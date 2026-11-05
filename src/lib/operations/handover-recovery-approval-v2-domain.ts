// Phase 8C.4B — pure Version 2 dual-approval domain.
//
// No I/O, no clock, no persistence. This module owns the identity of a Version 2
// recovery intent: the canonical binding both signatures must agree on, the
// personal password proof that attaches a signature to it, and the state machine
// that decides whether a stored record is still signable.
//
// The Version 2 intent is bound to the authoritative evidence digest and the
// exact eligibility classification produced by the corrected Phase 8C.3
// classifier, so an approval can never outlive the evidence it was granted on.
// The Version 1 constants for the 60-second proof window, the 24-hour intent
// lifetime and the reason/idempotency grammar are imported rather than copied,
// so both versions move together.
//
// Nothing here can execute a recovery. `recoveryExecutionEligible` is a literal
// false on every record, in every status, and Version 1 documents are never
// read, migrated or rewritten by any code in this file.

import { EQUAL_HANDOVER_LIFECYCLE_STATUSES } from "@/types/equal-technician-handover";
import { HANDOVER_REVIEW_CASE_STATUSES } from "@/types/handover-admin-review";
import {
  HANDOVER_RECOVERY_APPROVAL_V2_ACTION,
  HANDOVER_RECOVERY_APPROVAL_V2_AUDIT_ID_PREFIX,
  HANDOVER_RECOVERY_APPROVAL_V2_EFFECTIVE_STATUSES,
  HANDOVER_RECOVERY_APPROVAL_V2_EVENTS,
  HANDOVER_RECOVERY_APPROVAL_V2_ID_PREFIX,
  HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON,
  HANDOVER_RECOVERY_APPROVAL_V2_PROOF_SCHEMA,
  HANDOVER_RECOVERY_APPROVAL_V2_ROLES,
  HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA,
  HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION,
  HANDOVER_RECOVERY_APPROVAL_V2_STATUSES,
  type HandoverRecoveryApprovalV2Binding,
  type HandoverRecoveryApprovalV2EffectiveStatus,
  type HandoverRecoveryApprovalV2Event,
  type HandoverRecoveryApprovalV2EvidenceBinding,
  type HandoverRecoveryApprovalV2Record,
  type HandoverRecoveryApprovalV2Role,
  type HandoverRecoveryApprovalV2Signature,
  type HandoverRecoveryApprovalV2View,
} from "@/types/handover-recovery-approval-v2";
import {
  HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS,
  HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA,
  HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION,
  HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA,
  HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA_VERSION,
  type HandoverRecoveryEligibilityReadModel,
  type HandoverRecoveryEligibilityResult,
} from "@/types/handover-recovery-eligibility";
import {
  HANDOVER_RECOVERY_APPROVAL_IDEMPOTENCY_PATTERN,
  HANDOVER_RECOVERY_APPROVAL_INTENT_MAX_AGE_MS,
  HANDOVER_RECOVERY_APPROVAL_PROOF_MAX_AGE_MS,
  HANDOVER_RECOVERY_APPROVAL_REASON_MAX_LENGTH,
  HANDOVER_RECOVERY_APPROVAL_REASON_MIN_LENGTH,
  approvalDigest,
  validHandoverDocumentId,
} from "./handover-recovery-approval-domain";

export const HANDOVER_RECOVERY_APPROVAL_V2_INTENT_MAX_AGE_MS =
  HANDOVER_RECOVERY_APPROVAL_INTENT_MAX_AGE_MS;
export const HANDOVER_RECOVERY_APPROVAL_V2_PROOF_MAX_AGE_MS =
  HANDOVER_RECOVERY_APPROVAL_PROOF_MAX_AGE_MS;

export class HandoverRecoveryApprovalV2InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoverRecoveryApprovalV2InputError";
  }
}

export type HandoverRecoveryApprovalV2ErrorCode =
  | "RECOVERY_APPROVAL_V2_NOT_FOUND"
  | "RECOVERY_APPROVAL_V2_HANDOVER_NOT_FOUND"
  | "RECOVERY_APPROVAL_V2_HANDOVER_UNREADABLE"
  | "RECOVERY_APPROVAL_V2_NOT_ELIGIBLE"
  | "RECOVERY_APPROVAL_V2_ELIGIBILITY_UNAVAILABLE"
  | "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN"
  | "RECOVERY_APPROVAL_V2_DUPLICATE_ACTOR"
  | "RECOVERY_APPROVAL_V2_ROLE_CONFLICT"
  | "RECOVERY_APPROVAL_V2_STALE"
  | "RECOVERY_APPROVAL_V2_EXPIRED"
  | "RECOVERY_APPROVAL_V2_ALREADY_COMPLETE"
  | "RECOVERY_APPROVAL_V2_ALREADY_VOIDED"
  | "RECOVERY_APPROVAL_V2_NOT_VOIDED"
  | "RECOVERY_APPROVAL_V2_ALREADY_REISSUED"
  | "RECOVERY_APPROVAL_V2_IDEMPOTENCY_CONFLICT"
  | "RECOVERY_APPROVAL_V2_REQUEST_CONFLICT"
  | "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT"
  | "RECOVERY_APPROVAL_V2_AUTHENTICATION_INVALID"
  | "RECOVERY_APPROVAL_V2_AUTHENTICATION_EXPIRED"
  | "RECOVERY_APPROVAL_V2_AUTH_IDENTITY_CHANGED"
  | "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED";

const ERROR_STATUS: Record<HandoverRecoveryApprovalV2ErrorCode, number> = {
  RECOVERY_APPROVAL_V2_NOT_FOUND: 404,
  RECOVERY_APPROVAL_V2_HANDOVER_NOT_FOUND: 404,
  RECOVERY_APPROVAL_V2_HANDOVER_UNREADABLE: 409,
  RECOVERY_APPROVAL_V2_NOT_ELIGIBLE: 409,
  RECOVERY_APPROVAL_V2_ELIGIBILITY_UNAVAILABLE: 503,
  RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN: 403,
  RECOVERY_APPROVAL_V2_DUPLICATE_ACTOR: 409,
  RECOVERY_APPROVAL_V2_ROLE_CONFLICT: 409,
  RECOVERY_APPROVAL_V2_STALE: 409,
  RECOVERY_APPROVAL_V2_EXPIRED: 409,
  RECOVERY_APPROVAL_V2_ALREADY_COMPLETE: 409,
  RECOVERY_APPROVAL_V2_ALREADY_VOIDED: 409,
  RECOVERY_APPROVAL_V2_NOT_VOIDED: 409,
  RECOVERY_APPROVAL_V2_ALREADY_REISSUED: 409,
  RECOVERY_APPROVAL_V2_IDEMPOTENCY_CONFLICT: 409,
  RECOVERY_APPROVAL_V2_REQUEST_CONFLICT: 409,
  RECOVERY_APPROVAL_V2_STATE_INCONSISTENT: 409,
  RECOVERY_APPROVAL_V2_AUTHENTICATION_INVALID: 401,
  RECOVERY_APPROVAL_V2_AUTHENTICATION_EXPIRED: 401,
  RECOVERY_APPROVAL_V2_AUTH_IDENTITY_CHANGED: 403,
  RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED: 503,
};

export class HandoverRecoveryApprovalV2Error extends Error {
  public readonly code: HandoverRecoveryApprovalV2ErrorCode;
  public readonly status: number;

  constructor(code: HandoverRecoveryApprovalV2ErrorCode, message: string) {
    super(message);
    this.name = "HandoverRecoveryApprovalV2Error";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export function approvalV2Fail(
  code: HandoverRecoveryApprovalV2ErrorCode,
  message: string,
): never {
  throw new HandoverRecoveryApprovalV2Error(code, message);
}

function inputFail(message: string): never {
  throw new HandoverRecoveryApprovalV2InputError(message);
}

// ---------------------------------------------------------------------------
// Canonical material and reference identities
// ---------------------------------------------------------------------------

function referenceDigestV2(namespace: string, value: unknown): string {
  return approvalDigest(namespace, value).slice(0, 40);
}

// The canonical intent. Two Version 2 signatures agree exactly when this digest
// agrees, so every field the approvers relied on has to be inside it — and
// nothing that legitimately changes between the signatures may be.
export function createHandoverRecoveryApprovalV2IntentFingerprint(
  binding: HandoverRecoveryApprovalV2Binding,
): string {
  return approvalDigest("handover-recovery-approval-intent-v2", {
    schema: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA,
    schemaVersion: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION,
    action: HANDOVER_RECOVERY_APPROVAL_V2_ACTION,
    binding,
  });
}

// Deterministic: concurrent requests for the same intent of the same handover
// collapse onto one document, so the complementary role must countersign
// instead of creating a competing approval.
export function createHandoverRecoveryApprovalV2Id(input: {
  handoverDocumentId: string;
  intentFingerprint: string;
}): string {
  identifier(input.handoverDocumentId, "handover document ID");
  hex64(input.intentFingerprint, "intent fingerprint");
  return `${HANDOVER_RECOVERY_APPROVAL_V2_ID_PREFIX}${referenceDigestV2(
    "handover-recovery-approval-v2",
    {
      handoverDocumentId: input.handoverDocumentId,
      action: HANDOVER_RECOVERY_APPROVAL_V2_ACTION,
      intentFingerprint: input.intentFingerprint,
    },
  )}`;
}

// A voided intent is terminal, so a reissue can never reuse its identity. The
// successor is named by the voided original plus the caller's idempotency key:
// a retried reissue replays, a different key is a different request.
export function createHandoverRecoveryApprovalV2ReissueId(input: {
  voidedApprovalId: string;
  idempotencyKey: string;
}): string {
  identifier(input.voidedApprovalId, "voided approval ID");
  idempotencyKey(input.idempotencyKey);
  return `${HANDOVER_RECOVERY_APPROVAL_V2_ID_PREFIX}reissue_${referenceDigestV2(
    "handover-recovery-approval-v2-reissue",
    {
      voidedApprovalId: input.voidedApprovalId,
      idempotencyKey: input.idempotencyKey,
    },
  )}`;
}

export function createHandoverRecoveryApprovalV2AuditId(input: {
  approvalId: string;
  event: HandoverRecoveryApprovalV2Event;
  discriminator?: string;
}): string {
  identifier(input.approvalId, "approval ID");
  if (!Object.values(HANDOVER_RECOVERY_APPROVAL_V2_EVENTS).includes(input.event)) {
    inputFail("Invalid approval audit event.");
  }
  return `${HANDOVER_RECOVERY_APPROVAL_V2_AUDIT_ID_PREFIX}${referenceDigestV2(
    "handover-recovery-approval-v2-audit",
    {
      approvalId: input.approvalId,
      event: input.event,
      discriminator: input.discriminator ?? null,
    },
  )}`;
}

export function createHandoverRecoveryApprovalV2RequestHash(input: {
  requestedBy: string;
  handoverDocumentId: string;
  intentFingerprint: string;
  reason: string;
}): string {
  return approvalDigest("handover-recovery-approval-v2-request", {
    requestedBy: input.requestedBy,
    handoverDocumentId: input.handoverDocumentId,
    action: HANDOVER_RECOVERY_APPROVAL_V2_ACTION,
    intentFingerprint: input.intentFingerprint,
    reason: input.reason,
  });
}

// ---------------------------------------------------------------------------
// The binding derived from the authoritative eligibility evaluation
// ---------------------------------------------------------------------------

// Maps one point-in-time eligibility evaluation onto the canonical intent. Every
// value is server-derived; a caller supplies none of it. Anything the binding
// needs that the evaluation cannot state authoritatively refuses instead of
// substituting a guess, and an eligible classification is required before an
// intent can exist at all.
export function createHandoverRecoveryApprovalV2Binding(input: {
  result: HandoverRecoveryEligibilityResult;
  readModel: HandoverRecoveryEligibilityReadModel;
}): HandoverRecoveryApprovalV2Binding {
  const result = input.result;
  const readModel = input.readModel;
  const code = "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT" as const;

  if (
    result.schema !== HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA ||
    result.schemaVersion !== HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA_VERSION
  ) {
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_ELIGIBILITY_UNAVAILABLE",
      "The eligibility result was produced by an unsupported contract version.",
    );
  }
  const digest = result.evidenceDigest;
  if (
    digest.schema !== HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA ||
    digest.schemaVersion !== HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION ||
    digest.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/.test(digest.value)
  ) {
    // A Version 1-semantic digest — one produced before the orphan-evidence
    // correction — can never be bound, because it is not reproducible here.
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_ELIGIBILITY_UNAVAILABLE",
      "The evidence digest is not produced by the current classifier build.",
    );
  }
  if (
    result.handoverDocumentId !== readModel.handoverDocumentId ||
    result.outgoingShiftId !== readModel.outgoingShiftId ||
    result.incomingShiftId !== readModel.incomingShiftId
  ) {
    approvalV2Fail(
      code,
      "The eligibility result does not describe the evidence it read.",
    );
  }
  if (result.classification !== HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.ELIGIBLE_FOR_ABANDONMENT_REVIEW) {
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_NOT_ELIGIBLE",
      `This handover cannot be approved for recovery: ${result.reason}`,
    );
  }

  const evidence: HandoverRecoveryApprovalV2EvidenceBinding = {
    eligibilitySchema: result.schema,
    eligibilitySchemaVersion: result.schemaVersion,
    evidenceDigestSchema: digest.schema,
    evidenceDigestSchemaVersion: digest.schemaVersion,
    evidenceDigestAlgorithm: digest.algorithm,
    evidenceDigest: digest.value,
    classification: result.classification,
  };

  const aggregate = readModel.aggregate;
  const identity = aggregate.identity;
  if (
    !aggregate.present ||
    aggregate.unreadable ||
    identity === null ||
    aggregate.revision === null ||
    aggregate.snapshotHash === null ||
    aggregate.lifecycleStatus === null
  ) {
    approvalV2Fail(code, "The handover aggregate cannot be bound to an intent.");
  }
  if (!Object.values(EQUAL_HANDOVER_LIFECYCLE_STATUSES).includes(aggregate.lifecycleStatus as never)) {
    approvalV2Fail(code, "The handover aggregate lifecycle is unsupported.");
  }

  const guard = readModel.guard;
  if (
    !guard.present ||
    guard.unreadable ||
    guard.guardRevision === null ||
    guard.fencingEpoch === null
  ) {
    approvalV2Fail(code, "The reservation guard cannot be bound to an intent.");
  }

  // The global operational slot the outgoing shift still occupies. An eligible
  // classification already proves this slot is the handover's own, so a missing
  // token here means the read model contradicts the conclusion.
  const slot = readModel.slot;
  if (
    !slot.present ||
    slot.unreadable ||
    slot.slotToken === null ||
    slot.generation === null
  ) {
    approvalV2Fail(code, "The global operational slot cannot be bound to an intent.");
  }

  const reviewCase = readModel.reviewCase;
  if (reviewCase.unreadable) {
    approvalV2Fail(code, "The administrative review case cannot be bound safely.");
  }
  let reviewCaseStatus: HandoverRecoveryApprovalV2Binding["reviewCaseStatus"] = "none";
  if (reviewCase.present) {
    if (
      !Object.values(HANDOVER_REVIEW_CASE_STATUSES).includes(
        reviewCase.status as never,
      ) ||
      reviewCase.caseRevision === null ||
      reviewCase.fingerprint === null
    ) {
      approvalV2Fail(code, "The administrative review case is malformed.");
    }
    reviewCaseStatus = reviewCase.status as HandoverRecoveryApprovalV2Binding["reviewCaseStatus"];
  }

  return {
    evidence,
    handoverDocumentId: readModel.handoverDocumentId,
    outgoingShiftId: readModel.outgoingShiftId,
    incomingShiftId: readModel.incomingShiftId,
    aggregateRevision: aggregate.revision,
    aggregateSnapshotHash: aggregate.snapshotHash,
    aggregateLifecycleStatus: aggregate.lifecycleStatus as HandoverRecoveryApprovalV2Binding["aggregateLifecycleStatus"],
    guardId: guard.id,
    guardRevision: guard.guardRevision,
    fencingEpoch: guard.fencingEpoch,
    globalSlotToken: slot.slotToken,
    globalSlotGeneration: slot.generation,
    successorSlotToken: identity.successorSlotToken,
    successorSlotGeneration: identity.successorGeneration,
    reviewCaseId: reviewCase.id,
    reviewCaseStatus,
    reviewCaseRevision: reviewCase.present ? (reviewCase.caseRevision as number) : 0,
    reviewCaseFingerprint: reviewCase.present ? reviewCase.fingerprint : null,
  };
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

export interface HandoverRecoveryApprovalV2Proof {
  schema: typeof HANDOVER_RECOVERY_APPROVAL_V2_PROOF_SCHEMA;
  actorUid: string;
  actorRole: HandoverRecoveryApprovalV2Role;
  intentFingerprint: string;
  requestNonce: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  proofExpiresAt: string;
  verifiedAtMonotonicMs: number;
  proofFingerprint: string;
}

function proofFingerprintV2(input: {
  actorUid: string;
  actorRole: HandoverRecoveryApprovalV2Role;
  intentFingerprint: string;
  requestNonce: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  verifiedAtMonotonicMs: number;
}): string {
  return approvalDigest("handover-recovery-approval-v2-proof-v1", {
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    intentFingerprint: input.intentFingerprint,
    requestNonce: input.requestNonce,
    verifiedAt: input.verifiedAt,
    authAccountCheckedAt: input.authAccountCheckedAt,
    verifiedAtMonotonicMs: input.verifiedAtMonotonicMs,
  });
}

export function createHandoverRecoveryApprovalV2Proof(input: {
  actorUid: string;
  actorRole: HandoverRecoveryApprovalV2Role;
  intentFingerprint: string;
  requestNonce: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  verifiedAtMonotonicMs: number;
}): HandoverRecoveryApprovalV2Proof {
  identifier(input.actorUid, "approver UID");
  roleValue(input.actorRole);
  hex64(input.intentFingerprint, "intent fingerprint");
  identifier(input.requestNonce, "request nonce");
  canonicalTimestamp(input.verifiedAt, "password verification time");
  canonicalTimestamp(input.authAccountCheckedAt, "account check time");
  nonNegativeInteger(input.verifiedAtMonotonicMs, "verification monotonic time");

  const verifiedAtMs = Date.parse(input.verifiedAt);
  if (Date.parse(input.authAccountCheckedAt) < verifiedAtMs) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_AUTHENTICATION_INVALID",
      "Authentication times are not in a valid order.",
    );
  }

  return {
    schema: HANDOVER_RECOVERY_APPROVAL_V2_PROOF_SCHEMA,
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    intentFingerprint: input.intentFingerprint,
    requestNonce: input.requestNonce,
    verifiedAt: input.verifiedAt,
    authAccountCheckedAt: input.authAccountCheckedAt,
    proofExpiresAt: new Date(
      verifiedAtMs + HANDOVER_RECOVERY_APPROVAL_V2_PROOF_MAX_AGE_MS,
    ).toISOString(),
    verifiedAtMonotonicMs: input.verifiedAtMonotonicMs,
    proofFingerprint: proofFingerprintV2(input),
  };
}

export function assertHandoverRecoveryApprovalV2Proof(input: {
  proof: unknown;
  expectedActorUid: string;
  expectedActorRole: HandoverRecoveryApprovalV2Role;
  expectedIntentFingerprint: string;
  expectedRequestNonce: string;
  nowIso: string;
  nowMonotonicMs: number;
  maximumAgeMs?: number;
}): HandoverRecoveryApprovalV2Proof {
  const code = "RECOVERY_APPROVAL_V2_AUTHENTICATION_INVALID" as const;
  const record = strictObject(input.proof, proofFields, code, "approval proof");
  if (record.schema !== HANDOVER_RECOVERY_APPROVAL_V2_PROOF_SCHEMA) {
    throw new HandoverRecoveryApprovalV2Error(code, "Unsupported approval proof schema.");
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
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_AUTH_IDENTITY_CHANGED",
      "The verified authentication subject does not match the session subject.",
    );
  }
  if (record.actorRole !== input.expectedActorRole) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_ROLE_CONFLICT",
      "The approval proof was issued for a different role.",
    );
  }
  if (record.requestNonce !== input.expectedRequestNonce) {
    throw new HandoverRecoveryApprovalV2Error(
      code,
      "The authentication proof belongs to a different request.",
    );
  }
  if (record.intentFingerprint !== input.expectedIntentFingerprint) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_STALE",
      "The approved intent changed after authentication.",
    );
  }
  if (
    record.proofFingerprint !==
    proofFingerprintV2({
      actorUid: record.actorUid as string,
      actorRole: record.actorRole as HandoverRecoveryApprovalV2Role,
      intentFingerprint: record.intentFingerprint as string,
      requestNonce: record.requestNonce as string,
      verifiedAt: record.verifiedAt as string,
      authAccountCheckedAt: record.authAccountCheckedAt as string,
      verifiedAtMonotonicMs: record.verifiedAtMonotonicMs as number,
    })
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "The approval proof is not self-consistent.");
  }

  const verifiedAtMs = Date.parse(record.verifiedAt as string);
  const checkedAtMs = Date.parse(record.authAccountCheckedAt as string);
  const expiresAtMs = Date.parse(record.proofExpiresAt as string);
  const nowMs = Date.parse(input.nowIso);
  if (verifiedAtMs > checkedAtMs || checkedAtMs > nowMs) {
    throw new HandoverRecoveryApprovalV2Error(
      code,
      "Authentication times are not in a valid order.",
    );
  }
  if (expiresAtMs !== verifiedAtMs + HANDOVER_RECOVERY_APPROVAL_V2_PROOF_MAX_AGE_MS) {
    throw new HandoverRecoveryApprovalV2Error(code, "The approval proof expiry is not canonical.");
  }

  const maximumAgeMs = input.maximumAgeMs ?? HANDOVER_RECOVERY_APPROVAL_V2_PROOF_MAX_AGE_MS;
  const elapsed = input.nowMonotonicMs - (record.verifiedAtMonotonicMs as number);
  if (elapsed < 0 || nowMs < verifiedAtMs) {
    throw new HandoverRecoveryApprovalV2Error(
      code,
      "The authentication clocks moved backwards.",
    );
  }
  if (elapsed >= maximumAgeMs || nowMs >= expiresAtMs) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_AUTHENTICATION_EXPIRED",
      "The password verification has expired; authenticate again.",
    );
  }

  return record as unknown as HandoverRecoveryApprovalV2Proof;
}

// ---------------------------------------------------------------------------
// Approval state
// ---------------------------------------------------------------------------

export function complementaryApprovalV2Role(
  role: HandoverRecoveryApprovalV2Role,
): HandoverRecoveryApprovalV2Role {
  return role === HANDOVER_RECOVERY_APPROVAL_V2_ROLES.SUPERVISOR
    ? HANDOVER_RECOVERY_APPROVAL_V2_ROLES.ADMIN
    : HANDOVER_RECOVERY_APPROVAL_V2_ROLES.SUPERVISOR;
}

export function requiredSecondApprovalV2Role(
  approvals: readonly HandoverRecoveryApprovalV2Signature[],
): HandoverRecoveryApprovalV2Role | null {
  if (approvals.length !== 1) return null;
  return complementaryApprovalV2Role(approvals[0].actorRole);
}

export function evaluateHandoverRecoveryApprovalV2EffectiveStatus(
  record: HandoverRecoveryApprovalV2Record,
  nowIso: string,
): HandoverRecoveryApprovalV2EffectiveStatus {
  canonicalTimestamp(nowIso, "current time");
  if (record.status === HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED) {
    return HANDOVER_RECOVERY_APPROVAL_V2_EFFECTIVE_STATUSES.VOIDED;
  }
  if (Date.parse(nowIso) >= Date.parse(record.expiresAt)) {
    return HANDOVER_RECOVERY_APPROVAL_V2_EFFECTIVE_STATUSES.EXPIRED;
  }
  return record.status;
}

export function createHandoverRecoveryApprovalV2View(
  record: HandoverRecoveryApprovalV2Record,
  nowIso: string,
): HandoverRecoveryApprovalV2View {
  return {
    approval: record,
    effectiveStatus: evaluateHandoverRecoveryApprovalV2EffectiveStatus(record, nowIso),
    approvalCount: record.approvals.length,
    requiredSecondRole:
      record.status === HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL
        ? requiredSecondApprovalV2Role(record.approvals)
        : null,
    recoveryExecutionEligible: false,
  };
}

export function assertApprovalV2IntentNotExpired(
  record: HandoverRecoveryApprovalV2Record,
  nowIso: string,
): void {
  canonicalTimestamp(nowIso, "current time");
  if (Date.parse(nowIso) >= Date.parse(record.expiresAt)) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_EXPIRED",
      "This approval intent has expired; request a new intent.",
    );
  }
}

// A stored signature list is append-only. A second signature is refused unless
// it comes from the complementary role, a different person, on the unchanged
// intent, with a fresh proof.
export function assertApprovalV2SignatureAppendable(input: {
  approvals: readonly HandoverRecoveryApprovalV2Signature[];
  actorUid: string;
  actorRole: HandoverRecoveryApprovalV2Role;
}): HandoverRecoveryApprovalV2Role {
  if (input.approvals.length === 0) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT",
      "An approval record has no first signature.",
    );
  }
  if (input.approvals.length !== 1) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_ALREADY_COMPLETE",
      "This approval already carries both signatures.",
    );
  }
  const first = input.approvals[0];
  if (first.actorUid === input.actorUid) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_DUPLICATE_ACTOR",
      "The second approval must be a different person.",
    );
  }
  const required = complementaryApprovalV2Role(first.actorRole);
  if (input.actorRole !== required) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_ROLE_CONFLICT",
      `The second approval must come from the complementary ${required} role.`,
    );
  }
  return required;
}

export function assertRequiredApprovalV2Pair(
  approvals: readonly HandoverRecoveryApprovalV2Signature[],
): void {
  if (approvals.length !== 2) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT",
      "A fully approved record must carry exactly two signatures.",
    );
  }
  const [first, second] = approvals;
  if (first.actorUid === second.actorUid) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT",
      "Both signatures belong to the same person.",
    );
  }
  if (first.proofFingerprint === second.proofFingerprint) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT",
      "Both signatures reuse one authentication proof.",
    );
  }
  const roles = new Set<HandoverRecoveryApprovalV2Role>([
    first.actorRole,
    second.actorRole,
  ]);
  if (
    !roles.has(HANDOVER_RECOVERY_APPROVAL_V2_ROLES.SUPERVISOR) ||
    !roles.has(HANDOVER_RECOVERY_APPROVAL_V2_ROLES.ADMIN)
  ) {
    throw new HandoverRecoveryApprovalV2Error(
      "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT",
      "Approvals must contain exactly one supervisor and one administrator.",
    );
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

export interface HandoverRecoveryApprovalV2Credential {
  password: string;
}

export interface HandoverRecoveryApprovalV2RequestIntent {
  handoverDocumentId: string;
  reason: string;
  idempotencyKey: string;
}

export interface HandoverRecoveryApprovalV2CountersignIntent {
  expectedRevision: number;
}

export interface HandoverRecoveryApprovalV2VoidIntent {
  reason: string;
  idempotencyKey: string;
}

export interface HandoverRecoveryApprovalV2ReissueIntent {
  reason: string;
  idempotencyKey: string;
}

export function parseHandoverRecoveryApprovalV2RequestBody(input: unknown): {
  intent: HandoverRecoveryApprovalV2RequestIntent;
  credential: HandoverRecoveryApprovalV2Credential;
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
      reason: approvalV2Reason(body.reason),
      idempotencyKey: idempotencyKey(body.idempotencyKey),
    },
    credential: { password: password(body.password) },
  };
}

export function parseHandoverRecoveryApprovalV2CountersignBody(input: unknown): {
  intent: HandoverRecoveryApprovalV2CountersignIntent;
  credential: HandoverRecoveryApprovalV2Credential;
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

export function parseHandoverRecoveryApprovalV2VoidBody(input: unknown): {
  intent: HandoverRecoveryApprovalV2VoidIntent;
  credential: HandoverRecoveryApprovalV2Credential;
} {
  const body = strictObject(
    input,
    ["reason", "idempotencyKey", "password"],
    "validation",
    "approval void",
  );
  return {
    intent: {
      reason: approvalV2Reason(body.reason),
      idempotencyKey: idempotencyKey(body.idempotencyKey),
    },
    credential: { password: password(body.password) },
  };
}

export function parseHandoverRecoveryApprovalV2ReissueBody(input: unknown): {
  intent: HandoverRecoveryApprovalV2ReissueIntent;
  credential: HandoverRecoveryApprovalV2Credential;
} {
  const body = strictObject(
    input,
    ["reason", "idempotencyKey", "password"],
    "validation",
    "approval reissue",
  );
  return {
    intent: {
      reason: approvalV2Reason(body.reason),
      idempotencyKey: idempotencyKey(body.idempotencyKey),
    },
    credential: { password: password(body.password) },
  };
}

// ---------------------------------------------------------------------------
// Stored-record validation
// ---------------------------------------------------------------------------

const evidenceBindingFields = [
  "eligibilitySchema",
  "eligibilitySchemaVersion",
  "evidenceDigestSchema",
  "evidenceDigestSchemaVersion",
  "evidenceDigestAlgorithm",
  "evidenceDigest",
  "classification",
] as const;

const bindingFields = [
  "evidence",
  "handoverDocumentId",
  "outgoingShiftId",
  "incomingShiftId",
  "aggregateRevision",
  "aggregateSnapshotHash",
  "aggregateLifecycleStatus",
  "guardId",
  "guardRevision",
  "fencingEpoch",
  "globalSlotToken",
  "globalSlotGeneration",
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
  "boundEvaluatedAt",
  "createdAt",
  "updatedAt",
] as const;

export function assertHandoverRecoveryApprovalV2Record(
  data: unknown,
  id: string,
): HandoverRecoveryApprovalV2Record {
  const code = "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT" as const;
  const value = strictObject(data, recordFields, code, "approval record");
  if (value.schema !== HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA) {
    // A Version 1 document can never be read, upgraded or rewritten here.
    throw new HandoverRecoveryApprovalV2Error(
      code,
      "Version 1 approval documents are not readable as Version 2 approvals.",
    );
  }
  if (value.schemaVersion !== HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION) {
    throw new HandoverRecoveryApprovalV2Error(code, "Unsupported approval schema version.");
  }
  if (value.id !== id) {
    throw new HandoverRecoveryApprovalV2Error(code, "The approval record identity does not match.");
  }
  if (value.action !== HANDOVER_RECOVERY_APPROVAL_V2_ACTION) {
    throw new HandoverRecoveryApprovalV2Error(code, "Unsupported approval action.");
  }
  if (value.recoveryExecutionEligible !== false) {
    throw new HandoverRecoveryApprovalV2Error(code, "A Version 2 approval cannot be executable.");
  }
  if (value.nonExecutableReason !== HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON) {
    throw new HandoverRecoveryApprovalV2Error(code, "The non-executable reason is not canonical.");
  }

  const binding = strictObject(value.binding, bindingFields, code, "approval binding");
  const evidence = strictObject(
    binding.evidence,
    evidenceBindingFields,
    code,
    "approval evidence binding",
  );
  if (
    evidence.eligibilitySchema !== HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA ||
    evidence.eligibilitySchemaVersion !== HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA_VERSION
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "Unsupported eligibility schema.");
  }
  if (
    evidence.evidenceDigestSchema !== HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA ||
    evidence.evidenceDigestSchemaVersion !== HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "Unsupported evidence digest schema.");
  }
  if (evidence.evidenceDigestAlgorithm !== "sha256") {
    throw new HandoverRecoveryApprovalV2Error(code, "Unsupported evidence digest algorithm.");
  }
  hex64OrCode(evidence.evidenceDigest, "evidence digest", code);
  if (
    evidence.classification !==
    HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.ELIGIBLE_FOR_ABANDONMENT_REVIEW
  ) {
    throw new HandoverRecoveryApprovalV2Error(
      code,
      "Only an eligible classification can be approved.",
    );
  }

  identifierOrCode(binding.handoverDocumentId, "handover document ID", code);
  identifierOrCode(binding.outgoingShiftId, "outgoing shift ID", code);
  identifierOrCode(binding.incomingShiftId, "incoming shift ID", code);
  positiveIntegerOrCode(binding.aggregateRevision, "aggregate revision", code);
  hex64OrCode(binding.aggregateSnapshotHash, "aggregate snapshot hash", code);
  if (
    !Object.values(EQUAL_HANDOVER_LIFECYCLE_STATUSES).includes(
      binding.aggregateLifecycleStatus as never,
    )
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "Unsupported aggregate lifecycle.");
  }
  if (binding.guardId !== null) identifierOrCode(binding.guardId, "guard ID", code);
  nonNegativeIntegerOrCode(binding.guardRevision, "guard revision", code);
  nonNegativeIntegerOrCode(binding.fencingEpoch, "fencing epoch", code);
  identifierOrCode(binding.globalSlotToken, "global slot token", code);
  nonNegativeIntegerOrCode(binding.globalSlotGeneration, "global slot generation", code);
  identifierOrCode(binding.successorSlotToken, "successor slot token", code);
  nonNegativeIntegerOrCode(binding.successorSlotGeneration, "successor slot generation", code);
  identifierOrCode(binding.reviewCaseId, "review case ID", code);
  if (
    binding.reviewCaseStatus !== "none" &&
    !Object.values(HANDOVER_REVIEW_CASE_STATUSES).includes(binding.reviewCaseStatus as never)
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "Unsupported review case status.");
  }
  nonNegativeIntegerOrCode(binding.reviewCaseRevision, "review case revision", code);
  if (binding.reviewCaseFingerprint !== null) {
    hex64OrCode(binding.reviewCaseFingerprint, "review case fingerprint", code);
  }

  hex64OrCode(value.intentFingerprint, "intent fingerprint", code);
  if (
    value.intentFingerprint !==
    createHandoverRecoveryApprovalV2IntentFingerprint(
      binding as unknown as HandoverRecoveryApprovalV2Binding,
    )
  ) {
    throw new HandoverRecoveryApprovalV2Error(
      code,
      "The intent fingerprint does not match its binding.",
    );
  }

  identifierOrCode(value.handoverDocumentId, "handover document ID", code);
  identifierOrCode(value.outgoingShiftId, "outgoing shift ID", code);
  identifierOrCode(value.incomingShiftId, "incoming shift ID", code);
  if (
    binding.handoverDocumentId !== value.handoverDocumentId ||
    binding.outgoingShiftId !== value.outgoingShiftId ||
    binding.incomingShiftId !== value.incomingShiftId
  ) {
    throw new HandoverRecoveryApprovalV2Error(
      code,
      "The approval top level does not match its binding.",
    );
  }
  approvalReasonOrCode(value.reason, code);
  identifierOrCode(value.requestedBy, "requester UID", code);
  canonicalTimestampOrCode(value.requestedAt, "requested time", code);
  canonicalTimestampOrCode(value.boundEvaluatedAt, "bound evaluation time", code);
  canonicalTimestampOrCode(value.expiresAt, "intent expiry", code);
  if (Date.parse(value.expiresAt as string) <= Date.parse(value.requestedAt as string)) {
    throw new HandoverRecoveryApprovalV2Error(code, "The intent expiry is not after the request.");
  }
  if (
    Date.parse(value.expiresAt as string) - Date.parse(value.requestedAt as string) !==
    HANDOVER_RECOVERY_APPROVAL_V2_INTENT_MAX_AGE_MS
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "The intent lifetime is not canonical.");
  }
  hex64OrCode(value.requestHash, "request hash", code);
  positiveIntegerOrCode(value.revision, "approval revision", code);

  const status = value.status;
  if (
    status !== HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL &&
    status !== HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.FULLY_APPROVED &&
    status !== HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "Unsupported approval status.");
  }

  if (!Array.isArray(value.approvals)) {
    throw new HandoverRecoveryApprovalV2Error(code, "Approval signatures are malformed.");
  }
  const approvals = value.approvals.map((item) => readSignatureV2(item, code));
  if (approvals.length < 1 || approvals.length > 2) {
    throw new HandoverRecoveryApprovalV2Error(code, "An approval carries one or two signatures.");
  }
  if (approvals[0].actorUid !== value.requestedBy) {
    throw new HandoverRecoveryApprovalV2Error(
      code,
      "The first signature does not belong to the requester.",
    );
  }
  if (approvals.length === 2) {
    assertRequiredApprovalV2Pair(approvals);
    if (status === HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL) {
      throw new HandoverRecoveryApprovalV2Error(code, "A complete approval is still awaiting.");
    }
  } else if (status === HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.FULLY_APPROVED) {
    throw new HandoverRecoveryApprovalV2Error(
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
    status === HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED &&
    (value.voidedAt === null || value.voidedBy === null || value.voidReason === null ||
      value.voidAuditId === null)
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "A voided approval lacks its tombstone.");
  }
  if (
    status !== HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED &&
    (value.voidedAt !== null || value.voidedBy !== null || value.voidReason !== null ||
      value.voidAuditId !== null)
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "A live approval carries a void tombstone.");
  }
  if (
    (value.revision === 1) !== (approvals.length === 1) &&
    status !== HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "The approval revision is inconsistent.");
  }

  canonicalTimestampOrCode(value.createdAt, "creation time", code);
  canonicalTimestampOrCode(value.updatedAt, "update time", code);

  return {
    schema: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA,
    schemaVersion: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION,
    id,
    action: HANDOVER_RECOVERY_APPROVAL_V2_ACTION,
    handoverDocumentId: value.handoverDocumentId as string,
    outgoingShiftId: value.outgoingShiftId as string,
    incomingShiftId: value.incomingShiftId as string,
    binding: binding as unknown as HandoverRecoveryApprovalV2Binding,
    intentFingerprint: value.intentFingerprint as string,
    recoveryExecutionEligible: false,
    nonExecutableReason: HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON,
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
    boundEvaluatedAt: value.boundEvaluatedAt as string,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
  };
}

function readSignatureV2(
  data: unknown,
  code: HandoverRecoveryApprovalV2ErrorCode,
): HandoverRecoveryApprovalV2Signature {
  const value = strictObject(data, signatureFields, code, "approval signature");
  identifierOrCode(value.actorUid, "approver UID", code);
  roleValueOrCode(value.actorRole, code);
  hex64OrCode(value.proofFingerprint, "proof fingerprint", code);
  canonicalTimestampOrCode(value.approvedAt, "approval time", code);
  canonicalTimestampOrCode(value.proofExpiresAt, "proof expiry", code);
  if (
    Date.parse(value.proofExpiresAt as string) !==
    Date.parse(value.approvedAt as string) + HANDOVER_RECOVERY_APPROVAL_V2_PROOF_MAX_AGE_MS
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "The signature proof expiry is not canonical.");
  }
  return value as unknown as HandoverRecoveryApprovalV2Signature;
}

// ---------------------------------------------------------------------------
// Identity guards used by the routes before any read
// ---------------------------------------------------------------------------

export function validHandoverRecoveryApprovalV2Id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(HANDOVER_RECOVERY_APPROVAL_V2_ID_PREFIX) &&
    value.length <= 160 &&
    !value.includes("/")
  );
}

// ---------------------------------------------------------------------------
// Primitive validation
// ---------------------------------------------------------------------------

function strictObject(
  value: unknown,
  fields: readonly string[],
  code: HandoverRecoveryApprovalV2ErrorCode | "validation",
  label: string,
): Record<string, unknown> {
  const fail = (message: string): never => {
    if (code === "validation") inputFail(message);
    throw new HandoverRecoveryApprovalV2Error(code, message);
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
  code: HandoverRecoveryApprovalV2ErrorCode,
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
    throw new HandoverRecoveryApprovalV2Error(code, `Invalid ${label}.`);
  }
}

function handoverDocumentId(value: unknown): string {
  if (!validHandoverDocumentId(value)) {
    inputFail("Invalid handover document.");
  }
  return value;
}

function hex64(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    inputFail(`Invalid ${label}.`);
  }
}

function hex64OrCode(
  value: unknown,
  label: string,
  code: HandoverRecoveryApprovalV2ErrorCode,
): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new HandoverRecoveryApprovalV2Error(code, `Invalid ${label}.`);
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
  code: HandoverRecoveryApprovalV2ErrorCode,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, `Invalid ${label}.`);
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
  code: HandoverRecoveryApprovalV2ErrorCode,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HandoverRecoveryApprovalV2Error(code, `Invalid ${label}.`);
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
  code: HandoverRecoveryApprovalV2ErrorCode,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new HandoverRecoveryApprovalV2Error(code, `Invalid ${label}.`);
  }
}

function roleValue(value: unknown): asserts value is HandoverRecoveryApprovalV2Role {
  if (
    value !== HANDOVER_RECOVERY_APPROVAL_V2_ROLES.SUPERVISOR &&
    value !== HANDOVER_RECOVERY_APPROVAL_V2_ROLES.ADMIN
  ) {
    inputFail("Invalid approval role.");
  }
}

function roleValueOrCode(
  value: unknown,
  code: HandoverRecoveryApprovalV2ErrorCode,
): asserts value is HandoverRecoveryApprovalV2Role {
  if (
    value !== HANDOVER_RECOVERY_APPROVAL_V2_ROLES.SUPERVISOR &&
    value !== HANDOVER_RECOVERY_APPROVAL_V2_ROLES.ADMIN
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "Invalid approval role.");
  }
}

export function approvalV2Reason(value: unknown): string {
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
  code: HandoverRecoveryApprovalV2ErrorCode,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < HANDOVER_RECOVERY_APPROVAL_REASON_MIN_LENGTH ||
    value.length > HANDOVER_RECOVERY_APPROVAL_REASON_MAX_LENGTH
  ) {
    throw new HandoverRecoveryApprovalV2Error(code, "Invalid approval reason.");
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
