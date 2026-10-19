/**
 * Firestore emulator integration tests for the equal-technician v2 handover
 * reservation workflow (TECH-HO-RECOVERY-04).
 *
 * Run via: tests/run-handover-v2-reservation-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-handover-v2" on
 * port 8091 with synthetic accounts only. The suite refuses to run against any
 * other project or a non-emulator host.
 *
 * Identifier contract under test (authoritative, production-shaped):
 *   - equal_handovers_v2/<createEqualHandoverDocumentId(outgoingShiftId)> is
 *     the stable v2 aggregate location (distinct from the v1 stable document).
 *   - The reservation identity fingerprint is createEqualHandoverId(identity).
 *   - The shared lock is handover_reservation_guards/<guard document id> —
 *     the exact same deterministic document the v1 writer uses. There is no
 *     independent v2-only lock. Cancelled-guard history is archived in
 *     handover_reservation_guard_history.
 *   - The cross-version race invokes the actual production v1 (formal-handover)
 *     and v2 (equal-handover-reservation-firestore) writers, never a
 *     guard-domain mock.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest } from "next/server";

const project = "demo-shiftchange-handover-v2";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8091", "localhost:8091"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run v2 reservation emulator tests outside the isolated demo emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The v2 emulator suite must exercise services directly, with no dev feature flag.");
}
const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const {
  initializeFormalHandover: v1Initialize,
  cancelFormalHandoverReservation: v1Cancel,
} = await import("../src/lib/operations/formal-handover.ts");
const { createHandoverDocumentId, createHandoverSnapshot, assertHandoverAggregate } = await import(
  "../src/lib/operations/handover-domain.ts"
);
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const {
  initializeEqualHandoverReservation,
  replaceEqualHandoverReservationForTechnicians,
  cancelEqualHandoverReservationForTechnicians,
  readEqualHandoverReservation,
} = await import("../src/lib/operations/equal-handover-reservation-firestore.ts");
const {
  assertEqualHandoverAggregate,
  createEqualHandoverDocumentId,
  createEqualHandoverId,
} = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const { OPERATIONAL_COLLECTIONS, getOperationalCollections } = await import(
  "../src/lib/operations/collections.ts"
);
const {
  resolveOrAcquireReservationGuard,
  readReservationGuardState,
  HandoverReservationGuardError,
} = await import("../src/lib/operations/handover-reservation-guard.ts");
const {
  assertHandoverReservationGuard,
  createHandoverReservationGuardDocumentId,
  createInitialReservationGuard,
  createReservationGuardArchiveDocumentId,
  transitionGuardForCompletion,
} = await import("../src/lib/operations/handover-reservation-guard-domain.ts");
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");

const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);

const historical = "2020-01-01T00:00:00.000Z";
const scheduledStart = "2030-01-01T06:00:00.000Z";
const scheduledEnd = "2030-01-01T14:00:00.000Z";
let seq = 0;

const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearDb() {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200);
}

async function makeActiveShiftFixture({ managerRole = "supervisor" } = {}) {
  const prefix = `v2g${++seq}`;
  const f = {
    manager: `${prefix}-manager`,
    outgoing: `${prefix}-outgoing`,
    outPair: `${prefix}-outpair`,
    inPair: `${prefix}-inpair`,
    out: [`${prefix}-outa`, `${prefix}-outb`],
    incoming: [`${prefix}-ina`, `${prefix}-inb`],
    unrelated: `${prefix}-unrelated`,
    token: randomUUID(),
  };
  const batch = db.batch();
  batch.set(ref("users", f.manager), { uid: f.manager, role: managerRole, status: "active", statusOperation: null, mustChangePassword: false });
  for (const uid of [...f.out, ...f.incoming]) {
    batch.set(ref("users", uid), { uid, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  }
  batch.set(ref("users", f.unrelated), { uid: f.unrelated, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  for (const [id, ids] of [[f.outPair, f.out], [f.inPair, f.incoming]]) {
    batch.set(ref("technician_pairs", id), {
      id, technicianIds: ids, status: "active", createdBy: f.manager,
      createdAt: historical, updatedAt: historical, deactivatedAt: null, deactivatedBy: null,
    });
    for (const uid of ids) {
      batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: id, createdAt: historical, updatedAt: historical });
    }
  }
  f.shift = {
    id: f.outgoing, status: "active", permanentPairId: f.outPair, primaryTechnicianIds: f.out,
    operationalSlotToken: f.token, shiftType: "morning",
    scheduledStart, scheduledEnd,
    actualStart: historical, actualEnd: null, createdBy: f.manager, createdAt: historical, updatedAt: historical,
  };
  batch.set(ref("shifts", f.outgoing), f.shift);

  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(f.token, 1, historical), f.outgoing, historical);
  control = transitionOperationalShiftControl(control, f.outgoing, "scheduled", "active", historical);
  batch.set(ref("operational_shift_control", "global"), control);

  const memberId = (uid) => `${f.outgoing}_${uid}`;
  for (const uid of f.out) {
    batch.set(ref("shift_members", memberId(uid)), {
      id: memberId(uid), shiftId: f.outgoing, technicianId: uid, role: "primary", joinedAt: historical, leftAt: null,
    });
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: f.outgoing, scheduledStart, scheduledEnd, status: "active" }],
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

// Technician-authorized v2 begin (shared begin service) moves the fixture to
// handover_pending before any reservation is attempted.
async function makeHandoverFixture(options = {}) {
  const f = await makeActiveShiftFixture(options);
  await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  return f;
}

async function addEligiblePair(prefixOwner, pairId, uids) {
  const batch = db.batch();
  for (const uid of uids) {
    batch.set(ref("users", uid), { uid, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
    batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId, createdAt: historical, updatedAt: historical });
    batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [], updatedAt: historical });
  }
  batch.set(ref("technician_pairs", pairId), {
    id: pairId, technicianIds: uids, status: "active", createdBy: prefixOwner,
    createdAt: historical, updatedAt: historical, deactivatedAt: null, deactivatedBy: null,
  });
  await batch.commit();
}

const initInput = (f, overrides = {}) => ({
  outgoingShiftId: f.outgoing,
  actorUid: f.out[0],
  incomingPermanentPairId: f.inPair,
  shiftType: "morning",
  scheduledStart,
  scheduledEnd,
  idempotencyKey: `key-${randomUUID()}`,
  ...overrides,
});

async function v2Binding(f) {
  const state = await readEqualHandoverReservation(f.outgoing);
  return {
    aggregate: state.aggregate,
    expectedRevision: state.aggregate.revision,
    expectedSnapshotHash: state.snapshotHash,
    guard: state.guard,
  };
}

async function getGuard(outgoingShiftId) {
  const snap = await ref("handover_reservation_guards", createHandoverReservationGuardDocumentId(outgoingShiftId)).get();
  return snap.exists ? snap.data() : null;
}

async function getV2Document(f) {
  const snap = await ref("equal_handovers_v2", createEqualHandoverDocumentId(f.outgoing)).get();
  return snap.exists ? snap.data() : null;
}

async function collectionState(name) {
  const snap = await db.collection(name).get();
  return snap.docs
    .map((doc) => [doc.id, doc.data()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function operationalState() {
  return {
    equalHandoversV2: await collectionState("equal_handovers_v2"),
    handovers: await collectionState("handovers"),
    guards: await collectionState("handover_reservation_guards"),
    guardHistory: await collectionState("handover_reservation_guard_history"),
    shifts: await collectionState("shifts"),
    technicianSchedules: await collectionState("technician_schedules"),
    shiftMembers: await collectionState("shift_members"),
    operationalShiftControl: await collectionState("operational_shift_control"),
    auditLogs: await collectionState("audit_logs"),
    attendanceV2: await collectionState("attendance_evidence_v2"),
    attendanceOperationsV2: await collectionState("attendance_evidence_operations_v2"),
    handoverTransfers: await collectionState("handover_task_transfers"),
  };
}

function expectsStatus(errorClass, status, messagePattern) {
  return (error) => {
    assert.ok(error instanceof errorClass, `${error.constructor.name}: ${error.message}`);
    assert.equal(error.status, status);
    if (messagePattern) assert.match(error.message, messagePattern);
    return true;
  };
}

const as409 = (pattern) => expectsStatus(AssignmentOperationError, 409, pattern);
const as403 = expectsStatus(AssignmentOperationError, 403);

// ---------------------------------------------------------------------------
// §3/§4 — technician-authorized initiation
// ---------------------------------------------------------------------------

test("1. Either outgoing technician begins active→handover_pending; shift, control, schedules and audit move atomically", async () => {
  await clearDb();
  const fa = await makeActiveShiftFixture();
  await beginShiftHandover({ shiftId: fa.outgoing, actorUid: fa.out[0], authority: "equal-technician" });
  const shiftA = (await ref("shifts", fa.outgoing).get()).data();
  assert.equal(shiftA.status, "handover_pending");
  assert.equal(shiftA.handoverStartedBy, fa.out[0]);
  const controlA = (await ref("operational_shift_control", "global").get()).data();
  assert.equal(controlA.shiftStatus, "handover_pending");

  await clearDb();
  const fb = await makeActiveShiftFixture();
  await beginShiftHandover({ shiftId: fb.outgoing, actorUid: fb.out[1], authority: "equal-technician" });
  const shiftB = (await ref("shifts", fb.outgoing).get()).data();
  assert.equal(shiftB.status, "handover_pending");
  assert.equal(shiftB.handoverStartedBy, fb.out[1]);
  const beginAudits = (await collectionState("audit_logs")).filter(([, a]) => a.action === "SHIFT_HANDOVER_STARTED");
  assert.equal(beginAudits.length, 1);
  assert.equal(beginAudits[0][1].actorUid, fb.out[1]);
  for (const uid of fb.out) {
    const schedule = (await ref("technician_schedules", uid).get()).data();
    assert.equal(schedule.entries.find((e) => e.shiftId === fb.outgoing).status, "handover_pending");
  }
});

test("2. Incoming technician, unrelated technician, admin and supervisor actors are all rejected before any reservation", async () => {
  await clearDb();
  const f = await makeHandoverFixture({ managerRole: "admin" });
  const before = await operationalState();
  for (const actorUid of [f.incoming[0], f.unrelated, f.manager]) {
    await assert.rejects(
      () => initializeEqualHandoverReservation(initInput(f, { actorUid })),
      (error) => {
        assert.ok(error instanceof AssignmentOperationError, `${error.constructor.name}: ${error.message}`);
        assert.equal(error.status, 403);
        return true;
      },
    );
  }
  const stateAfter = await operationalState();
  assert.equal(stateAfter.equalHandoversV2.length, 0);
  assert.equal(stateAfter.guards.length, 0);
  assert.deepEqual(stateAfter, before, "Rejected actors must not mutate any operational state");
});

test("3. Actor with mustChangePassword, statusOperation, inactive status or missing profile is rejected", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const before = await operationalState();
  const cases = [
    { mustChangePassword: true },
    { statusOperation: { kind: "role_change" } },
    { status: "inactive" },
  ];
  for (const patch of cases) {
    await ref("users", f.out[0]).update(patch);
    await assert.rejects(() => initializeEqualHandoverReservation(initInput(f)), as403);
    await ref("users", f.out[0]).update({ mustChangePassword: false, statusOperation: null, status: "active" });
  }
  await ref("users", f.out[0]).delete();
  await assert.rejects(() => initializeEqualHandoverReservation(initInput(f)), as403);
  assert.deepEqual(await operationalState(), before);
});

test("4. Reservation before handover initiation fails closed: an active shift cannot receive a v2 reservation", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  const before = await operationalState();
  await assert.rejects(
    () => initializeEqualHandoverReservation(initInput(f)),
    as409(/has not started a valid handover|handover/i),
  );
  assert.deepEqual(await operationalState(), before);
});

// ---------------------------------------------------------------------------
// §5/§6/§8 — reservation creation
// ---------------------------------------------------------------------------

test("5. Reservation creates the complete validated aggregate at the stable v2 document id and acquires the shared guard", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const result = await initializeEqualHandoverReservation(initInput(f));
  assert.equal(result.replayed, false);

  const stored = await getV2Document(f);
  assert.ok(stored);
  const aggregate = assertEqualHandoverAggregate(stored);
  assert.deepEqual(Object.keys(stored).sort(), [
    "absences", "confirmations", "createdAt", "historicalConfirmations", "identity", "lifecycleStatus",
    "reportBinding", "reservation", "retiredSuccessorSlotTokens", "revision", "schema", "updatedAt",
  ]);
  assert.equal(aggregate.schema, "equal-handover-v2");
  assert.equal(aggregate.revision, 1);
  assert.equal(aggregate.lifecycleStatus, "collecting_confirmations");
  assert.equal(aggregate.reportBinding, null);
  assert.equal(aggregate.reservation.handoverId, createEqualHandoverId(aggregate.identity));
  assert.equal(aggregate.reservation.handoverId, result.aggregate.reservation.handoverId);
  assert.equal(createEqualHandoverDocumentId(f.outgoing), `handover_v2_${f.outgoing}`);
  assert.notEqual(createEqualHandoverDocumentId(f.outgoing), aggregate.reservation.handoverId);

  const guard = await getGuard(f.outgoing);
  assert.equal(guard.protocolOwner, "v2");
  assert.equal(guard.ownerLifecycleState, "active");
  assert.equal(guard.guardRevision, 1);
  assert.equal(guard.fencingEpoch, 1);
  assert.equal(guard.ownerHandoverDocumentId, createEqualHandoverDocumentId(f.outgoing));
  assert.equal(guard.reservationId, aggregate.reservation.handoverId);
  assert.equal(guard.reservedIncomingShiftId, aggregate.reservation.reservedIncomingShiftId);
  assert.equal(guard.outgoingShiftId, f.outgoing);

  // Both incoming technicians are reserved on the incoming shift identity.
  for (const uid of f.incoming) {
    const schedule = (await ref("technician_schedules", uid).get()).data();
    const entry = schedule.entries.find((e) => e.shiftId === aggregate.reservation.reservedIncomingShiftId);
    assert.ok(entry, "Incoming technician must hold the reserved schedule entry");
    assert.equal(entry.status, "scheduled");
    assert.equal(entry.scheduledStart, scheduledStart);
    assert.equal(entry.scheduledEnd, scheduledEnd);
  }

  const audits = (await collectionState("audit_logs")).filter(([, a]) => a.action === "EQUAL_SHIFT_HANDOVER_RESERVATION_CREATED_V2");
  assert.equal(audits.length, 1);
  assert.equal(audits[0][1].reservation.handoverId, aggregate.reservation.handoverId);

  // §5 negative: reservation created no incoming Shift and no attendance evidence.
  assert.equal((await ref("shifts", aggregate.reservation.reservedIncomingShiftId).get()).exists, false);
  assert.equal((await operationalState()).attendanceV2.length, 0);
  assert.equal((await operationalState()).attendanceOperationsV2.length, 0);
});

test("6. Incoming pair with an ineligible technician is rejected with zero reservation writes", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await ref("users", f.incoming[1]).update({ status: "inactive" });
  const before = await operationalState();
  await assert.rejects(() => initializeEqualHandoverReservation(initInput(f)), (error) => {
    assert.ok(error instanceof AssignmentOperationError);
    return true;
  });
  assert.deepEqual(await operationalState(), before);
});

test("7. Malformed requests are rejected with 400: non-canonical times, missing fields, bad idempotency keys", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const before = await operationalState();
  const bad = [
    // A well-formed identifier that references no permanent pair is a
    // missing resource, not a malformed body.
    { patch: { incomingPermanentPairId: "x" }, status: 404 },
    { patch: { shiftType: "afternoon" }, status: 400 },
    { patch: { scheduledStart: "2030-01-01 06:00" }, status: 400 },
    { patch: { idempotencyKey: "short" }, status: 400 },
    // A non-existent actor is never authorized; body-supplied identities are
    // rejected by the authoritative profile read, not trusted.
    { patch: { actorUid: "caller-controlled" }, status: 403 },
  ];
  for (const { patch, status } of bad) {
    await assert.rejects(
      () => initializeEqualHandoverReservation(initInput(f, patch)),
      expectsStatus(AssignmentOperationError, status),
    );
  }
  assert.deepEqual(await operationalState(), before);
});

// ---------------------------------------------------------------------------
// §11 — idempotency
// ---------------------------------------------------------------------------

test("8. Identical retry replays the authoritative reservation without any state change", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const input = initInput(f);
  const first = await initializeEqualHandoverReservation(input);
  await sleep();
  const before = await operationalState();

  const retry = await initializeEqualHandoverReservation(input);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.aggregate, first.aggregate);
  assert.equal(retry.snapshotHash, first.snapshotHash);
  assert.equal(retry.guard.guardRevision, first.guard.guardRevision);
  assert.equal(retry.guard.fencingEpoch, first.guard.fencingEpoch);

  const after = await operationalState();
  assert.deepEqual(after, before, "An identical retry must not write anything");
  assert.equal(after.equalHandoversV2.length, 1);
  assert.equal(
    after.auditLogs.filter(([, a]) => a.action === "EQUAL_SHIFT_HANDOVER_RESERVATION_CREATED_V2").length,
    1,
    "No second successful audit event",
  );
});

test("9. Equal authority is not a bypass: the counterpart may replay the identical reservation, but a conflicting retry fails", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const input = initInput(f);
  const first = await initializeEqualHandoverReservation(input);
  await sleep();

  // Same deterministic reservation initiated by the counterpart technician:
  // legitimate equal authority, so the stored reservation is returned as-is.
  const counterpart = await initializeEqualHandoverReservation({ ...input, actorUid: f.out[1] });
  assert.equal(counterpart.replayed, true);
  assert.deepEqual(counterpart.aggregate, first.aggregate);

  // Same idempotency key but a different reservation body is a conflict.
  await addEligiblePair(f.outgoing, `${f.outgoing}-thirdpair`, [`${f.outgoing}-3a`, `${f.outgoing}-3b`]);
  const before = await operationalState();
  await assert.rejects(
    () => initializeEqualHandoverReservation({ ...input, incomingPermanentPairId: `${f.outgoing}-thirdpair`, actorUid: f.out[0] }),
    as409(/already exists/),
  );
  // A second legitimate reservation attempt with a fresh key while one is active.
  await assert.rejects(
    () => initializeEqualHandoverReservation({ ...input, idempotencyKey: `key-${randomUUID()}`, actorUid: f.out[0] }),
    as409(/already exists/),
  );
  assert.deepEqual(await operationalState(), before);
});

// ---------------------------------------------------------------------------
// §9 — replacement
// ---------------------------------------------------------------------------

test("10. Replacement retires the old reservation immutably, advances guard revision and epoch, and rebinds schedules", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await initializeEqualHandoverReservation(initInput(f));
  await sleep();
  const previous = await v2Binding(f);
  const oldIncomingShiftId = previous.aggregate.reservation.reservedIncomingShiftId;

  await addEligiblePair(f.outgoing, `${f.outgoing}-newpair`, [`${f.outgoing}-newa`, `${f.outgoing}-newb`]);
  await sleep();
  const replacement = await replaceEqualHandoverReservationForTechnicians({
    outgoingShiftId: f.outgoing, actorUid: f.out[1],
    incomingPermanentPairId: `${f.outgoing}-newpair`, shiftType: "morning", scheduledStart, scheduledEnd,
    expectedRevision: previous.expectedRevision, expectedSnapshotHash: previous.expectedSnapshotHash,
  });

  const stored = await getV2Document(f);
  assert.equal(stored.revision, 2);
  assert.equal(stored.reservation.handoverId, createEqualHandoverId(stored.identity));
  assert.notEqual(stored.reservation.handoverId, previous.aggregate.reservation.handoverId);
  assert.equal(stored.identity.outgoingSlotToken, previous.aggregate.identity.outgoingSlotToken);
  assert.ok(stored.retiredSuccessorSlotTokens.includes(previous.aggregate.identity.successorSlotToken));
  assert.notEqual(stored.identity.successorSlotToken, previous.aggregate.identity.successorSlotToken);

  const guard = await getGuard(f.outgoing);
  assert.equal(guard.guardRevision, previous.guard.guardRevision + 1);
  assert.equal(guard.fencingEpoch, previous.guard.fencingEpoch + 1);
  assert.ok(guard.retiredSuccessorSlotTokens.includes(previous.guard.successorSlotToken));
  assert.equal(guard.reservationId, stored.reservation.handoverId);

  // Old incoming schedules released, new pair reserved.
  for (const uid of f.incoming) {
    const schedule = (await ref("technician_schedules", uid).get()).data();
    assert.equal(schedule.entries.some((e) => e.shiftId === oldIncomingShiftId), false);
  }
  for (const uid of [`${f.outgoing}-newa`, `${f.outgoing}-newb`]) {
    const schedule = (await ref("technician_schedules", uid).get()).data();
    assert.ok(schedule.entries.some((e) => e.shiftId === stored.reservation.reservedIncomingShiftId));
  }

  // Full superseded evidence preserved in the immutable audit record. The
  // superseded copy differs from the live previous aggregate only by the
  // terminal lifecycle status and the supersession timestamp.
  const audits = (await collectionState("audit_logs")).filter(([, a]) => a.action === "EQUAL_SHIFT_HANDOVER_RESERVATION_REPLACED_V2");
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0][1].supersededAggregate, {
    ...previous.aggregate,
    lifecycleStatus: "superseded",
    updatedAt: audits[0][1].recordedAt,
  });
  assert.equal(audits[0][1].previousSnapshotHash, previous.expectedSnapshotHash);
  assert.equal(audits[0][1].actorUid, f.out[1]);
  assert.equal(replacement.aggregate.revision, 2);
});

test("11. Stale revision, snapshot hash or guard fencing evidence is rejected without writes", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await initializeEqualHandoverReservation(initInput(f));
  const binding = await v2Binding(f);
  await addEligiblePair(f.outgoing, `${f.outgoing}-newpair`, [`${f.outgoing}-newa`, `${f.outgoing}-newb`]);
  await sleep();
  const before = await operationalState();

  await assert.rejects(
    () => replaceEqualHandoverReservationForTechnicians({
      outgoingShiftId: f.outgoing, actorUid: f.out[0],
      incomingPermanentPairId: `${f.outgoing}-newpair`, shiftType: "morning", scheduledStart, scheduledEnd,
      expectedRevision: binding.expectedRevision + 5, expectedSnapshotHash: binding.expectedSnapshotHash,
    }),
    as409(/Stale/),
  );
  await assert.rejects(
    () => replaceEqualHandoverReservationForTechnicians({
      outgoingShiftId: f.outgoing, actorUid: f.out[0],
      incomingPermanentPairId: `${f.outgoing}-newpair`, shiftType: "morning", scheduledStart, scheduledEnd,
      expectedRevision: binding.expectedRevision, expectedSnapshotHash: "f".repeat(64),
    }),
    as409(/Stale/),
  );
  assert.deepEqual(await operationalState(), before);
});

test("12. Replacement fails closed when unexpected report or confirmation evidence is present", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await initializeEqualHandoverReservation(initInput(f));
  const documentId = createEqualHandoverDocumentId(f.outgoing);

  const corrupt = async (patch) => {
    const current = (await ref("equal_handovers_v2", documentId).get()).data();
    await ref("equal_handovers_v2", documentId).set({ ...current, ...patch });
    await sleep();
  };

  await addEligiblePair(f.outgoing, `${f.outgoing}-newpair`, [`${f.outgoing}-newa`, `${f.outgoing}-newb`]);

  // §3 migration guarantee: a relabeled legacy v1 binding can no longer even
  // be read back as a valid v2 aggregate.
  await corrupt({ reportBinding: { schema: "handover-report-v1", id: `report_${randomUUID()}`, digest: "a".repeat(64) } });
  await assert.rejects(() => readEqualHandoverReservation(f.outgoing), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /report binding/i);
    return true;
  });

  // A genuine v2 binding is readable but keeps replacement fail-closed.
  await corrupt({ reportBinding: null });
  const storedFingerprint = (await ref("equal_handovers_v2", documentId).get()).data().reservation.handoverId;
  await corrupt({
    reportBinding: {
      schema: "handover-report-v2",
      id: "report_v2_00000000-0000-4000-8000-000000000001",
      digest: "a".repeat(64),
      evidenceSnapshotHash: "b".repeat(64),
      workSnapshotVersion: "c".repeat(64),
      preparationId: `preparation_${storedFingerprint}`,
      preparationRevision: 1,
      reservationId: storedFingerprint,
      aggregateRevision: 1,
      fencingEpoch: 1,
      frozenBy: f.out[0],
      frozenAt: scheduledStart,
    },
  });
  const binding = await v2Binding(f);
  const before = await operationalState();
  await assert.rejects(
    () => replaceEqualHandoverReservationForTechnicians({
      outgoingShiftId: f.outgoing, actorUid: f.out[0],
      incomingPermanentPairId: `${f.outgoing}-newpair`, shiftType: "morning", scheduledStart, scheduledEnd,
      expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.expectedSnapshotHash,
    }),
    as409(/administrator review/),
  );
  await corrupt({ reportBinding: null });

  // Malformed aggregate (unsupported fields) is rejected by the strict domain
  // read before any mutation logic runs.
  const current = (await ref("equal_handovers_v2", documentId).get()).data();
  await ref("equal_handovers_v2", documentId).set({ ...current, unexpectedField: true });
  await assert.rejects(
    () => readEqualHandoverReservation(f.outgoing),
    (error) => error.constructor.name === "EqualHandoverDomainError",
  );
  await ref("equal_handovers_v2", documentId).set(current);
  assert.equal((await operationalState()).guards.length, before.guards.length);
});

// ---------------------------------------------------------------------------
// §10 — cancellation
// ---------------------------------------------------------------------------

test("13. Cancellation closes the aggregate, cancels the shared guard with terminal evidence, releases incoming schedules and keeps the shift", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await initializeEqualHandoverReservation(initInput(f));
  await sleep();
  const binding = await v2Binding(f);
  const incomingShiftId = binding.aggregate.reservation.reservedIncomingShiftId;
  // Pre-existing attendance evidence must survive cancellation untouched.
  const batch = db.batch();
  batch.set(ref("handover_task_transfers", `${incomingShiftId}_unrelated`), { marker: "completed-handover-receipt" });
  await batch.commit();

  await sleep();
  const result = await cancelEqualHandoverReservationForTechnicians({
    outgoingShiftId: f.outgoing, actorUid: f.out[1],
    expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.expectedSnapshotHash,
    reason: "Incoming pair unavailable for this cycle",
  });

  const stored = await getV2Document(f);
  assert.equal(stored.lifecycleStatus, "cancelled");
  // Cancellation closes at the same aggregate revision (the guard advances);
  // this matches the authoritative v1 cancel contract.
  assert.equal(stored.revision, binding.expectedRevision);
  assert.equal(result.aggregate.lifecycleStatus, "cancelled");

  const guard = await getGuard(f.outgoing);
  assert.equal(guard.ownerLifecycleState, "cancelled");
  assert.equal(guard.protocolOwner, "v2");
  assert.equal(guard.guardRevision, binding.guard.guardRevision + 1);
  assert.equal(guard.fencingEpoch, binding.guard.fencingEpoch, "Cancellation must not advance the epoch");

  const audits = (await collectionState("audit_logs")).filter(([, a]) => a.action === "EQUAL_SHIFT_HANDOVER_RESERVATION_CANCELLED_V2");
  assert.equal(audits.length, 1);
  assert.equal(audits[0][1].cancellationReason, "Incoming pair unavailable for this cycle");
  assert.equal(audits[0][1].actorUid, f.out[1]);
  assert.deepEqual(audits[0][1].cancelledAggregate, stored);
  assert.equal(guard.terminalEvidenceRef, audits[0][0]);

  // Incoming schedules released; outgoing shift untouched.
  for (const uid of f.incoming) {
    const schedule = (await ref("technician_schedules", uid).get()).data();
    assert.equal(schedule.entries.some((e) => e.shiftId === incomingShiftId), false);
  }
  const shift = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(shift.status, "handover_pending");
  assert.equal((await ref("shifts", incomingShiftId).get()).exists, false);
  assert.deepEqual((await collectionState("handover_task_transfers")).map(([id]) => id), [`${incomingShiftId}_unrelated`]);
});

test("14. Cancel and replace after terminal states or with stale bindings are rejected; v1 writers cannot touch a v2 reservation", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await initializeEqualHandoverReservation(initInput(f));
  await sleep();
  const binding = await v2Binding(f);
  await cancelEqualHandoverReservationForTechnicians({
    outgoingShiftId: f.outgoing, actorUid: f.out[0],
    expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.expectedSnapshotHash,
    reason: "Cancelled once",
  });
  await sleep();
  const before = await operationalState();

  await assert.rejects(
    () => cancelEqualHandoverReservationForTechnicians({
      outgoingShiftId: f.outgoing, actorUid: f.out[0],
      expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.expectedSnapshotHash,
      reason: "Cancelled twice",
    }),
    as409(/Stale or closed/),
  );
  await assert.rejects(
    () => replaceEqualHandoverReservationForTechnicians({
      outgoingShiftId: f.outgoing, actorUid: f.out[0],
      incomingPermanentPairId: f.inPair, shiftType: "morning", scheduledStart, scheduledEnd,
      expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.expectedSnapshotHash,
    }),
    as409(/Stale or closed/),
  );

  // The real production v1 writers must not mutate a v2-owned reservation.
  await assert.rejects(
    () => v1Cancel({
      outgoingShiftId: f.outgoing, actorUid: f.manager, expectedRole: "supervisor",
      expectedRevision: 1, expectedSnapshotHash: "0".repeat(64),
    }),
    (error) => {
      assert.ok(error instanceof AssignmentOperationError || error.constructor.name === "HandoverDomainError");
      return true;
    },
  );
  assert.deepEqual(await operationalState(), before);
});

// ---------------------------------------------------------------------------
// §6/§7 — shared guard properties and cancelled-v1 transition
// ---------------------------------------------------------------------------

test("15. Concurrent v2 acquisitions race on the shared guard: exactly one reservation survives", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const a = initializeEqualHandoverReservation(initInput(f, { actorUid: f.out[0] }));
  const b = initializeEqualHandoverReservation(initInput(f, { actorUid: f.out[1] }));
  const settled = await Promise.allSettled([a, b]);
  const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
  assert.equal(fulfilled.length, 1, settled.map((entry) => entry.reason?.message ?? "fulfilled").join(" | "));
  const rejected = settled.find((entry) => entry.status === "rejected");
  assert.equal(rejected.reason.status, 409);

  const docs = await collectionState("equal_handovers_v2");
  assert.equal(docs.length, 1);
  const guard = await getGuard(f.outgoing);
  assert.equal(guard.reservationId, docs[0][1].reservation.handoverId);
  const createAudits = (await collectionState("audit_logs")).filter(([, a2]) => a2.action === "EQUAL_SHIFT_HANDOVER_RESERVATION_CREATED_V2");
  assert.equal(createAudits.length, 1);
});

test("16. Cross-version race invokes the real v1 and v2 writers: one owner, no dual reservations", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const v1 = () => v1InitializeAll(f);
  const v2 = () => initializeEqualHandoverReservation(initInput(f));
  const settled = await Promise.allSettled([v1(), v2()]);
  const winners = settled.filter((entry) => entry.status === "fulfilled");
  assert.equal(winners.length, 1, settled.map((entry) => entry.reason?.message ?? "fulfilled").join(" | "));
  assert.equal(settled.find((entry) => entry.status === "rejected").reason.status, 409);

  const guard = await getGuard(f.outgoing);
  const v1Doc = (await ref("handovers", createHandoverDocumentId(f.outgoing)).get()).exists;
  const v2Doc = (await ref("equal_handovers_v2", createEqualHandoverDocumentId(f.outgoing)).get()).exists;
  assert.notEqual(v1Doc, v2Doc, "Exactly one protocol may hold a reservation");
  if (guard.protocolOwner === "v1") {
    assert.equal(v1Doc, true);
    assert.equal(v2Doc, false);
    assert.equal(guard.ownerHandoverDocumentId, createHandoverDocumentId(f.outgoing));
  } else {
    assert.equal(guard.protocolOwner, "v2");
    assert.equal(v2Doc, true);
    assert.equal(v1Doc, false);
  }
  assert.equal(guard.ownerLifecycleState, "active");
});

async function v1InitializeAll(f) {
  return v1Initialize({
    outgoingShiftId: f.outgoing, actorUid: f.manager, expectedRole: "supervisor",
    incomingPermanentPairId: f.inPair, shiftType: "morning", scheduledStart, scheduledEnd,
  });
}

test("17. The actual production v1 writer rejects a v2-owned guard and never overwrites it", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await initializeEqualHandoverReservation(initInput(f));
  const before = await operationalState();

  await assert.rejects(
    () => v1InitializeAll(f),
    as409(/owned by protocol v2/),
  );
  const guard = await getGuard(f.outgoing);
  assert.equal(guard.protocolOwner, "v2");
  assert.deepEqual(await operationalState(), before);
});

test("18. A cancelled v2 guard is terminal for every v1 production writer", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await initializeEqualHandoverReservation(initInput(f));
  const binding = await v2Binding(f);
  await sleep();
  await cancelEqualHandoverReservationForTechnicians({
    outgoingShiftId: f.outgoing, actorUid: f.out[0],
    expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.expectedSnapshotHash,
    reason: "Cancelled for v1 fencing check",
  });
  await sleep();

  await assert.rejects(() => v1InitializeAll(f), (error) => {
    assert.ok(error instanceof AssignmentOperationError || error.constructor.name === "HandoverDomainError");
    return true;
  });
  const guard = await getGuard(f.outgoing);
  assert.equal(guard.ownerLifecycleState, "cancelled");
  assert.equal(guard.protocolOwner, "v2");
});

test("19. Cancelled v1 guard → v2 acquisition archives exact terminal evidence and advances the fencing epoch", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await v1InitializeAll(f);
  const v1Handover = assertHandoverAggregate((await ref("handovers", createHandoverDocumentId(f.outgoing)).get()).data());
  await v1Cancel({
    outgoingShiftId: f.outgoing, actorUid: f.manager, expectedRole: "supervisor",
    expectedRevision: v1Handover.revision, expectedSnapshotHash: createHandoverSnapshot(v1Handover).snapshotHash,
  });
  const cancelledGuard = await getGuard(f.outgoing);
  assert.equal(cancelledGuard.ownerLifecycleState, "cancelled");
  assert.equal(cancelledGuard.protocolOwner, "v1");
  const before = await operationalState();
  assert.equal(before.handovers.length, 1, "The v1 aggregate evidence exists before the transition");
  await sleep();

  const result = await initializeEqualHandoverReservation(initInput(f));
  assert.equal(result.replayed, false);

  const successor = await getGuard(f.outgoing);
  assert.equal(successor.protocolOwner, "v2");
  assert.equal(successor.ownerLifecycleState, "active");
  assert.equal(successor.fencingEpoch, cancelledGuard.fencingEpoch + 1);
  assert.equal(successor.guardRevision, cancelledGuard.guardRevision + 2);
  assert.ok(successor.retiredSuccessorSlotTokens.includes(cancelledGuard.successorSlotToken));
  assert.notEqual(successor.successorSlotToken, cancelledGuard.successorSlotToken);
  assert.equal(successor.reservationId, result.aggregate.reservation.handoverId);
  assert.equal(successor.reservedIncomingShiftId, result.aggregate.reservation.reservedIncomingShiftId);

  // Exact immutable copy of the cancelled guard preserved in history.
  const expectedArchiveId = createReservationGuardArchiveDocumentId(cancelledGuard);
  assert.equal(successor.terminalEvidenceRef, expectedArchiveId);
  const history = await collectionState("handover_reservation_guard_history");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0][1], cancelledGuard);
  assert.equal(history[0][0], expectedArchiveId);

  // v1 aggregate + cancellation evidence fully preserved and append-only.
  const after = await operationalState();
  assert.deepEqual(after.handovers, before.handovers);
  const auditIds = after.auditLogs.map(([id]) => id);
  for (const [id] of before.auditLogs) assert.ok(auditIds.includes(id), "Prior audit evidence must never be erased");
  assert.equal(after.guardHistory.length, 1);

  // The v1 guard document and terminal evidence are gone from v1 writers only
  // in the sense that the live document is now v2-owned and epoch-advanced.
  const v2State = await readEqualHandoverReservation(f.outgoing);
  assert.equal(v2State.guard.fencingEpoch, cancelledGuard.fencingEpoch + 1);
});

test("20. A stale v1 writer holding the pre-cancellation guard evidence cannot replace the v2 successor", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const v2result = await initializeEqualHandoverReservation(initInput(f));
  await sleep();
  const stale = {
    outgoingShiftId: f.outgoing, protocolOwner: "v1",
    expectedGuardRevision: v2result.guard.guardRevision,
    expectedFencingEpoch: v2result.guard.fencingEpoch,
    outgoingSlotToken: v2result.aggregate.identity.outgoingSlotToken,
    outgoingGeneration: v2result.aggregate.identity.outgoingGeneration,
    successorSlotToken: randomUUID(),
    successorGeneration: v2result.aggregate.identity.successorGeneration,
    reservationId: `handover_${randomUUID().replace(/-/g, "")}`,
    reservedIncomingShiftId: "ghost-shift",
    recordedAt: new Date().toISOString(), actorUid: f.manager,
  };
  await assert.rejects(
    () => db.runTransaction(async (transaction) => {
      const state = await readReservationGuardState(transaction, f.outgoing);
      const { replaceReservationGuard } = await import("../src/lib/operations/handover-reservation-guard.ts");
      return replaceReservationGuard(transaction, stale, state);
    }),
    (error) => {
      assert.ok(error instanceof HandoverReservationGuardError, `${error.constructor.name}: ${error.message}`);
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.deepEqual(await getGuard(f.outgoing), v2result.guard);
});

test("21. A completed guard can never be archived, reopened or re-acquired by v2", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const outgoing = f.shift.operationalSlotToken;
  const initial = createInitialReservationGuard({
    outgoingShiftId: f.outgoing, protocolOwner: "v1",
    ownerHandoverDocumentId: createHandoverDocumentId(f.outgoing),
    outgoingSlotToken: outgoing, outgoingGeneration: f.controlGeneration ?? 1,
    successorSlotToken: randomUUID(), successorGeneration: 2,
    reservationId: `handover_v2_${"a".repeat(64)}`.slice(0, 200),
    reservedIncomingShiftId: "reserved-incoming-shift",
    reservedAt: historical, reservedBy: f.manager,
  });
  const completed = transitionGuardForCompletion(initial, {
    outgoingShiftId: f.outgoing, protocolOwner: "v1",
    receiptId: `receipt_${f.outgoing}`, outgoingSlotToken: outgoing, outgoingGeneration: 1,
    successorSlotToken: initial.successorSlotToken, successorGeneration: 2,
    recordedAt: historical, actorUid: f.manager,
  });
  await ref("handover_reservation_guards", initial.id).set(completed);

  const attempted = {
    outgoingShiftId: f.outgoing, protocolOwner: "v2",
    ownerHandoverDocumentId: createEqualHandoverDocumentId(f.outgoing),
    outgoingSlotToken: outgoing, outgoingGeneration: 1,
    successorSlotToken: randomUUID(), successorGeneration: 2,
    reservationId: `handover_v2_${"b".repeat(64)}`.slice(0, 200),
    reservedIncomingShiftId: "another-reserved-shift",
    reservedAt: new Date().toISOString(), reservedBy: f.out[0],
  };
  await assert.rejects(
    () => db.runTransaction(async (transaction) => {
      const state = await readReservationGuardState(transaction, f.outgoing);
      return resolveOrAcquireReservationGuard(transaction, attempted, state);
    }),
    (error) => {
      assert.ok(error instanceof HandoverReservationGuardError, `${error.constructor.name}: ${error.message}`);
      assert.equal(error.status, 409);
      assert.match(error.message, /terminal state/);
      return true;
    },
  );
  assert.deepEqual(await getGuard(f.outgoing), assertHandoverReservationGuard(completed));
  assert.equal((await collectionState("handover_reservation_guard_history")).length, 0);
});

test("22. A guardless cancelled legacy v1 aggregate fails closed for administrator review instead of silent conversion", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await v1InitializeAll(f);
  const v1Handover = assertHandoverAggregate((await ref("handovers", createHandoverDocumentId(f.outgoing)).get()).data());
  await v1Cancel({
    outgoingShiftId: f.outgoing, actorUid: f.manager, expectedRole: "supervisor",
    expectedRevision: v1Handover.revision, expectedSnapshotHash: createHandoverSnapshot(v1Handover).snapshotHash,
  });
  // Corrupt the state production would never create: the guard evidence is
  // gone while a cancelled v1 aggregate remains.
  await ref("handover_reservation_guards", createHandoverReservationGuardDocumentId(f.outgoing)).delete();
  const before = await operationalState();

  await assert.rejects(
    () => initializeEqualHandoverReservation(initInput(f)),
    as409(/administrator review/),
  );
  assert.deepEqual(await operationalState(), before);
});

test("23. A guardless active or completed legacy v1 aggregate also blocks v2 acquisition", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await v1InitializeAll(f);
  await ref("handover_reservation_guards", createHandoverReservationGuardDocumentId(f.outgoing)).delete();
  const before = await operationalState();
  await assert.rejects(
    () => initializeEqualHandoverReservation(initInput(f)),
    as409(/legacy v1 handover reservation exists/),
  );
  assert.deepEqual(await operationalState(), before);
});

// ---------------------------------------------------------------------------
// §12 — route gate and response hygiene (synthetic, no fabricated sessions)
// ---------------------------------------------------------------------------

// The v2 route modules are executed from their real source with a CommonJS
// shim: `server-only`, `next/server` and every `@/` production dependency
// resolve to the same modules the service tests use. Only the session
// boundary is stubbed, because `@/lib/auth/session` transitively imports
// `next/navigation`, which cannot load outside a Next.js server. No real
// session is fabricated: `routeSessionUser` stays null except for the one
// case that must reach the origin check past the session gate.
let routeSessionUser = null;

function jsonResponse(body, options = {}) {
  const headers = new Map(Object.entries(options.headers ?? {}));
  return {
    status: options.status ?? 200,
    body,
    headers: { get: (name) => headers.get(name) ?? null },
    json: async () => body,
  };
}

async function loadRouteModule(file) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  // `require` in CommonJS is synchronous, so every real `@/` dependency is
  // resolved to its ESM namespace up front (file, then directory index). Only
  // the session boundary stays stubbed.
  const specifiers = [...new Set(source.match(/"@\/[^"]+"/g)?.map((literal) => literal.slice(1, -1)) ?? [])];
  const preloadedDeps = new Map();
  for (const name of specifiers) {
    if (name === "@/lib/auth/session") continue;
    const base = `../src/${name.slice(2)}`;
    const candidates = [`${base}.ts`, `${base}/index.ts`];
    const hit = candidates.find((candidate) => existsSync(new URL(candidate, import.meta.url)));
    if (!hit) throw new Error(`Unresolvable v2 route dependency: ${name}`);
    preloadedDeps.set(name, await import(new URL(hit, import.meta.url).href));
  }
  const moduleExports = {};
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: moduleExports,
      process,
      console: { error(...args) { void args; } },
      require(name) {
        if (name === "server-only") return {};
        if (name === "next/server") return { NextRequest, NextResponse: { json: jsonResponse } };
        if (name === "@/lib/auth/session") return { getCurrentUser: async () => routeSessionUser };
        if (preloadedDeps.has(name)) return preloadedDeps.get(name);
        throw new Error(`Unexpected v2 route dependency: ${name}`);
      },
    },
  );
  return moduleExports;
}

const beginRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/begin/route.ts",
);
const reservationRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/reservation/route.ts",
);

test("24. With HANDOVER_V2_DEV absent or false, v2 mutation routes return 404 and execute no workflow", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  const before = await operationalState();
  const url = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2/reservation`;
  for (const flag of [undefined, "false"]) {
    if (flag === undefined) delete process.env.HANDOVER_V2_DEV;
    else process.env.HANDOVER_V2_DEV = flag;
    const request = new NextRequest(url, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" });
    const response = await reservationRoute.POST(request, { params: Promise.resolve({ shiftId: f.outgoing }) });
    assert.equal(response.status, 404);
    const beginRequest = new NextRequest(`http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2/begin`,
      { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" });
    const beginResponse = await beginRoute.POST(beginRequest, { params: Promise.resolve({ shiftId: f.outgoing }) });
    assert.equal(beginResponse.status, 404);
  }
  assert.deepEqual(await operationalState(), before, "A disabled gate must not execute any v2 workflow");
  const payload = await responseJson(await reservationRoute.GET(
    new NextRequest(url), { params: Promise.resolve({ shiftId: f.outgoing }) }));
  assert.equal(payload.error, "Not found.");
});

test("25. Enabled routes reject a missing session with 401 and a foreign origin with 403, and answer no-store", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  process.env.HANDOVER_V2_DEV = "true";
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2`;
  try {
    const unauthenticated = await reservationRoute.POST(
      new NextRequest(`${base}/reservation`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }),
      { params: Promise.resolve({ shiftId: f.outgoing }) },
    );
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("Cache-Control"), "no-store");

    // With no session at all, the mutation is refused before any workflow or
    // origin logic runs.
    const badOrigin = await reservationRoute.POST(
      new NextRequest(base, { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" }),
      { params: Promise.resolve({ shiftId: f.outgoing }) },
    );
    assert.equal(badOrigin.status, 401);

    // Past the session gate, a foreign origin is refused before any body is
    // parsed or service executed; the stub user exists only to reach that check.
    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    try {
      const foreign = await reservationRoute.POST(
        new NextRequest(base, { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" }),
        { params: Promise.resolve({ shiftId: f.outgoing }) },
      );
      assert.equal(foreign.status, 403);
      assert.equal((await foreign.json()).error, "Invalid request origin.");
    } finally {
      routeSessionUser = null;
    }

    const beginForbidden = await beginRoute.POST(
      new NextRequest(`${base}/begin`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }),
      { params: Promise.resolve({ shiftId: f.outgoing }) },
    );
    assert.equal(beginForbidden.status, 401);
    assert.equal(beginForbidden.headers.get("Cache-Control"), "no-store");
  } finally {
    delete process.env.HANDOVER_V2_DEV;
  }
  const reservation = await readEqualHandoverReservation(f.outgoing);
  assert.equal(reservation, null, "Route rejections must never create a reservation");
});

// ---------------------------------------------------------------------------
// §6 — shared guard constants/locations and remaining properties
// ---------------------------------------------------------------------------

test("26. The collection constants name the dedicated v2 aggregate and shared guard collections", async () => {
  assert.equal(OPERATIONAL_COLLECTIONS.EQUAL_HANDOVERS_V2, "equal_handovers_v2");
  assert.equal(OPERATIONAL_COLLECTIONS.HANDOVER_RESERVATION_GUARDS, "handover_reservation_guards");
  assert.equal(OPERATIONAL_COLLECTIONS.HANDOVER_RESERVATION_GUARD_HISTORY, "handover_reservation_guard_history");
  const collections = getOperationalCollections();
  assert.equal(collections.equalHandoversV2.id, "equal_handovers_v2");
  assert.equal(collections.handoverReservationGuards.id, "handover_reservation_guards");
  assert.equal(collections.handoverReservationGuardHistory.id, "handover_reservation_guard_history");
});

test("27. Read-back returns the authoritative aggregate, snapshot hash and live guard", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  assert.equal(await readEqualHandoverReservation(f.outgoing), null);
  const created = await initializeEqualHandoverReservation(initInput(f));
  const state = await readEqualHandoverReservation(f.outgoing);
  assert.deepEqual(state.aggregate, created.aggregate);
  assert.equal(state.snapshotHash, created.snapshotHash);
  assert.deepEqual(state.guard, created.guard);
  await assert.rejects(() => readEqualHandoverReservation("other/shift"), expectsStatus(AssignmentOperationError, 400));
});

test("28. A v2 cancellation then re-reservation with a fresh key archives the v2 terminal evidence at the next epoch", async () => {
  await clearDb();
  const f = await makeHandoverFixture();
  await initializeEqualHandoverReservation(initInput(f));
  const binding = await v2Binding(f);
  await sleep();
  await cancelEqualHandoverReservationForTechnicians({
    outgoingShiftId: f.outgoing, actorUid: f.out[0],
    expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.expectedSnapshotHash,
    reason: "Cycle aborted",
  });
  const cancelledGuard = await getGuard(f.outgoing);
  // The shared guard archival contract requires a strictly newer timestamp
  // than the cancellation itself.
  await sleep(25);

  const second = await initializeEqualHandoverReservation(initInput(f));
  const successor = await getGuard(f.outgoing);
  assert.equal(successor.protocolOwner, "v2");
  assert.equal(successor.ownerLifecycleState, "active");
  assert.equal(successor.fencingEpoch, cancelledGuard.fencingEpoch + 1);
  assert.notEqual(successor.reservationId, binding.guard.reservationId);
  const expectedArchiveId = createReservationGuardArchiveDocumentId(cancelledGuard);
  assert.equal(successor.terminalEvidenceRef, expectedArchiveId);
  const history = await collectionState("handover_reservation_guard_history");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0][1], cancelledGuard);
  assert.equal(second.aggregate.revision, 1);
});

async function responseJson(response) {
  return response.json();
}
