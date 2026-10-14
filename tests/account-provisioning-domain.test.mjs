import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/lib/accounts/account-provisioning-domain.ts", import.meta.url),
  "utf8",
);
const exports = {};
runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  { exports },
);
const domain = exports;

const BASE = "2025-01-01T00:00:00.000Z";
const KEY = "hmac-sha256:v1:opaque-reservation-key";

function plusSecond(value) {
  return new Date(Date.parse(value) + 1_000).toISOString();
}

function plusHour(value) {
  return new Date(Date.parse(value) + 3_600_000).toISOString();
}

function createOperation(overrides = {}, now = BASE) {
  return domain.createProvisioningOperation({
    operationId: "operation-1",
    targetAuthUid: "auth-uid-1",
    initiatingAdminUid: "admin-uid-1",
    requestedRole: "technician",
    displayName: "Taylor Technician",
    emailReservationKey: KEY,
    requestFingerprint: "request-fingerprint-v1",
    ...overrides,
  }, now);
}

function acquire(operation, ownerId = "worker-1", now = operation.updatedAt) {
  return domain.acquireProvisioningLease(operation, {
    ownerId,
    now,
    expiresAt: plusHour(now),
    expectedRevision: operation.revision,
  });
}

function ensureLease(operation) {
  return operation.lease ? operation : acquire(operation);
}

function command(operation, type, extra = {}, at = plusSecond(operation.updatedAt)) {
  assert.ok(operation.lease, "command helper requires a lease");
  return {
    type,
    commandId: `${type}-${operation.stage}-${operation.revision}`,
    expectedRevision: operation.revision,
    ownerId: operation.lease.ownerId,
    fencingToken: operation.lease.fencingToken,
    at,
    ...extra,
  };
}

function expectDomainError(run, code) {
  assert.throws(run, (error) =>
    error?.name === "ProvisioningDomainError" && error.code === code,
  );
}

function start(operation) {
  const leased = acquire(operation);
  return domain.applyProvisioningCommand(leased, command(leased, "start"));
}

function advance(operation, to, evidence) {
  const leased = ensureLease(operation);
  return domain.applyProvisioningCommand(
    leased,
    command(leased, "advance", { to, evidence }),
  );
}

function completeOperation() {
  let operation = start(createOperation());
  operation = advance(operation, "claims_pending", "auth_identity_matches");
  operation = advance(operation, "auth_enable_pending", "role_claim_matches");
  operation = advance(operation, "finalize_pending", "auth_user_enabled");
  operation = advance(operation, "completed", "finalization_committed");
  return operation;
}

test("accepts each legal forward stage transition through confirmed completion", () => {
  const operation = completeOperation();
  assert.equal(operation.stage, "completed");
  assert.equal(operation.completedAt, operation.updatedAt);
  assert.equal(operation.attemptCount, 1);
  assert.equal(operation.targetAuthUid, "auth-uid-1");
});

test("rejects skipped, backward, and evidence-mismatched transitions", () => {
  const operation = start(createOperation());
  const leased = ensureLease(operation);
  expectDomainError(() => domain.applyProvisioningCommand(
    leased,
    command(leased, "advance", {
      to: "auth_enable_pending",
      evidence: "auth_identity_matches",
    }),
  ), "illegal_transition");
  expectDomainError(() => domain.applyProvisioningCommand(
    leased,
    command(leased, "advance", {
      to: "reserved",
      evidence: "auth_identity_matches",
    }),
  ), "illegal_transition");
  expectDomainError(() => domain.applyProvisioningCommand(
    leased,
    command(leased, "advance", {
      to: "claims_pending",
      evidence: "role_claim_matches",
    }),
  ), "illegal_transition");
});

test("replays an identical command deterministically and rejects conflicting command reuse", () => {
  const leased = acquire(createOperation());
  const startCommand = command(leased, "start");
  const started = domain.applyProvisioningCommand(leased, startCommand);
  const replay = domain.applyProvisioningCommand(started, startCommand);
  assert.equal(JSON.stringify(replay), JSON.stringify(started));

  expectDomainError(() => domain.applyProvisioningCommand(started, {
    ...startCommand,
    at: plusSecond(startCommand.at),
  }), "identity_conflict");
});

test("completed operations are immutable, including after a duplicate final command", () => {
  const completed = completeOperation();
  const duplicateFinal = {
    type: "advance",
    commandId: completed.lastCommand.commandId,
    expectedRevision: completed.revision - 1,
    ownerId: "worker-1",
    fencingToken: completed.leaseEpoch,
    at: completed.completedAt,
    to: "completed",
    evidence: "finalization_committed",
  };
  assert.equal(
    JSON.stringify(domain.applyProvisioningCommand(completed, duplicateFinal)),
    JSON.stringify(completed),
  );
  expectDomainError(() => domain.acquireProvisioningLease(completed, {
    ownerId: "worker-2",
    now: completed.updatedAt,
    expiresAt: plusHour(completed.updatedAt),
    expectedRevision: completed.revision,
  }), "immutable_operation");
});

test("requires an explicit reviewed recovery decision before leaving requires_review", () => {
  let operation = start(createOperation());
  let leased = ensureLease(operation);
  operation = domain.applyProvisioningCommand(leased, command(leased, "record_failure", {
    failure: {
      classification: "requires_review",
      outcome: "unknown",
      code: "identity_mismatch",
      evidence: null,
    },
  }));
  assert.equal(operation.stage, "requires_review");
  assert.equal(operation.review.resumeStage, "auth_create_pending");

  leased = acquire(operation, "review-worker");
  expectDomainError(() => domain.applyProvisioningCommand(
    leased,
    command(leased, "retry", { evidence: "auth_uid_absent" }),
  ), "review_decision_required");

  operation = domain.applyProvisioningCommand(leased, command(leased, "resolve_review", {
    decision: {
      actorUid: "admin-uid-1",
      decisionId: "decision-1",
      action: "resume",
      outcome: "applied",
      evidence: "auth_identity_matches",
    },
  }));
  assert.equal(operation.stage, "claims_pending");
  assert.equal(operation.lastRecoveryDecision.actorUid, "admin-uid-1");
  assert.equal(operation.review, null);
});

test("transient unknown outcomes require positive not-applied evidence before retry", () => {
  let operation = start(createOperation());
  let leased = ensureLease(operation);
  operation = domain.applyProvisioningCommand(leased, command(leased, "record_failure", {
    failure: {
      classification: "transient",
      outcome: "unknown",
      code: "auth_create_unavailable",
      evidence: null,
    },
  }));
  assert.equal(operation.stage, "auth_create_pending");
  assert.equal(operation.lastFailure.outcome, "unknown");

  leased = acquire(operation);
  expectDomainError(() => domain.applyProvisioningCommand(
    leased,
    command(leased, "retry", { evidence: "operation_reserved" }),
  ), "illegal_transition");
  operation = domain.applyProvisioningCommand(leased, command(leased, "retry", {
    evidence: "auth_uid_absent",
  }));
  assert.equal(operation.stage, "auth_create_pending");
  assert.equal(operation.lastFailure, null);
  assert.equal(operation.attemptCount, 2);
});

test("confirmed terminal failure is final and does not change the predetermined UID", () => {
  let operation = start(createOperation());
  const leased = ensureLease(operation);
  operation = domain.applyProvisioningCommand(leased, command(leased, "record_failure", {
    failure: {
      classification: "terminal",
      outcome: "confirmed_not_applied",
      code: "auth_create_unavailable",
      evidence: "auth_uid_absent",
    },
  }));
  assert.equal(operation.stage, "failed");
  assert.equal(operation.targetAuthUid, "auth-uid-1");
  expectDomainError(() => acquire(operation), "immutable_operation");
});

test("review resolution can resume after confirmed non-application with retry evidence", () => {
  let operation = start(createOperation());
  let leased = ensureLease(operation);
  operation = domain.applyProvisioningCommand(leased, command(leased, "record_failure", {
    failure: {
      classification: "requires_review",
      outcome: "unknown",
      code: "auth_claims_unavailable",
      evidence: null,
    },
  }));
  leased = acquire(operation, "review-worker");
  operation = domain.applyProvisioningCommand(leased, command(leased, "resolve_review", {
    decision: {
      actorUid: "admin-uid-1",
      decisionId: "decision-not-applied",
      action: "resume",
      outcome: "not_applied",
      evidence: "auth_uid_absent",
    },
  }));
  assert.equal(operation.stage, "auth_create_pending");
  assert.equal(operation.lastFailure.classification, "transient");
  assert.equal(operation.lastFailure.outcome, "confirmed_not_applied");
});

test("retries cannot change operation identity, target UID, role, or request attributes", () => {
  const operation = createOperation();
  const conflicts = [
    { operationId: "operation-2" },
    { targetAuthUid: "auth-uid-2" },
    { requestedRole: "supervisor" },
    { displayName: "Different Technician" },
    { emailReservationKey: "different-opaque-key" },
    { requestFingerprint: "different-request" },
  ];
  for (const conflict of conflicts) {
    expectDomainError(() => domain.assertSameProvisioningIdentity(
      operation,
      {
        operationId: operation.operationId,
        targetAuthUid: operation.targetAuthUid,
        initiatingAdminUid: operation.initiatingAdminUid,
        requestedRole: operation.requestedRole,
        displayName: operation.displayName,
        emailReservationKey: operation.emailReservationKey,
        requestFingerprint: operation.requestFingerprint,
        ...conflict,
      },
    ), "identity_conflict");
  }
});

test("lease ownership, fencing tokens, expiry, and revisions reject stale workers", () => {
  let operation = acquire(createOperation(), "worker-a");
  const staleLease = operation.lease;
  expectDomainError(() => acquire(operation, "worker-b"), "lease_required");

  const expiredAt = operation.lease.expiresAt;
  operation = acquire(operation, "worker-b", expiredAt);
  assert.equal(operation.lease.fencingToken, staleLease.fencingToken + 1);

  expectDomainError(() => domain.applyProvisioningCommand(operation, {
    type: "start",
    commandId: "stale-worker-command",
    expectedRevision: operation.revision,
    ownerId: staleLease.ownerId,
    fencingToken: staleLease.fencingToken,
    at: plusSecond(expiredAt),
  }), "lease_required");

  expectDomainError(() => domain.applyProvisioningCommand(operation, {
    type: "start",
    commandId: "stale-revision-command",
    expectedRevision: operation.revision - 1,
    ownerId: operation.lease.ownerId,
    fencingToken: operation.lease.fencingToken,
    at: plusSecond(expiredAt),
  }), "stale_revision");
});

test("operation contract excludes secret fields and rejects non-opaque reservation values", () => {
  const operation = createOperation();
  assert.doesNotMatch(JSON.stringify(operation), /password|credential|token/i);
  expectDomainError(() => createOperation({ password: "must-not-persist" }), "invalid_operation");
  expectDomainError(() => createOperation({ emailReservationKey: "person@example.test" }), "invalid_operation");
  expectDomainError(() => createOperation({ requestFingerprint: "person@example.test" }), "invalid_operation");
  expectDomainError(() => domain.assertProvisioningOperation({ ...operation, password: "secret" }), "invalid_operation");
});

test("existing account status types stay limited to their established values", () => {
  const authTypes = readFileSync(
    new URL("../src/types/auth.ts", import.meta.url),
    "utf8",
  );
  assert.match(authTypes, /export type UserStatus =\s*\| "active"\s*\| "blocked"\s*\| "revoked";/);
  assert.doesNotMatch(authTypes, /"provisioning"/);
});

test("identical inputs and command sequences produce identical operation states", () => {
  const first = completeOperation();
  const second = completeOperation();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});






