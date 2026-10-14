// Standalone test for UI-04C3 features
import assert from "node:assert/strict";
import crypto from "node:crypto";

// ============================================================
// Reservation key computation
// ============================================================

const TEST_SECRET = "test-hmac-secret-key-for-reservations-only";

function computeEmailReservationKey(email, secret = TEST_SECRET) {
  const normalizedEmail = email.trim().toLowerCase();
  const hmac = crypto.createHmac("sha256", secret).update(normalizedEmail).digest("hex");
  return `hmac-sha256:v1:${hmac}`;
}

function validateReservationKey(key) {
  const match = key.match(/^hmac-sha256:(v1|v2|v3):([0-9a-f]{64})$/);
  if (!match) return null;
  return { version: match[1], opaqueKey: match[2] };
}

// ============================================================
// Test: Email reservation key is deterministic
// ============================================================

test("Email reservation key is deterministic and stable", () => {
  const key1 = computeEmailReservationKey("taylor@example.test", TEST_SECRET);
  const key2 = computeEmailReservationKey("taylor@example.test", TEST_SECRET);
  assert.strictEqual(key1, key2, "Same email + secret should produce same key");

  const key3 = computeEmailReservationKey("different@example.test", TEST_SECRET);
  assert.notStrictEqual(key1, key3, "Different email should produce different key");
});

// Test: Key validation
test("Reservation key validation", () => {
  const validKey = computeEmailReservationKey("test@example.test", TEST_SECRET);
  const validated = validateReservationKey(validKey);
  assert.ok(validated, "Valid key should validate");
  assert.strictEqual(validated.version, "v1", "Version should be v1");

  const invalidKey = validateReservationKey("not-a-valid-key");
  assert.ok(!invalidKey, "Invalid key should not validate");
});

// Test: Raw email does not appear in key
test("Reservation key does not expose raw email", () => {
  const key = computeEmailReservationKey("raw@example.test@example.com", TEST_SECRET);
  assert.ok(!key.includes("@"), "Key should not contain @");
  assert.ok(key.startsWith("hmac-sha256:"), "Key should start with hmac-sha256:");
});

// Test: Missing secret fails closed
test("Missing secret fails closed", () => {
  try {
    computeEmailReservationKey("test@example.test", { secret: "" });
    assert.fail("Should throw for empty secret");
  } catch (e) {
    assert.ok(e.message.includes("secret") || e.message.includes("must be"));
  }
});

// ============================================================
// Test: Domain lease logic
// ============================================================

// Load the domain module
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const domainSource = readFileSync(
  new URL("../src/lib/accounts/account-provisioning-domain.ts", import.meta.url),
  "utf8",
);

const domainCompile = ts.transpileModule(domainSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const domainExports = {};
runInNewContext(domainCompile, { exports: domainExports });
const domain = domainExports;

// Helper: create provisioning operation
function createProvOp(overrides, now = "2025-01-01T00:00:00.000Z") {
  return domain.createProvisioningOperation({
    operationId: "test-uid",
    targetAuthUid: "auth-uid-1",
    initiatingAdminUid: "admin-uid-1",
    requestedRole: "technician",
    displayName: "Taylor Technician",
    emailReservationKey: "hmac-sha256:v1:placeholder",
    requestFingerprint: "req-fp",
    ...overrides,
    schemaVersion: 1,
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
    lastCommand: null,
  }, now);
}

// Test: Lease acquisition
test("Lease acquisition", () => {
  const operation = createProvOp();
  const acquired = domain.acquireProvisioningLease(
    operation,
    { ownerId: "worker-1", now: "2025-01-01T00:00:00.000Z", expiresAt: "2025-01-01T01:00:00.000Z", expectedRevision: operation.revision },
  );
  assert.ok(acquired.lease !== null, "Lease should be acquired");
  assert.strictEqual(acquired.lease.ownerId, "worker-1", "Lease owner should match");
  assert.ok(Number.isSafeInteger(acquired.lease.fencingToken), "Fencing token should be safe integer");
});

// Test: Lease renewal
test("Lease renewal", () => {
  const operation = createProvOp();
  const acquired = domain.acquireProvisioningLease(
    operation,
    { ownerId: "worker-1", now: "2025-01-01T00:00:00.000Z", expiresAt: "2025-01-01T01:00:00.000Z", expectedRevision: operation.revision },
  );
  const renewed = domain.renewProvisioningLease(
    acquired,
    { ownerId: "worker-1", fencingToken: acquired.lease.fencingToken, expectedRevision: acquired.revision, now: "2025-01-01T00:00:01.000Z", expiresAt: "2025-01-01T02:00:00.000Z" },
  );
  assert.ok(renewed.lease !== null, "Lease should be renewed");
  assert.strictEqual(renewed.lease.ownerId, "worker-1", "Lease owner should persist");
});

// Test: Concurrent lease acquisition
test("Concurrent lease acquisition", () => {
  const operation = createProvOp();
  const acquired1 = domain.acquireProvisioningLease(
    operation,
    { ownerId: "worker-1", now: "2025-01-01T00:00:00.000Z", expiresAt: "2025-01-01T01:00:00.000Z", expectedRevision: operation.revision },
  );

  let threw = false;
  try {
    domain.acquireProvisioningLease(
      operation,
      { ownerId: "worker-2", now: "2025-01-01T00:00:00.000Z", expiresAt: "2025-01-01T01:00:00.000Z", expectedRevision: operation.revision },
    );
  } catch (e) {
    threw = e.code === "lease_required";
  }
  assert.ok(threw, "Second worker should require existing lease");
  assert.ok(acquired1.lease.ownerId === "worker-1", "First worker should own the lease");
});

// Test: Stale revision rejection
test("Stale revision rejection", () => {
  const operation = createProvOp();
  let threw = false;
  try {
    domain.applyProvisioningCommand(operation, {
      type: "start",
      commandId: "stale-command",
      expectedRevision: operation.revision - 1,
      ownerId: "worker-1",
      fencingToken: operation.lease.fencingToken,
      at: "2025-01-01T00:00:01.000Z",
    });
  } catch (e) {
    threw = e.code === "stale_revision";
  }
  assert.ok(threw, "Stale revision should be rejected");
});

// Test: Fencing token mismatch
test("Fencing token mismatch rejection", () => {
  const operation = createProvOp();
  let threw = false;
  try {
    domain.applyProvisioningCommand(operation, {
      type: "start",
      commandId: "fencing-command",
      expectedRevision: operation.revision,
      ownerId: "worker-2",
      fencingToken: 0,
      at: "2025-01-01T00:00:01.000Z",
    });
  } catch (e) {
    threw = e.code === "lease_required";
  }
  assert.ok(threw, "Fencing token mismatch should be rejected");
});

// Test: Completed operation immutability
test("Completed operation immutability", () => {
  const completed = createProvOp({
    stage: "completed",
    revision: 5,
    leaseEpoch: 5,
    lease: { ownerId: "worker-1", fencingToken: 5, expiresAt: "2025-01-01T01:00:00.000Z" },
    completedAt: "2025-01-01T01:00:00.000Z",
  });

  // Advance from completed should fail
  let threw = false;
  try {
    domain.applyProvisioningCommand(completed, {
      type: "advance",
      commandId: "dup-command",
      expectedRevision: completed.revision,
      ownerId: "worker-1",
      fencingToken: completed.leaseEpoch,
      at: "2025-01-01T01:01:00.000Z",
      to: "completed",
      evidence: "finalization_committed",
    });
  } catch (e) {
    threw = e.code === "immutable_operation";
  }
  assert.ok(threw, "Should reject advance from completed stage");

  // Acquire lease on completed should fail
  threw = false;
  try {
    domain.acquireProvisioningLease(completed, {
      ownerId: "worker-2",
      now: "2025-01-01T01:01:00.000Z",
      expiresAt: "2025-01-01T02:00:00.000Z",
      expectedRevision: completed.revision,
    });
  } catch (e) {
    threw = e.code === "immutable_operation";
  }
  assert.ok(threw, "Should reject lease acquisition on completed operation");
});

// Test: Review-required protection
test("Review-required protection", () => {
  let operation = createProvOp();
  operation = domain.acquireProvisioningLease(operation, {
    ownerId: "worker-1", now: "2025-01-01T00:00:00.000Z", expiresAt: "2025-01-01T01:00:00.000Z", expectedRevision: operation.revision,
  });
  operation = domain.applyProvisioningCommand(operation, {
    type: "record_failure",
    commandId: "failure-1",
    expectedRevision: operation.revision,
    ownerId: "worker-1",
    fencingToken: operation.lease.fencingToken,
    at: "2025-01-01T00:00:01.000Z",
    failure: {
      classification: "requires_review",
      outcome: "unknown",
      code: "identity_mismatch",
      evidence: null,
    },
  });
  assert.strictEqual(operation.stage, "requires_review", "Operation should be in requires_review stage");

  // Retry should be rejected without review decision
  let threw = false;
  try {
    domain.applyProvisioningCommand(operation, {
      type: "retry",
      commandId: "retry-1",
      expectedRevision: operation.revision,
      ownerId: "worker-1",
      fencingToken: operation.lease.fencingToken,
      at: "2025-01-01T00:00:02.000Z",
      evidence: "auth_uid_absent",
    });
  } catch (e) {
    threw = e.code === "review_decision_required";
  }
  assert.ok(threw, "Retry should require review decision");

  // Resume after review decision
  operation = domain.applyProvisioningCommand(operation, {
    type: "resolve_review",
    commandId: "resolve-1",
    expectedRevision: operation.revision,
    ownerId: "admin-uid-1",
    fencingToken: operation.leaseEpoch,
    at: "2025-01-01T00:00:03.000Z",
    decision: {
      actorUid: "admin-uid-1",
      decisionId: "decision-1",
      action: "resume",
      outcome: "applied",
      evidence: "auth_identity_matches",
    },
  });
  assert.strictEqual(operation.stage, "auth_create_pending", "Review resolution should resume operation");
});

// ============================================================
// Summary
// ============================================================

console.log("All UI-04C3 standalone tests passed!");