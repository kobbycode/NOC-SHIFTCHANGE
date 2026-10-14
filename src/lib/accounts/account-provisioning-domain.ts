import type { UserRole } from "@/types/auth";

export const ACCOUNT_PROVISIONING_STAGES = [
  "reserved",
  "auth_create_pending",
  "claims_pending",
  "auth_enable_pending",
  "finalize_pending",
  "completed",
  "requires_review",
  "failed",
] as const;

export type AccountProvisioningStage =
  (typeof ACCOUNT_PROVISIONING_STAGES)[number];

export type ProvisioningFailureClassification =
  | "transient"
  | "requires_review"
  | "terminal";

export type ProvisioningFailureOutcome =
  | "confirmed_not_applied"
  | "unknown";

export type ProvisioningFailureCode =
  | "auth_create_unavailable"
  | "auth_claims_unavailable"
  | "auth_enable_unavailable"
  | "firestore_finalize_unavailable"
  | "identity_mismatch"
  | "reservation_conflict"
  | "persistence_unavailable"
  | "invalid_operation";

export type ProvisioningEvidence =
  | "operation_reserved"
  | "auth_uid_absent"
  | "auth_identity_matches"
  | "role_claim_absent"
  | "role_claim_matches"
  | "auth_user_disabled"
  | "auth_user_enabled"
  | "finalization_absent"
  | "finalization_committed";

/**
 * This opaque key is supplied by the future persistence adapter. It must be a
 * keyed HMAC (or equivalently protected server-only value), never a raw email
 * or plain unsalted email hash. UI-04C2 configures no key or secret. Keep completed
 * reservations from silently authorizing replacement; pending and review-required
 * operations must not be automatically discarded. Cleanup/recreation requires
 * an explicit future policy.
 */
export type EmailReservationKey = string & {
  readonly __emailReservationKey: unique symbol;
};

export interface ProvisioningRequestIdentity {
  operationId: string;
  targetAuthUid: string;
  initiatingAdminUid: string;
  requestedRole: UserRole;
  displayName: string;
  emailReservationKey: EmailReservationKey;
  /** Fingerprint only immutable non-secret request fields; never credentials. */
  requestFingerprint: string;
}

/**
 * Persistence must acquire/update this lease with revision compare-and-swap and
 * check fencingToken before committing each external result. Never let a worker
 * with an expired or superseded epoch write a stage transition.
 */
export interface ProvisioningLease {
  ownerId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface ProvisioningFailure {
  classification: ProvisioningFailureClassification;
  outcome: ProvisioningFailureOutcome;
  code: ProvisioningFailureCode;
  evidence: ProvisioningEvidence | null;
  occurredAt: string;
}

export interface ProvisioningReview {
  resumeStage: Exclude<
    AccountProvisioningStage,
    "completed" | "requires_review" | "failed"
  >;
  openedAt: string;
}

export interface ProvisioningRecoveryDecision {
  actorUid: string;
  decisionId: string;
  action: "resume" | "fail";
  outcome: "applied" | "not_applied";
  evidence: ProvisioningEvidence;
  decidedAt: string;
}

export interface AccountProvisioningOperation
  extends ProvisioningRequestIdentity {
  schemaVersion: 1;
  stage: AccountProvisioningStage;
  revision: number;
  leaseEpoch: number;
  lease: ProvisioningLease | null;
  createdAt: string;
  updatedAt: string;
  stageEnteredAt: string;
  lastAttemptAt: string | null;
  attemptCount: number;
  completedAt: string | null;
  lastFailure: ProvisioningFailure | null;
  review: ProvisioningReview | null;
  lastRecoveryDecision: ProvisioningRecoveryDecision | null;
  lastCommand: {
    commandId: string;
    fingerprint: string;
  } | null;
}

export type ProvisioningEvidenceCommand = {
  commandId: string;
  expectedRevision: number;
  ownerId: string;
  fencingToken: number;
  at: string;
};

export type ProvisioningCommand =
  | ({ type: "start" } & ProvisioningEvidenceCommand)
  | ({
      type: "advance";
      to: AccountProvisioningStage;
      evidence: ProvisioningEvidence;
    } & ProvisioningEvidenceCommand)
  | ({
      type: "retry";
      evidence: ProvisioningEvidence;
    } & ProvisioningEvidenceCommand)
  | ({
      type: "record_failure";
      failure: Omit<ProvisioningFailure, "occurredAt">;
    } & ProvisioningEvidenceCommand)
  | ({
      type: "resolve_review";
      decision: Omit<ProvisioningRecoveryDecision, "decidedAt">;
    } & ProvisioningEvidenceCommand);

export interface AcquireProvisioningLeaseInput {
  ownerId: string;
  expiresAt: string;
  now: string;
  expectedRevision: number;
}

export interface RenewProvisioningLeaseInput {
  ownerId: string;
  fencingToken: number;
  expectedRevision: number;
  now: string;
  expiresAt: string;
}
export class ProvisioningDomainError extends Error {
  readonly code: "invalid_operation" | "illegal_transition" | "identity_conflict" | "stale_revision" | "lease_required" | "lease_expired" | "review_decision_required" | "immutable_operation";

  constructor(code: "invalid_operation" | "illegal_transition" | "identity_conflict" | "stale_revision" | "lease_required" | "lease_expired" | "review_decision_required" | "immutable_operation") {
    super(code);
    this.code = code;
    this.name = "ProvisioningDomainError";
  }
}

const VALID_ROLES = new Set<UserRole>([
  "admin",
  "supervisor",
  "technician",
]);

const FAILURE_CODES = new Set<ProvisioningFailureCode>([
  "auth_create_unavailable",
  "auth_claims_unavailable",
  "auth_enable_unavailable",
  "firestore_finalize_unavailable",
  "identity_mismatch",
  "reservation_conflict",
  "persistence_unavailable",
  "invalid_operation",
]);

const EVIDENCE_CODES = new Set<ProvisioningEvidence>([
  "operation_reserved",
  "auth_uid_absent",
  "auth_identity_matches",
  "role_claim_absent",
  "role_claim_matches",
  "auth_user_disabled",
  "auth_user_enabled",
  "finalization_absent",
  "finalization_committed",
]);

const NEXT_STAGE: Partial<
  Record<AccountProvisioningStage, AccountProvisioningStage>
> = {
  auth_create_pending: "claims_pending",
  claims_pending: "auth_enable_pending",
  auth_enable_pending: "finalize_pending",
  finalize_pending: "completed",
};

const ADVANCE_EVIDENCE: Partial<
  Record<AccountProvisioningStage, ProvisioningEvidence>
> = {
  auth_create_pending: "auth_identity_matches",
  claims_pending: "role_claim_matches",
  auth_enable_pending: "auth_user_enabled",
  finalize_pending: "finalization_committed",
};

const RETRY_EVIDENCE: Record<
  Exclude<AccountProvisioningStage, "completed" | "requires_review" | "failed">,
  ProvisioningEvidence
> = {
  reserved: "operation_reserved",
  auth_create_pending: "auth_uid_absent",
  claims_pending: "role_claim_absent",
  auth_enable_pending: "auth_user_disabled",
  finalize_pending: "finalization_absent",
};

const OPERATION_KEYS = new Set([
  "schemaVersion",
  "operationId",
  "targetAuthUid",
  "initiatingAdminUid",
  "requestedRole",
  "displayName",
  "emailReservationKey",
  "requestFingerprint",
  "stage",
  "revision",
  "leaseEpoch",
  "lease",
  "createdAt",
  "updatedAt",
  "stageEnteredAt",
  "lastAttemptAt",
  "attemptCount",
  "completedAt",
  "lastFailure",
  "review",
  "lastRecoveryDecision",
  "lastCommand",
]);

function fail(
  code: ConstructorParameters<typeof ProvisioningDomainError>[0]
): never {
  throw new ProvisioningDomainError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function nonEmptyString(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maxLength;
}

function validateIdentity(identity: unknown): asserts identity is ProvisioningRequestIdentity {
  if (!isRecord(identity) || !hasExactKeys(identity, [
    "operationId",
    "targetAuthUid",
    "initiatingAdminUid",
    "requestedRole",
    "displayName",
    "emailReservationKey",
    "requestFingerprint",
  ])) fail("invalid_operation");

  if (
    !nonEmptyString(identity.operationId, 128) ||
    identity.operationId.includes("/") ||
    !nonEmptyString(identity.targetAuthUid, 128) ||
    identity.targetAuthUid.includes("/") ||
    !nonEmptyString(identity.initiatingAdminUid, 128) ||
    identity.initiatingAdminUid.includes("/") ||
    typeof identity.requestedRole !== "string" ||
    !VALID_ROLES.has(identity.requestedRole as UserRole) ||
    typeof identity.displayName !== "string" ||
    identity.displayName.trim().length < 2 ||
    identity.displayName.length > 120 ||
    !nonEmptyString(identity.emailReservationKey, 256) ||
    identity.emailReservationKey.includes("@") ||
    !nonEmptyString(identity.requestFingerprint, 256) ||
    identity.requestFingerprint.includes("@")
  ) fail("invalid_operation");
}

function validateFailure(value: unknown): value is ProvisioningFailure {
  if (value === null) return true;
  if (!isRecord(value) || !hasExactKeys(value, [
    "classification",
    "outcome",
    "code",
    "evidence",
    "occurredAt",
  ])) return false;

  return (
    (value.classification === "transient" ||
      value.classification === "requires_review" ||
      value.classification === "terminal") &&
    (value.outcome === "confirmed_not_applied" || value.outcome === "unknown") &&
    typeof value.code === "string" && FAILURE_CODES.has(value.code as ProvisioningFailureCode) &&
    (value.evidence === null ||
      (typeof value.evidence === "string" && EVIDENCE_CODES.has(value.evidence as ProvisioningEvidence))) &&
    validTimestamp(value.occurredAt)
  );
}

export function assertProvisioningOperation(
  value: unknown,
): asserts value is AccountProvisioningOperation {
  if (!isRecord(value) || !hasExactKeys(value, [...OPERATION_KEYS])) {
    fail("invalid_operation");
  }
  validateIdentity({
    operationId: value.operationId,
    targetAuthUid: value.targetAuthUid,
    initiatingAdminUid: value.initiatingAdminUid,
    requestedRole: value.requestedRole,
    displayName: value.displayName,
    emailReservationKey: value.emailReservationKey,
    requestFingerprint: value.requestFingerprint,
  });

  if (
    value.schemaVersion !== 1 ||
    typeof value.stage !== "string" ||
    !(ACCOUNT_PROVISIONING_STAGES as readonly string[]).includes(value.stage) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !Number.isSafeInteger(value.leaseEpoch) || (value.leaseEpoch as number) < 0 ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt) ||
    !validTimestamp(value.stageEnteredAt) ||
    Date.parse(value.createdAt) > Date.parse(value.updatedAt) ||
    Date.parse(value.stageEnteredAt) > Date.parse(value.updatedAt) ||
    !(value.lastAttemptAt === null || validTimestamp(value.lastAttemptAt)) ||
    !Number.isSafeInteger(value.attemptCount) || (value.attemptCount as number) < 0 ||
    !(value.completedAt === null || validTimestamp(value.completedAt)) ||
    !validateFailure(value.lastFailure)
  ) fail("invalid_operation");

  if (value.lease !== null) {
    if (!isRecord(value.lease) || !hasExactKeys(value.lease, ["ownerId", "fencingToken", "expiresAt"]) ||
      !nonEmptyString(value.lease.ownerId, 128) ||
      !Number.isSafeInteger(value.lease.fencingToken) ||
      value.lease.fencingToken !== value.leaseEpoch ||
      !validTimestamp(value.lease.expiresAt)) fail("invalid_operation");
  }

  if (value.review !== null) {
    if (!isRecord(value.review) || !hasExactKeys(value.review, ["resumeStage", "openedAt"]) ||
      typeof value.review.resumeStage !== "string" ||
      !["reserved", "auth_create_pending", "claims_pending", "auth_enable_pending", "finalize_pending"].includes(value.review.resumeStage) ||
      !validTimestamp(value.review.openedAt)) fail("invalid_operation");
  }

  if (value.lastRecoveryDecision !== null) {
    if (!isRecord(value.lastRecoveryDecision) || !hasExactKeys(value.lastRecoveryDecision, [
      "actorUid", "decisionId", "action", "outcome", "evidence", "decidedAt",
    ]) || !nonEmptyString(value.lastRecoveryDecision.actorUid, 128) ||
      !nonEmptyString(value.lastRecoveryDecision.decisionId, 128) ||
      (value.lastRecoveryDecision.action !== "resume" && value.lastRecoveryDecision.action !== "fail") ||
      (value.lastRecoveryDecision.outcome !== "applied" && value.lastRecoveryDecision.outcome !== "not_applied") ||
      typeof value.lastRecoveryDecision.evidence !== "string" ||
      !EVIDENCE_CODES.has(value.lastRecoveryDecision.evidence as ProvisioningEvidence) ||
      !validTimestamp(value.lastRecoveryDecision.decidedAt)) fail("invalid_operation");
  }

  if (value.lastCommand !== null) {
    if (!isRecord(value.lastCommand) || !hasExactKeys(value.lastCommand, ["commandId", "fingerprint"]) ||
      !nonEmptyString(value.lastCommand.commandId, 128) ||
      !nonEmptyString(value.lastCommand.fingerprint, 4096)) fail("invalid_operation");
  }

  if ((value.stage === "completed") !== (value.completedAt !== null) ||
    (value.stage === "completed" && value.lastFailure !== null)) fail("invalid_operation");
  if ((value.stage === "requires_review") !== (value.review !== null) ||
    (value.stage === "requires_review" && value.lastFailure?.classification !== "requires_review")) fail("invalid_operation");
  if ((value.stage === "failed") !== (value.lastFailure?.classification === "terminal")) fail("invalid_operation");
}

export function createProvisioningOperation(
  identity: ProvisioningRequestIdentity,
  now: string,
): AccountProvisioningOperation {
  validateIdentity(identity);
  if (!validTimestamp(now)) fail("invalid_operation");

  const operation: AccountProvisioningOperation = {
    schemaVersion: 1,
    ...identity,
    stage: "reserved",
    revision: 0,
    leaseEpoch: 0,
    lease: null,
    createdAt: now,
    updatedAt: now,
    stageEnteredAt: now,
    lastAttemptAt: null,
    attemptCount: 0,
    completedAt: null,
    lastFailure: null,
    review: null,
    lastRecoveryDecision: null,
    lastCommand: null,
  };
  assertProvisioningOperation(operation);
  return operation;
}

export function assertSameProvisioningIdentity(
  operation: AccountProvisioningOperation,
  retry: ProvisioningRequestIdentity,
): void {
  assertProvisioningOperation(operation);
  validateIdentity(retry);
  const identityKeys: (keyof ProvisioningRequestIdentity)[] = [
    "operationId",
    "targetAuthUid",
    "initiatingAdminUid",
    "requestedRole",
    "displayName",
    "emailReservationKey",
    "requestFingerprint",
  ];
  if (identityKeys.some((key) => operation[key] !== retry[key])) {
    fail("identity_conflict");
  }
}

export function acquireProvisioningLease(
  operation: AccountProvisioningOperation,
  input: AcquireProvisioningLeaseInput,
): AccountProvisioningOperation {
  assertProvisioningOperation(operation);
  if (!validTimestamp(input.now) || !validTimestamp(input.expiresAt) ||
    !nonEmptyString(input.ownerId, 128) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision !== operation.revision ||
    input.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    operation.leaseEpoch >= Number.MAX_SAFE_INTEGER ||
    Date.parse(input.now) < Date.parse(operation.updatedAt) ||
    Date.parse(input.expiresAt) <= Date.parse(input.now)) fail("stale_revision");
  if (operation.stage === "completed" || operation.stage === "failed") fail("immutable_operation");
  if (operation.lease && Date.parse(operation.lease.expiresAt) > Date.parse(input.now)) {
    fail("lease_required");
  }

  return {
    ...operation,
    revision: operation.revision + 1,
    leaseEpoch: operation.leaseEpoch + 1,
    lease: {
      ownerId: input.ownerId,
      fencingToken: operation.leaseEpoch + 1,
      expiresAt: input.expiresAt,
    },
    updatedAt: input.now,
  };
}

export function renewProvisioningLease(
  operation: AccountProvisioningOperation,
  input: RenewProvisioningLeaseInput,
): AccountProvisioningOperation {
  assertProvisioningOperation(operation);
  if (
    !validTimestamp(input.now) ||
    !validTimestamp(input.expiresAt) ||
    !nonEmptyString(input.ownerId, 128) ||
    !Number.isSafeInteger(input.fencingToken) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision !== operation.revision ||
    input.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    Date.parse(input.now) < Date.parse(operation.updatedAt) ||
    Date.parse(input.expiresAt) <= Date.parse(input.now)
  ) fail("stale_revision");

  if (operation.stage === "completed" || operation.stage === "failed") {
    fail("immutable_operation");
  }
  if (
    !operation.lease ||
    operation.lease.ownerId !== input.ownerId ||
    operation.lease.fencingToken !== input.fencingToken ||
    operation.leaseEpoch !== input.fencingToken
  ) fail("lease_required");
  if (Date.parse(operation.lease.expiresAt) <= Date.parse(input.now)) {
    fail("lease_expired");
  }

  const renewed: AccountProvisioningOperation = {
    ...operation,
    revision: operation.revision + 1,
    updatedAt: input.now,
    lease: {
      ...operation.lease,
      expiresAt: input.expiresAt,
    },
  };
  assertProvisioningOperation(renewed);
  return renewed;
}
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function cloneOperation(operation: AccountProvisioningOperation): AccountProvisioningOperation {
  return JSON.parse(JSON.stringify(operation)) as AccountProvisioningOperation;
}

function validateCommandShape(command: ProvisioningCommand): void {
  if (!["start", "advance", "retry", "record_failure", "resolve_review"].includes(command.type)) fail("invalid_operation");
  const common = ["type", "commandId", "expectedRevision", "ownerId", "fencingToken", "at"];
  const keys = command.type === "advance" ? [...common, "to", "evidence"]
    : command.type === "retry" ? [...common, "evidence"]
      : command.type === "record_failure" ? [...common, "failure"]
        : command.type === "resolve_review" ? [...common, "decision"]
          : common;
  if (!hasExactKeys(command as unknown as Record<string, unknown>, keys) ||
    !nonEmptyString(command.commandId, 128) ||
    !nonEmptyString(command.ownerId, 128) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    !Number.isSafeInteger(command.fencingToken) ||
    !validTimestamp(command.at)) fail("invalid_operation");

  if (command.type === "advance" || command.type === "retry") {
    if (typeof command.evidence !== "string" || !EVIDENCE_CODES.has(command.evidence)) fail("invalid_operation");
  }
  if (command.type === "record_failure") {
    if (!isRecord(command.failure) || !hasExactKeys(command.failure, [
      "classification", "outcome", "code", "evidence",
    ]) || !validateFailure({ ...command.failure, occurredAt: command.at })) fail("invalid_operation");
  }
  if (command.type === "resolve_review") {
    if (!isRecord(command.decision) || !hasExactKeys(command.decision, [
      "actorUid", "decisionId", "action", "outcome", "evidence",
    ]) || !nonEmptyString(command.decision.actorUid, 128) ||
      !nonEmptyString(command.decision.decisionId, 128) ||
      (command.decision.action !== "resume" && command.decision.action !== "fail") ||
      (command.decision.outcome !== "applied" && command.decision.outcome !== "not_applied") ||
      typeof command.decision.evidence !== "string" || !EVIDENCE_CODES.has(command.decision.evidence as ProvisioningEvidence)) {
      fail("invalid_operation");
    }
  }
}

function requireLease(
  operation: AccountProvisioningOperation,
  command: ProvisioningEvidenceCommand,
): void {
  if (!operation.lease ||
    operation.lease.ownerId !== command.ownerId ||
    operation.lease.fencingToken !== command.fencingToken ||
    operation.leaseEpoch !== command.fencingToken) fail("lease_required");
  if (Date.parse(operation.lease.expiresAt) <= Date.parse(command.at)) fail("lease_expired");
}

function nextStage(
  stage: AccountProvisioningStage,
  evidence: ProvisioningEvidence,
): AccountProvisioningStage {
  if (ADVANCE_EVIDENCE[stage] !== evidence || !NEXT_STAGE[stage]) fail("illegal_transition");
  return NEXT_STAGE[stage]!;
}

export function applyProvisioningCommand(
  operation: AccountProvisioningOperation,
  command: ProvisioningCommand,
): AccountProvisioningOperation {
  assertProvisioningOperation(operation);
  validateCommandShape(command);

  const fingerprint = stableSerialize(command);
  if (operation.lastCommand?.commandId === command.commandId) {
    if (operation.lastCommand.fingerprint !== fingerprint) fail("identity_conflict");
    return cloneOperation(operation);
  }
  if (command.expectedRevision !== operation.revision) fail("stale_revision");
  if (operation.stage === "completed" || operation.stage === "failed") fail("immutable_operation");
  if (Date.parse(command.at) < Date.parse(operation.updatedAt)) fail("invalid_operation");
  requireLease(operation, command);
  if (operation.stage === "requires_review" && command.type !== "resolve_review") {
    fail("review_decision_required");
  }

  const next: AccountProvisioningOperation = cloneOperation(operation);
  next.revision += 1;
  next.updatedAt = command.at;
  next.lastCommand = { commandId: command.commandId, fingerprint };

  if (command.type === "start") {
    if (operation.stage !== "reserved" || operation.lastFailure !== null) fail("illegal_transition");
    next.stage = "auth_create_pending";
    next.stageEnteredAt = command.at;
    next.lastAttemptAt = command.at;
    next.attemptCount += 1;
  } else if (command.type === "advance") {
    const target = nextStage(operation.stage, command.evidence);
    if (target !== command.to) fail("illegal_transition");
    next.stage = target;
    next.stageEnteredAt = command.at;
    next.lastFailure = null;
    next.review = null;
    if (target === "completed") next.completedAt = command.at;
    next.lease = null;
  } else if (command.type === "retry") {
    const expectedRetryEvidence = RETRY_EVIDENCE[operation.stage as keyof typeof RETRY_EVIDENCE];
    if (!expectedRetryEvidence || expectedRetryEvidence !== command.evidence ||
      (operation.lastFailure !== null && operation.lastFailure.classification !== "transient")) fail("illegal_transition");
    next.lastFailure = null;
    next.lastAttemptAt = command.at;
    next.attemptCount += 1;
  } else if (command.type === "record_failure") {
    const failure = { ...command.failure, occurredAt: command.at };
    if (failure.outcome === "confirmed_not_applied" &&
      (failure.evidence === null || RETRY_EVIDENCE[operation.stage as keyof typeof RETRY_EVIDENCE] !== failure.evidence)) {
      fail("invalid_operation");
    }
    if (failure.outcome === "unknown" && failure.evidence !== null) fail("invalid_operation");

    if (failure.classification === "terminal") {
      if ((operation.stage !== "reserved" && operation.stage !== "auth_create_pending") ||
        failure.outcome !== "confirmed_not_applied") fail("illegal_transition");
      next.stage = "failed";
      next.lease = null;
    } else if (failure.classification === "requires_review") {
      if (operation.stage === "requires_review") fail("illegal_transition");
      next.stage = "requires_review";
      next.review = { resumeStage: operation.stage as ProvisioningReview["resumeStage"], openedAt: command.at };
      next.lease = null;
    } else if (failure.classification === "transient") {
      next.lease = null;
    }
    next.lastFailure = failure;
  } else {
    const review = operation.review;
    if (operation.stage !== "requires_review" || !review) fail("review_decision_required");
    const decision = command.decision;
    const expectedEvidence = decision.outcome === "applied"
      ? ADVANCE_EVIDENCE[review.resumeStage]
      : RETRY_EVIDENCE[review.resumeStage];
    if (!expectedEvidence || expectedEvidence !== decision.evidence) fail("invalid_operation");
    if (decision.action === "fail" &&
      (decision.outcome !== "not_applied" ||
        (review.resumeStage !== "reserved" && review.resumeStage !== "auth_create_pending"))) {
      fail("illegal_transition");
    }

    next.lastRecoveryDecision = {
      ...decision,
      decidedAt: command.at,
    };
    if (decision.action === "fail") {
      next.stage = "failed";
      next.review = null;
      next.lease = null;
      next.lastFailure = {
        classification: "terminal",
        outcome: "confirmed_not_applied",
        code: operation.lastFailure?.code ?? "invalid_operation",
        evidence: decision.evidence,
        occurredAt: command.at,
      };
    } else if (decision.outcome === "applied") {
      const target = nextStage(review.resumeStage, decision.evidence);
      next.stage = target;
      next.stageEnteredAt = command.at;
      next.lastFailure = null;
      next.review = null;
      if (target === "completed") next.completedAt = command.at;
      if (target === "completed") next.lease = null;
    } else {
      next.stage = review.resumeStage;
      next.review = null;
      next.lastFailure = {
        classification: "transient",
        outcome: "confirmed_not_applied",
        code: operation.lastFailure?.code ?? "persistence_unavailable",
        evidence: decision.evidence,
        occurredAt: command.at,
      };
    }
  }

  assertProvisioningOperation(next);
  return next;
}



