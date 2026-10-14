import assert from "node:assert/strict";
import test from "node:test";
import * as domain from "../src/lib/accounts/account-provisioning-domain.ts";
import * as keys from "../src/lib/accounts/reservation-key.ts";
import { createAuthProvisioningAdapter } from "../src/lib/accounts/auth-provisioning-adapter-core.ts";

const KEY_CONFIG = { secret: "injected-auth-adapter-test-key", version: "v1" };
const NOW = "2025-02-01T00:00:00.000Z";
const PASSWORD = "Test initial password 123!";

function makeOperation(email, stage = "auth_create_pending", requestedRole = "technician") {
  const normalizedEmail = email.trim().toLowerCase();
  let operation = domain.createProvisioningOperation({
    operationId: "reservation-auth-adapter-test",
    targetAuthUid: "reserved-auth-uid",
    initiatingAdminUid: "admin-uid",
    requestedRole,
    displayName: "Morgan Technician",
    emailReservationKey: keys.computeEmailReservationKey(normalizedEmail, KEY_CONFIG),
    requestFingerprint: "safe-test-fingerprint",
  }, NOW);
  if (stage === "reserved") return operation;
  operation = domain.acquireProvisioningLease(operation, {
    ownerId: "provisioner",
    now: "2025-02-01T00:00:01.000Z",
    expiresAt: "2025-02-01T01:00:00.000Z",
    expectedRevision: operation.revision,
  });
  operation = domain.applyProvisioningCommand(operation, {
    type: "start",
    commandId: "start-auth-create",
    expectedRevision: operation.revision,
    ownerId: "provisioner",
    fencingToken: operation.lease.fencingToken,
    at: "2025-02-01T00:00:02.000Z",
  });
  if (stage === "auth_create_pending") return operation;
  if (stage !== "claims_pending") throw new Error("unsupported_test_stage");
  operation = domain.applyProvisioningCommand(operation, {
    type: "advance",
    commandId: "auth-identity-confirmed",
    expectedRevision: operation.revision,
    ownerId: "provisioner",
    fencingToken: operation.lease.fencingToken,
    at: "2025-02-01T00:00:03.000Z",
    to: "claims_pending",
    evidence: "auth_identity_matches",
  });
  return operation;
}

function createMockAuth({
  initialUsers = [],
  throwAfterCreate = false,
  createErrorCode = "auth/internal-error",
  throwAfterClaims = false,
} = {}) {
  const users = new Map(initialUsers.map((user) => [user.uid, structuredClone(user)]));
  const calls = { create: [], getUser: [], getUserByEmail: [], setClaims: [] };
  let didThrowAfterCreate = false;
  let didThrowAfterClaims = false;
  const auth = {
    calls,
    users,
    async createUser(properties) {
      calls.create.push({ ...properties });
      if (users.has(properties.uid)) throw Object.assign(new Error("reserved_uid_exists"), { code: "auth/uid-already-exists" });
      if ([...users.values()].some((user) => user.email?.toLowerCase() === properties.email.toLowerCase())) {
        throw Object.assign(new Error("email_exists"), { code: "auth/email-already-exists" });
      }
      if (createErrorCode && !throwAfterCreate) {
        throw Object.assign(new Error("auth_unavailable"), { code: createErrorCode });
      }
      const user = {
        uid: properties.uid,
        email: properties.email,
        disabled: properties.disabled,
        customClaims: {},
      };
      users.set(user.uid, structuredClone(user));
      if (throwAfterCreate && !didThrowAfterCreate) {
        didThrowAfterCreate = true;
        throw Object.assign(new Error("create_acknowledgement_lost"), { code: "auth/internal-error" });
      }
      return structuredClone(user);
    },
    async getUser(uid) {
      calls.getUser.push(uid);
      const user = users.get(uid);
      if (!user) throw Object.assign(new Error("user_missing"), { code: "auth/user-not-found" });
      return structuredClone(user);
    },
    async getUserByEmail(email) {
      calls.getUserByEmail.push(email);
      const user = [...users.values()].find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
      if (!user) throw Object.assign(new Error("user_missing"), { code: "auth/user-not-found" });
      return structuredClone(user);
    },
    async setCustomUserClaims(uid, customClaims) {
      calls.setClaims.push({ uid, claims: structuredClone(customClaims) });
      const user = users.get(uid);
      if (!user) throw Object.assign(new Error("user_missing"), { code: "auth/user-not-found" });
      users.set(uid, { ...user, customClaims: structuredClone(customClaims) });
      if (throwAfterClaims && !didThrowAfterClaims) {
        didThrowAfterClaims = true;
        throw Object.assign(new Error("claims_acknowledgement_lost"), { code: "auth/internal-error" });
      }
    },
  };
  return auth;
}

function makeAdapter(auth) {
  return createAuthProvisioningAdapter({
    auth,
    domain,
    keys,
    reservationKeyConfig: KEY_CONFIG,
  });
}

const userFor = (operation, email, overrides = {}) => ({
  uid: operation.targetAuthUid,
  email,
  disabled: true,
  customClaims: {},
  ...overrides,
});

test("creates a disabled Auth identity at the reserved UID and normalized email", async () => {
  const email = " Morgan@Example.Test ";
  const operation = makeOperation(email);
  const auth = createMockAuth({ createErrorCode: null });
  const result = await makeAdapter(auth).createDisabledAuthUser(operation, email, PASSWORD);
  assert.equal(result.outcome, "created");
  assert.equal(result.user.uid, operation.targetAuthUid);
  assert.equal(result.user.email, "morgan@example.test");
  assert.equal(result.user.disabled, true);
  assert.deepEqual(auth.calls.create[0], {
    uid: operation.targetAuthUid,
    email: "morgan@example.test",
    password: PASSWORD,
    displayName: operation.displayName,
    emailVerified: false,
    disabled: true,
  });
});

test("reconciles create success followed by a lost acknowledgement without treating password as known", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email);
  const auth = createMockAuth({ throwAfterCreate: true, createErrorCode: null });
  const result = await makeAdapter(auth).createDisabledAuthUser(operation, email, PASSWORD);
  assert.equal(result.outcome, "recovered");
  assert.equal(result.user.uid, operation.targetAuthUid);
  assert.equal(result.user.disabled, true);
  assert.equal(result.passwordState, "unknown");
  assert.equal(result.requiresReview, true);
});

test("a retry recovers the same reserved UID and never replaces its password", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email);
  const auth = createMockAuth({ throwAfterCreate: true, createErrorCode: null });
  const adapter = makeAdapter(auth);
  await adapter.createDisabledAuthUser(operation, email, PASSWORD);
  const recovered = await adapter.createDisabledAuthUser(operation, email, "Different retry password 456!");
  assert.equal(recovered.outcome, "recovered");
  assert.equal(recovered.user.uid, "reserved-auth-uid");
  assert.equal(recovered.passwordState, "unknown");
  assert.equal(auth.calls.create.length, 2);
  assert.equal(auth.users.get("reserved-auth-uid").uid, operation.targetAuthUid);
});

test("an existing disabled UID with the reserved email is recovered but requires password review", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email);
  const auth = createMockAuth({ initialUsers: [userFor(operation, email)] });
  const result = await makeAdapter(auth).createDisabledAuthUser(operation, email, PASSWORD);
  assert.equal(result.outcome, "recovered");
  assert.equal(result.passwordState, "unknown");
  assert.equal(result.reviewReason, "password_state_unknown");
});

test("an existing reserved UID with a conflicting email requires review", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email);
  const auth = createMockAuth({ initialUsers: [userFor(operation, "other@example.test")] });
  const result = await makeAdapter(auth).createDisabledAuthUser(operation, email, PASSWORD);
  assert.deepEqual(result, { outcome: "requires_review", reason: "uid_identity_conflict" });
});

test("an email owned by a different Auth UID requires review", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email);
  const auth = createMockAuth({ initialUsers: [{
    uid: "different-auth-uid", email, disabled: true, customClaims: {},
  }] });
  const result = await makeAdapter(auth).createDisabledAuthUser(operation, email, PASSWORD);
  assert.deepEqual(result, { outcome: "requires_review", reason: "email_owned_by_other_uid" });
});

test("temporary Auth failure is retryable only after authoritative UID and email absence", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email);
  const auth = createMockAuth({ createErrorCode: "auth/internal-error" });
  const result = await makeAdapter(auth).createDisabledAuthUser(operation, email, PASSWORD);
  assert.deepEqual(result, { outcome: "retryable_failure", reason: "auth_temporarily_unavailable" });
  assert.equal(auth.calls.getUser.length, 1);
  assert.equal(auth.calls.getUserByEmail.length, 1);
});

test("a confirmed Auth rejection is distinct from an ambiguous service failure", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email);
  const auth = createMockAuth({ createErrorCode: "auth/weak-password" });
  const result = await makeAdapter(auth).createDisabledAuthUser(operation, email, PASSWORD);
  assert.deepEqual(result, { outcome: "confirmed_failure", reason: "auth_rejected_request" });
  await assert.rejects(
    makeAdapter(auth).createDisabledAuthUser(operation, email, "short"),
    (error) => error.code === "invalid_password",
  );
});

test("role claims are applied from the immutable operation and existing claims are preserved", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email, "claims_pending", "technician");
  const auth = createMockAuth({ initialUsers: [userFor(operation, email, {
    customClaims: { mustChangePassword: true, securityMarker: "preserve" },
  })] });
  const result = await makeAdapter(auth).applyRoleClaims(operation, email);
  assert.equal(result.outcome, "applied");
  assert.deepEqual(auth.calls.setClaims[0].claims, {
    mustChangePassword: true,
    securityMarker: "preserve",
    role: "technician",
  });
  assert.equal(result.user.role, "technician");
});

test("claims applied before a lost acknowledgement are recovered by authoritative read", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email, "claims_pending");
  const auth = createMockAuth({
    initialUsers: [userFor(operation, email, { customClaims: { existingSecurityClaim: true } })],
    throwAfterClaims: true,
  });
  const result = await makeAdapter(auth).applyRoleClaims(operation, email);
  assert.equal(result.outcome, "recovered");
  assert.equal(result.user.role, "technician");
  assert.equal(auth.users.get(operation.targetAuthUid).customClaims.existingSecurityClaim, true);
});

test("conflicting existing role claims are not overwritten", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email, "claims_pending", "technician");
  const auth = createMockAuth({ initialUsers: [userFor(operation, email, {
    customClaims: { role: "supervisor", securityMarker: "preserve" },
  })] });
  const result = await makeAdapter(auth).applyRoleClaims(operation, email);
  assert.deepEqual(result, { outcome: "requires_review", reason: "role_claim_conflict" });
  assert.equal(auth.calls.setClaims.length, 0);
});

test("state verification requires the reserved UID, email, role claim, and disabled state", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email, "claims_pending");
  const auth = createMockAuth({ initialUsers: [userFor(operation, email, {
    customClaims: { role: "technician" },
  })] });
  const result = await makeAdapter(auth).verifyAuthState(operation, email);
  assert.equal(result.outcome, "verified");
  assert.equal(result.user.disabled, true);
});

test("unexpectedly enabled accounts are reported and never changed by the adapter", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email, "claims_pending");
  const auth = createMockAuth({ initialUsers: [userFor(operation, email, {
    disabled: false,
    customClaims: { role: "technician" },
  })] });
  const verified = await makeAdapter(auth).verifyAuthState(operation, email);
  assert.deepEqual(verified, { outcome: "mismatch", reasons: ["account_enabled"] });
  const creationRecovery = await makeAdapter(auth).createDisabledAuthUser(
    makeOperation(email), email, PASSWORD,
  );
  assert.deepEqual(creationRecovery, { outcome: "requires_review", reason: "account_enabled" });
  assert.equal(auth.users.get(operation.targetAuthUid).disabled, false);
});

test("password never appears in adapter results, operation data, or logs", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email);
  const auth = createMockAuth({ createErrorCode: null });
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  try {
    const result = await makeAdapter(auth).createDisabledAuthUser(operation, email, PASSWORD);
    assert.equal(JSON.stringify(result).includes(PASSWORD), false);
    assert.equal(JSON.stringify(operation).includes(PASSWORD), false);
    assert.equal(JSON.stringify(logs).includes(PASSWORD), false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("the adapter surface has no delete or password-update operation", async () => {
  const email = "morgan@example.test";
  const operation = makeOperation(email);
  const auth = createMockAuth({ createErrorCode: null });
  const result = await makeAdapter(auth).createDisabledAuthUser(operation, email, PASSWORD);
  assert.equal(result.outcome, "created");
  assert.equal("deleteUser" in auth, false);
  assert.equal("updateUser" in auth, false);
  assert.equal(auth.users.get(operation.targetAuthUid).disabled, true);
});