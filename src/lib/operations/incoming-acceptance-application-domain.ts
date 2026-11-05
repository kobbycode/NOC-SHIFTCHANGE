// Pure domain for the atomic incoming-acceptance application protocol.
// No Firestore imports, no writers and no authentication network calls.

import { createHash } from "node:crypto";
import {
  ATTENDANCE_EVIDENCE_KINDS,
  type AttendanceEvidenceKind,
} from "@/types/attendance-evidence";
import { EQUAL_HANDOVER_POSITIONS } from "@/types/equal-technician-handover";
import {
  INCOMING_ACCEPTANCE_APPLICATION_PROTOCOL_VERSION,
  INCOMING_ACCEPTANCE_APPLICATION_SCHEMA,
  INCOMING_ACCEPTANCE_APPLICATION_STATUSES,
  INCOMING_ACCEPTANCE_AUTHENTICATION_PROOF_SCHEMA,
  INCOMING_ACCEPTANCE_EVIDENCE_ROLES,
  INCOMING_ACCEPTANCE_LATE_REASON_SOURCES,
  INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS,
  INCOMING_ACCEPTANCE_ORIGINS,
  INCOMING_ACCEPTANCE_OUTCOMES,
  type IncomingAcceptanceAbsenceReference,
  type IncomingAcceptanceApplicationReceipt,
  type IncomingAcceptanceAttendanceRecord,
  type IncomingAcceptanceAuthenticationProof,
  type IncomingAcceptanceCommitMarker,
  type IncomingAcceptanceEvidenceRecord,
  type IncomingAcceptanceExceptionalClosure,
  type IncomingAcceptanceGuardApplicationState,
  type IncomingAcceptanceIncomingShiftRecord,
  type IncomingAcceptanceLateReasonSource,
  type IncomingAcceptanceLegacyClassification,
  type IncomingAcceptanceLegacyRecovery,
  type IncomingAcceptanceLegacyState,
  type IncomingAcceptanceMembershipRecord,
  type IncomingAcceptanceOperationRecord,
  type IncomingAcceptanceOutcome,
  type IncomingAcceptanceReservationBinding,
  type IncomingAcceptanceReviewedBinding,
} from "@/types/incoming-acceptance-application";
import {
  attendanceAuthenticationMethodForKind,
  attendanceEvidenceId,
  attendanceEvidenceSlotId,
  attendanceOperationId,
} from "./attendance-evidence-domain";
import { evaluateIncomingAttendanceLateness } from "./equal-technician-handover-domain";

export const INCOMING_ACCEPTANCE_PROOF_MAX_AGE_MS = 60_000;
export const INCOMING_ACCEPTANCE_LATE_REASON_MAX_LENGTH = 1_000;
export const INCOMING_ACCEPTANCE_LEGACY_RECOVERY_WRITES_ENABLED = false;

export const INCOMING_ACCEPTANCE_ERROR_CODES = {
  AUTHENTICATION_PROOF_INVALID: "AUTHENTICATION_PROOF_INVALID",
  AUTHENTICATION_EXPIRED: "AUTHENTICATION_EXPIRED",
  AUTH_IDENTITY_CHANGED: "AUTH_IDENTITY_CHANGED",
  REVIEW_BINDING_CHANGED: "REVIEW_BINDING_CHANGED",
  CLOCK_ORDER_CONFLICT: "CLOCK_ORDER_CONFLICT",
  LATE_REASON_REQUIRED: "LATE_REASON_REQUIRED",
  LATE_REASON_INVALID: "LATE_REASON_INVALID",
  ACTIVATION_NOT_OPEN: "ACTIVATION_NOT_OPEN",
  ACTIVATION_WINDOW_EXPIRED: "ACTIVATION_WINDOW_EXPIRED",
  JOIN_WINDOW_NOT_OPEN: "JOIN_WINDOW_NOT_OPEN",
  JOIN_WINDOW_CLOSED: "JOIN_WINDOW_CLOSED",
  JOIN_WINDOW_INCONSISTENT: "JOIN_WINDOW_INCONSISTENT",
  APPLICATION_RECEIPT_INCONSISTENT: "APPLICATION_RECEIPT_INCONSISTENT",
  EVIDENCE_BINDING_CONFLICT: "EVIDENCE_BINDING_CONFLICT",
  PARTICIPATION_INCONSISTENT: "PARTICIPATION_INCONSISTENT",
  GUARD_COMPLETION_NOT_ELIGIBLE: "GUARD_COMPLETION_NOT_ELIGIBLE",
  LEGACY_RECOVERY_DISABLED: "LEGACY_RECOVERY_DISABLED",
} as const;

export type IncomingAcceptanceErrorCode =
  (typeof INCOMING_ACCEPTANCE_ERROR_CODES)[keyof typeof INCOMING_ACCEPTANCE_ERROR_CODES];

const ERROR_STATUS: Record<IncomingAcceptanceErrorCode, number> = {
  AUTHENTICATION_PROOF_INVALID: 400,
  AUTHENTICATION_EXPIRED: 409,
  AUTH_IDENTITY_CHANGED: 403,
  REVIEW_BINDING_CHANGED: 409,
  CLOCK_ORDER_CONFLICT: 409,
  LATE_REASON_REQUIRED: 400,
  LATE_REASON_INVALID: 400,
  ACTIVATION_NOT_OPEN: 409,
  ACTIVATION_WINDOW_EXPIRED: 409,
  JOIN_WINDOW_NOT_OPEN: 409,
  JOIN_WINDOW_CLOSED: 409,
  JOIN_WINDOW_INCONSISTENT: 409,
  APPLICATION_RECEIPT_INCONSISTENT: 409,
  EVIDENCE_BINDING_CONFLICT: 409,
  PARTICIPATION_INCONSISTENT: 409,
  GUARD_COMPLETION_NOT_ELIGIBLE: 409,
  LEGACY_RECOVERY_DISABLED: 409,
};

export class IncomingAcceptanceApplicationError extends Error {
  public readonly code: IncomingAcceptanceErrorCode;
  public readonly status: number;

  constructor(code: IncomingAcceptanceErrorCode, message: string) {
    super(message);
    this.name = "IncomingAcceptanceApplicationError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

function fail(code: IncomingAcceptanceErrorCode, message: string): never {
  throw new IncomingAcceptanceApplicationError(code, message);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function identifier(
  value: unknown,
  label: string,
  max = 512,
  code: IncomingAcceptanceErrorCode = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > max ||
    value.includes("/") ||
    value === "." ||
    value === ".."
  ) {
    fail(code, `Invalid ${label}.`);
  }
}

function hex64(
  value: unknown,
  label: string,
  code: IncomingAcceptanceErrorCode = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(code, `Invalid ${label}.`);
  }
}

function positiveInteger(
  value: unknown,
  label: string,
  code: IncomingAcceptanceErrorCode = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(code, `Invalid ${label}.`);
  }
}

function nonNegativeInteger(
  value: unknown,
  label: string,
  code: IncomingAcceptanceErrorCode = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(code, `Invalid ${label}.`);
  }
}

function canonicalTimestamp(
  value: unknown,
  label: string,
  code: IncomingAcceptanceErrorCode = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(code, `Invalid canonical ${label}.`);
  }
}

function strictObject(
  value: unknown,
  required: readonly string[],
  code: IncomingAcceptanceErrorCode = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  label = "record",
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `Malformed ${label}.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = [...required, ...optional];
  if (
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    fail(code, `Malformed ${label}: missing or unsupported fields.`);
  }
  return record;
}

function objectRecord(
  value: unknown,
  code: IncomingAcceptanceErrorCode,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `Malformed ${label}.`);
  }
  return value as Record<string, unknown>;
}

function clockMs(value: string): number {
  return Date.parse(value);
}

function atOrAfter(earlier: string | null, later: string | null): boolean {
  return earlier === null || later === null || clockMs(earlier) <= clockMs(later);
}

// ---------------------------------------------------------------------------
// Deterministic identity
// ---------------------------------------------------------------------------

export interface IncomingAcceptanceIdentityInput {
  handoverId: string;
  technicianUid: string;
  kind: AttendanceEvidenceKind;
}

export function createIncomingAcceptanceApplicationIdentity(input: IncomingAcceptanceIdentityInput) {
  identifier(input.handoverId, "handover ID", 512, INCOMING_ACCEPTANCE_ERROR_CODES.EVIDENCE_BINDING_CONFLICT);
  identifier(input.technicianUid, "technician UID", 128, INCOMING_ACCEPTANCE_ERROR_CODES.EVIDENCE_BINDING_CONFLICT);
  if (
    input.kind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN &&
    input.kind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE
  ) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.EVIDENCE_BINDING_CONFLICT, "Unsupported incoming acceptance evidence kind.");
  }

  const businessKeyHash = digest({
    namespace: "incoming-acceptance-application-v1",
    handoverId: input.handoverId,
    technicianUid: input.technicianUid,
  });
  const slotId = attendanceEvidenceSlotId(input);
  const eventId = `atomic_acceptance_v1_${digest({
    handoverId: input.handoverId,
    technicianUid: input.technicianUid,
    kind: input.kind,
  })}`;

  return {
    handoverId: input.handoverId,
    technicianUid: input.technicianUid,
    kind: input.kind,
    businessKeyHash,
    receiptId: `acceptance_app_v1_${businessKeyHash}`,
    auditId: `acceptance_application_v1_${businessKeyHash}`,
    eventId,
    operationId: attendanceOperationId(eventId),
    evidenceId: attendanceEvidenceId(slotId),
    slotId,
  };
}

// The pre-atomic acceptance writer derives its attendance evidence event (and
// therefore operation) identifier from this exact material. Recovery
// eligibility must be able to name the document that writer would have
// produced, otherwise an interrupted legacy attempt is invisible.
export function createLegacyIncomingAcceptanceEventId(input: IncomingAcceptanceIdentityInput): string {
  identifier(input.handoverId, "handover ID", 512, INCOMING_ACCEPTANCE_ERROR_CODES.EVIDENCE_BINDING_CONFLICT);
  identifier(input.technicianUid, "technician UID", 128, INCOMING_ACCEPTANCE_ERROR_CODES.EVIDENCE_BINDING_CONFLICT);
  if (
    input.kind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN &&
    input.kind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE
  ) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.EVIDENCE_BINDING_CONFLICT, "Unsupported incoming acceptance evidence kind.");
  }
  return `acceptance_v2_${digest({
    handoverId: input.handoverId,
    technicianUid: input.technicianUid,
    kind: input.kind,
  })}`;
}

export function selectIncomingAcceptanceEvidenceKind(hasNotYetInDeclaration: boolean): AttendanceEvidenceKind {
  return hasNotYetInDeclaration
    ? ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE
    : ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN;
}

// ---------------------------------------------------------------------------
// Reviewed binding and late reason
// ---------------------------------------------------------------------------

const reviewedReportFields = [
  "schema",
  "id",
  "digest",
  "evidenceSnapshotHash",
  "workSnapshotVersion",
  "preparationId",
  "preparationRevision",
  "reservationId",
  "aggregateRevision",
  "fencingEpoch",
  "frozenBy",
  "frozenAt",
] as const;
const reviewedBindingFields = [
  "handoverId",
  "handoverDocumentId",
  "aggregateRevision",
  "snapshotHash",
  "report",
  "guardRevision",
  "fencingEpoch",
] as const;

export function assertReviewedReportBinding(value: unknown): void {
  const record = strictObject(value, reviewedReportFields, undefined, "reviewed report binding");
  if (record.schema !== "handover-report-v2") {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "Unsupported report binding schema.");
  }
  identifier(record.id, "report ID");
  hex64(record.digest, "report digest");
  hex64(record.evidenceSnapshotHash, "report evidence snapshot hash");
  identifier(record.workSnapshotVersion, "work snapshot version", 128);
  identifier(record.preparationId, "preparation ID");
  positiveInteger(record.preparationRevision, "preparation revision");
  identifier(record.reservationId, "report reservation ID");
  positiveInteger(record.aggregateRevision, "report aggregate revision");
  positiveInteger(record.fencingEpoch, "report fencing epoch");
  identifier(record.frozenBy, "report freezer UID", 128);
  canonicalTimestamp(record.frozenAt, "report frozen time");
}

export function assertReviewedBinding(value: unknown): asserts value is IncomingAcceptanceReviewedBinding {
  const record = strictObject(value, reviewedBindingFields, undefined, "reviewed binding");
  identifier(record.handoverId, "handover ID");
  identifier(record.handoverDocumentId, "handover document ID");
  positiveInteger(record.aggregateRevision, "aggregate revision");
  hex64(record.snapshotHash, "snapshot hash");
  assertReviewedReportBinding(record.report);
  const report = record.report as Record<string, unknown>;
  positiveInteger(record.guardRevision, "guard revision");
  positiveInteger(record.fencingEpoch, "fencing epoch");
  if (report.reservationId !== record.handoverId) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "Report reservation does not match the reviewed handover.");
  }
  if (report.aggregateRevision !== record.aggregateRevision) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "Report revision does not match the reviewed aggregate.");
  }
  if (report.fencingEpoch !== record.fencingEpoch) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "Report fencing epoch does not match the reviewed binding.");
  }
}

export function createReviewedBindingFingerprint(binding: IncomingAcceptanceReviewedBinding): string {
  assertReviewedBinding(binding);
  return digest({ namespace: "incoming-acceptance-reviewed-binding-v1", binding });
}

export function assertReviewedBindingMatches(
  receiptBinding: IncomingAcceptanceReviewedBinding,
  currentBinding: IncomingAcceptanceReviewedBinding,
): void {
  assertReviewedBinding(receiptBinding);
  assertReviewedBinding(currentBinding);
  if (canonical(receiptBinding) !== canonical(currentBinding)) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
      "The reviewed handover, report or guard binding changed before the application commit.",
    );
  }
}

export function normalizeIncomingAcceptanceLateReason(input: {
  reason: unknown;
  required: boolean;
}): string | null {
  if (input.reason === null || input.reason === undefined) {
    if (input.required) {
      fail(INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_REQUIRED, "A late reason is required.");
    }
    return null;
  }
  if (typeof input.reason !== "string") {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_INVALID, "The late reason must be text.");
  }
  const trimmed = input.reason.trim();
  if (!trimmed) {
    if (input.required) {
      fail(INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_REQUIRED, "A non-empty late reason is required.");
    }
    return null;
  }
  if (trimmed.length > INCOMING_ACCEPTANCE_LATE_REASON_MAX_LENGTH) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_INVALID, "The late reason is too long.");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_INVALID, "The late reason contains unsupported control characters.");
  }
  return trimmed;
}

export function isIncomingAcceptanceLateReasonRequired(input: {
  scheduledStart: string;
  operationalAppliedAt: string;
}): boolean {
  canonicalTimestamp(input.scheduledStart, "scheduled start");
  canonicalTimestamp(input.operationalAppliedAt, "operational application time");
  return evaluateIncomingAttendanceLateness(input.scheduledStart, input.operationalAppliedAt).lateReasonRequired;
}

export function createLateReasonDigest(reason: string | null): string | null {
  if (reason === null) return null;
  if (typeof reason !== "string" || !reason.trim() || reason.trim() !== reason) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_INVALID, "The late reason must be normalized before digesting.");
  }
  return digest({ namespace: "incoming-acceptance-late-reason-v1", reason });
}

// ---------------------------------------------------------------------------
// Authentication proof
// ---------------------------------------------------------------------------

const proofFields = [
  "schema",
  "requestNonce",
  "verifiedTechnicianUid",
  "verifiedAt",
  "authAccountCheckedAt",
  "reviewFingerprint",
  "reasonDigest",
  "verifiedAtMonotonicMs",
] as const;

export function createIncomingAcceptanceAuthenticationProof(input: {
  requestNonce: string;
  verifiedTechnicianUid: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  reviewedBinding: IncomingAcceptanceReviewedBinding;
  lateReason: string | null;
  verifiedAtMonotonicMs: number;
}): IncomingAcceptanceAuthenticationProof {
  identifier(input.requestNonce, "request nonce", 128, INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_PROOF_INVALID);
  identifier(input.verifiedTechnicianUid, "verified technician UID", 128, INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_PROOF_INVALID);
  canonicalTimestamp(input.verifiedAt, "password verification time", INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_PROOF_INVALID);
  canonicalTimestamp(input.authAccountCheckedAt, "account check time", INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_PROOF_INVALID);
  nonNegativeInteger(input.verifiedAtMonotonicMs, "verification monotonic time", INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_PROOF_INVALID);

  return {
    schema: INCOMING_ACCEPTANCE_AUTHENTICATION_PROOF_SCHEMA,
    requestNonce: input.requestNonce,
    verifiedTechnicianUid: input.verifiedTechnicianUid,
    verifiedAt: input.verifiedAt,
    authAccountCheckedAt: input.authAccountCheckedAt,
    reviewFingerprint: createReviewedBindingFingerprint(input.reviewedBinding),
    reasonDigest: createLateReasonDigest(input.lateReason),
    verifiedAtMonotonicMs: input.verifiedAtMonotonicMs,
  };
}

export function assertIncomingAcceptanceAuthenticationProof(input: {
  proof: unknown;
  expectedTechnicianUid: string;
  expectedRequestNonce: string;
  reviewedBinding: IncomingAcceptanceReviewedBinding;
  lateReason: string | null;
  nowIso: string;
  nowMonotonicMs: number;
  maximumAgeMs?: number;
}): void {
  const code = INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_PROOF_INVALID;
  const record = strictObject(input.proof, proofFields, code, "authentication proof");
  if (record.schema !== INCOMING_ACCEPTANCE_AUTHENTICATION_PROOF_SCHEMA) {
    fail(code, "Unsupported authentication proof schema.");
  }
  identifier(record.requestNonce, "request nonce", 128, code);
  identifier(record.verifiedTechnicianUid, "verified technician UID", 128, code);
  canonicalTimestamp(record.verifiedAt, "password verification time", code);
  canonicalTimestamp(record.authAccountCheckedAt, "account check time", code);
  hex64(record.reviewFingerprint, "review fingerprint", code);
  if (record.reasonDigest !== null) hex64(record.reasonDigest, "reason digest", code);
  nonNegativeInteger(record.verifiedAtMonotonicMs, "verification monotonic time", code);
  canonicalTimestamp(input.nowIso, "current time", code);
  nonNegativeInteger(input.nowMonotonicMs, "current monotonic time", code);

  if (record.verifiedTechnicianUid !== input.expectedTechnicianUid) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.AUTH_IDENTITY_CHANGED, "The verified authentication subject does not match the session subject.");
  }
  if (record.requestNonce !== input.expectedRequestNonce) {
    fail(code, "The authentication proof belongs to a different request.");
  }
  if (record.reviewFingerprint !== createReviewedBindingFingerprint(input.reviewedBinding)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED, "The reviewed handover binding changed after authentication.");
  }
  if (record.reasonDigest !== createLateReasonDigest(input.lateReason)) {
    fail(code, "The authentication proof is not bound to this late reason.");
  }

  const verifiedAtMs = clockMs(record.verifiedAt as string);
  const checkedAtMs = clockMs(record.authAccountCheckedAt as string);
  const nowMs = clockMs(input.nowIso);
  if (verifiedAtMs > checkedAtMs || checkedAtMs > nowMs) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.CLOCK_ORDER_CONFLICT, "Authentication times are not in a valid order.");
  }

  const maximumAgeMs = input.maximumAgeMs ?? INCOMING_ACCEPTANCE_PROOF_MAX_AGE_MS;
  const elapsed = input.nowMonotonicMs - (record.verifiedAtMonotonicMs as number);
  if (elapsed < 0 || nowMs < verifiedAtMs) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.CLOCK_ORDER_CONFLICT, "The authentication clocks moved backwards.");
  }
  if (elapsed > maximumAgeMs) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_EXPIRED, "The password verification has expired; authenticate again.");
  }
}

// ---------------------------------------------------------------------------
// Receipt construction and validation
// ---------------------------------------------------------------------------

const receiptFields = [
  "schema",
  "protocolVersion",
  "id",
  "businessKeyHash",
  "status",
  "handoverDocumentId",
  "reservationId",
  "outgoingShiftId",
  "incomingShiftId",
  "technicianUid",
  "position",
  "outcome",
  "activationReceiptId",
  "activationReceiptHash",
  "evidenceEventId",
  "evidenceOperationId",
  "evidenceId",
  "evidenceKind",
  "evidenceDigest",
  "membershipId",
  "attendanceId",
  "reviewedBinding",
  "appliedGuardBinding",
  "requestAcceptedAt",
  "passwordVerifiedAt",
  "authAccountCheckedAt",
  "personalEvidenceEventAt",
  "operationalAppliedAt",
  "committedAt",
  "lateReason",
  "lateReasonSource",
  "absenceReference",
  "origin",
  "evidenceRole",
  "legacyRecovery",
  "auditId",
  "receiptHash",
] as const;

const guardBindingFields = [
  "protocolOwner",
  "handoverDocumentId",
  "reservationId",
  "incomingShiftId",
  "lifecycleState",
  "guardRevision",
  "fencingEpoch",
  "outgoingSlotToken",
  "outgoingGeneration",
  "successorSlotToken",
  "successorGeneration",
] as const;

const absenceReferenceFields = [
  "absenceType",
  "technicianUid",
  "recordedBy",
  "recordedRevision",
  "revision",
  "recordedAt",
  "reason",
] as const;

const legacyRecoveryFields = [
  "approvalId",
  "approvedBy",
  "approvedAt",
  "expiresAt",
  "observedEvidenceDigest",
  "observedOperationId",
  "previousEvidenceId",
  "previousEventTime",
  "recoveredAt",
] as const;

function receiptHashMaterial(receipt: IncomingAcceptanceApplicationReceipt): string {
  const material: Record<string, unknown> = { ...receipt };
  delete material.committedAt;
  delete material.receiptHash;
  return canonical({ namespace: "incoming-acceptance-application-receipt-v1", ...material });
}

export function computeIncomingAcceptanceReceiptHash(receipt: IncomingAcceptanceApplicationReceipt): string {
  return createHash("sha256").update(receiptHashMaterial(receipt)).digest("hex");
}

function assertGuardBinding(
  value: unknown,
  receipt: Pick<IncomingAcceptanceApplicationReceipt, "handoverDocumentId" | "reservationId" | "incomingShiftId">,
): void {
  const record = strictObject(value, guardBindingFields, undefined, "applied guard binding");
  if (record.protocolOwner !== "v2") {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "The applied guard is not owned by the v2 protocol.");
  }
  identifier(record.handoverDocumentId, "guard handover document ID");
  identifier(record.reservationId, "guard reservation ID");
  identifier(record.incomingShiftId, "guard incoming shift ID");
  if (record.lifecycleState !== "active") {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "The applied guard was not active.");
  }
  positiveInteger(record.guardRevision, "guard revision");
  positiveInteger(record.fencingEpoch, "guard fencing epoch");
  identifier(record.outgoingSlotToken, "outgoing slot token");
  positiveInteger(record.outgoingGeneration, "outgoing generation");
  identifier(record.successorSlotToken, "successor slot token");
  positiveInteger(record.successorGeneration, "successor generation");
  if (
    record.handoverDocumentId !== receipt.handoverDocumentId ||
    record.reservationId !== receipt.reservationId ||
    record.incomingShiftId !== receipt.incomingShiftId
  ) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "The applied guard binding does not match the receipt lineage.");
  }
}

function assertCommitMarker(
  value: unknown,
  requireResolved: boolean,
): asserts value is IncomingAcceptanceCommitMarker {
  const code = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "Malformed application commit timestamp.");
  }
  const record = value as Record<string, unknown>;
  if (record.state === "unresolved") {
    if (Object.keys(record).length !== 1) fail(code, "Malformed unresolved commit timestamp.");
    if (requireResolved) fail(code, "The application receipt commit timestamp is not resolved.");
    return;
  }
  if (record.state !== "resolved") fail(code, "Unknown application commit timestamp state.");
  if (Object.keys(record).length !== 3) fail(code, "Malformed resolved commit timestamp.");
  nonNegativeInteger(record.seconds, "commit timestamp seconds");
  if (
    !Number.isSafeInteger(record.nanoseconds) ||
    (record.nanoseconds as number) < 0 ||
    (record.nanoseconds as number) > 999_999_999
  ) {
    fail(code, "Invalid commit timestamp nanoseconds.");
  }
}

export function assertIncomingAcceptanceApplicationReceipt(
  value: unknown,
  options: { requireResolvedCommit?: boolean } = {},
): asserts value is IncomingAcceptanceApplicationReceipt {
  const code = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT;
  const record = strictObject(value, receiptFields, code, "application receipt");
  const receipt = record as unknown as IncomingAcceptanceApplicationReceipt;

  if (record.schema !== INCOMING_ACCEPTANCE_APPLICATION_SCHEMA) fail(code, "Unsupported application receipt schema.");
  if (record.protocolVersion !== INCOMING_ACCEPTANCE_APPLICATION_PROTOCOL_VERSION) fail(code, "Unsupported application receipt protocol version.");
  if (record.status !== INCOMING_ACCEPTANCE_APPLICATION_STATUSES.APPLIED) fail(code, "Only applied application receipts are valid.");

  identifier(record.handoverDocumentId, "handover document ID");
  identifier(record.reservationId, "reservation ID");
  identifier(record.outgoingShiftId, "outgoing shift ID");
  identifier(record.incomingShiftId, "incoming shift ID");
  identifier(record.technicianUid, "technician UID", 128);

  if (record.position !== EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_A &&
      record.position !== EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_B) {
    fail(code, "Invalid incoming acceptance position.");
  }

  if (
    record.outcome !== INCOMING_ACCEPTANCE_OUTCOMES.FIRST_ACTIVATION &&
    record.outcome !== INCOMING_ACCEPTANCE_OUTCOMES.SUBSEQUENT_JOIN
  ) {
    fail(code, "Invalid application outcome.");
  }

  identifier(record.activationReceiptId, "activation receipt ID");
  hex64(record.activationReceiptHash, "activation receipt hash");

  if (
    record.evidenceKind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN &&
    record.evidenceKind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE
  ) {
    fail(code, "Unsupported incoming acceptance evidence kind.");
  }
  const identity = createIncomingAcceptanceApplicationIdentity({
    handoverId: record.reservationId,
    technicianUid: record.technicianUid,
    kind: record.evidenceKind,
  });
  if (record.id !== identity.receiptId || record.businessKeyHash !== identity.businessKeyHash) {
    fail(code, "The application receipt identity is not deterministic.");
  }
  if (record.auditId !== identity.auditId) fail(code, "The application audit identity is not deterministic.");
  if (record.evidenceEventId !== identity.eventId ||
      record.evidenceOperationId !== identity.operationId ||
      record.evidenceId !== identity.evidenceId) {
    fail(code, "The application receipt evidence identities are not deterministic.");
  }
  hex64(record.evidenceDigest, "evidence digest");

  if (record.membershipId !== `${record.incomingShiftId}_${record.technicianUid}` ||
      record.attendanceId !== `${record.incomingShiftId}_${record.technicianUid}`) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT, "The participation identities do not match the incoming shift and technician.");
  }

  assertReviewedBinding(record.reviewedBinding);
  const reviewedBinding = record.reviewedBinding as unknown as IncomingAcceptanceReviewedBinding;
  if (reviewedBinding.handoverId !== record.reservationId ||
      reviewedBinding.handoverDocumentId !== record.handoverDocumentId) {
    fail(code, "The reviewed binding does not match the receipt lineage.");
  }
  assertGuardBinding(record.appliedGuardBinding, receipt);

  canonicalTimestamp(record.requestAcceptedAt, "request acceptance time");
  canonicalTimestamp(record.passwordVerifiedAt, "password verification time");
  canonicalTimestamp(record.authAccountCheckedAt, "account check time");
  canonicalTimestamp(record.personalEvidenceEventAt, "personal evidence event time");
  canonicalTimestamp(record.operationalAppliedAt, "operational application time");
  assertCommitMarker(record.committedAt, options.requireResolvedCommit === true);

  if (record.lateReason !== null) {
    if (typeof record.lateReason !== "string" || !record.lateReason.trim() ||
        record.lateReason.trim() !== record.lateReason ||
        record.lateReason.length > INCOMING_ACCEPTANCE_LATE_REASON_MAX_LENGTH) {
      fail(INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_INVALID, "The receipt late reason is invalid.");
    }
  }
  if (
    record.lateReasonSource !== INCOMING_ACCEPTANCE_LATE_REASON_SOURCES.TECHNICIAN_SUPPLIED &&
    record.lateReasonSource !== INCOMING_ACCEPTANCE_LATE_REASON_SOURCES.NOT_REQUIRED
  ) {
    fail(code, "Invalid late reason source.");
  }
  if (record.lateReason === null && record.lateReasonSource !== INCOMING_ACCEPTANCE_LATE_REASON_SOURCES.NOT_REQUIRED) {
    fail(code, "A null late reason must use the not_required source.");
  }
  if (record.lateReason !== null && record.lateReasonSource !== INCOMING_ACCEPTANCE_LATE_REASON_SOURCES.TECHNICIAN_SUPPLIED) {
    fail(code, "A supplied late reason must use the technician_supplied source.");
  }

  if (record.absenceReference !== null) {
    const absence = strictObject(record.absenceReference, absenceReferenceFields, code, "absence reference") as unknown as IncomingAcceptanceAbsenceReference;
    if (absence.absenceType !== "not_yet_in") fail(code, "Only not_yet_in declarations may be referenced.");
    identifier(absence.technicianUid, "absence technician UID", 128);
    identifier(absence.recordedBy, "absence recorder UID", 128);
    positiveInteger(absence.recordedRevision, "absence recorded revision");
    positiveInteger(absence.revision, "absence revision");
    canonicalTimestamp(absence.recordedAt, "absence recorded time");
    if (typeof absence.reason !== "string" || !absence.reason.trim() || absence.reason.trim() !== absence.reason) {
      fail(code, "The preserved absence reason is invalid.");
    }
    if (absence.technicianUid !== record.technicianUid) {
      fail(code, "The absence declaration does not belong to the accepting technician.");
    }
    if (record.evidenceKind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE) {
      fail(code, "A referenced absence requires late-acceptance evidence.");
    }
  } else if (record.evidenceKind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN) {
    fail(code, "Late-acceptance evidence requires a preserved absence reference.");
  }

  if (record.origin !== INCOMING_ACCEPTANCE_ORIGINS.NATIVE_ATOMIC &&
      record.origin !== INCOMING_ACCEPTANCE_ORIGINS.LEGACY_RECOVERY) {
    fail(code, "Unknown application origin.");
  }
  if (record.evidenceRole !== INCOMING_ACCEPTANCE_EVIDENCE_ROLES.APPLIED_PERSONAL_EVENT &&
      record.evidenceRole !== INCOMING_ACCEPTANCE_EVIDENCE_ROLES.PRIOR_AUTHENTICATED_ATTEMPT) {
    fail(code, "Unknown evidence role.");
  }
  if (record.origin === INCOMING_ACCEPTANCE_ORIGINS.NATIVE_ATOMIC) {
    if (record.legacyRecovery !== null) fail(code, "A native application cannot carry legacy recovery metadata.");
    if (record.evidenceRole !== INCOMING_ACCEPTANCE_EVIDENCE_ROLES.APPLIED_PERSONAL_EVENT) {
      fail(code, "A native application must use the applied personal event role.");
    }
    if (record.personalEvidenceEventAt !== record.operationalAppliedAt) {
      fail(code, "Native personal evidence time must equal the operational application time.");
    }
  } else {
    if (record.legacyRecovery === null) fail(code, "A legacy recovery receipt requires recovery metadata.");
    const recovery = strictObject(record.legacyRecovery, legacyRecoveryFields, code, "legacy recovery") as unknown as IncomingAcceptanceLegacyRecovery;
    identifier(recovery.approvalId, "recovery approval ID");
    identifier(recovery.approvedBy, "recovery approver UID", 128);
    canonicalTimestamp(recovery.approvedAt, "recovery approval time");
    canonicalTimestamp(recovery.expiresAt, "recovery approval expiry");
    hex64(recovery.observedEvidenceDigest, "observed legacy evidence digest");
    identifier(recovery.observedOperationId, "observed legacy operation ID");
    identifier(recovery.previousEvidenceId, "previous evidence ID");
    canonicalTimestamp(recovery.previousEventTime, "previous evidence event time");
    canonicalTimestamp(recovery.recoveredAt, "recovery time");
    if (record.personalEvidenceEventAt !== recovery.previousEventTime) {
      fail(code, "Recovered evidence time must preserve the original event time.");
    }
    if (record.evidenceRole !== INCOMING_ACCEPTANCE_EVIDENCE_ROLES.PRIOR_AUTHENTICATED_ATTEMPT) {
      fail(code, "A legacy recovery must label the old evidence as a prior attempt.");
    }
  }

  hex64(record.receiptHash, "receipt hash");
  if (record.receiptHash !== computeIncomingAcceptanceReceiptHash(receipt)) {
    fail(code, "The application receipt hash does not match its contents.");
  }
}

export interface IncomingAcceptanceReceiptInput {
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  technicianUid: string;
  position: IncomingAcceptanceApplicationReceipt["position"];
  outcome: IncomingAcceptanceOutcome;
  activationReceiptId: string;
  activationReceiptHash: string;
  evidenceKind: AttendanceEvidenceKind;
  evidenceDigest: string;
  membershipId: string;
  attendanceId: string;
  reviewedBinding: IncomingAcceptanceReviewedBinding;
  appliedGuardBinding: IncomingAcceptanceApplicationReceipt["appliedGuardBinding"];
  requestAcceptedAt: string;
  passwordVerifiedAt: string;
  authAccountCheckedAt: string;
  personalEvidenceEventAt: string;
  operationalAppliedAt: string;
  lateReason: string | null;
  absenceReference: IncomingAcceptanceAbsenceReference | null;
  origin?: IncomingAcceptanceApplicationReceipt["origin"];
  evidenceRole?: IncomingAcceptanceApplicationReceipt["evidenceRole"];
  legacyRecovery?: IncomingAcceptanceLegacyRecovery | null;
}

export function createIncomingAcceptanceApplicationReceipt(
  input: IncomingAcceptanceReceiptInput,
): IncomingAcceptanceApplicationReceipt {
  const origin = input.origin ?? INCOMING_ACCEPTANCE_ORIGINS.NATIVE_ATOMIC;
  if (origin === INCOMING_ACCEPTANCE_ORIGINS.LEGACY_RECOVERY) {
    assertIncomingAcceptanceLegacyRecoveryWritesEnabled();
  }
  const identity = createIncomingAcceptanceApplicationIdentity({
    handoverId: input.reviewedBinding.handoverId,
    technicianUid: input.technicianUid,
    kind: input.evidenceKind,
  });
  const lateReasonSource: IncomingAcceptanceLateReasonSource =
    input.lateReason === null
      ? INCOMING_ACCEPTANCE_LATE_REASON_SOURCES.NOT_REQUIRED
      : INCOMING_ACCEPTANCE_LATE_REASON_SOURCES.TECHNICIAN_SUPPLIED;

  const receipt: IncomingAcceptanceApplicationReceipt = {
    schema: INCOMING_ACCEPTANCE_APPLICATION_SCHEMA,
    protocolVersion: INCOMING_ACCEPTANCE_APPLICATION_PROTOCOL_VERSION,
    id: identity.receiptId,
    businessKeyHash: identity.businessKeyHash,
    status: INCOMING_ACCEPTANCE_APPLICATION_STATUSES.APPLIED,
    handoverDocumentId: input.handoverDocumentId,
    reservationId: input.reviewedBinding.handoverId,
    outgoingShiftId: input.outgoingShiftId,
    incomingShiftId: input.incomingShiftId,
    technicianUid: input.technicianUid,
    position: input.position,
    outcome: input.outcome,
    activationReceiptId: input.activationReceiptId,
    activationReceiptHash: input.activationReceiptHash,
    evidenceEventId: identity.eventId,
    evidenceOperationId: identity.operationId,
    evidenceId: identity.evidenceId,
    evidenceKind: input.evidenceKind,
    evidenceDigest: input.evidenceDigest,
    membershipId: input.membershipId,
    attendanceId: input.attendanceId,
    reviewedBinding: structuredClone(input.reviewedBinding),
    appliedGuardBinding: structuredClone(input.appliedGuardBinding),
    requestAcceptedAt: input.requestAcceptedAt,
    passwordVerifiedAt: input.passwordVerifiedAt,
    authAccountCheckedAt: input.authAccountCheckedAt,
    personalEvidenceEventAt: input.personalEvidenceEventAt,
    operationalAppliedAt: input.operationalAppliedAt,
    committedAt: { state: "unresolved" } as const,
    lateReason: input.lateReason,
    lateReasonSource,
    absenceReference: input.absenceReference,
    origin,
    evidenceRole: input.evidenceRole ?? INCOMING_ACCEPTANCE_EVIDENCE_ROLES.APPLIED_PERSONAL_EVENT,
    legacyRecovery: input.legacyRecovery ?? null,
    auditId: identity.auditId,
    receiptHash: "",
  };
  receipt.receiptHash = computeIncomingAcceptanceReceiptHash(receipt);
  assertIncomingAcceptanceApplicationReceipt(receipt);
  return receipt;
}

export function hydrateIncomingAcceptanceCommittedAt(
  receipt: IncomingAcceptanceApplicationReceipt,
  value: { seconds: number; nanoseconds: number },
): IncomingAcceptanceApplicationReceipt {
  assertIncomingAcceptanceApplicationReceipt(receipt);
  nonNegativeInteger(value.seconds, "commit timestamp seconds");
  if (!Number.isSafeInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds > 999_999_999) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "Invalid commit timestamp nanoseconds.");
  }
  const hydrated: IncomingAcceptanceApplicationReceipt = {
    ...receipt,
    committedAt: { state: "resolved", seconds: value.seconds, nanoseconds: value.nanoseconds },
  };
  assertIncomingAcceptanceApplicationReceipt(hydrated, { requireResolvedCommit: true });
  return hydrated;
}

export function assertIncomingAcceptanceLegacyRecoveryWritesEnabled(): void {
  if (!INCOMING_ACCEPTANCE_LEGACY_RECOVERY_WRITES_ENABLED) {
    fail(
      INCOMING_ACCEPTANCE_ERROR_CODES.LEGACY_RECOVERY_DISABLED,
      "Legacy incoming-acceptance recovery writes are not authorized in this phase.",
    );
  }
}

// ---------------------------------------------------------------------------
// Reservation, clocks and windows
// ---------------------------------------------------------------------------

export function assertIncomingAcceptanceReservation(
  receipt: IncomingAcceptanceApplicationReceipt,
  reservation: IncomingAcceptanceReservationBinding,
): void {
  canonicalTimestamp(reservation.scheduledStart, "scheduled start");
  canonicalTimestamp(reservation.scheduledEnd, "scheduled end");
  if (reservation.handoverId !== receipt.reservationId ||
      reservation.handoverDocumentId !== receipt.handoverDocumentId ||
      reservation.outgoingShiftId !== receipt.outgoingShiftId ||
      reservation.incomingShiftId !== receipt.incomingShiftId) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "The receipt does not belong to this reservation.");
  }
  const [incomingA, incomingB] = reservation.incomingTechnicianIds;
  if (![incomingA, incomingB].includes(receipt.technicianUid)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "The receipt subject is not a reserved incoming technician.");
  }
  const expectedPosition =
    receipt.technicianUid === incomingA
      ? EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_A
      : EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_B;
  if (receipt.position !== expectedPosition) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "The receipt position does not match the reserved roster.");
  }
  if (clockMs(reservation.scheduledEnd) <= clockMs(reservation.scheduledStart)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_INCONSISTENT, "The reservation shift window is invalid.");
  }
}

export function assertIncomingAcceptanceClockOrder(input: {
  requestAcceptedAt: string;
  passwordVerifiedAt: string;
  authAccountCheckedAt: string;
  personalEvidenceEventAt: string;
  operationalAppliedAt: string;
  outcome: IncomingAcceptanceOutcome;
  origin: IncomingAcceptanceApplicationReceipt["origin"];
  aggregateUpdatedAt?: string | null;
  expectedLegacyEventTime?: string | null;
}): void {
  canonicalTimestamp(input.requestAcceptedAt, "request acceptance time");
  canonicalTimestamp(input.passwordVerifiedAt, "password verification time");
  canonicalTimestamp(input.authAccountCheckedAt, "account check time");
  canonicalTimestamp(input.personalEvidenceEventAt, "personal evidence event time");
  canonicalTimestamp(input.operationalAppliedAt, "operational application time");

  if (!atOrAfter(input.requestAcceptedAt, input.passwordVerifiedAt) ||
      !atOrAfter(input.passwordVerifiedAt, input.authAccountCheckedAt) ||
      !atOrAfter(input.authAccountCheckedAt, input.operationalAppliedAt)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.CLOCK_ORDER_CONFLICT, "Acceptance timestamps are not in a valid order.");
  }
  if (input.outcome === INCOMING_ACCEPTANCE_OUTCOMES.FIRST_ACTIVATION && input.aggregateUpdatedAt) {
    canonicalTimestamp(input.aggregateUpdatedAt, "aggregate update time");
    if (clockMs(input.requestAcceptedAt) < clockMs(input.aggregateUpdatedAt)) {
      fail(INCOMING_ACCEPTANCE_ERROR_CODES.CLOCK_ORDER_CONFLICT, "The acceptance request predates the reviewed aggregate revision.");
    }
  }
  if (input.origin === INCOMING_ACCEPTANCE_ORIGINS.NATIVE_ATOMIC) {
    if (input.personalEvidenceEventAt !== input.operationalAppliedAt) {
      fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "Native personal evidence time must equal the operational application time.");
    }
  } else if (input.expectedLegacyEventTime !== input.personalEvidenceEventAt) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT, "Recovered evidence must preserve its original event time.");
  }
}

export function assertFirstActivationWindow(input: {
  operationalAppliedAt: string;
  earliestActivationAt: string;
  latestActivationAt: string;
}): void {
  canonicalTimestamp(input.operationalAppliedAt, "operational application time");
  canonicalTimestamp(input.earliestActivationAt, "earliest activation time");
  canonicalTimestamp(input.latestActivationAt, "latest activation time");
  if (clockMs(input.earliestActivationAt) > clockMs(input.latestActivationAt)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_INCONSISTENT, "The activation window bounds are inconsistent.");
  }
  if (clockMs(input.operationalAppliedAt) < clockMs(input.earliestActivationAt)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.ACTIVATION_NOT_OPEN, "The activation window has not opened.");
  }
  if (clockMs(input.operationalAppliedAt) > clockMs(input.latestActivationAt)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.ACTIVATION_WINDOW_EXPIRED, "The activation window has expired.");
  }
}

export function assertIncomingAcceptanceJoinWindow(input: {
  activationTime: string;
  joinTime: string;
  scheduledStart: string;
  scheduledEnd: string;
}): void {
  canonicalTimestamp(input.activationTime, "activation time");
  canonicalTimestamp(input.joinTime, "join time");
  canonicalTimestamp(input.scheduledStart, "scheduled start");
  canonicalTimestamp(input.scheduledEnd, "scheduled end");
  if (clockMs(input.scheduledEnd) <= clockMs(input.scheduledStart) ||
      clockMs(input.activationTime) > clockMs(input.scheduledEnd)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_INCONSISTENT, "The activation or shift window is inconsistent.");
  }
  if (clockMs(input.joinTime) < clockMs(input.activationTime)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_NOT_OPEN, "The partner cannot join before the incoming shift activates.");
  }
  if (clockMs(input.joinTime) >= clockMs(input.scheduledEnd)) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_CLOSED, "The upcoming shift has ended; joining is closed.");
  }
}

// ---------------------------------------------------------------------------
// Evidence, participation and activation receipts
// ---------------------------------------------------------------------------

const evidenceDigestFields = [
  "slotId",
  "id",
  "operationId",
  "eventId",
  "kind",
  "technicianUid",
  "handoverId",
  "eventTime",
  "authenticationMethod",
  "personallyAuthenticated",
  "guardRevision",
  "fencingEpoch",
] as const;

export function createIncomingAcceptanceEvidenceDigest(evidence: IncomingAcceptanceEvidenceRecord): string {
  const projection: Record<string, unknown> = {};
  for (const field of evidenceDigestFields) projection[field] = evidence[field];
  return digest({ namespace: "incoming-acceptance-evidence-v1", ...projection });
}

export function assertIncomingAcceptanceEvidenceConsistency(input: {
  receipt: IncomingAcceptanceApplicationReceipt;
  operation: IncomingAcceptanceOperationRecord;
  evidence: IncomingAcceptanceEvidenceRecord;
}): void {
  const { receipt, operation, evidence } = input;
  const code = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT;
  if (operation.id !== receipt.evidenceOperationId ||
      operation.eventId !== receipt.evidenceEventId ||
      operation.technicianUid !== receipt.technicianUid ||
      operation.kind !== receipt.evidenceKind ||
      operation.evidenceId !== receipt.evidenceId) {
    fail(code, "The evidence operation does not match the application receipt.");
  }
  if (operation.status !== "finalized") {
    fail(code, "The evidence operation is not finalized.");
  }
  if (operation.interruptedFinalization !== false) {
    fail(code, "A native application cannot retain an interrupted finalization acknowledgement.");
  }
  if (evidence.id !== receipt.evidenceId ||
      evidence.operationId !== receipt.evidenceOperationId ||
      evidence.eventId !== receipt.evidenceEventId ||
      evidence.technicianUid !== receipt.technicianUid ||
      evidence.handoverId !== receipt.reservationId ||
      evidence.kind !== receipt.evidenceKind) {
    fail(code, "The attendance evidence does not match the application receipt.");
  }
  const identity = createIncomingAcceptanceApplicationIdentity({
    handoverId: receipt.reservationId,
    technicianUid: receipt.technicianUid,
    kind: receipt.evidenceKind,
  });
  if (evidence.slotId !== identity.slotId) {
    fail(code, "The attendance evidence slot is not deterministic.");
  }
  if (evidence.eventTime !== receipt.personalEvidenceEventAt) {
    fail(code, "The attendance evidence event time does not match the receipt.");
  }
  if (evidence.authenticationMethod !== attendanceAuthenticationMethodForKind(receipt.evidenceKind)) {
    fail(code, "The attendance evidence authentication method is not authoritative for its kind.");
  }
  if (evidence.personallyAuthenticated !== true) {
    fail(code, "The attendance evidence is not personally authenticated.");
  }
  if (evidence.guardRevision !== receipt.appliedGuardBinding.guardRevision ||
      evidence.fencingEpoch !== receipt.appliedGuardBinding.fencingEpoch) {
    fail(code, "The attendance evidence guard binding does not match the receipt.");
  }
  if (receipt.evidenceDigest !== createIncomingAcceptanceEvidenceDigest(evidence)) {
    fail(code, "The attendance evidence digest does not match the receipt.");
  }
}

export function assertIncomingAcceptanceParticipationConsistency(input: {
  receipt: IncomingAcceptanceApplicationReceipt;
  membership: IncomingAcceptanceMembershipRecord;
  attendance: IncomingAcceptanceAttendanceRecord;
  allowHistoricalDeparture?: boolean;
}): void {
  const { receipt, membership, attendance } = input;
  const code = INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT;
  const expectedId = `${receipt.incomingShiftId}_${receipt.technicianUid}`;
  if (membership.id !== expectedId ||
      membership.shiftId !== receipt.incomingShiftId ||
      membership.technicianId !== receipt.technicianUid ||
      membership.role !== "primary") {
    fail(code, "The incoming shift membership does not match the application receipt.");
  }
  if (membership.leftAt !== null) {
    if (!input.allowHistoricalDeparture) {
      fail(code, "The incoming membership has already ended.");
    }
    canonicalTimestamp(membership.leftAt, "membership departure time", code);
    if (clockMs(membership.leftAt) < clockMs(receipt.operationalAppliedAt)) {
      fail(code, "The membership departs before the application.");
    }
  }
  if (membership.joinedAt !== undefined && membership.joinedAt !== null) {
    canonicalTimestamp(membership.joinedAt, "membership join time", code);
    if (clockMs(membership.joinedAt) > clockMs(receipt.operationalAppliedAt)) {
      fail(code, "The membership join time is later than the application time.");
    }
  }
  if (attendance.id !== expectedId ||
      attendance.shiftId !== receipt.incomingShiftId ||
      attendance.technicianId !== receipt.technicianUid) {
    fail(code, "The attendance record does not match the application receipt.");
  }
  if (attendance.status !== "present" ||
      attendance.participationAuthority !== "primary" ||
      attendance.authorizationId !== null ||
      attendance.isProvisional !== false ||
      attendance.clockIn !== null ||
      attendance.clockOut !== null) {
    fail(code, "The legacy attendance record does not have the required operational shape.");
  }
  canonicalTimestamp(attendance.recordedAt, "attendance recorded time", code);
  canonicalTimestamp(attendance.updatedAt, "attendance updated time", code);
  if (clockMs(attendance.recordedAt) > clockMs(receipt.operationalAppliedAt)) {
    fail(code, "The attendance record was recorded after the application time.");
  }
  if (clockMs(attendance.updatedAt) < clockMs(attendance.recordedAt)) {
    fail(code, "The attendance update time precedes its recorded time.");
  }
}

export interface IncomingAcceptanceActivationReceipt {
  id: string;
  schema: "equal-handover-activation-v2";
  action: "EQUAL_SHIFT_ACTIVATED_INCOMING_V2";
  outcome: "INCOMING_ACTIVATED";
  protocol: "equal-handover-v2";
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  finalRevision: number;
  finalSnapshotHash: string;
  boundReportId: string;
  actorUid: string;
  actorRole: "technician";
  activatedAt: string;
  receiptHash: string;
  operationalControlBefore: unknown;
  operationalControlAfter: unknown;
  [key: string]: unknown;
}

const activationReceiptFields = [
  "id",
  "schema",
  "action",
  "outcome",
  "protocol",
  "handoverDocumentId",
  "outgoingShiftId",
  "incomingShiftId",
  "finalRevision",
  "finalSnapshotHash",
  "boundReportId",
  "actorUid",
  "actorRole",
  "activatedAt",
  "receiptHash",
  "operationalControlBefore",
  "operationalControlAfter",
] as const;

export function createIncomingAcceptanceActivationReceiptId(handoverDocumentId: string): string {
  identifier(handoverDocumentId, "handover document ID");
  return `handover-activation-v2-${digest({
    namespace: "equal-handover-activation-v2",
    handoverDocumentId,
  })}`;
}

function activationReceiptMaterial(receipt: IncomingAcceptanceActivationReceipt): string {
  return canonical({
    namespace: "equal-handover-activation-receipt-v2",
    id: receipt.id,
    handoverDocumentId: receipt.handoverDocumentId,
    outgoingShiftId: receipt.outgoingShiftId,
    incomingShiftId: receipt.incomingShiftId,
    finalRevision: receipt.finalRevision,
    finalSnapshotHash: receipt.finalSnapshotHash,
    boundReportId: receipt.boundReportId,
    actorUid: receipt.actorUid,
    actorRole: receipt.actorRole,
    activatedAt: receipt.activatedAt,
  });
}

export function computeIncomingAcceptanceActivationReceiptHash(
  receipt: IncomingAcceptanceActivationReceipt,
): string {
  return createHash("sha256").update(activationReceiptMaterial(receipt)).digest("hex");
}

export function assertIncomingAcceptanceActivationReceipt(
  value: unknown,
  expected: {
    handoverDocumentId: string;
    outgoingShiftId: string;
    incomingShiftId: string;
    boundReportId: string;
  },
): asserts value is IncomingAcceptanceActivationReceipt {
  const code = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT;
  const record = strictObject(
    value,
    activationReceiptFields,
    code,
    "activation receipt",
    ["createdAt"],
  );
  const receipt = record as unknown as IncomingAcceptanceActivationReceipt;
  if (receipt.schema !== "equal-handover-activation-v2" ||
      receipt.action !== "EQUAL_SHIFT_ACTIVATED_INCOMING_V2" ||
      receipt.outcome !== "INCOMING_ACTIVATED" ||
      receipt.protocol !== "equal-handover-v2") {
    fail(code, "The activation receipt schema is inconsistent.");
  }
  identifier(receipt.handoverDocumentId, "activation handover document ID");
  identifier(receipt.outgoingShiftId, "activation outgoing shift ID");
  identifier(receipt.incomingShiftId, "activation incoming shift ID");
  identifier(receipt.boundReportId, "activation bound report ID");
  identifier(receipt.actorUid, "activation actor UID", 128);
  if (receipt.actorRole !== "technician") fail(code, "The activation actor role is inconsistent.");
  canonicalTimestamp(receipt.activatedAt, "activation time");
  positiveInteger(receipt.finalRevision, "activation final revision");
  hex64(receipt.finalSnapshotHash, "activation final snapshot hash");
  hex64(receipt.receiptHash, "activation receipt hash");
  objectRecord(receipt.operationalControlBefore, code, "operational control before");
  objectRecord(receipt.operationalControlAfter, code, "operational control after");

  if (receipt.id !== createIncomingAcceptanceActivationReceiptId(receipt.handoverDocumentId)) {
    fail(code, "The activation receipt identity is not deterministic.");
  }
  if (receipt.receiptHash !== computeIncomingAcceptanceActivationReceiptHash(receipt)) {
    fail(code, "The activation receipt hash does not match its contents.");
  }
  if (receipt.handoverDocumentId !== expected.handoverDocumentId ||
      receipt.outgoingShiftId !== expected.outgoingShiftId ||
      receipt.incomingShiftId !== expected.incomingShiftId ||
      receipt.boundReportId !== expected.boundReportId) {
    fail(code, "The activation receipt does not match the application lineage.");
  }
}

export function assertIncomingAcceptanceOutcome(input: {
  receipt: IncomingAcceptanceApplicationReceipt;
  activationReceipt: unknown;
  incomingShift: IncomingAcceptanceIncomingShiftRecord | null;
  scheduledStart: string;
  scheduledEnd: string;
  requireActiveShift?: boolean;
}): void {
  const code = INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT;
  const { receipt } = input;
  assertIncomingAcceptanceActivationReceipt(input.activationReceipt, {
    handoverDocumentId: receipt.handoverDocumentId,
    outgoingShiftId: receipt.outgoingShiftId,
    incomingShiftId: receipt.incomingShiftId,
    boundReportId: receipt.reviewedBinding.report.id,
  });
  const activation = input.activationReceipt as IncomingAcceptanceActivationReceipt;

  if (activation.id !== receipt.activationReceiptId ||
      activation.receiptHash !== receipt.activationReceiptHash) {
    fail(code, "The receipt does not reference the authoritative activation receipt.");
  }

  if (!input.incomingShift ||
      input.incomingShift.id !== receipt.incomingShiftId ||
      input.incomingShift.actualStart !== activation.activatedAt) {
    fail(code, "The incoming shift does not match the activation receipt.");
  }
  const requireActive = input.requireActiveShift !== false;
  if (requireActive && input.incomingShift.status !== "active") {
    fail(code, "The incoming shift is not active.");
  }

  if (receipt.outcome === INCOMING_ACCEPTANCE_OUTCOMES.FIRST_ACTIVATION) {
    if (activation.actorUid !== receipt.technicianUid) {
      fail(code, "A first-activation receipt must belong to the activating technician.");
    }
    if (receipt.operationalAppliedAt !== activation.activatedAt ||
        receipt.personalEvidenceEventAt !== activation.activatedAt) {
      fail(code, "The first application time must equal the authoritative activation time.");
    }
    return;
  }

  if (activation.actorUid === receipt.technicianUid) {
    fail(code, "A subsequent join cannot be attributed to the activating technician.");
  }
  assertIncomingAcceptanceJoinWindow({
    activationTime: activation.activatedAt,
    joinTime: receipt.operationalAppliedAt,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
  });
}

// ---------------------------------------------------------------------------
// Legacy classification
// ---------------------------------------------------------------------------

export interface IncomingAcceptanceLegacyClassificationResult {
  classification: IncomingAcceptanceLegacyClassification;
  readOnly: true;
  receiptBacked: boolean;
  modernReceipt: IncomingAcceptanceApplicationReceipt | null;
  postDisposition: "NATIVE_REPLAY" | "LEGACY_READ_ONLY" | "RECOVERY_REVIEW" | "NONE";
}

function classification(
  value: IncomingAcceptanceLegacyClassification,
  postDisposition: IncomingAcceptanceLegacyClassificationResult["postDisposition"],
  receiptBacked = false,
  modernReceipt: IncomingAcceptanceApplicationReceipt | null = null,
): IncomingAcceptanceLegacyClassificationResult {
  return { classification: value, readOnly: true, receiptBacked, modernReceipt, postDisposition };
}

export function classifyIncomingAcceptanceLegacyState(
  state: IncomingAcceptanceLegacyState,
): IncomingAcceptanceLegacyClassificationResult {
  const {
    NATIVE_APPLIED,
    LEGACY_APPLIED_UNATTESTED_V1,
    LEGACY_UNAPPLIED_AUTHENTICATED_ATTEMPT,
    LEGACY_PENDING_INTENT,
    LEGACY_ACK_INTERRUPTED,
    LEGACY_ABORTED_INTENT,
    NOT_APPLIED,
    INCONSISTENT_REVIEW_REQUIRED,
  } = INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS;

  if (state.nativeReceipt) {
    try {
      assertIncomingAcceptanceApplicationReceipt(state.nativeReceipt, { requireResolvedCommit: true });
      return classification(NATIVE_APPLIED, "NATIVE_REPLAY", true, state.nativeReceipt);
    } catch {
      return classification(INCONSISTENT_REVIEW_REQUIRED, "RECOVERY_REVIEW");
    }
  }

  if (state.membershipPresent !== state.attendancePresent) {
    return classification(INCONSISTENT_REVIEW_REQUIRED, "RECOVERY_REVIEW");
  }

  const evidence = state.evidence;
  const operation = state.operation;
  const evidencePresent = evidence?.present === true;
  const operationPresent = operation?.present === true;
  const finalizedEvidence = evidencePresent && evidence?.finalized === true;

  if (evidencePresent && !finalizedEvidence) {
    return classification(INCONSISTENT_REVIEW_REQUIRED, "RECOVERY_REVIEW");
  }

  if (operationPresent && operation?.status === "aborted") {
    if (evidencePresent) return classification(INCONSISTENT_REVIEW_REQUIRED, "RECOVERY_REVIEW");
    return classification(LEGACY_ABORTED_INTENT, "LEGACY_READ_ONLY");
  }

  if (operationPresent && operation?.status === "pending") {
    if (evidencePresent) return classification(INCONSISTENT_REVIEW_REQUIRED, "RECOVERY_REVIEW");
    return classification(LEGACY_PENDING_INTENT, "RECOVERY_REVIEW");
  }

  if (finalizedEvidence) {
    if (operationPresent && operation?.status !== "finalized") {
      return classification(INCONSISTENT_REVIEW_REQUIRED, "RECOVERY_REVIEW");
    }
    if (evidence?.interruptedFinalization === true) {
      return classification(LEGACY_ACK_INTERRUPTED, "RECOVERY_REVIEW");
    }
    if (state.membershipPresent && state.attendancePresent) {
      if (state.aggregateLifecycleStatus !== "completed" ||
          !state.activationReceiptPresent ||
          !state.activationReceiptConsistent) {
        return classification(INCONSISTENT_REVIEW_REQUIRED, "RECOVERY_REVIEW");
      }
      return classification(LEGACY_APPLIED_UNATTESTED_V1, "LEGACY_READ_ONLY");
    }
    return classification(LEGACY_UNAPPLIED_AUTHENTICATED_ATTEMPT, "RECOVERY_REVIEW");
  }

  if (state.aggregateLifecycleStatus === "completed") {
    if (!state.membershipPresent || !state.attendancePresent ||
        !state.activationReceiptPresent || !state.activationReceiptConsistent) {
      return classification(INCONSISTENT_REVIEW_REQUIRED, "RECOVERY_REVIEW");
    }
    return classification(LEGACY_APPLIED_UNATTESTED_V1, "LEGACY_READ_ONLY");
  }

  if (operationPresent) {
    return classification(INCONSISTENT_REVIEW_REQUIRED, "RECOVERY_REVIEW");
  }
  return classification(NOT_APPLIED, "NONE");
}

// ---------------------------------------------------------------------------
// Guard completion eligibility
// ---------------------------------------------------------------------------

export interface IncomingAcceptanceGuardCompletionInput {
  reservedTechnicianIds: [string, string];
  activationReceiptId: string | null;
  activationReceiptHash: string | null;
  activationActorUid: string | null;
  aggregateLifecycleStatus: string;
  applications: IncomingAcceptanceGuardApplicationState[];
  exceptionalClosure?: IncomingAcceptanceExceptionalClosure | null;
}

export interface IncomingAcceptanceGuardCompletionEligible {
  status: "eligible";
  automatic: true;
  terminalEvidenceRef: string;
  technicianUids: [string, string];
  outcomes: [IncomingAcceptanceOutcome, IncomingAcceptanceOutcome];
  fabricatedReceipt: false;
}

export interface IncomingAcceptanceGuardCompletionNotEligible {
  status: "not_eligible";
  automatic: false;
  reason:
    | "HANDOVER_NOT_COMPLETED"
    | "ACTIVATION_RECEIPT_MISSING"
    | "PERSONAL_RECEIPT_MISSING"
    | "APPLICATION_RECEIPT_INCONSISTENT";
  missingTechnicianUids: string[];
  fabricatedReceipt: false;
}

export interface IncomingAcceptanceGuardExceptionalClosure {
  status: "exceptional_closure_authorized";
  automatic: false;
  requiresOperatorWorkflow: true;
  closureId: string;
  subjectUid: string;
  terminalEvidenceRef: string;
  fabricatedReceipt: false;
}

export interface IncomingAcceptanceGuardExceptionalClosureInvalid {
  status: "exceptional_closure_invalid";
  automatic: false;
  reason: "CLOSURE_SUBJECT_NOT_MISSING" | "CLOSURE_INVALID" | "BOTH_PERSONAL_RECEIPTS_PRESENT";
  fabricatedReceipt: false;
}

export type IncomingAcceptanceGuardCompletionResult =
  | IncomingAcceptanceGuardCompletionEligible
  | IncomingAcceptanceGuardCompletionNotEligible
  | IncomingAcceptanceGuardExceptionalClosure
  | IncomingAcceptanceGuardExceptionalClosureInvalid;

function notEligible(
  reason: IncomingAcceptanceGuardCompletionNotEligible["reason"],
  missing: string[],
): IncomingAcceptanceGuardCompletionNotEligible {
  return { status: "not_eligible", automatic: false, reason, missingTechnicianUids: missing, fabricatedReceipt: false };
}

export function evaluateIncomingAcceptanceGuardCompletion(
  input: IncomingAcceptanceGuardCompletionInput,
): IncomingAcceptanceGuardCompletionResult {
  const [first, second] = input.reservedTechnicianIds;
  identifier(first, "reserved technician UID", 128, INCOMING_ACCEPTANCE_ERROR_CODES.GUARD_COMPLETION_NOT_ELIGIBLE);
  identifier(second, "reserved technician UID", 128, INCOMING_ACCEPTANCE_ERROR_CODES.GUARD_COMPLETION_NOT_ELIGIBLE);
  if (first === second) {
    fail(INCOMING_ACCEPTANCE_ERROR_CODES.GUARD_COMPLETION_NOT_ELIGIBLE, "Guard completion requires two distinct reserved technicians.");
  }
  if (input.aggregateLifecycleStatus !== "completed") {
    return notEligible("HANDOVER_NOT_COMPLETED", [first, second]);
  }
  if (!input.activationReceiptId || !input.activationReceiptHash || !input.activationActorUid) {
    return notEligible("ACTIVATION_RECEIPT_MISSING", [first, second]);
  }

  const missing: string[] = [];
  const outcomes: IncomingAcceptanceOutcome[] = [];
  for (const uid of [first, second]) {
    const application = input.applications.find((item) => item.technicianUid === uid);
    if (!application || !application.receipt) {
      missing.push(uid);
      continue;
    }
    try {
      assertIncomingAcceptanceApplicationReceipt(application.receipt, { requireResolvedCommit: true });
    } catch {
      return notEligible("APPLICATION_RECEIPT_INCONSISTENT", []);
    }
    if (
      application.receipt.technicianUid !== uid ||
      application.receipt.activationReceiptId !== input.activationReceiptId ||
      application.receipt.activationReceiptHash !== input.activationReceiptHash ||
      !application.evidencePresent ||
      !application.operationFinalized ||
      !application.membershipPresent ||
      !application.attendancePresent
    ) {
      return notEligible("APPLICATION_RECEIPT_INCONSISTENT", []);
    }
    outcomes.push(application.receipt.outcome);
  }

  if (missing.length === 0) {
    const firstActivationIndex = outcomes.indexOf(INCOMING_ACCEPTANCE_OUTCOMES.FIRST_ACTIVATION);
    const joinIndex = outcomes.indexOf(INCOMING_ACCEPTANCE_OUTCOMES.SUBSEQUENT_JOIN);
    if (
      firstActivationIndex === -1 ||
      joinIndex === -1 ||
      firstActivationIndex === joinIndex ||
      [first, second][firstActivationIndex] !== input.activationActorUid
    ) {
      return notEligible("APPLICATION_RECEIPT_INCONSISTENT", []);
    }
    const firstUid = [first, second][firstActivationIndex];
    const joinUid = [first, second][joinIndex];
    return {
      status: "eligible",
      automatic: true,
      terminalEvidenceRef: input.activationReceiptId,
      technicianUids: [firstUid, joinUid],
      outcomes: [INCOMING_ACCEPTANCE_OUTCOMES.FIRST_ACTIVATION, INCOMING_ACCEPTANCE_OUTCOMES.SUBSEQUENT_JOIN],
      fabricatedReceipt: false,
    };
  }

  if (input.exceptionalClosure) {
    const closure = input.exceptionalClosure;
    if (missing.length !== 1 || !missing.includes(closure.subjectUid)) {
      return {
        status: "exceptional_closure_invalid",
        automatic: false,
        reason: "CLOSURE_SUBJECT_NOT_MISSING",
        fabricatedReceipt: false,
      };
    }
    try {
      identifier(closure.closureId, "exceptional closure ID", 512, INCOMING_ACCEPTANCE_ERROR_CODES.GUARD_COMPLETION_NOT_ELIGIBLE);
      identifier(closure.authorizedBy, "exceptional closure authorizer", 128, INCOMING_ACCEPTANCE_ERROR_CODES.GUARD_COMPLETION_NOT_ELIGIBLE);
      identifier(closure.subjectUid, "exceptional closure subject", 128, INCOMING_ACCEPTANCE_ERROR_CODES.GUARD_COMPLETION_NOT_ELIGIBLE);
      canonicalTimestamp(
        closure.recordedAt,
        "exceptional closure time",
        INCOMING_ACCEPTANCE_ERROR_CODES.GUARD_COMPLETION_NOT_ELIGIBLE,
      );
      const reason = normalizeIncomingAcceptanceLateReason({ reason: closure.reason, required: true });
      if (!reason) throw new Error("missing closure reason");
    } catch {
      return {
        status: "exceptional_closure_invalid",
        automatic: false,
        reason: "CLOSURE_INVALID",
        fabricatedReceipt: false,
      };
    }
    return {
      status: "exceptional_closure_authorized",
      automatic: false,
      requiresOperatorWorkflow: true,
      closureId: closure.closureId,
      subjectUid: closure.subjectUid,
      terminalEvidenceRef: closure.closureId,
      fabricatedReceipt: false,
    };
  }

  return notEligible("PERSONAL_RECEIPT_MISSING", missing);
}
