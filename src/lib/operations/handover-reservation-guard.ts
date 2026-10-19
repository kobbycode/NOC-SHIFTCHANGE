import "server-only";

import type { DocumentReference, DocumentSnapshot, Transaction } from "firebase-admin/firestore";
import type {
  AcquireGuardInput,
  CancelGuardInput,
  CompleteGuardInput,
  HandoverReservationGuard,
  ReplaceGuardInput,
} from "@/types/handover-reservation-guard";
import { getOperationalCollections } from "./collections";
import {
  adoptGuardlessLegacyReservation,
  archiveCancelledReservationGuard,
  assertHandoverReservationGuard,
  createHandoverReservationGuardDocumentId,
  createInitialReservationGuard,
  HandoverReservationGuardError,
  transitionCancelledGuardForEqualReacquisition,
  assertSameOwnerRetry,
  transitionGuardForCancellation,
  transitionGuardForCompletion,
  transitionGuardForReplacement,
} from "./handover-reservation-guard-domain";
import { assertHandoverAggregate, createHandoverDocumentId } from "./handover-domain";

export {
  createHandoverReservationGuardDocumentId,
  HandoverReservationGuardError,
};

export interface ReservationGuardTransactionState {
  documentId: string;
  guardRef: DocumentReference;
  guardSnapshot: DocumentSnapshot;
  legacyRef: DocumentReference;
  legacySnapshot: DocumentSnapshot;
}

export async function readReservationGuardState(
  transaction: Transaction,
  outgoingShiftId: string,
): Promise<ReservationGuardTransactionState> {
  const { handoverReservationGuards, handovers } = getOperationalCollections();
  const documentId = createHandoverReservationGuardDocumentId(outgoingShiftId);
  const guardRef = handoverReservationGuards.doc(documentId);
  const legacyDocId = createHandoverDocumentId(outgoingShiftId);
  const legacyRef = handovers.doc(legacyDocId);

  const [guardSnapshot, legacySnapshot] = await Promise.all([
    transaction.get(guardRef),
    transaction.get(legacyRef),
  ]);

  return {
    documentId,
    guardRef,
    guardSnapshot,
    legacyRef,
    legacySnapshot,
  };
}

export async function readReservationGuard(
  transaction: Transaction,
  outgoingShiftId: string,
): Promise<HandoverReservationGuard | null> {
  const { handoverReservationGuards } = getOperationalCollections();
  const documentId = createHandoverReservationGuardDocumentId(outgoingShiftId);
  const snapshot = await transaction.get(handoverReservationGuards.doc(documentId));
  if (!snapshot.exists) {
    return null;
  }
  return assertHandoverReservationGuard(snapshot.data());
}

export async function resolveOrAcquireReservationGuard(
  transaction: Transaction,
  input: AcquireGuardInput,
  preloadedState?: ReservationGuardTransactionState,
): Promise<{ guard: HandoverReservationGuard; isNew: boolean }> {
  const state = preloadedState ?? (await readReservationGuardState(transaction, input.outgoingShiftId));

  if (state.guardSnapshot.exists) {
    const existing = assertHandoverReservationGuard(state.guardSnapshot.data());
    if (
      existing.ownerLifecycleState === "cancelled" &&
      input.protocolOwner === "v2"
    ) {
      // Cancelled → v2 hand-off (§7): archive the exact terminal evidence
      // immutably, then replace the live document inside this same transaction
      // with a fresh v2 successor at the next fencing epoch. A cancelled
      // guard remains terminal and rejecting for every v1 writer.
      const archive = archiveCancelledReservationGuard(existing, input.reservedAt);
      const historyRef = getOperationalCollections()
        .handoverReservationGuardHistory
        .doc(archive.archiveDocumentId);
      const historySnapshot = await transaction.get(historyRef);
      if (historySnapshot.exists) {
        throw new HandoverReservationGuardError(
          "Reservation guard archive history already exists; administrator review required.",
          409,
        );
      }
      const successor = transitionCancelledGuardForEqualReacquisition(archive, {
        ...input,
        expectedGuardRevision: existing.protocolOwner === "v1"
          ? existing.guardRevision + 1
          : existing.guardRevision,
        expectedFencingEpoch: existing.fencingEpoch,
      });
      transaction.create(historyRef, archive.archived);
      transaction.set(state.guardRef, successor);
      return { guard: successor, isNew: true };
    }
    const retried = assertSameOwnerRetry(existing, input);
    return { guard: retried, isNew: false };
  }

  // Guard document does not exist. Check for active or conflicting guardless legacy handover.
  if (state.legacySnapshot.exists) {
    const legacy = assertHandoverAggregate(state.legacySnapshot.data());
    if (legacy.lifecycleStatus === "collecting_confirmations") {
      if (input.protocolOwner === "v2") {
        throw new HandoverReservationGuardError(
          "Active legacy v1 handover reservation exists for this outgoing shift without guard. V2 acquisition is blocked.",
          409,
        );
      }
      // For V1, check consistency before adopting
      if (
        legacy.identity.outgoingShiftId !== input.outgoingShiftId ||
        legacy.reservation.reservedIncomingShiftId !== input.reservedIncomingShiftId
      ) {
        throw new HandoverReservationGuardError(
          "Conflicting active guardless legacy v1 reservation exists for this shift.",
          409,
        );
      }
      const adopted = adoptGuardlessLegacyReservation(legacy);
      transaction.create(state.guardRef, adopted);
      return { guard: adopted, isNew: true };
    }
    if (legacy.lifecycleStatus === "completed") {
      throw new HandoverReservationGuardError(
        "A legacy handover for this outgoing shift is already completed.",
        409,
      );
    }
  }

  const initial = createInitialReservationGuard(input);
  transaction.create(state.guardRef, initial);
  return { guard: initial, isNew: true };
}

export async function replaceReservationGuard(
  transaction: Transaction,
  input: ReplaceGuardInput,
  preloadedState?: ReservationGuardTransactionState,
): Promise<HandoverReservationGuard> {
  const state = preloadedState ?? (await readReservationGuardState(transaction, input.outgoingShiftId));

  let existing: HandoverReservationGuard;
  if (state.guardSnapshot.exists) {
    existing = assertHandoverReservationGuard(state.guardSnapshot.data());
  } else {
    // Attempt guardless legacy adoption if active
    if (!state.legacySnapshot.exists) {
      throw new HandoverReservationGuardError("The reservation guard was not found.", 404);
    }
    const legacy = assertHandoverAggregate(state.legacySnapshot.data());
    if (legacy.lifecycleStatus !== "collecting_confirmations") {
      throw new HandoverReservationGuardError(
        "Cannot replace an inactive legacy handover reservation without guard.",
        409,
      );
    }
    existing = adoptGuardlessLegacyReservation(legacy);
  }

  const nextGuard = transitionGuardForReplacement(existing, input);
  transaction.set(state.guardRef, nextGuard);
  return nextGuard;
}

export async function cancelReservationGuard(
  transaction: Transaction,
  input: CancelGuardInput,
  preloadedState?: ReservationGuardTransactionState,
): Promise<HandoverReservationGuard> {
  const state = preloadedState ?? (await readReservationGuardState(transaction, input.outgoingShiftId));

  let existing: HandoverReservationGuard;
  if (state.guardSnapshot.exists) {
    existing = assertHandoverReservationGuard(state.guardSnapshot.data());
  } else {
    if (!state.legacySnapshot.exists) {
      throw new HandoverReservationGuardError("The reservation guard was not found.", 404);
    }
    const legacy = assertHandoverAggregate(state.legacySnapshot.data());
    if (legacy.lifecycleStatus !== "collecting_confirmations") {
      throw new HandoverReservationGuardError(
        "Cannot cancel an inactive legacy handover reservation without guard.",
        409,
      );
    }
    existing = adoptGuardlessLegacyReservation(legacy);
  }

  const nextGuard = transitionGuardForCancellation(existing, input);
  transaction.set(state.guardRef, nextGuard);
  return nextGuard;
}

export async function completeReservationGuard(
  transaction: Transaction,
  input: CompleteGuardInput,
  preloadedState?: ReservationGuardTransactionState,
): Promise<{ guard: HandoverReservationGuard; operation: "create" | "set" }> {
  const state = preloadedState ?? (await readReservationGuardState(transaction, input.outgoingShiftId));

  let existing: HandoverReservationGuard;
  let operation: "create" | "set" = "set";
  if (state.guardSnapshot.exists) {
    existing = assertHandoverReservationGuard(state.guardSnapshot.data());
  } else {
    if (!state.legacySnapshot.exists) {
      throw new HandoverReservationGuardError("The reservation guard was not found.", 404);
    }
    const legacy = assertHandoverAggregate(state.legacySnapshot.data());
    if (legacy.lifecycleStatus === "completed") {
      existing = adoptGuardlessLegacyReservation(legacy, input.receiptId);
      transaction.create(state.guardRef, existing);
      return { guard: existing, operation: "create" };
    }
    if (legacy.lifecycleStatus !== "collecting_confirmations") {
      throw new HandoverReservationGuardError(
        "Cannot complete an inactive or cancelled legacy handover reservation.",
        409,
      );
    }
    existing = adoptGuardlessLegacyReservation(legacy);
    operation = "create";
  }

  const nextGuard = transitionGuardForCompletion(existing, input);
  if (operation === "create") {
    transaction.create(state.guardRef, nextGuard);
  } else {
    transaction.set(state.guardRef, nextGuard);
  }
  return { guard: nextGuard, operation };
}
