import "server-only";

import type { DocumentSnapshot, Transaction } from "firebase-admin/firestore";
import type {
  AttendanceEvidence,
  AttendanceEvidenceRequest,
  AttendanceOperation,
  AttendanceTrustedAuthentication,
} from "@/types/attendance-evidence";
import type {
  EqualHandoverAggregate,
  EqualHandoverIdentity,
  EqualHandoverReservation,
} from "@/types/equal-technician-handover";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import { getOperationalCollections } from "./collections";
import { createHandoverReservationGuardDocumentId } from "./handover-reservation-guard-domain";
import { assertEqualHandoverAggregate } from "./equal-technician-handover-domain";
import {
  attendanceEvidenceOtherKindRefs,
  attendanceTransactionalGetAll,
  outgoingShiftIdFromHandoverDocument,
  persistAttendanceEvidence,
  persistAttendanceOperation,
  readAttendanceEvidenceSnapshot,
  readAttendanceOperationSnapshot,
  readReservationGuardSnapshot,
} from "./attendance-evidence-firestore-state";
import {
  assertAttendanceEvidenceRequest,
  assertAttendanceOperation,
  attendanceAuthenticationMethodForKind,
  attendanceEvidenceId,
  attendanceEvidenceRequestDigest,
  attendanceEvidenceSlotId,
  attendanceOperationId,
  buildAttendanceEvidence,
  classifyAttendanceEvidenceConflict,
  createPendingAttendanceOperation,
  AttendanceEvidenceDomainError,
} from "./attendance-evidence-domain";
import { createIncomingAcceptanceEvidenceDigest } from "./incoming-acceptance-application-domain";

// Transaction-composable evidence planning for the future atomic incoming
// acceptance service. Every function here is called INSIDE a caller-owned
// Firestore transaction: it never calls `runTransaction`, never commits, and
// performs all authoritative reads before queueing the first write. The
// existing begin/finalize callers keep their separate transactions; this module
// exists so the atomic acceptance path can create the subject's operation,
// evidence and finalized operation together without a durable pending-only
// state.

export interface AtomicAcceptanceEvidenceInput {
  request: AttendanceEvidenceRequest;
  identity: EqualHandoverIdentity;
  reservation: EqualHandoverReservation;
  trustedAuthentication: AttendanceTrustedAuthentication;
  serverAuthenticationTime: string;
}

export interface AtomicAcceptanceEvidenceState {
  operation: AttendanceOperation | null;
  slotEvidence: AttendanceEvidence | null;
  otherKindEvidence: readonly AttendanceEvidence[];
  guard: HandoverReservationGuard | null;
  handover: EqualHandoverAggregate | null;
}

export type AtomicAcceptanceEvidenceMode =
  | "create_operation_and_evidence"
  | "finalize_pending_operation"
  | "replay_finalized_operation";

export interface AtomicAcceptanceEvidencePlan {
  mode: AtomicAcceptanceEvidenceMode;
  operationId: string;
  evidenceId: string;
  operation: AttendanceOperation;
  evidence: AttendanceEvidence;
  evidenceDigest: string;
  // Evidence composition never asserts operational acceptance. The caller must
  // still validate the receipt and the activation/join/membership state.
  operationalAcceptance: false;
  acknowledgementRequired: boolean;
}

function createEvidenceDigest(evidence: AttendanceEvidence): string {
  return createIncomingAcceptanceEvidenceDigest({
    id: evidence.id,
    slotId: evidence.slotId,
    operationId: evidence.operationId,
    eventId: evidence.eventId,
    handoverId: evidence.handoverId,
    technicianUid: evidence.technicianUid,
    kind: evidence.kind,
    eventTime: evidence.eventTime,
    authenticationMethod: evidence.authenticationMethod,
    personallyAuthenticated: evidence.personallyAuthenticated,
    guardRevision: evidence.guardRevision,
    fencingEpoch: evidence.fencingEpoch,
  });
}

function canonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new AttendanceEvidenceDomainError(`Invalid canonical ${label}.`, 400);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readOtherKindEvidence(snapshots: DocumentSnapshot[]): AttendanceEvidence[] {
  const evidence: AttendanceEvidence[] = [];
  for (const snapshot of snapshots) {
    const record = readAttendanceEvidenceSnapshot(snapshot);
    if (record !== null) evidence.push(record);
  }
  return evidence;
}

export async function readAtomicAcceptanceEvidenceState(
  transaction: Transaction,
  input: AtomicAcceptanceEvidenceInput,
): Promise<AtomicAcceptanceEvidenceState> {
  const request = assertAttendanceEvidenceRequest(input.request);
  const outgoingShiftId = outgoingShiftIdFromHandoverDocument(request.handoverDocumentId);
  const slotId = attendanceEvidenceSlotId({
    handoverId: request.handoverId,
    technicianUid: request.technicianUid,
    kind: request.kind,
  });
  const operationId = attendanceOperationId(request.eventId);
  const evidenceId = attendanceEvidenceId(slotId);
  const {
    attendanceEvidenceV2,
    attendanceEvidenceOperationsV2,
    equalHandoversV2,
    handoverReservationGuards,
  } = getOperationalCollections();

  const [operationSnapshot, slotSnapshot, guardSnapshot, handoverSnapshot, ...otherKindSnapshots] =
    await Promise.all([
      transaction.get(attendanceEvidenceOperationsV2.doc(operationId)),
      transaction.get(attendanceEvidenceV2.doc(evidenceId)),
      transaction.get(
        handoverReservationGuards.doc(
          createHandoverReservationGuardDocumentId(outgoingShiftId),
        ),
      ),
      transaction.get(equalHandoversV2.doc(request.handoverDocumentId)),
      ...(await attendanceTransactionalGetAll(
        transaction,
        attendanceEvidenceOtherKindRefs(request.handoverId, request.technicianUid, request.kind),
      )),
    ]);

  return {
    operation: readAttendanceOperationSnapshot(operationSnapshot),
    slotEvidence: readAttendanceEvidenceSnapshot(slotSnapshot),
    otherKindEvidence: readOtherKindEvidence(otherKindSnapshots),
    guard: readReservationGuardSnapshot(guardSnapshot),
    handover: handoverSnapshot.exists
      ? assertEqualHandoverAggregate(handoverSnapshot.data())
      : null,
  };
}

function assertMatchingSubject(
  input: AtomicAcceptanceEvidenceInput,
  request: AttendanceEvidenceRequest,
): void {
  if (input.trustedAuthentication.verifiedTechnicianUid !== request.technicianUid) {
    throw new AttendanceEvidenceDomainError(
      "Personally authenticated evidence requires the subject technician's own verified authentication.",
      403,
    );
  }
  if (input.trustedAuthentication.method !== attendanceAuthenticationMethodForKind(request.kind)) {
    throw new AttendanceEvidenceDomainError(
      `Authentication method ${input.trustedAuthentication.method} cannot finalize evidence kind ${request.kind}.`,
      403,
    );
  }
  if (!input.identity.incomingTechnicianIds.includes(request.technicianUid)) {
    throw new AttendanceEvidenceDomainError(
      "The evidence subject is not a reserved incoming technician.",
      403,
    );
  }
}

function assertOtherKindConflicts(
  state: AtomicAcceptanceEvidenceState,
  request: AttendanceEvidenceRequest,
  operationId: string,
  serverAuthenticationTime: string,
): void {
  for (const other of state.otherKindEvidence) {
    if (other.technicianUid !== request.technicianUid) continue;
    const conflict = classifyAttendanceEvidenceConflict({
      existing: other,
      incomingKind: request.kind,
      incomingTechnicianUid: request.technicianUid,
      incomingEventTime: serverAuthenticationTime,
      incomingOperationId: operationId,
    });
    if (conflict !== null) {
      throw new AttendanceEvidenceDomainError(
        `Conflicting attendance evidence already exists (${conflict}: ${other.kind} for ${other.technicianUid}); fail closed and remain auditable.`,
        409,
      );
    }
  }
}

function assertWritableAggregate(
  state: AtomicAcceptanceEvidenceState,
  input: AtomicAcceptanceEvidenceInput,
): asserts state is AtomicAcceptanceEvidenceState & {
  handover: EqualHandoverAggregate;
  guard: HandoverReservationGuard;
} {
  if (state.handover === null) {
    throw new AttendanceEvidenceDomainError(
      "The v2 handover document is missing; refusing to finalize attendance evidence.",
      409,
    );
  }
  if (state.handover.lifecycleStatus === "cancelled" || state.handover.lifecycleStatus === "superseded") {
    throw new AttendanceEvidenceDomainError(
      `Handover is ${state.handover.lifecycleStatus}; attendance finalization is blocked.`,
      409,
    );
  }
  if (canonicalJson(state.handover.identity) !== canonicalJson(input.identity)) {
    throw new AttendanceEvidenceDomainError(
      "Attendance evidence coordinator identity is stale for the stored handover aggregate.",
      409,
    );
  }
  if (state.guard === null) {
    throw new AttendanceEvidenceDomainError(
      "Attendance evidence requires an active reservation guard.",
      409,
    );
  }
}

function assertOperationMatchesRequest(
  operation: AttendanceOperation,
  request: AttendanceEvidenceRequest,
  operationId: string,
  evidenceId: string,
): void {
  if (
    operation.id !== operationId ||
    operation.evidenceId !== evidenceId ||
    operation.request.eventId !== request.eventId ||
    operation.request.handoverId !== request.handoverId ||
    operation.request.technicianUid !== request.technicianUid ||
    operation.request.kind !== request.kind
  ) {
    throw new AttendanceEvidenceDomainError(
      "The stored attendance operation belongs to a different event, subject or handover.",
      409,
    );
  }
}

function finalizePendingOperation(
  operation: AttendanceOperation,
  evidence: AttendanceEvidence,
): AttendanceOperation {
  return assertAttendanceOperation({
    ...operation,
    status: "finalized",
    interruptedFinalization: true,
    finalizedAt: evidence.finalizedAt,
  });
}

export function planAtomicAcceptanceEvidence(
  state: AtomicAcceptanceEvidenceState,
  input: AtomicAcceptanceEvidenceInput,
): AtomicAcceptanceEvidencePlan {
  const request = assertAttendanceEvidenceRequest(input.request);
  canonicalTimestamp(input.serverAuthenticationTime, "server authentication time");
  assertMatchingSubject(input, request);

  const slotId = attendanceEvidenceSlotId({
    handoverId: request.handoverId,
    technicianUid: request.technicianUid,
    kind: request.kind,
  });
  const operationId = attendanceOperationId(request.eventId);
  const evidenceId = attendanceEvidenceId(slotId);
  const incomingDigest = attendanceEvidenceRequestDigest(request);

  assertOtherKindConflicts(state, request, operationId, input.serverAuthenticationTime);

  if (state.operation !== null) {
    assertOperationMatchesRequest(state.operation, request, operationId, evidenceId);
    if (state.operation.status === "aborted") {
      throw new AttendanceEvidenceDomainError(
        `Attendance operation was aborted: ${state.operation.abortReason ?? "unknown"}`,
        409,
      );
    }

    if (state.operation.status === "finalized") {
      if (state.slotEvidence === null) {
        throw new AttendanceEvidenceDomainError(
          "Finalized attendance operation is missing its evidence document; refusing to guess state.",
          409,
        );
      }
      const evidence = state.slotEvidence;
      if (
        evidence.operationId !== state.operation.id ||
        evidence.eventId !== request.eventId ||
        evidence.technicianUid !== request.technicianUid ||
        evidence.handoverId !== request.handoverId ||
        evidence.kind !== request.kind
      ) {
        throw new AttendanceEvidenceDomainError(
          "Stored attendance evidence does not match its operation and request identity.",
          409,
        );
      }
      return {
        mode: "replay_finalized_operation",
        operationId,
        evidenceId,
        operation: state.operation,
        evidence,
        evidenceDigest: createEvidenceDigest(evidence),
        operationalAcceptance: false,
        acknowledgementRequired: state.operation.interruptedFinalization,
      };
    }

    // Pending: never silently adopt a changed request binding. A retry must
    // present the exact same reviewed request; the caller re-reads it from the
    // authoritative context rather than reusing a stale body.
    if (state.operation.requestDigest !== incomingDigest) {
      throw new AttendanceEvidenceDomainError(
        "A pending attendance operation was created for a different request binding; the retry conflicts and the stored operation is preserved unchanged.",
        409,
      );
    }
    if (state.slotEvidence !== null) {
      throw new AttendanceEvidenceDomainError(
        "Attendance evidence exists while its operation is still pending; administrator review required.",
        409,
      );
    }

    assertWritableAggregate(state, input);
    const evidence = buildAttendanceEvidence({
      operation: state.operation,
      serverTime: input.serverAuthenticationTime,
      guard: state.guard,
      reservation: input.reservation,
      identity: input.identity,
      trustedAuthentication: input.trustedAuthentication,
    });
    return {
      mode: "finalize_pending_operation",
      operationId,
      evidenceId,
      operation: finalizePendingOperation(state.operation, evidence),
      evidence,
      evidenceDigest: createEvidenceDigest(evidence),
      operationalAcceptance: false,
      acknowledgementRequired: true,
    };
  }

  if (state.slotEvidence !== null) {
    throw new AttendanceEvidenceDomainError(
      `Attendance evidence already exists for this slot (${state.slotEvidence.operationId}); duplicate operations are rejected.`,
      409,
    );
  }

  assertWritableAggregate(state, input);
  const pending = assertAttendanceOperation({
    ...createPendingAttendanceOperation(request),
    requestedAt: input.serverAuthenticationTime,
  });
  const evidence = buildAttendanceEvidence({
    operation: pending,
    serverTime: input.serverAuthenticationTime,
    guard: state.guard,
    reservation: input.reservation,
    identity: input.identity,
    trustedAuthentication: input.trustedAuthentication,
  });
  return {
    mode: "create_operation_and_evidence",
    operationId,
    evidenceId,
    operation: finalizePendingOperation(pending, evidence),
    evidence,
    evidenceDigest: createEvidenceDigest(evidence),
    operationalAcceptance: false,
    acknowledgementRequired: true,
  };
}

// Queues evidence writes on the caller's transaction. No commit happens here;
// a replay queues nothing. The caller must still write the application receipt
// and activation/join records in the same transaction.
export function applyAtomicAcceptanceEvidencePlan(
  transaction: Transaction,
  plan: AtomicAcceptanceEvidencePlan,
): void {
  const { attendanceEvidenceV2, attendanceEvidenceOperationsV2 } = getOperationalCollections();
  if (plan.mode === "replay_finalized_operation") {
    return;
  }
  transaction.create(
    attendanceEvidenceV2.doc(plan.evidenceId),
    persistAttendanceEvidence(plan.evidence),
  );
  if (plan.mode === "create_operation_and_evidence") {
    transaction.create(
      attendanceEvidenceOperationsV2.doc(plan.operationId),
      persistAttendanceOperation(plan.operation),
    );
    return;
  }
  transaction.set(
    attendanceEvidenceOperationsV2.doc(plan.operationId),
    persistAttendanceOperation(plan.operation),
  );
}

export async function prepareAtomicAcceptanceEvidence(
  transaction: Transaction,
  input: AtomicAcceptanceEvidenceInput,
): Promise<AtomicAcceptanceEvidencePlan> {
  const state = await readAtomicAcceptanceEvidenceState(transaction, input);
  const plan = planAtomicAcceptanceEvidence(state, input);
  applyAtomicAcceptanceEvidencePlan(transaction, plan);
  return plan;
}
