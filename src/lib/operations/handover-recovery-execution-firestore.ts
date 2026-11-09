// Phase 8C.5 — the recovery execution service for a stalled, zero-acceptance
// handover.
//
// This is the only code path that can abandon an equal handover. It is a single
// Firestore transaction: every precondition of the 8C.1 contract is re-read
// inside it, every comparison-and-set fence is evaluated against those fresh
// reads, and all writes are staged only after the last read.
//
// Hard boundaries, enforced here and not by convention:
//   * no personal evidence is created, rewritten or deleted — no technician
//     clock-in/out, no acceptance application, no receipt, no attendance row;
//   * `shifts.actualEnd` stays null, so no system reads a fabricated end of work;
//   * only the writable set of §6.3 is written;
//   * the signed approval document is never modified. Consumption is proven by
//     the create-once abandonment audit row whose id is derived from the
//     approval id, so the signed intent stays immutable.
//
// The operation is once-only. A retry after a commit finds the audit row and
// answers `already_applied` with the original outcome; a retry after an abort
// sees no row and executes normally.

import "server-only";

import { FieldValue, type DocumentSnapshot } from "firebase-admin/firestore";

import type { TechnicianSchedule } from "@/types/technician-schedule";
import {
  HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION,
  type HandoverRecoveryApprovalV2Record,
} from "@/types/handover-recovery-approval-v2";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { getOperationalCollections, GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID } from "./collections";
import {
  abandonEqualHandover,
  assertEqualHandoverAggregate,
} from "./equal-technician-handover-domain";
import {
  assertHandoverReservationGuard,
  transitionGuardForCancellation,
} from "./handover-reservation-guard-domain";
import { readReservationGuardState } from "./handover-reservation-guard";
import {
  advanceOperationalShiftControl,
  assertOperationalShiftControl,
} from "./operational-shift-control-state";
import { assertNoScheduleConflict } from "./shift-overlap";
import {
  HANDOVER_RECOVERY_ABANDONMENT_AUDIT_ACTION,
  HANDOVER_RECOVERY_ABANDONMENT_REFUSALS,
  HandoverRecoveryAbandonmentError,
  createHandoverAbandonmentAuditId,
  createHandoverAbandonmentSlotToken,
  evaluateHandoverAbandonmentApprovalFence,
  refusalForAbandonmentClassification,
} from "./handover-recovery-abandonment-domain";
import {
  HandoverRecoveryEligibilityError,
  evaluateHandoverRecoveryEligibilityInTransaction,
  prepareHandoverRecoveryEligibilityRequest,
} from "./handover-recovery-eligibility-firestore";
import {
  HandoverRecoveryApprovalV2Error,
  assertHandoverRecoveryApprovalV2Record,
  createHandoverRecoveryApprovalV2Binding,
  createHandoverRecoveryApprovalV2IntentFingerprint,
  idempotencyKey as parseIdempotencyKey,
  approvalV2Reason,
} from "./handover-recovery-approval-v2-domain";

export interface HandoverRecoveryExecutionOutcome {
  status: "committed" | "already_applied";
  auditId: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  approvalId: string;
  executedBy: string;
  executedAt: string;
  recoveryExecutionEligible: false;
}

export interface HandoverRecoveryExecutionInput {
  approvalId: string;
  actorUid: string;
  reason: string;
  idempotencyKey: string;
  now?: Date;
}

function statusOf(error: unknown, fallback: number): number {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return fallback;
}

function assertExecutor(profile: unknown): void {
  const record = profile as Record<string, unknown> | null | undefined;
  if (
    !record ||
    record.role !== "admin" ||
    record.status !== "active" ||
    record.statusOperation != null ||
    record.mustChangePassword === true
  ) {
    throw new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
      "Only an administrator can execute a recovery.",
      403,
    );
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// The audit row is the execution record, so a replay answers from it alone:
// every field it reports was written by the transaction that committed.
function alreadyApplied(
  snapshot: DocumentSnapshot,
  approvalId: string,
): HandoverRecoveryExecutionOutcome {
  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  const handoverDocumentId = readString(data.handoverDocumentId);
  const outgoingShiftId = readString(data.outgoingShiftId);
  const incomingShiftId = readString(data.incomingShiftId);
  const executedBy = readString(data.actorUid);
  const executedAt = readString(data.recordedAt);
  if (
    !handoverDocumentId ||
    !outgoingShiftId ||
    !incomingShiftId ||
    !executedBy ||
    !executedAt
  ) {
    throw new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
      "The recovery audit record is incomplete.",
      409,
    );
  }
  return {
    status: "already_applied",
    auditId: snapshot.id,
    handoverDocumentId,
    outgoingShiftId,
    incomingShiftId,
    approvalId,
    executedBy,
    executedAt,
    recoveryExecutionEligible: false,
  };
}

interface ScheduleRelease {
  technicianUid: string;
  entries: TechnicianSchedule["entries"];
}

export async function executeHandoverAbandonment(
  input: HandoverRecoveryExecutionInput,
): Promise<HandoverRecoveryExecutionOutcome> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
      "Recovery cannot be executed right now.",
      503,
    );
  }
  const nowIso = now.toISOString();
  const reason = approvalV2Reason(input.reason);
  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
  const auditId = createHandoverAbandonmentAuditId(input.approvalId);

  const db = getAdminFirestore();
  const { shifts, shiftMembers, technicianSchedules, operationalShiftControl, equalHandoversV2 } =
    getOperationalCollections();

  try {
    return await db.runTransaction(async (transaction): Promise<HandoverRecoveryExecutionOutcome> => {
      const actorRef = db.collection("users").doc(input.actorUid);
      const approvalRef = db
        .collection(HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION)
        .doc(input.approvalId);
      const auditRef = db.collection("audit_logs").doc(auditId);
      const controlRef = operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID);

      // ---- reads -----------------------------------------------------------
      const [actorSnapshot, approvalSnapshot, auditSnapshot] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(approvalRef),
        transaction.get(auditRef),
      ]);

      assertExecutor(actorSnapshot.data());

      if (!approvalSnapshot.exists) {
        throw new HandoverRecoveryAbandonmentError(
          HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
          "The approval was not found.",
          404,
        );
      }
      let approval: HandoverRecoveryApprovalV2Record;
      try {
        approval = assertHandoverRecoveryApprovalV2Record(
          approvalSnapshot.data(),
          input.approvalId,
        );
      } catch (error) {
        throw new HandoverRecoveryAbandonmentError(
          HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
          error instanceof Error
            ? error.message
            : "The approval record cannot be read safely.",
          409,
        );
      }

      // Consumption is proven by this deterministic row, so a committed retry
      // answers with the original outcome and writes nothing.
      if (auditSnapshot.exists) {
        return alreadyApplied(auditSnapshot, input.approvalId);
      }

      // The classifier runs on this transaction: every precondition of §3.2 is
      // re-read after the approval was granted, so approval never carries
      // authority over state.
      const request = await prepareHandoverRecoveryEligibilityRequest({
        handoverDocumentId: approval.handoverDocumentId,
        actorUid: input.actorUid,
        now,
      });
      const evaluation = await evaluateHandoverRecoveryEligibilityInTransaction(
        transaction,
        request,
      );
      const refusal = refusalForAbandonmentClassification(evaluation.result.classification);
      if (refusal) {
        throw new HandoverRecoveryAbandonmentError(
          refusal,
          evaluation.result.reason,
          409,
          { classification: evaluation.result.classification },
        );
      }

      const readModel = evaluation.readModel;
      const identity = readModel.aggregate.identity;
      const guardView = readModel.guard;
      const slot = readModel.slot;
      if (
        !identity ||
        readModel.aggregate.revision === null ||
        readModel.aggregate.snapshotHash === null ||
        readModel.aggregate.lifecycleStatus === null ||
        readModel.aggregate.unreadable ||
        !guardView.present ||
        guardView.guardRevision === null ||
        guardView.fencingEpoch === null ||
        !slot.present ||
        slot.slotToken === null ||
        slot.generation === null
      ) {
        throw new HandoverRecoveryAbandonmentError(
          HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
          "The recovery evidence cannot be bound to an execution.",
        );
      }

      // F-5: both signatures must still describe the freshly re-read intent.
      const binding = createHandoverRecoveryApprovalV2Binding({
        result: evaluation.result,
        readModel,
      });
      const fenceError = evaluateHandoverAbandonmentApprovalFence(
        {
          intentFingerprint: approval.intentFingerprint,
          recomputedIntentFingerprint:
            createHandoverRecoveryApprovalV2IntentFingerprint(binding),
          storedStatus: approval.status,
          voidedAt: approval.voidedAt,
          consumedAt: null,
          expiresAt: approval.expiresAt,
          approvals: approval.approvals,
        },
        nowIso,
      );
      if (fenceError) throw fenceError;

      const outgoingShiftId = readModel.outgoingShiftId;
      const incomingShiftId = readModel.incomingShiftId;

      // The records the domain transitions need in full (the classifier only
      // returns views, and a view is not an authority for a write).
      const [
        aggregateSnapshot,
        controlSnapshot,
        guardState,
        membersSnapshot,
        outgoingShiftSnapshot,
      ] = await Promise.all([
        transaction.get(equalHandoversV2.doc(approval.handoverDocumentId)),
        transaction.get(controlRef),
        readReservationGuardState(transaction, outgoingShiftId),
        transaction.get(shiftMembers.where("shiftId", "==", outgoingShiftId)),
        transaction.get(shifts.doc(outgoingShiftId)),
      ]);

      if (
        !aggregateSnapshot.exists ||
        !controlSnapshot.exists ||
        !guardState.guardSnapshot.exists ||
        guardState.legacySnapshot.exists ||
        !outgoingShiftSnapshot.exists
      ) {
        throw new HandoverRecoveryAbandonmentError(
          HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
          "The recovery documents are not all present in the expected shape.",
        );
      }

      let aggregate;
      let guard;
      let control;
      try {
        aggregate = assertEqualHandoverAggregate(aggregateSnapshot.data());
        guard = assertHandoverReservationGuard(guardState.guardSnapshot.data());
        control = assertOperationalShiftControl(controlSnapshot.data());
      } catch (error) {
        throw new HandoverRecoveryAbandonmentError(
          HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
          error instanceof Error ? error.message : "The recovery state is malformed.",
          409,
        );
      }

      // The outgoing shift is written by W1, so it is read and checked in full.
      // Its own window — not the handover identity's, which carries the incoming
      // window — is what each outgoing schedule entry must match.
      const outgoingShift = outgoingShiftSnapshot.data() as Record<string, unknown>;
      const shiftScheduledStart = readString(outgoingShift.scheduledStart);
      const shiftScheduledEnd = readString(outgoingShift.scheduledEnd);
      const shiftPrimaryIds = Array.isArray(outgoingShift.primaryTechnicianIds)
        ? (outgoingShift.primaryTechnicianIds as unknown[]).map((item) => readString(item))
        : [];
      if (
        outgoingShift.id !== outgoingShiftId ||
        outgoingShift.status !== "handover_pending" ||
        outgoingShift.actualEnd !== null ||
        outgoingShift.permanentPairId !== identity.outgoingPermanentPairId ||
        outgoingShift.operationalSlotToken !== identity.outgoingSlotToken ||
        !shiftScheduledStart ||
        !shiftScheduledEnd ||
        !Number.isFinite(Date.parse(shiftScheduledStart)) ||
        !Number.isFinite(Date.parse(shiftScheduledEnd)) ||
        shiftPrimaryIds.length !== 2 ||
        shiftPrimaryIds.some((uid) => uid === null) ||
        [...shiftPrimaryIds].sort().join("\u0000") !==
          [...identity.outgoingTechnicianIds].sort().join("\u0000")
      ) {
        throw new HandoverRecoveryAbandonmentError(
          HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
          "The outgoing shift does not match the handover that was approved.",
        );
      }

      if (
        guard.protocolOwner !== "v2" ||
        guard.ownerHandoverDocumentId !== approval.handoverDocumentId ||
        guard.outgoingSlotToken !== identity.outgoingSlotToken ||
        guard.outgoingGeneration !== identity.outgoingGeneration ||
        guard.successorSlotToken !== identity.successorSlotToken ||
        guard.successorGeneration !== identity.successorGeneration
      ) {
        throw new HandoverRecoveryAbandonmentError(
          HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
          "The reservation guard does not bind this handover.",
        );
      }

      const roster = membersSnapshot.docs.map((document) => {
        const data = document.data() as Record<string, unknown>;
        const technicianId = readString(data.technicianId);
        const joinedAt = readString(data.joinedAt);
        const leftAt = data.leftAt ?? null;
        const validLeftAt =
          leftAt === null ||
          (typeof leftAt === "string" &&
            Number.isFinite(Date.parse(leftAt)) &&
            typeof joinedAt === "string" &&
            leftAt >= joinedAt);
        if (
          data.id !== document.id ||
          data.shiftId !== outgoingShiftId ||
          !technicianId ||
          technicianId.includes("/") ||
          technicianId.length > 128 ||
          !joinedAt ||
          !Number.isFinite(Date.parse(joinedAt)) ||
          !validLeftAt
        ) {
          throw new HandoverRecoveryAbandonmentError(
            HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
            "The outgoing shift's roster is inconsistent.",
          );
        }
        return {
          id: document.id,
          technicianId,
          role: data.role,
          leftAt: leftAt as string | null,
        };
      });
      const currentMembers = roster.filter((member) => member.leftAt === null);
      const currentIds = currentMembers.map((member) => member.technicianId).sort();
      const identityIds = [...identity.outgoingTechnicianIds].sort();
      if (
        currentIds.length !== 2 ||
        new Set(currentIds).size !== 2 ||
        currentIds[0] !== identityIds[0] ||
        currentIds[1] !== identityIds[1] ||
        currentMembers.some((member) => member.role !== "primary")
      ) {
        throw new HandoverRecoveryAbandonmentError(
          HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
          "The outgoing shift's live roster does not match the handover.",
        );
      }

      // W4: every current outgoing member's schedule must hold exactly the
      // outgoing shift's entry, with matching times, and that entry is removed.
      const scheduleReleases: ScheduleRelease[] = [];
      for (const member of currentMembers) {
        const technicianUid = member.technicianId;
        const scheduleSnapshot = await transaction.get(technicianSchedules.doc(technicianUid));
        const schedule = scheduleSnapshot.data() as TechnicianSchedule | undefined;
        if (
          !scheduleSnapshot.exists ||
          !schedule ||
          schedule.technicianUid !== technicianUid ||
          !Array.isArray(schedule.entries)
        ) {
          throw new HandoverRecoveryAbandonmentError(
            HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
            "An outgoing technician has an invalid scheduling record.",
          );
        }
        const entries = schedule.entries;
        if (
          entries.some(
            (entry) =>
              !entry ||
              typeof entry.shiftId !== "string" ||
              !entry.shiftId ||
              typeof entry.scheduledStart !== "string" ||
              typeof entry.scheduledEnd !== "string",
          ) ||
          new Set(entries.map((entry) => entry.shiftId)).size !== entries.length
        ) {
          throw new HandoverRecoveryAbandonmentError(
            HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
            "An outgoing technician's scheduling information is invalid.",
          );
        }
        const matching = entries.filter((entry) => entry.shiftId === outgoingShiftId);
        if (
          matching.length !== 1 ||
          matching[0].status !== "handover_pending" ||
          matching[0].scheduledStart !== shiftScheduledStart ||
          matching[0].scheduledEnd !== shiftScheduledEnd
        ) {
          throw new HandoverRecoveryAbandonmentError(
            HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
            "An outgoing technician's schedule does not match the stalled shift.",
          );
        }
        const remaining = entries.filter((entry) => entry.shiftId !== outgoingShiftId);
        try {
          assertNoScheduleConflict(shiftScheduledStart, shiftScheduledEnd, remaining);
        } catch (error) {
          throw new HandoverRecoveryAbandonmentError(
            HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
            error instanceof Error
              ? error.message
              : "An outgoing technician's remaining schedule conflicts.",
            409,
          );
        }
        scheduleReleases.push({ technicianUid, entries: remaining });
      }

      // ---- writes (nothing below this line reads) --------------------------
      let nextAggregate;
      let nextGuard;
      let nextControl;
      let slotTokenAfter: string;
      try {
        nextAggregate = abandonEqualHandover(aggregate, {
          expectedRevision: approval.binding.aggregateRevision,
          expectedSnapshotHash: approval.binding.aggregateSnapshotHash,
          expectedLifecycleStatus: approval.binding.aggregateLifecycleStatus,
          recordedAt: nowIso,
          actorUid: input.actorUid,
        });
        slotTokenAfter = createHandoverAbandonmentSlotToken({
          approvalId: approval.id,
          generation: control.generation + 1,
        });
        nextControl = advanceOperationalShiftControl(
          control,
          outgoingShiftId,
          slotTokenAfter,
          nowIso,
        );
        nextGuard = transitionGuardForCancellation(guard, {
          outgoingShiftId,
          protocolOwner: "v2",
          expectedGuardRevision: approval.binding.guardRevision,
          expectedFencingEpoch: approval.binding.fencingEpoch,
          terminalEvidenceRef: auditId,
          recordedAt: nowIso,
          actorUid: input.actorUid,
        });
      } catch (error) {
        if (error instanceof HandoverRecoveryAbandonmentError) throw error;
        throw new HandoverRecoveryAbandonmentError(
          statusOf(error, 409) === 409
            ? HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STALE_OR_APPLIED
            : HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
          error instanceof Error ? error.message : "The recovery transition was refused.",
        );
      }

      // W1 — the shift ends administratively; actualEnd stays null.
      transaction.update(shifts.doc(outgoingShiftId), {
        status: "cancelled",
        cancelledAt: nowIso,
        cancelledBy: input.actorUid,
        updatedAt: nowIso,
      });

      // W2 — the global slot is released to a fresh pending generation.
      transaction.update(controlRef, nextControl);

      // W3 — roster end only, never a clock-out.
      for (const member of currentMembers) {
        transaction.update(shiftMembers.doc(member.id), { leftAt: nowIso });
      }

      // W4 — the cancelled shift leaves each technician's schedule.
      for (const release of scheduleReleases) {
        transaction.update(technicianSchedules.doc(release.technicianUid), {
          entries: release.entries,
          updatedAt: nowIso,
        });
      }

      // W5 — the handover aggregate becomes terminal.
      transaction.set(equalHandoversV2.doc(approval.handoverDocumentId), nextAggregate);

      // W6 — the reservation guard is cancelled with the audit as its evidence.
      transaction.set(guardState.guardRef, nextGuard);

      // W7 — create-once audit. Its existence is the consumption proof.
      transaction.create(auditRef, {
        id: auditId,
        action: HANDOVER_RECOVERY_ABANDONMENT_AUDIT_ACTION,
        protocol: "equal-handover-v2-recovery",
        actorUid: input.actorUid,
        approvalId: approval.id,
        intentFingerprint: approval.intentFingerprint,
        supervisorUid:
          approval.approvals.find((item) => item.actorRole === "supervisor")?.actorUid ?? null,
        adminUid: approval.approvals.find((item) => item.actorRole === "admin")?.actorUid ?? null,
        handoverDocumentId: approval.handoverDocumentId,
        shiftId: outgoingShiftId,
        outgoingShiftId,
        incomingShiftId,
        guardId: guardState.documentId,
        guardRevisionBefore: guard.guardRevision,
        guardRevisionAfter: nextGuard.guardRevision,
        fencingEpoch: guard.fencingEpoch,
        slotTokenBefore: control.slotToken,
        slotTokenAfter,
        generationBefore: control.generation,
        generationAfter: nextControl.generation,
        aggregateRevision: aggregate.revision,
        aggregateLifecycleBefore: aggregate.lifecycleStatus,
        aggregateLifecycleAfter: nextAggregate.lifecycleStatus,
        activationWindow: {
          scheduledStart: readModel.activationWindow.scheduledStart,
          scheduledEnd: readModel.activationWindow.scheduledEnd,
          latestActivationAt: readModel.activationWindow.latestActivationAt,
          nowIso,
        },
        evidenceDigest: evaluation.result.evidenceDigest.value,
        negativeProof: {
          classification: evaluation.result.classification,
          activationReceiptPresent: readModel.activationReceipt.present,
          commitReceiptPresent: readModel.commitReceipt.present,
          incomingShiftPresent: readModel.incomingShift.present,
          incomingMembershipCount: readModel.memberships.filter((item) => item.present).length,
          incomingAttendanceCount: readModel.attendance.filter((item) => item.present).length,
          incomingApplicationCount: readModel.applications.filter((item) => item.present).length,
          finalizedIncomingEvidenceCount: readModel.evidence.filter(
            (item) => item.present && item.finalizedAt !== null,
          ).length,
          reportVerified: readModel.report.verified,
          reviewCaseStatus: readModel.reviewCase.status,
        },
        reason,
        idempotencyKey,
        rosterEndOnly: true,
        personalEvidenceWritten: false,
        recordedAt: nowIso,
        createdAt: FieldValue.serverTimestamp(),
      });

      return {
        status: "committed",
        auditId,
        handoverDocumentId: approval.handoverDocumentId,
        outgoingShiftId,
        incomingShiftId,
        approvalId: approval.id,
        executedBy: input.actorUid,
        executedAt: nowIso,
        recoveryExecutionEligible: false,
      };
    });
  } catch (error) {
    if (error instanceof HandoverRecoveryAbandonmentError) throw error;
    if (error instanceof HandoverRecoveryApprovalV2Error) {
      throw new HandoverRecoveryAbandonmentError(
        HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
        error.message,
        409,
      );
    }
    if (error instanceof HandoverRecoveryEligibilityError) {
      throw new HandoverRecoveryAbandonmentError(
        error.code === "ELIGIBILITY_FORBIDDEN"
          ? HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID
          : HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
        error.message,
        error.status,
      );
    }
    // An ambiguous transaction failure may or may not have committed. Before
    // reporting an unknown outcome, read the create-once row: if it is present
    // the transaction did commit (for example, a concurrent executor won the
    // create), so the outcome is known after all.
    try {
      const applied = await db.collection("audit_logs").doc(auditId).get();
      if (applied.exists) return alreadyApplied(applied, input.approvalId);
    } catch {
      // The read-back itself failed; report the ambiguity rather than guess.
    }
    console.error("Handover recovery execution failed.");
    throw new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.OUTCOME_UNKNOWN,
      "The recovery outcome could not be confirmed. Verify before trying again.",
      503,
    );
  }
}

export interface HandoverRecoveryExecutionStatus {
  approvalId: string;
  handoverDocumentId: string;
  applied: boolean;
  auditId: string;
  executedBy: string | null;
  executedAt: string | null;
  recoveryExecutionEligible: false;
}

/**
 * S9 read-back: never guesses. It answers whether the deterministic audit row
 * exists for this approval, and reads nothing that could alter authority.
 */
export async function readHandoverAbandonmentStatus(input: {
  approvalId: string;
}): Promise<HandoverRecoveryExecutionStatus> {
  const db = getAdminFirestore();
  const approvalId = input.approvalId;
  const approvalSnapshot = await db
    .collection(HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION)
    .doc(approvalId)
    .get();
  if (!approvalSnapshot.exists) {
    throw new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
      "The approval was not found.",
      404,
    );
  }
  const approval = assertHandoverRecoveryApprovalV2Record(approvalSnapshot.data(), approvalId);
  const auditId = createHandoverAbandonmentAuditId(approvalId);
  const auditSnapshot = await db.collection("audit_logs").doc(auditId).get();
  const data = (auditSnapshot.data() ?? {}) as Record<string, unknown>;
  return {
    approvalId,
    handoverDocumentId: approval.handoverDocumentId,
    applied: auditSnapshot.exists,
    auditId,
    executedBy: auditSnapshot.exists ? readString(data.actorUid) : null,
    executedAt: auditSnapshot.exists ? readString(data.recordedAt) : null,
    recoveryExecutionEligible: false,
  };
}
