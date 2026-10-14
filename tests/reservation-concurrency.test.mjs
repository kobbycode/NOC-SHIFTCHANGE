import assert from "node:assert/strict";
import test from "node:test";
import * as domain from "../src/lib/accounts/account-provisioning-domain.ts";
import * as keys from "../src/lib/accounts/reservation-key.ts";
import { createReservationPersistence } from "../src/lib/accounts/reservation-persistence-core.ts";
import { createTransactionalFirestore } from "./helpers/transactional-firestore.mjs";

const SECRET = "injected-test-only-reservation-key";
const CONFIG = { secret: SECRET, version: "v1" };
const BASE_TIME = Date.parse("2025-01-01T00:00:00.000Z");

function setup({ authorizeRecoveryAdministrator = async (uid) => uid === "admin-uid" } = {}) {
  const firestore = createTransactionalFirestore();
  let currentTime = BASE_TIME;
  const persistence = createReservationPersistence({
    firestore,
    domain,
    keys,
    now: () => new Date(currentTime),
    authorizeRecoveryAdministrator,
  });
  return {
    firestore,
    persistence,
    setTime(milliseconds) { currentTime = milliseconds; },
    now() { return new Date(currentTime).toISOString(); },
  };
}

function reserve(persistence, {
  email = "taylor@example.test",
  uid = "auth-uid-1",
  adminUid = "admin-uid",
  role = "technician",
  displayName = "Taylor Technician",
  fingerprint = "safe-request-fingerprint",
} = {}) {
  return persistence.reserveAccountOperation(
    email, uid, adminUid, role, displayName, fingerprint, CONFIG,
  );
}

async function acquire(setupValue, operation, ownerId = "worker-1", leaseMillis = BASE_TIME + 60_000) {
  return setupValue.persistence.acquirePersistedLease(
    operation, ownerId, new Date(leaseMillis).toISOString(),
  );
}

test("HMAC reservation keys normalize email and are deterministic, versioned, and opaque", () => {
  const key = keys.computeEmailReservationKey(" Taylor@Example.Test ", CONFIG);
  assert.equal(key, keys.computeEmailReservationKey("taylor@example.test", CONFIG));
  assert.match(key, /^hmac-sha256:v1:[0-9a-f]{64}$/);
  assert.equal(keys.validateReservationKey(key)?.version, "v1");
  assert.equal(key.includes("taylor"), false);
  assert.throws(() => keys.computeEmailReservationKey("x@example.test", { secret: "" }));
});

test("first reservation persists a pending operation and never an active user profile", async () => {
  const ctx = setup();
  const result = await reserve(ctx.persistence);
  assert.equal(result.newlyCreated, true);
  assert.equal(result.operation.stage, "reserved");
  assert.equal(result.operation.targetAuthUid, "auth-uid-1");
  assert.deepEqual(ctx.firestore.paths(), [`provisioning_reservations/${result.existingKey}`]);
  assert.equal(ctx.firestore.read(`users/${result.operation.targetAuthUid}`), undefined);
  assert.equal(result.operation.requestedRole, "technician");
});

test("identical retry returns the exact original operation and predetermined Auth UID", async () => {
  const ctx = setup();
  const first = await reserve(ctx.persistence);
  const retry = await reserve(ctx.persistence);
  assert.equal(retry.newlyCreated, false);
  assert.equal(retry.operation.operationId, first.operation.operationId);
  assert.equal(retry.operation.targetAuthUid, first.operation.targetAuthUid);
  assert.equal(ctx.firestore.paths().length, 1);
});

test("same-email retry rejects a conflicting role or identity", async () => {
  const ctx = setup();
  await reserve(ctx.persistence);
  await assert.rejects(reserve(ctx.persistence, { role: "supervisor" }), /identity_conflict/);
  await assert.rejects(reserve(ctx.persistence, { uid: "different-auth-uid" }), /identity_conflict/);
});

test("same-email retry rejects changes to display name and immutable request fingerprint", async () => {
  const ctx = setup();
  await reserve(ctx.persistence);
  await assert.rejects(reserve(ctx.persistence, { displayName: "Different Name" }), /identity_conflict/);
  await assert.rejects(reserve(ctx.persistence, { fingerprint: "different-safe-fingerprint" }), /identity_conflict/);
});
test("concurrent identical requests produce one reservation", async () => {
  const ctx = setup();
  const results = await Promise.all([reserve(ctx.persistence), reserve(ctx.persistence), reserve(ctx.persistence)]);
  assert.equal(results.filter((result) => result.newlyCreated).length, 1);
  assert.equal(new Set(results.map((result) => result.operation.operationId)).size, 1);
  assert.equal(ctx.firestore.paths().length, 1);
});

test("different emails map to distinct opaque reservation document IDs", async () => {
  const ctx = setup();
  const first = await reserve(ctx.persistence, { email: "alice@example.test" });
  const second = await reserve(ctx.persistence, { email: "bob@example.test", uid: "auth-uid-2" });
  assert.notEqual(first.existingKey, second.existingKey);
  assert.equal(ctx.firestore.paths().length, 2);
  assert.equal(ctx.firestore.paths().some((path) => path.includes("@")), false);
  assert.equal(JSON.stringify(ctx.firestore.paths()).includes("alice"), false);
});

test("persisted operation contains no password or credential fields", async () => {
  const ctx = setup();
  const result = await reserve(ctx.persistence);
  const persisted = ctx.firestore.read(`provisioning_reservations/${result.existingKey}`);
  const allKeys = JSON.stringify(Object.keys(persisted)).toLowerCase();
  for (const forbidden of ["password", "token", "credential", "verifier", "secret"]) {
    assert.equal(allKeys.includes(forbidden), false, `unexpected field fragment: ${forbidden}`);
  }
  assert.equal(JSON.stringify(persisted).includes(SECRET), false);
});

test("lease acquisition and renewal atomically increment revision while preserving fencing ownership", async () => {
  const ctx = setup();
  const reserved = (await reserve(ctx.persistence)).operation;
  const acquired = await acquire(ctx, reserved);
  assert.equal(acquired.lease?.ownerId, "worker-1");
  assert.equal(acquired.lease?.fencingToken, 1);
  assert.equal(acquired.revision, reserved.revision + 1);
  ctx.setTime(BASE_TIME + 1_000);
  const renewed = await ctx.persistence.renewPersistedLease(
    acquired,
    "worker-1",
    acquired.lease.fencingToken,
    new Date(BASE_TIME + 120_000).toISOString(),
  );
  assert.equal(renewed.revision, acquired.revision + 1);
  assert.equal(renewed.lease?.fencingToken, acquired.lease.fencingToken);
});

test("concurrent lease acquisition has exactly one current owner", async () => {
  const ctx = setup();
  const reserved = (await reserve(ctx.persistence)).operation;
  const attempts = await Promise.allSettled([
    acquire(ctx, reserved, "worker-a"),
    acquire(ctx, reserved, "worker-b"),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
});

test("expired lease recovery fences stale revision and fencing-token writers", async () => {
  const ctx = setup();
  const reserved = (await reserve(ctx.persistence)).operation;
  const oldLease = await acquire(ctx, reserved, "worker-old", BASE_TIME + 1_000);
  ctx.setTime(BASE_TIME + 2_000);
  const recovered = await ctx.persistence.recoverExpiredLease(
    oldLease,
    "admin-uid",
    new Date(BASE_TIME + 30_000).toISOString(),
    "admin-uid",
  );
  assert.equal(recovered.lease?.fencingToken, oldLease.lease?.fencingToken + 1);
  assert.equal(recovered.lease?.ownerId, "admin-uid");
  await assert.rejects(
    ctx.persistence.advancePersistedStage(oldLease, {
      type: "start", commandId: "stale-revision", expectedRevision: oldLease.revision,
      ownerId: "worker-old", fencingToken: oldLease.lease.fencingToken, at: ctx.now(),
    }),
    /stale_revision/,
  );
  await assert.rejects(
    ctx.persistence.advancePersistedStage(recovered, {
      type: "start", commandId: "stale-fence", expectedRevision: recovered.revision,
      ownerId: "admin-uid", fencingToken: oldLease.lease.fencingToken, at: ctx.now(),
    }),
    /lease_required/,
  );
});

test("expired-lease recovery rejects unauthorized actors", async () => {
  const ctx = setup();
  const reserved = (await reserve(ctx.persistence)).operation;
  const lease = await acquire(ctx, reserved, "worker-old", BASE_TIME + 1_000);
  ctx.setTime(BASE_TIME + 2_000);
  await assert.rejects(
    ctx.persistence.recoverExpiredLease(lease, "intruder", new Date(BASE_TIME + 30_000).toISOString(), "intruder"),
    (error) => error.code === "recovery_forbidden",
  );
});

test("completed reservation remains immutable and retries never replace it", async () => {
  const ctx = setup();
  let operation = (await reserve(ctx.persistence)).operation;
  const stages = [
    ["auth_create_pending", "auth_identity_matches"],
    ["claims_pending", "auth_identity_matches"],
    ["auth_enable_pending", "role_claim_matches"],
    ["finalize_pending", "auth_user_enabled"],
    ["completed", "finalization_committed"],
  ];
  for (const [index, [to, evidence]] of stages.entries()) {
    ctx.setTime(BASE_TIME + (index * 10_000));
    if (operation.lease === null) {
      operation = await acquire(ctx, operation, `worker-${index}`, BASE_TIME + (index * 10_000) + 60_000);
    }
    if (index === 0) {
      operation = await ctx.persistence.advancePersistedStage(operation, {
        type: "start", commandId: `start-${index}`, expectedRevision: operation.revision,
        ownerId: operation.lease.ownerId, fencingToken: operation.lease.fencingToken, at: ctx.now(),
      });
      continue;
    }
    operation = await ctx.persistence.advancePersistedStage(operation, {
      type: "advance", commandId: `advance-${index}`, expectedRevision: operation.revision,
      ownerId: operation.lease.ownerId, fencingToken: operation.lease.fencingToken,
      at: ctx.now(), to, evidence,
    });
  }
  assert.equal(operation.stage, "completed");
  assert.ok(operation.completedAt);
  await assert.rejects(acquire(ctx, operation), /immutable_operation/);
  const retry = await reserve(ctx.persistence);
  assert.equal(retry.newlyCreated, false);
  assert.equal(retry.operation.stage, "completed");
});

test("requires_review cannot progress without authorized explicit recovery decision", async () => {
  const ctx = setup();
  let operation = (await reserve(ctx.persistence)).operation;
  operation = await acquire(ctx, operation);
  operation = await ctx.persistence.advancePersistedStage(operation, {
    type: "record_failure", commandId: "uncertain", expectedRevision: operation.revision,
    ownerId: operation.lease.ownerId, fencingToken: operation.lease.fencingToken, at: ctx.now(),
    failure: { classification: "requires_review", outcome: "unknown", code: "firestore_finalize_unavailable", evidence: null },
  });
  assert.equal(operation.stage, "requires_review");
  await assert.rejects(
    ctx.persistence.recoverExpiredLease(operation, "intruder", new Date(BASE_TIME + 120_000).toISOString(), "intruder"),
    (error) => error.code === "recovery_forbidden",
  );
  ctx.setTime(BASE_TIME + 1_000);
  operation = await ctx.persistence.recoverExpiredLease(
    operation, "admin-uid", new Date(BASE_TIME + 120_000).toISOString(), "admin-uid",
  );
  await assert.rejects(
    ctx.persistence.advancePersistedStage(operation, {
      type: "start", commandId: "bypass-review", expectedRevision: operation.revision,
      ownerId: "admin-uid", fencingToken: operation.lease.fencingToken, at: ctx.now(),
    }),
    /review_decision_required/,
  );
  operation = await ctx.persistence.advancePersistedStage(operation, {
    type: "resolve_review", commandId: "decision", expectedRevision: operation.revision,
    ownerId: "admin-uid", fencingToken: operation.lease.fencingToken, at: ctx.now(),
    decision: { actorUid: "admin-uid", decisionId: "decision-1", action: "resume", outcome: "not_applied", evidence: "operation_reserved" },
  });
  assert.equal(operation.stage, "reserved");
  assert.equal(operation.lastRecoveryDecision?.actorUid, "admin-uid");
});

test("before-commit transaction failure leaves no reservation", async () => {
  const ctx = setup();
  ctx.firestore.failNextBeforeCommit();
  await assert.rejects(reserve(ctx.persistence), /mock_transaction_failed_before_commit/);
  assert.equal(ctx.firestore.paths().length, 0);
});

test("lost commit acknowledgement retry recovers original operation without duplication", async () => {
  const ctx = setup();
  ctx.firestore.loseNextCommitAcknowledgement();
  await assert.rejects(reserve(ctx.persistence), /mock_commit_acknowledgement_lost/);
  const retry = await reserve(ctx.persistence);
  assert.equal(retry.newlyCreated, false);
  assert.equal(retry.operation.targetAuthUid, "auth-uid-1");
  assert.equal(ctx.firestore.paths().length, 1);
});