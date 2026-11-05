/**
 * Phase 8C.4B — isolated Firestore emulator suite for Version 2 dual approval.
 *
 * The world is the real committed-handover fixture used by 8C.4A, seeded into a
 * disposable store, so every binding an approval carries is produced by the
 * production classifier reading production documents — never by a stub.
 *
 * What is proved here:
 *   - a request binds the classifier's digest AND its classification, and both
 *     are re-derived inside the writing transaction;
 *   - the second signature is refused, not rebound, when the evidence moves
 *     between the two signatures (review case, live acceptance) or when the
 *     stored record was tampered with (a self-contradicting edit reads as
 *     corrupt history, a self-consistent one reads as stale);
 *   - only a different human in the complementary role can sign, with a fresh
 *     proof inside the 60-second proof window and inside the 24-hour intent
 *     window;
 *   - void is terminal, reissue mints a new identity that is reclassified rather
 *     than inherited, and replay is exact;
 *   - the §2 orphan correction reaches the approval seam: a finalized operation
 *     without its evidence can no longer be requested;
 *   - the two approval collections are the ONLY writes, expiry is derived at
 *     read time with no write, and no state — including `fully_approved` —
 *     carries execution authority;
 *   - the Version 1 collection is never read, migrated or rewritten.
 *
 * Run via: tests/run-handover-recovery-approval-v2-emulator.ps1
 *
 * Safety invariant: project "demo-recovery-approval-v2-8c4b" on dedicated port
 * 8189 only, ephemeral instance, no import/export. Protected presentation, UAT
 * and every other milestone stack is never contacted. The real password seam is
 * not called, so the closed emulator allowlist is untouched.
 */
import assert from "node:assert/strict";
import test from "node:test";

const project = "demo-recovery-approval-v2-8c4b";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8189", "localhost:8189"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  ) ||
  process.env.RECOVERY_APPROVAL_V2_EMULATOR !== "true"
) {
  throw new Error("Refusing to run Version 2 approval tests outside the isolated disposable emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The Version 2 approval suite drives services directly, with no dev feature flag.");
}
if (process.env.HANDOVER_V2_ATOMIC_ACCEPTANCE) {
  throw new Error("The Version 2 approval suite must not inherit the atomic acceptance flag.");
}

const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { Timestamp } = await import("firebase-admin/firestore");
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { acceptanceFixture } = await import("./helpers/acceptance-integrity-fixtures.mjs");
const v2 = await import("../src/lib/operations/handover-recovery-approval-v2-firestore.ts");
const v2Domain = await import("../src/lib/operations/handover-recovery-approval-v2-domain.ts");
const eligibility = await import("../src/lib/operations/handover-recovery-eligibility-firestore.ts");
const adminReviewDomain = await import("../src/lib/operations/handover-admin-review-domain.ts");
const applicationDomain = await import("../src/lib/operations/incoming-acceptance-application-domain.ts");
const { createEqualHandoverSnapshot } = await import(
  "../src/lib/operations/equal-technician-handover-domain.ts"
);
const { HANDOVER_REVIEW_CASE_SCHEMA, HANDOVER_REVIEW_CASE_STATUSES } = await import(
  "../src/types/handover-admin-review.ts"
);
const {
  HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION,
  HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON,
  HANDOVER_RECOVERY_APPROVAL_V2_STATUSES,
} = await import("../src/types/handover-recovery-approval-v2.ts");
const { HANDOVER_RECOVERY_APPROVAL_COLLECTION } = await import(
  "../src/types/handover-recovery-approval.ts"
);

const db = getAdminFirestore();
const ELIGIBLE = "eligible_for_abandonment_review";
const HANDOVER_NOT_APPLICABLE = "handover_not_applicable";
const REASON = "Recover the stalled outgoing handover after review.";
const VOID_REASON = "The evidence moved; this intent is withdrawn.";

const SUPERVISOR = "v2-supervisor";
const SUPERVISOR_TWO = "v2-supervisor-two";
const ADMIN = "v2-admin";
const ADMIN_TWO = "v2-admin-two";
const TECHNICIAN_ACTOR = "v2-technician";
const SUSPENDED_ADMIN = "v2-suspended-admin";
const PASSWORD_ADMIN = "v2-password-admin";

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

const frozenWorld = await acceptanceFixture();
const baseAggregate = frozenWorld.records.get("equal_handovers_v2/handover_v2_outgoing");
assert.ok(baseAggregate, "The fixture aggregate is missing.");

const HANDOVER_DOCUMENT_ID = "handover_v2_outgoing";
const AGGREGATE_PATH = `equal_handovers_v2/${HANDOVER_DOCUMENT_ID}`;
const GUARD_PATH = "handover_reservation_guards/guard_outgoing";
const INCOMING_SHIFT_ID = baseAggregate.identity.incomingShiftId;
const [IN_A] = baseAggregate.identity.incomingTechnicianIds;
const HANDOVER_ID = baseAggregate.reservation.handoverId;
const LEGACY_PATH = "handovers/handover_outgoing";
const OUTGOING_SHIFT_ID = baseAggregate.identity.outgoingShiftId;

const IN_A_IDENTITY = applicationDomain.createIncomingAcceptanceApplicationIdentity({
  handoverId: HANDOVER_ID,
  technicianUid: IN_A,
  kind: "incoming_clock_in",
});
const ORPHAN_OPERATION_PATH = `attendance_evidence_operations_v2/${IN_A_IDENTITY.operationId}`;

const seedRecords = new Map(frozenWorld.records);
const realLegacyRecord = seedRecords.get(LEGACY_PATH);
assert.ok(realLegacyRecord, "The fixture writes no legacy handover record.");
// A v2-native reservation world must not carry a competing legacy record.
seedRecords.delete(LEGACY_PATH);

// The activation window is genuinely closed here: the window is derived from the
// fixture's own scheduled start, so the classifier can conclude.
const LATEST_ACTIVATION_MS = Date.parse(baseAggregate.identity.scheduledStart) + 60 * 60_000;
const CLOCK_START = LATEST_ACTIVATION_MS + 60_000;
const INTENT_MAX_AGE_MS = v2Domain.HANDOVER_RECOVERY_APPROVAL_V2_INTENT_MAX_AGE_MS;

const clock = { now: CLOCK_START, mono: 100_000 };
let nonceSequence = 0;

const iso = (ms) => new Date(ms).toISOString();
const advance = (ms) => {
  clock.now += ms;
  clock.mono += ms;
};

function authentication(actorUid, role, overrides = {}) {
  return {
    actorUid,
    requestNonce: `v2-nonce-${++nonceSequence}`,
    verifiedAt: iso(clock.now - 1000),
    authAccountCheckedAt: iso(clock.now - 500),
    verifiedAtMonotonicMs: clock.mono - 1000,
    nowIso: iso(clock.now),
    nowMonotonicMs: clock.mono,
    ...overrides,
    // role is carried only so a test can build a mismatched proof; the service
    // derives the role from the live user document.
    ...(overrides.actorRole ? { actorRole: overrides.actorRole } : {}),
  };
}

function toFirestore(value) {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "object" &&
    Number.isSafeInteger(value.seconds) &&
    Number.isSafeInteger(value.nanoseconds)
  ) {
    return new Timestamp(value.seconds, value.nanoseconds);
  }
  // A Timestamp read back out of the store keeps its clock on the prototype, so
  // spreading one leaves only _seconds/_nanoseconds. Those must still round-trip
  // as a Timestamp: written as a plain map the production readers hydrate the
  // field to null and the document refuses for a reason unrelated to the model
  // under test.
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isSafeInteger(value._seconds) &&
    Number.isSafeInteger(value._nanoseconds)
  ) {
    return new Timestamp(value._seconds, value._nanoseconds);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toFirestore);
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toFirestore(item);
    }
    return result;
  }
  return value;
}

async function clearDatabase() {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200, "The disposable emulator database could not be cleared.");
}

async function writeWorld() {
  await clearDatabase();
  let batch = db.batch();
  let queued = 0;
  for (const [path, value] of seedRecords) {
    batch.set(db.doc(path), toFirestore(structuredClone(value)));
    queued += 1;
    if (queued === 400) {
      await batch.commit();
      batch = db.batch();
      queued = 0;
    }
  }
  if (queued > 0) await batch.commit();

  const viewer = (await db.doc("users/manager").get()).data();
  assert.ok(viewer, "The seeded world has no actor user document to clone.");
  const approvers = [
    [SUPERVISOR, "supervisor", {}],
    [SUPERVISOR_TWO, "supervisor", {}],
    [ADMIN, "admin", {}],
    [ADMIN_TWO, "admin", {}],
    [TECHNICIAN_ACTOR, "technician", {}],
    [SUSPENDED_ADMIN, "admin", { status: "suspended" }],
    [PASSWORD_ADMIN, "admin", { mustChangePassword: true }],
  ];
  for (const [uid, role, extra] of approvers) {
    await db.doc(`users/${uid}`).set(
      toFirestore({
        ...structuredClone(viewer),
        uid,
        id: uid,
        fullName: uid,
        role,
        status: "active",
        statusOperation: null,
        mustChangePassword: false,
        ...extra,
      }),
    );
  }
  // A Version 1 approval document is planted to prove nothing here reads,
  // migrates or rewrites it.
  await db.doc(`${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/v1-plant`).set(
    toFirestore({ schema: "handover-recovery-approval-v1", planted: true }),
  );
  clock.now = CLOCK_START;
  clock.mono = 100_000;
  return structuredClone(seedRecords.get(AGGREGATE_PATH));
}

const evaluate = (atMs = clock.now) => eligibility.evaluateHandoverRecoveryEligibility({
  handoverDocumentId: HANDOVER_DOCUMENT_ID,
  actorUid: SUPERVISOR,
  now: new Date(atMs),
});

function stamp(value) {
  return value ? `${value.seconds}/${value.nanoseconds}` : "none";
}

async function storeFingerprint() {
  const out = [];
  for (const collection of await db.listCollections()) {
    const snapshot = await db.collection(collection.id).get();
    for (const doc of snapshot.docs) {
      out.push(`${doc.ref.path}|${stamp(doc.createTime)}|${stamp(doc.updateTime)}`);
    }
  }
  out.sort();
  return out;
}

async function readDoc(path) {
  const snapshot = await db.doc(path).get();
  return snapshot.exists ? snapshot.data() : null;
}

function touchedPaths(before, after) {
  const left = new Map(before.map((line) => [line.split("|")[0], line]));
  const changed = [];
  for (const line of after) {
    const path = line.split("|")[0];
    if (left.get(path) !== line) changed.push(path);
  }
  for (const path of left.keys()) {
    if (!after.some((line) => line.split("|")[0] === path)) changed.push(path);
  }
  return Array.from(new Set(changed)).sort();
}

// Every write this service may ever make lives in these two collections.
function assertApprovalOnlyWrites(changed) {
  for (const path of changed) {
    assert.ok(
      path.startsWith(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/`) ||
        path.startsWith("audit_logs/handover_recovery_approval_v2_"),
      `the Version 2 approval service wrote outside its own two collections: ${path}`,
    );
  }
}

async function requestBy(actorUid, role, intent = {}) {
  return v2.requestHandoverRecoveryApprovalV2({
    actorUid,
    intent: {
      handoverDocumentId: HANDOVER_DOCUMENT_ID,
      reason: intent.reason ?? REASON,
      idempotencyKey: intent.idempotencyKey ?? `request-${++nonceSequence}`,
    },
    authentication: authentication(actorUid, role, intent.authentication ?? {}),
  });
}

async function countersignBy(actorUid, approvalId, expectedRevision = 1, overrides = {}) {
  return v2.countersignHandoverRecoveryApprovalV2({
    approvalId,
    actorUid,
    intent: { expectedRevision },
    authentication: authentication(actorUid, null, overrides),
  });
}

async function expectRefusal(operation, code, status) {
  const error = await operation().then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error, `expected a ${code} refusal, but the operation succeeded`);
  assert.equal(error.name, "HandoverRecoveryApprovalV2Error", String(error));
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return error;
}

async function reviewedBinding() {
  const aggregate = await readDoc(AGGREGATE_PATH);
  const guard = await readDoc(GUARD_PATH);
  return {
    handoverId: aggregate.reservation.handoverId,
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    aggregateRevision: aggregate.revision,
    snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
    report: { ...aggregate.reportBinding, aggregateRevision: aggregate.revision },
    guardRevision: guard.guardRevision,
    fencingEpoch: guard.fencingEpoch,
  };
}

// Drives the production acceptance writer, so "the evidence moved" is a real
// commit by the live path rather than a hand-written document.
async function applyIncoming(uid) {
  const { applyIncomingAcceptanceApplicationAtomically } = await import(
    "../src/lib/operations/incoming-acceptance-application-firestore.ts"
  );
  const aggregate = await readDoc(AGGREGATE_PATH);
  const appliedMs = Math.max(
    Date.parse(aggregate.updatedAt) + 60_000,
    Date.parse(aggregate.identity.scheduledStart) + 60_000,
  );
  const binding = await reviewedBinding();
  const requestNonce = `v2-accept-${uid}-${appliedMs}`;
  const proof = applicationDomain.createIncomingAcceptanceAuthenticationProof({
    requestNonce,
    verifiedTechnicianUid: uid,
    verifiedAt: iso(appliedMs - 2000),
    authAccountCheckedAt: iso(appliedMs - 1000),
    reviewedBinding: binding,
    lateReason: null,
    verifiedAtMonotonicMs: 1_000_000,
  });
  return applyIncomingAcceptanceApplicationAtomically({
    outgoingShiftId: OUTGOING_SHIFT_ID,
    actorUid: uid,
    reviewedBinding: binding,
    lateReason: null,
    requestNonce,
    proof,
    requestAcceptedAt: iso(appliedMs - 3000),
    operationalAppliedAt: iso(appliedMs),
    nowIso: iso(appliedMs + 100),
    nowMonotonicMs: 1_004_000,
  });
}

// A genuine finalized orphan: the operation document is written by the real
// acceptance writer, then the paired evidence document alone is removed.
async function captureFinalizedOperation() {
  await writeWorld();
  const applied = await applyIncoming(IN_A);
  assert.equal(applied.status, "APPLIED", "the live acceptance did not apply");
  const operation = await readDoc(ORPHAN_OPERATION_PATH);
  assert.ok(operation, `the acceptance wrote no operation at ${ORPHAN_OPERATION_PATH}`);
  assert.equal(operation.status, "finalized", "the captured operation is not finalized");
  return structuredClone(operation);
}

function reviewCaseDocument(overrides) {
  return {
    schema: HANDOVER_REVIEW_CASE_SCHEMA,
    id: adminReviewDomain.createHandoverReviewCaseId(HANDOVER_DOCUMENT_ID),
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    status: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
    caseRevision: 1,
    fingerprintAtLastDecision: "d".repeat(64),
    ...overrides,
  };
}

const REVIEW_CASE_PATH = `handover_review_cases_v1/${adminReviewDomain.createHandoverReviewCaseId(
  HANDOVER_DOCUMENT_ID,
)}`;

// ---------------------------------------------------------------------------
// 1. The first signature
// ---------------------------------------------------------------------------

test("01 a request binds the classifier digest and classification to one intent", async () => {
  await writeWorld();
  const baseline = await evaluate();
  assert.equal(baseline.result.classification, ELIGIBLE, "the seeded world is not eligible");

  const outcome = await requestBy(SUPERVISOR, "supervisor");
  assert.equal(outcome.replayed, false);
  const record = outcome.view.approval;

  assert.equal(outcome.view.effectiveStatus, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL);
  assert.equal(outcome.view.approvalCount, 1);
  assert.equal(outcome.view.requiredSecondRole, "admin");
  assert.equal(record.binding.evidence.evidenceDigest, baseline.result.evidenceDigest.value);
  assert.equal(record.binding.evidence.classification, baseline.result.classification);
  assert.equal(record.binding.evidence.evidenceDigestSchemaVersion, 2);
  assert.equal(record.binding.evidence.eligibilitySchemaVersion, 1);
  assert.equal(record.binding.aggregateRevision, baseline.readModel.aggregate.revision);
  assert.equal(record.binding.guardRevision, baseline.readModel.guard.guardRevision);
  assert.equal(record.handoverDocumentId, HANDOVER_DOCUMENT_ID);
  assert.equal(record.outgoingShiftId, OUTGOING_SHIFT_ID);
  assert.equal(record.incomingShiftId, INCOMING_SHIFT_ID);
  assert.equal(record.requestedBy, SUPERVISOR);
  assert.equal(record.revision, 1);
  assert.equal(record.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL);
  assert.equal(record.approvals.length, 1);
  assert.equal(record.approvals[0].actorUid, SUPERVISOR);
  assert.equal(record.approvals[0].actorRole, "supervisor");
  assert.match(record.approvals[0].proofFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    record.nonExecutableReason,
    HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON,
  );
  // Never supplied by a caller, and never true.
  assert.equal(record.recoveryExecutionEligible, false);
  assert.equal(outcome.view.recoveryExecutionEligible, false);
  assert.match(record.intentFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    record.expiresAt,
    iso(Date.parse(record.requestedAt) + INTENT_MAX_AGE_MS),
  );
});

test("02 requesting writes exactly one approval and one audit, nothing operational", async () => {
  await writeWorld();
  const before = await storeFingerprint();
  const outcome = await requestBy(SUPERVISOR, "supervisor");
  const after = await storeFingerprint();

  const changed = touchedPaths(before, after);
  assertApprovalOnlyWrites(changed);
  assert.deepEqual(
    changed,
    [
      `audit_logs/${outcome.auditId}`,
      `${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${outcome.view.approval.id}`,
    ].sort(),
    "a request wrote more than the approval and its audit entry",
  );
  const audit = await readDoc(`audit_logs/${outcome.auditId}`);
  assert.equal(audit.recoveryExecutionEligible, false);
  assert.equal(audit.eligibilityClassification, ELIGIBLE);
  assert.equal(audit.evidenceDigest, outcome.view.approval.binding.evidence.evidenceDigest);
});

test("03 the same person repeating the same intent replays without a second record", async () => {
  await writeWorld();
  const intent = { idempotencyKey: "stable-key" };
  const first = await requestBy(SUPERVISOR, "supervisor", intent);
  const storedApproval = await readDoc(
    `${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${first.view.approval.id}`,
  );
  const before = await storeFingerprint();

  const again = await requestBy(SUPERVISOR, "supervisor", intent);
  assert.equal(again.replayed, true);
  assert.equal(again.view.approval.id, first.view.approval.id);
  assert.equal(again.auditId, first.auditId);

  const after = await storeFingerprint();
  assert.deepEqual(touchedPaths(before, after), [], "a replay wrote to the store");
  assert.deepEqual(
    await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${first.view.approval.id}`),
    storedApproval,
    "a replay rewrote the approval",
  );
});

test("04 a different reason or a different first approver conflicts instead of forking", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");

  await expectRefusal(
    () => requestBy(SUPERVISOR, "supervisor", { reason: "A different claim entirely." }),
    "RECOVERY_APPROVAL_V2_REQUEST_CONFLICT",
    409,
  );
  await expectRefusal(
    () => requestBy(SUPERVISOR_TWO, "supervisor"),
    "RECOVERY_APPROVAL_V2_REQUEST_CONFLICT",
    409,
  );

  const views = await v2.listHandoverRecoveryApprovalsV2({
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    nowIso: iso(clock.now),
  });
  assert.equal(views.length, 1, "a conflicting request created a second approval");
  assert.equal(views[0].approval.id, first.view.approval.id);
});

test("05 only a live supervisor or administrator may request", async () => {
  await writeWorld();
  for (const uid of [TECHNICIAN_ACTOR, SUSPENDED_ADMIN, PASSWORD_ADMIN]) {
    await expectRefusal(
      () => requestBy(uid, "supervisor"),
      "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN",
      403,
    );
  }
  const before = await storeFingerprint();
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

test("06 an unknown handover is refused, and never becomes an approval", async (t) => {
  await writeWorld();
  const before = await storeFingerprint();

  // A malformed or non-canonical ID is refused while the request is prepared,
  // before any transaction opens, so it never takes part in a read. This is the
  // only path that reaches HANDOVER_NOT_FOUND.
  for (const id of ["not_a_handover_document", "handover_"]) {
    await expectRefusal(
      () =>
        v2.requestHandoverRecoveryApprovalV2({
          actorUid: SUPERVISOR,
          intent: { handoverDocumentId: id, reason: REASON, idempotencyKey: `malformed-${id}` },
          authentication: authentication(SUPERVISOR, "supervisor"),
        }),
      "RECOVERY_APPROVAL_V2_HANDOVER_NOT_FOUND",
      404,
    );
  }

  // A well-formed ID with no aggregate is a classifier conclusion rather than a
  // bad request: the classifier refuses it as handover_not_applicable /
  // HANDOVER_NOT_FOUND, and the approval seam reports that same conclusion. Both
  // codes authorize nothing; only the first is a 404.
  const absent = "handover_v2_does_not_exist";
  const reading = await eligibility.evaluateHandoverRecoveryEligibility({
    handoverDocumentId: absent,
    actorUid: SUPERVISOR,
    now: new Date(clock.now),
  });
  assert.equal(reading.result.classification, HANDOVER_NOT_APPLICABLE);
  const error = await expectRefusal(
    () =>
      v2.requestHandoverRecoveryApprovalV2({
        actorUid: SUPERVISOR,
        intent: { handoverDocumentId: absent, reason: REASON, idempotencyKey: "absent-handover" },
        authentication: authentication(SUPERVISOR, "supervisor"),
      }),
    "RECOVERY_APPROVAL_V2_NOT_ELIGIBLE",
    409,
  );
  assert.match(error.message, /No equal-handover v2 aggregate exists/);
  t.diagnostic(
    "absent handover: classifier " +
      `${reading.result.classification} -> approval ${error.code} (${error.status}); ` +
      "unparseable id -> RECOVERY_APPROVAL_V2_HANDOVER_NOT_FOUND (404)",
  );

  const views = await v2.listHandoverRecoveryApprovalsV2({
    handoverDocumentId: absent,
    nowIso: iso(clock.now),
  });
  assert.equal(views.length, 0, "an approval exists for a handover that does not exist");
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "an unknown handover wrote");
});

test("07 an open activation window is not eligible and cannot be requested", async () => {
  await writeWorld();
  const open = LATEST_ACTIVATION_MS - 60_000;
  const reading = await eligibility.evaluateHandoverRecoveryEligibility({
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    actorUid: SUPERVISOR,
    now: new Date(open),
  });
  assert.notEqual(reading.result.classification, ELIGIBLE);

  const error = await expectRefusal(
    () =>
      v2.requestHandoverRecoveryApprovalV2({
        actorUid: SUPERVISOR,
        intent: {
          handoverDocumentId: HANDOVER_DOCUMENT_ID,
          reason: REASON,
          idempotencyKey: "window-open",
        },
        authentication: authentication(SUPERVISOR, "supervisor", {
          nowIso: iso(open),
          nowMonotonicMs: clock.mono,
          verifiedAt: iso(open - 1000),
          authAccountCheckedAt: iso(open - 500),
          verifiedAtMonotonicMs: clock.mono - 1000,
        }),
      }),
    "RECOVERY_APPROVAL_V2_NOT_ELIGIBLE",
    409,
  );
  assert.match(error.message, /cannot be approved for recovery/);
});

// ---------------------------------------------------------------------------
// 2. The §2 orphan correction, end to end
// ---------------------------------------------------------------------------

test("08 a finalized orphan operation is refused by the classifier and cannot be requested", async (t) => {
  const operation = await captureFinalizedOperation();
  await writeWorld();
  assert.equal((await evaluate()).result.classification, ELIGIBLE, "the clean world must be eligible");

  await db.doc(ORPHAN_OPERATION_PATH).set(toFirestore(operation));
  const reading = await evaluate();
  // A refusal carries the classifier's own classification as its code and the
  // §2 detail name as its detail, e.g. inconsistent_evidence +
  // OPERATION_WITHOUT_EVIDENCE.
  const details = Array.from(reading.result.refusals, (entry) => `${entry.code}:${entry.detail}`);
  assert.ok(
    details.includes("inconsistent_evidence:OPERATION_WITHOUT_EVIDENCE"),
    `the orphan did not refuse: ${reading.result.classification} ${JSON.stringify(details)}`,
  );
  assert.notEqual(reading.result.classification, ELIGIBLE);
  t.diagnostic(`orphan classification: ${reading.result.classification} ${JSON.stringify(details)}`);

  await expectRefusal(
    () => requestBy(SUPERVISOR, "supervisor", { idempotencyKey: "orphan-world" }),
    "RECOVERY_APPROVAL_V2_NOT_ELIGIBLE",
    409,
  );
  const views = await v2.listHandoverRecoveryApprovalsV2({
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    nowIso: iso(clock.now),
  });
  assert.equal(views.length, 0, "an approval was created over refused evidence");
});

// ---------------------------------------------------------------------------
// 3. The second signature
// ---------------------------------------------------------------------------

test("09 the complementary role completes the intent and preserves the first signature", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const firstSignature = structuredClone(first.view.approval.approvals[0]);
  const before = await storeFingerprint();

  const second = await countersignBy(ADMIN, first.view.approval.id);
  assert.equal(second.replayed, false);
  const record = second.view.approval;

  assert.equal(record.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.FULLY_APPROVED);
  assert.equal(second.view.effectiveStatus, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.FULLY_APPROVED);
  assert.equal(second.view.approvalCount, 2);
  assert.equal(second.view.requiredSecondRole, null);
  assert.equal(record.revision, 2);
  assert.deepEqual(record.approvals[0], firstSignature, "the first signature was rewritten");
  assert.equal(record.approvals[1].actorUid, ADMIN);
  assert.equal(record.approvals[1].actorRole, "admin");
  assert.notEqual(record.approvals[1].proofFingerprint, record.approvals[0].proofFingerprint);
  assert.equal(record.recoveryExecutionEligible, false);
  assert.equal(second.view.recoveryExecutionEligible, false);
  assert.equal(
    record.nonExecutableReason,
    HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON,
  );
  // Completing the intent still binds the same canonical evidence.
  assert.equal(record.intentFingerprint, first.view.approval.intentFingerprint);
  assert.equal(
    record.binding.evidence.evidenceDigest,
    first.view.approval.binding.evidence.evidenceDigest,
  );

  const changed = touchedPaths(before, await storeFingerprint());
  assertApprovalOnlyWrites(changed);
  assert.deepEqual(
    changed,
    [
      `audit_logs/${second.auditId}`,
      `${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${record.id}`,
    ].sort(),
  );
});

test("10 the same person, the same role, or a third signer cannot complete the intent", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;

  await expectRefusal(() => countersignBy(SUPERVISOR, approvalId), "RECOVERY_APPROVAL_V2_DUPLICATE_ACTOR", 409);
  await expectRefusal(() => countersignBy(SUPERVISOR_TWO, approvalId), "RECOVERY_APPROVAL_V2_ROLE_CONFLICT", 409);
  await expectRefusal(() => countersignBy(TECHNICIAN_ACTOR, approvalId), "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN", 403);
  await expectRefusal(() => countersignBy(SUSPENDED_ADMIN, approvalId), "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN", 403);

  const stored = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.equal(stored.approvals.length, 1, "a refused countersignature was appended anyway");
  assert.equal(stored.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL);
});

test("11 a stale expectedRevision refuses before any evidence is re-read", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  await expectRefusal(
    () => countersignBy(ADMIN, first.view.approval.id, 77),
    "RECOVERY_APPROVAL_V2_STALE",
    409,
  );
});

test("12 evidence that moves between signatures refuses the second one, never rebinds it", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;
  const boundDigest = first.view.approval.binding.evidence.evidenceDigest;
  const stored = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);

  // A valid open review case keeps the handover eligible but is bound into the
  // digest, so the digest moves while the classification does not.
  await db.doc(REVIEW_CASE_PATH).set(toFirestore(reviewCaseDocument({})));
  const moved = await evaluate();
  assert.equal(moved.result.classification, ELIGIBLE, "the review case must not change eligibility");
  assert.notEqual(
    moved.result.evidenceDigest.value,
    boundDigest,
    "the review case was not bound into the digest",
  );

  const error = await expectRefusal(
    () => countersignBy(ADMIN, approvalId),
    "RECOVERY_APPROVAL_V2_STALE",
    409,
  );
  assert.match(error.message, /Void this intent and request a new one/);

  const after = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.deepEqual(after, stored, "the approval was silently rebound to the new evidence");

  // Reverting the move restores the original intent exactly, and the pending
  // approval becomes signable again.
  await db.doc(REVIEW_CASE_PATH).delete();
  const completed = await countersignBy(ADMIN, approvalId);
  assert.equal(completed.view.approval.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.FULLY_APPROVED);
  assert.equal(completed.view.approval.binding.evidence.evidenceDigest, boundDigest);
});

test("13 a live acceptance that lands between signatures refuses the second signature", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const applied = await applyIncoming(IN_A);
  assert.equal(applied.status, "APPLIED");
  const accepted = await evaluate();
  assert.notEqual(accepted.result.classification, ELIGIBLE, "an accepted handover still reads eligible");

  await expectRefusal(
    () => countersignBy(ADMIN, first.view.approval.id),
    "RECOVERY_APPROVAL_V2_NOT_ELIGIBLE",
    409,
  );
  const stored = await readDoc(
    `${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${first.view.approval.id}`,
  );
  assert.equal(stored.approvals.length, 1);
  assert.equal(stored.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL);
});

test("14 a tampered stored binding cannot be talked into matching new evidence", async (t) => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;
  const path = `${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`;
  const original = await readDoc(path);

  // Shape 1 — the record no longer binds to its own content. Its stored intent
  // fingerprint must equal the canonical fingerprint of its own binding, so a
  // lone edit makes the record corrupt history rather than merely out of date:
  // it is refused as STATE_INCONSISTENT and never repaired.
  await db.doc(path).update({ intentFingerprint: "b".repeat(64) });
  await expectRefusal(
    () => countersignBy(ADMIN, approvalId),
    "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT",
    409,
  );
  let stored = await readDoc(path);
  assert.equal(stored.intentFingerprint, "b".repeat(64), "the tampered fingerprint was repaired");
  assert.equal(stored.approvals.length, 1, "a corrupt record gained a signature");

  // Shape 2 — a tamper that is internally consistent: the digest is replaced and
  // the intent fingerprint is recomputed over the tampered binding, so the
  // record still validates but no longer names the evidence the store holds.
  // The second signature is refused as STALE; the real digest is never written
  // into the record to make the tamper pass.
  const tamperedBinding = {
    ...original.binding,
    evidence: { ...original.binding.evidence, evidenceDigest: "a".repeat(64) },
  };
  await db.doc(path).update({
    "binding.evidence.evidenceDigest": "a".repeat(64),
    intentFingerprint: v2Domain.createHandoverRecoveryApprovalV2IntentFingerprint(tamperedBinding),
  });
  const stale = await expectRefusal(
    () => countersignBy(ADMIN, approvalId),
    "RECOVERY_APPROVAL_V2_STALE",
    409,
  );
  assert.match(stale.message, /Void this intent and request a new one/);
  stored = await readDoc(path);
  assert.equal(stored.binding.evidence.evidenceDigest, "a".repeat(64), "the binding was rebound");
  assert.equal(stored.approvals.length, 1, "a tampered record gained a signature");
  assert.equal(stored.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL);
  t.diagnostic(
    "tampered record: self-contradicting edit -> STATE_INCONSISTENT, " +
      "self-consistent edit detached from the evidence -> STALE; neither rebinds or signs",
  );
});

test("15 the proof window and the clock both close the countersignature", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;

  // A proof older than 60 seconds is expired even though the intent is fresh.
  const stale = { verifiedAt: iso(clock.now - 61_000), verifiedAtMonotonicMs: clock.mono - 61_000 };
  await expectRefusal(
    () => countersignBy(ADMIN, approvalId, 1, stale),
    "RECOVERY_APPROVAL_V2_AUTHENTICATION_EXPIRED",
    401,
  );

  // Authentication clocks out of order.
  await expectRefusal(
    () =>
      countersignBy(ADMIN, approvalId, 1, {
        verifiedAt: iso(clock.now),
        authAccountCheckedAt: iso(clock.now - 500),
      }),
    "RECOVERY_APPROVAL_V2_AUTHENTICATION_INVALID",
    401,
  );

  // The subject of the proof is not the subject of the session.
  await expectRefusal(
    () =>
      v2.countersignHandoverRecoveryApprovalV2({
        approvalId,
        actorUid: ADMIN,
        intent: { expectedRevision: 1 },
        authentication: authentication(ADMIN_TWO, "admin"),
      }),
    "RECOVERY_APPROVAL_V2_AUTH_IDENTITY_CHANGED",
    403,
  );

  // The 24-hour intent window closes; nothing auto-voids it.
  advance(INTENT_MAX_AGE_MS + 1000);
  await expectRefusal(() => countersignBy(ADMIN, approvalId), "RECOVERY_APPROVAL_V2_EXPIRED", 409);
  const stored = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.equal(stored.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL);
  assert.equal(stored.approvals.length, 1);
});

// ---------------------------------------------------------------------------
// 4. Void and reissue
// ---------------------------------------------------------------------------

test("16 only an approver may void, and voiding never re-evaluates eligibility", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;

  // An administrator who never signed this intent cannot void it.
  await expectRefusal(
    () =>
      v2.voidHandoverRecoveryApprovalV2({
        approvalId,
        actorUid: ADMIN,
        intent: { reason: VOID_REASON, idempotencyKey: "void-by-non-signer" },
        authentication: authentication(ADMIN, "admin"),
      }),
    "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN",
    403,
  );

  // The evidence then moves, and the signer can still close the intent.
  await db.doc(REVIEW_CASE_PATH).set(toFirestore(reviewCaseDocument({})));
  const before = await storeFingerprint();
  const voided = await v2.voidHandoverRecoveryApprovalV2({
    approvalId,
    actorUid: SUPERVISOR,
    intent: { reason: VOID_REASON, idempotencyKey: "void-after-move" },
    authentication: authentication(SUPERVISOR, "supervisor"),
  });
  assert.equal(voided.view.approval.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED);
  assert.equal(voided.view.approval.voidedBy, SUPERVISOR);
  assert.equal(voided.view.approval.voidReason, VOID_REASON);
  assert.equal(voided.view.effectiveStatus, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED);
  // The bound digest is the one the signature was made against, not the moved one.
  assert.equal(
    voided.view.approval.binding.evidence.evidenceDigest,
    first.view.approval.binding.evidence.evidenceDigest,
  );
  const changed = touchedPaths(before, await storeFingerprint());
  assertApprovalOnlyWrites(changed);
  await db.doc(REVIEW_CASE_PATH).delete();
});

test("17 void is terminal: replay, re-void and re-request all refuse or replay", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;
  const voidIntent = { reason: VOID_REASON, idempotencyKey: "void-terminal" };
  const voided = await v2.voidHandoverRecoveryApprovalV2({
    approvalId,
    actorUid: SUPERVISOR,
    intent: voidIntent,
    authentication: authentication(SUPERVISOR, "supervisor"),
  });

  const replay = await v2.voidHandoverRecoveryApprovalV2({
    approvalId,
    actorUid: SUPERVISOR,
    intent: voidIntent,
    authentication: authentication(SUPERVISOR, "supervisor"),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.auditId, voided.auditId);
  assert.equal(replay.view.approval.voidAuditId, voided.view.approval.voidAuditId);

  await expectRefusal(
    () =>
      v2.voidHandoverRecoveryApprovalV2({
        approvalId,
        actorUid: SUPERVISOR,
        intent: { reason: "Another void attempt.", idempotencyKey: "void-again" },
        authentication: authentication(SUPERVISOR, "supervisor"),
      }),
    "RECOVERY_APPROVAL_V2_ALREADY_VOIDED",
    409,
  );
  await expectRefusal(
    () => countersignBy(ADMIN, approvalId),
    "RECOVERY_APPROVAL_V2_ALREADY_VOIDED",
    409,
  );
  await expectRefusal(
    () => requestBy(SUPERVISOR, "supervisor", { idempotencyKey: "re-request-voided" }),
    "RECOVERY_APPROVAL_V2_ALREADY_VOIDED",
    409,
  );

  const stored = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.deepEqual(
    stored.approvals,
    voided.view.approval.approvals,
    "a voided approval's signatures changed",
  );
});

test("18 reissue mints a new identity, reclassifies it, and preserves the original", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;
  await v2.voidHandoverRecoveryApprovalV2({
    approvalId,
    actorUid: SUPERVISOR,
    intent: { reason: VOID_REASON, idempotencyKey: "void-for-reissue" },
    authentication: authentication(SUPERVISOR, "supervisor"),
  });
  const voidedRecord = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);

  const reissueIntent = { reason: "Reconsidered after review.", idempotencyKey: "reissue-one" };
  const reissued = await v2.reissueHandoverRecoveryApprovalV2({
    approvalId,
    actorUid: ADMIN,
    intent: reissueIntent,
    authentication: authentication(ADMIN, "admin"),
  });
  const newPath = `${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${reissued.view.approval.id}`;

  assert.notEqual(reissued.view.approval.id, approvalId);
  assert.equal(reissued.view.approval.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL);
  assert.equal(reissued.view.approval.approvals.length, 1);
  assert.equal(reissued.view.approval.approvals[0].actorUid, ADMIN);
  assert.equal(reissued.view.approval.replacesApprovalId, approvalId);
  assert.equal(reissued.view.approval.recoveryExecutionEligible, false);
  assert.equal(reissued.auditId, reissued.view.approval.requestAuditId);

  const original = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.equal(original.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED);
  assert.equal(original.reissuedAsApprovalId, reissued.view.approval.id);
  assert.deepEqual(original.approvals, voidedRecord.approvals, "the voided original was rewritten");
  assert.equal(original.binding.evidence.evidenceDigest, voidedRecord.binding.evidence.evidenceDigest);

  // A reissue is a fresh claim, so it is signed on its own identity.
  const completed = await countersignBy(SUPERVISOR, reissued.view.approval.id);
  assert.equal(completed.view.approval.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.FULLY_APPROVED);
  assert.equal((await readDoc(newPath)).approvals.length, 2);
});

test("19 reissue requires a voided original and one identity per reissue", async () => {
  await writeWorld();
  const live = await requestBy(SUPERVISOR, "supervisor");
  await expectRefusal(
    () =>
      v2.reissueHandoverRecoveryApprovalV2({
        approvalId: live.view.approval.id,
        actorUid: ADMIN,
        intent: { reason: "Too soon.", idempotencyKey: "reissue-live" },
        authentication: authentication(ADMIN, "admin"),
      }),
    "RECOVERY_APPROVAL_V2_NOT_VOIDED",
    409,
  );

  const approvalId = live.view.approval.id;
  await v2.voidHandoverRecoveryApprovalV2({
    approvalId,
    actorUid: SUPERVISOR,
    intent: { reason: VOID_REASON, idempotencyKey: "void-before-two-reissues" },
    authentication: authentication(SUPERVISOR, "supervisor"),
  });

  const intent = { reason: "First reissue.", idempotencyKey: "reissue-twice" };
  const first = await v2.reissueHandoverRecoveryApprovalV2({
    approvalId,
    actorUid: ADMIN,
    intent,
    authentication: authentication(ADMIN, "admin"),
  });
  const replay = await v2.reissueHandoverRecoveryApprovalV2({
    approvalId,
    actorUid: ADMIN,
    intent,
    authentication: authentication(ADMIN, "admin"),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.view.approval.id, first.view.approval.id);

  await expectRefusal(
    () =>
      v2.reissueHandoverRecoveryApprovalV2({
        approvalId,
        actorUid: ADMIN,
        intent: { reason: "Second reissue.", idempotencyKey: "reissue-other-key" },
        authentication: authentication(ADMIN, "admin"),
      }),
    "RECOVERY_APPROVAL_V2_ALREADY_REISSUED",
    409,
  );
});

test("20 a reissue is reclassified, not inherited from the voided original", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;
  await v2.voidHandoverRecoveryApprovalV2({
    approvalId,
    actorUid: SUPERVISOR,
    intent: { reason: VOID_REASON, idempotencyKey: "void-then-accept" },
    authentication: authentication(SUPERVISOR, "supervisor"),
  });

  await applyIncoming(IN_A);
  await expectRefusal(
    () =>
      v2.reissueHandoverRecoveryApprovalV2({
        approvalId,
        actorUid: ADMIN,
        intent: { reason: "Reconsidered.", idempotencyKey: "reissue-after-acceptance" },
        authentication: authentication(ADMIN, "admin"),
      }),
    "RECOVERY_APPROVAL_V2_NOT_ELIGIBLE",
    409,
  );

  const views = await v2.listHandoverRecoveryApprovalsV2({
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    nowIso: iso(clock.now),
  });
  assert.equal(views.length, 1, "a reissue over accepted evidence created a record");
  assert.equal(views[0].approval.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED);
});

// ---------------------------------------------------------------------------
// 5. Reads, expiry and the non-executable invariant
// ---------------------------------------------------------------------------

test("21 expiry is derived at read time and needs no scheduler or write", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;
  const path = `${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`;
  const before = await storeFingerprint();
  const stored = await readDoc(path);

  const later = Date.parse(stored.expiresAt) + 1000;
  const view = await v2.readHandoverRecoveryApprovalV2({ approvalId, nowIso: iso(later) });
  assert.equal(view.effectiveStatus, "expired");
  assert.equal(view.approval.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL);
  assert.equal(view.recoveryExecutionEligible, false);

  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "expiry wrote to the store");
  assert.deepEqual(await readDoc(path), stored, "expiry rewrote the approval");
});

test("22 a fully approved intent is still not executable, at any clock", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const completed = await countersignBy(ADMIN, first.view.approval.id);
  const approvalId = completed.view.approval.id;

  for (const atMs of [clock.now, clock.now + 1000, Date.parse(completed.view.approval.expiresAt) + 5_000]) {
    const view = await v2.readHandoverRecoveryApprovalV2({ approvalId, nowIso: iso(atMs) });
    assert.equal(view.recoveryExecutionEligible, false, `execution authority appeared at ${atMs}`);
    assert.equal(view.approval.recoveryExecutionEligible, false);
    assert.equal(
      view.approval.nonExecutableReason,
      HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON,
    );
  }

  const stored = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.equal(
    stored.binding.evidence.classification,
    ELIGIBLE,
    "an approval was stored against a non-eligible classification",
  );
});

test("23 listing is read-only, ordered, and refuses to render a corrupt record", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const before = await storeFingerprint();

  const views = await v2.listHandoverRecoveryApprovalsV2({
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    nowIso: iso(clock.now),
  });
  assert.equal(views.length, 1);
  assert.equal(views[0].approval.id, first.view.approval.id);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);

  await db.doc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${first.view.approval.id}`).update({
    approvals: [],
  });
  await expectRefusal(
    () => v2.listHandoverRecoveryApprovalsV2({ handoverDocumentId: HANDOVER_DOCUMENT_ID, nowIso: iso(clock.now) }),
    "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT",
    409,
  );
  await expectRefusal(
    () => v2.readHandoverRecoveryApprovalV2({ approvalId: first.view.approval.id, nowIso: iso(clock.now) }),
    "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT",
    409,
  );
});

test("24 concurrent countersignatures settle on exactly one pair of signatures", async (t) => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const approvalId = first.view.approval.id;
  const path = `${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`;

  // Two different humans in the complementary role race for the single second
  // slot. Only one may claim it; the other must refuse without appending a third
  // signature. Serialisation decides which one loses, so the loser's code is
  // recorded rather than prescribed — but both of its possible codes authorize
  // nothing.
  const raced = await Promise.allSettled([
    countersignBy(ADMIN, approvalId),
    countersignBy(ADMIN_TWO, approvalId),
  ]);
  const winners = raced.filter((entry) => entry.status === "fulfilled");
  const losers = raced.filter((entry) => entry.status === "rejected");
  assert.equal(winners.length, 1, "two different approvers both claimed the second slot");
  assert.equal(losers.length, 1, "a concurrent countersignature neither succeeded nor refused");
  const loser = losers[0].reason;
  assert.equal(loser.name, "HandoverRecoveryApprovalV2Error");
  assert.ok(
    ["RECOVERY_APPROVAL_V2_ALREADY_COMPLETE", "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED"].includes(
      loser.code,
    ),
    `the loser failed with an unexpected code: ${loser.code}`,
  );
  t.diagnostic(`raced countersignature loser: ${loser.code} (${loser.status})`);

  let stored = await readDoc(path);
  assert.equal(stored.approvals.length, 2, "the approval carries a torn signature list");
  assert.equal(stored.revision, 2);
  assert.equal(stored.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.FULLY_APPROVED);
  assert.notEqual(stored.approvals[0].actorUid, stored.approvals[1].actorUid);
  assert.equal(winners[0].value.view.approval.approvals[1].actorUid, stored.approvals[1].actorUid);

  // The winner is now the only human whose signature is on the record, so its
  // retry replays the committed outcome: no third signature, one audit row, no
  // new revision.
  const replay = await countersignBy(stored.approvals[1].actorUid, approvalId, stored.revision);
  assert.equal(replay.replayed, true, "a settled countersignature re-appended instead of replaying");
  assert.equal(replay.view.approval.approvals.length, 2);
  assert.equal(replay.auditId, stored.countersignAuditId, "the replay reported a second audit row");
  const afterReplay = await readDoc(path);
  assert.deepEqual(
    { approvals: afterReplay.approvals.length, revision: afterReplay.revision },
    { approvals: 2, revision: 2 },
    "a replay rewrote the approval",
  );

  // The same person racing their own committed signature is the duplicate that
  // the replay branch exists for: both callers are satisfied, but the record
  // still holds one pair, one audit row and one revision.
  const secondSigner = stored.approvals[1].actorUid;
  const duplicate = await Promise.allSettled([
    countersignBy(secondSigner, approvalId, 1),
    countersignBy(secondSigner, approvalId, 1),
  ]);
  assert.deepEqual(
    duplicate.map((entry) => entry.status),
    ["fulfilled", "fulfilled"],
    "a duplicate countersignature did not replay",
  );
  const final = await readDoc(path);
  assert.equal(final.approvals.length, 2, "a duplicate countersignature appended a third signature");
  assert.equal(final.revision, 2, "a duplicate countersignature advanced the revision");
  for (const entry of duplicate) assert.equal(entry.value.replayed, true);
  assert.equal(
    new Set(duplicate.map((entry) => entry.value.auditId)).size,
    1,
    "a duplicate countersignature reported two audit rows",
  );
});

test("25 different evidence produces a different intent and a different approval identity", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");

  await db.doc(REVIEW_CASE_PATH).set(toFirestore(reviewCaseDocument({})));
  const second = await requestBy(SUPERVISOR_TWO, "supervisor", { idempotencyKey: "moved-evidence" });
  assert.notEqual(second.view.approval.id, first.view.approval.id);
  assert.notEqual(
    second.view.approval.intentFingerprint,
    first.view.approval.intentFingerprint,
    "the canonical intent ignored a binding that moved",
  );
  assert.notEqual(
    second.view.approval.binding.evidence.evidenceDigest,
    first.view.approval.binding.evidence.evidenceDigest,
  );
  // Each approval binds its own digest, so neither can be replayed across the
  // other's evidence.
  assert.equal(
    second.view.approval.binding.evidence.evidenceDigest,
    (await evaluate()).result.evidenceDigest.value,
  );
  await db.doc(REVIEW_CASE_PATH).delete();
});

test("26 nothing outside the two Version 2 collections is ever written, and V1 is untouched", async () => {
  await writeWorld();
  const planted = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/v1-plant`);
  const before = await storeFingerprint();

  const first = await requestBy(SUPERVISOR, "supervisor");
  const completed = await countersignBy(ADMIN, first.view.approval.id);
  await v2.voidHandoverRecoveryApprovalV2({
    approvalId: completed.view.approval.id,
    actorUid: ADMIN,
    intent: { reason: VOID_REASON, idempotencyKey: "invariant-void" },
    authentication: authentication(ADMIN, "admin"),
  });
  await v2.reissueHandoverRecoveryApprovalV2({
    approvalId: completed.view.approval.id,
    actorUid: ADMIN,
    intent: { reason: "Reconsidered.", idempotencyKey: "invariant-reissue" },
    authentication: authentication(ADMIN, "admin"),
  });
  await v2.listHandoverRecoveryApprovalsV2({
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    nowIso: iso(clock.now),
  });

  const changed = touchedPaths(before, await storeFingerprint());
  assertApprovalOnlyWrites(changed);
  assert.deepEqual(
    await readDoc(`${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/v1-plant`),
    planted,
    "the Version 1 approval collection was read into a rewrite or migration",
  );
  for (const collection of [
    "shifts",
    "shift_members",
    "shift_attendance",
    "attendance_evidence_v2",
    "attendance_evidence_operations_v2",
    "handover_reservation_guards",
    "handover_reports_v2",
    "equal_handovers_v2",
    "operational_shift_control",
    "technician_schedules",
    "incoming_acceptance_applications_v1",
  ]) {
    assert.ok(
      !changed.some((path) => path.startsWith(`${collection}/`)),
      `an operational collection was written: ${changed.filter((path) => path.startsWith(`${collection}/`))}`,
    );
  }
});
