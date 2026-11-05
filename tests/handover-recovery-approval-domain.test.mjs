/**
 * Phase 8C.2b — network-free contract tests for the dual-approval substrate.
 *
 * No emulator, no Firebase and no route module is loaded. These tests pin the
 * parts that must hold without a database:
 *   - Version 1 is permanently non-executable and exposes no executable state;
 *   - intent, request, audit and reissue identities are deterministic and
 *     sensitive to every authoritative field they bind;
 *   - a password proof is single-actor, single-role, single-intent, single
 *     request and valid for exactly 60 seconds;
 *   - signatures append only, never replace, and always pair one supervisor
 *     with one administrator;
 *   - the 24-hour intent lifetime is derived, not written by a scheduler;
 *   - request bodies cannot smuggle executable flags, bindings or roles.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HANDOVER_RECOVERY_APPROVAL_ACTION,
  HANDOVER_RECOVERY_APPROVAL_COLLECTION,
  HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES,
  HANDOVER_RECOVERY_APPROVAL_SCHEMA,
  HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION,
  HANDOVER_RECOVERY_APPROVAL_STATUSES,
  HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
} from "../src/types/handover-recovery-approval.ts";
import {
  HANDOVER_RECOVERY_APPROVAL_ID_PREFIX,
  HANDOVER_RECOVERY_APPROVAL_INTENT_MAX_AGE_MS,
  HANDOVER_RECOVERY_APPROVAL_PROOF_MAX_AGE_MS,
  HANDOVER_RECOVERY_APPROVAL_PROOF_SCHEMA,
  HandoverRecoveryApprovalError,
  HandoverRecoveryApprovalInputError,
  approvalDigest,
  approvalReason,
  assertApprovalIntentNotExpired,
  assertApprovalSignatureAppendable,
  assertHandoverRecoveryApprovalProof,
  assertHandoverRecoveryApprovalRecord,
  assertRequiredApprovalPair,
  canonicalApprovalMaterial,
  complementaryApprovalRole,
  createHandoverRecoveryApprovalAuditId,
  createHandoverRecoveryApprovalId,
  createHandoverRecoveryApprovalProof,
  createHandoverRecoveryApprovalRequestHash,
  createHandoverRecoveryApprovalView,
  createHandoverRecoveryIntentFingerprint,
  createHandoverRecoveryReissueApprovalId,
  evaluateHandoverRecoveryApprovalEffectiveStatus,
  idempotencyKey,
  parseHandoverRecoveryApprovalCountersignBody,
  parseHandoverRecoveryApprovalReissueBody,
  parseHandoverRecoveryApprovalRequestBody,
  parseHandoverRecoveryApprovalVoidBody,
  requiredSecondApprovalRole,
  validHandoverDocumentId,
  validHandoverRecoveryApprovalId,
} from "../src/lib/operations/handover-recovery-approval-domain.ts";

const NOW = "2026-11-01T09:00:00.000Z";
const HANDOVER = "handover_v2_shift-outgoing";
const SUPERVISOR_UID = "approval-supervisor";
const ADMIN_UID = "approval-admin";
const REASON = "Recover the stalled outgoing handover after review.";
const IDEMPOTENCY_KEY = "recovery-key-0001";

function binding(overrides = {}) {
  return {
    aggregateRevision: 4,
    aggregateSnapshotHash: "a".repeat(64),
    aggregateLifecycleStatus: "awaiting_incoming_acceptance",
    guardId: "guard_outgoing",
    guardRevision: 7,
    fencingEpoch: 2,
    slotToken: "10000000-0000-4000-8000-000000000001",
    slotGeneration: 1,
    successorSlotToken: "20000000-0000-4000-8000-000000000002",
    successorSlotGeneration: 2,
    reviewCaseId: "review_case_x",
    reviewCaseStatus: "under_investigation",
    reviewCaseRevision: 3,
    reviewCaseFingerprint: "b".repeat(64),
    ...overrides,
  };
}

function proofInput(overrides = {}) {
  return {
    actorUid: SUPERVISOR_UID,
    actorRole: "supervisor",
    intentFingerprint: createHandoverRecoveryIntentFingerprint(binding()),
    requestNonce: "nonce-0001",
    verifiedAt: NOW,
    authAccountCheckedAt: NOW,
    verifiedAtMonotonicMs: 1_000,
    ...overrides,
  };
}

function signature(overrides = {}) {
  return {
    actorUid: SUPERVISOR_UID,
    actorRole: "supervisor",
    proofFingerprint: "c".repeat(64),
    approvedAt: NOW,
    proofExpiresAt: "2026-11-01T09:01:00.000Z",
    ...overrides,
  };
}

function record(overrides = {}) {
  const intentFingerprint = createHandoverRecoveryIntentFingerprint(binding());
  return {
    schema: HANDOVER_RECOVERY_APPROVAL_SCHEMA,
    schemaVersion: HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION,
    id: createHandoverRecoveryApprovalId({ handoverDocumentId: HANDOVER, intentFingerprint }),
    action: HANDOVER_RECOVERY_APPROVAL_ACTION,
    handoverDocumentId: HANDOVER,
    outgoingShiftId: "shift-outgoing",
    incomingShiftId: "shift-incoming",
    binding: binding(),
    intentFingerprint,
    recoveryExecutionEligible: false,
    nonExecutableReason: HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
    reason: REASON,
    requestedBy: SUPERVISOR_UID,
    requestedAt: NOW,
    expiresAt: "2026-11-02T09:00:00.000Z",
    approvals: [signature()],
    requestHash: createHandoverRecoveryApprovalRequestHash({
      requestedBy: SUPERVISOR_UID,
      handoverDocumentId: HANDOVER,
      intentFingerprint,
      reason: REASON,
    }),
    revision: 1,
    status: HANDOVER_RECOVERY_APPROVAL_STATUSES.AWAITING_SECOND_APPROVAL,
    replacesApprovalId: null,
    reissuedAsApprovalId: null,
    requestAuditId: "request_audit",
    countersignAuditId: null,
    voidAuditId: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function requestBody(overrides = {}) {
  return {
    handoverDocumentId: HANDOVER,
    reason: REASON,
    idempotencyKey: IDEMPOTENCY_KEY,
    password: "current-password",
    ...overrides,
  };
}

const failsWith = (code) => (error) => {
  assert.ok(error instanceof HandoverRecoveryApprovalError, `expected domain error, got ${error}`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
  return true;
};

const failsInput = (error) => {
  assert.ok(error instanceof HandoverRecoveryApprovalInputError, `expected input error, got ${error}`);
  return true;
};

// ---------------------------------------------------------------------------
// 1. Version 1 is permanently non-executable
// ---------------------------------------------------------------------------

test("the persisted contract names a versioned, non-executable approval", () => {
  assert.equal(HANDOVER_RECOVERY_APPROVAL_SCHEMA, "handover-recovery-approval-v1");
  assert.equal(HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION, 1);
  assert.equal(HANDOVER_RECOVERY_APPROVAL_COLLECTION, "handover_recovery_approvals_v1");
  assert.equal(HANDOVER_RECOVERY_APPROVAL_ACTION, "abandon_stalled_handover");
  assert.equal(
    HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
    "schema_version_1_binds_no_authoritative_evidence_digest",
  );
});

test("no executable, consumed or completed state exists", () => {
  assert.deepEqual(
    Object.values(HANDOVER_RECOVERY_APPROVAL_STATUSES).sort(),
    ["awaiting_second_approval", "fully_approved", "voided"],
  );
  assert.deepEqual(
    Object.values(HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES).sort(),
    ["awaiting_second_approval", "expired", "fully_approved", "voided"],
  );
  for (const forbidden of ["executable", "executed", "consumed", "completed", "recovered"]) {
    assert.ok(!Object.values(HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES).includes(forbidden));
  }
});

test("a valid stored record always reads back as non-executable", () => {
  const stored = assertHandoverRecoveryApprovalRecord(record(), record().id);
  assert.equal(stored.recoveryExecutionEligible, false);
  const view = createHandoverRecoveryApprovalView(stored, NOW);
  assert.equal(view.recoveryExecutionEligible, false);
  assert.equal(view.effectiveStatus, "awaiting_second_approval");
  assert.equal(view.approvalCount, 1);
  assert.equal(view.requiredSecondRole, "admin");
});

// ---------------------------------------------------------------------------
// 2. Deterministic identities
// ---------------------------------------------------------------------------

test("the intent fingerprint is canonical and deterministic", () => {
  const first = createHandoverRecoveryIntentFingerprint(binding());
  const second = createHandoverRecoveryIntentFingerprint(binding());
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(
    first,
    approvalDigest("handover-recovery-approval-intent-v1", {
      schemaVersion: 1,
      action: "abandon_stalled_handover",
      binding: binding(),
    }),
  );
});

test("the intent fingerprint changes for every bound field", () => {
  const base = createHandoverRecoveryIntentFingerprint(binding());
  const variations = {
    aggregateRevision: 5,
    aggregateSnapshotHash: "d".repeat(64),
    aggregateLifecycleStatus: "completed",
    guardId: "guard_other",
    guardRevision: 8,
    fencingEpoch: 3,
    slotToken: "10000000-0000-4000-8000-000000000009",
    slotGeneration: 2,
    successorSlotToken: "20000000-0000-4000-8000-000000000009",
    successorSlotGeneration: 3,
    reviewCaseId: "review_case_y",
    reviewCaseStatus: "closed",
    reviewCaseRevision: 4,
    reviewCaseFingerprint: "e".repeat(64),
  };
  const seen = new Set([base]);
  for (const [field, value] of Object.entries(variations)) {
    const changed = createHandoverRecoveryIntentFingerprint(binding({ [field]: value }));
    assert.notEqual(changed, base, `${field} must influence the fingerprint`);
    seen.add(changed);
  }
  assert.equal(seen.size, Object.keys(variations).length + 1);
});

test("an absent guard and absent review case are bound explicitly", () => {
  const fingerprint = createHandoverRecoveryIntentFingerprint(
    binding({ guardId: null, guardRevision: 0, fencingEpoch: 0, reviewCaseStatus: "none", reviewCaseRevision: 0, reviewCaseFingerprint: null }),
  );
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(fingerprint, createHandoverRecoveryIntentFingerprint(binding()));
});

test("the approval identity is derived from the handover and the intent", () => {
  const intentFingerprint = createHandoverRecoveryIntentFingerprint(binding());
  const id = createHandoverRecoveryApprovalId({ handoverDocumentId: HANDOVER, intentFingerprint });
  assert.ok(id.startsWith(HANDOVER_RECOVERY_APPROVAL_ID_PREFIX));
  assert.equal(id, createHandoverRecoveryApprovalId({ handoverDocumentId: HANDOVER, intentFingerprint }));
  assert.notEqual(
    id,
    createHandoverRecoveryApprovalId({ handoverDocumentId: "handover_v2_other", intentFingerprint }),
  );
  assert.notEqual(
    id,
    createHandoverRecoveryApprovalId({
      handoverDocumentId: HANDOVER,
      intentFingerprint: createHandoverRecoveryIntentFingerprint(binding({ guardRevision: 8 })),
    }),
  );
  assert.ok(validHandoverRecoveryApprovalId(id));
});

test("the reissue identity is new and derived from the voided identity plus the key", () => {
  const voidedApprovalId = "handover_recovery_approval_v1_" + "f".repeat(40);
  const reissued = createHandoverRecoveryReissueApprovalId({
    voidedApprovalId,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.ok(validHandoverRecoveryApprovalId(reissued));
  assert.notEqual(reissued, voidedApprovalId);
  assert.equal(
    reissued,
    createHandoverRecoveryReissueApprovalId({ voidedApprovalId, idempotencyKey: IDEMPOTENCY_KEY }),
  );
  assert.notEqual(
    reissued,
    createHandoverRecoveryReissueApprovalId({ voidedApprovalId, idempotencyKey: "recovery-key-0002" }),
  );
  assert.notEqual(
    reissued,
    createHandoverRecoveryReissueApprovalId({
      voidedApprovalId: "handover_recovery_approval_v1_" + "e".repeat(40),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
  );
});

test("audit identities are distinct per event and per discriminator", () => {
  const approvalId = "handover_recovery_approval_v1_" + "f".repeat(40);
  const requested = createHandoverRecoveryApprovalAuditId({ approvalId, event: "requested" });
  const countersigned = createHandoverRecoveryApprovalAuditId({ approvalId, event: "countersigned", discriminator: ADMIN_UID });
  const voidedA = createHandoverRecoveryApprovalAuditId({ approvalId, event: "voided", discriminator: "key-a" });
  const voidedB = createHandoverRecoveryApprovalAuditId({ approvalId, event: "voided", discriminator: "key-b" });
  assert.equal(new Set([requested, countersigned, voidedA, voidedB]).size, 4);
  assert.equal(requested, createHandoverRecoveryApprovalAuditId({ approvalId, event: "requested" }));
  assert.throws(
    () => createHandoverRecoveryApprovalAuditId({ approvalId, event: "executed" }),
    failsInput,
  );
});

test("the request hash binds the requester, handover, intent and reason", () => {
  const intentFingerprint = createHandoverRecoveryIntentFingerprint(binding());
  const base = createHandoverRecoveryApprovalRequestHash({
    requestedBy: SUPERVISOR_UID,
    handoverDocumentId: HANDOVER,
    intentFingerprint,
    reason: REASON,
  });
  const variants = [
    { requestedBy: ADMIN_UID, handoverDocumentId: HANDOVER, intentFingerprint, reason: REASON },
    { requestedBy: SUPERVISOR_UID, handoverDocumentId: "handover_v2_other", intentFingerprint, reason: REASON },
    { requestedBy: SUPERVISOR_UID, handoverDocumentId: HANDOVER, intentFingerprint: "f".repeat(64), reason: REASON },
    { requestedBy: SUPERVISOR_UID, handoverDocumentId: HANDOVER, intentFingerprint, reason: REASON + " " },
  ];
  for (const variant of variants) {
    assert.notEqual(createHandoverRecoveryApprovalRequestHash(variant), base);
  }
  assert.equal(
    createHandoverRecoveryApprovalRequestHash({
      requestedBy: SUPERVISOR_UID,
      handoverDocumentId: HANDOVER,
      intentFingerprint,
      reason: REASON,
    }),
    base,
  );
});

test("canonical material is key-order independent", () => {
  assert.equal(
    canonicalApprovalMaterial({ b: 1, a: [{ d: 2, c: 3 }] }),
    canonicalApprovalMaterial({ a: [{ c: 3, d: 2 }], b: 1 }),
  );
});

// ---------------------------------------------------------------------------
// 3. The 60-second personal password proof
// ---------------------------------------------------------------------------

test("a proof expires exactly 60 seconds after verification", () => {
  const proof = createHandoverRecoveryApprovalProof(proofInput());
  assert.equal(proof.schema, HANDOVER_RECOVERY_APPROVAL_PROOF_SCHEMA);
  assert.equal(proof.proofExpiresAt, "2026-11-01T09:01:00.000Z");
  assert.equal(
    Date.parse(proof.proofExpiresAt) - Date.parse(proof.verifiedAt),
    HANDOVER_RECOVERY_APPROVAL_PROOF_MAX_AGE_MS,
  );
  assert.match(proof.proofFingerprint, /^[0-9a-f]{64}$/);
});

test("a proof carries no credential material and no caller-visible secret", () => {
  const proof = createHandoverRecoveryApprovalProof(proofInput());
  assert.deepEqual(Object.keys(proof).sort(), [
    "actorRole",
    "actorUid",
    "authAccountCheckedAt",
    "intentFingerprint",
    "proofExpiresAt",
    "proofFingerprint",
    "requestNonce",
    "schema",
    "verifiedAt",
    "verifiedAtMonotonicMs",
  ]);
  const serialized = JSON.stringify(proof);
  assert.doesNotMatch(serialized, /password|idToken|refreshToken|cookie/i);
});

test("a proof is accepted inside its window and refused after it", () => {
  const proof = createHandoverRecoveryApprovalProof(proofInput());
  const expect = {
    proof,
    expectedActorUid: SUPERVISOR_UID,
    expectedActorRole: "supervisor",
    expectedIntentFingerprint: proofInput().intentFingerprint,
    expectedRequestNonce: "nonce-0001",
  };
  assert.equal(
    assertHandoverRecoveryApprovalProof({ ...expect, nowIso: NOW, nowMonotonicMs: 1_000 }).actorUid,
    SUPERVISOR_UID,
  );
  assert.equal(
    assertHandoverRecoveryApprovalProof({
      ...expect,
      nowIso: "2026-11-01T09:00:59.999Z",
      nowMonotonicMs: 60_999,
    }).actorUid,
    SUPERVISOR_UID,
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({
      ...expect,
      nowIso: "2026-11-01T09:01:00.000Z",
      nowMonotonicMs: 61_000,
    }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_EXPIRED"),
  );
  // The monotonic clock alone must also close the window, even if the wall
  // clock still looks recent.
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({
      ...expect,
      nowIso: "2026-11-01T09:00:30.000Z",
      nowMonotonicMs: 61_000,
    }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_EXPIRED"),
  );
});

test("a proof cannot be replayed for another actor, role, request or intent", () => {
  const proof = createHandoverRecoveryApprovalProof(proofInput());
  const base = {
    proof,
    expectedActorUid: SUPERVISOR_UID,
    expectedActorRole: "supervisor",
    expectedIntentFingerprint: proofInput().intentFingerprint,
    expectedRequestNonce: "nonce-0001",
    nowIso: NOW,
    nowMonotonicMs: 1_000,
  };
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, expectedActorUid: ADMIN_UID }),
    failsWith("RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, expectedActorRole: "admin" }),
    failsWith("RECOVERY_APPROVAL_ROLE_CONFLICT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, expectedRequestNonce: "nonce-0002" }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, expectedIntentFingerprint: "f".repeat(64) }),
    failsWith("RECOVERY_APPROVAL_STALE"),
  );
});

test("a tampered or extended proof is refused", () => {
  const proof = createHandoverRecoveryApprovalProof(proofInput());
  const base = {
    expectedActorUid: SUPERVISOR_UID,
    expectedActorRole: "supervisor",
    expectedIntentFingerprint: proofInput().intentFingerprint,
    expectedRequestNonce: "nonce-0001",
    nowIso: NOW,
    nowMonotonicMs: 1_000,
  };
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, proof: { ...proof, actorUid: ADMIN_UID } }),
    failsWith("RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, proof: { ...proof, proofFingerprint: "d".repeat(64) } }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, proof: { ...proof, verifiedAtMonotonicMs: 0 } }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, proof: { ...proof, password: "leak" } }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, proof: { ...proof, proofExpiresAt: "2026-11-01T09:59:00.000Z" } }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, proof: { ...proof, schema: "proof-v2" } }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
});

test("the authentication clocks refuse to move backwards", () => {
  const proof = createHandoverRecoveryApprovalProof(proofInput());
  const base = {
    proof,
    expectedActorUid: SUPERVISOR_UID,
    expectedActorRole: "supervisor",
    expectedIntentFingerprint: proofInput().intentFingerprint,
    expectedRequestNonce: "nonce-0001",
  };
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, nowIso: "2026-11-01T08:59:59.000Z", nowMonotonicMs: 2_000 }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalProof({ ...base, nowIso: NOW, nowMonotonicMs: 999 }),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
  assert.throws(
    () => createHandoverRecoveryApprovalProof(proofInput({ authAccountCheckedAt: "2026-11-01T08:59:59.999Z" })),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
});

test("a proof requires normalized inputs", () => {
  for (const bad of [
    { actorUid: "" },
    { actorUid: " padded" },
    { actorRole: "technician" },
    { requestNonce: "" },
    { verifiedAt: "2026-11-01 09:00:00" },
    { verifiedAtMonotonicMs: -1 },
    { verifiedAtMonotonicMs: 1.5 },
  ]) {
    assert.throws(
      () => createHandoverRecoveryApprovalProof(proofInput(bad)),
      (error) =>
        error instanceof HandoverRecoveryApprovalError || error instanceof HandoverRecoveryApprovalInputError,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Signature pairing
// ---------------------------------------------------------------------------

test("roles pair exactly one supervisor with one administrator", () => {
  assert.equal(complementaryApprovalRole("supervisor"), "admin");
  assert.equal(complementaryApprovalRole("admin"), "supervisor");
  assert.equal(requiredSecondApprovalRole([signature()]), "admin");
  assert.equal(requiredSecondApprovalRole([signature({ actorUid: ADMIN_UID, actorRole: "admin" })]), "supervisor");
  assert.equal(requiredSecondApprovalRole([]), null);
  assert.equal(requiredSecondApprovalRole([signature(), signature({ actorUid: ADMIN_UID, actorRole: "admin" })]), null);
});

test("a second signature must be a different person in the complementary role", () => {
  const approvals = [signature()];
  assert.equal(
    assertApprovalSignatureAppendable({ approvals, actorUid: ADMIN_UID, actorRole: "admin" }),
    "admin",
  );
  assert.throws(
    () => assertApprovalSignatureAppendable({ approvals, actorUid: SUPERVISOR_UID, actorRole: "admin" }),
    failsWith("RECOVERY_APPROVAL_DUPLICATE_ACTOR"),
  );
  assert.throws(
    () => assertApprovalSignatureAppendable({ approvals, actorUid: "other-supervisor", actorRole: "supervisor" }),
    failsWith("RECOVERY_APPROVAL_ROLE_CONFLICT"),
  );
  assert.throws(
    () => assertApprovalSignatureAppendable({ approvals: [], actorUid: ADMIN_UID, actorRole: "admin" }),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertApprovalSignatureAppendable({
      approvals: [signature(), signature({ actorUid: ADMIN_UID, actorRole: "admin" })],
      actorUid: "third-admin",
      actorRole: "admin",
    }),
    failsWith("RECOVERY_APPROVAL_ALREADY_COMPLETE"),
  );
});

test("a completed pair is validated for distinct people and both roles", () => {
  assert.doesNotThrow(() =>
    assertRequiredApprovalPair([signature(), signature({ actorUid: ADMIN_UID, actorRole: "admin" })]),
  );
  assert.throws(
    () => assertRequiredApprovalPair([signature()]),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertRequiredApprovalPair([signature(), signature({ actorRole: "supervisor" })]),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertRequiredApprovalPair([
      signature(),
      signature({ actorUid: ADMIN_UID, actorRole: "admin" }),
      signature({ actorUid: "third", actorRole: "admin" }),
    ]),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
});

// ---------------------------------------------------------------------------
// 5. The 24-hour intent lifetime
// ---------------------------------------------------------------------------

test("the intent lifetime is 24 hours and expires without a write", () => {
  assert.equal(HANDOVER_RECOVERY_APPROVAL_INTENT_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  const stored = assertHandoverRecoveryApprovalRecord(record(), record().id);
  assert.equal(Date.parse(stored.expiresAt) - Date.parse(stored.requestedAt), 24 * 60 * 60 * 1000);
  assert.doesNotThrow(() => assertApprovalIntentNotExpired(stored, "2026-11-02T08:59:59.999Z"));
  assert.throws(
    () => assertApprovalIntentNotExpired(stored, "2026-11-02T09:00:00.000Z"),
    failsWith("RECOVERY_APPROVAL_EXPIRED"),
  );
  assert.equal(
    evaluateHandoverRecoveryApprovalEffectiveStatus(stored, "2026-11-02T09:00:00.000Z"),
    "expired",
  );
  assert.equal(
    evaluateHandoverRecoveryApprovalEffectiveStatus(stored, "2026-11-02T09:00:00.000Z"),
    HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES.EXPIRED,
  );
});

test("voiding is terminal and dominates expiry", () => {
  const voided = assertHandoverRecoveryApprovalRecord(
    record({
      status: "voided",
      voidAuditId: "void_audit",
      voidedAt: "2026-11-01T10:00:00.000Z",
      voidedBy: SUPERVISOR_UID,
      voidReason: "The handover state changed before the second approval.",
      updatedAt: "2026-11-01T10:00:00.000Z",
    }),
    record().id,
  );
  assert.equal(evaluateHandoverRecoveryApprovalEffectiveStatus(voided, NOW), "voided");
  assert.equal(evaluateHandoverRecoveryApprovalEffectiveStatus(voided, "2027-01-01T00:00:00.000Z"), "voided");
  const view = createHandoverRecoveryApprovalView(voided, NOW);
  assert.equal(view.effectiveStatus, "voided");
  assert.equal(view.requiredSecondRole, null);
  assert.equal(view.recoveryExecutionEligible, false);
});

// ---------------------------------------------------------------------------
// 6. Request parsing cannot smuggle executable intent
// ---------------------------------------------------------------------------

test("a request body accepts only its four fields", () => {
  const parsed = parseHandoverRecoveryApprovalRequestBody(requestBody());
  assert.deepEqual(parsed.intent, {
    handoverDocumentId: HANDOVER,
    reason: REASON,
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.deepEqual(parsed.credential, { password: "current-password" });
  assert.equal("password" in parsed.intent, false);
});

test("a request body cannot supply executable flags, bindings, roles or identities", () => {
  for (const injected of [
    { recoveryExecutionEligible: true },
    { recoveryExecutionEligible: false },
    { nonExecutableReason: "caller-supplied" },
    { binding: binding() },
    { actorUid: ADMIN_UID },
    { role: "admin" },
    { requestedBy: ADMIN_UID },
    { approvals: [signature()] },
    { schemaVersion: 2 },
    { intentFingerprint: "f".repeat(64) },
    { approvedAt: NOW },
  ]) {
    assert.throws(
      () => parseHandoverRecoveryApprovalRequestBody(requestBody(injected)),
      failsInput,
      `expected rejection of ${JSON.stringify(injected)}`,
    );
  }
});

test("a request body validates its handover, reason, key and password", () => {
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ handoverDocumentId: "shift-1" })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ handoverDocumentId: "handover_v2_" })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ reason: "too short" })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ reason: ` ${REASON}` })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ reason: "x".repeat(2001) })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ idempotencyKey: "short" })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ idempotencyKey: "bad key with spaces" })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ password: "" })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ password: "x".repeat(4097) })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(requestBody({ password: 12345 })), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody(null), failsInput);
  assert.throws(() => parseHandoverRecoveryApprovalRequestBody([]), failsInput);
});

test("a countersign body carries only the expected revision and the password", () => {
  const parsed = parseHandoverRecoveryApprovalCountersignBody({ expectedRevision: 1, password: "current-password" });
  assert.deepEqual(parsed.intent, { expectedRevision: 1 });
  assert.deepEqual(parsed.credential, { password: "current-password" });
  for (const injected of [
    { actorUid: ADMIN_UID },
    { actorRole: "admin" },
    { approvals: [signature()] },
    { expectedIntentFingerprint: "f".repeat(64) },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedRevision: "1" },
  ]) {
    assert.throws(
      () => parseHandoverRecoveryApprovalCountersignBody({ expectedRevision: 1, password: "current-password", ...injected }),
      failsInput,
      `expected rejection of ${JSON.stringify(injected)}`,
    );
  }
});

test("void and reissue bodies require a normalized reason and an idempotency key", () => {
  for (const parse of [parseHandoverRecoveryApprovalVoidBody, parseHandoverRecoveryApprovalReissueBody]) {
    const parsed = parse({ reason: REASON, idempotencyKey: IDEMPOTENCY_KEY, password: "current-password" });
    assert.deepEqual(parsed.intent, { reason: REASON, idempotencyKey: IDEMPOTENCY_KEY });
    assert.deepEqual(parsed.credential, { password: "current-password" });
    assert.throws(() => parse({ reason: "short", idempotencyKey: IDEMPOTENCY_KEY, password: "x" }), failsInput);
    assert.throws(() => parse({ reason: REASON, idempotencyKey: "bad key", password: "x" }), failsInput);
    assert.throws(() => parse({ reason: REASON, idempotencyKey: IDEMPOTENCY_KEY, password: "x", status: "voided" }), failsInput);
    assert.throws(() => parse({ reason: REASON, idempotencyKey: IDEMPOTENCY_KEY }), failsInput);
  }
});

test("reason and idempotency primitives reject non-normalized values", () => {
  assert.equal(approvalReason(REASON), REASON);
  assert.throws(() => approvalReason(" padded reason "), failsInput);
  assert.throws(() => approvalReason(REASON + "\n"), failsInput);
  assert.equal(idempotencyKey("abcDEF0123._:-"), "abcDEF0123._:-");
  assert.throws(() => idempotencyKey("with/slash"), failsInput);
  assert.throws(() => idempotencyKey("short"), failsInput);
});

test("document identifiers are constrained to the v2 handover namespace", () => {
  assert.ok(validHandoverDocumentId("handover_v2_shift_2026-11-01"));
  assert.equal(validHandoverDocumentId("handover_v2_"), false);
  assert.equal(validHandoverDocumentId("handover_v2_a/b"), false);
  assert.equal(validHandoverDocumentId("shift"), false);
  assert.equal(validHandoverDocumentId(null), false);
  assert.equal(validHandoverRecoveryApprovalId("handover_recovery_approval_v1_" + "a".repeat(40)), true);
  assert.equal(validHandoverRecoveryApprovalId("other_v1_" + "a".repeat(40)), false);
  assert.equal(validHandoverRecoveryApprovalId("handover_recovery_approval_v1_a/b"), false);
});

// ---------------------------------------------------------------------------
// 7. Stored-record validation
// ---------------------------------------------------------------------------

test("a fully approved record is accepted and reads as non-executable", () => {
  const stored = assertHandoverRecoveryApprovalRecord(
    record({
      approvals: [signature(), signature({ actorUid: ADMIN_UID, actorRole: "admin" })],
      revision: 2,
      status: "fully_approved",
      countersignAuditId: "countersign_audit",
      updatedAt: "2026-11-01T09:05:00.000Z",
    }),
    record().id,
  );
  assert.equal(stored.status, "fully_approved");
  assert.equal(stored.approvals.length, 2);
  assert.equal(stored.recoveryExecutionEligible, false);
  const view = createHandoverRecoveryApprovalView(stored, NOW);
  assert.equal(view.effectiveStatus, "fully_approved");
  assert.equal(view.requiredSecondRole, null);
  assert.equal(view.recoveryExecutionEligible, false);
});

test("a version 1 record can never be persisted as executable", () => {
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ recoveryExecutionEligible: true }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ nonExecutableReason: "because" }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ schemaVersion: 2 }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ schema: "handover-recovery-approval-v2" }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ action: "recover_stalled_handover" }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
});

test("a stored record rejects unknown fields and identity mismatches", () => {
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ executionNonce: "x" }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record(), "handover_recovery_approval_v1_" + "0".repeat(40)),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ intentFingerprint: "f".repeat(64) }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      { ...record(), binding: { ...binding(), executable: true } },
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
});

test("the first signature must belong to the requester", () => {
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      record({ approvals: [signature({ actorUid: ADMIN_UID, actorRole: "admin" })] }),
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
});

test("stored signatures must agree with their status and revision", () => {
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ status: "fully_approved" }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      record({
        approvals: [signature(), signature({ actorUid: ADMIN_UID, actorRole: "admin" })],
        revision: 2,
        status: "awaiting_second_approval",
      }),
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      record({
        approvals: [signature(), signature({ actorUid: ADMIN_UID, actorRole: "admin" })],
        revision: 1,
        status: "fully_approved",
      }),
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      record({ approvals: [signature(), signature({ actorUid: ADMIN_UID, actorRole: "admin" })], status: "fully_approved" }),
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      record({
        approvals: [signature(), signature({ actorUid: SUPERVISOR_UID, actorRole: "admin" })],
        revision: 2,
        status: "fully_approved",
      }),
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
});

test("voided records require a complete, canonical tombstone", () => {
  const tombstone = {
    status: "voided",
    voidAuditId: "void_audit",
    voidedAt: "2026-11-01T10:00:00.000Z",
    voidedBy: SUPERVISOR_UID,
    voidReason: "The handover moved before the complementary approval.",
    updatedAt: "2026-11-01T10:00:00.000Z",
  };
  assert.doesNotThrow(() => assertHandoverRecoveryApprovalRecord(record(tombstone), record().id));
  for (const missing of ["voidAuditId", "voidedAt", "voidedBy", "voidReason"]) {
    assert.throws(
      () => assertHandoverRecoveryApprovalRecord(record({ ...tombstone, [missing]: null }), record().id),
      failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
      `a voided record without ${missing} must be refused`,
    );
  }
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ status: "voided" }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      record({ voidAuditId: "void_audit", voidedAt: NOW, voidedBy: SUPERVISOR_UID, voidReason: REASON }),
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
});

test("a stored signature carries no credential and expires canonically", () => {
  const stored = assertHandoverRecoveryApprovalRecord(record(), record().id);
  assert.deepEqual(Object.keys(stored.approvals[0]).sort(), [
    "actorRole",
    "actorUid",
    "approvedAt",
    "proofExpiresAt",
    "proofFingerprint",
  ]);
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      record({ approvals: [{ ...signature(), password: "leak" }] }),
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      record({ approvals: [signature({ proofExpiresAt: "2026-11-01T09:30:00.000Z" })] }),
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(
      record({ approvals: [signature({ actorRole: "technician" })] }),
      record().id,
    ),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
});

test("the intent expiry must follow the request time", () => {
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ expiresAt: NOW }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  assert.throws(
    () => assertHandoverRecoveryApprovalRecord(record({ requestedAt: "not-a-time" }), record().id),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
});

// ---------------------------------------------------------------------------
// 8. Error surface
// ---------------------------------------------------------------------------

test("error statuses separate authentication, authorization and conflict", () => {
  const status = (code) => {
    try {
      throw new HandoverRecoveryApprovalError(code, "x");
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(status("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"), 401);
  assert.equal(status("RECOVERY_APPROVAL_AUTHENTICATION_EXPIRED"), 401);
  assert.equal(status("RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED"), 403);
  assert.equal(status("RECOVERY_APPROVAL_ROLE_FORBIDDEN"), 403);
  assert.equal(status("RECOVERY_APPROVAL_NOT_FOUND"), 404);
  assert.equal(status("RECOVERY_APPROVAL_HANDOVER_NOT_FOUND"), 404);
  assert.equal(status("RECOVERY_APPROVAL_STALE"), 409);
  assert.equal(status("RECOVERY_APPROVAL_DUPLICATE_ACTOR"), 409);
  assert.equal(status("RECOVERY_APPROVAL_ALREADY_VOIDED"), 409);
  assert.equal(status("RECOVERY_APPROVAL_OUTCOME_UNVERIFIED"), 503);
});
