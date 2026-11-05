// Phase 8C.2b — pure dual-approval domain.
//
// No I/O, no clock, no persistence. This module defines the identity of an
// approval intent, the two personal signatures that can attach to it, the
// 60-second password-proof window and the 24-hour intent lifetime. Every value
// here is derived from authoritative state that the Firestore service read
// inside its transaction.

import { createHash } from "node:crypto";

import {
  HANDOVER_RECOVERY_APPROVAL_ACTION,
  HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES,
  HANDOVER_RECOVERY_APPROVAL_EVENTS,
  HANDOVER_RECOVERY_APPROVAL_ROLES,
  HANDOVER_RECOVERY_APPROVAL_SCHEMA,
  HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION,
  HANDOVER_RECOVERY_APPROVAL_STATUSES,
  HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
  type HandoverRecoveryApprovalBinding,
  type HandoverRecoveryApprovalEffectiveStatus,
  type HandoverRecoveryApprovalEvent,
  type HandoverRecoveryApprovalRecord,
  type HandoverRecoveryApprovalRole,
  type HandoverRecoveryApprovalSignature,
  type HandoverRecoveryApprovalView,
} from "@/types/handover-recovery-approval";
import { HANDOVER_REVIEW_CASE_STATUSES } from "@/types/handover-admin-review";
import { EQUAL_HANDOVER_LIFECYCLE_STATUSES } from "@/types/equal-technician-handover";

export const HANDOVER_RECOVERY_APPROVAL_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const HANDOVER_RECOVERY_APPROVAL_PROOF_MAX_AGE_MS = 60_000;
export const HANDOVER_RECOVERY_APPROVAL_REASON_MIN_LENGTH = 10;
export const HANDOVER_RECOVERY_APPROVAL_REASON_MAX_LENGTH = 2000;
export const HANDOVER_RECOVERY_APPROVAL_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
export const HANDOVER_RECOVERY_APPROVAL_PROOF_SCHEMA = "handover-recovery-approval-proof-v1" as const;
export const HANDOVER_RECOVERY_APPROVAL_ID_PREFIX = "handover_recovery_approval_v1_" as const;

export class HandoverRecoveryApprovalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoverRecoveryApprovalInputError";
  }
}

export type HandoverRecoveryApprovalErrorCode =
  | "RECOVERY_APPROVAL_NOT_FOUND"
  | "RECOVERY_APPROVAL_HANDOVER_NOT_FOUND"
  | "RECOVERY_APPROVAL_HANDOVER_UNREADABLE"
  | "RECOVERY_APPROVAL_ROLE_FORBIDDEN"
  | "RECOVERY_APPROVAL_DUPLICATE_ACTOR"
  | "RECOVERY_APPROVAL_ROLE_CONFLICT"
  | "RECOVERY_APPROVAL_STALE"
  | "RECOVERY_APPROVAL_EXPIRED"
  | "RECOVERY_APPROVAL_ALREADY_COMPLETE"
  | "RECOVERY_APPROVAL_ALREADY_VOIDED"
  | "RECOVERY_APPROVAL_NOT_VOIDED"
  | "RECOVERY_APPROVAL_ALREADY_REISSUED"
  | "RECOVERY_APPROVAL_IDEMPOTENCY_CONFLICT"
  | "RECOVERY_APPROVAL_REQUEST_CONFLICT"
  | "RECOVERY_APPROVAL_STATE_INCONSISTENT"
  | "RECOVERY_APPROVAL_AUTHENTICATION_INVALID"
  | "RECOVERY_APPROVAL_AUTHENTICATION_EXPIRED"
  | "RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED"
  | "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED";

const ERROR_STATUS: Record<HandoverRecoveryApprovalErrorCode, number> = {
  RECOVERY_APPROVAL_NOT_FOUND: 404,
  RECOVERY_APPROVAL_HANDOVER_NOT_FOUND: 404,
  RECOVERY_APPROVAL_HANDOVER_UNREADABLE: 409,
  RECOVERY_APPROVAL_ROLE_FORBIDDEN: 403,
  RECOVERY_APPROVAL_DUPLICATE_ACTOR: 409,
  RECOVERY_APPROVAL_ROLE_CONFLICT: 409,
  RECOVERY_APPROVAL_STALE: 409,
  RECOVERY_APPROVAL_EXPIRED: 409,
  RECOVERY_APPROVAL_ALREADY_COMPLETE: 409,
  RECOVERY_APPROVAL_ALREADY_VOIDED: 409,
  RECOVERY_APPROVAL_NOT_VOIDED: 409,
  RECOVERY_APPROVAL_ALREADY_REISSUED: 409,
  RECOVERY_APPROVAL_IDEMPOTENCY_CONFLICT: 409,
  RECOVERY_APPROVAL_REQUEST_CONFLICT: 409,
  RECOVERY_APPROVAL_STATE_INCONSISTENT: 409,
  RECOVERY_APPROVAL_AUTHENTICATION_INVALID: 401,
  RECOVERY_APPROVAL_AUTHENTICATION_EXPIRED: 401,
  RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED: 403,
  RECOVERY_APPROVAL_OUTCOME_UNVERIFIED: 503,
};

export class HandoverRecoveryApprovalError extends Error {
  public readonly code: HandoverRecoveryApprovalErrorCode;
  public readonly status: number;

  constructor(code: HandoverRecoveryApprovalErrorCode, message: string) {
    super(message);
    this.name = "HandoverRecoveryApprovalError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export function approvalFail(
  code: HandoverRecoveryApprovalErrorCode,
  message: string,
): never {
  throw new HandoverRecoveryApprovalError(code, message);
}

function inputFail(message: string): never {
  throw new HandoverRecoveryApprovalInputError(message);
}

// ---------------------------------------------------------------------------
// Canonical material and reference identities
// ---------------------------------------------------------------------------

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) result[key] = stableValue(item);
    }
    return result;
  }
  return value;
}

export function canonicalApprovalMaterial(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function approvalDigest(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(canonicalApprovalMaterial({ namespace, value }))
    .digest("hex");
}

function referenceDigest(namespace: string, value: unknown): string {
  return approvalDigest(namespace, value).slice(0, 40);
}

export function createHandoverRecoveryIntentFingerprint(
  binding: HandoverRecoveryApprovalBinding,
): string {
  return approvalDigest("handover-recovery-approval-intent-v1", {
    schemaVersion: HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION,
    action: HANDOVER_RECOVERY_APPROVAL_ACTION,
    binding,
  });
}

// Deterministic: two parallel requests for the same movement of the same
// handover collapse onto one document, so the second role must countersign
// rather than create a competing intent.
export function createHandoverRecoveryApprovalId(input: {
  handoverDocumentId: string;
  intentFingerprint: string;
}): string {
  identifier(input.handoverDocumentId, "handover document ID");
  hex64(input.intentFingerprint, "intent fingerprint");
  return `${HANDOVER_RECOVERY_APPROVAL_ID_PREFIX}${referenceDigest(
    "handover-recovery-approval-v1",
    {
      handoverDocumentId: input.handoverDocumentId,
      action: HANDOVER_RECOVERY_APPROVAL_ACTION,
      intentFingerprint: input.intentFingerprint,
    },
  )}`;
}

// A reissued intent can never reuse the voided identity (OD-14). Its identity
// is derived from the voided original plus the caller's idempotency key, so a
// retried reissue is a replay and a different key is a distinct request.
export function createHandoverRecoveryReissueApprovalId(input: {
  voidedApprovalId: string;
  idempotencyKey: string;
}): string {
  identifier(input.voidedApprovalId, "voided approval ID");
  idempotencyKey(input.idempotencyKey);
  return `${HANDOVER_RECOVERY_APPROVAL_ID_PREFIX}reissue_${referenceDigest(
    "handover-recovery-approval-reissue-v1",
    {
      voidedApprovalId: input.voidedApprovalId,
      idempotencyKey: input.idempotencyKey,
    },
  )}`;
}

export function createHandoverRecoveryApprovalAuditId(input: {
  approvalId: string;
  event: HandoverRecoveryApprovalEvent;
  discriminator?: string;
}): string {
  identifier(input.approvalId, "approval ID");
  if (!Object.values(HANDOVER_RECOVERY_APPROVAL_EVENTS).includes(input.event)) {
    inputFail("Invalid approval audit event.");
  }
  return `handover_recovery_approval_audit_v1_${referenceDigest(
    "handover-recovery-approval-audit-v1",
    {
      approvalId: input.approvalId,
      event: input.event,
      discriminator: input.discriminator ?? null,
    },
  )}`;
}

export function createHandoverRecoveryApprovalRequestHash(input: {
  requestedBy: string;
  handoverDocumentId: string;
  intentFingerprint: string;
  reason: string;
}): string {
  return approvalDigest("handover-recovery-approval-request-v1", {
    requestedBy: input.requestedBy,
    handoverDocumentId: input.handoverDocumentId,
    action: HANDOVER_RECOVERY_APPROVAL_ACTION,
    intentFingerprint: input.intentFingerprint,
    reason: input.reason,
  });
}

// ---------------------------------------------------------------------------
// Personal password proof
// ---------------------------------------------------------------------------

const proofFields = [
  "schema",
  "actorUid",
  "actorRole",
  "intentFingerprint",
  "requestNonce",
  "verifiedAt",
  "authAccountCheckedAt",
  "proofExpiresAt",
  "verifiedAtMonotonicMs",
  "proofFingerprint",
] as const;

export interface HandoverRecoveryApprovalProof {
  schema: typeof HANDOVER_RECOVERY_APPROVAL_PROOF_SCHEMA;
  actorUid: string;
  actorRole: HandoverRecoveryApprovalRole;
  intentFingerprint: string;
  requestNonce: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  proofExpiresAt: string;
  verifiedAtMonotonicMs: number;
  proofFingerprint: string;
}

function proofFingerprint(input: {
  actorUid: string;
  actorRole: HandoverRecoveryApprovalRole;
  intentFingerprint: string;
  requestNonce: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  verifiedAtMonotonicMs: number;
}): string {
  return approvalDigest("handover-recovery-approval-proof-v1", {
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    intentFingerprint: input.intentFingerprint,
    requestNonce: input.requestNonce,
    verifiedAt: input.verifiedAt,
    authAccountCheckedAt: input.authAccountCheckedAt,
    verifiedAtMonotonicMs: input.verifiedAtMonotonicMs,
  });
}

export function createHandoverRecoveryApprovalProof(input: {
  actorUid: string;
  actorRole: HandoverRecoveryApprovalRole;
  intentFingerprint: string;
  requestNonce: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  verifiedAtMonotonicMs: number;
}): HandoverRecoveryApprovalProof {
  identifier(input.actorUid, "approver UID");
  roleValue(input.actorRole);
  hex64(input.intentFingerprint, "intent fingerprint");
  identifier(input.requestNonce, "request nonce");
  canonicalTimestamp(input.verifiedAt, "password verification time");
  canonicalTimestamp(input.authAccountCheckedAt, "account check time");
  nonNegativeInteger(input.verifiedAtMonotonicMs, "verification monotonic time");

  const verifiedAtMs = Date.parse(input.verifiedAt);
  if (Date.parse(input.authAccountCheckedAt) < verifiedAtMs) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_AUTHENTICATION_INVALID",
      "Authentication times are not in a valid order.",
    );
  }

  return {
    schema: HANDOVER_RECOVERY_APPROVAL_PROOF_SCHEMA,
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    intentFingerprint: input.intentFingerprint,
    requestNonce: input.requestNonce,
    verifiedAt: input.verifiedAt,
    authAccountCheckedAt: input.authAccountCheckedAt,
    proofExpiresAt: new Date(verifiedAtMs + HANDOVER_RECOVERY_APPROVAL_PROOF_MAX_AGE_MS).toISOString(),
    verifiedAtMonotonicMs: input.verifiedAtMonotonicMs,
    proofFingerprint: proofFingerprint(input),
  };
}

export function assertHandoverRecoveryApprovalProof(input: {
  proof: unknown;
  expectedActorUid: string;
  expectedActorRole: HandoverRecoveryApprovalRole;
  expectedIntentFingerprint: string;
  expectedRequestNonce: string;
  nowIso: string;
  nowMonotonicMs: number;
  maximumAgeMs?: number;
}): HandoverRecoveryApprovalProof {
  const code = "RECOVERY_APPROVAL_AUTHENTICATION_INVALID" as const;
  const record = strictObject(input.proof, proofFields, code, "approval proof");
  if (record.schema !== HANDOVER_RECOVERY_APPROVAL_PROOF_SCHEMA) {
    throw new HandoverRecoveryApprovalError(code, "Unsupported approval proof schema.");
  }
  identifierOrCode(record.actorUid, "approver UID", code);
  roleValueOrCode(record.actorRole, code);
  hex64OrCode(record.intentFingerprint, "intent fingerprint", code);
  identifierOrCode(record.requestNonce, "request nonce", code);
  canonicalTimestampOrCode(record.verifiedAt, "password verification time", code);
  canonicalTimestampOrCode(record.authAccountCheckedAt, "account check time", code);
  canonicalTimestampOrCode(record.proofExpiresAt, "proof expiry", code);
  nonNegativeIntegerOrCode(record.verifiedAtMonotonicMs, "verification monotonic time", code);
  hex64OrCode(record.proofFingerprint, "proof fingerprint", code);
  canonicalTimestampOrCode(input.nowIso, "current time", code);
  nonNegativeIntegerOrCode(input.nowMonotonicMs, "current monotonic time", code);

  if (record.actorUid !== input.expectedActorUid) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED",
      "The verified authentication subject does not match the session subject.",
    );
  }
  if (record.actorRole !== input.expectedActorRole) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_ROLE_CONFLICT",
      "The approval proof was issued for a different role.",
    );
  }
  if (record.requestNonce !== input.expectedRequestNonce) {
    throw new HandoverRecoveryApprovalError(
      code,
      "The authentication proof belongs to a different request.",
    );
  }
  if (record.intentFingerprint !== input.expectedIntentFingerprint) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_STALE",
      "The approved intent changed after authentication.",
    );
  }
  if (
    record.proofFingerprint !==
    proofFingerprint({
      actorUid: record.actorUid as string,
      actorRole: record.actorRole as HandoverRecoveryApprovalRole,
      intentFingerprint: record.intentFingerprint as string,
      requestNonce: record.requestNonce as string,
      verifiedAt: record.verifiedAt as string,
      authAccountCheckedAt: record.authAccountCheckedAt as string,
      verifiedAtMonotonicMs: record.verifiedAtMonotonicMs as number,
    })
  ) {
    throw new HandoverRecoveryApprovalError(code, "The approval proof is not self-consistent.");
  }

  const verifiedAtMs = Date.parse(record.verifiedAt as string);
  const checkedAtMs = Date.parse(record.authAccountCheckedAt as string);
  const expiresAtMs = Date.parse(record.proofExpiresAt as string);
  const nowMs = Date.parse(input.nowIso);
  if (verifiedAtMs > checkedAtMs || checkedAtMs > nowMs) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_AUTHENTICATION_INVALID",
      "Authentication times are not in a valid order.",
    );
  }
  if (expiresAtMs !== verifiedAtMs + HANDOVER_RECOVERY_APPROVAL_PROOF_MAX_AGE_MS) {
    throw new HandoverRecoveryApprovalError(code, "The approval proof expiry is not canonical.");
  }

  const maximumAgeMs = input.maximumAgeMs ?? HANDOVER_RECOVERY_APPROVAL_PROOF_MAX_AGE_MS;
  const elapsed = input.nowMonotonicMs - (record.verifiedAtMonotonicMs as number);
  if (elapsed < 0 || nowMs < verifiedAtMs) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_AUTHENTICATION_INVALID",
      "The authentication clocks moved backwards.",
    );
  }
  if (elapsed >= maximumAgeMs || nowMs >= expiresAtMs) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_AUTHENTICATION_EXPIRED",
      "The password verification has expired; authenticate again.",
    );
  }

  return record as unknown as HandoverRecoveryApprovalProof;
}

// ---------------------------------------------------------------------------
// Approval state
// ---------------------------------------------------------------------------

export function complementaryApprovalRole(
  role: HandoverRecoveryApprovalRole,
): HandoverRecoveryApprovalRole {
  return role === HANDOVER_RECOVERY_APPROVAL_ROLES.SUPERVISOR
    ? HANDOVER_RECOVERY_APPROVAL_ROLES.ADMIN
    : HANDOVER_RECOVERY_APPROVAL_ROLES.SUPERVISOR;
}

export function requiredSecondApprovalRole(
  approvals: readonly HandoverRecoveryApprovalSignature[],
): HandoverRecoveryApprovalRole | null {
  if (approvals.length !== 1) return null;
  return complementaryApprovalRole(approvals[0].actorRole);
}

export function evaluateHandoverRecoveryApprovalEffectiveStatus(
  record: HandoverRecoveryApprovalRecord,
  nowIso: string,
): HandoverRecoveryApprovalEffectiveStatus {
  canonicalTimestamp(nowIso, "current time");
  if (record.status === HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED) {
    return HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES.VOIDED;
  }
  if (Date.parse(nowIso) >= Date.parse(record.expiresAt)) {
    return HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES.EXPIRED;
  }
  return record.status;
}

export function createHandoverRecoveryApprovalView(
  record: HandoverRecoveryApprovalRecord,
  nowIso: string,
): HandoverRecoveryApprovalView {
  return {
    approval: record,
    effectiveStatus: evaluateHandoverRecoveryApprovalEffectiveStatus(record, nowIso),
    approvalCount: record.approvals.length,
    requiredSecondRole:
      record.status === HANDOVER_RECOVERY_APPROVAL_STATUSES.AWAITING_SECOND_APPROVAL
        ? requiredSecondApprovalRole(record.approvals)
        : null,
    recoveryExecutionEligible: false,
  };
}

export function assertApprovalIntentNotExpired(
  record: HandoverRecoveryApprovalRecord,
  nowIso: string,
): void {
  canonicalTimestamp(nowIso, "current time");
  if (Date.parse(nowIso) >= Date.parse(record.expiresAt)) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_EXPIRED",
      "This approval intent has expired; request a new intent.",
    );
  }
}

// A stored signature can only ever be appended. A second signature is refused
// unless it is the complementary role, a different human and fresh.
export function assertApprovalSignatureAppendable(input: {
  approvals: readonly HandoverRecoveryApprovalSignature[];
  actorUid: string;
  actorRole: HandoverRecoveryApprovalRole;
}): HandoverRecoveryApprovalRole {
  if (input.approvals.length === 0) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_STATE_INCONSISTENT",
      "An approval record has no first signature.",
    );
  }
  if (input.approvals.length !== 1) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_ALREADY_COMPLETE",
      "This approval already carries both signatures.",
    );
  }
  const first = input.approvals[0];
  if (first.actorUid === input.actorUid) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_DUPLICATE_ACTOR",
      "The second approval must be a different person.",
    );
  }
  const required = complementaryApprovalRole(first.actorRole);
  if (input.actorRole !== required) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_ROLE_CONFLICT",
      `The second approval must come from the complementary ${required} role.`,
    );
  }
  return required;
}

export function assertRequiredApprovalPair(
  approvals: readonly HandoverRecoveryApprovalSignature[],
): void {
  if (approvals.length !== 2) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_STATE_INCONSISTENT",
      "A fully approved record must carry exactly two signatures.",
    );
  }
  const [first, second] = approvals;
  if (first.actorUid === second.actorUid) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_STATE_INCONSISTENT",
      "Both signatures belong to the same person.",
    );
  }
  const roles = new Set([first.actorRole, second.actorRole]);
  if (!roles.has("supervisor") || !roles.has("admin")) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_STATE_INCONSISTENT",
      "Approvals must contain exactly one supervisor and one administrator.",
    );
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

export interface HandoverRecoveryApprovalCredential {
  password: string;
}

export interface HandoverRecoveryApprovalRequestIntent {
  handoverDocumentId: string;
  reason: string;
  idempotencyKey: string;
}

export interface HandoverRecoveryApprovalCountersignIntent {
  expectedRevision: number;
}

export interface HandoverRecoveryApprovalVoidIntent {
  reason: string;
  idempotencyKey: string;
}

export interface HandoverRecoveryApprovalReissueIntent {
  reason: string;
  idempotencyKey: string;
}

export function parseHandoverRecoveryApprovalRequestBody(input: unknown): {
  intent: HandoverRecoveryApprovalRequestIntent;
  credential: HandoverRecoveryApprovalCredential;
} {
  const body = strictObject(
    input,
    ["handoverDocumentId", "reason", "idempotencyKey", "password"],
    "validation",
    "approval request",
  );
  return {
    intent: {
      handoverDocumentId: handoverDocumentId(body.handoverDocumentId),
      reason: approvalReason(body.reason),
      idempotencyKey: idempotencyKey(body.idempotencyKey),
    },
    credential: { password: password(body.password) },
  };
}

export function parseHandoverRecoveryApprovalCountersignBody(input: unknown): {
  intent: HandoverRecoveryApprovalCountersignIntent;
  credential: HandoverRecoveryApprovalCredential;
} {
  const body = strictObject(
    input,
    ["expectedRevision", "password"],
    "validation",
    "complementary approval",
  );
  return {
    intent: {
      expectedRevision: positiveInteger(body.expectedRevision, "expected revision"),
    },
    credential: { password: password(body.password) },
  };
}

export function parseHandoverRecoveryApprovalVoidBody(input: unknown): {
  intent: HandoverRecoveryApprovalVoidIntent;
  credential: HandoverRecoveryApprovalCredential;
} {
  const body = strictObject(
    input,
    ["reason", "idempotencyKey", "password"],
    "validation",
    "approval void",
  );
  return {
    intent: {
      reason: approvalReason(body.reason),
      idempotencyKey: idempotencyKey(body.idempotencyKey),
    },
    credential: { password: password(body.password) },
  };
}

export function parseHandoverRecoveryApprovalReissueBody(input: unknown): {
  intent: HandoverRecoveryApprovalReissueIntent;
  credential: HandoverRecoveryApprovalCredential;
} {
  const body = strictObject(
    input,
    ["reason", "idempotencyKey", "password"],
    "validation",
    "approval reissue",
  );
  return {
    intent: {
      reason: approvalReason(body.reason),
      idempotencyKey: idempotencyKey(body.idempotencyKey),
    },
    credential: { password: password(body.password) },
  };
}

// ---------------------------------------------------------------------------
// Stored-record validation
// ---------------------------------------------------------------------------

const bindingFields = [
  "aggregateRevision",
  "aggregateSnapshotHash",
  "aggregateLifecycleStatus",
  "guardId",
  "guardRevision",
  "fencingEpoch",
  "slotToken",
  "slotGeneration",
  "successorSlotToken",
  "successorSlotGeneration",
  "reviewCaseId",
  "reviewCaseStatus",
  "reviewCaseRevision",
  "reviewCaseFingerprint",
] as const;

const signatureFields = [
  "actorUid",
  "actorRole",
  "proofFingerprint",
  "approvedAt",
  "proofExpiresAt",
] as const;

const recordFields = [
  "schema",
  "schemaVersion",
  "id",
  "action",
  "handoverDocumentId",
  "outgoingShiftId",
  "incomingShiftId",
  "binding",
  "intentFingerprint",
  "recoveryExecutionEligible",
  "nonExecutableReason",
  "reason",
  "requestedBy",
  "requestedAt",
  "expiresAt",
  "approvals",
  "requestHash",
  "revision",
  "status",
  "replacesApprovalId",
  "reissuedAsApprovalId",
  "requestAuditId",
  "countersignAuditId",
  "voidAuditId",
  "voidedAt",
  "voidedBy",
  "voidReason",
  "createdAt",
  "updatedAt",
] as const;

export function assertHandoverRecoveryApprovalRecord(
  data: unknown,
  id: string,
): HandoverRecoveryApprovalRecord {
  const code = "RECOVERY_APPROVAL_STATE_INCONSISTENT" as const;
  const value = strictObject(data, recordFields, code, "approval record");
  if (value.schema !== HANDOVER_RECOVERY_APPROVAL_SCHEMA) {
    throw new HandoverRecoveryApprovalError(code, "Unsupported approval schema.");
  }
  if (value.schemaVersion !== HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION) {
    throw new HandoverRecoveryApprovalError(code, "Unsupported approval schema version.");
  }
  if (value.id !== id) {
    throw new HandoverRecoveryApprovalError(code, "The approval record identity does not match.");
  }
  if (value.action !== HANDOVER_RECOVERY_APPROVAL_ACTION) {
    throw new HandoverRecoveryApprovalError(code, "Unsupported approval action.");
  }
  if (value.recoveryExecutionEligible !== false) {
    throw new HandoverRecoveryApprovalError(code, "A version 1 approval cannot be executable.");
  }
  if (value.nonExecutableReason !== HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON) {
    throw new HandoverRecoveryApprovalError(code, "The non-executable reason is not canonical.");
  }

  const binding = strictObject(value.binding, bindingFields, code, "approval binding");
  positiveIntegerOrCode(binding.aggregateRevision, "aggregate revision", code);
  hex64OrCode(binding.aggregateSnapshotHash, "aggregate snapshot hash", code);
  if (
    !Object.values(EQUAL_HANDOVER_LIFECYCLE_STATUSES).includes(
      binding.aggregateLifecycleStatus as never,
    )
  ) {
    throw new HandoverRecoveryApprovalError(code, "Unsupported aggregate lifecycle.");
  }
  if (binding.guardId !== null) identifierOrCode(binding.guardId, "guard ID", code);
  nonNegativeIntegerOrCode(binding.guardRevision, "guard revision", code);
  nonNegativeIntegerOrCode(binding.fencingEpoch, "fencing epoch", code);
  identifierOrCode(binding.slotToken, "slot token", code);
  nonNegativeIntegerOrCode(binding.slotGeneration, "slot generation", code);
  identifierOrCode(binding.successorSlotToken, "successor slot token", code);
  nonNegativeIntegerOrCode(binding.successorSlotGeneration, "successor slot generation", code);
  identifierOrCode(binding.reviewCaseId, "review case ID", code);
  if (
    binding.reviewCaseStatus !== "none" &&
    !Object.values(HANDOVER_REVIEW_CASE_STATUSES).includes(binding.reviewCaseStatus as never)
  ) {
    throw new HandoverRecoveryApprovalError(code, "Unsupported review case status.");
  }
  nonNegativeIntegerOrCode(binding.reviewCaseRevision, "review case revision", code);
  if (binding.reviewCaseFingerprint !== null) {
    hex64OrCode(binding.reviewCaseFingerprint, "review case fingerprint", code);
  }

  hex64OrCode(value.intentFingerprint, "intent fingerprint", code);
  if (value.intentFingerprint !== createHandoverRecoveryIntentFingerprint(
    binding as unknown as HandoverRecoveryApprovalBinding,
  )) {
    throw new HandoverRecoveryApprovalError(
      code,
      "The intent fingerprint does not match its binding.",
    );
  }

  identifierOrCode(value.handoverDocumentId, "handover document ID", code);
  identifierOrCode(value.outgoingShiftId, "outgoing shift ID", code);
  identifierOrCode(value.incomingShiftId, "incoming shift ID", code);
  approvalReasonOrCode(value.reason, code);
  identifierOrCode(value.requestedBy, "requester UID", code);
  canonicalTimestampOrCode(value.requestedAt, "requested time", code);
  canonicalTimestampOrCode(value.expiresAt, "intent expiry", code);
  if (Date.parse(value.expiresAt as string) <= Date.parse(value.requestedAt as string)) {
    throw new HandoverRecoveryApprovalError(code, "The intent expiry is not after the request.");
  }
  hex64OrCode(value.requestHash, "request hash", code);
  positiveIntegerOrCode(value.revision, "approval revision", code);

  const status = value.status;
  if (
    status !== HANDOVER_RECOVERY_APPROVAL_STATUSES.AWAITING_SECOND_APPROVAL &&
    status !== HANDOVER_RECOVERY_APPROVAL_STATUSES.FULLY_APPROVED &&
    status !== HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED
  ) {
    throw new HandoverRecoveryApprovalError(code, "Unsupported approval status.");
  }

  if (!Array.isArray(value.approvals)) {
    throw new HandoverRecoveryApprovalError(code, "Approval signatures are malformed.");
  }
  const approvals = value.approvals.map((item) =>
    readSignature(item, code),
  );
  if (approvals.length < 1 || approvals.length > 2) {
    throw new HandoverRecoveryApprovalError(code, "An approval carries one or two signatures.");
  }
  if (approvals[0].actorUid !== value.requestedBy) {
    throw new HandoverRecoveryApprovalError(
      code,
      "The first signature does not belong to the requester.",
    );
  }
  if (approvals.length === 2) {
    assertRequiredApprovalPair(approvals);
    if (status === HANDOVER_RECOVERY_APPROVAL_STATUSES.AWAITING_SECOND_APPROVAL) {
      throw new HandoverRecoveryApprovalError(code, "A complete approval is still awaiting.");
    }
  } else if (status === HANDOVER_RECOVERY_APPROVAL_STATUSES.FULLY_APPROVED) {
    throw new HandoverRecoveryApprovalError(
      code,
      "A fully approved record must carry two signatures.",
    );
  }

  if (value.replacesApprovalId !== null) {
    identifierOrCode(value.replacesApprovalId, "replaced approval ID", code);
  }
  if (value.reissuedAsApprovalId !== null) {
    identifierOrCode(value.reissuedAsApprovalId, "reissued approval ID", code);
  }
  identifierOrCode(value.requestAuditId, "request audit ID", code);
  if (value.countersignAuditId !== null) {
    identifierOrCode(value.countersignAuditId, "countersign audit ID", code);
  }
  if (value.voidAuditId !== null) {
    identifierOrCode(value.voidAuditId, "void audit ID", code);
  }
  if (value.voidedAt !== null) canonicalTimestampOrCode(value.voidedAt, "void time", code);
  if (value.voidedBy !== null) identifierOrCode(value.voidedBy, "void actor", code);
  if (value.voidReason !== null) approvalReasonOrCode(value.voidReason, code);
  if (
    status === HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED &&
    (value.voidedAt === null || value.voidedBy === null || value.voidReason === null ||
      value.voidAuditId === null)
  ) {
    throw new HandoverRecoveryApprovalError(code, "A voided approval lacks its tombstone.");
  }
  if (
    status !== HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED &&
    (value.voidedAt !== null || value.voidedBy !== null || value.voidReason !== null ||
      value.voidAuditId !== null)
  ) {
    throw new HandoverRecoveryApprovalError(code, "A live approval carries a void tombstone.");
  }
  if (
    (value.revision === 1) !== (approvals.length === 1) &&
    status !== HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED
  ) {
    throw new HandoverRecoveryApprovalError(code, "The approval revision is inconsistent.");
  }

  canonicalTimestampOrCode(value.createdAt, "creation time", code);
  canonicalTimestampOrCode(value.updatedAt, "update time", code);

  return {
    schema: HANDOVER_RECOVERY_APPROVAL_SCHEMA,
    schemaVersion: HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION,
    id,
    action: HANDOVER_RECOVERY_APPROVAL_ACTION,
    handoverDocumentId: value.handoverDocumentId as string,
    outgoingShiftId: value.outgoingShiftId as string,
    incomingShiftId: value.incomingShiftId as string,
    binding: binding as unknown as HandoverRecoveryApprovalBinding,
    intentFingerprint: value.intentFingerprint as string,
    recoveryExecutionEligible: false,
    nonExecutableReason: HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
    reason: value.reason as string,
    requestedBy: value.requestedBy as string,
    requestedAt: value.requestedAt as string,
    expiresAt: value.expiresAt as string,
    approvals,
    requestHash: value.requestHash as string,
    revision: value.revision as number,
    status,
    replacesApprovalId: value.replacesApprovalId as string | null,
    reissuedAsApprovalId: value.reissuedAsApprovalId as string | null,
    requestAuditId: value.requestAuditId as string,
    countersignAuditId: value.countersignAuditId as string | null,
    voidAuditId: value.voidAuditId as string | null,
    voidedAt: value.voidedAt as string | null,
    voidedBy: value.voidedBy as string | null,
    voidReason: value.voidReason as string | null,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
  };
}

function readSignature(
  data: unknown,
  code: HandoverRecoveryApprovalErrorCode,
): HandoverRecoveryApprovalSignature {
  const value = strictObject(data, signatureFields, code, "approval signature");
  identifierOrCode(value.actorUid, "approver UID", code);
  roleValueOrCode(value.actorRole, code);
  hex64OrCode(value.proofFingerprint, "proof fingerprint", code);
  canonicalTimestampOrCode(value.approvedAt, "approval time", code);
  canonicalTimestampOrCode(value.proofExpiresAt, "proof expiry", code);
  if (
    Date.parse(value.proofExpiresAt as string) !==
    Date.parse(value.approvedAt as string) + HANDOVER_RECOVERY_APPROVAL_PROOF_MAX_AGE_MS
  ) {
    throw new HandoverRecoveryApprovalError(code, "The signature proof expiry is not canonical.");
  }
  return value as unknown as HandoverRecoveryApprovalSignature;
}

// ---------------------------------------------------------------------------
// Primitive validation
// ---------------------------------------------------------------------------

function strictObject(
  value: unknown,
  fields: readonly string[],
  code: HandoverRecoveryApprovalErrorCode | "validation",
  label: string,
): Record<string, unknown> {
  const fail = (message: string): never => {
    if (code === "validation") inputFail(message);
    throw new HandoverRecoveryApprovalError(code, message);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`Invalid ${label}.`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(record, key))
  ) {
    fail(`Missing or unsupported ${label} fields.`);
  }
  return record;
}

function identifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 512 ||
    value.includes("/") ||
    value === "." ||
    value === ".."
  ) {
    inputFail(`Invalid ${label}.`);
  }
}

function identifierOrCode(
  value: unknown,
  label: string,
  code: HandoverRecoveryApprovalErrorCode,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 512 ||
    value.includes("/") ||
    value === "." ||
    value === ".."
  ) {
    throw new HandoverRecoveryApprovalError(code, `Invalid ${label}.`);
  }
}

export function validHandoverDocumentId(value: unknown): value is string {
  return typeof value === "string" && /^handover_v2_[A-Za-z0-9_-]{1,128}$/.test(value);
}

function handoverDocumentId(value: unknown): string {
  if (!validHandoverDocumentId(value)) {
    inputFail("Invalid handover document.");
  }
  return value;
}

export function validHandoverRecoveryApprovalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(HANDOVER_RECOVERY_APPROVAL_ID_PREFIX) &&
    value.length <= 160 &&
    !value.includes("/")
  );
}

function hex64(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    inputFail(`Invalid ${label}.`);
  }
}

function hex64OrCode(
  value: unknown,
  label: string,
  code: HandoverRecoveryApprovalErrorCode,
): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new HandoverRecoveryApprovalError(code, `Invalid ${label}.`);
  }
}

function canonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    inputFail(`Invalid ${label}.`);
  }
}

function canonicalTimestampOrCode(
  value: unknown,
  label: string,
  code: HandoverRecoveryApprovalErrorCode,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new HandoverRecoveryApprovalError(code, `Invalid ${label}.`);
  }
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    inputFail(`Invalid ${label}.`);
  }
}

function nonNegativeIntegerOrCode(
  value: unknown,
  label: string,
  code: HandoverRecoveryApprovalErrorCode,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HandoverRecoveryApprovalError(code, `Invalid ${label}.`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    inputFail(`Invalid ${label}.`);
  }
  return value as number;
}

function positiveIntegerOrCode(
  value: unknown,
  label: string,
  code: HandoverRecoveryApprovalErrorCode,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new HandoverRecoveryApprovalError(code, `Invalid ${label}.`);
  }
}

function roleValue(value: unknown): asserts value is HandoverRecoveryApprovalRole {
  if (
    value !== HANDOVER_RECOVERY_APPROVAL_ROLES.SUPERVISOR &&
    value !== HANDOVER_RECOVERY_APPROVAL_ROLES.ADMIN
  ) {
    inputFail("Invalid approval role.");
  }
}

function roleValueOrCode(
  value: unknown,
  code: HandoverRecoveryApprovalErrorCode,
): asserts value is HandoverRecoveryApprovalRole {
  if (
    value !== HANDOVER_RECOVERY_APPROVAL_ROLES.SUPERVISOR &&
    value !== HANDOVER_RECOVERY_APPROVAL_ROLES.ADMIN
  ) {
    throw new HandoverRecoveryApprovalError(code, "Invalid approval role.");
  }
}

export function approvalReason(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) {
    inputFail("The approval reason must be normalized.");
  }
  if (
    value.length < HANDOVER_RECOVERY_APPROVAL_REASON_MIN_LENGTH ||
    value.length > HANDOVER_RECOVERY_APPROVAL_REASON_MAX_LENGTH
  ) {
    inputFail(
      `The approval reason must be between ${HANDOVER_RECOVERY_APPROVAL_REASON_MIN_LENGTH} and ${HANDOVER_RECOVERY_APPROVAL_REASON_MAX_LENGTH} characters.`,
    );
  }
  return value;
}

function approvalReasonOrCode(
  value: unknown,
  code: HandoverRecoveryApprovalErrorCode,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < HANDOVER_RECOVERY_APPROVAL_REASON_MIN_LENGTH ||
    value.length > HANDOVER_RECOVERY_APPROVAL_REASON_MAX_LENGTH
  ) {
    throw new HandoverRecoveryApprovalError(code, "Invalid approval reason.");
  }
}

export function idempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !HANDOVER_RECOVERY_APPROVAL_IDEMPOTENCY_PATTERN.test(value)
  ) {
    inputFail("Provide a valid approval idempotency key.");
  }
  return value;
}

function password(value: unknown): string {
  if (typeof value !== "string" || !value) {
    inputFail("Provide the current password for personal reauthentication.");
  }
  if (value.length > 4096) {
    inputFail("Invalid password verification input.");
  }
  return value;
}
