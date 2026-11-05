/**
 * Phase 8C.2b — isolated Firestore emulator suite for the dual-approval
 * substrate.
 *
 * The suite seeds synthetic stalled handovers (production aggregate + guard
 * factories), then drives the approval services directly. It proves:
 *   - the requester records the first personal approval and nothing else;
 *   - only a different human in the complementary role can add the second
 *     signature, and the first signature is never rewritten;
 *   - a moved binding is refused rather than silently rebound or auto-voided;
 *   - the intent window and the 60-second proof window both close;
 *   - voiding is terminal and reissue mints a new identity while preserving the
 *     voided original;
 *   - replay, concurrency and orphaned audits cannot fabricate a second state;
 *   - the trusted HTTP boundary binds the proof to the session subject, never
 *     returns the password and refuses disabled, mismatched or changing
 *     accounts;
 *   - NO operational collection is written and no approval can ever be
 *     executable.
 *
 * Run via: tests/run-handover-recovery-approval-emulator.ps1
 *
 * Safety invariant: project "demo-recovery-approval-8c2b" on dedicated port
 * 8184 only, no import/export, synthetic records only. Protected presentation
 * and UAT stacks are never contacted. This suite does not call the real
 * password-verification seam, so the closed emulator allowlist is untouched.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const project = "demo-recovery-approval-8c2b";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8184", "localhost:8184"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run recovery approval emulator tests outside the isolated demo emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The recovery approval suite drives services directly, with no dev feature flag.");
}
if (process.env.HANDOVER_V2_ATOMIC_ACCEPTANCE) {
  throw new Error("The recovery approval suite must not inherit the atomic acceptance flag.");
}

const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const {
  requestHandoverRecoveryApproval,
  countersignHandoverRecoveryApproval,
  voidHandoverRecoveryApproval,
  reissueHandoverRecoveryApproval,
  readHandoverRecoveryApproval,
  listHandoverRecoveryApprovals,
} = await import("../src/lib/operations/handover-recovery-approval-firestore.ts");
const {
  createHandoverRecoveryApprovalId,
  createHandoverRecoveryIntentFingerprint,
} = await import("../src/lib/operations/handover-recovery-approval-domain.ts");
const {
  HANDOVER_RECOVERY_APPROVAL_COLLECTION,
  HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
} = await import("../src/types/handover-recovery-approval.ts");
const {
  createEqualHandover,
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
} = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const { createInitialReservationGuard } = await import(
  "../src/lib/operations/handover-reservation-guard-domain.ts"
);
const { createHandoverReviewCaseId } = await import("../src/lib/operations/handover-admin-review-domain.ts");
const { authenticateHandoverRecoveryApproval } = await import(
  "../src/lib/operations/handover-recovery-approval-coordinator.ts"
);
const { PasswordReauthenticationError } = await import("../src/lib/auth/password-reauthentication.ts");

const db = getAdminFirestore();

// ---------------------------------------------------------------------------
// Synthetic world
// ---------------------------------------------------------------------------

const AT = "2026-11-01T09:00:00.000Z";
const END = "2026-11-01T17:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const REASON = "Recover the stalled outgoing handover after review.";
const VOID_REASON = "The handover state moved before the second approval.";

const SUPERVISOR = "approval-supervisor";
const SUPERVISOR_TWO = "approval-supervisor-two";
const ADMIN = "approval-admin";
const ADMIN_TWO = "approval-admin-two";
const TECHNICIAN = "approval-technician";
const SUSPENDED_ADMIN = "approval-suspended-admin";
const PASSWORD_ADMIN = "approval-password-admin";

const USERS = [
  [SUPERVISOR, { role: "supervisor", status: "active" }],
  [SUPERVISOR_TWO, { role: "supervisor", status: "active" }],
  [ADMIN, { role: "admin", status: "active" }],
  [ADMIN_TWO, { role: "admin", status: "active" }],
  [TECHNICIAN, { role: "technician", status: "active" }],
  [SUSPENDED_ADMIN, { role: "admin", status: "suspended" }],
  [PASSWORD_ADMIN, { role: "admin", status: "active", mustChangePassword: true }],
];

const OPERATIONAL_COLLECTIONS = [
  "users",
  "handovers",
  "equal_handovers_v2",
  "handover_reservation_guards",
  "handover_reservation_guard_history",
  "handover_review_cases_v1",
  "handover_review_decisions_v1",
  "handover_reviews_v1",
  "handover_reports_v2",
  "handover_report_preparations_v2",
  "incoming_acceptance_applications_v1",
  "attendance_evidence_v2",
  "attendance_evidence_operations_v2",
  "shift_members",
  "shift_attendance",
  "shifts",
  "shift_joins",
  "operational_shift_control",
  "technician_schedules",
  "technician_pairs",
  "technician_pair_memberships",
  "notifications",
  "notification_outbox",
];

const clock = { now: Date.parse(AT), mono: 5_000 };
let nonceSequence = 0;

function advance(ms) {
  clock.now += ms;
  clock.mono += ms;
}

function authentication(actorUid, overrides = {}) {
  const iso = new Date(clock.now).toISOString();
  return {
    actorUid,
    requestNonce: `nonce_${String(++nonceSequence).padStart(6, "0")}`,
    verifiedAt: iso,
    authAccountCheckedAt: iso,
    verifiedAtMonotonicMs: clock.mono,
    nowIso: iso,
    nowMonotonicMs: clock.mono,
    ...overrides,
  };
}

function uuid(seed) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

let handoverSequence = 0;

async function seedHandover() {
  const key = `h${String(++handoverSequence).padStart(3, "0")}`;
  const outgoingShiftId = `outgoing_${key}`;
  const incomingShiftId = `incoming_${key}`;
  const identity = {
    schema: "equal-handover-v2",
    outgoingShiftId,
    outgoingPermanentPairId: `pair_out_${key}`,
    outgoingTechnicianIds: [`tech_out_a_${key}`, `tech_out_b_${key}`],
    outgoingSlotToken: uuid(`outgoing:${key}`),
    outgoingGeneration: 1,
    incomingShiftId,
    incomingPermanentPairId: `pair_in_${key}`,
    incomingTechnicianIds: [`tech_in_a_${key}`, `tech_in_b_${key}`],
    successorSlotToken: uuid(`successor:${key}`),
    successorGeneration: 2,
    shiftType: "morning",
    scheduledStart: AT,
    scheduledEnd: END,
  };
  const aggregate = createEqualHandover({ identity, reservedAt: AT, reservedBy: SUPERVISOR });
  const handoverDocumentId = createEqualHandoverDocumentId(outgoingShiftId);
  const guard = createInitialReservationGuard({
    outgoingShiftId,
    protocolOwner: "v2",
    ownerHandoverDocumentId: handoverDocumentId,
    outgoingSlotToken: identity.outgoingSlotToken,
    outgoingGeneration: identity.outgoingGeneration,
    successorSlotToken: identity.successorSlotToken,
    successorGeneration: identity.successorGeneration,
    reservationId: uuid(`reservation:${key}`),
    reservedIncomingShiftId: incomingShiftId,
    reservedAt: AT,
    reservedBy: SUPERVISOR,
  });

  await db.doc(`equal_handovers_v2/${handoverDocumentId}`).set(aggregate);
  await db.doc(`handover_reservation_guards/${guard.id}`).set(guard);

  return { key, outgoingShiftId, incomingShiftId, handoverDocumentId, aggregate, guard };
}

async function seedUsers() {
  for (const [uid, profile] of USERS) {
    await db.doc(`users/${uid}`).set({ uid, ...profile });
  }
}

const stored = async (path) => (await db.doc(path).get()).data();

function approvalPath(approvalId) {
  return `${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/${approvalId}`;
}

function expectedBinding(world, reviewCase = null) {
  return {
    aggregateRevision: world.aggregate.revision,
    aggregateSnapshotHash: createEqualHandoverSnapshot(world.aggregate).snapshotHash,
    aggregateLifecycleStatus: world.aggregate.lifecycleStatus,
    guardId: world.guard.id,
    guardRevision: world.guard.guardRevision,
    fencingEpoch: world.guard.fencingEpoch,
    slotToken: world.aggregate.identity.outgoingSlotToken,
    slotGeneration: world.aggregate.identity.outgoingGeneration,
    successorSlotToken: world.aggregate.identity.successorSlotToken,
    successorSlotGeneration: world.aggregate.identity.successorGeneration,
    reviewCaseId: createHandoverReviewCaseId(world.handoverDocumentId),
    reviewCaseStatus: reviewCase === null ? "none" : "open",
    reviewCaseRevision: reviewCase === null ? 0 : reviewCase.caseRevision,
    reviewCaseFingerprint: reviewCase === null ? null : reviewCase.fingerprintAtLastDecision,
  };
}

async function requestAs(uid, world, overrides = {}) {
  return requestHandoverRecoveryApproval({
    actorUid: uid,
    handoverDocumentId: world.handoverDocumentId,
    intent: { handoverDocumentId: world.handoverDocumentId, reason: REASON, idempotencyKey: `key_${uid}_${world.key}`, ...overrides },
    authentication: authentication(uid),
  });
}

async function countersignAs(uid, approvalId, revision = 1) {
  return countersignHandoverRecoveryApproval({
    approvalId,
    actorUid: uid,
    intent: { expectedRevision: revision },
    authentication: authentication(uid),
  });
}

async function voidAs(uid, approvalId, idempotencyKey, reason = VOID_REASON) {
  return voidHandoverRecoveryApproval({
    approvalId,
    actorUid: uid,
    intent: { reason, idempotencyKey },
    authentication: authentication(uid),
  });
}

async function reissueAs(uid, approvalId, idempotencyKey, reason = REASON) {
  return reissueHandoverRecoveryApproval({
    approvalId,
    actorUid: uid,
    intent: { reason, idempotencyKey },
    authentication: authentication(uid),
  });
}

const failsWith = (code) => (error) => {
  assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
  return true;
};

async function auditRowsFor(approvalId) {
  const snapshot = await db.collection("audit_logs").where("approvalId", "==", approvalId).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

async function operationalFingerprint() {
  const parts = [];
  for (const collection of OPERATIONAL_COLLECTIONS) {
    const snapshot = await db.collection(collection).get();
    for (const document of snapshot.docs) {
      parts.push(`${document.ref.path}=${JSON.stringify(document.data())}`);
    }
  }
  return createHash("sha256").update(parts.sort().join("\n")).digest("hex");
}

const FORBIDDEN_KEYS = [
  "password",
  "idtoken",
  "refreshtoken",
  "accesstoken",
  "cookie",
  "cookies",
  "authorization",
  "credential",
  "credentials",
  "secret",
  "apikey",
  "api_key",
];

function assertNoCredentialMaterial(value, location) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialMaterial(item, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(
        !FORBIDDEN_KEYS.includes(key.toLowerCase()),
        `credential field ${location}.${key} must never be stored`,
      );
      assertNoCredentialMaterial(item, `${location}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    assert.doesNotMatch(value, /password\s*=|idToken|refreshToken/i, `credential material at ${location}`);
  }
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

test("00 the disposable project starts empty", async () => {
  const approvals = await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION).get();
  assert.equal(approvals.size, 0, "the approval collection must start empty");
  const audits = await db.collection("audit_logs").get();
  assert.equal(audits.size, 0, "the audit log must start empty");
  await seedUsers();
});

// ---------------------------------------------------------------------------
// 1. Requester records the first, non-executable approval
// ---------------------------------------------------------------------------

test("01 the requester records one non-executable approval bound to live state", async () => {
  const world = await seedHandover();
  const result = await requestAs(SUPERVISOR, world);

  assert.equal(result.replayed, false);
  const view = result.view;
  assert.equal(view.recoveryExecutionEligible, false);
  assert.equal(view.effectiveStatus, "awaiting_second_approval");
  assert.equal(view.approvalCount, 1);
  assert.equal(view.requiredSecondRole, "admin");

  const record = view.approval;
  assert.equal(record.recoveryExecutionEligible, false);
  assert.equal(record.nonExecutableReason, HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.action, "abandon_stalled_handover");
  assert.equal(record.handoverDocumentId, world.handoverDocumentId);
  assert.equal(record.outgoingShiftId, world.outgoingShiftId);
  assert.equal(record.incomingShiftId, world.incomingShiftId);
  assert.equal(record.requestedBy, SUPERVISOR);
  assert.equal(record.status, "awaiting_second_approval");
  assert.equal(record.revision, 1);
  assert.equal(record.replacesApprovalId, null);
  assert.equal(record.reissuedAsApprovalId, null);
  assert.deepEqual(record.binding, expectedBinding(world));
  assert.equal(
    record.intentFingerprint,
    createHandoverRecoveryIntentFingerprint(expectedBinding(world)),
  );
  assert.equal(
    record.id,
    createHandoverRecoveryApprovalId({
      handoverDocumentId: world.handoverDocumentId,
      intentFingerprint: record.intentFingerprint,
    }),
  );
  assert.equal(Date.parse(record.expiresAt) - Date.parse(record.requestedAt), DAY);
  assert.equal(record.approvals.length, 1);
  assert.equal(record.approvals[0].actorUid, SUPERVISOR);
  assert.equal(record.approvals[0].actorRole, "supervisor");
  assert.equal(Date.parse(record.approvals[0].proofExpiresAt) - Date.parse(record.approvals[0].approvedAt), 60_000);
  assert.match(record.approvals[0].proofFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(record.requestAuditId, result.auditId);

  const persisted = await stored(approvalPath(record.id));
  assert.equal(persisted.recoveryExecutionEligible, false);

  const audits = await auditRowsFor(record.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "HANDOVER_RECOVERY_APPROVAL_REQUESTED");
  assert.equal(audits[0].actorUid, SUPERVISOR);
  assert.equal(audits[0].actorRole, "supervisor");
  assert.equal(audits[0].targetHandoverDocumentId, world.handoverDocumentId);
  assert.equal(audits[0].approvalId, record.id);
  assert.equal(audits[0].intentFingerprint, record.intentFingerprint);
  assert.equal(audits[0].recoveryExecutionEligible, false);
  assert.ok(audits[0].createdAt);
});

test("02 a requester replay returns the same approval and writes nothing new", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  const second = await requestAs(SUPERVISOR, world);

  assert.equal(second.replayed, true);
  assert.equal(second.view.approval.id, first.view.approval.id);
  assert.equal(second.auditId, first.auditId);
  assert.equal((await auditRowsFor(first.view.approval.id)).length, 1);
  const all = await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION)
    .where("handoverDocumentId", "==", world.handoverDocumentId).get();
  assert.equal(all.size, 1);
});

test("03 a second person cannot create a competing intent for the same state", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  await assert.rejects(() => requestAs(ADMIN, world), failsWith("RECOVERY_APPROVAL_REQUEST_CONFLICT"));

  const all = await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION)
    .where("handoverDocumentId", "==", world.handoverDocumentId).get();
  assert.equal(all.size, 1);
  assert.equal((await stored(approvalPath(first.view.approval.id))).status, "awaiting_second_approval");
});

test("04 a technician can neither request nor countersign", async () => {
  const world = await seedHandover();
  await assert.rejects(() => requestAs(TECHNICIAN, world), failsWith("RECOVERY_APPROVAL_ROLE_FORBIDDEN"));
  const first = await requestAs(SUPERVISOR, world);
  await assert.rejects(
    () => countersignAs(TECHNICIAN, first.view.approval.id),
    failsWith("RECOVERY_APPROVAL_ROLE_FORBIDDEN"),
  );
});

test("05 a suspended or password-blocked administrator cannot approve", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  await assert.rejects(() => requestAs(SUSPENDED_ADMIN, world), failsWith("RECOVERY_APPROVAL_ROLE_FORBIDDEN"));
  await assert.rejects(
    () => countersignAs(SUSPENDED_ADMIN, first.view.approval.id),
    failsWith("RECOVERY_APPROVAL_ROLE_FORBIDDEN"),
  );
  await assert.rejects(
    () => countersignAs(PASSWORD_ADMIN, first.view.approval.id),
    failsWith("RECOVERY_APPROVAL_ROLE_FORBIDDEN"),
  );
  assert.equal((await stored(approvalPath(first.view.approval.id))).approvals.length, 1);
});

// ---------------------------------------------------------------------------
// 2. The second approval: different person, complementary role
// ---------------------------------------------------------------------------

test("06 the requester cannot countersign their own request", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  await assert.rejects(
    () => countersignAs(SUPERVISOR, first.view.approval.id),
    failsWith("RECOVERY_APPROVAL_DUPLICATE_ACTOR"),
  );
  const persisted = await stored(approvalPath(first.view.approval.id));
  assert.equal(persisted.approvals.length, 1);
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.status, "awaiting_second_approval");
});

test("07 a second supervisor cannot countersign", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  await assert.rejects(
    () => countersignAs(SUPERVISOR_TWO, first.view.approval.id),
    failsWith("RECOVERY_APPROVAL_ROLE_CONFLICT"),
  );
});

test("08 a stale expected revision is refused before any proof is considered", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  await assert.rejects(
    () => countersignAs(ADMIN, first.view.approval.id, 2),
    failsWith("RECOVERY_APPROVAL_STALE"),
  );
  assert.equal((await stored(approvalPath(first.view.approval.id))).status, "awaiting_second_approval");
});

test("09 a moved aggregate lifecycle refuses the second signature without auto-voiding", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  const before = await stored(approvalPath(first.view.approval.id));

  await db.doc(`equal_handovers_v2/${world.handoverDocumentId}`).update({
    lifecycleStatus: "completed",
    updatedAt: "2026-11-01T09:30:00.000Z",
  });

  await assert.rejects(
    () => countersignAs(ADMIN, first.view.approval.id),
    failsWith("RECOVERY_APPROVAL_STALE"),
  );

  const after = await stored(approvalPath(first.view.approval.id));
  assert.equal(after.status, "awaiting_second_approval", "a moved binding must not implicitly void");
  assert.equal(after.revision, 1);
  assert.deepEqual(after.approvals, before.approvals);
  assert.equal(after.countersignAuditId, null);
  assert.equal(after.intentFingerprint, before.intentFingerprint);
  const audits = await auditRowsFor(first.view.approval.id);
  assert.equal(audits.filter((row) => row.action === "HANDOVER_RECOVERY_APPROVAL_COUNTERSIGNED").length, 0);
});

test("10 an administrative review case appearing refuses the second signature", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  assert.equal(first.view.approval.binding.reviewCaseStatus, "none");

  const reviewCase = {
    schema: "handover-admin-review-case-v1",
    id: createHandoverReviewCaseId(world.handoverDocumentId),
    handoverDocumentId: world.handoverDocumentId,
    status: "open",
    caseRevision: 1,
    fingerprintAtLastDecision: "a".repeat(64),
    openedAt: AT,
    updatedAt: AT,
  };
  await db.doc(`handover_review_cases_v1/${reviewCase.id}`).set(reviewCase);

  await assert.rejects(
    () => countersignAs(ADMIN, first.view.approval.id),
    failsWith("RECOVERY_APPROVAL_STALE"),
  );
  assert.equal((await stored(approvalPath(first.view.approval.id))).status, "awaiting_second_approval");

  // Reissuing against the new binding is the explicit path forward.
  await voidAs(SUPERVISOR, first.view.approval.id, "void_after_review_case");
  const reissued = await reissueAs(ADMIN, first.view.approval.id, "reissue_after_review_case");
  assert.equal(reissued.view.approval.binding.reviewCaseStatus, "open");
  assert.equal(reissued.view.approval.binding.reviewCaseRevision, 1);
  assert.notEqual(reissued.view.approval.intentFingerprint, first.view.approval.intentFingerprint);
});

test("11 the complementary role completes the pair without rewriting the first signature", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  const firstSignature = first.view.approval.approvals[0];
  const second = await countersignAs(ADMIN, first.view.approval.id);

  assert.equal(second.replayed, false);
  assert.equal(second.view.effectiveStatus, "fully_approved");
  assert.equal(second.view.approvalCount, 2);
  assert.equal(second.view.requiredSecondRole, null);
  assert.equal(second.view.recoveryExecutionEligible, false);

  const record = await stored(approvalPath(first.view.approval.id));
  assert.equal(record.status, "fully_approved");
  assert.equal(record.revision, 2);
  assert.equal(record.recoveryExecutionEligible, false);
  assert.deepEqual(record.approvals[0], firstSignature, "the first signature is immutable");
  assert.equal(record.approvals[1].actorUid, ADMIN);
  assert.equal(record.approvals[1].actorRole, "admin");
  assert.equal(record.countersignAuditId, second.auditId);
  assert.equal(record.voidedAt, null);

  const audits = await auditRowsFor(record.id);
  assert.equal(audits.length, 2);
  const countersignRow = audits.find((row) => row.action === "HANDOVER_RECOVERY_APPROVAL_COUNTERSIGNED");
  assert.ok(countersignRow);
  assert.equal(countersignRow.actorUid, ADMIN);
  assert.equal(countersignRow.actorRole, "admin");
  assert.equal(countersignRow.requestedBy, SUPERVISOR);
  assert.equal(countersignRow.approvals, 2);
  assert.equal(countersignRow.recoveryExecutionEligible, false);
});

test("12 a repeated complementary approval is a replay, not a third signature", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  const second = await countersignAs(ADMIN, first.view.approval.id);
  const replay = await countersignAs(ADMIN, first.view.approval.id);

  assert.equal(replay.replayed, true);
  assert.equal(replay.view.approval.id, second.view.approval.id);
  const record = await stored(approvalPath(first.view.approval.id));
  assert.equal(record.approvals.length, 2);
  assert.equal(record.revision, 2);
  assert.equal(
    (await auditRowsFor(first.view.approval.id))
      .filter((row) => row.action === "HANDOVER_RECOVERY_APPROVAL_COUNTERSIGNED").length,
    1,
  );
});

// ---------------------------------------------------------------------------
// 3. Voiding, terminality and reissue
// ---------------------------------------------------------------------------

test("13 only an approver may void, and voiding is terminal", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);

  await assert.rejects(
    () => voidAs(ADMIN, first.view.approval.id, "void_by_outsider"),
    failsWith("RECOVERY_APPROVAL_ROLE_FORBIDDEN"),
  );

  const voided = await voidAs(SUPERVISOR, first.view.approval.id, "void_terminal_1");
  assert.equal(voided.view.effectiveStatus, "voided");
  assert.equal(voided.view.requiredSecondRole, null);
  assert.equal(voided.view.recoveryExecutionEligible, false);

  const record = await stored(approvalPath(first.view.approval.id));
  assert.equal(record.status, "voided");
  assert.equal(record.voidedBy, SUPERVISOR);
  assert.equal(record.voidReason, VOID_REASON);
  assert.ok(record.voidedAt);
  assert.equal(record.voidAuditId, voided.auditId);
  assert.deepEqual(record.approvals, first.view.approval.approvals, "voiding preserves signatures");

  assert.equal((await voidAs(SUPERVISOR, first.view.approval.id, "void_terminal_1")).replayed, true);
  await assert.rejects(
    () => voidAs(SUPERVISOR, first.view.approval.id, "void_terminal_2"),
    failsWith("RECOVERY_APPROVAL_ALREADY_VOIDED"),
  );
  const voidRows = (await auditRowsFor(first.view.approval.id))
    .filter((row) => row.action === "HANDOVER_RECOVERY_APPROVAL_VOIDED");
  assert.equal(voidRows.length, 1);
  assert.equal(voidRows[0].priorApprovalCount, 1);
  assert.equal(voidRows[0].recoveryExecutionEligible, false);
});

test("14 a voided intent cannot be signed", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  await voidAs(SUPERVISOR, first.view.approval.id, "void_before_countersign");
  await assert.rejects(
    () => countersignAs(ADMIN, first.view.approval.id),
    failsWith("RECOVERY_APPROVAL_ALREADY_VOIDED"),
  );
  await assert.rejects(
    () => requestAs(SUPERVISOR, world),
    failsWith("RECOVERY_APPROVAL_ALREADY_VOIDED"),
  );
});

test("15 a live intent cannot be reissued", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  await assert.rejects(
    () => reissueAs(ADMIN, first.view.approval.id, "reissue_live"),
    failsWith("RECOVERY_APPROVAL_NOT_VOIDED"),
  );
});

test("16 reissue mints a new identity and preserves the voided original", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  const original = first.view.approval;
  const voided = await voidAs(SUPERVISOR, original.id, "void_for_reissue");
  const reissued = await reissueAs(ADMIN, original.id, "reissue_after_void");

  assert.equal(reissued.replayed, false);
  assert.equal(reissued.view.recoveryExecutionEligible, false);
  const next = reissued.view.approval;
  assert.notEqual(next.id, original.id);
  assert.equal(next.replacesApprovalId, original.id);
  assert.equal(next.handoverDocumentId, original.handoverDocumentId);
  assert.equal(next.requestedBy, ADMIN);
  assert.equal(next.status, "awaiting_second_approval");
  assert.equal(next.revision, 1);
  assert.equal(next.approvals.length, 1);
  assert.equal(next.approvals[0].actorUid, ADMIN);
  assert.equal(next.approvals[0].actorRole, "admin");
  assert.equal(Date.parse(next.expiresAt) - Date.parse(next.requestedAt), DAY);
  assert.equal(next.reissuedAsApprovalId, null);

  const preserved = await stored(approvalPath(original.id));
  assert.equal(preserved.status, "voided");
  assert.equal(preserved.voidedBy, SUPERVISOR);
  assert.equal(preserved.voidAuditId, voided.auditId);
  assert.equal(preserved.reissuedAsApprovalId, next.id);
  assert.deepEqual(preserved.approvals, original.approvals);
  assert.equal(preserved.intentFingerprint, original.intentFingerprint);

  assert.equal((await reissueAs(ADMIN, original.id, "reissue_after_void")).replayed, true);
  await assert.rejects(
    () => reissueAs(ADMIN, original.id, "reissue_second_key"),
    failsWith("RECOVERY_APPROVAL_ALREADY_REISSUED"),
  );

  const reissueRows = (await auditRowsFor(next.id))
    .filter((row) => row.action === "HANDOVER_RECOVERY_APPROVAL_REISSUED");
  assert.equal(reissueRows.length, 1);
  assert.equal(reissueRows[0].replacesApprovalId, original.id);
  assert.equal(reissueRows[0].voidedIntentFingerprint, original.intentFingerprint);
});

// ---------------------------------------------------------------------------
// 4. Windows
// ---------------------------------------------------------------------------

test("17 an expired intent refuses the second signature but permits void and reissue", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  advance(DAY + 60_000);

  await assert.rejects(
    () => countersignAs(ADMIN, first.view.approval.id),
    failsWith("RECOVERY_APPROVAL_EXPIRED"),
  );
  assert.equal((await stored(approvalPath(first.view.approval.id))).status, "awaiting_second_approval");

  const view = await readHandoverRecoveryApproval({
    approvalId: first.view.approval.id,
    nowIso: new Date(clock.now).toISOString(),
  });
  assert.equal(view.effectiveStatus, "expired");
  assert.equal(view.recoveryExecutionEligible, false);

  await voidAs(SUPERVISOR, first.view.approval.id, "void_expired");
  const reissued = await reissueAs(ADMIN, first.view.approval.id, "reissue_expired");
  assert.equal(
    Date.parse(reissued.view.approval.expiresAt) - Date.parse(reissued.view.approval.requestedAt),
    DAY,
  );
  assert.equal(reissued.view.effectiveStatus, "awaiting_second_approval");
});

test("18 the effective status is derived from the clock without a write", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  const before = await stored(approvalPath(first.view.approval.id));
  const expired = await readHandoverRecoveryApproval({
    approvalId: first.view.approval.id,
    nowIso: new Date(clock.now + 2 * DAY).toISOString(),
  });
  assert.equal(expired.effectiveStatus, "expired");
  assert.equal(expired.approval.status, "awaiting_second_approval");
  assert.deepEqual(await stored(approvalPath(first.view.approval.id)), before, "reads never write");
});

// ---------------------------------------------------------------------------
// 5. Concurrency, replay and unverified outcomes
// ---------------------------------------------------------------------------

test("19 duplicate concurrent requests collapse onto one approval", async () => {
  const world = await seedHandover();
  const results = await Promise.allSettled([requestAs(SUPERVISOR, world), requestAs(SUPERVISOR, world)]);
  const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  assert.ok(fulfilled.length >= 1, "at least one request must succeed");
  const ids = new Set(fulfilled.map((result) => result.view.approval.id));
  assert.equal(ids.size, 1);

  const all = await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION)
    .where("handoverDocumentId", "==", world.handoverDocumentId).get();
  assert.equal(all.size, 1);
  assert.equal((await auditRowsFor(fulfilled[0].view.approval.id)).length, 1);
});

test("20 concurrent complementary approvals commit exactly one second signature", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  const results = await Promise.allSettled([
    countersignAs(ADMIN, first.view.approval.id),
    countersignAs(ADMIN_TWO, first.view.approval.id),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one complementary approval may commit");
  assert.equal(rejected.length, 1);
  assert.ok(
    ["RECOVERY_APPROVAL_ALREADY_COMPLETE", "RECOVERY_APPROVAL_STALE", "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED"]
      .includes(rejected[0].reason?.code),
    `unexpected loser code: ${rejected[0].reason?.code}`,
  );

  const record = await stored(approvalPath(first.view.approval.id));
  assert.equal(record.status, "fully_approved");
  assert.equal(record.approvals.length, 2);
  assert.equal(record.revision, 2);
  assert.equal(
    (await auditRowsFor(first.view.approval.id))
      .filter((row) => row.action === "HANDOVER_RECOVERY_APPROVAL_COUNTERSIGNED").length,
    1,
  );
});

test("21 an orphaned audit row is reported as an unverified outcome", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  const approvalId = first.view.approval.id;

  await db.doc(approvalPath(approvalId)).delete();
  await assert.rejects(() => requestAs(SUPERVISOR, world), failsWith("RECOVERY_APPROVAL_OUTCOME_UNVERIFIED"));
  assert.equal((await db.doc(approvalPath(approvalId)).get()).exists, false);
});

test("22 a countersign before the request exists is refused", async () => {
  await assert.rejects(
    () => countersignAs(ADMIN, "handover_recovery_approval_v1_" + "0".repeat(40)),
    failsWith("RECOVERY_APPROVAL_NOT_FOUND"),
  );
});

// ---------------------------------------------------------------------------
// 6. Tampering, reading and scope
// ---------------------------------------------------------------------------

test("23 a tampered executable flag is refused on every read", async () => {
  const world = await seedHandover();
  const first = await requestAs(SUPERVISOR, world);
  const approvalId = first.view.approval.id;

  await db.doc(approvalPath(approvalId)).update({ recoveryExecutionEligible: true });
  const nowIso = new Date(clock.now).toISOString();
  await assert.rejects(
    () => readHandoverRecoveryApproval({ approvalId, nowIso }),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );
  await assert.rejects(
    () => listHandoverRecoveryApprovals({ handoverDocumentId: world.handoverDocumentId, nowIso }),
    failsWith("RECOVERY_APPROVAL_STATE_INCONSISTENT"),
  );

  await db.doc(approvalPath(approvalId)).update({ recoveryExecutionEligible: false });
  const restored = await readHandoverRecoveryApproval({ approvalId, nowIso });
  assert.equal(restored.recoveryExecutionEligible, false);
});

test("24 listing returns exactly one handover's approvals in request order", async () => {
  const worldA = await seedHandover();
  const worldB = await seedHandover();
  const first = await requestAs(SUPERVISOR, worldA);
  await requestAs(SUPERVISOR, worldB);
  const nowIso = new Date(clock.now).toISOString();

  const listA = await listHandoverRecoveryApprovals({ handoverDocumentId: worldA.handoverDocumentId, nowIso });
  assert.equal(listA.length, 1);
  assert.equal(listA[0].approval.id, first.view.approval.id);
  assert.equal(listA[0].recoveryExecutionEligible, false);

  const listB = await listHandoverRecoveryApprovals({ handoverDocumentId: worldB.handoverDocumentId, nowIso });
  assert.equal(listB.length, 1);
  assert.notEqual(listB[0].approval.id, listA[0].approval.id);

  const empty = await listHandoverRecoveryApprovals({ handoverDocumentId: "handover_v2_absent", nowIso });
  assert.deepEqual(empty, []);
});

test("25 the authentication subject must match the acting session subject", async () => {
  const world = await seedHandover();
  await assert.rejects(
    () => requestHandoverRecoveryApproval({
      actorUid: SUPERVISOR,
      handoverDocumentId: world.handoverDocumentId,
      intent: { handoverDocumentId: world.handoverDocumentId, reason: REASON, idempotencyKey: "subject_mismatch" },
      authentication: authentication(ADMIN),
    }),
    failsWith("RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED"),
  );

  const first = await requestAs(SUPERVISOR, world);
  await assert.rejects(
    () => countersignHandoverRecoveryApproval({
      approvalId: first.view.approval.id,
      actorUid: ADMIN,
      intent: { expectedRevision: 1 },
      authentication: authentication(SUPERVISOR),
    }),
    failsWith("RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED"),
  );
  assert.equal((await stored(approvalPath(first.view.approval.id))).approvals.length, 1);
});

test("26 no approval ever stores credential material or becomes executable", async () => {
  const approvals = await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION).get();
  assert.ok(approvals.size > 0);
  for (const document of approvals.docs) {
    const data = document.data();
    assert.equal(data.recoveryExecutionEligible, false, `${document.ref.path} must stay non-executable`);
    assert.equal(data.nonExecutableReason, HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON);
    assertNoCredentialMaterial(data, document.ref.path);
  }
  const audits = await db.collection("audit_logs").get();
  assert.ok(audits.size > 0);
  for (const document of audits.docs) {
    assertNoCredentialMaterial(document.data(), document.ref.path);
  }
  const raw = JSON.stringify(approvals.docs.map((document) => document.data()));
  assert.doesNotMatch(raw, /password|idToken|refreshToken|accessToken/i);
});

test("27 approval operations write no operational collection", async () => {
  const world = await seedHandover();
  const before = await operationalFingerprint();

  const first = await requestAs(SUPERVISOR, world);
  await countersignAs(ADMIN, first.view.approval.id);
  await voidAs(ADMIN, first.view.approval.id, "void_no_operational_writes");
  await reissueAs(SUPERVISOR, first.view.approval.id, "reissue_no_operational_writes");

  const after = await operationalFingerprint();
  assert.equal(after, before, "no operational collection may change");

  const approvals = await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION)
    .where("handoverDocumentId", "==", world.handoverDocumentId).get();
  assert.equal(approvals.size, 2, "one voided original and one reissued intent");
});

test("28 a handover whose guard is unreadable is refused", async () => {
  const world = await seedHandover();
  await db.doc(`handover_reservation_guards/${world.guard.id}`).update({ guardRevision: 0 });
  await assert.rejects(
    () => requestAs(SUPERVISOR, world),
    failsWith("RECOVERY_APPROVAL_HANDOVER_UNREADABLE"),
  );
});

test("29 an unknown handover is not found", async () => {
  await assert.rejects(
    () => requestHandoverRecoveryApproval({
      actorUid: SUPERVISOR,
      handoverDocumentId: "handover_v2_absent",
      intent: { handoverDocumentId: "handover_v2_absent", reason: REASON, idempotencyKey: "absent_handover" },
      authentication: authentication(SUPERVISOR),
    }),
    failsWith("RECOVERY_APPROVAL_HANDOVER_NOT_FOUND"),
  );
});

// ---------------------------------------------------------------------------
// 7. The trusted HTTP boundary (injected, no network)
// ---------------------------------------------------------------------------

const ACTOR = {
  uid: ADMIN,
  email: "approval-admin@example.test",
  role: "admin",
  mustChangePassword: false,
};

function account(overrides = {}) {
  return {
    uid: ADMIN,
    email: "approval-admin@example.test",
    disabled: false,
    ...overrides,
  };
}

function clockDependency(times, monotonic = [1_000, 1_000, 1_000]) {
  let index = 0;
  let monoIndex = 0;
  return {
    nowIso: () => times[Math.min(index++, times.length - 1)],
    monotonicMs: () => monotonic[Math.min(monoIndex++, monotonic.length - 1)],
  };
}

test("30 the boundary binds the proof to the session subject and never returns the password", async () => {
  let reauthenticated = null;
  const base = await authenticateHandoverRecoveryApproval(
    { actor: ACTOR, password: "  current-password  " },
    {
      auth: { getUser: async () => account() },
      reauthenticate: async (input) => {
        reauthenticated = input;
        return { uid: ADMIN };
      },
      clock: clockDependency([AT, AT, "2026-11-01T09:00:05.000Z"], [1_000, 1_000, 5_000]),
      createNonce: () => "nonce_boundary",
    },
  );

  assert.deepEqual(reauthenticated, {
    expectedUid: ADMIN,
    email: "approval-admin@example.test",
    password: "  current-password  ",
  });
  assert.deepEqual(Object.keys(base).sort(), [
    "actorUid",
    "authAccountCheckedAt",
    "nowIso",
    "nowMonotonicMs",
    "requestNonce",
    "verifiedAt",
    "verifiedAtMonotonicMs",
  ]);
  assert.equal(base.actorUid, ADMIN);
  assert.equal(base.requestNonce, "nonce_boundary");
  assert.equal(base.verifiedAt, AT);
  assert.equal(base.authAccountCheckedAt, AT);
  assert.equal(base.nowIso, "2026-11-01T09:00:05.000Z");
  assertNoCredentialMaterial(base, "authentication base");
});

test("31 the boundary refuses missing, disabled and mismatched accounts before any verification", async () => {
  const cases = [
    async () => null,
    async () => account({ disabled: true }),
    async () => account({ uid: "someone-else" }),
    async () => account({ email: "other@example.test" }),
    async () => account({ email: "" }),
  ];
  for (const getUser of cases) {
    let verified = false;
    await assert.rejects(
      () => authenticateHandoverRecoveryApproval(
        { actor: ACTOR, password: "current-password" },
        {
          auth: { getUser },
          reauthenticate: async () => {
            verified = true;
            return { uid: ADMIN };
          },
          clock: clockDependency([AT, AT, AT]),
          createNonce: () => "nonce_refused",
        },
      ),
      failsWith("RECOVERY_APPROVAL_ROLE_FORBIDDEN"),
    );
    assert.equal(verified, false, "no password may be sent for an unusable account");
  }
});

test("32 the boundary refuses an account that changes during verification", async () => {
  let calls = 0;
  await assert.rejects(
    () => authenticateHandoverRecoveryApproval(
      { actor: ACTOR, password: "current-password" },
      {
        auth: {
          getUser: async () => {
            calls += 1;
            return calls === 1 ? account() : account({ email: "changed@example.test" });
          },
        },
        reauthenticate: async () => ({ uid: ADMIN }),
        clock: clockDependency([AT, AT, AT]),
        createNonce: () => "nonce_changed",
      },
    ),
    failsWith("RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED"),
  );
  assert.equal(calls, 2);
});

test("33 the boundary propagates credential rejection and never invents success", async () => {
  for (const code of ["CREDENTIAL_REJECTED", "IDENTITY_MISMATCH", "SERVICE_UNAVAILABLE"]) {
    await assert.rejects(
      () => authenticateHandoverRecoveryApproval(
        { actor: ACTOR, password: "wrong-password" },
        {
          auth: { getUser: async () => account() },
          reauthenticate: async () => {
            throw new PasswordReauthenticationError(code);
          },
          clock: clockDependency([AT, AT, AT]),
          createNonce: () => "nonce_rejected",
        },
      ),
      (error) => error instanceof PasswordReauthenticationError && error.code === code,
    );
  }
});

test("34 the boundary refuses a clock that moves backwards", async () => {
  await assert.rejects(
    () => authenticateHandoverRecoveryApproval(
      { actor: ACTOR, password: "current-password" },
      {
        auth: { getUser: async () => account() },
        reauthenticate: async () => ({ uid: ADMIN }),
        clock: clockDependency(["2026-11-01T09:00:05.000Z", "2026-11-01T09:00:04.000Z", AT], [5_000, 4_000, 4_000]),
        createNonce: () => "nonce_backwards",
      },
    ),
    failsWith("RECOVERY_APPROVAL_AUTHENTICATION_INVALID"),
  );
});

test("35 there is no execution surface on the approval collection", async () => {
  const services = await import("../src/lib/operations/handover-recovery-approval-firestore.ts");
  const exported = Object.keys(services).filter((name) => typeof services[name] === "function");
  assert.deepEqual(exported.sort(), [
    "countersignHandoverRecoveryApproval",
    "listHandoverRecoveryApprovals",
    "readHandoverRecoveryApproval",
    "reissueHandoverRecoveryApproval",
    "requestHandoverRecoveryApproval",
    "voidHandoverRecoveryApproval",
  ]);
  for (const forbidden of ["execute", "recover", "abandon", "cancel", "complete", "activate", "consume"]) {
    // Strip the domain noun so "requestHandoverRecoveryApproval" is not read as
    // a "recover" verb; only an execution action may never be exported.
    const normalized = exported.map((name) => name.replace(/Recovery/g, ""));
    assert.ok(
      !normalized.some((name) => name.toLowerCase().includes(forbidden)),
      `unexpected ${forbidden} export`,
    );
  }
});
