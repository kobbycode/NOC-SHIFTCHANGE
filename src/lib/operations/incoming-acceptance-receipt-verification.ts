// 09M-R3B.2 Phase 4A — shared receipt-backed application verification.
//
// Guard finalization and read-only reconciliation must agree on what "this
// technician's application is valid" means. Both read the same deterministic
// receipt, evidence, finalized operation, membership, attendance and
// application audit, then call this one function so the two surfaces can never
// drift apart.
//
// This module performs no I/O of its own: the caller supplies the snapshots it
// already read inside its transaction.

import "server-only";

import type { DocumentSnapshot } from "firebase-admin/firestore";
import type { EqualHandoverAggregate } from "@/types/equal-technician-handover";
import type {
  IncomingAcceptanceApplicationReceipt,
  IncomingAcceptanceAttendanceRecord,
  IncomingAcceptanceEvidenceRecord,
  IncomingAcceptanceIncomingShiftRecord,
  IncomingAcceptanceMembershipRecord,
  IncomingAcceptanceOperationRecord,
} from "@/types/incoming-acceptance-application";
import type { AttendanceEvidence, AttendanceOperation } from "@/types/attendance-evidence";
import {
  assertIncomingAcceptanceEvidenceConsistency,
  assertIncomingAcceptanceOutcome,
  assertIncomingAcceptanceParticipationConsistency,
  assertIncomingAcceptanceReservation,
  IncomingAcceptanceApplicationError,
  type IncomingAcceptanceActivationReceipt,
} from "./incoming-acceptance-application-domain";
import {
  assertApplicationAudit,
  AtomicAcceptanceServiceError,
  readPersistedReceipt,
  reservationBinding,
} from "./incoming-acceptance-application-firestore";
import {
  readAttendanceEvidenceSnapshot,
  readAttendanceOperationSnapshot,
} from "./attendance-evidence-firestore-state";

export type IncomingAcceptanceVerificationCode =
  | "BINDING_CONFLICT"
  | "INCONSISTENT"
  | "UNRESOLVED_COMMIT";

export class IncomingAcceptanceVerificationError extends Error {
  public readonly code: IncomingAcceptanceVerificationCode;

  constructor(code: IncomingAcceptanceVerificationCode, message: string) {
    super(message);
    this.name = "IncomingAcceptanceVerificationError";
    this.code = code;
  }
}

export interface IncomingAcceptanceApplicationSnapshots {
  receipt: DocumentSnapshot;
  evidence: DocumentSnapshot;
  operation: DocumentSnapshot;
  membership: DocumentSnapshot;
  attendance: DocumentSnapshot;
  audit: DocumentSnapshot;
}

export interface VerifyIncomingAcceptanceApplicationInput {
  aggregate: EqualHandoverAggregate;
  handoverDocumentId: string;
  technicianUid: string;
  expectedReceiptId: string;
  activationReceipt: IncomingAcceptanceActivationReceipt;
  incomingShift: IncomingAcceptanceIncomingShiftRecord | null;
  snapshots: IncomingAcceptanceApplicationSnapshots;
  /** Guard cleanup and reconciliation may run after the shift has ended. */
  allowHistoricalDeparture?: boolean;
}

function operationRecord(operation: AttendanceOperation): IncomingAcceptanceOperationRecord {
  return {
    id: operation.id,
    status: operation.status,
    eventId: operation.request.eventId,
    technicianUid: operation.request.technicianUid,
    kind: operation.request.kind,
    evidenceId: operation.evidenceId,
    interruptedFinalization: operation.interruptedFinalization,
  };
}

function evidenceRecord(evidence: AttendanceEvidence): IncomingAcceptanceEvidenceRecord {
  return {
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
  };
}

/**
 * Validates one persisted application end to end and returns the hydrated
 * receipt. Throws `IncomingAcceptanceVerificationError` for every failure so a
 * caller can map the failure onto its own typed status without guessing.
 */
export function verifyIncomingAcceptanceApplication(
  input: VerifyIncomingAcceptanceApplicationInput,
): IncomingAcceptanceApplicationReceipt {
  const { snapshots } = input;
  if (!snapshots.receipt.exists) {
    throw new IncomingAcceptanceVerificationError(
      "INCONSISTENT",
      "The application receipt is missing.",
    );
  }

  let receipt: IncomingAcceptanceApplicationReceipt;
  try {
    receipt = readPersistedReceipt(snapshots.receipt.data());
  } catch (error) {
    if (error instanceof AtomicAcceptanceServiceError) {
      throw new IncomingAcceptanceVerificationError(
        "UNRESOLVED_COMMIT",
        "The application commit marker is unresolved; refresh status before retrying.",
      );
    }
    throw new IncomingAcceptanceVerificationError(
      "INCONSISTENT",
      "The persisted application receipt is malformed.",
    );
  }

  if (receipt.id !== input.expectedReceiptId ||
      receipt.technicianUid !== input.technicianUid ||
      receipt.handoverDocumentId !== input.handoverDocumentId ||
      receipt.reservationId !== input.aggregate.reservation.handoverId ||
      receipt.outgoingShiftId !== input.aggregate.identity.outgoingShiftId ||
      receipt.incomingShiftId !== input.aggregate.identity.incomingShiftId) {
    throw new IncomingAcceptanceVerificationError(
      "BINDING_CONFLICT",
      "The application receipt does not belong to this handover, technician or slot.",
    );
  }

  try {
    assertIncomingAcceptanceReservation(
      receipt,
      reservationBinding(input.aggregate, input.handoverDocumentId),
    );
    assertIncomingAcceptanceOutcome({
      receipt,
      activationReceipt: input.activationReceipt,
      incomingShift: input.incomingShift,
      scheduledStart: input.aggregate.identity.scheduledStart,
      scheduledEnd: input.aggregate.identity.scheduledEnd,
      requireActiveShift: false,
    });
  } catch (error) {
    if (error instanceof IncomingAcceptanceApplicationError) {
      throw new IncomingAcceptanceVerificationError("BINDING_CONFLICT", error.message);
    }
    throw error;
  }

  const evidence = readAttendanceEvidenceSnapshot(snapshots.evidence);
  const operation = readAttendanceOperationSnapshot(snapshots.operation);
  if (evidence === null || operation === null) {
    throw new IncomingAcceptanceVerificationError(
      "INCONSISTENT",
      "The application receipt has no finalized attendance evidence or operation.",
    );
  }
  try {
    assertIncomingAcceptanceEvidenceConsistency({
      receipt,
      operation: operationRecord(operation),
      evidence: evidenceRecord(evidence),
    });
  } catch {
    throw new IncomingAcceptanceVerificationError(
      "INCONSISTENT",
      "The attendance evidence does not match the application receipt.",
    );
  }

  if (!snapshots.membership.exists || !snapshots.attendance.exists) {
    throw new IncomingAcceptanceVerificationError(
      "INCONSISTENT",
      "The application receipt is missing its membership or attendance record.",
    );
  }
  try {
    assertIncomingAcceptanceParticipationConsistency({
      receipt,
      membership: snapshots.membership.data() as IncomingAcceptanceMembershipRecord,
      attendance: snapshots.attendance.data() as IncomingAcceptanceAttendanceRecord,
      allowHistoricalDeparture: input.allowHistoricalDeparture === true,
    });
  } catch {
    throw new IncomingAcceptanceVerificationError(
      "INCONSISTENT",
      "The participation records contradict the application receipt.",
    );
  }

  if (!snapshots.audit.exists) {
    throw new IncomingAcceptanceVerificationError(
      "INCONSISTENT",
      "The application audit is missing.",
    );
  }
  try {
    assertApplicationAudit(snapshots.audit.data(), receipt);
  } catch {
    throw new IncomingAcceptanceVerificationError(
      "INCONSISTENT",
      "The application audit does not match its receipt.",
    );
  }

  return receipt;
}
