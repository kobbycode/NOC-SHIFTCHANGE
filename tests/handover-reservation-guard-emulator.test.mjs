/**
 * Firestore emulator integration tests for the handover reservation guard.
 *
 * Run via: tests/run-handover-reservation-guard-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-guard" on port 8088.
 * The guard at the top of this file refuses to run against any other project or
 * against a non-emulator host, preventing accidental production access.
 *
 * Identifier contract under test (authoritative, production-shaped):
 *   - handovers/<createHandoverDocumentId(outgoingShiftId)> is the stable aggregate location.
 *   - handover_reservation_guards/<createHandoverReservationGuardDocumentId(outgoingShiftId)>
 *     is the stable guard location.
 *   - guard.ownerHandoverDocumentId is that stable aggregate document ID.
 *   - guard.reservationId is the reservation identity fingerprint
 *     aggregate.reservation.handoverId === createHandoverId(identity).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fixtureRecords, modules } from "./formal-handover-transfer-fixtures.mjs";

const project = "demo-shiftchange-guard";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8088", "localhost:8088"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run guard emulator tests outside the isolated demo emulator.");
}
const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

// ---------------------------------------------------------------------------
// Module imports (dynamic — requires --conditions=react-server for server-only)
// ---------------------------------------------------------------------------

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const {
  initializeFormalHandover: initialize,
  replaceFormalHandoverReservation: replace,
  cancelFormalHandoverReservation: cancel,
} = await import("../src/lib/operations/formal-handover.ts");
const { persistFormalHandoverTransfer: transfer } = await import(
  "../src/lib/operations/formal-handover-transfer.ts"
);
const { persistFormalHandoverConfirmation: confirm } = await import(
  "../src/lib/operations/formal-handover-confirmation.ts"
);
const {
  resolveOrAcquireReservationGuard,
  replaceReservationGuard,
  cancelReservationGuard,
  completeReservationGuard,
  readReservationGuardState,
  HandoverReservationGuardError,
} = await import("../src/lib/operations/handover-reservation-guard.ts");
const { createHandoverReservationGuardDocumentId } = await import(
  "../src/lib/operations/handover-reservation-guard-domain.ts"
);
const {
  assertHandoverAggregate,
  createHandoverDocumentId,
  createHandoverSnapshot,
} = await import("../src/lib/operations/handover-domain.ts");
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");
const { freezeHandoverReport } = await import("../src/lib/operations/freeze-handover-report.ts");
const { recordShiftOperation } = await import("../src/lib/operations/shift-operations.ts");
const { createFormalHandoverTransferReceiptId } = await import(
  "../src/lib/operations/handover-transfer-domain.ts"
);
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");

const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Seeded reference data is historical, so its own metadata may be old. Guard
// mutations must never be dated before the live records production just wrote.
const historical = "2020-01-01T00:00:00.000Z";
const scheduledStart = "2030-01-01T06:00:00.000Z";
const scheduledEnd = "2030-01-01T14:00:00.000Z";
let seq = 0;

const liveAt = (...lowerBounds) =>
  new Date(Math.max(Date.now(), ...lowerBounds.map((value) => Date.parse(value)))).toISOString();

async function clearDb() {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200);
}

async function makeShiftFixture(status = "handover_pending", role = "admin") {
  const prefix = `g${++seq}`;
  const f = {
    actor: `${prefix}-manager`,
    outgoing: `${prefix}-outgoing`,
    outPair: `${prefix}-outpair`,
    inPair: `${prefix}-inpair`,
    out: [`${prefix}-outa`, `${prefix}-outb`],
    incoming: [`${prefix}-ina`, `${prefix}-inb`],
    token: randomUUID(),
    role,
  };
  f.input = {
    outgoingShiftId: f.outgoing,
    actorUid: f.actor,
    expectedRole: role,
    incomingPermanentPairId: f.inPair,
    shiftType: "morning",
    scheduledStart,
    scheduledEnd,
  };
  const batch = db.batch();
  for (const [uid, userRole] of [
    [f.actor, role],
    ...[...f.out, ...f.incoming].map((uid) => [uid, "technician"]),
  ]) {
    batch.set(ref("users", uid), { uid, role: userRole, status: "active", statusOperation: null, mustChangePassword: false });
  }
  for (const [id, ids] of [[f.outPair, f.out], [f.inPair, f.incoming]]) {
    batch.set(ref("technician_pairs", id), {
      id, technicianIds: ids, status: "active", createdBy: f.actor,
      createdAt: historical, updatedAt: historical, deactivatedAt: null, deactivatedBy: null,
    });
    for (const uid of ids)
      batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: id, createdAt: historical, updatedAt: historical });
  }
  f.shift = {
    id: f.outgoing, status, permanentPairId: f.outPair, primaryTechnicianIds: f.out,
    operationalSlotToken: f.token, shiftType: "morning",
    scheduledStart: "2020-01-01T06:00:00.000Z",
    scheduledEnd: "2020-01-01T14:00:00.000Z",
    actualStart: historical, actualEnd: null, createdBy: f.actor, createdAt: historical, updatedAt: historical,
  };
  batch.set(ref("shifts", f.outgoing), f.shift);

  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(f.token, 1, historical), f.outgoing, historical);
  control = transitionOperationalShiftControl(control, f.outgoing, "scheduled", "active", historical);
  if (status === "handover_pending") {
    control = transitionOperationalShiftControl(control, f.outgoing, "active", status, historical);
  }
  batch.set(ref("operational_shift_control", "global"), control);
  f.control = control;

  for (const uid of f.out) {
    const memberId = `${f.outgoing}_${uid}`;
    batch.set(ref("shift_members", memberId), { id: memberId, shiftId: f.outgoing, technicianId: uid, role: "primary", joinedAt: historical, leftAt: null });
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: f.outgoing, scheduledStart: f.shift.scheduledStart, scheduledEnd: f.shift.scheduledEnd, status }],
      updatedAt: historical,
    });
  }
  for (const uid of f.incoming) {
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: "unrelated-shift", scheduledStart: "2030-01-03T06:00:00.000Z", scheduledEnd: "2030-01-03T14:00:00.000Z", status: "scheduled" }],
      updatedAt: historical,
    });
  }
  await batch.commit();
  return f;
}

async function getGuard(outgoingShiftId) {
  const docId = createHandoverReservationGuardDocumentId(outgoingShiftId);
  const snap = await ref("handover_reservation_guards", docId).get();
  return snap.exists ? snap.data() : null;
}

// The aggregate always persists at its deterministic stable location.
async function getHandoverDocument(outgoingShiftId) {
  const snap = await ref("handovers", createHandoverDocumentId(outgoingShiftId)).get();
  return snap.exists ? snap.data() : null;
}

async function getHandoverQuery(outgoingShiftId) {
  const snap = await db.collection("handovers")
    .where("identity.outgoingShiftId", "==", outgoingShiftId)
    .limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, data: snap.docs[0].data() };
}

async function collectionState(name) {
  const snap = await db.collection(name).get();
  return snap.docs
    .map((doc) => [doc.id, doc.data()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function operationalState() {
  return {
    handovers: await collectionState("handovers"),
    shifts: await collectionState("shifts"),
    technicianSchedules: await collectionState("technician_schedules"),
    shiftMembers: await collectionState("shift_members"),
    operationalShiftControl: await collectionState("operational_shift_control"),
    auditLogs: await collectionState("audit_logs"),
    guard: await collectionState("handover_reservation_guards"),
  };
}

// ---------------------------------------------------------------------------
// Helper: run a simple Firestore transaction
// ---------------------------------------------------------------------------

async function withTransaction(fn) {
  return db.runTransaction(fn);
}

// Guard inputs always name the stable aggregate document and the reservation
// fingerprint of the aggregate that currently owns the reservation.
function guardAcquireInput(guard, overrides = {}) {
  return {
    outgoingShiftId: guard.outgoingShiftId,
    protocolOwner: guard.protocolOwner,
    ownerHandoverDocumentId: guard.ownerHandoverDocumentId,
    outgoingSlotToken: guard.outgoingSlotToken,
    outgoingGeneration: guard.outgoingGeneration,
    successorSlotToken: guard.successorSlotToken,
    successorGeneration: guard.successorGeneration,
    reservationId: guard.reservationId,
    reservedIncomingShiftId: guard.reservedIncomingShiftId,
    reservedAt: guard.reservedAt,
    reservedBy: guard.reservedBy,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Guard acquisition creates guard document on initialize
// ---------------------------------------------------------------------------

test("1. V1 initialize creates the guard at its stable location bound to the stable handover document", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);

  const guard = await getGuard(f.outgoing);
  assert.ok(guard, "Guard document must be created on initialize");
  assert.equal(guard.id, createHandoverReservationGuardDocumentId(f.outgoing));
  assert.equal(guard.protocolOwner, "v1");
  assert.equal(guard.ownerLifecycleState, "active");
  assert.equal(guard.outgoingShiftId, f.outgoing);
  assert.equal(guard.guardRevision, 1);
  assert.equal(guard.fencingEpoch, 1);

  const handover = await getHandoverDocument(f.outgoing);
  assert.ok(handover, "Handover must persist at the stable document ID");
  assert.equal(handover.identity.outgoingShiftId, f.outgoing);
  // The queried aggregate is the same document the writer created.
  const queried = await getHandoverQuery(f.outgoing);
  assert.equal(queried.id, createHandoverDocumentId(f.outgoing));
  assert.deepEqual(queried.data, handover);

  // Stable persistence document, not the reservation identity fingerprint.
  assert.equal(guard.ownerHandoverDocumentId, createHandoverDocumentId(f.outgoing));
  assert.equal(guard.reservationId, handover.reservation.handoverId);
  assert.notEqual(guard.ownerHandoverDocumentId, guard.reservationId);
  assert.equal(guard.reservedIncomingShiftId, handover.reservation.reservedIncomingShiftId);
});

// ---------------------------------------------------------------------------
// 2. Duplicate V1 initialization fails closed; same-owner guard retry is idempotent
// ---------------------------------------------------------------------------

test("2. V1 duplicate initialize fails closed unchanged and a same-owner guard retry is idempotent", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);

  const guardBefore = await getGuard(f.outgoing);
  const stateBefore = await operationalState();

  // The established v1 production API rejects a second initialization outright.
  await assert.rejects(
    () => initialize(f.input),
    (error) => {
      assert.ok(error instanceof AssignmentOperationError, `${error.constructor.name}: ${error.message}`);
      assert.equal(error.status, 409);
      assert.equal(error.message, "A formal handover already exists for this shift.");
      return true;
    },
  );

  assert.deepEqual(await operationalState(), stateBefore, "Rejected initialize must not mutate any operational state");
  assert.deepEqual(await getGuard(f.outgoing), guardBefore);

  // Same-owner retry is a guard-adapter concern, and it is idempotent.
  const retry = await withTransaction(async (tx) => {
    const state = await readReservationGuardState(tx, f.outgoing);
    return resolveOrAcquireReservationGuard(tx, guardAcquireInput(guardBefore), state);
  });
  assert.equal(retry.isNew, false);
  assert.deepEqual(retry.guard, guardBefore);

  const guardAfter = await getGuard(f.outgoing);
  assert.deepEqual(guardAfter, guardBefore);
  assert.equal(guardAfter.guardRevision, 1);
  assert.deepEqual(await operationalState(), stateBefore);
});

// ---------------------------------------------------------------------------
// 3. V1 replace updates guard and retires old successor token
// ---------------------------------------------------------------------------

test("3. V1 replace updates guard: retires old successor, increments revision and fencing epoch", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);
  const guardBefore = await getGuard(f.outgoing);
  const oldSuccessor = guardBefore.successorSlotToken;

  // Create a new incoming pair for replacement
  const prefix = `rep${seq}`;
  const newInPair = `${prefix}-newpair`;
  const newIncoming = [`${prefix}-new-ina`, `${prefix}-new-inb`];
  const batch = db.batch();
  batch.set(ref("technician_pairs", newInPair), {
    id: newInPair, technicianIds: newIncoming, status: "active",
    createdBy: f.actor, createdAt: historical, updatedAt: historical, deactivatedAt: null, deactivatedBy: null,
  });
  for (const uid of newIncoming) {
    batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: newInPair, createdAt: historical, updatedAt: historical });
    batch.set(ref("users", uid), { uid, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: "unrelated-shift", scheduledStart: "2030-01-03T06:00:00.000Z", scheduledEnd: "2030-01-03T14:00:00.000Z", status: "scheduled" }],
      updatedAt: historical,
    });
  }
  await batch.commit();

  const handover = await getHandoverDocument(f.outgoing);
  const aggregate = assertHandoverAggregate(handover);

  // The production replace contract re-selects the incoming pair through the
  // same selection fields as initialization.
  await replace({
    outgoingShiftId: f.outgoing,
    actorUid: f.actor,
    expectedRole: f.role,
    incomingPermanentPairId: newInPair,
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: createHandoverSnapshot(aggregate).snapshotHash,
    shiftType: "morning",
    scheduledStart,
    scheduledEnd,
  });

  const guardAfter = await getGuard(f.outgoing);
  assert.equal(guardAfter.guardRevision, 2);
  assert.equal(guardAfter.fencingEpoch, 2);
  assert.ok(guardAfter.retiredSuccessorSlotTokens.includes(oldSuccessor));
  assert.notEqual(guardAfter.successorSlotToken, oldSuccessor);
  assert.equal(guardAfter.ownerHandoverDocumentId, createHandoverDocumentId(f.outgoing));
  assert.equal(guardAfter.ownerLifecycleState, "active");

  const replaced = assertHandoverAggregate(await getHandoverDocument(f.outgoing));
  assert.equal(replaced.revision, 2);
  assert.equal(replaced.identity.incomingPermanentPairId, newInPair);
  // The replacement is a new reservation fingerprint at the same stable document.
  assert.equal(guardAfter.reservationId, replaced.reservation.handoverId);
  assert.notEqual(guardAfter.reservationId, guardBefore.reservationId);
  assert.notEqual(guardAfter.reservedIncomingShiftId, guardBefore.reservedIncomingShiftId);
});

// ---------------------------------------------------------------------------
// 4. V1 cancel transitions guard to cancelled state
// ---------------------------------------------------------------------------

test("4. V1 cancel transitions guard to cancelled state", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);

  const handover = await getHandoverDocument(f.outgoing);
  const aggregate = assertHandoverAggregate(handover);
  const snapshot = createHandoverSnapshot(aggregate);

  await cancel({
    outgoingShiftId: f.outgoing,
    actorUid: f.actor,
    expectedRole: f.role,
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: snapshot.snapshotHash,
  });

  const guard = await getGuard(f.outgoing);
  assert.equal(guard.ownerLifecycleState, "cancelled");
  assert.equal(guard.guardRevision, 2);
  assert.equal(guard.ownerHandoverDocumentId, createHandoverDocumentId(f.outgoing));
  assert.equal(guard.reservationId, aggregate.reservation.handoverId);
});

// ---------------------------------------------------------------------------
// 5. V1 transfer (full) completes the guard with receipt ID
// ---------------------------------------------------------------------------

const managerUser = {
  uid: "manager", role: "admin", status: "active", statusOperation: null,
  mustChangePassword: false, fullName: "manager", email: "manager@demo.invalid",
};
const technicianUser = (uid) => ({
  uid, role: "technician", status: "active", statusOperation: null,
  mustChangePassword: false, fullName: uid, email: `${uid}@demo.invalid`,
});
const broadcastObservation = (stationId) => ({
  kind: "broadcast", stationId, status: "on_air", occurredAt: new Date().toISOString(),
  remarks: "Verified actual audio",
});
const outsideBroadcast = () => ({
  kind: "outside_broadcast", title: "Community event", location: "Accra",
  occurredAt: new Date().toISOString(), runningStatus: "running",
  technicalIssues: "Backup uplink required", actionTaken: "Backup enabled",
  status: "monitoring", remarks: "Producer notified", linkedTaskId: null,
});

async function reviewed(outgoingShiftId) {
  const aggregate = assertHandoverAggregate(await getHandoverDocument(outgoingShiftId));
  return {
    aggregate,
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: createHandoverSnapshot(aggregate).snapshotHash,
  };
}

// Builds the real v1 precondition chain: an operational shift with verified
// broadcast evidence, then a live reservation created by the production
// initialize writer. The transfer writer owns the incoming Shift document.
async function makeTransferReadyFixture() {
  const load = modules();
  const f = structuredClone(fixtureRecords(load, { count: 0 }));
  // Operations are only writable while the shift is active, and the reserved
  // incoming schedule entries are created by the production initialize writer.
  f.shift.status = "active";
  delete f.shift.handoverStartedAt;
  f.records.set("shifts/outgoing", f.shift);
  f.records.get("operational_shift_control/global").shiftStatus = "active";
  f.records.delete("handovers/handover_outgoing");
  for (const [path, record] of f.records) {
    if (path.startsWith("users/")) record.fullName = record.uid;
    if (path.startsWith("technician_schedules/")) {
      for (const entry of record.entries) if (entry.shiftId === "outgoing") entry.status = "active";
      if (f.incoming.includes(record.technicianUid)) record.entries = [];
    }
  }
  for (const uid of f.out) {
    f.records.set(`shift_attendance/outgoing_${uid}`, load("lib/operations/shift-join-domain").createShiftAttendanceRecord({
      shiftId: "outgoing", technicianUid: uid, participationAuthority: "primary", authorizationId: null,
      recordedAt: f.shift.actualStart,
    }));
  }
  let batch = db.batch();
  for (const [path, record] of f.records) batch.set(db.doc(path), record);
  await batch.commit();

  for (const stationId of ["joy-fm", "adom-fm", "asempa-fm", "hitz-fm"]) {
    await recordShiftOperation(technicianUser("out-a"), "outgoing", { details: broadcastObservation(stationId) });
  }
  await recordShiftOperation(technicianUser("out-b"), "outgoing", { details: outsideBroadcast() });

  const handoverStartedAt = liveAt(f.shift.actualStart);
  batch = db.batch();
  batch.update(db.doc("shifts/outgoing"), { status: "handover_pending", handoverStartedAt });
  batch.update(db.doc("operational_shift_control/global"), { shiftStatus: "handover_pending" });
  for (const uid of f.out) {
    const schedule = (await db.doc(`technician_schedules/${uid}`).get()).data();
    batch.set(db.doc(`technician_schedules/${uid}`), {
      ...schedule,
      entries: schedule.entries.map((entry) => (entry.shiftId === "outgoing" ? { ...entry, status: "handover_pending" } : entry)),
    });
  }
  await batch.commit();

  f.identity = f.aggregate.identity;
  return f;
}

test("5. V1 end-to-end transfer completes the guard with the transfer receipt", async () => {
  await clearDb();
  const f = await makeTransferReadyFixture();

  // The reservation is created through the production v1 writer, so the guard
  // starts as an active revision-1 owner of the stable handover document.
  await initialize({
    outgoingShiftId: "outgoing",
    actorUid: "manager",
    expectedRole: "admin",
    incomingPermanentPairId: "in-pair",
    shiftType: f.identity.shiftType,
    scheduledStart: f.identity.scheduledStart,
    scheduledEnd: f.identity.scheduledEnd,
  });

  const reserved = await getHandoverDocument("outgoing");
  const incomingShiftId = reserved.reservation.reservedIncomingShiftId;
  assert.equal((await getGuard("outgoing")).guardRevision, 1);
  // The test never fabricates the reserved incoming Shift; the transfer owns it.
  assert.equal((await ref("shifts", incomingShiftId).get()).exists, false);

  // Report freeze binds every later confirmation and the transfer itself.
  const first = await reviewed("outgoing");
  await freezeHandoverReport(managerUser, "outgoing", {
    expectedRevision: first.expectedRevision,
    expectedSnapshotHash: first.expectedSnapshotHash,
    reason: "Reviewed outgoing report before transfer",
  });

  for (const uid of ["out-a", "out-b", "in-a", "in-b"]) {
    const { expectedRevision, expectedSnapshotHash } = await reviewed("outgoing");
    const outcome = await confirm({ outgoingShiftId: "outgoing", actorUid: uid, expectedRevision, expectedSnapshotHash });
    assert.equal(outcome.status, "CONFIRMED");
  }

  const { expectedRevision, expectedSnapshotHash } = await reviewed("outgoing");
  const result = await transfer({
    outgoingShiftId: "outgoing", actorUid: "manager", actorRole: "admin", expectedRevision, expectedSnapshotHash,
  });
  assert.equal(result.status, "TRANSFERRED");

  const guard = await getGuard("outgoing");
  assert.equal(guard.protocolOwner, "v1");
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, createFormalHandoverTransferReceiptId(createHandoverDocumentId("outgoing")));
  assert.equal(guard.guardRevision, 2);
  assert.equal(guard.ownerHandoverDocumentId, createHandoverDocumentId("outgoing"));
  const completed = assertHandoverAggregate(await getHandoverDocument("outgoing"));
  assert.equal(completed.lifecycleStatus, "completed");
  assert.equal(guard.reservationId, completed.reservation.handoverId);
  assert.equal(guard.terminalEvidenceRef, result.receipt.id);
  assert.equal((await collectionState("audit_logs")).filter(([id]) => id === result.receipt.id).length, 1);

  // The transfer writer created the incoming shift linked to the stable document.
  const incoming = await ref("shifts", incomingShiftId).get();
  assert.ok(incoming.exists, "Transfer must create the reserved incoming shift");
  assert.equal(incoming.data().handoverDocumentId, createHandoverDocumentId("outgoing"));
});

// ---------------------------------------------------------------------------
// 6. V2 claim blocked by active V1 guard (cross-protocol fencing)
// ---------------------------------------------------------------------------

test("6. V2 acquisition is blocked by existing active V1 guard", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);

  // Attempt to acquire with V2 protocol — should fail
  const handover = await getHandoverDocument(f.outgoing);
  const aggregate = assertHandoverAggregate(handover);

  await assert.rejects(
    () =>
      withTransaction(async (tx) => {
        const state = await readReservationGuardState(tx, f.outgoing);
        await resolveOrAcquireReservationGuard(
          tx,
          {
            outgoingShiftId: f.outgoing,
            protocolOwner: "v2",
            ownerHandoverDocumentId: `handover_v2_${f.outgoing}`,
            outgoingSlotToken: aggregate.identity.outgoingSlotToken,
            outgoingGeneration: aggregate.identity.outgoingGeneration,
            successorSlotToken: randomUUID(),
            successorGeneration: aggregate.identity.successorGeneration,
            reservationId: randomUUID(),
            reservedIncomingShiftId: aggregate.identity.incomingShiftId,
            reservedAt: historical,
            reservedBy: f.actor,
          },
          state,
        );
      }),
    (error) => {
      assert.ok(error instanceof HandoverReservationGuardError, `${error.constructor.name}: ${error.message}`);
      assert.equal(error.status, 409);
      return true;
    },
  );

  // Guard must still be owned by V1
  const guard = await getGuard(f.outgoing);
  assert.equal(guard.protocolOwner, "v1");
  assert.equal(guard.ownerLifecycleState, "active");
  assert.equal(guard.guardRevision, 1); // unchanged
});

// ---------------------------------------------------------------------------
// 7. Guardless legacy V1 adoption (active): V2 blocked; V1 adopts and creates guard
// ---------------------------------------------------------------------------

test("7. Guardless legacy V1 adoption: active legacy blocks V2 and is adopted by V1", async () => {
  await clearDb();
  const f = await makeShiftFixture();

  // Create a V1 handover, then drop the guard to simulate a pre-guard legacy shift.
  await initialize(f.input);
  const aggregate = assertHandoverAggregate(await getHandoverDocument(f.outgoing));

  // Delete the guard document to simulate guardless legacy
  const guardDocId = createHandoverReservationGuardDocumentId(f.outgoing);
  await ref("handover_reservation_guards", guardDocId).delete();
  assert.equal(await getGuard(f.outgoing), null);

  // V2 should be blocked by active legacy handover
  await assert.rejects(
    () =>
      withTransaction(async (tx) => {
        const state = await readReservationGuardState(tx, f.outgoing);
        await resolveOrAcquireReservationGuard(
          tx,
          {
            outgoingShiftId: f.outgoing,
            protocolOwner: "v2",
            ownerHandoverDocumentId: `handover_v2_${f.outgoing}`,
            outgoingSlotToken: aggregate.identity.outgoingSlotToken,
            outgoingGeneration: aggregate.identity.outgoingGeneration,
            successorSlotToken: randomUUID(),
            successorGeneration: aggregate.identity.successorGeneration,
            reservationId: randomUUID(),
            reservedIncomingShiftId: aggregate.identity.incomingShiftId,
            reservedAt: historical,
            reservedBy: f.actor,
          },
          state,
        );
      }),
    (error) => {
      assert.ok(error instanceof HandoverReservationGuardError, `${error.constructor.name}: ${error.message}`);
      assert.equal(error.status, 409);
      return true;
    },
  );

  // V1 same-owner retry should adopt the legacy and create the guard
  let adopted = null;
  await withTransaction(async (tx) => {
    const state = await readReservationGuardState(tx, f.outgoing);
    const result = await resolveOrAcquireReservationGuard(
      tx,
      {
        outgoingShiftId: f.outgoing,
        protocolOwner: "v1",
        ownerHandoverDocumentId: createHandoverDocumentId(f.outgoing),
        outgoingSlotToken: aggregate.identity.outgoingSlotToken,
        outgoingGeneration: aggregate.identity.outgoingGeneration,
        successorSlotToken: aggregate.identity.successorSlotToken,
        successorGeneration: aggregate.identity.successorGeneration,
        reservationId: aggregate.reservation.handoverId,
        reservedIncomingShiftId: aggregate.reservation.reservedIncomingShiftId,
        reservedAt: aggregate.reservation.reservedAt,
        reservedBy: aggregate.reservation.reservedBy,
      },
      state,
    );
    adopted = result.guard;
  });

  const guard = await getGuard(f.outgoing);
  assert.ok(guard, "Guard must be created by V1 legacy adoption");
  assert.equal(guard.protocolOwner, "v1");
  assert.equal(guard.ownerLifecycleState, "active");
  assert.equal(guard.guardRevision, 1);
  assert.equal(guard.ownerHandoverDocumentId, createHandoverDocumentId(f.outgoing));
  assert.equal(guard.reservationId, aggregate.reservation.handoverId);
  assert.deepEqual(adopted, guard);
});

// ---------------------------------------------------------------------------
// 8. Concurrent V1 acquisition racing: losing writer fails closed, no partial write
// ---------------------------------------------------------------------------

test("8. Concurrent acquisition racing: losing writer fails closed without partial writes", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  const stateBefore = await operationalState();

  // Both writers claim the same stable handover document with different reservations.
  const incomingA = randomUUID();
  const incomingB = randomUUID();
  const ownerDocumentId = createHandoverDocumentId(f.outgoing);

  const inputA = {
    outgoingShiftId: f.outgoing,
    protocolOwner: "v1",
    ownerHandoverDocumentId: ownerDocumentId,
    outgoingSlotToken: f.token,
    outgoingGeneration: 1,
    successorSlotToken: randomUUID(),
    successorGeneration: 2,
    reservationId: `res-${incomingA}`,
    reservedIncomingShiftId: incomingA,
    reservedAt: historical,
    reservedBy: f.actor,
  };
  const inputB = {
    ...inputA,
    successorSlotToken: randomUUID(),
    reservationId: `res-${incomingB}`,
    reservedIncomingShiftId: incomingB,
  };

  // Race two concurrent Firestore transactions
  const results = await Promise.allSettled([
    withTransaction(async (tx) => {
      const state = await readReservationGuardState(tx, inputA.outgoingShiftId);
      return resolveOrAcquireReservationGuard(tx, inputA, state);
    }),
    withTransaction(async (tx) => {
      const state = await readReservationGuardState(tx, inputB.outgoingShiftId);
      return resolveOrAcquireReservationGuard(tx, inputB, state);
    }),
  ]);

  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");

  // Exactly one acquisition may own the guard; the loser fails closed.
  assert.equal(succeeded.length, 1, "exactly one acquisition must succeed");
  assert.equal(failed.length, 1);
  const loser = failed[0].reason;
  assert.ok(
    loser instanceof HandoverReservationGuardError || loser.status === 409 || loser.code === 10 || loser.code === 4,
    `${loser.constructor.name}: ${loser.message}`,
  );

  const guard = await getGuard(f.outgoing);
  assert.ok(guard, "Guard must exist after race");
  assert.equal(guard.ownerLifecycleState, "active");
  assert.equal(guard.guardRevision, 1); // Only one write round
  assert.equal(guard.reservationId, succeeded[0].value.guard.reservationId);

  // The losing writer left no partial operational writes behind.
  const stateAfter = await operationalState();
  assert.deepEqual({ ...stateAfter, guard: undefined }, { ...stateBefore, guard: undefined });
  assert.equal(stateAfter.guard.length, 1);
});

// ---------------------------------------------------------------------------
// 9. completeReservationGuard for guardless completed legacy
// ---------------------------------------------------------------------------

test("9. completeReservationGuard adopts completed guardless legacy and creates guard", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);
  const documentId = createHandoverDocumentId(f.outgoing);
  const aggregate = assertHandoverAggregate(await getHandoverDocument(f.outgoing));

  // Simulate a real pre-guard completed legacy at its stable Firestore location.
  const completedAt = liveAt(aggregate.updatedAt);
  await ref("handovers", documentId).update({ lifecycleStatus: "completed", updatedAt: completedAt });
  const legacy = assertHandoverAggregate(await getHandoverDocument(f.outgoing));
  assert.equal(legacy.lifecycleStatus, "completed");

  // Delete guard to simulate legacy
  await ref("handover_reservation_guards", createHandoverReservationGuardDocumentId(f.outgoing)).delete();

  const receiptId = `receipt-${randomUUID()}`;

  await withTransaction(async (tx) => {
    const state = await readReservationGuardState(tx, f.outgoing);
    await completeReservationGuard(
      tx,
      {
        outgoingShiftId: f.outgoing,
        protocolOwner: "v1",
        receiptId,
        outgoingSlotToken: legacy.identity.outgoingSlotToken,
        outgoingGeneration: legacy.identity.outgoingGeneration,
        successorSlotToken: legacy.identity.successorSlotToken,
        successorGeneration: legacy.identity.successorGeneration,
        recordedAt: completedAt,
        actorUid: f.actor,
      },
      state,
    );
  });

  const guard = await getGuard(f.outgoing);
  assert.ok(guard, "Guard must be created for guardless completed legacy");
  assert.equal(guard.protocolOwner, "v1");
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, receiptId);
  assert.equal(guard.ownerHandoverDocumentId, documentId);
  assert.equal(guard.reservationId, legacy.reservation.handoverId);
});

// ---------------------------------------------------------------------------
// 10. cancelReservationGuard for guardless active legacy
// ---------------------------------------------------------------------------

test("10. cancelReservationGuard adopts guardless active legacy and transitions to cancelled", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);
  const aggregate = assertHandoverAggregate(await getHandoverDocument(f.outgoing));

  // Delete guard to simulate legacy
  await ref("handover_reservation_guards", createHandoverReservationGuardDocumentId(f.outgoing)).delete();

  // Terminal evidence is recorded at the live server time, never before the
  // reservation it fences.
  const recordedAt = liveAt(aggregate.updatedAt);

  await withTransaction(async (tx) => {
    const state = await readReservationGuardState(tx, f.outgoing);
    await cancelReservationGuard(
      tx,
      {
        outgoingShiftId: f.outgoing,
        protocolOwner: "v1",
        expectedGuardRevision: 1,
        expectedFencingEpoch: 1,
        terminalEvidenceRef: "cancellation-ref-001",
        recordedAt,
        actorUid: f.actor,
      },
      state,
    );
  });

  const guard = await getGuard(f.outgoing);
  assert.ok(guard);
  assert.equal(guard.ownerLifecycleState, "cancelled");
  assert.equal(guard.terminalEvidenceRef, "cancellation-ref-001");
  assert.equal(guard.guardRevision, 2);
  assert.equal(guard.ownerHandoverDocumentId, createHandoverDocumentId(f.outgoing));
  assert.equal(guard.reservationId, aggregate.reservation.handoverId);
});

// ---------------------------------------------------------------------------
// 11. Stale guard revision and fencing epoch fail closed at the Firestore boundary
// ---------------------------------------------------------------------------

test("11. A writer holding a stale guard revision or fencing epoch is rejected without writes", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);
  const guardV1 = await getGuard(f.outgoing);

  const replacementInput = {
    outgoingShiftId: f.outgoing,
    protocolOwner: "v1",
    outgoingSlotToken: guardV1.outgoingSlotToken,
    outgoingGeneration: guardV1.outgoingGeneration,
    successorSlotToken: randomUUID(),
    successorGeneration: guardV1.successorGeneration,
    reservationId: `res-${randomUUID()}`,
    reservedIncomingShiftId: `incoming-${randomUUID()}`,
    recordedAt: liveAt(guardV1.updatedAt),
    actorUid: f.actor,
    expectedGuardRevision: guardV1.guardRevision,
    expectedFencingEpoch: guardV1.fencingEpoch,
  };

  // Advance the guard through the real replacement boundary to revision 2.
  const advanced = await withTransaction(async (tx) =>
    replaceReservationGuard(tx, replacementInput, await readReservationGuardState(tx, f.outgoing)));
  assert.equal(advanced.guardRevision, 2);
  assert.equal(advanced.fencingEpoch, 2);
  const stateBefore = await operationalState();

  // Replace with the stale revision.
  await assert.rejects(
    () =>
      withTransaction(async (tx) =>
        replaceReservationGuard(
          tx,
          { ...replacementInput, expectedGuardRevision: 1, successorSlotToken: randomUUID() },
          await readReservationGuardState(tx, f.outgoing),
        )),
    (error) => {
      assert.ok(error instanceof HandoverReservationGuardError, `${error.constructor.name}: ${error.message}`);
      assert.equal(error.status, 409);
      assert.match(error.message, /Stale guard revision/);
      return true;
    },
  );

  // Cancel with the stale fencing epoch.
  await assert.rejects(
    () =>
      withTransaction(async (tx) =>
        cancelReservationGuard(
          tx,
          {
            outgoingShiftId: f.outgoing,
            protocolOwner: "v1",
            expectedGuardRevision: advanced.guardRevision,
            expectedFencingEpoch: 1,
            terminalEvidenceRef: "stale-cancellation-ref",
            recordedAt: liveAt(advanced.updatedAt),
            actorUid: f.actor,
          },
          await readReservationGuardState(tx, f.outgoing),
        )),
    (error) => {
      assert.ok(error instanceof HandoverReservationGuardError, `${error.constructor.name}: ${error.message}`);
      assert.equal(error.status, 409);
      assert.match(error.message, /Stale guard fencing epoch/);
      return true;
    },
  );

  assert.deepEqual(await getGuard(f.outgoing), advanced);
  assert.deepEqual(await operationalState(), stateBefore);
});

test.after(async () => {
  await db.terminate();
});
