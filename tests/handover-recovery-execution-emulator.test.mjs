/**
 * Phase 8C.5 — isolated Firestore emulator suite for recovery execution.
 *
 * The world is the same committed-handover fixture the 8C.4A and 8C.4B suites
 * use, seeded into a disposable store and driven through the production
 * approval service, so the approval the executor consumes is a real one.
 *
 * What is proved here:
 *   - a fully approved intent executes exactly once, and the write set is
 *     exactly the adopted §6.3 set: shift cancelled (actualEnd untouched),
 *     global slot advanced, roster leftAt, schedule entries released,
 *     aggregate terminal, guard cancelled, one audit row — nothing else;
 *   - no personal evidence is written and no user document is touched;
 *   - a retry answers from the create-once audit row and writes nothing;
 *   - the executor must be a live administrator, and no other authority — not
 *     either signer's, not a suspended or password-rotating admin — is enough;
 *   - the classifier gates execution as state, not as history: an open window
 *     and a live acceptance both refuse, and evidence that moves after the
 *     signatures refuses rather than rebinds;
 *   - expiry and void are refused at execution time;
 *   - two concurrent executions settle on exactly one committed recovery;
 *   - the S9 read-back never guesses.
 *
 * Run via: tests/run-handover-recovery-execution-emulator.ps1
 *
 * Safety invariant: project "demo-recovery-execution-8c5" on dedicated port
 * 8191 only, ephemeral instance, no import/export. Protected presentation, UAT
 * and every other milestone stack is never contacted.
 */
import assert from "node:assert/strict";
import test from "node:test";

const project = "demo-recovery-execution-8c5";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8191", "localhost:8191"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  ) ||
  process.env.RECOVERY_EXECUTION_EMULATOR !== "true"
) {
  throw new Error("Refusing to run recovery execution tests outside the isolated disposable emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The recovery execution suite drives services directly, with no dev feature flag.");
}
if (process.env.HANDOVER_V2_ATOMIC_ACCEPTANCE) {
  throw new Error("The recovery execution suite must not inherit the atomic acceptance flag.");
}
if (process.env.HANDOVER_RECOVERY_EXECUTION_ENABLED) {
  throw new Error("The recovery execution suite must not enable the HTTP execution route.");
}

const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { Timestamp } = await import("firebase-admin/firestore");
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { acceptanceFixture } = await import("./helpers/acceptance-integrity-fixtures.mjs");
const v2 = await import("../src/lib/operations/handover-recovery-approval-v2-firestore.ts");
const eligibility = await import("../src/lib/operations/handover-recovery-eligibility-firestore.ts");
const execution = await import("../src/lib/operations/handover-recovery-execution-firestore.ts");
const abandonment = await import("../src/lib/operations/handover-recovery-abandonment-domain.ts");
const adminReviewDomain = await import("../src/lib/operations/handover-admin-review-domain.ts");
const applicationDomain = await import("../src/lib/operations/incoming-acceptance-application-domain.ts");
const { createEqualHandoverSnapshot } = await import(
  "../src/lib/operations/equal-technician-handover-domain.ts"
);
const { createHandoverReservationGuardDocumentId } = await import(
  "../src/lib/operations/handover-reservation-guard-domain.ts"
);
const { HANDOVER_REVIEW_CASE_SCHEMA, HANDOVER_REVIEW_CASE_STATUSES } = await import(
  "../src/types/handover-admin-review.ts"
);
const {
  HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION,
  HANDOVER_RECOVERY_APPROVAL_V2_STATUSES,
} = await import("../src/types/handover-recovery-approval-v2.ts");

const db = getAdminFirestore();
const ELIGIBLE = "eligible_for_abandonment_review";
const R = abandonment.HANDOVER_RECOVERY_ABANDONMENT_REFUSALS;
const REASON = "Recover the stalled outgoing handover after review.";
const KEY = "execute-stalled-handover-1";

const SUPERVISOR = "v2-supervisor";
const ADMIN = "v2-admin";
const ADMIN_TWO = "v2-admin-two";
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
const OUTGOING_SHIFT_ID = baseAggregate.identity.outgoingShiftId;
const INCOMING_SHIFT_ID = baseAggregate.identity.incomingShiftId;
const CONTROL_PATH = "operational_shift_control/global";
const GUARD_PATH = `handover_reservation_guards/${createHandoverReservationGuardDocumentId(
  OUTGOING_SHIFT_ID,
)}`;
const [IN_A] = baseAggregate.identity.incomingTechnicianIds;

const seedRecords = new Map(frozenWorld.records);
seedRecords.delete("handovers/handover_outgoing");

const LATEST_ACTIVATION_MS = Date.parse(baseAggregate.identity.scheduledStart) + 60 * 60_000;
const CLOCK_START = LATEST_ACTIVATION_MS + 60_000;

const clock = { now: CLOCK_START, mono: 100_000 };
let nonceSequence = 0;

const iso = (ms) => new Date(ms).toISOString();

function authentication(actorUid, role, overrides = {}) {
  return {
    actorUid,
    requestNonce: `exec-nonce-${++nonceSequence}`,
    verifiedAt: iso(clock.now - 1000),
    authAccountCheckedAt: iso(clock.now - 500),
    verifiedAtMonotonicMs: clock.mono - 1000,
    nowIso: iso(clock.now),
    nowMonotonicMs: clock.mono,
    ...(overrides.actorRole ? { actorRole: overrides.actorRole } : {}),
    ...overrides,
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
  const users = [
    [SUPERVISOR, "supervisor", {}],
    [ADMIN, "admin", {}],
    [ADMIN_TWO, "admin", {}],
    [SUSPENDED_ADMIN, "admin", { status: "suspended" }],
    [PASSWORD_ADMIN, "admin", { mustChangePassword: true }],
  ];
  for (const [uid, role, extra] of users) {
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
  clock.now = CLOCK_START;
  clock.mono = 100_000;
}

async function storeFingerprint() {
  const out = [];
  for (const collection of await db.listCollections()) {
    const snapshot = await db.collection(collection.id).get();
    for (const doc of snapshot.docs) {
      out.push(
        `${doc.ref.path}|${doc.createTime ? `${doc.createTime.seconds}/${doc.createTime.nanoseconds}` : "none"}|${
          doc.updateTime ? `${doc.updateTime.seconds}/${doc.updateTime.nanoseconds}` : "none"
        }`,
      );
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

// ---------------------------------------------------------------------------
// Approval and execution helpers
// ---------------------------------------------------------------------------

async function requestBy(actorUid, role) {
  return v2.requestHandoverRecoveryApprovalV2({
    actorUid,
    intent: {
      handoverDocumentId: HANDOVER_DOCUMENT_ID,
      reason: REASON,
      idempotencyKey: `request-${++nonceSequence}`,
    },
    authentication: authentication(actorUid, role),
  });
}

async function countersignBy(actorUid, approvalId) {
  return v2.countersignHandoverRecoveryApprovalV2({
    approvalId,
    actorUid,
    intent: { expectedRevision: 1 },
    authentication: authentication(actorUid, null),
  });
}

async function fullyApproved() {
  const first = await requestBy(SUPERVISOR, "supervisor");
  const second = await countersignBy(ADMIN, first.view.approval.id);
  assert.equal(second.view.approval.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.FULLY_APPROVED);
  return second.view.approval;
}

function execute(approvalId, options = {}) {
  return execution.executeHandoverAbandonment({
    approvalId,
    actorUid: options.actorUid ?? ADMIN,
    reason: options.reason ?? REASON,
    idempotencyKey: options.idempotencyKey ?? KEY,
    now: options.now ?? new Date(clock.now),
  });
}

async function expectRefusal(operation, code, status) {
  const error = await operation().then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error, `expected a ${code} refusal, but the operation succeeded`);
  assert.equal(error.name, "HandoverRecoveryAbandonmentError", String(error));
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return error;
}

const evaluate = (atMs = clock.now) =>
  eligibility.evaluateHandoverRecoveryEligibility({
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    actorUid: SUPERVISOR,
    now: new Date(atMs),
  });

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

// Drives the production acceptance writer, so "an acceptance exists" is a real
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
  const requestNonce = `exec-accept-${uid}-${appliedMs}`;
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

const REVIEW_CASE_PATH = `handover_review_cases_v1/${adminReviewDomain.createHandoverReviewCaseId(
  HANDOVER_DOCUMENT_ID,
)}`;

function reviewCaseDocument() {
  return {
    schema: HANDOVER_REVIEW_CASE_SCHEMA,
    id: adminReviewDomain.createHandoverReviewCaseId(HANDOVER_DOCUMENT_ID),
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    status: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
    caseRevision: 1,
    fingerprintAtLastDecision: "d".repeat(64),
  };
}

// ---------------------------------------------------------------------------
// 1. The commit
// ---------------------------------------------------------------------------

test("01 an approved intent executes once and writes only the recovery write set", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const approvalId = approval.id;

  const aggregateBefore = await readDoc(AGGREGATE_PATH);
  const controlBefore = await readDoc(CONTROL_PATH);
  const guardBefore = await readDoc(GUARD_PATH);
  const shiftBefore = await readDoc(`shifts/${OUTGOING_SHIFT_ID}`);
  const incomingShiftBefore = await readDoc(`shifts/${INCOMING_SHIFT_ID}`);
  const membersBefore = (await db.collection("shift_members").where("shiftId", "==", OUTGOING_SHIFT_ID).get()).docs
    .map((document) => document.data())
    .filter((member) => member.leftAt === null);

  const before = await storeFingerprint();
  const outcome = await execute(approvalId);
  const after = await storeFingerprint();

  assert.equal(outcome.status, "committed");
  assert.equal(outcome.recoveryExecutionEligible, false);
  assert.equal(outcome.approvalId, approvalId);
  assert.equal(outcome.handoverDocumentId, HANDOVER_DOCUMENT_ID);
  assert.equal(outcome.outgoingShiftId, OUTGOING_SHIFT_ID);
  assert.equal(outcome.incomingShiftId, INCOMING_SHIFT_ID);
  assert.equal(outcome.executedBy, ADMIN);
  assert.equal(outcome.executedAt, iso(clock.now));

  const expectedAuditId = abandonment.createHandoverAbandonmentAuditId(approvalId);
  assert.equal(outcome.auditId, expectedAuditId);

  const changed = touchedPaths(before, after);
  assert.deepEqual(
    changed,
    [
      `audit_logs/${expectedAuditId}`,
      AGGREGATE_PATH,
      GUARD_PATH,
      CONTROL_PATH,
      `shifts/${OUTGOING_SHIFT_ID}`,
      ...membersBefore.map((member) => `shift_members/${member.id}`),
      ...aggregateBefore.identity.outgoingTechnicianIds.map((uid) => `technician_schedules/${uid}`),
    ].sort(),
    "the executor wrote outside the adopted §6.3 write set",
  );

  // W1 — cancelled, and never a fabricated end of work.
  const shiftAfter = await readDoc(`shifts/${OUTGOING_SHIFT_ID}`);
  assert.equal(shiftAfter.status, "cancelled");
  assert.equal(shiftAfter.actualEnd, null);
  assert.equal(shiftAfter.actualStart, shiftBefore.actualStart);
  assert.equal(shiftAfter.cancelledAt, outcome.executedAt);
  assert.equal(shiftAfter.cancelledBy, ADMIN);
  assert.deepEqual(await readDoc(`shifts/${INCOMING_SHIFT_ID}`), incomingShiftBefore);

  // W2 — a fresh pending generation, derived from the approval.
  const controlAfter = await readDoc(CONTROL_PATH);
  assert.equal(controlAfter.generation, controlBefore.generation + 1);
  assert.equal(
    controlAfter.slotToken,
    abandonment.createHandoverAbandonmentSlotToken({
      approvalId,
      generation: controlBefore.generation + 1,
    }),
  );
  assert.equal(controlAfter.slotStatus, "pending");
  assert.equal(controlAfter.shiftId, null);
  assert.equal(controlAfter.shiftStatus, null);
  assert.equal(controlAfter.previousSlotToken, controlBefore.slotToken);

  // W3 — roster end only.
  for (const member of membersBefore) {
    const stored = await readDoc(`shift_members/${member.id}`);
    assert.equal(stored.leftAt, outcome.executedAt);
    assert.equal(stored.technicianId, member.technicianId);
  }

  // W4 — the cancelled shift leaves each schedule; everything else survives.
  for (const uid of aggregateBefore.identity.outgoingTechnicianIds) {
    const schedule = await readDoc(`technician_schedules/${uid}`);
    assert.deepEqual(schedule.entries, []);
    assert.equal(schedule.metadata, "preserve");
    assert.equal(schedule.updatedAt, outcome.executedAt);
  }

  // W5 — terminal, with the signed binding untouched.
  const aggregateAfter = await readDoc(AGGREGATE_PATH);
  assert.equal(aggregateAfter.lifecycleStatus, "cancelled");
  assert.equal(aggregateAfter.revision, aggregateBefore.revision);
  assert.deepEqual(aggregateAfter.identity, aggregateBefore.identity);
  assert.deepEqual(aggregateAfter.reservation, aggregateBefore.reservation);
  assert.equal(aggregateAfter.updatedAt, outcome.executedAt);
  assert.equal(
    createEqualHandoverSnapshot(aggregateAfter).snapshotHash,
    createEqualHandoverSnapshot(aggregateBefore).snapshotHash,
  );

  // W6 — the guard is cancelled with the audit as its evidence.
  const guardAfter = await readDoc(GUARD_PATH);
  assert.equal(guardAfter.ownerLifecycleState, "cancelled");
  assert.equal(guardAfter.guardRevision, guardBefore.guardRevision + 1);
  assert.equal(guardAfter.fencingEpoch, guardBefore.fencingEpoch);
  assert.equal(guardAfter.terminalEvidenceRef, expectedAuditId);

  // W7 — one audit row that describes the whole transition.
  const audit = await readDoc(`audit_logs/${expectedAuditId}`);
  assert.equal(audit.action, "HANDOVER_STALLED_ABANDONED_V1");
  assert.equal(audit.protocol, "equal-handover-v2-recovery");
  assert.equal(audit.actorUid, ADMIN);
  assert.equal(audit.approvalId, approvalId);
  assert.equal(audit.intentFingerprint, approval.intentFingerprint);
  assert.equal(audit.supervisorUid, SUPERVISOR);
  assert.equal(audit.adminUid, ADMIN);
  assert.equal(audit.handoverDocumentId, HANDOVER_DOCUMENT_ID);
  assert.equal(audit.shiftId, OUTGOING_SHIFT_ID);
  assert.equal(audit.guardRevisionBefore, guardBefore.guardRevision);
  assert.equal(audit.guardRevisionAfter, guardAfter.guardRevision);
  assert.equal(audit.fencingEpoch, guardBefore.fencingEpoch);
  assert.equal(audit.slotTokenBefore, controlBefore.slotToken);
  assert.equal(audit.slotTokenAfter, controlAfter.slotToken);
  assert.equal(audit.generationBefore, controlBefore.generation);
  assert.equal(audit.generationAfter, controlAfter.generation);
  assert.equal(audit.aggregateRevision, aggregateBefore.revision);
  assert.equal(audit.aggregateLifecycleBefore, "awaiting_incoming_acceptance");
  assert.equal(audit.aggregateLifecycleAfter, "cancelled");
  assert.equal(audit.evidenceDigest, approval.binding.evidence.evidenceDigest);
  assert.equal(audit.negativeProof.classification, ELIGIBLE);
  assert.equal(audit.reason, REASON);
  assert.equal(audit.idempotencyKey, KEY);
  assert.equal(audit.rosterEndOnly, true);
  assert.equal(audit.personalEvidenceWritten, false);
  assert.equal(audit.recordedAt, outcome.executedAt);

  // The signed approval is history, not a mutable work item.
  const storedApproval = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.deepEqual(storedApproval, approval);

  // Nothing personal, nothing operational beyond the adopted set.
  for (const path of changed) {
    assert.equal(path.startsWith("users/"), false, `a user document was written: ${path}`);
    assert.equal(path.startsWith("shift_attendance/"), false, `attendance was written: ${path}`);
    assert.equal(path.startsWith("attendance_evidence"), false, `personal evidence was written: ${path}`);
    assert.equal(path.startsWith("notification"), false, `a notification was written: ${path}`);
    assert.equal(path.startsWith("handovers/"), false, `the legacy handover record was written: ${path}`);
  }
});

test("02 a retry answers from the create-once audit row and writes nothing", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const first = await execute(approval.id);
  assert.equal(first.status, "committed");

  const before = await storeFingerprint();
  const replay = await execute(approval.id, {
    actorUid: ADMIN_TWO,
    reason: "A different administrator retrying after a timeout.",
    idempotencyKey: "execute-stalled-handover-2",
  });

  assert.equal(replay.status, "already_applied");
  assert.equal(replay.auditId, first.auditId);
  assert.equal(replay.executedBy, ADMIN);
  assert.equal(replay.executedAt, first.executedAt);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

// ---------------------------------------------------------------------------
// 2. Authority and state gates
// ---------------------------------------------------------------------------

test("03 an intent that is not fully approved cannot execute", async () => {
  await writeWorld();
  const first = await requestBy(SUPERVISOR, "supervisor");
  const before = await storeFingerprint();
  const error = await expectRefusal(() => execute(first.view.approval.id), R.APPROVAL_INVALID, 409);
  assert.equal(error.notCommitted, true);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

test("04 only a live administrator executes; a supervisor cannot", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const before = await storeFingerprint();
  await expectRefusal(
    () => execute(approval.id, { actorUid: SUPERVISOR }),
    R.APPROVAL_INVALID,
    403,
  );
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

test("05 a suspended or password-rotating administrator cannot execute", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const before = await storeFingerprint();
  await expectRefusal(
    () => execute(approval.id, { actorUid: SUSPENDED_ADMIN }),
    R.APPROVAL_INVALID,
    403,
  );
  await expectRefusal(
    () => execute(approval.id, { actorUid: PASSWORD_ADMIN }),
    R.APPROVAL_INVALID,
    403,
  );
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

test("06 recovery is refused while the incoming shift can still accept", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const before = await storeFingerprint();
  const error = await expectRefusal(
    () => execute(approval.id, { now: new Date(CLOCK_START - 10 * 60_000) }),
    R.WINDOW_OPEN,
    409,
  );
  assert.equal(error.notCommitted, true);
  assert.equal(error.details.classification, "activation_window_open");
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

test("07 a live acceptance refuses recovery, whichever classification it reports", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const applied = await applyIncoming(IN_A);
  assert.equal(applied.status, "APPLIED");

  const classified = await evaluate();
  assert.notEqual(classified.result.classification, ELIGIBLE);
  const expected = abandonment.refusalForAbandonmentClassification(classified.result.classification);
  assert.ok(expected, "an accepted handover produced no refusal");

  const before = await storeFingerprint();
  const error = await expectRefusal(() => execute(approval.id), expected, 409);
  assert.equal(error.notCommitted, true);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

test("08 an expired intent cannot execute", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const before = await storeFingerprint();
  await expectRefusal(
    () => execute(approval.id, { now: new Date(Date.parse(approval.expiresAt) + 1_000) }),
    R.APPROVAL_EXPIRED,
    409,
  );
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

test("09 a voided intent cannot execute", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const voided = await v2.voidHandoverRecoveryApprovalV2({
    approvalId: approval.id,
    actorUid: SUPERVISOR,
    intent: { reason: "The evidence changed; this intent is withdrawn.", idempotencyKey: "void-before-execute" },
    authentication: authentication(SUPERVISOR, "supervisor"),
  });
  assert.equal(voided.view.approval.status, HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED);

  const before = await storeFingerprint();
  await expectRefusal(() => execute(approval.id), R.APPROVAL_INVALID, 409);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

test("10 evidence that moves after approval refuses at execution and writes nothing", async () => {
  await writeWorld();
  const approval = await fullyApproved();

  // An open review case keeps the handover eligible but is bound into the
  // digest, so approval is stale without the state becoming ineligible.
  await db.doc(REVIEW_CASE_PATH).set(toFirestore(reviewCaseDocument()));
  const moved = await evaluate();
  assert.equal(moved.result.classification, ELIGIBLE);
  assert.notEqual(moved.result.evidenceDigest.value, approval.binding.evidence.evidenceDigest);

  const before = await storeFingerprint();
  const error = await expectRefusal(() => execute(approval.id), R.APPROVAL_STALE, 409);
  assert.equal(error.notCommitted, true);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

// ---------------------------------------------------------------------------
// 3. Concurrency and read-back
// ---------------------------------------------------------------------------

test("11 two concurrent executions settle on exactly one committed recovery", async () => {
  await writeWorld();
  const approval = await fullyApproved();

  const settled = await Promise.allSettled([execute(approval.id), execute(approval.id)]);
  const committed = settled.filter(
    (entry) => entry.status === "fulfilled" && entry.value.status === "committed",
  );
  assert.equal(committed.length, 1, "two executions both claimed the commit");

  for (const entry of settled) {
    if (entry.status === "rejected") {
      assert.equal(entry.reason.name, "HandoverRecoveryAbandonmentError", String(entry.reason));
      assert.equal(entry.reason.code, R.OUTCOME_UNKNOWN);
      assert.equal(entry.reason.notCommitted, false);
    } else {
      assert.ok(["committed", "already_applied"].includes(entry.value.status));
    }
  }

  const auditId = committed[0].value.auditId;
  assert.ok(await readDoc(`audit_logs/${auditId}`), "the committed audit row is missing");
  const third = await execute(approval.id);
  assert.equal(third.status, "already_applied");
  assert.equal(third.auditId, auditId);
  assert.equal((await readDoc(`shifts/${OUTGOING_SHIFT_ID}`)).status, "cancelled");
});

test("12 the read-back answers from the audit row and never guesses", async () => {
  await writeWorld();
  const approval = await fullyApproved();

  const early = await execution.readHandoverAbandonmentStatus({ approvalId: approval.id });
  assert.equal(early.applied, false);
  assert.equal(early.approvalId, approval.id);
  assert.equal(early.handoverDocumentId, HANDOVER_DOCUMENT_ID);
  assert.equal(early.auditId, abandonment.createHandoverAbandonmentAuditId(approval.id));
  assert.equal(early.executedBy, null);
  assert.equal(early.executedAt, null);
  assert.equal(early.recoveryExecutionEligible, false);

  const outcome = await execute(approval.id);
  const late = await execution.readHandoverAbandonmentStatus({ approvalId: approval.id });
  assert.equal(late.applied, true);
  assert.equal(late.auditId, outcome.auditId);
  assert.equal(late.executedBy, ADMIN);
  assert.equal(late.executedAt, outcome.executedAt);
  assert.equal(late.recoveryExecutionEligible, false);

  const missing = await execution
    .readHandoverAbandonmentStatus({ approvalId: "approval-that-does-not-exist" })
    .then(
      () => null,
      (caught) => caught,
    );
  assert.ok(missing);
  assert.equal(missing.name, "HandoverRecoveryAbandonmentError");
  assert.equal(missing.code, R.APPROVAL_INVALID);
  assert.equal(missing.status, 404);
});
