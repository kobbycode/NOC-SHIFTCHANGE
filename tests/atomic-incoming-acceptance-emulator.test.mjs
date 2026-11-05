/**
 * Firestore emulator integration suite for the 09M-R3B.2 Phase 3 atomic
 * incoming acceptance service. Unlike the network-free double, this suite
 * exercises the real Firestore transaction API end to end: optimistic retries,
 * server timestamps, post-commit hydration and persisted-state validation.
 *
 * Run via: tests/run-atomic-acceptance-emulator.ps1
 *
 * Isolation invariant: project "demo-atomic-acceptance-r3b2" on the dedicated
 * Firestore port 8181 only, no import/export, synthetic records only. The suite
 * refuses to run under any other project or host. The presentation, 09D, 09L
 * and 09M UAT stacks are never contacted.
 *
 * Fault-injection scenarios (rollback, lost acknowledgement, unreadable
 * read-back, tampered receipt, guard-cleanup failure) are covered by
 * tests/atomic-incoming-acceptance-service.test.mjs, which can intercept the
 * commit boundary; a real emulator cannot simulate those losses.
 */
import assert from "node:assert/strict";
import test from "node:test";

const project = "demo-atomic-acceptance-r3b2";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8181", "localhost:8181"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run atomic acceptance emulator tests outside the isolated demo emulator.");
}
if (process.env.NOTIFICATIONS_ENABLED !== "true") {
  throw new Error("The atomic acceptance emulator suite requires its dedicated notification setting.");
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
const { createEqualHandoverSnapshot, getEqualHandoverPositions } = await import(
  "../src/lib/operations/equal-technician-handover-domain.ts"
);
const { planAtomicAcceptanceEvidence, applyAtomicAcceptanceEvidencePlan } = await import(
  "../src/lib/operations/atomic-acceptance-evidence.ts"
);
const { attendanceAuthenticationMethodForKind } = await import(
  "../src/lib/operations/attendance-evidence-domain.ts"
);
const { ATTENDANCE_EVIDENCE_SCHEMA } = await import("../src/types/attendance-evidence.ts");

const db = getAdminFirestore();
const aggregatePath = "equal_handovers_v2/handover_v2_outgoing";
const guardPath = "handover_reservation_guards/guard_outgoing";
const receiptsCollection = "incoming_acceptance_applications_v1";

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

async function seed() {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200);
  const base = await acceptanceFixture();
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
  if (count > 0) await batch.commit();
  return base;
}

async function reviewedBinding() {
  const aggregate = await read(aggregatePath);
  const guard = await read(guardPath);
  return {
    handoverId: aggregate.reservation.handoverId,
    handoverDocumentId: "handover_v2_outgoing",
    aggregateRevision: aggregate.revision,
    snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
    // Freezing revises the aggregate after the immutable report is stamped; the
    // reviewed report carries the live revision overlaid by the coordinator.
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
  const nonce = `nonce-${uid}-${appliedMs}`;
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

async function count(collection) {
  return (await db.collection(collection).get()).size;
}

test("first acceptance persists evidence, participation, receipt and audit atomically", async () => {
  await seed();
  const result = await apply("in-a");

  assert.equal(result.status, "APPLIED");
  assert.equal(result.outcome, "first_activation");
  assert.equal(result.commitState, "committed_validated");
  assert.equal(result.guardCleanup, "pending");
  const appliedAt = result.receipt.operationalAppliedAt;

  const incoming = await read("shifts/incoming");
  assert.equal(incoming.status, "active");
  assert.equal(incoming.actualStart, appliedAt);
  const outgoing = await read("shifts/outgoing");
  assert.equal(outgoing.status, "completed");
  assert.equal(outgoing.actualEnd, appliedAt);
  const control = await read("operational_shift_control/global");
  assert.equal(control.shiftId, "incoming");
  assert.equal(control.shiftStatus, "active");

  assert.equal((await read("shift_members/incoming_in-a")).technicianId, "in-a");
  assert.equal((await read("shift_attendance/incoming_in-a")).technicianId, "in-a");
  assert.equal((await read("shift_members/incoming_in-b")), undefined);
  assert.equal((await read("shift_attendance/incoming_in-b")), undefined);

  const operation = await read(`attendance_evidence_operations_v2/${result.receipt.evidenceOperationId}`);
  assert.equal(operation.status, "finalized");
  assert.equal(operation.interruptedFinalization, false);
  const evidence = await read(`attendance_evidence_v2/${result.receipt.evidenceId}`);
  assert.equal(evidence.technicianUid, "in-a");
  assert.equal(evidence.eventTime.toDate().toISOString(), appliedAt);
  assert.equal(evidence.personallyAuthenticated, true);

  // The persisted receipt hydrates to a real server timestamp, and the
  // post-commit hash matches the returned receipt.
  const stored = await read(`${receiptsCollection}/${result.receipt.id}`);
  assert.ok(stored.committedAt instanceof Timestamp);
  assert.equal(stored.receiptHash, result.receiptHash);
  assert.equal(stored.outcome, "first_activation");

  const activationAudits = await db
    .collection("audit_logs")
    .where("action", "==", "EQUAL_SHIFT_ACTIVATED_INCOMING_V2")
    .get();
  assert.equal(activationAudits.size, 1);
  const activation = activationAudits.docs[0].data();
  assert.equal(activation.receiptHash, result.receipt.activationReceiptHash);
  assert.ok(activation.createdAt instanceof Timestamp);
  const applicationAudit = await read(`audit_logs/${result.receipt.auditId}`);
  assert.equal(applicationAudit.receiptHash, result.receiptHash);

  // Notification intents were queued in the same transaction.
  assert.equal(await count("notifications"), 4);
  assert.equal(await count("notification_outbox"), 4);

  // Guard completion is deferred: the service never writes the guard.
  assert.equal((await read(guardPath)).ownerLifecycleState, "active");
});

test("a duplicate acceptance replays without writing or re-timestamping", async () => {
  await seed();
  const first = await apply("in-a");
  const before = {
    receipts: await count(receiptsCollection),
    evidence: await count("attendance_evidence_v2"),
    operations: await count("attendance_evidence_operations_v2"),
    members: await count("shift_members"),
    stored: await read(`${receiptsCollection}/${first.receipt.id}`),
  };

  const replay = await apply("in-a");
  assert.equal(replay.status, "REPLAYED");
  assert.equal(replay.receiptHash, first.receiptHash);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(await count(receiptsCollection), before.receipts);
  assert.equal(await count("attendance_evidence_v2"), before.evidence);
  assert.equal(await count("attendance_evidence_operations_v2"), before.operations);
  assert.equal(await count("shift_members"), before.members);
  assert.deepEqual(await read(`${receiptsCollection}/${first.receipt.id}`), before.stored);
});

test("the second technician joins the activated shift without duplicating activation", async () => {
  await seed();
  const first = await apply("in-a");
  const firstReceipt = await read(`${receiptsCollection}/${first.receipt.id}`);
  const firstEvidence = await read(`attendance_evidence_v2/${first.receipt.evidenceId}`);
  const activationCount = (await db.collection("audit_logs")
    .where("action", "==", "EQUAL_SHIFT_ACTIVATED_INCOMING_V2").get()).size;

  const join = await apply("in-b");
  assert.equal(join.status, "APPLIED");
  assert.equal(join.outcome, "subsequent_join");
  assert.equal(join.receipt.activationReceiptId, first.receipt.activationReceiptId);

  assert.equal(await count(receiptsCollection), 2);
  assert.equal((await db.collection("shift_members").where("shiftId", "==", "incoming").get()).size, 2);
  assert.equal((await db.collection("shift_attendance").where("shiftId", "==", "incoming").get()).size, 2);
  assert.equal((await db.collection("audit_logs")
    .where("action", "==", "EQUAL_SHIFT_ACTIVATED_INCOMING_V2").get()).size, activationCount);
  assert.equal((await db.collection("audit_logs")
    .where("action", "==", "INCOMING_ACCEPTANCE_APPLIED_V1").get()).size, 2);

  // The first technician's records were not recreated or overwritten.
  assert.deepEqual(await read(`${receiptsCollection}/${first.receipt.id}`), firstReceipt);
  assert.deepEqual(await read(`attendance_evidence_v2/${first.receipt.evidenceId}`), firstEvidence);
  assert.equal((await read("shifts/incoming")).actualStart, first.receipt.operationalAppliedAt);
});

test("concurrent acceptance yields exactly one activation and one join", async () => {
  await seed();
  const [left, right] = await Promise.all([apply("in-a"), apply("in-b")]);
  const outcomes = [left.outcome, right.outcome].sort();
  assert.deepEqual(outcomes, ["first_activation", "subsequent_join"].sort());
  assert.notEqual(left.technicianUid, right.technicianUid);

  assert.equal((await db.collection("audit_logs")
    .where("action", "==", "EQUAL_SHIFT_ACTIVATED_INCOMING_V2").get()).size, 1);
  assert.equal((await db.collection("shifts").where("id", "==", "incoming").get()).size, 1);
  assert.equal(await count(receiptsCollection), 2);
  assert.equal((await db.collection("shift_members").where("shiftId", "==", "incoming").get()).size, 2);
  assert.equal((await db.collection("shift_attendance").where("shiftId", "==", "incoming").get()).size, 2);
  assert.equal(await count("attendance_evidence_v2"), 2);
  assert.equal((await read(aggregatePath)).lifecycleStatus, "completed");
});

test("finalized evidence without an application receipt cannot be promoted", async () => {
  await seed();
  const aggregate = await read(aggregatePath);
  const binding = await reviewedBinding();
  const guard = await read(guardPath);
  const appliedAt = new Date(await firstAppliedMs()).toISOString();
  const identity = applicationDomain.createIncomingAcceptanceApplicationIdentity({
    handoverId: aggregate.reservation.handoverId,
    technicianUid: "in-a",
    kind: "incoming_clock_in",
  });
  const position = getEqualHandoverPositions(aggregate.identity)
    .find((entry) => entry.technicianUid === "in-a" && entry.side === "incoming")?.position;
  assert.ok(position);
  const plan = planAtomicAcceptanceEvidence(
    { operation: null, slotEvidence: null, otherKindEvidence: [], guard, handover: aggregate },
    {
      request: {
        schema: ATTENDANCE_EVIDENCE_SCHEMA,
        handoverId: aggregate.reservation.handoverId,
        handoverDocumentId: "handover_v2_outgoing",
        eventId: identity.eventId,
        position,
        technicianUid: "in-a",
        kind: "incoming_clock_in",
        scheduledStart: aggregate.identity.scheduledStart,
        scheduledEnd: aggregate.identity.scheduledEnd,
        reportedDepartureTime: null,
        attestedByUid: null,
        attestationReason: null,
        lateReason: null,
        handoverRevision: aggregate.revision,
        snapshotHash: binding.snapshotHash,
        expectedGuardRevision: binding.guardRevision,
        expectedFencingEpoch: binding.fencingEpoch,
      },
      identity: aggregate.identity,
      reservation: aggregate.reservation,
      trustedAuthentication: {
        verifiedTechnicianUid: "in-a",
        method: attendanceAuthenticationMethodForKind("incoming_clock_in"),
      },
      serverAuthenticationTime: appliedAt,
    },
  );
  assert.equal(plan.mode, "create_operation_and_evidence");
  await db.runTransaction(async (transaction) => {
    applyAtomicAcceptanceEvidencePlan(transaction, plan);
  });
  assert.ok(await read(`attendance_evidence_v2/${plan.evidenceId}`));

  await assert.rejects(
    apply("in-a"),
    (error) => {
      assert.equal(error.code, "EVIDENCE_BINDING_CONFLICT", `${error.name}: ${error.message}`);
      return true;
    },
  );
  assert.equal(await count(receiptsCollection), 0);
  assert.equal(await read("shift_members/incoming_in-a"), undefined);
  assert.equal(await read("shifts/incoming"), undefined);
});

test("a failed guard-cleanup transaction cannot invalidate a committed application", async () => {
  await seed();
  const applied = await apply("in-a");
  const before = {
    receipt: await read(`${receiptsCollection}/${applied.receipt.id}`),
    membership: await read("shift_members/incoming_in-a"),
    attendance: await read("shift_attendance/incoming_in-a"),
    guard: await read(guardPath),
  };

  await assert.rejects(
    db.runTransaction(async (transaction) => {
      await transaction.get(db.doc(guardPath));
      transaction.set(db.doc(guardPath), { ...before.guard, ownerLifecycleState: "completed" });
      throw new Error("Injected guard cleanup failure");
    }),
    /Injected guard cleanup failure/,
  );

  assert.deepEqual(await read(`${receiptsCollection}/${applied.receipt.id}`), before.receipt);
  assert.deepEqual(await read("shift_members/incoming_in-a"), before.membership);
  assert.deepEqual(await read("shift_attendance/incoming_in-a"), before.attendance);
  assert.deepEqual(await read(guardPath), before.guard);

  const replay = await apply("in-a");
  assert.equal(replay.status, "REPLAYED");
});
