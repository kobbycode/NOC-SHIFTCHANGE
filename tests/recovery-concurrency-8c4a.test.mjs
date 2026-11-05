/**
 * Phase 8C.4A — real Firestore concurrency, negative evidence and
 * eligibility-safety verification for the Phase 8C.3 recovery-eligibility
 * read model.
 *
 * This suite talks to the disposable Firestore emulator started by
 * tests/run-recovery-concurrency-8c4a.ps1. It never contacts a protected UAT
 * stack or the network. Every document it writes is synthetic and lives only
 * inside the ephemeral emulator instance.
 *
 * Run via: tests/run-recovery-concurrency-8c4a.ps1
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const project = "demo-recovery-concurrency-8c4a";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8186", "localhost:8186"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  ) ||
  process.env.RECOVERY_CONCURRENCY_EMULATOR !== "true" ||
  process.env.HANDOVER_V2_DEV !== "true"
) {
  throw new Error("Refusing to run recovery concurrency tests outside the isolated disposable emulator.");
}

const emulatorProbe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(emulatorProbe.status), `Emulator probe failed: ${emulatorProbe.status}`);

const { Timestamp } = await import("firebase-admin/firestore");
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { acceptanceFixture } = await import("./helpers/acceptance-integrity-fixtures.mjs");
const applicationDomain = await import("../src/lib/operations/incoming-acceptance-application-domain.ts");
const reportFirestore = await import("../src/lib/operations/equal-handover-report-firestore.ts");
const attendanceDomain = await import("../src/lib/operations/attendance-evidence-domain.ts");
const { ATTENDANCE_EVIDENCE_KINDS } = await import("../src/types/attendance-evidence.ts");

const db = getAdminFirestore();

// ---------------------------------------------------------------------------
// Deterministic identities, derived only with the production factories
// ---------------------------------------------------------------------------

// The network-free fixture is used here solely as the source of the real
// document ids a committed handover produces. Nothing from it is written to
// the emulator by the A-1 probes.
//
// One fixture instance seeds every world below and supplies the derived
// identities: the reservation handover id is content-addressed from the
// reservation, so two separate builds disagree about which documents the
// production acceptance writes.
const frozenWorld = await acceptanceFixture();
const baseAggregate = frozenWorld.records.get("equal_handovers_v2/handover_v2_outgoing");
assert.ok(baseAggregate, "The fixture aggregate is missing.");

const HANDOVER_DOCUMENT_ID = "handover_v2_outgoing";
const AGGREGATE_PATH = `equal_handovers_v2/${HANDOVER_DOCUMENT_ID}`;
const INCOMING_SHIFT_ID = baseAggregate.identity.incomingShiftId;
const [IN_A] = baseAggregate.identity.incomingTechnicianIds;
const HANDOVER_ID = baseAggregate.reservation.handoverId;

const IN_A_IDENTITY = applicationDomain.createIncomingAcceptanceApplicationIdentity({
  handoverId: HANDOVER_ID,
  technicianUid: IN_A,
  kind: ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
});
const LEGACY_IN_A_OPERATION_ID = attendanceDomain.attendanceOperationId(
  applicationDomain.createLegacyIncomingAcceptanceEventId({
    handoverId: HANDOVER_ID,
    technicianUid: IN_A,
    kind: ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
  }),
);

const A1_DOCUMENT_FAMILIES = [
  ["activation-receipt", `audit_logs/${applicationDomain.createIncomingAcceptanceActivationReceiptId(HANDOVER_DOCUMENT_ID)}`],
  ["application-receipt", `incoming_acceptance_applications_v1/${IN_A_IDENTITY.receiptId}`],
  ["application-audit", `audit_logs/${IN_A_IDENTITY.auditId}`],
  ["incoming-shift", `shifts/${INCOMING_SHIFT_ID}`],
  ["incoming-membership", `shift_members/${INCOMING_SHIFT_ID}_${IN_A}`],
  ["incoming-attendance", `shift_attendance/${INCOMING_SHIFT_ID}_${IN_A}`],
  ["evidence-operation-atomic", `attendance_evidence_operations_v2/${IN_A_IDENTITY.operationId}`],
  ["evidence-operation-legacy", `attendance_evidence_operations_v2/${LEGACY_IN_A_OPERATION_ID}`],
  // Not in the mandatory list, but both are read by the classifier, so a stale
  // negative decision about either would be just as unsafe.
  ["commit-receipt", `audit_logs/${reportFirestore.equalHandoverCommitReceiptId(HANDOVER_DOCUMENT_ID)}`],
  ["evidence-document", `attendance_evidence_v2/${IN_A_IDENTITY.evidenceId}`],
];

// ---------------------------------------------------------------------------
// Emulator helpers
// ---------------------------------------------------------------------------

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
  // spreading or cloning one leaves only _seconds/_nanoseconds. Those must still
  // round-trip as a Timestamp: written as a plain map the production readers
  // hydrate the field to null and an injected artifact would refuse for a reason
  // that has nothing to do with the model under test.
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

// The ISO form the attendance and report readers accept for a timestamp field,
// from whatever representation the store handed back.
function toIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Number.isSafeInteger(value._seconds)) {
    return new Timestamp(value._seconds, value._nanoseconds).toDate().toISOString();
  }
  return null;
}

async function clearDatabase() {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200, "The disposable emulator database could not be cleared.");
}

async function read(path) {
  return (await db.doc(path).get()).data();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// §2 A-1 — is an absent-document read inside a transaction fenced?
// ---------------------------------------------------------------------------
//
// Controlled interleaving, no timing as proof:
//   1. Transaction A reads the target document and must observe absence. A then
//      buffers its decision and stops at an explicit promise barrier while its
//      transaction is still open.
//   2. Writer B issues the create of that exact document while A is open, and
//      the barrier is released only after B has been pending for the whole
//      bounded classification window. The window classifies nothing on its own.
//   3. A attempts to commit the decision derived from its observation.
//
// The verdict comes from the emulator's own server clocks, not from local
// promise ordering: both writes carry a server-assigned createTime from the
// same backend, so `create(B) < commit(A)` is a happens-before fact about the
// store. A safe outcome is therefore either
//   - B withheld until after A committed  → the decision is serialised first, or
//   - B landed first and A was aborted and retried → the retry sees the document.
// A committing "absent" while B's create is timestamped earlier is an unfenced
// stale negative read.

const CLASSIFICATION_WINDOW_MS = 3_000;

function before(left, right) {
  return left.seconds < right.seconds ||
    (left.seconds === right.seconds && left.nanoseconds < right.nanoseconds);
}

async function probeConcurrentCreate(family, targetPath, { seedExisting = null } = {}) {
  const decisionPath = `recovery_concurrency_probes/decision_${family}`;
  const observations = [];

  if (seedExisting !== null) {
    await db.doc(targetPath).set(toFirestore(seedExisting));
  }

  let attempts = 0;
  let releaseResolve;
  const released = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  let firstReadResolve;
  const firstRead = new Promise((resolve) => {
    firstReadResolve = resolve;
  });
  let targetReadTime = null;

  const transaction = db.runTransaction(async (tx) => {
    attempts += 1;
    const attempt = attempts;
    const snapshot = await tx.get(db.doc(targetPath));
    if (attempt === 1 && snapshot.readTime) targetReadTime = snapshot.readTime;
    observations.push({ attempt, exists: snapshot.exists });
    if (attempt === 1) {
      firstReadResolve();
      await released;
    }
    tx.set(db.doc(decisionPath), {
      family,
      observed: snapshot.exists ? "present" : "absent",
      attempt,
    });
  });

  await firstRead;

  // B is issued while A is provably still open: A is parked on `released`.
  const writer = db.doc(targetPath).set({ syntheticProbe: family, writtenBy: "writer-b" });

  const pendingAtRelease =
    (await Promise.race([writer.then(() => false), delay(CLASSIFICATION_WINDOW_MS).then(() => true)])) === true;
  releaseResolve();

  let transactionFailed = null;
  try {
    await transaction;
  } catch (error) {
    transactionFailed = error?.name ?? "TransactionError";
  }
  await writer;

  // Server-side ordering: both writes are timestamped by the same backend, so
  // create(B) versus commit(A) is a fact about the store, not about this
  // process's microtask queue.
  const decisionSnapshot = await db.doc(decisionPath).get();
  const targetSnapshot = await db.doc(targetPath).get();
  const decisionCommitTime = decisionSnapshot.updateTime ?? decisionSnapshot.createTime;
  // For a seeded (control) target, createTime is the seed; B's write is the
  // update. For an absent target the two are the same document creation.
  const targetWriteTime = targetSnapshot.updateTime ?? targetSnapshot.createTime;

  let serverOrdering = "unrecorded";
  if (decisionCommitTime && targetWriteTime) {
    if (before(targetWriteTime, decisionCommitTime)) serverOrdering = "write-before-commit";
    else if (before(decisionCommitTime, targetWriteTime)) serverOrdering = "write-after-commit";
    else serverOrdering = "identical";
  }

  return {
    family,
    attempts,
    observations,
    transactionFailed,
    pendingAtRelease,
    writerAcknowledgedBeforeRelease: !pendingAtRelease,
    targetReadTime: targetReadTime ? `${targetReadTime.seconds}/${targetReadTime.nanoseconds}` : null,
    targetCreateTime: targetSnapshot.createTime
      ? `${targetSnapshot.createTime.seconds}/${targetSnapshot.createTime.nanoseconds}`
      : null,
    targetWriteTime: targetWriteTime ? `${targetWriteTime.seconds}/${targetWriteTime.nanoseconds}` : null,
    decisionCommitTime: decisionCommitTime
      ? `${decisionCommitTime.seconds}/${decisionCommitTime.nanoseconds}`
      : null,
    serverOrdering,
    decision: decisionSnapshot.data(),
    target: targetSnapshot.data(),
  };
}

function assertFenced(outcome, family) {
  const evidence = JSON.stringify({
    attempts: outcome.attempts,
    serverOrdering: outcome.serverOrdering,
    targetWriteTime: outcome.targetWriteTime,
    decisionCommitTime: outcome.decisionCommitTime,
    decision: outcome.decision?.observed,
  });
  assert.equal(outcome.observations[0].exists, false, `${family}: the first read must observe absence`);
  assert.equal(outcome.transactionFailed, null, `${family}: A's transaction failed unexpectedly (${evidence})`);

  if (outcome.serverOrdering === "write-after-commit") {
    // The backend withheld the concurrent create until A's commit applied, so
    // A's negative decision is serialised strictly before the acceptance
    // document exists. That is the fencing property A-1 needs.
    assert.equal(outcome.attempts, 1, `${family}: unexpected retry while the writer was blocked (${evidence})`);
    assert.equal(outcome.decision.observed, "absent", `${family}: unexpected decision (${evidence})`);
    assert.equal(
      outcome.writerAcknowledgedBeforeRelease,
      false,
      `${family}: the writer was not actually withheld (${evidence})`,
    );
    return "A's open read withheld B's create; the negative decision is serialised strictly before the document exists";
  }

  assert.equal(
    outcome.serverOrdering,
    "write-before-commit",
    `${family}: the store gives no ordered evidence that the absent read was fenced (${evidence})`,
  );
  assert.ok(
    outcome.attempts >= 2,
    `${family}: A committed a stale "absent" decision although B's create is server-timestamped earlier — the missing-document read is NOT fenced (${evidence})`,
  );
  assert.deepEqual(
    outcome.observations.map((entry) => entry.exists),
    [false, true],
    `${family}: the retried attempt must observe the created document (${evidence})`,
  );
  assert.equal(outcome.decision.observed, "present", `${family}: an unfenced stale decision was committed (${evidence})`);
  return "B's create landed first; Firestore aborted A and the retried read observed it";
}

test("A-1 control: a write to a document that was READ AS PRESENT is fenced", async (t) => {
  await clearDatabase();
  const outcome = await probeConcurrentCreate("control-present-read", AGGREGATE_PATH, {
    seedExisting: baseAggregate,
  });
  t.diagnostic(`control: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.observations[0].exists, true, "control: the seeded document must be read as present");
  assert.equal(
    outcome.decision.observed,
    "present",
    "control: a decision derived from a present read must never claim absence",
  );
  // The probe's own harness must be capable of observing a non-blocked write:
  // the control proves the barrier really does park A while B is issued.
  assert.equal(
    outcome.serverOrdering,
    "write-after-commit",
    `control: B's write to a read-present document was not withheld (${JSON.stringify(outcome)})`,
  );
  assert.deepEqual(
    outcome.target,
    { syntheticProbe: "control-present-read", writtenBy: "writer-b" },
    "control: B's write must apply after A commits",
  );
});

for (const [family, path] of A1_DOCUMENT_FAMILIES) {
  test(`A-1 ${family}: an absent-document read is fenced against a concurrent create`, async (t) => {
    const outcome = await probeConcurrentCreate(family, path);
    const fence = assertFenced(outcome, family);
    t.diagnostic(`${family}: ${fence} | ${JSON.stringify(outcome)}`);
  });
}

// ---------------------------------------------------------------------------
// §3 concurrent eligibility against real acceptance evidence
// ---------------------------------------------------------------------------
//
// The fixture clock freezes when the fixture is built, so one build can be
// re-seeded into the emulator repeatedly and every document is identical each
// time. The production reader takes the server clock as an argument (the HTTP
// route supplies `new Date()`), so "the window has expired" is expressed as an
// explicit evaluation clock, not by moving stored contents around it.
//
// Two labelled worlds are used:
//   * the expired world is evaluated after the permitted activation window has
//     fully closed and is used for evidence-conflict testing;
//   * the earlier-window world is evaluated while the window is still open and
//     is the only world where a real production acceptance can legally commit.
// No window check is bypassed: the acceptance below is the same service the
// HTTP route calls, with the same arguments the R3B emulator suite uses.

const LEGACY_PATH = "handovers/handover_outgoing";
const GUARD_PATH = "handover_reservation_guards/guard_outgoing";
const ACTOR_UID = "manager";

const ELIGIBLE = "eligible_for_abandonment_review";
const WINDOW_OPEN = "activation_window_open";
const ACCEPTANCE_EXISTS = "acceptance_exists";
const OUTCOME_UNCERTAIN = "acceptance_outcome_uncertain";
const INCONSISTENT = "inconsistent_evidence";
const UNVERIFIABLE = "evidence_unverifiable";

const { evaluateHandoverRecoveryEligibility } = await import(
  "../src/lib/operations/handover-recovery-eligibility-firestore.ts"
);
const { applyIncomingAcceptanceApplicationAtomically } = await import(
  "../src/lib/operations/incoming-acceptance-application-firestore.ts"
);
const { createEqualHandoverSnapshot } = await import(
  "../src/lib/operations/equal-technician-handover-domain.ts"
);
const { assertShiftActivationWindowExpired } = await import(
  "../src/lib/operations/shift-activation-window.ts"
);
const eligibilityDomain = await import("../src/lib/operations/handover-recovery-eligibility-domain.ts");
const adminReviewDomain = await import("../src/lib/operations/handover-admin-review-domain.ts");
const guardDomain = await import("../src/lib/operations/handover-reservation-guard-domain.ts");
const { HANDOVER_REVIEW_CASE_SCHEMA, HANDOVER_REVIEW_CASE_STATUSES } = await import(
  "../src/types/handover-admin-review.ts"
);

const seedRecords = new Map(frozenWorld.records);
const worldAggregate = seedRecords.get(AGGREGATE_PATH);
assert.ok(worldAggregate, "The fixture aggregate is missing.");
// The record a v1 handover leaves in `handovers/` is kept aside rather than
// seeded: a v2-native reservation world must not carry a competing legacy
// reservation, and §5 reinstates the real document to exercise the ambiguous
// identity states.
const realLegacyRecord = seedRecords.get(LEGACY_PATH);
assert.ok(realLegacyRecord, "The fixture writes no legacy handover record.");
// A v2-native reservation: the shared fixture also writes a legacy
// collecting-confirmations record, which on its own makes the identity model
// ambiguous. It is removed from the seed so the ordinary classifications are
// observable; the ambiguous case is exercised separately in §5.
seedRecords.delete(LEGACY_PATH);

const LATEST_ACTIVATION_MS = Date.parse(worldAggregate.identity.scheduledStart) + 60 * 60_000;
const EXPIRED_NOW = new Date(LATEST_ACTIVATION_MS + 1_000);
const OPEN_NOW = new Date(LATEST_ACTIVATION_MS - 60_000);

async function seedWorld() {
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
  return structuredClone(seedRecords.get(AGGREGATE_PATH));
}

const evaluate = (now) => evaluateHandoverRecoveryEligibility({
  handoverDocumentId: HANDOVER_DOCUMENT_ID,
  actorUid: ACTOR_UID,
  now,
});

// A fingerprint over every document id plus its server write times, across all
// root collections (the operational model has no subcollections). Any write by
// this supposedly read-only reader changes it.
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

async function reviewedBinding() {
  const aggregate = await read(AGGREGATE_PATH);
  const guard = await read(GUARD_PATH);
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

// The earliest server-legal application time in this frozen world: inside the
// permitted activation window, so the production window check passes normally.
function acceptanceAppliedMs(aggregate) {
  return Math.max(
    Date.parse(aggregate.updatedAt) + 60_000,
    Date.parse(aggregate.identity.scheduledStart) + 60_000,
  );
}

async function acceptIncoming(uid, aggregate) {
  const appliedMs = acceptanceAppliedMs(aggregate);
  const binding = await reviewedBinding();
  const lateReason = null;
  const requestNonce = `nonce-${uid}-${appliedMs}`;
  const iso = (ms) => new Date(ms).toISOString();
  const proof = applicationDomain.createIncomingAcceptanceAuthenticationProof({
    requestNonce,
    verifiedTechnicianUid: uid,
    verifiedAt: iso(appliedMs - 2000),
    authAccountCheckedAt: iso(appliedMs - 1000),
    reviewedBinding: binding,
    lateReason,
    verifiedAtMonotonicMs: 1_000_000,
  });
  return applyIncomingAcceptanceApplicationAtomically({
    outgoingShiftId: "outgoing",
    actorUid: uid,
    reviewedBinding: binding,
    lateReason,
    requestNonce,
    proof,
    requestAcceptedAt: iso(appliedMs - 3000),
    operationalAppliedAt: iso(appliedMs),
    nowIso: iso(appliedMs + 100),
    nowMonotonicMs: 1_004_000,
  });
}

const details = (result) => Array.from(result.refusals, (entry) => `${entry.code}:${entry.detail}`);

test("§3.1 the real reader on real Firestore returns an eligible, write-free, repeatable evaluation", async (t) => {
  const aggregate = await seedWorld();
  assert.equal(aggregate.lifecycleStatus, "awaiting_incoming_acceptance");
  // The expiry is real: the production window guard itself accepts it.
  assertShiftActivationWindowExpired(
    aggregate.identity.scheduledStart,
    aggregate.identity.scheduledEnd,
    EXPIRED_NOW,
  );
  const before = await storeFingerprint();

  const first = await evaluate(EXPIRED_NOW);
  const second = await evaluate(EXPIRED_NOW);

  assert.equal(first.result.classification, ELIGIBLE);
  assert.equal(first.result.refusals.length, 0);
  assert.equal(first.result.executionAuthorized, false);
  assert.equal(first.result.executionAuthority, "none");
  assert.equal(first.result.evaluatedAt, EXPIRED_NOW.toISOString());
  assert.match(first.result.evidenceDigest.value, /^[0-9a-f]{64}$/);
  assert.equal(first.readModel.activationWindow.closedAtEvaluation, true);
  assert.equal(first.readModel.activationReceipt.present, false);
  assert.equal(first.readModel.incomingShift.present, false);
  assert.equal(first.readModel.report.verified, true);
  assert.equal(first.readModel.kindSetComplete, true);

  assert.deepEqual(second.result, first.result);
  const after = await storeFingerprint();
  assert.deepEqual(after, before, "the eligibility reader wrote to the store");
  t.diagnostic(
    `expired world: ${before.length} documents, digest ${first.result.evidenceDigest.value}`,
  );
});

test("§3.2 the same evidence inside the open window refuses, with a different digest", async () => {
  await seedWorld();
  const open = await evaluate(OPEN_NOW);
  const closed = await evaluate(EXPIRED_NOW);

  assert.equal(open.result.classification, WINDOW_OPEN);
  assert.deepEqual(details(open.result), [`${WINDOW_OPEN}:ACTIVATION_WINDOW_OPEN`]);
  assert.equal(open.readModel.activationWindow.closedAtEvaluation, false);
  assert.equal(closed.result.classification, ELIGIBLE);
  assert.notEqual(open.result.evidenceDigest.value, closed.result.evidenceDigest.value);
});

test("§3.3 a real production acceptance committed through Firestore flips the read to acceptance_exists", async (t) => {
  const aggregate = await seedWorld();
  const before = await evaluate(OPEN_NOW);
  assert.equal(before.result.classification, WINDOW_OPEN);

  const result = await acceptIncoming("in-a", aggregate);
  assert.equal(result.status, "APPLIED");
  assert.equal(result.outcome, "first_activation");
  assert.equal(result.commitState, "committed_validated");

  const after = await evaluate(OPEN_NOW);
  assert.equal(after.result.classification, ACCEPTANCE_EXISTS);
  assert.equal(after.readModel.activationReceipt.present, true);
  assert.equal(after.readModel.activationReceipt.valid, true);
  assert.equal(after.readModel.incomingShift.present, true);
  assert.equal(after.readModel.incomingShift.status, "active");
  assert.notEqual(after.result.evidenceDigest.value, before.result.evidenceDigest.value);
  assert.notEqual(after.result.classification, ELIGIBLE);
  t.diagnostic(
    `acceptance_exists digest ${after.result.evidenceDigest.value}; refusals ${JSON.stringify(details(after.result))}`,
  );
});

// The artifacts a real first acceptance leaves behind, captured once so they
// can be re-injected as deliberately partial evidence in another world.
const ACCEPTANCE_ARTIFACT_PATHS = [
  `audit_logs/${applicationDomain.createIncomingAcceptanceActivationReceiptId(HANDOVER_DOCUMENT_ID)}`,
  `incoming_acceptance_applications_v1/${IN_A_IDENTITY.receiptId}`,
  `audit_logs/${IN_A_IDENTITY.auditId}`,
  `shifts/${INCOMING_SHIFT_ID}`,
  `shift_members/${INCOMING_SHIFT_ID}_${IN_A}`,
  `shift_attendance/${INCOMING_SHIFT_ID}_${IN_A}`,
  `attendance_evidence_v2/${IN_A_IDENTITY.evidenceId}`,
  `attendance_evidence_operations_v2/${IN_A_IDENTITY.operationId}`,
];

async function captureAcceptanceArtifacts() {
  const aggregate = await seedWorld();
  const applied = await acceptIncoming("in-a", aggregate);
  assert.equal(applied.status, "APPLIED");
  const artifacts = new Map();
  for (const path of ACCEPTANCE_ARTIFACT_PATHS) {
    const snapshot = await db.doc(path).get();
    assert.ok(snapshot.exists, `the acceptance did not write ${path}`);
    artifacts.set(path, snapshot.data());
  }
  const real = await evaluate(EXPIRED_NOW);
  return { artifacts, real };
}

test("§3.4 an injected partial artifact is refused or reported as acceptance", async (t) => {
  const { artifacts, real } = await captureAcceptanceArtifacts();
  assert.equal(real.result.classification, ACCEPTANCE_EXISTS);

  // Expectations are taken from the classifier's unconditional rules:
  //   shifts/<incoming> is created only by a committed activation, a valid
  //   activation receipt proves acceptance, and membership / attendance /
  //   audit rows without a receipt are contradictory history.
  // A row marked "refuses" depends on cross-document reconciliation, so its safe
  // property is "never eligible" and its code is recorded rather than prescribed.
  // "finalized evidence operation alone" was the single artifact this suite found
  // the classifier did NOT refuse (8C.4A finding F-1). Phase 8C.4B §2 closed it
  // with OPERATION_WITHOUT_EVIDENCE, so the row now carries a prescribed code and
  // keeps asserting the fail-closed property it exposed.
  const cases = [
    ["activation receipt alone", [`audit_logs/${applicationDomain.createIncomingAcceptanceActivationReceiptId(HANDOVER_DOCUMENT_ID)}`], ACCEPTANCE_EXISTS, "ACTIVATION_RECEIPT_VALID"],
    ["application receipt alone", [`incoming_acceptance_applications_v1/${IN_A_IDENTITY.receiptId}`], "refuses", null],
    ["application audit alone", [`audit_logs/${IN_A_IDENTITY.auditId}`], INCONSISTENT, "AUDIT_WITHOUT_APPLICATION"],
    ["incoming membership alone", [`shift_members/${INCOMING_SHIFT_ID}_${IN_A}`], INCONSISTENT, "MEMBERSHIP_WITHOUT_RECEIPT"],
    ["incoming attendance alone", [`shift_attendance/${INCOMING_SHIFT_ID}_${IN_A}`], INCONSISTENT, "ATTENDANCE_WITHOUT_RECEIPT"],
    ["incoming shift alone", [`shifts/${INCOMING_SHIFT_ID}`], ACCEPTANCE_EXISTS, "INCOMING_SHIFT_ACTIVATED"],
    ["finalized evidence operation alone", [`attendance_evidence_operations_v2/${IN_A_IDENTITY.operationId}`], INCONSISTENT, "OPERATION_WITHOUT_EVIDENCE"],
  ];

  const observed = [];
  const digests = new Set();
  for (const [label, paths, expected, expectedDetail] of cases) {
    await seedWorld();
    const baseline = await evaluate(EXPIRED_NOW);
    assert.equal(baseline.result.classification, ELIGIBLE, `${label}: the injected world was not eligible first`);

    for (const path of paths) {
      await db.doc(path).set(toFirestore(structuredClone(artifacts.get(path))));
    }
    const injected = await evaluate(EXPIRED_NOW);
    const line = `${label}: ${injected.result.classification} ${JSON.stringify(details(injected.result))}`;
    observed.push(line);
    // Emitted before the assertions so a failed row still reaches the log.
    t.diagnostic(line);
    digests.add(injected.result.evidenceDigest.value);

    assert.notEqual(injected.result.classification, ELIGIBLE, `${label}: ambiguous evidence read as eligible`);
    if (expected !== "refuses") {
      assert.equal(injected.result.classification, expected, `${label}: unexpected classification`);
      assert.ok(
        details(injected.result).includes(`${expected}:${expectedDetail}`),
        `${label}: missing ${expectedDetail}`,
      );
    }
    // Every injection is distinguishable and authorizes nothing: the digest
    // binds the operation state, so a conclusion drawn here can never be
    // replayed against a world in which the operation is absent.
    assert.equal(injected.result.executionAuthorized, false, `${label}: an injection authorized execution`);
    assert.notEqual(
      injected.result.evidenceDigest.value,
      baseline.result.evidenceDigest.value,
      `${label}: the digest did not change`,
    );
    assert.notEqual(
      injected.result.evidenceDigest.value,
      real.result.evidenceDigest.value,
      `${label}: a partial artifact digests identically to a complete acceptance`,
    );
  }

  // Every injection is distinguishable from every other one.
  assert.equal(digests.size, cases.length, "injected variants are not individually distinguishable");
  t.diagnostic(`injected evidence matrix:\n${observed.join("\n")}`);
});

test("§3.5 racing the production acceptance against the production eligibility read is always serialisable", async (t) => {
  await seedWorld();
  const baseline = await evaluate(OPEN_NOW);
  assert.equal(baseline.result.classification, WINDOW_OPEN);

  // Warm the client so the acceptance is issued while reads are genuinely in
  // flight, not behind a cold-start round trip.
  await seedWorld();
  const aloneStartedAt = Date.now();
  const alone = await acceptIncoming("in-a", await read(AGGREGATE_PATH));
  const aloneMs = Date.now() - aloneStartedAt;
  assert.equal(alone.status, "APPLIED");

  const READER_FAN_OUT = 8;
  const runs = [];
  for (let index = 0; index < 3; index += 1) {
    await seedWorld();
    const aggregate = await read(AGGREGATE_PATH);
    const readers = Array.from({ length: READER_FAN_OUT }, () => evaluate(OPEN_NOW));
    const writerStartedAt = Date.now();
    const writer = acceptIncoming("in-a", aggregate);
    const raced = await Promise.all(readers);
    const applied = await writer;
    const racedMs = Date.now() - writerStartedAt;

    assert.equal(applied.status, "APPLIED", `run ${index}: the acceptance was lost under the concurrent reads`);

    const settled = await evaluate(OPEN_NOW);
    assert.equal(settled.result.classification, ACCEPTANCE_EXISTS, `run ${index}: the settled world is not accepted`);

    const beforeDigest = baseline.result.evidenceDigest.value;
    const afterDigest = settled.result.evidenceDigest.value;
    let sawBefore = 0;
    let sawAfter = 0;
    for (const [position, outcome] of raced.entries()) {
      const isBefore = outcome.result.evidenceDigest.value === beforeDigest;
      const isAfter = outcome.result.evidenceDigest.value === afterDigest;
      assert.ok(
        isBefore || isAfter,
        `run ${index} read ${position}: the racing read returned a torn state matching neither serial order (${outcome.result.classification}, refusals ${JSON.stringify(details(outcome.result))})`,
      );
      assert.equal(
        outcome.result.classification,
        isBefore ? WINDOW_OPEN : ACCEPTANCE_EXISTS,
        `run ${index} read ${position}: classification disagrees with the serial order it matched`,
      );
      assert.equal(outcome.result.executionAuthorized, false);
      if (isBefore) sawBefore += 1;
      else sawAfter += 1;
    }
    runs.push({ index, sawBefore, sawAfter, aloneMs, racedMs });
  }
  t.diagnostic(
    `race runs: ${JSON.stringify(runs)}; aloneMs is the un-contended acceptance, racedMs the same acceptance issued against ${READER_FAN_OUT} concurrent eligibility reads`,
  );
});

// ---------------------------------------------------------------------------
// §4 digest mutation matrix on the real store
// ---------------------------------------------------------------------------
//
// Every safety-relevant binding named by the milestone is changed in place in
// real Firestore, the production reader is re-run, and the mutation is then
// reverted. Two properties must hold for each row: the digest changes when the
// binding changes, and the digest returns to the exact baseline value once the
// binding is restored. The second half is what proves the digest is a pure
// function of the authoritative content rather than of the read itself.

const SLOT_PATH = "operational_shift_control/global";
const OUTGOING_SHIFT_PATH = "shifts/outgoing";
const GUARD_DOC_PATH = GUARD_PATH;
const COMMIT_RECEIPT_PATH = `audit_logs/${reportFirestore.equalHandoverCommitReceiptId(HANDOVER_DOCUMENT_ID)}`;
const ACTIVATION_RECEIPT_PATH = `audit_logs/${applicationDomain.createIncomingAcceptanceActivationReceiptId(HANDOVER_DOCUMENT_ID)}`;
const REPORT_PATH = `handover_reports_v2/${worldAggregate.reportBinding.id}`;
const REVIEW_CASE_PATH = `handover_review_cases_v1/${adminReviewDomain.createHandoverReviewCaseId(HANDOVER_DOCUMENT_ID)}`;
const GUARD_HISTORY_COLLECTION = "handover_reservation_guard_history";
const EVIDENCE_OPERATION_PATH = `attendance_evidence_operations_v2/${IN_A_IDENTITY.operationId}`;
const EXPIRED_NOW_2H = new Date(LATEST_ACTIVATION_MS + 7_201_000);

const REVERTED = Symbol("reverted");

// The minimum document the production reader accepts as a validated review
// case: readReviewCase() requires the schema, the derived id, the handover
// document id, a positive integer revision, a hex-64 fingerprint and a known
// status. Anything else is present-but-unreadable and must fail closed.
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

async function applyMutation(spec) {
  const snapshot = await db.doc(spec.path).get();
  const existed = snapshot.exists;
  const original = existed ? snapshot.data() : null;
  if (spec.delete) {
    if (existed) await db.doc(spec.path).delete();
  } else if (spec.create) {
    await db.doc(spec.path).set(toFirestore(spec.patch));
  } else {
    await db.doc(spec.path).update(spec.patch);
  }
  return async () => {
    if (!existed) {
      if ((await db.doc(spec.path).get()).exists) await db.doc(spec.path).delete();
    } else {
      await db.doc(spec.path).set(toFirestore(structuredClone(original)));
    }
    return REVERTED;
  };
}

// Every row is one of two documented expectations:
//   "refuse" - the value is cross-checked against another authoritative
//              document, so a mismatch is an ambiguous state and the classifier
//              must not return an eligible conclusion;
//   "rebind" - the value is bound into the evidence digest but is not
//              independently cross-checked (the domain only compares a live
//              guard revision against its archived history, and only refuses a
//              review case it cannot validate). Such a row must still move the
//              digest, because the digest is what a later approval binds to; an
//              eligible conclusion with a changed digest is the safe outcome.
const SAFETY_BINDINGS = [
  ["aggregate lifecycle status", { path: AGGREGATE_PATH, patch: { lifecycleStatus: "completed" } }, "refuse"],
  ["aggregate revision", { path: AGGREGATE_PATH, patch: { revision: 99 } }, "refuse"],
  ["aggregate snapshot hash", { path: AGGREGATE_PATH, patch: { snapshotHash: "0".repeat(64) } }, "refuse"],
  ["aggregate identity successor generation", { path: AGGREGATE_PATH, patch: { "identity.successorGeneration": 9 } }, "refuse"],
  ["aggregate identity scheduled end", { path: AGGREGATE_PATH, patch: { "identity.scheduledEnd": "2099-01-01T00:00:00.000Z" } }, "refuse"],
  ["aggregate reservation outgoing generation", { path: AGGREGATE_PATH, patch: { "reservation.outgoingGeneration": 9 } }, "refuse"],
  ["aggregate reservation reservedBy", { path: AGGREGATE_PATH, patch: { "reservation.reservedBy": "intruder-uid" } }, "refuse"],
  ["aggregate report binding digest", { path: AGGREGATE_PATH, patch: { "reportBinding.reportDigest": "f".repeat(64) } }, "refuse"],
  ["guard lifecycle state", { path: GUARD_DOC_PATH, patch: { ownerLifecycleState: "cancelled" } }, "refuse"],
  ["guard revision", { path: GUARD_DOC_PATH, patch: { guardRevision: 42 } }, "rebind"],
  ["guard fencing epoch", { path: GUARD_DOC_PATH, patch: { fencingEpoch: 42 } }, "refuse"],
  ["guard successor slot token", { path: GUARD_DOC_PATH, patch: { successorSlotToken: randomUUID() } }, "refuse"],
  ["guard reserved incoming shift", { path: GUARD_DOC_PATH, patch: { reservedIncomingShiftId: "other-incoming" } }, "refuse"],
  ["guard protocol owner", { path: GUARD_DOC_PATH, patch: { protocolOwner: "v1" } }, "refuse"],
  ["global slot owning shift", { path: SLOT_PATH, patch: { shiftId: "other-shift" } }, "refuse"],
  ["global slot generation", { path: SLOT_PATH, patch: { generation: 9 } }, "refuse"],
  ["global slot token", { path: SLOT_PATH, patch: { slotToken: randomUUID() } }, "refuse"],
  ["outgoing commit receipt missing", { path: COMMIT_RECEIPT_PATH, delete: true }, "refuse"],
  ["outgoing commit receipt hash", { path: COMMIT_RECEIPT_PATH, patch: { receiptHash: "a".repeat(64) } }, "refuse"],
  ["outgoing shift status", { path: OUTGOING_SHIFT_PATH, patch: { status: "cancelled" } }, "refuse"],
  ["incoming membership created", { path: `shift_members/${INCOMING_SHIFT_ID}_${IN_A}`, create: true, patch: { technicianId: IN_A, joinedAt: "2099-01-01T00:00:00.000Z" } }, "refuse"],
  ["incoming attendance created", { path: `shift_attendance/${INCOMING_SHIFT_ID}_${IN_A}`, create: true, patch: { technicianId: IN_A, clockIn: "2099-01-01T00:00:00.000Z" } }, "refuse"],
  ["incoming shift created", { path: `shifts/${INCOMING_SHIFT_ID}`, create: true, patch: { status: "active", actualStart: "2099-01-01T00:00:00.000Z" } }, "refuse"],
  ["activation receipt created", { path: ACTIVATION_RECEIPT_PATH, create: true, patch: { action: "EQUAL_SHIFT_ACTIVATED_INCOMING_V2", receiptHash: "b".repeat(64) } }, "refuse"],
  ["unparseable attendance operation document", { path: EVIDENCE_OPERATION_PATH, create: true, patch: { id: IN_A_IDENTITY.operationId, status: "pending", interruptedFinalization: false } }, "refuse"],
  ["frozen report digest", { path: REPORT_PATH, patch: { reportDigest: "c".repeat(64) } }, "refuse"],
  // A review case the reader can validate is bound into the digest but is not
  // a reason to refuse: the domain only refuses a case it cannot read.
  ["valid open review case", { path: REVIEW_CASE_PATH, create: true, patch: reviewCaseDocument({}) }, "rebind"],
  ["valid closed review case", { path: REVIEW_CASE_PATH, create: true, patch: reviewCaseDocument({ status: HANDOVER_REVIEW_CASE_STATUSES.CLOSED }) }, "rebind"],
  ["malformed review case", { path: REVIEW_CASE_PATH, create: true, patch: { status: "open", caseRevision: 1, fingerprint: "d".repeat(64) } }, "refuse"],
  ["legacy handover stub the v1 validator rejects", { path: LEGACY_PATH, create: true, patch: { lifecycleStatus: "collecting_confirmations" } }, "refuse"],
  ["legacy handover reinstated as the fixture wrote it", { path: LEGACY_PATH, create: true, patch: realLegacyRecord }, "refuse"],
  // Strict schema parsing is itself a fail-closed binding: a field the
  // aggregate validator does not recognise makes the whole aggregate view
  // unreadable, so an unknown field cannot ride along unnoticed.
  ["aggregate gains an unknown field", { path: AGGREGATE_PATH, patch: { createdAt: "2099-01-01T00:00:00.000Z" } }, "refuse"],
];

test("§4.1 every safety-relevant binding changes the digest and reverting it restores it exactly", async (t) => {
  await seedWorld();
  const baseline = await evaluate(EXPIRED_NOW);
  assert.equal(baseline.result.classification, ELIGIBLE);
  const byLabel = new Map();

  for (const [label, spec, expectation] of SAFETY_BINDINGS) {
    const undo = await applyMutation(spec);
    const mutated = await evaluate(EXPIRED_NOW);
    const row = `${label} [${expectation}] -> ${mutated.result.classification} ${JSON.stringify(details(mutated.result))} digest ${
      mutated.result.evidenceDigest.value === baseline.result.evidenceDigest.value ? "= BASELINE (blind)" : "!= baseline"
    }`;
    byLabel.set(label, { ...mutated.result, row });
    // Emitted before the assertions so a failed row still reaches the log.
    t.diagnostic(row);
    const restored = (await undo()) === REVERTED ? await evaluate(EXPIRED_NOW) : null;

    assert.notEqual(
      mutated.result.evidenceDigest.value,
      baseline.result.evidenceDigest.value,
      `${label}: the digest was blind to this binding`,
    );
    assert.equal(
      restored.result.evidenceDigest.value,
      baseline.result.evidenceDigest.value,
      `${label}: the digest did not return to baseline after reverting`,
    );
    if (expectation === "refuse") {
      assert.notEqual(mutated.result.classification, ELIGIBLE, `${label}: a broken binding still read as eligible`);
    } else {
      assert.equal(mutated.result.classification, ELIGIBLE, `${label}: an un-cross-checked value unexpectedly refused`);
    }
  }

  // Two review-case states that both classify the same way are still
  // individually distinguishable, so a later approval cannot be replayed
  // against a different case state.
  assert.notEqual(
    byLabel.get("valid open review case").evidenceDigest.value,
    byLabel.get("valid closed review case").evidenceDigest.value,
    "review case status is invisible to the digest",
  );
  t.diagnostic(
    `digest mutation matrix:\n${Array.from(byLabel.values(), (entry) => entry.row).join("\n")}`,
  );

  // A field that is present in the store but deliberately outside the digest
  // must not move the digest. Each exclusion is justified here and in the
  // report: these are timestamps and bookkeeping the reader projects into the
  // view but that carry no binding power - the identity, revision, epoch and
  // token fields next to them are all digest material, so a document cannot be
  // re-pointed at different content while staying digest-stable.
  const EXCLUSIONS = [
    ["aggregate updatedAt", { path: AGGREGATE_PATH, patch: { updatedAt: "2099-01-01T00:00:00.000Z" } }],
    ["guard reservedBy", { path: GUARD_DOC_PATH, patch: { reservedBy: "intruder-uid" } }],
    ["guard updatedAt", { path: GUARD_DOC_PATH, patch: { updatedAt: "2099-01-01T00:00:00.000Z" } }],
    ["guard retired successor token list", { path: GUARD_DOC_PATH, patch: { retiredSuccessorSlotTokens: [randomUUID()] } }],
    ["outgoing shift unbound field", { path: OUTGOING_SHIFT_PATH, patch: { notes: "not part of the proof" } }],
  ];
  const excluded = [];
  for (const [label, spec] of EXCLUSIONS) {
    const undo = await applyMutation(spec);
    const after = await evaluate(EXPIRED_NOW);
    const inert = after.result.evidenceDigest.value === baseline.result.evidenceDigest.value;
    t.diagnostic(`excluded ${label}: digest ${inert ? "= baseline (inert)" : "!= baseline"}, ${after.result.classification}`);
    assert.equal(
      after.result.evidenceDigest.value,
      baseline.result.evidenceDigest.value,
      `${label}: unexpectedly included in the digest`,
    );
    assert.equal(after.result.classification, baseline.result.classification);
    excluded.push(label);
    await undo();
  }

  // Equivalent reads: different actor, different (still closed) clock. The
  // reader authorizes the actor from their own user document, so the peers below
  // are genuine authorized viewers rather than an unauthenticated uid.
  const actorRecord = await read(`users/${ACTOR_UID}`);
  assert.ok(actorRecord, "The seeded world has no actor user document.");
  const peerActors = [
    ["peer-supervisor", "supervisor"],
    ["peer-admin", "admin"],
  ];
  for (const [uid, role] of peerActors) {
    await db.doc(`users/${uid}`).set(toFirestore({
      ...structuredClone(actorRecord),
      uid,
      id: uid,
      role,
      status: "active",
      statusOperation: null,
      mustChangePassword: false,
    }));
  }
  for (const [uid] of peerActors) {
    const otherActor = await evaluateHandoverRecoveryEligibility({
      handoverDocumentId: HANDOVER_DOCUMENT_ID,
      actorUid: uid,
      now: EXPIRED_NOW,
    });
    assert.equal(
      otherActor.result.evidenceDigest.value,
      baseline.result.evidenceDigest.value,
      `actor ${uid}: the digest depends on who read it`,
    );
    assert.equal(otherActor.result.classification, baseline.result.classification);
  }
  const laterClock = await evaluate(EXPIRED_NOW_2H);
  assert.equal(laterClock.result.evidenceDigest.value, baseline.result.evidenceDigest.value);
  assert.equal(laterClock.result.classification, baseline.result.classification);
  assert.notEqual(laterClock.result.evaluatedAt, baseline.result.evaluatedAt);
  for (const [uid] of peerActors) await db.doc(`users/${uid}`).delete();

  t.diagnostic(
    `proven inert by design: ${excluded.join(", ")}; actor- and clock-invariant digests confirmed`,
  );
});

async function seedInAlternativeOrder() {
  await clearDatabase();
  const entries = Array.from(seedRecords, ([path, value]) => ({ path, value }));
  // A deterministic reversal: enough to change arrival and listing order.
  entries.reverse();
  let batch = db.batch();
  let queued = 0;
  for (const { path, value } of entries) {
    batch.set(db.doc(path), toFirestore(structuredClone(value)));
    queued += 1;
    if (queued === 400) {
      await batch.commit();
      batch = db.batch();
      queued = 0;
    }
  }
  if (queued > 0) await batch.commit();
}

test("§4.2 document arrival order does not change the digest", async (t) => {
  await seedWorld();
  const forward = await evaluate(EXPIRED_NOW);
  await seedInAlternativeOrder();
  const reversed = await evaluate(EXPIRED_NOW);

  assert.equal(reversed.result.classification, forward.result.classification);
  assert.equal(reversed.result.evidenceDigest.value, forward.result.evidenceDigest.value);
  // The canonical material is stable even though the store listing differed.
  assert.equal(
    eligibilityDomain.handoverRecoveryEligibilityDigestInput(reversed.readModel, reversed.result),
    eligibilityDomain.handoverRecoveryEligibilityDigestInput(forward.readModel, forward.result),
  );
  t.diagnostic(`order-invariant digest: ${forward.result.evidenceDigest.value}`);
});

// The attendance operation schema has three statuses (pending, finalized,
// aborted) plus an interruptedFinalization flag that only a finalized
// operation may carry, and each status has documented field invariants. The
// variants below are therefore coherent documents, not invented statuses: the
// point is that the reader's evidence view binds status, the interrupted flag
// and the finalization time into the digest, and that the genuinely ambiguous
// states refuse with the documented detail codes.
//
// The oracle is a bijection, not a bare count: two variants share a digest
// exactly when their canonical digest inputs are identical. That distinguishes
// "the digest is blind to a difference the reader can see" (unsafe) from "the
// reader genuinely cannot see a difference in the store" (a coverage statement
// about the model, reported rather than asserted away).
test("§4.3 coherent evidence-operation states are individually visible to the digest", async (t) => {
  const { artifacts } = await captureAcceptanceArtifacts();
  const operation = structuredClone(artifacts.get(EVIDENCE_OPERATION_PATH));
  assert.equal(operation.status, "finalized");
  const FINALIZED_AT = toIso(operation.finalizedAt);
  const REQUESTED_AT = toIso(operation.requestedAt);
  assert.notEqual(FINALIZED_AT, null, "a committed acceptance leaves a finalized server time");

  const variants = [
    ["finalized", { ...operation, requestedAt: REQUESTED_AT, finalizedAt: FINALIZED_AT }],
    ["finalized with interrupted finalization", {
      ...operation, requestedAt: REQUESTED_AT, finalizedAt: FINALIZED_AT, interruptedFinalization: true,
    }],
    ["pending", {
      ...operation,
      requestedAt: REQUESTED_AT,
      status: "pending",
      finalizedAt: null,
      abortedAt: null,
      abortReason: null,
      interruptedFinalization: false,
    }],
    ["aborted", {
      ...operation,
      requestedAt: REQUESTED_AT,
      status: "aborted",
      finalizedAt: null,
      abortedAt: FINALIZED_AT,
      abortReason: "operator aborted the acceptance attempt",
      interruptedFinalization: false,
    }],
    ["incoherent: pending with a finalization time", {
      ...operation, requestedAt: REQUESTED_AT, status: "pending", finalizedAt: FINALIZED_AT,
    }],
  ];

  await seedWorld();
  const baseline = await evaluate(EXPIRED_NOW);
  assert.equal(baseline.result.classification, ELIGIBLE);

  const observed = [];
  const seen = [];
  for (const [label, document] of variants) {
    await db.doc(EVIDENCE_OPERATION_PATH).set(toFirestore(document));
    const outcome = await evaluate(EXPIRED_NOW);
    const line = `${label}: ${outcome.result.classification} ${JSON.stringify(details(outcome.result))}` +
      ` authorized=${outcome.result.executionAuthorized}` +
      ` digest ${outcome.result.evidenceDigest.value === baseline.result.evidenceDigest.value ? "= BASELINE (blind)" : "!= baseline"}`;
    observed.push(line);
    seen.push({
      label,
      digest: outcome.result.evidenceDigest.value,
      material: eligibilityDomain.handoverRecoveryEligibilityDigestInput(
        outcome.readModel,
        outcome.result,
      ),
    });
    // Emitted before the assertions so a failed variant still reaches the log.
    t.diagnostic(line);
    assert.notEqual(
      outcome.result.evidenceDigest.value,
      baseline.result.evidenceDigest.value,
      `${label}: the digest was blind to this operation state`,
    );
    assert.equal(outcome.result.executionAuthorized, false);
  }

  // Bijection: digest equality and visible-state equality agree for every pair.
  for (let left = 0; left < seen.length; left += 1) {
    for (let right = left + 1; right < seen.length; right += 1) {
      const sameDigest = seen[left].digest === seen[right].digest;
      const sameMaterial = seen[left].material === seen[right].material;
      assert.equal(
        sameDigest,
        sameMaterial,
        `${seen[left].label} vs ${seen[right].label}: digest equality (${sameDigest}) ` +
          `disagrees with visible-state equality (${sameMaterial})`,
      );
    }
  }
  const blind = seen.filter(
    (entry, index) => seen.findIndex((other) => other.material === entry.material) !== index,
  );
  assert.equal(blind.length, 0, `operation states are not individually visible: ${blind.map((entry) => entry.label).join(", ")}`);

  // The ambiguous states must refuse with their documented codes.
  const reEvaluate = async (index) => {
    await db.doc(EVIDENCE_OPERATION_PATH).set(toFirestore(variants[index][1]));
    return (await evaluate(EXPIRED_NOW)).result;
  };
  const pending = await reEvaluate(2);
  assert.equal(pending.classification, OUTCOME_UNCERTAIN);
  assert.ok(details(pending).includes(`${OUTCOME_UNCERTAIN}:OPERATION_PENDING`), JSON.stringify(details(pending)));
  const interrupted = await reEvaluate(1);
  assert.equal(interrupted.classification, OUTCOME_UNCERTAIN);
  assert.ok(details(interrupted).includes(`${OUTCOME_UNCERTAIN}:OPERATION_INTERRUPTED`), JSON.stringify(details(interrupted)));
  const incoherent = await reEvaluate(4);
  assert.equal(incoherent.classification, UNVERIFIABLE);
  assert.ok(details(incoherent).includes(`${UNVERIFIABLE}:EVIDENCE_UNREADABLE`), JSON.stringify(details(incoherent)));

  await db.doc(EVIDENCE_OPERATION_PATH).delete();
  const restored = await evaluate(EXPIRED_NOW);
  assert.equal(restored.result.evidenceDigest.value, baseline.result.evidenceDigest.value);
  t.diagnostic(`operation state matrix:\n${observed.join("\n")}`);
});

// ---------------------------------------------------------------------------
// §5 guard lifecycle matrix on the real store
// ---------------------------------------------------------------------------

async function rawGuard() {
  const snapshot = await db.doc(GUARD_DOC_PATH).get();
  assert.ok(snapshot.exists, "the seeded world has no reservation guard");
  return structuredClone(snapshot.data());
}

function archivedGuard(live, overrides) {
  return { ...structuredClone(live), ...overrides };
}

test("§5 guard lifecycle and reservation-history states all fail closed", async (t) => {
  await seedWorld();
  const live = await rawGuard();
  const baseline = await evaluate(EXPIRED_NOW);
  assert.equal(baseline.result.classification, ELIGIBLE);

  // A cancelled predecessor of the current guard, archived exactly as the
  // production transition writes it: the payload keeps the live document id and
  // the archive document id is derived from its content.
  const predecessor = archivedGuard(live, {
    ownerLifecycleState: "cancelled",
    guardRevision: 1,
    fencingEpoch: 1,
    terminalEvidenceRef: "transfer-receipt-archive-evidence",
  });
  const predecessorArchiveId = guardDomain.createReservationGuardArchiveDocumentId(predecessor);
  const successorAtSameEpoch = { guardRevision: 2, fencingEpoch: 1, terminalEvidenceRef: predecessorArchiveId };
  const successorAtAdvancedEpoch = { guardRevision: 2, fencingEpoch: 2, terminalEvidenceRef: predecessorArchiveId };

  const scenarios = [
    {
      label: "active and consistent",
      unchanged: true,
      apply: async () => async () => {},
      classification: ELIGIBLE,
      details: [],
    },
    {
      label: "cancelled while the aggregate is still open",
      apply: async () => applyMutation({ path: GUARD_DOC_PATH, patch: { ownerLifecycleState: "cancelled" } }),
      classification: INCONSISTENT,
      details: ["GUARD_TERMINAL_AGGREGATE_OPEN"],
    },
    {
      label: "completed while the aggregate is still open",
      apply: async () =>
        applyMutation({
          path: GUARD_DOC_PATH,
          patch: { ownerLifecycleState: "completed", terminalEvidenceRef: "transfer-receipt-1" },
        }),
      classification: INCONSISTENT,
      details: ["GUARD_TERMINAL_AGGREGATE_OPEN"],
    },
    {
      label: "archived predecessor, re-acquired at the same epoch",
      apply: async () => {
        const archive = await applyMutation({ path: `${GUARD_HISTORY_COLLECTION}/${predecessorArchiveId}`, create: true, patch: predecessor });
        const guard = await applyMutation({ path: GUARD_DOC_PATH, patch: successorAtSameEpoch });
        return async () => {
          await guard();
          await archive();
        };
      },
      classification: ELIGIBLE,
      details: [],
    },
    {
      label: "re-acquired with an advanced fencing epoch",
      apply: async () => {
        const archive = await applyMutation({ path: `${GUARD_HISTORY_COLLECTION}/${predecessorArchiveId}`, create: true, patch: predecessor });
        const guard = await applyMutation({ path: GUARD_DOC_PATH, patch: successorAtAdvancedEpoch });
        return async () => {
          await guard();
          await archive();
        };
      },
      classification: "guard_binding_conflict",
      details: ["GUARD_EPOCH_MISMATCH"],
    },
    {
      label: "conflicting history: an archived revision is not behind the live guard",
      apply: async () =>
        applyMutation({
          path: `${GUARD_HISTORY_COLLECTION}/${guardDomain.createReservationGuardArchiveDocumentId(
            archivedGuard(live, { ownerLifecycleState: "cancelled", guardRevision: 5, fencingEpoch: 1 }),
          )}`,
          create: true,
          patch: archivedGuard(live, { ownerLifecycleState: "cancelled", guardRevision: 5, fencingEpoch: 1 }),
        }),
      classification: "guard_binding_conflict",
      details: ["GUARD_REVISION_MISMATCH"],
    },
    {
      label: "missing required archive for an active guard's terminal evidence",
      apply: async () =>
        applyMutation({
          path: GUARD_DOC_PATH,
          patch: { terminalEvidenceRef: "guard_archive_1_" + "0".repeat(64) },
        }),
      classification: "guard_binding_conflict",
      details: ["GUARD_LIFECYCLE_NOT_ACTIVE"],
    },
    {
      label: "forged archive: the payload does not hash to its document id",
      apply: async () =>
        applyMutation({
          path: `${GUARD_HISTORY_COLLECTION}/guard_archive_tampered`,
          create: true,
          patch: predecessor,
        }),
      // The live guard is active with no terminal evidence reference, so the
      // unverifiable history is the only refusal it can produce.
      classification: UNVERIFIABLE,
      details: ["GUARD_HISTORY_UNREADABLE"],
    },
    {
      label: "forged archive that the live guard cites as its terminal evidence",
      apply: async () => {
        const archive = await applyMutation({
          path: `${GUARD_HISTORY_COLLECTION}/guard_archive_tampered`,
          create: true,
          patch: predecessor,
        });
        const guard = await applyMutation({
          path: GUARD_DOC_PATH,
          patch: { guardRevision: 2, fencingEpoch: 1, terminalEvidenceRef: "guard_archive_tampered" },
        });
        return async () => {
          await guard();
          await archive();
        };
      },
      // Both the unverifiable history and the unexplained terminal reference
      // must be reported: the ambiguous state fails closed twice over.
      classification: UNVERIFIABLE,
      details: ["GUARD_HISTORY_UNREADABLE", "GUARD_LIFECYCLE_NOT_ACTIVE"],
    },
    {
      label: "invalid fencing epoch",
      apply: async () => applyMutation({ path: GUARD_DOC_PATH, patch: { fencingEpoch: 7 } }),
      classification: "guard_binding_conflict",
      details: ["GUARD_EPOCH_MISMATCH"],
    },
    {
      label: "protocol v1 ownership",
      apply: async () => applyMutation({ path: GUARD_DOC_PATH, patch: { protocolOwner: "v1" } }),
      classification: "guard_binding_conflict",
      details: ["GUARD_NOT_V2"],
    },
    {
      label: "guard document unreadable",
      apply: async () => applyMutation({ path: GUARD_DOC_PATH, patch: { schema: "not-a-guard-schema" } }),
      classification: UNVERIFIABLE,
      details: ["GUARD_UNREADABLE"],
    },
    {
      label: "guard missing",
      apply: async () => applyMutation({ path: GUARD_DOC_PATH, delete: true }),
      // The frozen report is bound to a guard revision, so with no readable
      // guard there is nothing to bind to: the report becomes unverifiable and
      // that outranks the guard conflict. Both refusals must be reported.
      classification: UNVERIFIABLE,
      details: ["GUARD_MISSING", "REPORT_UNREADABLE"],
    },
    {
      // The v1 record exactly as the shared fixture writes it, i.e. the state a
      // real interrupted v1 handover leaves behind: the outgoing shift is
      // claimed by two reservation models at once.
      label: "legacy reservation conflict, real v1 record mid-collection",
      apply: async () =>
        applyMutation({ path: LEGACY_PATH, create: true, patch: realLegacyRecord }),
      classification: UNVERIFIABLE,
      details: ["LEGACY_RESERVATION_AMBIGUOUS"],
    },
    {
      // The documented exception: a legacy record whose own lifecycle is
      // readable and no longer claims the shift is not an ambiguity. It is
      // still bound into the digest, so a later approval cannot be replayed
      // across the two states.
      label: "legacy record already terminal does not make the identity ambiguous",
      apply: async () =>
        applyMutation({
          path: LEGACY_PATH,
          create: true,
          patch: { ...structuredClone(realLegacyRecord), lifecycleStatus: "completed" },
        }),
      classification: ELIGIBLE,
      details: [],
    },
    {
      // Strict parsing again fails closed: a stub the v1 validator rejects
      // projects as present-without-a-readable-lifecycle, which the model treats
      // as the ambiguous case rather than as no record at all.
      label: "legacy stub the v1 validator cannot read",
      apply: async () =>
        applyMutation({ path: LEGACY_PATH, create: true, patch: { lifecycleStatus: "collecting_confirmations" } }),
      classification: UNVERIFIABLE,
      details: ["LEGACY_RESERVATION_AMBIGUOUS"],
    },
  ];

  const matrix = [];
  for (const scenario of scenarios) {
    const undo = await scenario.apply();
    const evaluated = await evaluate(EXPIRED_NOW);
    const observedDetails = details(evaluated.result).map((entry) => entry.split(":")[1]);
    const line = `${scenario.label}: ${evaluated.result.classification} [${observedDetails.join(", ")}] digest ${
      evaluated.result.evidenceDigest.value === baseline.result.evidenceDigest.value ? "= baseline" : "!= baseline"
    }`;
    matrix.push(line);
    // Emitted before the assertions so a failed scenario still reaches the log.
    t.diagnostic(line);

    assert.equal(
      evaluated.result.classification,
      scenario.classification,
      `${scenario.label}: unexpected classification (${JSON.stringify(details(evaluated.result))})`,
    );
    for (const expected of scenario.details) {
      assert.ok(
        observedDetails.includes(expected),
        `${scenario.label}: missing refusal detail ${expected} (got ${JSON.stringify(observedDetails)})`,
      );
    }
    // Every ambiguous state must fail closed: nothing short of a clean, fully
    // consistent active guard may read as eligible.
    if (scenario.classification !== ELIGIBLE) {
      assert.notEqual(evaluated.result.classification, ELIGIBLE, `${scenario.label}: read as eligible`);
      assert.ok(evaluated.result.refusals.length > 0, `${scenario.label}: refused without a reason`);
    }
    // And every state the scenario writes must be visible in the digest, even
    // when it classifies the same way as the baseline world.
    if (scenario.unchanged !== true) {
      assert.notEqual(
        evaluated.result.evidenceDigest.value,
        baseline.result.evidenceDigest.value,
        `${scenario.label}: the guard or reservation state is invisible to the digest`,
      );
    }
    await undo();
    const restored = await evaluate(EXPIRED_NOW);
    assert.equal(
      restored.result.evidenceDigest.value,
      baseline.result.evidenceDigest.value,
      `${scenario.label}: the world did not return to the baseline digest after undo`,
    );
  }

  // The two consistent lifecycle shapes are distinguishable even when both
  // classify the same way.
  const noHistory = baseline.result.evidenceDigest.value;
  const withHistory = await (async () => {
    const undo = await scenarios[3].apply();
    const value = (await evaluate(EXPIRED_NOW)).result.evidenceDigest.value;
    await undo();
    return value;
  })();
  assert.notEqual(withHistory, noHistory, "archived history is invisible to the digest");

  t.diagnostic(`guard lifecycle matrix:\n${matrix.join("\n")}`);
});
