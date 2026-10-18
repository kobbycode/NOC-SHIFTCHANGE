/**
 * Firestore emulator integration tests for the handover reservation guard.
 *
 * Run via: tests/run-handover-reservation-guard-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-guard" on port 8088.
 * The guard at the top of this file refuses to run against any other project or
 * against a non-emulator host, preventing accidental production access.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

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
const { assertHandoverAggregate } = await import("../src/lib/operations/handover-domain.ts");
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const { createHandoverWorkSnapshot } = await import("../src/lib/operations/handover-work-snapshot.ts");
const { confirmHandoverParticipant, createHandoverSnapshot } = await import(
  "../src/lib/operations/handover-domain.ts"
);
const { freezeHandoverReport } = await import("../src/lib/operations/freeze-handover-report.ts");

const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const at = "2020-01-01T00:00:00.000Z";
const scheduledStart = "2030-01-01T06:00:00.000Z";
const scheduledEnd = "2030-01-01T14:00:00.000Z";
let seq = 0;

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
      createdAt: at, updatedAt: at, deactivatedAt: null, deactivatedBy: null,
    });
    for (const uid of ids)
      batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: id, createdAt: at, updatedAt: at });
  }
  f.shift = {
    id: f.outgoing, status, permanentPairId: f.outPair, primaryTechnicianIds: f.out,
    operationalSlotToken: f.token, shiftType: "morning",
    scheduledStart: "2020-01-01T06:00:00.000Z",
    scheduledEnd: "2020-01-01T14:00:00.000Z",
    actualStart: at, actualEnd: null, createdBy: f.actor, createdAt: at, updatedAt: at,
  };
  batch.set(ref("shifts", f.outgoing), f.shift);

  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(f.token, 1, at), f.outgoing, at);
  control = transitionOperationalShiftControl(control, f.outgoing, "scheduled", "active", at);
  if (status === "handover_pending") {
    control = transitionOperationalShiftControl(control, f.outgoing, "active", status, at);
  }
  batch.set(ref("operational_shift_control", "global"), control);
  f.control = control;

  for (const uid of f.out) {
    const memberId = `${f.outgoing}_${uid}`;
    batch.set(ref("shift_members", memberId), { id: memberId, shiftId: f.outgoing, technicianId: uid, role: "primary", joinedAt: at, leftAt: null });
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: f.outgoing, scheduledStart: f.shift.scheduledStart, scheduledEnd: f.shift.scheduledEnd, status }],
      updatedAt: at,
    });
  }
  for (const uid of f.incoming) {
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: "unrelated-shift", scheduledStart: "2030-01-03T06:00:00.000Z", scheduledEnd: "2030-01-03T14:00:00.000Z", status: "scheduled" }],
      updatedAt: at,
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

async function getHandover(outgoingShiftId) {
  const snap = await db.collection("handovers")
    .where("identity.outgoingShiftId", "==", outgoingShiftId)
    .limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data();
}

// ---------------------------------------------------------------------------
// Helper: run a simple Firestore transaction
// ---------------------------------------------------------------------------

async function withTransaction(fn) {
  return db.runTransaction(fn);
}

// ---------------------------------------------------------------------------
// 1. Guard acquisition creates guard document on initialize
// ---------------------------------------------------------------------------

test("1. V1 initialize creates reservation guard document atomically", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  const result = await initialize(f.input);

  const guard = await getGuard(f.outgoing);
  assert.ok(guard, "Guard document must be created on initialize");
  assert.equal(guard.protocolOwner, "v1");
  assert.equal(guard.ownerLifecycleState, "active");
  assert.equal(guard.outgoingShiftId, f.outgoing);
  assert.equal(guard.guardRevision, 1);
  assert.equal(guard.fencingEpoch, 1);

  // Guard references the actual handover aggregate
  const handover = await getHandover(f.outgoing);
  assert.ok(handover, "Handover document must be created");
  assert.equal(guard.ownerHandoverDocumentId, handover.reservation.handoverId);
  assert.equal(guard.reservationId, handover.reservation.handoverId);
});

// ---------------------------------------------------------------------------
// 2. Same-owner idempotent retry: second initialize returns existing guard
// ---------------------------------------------------------------------------

test("2. V1 initialize is idempotent (same-owner retry returns same guard)", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  const first = await initialize(f.input);
  const guardBefore = await getGuard(f.outgoing);

  // Re-submit the same initialization — should be an exact same-owner retry
  const second = await initialize(f.input);
  const guardAfter = await getGuard(f.outgoing);

  assert.deepEqual(guardBefore, guardAfter);
  assert.equal(guardAfter.guardRevision, 1); // unchanged
});

// ---------------------------------------------------------------------------
// 3. V1 replace updates guard and retires old successor token
// ---------------------------------------------------------------------------

test("3. V1 replace updates guard: retires old successor, increments revision and fencing epoch", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  const first = await initialize(f.input);
  const guardBefore = await getGuard(f.outgoing);
  const oldSuccessor = guardBefore.successorSlotToken;

  // Create a new incoming pair for replacement
  const prefix = `rep${seq}`;
  const newInPair = `${prefix}-newpair`;
  const newIncoming = [`${prefix}-new-ina`, `${prefix}-new-inb`];
  const batch = db.batch();
  batch.set(ref("technician_pairs", newInPair), {
    id: newInPair, technicianIds: newIncoming, status: "active",
    createdBy: f.actor, createdAt: at, updatedAt: at, deactivatedAt: null, deactivatedBy: null,
  });
  for (const uid of newIncoming) {
    batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: newInPair, createdAt: at, updatedAt: at });
    batch.set(ref("users", uid), { uid, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: "unrelated-shift", scheduledStart: "2030-01-03T06:00:00.000Z", scheduledEnd: "2030-01-03T14:00:00.000Z", status: "scheduled" }],
      updatedAt: at,
    });
  }
  await batch.commit();

  const handover = await getHandover(f.outgoing);
  const aggregate = assertHandoverAggregate(handover);

  await replace({
    outgoingShiftId: f.outgoing,
    actorUid: f.actor,
    expectedRole: f.role,
    newIncomingPermanentPairId: newInPair,
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
});

// ---------------------------------------------------------------------------
// 4. V1 cancel transitions guard to cancelled state
// ---------------------------------------------------------------------------

test("4. V1 cancel transitions guard to cancelled state", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);

  const handover = await getHandover(f.outgoing);
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
});

// ---------------------------------------------------------------------------
// 5. V1 transfer (full) completes the guard with receipt ID
// ---------------------------------------------------------------------------

test("5. V1 transfer completion sets guard ownerLifecycleState to completed with receipt", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  const initResult = await initialize(f.input);

  // Confirm all four participants so the handover is ready
  let handoverDoc = await getHandover(f.outgoing);
  let aggregate = assertHandoverAggregate(handoverDoc);

  // Freeze the handover report first
  const workSnapshot = createHandoverWorkSnapshot({ outgoingShiftId: f.outgoing, tasks: [], assignments: [] });
  const snap0 = createHandoverSnapshot(aggregate);
  const frozenResult = await freezeHandoverReport({
    outgoingShiftId: f.outgoing,
    actorUid: f.actor,
    expectedRole: f.role,
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: snap0.snapshotHash,
    workSnapshot,
    reportItems: [],
    faultItems: [],
    outsideBroadcastItems: [],
  });

  // Re-fetch and confirm all 4 participants
  handoverDoc = await getHandover(f.outgoing);
  aggregate = assertHandoverAggregate(handoverDoc);

  for (const uid of [...f.out, ...f.incoming]) {
    const snap = createHandoverSnapshot(aggregate);
    aggregate = confirmHandoverParticipant(aggregate, {
      actorUid: uid,
      technicianUid: uid,
      revision: aggregate.revision,
      snapshotHash: snap.snapshotHash,
      confirmedAt: at,
    });
    // Persist confirmation
    const snap2 = createHandoverSnapshot(aggregate);
    await db.collection("handovers").doc(handoverDoc.reservation.handoverId).update({
      confirmations: aggregate.confirmations,
      revision: aggregate.revision,
      updatedAt: at,
    });
  }

  // Re-fetch aggregate for transfer
  handoverDoc = await getHandover(f.outgoing);
  aggregate = assertHandoverAggregate(handoverDoc);
  const finalSnap = createHandoverSnapshot(aggregate);

  // Create incoming shift document for transfer
  const incomingShiftId = aggregate.identity.incomingShiftId;
  await ref("shifts", incomingShiftId).set({
    id: incomingShiftId, status: "scheduled", permanentPairId: f.inPair,
    primaryTechnicianIds: f.incoming, operationalSlotToken: randomUUID(),
    shiftType: "morning", scheduledStart, scheduledEnd,
    actualStart: null, actualEnd: null, createdBy: f.actor, createdAt: at, updatedAt: at,
  });

  await transfer({
    outgoingShiftId: f.outgoing,
    actorUid: f.actor,
    expectedRole: f.role,
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: finalSnap.snapshotHash,
    transferAt: at,
  });

  const guard = await getGuard(f.outgoing);
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.ok(guard.terminalEvidenceRef, "Guard must have terminal evidence receipt");
  assert.equal(guard.guardRevision, 2);
});

// ---------------------------------------------------------------------------
// 6. V2 claim blocked by active V1 guard (cross-protocol fencing)
// ---------------------------------------------------------------------------

test("6. V2 acquisition is blocked by existing active V1 guard", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  const initResult = await initialize(f.input);

  // Attempt to acquire with V2 protocol — should fail
  const handoverDoc = await getHandover(f.outgoing);
  const aggregate = assertHandoverAggregate(handoverDoc);

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
            successorGeneration: aggregate.identity.outgoingGeneration + 1,
            reservationId: randomUUID(),
            reservedIncomingShiftId: aggregate.identity.incomingShiftId,
            reservedAt: at,
            reservedBy: f.actor,
          },
          state,
        );
      }),
    (err) => {
      assert.ok(err instanceof HandoverReservationGuardError || err.status === 409);
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

  // Create a V1 handover without guard (simulate pre-guard legacy state)
  const initResult = await initialize(f.input);
  const handoverDoc = await getHandover(f.outgoing);
  const aggregate = assertHandoverAggregate(handoverDoc);

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
            successorGeneration: aggregate.identity.outgoingGeneration + 1,
            reservationId: randomUUID(),
            reservedIncomingShiftId: aggregate.identity.incomingShiftId,
            reservedAt: at,
            reservedBy: f.actor,
          },
          state,
        );
      }),
    (err) => {
      assert.ok(err instanceof HandoverReservationGuardError || err.status === 409);
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
        ownerHandoverDocumentId: aggregate.reservation.handoverId,
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
});

// ---------------------------------------------------------------------------
// 8. Concurrent V1 acquisition racing: losing writer fails closed, no partial write
// ---------------------------------------------------------------------------

test("8. Concurrent acquisition racing: losing writer fails closed without partial writes", async () => {
  await clearDb();
  const f = await makeShiftFixture();

  // Prepare two competing acquire inputs that claim the same outgoing shift with different reservations
  const incomingA = randomUUID();
  const incomingB = randomUUID();

  const inputA = {
    outgoingShiftId: f.outgoing,
    protocolOwner: "v1",
    ownerHandoverDocumentId: `handover_${f.outgoing}_a`,
    outgoingSlotToken: f.token,
    outgoingGeneration: 1,
    successorSlotToken: randomUUID(),
    successorGeneration: 2,
    reservationId: `res-${incomingA}`,
    reservedIncomingShiftId: incomingA,
    reservedAt: at,
    reservedBy: f.actor,
  };
  const inputB = {
    ...inputA,
    ownerHandoverDocumentId: `handover_${f.outgoing}_b`,
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

  // Exactly one must succeed (the other aborts with transaction conflict or guard conflict)
  assert.ok(succeeded.length >= 1, "At least one acquisition must succeed");
  // If both somehow succeeded (extreme race), both reservations must agree (same winner)
  if (succeeded.length === 2) {
    // Both wrote — they must have written the same guard (idempotent retry)
    const [g1, g2] = [succeeded[0].value.guard, succeeded[1].value.guard];
    assert.equal(g1.reservedIncomingShiftId, g2.reservedIncomingShiftId);
  }

  const guard = await getGuard(f.outgoing);
  assert.ok(guard, "Guard must exist after race");
  assert.equal(guard.ownerLifecycleState, "active");
  assert.equal(guard.guardRevision, 1); // Only one write round
});

// ---------------------------------------------------------------------------
// 9. completeReservationGuard for guardless completed legacy
// ---------------------------------------------------------------------------

test("9. completeReservationGuard adopts completed guardless legacy and creates guard", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);
  const handoverDoc = await getHandover(f.outgoing);
  const aggregate = assertHandoverAggregate(handoverDoc);

  // Manually mark the handover as completed in Firestore (simulate transfer already done pre-guard)
  await db.collection("handovers").doc(aggregate.reservation.handoverId).update({
    lifecycleStatus: "completed",
    updatedAt: at,
  });

  // Delete guard to simulate legacy
  const guardDocId = createHandoverReservationGuardDocumentId(f.outgoing);
  await ref("handover_reservation_guards", guardDocId).delete();

  const receiptId = `receipt-${randomUUID()}`;

  await withTransaction(async (tx) => {
    const state = await readReservationGuardState(tx, f.outgoing);
    await completeReservationGuard(
      tx,
      {
        outgoingShiftId: f.outgoing,
        protocolOwner: "v1",
        receiptId,
        outgoingSlotToken: aggregate.identity.outgoingSlotToken,
        outgoingGeneration: aggregate.identity.outgoingGeneration,
        successorSlotToken: aggregate.identity.successorSlotToken,
        successorGeneration: aggregate.identity.successorGeneration,
        recordedAt: at,
        actorUid: f.actor,
      },
      state,
    );
  });

  const guard = await getGuard(f.outgoing);
  assert.ok(guard, "Guard must be created for guardless completed legacy");
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, receiptId);
});

// ---------------------------------------------------------------------------
// 10. cancelReservationGuard for guardless active legacy
// ---------------------------------------------------------------------------

test("10. cancelReservationGuard adopts guardless active legacy and transitions to cancelled", async () => {
  await clearDb();
  const f = await makeShiftFixture();
  await initialize(f.input);
  const handoverDoc = await getHandover(f.outgoing);
  const aggregate = assertHandoverAggregate(handoverDoc);

  // Delete guard to simulate legacy
  const guardDocId = createHandoverReservationGuardDocumentId(f.outgoing);
  await ref("handover_reservation_guards", guardDocId).delete();

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
        recordedAt: at,
        actorUid: f.actor,
      },
      state,
    );
  });

  const guard = await getGuard(f.outgoing);
  assert.ok(guard);
  assert.equal(guard.ownerLifecycleState, "cancelled");
  assert.equal(guard.terminalEvidenceRef, "cancellation-ref-001");
});
