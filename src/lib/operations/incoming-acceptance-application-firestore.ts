// 09M-R3B.2 Phase 3 — atomic incoming-acceptance application service.
//
// ONE caller-owned Firestore transaction applies a reserved incoming
// technician's personal attendance evidence, finalized operation, participation,
// deterministic per-person receipt and application audit together — or applies
// nothing at all. The production acceptance route deliberately does NOT call
// this module yet; the legacy begin/finalize/accept path is unchanged.
//
// The callback never authenticates, never calls Auth/FCM/HTTP and never starts a
// nested transaction. Everything it trusts is either read from Firestore inside
// the callback or supplied by the server-side coordinator as a request-local
// proof (never a request body, never a persisted token).

import "server-only";

import {
  FieldValue,
  type DocumentData,
  type DocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import { ATTENDANCE_PARTICIPATION_AUTHORITIES } from "@/types/attendance";
import {
  ATTENDANCE_EVIDENCE_SCHEMA,
  ATTENDANCE_EVIDENCE_KINDS,
  type AttendanceEvidence,
  type AttendanceEvidenceKind,
  type AttendanceTrustedAuthentication,
} from "@/types/attendance-evidence";
import type { EqualHandoverAggregate, EqualHandoverPosition } from "@/types/equal-technician-handover";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import type { TechnicianScheduleEntry } from "@/types/technician-schedule";
import {
  INCOMING_ACCEPTANCE_APPLICATIONS_COLLECTION,
  INCOMING_ACCEPTANCE_OUTCOMES,
  type IncomingAcceptanceAbsenceReference,
  type IncomingAcceptanceAppliedGuardBinding,
  type IncomingAcceptanceApplicationReceipt,
  type IncomingAcceptanceAttendanceRecord,
  type IncomingAcceptanceAuthenticationProof,
  type IncomingAcceptanceEvidenceRecord,
  type IncomingAcceptanceIncomingShiftRecord,
  type IncomingAcceptanceMembershipRecord,
  type IncomingAcceptanceOperationRecord,
  type IncomingAcceptanceOutcome,
  type IncomingAcceptanceReservationBinding,
  type IncomingAcceptanceReviewedBinding,
} from "@/types/incoming-acceptance-application";
import type { NotificationIntent } from "@/types/notification";
import { notificationDocumentId, outboxDocumentId } from "@/lib/notifications/notification-domain";
import { completionIntents } from "@/lib/notifications/notification-hooks";
import { notificationsEnabled, writeOutboxEntries } from "@/lib/notifications/notification-outbox";
import { AssignmentOperationError } from "./assignment-transaction";
import {
  applyAtomicAcceptanceEvidencePlan,
  planAtomicAcceptanceEvidence,
  type AtomicAcceptanceEvidencePlan,
  type AtomicAcceptanceEvidenceState,
} from "./atomic-acceptance-evidence";
import {
  attendanceAuthenticationMethodForKind,
  assertAttendanceOperation,
} from "./attendance-evidence-domain";
import {
  attendanceEvidenceOtherKindRefs,
  attendanceTransactionalGetAll,
  readAttendanceEvidenceSnapshot,
  readAttendanceOperationSnapshot,
} from "./attendance-evidence-firestore-state";
import { getOperationalCollections, GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID } from "./collections";
import {
  assertFrozenEqualHandoverReportV2,
} from "./equal-handover-report-domain";
import {
  assertEqualHandoverCommitReceipt,
  authorizeTechnicianProfile,
  canonical,
  equalHandoverCommitReceiptId,
  readEqualHandoverParticipantSchedule,
  readV2Aggregate,
  requireV2GuardBinding,
  validateEqualHandoverPair,
} from "./equal-handover-report-firestore";
import {
  activateEqualHandoverIncomingTransfer,
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
  getEqualHandoverPositions,
} from "./equal-technician-handover-domain";
import { readReservationGuardState } from "./handover-reservation-guard";
import {
  assertFirstActivationWindow,
  assertIncomingAcceptanceApplicationReceipt,
  assertIncomingAcceptanceAuthenticationProof,
  assertIncomingAcceptanceClockOrder,
  assertIncomingAcceptanceEvidenceConsistency,
  assertIncomingAcceptanceJoinWindow,
  assertIncomingAcceptanceOutcome,
  assertIncomingAcceptanceParticipationConsistency,
  assertIncomingAcceptanceReservation,
  assertReviewedBinding,
  computeIncomingAcceptanceActivationReceiptHash,
  createIncomingAcceptanceActivationReceiptId,
  createIncomingAcceptanceApplicationIdentity,
  createIncomingAcceptanceApplicationReceipt,
  hydrateIncomingAcceptanceCommittedAt,
  INCOMING_ACCEPTANCE_ERROR_CODES,
  IncomingAcceptanceApplicationError,
  isIncomingAcceptanceLateReasonRequired,
  normalizeIncomingAcceptanceLateReason,
  selectIncomingAcceptanceEvidenceKind,
  type IncomingAcceptanceActivationReceipt,
} from "./incoming-acceptance-application-domain";
import {
  assertOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
  transferOperationalShiftControl,
} from "./operational-shift-control-state";
import { SHIFT_ACTIVATION_WINDOW } from "./shift-activation-window";
import { finalizeCurrentShiftMemberships } from "./shift-completion-domain";
import { createShiftAttendanceRecord } from "./shift-join-domain";
import { parseShiftTimeRange } from "./shift-overlap";

export const ATOMIC_ACCEPTANCE_WRITE_LIMIT = 100;
export const ATOMIC_ACCEPTANCE_BYTE_LIMIT = 4 * 1024 * 1024;
export const ATOMIC_ACCEPTANCE_AUDIT_SCHEMA = "incoming-acceptance-application-audit-v1";
export const ATOMIC_ACCEPTANCE_AUDIT_ACTION = "INCOMING_ACCEPTANCE_APPLIED_V1";
const MAX_OUTBOX_PRE_READS = 16;

// The service distinguishes "the callback failed without a commit" from "the
// commit happened but its server timestamp or persisted records cannot be
// proven". Only the latter is reported as an unknown outcome; a successful
// response requires a hydrated, revalidated receipt.
export type AtomicAcceptanceCommitState =
  | "not_committed"
  | "committed_unreadable"
  | "committed_unresolved"
  | "committed_inconsistent"
  | "committed_validated";

export type AtomicAcceptanceServiceErrorCode =
  | "APPLICATION_LIMIT_EXCEEDED"
  | "APPLICATION_OUTCOME_UNKNOWN";

export class AtomicAcceptanceServiceError extends Error {
  public readonly code: AtomicAcceptanceServiceErrorCode;
  public readonly status: number;
  public readonly commitState: AtomicAcceptanceCommitState;

  constructor(
    code: AtomicAcceptanceServiceErrorCode,
    message: string,
    commitState: AtomicAcceptanceCommitState,
    status: number,
  ) {
    super(message);
    this.name = "AtomicAcceptanceServiceError";
    this.code = code;
    this.status = status;
    this.commitState = commitState;
  }
}

export interface AtomicIncomingAcceptanceInput {
  outgoingShiftId: string;
  actorUid: string;
  reviewedBinding: IncomingAcceptanceReviewedBinding;
  lateReason: string | null;
  requestNonce: string;
  proof: unknown;
  /** HTTP-boundary acceptance time; captured before password verification. */
  requestAcceptedAt: string;
  /** Fresh application clock for this attempt; stable across SDK retries. */
  operationalAppliedAt: string;
  /** Freshness clock of the final pre-write check. */
  nowIso: string;
  nowMonotonicMs: number;
}

// Explicit delivery posture: acceptance never claims a notification was
// delivered. It reports whether completion intents were written to the outbox,
// already existed, were not required (joins/replays) or are disabled entirely.
export interface AtomicAcceptanceNotificationReport {
  enabled: boolean;
  outboxState: "written" | "existing" | "disabled" | "not_required" | "not_evaluated";
  intentsQueued: number;
  intentsExisting: number;
}

export interface AtomicIncomingAcceptanceResult {
  status: "APPLIED" | "REPLAYED";
  replayed: boolean;
  outcome: IncomingAcceptanceOutcome;
  receipt: IncomingAcceptanceApplicationReceipt;
  receiptHash: string;
  commitState: "committed_validated";
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  technicianUid: string;
  position: EqualHandoverPosition;
  guardCleanup: "pending" | "completed";
  notificationDelivery: AtomicAcceptanceNotificationReport;
}

function fail(code: (typeof INCOMING_ACCEPTANCE_ERROR_CODES)[keyof typeof INCOMING_ACCEPTANCE_ERROR_CODES], message: string): never {
  throw new IncomingAcceptanceApplicationError(code, message);
}

function documentRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, `Malformed ${label}.`);
  }
  return value as Record<string, unknown>;
}

function isTimestampValue(value: unknown): value is { seconds: number; nanoseconds: number; toDate: () => Date } {
  const record = value as { toDate?: unknown; seconds?: unknown; nanoseconds?: unknown } | null;
  return (
    record !== null &&
    typeof record === "object" &&
    typeof record.toDate === "function" &&
    Number.isSafeInteger(record.seconds) &&
    (record.seconds as number) >= 0 &&
    Number.isSafeInteger(record.nanoseconds) &&
    (record.nanoseconds as number) >= 0 &&
    (record.nanoseconds as number) <= 999_999_999
  );
}

function committedMarker(value: unknown): { seconds: number; nanoseconds: number } {
  if (!isTimestampValue(value)) {
    // A persisted receipt whose committedAt is not a resolved server timestamp
    // was never validated: never fabricate a success for it.
    throw new AtomicAcceptanceServiceError(
      "APPLICATION_OUTCOME_UNKNOWN",
      "The persisted application result could not be confirmed. Refresh acceptance status before retrying.",
      "committed_unresolved",
      503,
    );
  }
  return { seconds: value.seconds, nanoseconds: value.nanoseconds };
}

function requireResolvedServerTimestamp(value: unknown, label: string): void {
  if (!isTimestampValue(value)) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
      `The ${label} is missing its resolved server timestamp.`,
    );
  }
}

// Rehydrates a stored receipt: the persisted `committedAt` is a server
// Timestamp, while the domain receipt carries either an unresolved marker
// (pre-commit) or a resolved {seconds,nanoseconds} pair (read-back). The hash
// excludes committedAt, so replacing the marker cannot change receiptHash.
export function readPersistedReceipt(data: unknown): IncomingAcceptanceApplicationReceipt {
  const stored = documentRecord(data, "application receipt");
  const unresolved = { ...stored, committedAt: { state: "unresolved" } };
  assertIncomingAcceptanceApplicationReceipt(unresolved);
  const hydrated = hydrateIncomingAcceptanceCommittedAt(
    unresolved as unknown as IncomingAcceptanceApplicationReceipt,
    committedMarker(stored.committedAt),
  );
  return hydrated;
}

function createApplicationAuditRecord(
  receipt: IncomingAcceptanceApplicationReceipt,
): Record<string, unknown> {
  return {
    id: receipt.auditId,
    schema: ATOMIC_ACCEPTANCE_AUDIT_SCHEMA,
    action: ATOMIC_ACCEPTANCE_AUDIT_ACTION,
    technicianUid: receipt.technicianUid,
    handoverDocumentId: receipt.handoverDocumentId,
    reservationId: receipt.reservationId,
    outgoingShiftId: receipt.outgoingShiftId,
    incomingShiftId: receipt.incomingShiftId,
    outcome: receipt.outcome,
    receiptId: receipt.id,
    receiptHash: receipt.receiptHash,
    evidenceEventId: receipt.evidenceEventId,
    evidenceOperationId: receipt.evidenceOperationId,
    evidenceId: receipt.evidenceId,
    evidenceDigest: receipt.evidenceDigest,
    membershipId: receipt.membershipId,
    attendanceId: receipt.attendanceId,
    requestAcceptedAt: receipt.requestAcceptedAt,
    passwordVerifiedAt: receipt.passwordVerifiedAt,
    authAccountCheckedAt: receipt.authAccountCheckedAt,
    personalEvidenceEventAt: receipt.personalEvidenceEventAt,
    operationalAppliedAt: receipt.operationalAppliedAt,
    lateReasonSource: receipt.lateReasonSource,
    origin: receipt.origin,
    recordedAt: receipt.operationalAppliedAt,
    createdAt: FieldValue.serverTimestamp(),
  };
}

export function assertApplicationAudit(value: unknown, receipt: IncomingAcceptanceApplicationReceipt): void {
  const audit = documentRecord(value, "application audit");
  const expected: Array<[string, unknown]> = [
    ["id", receipt.auditId],
    ["schema", ATOMIC_ACCEPTANCE_AUDIT_SCHEMA],
    ["action", ATOMIC_ACCEPTANCE_AUDIT_ACTION],
    ["technicianUid", receipt.technicianUid],
    ["handoverDocumentId", receipt.handoverDocumentId],
    ["reservationId", receipt.reservationId],
    ["outgoingShiftId", receipt.outgoingShiftId],
    ["incomingShiftId", receipt.incomingShiftId],
    ["outcome", receipt.outcome],
    ["receiptId", receipt.id],
    ["receiptHash", receipt.receiptHash],
    ["evidenceEventId", receipt.evidenceEventId],
    ["evidenceOperationId", receipt.evidenceOperationId],
    ["evidenceId", receipt.evidenceId],
    ["evidenceDigest", receipt.evidenceDigest],
    ["membershipId", receipt.membershipId],
    ["attendanceId", receipt.attendanceId],
    ["requestAcceptedAt", receipt.requestAcceptedAt],
    ["passwordVerifiedAt", receipt.passwordVerifiedAt],
    ["authAccountCheckedAt", receipt.authAccountCheckedAt],
    ["personalEvidenceEventAt", receipt.personalEvidenceEventAt],
    ["operationalAppliedAt", receipt.operationalAppliedAt],
    ["lateReasonSource", receipt.lateReasonSource],
    ["origin", receipt.origin],
    ["recordedAt", receipt.operationalAppliedAt],
  ];
  if (expected.some(([field, wanted]) => audit[field] !== wanted)) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
      "The application audit does not match its receipt; administrator review required.",
    );
  }
  requireResolvedServerTimestamp(audit.createdAt, "application audit");
}

export function assertReportDocument(
  reportSnapshot: DocumentSnapshot | null,
  reviewed: IncomingAcceptanceReviewedBinding,
  aggregate: EqualHandoverAggregate,
): void {
  if (reportSnapshot === null || !reportSnapshot.exists) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
      "The frozen v2 report is missing; acceptance cannot be proven.",
    );
  }
  const frozen = assertFrozenEqualHandoverReportV2(reportSnapshot.data());
  const report = reviewed.report;
  if (frozen.id !== report.id ||
      frozen.digest !== report.digest ||
      frozen.evidenceSnapshotHash !== report.evidenceSnapshotHash ||
      frozen.workSnapshotVersion !== report.workSnapshotVersion ||
      frozen.preparationId !== report.preparationId ||
      frozen.preparationRevision !== report.preparationRevision ||
      frozen.reservationId !== report.reservationId ||
      frozen.fencingEpoch !== report.fencingEpoch ||
      frozen.frozenBy !== report.frozenBy ||
      frozen.frozenAt !== report.frozenAt ||
      frozen.outgoingShiftId !== aggregate.identity.outgoingShiftId ||
      frozen.handoverDocumentId !== createEqualHandoverDocumentId(aggregate.identity.outgoingShiftId)) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
      "The reviewed report binding no longer matches the frozen v2 report.",
    );
  }
  const current = aggregate.reportBinding;
  if (current === null || current.id !== frozen.id) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
      "The handover aggregate is not bound to the reviewed frozen report.",
    );
  }
  // aggregate.reportBinding is the freeze-time binding; the reviewed binding
  // carries the live aggregate revision overlaid by the coordinator, so only the
  // immutable provenance fields can be compared here.
  const frozenProvenance: Record<string, unknown> = { ...current };
  delete frozenProvenance.aggregateRevision;
  const reviewedProvenance: Record<string, unknown> = { ...report };
  delete reviewedProvenance.aggregateRevision;
  if (canonical(frozenProvenance) !== canonical(reviewedProvenance)) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
      "The reviewed report provenance differs from the committed handover binding.",
    );
  }
}

function assertLiveReviewedBinding(
  binding: IncomingAcceptanceReviewedBinding,
  aggregate: EqualHandoverAggregate,
  guard: HandoverReservationGuard,
  documentId: string,
): void {
  if (binding.handoverId !== aggregate.reservation.handoverId ||
      binding.handoverDocumentId !== documentId ||
      binding.aggregateRevision !== aggregate.revision ||
      binding.snapshotHash !== createEqualHandoverSnapshot(aggregate).snapshotHash ||
      binding.guardRevision !== guard.guardRevision ||
      binding.fencingEpoch !== guard.fencingEpoch) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
      "The reviewed handover binding changed before the application commit.",
    );
  }
}

function appliedGuardBinding(
  guard: HandoverReservationGuard,
  documentId: string,
): IncomingAcceptanceAppliedGuardBinding {
  return {
    protocolOwner: "v2",
    handoverDocumentId: documentId,
    reservationId: guard.reservationId,
    incomingShiftId: guard.reservedIncomingShiftId,
    lifecycleState: "active",
    guardRevision: guard.guardRevision,
    fencingEpoch: guard.fencingEpoch,
    outgoingSlotToken: guard.outgoingSlotToken,
    outgoingGeneration: guard.outgoingGeneration,
    successorSlotToken: guard.successorSlotToken,
    successorGeneration: guard.successorGeneration,
  };
}

function absenceReference(
  aggregate: EqualHandoverAggregate,
  technicianUid: string,
  kind: AttendanceEvidenceKind,
): IncomingAcceptanceAbsenceReference | null {
  if (kind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE) return null;
  const absence = aggregate.absences.find(
    (item) => item.technicianUid === technicianUid && item.absenceType === "not_yet_in",
  );
  if (!absence) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.EVIDENCE_BINDING_CONFLICT,
      "Late-acceptance evidence requires the technician's own not_yet_in declaration.",
    );
  }
  return {
    absenceType: "not_yet_in",
    technicianUid: absence.technicianUid,
    recordedBy: absence.recordedBy,
    recordedRevision: absence.recordedRevision,
    revision: absence.revision,
    recordedAt: absence.recordedAt,
    reason: absence.reason,
  };
}

function normalizedLateReason(input: {
  reason: string | null;
  kind: AttendanceEvidenceKind;
  scheduledStart: string;
  operationalAppliedAt: string;
}): string | null {
  const required =
    input.kind === ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE ||
    isIncomingAcceptanceLateReasonRequired({
      scheduledStart: input.scheduledStart,
      operationalAppliedAt: input.operationalAppliedAt,
    });
  return normalizeIncomingAcceptanceLateReason({ reason: input.reason, required });
}

function applicationOperationRecord(
  plan: AtomicAcceptanceEvidencePlan,
): IncomingAcceptanceOperationRecord {
  const request = plan.operation.request;
  return {
    id: plan.operation.id,
    status: plan.operation.status,
    eventId: request.eventId,
    technicianUid: request.technicianUid,
    kind: request.kind,
    evidenceId: plan.operation.evidenceId,
    interruptedFinalization: plan.operation.interruptedFinalization,
  };
}

function assertApplicationBudget(writeCount: number, byteCount: number): void {  if (writeCount > ATOMIC_ACCEPTANCE_WRITE_LIMIT || byteCount > ATOMIC_ACCEPTANCE_BYTE_LIMIT) {
    throw new AtomicAcceptanceServiceError(
      "APPLICATION_LIMIT_EXCEEDED",
      "The acceptance application plan exceeds the safe transaction budget; operator review is required.",
      "not_committed",
      409,
    );
  }
}

function estimateBytes(value: unknown): number {
  // Conservative preflight estimate only. Real document sizing is enforced by
  // Firestore; this guard keeps a plan far below the platform limits.
  return 64 + JSON.stringify(value ?? null).length;
}

function readFreshOutboxTargets(
  transaction: Transaction,
  db: ReturnType<typeof getOperationalCollections>["db"],
  intents: readonly NotificationIntent[],
): Promise<Array<{ intent: NotificationIntent; notification: DocumentSnapshot; outbox: DocumentSnapshot }>> {
  return Promise.all(
    intents.map(async (intent) => {
      const [notification, outbox] = await Promise.all([
        transaction.get(db.collection("notifications").doc(notificationDocumentId(intent.idempotencyKey))),
        transaction.get(db.collection("notification_outbox").doc(outboxDocumentId(intent.idempotencyKey))),
      ]);
      return { intent, notification, outbox };
    }),
  );
}

function assertExistingOutboxPair(
  intent: NotificationIntent,
  notification: DocumentSnapshot,
  outbox: DocumentSnapshot,
): void {
  if (!notification.exists || !outbox.exists) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
      "An existing completion notification is only half-recorded; administrator review required.",
    );
  }
  const notificationRecord = documentRecord(notification.data(), "notification");
  const outboxRecord = documentRecord(outbox.data(), "notification outbox");
  if (notificationRecord.idempotencyKey !== intent.idempotencyKey ||
      notificationRecord.eventKind !== intent.eventKind ||
      notificationRecord.recipientUid !== intent.recipientUid ||
      notificationRecord.title !== intent.title ||
      outboxRecord.idempotencyKey !== intent.idempotencyKey ||
      outboxRecord.notificationId !== notificationDocumentId(intent.idempotencyKey) ||
      outboxRecord.eventKind !== intent.eventKind ||
      outboxRecord.recipientUid !== intent.recipientUid) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
      "An existing completion notification does not match this application; administrator review required.",
    );
  }
}

function createActivationReceipt(input: {
  activationReceiptId: string;
  documentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  finalRevision: number;
  finalSnapshotHash: string;
  boundReportId: string;
  actorUid: string;
  activatedAt: string;
  controlBefore: unknown;
  controlAfter: unknown;
}): IncomingAcceptanceActivationReceipt {
  const material: IncomingAcceptanceActivationReceipt = {
    id: input.activationReceiptId,
    schema: "equal-handover-activation-v2",
    action: "EQUAL_SHIFT_ACTIVATED_INCOMING_V2",
    outcome: "INCOMING_ACTIVATED",
    protocol: "equal-handover-v2",
    handoverDocumentId: input.documentId,
    outgoingShiftId: input.outgoingShiftId,
    incomingShiftId: input.incomingShiftId,
    finalRevision: input.finalRevision,
    finalSnapshotHash: input.finalSnapshotHash,
    boundReportId: input.boundReportId,
    actorUid: input.actorUid,
    actorRole: "technician",
    activatedAt: input.activatedAt,
    operationalControlBefore: input.controlBefore,
    operationalControlAfter: input.controlAfter,
    receiptHash: "",
  };
  return {
    ...material,
    receiptHash: computeIncomingAcceptanceActivationReceiptHash(material),
  };
}

function assertEvidenceOperationIsFinalizable(
  plan: AtomicAcceptanceEvidencePlan,
): AtomicAcceptanceEvidencePlan {
  if (plan.mode === "replay_finalized_operation") {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.EVIDENCE_BINDING_CONFLICT,
      "Attendance evidence exists without an application receipt; administrator review required.",
    );
  }
  // The transaction applies evidence and the operational records together, so
  // the durable operation never carries the interrupted-finalization
  // acknowledgement the split legacy path uses.
  return {
    ...plan,
    operation: assertAttendanceOperation({
      ...plan.operation,
      interruptedFinalization: false,
    }),
  };
}

function buildEvidenceRequest(input: {
  aggregate: EqualHandoverAggregate;
  documentId: string;
  technicianUid: string;
  position: EqualHandoverPosition;
  kind: AttendanceEvidenceKind;
  eventId: string;
  lateReason: string | null;
  binding: IncomingAcceptanceReviewedBinding;
  guard: HandoverReservationGuard;
}) {
  return {
    schema: ATTENDANCE_EVIDENCE_SCHEMA,
    handoverId: input.aggregate.reservation.handoverId,
    handoverDocumentId: input.documentId,
    eventId: input.eventId,
    position: input.position,
    technicianUid: input.technicianUid,
    kind: input.kind,
    scheduledStart: input.aggregate.identity.scheduledStart,
    scheduledEnd: input.aggregate.identity.scheduledEnd,
    reportedDepartureTime: null,
    attestedByUid: null,
    attestationReason: null,
    lateReason: input.lateReason,
    handoverRevision: input.aggregate.revision,
    snapshotHash: input.binding.snapshotHash,
    expectedGuardRevision: input.guard.guardRevision,
    expectedFencingEpoch: input.guard.fencingEpoch,
  };
}

export function reservationBinding(
  aggregate: EqualHandoverAggregate,
  documentId: string,
): IncomingAcceptanceReservationBinding {
  return {
    handoverId: aggregate.reservation.handoverId,
    handoverDocumentId: documentId,
    outgoingShiftId: aggregate.identity.outgoingShiftId,
    incomingShiftId: aggregate.identity.incomingShiftId,
    incomingTechnicianIds: aggregate.identity.incomingTechnicianIds,
    scheduledStart: aggregate.identity.scheduledStart,
    scheduledEnd: aggregate.identity.scheduledEnd,
  };
}

export async function applyIncomingAcceptanceApplicationAtomically(
  input: AtomicIncomingAcceptanceInput,
): Promise<AtomicIncomingAcceptanceResult> {
  assertReviewedBinding(input.reviewedBinding);
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  if (input.reviewedBinding.handoverDocumentId !== documentId) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
      "The reviewed binding belongs to a different handover document.",
    );
  }

  const {
    db,
    shifts,
    shiftMembers,
    shiftAttendance,
    technicianSchedules,
    equalHandoversV2,
    handoverReportsV2,
    operationalShiftControl,
    attendanceEvidenceV2,
    attendanceEvidenceOperationsV2,
  } = getOperationalCollections();
  const aggregateRef = equalHandoversV2.doc(documentId);
  const receiptsCollection = db.collection(INCOMING_ACCEPTANCE_APPLICATIONS_COLLECTION);

  const committed = await db.runTransaction(async (transaction): Promise<{
    outcome: IncomingAcceptanceOutcome;
    replayed: boolean;
    guardLifecycle: HandoverReservationGuard["ownerLifecycleState"];
    notification: AtomicAcceptanceNotificationReport;
  }> => {
    // ---------------------------------------------------------------------
    // Read phase — every authoritative read completes before the first write.
    // ---------------------------------------------------------------------
    const [profileSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      transaction.get(db.collection("users").doc(input.actorUid)),
      transaction.get(aggregateRef),
      readReservationGuardState(transaction, input.outgoingShiftId),
    ]);
    if (!aggregateSnapshot.exists) {
      throw new AssignmentOperationError("The equal handover reservation was not found.", 404);
    }
    const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
    const identity = aggregate.identity;
    const incomingId = identity.incomingShiftId;
    const lifecycle = aggregate.lifecycleStatus;
    if (lifecycle !== "awaiting_incoming_acceptance" && lifecycle !== "completed") {
      fail(
        INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
        "This handover no longer accepts incoming applications; review the current handover.",
      );
    }

    // Authority is derived from the fresh profile and the reserved roster —
    // never from a body UID, role claim or client clock.
    authorizeTechnicianProfile(
      profileSnapshot.data() as Record<string, unknown> | undefined,
      input.actorUid,
    );
    if (!identity.incomingTechnicianIds.includes(input.actorUid)) {
      fail(
        INCOMING_ACCEPTANCE_ERROR_CODES.AUTH_IDENTITY_CHANGED,
        "Only a reserved incoming technician may apply this handover.",
      );
    }
    const actorPosition = getEqualHandoverPositions(identity).find(
      (item) => item.technicianUid === input.actorUid && item.side === "incoming",
    );
    if (!actorPosition) {
      fail(
        INCOMING_ACCEPTANCE_ERROR_CODES.AUTH_IDENTITY_CHANGED,
        "The verified technician is not a reserved incoming participant.",
      );
    }

    const guard = requireV2GuardBinding(
      guardState.guardSnapshot.exists,
      guardState.guardSnapshot.data(),
      documentId,
      aggregate,
    );
    const partnerUid = identity.incomingTechnicianIds.find((uid) => uid !== input.actorUid);
    if (partnerUid === undefined) {
      fail(
        INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT,
        "The incoming reservation does not contain two distinct technicians.",
      );
    }

    const derivedKind = selectIncomingAcceptanceEvidenceKind(
      aggregate.absences.some(
        (item) => item.technicianUid === input.actorUid && item.absenceType === "not_yet_in",
      ),
    );
    const anchorReceiptId = createIncomingAcceptanceApplicationIdentity({
      handoverId: aggregate.reservation.handoverId,
      technicianUid: input.actorUid,
      kind: derivedKind,
    }).receiptId;
    const receiptDocumentRef = receiptsCollection.doc(anchorReceiptId);
    const receiptSnapshot = await transaction.get(receiptDocumentRef);

    const storedReceiptData = receiptSnapshot.exists
      ? documentRecord(receiptSnapshot.data(), "application receipt")
      : null;
    if (storedReceiptData !== null &&
        storedReceiptData.evidenceKind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN &&
        storedReceiptData.evidenceKind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE) {
      fail(
        INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
        "The stored application receipt has an unsupported evidence kind.",
      );
    }

    // The receipt identity is kind-independent, but evidence/operation IDs are
    // not: a replay must resolve the slot the original application used.
    const effectiveKind = storedReceiptData === null
      ? derivedKind
      : (storedReceiptData.evidenceKind as AttendanceEvidenceKind);
    const applicationIdentity = createIncomingAcceptanceApplicationIdentity({
      handoverId: aggregate.reservation.handoverId,
      technicianUid: input.actorUid,
      kind: effectiveKind,
    });
    const partnerReceiptId = createIncomingAcceptanceApplicationIdentity({
      handoverId: aggregate.reservation.handoverId,
      technicianUid: partnerUid,
      kind: derivedKind,
    }).receiptId;

    const activationReceiptId = createIncomingAcceptanceActivationReceiptId(documentId);
    const activationReceiptRef = db.collection("audit_logs").doc(activationReceiptId);
    const commitReceiptId = equalHandoverCommitReceiptId(documentId);
    const auditRef = db.collection("audit_logs").doc(applicationIdentity.auditId);

    const [
      outgoingSnapshot,
      incomingSnapshot,
      controlSnapshot,
      commitReceiptSnapshot,
      activationReceiptSnapshot,
      partnerReceiptSnapshot,
      auditSnapshot,
      actorMemberSnapshot,
      actorAttendanceSnapshot,
      operationSnapshot,
      evidenceSnapshot,
      otherKindSnapshots,
    ] = await Promise.all([
      transaction.get(shifts.doc(input.outgoingShiftId)),
      transaction.get(shifts.doc(incomingId)),
      transaction.get(operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID)),
      transaction.get(db.collection("audit_logs").doc(commitReceiptId)),
      transaction.get(activationReceiptRef),
      transaction.get(receiptsCollection.doc(partnerReceiptId)),
      transaction.get(auditRef),
      transaction.get(shiftMembers.doc(`${incomingId}_${input.actorUid}`)),
      transaction.get(shiftAttendance.doc(`${incomingId}_${input.actorUid}`)),
      transaction.get(attendanceEvidenceOperationsV2.doc(applicationIdentity.operationId)),
      transaction.get(attendanceEvidenceV2.doc(applicationIdentity.evidenceId)),
      attendanceTransactionalGetAll(
        transaction,
        attendanceEvidenceOtherKindRefs(
          aggregate.reservation.handoverId,
          input.actorUid,
          effectiveKind,
        ),
      ),
    ]);

    const reportId = aggregate.reportBinding?.id ?? null;
    const reportSnapshot = reportId === null
      ? null
      : await transaction.get(handoverReportsV2.doc(reportId));

    const otherKindEvidence: AttendanceEvidence[] = [];
    for (const snapshot of otherKindSnapshots) {
      const record = readAttendanceEvidenceSnapshot(snapshot);
      if (record !== null) otherKindEvidence.push(record);
    }

    const evidenceState: AtomicAcceptanceEvidenceState = {
      operation: readAttendanceOperationSnapshot(operationSnapshot),
      slotEvidence: readAttendanceEvidenceSnapshot(evidenceSnapshot),
      otherKindEvidence,
      guard,
      handover: aggregate,
    };

    const buildPlan = (request: ReturnType<typeof buildEvidenceRequest>) =>
      planAtomicAcceptanceEvidence(evidenceState, {
        request,
        identity,
        reservation: aggregate.reservation,
        trustedAuthentication: {
          verifiedTechnicianUid: input.actorUid,
          method: attendanceAuthenticationMethodForKind(request.kind),
        } satisfies AttendanceTrustedAuthentication,
        serverAuthenticationTime: input.operationalAppliedAt,
      });

    // ---------------------------------------------------------------------
    // Replay — a matching deterministic receipt proves the original outcome.
    // No business, evidence, receipt, audit, schedule or outbox write happens.
    // ---------------------------------------------------------------------
    if (storedReceiptData !== null) {
      if (lifecycle !== "completed") {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
          "An application receipt exists while the handover is not completed.",
        );
      }
      const receipt = readPersistedReceipt(storedReceiptData);
      if (receipt.id !== applicationIdentity.receiptId ||
          receipt.technicianUid !== input.actorUid ||
          receipt.handoverDocumentId !== documentId ||
          receipt.reservationId !== aggregate.reservation.handoverId ||
          receipt.outgoingShiftId !== identity.outgoingShiftId ||
          receipt.incomingShiftId !== incomingId ||
          receipt.evidenceKind !== effectiveKind) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
          "The stored application receipt does not belong to this handover, technician or evidence slot.",
        );
      }
      assertIncomingAcceptanceReservation(receipt, reservationBinding(aggregate, documentId));
      assertIncomingAcceptanceClockOrder({
        requestAcceptedAt: receipt.requestAcceptedAt,
        passwordVerifiedAt: receipt.passwordVerifiedAt,
        authAccountCheckedAt: receipt.authAccountCheckedAt,
        personalEvidenceEventAt: receipt.personalEvidenceEventAt,
        operationalAppliedAt: receipt.operationalAppliedAt,
        outcome: receipt.outcome,
        origin: receipt.origin,
        // The creation transaction already ordered the request against the
        // reviewed revision of the aggregate. On replay the aggregate's
        // `updatedAt` has necessarily moved forward to the activation itself,
        // so it is not a pre-request stamp and must not be re-imposed here;
        // `assertIncomingAcceptanceOutcome` below re-proves that a first
        // activation's operational timestamp equals the activation receipt.
        aggregateUpdatedAt: null,
      });
      assertIncomingAcceptanceOutcome({
        receipt,
        activationReceipt: activationReceiptSnapshot.data(),
        incomingShift: incomingSnapshot.exists
          ? (incomingSnapshot.data() as IncomingAcceptanceIncomingShiftRecord)
          : null,
        scheduledStart: identity.scheduledStart,
        scheduledEnd: identity.scheduledEnd,
        requireActiveShift: false,
      });
      assertReportDocument(reportSnapshot, receipt.reviewedBinding, aggregate);

      if (auditSnapshot.exists) {
        assertApplicationAudit(auditSnapshot.data(), receipt);
      }
      if (!actorMemberSnapshot.exists || !actorAttendanceSnapshot.exists) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT,
          "The application receipt is missing its membership or attendance record.",
        );
      }
      assertIncomingAcceptanceParticipationConsistency({
        receipt,
        membership: actorMemberSnapshot.data() as IncomingAcceptanceMembershipRecord,
        attendance: actorAttendanceSnapshot.data() as IncomingAcceptanceAttendanceRecord,
        allowHistoricalDeparture: true,
      });

      const replayRequest = buildEvidenceRequest({
        aggregate,
        documentId,
        technicianUid: input.actorUid,
        position: receipt.position,
        kind: receipt.evidenceKind,
        eventId: receipt.evidenceEventId,
        lateReason: receipt.lateReason,
        binding: receipt.reviewedBinding,
        guard,
      });
      const replayPlan = planAtomicAcceptanceEvidence(evidenceState, {
        request: replayRequest,
        identity,
        reservation: aggregate.reservation,
        trustedAuthentication: {
          verifiedTechnicianUid: input.actorUid,
          method: attendanceAuthenticationMethodForKind(replayRequest.kind),
        },
        serverAuthenticationTime: receipt.operationalAppliedAt,
      });
      if (replayPlan.mode !== "replay_finalized_operation") {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
          "The application receipt exists but its attendance evidence is not finalized.",
        );
      }
      assertIncomingAcceptanceEvidenceConsistency({
        receipt,
        operation: applicationOperationRecord(replayPlan),
        evidence: replayPlan.evidence as unknown as IncomingAcceptanceEvidenceRecord,
      });

      return {
        outcome: receipt.outcome,
        replayed: true,
        guardLifecycle: guard.ownerLifecycleState,
        // A replay writes nothing, so it cannot re-report outbox outcomes. The
        // original commit owns the delivery evidence.
        notification: {
          enabled: notificationsEnabled(),
          outboxState: "not_evaluated",
          intentsQueued: 0,
          intentsExisting: 0,
        },
      };
    }

    if (auditSnapshot.exists) {
      fail(
        INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
        "An application audit exists without its receipt; administrator review required.",
      );
    }

    // ---------------------------------------------------------------------
    // New application — FIRST_ACTIVATION or SUBSEQUENT_JOIN, decided from the
    // authoritative lifecycle read inside this callback.
    // ---------------------------------------------------------------------
    const isFirstActivation = lifecycle === "awaiting_incoming_acceptance";
    const outcome = isFirstActivation
      ? INCOMING_ACCEPTANCE_OUTCOMES.FIRST_ACTIVATION
      : INCOMING_ACCEPTANCE_OUTCOMES.SUBSEQUENT_JOIN;

    if (guard.guardRevision !== input.reviewedBinding.guardRevision ||
        guard.fencingEpoch !== input.reviewedBinding.fencingEpoch) {
      fail(
        INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
        "The reservation guard changed since this handover was reviewed.",
      );
    }
    if (guard.ownerLifecycleState !== "active") {
      fail(
        INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
        "The reservation guard is no longer active; a new application is blocked.",
      );
    }

    if (partnerReceiptSnapshot.exists) {
      const partnerReceipt = readPersistedReceipt(partnerReceiptSnapshot.data());
      if (partnerReceipt.technicianUid !== partnerUid ||
          partnerReceipt.activationReceiptId !== activationReceiptId ||
          partnerReceipt.outcome !== INCOMING_ACCEPTANCE_OUTCOMES.FIRST_ACTIVATION) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
          "The partner application receipt is inconsistent with this handover.",
        );
      }
    }

    assertLiveReviewedBinding(input.reviewedBinding, aggregate, guard, documentId);
    assertReportDocument(reportSnapshot, input.reviewedBinding, aggregate);

    const lateReason = normalizedLateReason({
      reason: input.lateReason,
      kind: effectiveKind,
      scheduledStart: identity.scheduledStart,
      operationalAppliedAt: input.operationalAppliedAt,
    });
    assertIncomingAcceptanceAuthenticationProof({
      proof: input.proof,
      expectedTechnicianUid: input.actorUid,
      expectedRequestNonce: input.requestNonce,
      reviewedBinding: input.reviewedBinding,
      lateReason,
      nowIso: input.nowIso,
      nowMonotonicMs: input.nowMonotonicMs,
    });
    const proof = input.proof as IncomingAcceptanceAuthenticationProof;

    if (input.operationalAppliedAt < input.requestAcceptedAt) {
      fail(
        INCOMING_ACCEPTANCE_ERROR_CODES.CLOCK_ORDER_CONFLICT,
        "The application clock precedes the accepted request.",
      );
    }

    const evidenceRequest = buildEvidenceRequest({
      aggregate,
      documentId,
      technicianUid: input.actorUid,
      position: actorPosition.position,
      kind: effectiveKind,
      eventId: applicationIdentity.eventId,
      lateReason,
      binding: input.reviewedBinding,
      guard,
    });
    const plan = assertEvidenceOperationIsFinalizable(buildPlan(evidenceRequest));

    let stagedWrites = 0;
    let stagedBytes = 0;
    let notification: AtomicAcceptanceNotificationReport = {
      enabled: notificationsEnabled(),
      outboxState: "not_required",
      intentsQueued: 0,
      intentsExisting: 0,
    };
    const stage = (value: unknown, count = 1): void => {
      stagedWrites += count;
      stagedBytes += count * estimateBytes(value);
    };

    if (isFirstActivation) {
      // ---- FIRST_ACTIVATION ---------------------------------------------
      if (incomingSnapshot.exists) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
          "The reserved incoming Shift already exists while the handover is unactivated.",
        );
      }
      if (!commitReceiptSnapshot.exists) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
          "The outgoing commitment is missing; the handover cannot be activated.",
        );
      }
      assertEqualHandoverCommitReceipt(
        commitReceiptSnapshot.data(),
        aggregate,
        documentId,
        commitReceiptId,
      );

      const outgoing = outgoingSnapshot.data() as
        | (DocumentData & {
            id: string;
            status: string;
            actualEnd: string | null;
            actualStart: string;
            handoverStartedAt: string;
            permanentPairId: string;
            primaryTechnicianIds: string[];
            operationalSlotToken: string;
          })
        | undefined;
      if (!outgoing || outgoing.id !== input.outgoingShiftId || outgoing.status !== "handover_pending" ||
          outgoing.actualEnd !== null || typeof outgoing.actualStart !== "string" ||
          !Number.isFinite(Date.parse(outgoing.actualStart)) ||
          typeof outgoing.handoverStartedAt !== "string" ||
          !Number.isFinite(Date.parse(outgoing.handoverStartedAt)) ||
          outgoing.handoverStartedAt < outgoing.actualStart ||
          outgoing.permanentPairId !== identity.outgoingPermanentPairId ||
          !Array.isArray(outgoing.primaryTechnicianIds) || outgoing.primaryTechnicianIds.length !== 2 ||
          outgoing.primaryTechnicianIds.some((uid, index) => uid !== identity.outgoingTechnicianIds[index])) {
        fail(INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED, "Invalid outgoing handover Shift.");
      }
      parseShiftTimeRange(outgoing.scheduledStart as string, outgoing.scheduledEnd as string);

      let control;
      try {
        control = assertOperationalShiftControl(controlSnapshot.data());
        assertShiftOwnsOperationalSlot(
          control,
          input.outgoingShiftId,
          outgoing.operationalSlotToken as string,
          "handover_pending",
        );
        if (control.generation !== identity.outgoingGeneration ||
            control.slotToken.toLowerCase() !== identity.outgoingSlotToken.toLowerCase()) {
          fail(INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED, "Invalid outgoing control lineage.");
        }
      } catch (error) {
        if (error instanceof AssignmentOperationError) throw error;
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
          "The outgoing Shift no longer owns valid operational control.",
        );
      }

      await validateEqualHandoverPair(
        transaction,
        identity.outgoingPermanentPairId,
        identity.outgoingTechnicianIds,
      );
      await validateEqualHandoverPair(
        transaction,
        identity.incomingPermanentPairId,
        identity.incomingTechnicianIds,
      );

      const [outgoingMemberDocs, incomingMemberDocs] = await Promise.all([
        transaction.get(shiftMembers.where("shiftId", "==", input.outgoingShiftId)),
        transaction.get(shiftMembers.where("shiftId", "==", incomingId)),
      ]);
      if (!incomingMemberDocs.empty) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT,
          "Reserved incoming membership already exists.",
        );
      }
      const currentMembers: DocumentData[] = [];
      for (const document of outgoingMemberDocs.docs) {
        const member = document.data() as DocumentData;
        if (typeof member.technicianId !== "string" ||
            member.id !== document.id ||
            document.id !== `${input.outgoingShiftId}_${member.technicianId}` ||
            member.shiftId !== input.outgoingShiftId ||
            !["primary", "additional"].includes(member.role as string) ||
            typeof member.joinedAt !== "string" || !Number.isFinite(Date.parse(member.joinedAt)) ||
            (member.leftAt !== null &&
              (typeof member.leftAt !== "string" ||
                !Number.isFinite(Date.parse(member.leftAt)) ||
                member.leftAt < member.joinedAt))) {
          fail(INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT, "Invalid outgoing membership.");
        }
        if (member.leftAt === null) currentMembers.push(member);
      }

      const requiredUsers = new Set<string>([
        ...identity.outgoingTechnicianIds,
        ...identity.incomingTechnicianIds,
        ...currentMembers.map((member) => member.technicianId as string),
      ]);
      const schedules = new Map<string, TechnicianScheduleEntry[]>();
      for (const uid of requiredUsers) {
        if (uid !== input.actorUid) {
          authorizeTechnicianProfile(
            (await transaction.get(db.collection("users").doc(uid))).data() as
              | Record<string, unknown>
              | undefined,
            uid,
          );
        }
        const incomingMember = identity.incomingTechnicianIds.includes(uid);
        const entries = readEqualHandoverParticipantSchedule(
          (await transaction.get(technicianSchedules.doc(uid))).data(),
          uid,
          incomingMember
            ? {
                shiftId: incomingId,
                status: "scheduled",
                scheduledStart: identity.scheduledStart,
                scheduledEnd: identity.scheduledEnd,
              }
            : {
                shiftId: input.outgoingShiftId,
                status: "handover_pending",
                scheduledStart: outgoing.scheduledStart as string,
                scheduledEnd: outgoing.scheduledEnd as string,
              },
        );
        schedules.set(uid, entries);
      }

      const scheduledStartMs = Date.parse(identity.scheduledStart);
      const scheduledEndMs = Date.parse(identity.scheduledEnd);
      assertFirstActivationWindow({
        operationalAppliedAt: input.operationalAppliedAt,
        earliestActivationAt: new Date(
          scheduledStartMs - SHIFT_ACTIVATION_WINDOW.EARLY_MINUTES * 60_000,
        ).toISOString(),
        latestActivationAt: new Date(
          Math.min(
            scheduledStartMs + SHIFT_ACTIVATION_WINDOW.LATE_MINUTES * 60_000,
            scheduledEndMs,
          ),
        ).toISOString(),
      });

      const completed = activateEqualHandoverIncomingTransfer(aggregate, {
        revision: input.reviewedBinding.aggregateRevision,
        snapshotHash: input.reviewedBinding.snapshotHash,
        recordedAt: input.operationalAppliedAt,
        actorUid: input.actorUid,
      });

      let after;
      try {
        after = transferOperationalShiftControl({
          currentControl: control,
          outgoingShiftId: input.outgoingShiftId,
          outgoingSlotToken: identity.outgoingSlotToken,
          outgoingGeneration: identity.outgoingGeneration,
          incomingShiftId: incomingId,
          successorSlotToken: identity.successorSlotToken,
          successorGeneration: identity.successorGeneration,
          transferTimestamp: input.operationalAppliedAt,
        });
      } catch (error) {
        if (error instanceof AssignmentOperationError) throw error;
        fail(INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED, "The operational shift control could not be transferred.");
      }

      let finalizedMembers;
      try {
        finalizedMembers = finalizeCurrentShiftMemberships({
          shiftId: input.outgoingShiftId,
          completedAt: input.operationalAppliedAt,
          members: currentMembers,
        });
      } catch (error) {
        if (error instanceof AssignmentOperationError) throw error;
        fail(INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT, "Outgoing shift memberships could not be finalized.");
      }

      const boundReportId = aggregate.reportBinding?.id ?? "";
      const activationReceipt = createActivationReceipt({
        activationReceiptId,
        documentId,
        outgoingShiftId: input.outgoingShiftId,
        incomingShiftId: incomingId,
        finalRevision: completed.revision,
        finalSnapshotHash: createEqualHandoverSnapshot(completed).snapshotHash,
        boundReportId,
        actorUid: input.actorUid,
        activatedAt: input.operationalAppliedAt,
        controlBefore: control,
        controlAfter: after,
      });

      const applicationReceipt = createIncomingAcceptanceApplicationReceipt({
        handoverDocumentId: documentId,
        outgoingShiftId: input.outgoingShiftId,
        incomingShiftId: incomingId,
        technicianUid: input.actorUid,
        position: actorPosition.position,
        outcome,
        activationReceiptId,
        activationReceiptHash: activationReceipt.receiptHash,
        evidenceKind: effectiveKind,
        evidenceDigest: plan.evidenceDigest,
        membershipId: `${incomingId}_${input.actorUid}`,
        attendanceId: `${incomingId}_${input.actorUid}`,
        reviewedBinding: input.reviewedBinding,
        appliedGuardBinding: appliedGuardBinding(guard, documentId),
        requestAcceptedAt: input.requestAcceptedAt,
        passwordVerifiedAt: proof.verifiedAt,
        authAccountCheckedAt: proof.authAccountCheckedAt,
        personalEvidenceEventAt: input.operationalAppliedAt,
        operationalAppliedAt: input.operationalAppliedAt,
        lateReason,
        absenceReference: absenceReference(aggregate, input.actorUid, effectiveKind),
      });
      assertIncomingAcceptanceReservation(applicationReceipt, reservationBinding(aggregate, documentId));
      assertIncomingAcceptanceClockOrder({
        requestAcceptedAt: applicationReceipt.requestAcceptedAt,
        passwordVerifiedAt: applicationReceipt.passwordVerifiedAt,
        authAccountCheckedAt: applicationReceipt.authAccountCheckedAt,
        personalEvidenceEventAt: applicationReceipt.personalEvidenceEventAt,
        operationalAppliedAt: applicationReceipt.operationalAppliedAt,
        outcome,
        origin: applicationReceipt.origin,
        aggregateUpdatedAt: aggregate.updatedAt,
      });
      const incomingShiftRecord: IncomingAcceptanceIncomingShiftRecord = {
        id: incomingId,
        status: "active",
        actualStart: input.operationalAppliedAt,
      };
      assertIncomingAcceptanceOutcome({
        receipt: applicationReceipt,
        activationReceipt,
        incomingShift: incomingShiftRecord,
        scheduledStart: identity.scheduledStart,
        scheduledEnd: identity.scheduledEnd,
      });

      const outboxIntents = notification.enabled
        ? completionIntents(completed, input.operationalAppliedAt)
        : [];
      if (outboxIntents.length > MAX_OUTBOX_PRE_READS) {
        throw new AtomicAcceptanceServiceError(
          "APPLICATION_LIMIT_EXCEEDED",
          "The completion notification plan exceeds the safe transaction budget.",
          "not_committed",
          409,
        );
      }
      const outboxTargets = await readFreshOutboxTargets(transaction, db, outboxIntents);
      const freshIntents: NotificationIntent[] = [];
      for (const target of outboxTargets) {
        if (target.notification.exists || target.outbox.exists) {
          assertExistingOutboxPair(target.intent, target.notification, target.outbox);
          continue;
        }
        freshIntents.push(target.intent);
      }
      const existingIntents = outboxTargets.length - freshIntents.length;
      notification = notification.enabled
        ? freshIntents.length > 0
          ? {
              enabled: true,
              outboxState: "written",
              intentsQueued: freshIntents.length,
              intentsExisting: existingIntents,
            }
          : existingIntents > 0
            ? {
                enabled: true,
                outboxState: "existing",
                intentsQueued: 0,
                intentsExisting: existingIntents,
              }
            : { enabled: true, outboxState: "not_required", intentsQueued: 0, intentsExisting: 0 }
        : { enabled: false, outboxState: "disabled", intentsQueued: 0, intentsExisting: 0 };

      // ---- staged writes (queued on the caller's transaction only) --------
      const scheduleWrites: Array<[string, TechnicianScheduleEntry[]]> = [];
      for (const [uid, entries] of schedules) {
        const incomingMember = identity.incomingTechnicianIds.includes(uid);
        if (incomingMember && uid !== input.actorUid) continue;
        scheduleWrites.push([uid, entries]);
      }
      const activityUids = [...requiredUsers].filter(
        (uid) => !(identity.incomingTechnicianIds.includes(uid) && uid !== input.actorUid),
      );

      stage(completed);
      stage({ status: "completed" });
      stage({ incomingId });
      stage({ members: true }, finalizedMembers.length);
      stage({ schedules: true }, scheduleWrites.length);
      stage(applicationReceipt);
      stage(activationReceipt);
      stage(createApplicationAuditRecord(applicationReceipt));
      stage(plan.evidence);
      stage(plan.operation);
      stage({ outbox: true }, freshIntents.length * 2);
      stage({ activity: true }, activityUids.length);

      assertApplicationBudget(stagedWrites, stagedBytes);

      transaction.set(aggregateRef, completed);
      transaction.update(shifts.doc(input.outgoingShiftId), {
        status: "completed",
        actualEnd: input.operationalAppliedAt,
        completedBy: input.actorUid,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: input.operationalAppliedAt,
      });
      transaction.create(shifts.doc(incomingId), {
        id: incomingId,
        operationalSlotToken: identity.successorSlotToken,
        permanentPairId: identity.incomingPermanentPairId,
        shiftType: identity.shiftType,
        status: "active",
        scheduledStart: identity.scheduledStart,
        scheduledEnd: identity.scheduledEnd,
        actualStart: input.operationalAppliedAt,
        actualEnd: null,
        primaryTechnicianIds: identity.incomingTechnicianIds,
        createdBy: input.actorUid,
        createdAt: input.operationalAppliedAt,
        updatedAt: input.operationalAppliedAt,
        startedBy: input.actorUid,
        startedAt: FieldValue.serverTimestamp(),
        previousShiftId: input.outgoingShiftId,
        previousOperationalSlotToken: identity.outgoingSlotToken,
        operationalGeneration: identity.successorGeneration,
        handoverDocumentId: documentId,
      });
      for (const member of finalizedMembers) {
        transaction.update(shiftMembers.doc(member.id), { leftAt: input.operationalAppliedAt });
      }
      transaction.create(shiftMembers.doc(`${incomingId}_${input.actorUid}`), {
        id: `${incomingId}_${input.actorUid}`,
        shiftId: incomingId,
        technicianId: input.actorUid,
        role: "primary",
        joinedAt: input.operationalAppliedAt,
        leftAt: null,
      });
      transaction.create(
        shiftAttendance.doc(`${incomingId}_${input.actorUid}`),
        createShiftAttendanceRecord({
          shiftId: incomingId,
          technicianUid: input.actorUid,
          participationAuthority: ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY,
          authorizationId: null,
          recordedAt: input.operationalAppliedAt,
        }),
      );
      for (const [uid, entries] of scheduleWrites) {
        const incomingMember = identity.incomingTechnicianIds.includes(uid);
        transaction.update(technicianSchedules.doc(uid), {
          entries: incomingMember
            ? entries.map((entry) =>
                entry.shiftId === incomingId ? { ...entry, status: "active" } : entry,
              )
            : entries.filter((entry) => entry.shiftId !== input.outgoingShiftId),
          updatedAt: input.operationalAppliedAt,
        });
      }
      transaction.set(operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID), after);
      transaction.create(activationReceiptRef, {
        ...activationReceipt,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.create(receiptDocumentRef, {
        ...applicationReceipt,
        committedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(auditRef, createApplicationAuditRecord(applicationReceipt));
      for (const uid of activityUids) {
        transaction.update(db.collection("users").doc(uid), {
          lastAssignmentActivityAt: FieldValue.serverTimestamp(),
          ...(uid === input.actorUid
            ? { lastOperationalActivityAt: FieldValue.serverTimestamp() }
            : {}),
        });
      }
      if (freshIntents.length > 0) writeOutboxEntries(transaction, db, freshIntents);
    } else {
      // ---- SUBSEQUENT_JOIN ------------------------------------------------
      if (!activationReceiptSnapshot.exists) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
          "A completed v2 handover is missing its activation receipt; administrator review required.",
        );
      }
      const activationReceipt = activationReceiptSnapshot.data() as unknown as IncomingAcceptanceActivationReceipt;
      if (activationReceipt.actorUid === input.actorUid) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT,
          "The activation receipt and this technician disagree; administrator review required.",
        );
      }
      const incoming = incomingSnapshot.data() as
        | (DocumentData & {
            id: string;
            status: string;
            actualEnd: string | null;
            operationalSlotToken: string;
          })
        | undefined;
      if (!incoming || incoming.id !== incomingId || incoming.status !== "active" || incoming.actualEnd !== null) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
          "The reserved incoming shift is not active; joining is blocked.",
        );
      }
      let control;
      try {
        control = assertOperationalShiftControl(controlSnapshot.data());
        assertShiftOwnsOperationalSlot(control, incomingId, incoming.operationalSlotToken, "active");
        if (control.slotStatus !== "consumed" || control.shiftStatus !== "active") {
          fail(INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED, "Operational control is inconsistent with the active shift.");
        }
      } catch (error) {
        if (error instanceof AssignmentOperationError) throw error;
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
          "The incoming shift does not own valid operational control.",
        );
      }
      await validateEqualHandoverPair(
        transaction,
        identity.incomingPermanentPairId,
        identity.incomingTechnicianIds,
      );
      const actorScheduleEntries = readEqualHandoverParticipantSchedule(
        (await transaction.get(technicianSchedules.doc(input.actorUid))).data(),
        input.actorUid,
        {
          shiftId: incomingId,
          status: "scheduled",
          scheduledStart: identity.scheduledStart,
          scheduledEnd: identity.scheduledEnd,
        },
      );
      if (actorMemberSnapshot.exists || actorAttendanceSnapshot.exists) {
        fail(
          INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT,
          actorMemberSnapshot.exists && actorAttendanceSnapshot.exists
            ? "The incoming technician is already participating without an application receipt."
            : "The incoming technician has only half of its participation records.",
        );
      }
      assertIncomingAcceptanceJoinWindow({
        activationTime: activationReceipt.activatedAt,
        joinTime: input.operationalAppliedAt,
        scheduledStart: identity.scheduledStart,
        scheduledEnd: identity.scheduledEnd,
      });

      const applicationReceipt = createIncomingAcceptanceApplicationReceipt({
        handoverDocumentId: documentId,
        outgoingShiftId: input.outgoingShiftId,
        incomingShiftId: incomingId,
        technicianUid: input.actorUid,
        position: actorPosition.position,
        outcome,
        activationReceiptId,
        activationReceiptHash: activationReceipt.receiptHash,
        evidenceKind: effectiveKind,
        evidenceDigest: plan.evidenceDigest,
        membershipId: `${incomingId}_${input.actorUid}`,
        attendanceId: `${incomingId}_${input.actorUid}`,
        reviewedBinding: input.reviewedBinding,
        appliedGuardBinding: appliedGuardBinding(guard, documentId),
        requestAcceptedAt: input.requestAcceptedAt,
        passwordVerifiedAt: proof.verifiedAt,
        authAccountCheckedAt: proof.authAccountCheckedAt,
        personalEvidenceEventAt: input.operationalAppliedAt,
        operationalAppliedAt: input.operationalAppliedAt,
        lateReason,
        absenceReference: absenceReference(aggregate, input.actorUid, effectiveKind),
      });
      assertIncomingAcceptanceReservation(applicationReceipt, reservationBinding(aggregate, documentId));
      assertIncomingAcceptanceClockOrder({
        requestAcceptedAt: applicationReceipt.requestAcceptedAt,
        passwordVerifiedAt: applicationReceipt.passwordVerifiedAt,
        authAccountCheckedAt: applicationReceipt.authAccountCheckedAt,
        personalEvidenceEventAt: applicationReceipt.personalEvidenceEventAt,
        operationalAppliedAt: applicationReceipt.operationalAppliedAt,
        outcome,
        origin: applicationReceipt.origin,
        aggregateUpdatedAt: null,
      });
      assertIncomingAcceptanceOutcome({
        receipt: applicationReceipt,
        activationReceipt,
        incomingShift: incoming as unknown as IncomingAcceptanceIncomingShiftRecord,
        scheduledStart: identity.scheduledStart,
        scheduledEnd: identity.scheduledEnd,
      });

      stage({ actor: true }, 2); // membership + attendance
      stage({ schedule: true });
      stage(applicationReceipt);
      stage(createApplicationAuditRecord(applicationReceipt));
      stage(plan.evidence);
      stage(plan.operation);

      assertApplicationBudget(stagedWrites, stagedBytes);

      transaction.create(shiftMembers.doc(`${incomingId}_${input.actorUid}`), {
        id: `${incomingId}_${input.actorUid}`,
        shiftId: incomingId,
        technicianId: input.actorUid,
        role: "primary",
        joinedAt: input.operationalAppliedAt,
        leftAt: null,
      });
      transaction.create(
        shiftAttendance.doc(`${incomingId}_${input.actorUid}`),
        createShiftAttendanceRecord({
          shiftId: incomingId,
          technicianUid: input.actorUid,
          participationAuthority: ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY,
          authorizationId: null,
          recordedAt: input.operationalAppliedAt,
        }),
      );
      transaction.update(technicianSchedules.doc(input.actorUid), {
        entries: actorScheduleEntries.map((entry) =>
          entry.shiftId === incomingId ? { ...entry, status: "active" } : entry,
        ),
        updatedAt: input.operationalAppliedAt,
      });
      transaction.update(db.collection("users").doc(input.actorUid), {
        lastAssignmentActivityAt: FieldValue.serverTimestamp(),
        lastOperationalActivityAt: FieldValue.serverTimestamp(),
      });
      transaction.create(receiptDocumentRef, {
        ...applicationReceipt,
        committedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(auditRef, createApplicationAuditRecord(applicationReceipt));
    }

    applyAtomicAcceptanceEvidencePlan(transaction, plan);

    return { outcome, replayed: false, guardLifecycle: guard.ownerLifecycleState, notification };
  });

  // -------------------------------------------------------------------------
  // Post-commit read-back. A committed transaction is not yet a successful
  // response: the receipt must hydrate to a resolved server timestamp and
  // revalidate against its own hash before anything is returned.
  //
  // The receipt identity never includes the evidence kind, so it is recomputed
  // here from the reviewed handover and the authenticated technician instead of
  // trusting a value produced by the callback.
  // -------------------------------------------------------------------------
  const receiptId = createIncomingAcceptanceApplicationIdentity({
    handoverId: input.reviewedBinding.handoverId,
    technicianUid: input.actorUid,
    kind: ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
  }).receiptId;

  let persisted: DocumentSnapshot;
  try {
    persisted = await receiptsCollection.doc(receiptId).get();
  } catch {
    throw new AtomicAcceptanceServiceError(
      "APPLICATION_OUTCOME_UNKNOWN",
      "The application commit could not be read back. Refresh acceptance status before retrying.",
      "committed_unreadable",
      503,
    );
  }

  return finalizeCommittedResult(input, receiptId, persisted, committed);
}

function finalizeCommittedResult(
  input: AtomicIncomingAcceptanceInput,
  receiptId: string,
  persisted: DocumentSnapshot,
  committed: {
    outcome: IncomingAcceptanceOutcome;
    replayed: boolean;
    guardLifecycle: HandoverReservationGuard["ownerLifecycleState"];
    notification: AtomicAcceptanceNotificationReport;
  },
): AtomicIncomingAcceptanceResult {
  if (!persisted.exists) {
    throw new AtomicAcceptanceServiceError(
      "APPLICATION_OUTCOME_UNKNOWN",
      "The application commit could not be verified from its persisted receipt. Refresh acceptance status before retrying.",
      "committed_unreadable",
      503,
    );
  }

  let receipt: IncomingAcceptanceApplicationReceipt;
  try {
    receipt = readPersistedReceipt(persisted.data());
  } catch (error) {
    if (error instanceof AtomicAcceptanceServiceError) throw error;
    throw new AtomicAcceptanceServiceError(
      "APPLICATION_OUTCOME_UNKNOWN",
      "The persisted application receipt contradicts this application; administrator review is required before retrying.",
      "committed_inconsistent",
      503,
    );
  }

  if (receipt.id !== receiptId ||
      receipt.technicianUid !== input.actorUid ||
      receipt.handoverDocumentId !== input.reviewedBinding.handoverDocumentId ||
      receipt.outcome !== committed.outcome) {
    throw new AtomicAcceptanceServiceError(
      "APPLICATION_OUTCOME_UNKNOWN",
      "The persisted application receipt does not match this application; administrator review is required before retrying.",
      "committed_inconsistent",
      503,
    );
  }

  return {
    status: committed.replayed ? "REPLAYED" : "APPLIED",
    replayed: committed.replayed,
    outcome: committed.outcome,
    receipt,
    receiptHash: receipt.receiptHash,
    commitState: "committed_validated",
    handoverDocumentId: receipt.handoverDocumentId,
    outgoingShiftId: receipt.outgoingShiftId,
    incomingShiftId: receipt.incomingShiftId,
    technicianUid: receipt.technicianUid,
    position: receipt.position,
    guardCleanup: committed.guardLifecycle === "completed" ? "completed" : "pending",
    notificationDelivery: committed.notification,
  };
}
