/**
 * Firestore emulator integration suite for Phase 8B — administrative handover
 * review and controlled resolution.
 *
 * The suite builds real completed/awaiting handovers with the production atomic
 * acceptance and guard-finalization services, then drives the review service
 * against the same emulator. It proves the administrative boundary:
 *   - a valid completion is projected read-only and excluded from the queue;
 *   - disturbed evidence and an expired joining window are reviewable;
 *   - only live administrators may record a decision (technicians, supervisors,
 *     blocked admins and password-change-blocked admins are refused);
 *   - acknowledgement is impossible unless the completion is fully proven;
 *   - decisions are idempotent, stale decisions are refused, concurrent
 *     decisions commit at most one, and attribution lands in audit_logs;
 *   - NO operational collection is written by any review decision, and no
 *     acceptance, attendance, evidence, membership or guard record is created.
 *
 * Run via: tests/run-handover-admin-review-emulator.ps1
 *
 * Safety invariant: project "demo-shiftchange-admin-review" on the dedicated
 * Firestore port 8182 only, no import/export, synthetic records only. The
 * suite refuses to run under any other project or host. Protected UAT stacks
 * are never contacted.
 */
import assert from "node:assert/strict";
import test from "node:test";

const project = "demo-shiftchange-admin-review";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8182", "localhost:8182"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run admin review emulator tests outside the isolated demo emulator.");
}
if (process.env.NOTIFICATIONS_ENABLED !== "true") {
  throw new Error("The admin review emulator suite requires its dedicated notification setting.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The admin review emulator suite must exercise services directly, with no dev feature flag.");
}

const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { Timestamp } = await import("firebase-admin/firestore");
const { acceptanceFixture } = await import("./helpers/acceptance-integrity-fixtures.mjs");
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { applyIncomingAcceptanceApplicationAtomically } = await import(
  "../src/lib/operations/incoming-acceptance-application-firestore.ts"
);
const applicationDomain = await import("../src/lib/operations/incoming-acceptance-application-domain.ts");
const { createEqualHandoverSnapshot } = await import(
  "../src/lib/operations/equal-technician-handover-domain.ts"
);
const {
  finalizeIncomingAcceptanceGuardAtomically,
  createGuardFinalizationAuditId,
  GUARD_CLOSURE_AUDIT_ACTION,
  GUARD_FINALIZATION_AUDIT_ACTION,
} = await import("../src/lib/operations/incoming-acceptance-guard-finalization.ts");
const {
  listHandoverReviewQueue,
  listHandoverAdjudications,
  readHandoverAdjudicationEligibility,
  readHandoverReviewCase,
  recordHandoverReviewAdjudication,
  recordHandoverReviewDecision,
  HandoverReviewServiceError,
  HANDOVER_REVIEW_QUEUE_LIMIT,
} = await import("../src/lib/operations/handover-admin-review-firestore.ts");
const {
  HANDOVER_REVIEW_ADJUDICATION_COLLECTION,
  HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT,
  HANDOVER_REVIEW_ADJUDICATION_SCHEMA,
  HANDOVER_REVIEW_ADJUDICATION_STATUS,
  HANDOVER_REVIEW_CASE_COLLECTION,
  HANDOVER_REVIEW_CASE_STATUSES,
  HANDOVER_REVIEW_CLASSIFICATIONS,
  HANDOVER_REVIEW_DECISION_COLLECTION,
  HANDOVER_REVIEW_DECISION_TYPES,
  HANDOVER_REVIEW_VERIFICATION_STATUSES,
} = await import("../src/types/handover-admin-review.ts");
const {
  HandoverAdjudicationError,
  HandoverReviewInputError,
  createHandoverReviewAdjudicationAuditId,
  createHandoverReviewAdjudicationId,
  createHandoverReviewAuditId,
  createHandoverReviewCaseId,
  createHandoverReviewDecisionId,
  parseHandoverReviewAdjudicationBody,
} = await import("../src/lib/operations/handover-admin-review-domain.ts");

const db = getAdminFirestore();
const aggregatePath = "equal_handovers_v2/handover_v2_outgoing";
const guardPath = "handover_reservation_guards/guard_outgoing";
const receiptsCollection = "incoming_acceptance_applications_v1";
const handoverDocumentId = "handover_v2_outgoing";

const ADMIN = "review-admin";
const ADMIN_TWO = "review-admin-two";
const BLOCKED_ADMIN = "review-admin-blocked";
const PASSWORD_BLOCKED_ADMIN = "review-admin-password";
const SUPERVISOR = "review-sup";

const OPERATIONAL_COLLECTIONS = [
  "equal_handovers_v2",
  "handover_reservation_guards",
  "handover_reports_v2",
  "incoming_acceptance_applications_v1",
  "attendance_evidence_v2",
  "attendance_evidence_operations_v2",
  "shift_members",
  "shift_attendance",
  "shifts",
  "shift_joins",
  "operational_shift_control",
  "technician_schedules",
  "notifications",
  "notification_outbox",
];

const read = async (path) => (await db.doc(path).get()).data();

function toFirestore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && Number.isSafeInteger(value.seconds) && Number.isSafeInteger(value.nanoseconds)) {
    return new Timestamp(value.seconds, value.nanoseconds);
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

function canonical(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

async function seed(options = {}) {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200);
  const base = await acceptanceFixture(options);
  let batch = db.batch();
  let count = 0;
  for (const [path, value] of base.records) {
    batch.set(db.doc(path), toFirestore(structuredClone(value)));
    count += 1;
    if (count === 400) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  await batch.commit();
  await Promise.all([
    db.doc(`users/${ADMIN}`).set({ uid: ADMIN, fullName: "Review Admin", role: "admin", status: "active", statusOperation: null, mustChangePassword: false }),
    db.doc(`users/${ADMIN_TWO}`).set({ uid: ADMIN_TWO, fullName: "Second Review Admin", role: "admin", status: "active", statusOperation: null, mustChangePassword: false }),
    db.doc(`users/${BLOCKED_ADMIN}`).set({ uid: BLOCKED_ADMIN, fullName: "Blocked Admin", role: "admin", status: "blocked", statusOperation: null, mustChangePassword: false }),
    db.doc(`users/${PASSWORD_BLOCKED_ADMIN}`).set({ uid: PASSWORD_BLOCKED_ADMIN, fullName: "Password Admin", role: "admin", status: "active", statusOperation: null, mustChangePassword: true }),
    db.doc(`users/${SUPERVISOR}`).set({ uid: SUPERVISOR, fullName: "Review Supervisor", role: "supervisor", status: "active", statusOperation: null, mustChangePassword: false }),
  ]);
  return base;
}

async function reviewedBinding() {
  const aggregate = await read(aggregatePath);
  const guard = await read(guardPath);
  return {
    handoverId: aggregate.reservation.handoverId,
    handoverDocumentId,
    aggregateRevision: aggregate.revision,
    snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
    report: { ...aggregate.reportBinding, aggregateRevision: aggregate.revision },
    guardRevision: guard.guardRevision,
    fencingEpoch: guard.fencingEpoch,
  };
}

async function firstAppliedMs() {
  const aggregate = await read(aggregatePath);
  return Math.max(
    Date.parse(aggregate.updatedAt) + 60_000,
    Date.parse(aggregate.identity.scheduledStart) + 60_000,
  );
}

async function apply(uid, overrides = {}) {
  const appliedMs = overrides.appliedMs ?? (await firstAppliedMs());
  const binding = overrides.binding ?? (await reviewedBinding());
  const lateReason = overrides.lateReason ?? null;
  const nonce = `nonce-${uid}-${appliedMs}-${Math.random().toString(16).slice(2)}`;
  const iso = (ms) => new Date(ms).toISOString();
  const proof = applicationDomain.createIncomingAcceptanceAuthenticationProof({
    requestNonce: nonce,
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
    requestNonce: nonce,
    proof,
    requestAcceptedAt: iso(appliedMs - 3000),
    operationalAppliedAt: iso(appliedMs),
    nowIso: iso(appliedMs + 100),
    nowMonotonicMs: 1_004_000,
  });
}

async function completeValid() {
  await seed();
  const first = await apply("in-a");
  assert.equal(first.status, "APPLIED");
  const join = await apply("in-b");
  assert.equal(join.status, "APPLIED");
  const nowIso = new Date(Date.parse(join.receipt.operationalAppliedAt) + 60_000).toISOString();
  const finalized = await finalizeIncomingAcceptanceGuardAtomically({
    outgoingShiftId: "outgoing",
    actorUid: "in-b",
    nowIso,
  });
  assert.equal(finalized.status, "FINALIZED");
  return { first, join, finalized, nowIso };
}

async function completeExceptional() {
  await seed({ absence: { subjectUid: "in-b", actorUid: "out-a", reason: "Partner reported unavailable for this shift." } });
  const first = await apply("in-a");
  assert.equal(first.status, "APPLIED");
  const activationMs = Date.parse(first.receipt.operationalAppliedAt);
  const finalized = await finalizeIncomingAcceptanceGuardAtomically({
    outgoingShiftId: "outgoing",
    actorUid: SUPERVISOR,
    nowIso: new Date(activationMs + 90_000).toISOString(),
    exceptionalClosure: {
      closureId: "closure-review-0001",
      subjectUid: "in-b",
      reason: "The absent partner never arrived; supervisor closed the handover window.",
      recordedAt: new Date(activationMs + 30_000).toISOString(),
    },
  });
  assert.equal(finalized.status, "FINALIZED");
  return { first, finalized };
}

async function currentCase() {
  return readHandoverReviewCase({
    handoverDocumentId,
    nowIso: new Date().toISOString(),
  });
}

function decisionBody(projection, overrides = {}) {
  const { nowIso: _nowIso, ...bodyOverrides } = overrides;
  return {
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION,
    idempotencyKey: "review-key-0001",
    expectedCaseRevision: projection.caseRevision,
    expectedFingerprint: projection.evidenceFingerprint,
    reason: "Inspected the persisted handover evidence during administrative review.",
    ...bodyOverrides,
  };
}

async function record(projection, overrides = {}, actorUid = ADMIN) {
  const body = overrides.body ?? decisionBody(projection, overrides);
  return recordHandoverReviewDecision({
    handoverDocumentId,
    actorUid,
    body,
    nowIso: overrides.nowIso ?? new Date().toISOString(),
  });
}

async function snapshotOperational() {
  const result = {};
  for (const collection of OPERATIONAL_COLLECTIONS) {
    const snapshot = await db.collection(collection).get();
    result[collection] = Object.fromEntries(
      snapshot.docs
        .map((document) => [document.id, canonical(document.data())])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return result;
}

async function reviewAuditCount() {
  const snapshot = await db.collection("audit_logs").get();
  return snapshot.docs.filter((document) =>
    String(document.data().action ?? "").startsWith("HANDOVER_REVIEW_"),
  ).length;
}

async function countCollection(collection, filters = []) {
  let snapshot = await db.collection(collection).get();
  return snapshot.docs.filter((document) =>
    filters.every(([field, value]) => document.data()[field] === value),
  ).length;
}

// ===========================================================================
// Phase 8C.2a helpers — an acknowledged completion whose authoritative evidence
// was later disturbed, plus the append-only adjudication calls.
// ===========================================================================

async function acknowledgeAndDisturb(ackKey = "ack-adjudication-0001") {
  await completeValid();
  const projection = await currentCase();
  const acknowledged = await record(projection, {
    idempotencyKey: ackKey,
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
    reason: "The persisted evidence proves a valid completed handover.",
  });
  assert.equal(acknowledged.decision.caseStatusAfter, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  const receipt = projection.applications.find((application) => application.technicianUid === "in-b");
  await db.doc(`${receiptsCollection}/${receipt.receiptId}`).delete();
  const disturbed = await currentCase();
  assert.equal(
    disturbed.classification,
    HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
  );
  assert.ok(disturbed.reviewReasons.length > 0);
  assert.notEqual(disturbed.evidenceFingerprint, projection.evidenceFingerprint);
  return { acknowledged: acknowledged.decision, projection: disturbed };
}

function adjudicationBody(acknowledged, projection, overrides = {}) {
  const bodyOverrides = { ...overrides };
  delete bodyOverrides.nowIso;
  return {
    originalDecisionId: acknowledged.id,
    idempotencyKey: "adjudication-key-0001",
    expectedCaseRevision: projection.caseRevision,
    expectedFingerprint: projection.evidenceFingerprint,
    finding:
      "The personal receipt that supported the acknowledgement is no longer present in the authoritative history.",
    ...bodyOverrides,
  };
}

async function adjudicate(acknowledged, projection, overrides = {}, actorUid = ADMIN) {
  return recordHandoverReviewAdjudication({
    handoverDocumentId,
    actorUid,
    body: adjudicationBody(acknowledged, projection, overrides),
    nowIso: overrides.nowIso ?? new Date().toISOString(),
  });
}

async function eligibilityFor() {
  return readHandoverAdjudicationEligibility({
    handoverDocumentId,
    nowIso: new Date().toISOString(),
  });
}

async function snapshotHistorical() {
  const result = {};
  for (const collection of [
    HANDOVER_REVIEW_CASE_COLLECTION,
    HANDOVER_REVIEW_DECISION_COLLECTION,
  ]) {
    const snapshot = await db.collection(collection).get();
    result[collection] = Object.fromEntries(
      snapshot.docs
        .map((document) => [document.id, canonical(document.data())])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return result;
}

async function adjudicationAuditCount() {
  const snapshot = await db.collection("audit_logs").get();
  return snapshot.docs.filter(
    (document) => document.data().action === "HANDOVER_REVIEW_ADJUDICATED",
  ).length;
}

const asAdjudicationError = (status, code) => (error) => {
  assert.ok(
    error instanceof HandoverAdjudicationError,
    `${error?.constructor?.name}: ${error?.message}`,
  );
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  return true;
};

const asServiceError = (status, code) => (error) => {
  assert.ok(error instanceof HandoverReviewServiceError, `${error?.constructor?.name}: ${error?.message}`);
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  return true;
};

const asDecisionError = (code) => (error) => {
  assert.equal(error?.code, code, `${error?.name}: ${error?.message}`);
  assert.equal(error.status, 409);
  return true;
};

// ===========================================================================
// Projection and queue.
// ===========================================================================

test("1. a fully proven completion projects as completed_valid and stays reviewable while no action is required", async () => {
  await completeValid();
  const projection = await currentCase();

  assert.equal(projection.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID);
  assert.equal(projection.aggregateLifecycleStatus, "completed");
  assert.equal(projection.guardLifecycleState, "guard_finalized");
  assert.equal(projection.guardLifecycleReason, "GUARD_FINALIZED");
  assert.equal(projection.guard?.ownerLifecycleState, "completed");
  assert.equal(projection.guard?.terminalEvidenceRef, projection.activation.receiptId);
  assert.equal(projection.guard?.finalizationAuditPresent, true);
  assert.equal(projection.activation.valid, true);
  assert.equal(projection.report.valid, true);
  assert.equal(projection.applications.length, 2);
  for (const application of projection.applications) {
    assert.equal(application.verificationStatus, HANDOVER_REVIEW_VERIFICATION_STATUSES.VALIDATED);
    assert.equal(application.evidencePresent, true);
    assert.equal(application.operationFinalized, true);
    assert.equal(application.membershipPresent, true);
    assert.equal(application.attendancePresent, true);
    assert.equal(application.applicationAuditPresent, true);
  }
  assert.equal(projection.requiresReview, false);
  assert.deepEqual(projection.allowedDecisions, [
    HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
    HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION,
    HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING,
    HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE,
    HANDOVER_REVIEW_DECISION_TYPES.ESCALATE,
  ]);
  assert.equal(projection.caseRevision, 0);
  assert.equal(projection.caseRecord, null);

  const healthyQueue = await listHandoverReviewQueue({ nowIso: new Date().toISOString() });
  assert.equal(healthyQueue.length, 1, "a completed handover is reviewable even when healthy");
  assert.equal(healthyQueue[0].classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID);
  assert.equal(healthyQueue[0].caseStatus, HANDOVER_REVIEW_CASE_STATUSES.OPEN);
  assert.deepEqual(healthyQueue[0].reviewReasons, []);

  // Disturb the evidence the way a real integrity exception would: the guard is
  // gone while the handover claims completion. The projection must surface that
  // instead of guessing.
  await db.doc(guardPath).delete();
  const disturbed = await currentCase();
  assert.equal(disturbed.classification, HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED);
  assert.equal(disturbed.requiresReview, true);
  assert.ok(disturbed.reviewReasons.some((reason) => reason.code === "GUARD_MISSING"));

  const queue = await listHandoverReviewQueue({ nowIso: new Date().toISOString() });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].handoverDocumentId, handoverDocumentId);
  assert.equal(queue[0].classification, HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED);
  assert.ok(queue.length <= HANDOVER_REVIEW_QUEUE_LIMIT);
});

test("2. an expired joining window is reviewable and never fabricates the missing acceptance", async () => {
  await seed();
  const applied = await apply("in-a");
  assert.equal(applied.status, "APPLIED");

  const projection = await currentCase();
  assert.equal(projection.classification, HANDOVER_REVIEW_CLASSIFICATIONS.AWAITING_PARTNER_ACCEPTANCE);
  assert.equal(projection.requiresReview, false, "the window is still open");

  const aggregate = await read(aggregatePath);
  const afterWindow = new Date(Date.parse(aggregate.identity.scheduledEnd) + 60_000).toISOString();
  const expired = await readHandoverReviewCase({ handoverDocumentId, nowIso: afterWindow });
  assert.equal(expired.classification, HANDOVER_REVIEW_CLASSIFICATIONS.JOINING_WINDOW_EXPIRED);
  assert.equal(expired.requiresReview, true);
  assert.ok(expired.reviewReasons.some((reason) => reason.code === "JOIN_WINDOW_CLOSED"));
  assert.ok(expired.reviewReasons.some(
    (reason) => reason.code === "PERSONAL_ACCEPTANCE_MISSING" && reason.subjectUid === "in-b",
  ));

  const queue = await listHandoverReviewQueue({ nowIso: afterWindow });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].classification, HANDOVER_REVIEW_CLASSIFICATIONS.JOINING_WINDOW_EXPIRED);

  const result = await record(expired, {
    nowIso: afterWindow,
    reason: "The joining window expired before the partner applied.",
  });
  assert.equal(result.replayed, false);
  assert.equal(result.decision.caseStatusAfter, HANDOVER_REVIEW_CASE_STATUSES.UNDER_INVESTIGATION);

  // The administrative decision fabricates nothing for the missing technician.
  const receipt = expired.applications.find((application) => application.technicianUid === "in-b");
  assert.equal(receipt.receiptPresent, false);
  assert.equal(receipt.membershipPresent, false);
  assert.equal(receipt.attendancePresent, false);
  assert.equal(receipt.evidencePresent, false);
  assert.equal((await db.collection(receiptsCollection).get()).size, 1, "exactly one personal receipt exists");
  assert.equal((await db.collection("shift_members").where("shiftId", "==", "incoming").get()).size, 1);
  assert.equal((await db.collection("shift_attendance").where("shiftId", "==", "incoming").get()).size, 1);

  const persisted = await currentCase();
  assert.equal(persisted.caseStatus, HANDOVER_REVIEW_CASE_STATUSES.UNDER_INVESTIGATION);
  assert.equal(persisted.caseRevision, 1);
  assert.equal(persisted.decisions.length, 1);
  assert.equal(persisted.decisions[0].id, result.decision.id);
});

// ===========================================================================
// Authority (§6) — administrative only.
// ===========================================================================

test("3. only a live administrator may record a decision", async () => {
  await completeValid();
  const projection = await currentCase();
  const baseBody = decisionBody(projection, { idempotencyKey: "authority-key-0001" });

  for (const actorUid of [
    "in-a",
    "out-a",
    SUPERVISOR,
    BLOCKED_ADMIN,
    PASSWORD_BLOCKED_ADMIN,
    "ghost-admin",
  ]) {
    await assert.rejects(
      recordHandoverReviewDecision({
        handoverDocumentId,
        actorUid,
        body: baseBody,
        nowIso: new Date().toISOString(),
      }),
      asServiceError(403, "REVIEW_UNAUTHORIZED"),
      `actor ${actorUid} must be refused`,
    );
  }

  assert.equal((await db.collection(HANDOVER_REVIEW_CASE_COLLECTION).get()).size, 0);
  assert.equal((await db.collection(HANDOVER_REVIEW_DECISION_COLLECTION).get()).size, 0);
  assert.equal(await reviewAuditCount(), 0);
});

// ===========================================================================
// Acknowledgement + audit + immutability.
// ===========================================================================

test("4. acknowledgement closes only a proven completion, is audited and leaves every operational document byte-identical", async () => {
  await completeValid();
  const projection = await currentCase();
  const before = await snapshotOperational();
  const auditsBefore = await countCollection("audit_logs");

  const result = await record(projection, {
    idempotencyKey: "ack-key-0001",
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
    reason: "The persisted evidence proves a valid completed handover.",
  });
  assert.equal(result.replayed, false);
  assert.equal(result.projection.caseStatus, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(result.projection.caseRevision, 1);
  assert.equal(result.decision.caseStatusBefore, HANDOVER_REVIEW_CASE_STATUSES.OPEN);
  assert.equal(result.decision.caseStatusAfter, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(result.decision.actorUid, ADMIN);
  assert.equal(result.decision.actorRole, "admin");
  assert.equal(result.decision.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID);
  assert.equal(result.decision.evidenceFingerprint, projection.evidenceFingerprint);

  const caseId = createHandoverReviewCaseId(handoverDocumentId);
  const decisionId = createHandoverReviewDecisionId(caseId, "ack-key-0001");
  assert.equal(result.decision.id, decisionId);
  const auditId = createHandoverReviewAuditId(decisionId);
  assert.equal(result.auditId, auditId);
  const audit = await read(`audit_logs/${auditId}`);
  assert.equal(audit.action, "HANDOVER_REVIEW_ACKNOWLEDGE_VALID_COMPLETED_STATE");
  assert.equal(audit.actorUid, ADMIN);
  assert.equal(audit.actorRole, "admin");
  assert.equal(audit.targetHandoverDocumentId, handoverDocumentId);
  assert.equal(audit.caseId, caseId);
  assert.equal(audit.decisionId, decisionId);
  assert.ok(audit.createdAt instanceof Timestamp);
  assert.equal(await countCollection("audit_logs"), auditsBefore + 1, "exactly one attribution record");

  const caseRecord = await read(`${HANDOVER_REVIEW_CASE_COLLECTION}/${caseId}`);
  assert.equal(caseRecord.status, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(caseRecord.caseRevision, 1);
  assert.equal(caseRecord.decisionCount, 1);
  assert.equal(caseRecord.resolution, "valid_completed_state_confirmed");
  assert.equal(caseRecord.fingerprintAtLastDecision, projection.evidenceFingerprint);

  // Read-only assertion: no operational document moved.
  assert.deepEqual(await snapshotOperational(), before);

  // Persistence across a fresh read (the browser refresh path).
  const persisted = await currentCase();
  assert.equal(persisted.caseStatus, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(persisted.decisions.length, 1);
  assert.deepEqual(persisted.allowedDecisions, []);

  // A closed case admits no further decision.
  const secondBody = decisionBody(persisted, {
    idempotencyKey: "ack-key-0002",
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION,
    reason: "Attempting a second decision after closure.",
  });
  await assert.rejects(
    recordHandoverReviewDecision({
      handoverDocumentId,
      actorUid: ADMIN,
      body: secondBody,
      nowIso: new Date().toISOString(),
    }),
    asDecisionError("REVIEW_CASE_CLOSED"),
  );
  assert.equal((await db.collection(HANDOVER_REVIEW_DECISION_COLLECTION).get()).size, 1);
  assert.equal(await reviewAuditCount(), 1);
});

// ===========================================================================
// Idempotency, staleness and concurrency (§6).
// ===========================================================================

test("5. an identical replay is write-free and a reused key with a different intent is refused", async () => {
  await completeValid();
  const projection = await currentCase();
  const body = decisionBody(projection, { idempotencyKey: "replay-key-0001" });

  const first = await recordHandoverReviewDecision({
    handoverDocumentId,
    actorUid: ADMIN,
    body,
    nowIso: new Date().toISOString(),
  });
  assert.equal(first.replayed, false);

  const replay = await recordHandoverReviewDecision({
    handoverDocumentId,
    actorUid: ADMIN,
    body,
    nowIso: new Date(Date.now() + 5_000).toISOString(),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.decision.id, first.decision.id);
  assert.equal(replay.decision.recordedAt, first.decision.recordedAt, "replay never re-timestamps");
  assert.equal((await db.collection(HANDOVER_REVIEW_DECISION_COLLECTION).get()).size, 1);
  assert.equal(await reviewAuditCount(), 1);

  await assert.rejects(
    recordHandoverReviewDecision({
      handoverDocumentId,
      actorUid: ADMIN,
      body: { ...body, reason: "A different intent reusing the same idempotency key." },
      nowIso: new Date().toISOString(),
    }),
    asServiceError(409, "REVIEW_IDEMPOTENCY_CONFLICT"),
  );
  assert.equal((await db.collection(HANDOVER_REVIEW_DECISION_COLLECTION).get()).size, 1);
});

test("6. a stale case revision is refused and concurrent decisions commit at most one", async () => {
  await completeValid();
  const projection = await currentCase();
  const first = await record(projection, { idempotencyKey: "stale-key-0001" });
  assert.equal(first.projection.caseRevision, 1);

  await assert.rejects(
    recordHandoverReviewDecision({
      handoverDocumentId,
      actorUid: ADMIN,
      body: decisionBody(projection, { idempotencyKey: "stale-key-0002" }),
      nowIso: new Date().toISOString(),
    }),
    asServiceError(409, "REVIEW_DECISION_STALE"),
  );
  assert.equal((await db.collection(HANDOVER_REVIEW_DECISION_COLLECTION).get()).size, 1);

  // Fresh state for the concurrency race.
  await completeValid();
  const fresh = await currentCase();
  const outcomes = await Promise.allSettled([
    recordHandoverReviewDecision({
      handoverDocumentId,
      actorUid: ADMIN,
      body: decisionBody(fresh, { idempotencyKey: "race-key-aaaa" }),
      nowIso: new Date().toISOString(),
    }),
    recordHandoverReviewDecision({
      handoverDocumentId,
      actorUid: ADMIN,
      body: decisionBody(fresh, { idempotencyKey: "race-key-bbbb" }),
      nowIso: new Date().toISOString(),
    }),
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one concurrent decision commits");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "REVIEW_DECISION_STALE");
  assert.equal((await db.collection(HANDOVER_REVIEW_DECISION_COLLECTION).get()).size, 1);
  assert.equal(await reviewAuditCount(), 1);
  const stored = await currentCase();
  assert.equal(stored.caseRevision, 1);
  assert.equal(stored.decisions.length, 1);
});

test("7. a decision against a fingerprint the administrator did not inspect is refused", async () => {
  await completeValid();
  const projection = await currentCase();
  const receipt = projection.applications.find((application) => application.technicianUid === "in-b");
  await db.doc(`${receiptsCollection}/${receipt.receiptId}`).update({ lateReason: "tampered after inspection" });

  const changed = await currentCase();
  assert.notEqual(changed.evidenceFingerprint, projection.evidenceFingerprint);
  assert.equal(changed.classification, HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED);

  await assert.rejects(
    recordHandoverReviewDecision({
      handoverDocumentId,
      actorUid: ADMIN,
      body: decisionBody(projection, { idempotencyKey: "fingerprint-key-0001" }),
      nowIso: new Date().toISOString(),
    }),
    asServiceError(409, "REVIEW_DECISION_STALE"),
  );
  assert.equal((await db.collection(HANDOVER_REVIEW_CASE_COLLECTION).get()).size, 0);
  assert.equal((await db.collection(HANDOVER_REVIEW_DECISION_COLLECTION).get()).size, 0);
});

// ===========================================================================
// Inconsistent history is never acknowledged and never repaired.
// ===========================================================================

test("8. inconsistent completed history cannot be acknowledged; a finding and close change no operational evidence", async () => {
  await completeValid();
  const projection = await currentCase();
  const receipt = projection.applications.find((application) => application.technicianUid === "in-b");
  await db.doc(`${receiptsCollection}/${receipt.receiptId}`).delete();

  const disturbed = await currentCase();
  assert.equal(disturbed.classification, HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED);
  assert.ok(disturbed.reviewReasons.some((reason) => reason.code === "APPLICATION_INCONSISTENT"));
  assert.ok(!disturbed.allowedDecisions.includes(HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE));

  await assert.rejects(
    record(disturbed, {
      idempotencyKey: "inconsistent-ack-01",
      decisionType: HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
      reason: "Attempting to acknowledge disturbed evidence.",
    }),
    (error) => error?.code === "REVIEW_DECISION_NOT_ALLOWED",
  );
  assert.equal((await db.collection(HANDOVER_REVIEW_CASE_COLLECTION).get()).size, 0);

  const before = await snapshotOperational();
  const finding = await record(disturbed, {
    idempotencyKey: "inconsistent-finding-01",
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING,
    reason: "Recorded that the partner receipt is missing from completed history.",
    finding: "The incoming partner personal receipt is absent while the guard is finalized.",
  });
  assert.equal(finding.decision.caseStatusAfter, HANDOVER_REVIEW_CASE_STATUSES.OPEN);

  const closed = await record(finding.projection, {
    idempotencyKey: "inconsistent-close-01",
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE,
    reason: "Concluded the administrative review without operational change.",
    resolutionSummary: "Evidence left exactly as found; recovery requires separate approval.",
  });
  assert.equal(closed.decision.caseStatusAfter, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(closed.decision.resolutionSummary, "Evidence left exactly as found; recovery requires separate approval.");

  assert.deepEqual(await snapshotOperational(), before, "no operational document changed");
  assert.equal(await countCollection(receiptsCollection), 1, "no receipt was recreated");
  assert.equal((await read(`${HANDOVER_REVIEW_CASE_COLLECTION}/${projection.caseId}`)).resolution,
    "review_concluded_without_operational_change");
  assert.deepEqual((await currentCase()).allowedDecisions, []);
});

// ===========================================================================
// Exceptional completion stays exceptional.
// ===========================================================================

test("9. a supervisor-authorized exceptional completion is recognised and can never be acknowledged as valid", async () => {
  const { finalized } = await completeExceptional();
  const projection = await currentCase();

  assert.equal(projection.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_EXCEPTIONAL);
  assert.equal(projection.guard?.ownerLifecycleState, "completed");
  assert.equal(projection.guard?.terminalEvidenceRef, finalized.terminalEvidenceRef);
  assert.notEqual(projection.guard?.terminalEvidenceRef, projection.activation.receiptId);
  assert.equal(projection.guard?.finalizationAuditPresent, true);
  assert.equal(projection.report.valid, true);

  const validated = projection.applications.filter(
    (application) => application.verificationStatus === HANDOVER_REVIEW_VERIFICATION_STATUSES.VALIDATED,
  );
  assert.equal(validated.length, 1);
  assert.equal(validated[0].technicianUid, "in-a");
  const absent = projection.applications.find((application) => application.technicianUid === "in-b");
  assert.equal(absent.verificationStatus, HANDOVER_REVIEW_VERIFICATION_STATUSES.NOT_APPLIED);
  assert.equal(absent.declaredNotYetIn, true);
  assert.equal(absent.receiptPresent, false);
  assert.equal(absent.attendancePresent, false);
  assert.equal(absent.membershipPresent, false);

  await assert.rejects(
    record(projection, {
      idempotencyKey: "exceptional-ack-01",
      decisionType: HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
      reason: "Attempting to acknowledge an exceptional closure as a normal completion.",
    }),
    (error) => error?.code === "REVIEW_DECISION_NOT_ALLOWED",
  );

  const before = await snapshotOperational();
  const finding = await record(projection, {
    idempotencyKey: "exceptional-finding-01",
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING,
    reason: "Recorded the supervisor-authorized exceptional closure for audit.",
    finding: "The absent partner never applied; the supervisor closed the window without fabricating attendance.",
  });
  assert.equal(finding.decision.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_EXCEPTIONAL);
  assert.deepEqual(await snapshotOperational(), before);
  assert.equal((await read(guardPath)).ownerLifecycleState, "completed");
  assert.equal((await read(guardPath)).terminalEvidenceRef, finalized.terminalEvidenceRef);
});

test("10. an unknown handover is a plain 404 and an unreadable case document blocks decisions", async () => {
  await seed();
  await assert.rejects(
    readHandoverReviewCase({ handoverDocumentId: "handover_v2_absent", nowIso: new Date().toISOString() }),
    asServiceError(404, "REVIEW_HANDOVER_NOT_FOUND"),
  );

  await completeValid();
  const caseId = createHandoverReviewCaseId(handoverDocumentId);
  await db.doc(`${HANDOVER_REVIEW_CASE_COLLECTION}/${caseId}`).set({ schema: "not-the-review-schema", id: caseId });
  await assert.rejects(
    currentCase(),
    asServiceError(409, "REVIEW_CASE_UNREADABLE"),
  );
});

// ===========================================================================
// Phase 8B.1 — the guard lifecycle projection is driven by closure evidence.
// ===========================================================================

test("11. a verified exceptional closure projects a finalized lifecycle instead of an invented mismatch", async () => {
  const { finalized } = await completeExceptional();
  const projection = await currentCase();

  assert.equal(projection.guardLifecycleState, "guard_finalized");
  assert.equal(projection.guardLifecycleReason, "GUARD_FINALIZED");
  assert.equal(projection.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_EXCEPTIONAL);
  assert.equal(projection.guard?.terminalEvidenceRef, finalized.terminalEvidenceRef);
  assert.equal(projection.guard?.finalizationAuditPresent, true);
  assert.deepEqual(projection.reviewReasons, []);
  assert.equal(projection.requiresReview, false);

  const queue = await listHandoverReviewQueue({ nowIso: new Date().toISOString() });
  const queued = queue.find((item) => item.handoverDocumentId === handoverDocumentId);
  assert.ok(queued, "the exceptional completion keeps its queue entry");
  assert.equal(queued.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_EXCEPTIONAL);
  assert.deepEqual(queued.reviewReasons, []);

  // Reading the projection must not touch operational history.
  const before = await snapshotOperational();
  const again = await currentCase();
  assert.equal(again.guardLifecycleState, "guard_finalized");
  assert.deepEqual(await snapshotOperational(), before);
});

test("12. exceptional closure evidence that cannot be verified demotes the completion itself", async () => {
  const { finalized } = await completeExceptional();
  const verified = await currentCase();
  assert.equal(verified.guardLifecycleState, "guard_finalized");
  assert.equal(verified.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_EXCEPTIONAL);

  const ACK = HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE;
  const auditPath = `audit_logs/${createGuardFinalizationAuditId(
    handoverDocumentId,
    finalized.terminalEvidenceRef,
  )}`;
  const pristine = structuredClone(await read(auditPath));
  const operationalBefore = await snapshotOperational();

  const failsClosed = async (label, patch, expectedCode) => {
    await db.doc(auditPath).set(structuredClone(pristine));
    await db.doc(auditPath).update(patch);
    const projection = await currentCase();
    assert.equal(
      projection.classification,
      HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
      label,
    );
    assert.equal(projection.guardLifecycleState, "inconsistent_review_required", label);
    assert.equal(projection.guardLifecycleReason, expectedCode, label);
    assert.deepEqual(projection.reviewReasons.map((item) => item.code), [expectedCode], label);
    assert.equal(projection.requiresReview, true, label);
    assert.ok(!projection.allowedDecisions.includes(ACK), label);
    assert.notEqual(projection.evidenceFingerprint, verified.evidenceFingerprint, label);

    // The same unverifiable bytes always project the same way, and a decision
    // quoted against the freshly served fingerprint is still refused: the
    // server re-derives the classification, it does not trust what was shown.
    const again = await currentCase();
    assert.equal(again.evidenceFingerprint, projection.evidenceFingerprint, label);
    await assert.rejects(
      record(projection, {
        idempotencyKey: `review-ack-${expectedCode.toLowerCase()}`,
        decisionType: ACK,
      }),
      (error) => error?.code === "REVIEW_DECISION_NOT_ALLOWED",
      label,
    );
    return projection;
  };

  // (a) An audit that contradicts the guard terminal reference is unverifiable.
  await failsClosed(
    "contradictory terminal reference inside the audit",
    { terminalEvidenceRef: "closure-unrelated" },
    "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID",
  );

  // (b) A closure identity that does not match the guard reference is not believed.
  await failsClosed(
    "forged closure identity",
    { "closure.closureId": "closure-forged" },
    "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID",
  );

  // (c) A closure subject outside the reserved incoming pair is not believed.
  await failsClosed(
    "closure subject is not a reserved technician",
    { "closure.subjectUid": "out-a" },
    "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID",
  );

  // (d) A closure without an authorizing operator is not believed.
  await failsClosed(
    "closure has no authorizing operator",
    { "closure.authorizedBy": "" },
    "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID",
  );

  // (e) A non-canonical closure timestamp is not believed.
  await failsClosed(
    "closure timestamp is not canonical",
    { "closure.recordedAt": "yesterday" },
    "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID",
  );

  // (f) An audit recorded as a normal closure cannot authorize the closure the
  // guard points at, so the terminal references contradict each other.
  await failsClosed(
    "normal closure mode carries an exceptional terminal reference",
    { closure: null, mode: "normal_closure", action: GUARD_FINALIZATION_AUDIT_ACTION },
    "TERMINAL_EVIDENCE_CONTRADICTION",
  );

  // (g) An audit recorded with another schema is not finalization evidence.
  await failsClosed(
    "audit schema is not the finalization schema",
    { schema: "not-the-finalization-schema" },
    "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID",
  );

  // (h) An audit belonging to another guard document is not this guard's proof.
  await failsClosed(
    "audit belongs to another guard",
    { guardId: "guard-someone-else" },
    "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID",
  );

  // (i) Structural restoration of the authoritative fields restores the
  // verified exceptional classification and the original fingerprint.
  await db.doc(auditPath).set(structuredClone(pristine));
  const repaired = await currentCase();
  assert.equal(repaired.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_EXCEPTIONAL);
  assert.equal(repaired.guardLifecycleState, "guard_finalized");
  assert.equal(repaired.guardLifecycleReason, "GUARD_FINALIZED");
  assert.equal(repaired.guard?.finalizationAuditPresent, true);
  assert.equal(repaired.evidenceFingerprint, verified.evidenceFingerprint);

  // (j) With the proof deleted, a structurally completed guard is no longer a
  // verified completion.
  await db.doc(auditPath).delete();
  const deleted = await currentCase();
  assert.equal(
    deleted.classification,
    HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
  );
  assert.equal(deleted.guardLifecycleReason, "EXCEPTIONAL_CLOSURE_EVIDENCE_MISSING");
  assert.deepEqual(deleted.reviewReasons.map((item) => item.code), [
    "EXCEPTIONAL_CLOSURE_EVIDENCE_MISSING",
  ]);
  assert.equal(deleted.guard?.finalizationAuditPresent, false);

  // (k) A completed guard whose stored terminal reference matches no audit is
  // the same failure expressed on the guard document instead of the audit.
  await db.doc(auditPath).set(structuredClone(pristine));
  await db.doc(guardPath).update({ terminalEvidenceRef: "closure-on-the-guard-only" });
  const tamperedGuard = await currentCase();
  assert.equal(
    tamperedGuard.classification,
    HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
  );
  assert.equal(tamperedGuard.guardLifecycleReason, "EXCEPTIONAL_CLOSURE_EVIDENCE_MISSING");
  await db.doc(guardPath).update({ terminalEvidenceRef: finalized.terminalEvidenceRef });
  assert.equal(
    (await currentCase()).evidenceFingerprint,
    verified.evidenceFingerprint,
    "restoring the guard reference restores the projection",
  );

  // No inspection changed an operational document.
  assert.deepEqual(await snapshotOperational(), operationalBefore);
});

// ===========================================================================
// Phase 8B.2 — completion is only verified when the terminal evidence agrees.
// ===========================================================================

test("13. a structurally completed handover needs agreeing terminal evidence before it can be acknowledged", async () => {
  await completeValid();
  const verified = await currentCase();
  const ACK = HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE;
  assert.equal(verified.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID);
  assert.ok(verified.allowedDecisions.includes(ACK));

  const activationReceiptId = verified.activation.receiptId;
  const auditPath = `audit_logs/${createGuardFinalizationAuditId(
    handoverDocumentId,
    activationReceiptId,
  )}`;
  const pristine = structuredClone(await read(auditPath));
  assert.equal(pristine.mode, "normal_closure");
  const operationalBefore = await snapshotOperational();

  const demote = async (label, expectedCode) => {
    const projection = await currentCase();
    assert.equal(
      projection.classification,
      HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
      label,
    );
    assert.equal(projection.guardLifecycleState, "inconsistent_review_required", label);
    assert.equal(projection.guardLifecycleReason, expectedCode, label);
    assert.ok(!projection.allowedDecisions.includes(ACK), label);
    assert.deepEqual(
      projection.allowedDecisions,
      [
        HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION,
        HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING,
        HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE,
        HANDOVER_REVIEW_DECISION_TYPES.ESCALATE,
      ],
      `${label}: investigation, findings, closure and escalation stay available`,
    );
    await assert.rejects(
      record(projection, {
        idempotencyKey: `review-ack-valid-${expectedCode.toLowerCase()}`,
        decisionType: ACK,
        reason: "Attempting to acknowledge a completion the terminal evidence disproves.",
      }),
      (error) => error?.code === "REVIEW_DECISION_NOT_ALLOWED",
      label,
    );
    return projection;
  };

  // (a) The guard was finalized normally, then its terminal reference was moved
  // to a closure nothing else proves.
  await db.doc(guardPath).update({ terminalEvidenceRef: "closure-invented-on-the-guard" });
  await demote("the guard terminal reference matches no closure evidence",
    "EXCEPTIONAL_CLOSURE_EVIDENCE_MISSING");
  await db.doc(guardPath).update({ terminalEvidenceRef: activationReceiptId });
  assert.equal(
    (await currentCase()).evidenceFingerprint,
    verified.evidenceFingerprint,
    "the previously displayed completion cannot override current evidence, or survive it",
  );

  // (b) An audit recorded as an exceptional closure at the activation receipt
  // reference contradicts the guard it describes.
  await db.doc(auditPath).set({
    ...pristine,
    mode: "exceptional_closure",
    action: GUARD_CLOSURE_AUDIT_ACTION,
    authorizedByUid: SUPERVISOR,
    closure: {
      closureId: activationReceiptId,
      subjectUid: "in-b",
      authorizedBy: SUPERVISOR,
      reason: "A closure claim recorded against a normal completion.",
      recordedAt: pristine.recordedAt,
    },
  });
  await demote("the audit contradicts the closure mode of the completion",
    "TERMINAL_EVIDENCE_CONTRADICTION");

  // (c) An audit that no longer describes this handover cannot verify it.
  await db.doc(auditPath).set({ ...pristine, handoverDocumentId: "handover_v2_elsewhere" });
  await demote("the audit is bound to another handover", "TERMINAL_EVIDENCE_CONTRADICTION");

  // (d) A completed guard with no audit at its activation receipt is the
  // finalizer's own legacy guard-only provenance: the activation receipt is the
  // terminal evidence, so the completion stays verified.
  await db.doc(auditPath).delete();
  const legacy = await currentCase();
  assert.equal(legacy.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID);
  assert.equal(legacy.guard?.finalizationAuditPresent, false);
  assert.equal(legacy.evidenceFingerprint, verified.evidenceFingerprint);

  await db.doc(auditPath).set(structuredClone(pristine));
  const restored = await currentCase();
  assert.equal(restored.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID);
  assert.equal(restored.guardLifecycleState, "guard_finalized");
  assert.equal(restored.evidenceFingerprint, verified.evidenceFingerprint);
  assert.deepEqual(await snapshotOperational(), operationalBefore);
});

// ===========================================================================
// Phase 8C.2a — append-only historical adjudication.
// ===========================================================================

test("14. a genuine contradiction after a valid acknowledgement creates one adjudication and one audit without touching history", async () => {
  const { acknowledged, projection } = await acknowledgeAndDisturb();
  const historicalBefore = await snapshotHistorical();
  const operationalBefore = await snapshotOperational();
  const auditsBefore = await countCollection("audit_logs");

  const { eligibility, adjudications } = await eligibilityFor();
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.ineligibleCode, null);
  assert.equal(eligibility.caseId, projection.caseId);
  assert.equal(eligibility.caseStatus, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(eligibility.acknowledgedDecision?.id, acknowledged.id);
  assert.equal(
    eligibility.previousClassification,
    HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID,
  );
  assert.equal(eligibility.previousEvidenceDigest, acknowledged.evidenceFingerprint);
  assert.equal(
    eligibility.currentClassification,
    HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
  );
  assert.equal(eligibility.currentEvidenceDigest, projection.evidenceFingerprint);
  assert.deepEqual(
    eligibility.currentReviewReasonCodes,
    projection.reviewReasons.map((item) => item.code),
  );
  assert.deepEqual(eligibility.contradictionReasonCodes, eligibility.currentReviewReasonCodes);
  assert.equal(eligibility.evidenceReferences.length, projection.reviewReasons.length);
  for (const reference of eligibility.evidenceReferences) {
    assert.ok(reference.message.length > 0);
    assert.ok(reference.references.length > 0, `${reference.code} must cite real documents`);
    for (const path of reference.references) assert.match(path, /^[a-z0-9_]+\/./);
  }
  assert.deepEqual(eligibility.existingAdjudicationIds, []);
  assert.deepEqual(adjudications, []);

  const expectedId = createHandoverReviewAdjudicationId({
    caseId: projection.caseId,
    originalDecisionId: acknowledged.id,
    currentEvidenceDigest: projection.evidenceFingerprint,
  });
  const result = await adjudicate(acknowledged, projection);

  assert.equal(result.replayed, false);
  const record = result.adjudication;
  assert.equal(record.schema, HANDOVER_REVIEW_ADJUDICATION_SCHEMA);
  assert.equal(record.id, expectedId);
  assert.match(record.id, /^handover_review_adjudication_v1_[0-9a-f]{40}$/);
  assert.equal(record.caseId, projection.caseId);
  assert.equal(record.handoverDocumentId, handoverDocumentId);
  assert.equal(record.originalDecisionId, acknowledged.id);
  assert.equal(
    record.originalDecisionType,
    HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
  );
  assert.equal(record.originalDecisionActorUid, ADMIN);
  assert.equal(record.originalDecisionRecordedAt, acknowledged.recordedAt);
  assert.equal(record.originalDecisionFingerprint, acknowledged.evidenceFingerprint);
  assert.equal(
    record.originalDecisionClassification,
    HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID,
  );
  assert.equal(record.originalCaseRevision, acknowledged.caseRevisionAfter);
  assert.equal(record.originalCaseStatus, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(
    record.currentClassification,
    HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
  );
  assert.equal(record.currentEvidenceDigest, projection.evidenceFingerprint);
  assert.deepEqual(
    record.contradictionReasonCodes,
    projection.reviewReasons.map((item) => item.code),
  );
  assert.ok(record.evidenceReferences.length > 0);
  assert.equal(record.actorUid, ADMIN);
  assert.equal(record.actorRole, "admin");
  assert.equal(record.status, HANDOVER_REVIEW_ADJUDICATION_STATUS);
  assert.equal(record.operationalEffect, HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT);
  assert.equal(record.auditId, createHandoverReviewAdjudicationAuditId(expectedId));

  const stored = await read(`${HANDOVER_REVIEW_ADJUDICATION_COLLECTION}/${expectedId}`);
  assert.equal(stored.id, expectedId);
  assert.ok(stored.createdAt instanceof Timestamp);
  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 1);

  const audit = await read(`audit_logs/${record.auditId}`);
  assert.equal(audit.action, "HANDOVER_REVIEW_ADJUDICATED");
  assert.equal(audit.actorUid, ADMIN);
  assert.equal(audit.actorRole, "admin");
  assert.equal(audit.targetHandoverDocumentId, handoverDocumentId);
  assert.equal(audit.caseId, projection.caseId);
  assert.equal(audit.decisionId, acknowledged.id);
  assert.equal(audit.adjudicationId, expectedId);
  assert.equal(audit.status, HANDOVER_REVIEW_ADJUDICATION_STATUS);
  assert.equal(audit.operationalEffect, HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT);
  assert.match(
    audit.details,
    /no operational evidence, review case or review decision was changed/,
  );
  assert.equal(await adjudicationAuditCount(), 1);
  assert.equal(await countCollection("audit_logs"), auditsBefore + 1, "exactly one audit");

  // Historical and operational documents are byte-identical.
  assert.deepEqual(await snapshotHistorical(), historicalBefore);
  assert.deepEqual(await snapshotOperational(), operationalBefore);

  // Persistence across a fresh read (the browser refresh path).
  const persisted = await currentCase();
  assert.equal(persisted.caseStatus, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(persisted.caseRevision, acknowledged.caseRevisionAfter);
  assert.equal(persisted.decisions.length, 1);
  const ledger = await listHandoverAdjudications({ handoverDocumentId });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].id, expectedId);
  assert.equal(ledger[0].finding, record.finding);
  const after = await eligibilityFor();
  assert.deepEqual(after.eligibility.existingAdjudicationIds, [expectedId]);
  assert.equal(after.eligibility.eligible, true, "the contradiction is still live");
});

test("15. an exact retry is write-free and neither replays nor forks a different finding", async () => {
  const { acknowledged, projection } = await acknowledgeAndDisturb();
  const first = await adjudicate(acknowledged, projection, {
    nowIso: "2026-11-01T09:00:00.000Z",
  });
  assert.equal(first.replayed, false);
  const auditsAfterFirst = await countCollection("audit_logs");

  const replay = await adjudicate(acknowledged, projection, {
    nowIso: "2026-11-01T09:05:00.000Z",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.adjudication.id, first.adjudication.id);
  assert.equal(replay.adjudication.adjudicatedAt, "2026-11-01T09:00:00.000Z");
  assert.equal(await countCollection("audit_logs"), auditsAfterFirst, "replay writes nothing");

  // Same identity, same actor, same words but a new key: already recorded.
  await assert.rejects(
    adjudicate(acknowledged, projection, { idempotencyKey: "adjudication-key-0002" }),
    asAdjudicationError(409, "ADJUDICATION_ALREADY_RECORDED"),
  );

  // Same key, changed intent: an idempotency conflict, not a second finding.
  await assert.rejects(
    adjudicate(acknowledged, projection, {
      finding: "A different account of the same contradiction under the same key.",
    }),
    asAdjudicationError(409, "ADJUDICATION_IDEMPOTENCY_CONFLICT"),
  );

  // Another administrator cannot overwrite or duplicate the recorded finding.
  await assert.rejects(
    adjudicate(
      acknowledged,
      projection,
      {
        idempotencyKey: "adjudication-key-0003",
        finding: "The second administrator disagrees about what is missing.",
      },
      ADMIN_TWO,
    ),
    asAdjudicationError(409, "ADJUDICATION_IDEMPOTENCY_CONFLICT"),
  );

  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 1);
  assert.equal(await adjudicationAuditCount(), 1);
  assert.equal(await countCollection("audit_logs"), auditsAfterFirst);
});

test("16. no contradiction, an unknown decision and a foreign decision are all refused", async () => {
  // (a) A closed case whose evidence still proves the acknowledgement.
  await completeValid();
  const healthy = await currentCase();
  await record(healthy, {
    idempotencyKey: "ack-healthy-0001",
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
    reason: "The persisted evidence proves a valid completed handover.",
  });
  const closed = await currentCase();
  const healthyEligibility = await eligibilityFor();
  assert.equal(healthyEligibility.eligibility.eligible, false);
  assert.equal(healthyEligibility.eligibility.ineligibleCode, "no_verified_contradiction");
  await assert.rejects(
    adjudicate(closed.decisions[0], closed),
    (error) => {
      assert.ok(error instanceof HandoverAdjudicationError);
      assert.equal(error.code, "ADJUDICATION_NOT_ELIGIBLE");
      assert.equal(error.status, 409);
      assert.equal(error.reasonCode, "no_verified_contradiction");
      return true;
    },
  );

  // (b) An acknowledgement whose evidence was disturbed.
  const { acknowledged, projection } = await acknowledgeAndDisturb("ack-adjudication-0016");
  const auditsBefore = await countCollection("audit_logs");

  await assert.rejects(
    adjudicate(acknowledged, projection, {
      originalDecisionId: `handover_review_decision_v1_${"0".repeat(40)}`,
    }),
    asAdjudicationError(404, "ADJUDICATION_DECISION_NOT_FOUND"),
  );

  const original = await read(`${HANDOVER_REVIEW_DECISION_COLLECTION}/${acknowledged.id}`);
  const foreignId = `handover_review_decision_v1_${"f".repeat(40)}`;
  await db.doc(`${HANDOVER_REVIEW_DECISION_COLLECTION}/${foreignId}`).set({
    ...original,
    id: foreignId,
    caseId: createHandoverReviewCaseId("handover_v2_other"),
    handoverDocumentId: "handover_v2_other",
  });
  await assert.rejects(
    adjudicate(acknowledged, projection, { originalDecisionId: foreignId }),
    asAdjudicationError(404, "ADJUDICATION_DECISION_NOT_FOUND"),
  );

  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 0);
  assert.equal(await adjudicationAuditCount(), 0);
  assert.equal(await countCollection("audit_logs"), auditsBefore);
});

test("17. a stale evidence fingerprint or case revision is refused before anything is written", async () => {
  const { acknowledged, projection } = await acknowledgeAndDisturb("ack-adjudication-0017");
  const auditsBefore = await countCollection("audit_logs");

  await assert.rejects(
    adjudicate(acknowledged, projection, {
      expectedFingerprint: acknowledged.evidenceFingerprint,
    }),
    asAdjudicationError(409, "ADJUDICATION_STALE"),
  );
  await assert.rejects(
    adjudicate(acknowledged, projection, {
      expectedCaseRevision: acknowledged.expectedCaseRevision,
    }),
    asAdjudicationError(409, "ADJUDICATION_STALE"),
  );
  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 0);
  assert.equal(await countCollection("audit_logs"), auditsBefore);

  // The same request with the authoritative fences succeeds.
  const accepted = await adjudicate(acknowledged, projection);
  assert.equal(accepted.replayed, false);
  assert.equal(
    accepted.adjudication.id,
    createHandoverReviewAdjudicationId({
      caseId: projection.caseId,
      originalDecisionId: acknowledged.id,
      currentEvidenceDigest: projection.evidenceFingerprint,
    }),
  );
});

test("18. concurrent administrators cannot create conflicting adjudications", async () => {
  const { acknowledged, projection } = await acknowledgeAndDisturb("ack-adjudication-0018");

  const outcomes = await Promise.allSettled([
    adjudicate(
      acknowledged,
      projection,
      {
        idempotencyKey: "race-adjudication-aaaa",
        finding: "The receipt is gone; the first administrator's account of it.",
      },
      ADMIN,
    ),
    adjudicate(
      acknowledged,
      projection,
      {
        idempotencyKey: "race-adjudication-bbbb",
        finding: "The receipt is gone; the second administrator's account of it.",
      },
      ADMIN_TWO,
    ),
  ]);

  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one adjudication commits");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof HandoverAdjudicationError);
  assert.equal(rejected[0].reason.status, 409);
  assert.ok(
    ["ADJUDICATION_IDEMPOTENCY_CONFLICT", "ADJUDICATION_ALREADY_RECORDED"].includes(
      rejected[0].reason.code,
    ),
    rejected[0].reason.code,
  );

  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 1);
  assert.equal(await adjudicationAuditCount(), 1);
  const persisted = await listHandoverAdjudications({ handoverDocumentId });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].finding, fulfilled[0].value.adjudication.finding);
});

test("19. only a live administrator may record an adjudication", async () => {
  const { acknowledged, projection } = await acknowledgeAndDisturb("ack-adjudication-0019");

  for (const actorUid of [
    "in-a",
    "out-a",
    SUPERVISOR,
    BLOCKED_ADMIN,
    PASSWORD_BLOCKED_ADMIN,
    "ghost-admin",
  ]) {
    await assert.rejects(
      adjudicate(acknowledged, projection, {}, actorUid),
      asServiceError(403, "REVIEW_UNAUTHORIZED"),
      `actor ${actorUid} must be refused`,
    );
  }

  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 0);
  assert.equal(await adjudicationAuditCount(), 0);
});

test("20. a client-supplied classification, actor or timestamp is never stored", async () => {
  const { acknowledged, projection } = await acknowledgeAndDisturb("ack-adjudication-0020");
  const auditsBefore = await countCollection("audit_logs");

  for (const forged of [
    { classification: "completed_valid" },
    { actorUid: ADMIN_TWO },
    { actorRole: "admin" },
    { adjudicatedAt: "2026-01-01T00:00:00.000Z" },
    { currentClassification: "completed_valid" },
    { currentEvidenceDigest: "c".repeat(64) },
    { operationalEffect: "recovery" },
    { status: "recorded" },
  ]) {
    await assert.rejects(
      adjudicate(acknowledged, projection, forged),
      (error) => error instanceof HandoverReviewInputError,
      JSON.stringify(forged),
    );
  }
  await assert.rejects(
    adjudicate(acknowledged, projection, { finding: "   " }),
    (error) => error instanceof HandoverReviewInputError,
  );

  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 0);
  assert.equal(await countCollection("audit_logs"), auditsBefore);

  const accepted = await adjudicate(acknowledged, projection);
  assert.equal(accepted.adjudication.actorUid, ADMIN);
  assert.equal(accepted.adjudication.actorRole, "admin");
  assert.equal(
    accepted.adjudication.originalDecisionClassification,
    HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID,
  );
  assert.notEqual(accepted.adjudication.adjudicatedAt, "2026-01-01T00:00:00.000Z");
});

test("21. an ambiguous prior outcome is verified, never reported as success or silently retried", async () => {
  const { acknowledged, projection } = await acknowledgeAndDisturb("ack-adjudication-0021");
  const body = adjudicationBody(acknowledged, projection);
  const intent = parseHandoverReviewAdjudicationBody(body);
  const adjudicationId = createHandoverReviewAdjudicationId({
    caseId: projection.caseId,
    originalDecisionId: acknowledged.id,
    currentEvidenceDigest: projection.evidenceFingerprint,
  });
  const auditId = createHandoverReviewAdjudicationAuditId(adjudicationId);

  // An earlier attempt left an audit but no adjudication: the outcome is unknown.
  await db.doc(`audit_logs/${auditId}`).set({
    action: "HANDOVER_REVIEW_ADJUDICATED",
    actorUid: ADMIN,
    caseId: projection.caseId,
    adjudicationId,
    createdAt: Timestamp.now(),
  });
  await assert.rejects(
    adjudicate(acknowledged, projection),
    asAdjudicationError(503, "ADJUDICATION_OUTCOME_UNVERIFIED"),
  );
  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 0);

  // Once the committed record exists, the same request is reported as a replay
  // of that exact record rather than as a second adjudication.
  await db.doc(`${HANDOVER_REVIEW_ADJUDICATION_COLLECTION}/${adjudicationId}`).set({
    schema: HANDOVER_REVIEW_ADJUDICATION_SCHEMA,
    id: adjudicationId,
    caseId: projection.caseId,
    handoverDocumentId,
    outgoingShiftId: projection.outgoingShiftId,
    incomingShiftId: projection.incomingShiftId,
    originalDecisionId: acknowledged.id,
    originalDecisionType: acknowledged.decisionType,
    originalDecisionActorUid: acknowledged.actorUid,
    originalDecisionRecordedAt: acknowledged.recordedAt,
    originalDecisionFingerprint: acknowledged.evidenceFingerprint,
    originalDecisionClassification: acknowledged.classification,
    originalCaseRevision: acknowledged.caseRevisionAfter,
    originalCaseStatus: acknowledged.caseStatusAfter,
    currentClassification: projection.classification,
    currentEvidenceDigest: projection.evidenceFingerprint,
    contradictionReasonCodes: projection.reviewReasons.map((item) => item.code),
    evidenceReferences: [],
    actorUid: ADMIN,
    actorRole: "admin",
    finding: intent.finding,
    requestHash: intent.requestHash,
    idempotencyKey: intent.idempotencyKey,
    status: HANDOVER_REVIEW_ADJUDICATION_STATUS,
    operationalEffect: HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT,
    auditId,
    adjudicatedAt: "2026-11-01T08:00:00.000Z",
    createdAt: Timestamp.now(),
  });

  const replay = await adjudicate(acknowledged, projection);
  assert.equal(replay.replayed, true);
  assert.equal(replay.adjudication.id, adjudicationId);
  assert.equal(replay.adjudication.adjudicatedAt, "2026-11-01T08:00:00.000Z");
  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 1);
});

test("22. an exceptional history is never adjudicated as a normal completion", async () => {
  // (a) A supervisor-authorized exceptional completion can only be closed
  // without acknowledgement, so it can never be adjudicated.
  await completeExceptional();
  const exceptional = await currentCase();
  assert.equal(exceptional.classification, HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_EXCEPTIONAL);
  await record(exceptional, {
    idempotencyKey: "exceptional-close-0022",
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE,
    reason: "Concluded the exceptional closure review without operational change.",
    resolutionSummary: "The exceptional closure is correct; nothing was changed.",
  });
  const closed = await currentCase();
  assert.equal(closed.caseStatus, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  const exceptionalEligibility = await eligibilityFor();
  assert.equal(exceptionalEligibility.eligibility.eligible, false);
  assert.equal(exceptionalEligibility.eligibility.ineligibleCode, "no_acknowledged_decision");
  await assert.rejects(
    adjudicate(closed.decisions[0], closed),
    (error) => {
      assert.ok(error instanceof HandoverAdjudicationError);
      assert.equal(error.code, "ADJUDICATION_NOT_ELIGIBLE");
      assert.equal(error.reasonCode, "no_acknowledged_decision");
      return true;
    },
  );
  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 0);

  // (b) The same is true when exceptional closure evidence appears over an
  // acknowledged normal completion: the contradiction is exceptional, and the
  // adjudication records it without any operational change.
  await completeValid();
  const verified = await currentCase();
  await record(verified, {
    idempotencyKey: "ack-exceptional-leak-0022",
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
    reason: "The persisted evidence proves a valid completed handover.",
  });
  const auditPath = `audit_logs/${createGuardFinalizationAuditId(
    handoverDocumentId,
    verified.activation.receiptId,
  )}`;
  const pristine = structuredClone(await read(auditPath));
  await db.doc(auditPath).set({
    ...pristine,
    mode: "exceptional_closure",
    action: GUARD_CLOSURE_AUDIT_ACTION,
    authorizedByUid: SUPERVISOR,
    closure: {
      closureId: verified.activation.receiptId,
      subjectUid: "in-b",
      authorizedBy: SUPERVISOR,
      reason: "An exceptional closure claim recorded against a normal completion.",
      recordedAt: pristine.recordedAt,
    },
  });

  const contradicted = await currentCase();
  assert.equal(
    contradicted.classification,
    HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
  );
  assert.ok(
    contradicted.reviewReasons.some((reason) => reason.code === "TERMINAL_EVIDENCE_CONTRADICTION"),
  );
  const operationalBefore = await snapshotOperational();
  const historicalBefore = await snapshotHistorical();

  const result = await adjudicate(contradicted.decisions[0], contradicted);
  assert.equal(result.replayed, false);
  assert.ok(
    result.adjudication.contradictionReasonCodes.includes("TERMINAL_EVIDENCE_CONTRADICTION"),
  );
  assert.ok(
    result.adjudication.evidenceReferences.some((reference) =>
      reference.references.includes(auditPath),
    ),
  );
  assert.deepEqual(await snapshotOperational(), operationalBefore);
  assert.deepEqual(await snapshotHistorical(), historicalBefore);
  assert.equal((await db.collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION).get()).size, 1);
});
