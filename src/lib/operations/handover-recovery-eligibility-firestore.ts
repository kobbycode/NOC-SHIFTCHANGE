// Phase 8C.3 — authoritative, read-only recovery-eligibility read model.
//
// Every document is read inside one Firestore transaction and nothing is
// written. Document ids come from the production factories; when an id cannot
// be derived with certainty the model says so instead of guessing. The
// classification and digest are produced by the pure domain module.

import "server-only";

import type {
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
  Transaction,
} from "firebase-admin/firestore";

import type { EqualHandoverAggregate } from "@/types/equal-technician-handover";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import type {
  IncomingAcceptanceApplicationReceipt,
  IncomingAcceptanceIncomingShiftRecord,
  IncomingAcceptanceLegacyState,
} from "@/types/incoming-acceptance-application";
import {
  HANDOVER_REVIEW_CASE_SCHEMA,
  HANDOVER_REVIEW_CASE_STATUSES,
} from "@/types/handover-admin-review";
import type {
  HandoverRecoveryEligibilityApplicationView,
  HandoverRecoveryEligibilityAttendanceView,
  HandoverRecoveryEligibilityEvidenceView,
  HandoverRecoveryEligibilityGuardHistoryEntryView,
  HandoverRecoveryEligibilityGuardHistoryView,
  HandoverRecoveryEligibilityGuardView,
  HandoverRecoveryEligibilityMembershipView,
  HandoverRecoveryEligibilityReadModel,
  HandoverRecoveryEligibilityReconciliationView,
  HandoverRecoveryEligibilityResult,
  HandoverRecoveryEligibilityReviewCaseView,
  HandoverRecoveryEligibilityShiftView,
  HandoverRecoveryEligibilitySlotView,
} from "@/types/handover-recovery-eligibility";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID, getOperationalCollections } from "./collections";
import {
  assertHandoverAggregate,
  createHandoverDocumentId,
} from "./handover-domain";
import {
  assertEqualHandoverAggregate,
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
} from "./equal-technician-handover-domain";
import {
  assertEqualHandoverCommitReceipt,
  equalHandoverCommitReceiptId,
} from "./equal-handover-report-firestore";
import { assertFrozenEqualHandoverReportV2 } from "./equal-handover-report-domain";
import {
  assertHandoverReservationGuard,
  createHandoverReservationGuardDocumentId,
  createReservationGuardArchiveDocumentId,
} from "./handover-reservation-guard-domain";
import { readReservationGuardState } from "./handover-reservation-guard";
import { assertOperationalShiftControl } from "./operational-shift-control-state";
import {
  SHIFT_ACTIVATION_WINDOW,
  assertShiftActivationWindowExpired,
} from "./shift-activation-window";
import { parseShiftTimeRange } from "./shift-overlap";
import {
  ALL_ATTENDANCE_EVIDENCE_KINDS,
  ATTENDANCE_EVIDENCE_KINDS,
  attendanceOperationId,
} from "./attendance-evidence-domain";
import {
  readAttendanceEvidenceSnapshot,
  readAttendanceOperationSnapshot,
} from "./attendance-evidence-firestore-state";
import {
  AtomicAcceptanceServiceError,
  assertApplicationAudit,
  assertReportDocument,
  readPersistedReceipt,
} from "./incoming-acceptance-application-firestore";
import {
  assertIncomingAcceptanceActivationReceipt,
  classifyIncomingAcceptanceLegacyState,
  createIncomingAcceptanceActivationReceiptId,
  createIncomingAcceptanceApplicationIdentity,
  createLegacyIncomingAcceptanceEventId,
  type IncomingAcceptanceActivationReceipt,
} from "./incoming-acceptance-application-domain";
import {
  IncomingAcceptanceVerificationError,
  verifyIncomingAcceptanceApplication,
} from "./incoming-acceptance-receipt-verification";
import { createHandoverReviewCaseId } from "./handover-admin-review-domain";
import {
  classifyHandoverRecoveryEligibility,
  createHandoverRecoveryEligibilityResult,
} from "./handover-recovery-eligibility-domain";

const HANDOVER_DOCUMENT_PREFIX = "handover_v2_";

// `createIncomingAcceptanceApplicationIdentity` accepts exactly these two
// evidence kinds and rejects every other kind, so reading both covers the
// complete personal-artifact space. If the enumeration ever changes,
// `kindSetComplete` becomes false and the classifier refuses.
const INCOMING_ACCEPTANCE_KINDS = ALL_ATTENDANCE_EVIDENCE_KINDS.filter(
  (kind) =>
    kind === ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN ||
    kind === ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE,
);

export type HandoverRecoveryEligibilityErrorCode =
  | "ELIGIBILITY_INVALID_HANDOVER"
  | "ELIGIBILITY_FORBIDDEN"
  | "ELIGIBILITY_UNAVAILABLE";

export class HandoverRecoveryEligibilityError extends Error {
  public readonly code: HandoverRecoveryEligibilityErrorCode;
  public readonly status: number;

  constructor(code: HandoverRecoveryEligibilityErrorCode, message: string, status: number) {
    super(message);
    this.name = "HandoverRecoveryEligibilityError";
    this.code = code;
    this.status = status;
  }
}

export interface HandoverRecoveryEligibilityEvaluation {
  result: HandoverRecoveryEligibilityResult;
  readModel: HandoverRecoveryEligibilityReadModel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoFrom(value: unknown): string | null {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (value && typeof value === "object" && typeof (value as { toDate?: unknown }).toDate === "function") {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Canonicalise a caller-supplied document id to its outgoing shift id. A value
 * that does not round-trip through the production factory is rejected rather
 * than repaired.
 */
export function parseHandoverRecoveryDocumentId(
  value: unknown,
): { handoverDocumentId: string; outgoingShiftId: string } {
  if (
    typeof value !== "string" ||
    !value.startsWith(HANDOVER_DOCUMENT_PREFIX) ||
    value.length === HANDOVER_DOCUMENT_PREFIX.length
  ) {
    throw new HandoverRecoveryEligibilityError(
      "ELIGIBILITY_INVALID_HANDOVER",
      "Invalid handover document.",
      400,
    );
  }
  const outgoingShiftId = value.slice(HANDOVER_DOCUMENT_PREFIX.length);
  let canonical: string;
  try {
    canonical = createEqualHandoverDocumentId(outgoingShiftId);
  } catch {
    throw new HandoverRecoveryEligibilityError(
      "ELIGIBILITY_INVALID_HANDOVER",
      "Invalid handover document.",
      400,
    );
  }
  if (canonical !== value) {
    throw new HandoverRecoveryEligibilityError(
      "ELIGIBILITY_INVALID_HANDOVER",
      "Invalid handover document.",
      400,
    );
  }
  return { handoverDocumentId: value, outgoingShiftId };
}

function assertEligibilityViewer(value: unknown): void {
  if (
    !isRecord(value) ||
    (value.role !== "admin" && value.role !== "supervisor") ||
    value.status !== "active" ||
    value.statusOperation != null ||
    value.mustChangePassword === true
  ) {
    throw new HandoverRecoveryEligibilityError(
      "ELIGIBILITY_FORBIDDEN",
      "Only authorized supervisors and administrators can inspect recovery eligibility.",
      403,
    );
  }
}

interface SlotRead {
  kind: string;
  evidenceId: string;
  operationId: string;
  legacyOperationId: string;
  evidenceSnapshot: DocumentSnapshot;
  operationSnapshot: DocumentSnapshot;
  legacyOperationSnapshot: DocumentSnapshot;
}

interface TechnicianReadSet {
  technicianUid: string;
  receiptId: string;
  auditId: string;
  membershipId: string;
  attendanceId: string;
  receiptSnapshot: DocumentSnapshot;
  auditSnapshot: DocumentSnapshot;
  membershipSnapshot: DocumentSnapshot;
  attendanceSnapshot: DocumentSnapshot;
  slots: SlotRead[];
}

interface ActivationWindowView {
  scheduledStart: string;
  scheduledEnd: string;
  latestActivationAt: string;
  closedAtEvaluation: boolean;
}

function unknownWindow(): ActivationWindowView {
  return { scheduledStart: "", scheduledEnd: "", latestActivationAt: "", closedAtEvaluation: false };
}

function evaluateActivationWindow(
  scheduledStart: string,
  scheduledEnd: string,
  now: Date,
): ActivationWindowView {
  try {
    const range = parseShiftTimeRange(scheduledStart, scheduledEnd);
    const latestActivationAt = new Date(
      Math.min(range.start + SHIFT_ACTIVATION_WINDOW.LATE_MINUTES * 60_000, range.end),
    ).toISOString();
    try {
      assertShiftActivationWindowExpired(scheduledStart, scheduledEnd, now);
      return { scheduledStart, scheduledEnd, latestActivationAt, closedAtEvaluation: true };
    } catch {
      return { scheduledStart, scheduledEnd, latestActivationAt, closedAtEvaluation: false };
    }
  } catch {
    return unknownWindow();
  }
}

function receiptView(present: boolean, id: string, receiptHash: string | null, valid: boolean) {
  return { present, id, receiptHash, valid };
}

function readGuardHistory(snapshot: QuerySnapshot): HandoverRecoveryEligibilityGuardHistoryView {
  if (snapshot.empty) {
    return { present: false, unreadable: false, entries: [] };
  }
  const entries: HandoverRecoveryEligibilityGuardHistoryEntryView[] = [];
  for (const document of snapshot.docs) {
    try {
      const archived = assertHandoverReservationGuard(document.data());
      // The archived payload keeps the live guard's `id`, so the only stable
      // per-archive identity is the content-derived document id. Requiring the
      // two to agree catches a moved or forged archive.
      if (createReservationGuardArchiveDocumentId(archived) !== document.id) {
        return { present: true, unreadable: true, entries: [] };
      }
      entries.push({
        id: document.id,
        ownerLifecycleState: archived.ownerLifecycleState,
        guardRevision: archived.guardRevision,
        fencingEpoch: archived.fencingEpoch,
        outgoingSlotToken: archived.outgoingSlotToken,
        terminalEvidenceRef: archived.terminalEvidenceRef ?? null,
      });
    } catch {
      return { present: true, unreadable: true, entries: [] };
    }
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  return { present: true, unreadable: false, entries };
}

function readGuard(
  snapshot: DocumentSnapshot,
  outgoingShiftId: string,
): { view: HandoverRecoveryEligibilityGuardView; typed: HandoverReservationGuard | null } {
  const id = createHandoverReservationGuardDocumentId(outgoingShiftId);
  if (!snapshot.exists) {
    return {
      view: {
        present: false,
        id,
        protocolOwner: null,
        ownerHandoverDocumentId: null,
        ownerLifecycleState: null,
        guardRevision: null,
        fencingEpoch: null,
        outgoingSlotToken: null,
        outgoingGeneration: null,
        successorSlotToken: null,
        successorGeneration: null,
        reservationId: null,
        reservedIncomingShiftId: null,
        reservedAt: null,
        terminalEvidenceRef: null,
        unreadable: false,
      },
      typed: null,
    };
  }
  try {
    const guard = assertHandoverReservationGuard(snapshot.data());
    return {
      view: {
        present: true,
        id: guard.id,
        protocolOwner: guard.protocolOwner,
        ownerHandoverDocumentId: guard.ownerHandoverDocumentId,
        ownerLifecycleState: guard.ownerLifecycleState,
        guardRevision: guard.guardRevision,
        fencingEpoch: guard.fencingEpoch,
        outgoingSlotToken: guard.outgoingSlotToken,
        outgoingGeneration: guard.outgoingGeneration,
        successorSlotToken: guard.successorSlotToken,
        successorGeneration: guard.successorGeneration,
        reservationId: guard.reservationId,
        reservedIncomingShiftId: guard.reservedIncomingShiftId,
        reservedAt: guard.reservedAt,
        terminalEvidenceRef: guard.terminalEvidenceRef ?? null,
        unreadable: false,
      },
      typed: guard,
    };
  } catch {
    return {
      view: {
        present: true,
        id,
        protocolOwner: null,
        ownerHandoverDocumentId: null,
        ownerLifecycleState: null,
        guardRevision: null,
        fencingEpoch: null,
        outgoingSlotToken: null,
        outgoingGeneration: null,
        successorSlotToken: null,
        successorGeneration: null,
        reservationId: null,
        reservedIncomingShiftId: null,
        reservedAt: null,
        terminalEvidenceRef: null,
        unreadable: true,
      },
      typed: null,
    };
  }
}

function readShift(snapshot: DocumentSnapshot, id: string): HandoverRecoveryEligibilityShiftView {
  if (!snapshot.exists) {
    return {
      present: false,
      id,
      status: null,
      actualStart: null,
      actualEnd: null,
      handoverStartedAt: null,
      permanentPairId: null,
      primaryTechnicianIds: [],
      unreadable: false,
    };
  }
  const data = snapshot.data();
  if (!isRecord(data)) {
    return {
      present: true,
      id,
      status: null,
      actualStart: null,
      actualEnd: null,
      handoverStartedAt: null,
      permanentPairId: null,
      primaryTechnicianIds: [],
      unreadable: true,
    };
  }
  return {
    present: true,
    id,
    status: stringOrNull(data.status),
    actualStart: isoFrom(data.actualStart),
    actualEnd: isoFrom(data.actualEnd),
    handoverStartedAt: isoFrom(data.handoverStartedAt),
    permanentPairId: stringOrNull(data.permanentPairId),
    primaryTechnicianIds: stringArray(data.primaryTechnicianIds),
    unreadable: false,
  };
}

function readSlot(snapshot: DocumentSnapshot): HandoverRecoveryEligibilitySlotView {
  if (!snapshot.exists) {
    return {
      present: false,
      slotStatus: null,
      shiftId: null,
      shiftStatus: null,
      slotToken: null,
      generation: null,
      updatedAt: null,
      unreadable: false,
    };
  }
  try {
    const control = assertOperationalShiftControl(snapshot.data());
    return {
      present: true,
      slotStatus: control.slotStatus,
      shiftId: control.shiftId,
      shiftStatus: control.shiftStatus,
      slotToken: control.slotToken,
      generation: control.generation,
      updatedAt: control.updatedAt,
      unreadable: false,
    };
  } catch {
    return {
      present: true,
      slotStatus: null,
      shiftId: null,
      shiftStatus: null,
      slotToken: null,
      generation: null,
      updatedAt: null,
      unreadable: true,
    };
  }
}

function readReviewCase(
  snapshot: DocumentSnapshot,
  handoverDocumentId: string,
): HandoverRecoveryEligibilityReviewCaseView {
  const id = createHandoverReviewCaseId(handoverDocumentId);
  if (!snapshot.exists) {
    return { present: false, id, status: null, caseRevision: null, fingerprint: null, unreadable: false };
  }
  const data = snapshot.data();
  if (
    !isRecord(data) ||
    data.schema !== HANDOVER_REVIEW_CASE_SCHEMA ||
    data.id !== id ||
    data.handoverDocumentId !== handoverDocumentId ||
    !Number.isSafeInteger(data.caseRevision) ||
    (data.caseRevision as number) < 1 ||
    typeof data.fingerprintAtLastDecision !== "string" ||
    !/^[0-9a-f]{64}$/.test(data.fingerprintAtLastDecision) ||
    !Object.values(HANDOVER_REVIEW_CASE_STATUSES).includes(
      data.status as (typeof HANDOVER_REVIEW_CASE_STATUSES)[keyof typeof HANDOVER_REVIEW_CASE_STATUSES],
    )
  ) {
    return { present: true, id, status: null, caseRevision: null, fingerprint: null, unreadable: true };
  }
  return {
    present: true,
    id,
    status: data.status as string,
    caseRevision: data.caseRevision as number,
    fingerprint: data.fingerprintAtLastDecision,
    unreadable: false,
  };
}

function legacyLifecycle(snapshot: DocumentSnapshot): string | null {
  try {
    return assertHandoverAggregate(snapshot.data()).lifecycleStatus;
  } catch {
    return null;
  }
}

function evidenceViewFor(slot: SlotRead, technicianUid: string): HandoverRecoveryEligibilityEvidenceView {
  let evidence = null;
  let operation = null;
  let legacyOperation = null;
  let unreadable = false;
  try {
    evidence = readAttendanceEvidenceSnapshot(slot.evidenceSnapshot);
  } catch {
    unreadable = true;
  }
  try {
    operation = readAttendanceOperationSnapshot(slot.operationSnapshot);
  } catch {
    unreadable = true;
  }
  try {
    legacyOperation = readAttendanceOperationSnapshot(slot.legacyOperationSnapshot);
  } catch {
    unreadable = true;
  }
  return {
    id: slot.evidenceId,
    technicianUid,
    kind: slot.kind,
    present: slot.evidenceSnapshot.exists,
    finalizedAt: evidence?.finalizedAt ?? null,
    snapshotHash: evidence?.snapshotHash ?? null,
    guardRevision: evidence?.guardRevision ?? null,
    fencingEpoch: evidence?.fencingEpoch ?? null,
    operationId: slot.operationId,
    operationPresent: slot.operationSnapshot.exists,
    operationStatus: operation?.status ?? null,
    operationInterrupted: operation?.interruptedFinalization ?? false,
    legacyOperationId: slot.legacyOperationId,
    legacyOperationPresent: slot.legacyOperationSnapshot.exists,
    legacyOperationStatus: legacyOperation?.status ?? null,
    legacyOperationInterrupted: legacyOperation?.interruptedFinalization ?? false,
    requestDigest: operation?.requestDigest ?? legacyOperation?.requestDigest ?? null,
    unreadable,
  };
}

function applicationViewFor(read: TechnicianReadSet): HandoverRecoveryEligibilityApplicationView {
  let receipt: IncomingAcceptanceApplicationReceipt | null = null;
  let unreadable = false;
  if (read.receiptSnapshot.exists) {
    try {
      receipt = readPersistedReceipt(read.receiptSnapshot.data());
      if (
        receipt.technicianUid !== read.technicianUid ||
        receipt.id !== read.receiptId ||
        receipt.auditId !== read.auditId
      ) {
        receipt = null;
        unreadable = true;
      }
    } catch {
      unreadable = true;
    }
  }
  if (receipt !== null && read.auditSnapshot.exists) {
    try {
      assertApplicationAudit(read.auditSnapshot.data(), receipt);
    } catch {
      unreadable = true;
    }
  }
  return {
    technicianUid: read.technicianUid,
    receiptId: read.receiptId,
    present: read.receiptSnapshot.exists,
    receiptHash: receipt?.receiptHash ?? null,
    outcome: receipt?.outcome ?? null,
    evidenceKind: receipt?.evidenceKind ?? null,
    auditId: read.auditId,
    auditPresent: read.auditSnapshot.exists,
    unreadable,
  };
}

function membershipViewFor(read: TechnicianReadSet): HandoverRecoveryEligibilityMembershipView {
  const data = read.membershipSnapshot.exists ? read.membershipSnapshot.data() : null;
  return {
    id: read.membershipId,
    present: read.membershipSnapshot.exists,
    joinedAt: isRecord(data) ? isoFrom(data.joinedAt) : null,
    leftAt: isRecord(data) ? isoFrom(data.leftAt) : null,
  };
}

function attendanceViewFor(read: TechnicianReadSet): HandoverRecoveryEligibilityAttendanceView {
  const data = read.attendanceSnapshot.exists ? read.attendanceSnapshot.data() : null;
  return {
    id: read.attendanceId,
    present: read.attendanceSnapshot.exists,
    clockIn: isRecord(data) ? isoFrom(data.clockIn) : null,
    clockOut: isRecord(data) ? isoFrom(data.clockOut) : null,
  };
}

// Mirrors `legacyStatus` in the production reconciliation service. It is local
// because that service owns its own transaction and technician authorization.
function reconciliationFromLegacy(classification: string): { status: string; reason: string } {
  switch (classification) {
    case "NATIVE_APPLIED":
      return { status: "APPLIED_VALIDATED", reason: "NATIVE_RECEIPT_VALIDATED" };
    case "LEGACY_APPLIED_UNATTESTED_V1":
      return { status: "ADMIN_REVIEW_REQUIRED", reason: "LEGACY_APPLIED_WITHOUT_PERSONAL_RECEIPT" };
    case "LEGACY_UNAPPLIED_AUTHENTICATED_ATTEMPT":
      return { status: "EVIDENCE_ONLY", reason: "EVIDENCE_WITHOUT_OPERATIONAL_APPLICATION" };
    case "LEGACY_PENDING_INTENT":
      return { status: "COMMIT_UNVERIFIABLE", reason: "PENDING_OPERATION_WITHOUT_EVIDENCE" };
    case "LEGACY_ACK_INTERRUPTED":
      return { status: "COMMIT_UNVERIFIABLE", reason: "INTERRUPTED_FINALIZATION" };
    case "LEGACY_ABORTED_INTENT":
      return { status: "NOT_APPLIED", reason: "ABORTED_OPERATION" };
    case "INCONSISTENT_REVIEW_REQUIRED":
      return { status: "INCONSISTENT_HISTORY", reason: "CONTRADICTORY_RECORDS" };
    default:
      return { status: "NOT_APPLIED", reason: "NO_APPLICATION_RECORD" };
  }
}

interface ReconciliationInput {
  read: TechnicianReadSet;
  aggregate: EqualHandoverAggregate;
  handoverDocumentId: string;
  activationReceipt: IncomingAcceptanceActivationReceipt | null;
  activationReceiptPresent: boolean;
  incomingShift: IncomingAcceptanceIncomingShiftRecord | null;
  guard: HandoverReservationGuard | null;
  guardConflicted: boolean;
  reportSnapshot: DocumentSnapshot | null;
  partnerReceiptSnapshot: DocumentSnapshot;
}

function reconcileTechnician(
  input: ReconciliationInput,
): HandoverRecoveryEligibilityReconciliationView {
  const { read } = input;
  const technicianUid = read.technicianUid;

  if (read.receiptSnapshot.exists) {
    let receipt: IncomingAcceptanceApplicationReceipt;
    try {
      receipt = readPersistedReceipt(read.receiptSnapshot.data());
    } catch (error) {
      return error instanceof AtomicAcceptanceServiceError
        ? { technicianUid, status: "COMMIT_UNVERIFIABLE", reason: "COMMIT_MARKER_UNRESOLVED" }
        : { technicianUid, status: "INCONSISTENT_HISTORY", reason: "MALFORMED_APPLICATION_RECEIPT" };
    }
    if (input.activationReceipt === null) {
      return { technicianUid, status: "INCONSISTENT_HISTORY", reason: "ACTIVATION_RECEIPT_MISSING" };
    }
    if (input.aggregate.lifecycleStatus !== "completed") {
      return {
        technicianUid,
        status: "INCONSISTENT_HISTORY",
        reason: "APPLICATION_RECEIPT_WITHOUT_ACTIVATION",
      };
    }
    const slotIndex = read.slots.findIndex((slot) => slot.evidenceId === receipt.evidenceId);
    if (slotIndex === -1) {
      return { technicianUid, status: "INCONSISTENT_HISTORY", reason: "RECEIPT_EVIDENCE_SLOT_UNKNOWN" };
    }
    try {
      verifyIncomingAcceptanceApplication({
        aggregate: input.aggregate,
        handoverDocumentId: input.handoverDocumentId,
        technicianUid,
        expectedReceiptId: read.receiptId,
        activationReceipt: input.activationReceipt,
        incomingShift: input.incomingShift,
        snapshots: {
          receipt: read.receiptSnapshot,
          evidence: read.slots[slotIndex].evidenceSnapshot,
          operation: read.slots[slotIndex].operationSnapshot,
          membership: read.membershipSnapshot,
          attendance: read.attendanceSnapshot,
          audit: read.auditSnapshot,
        },
        allowHistoricalDeparture: true,
      });
    } catch (error) {
      if (!(error instanceof IncomingAcceptanceVerificationError)) throw error;
      return {
        technicianUid,
        status:
          error.code === "UNRESOLVED_COMMIT"
            ? "COMMIT_UNVERIFIABLE"
            : error.code === "BINDING_CONFLICT"
              ? "BINDING_CONFLICT"
              : "INCONSISTENT_HISTORY",
        reason: error.message,
      };
    }
    if (input.guardConflicted || input.guard === null) {
      return { technicianUid, status: "GUARD_CONFLICT", reason: "GUARD_BINDING_INCONSISTENT" };
    }
    if (
      input.guard.ownerLifecycleState === "active" &&
      (receipt.appliedGuardBinding.guardRevision !== input.guard.guardRevision ||
        receipt.appliedGuardBinding.fencingEpoch !== input.guard.fencingEpoch)
    ) {
      return { technicianUid, status: "GUARD_CONFLICT", reason: "GUARD_REVISION_CHANGED_SINCE_APPLICATION" };
    }
    if (input.aggregate.reportBinding === null) {
      return { technicianUid, status: "BINDING_CONFLICT", reason: "FROZEN_REPORT_BINDING_MISSING" };
    }
    try {
      assertReportDocument(
        input.reportSnapshot,
        {
          handoverId: input.aggregate.reservation.handoverId,
          handoverDocumentId: input.handoverDocumentId,
          aggregateRevision: input.aggregate.revision,
          snapshotHash: createEqualHandoverSnapshot(input.aggregate).snapshotHash,
          report: {
            ...input.aggregate.reportBinding,
            aggregateRevision: input.aggregate.revision,
          },
          guardRevision: input.guard.guardRevision,
          fencingEpoch: input.guard.fencingEpoch,
        },
        input.aggregate,
      );
    } catch {
      return { technicianUid, status: "BINDING_CONFLICT", reason: "FROZEN_REPORT_BINDING_CHANGED" };
    }
    if (input.partnerReceiptSnapshot.exists) {
      try {
        const partner = readPersistedReceipt(input.partnerReceiptSnapshot.data());
        if (partner.outcome === receipt.outcome) {
          return { technicianUid, status: "INCONSISTENT_HISTORY", reason: "DUPLICATE_APPLICATION_OUTCOME" };
        }
      } catch {
        // An unreadable partner receipt does not invalidate this receipt.
      }
    }
    return {
      technicianUid,
      status: "APPLIED_VALIDATED",
      reason: "RECEIPT_EVIDENCE_PARTICIPATION_AUDIT_VALIDATED",
    };
  }

  const presentEvidence = read.slots.filter((slot) => slot.evidenceSnapshot.exists);
  if (presentEvidence.length > 1) {
    return { technicianUid, status: "INCONSISTENT_HISTORY", reason: "MULTIPLE_EVIDENCE_SLOTS" };
  }
  if (read.slots.some((slot) => slot.operationSnapshot.exists && slot.legacyOperationSnapshot.exists)) {
    return { technicianUid, status: "INCONSISTENT_HISTORY", reason: "DUPLICATE_EVIDENCE_OPERATIONS" };
  }
  if (read.auditSnapshot.exists) {
    return { technicianUid, status: "INCONSISTENT_HISTORY", reason: "APPLICATION_AUDIT_WITHOUT_RECEIPT" };
  }
  if (
    presentEvidence.length === 0 &&
    read.slots.every(
      (slot) => !slot.operationSnapshot.exists && !slot.legacyOperationSnapshot.exists,
    ) &&
    !read.membershipSnapshot.exists &&
    !read.attendanceSnapshot.exists
  ) {
    return { technicianUid, status: "NOT_APPLIED", reason: "NO_APPLICATION_RECORD" };
  }

  const slotIndex = read.slots.findIndex((slot) => slot.evidenceSnapshot.exists);
  let evidencePresent = false;
  if (slotIndex !== -1) {
    try {
      evidencePresent = readAttendanceEvidenceSnapshot(read.slots[slotIndex].evidenceSnapshot) !== null;
    } catch {
      return { technicianUid, status: "INCONSISTENT_HISTORY", reason: "MALFORMED_EVIDENCE_RECORD" };
    }
  }
  const slot = slotIndex === -1 ? null : read.slots[slotIndex];
  const operationSnapshot =
    slot === null
      ? null
      : slot.legacyOperationSnapshot.exists
        ? slot.legacyOperationSnapshot
        : slot.operationSnapshot.exists
          ? slot.operationSnapshot
          : null;
  const operationData = operationSnapshot?.data();
  const legacyState: IncomingAcceptanceLegacyState = {
    aggregateLifecycleStatus: input.aggregate.lifecycleStatus,
    activationReceiptPresent: input.activationReceiptPresent,
    activationReceiptConsistent: input.activationReceipt !== null,
    membershipPresent: read.membershipSnapshot.exists,
    attendancePresent: read.attendanceSnapshot.exists,
    evidence:
      slot === null
        ? null
        : {
            present: evidencePresent,
            finalized: isRecord(operationData) && operationData.status === "finalized",
            interruptedFinalization:
              isRecord(operationData) && operationData.interruptedFinalization === true,
          },
    operation:
      slot === null
        ? null
        : {
            present: operationSnapshot !== null,
            status: isRecord(operationData) ? stringOrNull(operationData.status) ?? "unknown" : "unknown",
          },
    nativeReceipt: null,
  };
  const classified = classifyIncomingAcceptanceLegacyState(legacyState);
  return { technicianUid, ...reconciliationFromLegacy(classified.classification) };
}

function emptyReadModel(input: {
  handoverDocumentId: string;
  outgoingShiftId: string;
  aggregatePresent: boolean;
  aggregateUnreadable: boolean;
  guard: HandoverRecoveryEligibilityGuardView;
  guardHistory: HandoverRecoveryEligibilityGuardHistoryView;
  legacyLifecycleStatus: string | null;
  outgoingShift: HandoverRecoveryEligibilityShiftView;
  slot: HandoverRecoveryEligibilitySlotView;
  reviewCase: HandoverRecoveryEligibilityReviewCaseView;
  kindSetComplete: boolean;
}): HandoverRecoveryEligibilityReadModel {
  return {
    handoverDocumentId: input.handoverDocumentId,
    outgoingShiftId: input.outgoingShiftId,
    incomingShiftId: "",
    aggregate: {
      present: input.aggregatePresent,
      id: input.handoverDocumentId,
      lifecycleStatus: null,
      revision: null,
      snapshotHash: null,
      identity: null,
      reservation: null,
      reportBinding: null,
      unreadable: input.aggregateUnreadable,
    },
    guard: input.guard,
    guardHistory: input.guardHistory,
    legacyHandover: {
      present: input.legacyLifecycleStatus !== null,
      id: createHandoverDocumentId(input.outgoingShiftId),
      lifecycleStatus: input.legacyLifecycleStatus,
    },
    outgoingShift: input.outgoingShift,
    slot: input.slot,
    activationWindow: unknownWindow(),
    commitReceipt: receiptView(false, equalHandoverCommitReceiptId(input.handoverDocumentId), null, false),
    activationReceipt: receiptView(
      false,
      createIncomingAcceptanceActivationReceiptId(input.handoverDocumentId),
      null,
      false,
    ),
    incomingShift: { present: false, id: "", status: null, actualStart: null },
    applications: [],
    memberships: [],
    attendance: [],
    evidence: [],
    reconciliation: [],
    report: {
      present: false,
      id: null,
      reportDigest: null,
      evidenceSnapshotHash: null,
      frozenAt: null,
      verified: false,
    },
    reviewCase: input.reviewCase,
    kindSetComplete: input.kindSetComplete,
  };
}

/**
 * Read one handover's authoritative recovery evidence and classify it. The
 * returned result is a point-in-time statement only; it never authorizes an
 * execution and this module performs no write of any kind.
 *
 * Phase 8C.4B split the collector out so a caller that must classify inside its
 * OWN transaction can do so: evaluateHandoverRecoveryEligibilityInTransaction
 * reads on the caller's transaction and still writes nothing. The standalone
 * entry point keeps its original behaviour, including its error mapping, by
 * opening a transaction and delegating to the same collector.
 */
export interface HandoverRecoveryEligibilityTransactionRequest {
  handoverDocumentId: string;
  outgoingShiftId: string;
  actorUid: string;
  now: Date;
  evaluatedAt: string;
  kindSetComplete: boolean;
}

// Validates every caller-supplied value before any transaction opens, so an
// invalid request never takes part in a read.
export async function prepareHandoverRecoveryEligibilityRequest(input: {
  handoverDocumentId: unknown;
  actorUid: unknown;
  now?: Date;
}): Promise<HandoverRecoveryEligibilityTransactionRequest> {
  const { handoverDocumentId, outgoingShiftId } = parseHandoverRecoveryDocumentId(
    input.handoverDocumentId,
  );
  if (typeof input.actorUid !== "string" || !input.actorUid.trim()) {
    throw new HandoverRecoveryEligibilityError(
      "ELIGIBILITY_FORBIDDEN",
      "Only authorized supervisors and administrators can inspect recovery eligibility.",
      403,
    );
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new HandoverRecoveryEligibilityError(
      "ELIGIBILITY_UNAVAILABLE",
      "Recovery eligibility cannot be evaluated right now.",
      503,
    );
  }
  return {
    handoverDocumentId,
    outgoingShiftId,
    actorUid: input.actorUid,
    now,
    evaluatedAt: now.toISOString(),
    kindSetComplete:
      INCOMING_ACCEPTANCE_KINDS.length === 2 &&
      INCOMING_ACCEPTANCE_KINDS.includes(ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN) &&
      INCOMING_ACCEPTANCE_KINDS.includes(ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE),
  };
}

async function collectHandoverRecoveryEligibilityReadModel(
  transaction: Transaction,
  request: HandoverRecoveryEligibilityTransactionRequest,
): Promise<HandoverRecoveryEligibilityReadModel> {
  const { handoverDocumentId, outgoingShiftId, actorUid, now, kindSetComplete } = request;
  const db = getAdminFirestore();
  const {
    equalHandoversV2,
    handoverReportsV2,
    shifts,
    shiftMembers,
    shiftAttendance,
    attendanceEvidenceV2,
    attendanceEvidenceOperationsV2,
    handoverReservationGuardHistory,
    operationalShiftControl,
  } = getOperationalCollections();
  const read = (reference: DocumentReference) => transaction.get(reference);
  const readQuery = (query: Query) => transaction.get(query);

  const [actorSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      read(db.collection("users").doc(actorUid)),
      read(equalHandoversV2.doc(handoverDocumentId)),
      readReservationGuardState(transaction, outgoingShiftId),
    ]);
    assertEligibilityViewer(actorSnapshot.data());

    const [guardHistorySnapshot, outgoingShiftSnapshot, slotSnapshot, reviewCaseSnapshot] =
      await Promise.all([
        readQuery(
          handoverReservationGuardHistory.where("outgoingShiftId", "==", outgoingShiftId),
        ),
        read(shifts.doc(outgoingShiftId)),
        read(operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID)),
        read(
          db
            .collection("handover_review_cases_v1")
            .doc(createHandoverReviewCaseId(handoverDocumentId)),
        ),
      ]);

    const guard = readGuard(guardState.guardSnapshot, outgoingShiftId);
    const guardHistory = readGuardHistory(guardHistorySnapshot);
    const outgoingShift = readShift(outgoingShiftSnapshot, outgoingShiftId);
    const slot = readSlot(slotSnapshot);
    const reviewCase = readReviewCase(reviewCaseSnapshot, handoverDocumentId);
    const legacyLifecycleStatus = guardState.legacySnapshot.exists
      ? legacyLifecycle(guardState.legacySnapshot)
      : null;

    let aggregate: EqualHandoverAggregate | null = null;
    let aggregateUnreadable = false;
    if (aggregateSnapshot.exists) {
      try {
        const parsed = assertEqualHandoverAggregate(aggregateSnapshot.data());
        if (createEqualHandoverDocumentId(parsed.identity.outgoingShiftId) !== handoverDocumentId) {
          aggregateUnreadable = true;
        } else {
          aggregate = parsed;
        }
      } catch {
        aggregateUnreadable = true;
      }
    }

    if (aggregate === null) {
      return emptyReadModel({
        handoverDocumentId,
        outgoingShiftId,
        aggregatePresent: aggregateSnapshot.exists,
        aggregateUnreadable,
        guard: guard.view,
        guardHistory,
        legacyLifecycleStatus,
        outgoingShift,
        slot,
        reviewCase,
        kindSetComplete,
      });
    }

    const identity = aggregate.identity;
    const reservation = aggregate.reservation;
    const incomingShiftId = identity.incomingShiftId;
    const reportBindingId = aggregate.reportBinding?.id ?? null;
    const commitReceiptId = equalHandoverCommitReceiptId(handoverDocumentId);
    const activationReceiptId = createIncomingAcceptanceActivationReceiptId(handoverDocumentId);

    const technicians = identity.incomingTechnicianIds.map((technicianUid) => {
      const receiptIdentity = createIncomingAcceptanceApplicationIdentity({
        handoverId: reservation.handoverId,
        technicianUid,
        kind: ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
      });
      const slots = INCOMING_ACCEPTANCE_KINDS.map((kind) => {
        const slotIdentity = createIncomingAcceptanceApplicationIdentity({
          handoverId: reservation.handoverId,
          technicianUid,
          kind,
        });
        const legacyOperationId = attendanceOperationId(
          createLegacyIncomingAcceptanceEventId({
            handoverId: reservation.handoverId,
            technicianUid,
            kind,
          }),
        );
        return {
          kind,
          evidenceId: slotIdentity.evidenceId,
          operationId: slotIdentity.operationId,
          legacyOperationId,
          evidenceRef: attendanceEvidenceV2.doc(slotIdentity.evidenceId),
          operationRef: attendanceEvidenceOperationsV2.doc(slotIdentity.operationId),
          legacyOperationRef: attendanceEvidenceOperationsV2.doc(legacyOperationId),
        };
      });
      return {
        technicianUid,
        receiptId: receiptIdentity.receiptId,
        auditId: receiptIdentity.auditId,
        membershipId: `${incomingShiftId}_${technicianUid}`,
        attendanceId: `${incomingShiftId}_${technicianUid}`,
        receiptRef: db.collection("incoming_acceptance_applications_v1").doc(receiptIdentity.receiptId),
        auditRef: db.collection("audit_logs").doc(receiptIdentity.auditId),
        membershipRef: shiftMembers.doc(`${incomingShiftId}_${technicianUid}`),
        attendanceRef: shiftAttendance.doc(`${incomingShiftId}_${technicianUid}`),
        slots,
      };
    });

    const [
      reportSnapshot,
      commitReceiptSnapshot,
      activationReceiptSnapshot,
      incomingShiftSnapshot,
      receiptSnapshots,
      auditSnapshots,
      membershipSnapshots,
      attendanceSnapshots,
      slotEvidenceSnapshots,
      slotOperationSnapshots,
      slotLegacyOperationSnapshots,
    ] = await Promise.all([
      reportBindingId === null
        ? Promise.resolve(null as unknown as DocumentSnapshot)
        : read(handoverReportsV2.doc(reportBindingId)),
      read(db.collection("audit_logs").doc(commitReceiptId)),
      read(db.collection("audit_logs").doc(activationReceiptId)),
      read(shifts.doc(incomingShiftId)),
      Promise.all(technicians.map((entry) => read(entry.receiptRef))),
      Promise.all(technicians.map((entry) => read(entry.auditRef))),
      Promise.all(technicians.map((entry) => read(entry.membershipRef))),
      Promise.all(technicians.map((entry) => read(entry.attendanceRef))),
      Promise.all(technicians.flatMap((entry) => entry.slots.map((slot) => read(slot.evidenceRef)))),
      Promise.all(technicians.flatMap((entry) => entry.slots.map((slot) => read(slot.operationRef)))),
      Promise.all(
        technicians.flatMap((entry) => entry.slots.map((slot) => read(slot.legacyOperationRef))),
      ),
    ]);

    let slotCursor = 0;
    let legacySlotCursor = 0;
    const technicianSets: TechnicianReadSet[] = technicians.map((entry, index) => {
      const slots = entry.slots.map((slot) => {
        const evidenceSnapshot = slotEvidenceSnapshots[slotCursor];
        const operationSnapshot = slotOperationSnapshots[slotCursor];
        const legacyOperationSnapshot = slotLegacyOperationSnapshots[legacySlotCursor];
        slotCursor += 1;
        legacySlotCursor += 1;
        return {
          kind: slot.kind,
          evidenceId: slot.evidenceId,
          operationId: slot.operationId,
          legacyOperationId: slot.legacyOperationId,
          evidenceSnapshot,
          operationSnapshot,
          legacyOperationSnapshot,
        };
      });
      return {
        technicianUid: entry.technicianUid,
        receiptId: entry.receiptId,
        auditId: entry.auditId,
        membershipId: entry.membershipId,
        attendanceId: entry.attendanceId,
        receiptSnapshot: receiptSnapshots[index],
        auditSnapshot: auditSnapshots[index],
        membershipSnapshot: membershipSnapshots[index],
        attendanceSnapshot: attendanceSnapshots[index],
        slots,
      };
    });

    const receiptHash = (snapshot: DocumentSnapshot): string | null => {
      const data = snapshot.data();
      return isRecord(data) ? stringOrNull(data.receiptHash) : null;
    };

    let commitReceiptValid = false;
    if (commitReceiptSnapshot.exists) {
      try {
        assertEqualHandoverCommitReceipt(
          commitReceiptSnapshot.data(),
          aggregate,
          handoverDocumentId,
          commitReceiptId,
        );
        commitReceiptValid = true;
      } catch {
        commitReceiptValid = false;
      }
    }

    let activationReceipt: IncomingAcceptanceActivationReceipt | null = null;
    if (activationReceiptSnapshot.exists) {
      try {
        assertIncomingAcceptanceActivationReceipt(activationReceiptSnapshot.data(), {
          handoverDocumentId,
          outgoingShiftId,
          incomingShiftId,
          boundReportId: reportBindingId ?? "",
        });
        activationReceipt =
          activationReceiptSnapshot.data() as unknown as IncomingAcceptanceActivationReceipt;
      } catch {
        activationReceipt = null;
      }
    }

    let reportView = {
      present: false,
      id: reportBindingId,
      reportDigest: null as string | null,
      evidenceSnapshotHash: null as string | null,
      frozenAt: null as string | null,
      verified: false,
    };
    if (reportSnapshot !== null && reportSnapshot.exists && aggregate.reportBinding !== null) {
      try {
        const frozen = assertFrozenEqualHandoverReportV2(reportSnapshot.data());
        reportView = {
          present: true,
          id: frozen.id,
          reportDigest: frozen.digest,
          evidenceSnapshotHash: frozen.evidenceSnapshotHash,
          frozenAt: frozen.frozenAt,
          verified: false,
        };
        // The frozen report is bound to a guard revision. Without a
        // readable guard there is nothing to bind to, so the report cannot
        // be called verified even if its own digest is intact.
        if (guard.typed !== null) {
          assertReportDocument(
            reportSnapshot,
            {
              handoverId: reservation.handoverId,
              handoverDocumentId,
              aggregateRevision: aggregate.revision,
              snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
              report: {
                ...aggregate.reportBinding,
                aggregateRevision: aggregate.revision,
              },
              guardRevision: guard.typed.guardRevision,
              fencingEpoch: guard.typed.fencingEpoch,
            },
            aggregate,
          );
          reportView.verified = true;
        }
      } catch {
        reportView.verified = false;
      }
    }

    const guardConflicted =
      !guard.view.present ||
      guard.view.unreadable ||
      guard.view.protocolOwner !== "v2" ||
      guard.view.ownerHandoverDocumentId !== handoverDocumentId ||
      guard.view.reservationId !== reservation.handoverId ||
      guard.view.reservedIncomingShiftId !== incomingShiftId ||
      guard.typed?.ownerLifecycleState === "cancelled";

    const incomingShiftData = incomingShiftSnapshot.exists ? incomingShiftSnapshot.data() : null;
    const incomingShiftRecord: IncomingAcceptanceIncomingShiftRecord | null =
      isRecord(incomingShiftData)
        ? {
            id: incomingShiftId,
            status: stringOrNull(incomingShiftData.status) ?? "",
            actualStart: isoFrom(incomingShiftData.actualStart),
          }
        : null;

    const applications = technicianSets.map(applicationViewFor);
    const memberships = technicianSets.map(membershipViewFor);
    const attendance = technicianSets.map(attendanceViewFor);
    const evidence = technicianSets.flatMap((entry) =>
      entry.slots.map((slot) => evidenceViewFor(slot, entry.technicianUid)),
    );
    const reconciliation = technicianSets.map((entry, index) =>
      reconcileTechnician({
        read: entry,
        aggregate,
        handoverDocumentId,
        activationReceipt,
        activationReceiptPresent: activationReceiptSnapshot.exists,
        incomingShift: incomingShiftRecord,
        guard: guard.typed,
        guardConflicted,
        reportSnapshot,
        partnerReceiptSnapshot: receiptSnapshots[index === 0 ? 1 : 0],
      }),
    );

    return {
      handoverDocumentId,
      outgoingShiftId,
      incomingShiftId,
      aggregate: {
        present: true,
        id: handoverDocumentId,
        lifecycleStatus: aggregate.lifecycleStatus,
        revision: aggregate.revision,
        snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
        identity: {
          outgoingShiftId: identity.outgoingShiftId,
          outgoingPermanentPairId: identity.outgoingPermanentPairId,
          outgoingTechnicianIds: [...identity.outgoingTechnicianIds],
          outgoingSlotToken: identity.outgoingSlotToken,
          outgoingGeneration: identity.outgoingGeneration,
          incomingShiftId: identity.incomingShiftId,
          incomingPermanentPairId: identity.incomingPermanentPairId,
          incomingTechnicianIds: [...identity.incomingTechnicianIds],
          successorSlotToken: identity.successorSlotToken,
          successorGeneration: identity.successorGeneration,
          shiftType: identity.shiftType,
          scheduledStart: identity.scheduledStart,
          scheduledEnd: identity.scheduledEnd,
        },
        reservation: {
          handoverId: reservation.handoverId,
          reservedIncomingShiftId: reservation.reservedIncomingShiftId,
          revision: reservation.revision,
          outgoingSlotToken: reservation.outgoingSlotToken,
          outgoingGeneration: reservation.outgoingGeneration,
          successorSlotToken: reservation.successorSlotToken,
          expectedSuccessorGeneration: reservation.expectedSuccessorGeneration,
          reservedAt: reservation.reservedAt,
          reservedBy: reservation.reservedBy,
        },
        reportBinding:
          aggregate.reportBinding === null
            ? null
            : {
                present: true,
                id: aggregate.reportBinding.id,
                reportDigest: aggregate.reportBinding.digest,
                frozenAt: aggregate.reportBinding.frozenAt,
                aggregateRevision: aggregate.reportBinding.aggregateRevision,
                fencingEpoch: aggregate.reportBinding.fencingEpoch,
              },
        unreadable: false,
      },
      guard: guard.view,
      guardHistory,
      legacyHandover: {
        present: guardState.legacySnapshot.exists,
        id: createHandoverDocumentId(outgoingShiftId),
        lifecycleStatus: legacyLifecycleStatus,
      },
      outgoingShift,
      slot,
      activationWindow: evaluateActivationWindow(
        identity.scheduledStart,
        identity.scheduledEnd,
        now,
      ),
      commitReceipt: receiptView(
        commitReceiptSnapshot.exists,
        commitReceiptId,
        receiptHash(commitReceiptSnapshot),
        commitReceiptValid,
      ),
      activationReceipt: receiptView(
        activationReceiptSnapshot.exists,
        activationReceiptId,
        receiptHash(activationReceiptSnapshot),
        activationReceipt !== null,
      ),
      incomingShift: {
        present: incomingShiftSnapshot.exists,
        id: incomingShiftId,
        status: incomingShiftRecord?.status ?? null,
        actualStart: incomingShiftRecord?.actualStart ?? null,
      },
      applications,
      memberships,
      attendance,
      evidence,
      reconciliation,
      report: reportView,
      reviewCase,
      kindSetComplete,
    };
}

/**
 * Classify the authoritative evidence of one handover on the CALLER's
 * transaction. This is the only form of eligibility evaluation that a writer may
 * use, because a point-in-time evaluation taken outside the writer's transaction
 * can already be stale by the time the writer commits.
 *
 * Read-only: it adds reads to the caller's transaction, writes nothing and never
 * grants execution authority.
 */
export async function evaluateHandoverRecoveryEligibilityInTransaction(
  transaction: Transaction,
  request: HandoverRecoveryEligibilityTransactionRequest,
): Promise<HandoverRecoveryEligibilityEvaluation> {
  const readModel = await collectHandoverRecoveryEligibilityReadModel(transaction, request);
  const conclusion = classifyHandoverRecoveryEligibility(readModel);
  return {
    result: createHandoverRecoveryEligibilityResult(readModel, conclusion, request.evaluatedAt),
    readModel,
  };
}

export async function evaluateHandoverRecoveryEligibility(input: {
  handoverDocumentId: unknown;
  actorUid: unknown;
  now?: Date;
}): Promise<HandoverRecoveryEligibilityEvaluation> {
  const request = await prepareHandoverRecoveryEligibilityRequest(input);
  try {
    return await getAdminFirestore().runTransaction((transaction) =>
      evaluateHandoverRecoveryEligibilityInTransaction(transaction, request),
    );
  } catch (error) {
    if (error instanceof HandoverRecoveryEligibilityError) {
      throw error;
    }
    throw new HandoverRecoveryEligibilityError(
      "ELIGIBILITY_UNAVAILABLE",
      "Recovery eligibility cannot be verified right now. Refresh and try again.",
      503,
    );
  }
}
