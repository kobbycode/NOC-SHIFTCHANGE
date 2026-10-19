/**
 * Firestore emulator integration tests for the equal-technician v2 handover
 * report workflow (TECH-HO-RECOVERY-05): preparation, absence evidence and the
 * immutable report freeze.
 *
 * Run via: tests/run-handover-v2-report-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-handover-v2" on
 * the dedicated report-emulator port 8092 with synthetic accounts only. The
 * suite refuses to run against any other project or host, and refuses to run
 * with the development feature flag preset; route-gate tests set and clear it
 * around the handler invocation only.
 *
 * Every assertion targets final Firestore documents and audit evidence, not
 * only service return values. The suite invokes the real production writers
 * (v2 reservation, shared guard, begin service, operational record writer) —
 * there is no parallel fake dataset.
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
  !["127.0.0.1:8092", "localhost:8092"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run v2 report emulator tests outside the isolated demo emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The v2 report emulator suite must exercise services directly, with no dev feature flag.");
}
const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const { createHandoverDocumentId } = await import("../src/lib/operations/handover-domain.ts");
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
  EqualHandoverDomainError,
} = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const {
  assertEqualHandoverReportV2Binding,
  assertEqualHandoverReportPreparationV2,
  assertFrozenEqualHandoverReportV2,
  createEqualHandoverPreparationDocumentId,
  createEqualHandoverReportV2Id,
  digestEqualHandoverReportV2Content,
  EqualHandoverReportDomainError,
} = await import("../src/lib/operations/equal-handover-report-domain.ts");
const {
  prepareEqualHandoverReport,
  readEqualHandoverReportState,
  recordEqualHandoverAbsenceV2,
  clearEqualHandoverAbsenceV2,
  freezeEqualHandoverReport,
} = await import("../src/lib/operations/equal-handover-report-firestore.ts");
const {
  parsePrepareBody,
  parseAbsenceRecordBody,
  parseAbsenceClearBody,
  parseFreezeBody,
} = await import("../src/lib/operations/handover-v2-report-http.ts");
const { getHandoverWorkspace } = await import("../src/lib/operations/handover-workspace.ts");
const { OPERATIONAL_COLLECTIONS, getOperationalCollections } = await import(
  "../src/lib/operations/collections.ts"
);
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");
const { recordShiftOperation } = await import("../src/lib/operations/shift-operations.ts");
const {
  attendanceEvidenceSlotId,
  attendanceEvidenceId,
  attendanceOperationId,
  assertAttendanceEvidence,
} = await import("../src/lib/operations/attendance-evidence-domain.ts");
const {
  ATTENDANCE_EVIDENCE_SCHEMA,
  ATTENDANCE_EVIDENCE_KINDS,
  ATTENDANCE_AUTHENTICATION_METHODS,
} = await import("../src/types/attendance-evidence.ts");
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

// ---------------------------------------------------------------------------
// Fixtures — the production writers build every precondition.
// ---------------------------------------------------------------------------

async function makeActiveShiftFixture({ managerRole = "supervisor", named = true } = {}) {
  const prefix = `v2r${++seq}`;
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
  const names = new Map([
    [f.out[0], `${prefix} Ada Out-A`], [f.out[1], `${prefix} Ben Out-B`],
    [f.incoming[0], `${prefix} Cal In-A`], [f.incoming[1], `${prefix} Dee In-B`],
    [f.manager, `${prefix} Max Manager`],
  ]);
  const batch = db.batch();
  batch.set(ref("users", f.manager), { uid: f.manager, fullName: names.get(f.manager), role: managerRole, status: "active", statusOperation: null, mustChangePassword: false });
  for (const uid of [...f.out, ...f.incoming]) {
    batch.set(ref("users", uid), {
      uid,
      ...(named ? { fullName: names.get(uid) } : {}),
      role: "technician", status: "active", statusOperation: null, mustChangePassword: false,
    });
  }
  batch.set(ref("users", f.unrelated), { uid: f.unrelated, fullName: `${prefix} Un`, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
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

// Real operational records must be written while the shift is still active:
// the handover-pending barrier is part of the production contract.
async function recordOperationsFixturePhase(f, kind) {
  const actor = { uid: f.out[0], role: "technician" };
  const at = (minute) => `2020-01-01T0${minute}:00:00.000Z`;
  if (kind === "none") return;
  // The production operations writer only accepts records from a technician
  // who has joined the current active shift.
  await seedLegacyAttendance(f, f.out[0]);
  if (kind === "incident") {
    await recordShiftOperation(actor, f.outgoing, { details: {
      kind: "incident", occurredAt: at(3), category: "fault", title: "Transmitter fault",
      description: "Power supply fluctuation on the main desk.", location: "Studio 1",
      actionTaken: "Switched to backup line.", status: "monitoring", severity: "medium", linkedTaskId: null,
    } });
    return;
  }
  for (const [index, stationId] of ["joy-fm", "adom-fm", "asempa-fm", "hitz-fm"].entries()) {
    await recordShiftOperation(actor, f.outgoing, { details: {
      kind: "broadcast", occurredAt: at(1 + index), stationId, status: "on_air", remarks: "",
    } });
  }
  await recordShiftOperation(actor, f.outgoing, { details: {
    kind: "outside_broadcast", occurredAt: at(5), title: "Outside van feed", location: "Accra mall",
    runningStatus: "ended", technicalIssues: "None", actionTaken: "Monitored handoff.",
    status: "resolved", remarks: "", linkedTaskId: null,
  } });
}

async function makeReservedFixture({ ops = "none", managerRole = "supervisor", named = true } = {}) {
  const f = await makeActiveShiftFixture({ managerRole, named });
  await recordOperationsFixturePhase(f, ops);
  await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  await initializeEqualHandoverReservation(initInput(f));
  return f;
}

async function addEligiblePair(createdBy, pairId, uids) {
  const batch = db.batch();
  for (const uid of uids) {
    batch.set(ref("users", uid), { uid, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
    batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId, createdAt: historical, updatedAt: historical });
    batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [], updatedAt: historical });
  }
  batch.set(ref("technician_pairs", pairId), {
    id: pairId, technicianIds: uids, status: "active", createdBy,
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
    snapshotHash: state.snapshotHash,
    expectedRevision: state.aggregate.revision,
    expectedSnapshotHash: state.snapshotHash,
    guard: state.guard,
  };
}

async function getV2Document(f) {
  const snap = await ref("equal_handovers_v2", createEqualHandoverDocumentId(f.outgoing)).get();
  return snap.exists ? snap.data() : null;
}

async function preparationDoc(f) {
  const state = await readEqualHandoverReservation(f.outgoing);
  const id = createEqualHandoverPreparationDocumentId(state.aggregate.reservation.handoverId);
  const snap = await ref("handover_report_preparations_v2", id).get();
  return { id, exists: snap.exists, data: snap.exists ? snap.data() : null };
}

async function collectionState(name) {
  const snap = await db.collection(name).get();
  return snap.docs
    .map((doc) => [doc.id, doc.data()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function reportsState() {
  return collectionState("handover_reports_v2");
}

async function operationalState() {
  return {
    equalHandoversV2: await collectionState("equal_handovers_v2"),
    preparations: await collectionState("handover_report_preparations_v2"),
    reports: await collectionState("handover_reports_v2"),
    corrections: await collectionState("handover_report_corrections"),
    handovers: await collectionState("handovers"),
    guards: await collectionState("handover_reservation_guards"),
    guardHistory: await collectionState("handover_reservation_guard_history"),
    shifts: await collectionState("shifts"),
    technicianSchedules: await collectionState("technician_schedules"),
    shiftMembers: await collectionState("shift_members"),
    operationalShiftControl: await collectionState("operational_shift_control"),
    auditLogs: await collectionState("audit_logs"),
    attendanceLegacy: await collectionState("shift_attendance"),
    attendanceV2: await collectionState("attendance_evidence_v2"),
    attendanceOperationsV2: await collectionState("attendance_evidence_operations_v2"),
    handoverTransfers: await collectionState("handover_task_transfers"),
    tasks: await collectionState("tasks"),
    taskAssignments: await collectionState("task_assignments"),
    operationEvents: await collectionState("shift_operation_events"),
    operationHeads: await collectionState("shift_operation_heads"),
  };
}

async function auditsByAction(action) {
  return (await collectionState("audit_logs")).filter(([, audit]) => audit.action === action);
}

// ---------------------------------------------------------------------------
// Authoritative source seeding — real collections, production-shaped records.
// ---------------------------------------------------------------------------

async function seedTask(f, status = "open", id = `${f.outgoing}-task`) {
  const task = { id, shiftId: f.outgoing, title: "Authoritative work", description: "Pending work",
    priority: "medium", sectionId: null, status, createdBy: f.manager, createdAt: historical, updatedAt: historical };
  await ref("tasks", id).set(task);
  return task;
}

async function seedLegacyAttendance(f, uid, { clockIn = null, clockOut = null } = {}) {
  const id = `${f.outgoing}_${uid}`;
  const record = { id, shiftId: f.outgoing, technicianId: uid, status: "present",
    participationAuthority: "primary", authorizationId: null, clockIn, clockOut, isProvisional: false,
    recordedAt: historical, updatedAt: historical };
  await ref("shift_attendance", id).set(record);
  return record;
}

async function seedAttendanceEvidence(f, { uid, position, kind, clockIn = null, clockOut = null,
  eventTime = null, attestedByUid = null, attestationReason = null, reportedDepartureTime = null, lateReason = null }) {
  const state = await readEqualHandoverReservation(f.outgoing);
  const handoverId = state.aggregate.reservation.handoverId;
  const slotId = attendanceEvidenceSlotId({ handoverId, technicianUid: uid, kind });
  const eventId = randomUUID();
  const personallyAuthenticated = kind !== ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION;
  const authenticationMethod = {
    [ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN]: ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_CONFIRMATION,
    [ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE]: ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_ACCEPTANCE,
    [ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT]: ATTENDANCE_AUTHENTICATION_METHODS.SERVER_ISSUED_PERSONAL_CLOCK_OUT,
    [ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION]: ATTENDANCE_AUTHENTICATION_METHODS.COLLEAGUE_ATTESTATION,
  }[kind];
  const evidence = assertAttendanceEvidence({
    schema: ATTENDANCE_EVIDENCE_SCHEMA,
    id: attendanceEvidenceId(slotId),
    slotId,
    operationId: attendanceOperationId(eventId),
    eventId,
    handoverId,
    handoverDocumentId: createEqualHandoverDocumentId(f.outgoing),
    outgoingShiftId: f.outgoing,
    incomingShiftId: state.aggregate.reservation.reservedIncomingShiftId,
    position,
    technicianUid: uid,
    kind,
    scheduledStart,
    scheduledEnd,
    eventTime,
    clockIn,
    clockOut,
    reportedDepartureTime,
    attestedByUid,
    attestationReason,
    authenticationMethod,
    personallyAuthenticated,
    lateReason,
    handoverRevision: state.aggregate.revision,
    snapshotHash: state.snapshotHash,
    guardRevision: state.guard?.guardRevision ?? 1,
    fencingEpoch: state.guard?.fencingEpoch ?? 1,
    finalizedAt: historical,
    createdAt: historical,
  });
  await ref("attendance_evidence_v2", evidence.id).set(evidence);
  return evidence;
}

// Full reviewed evidence for a freeze, taken from a fresh preparation and the
// current authoritative binding.
async function reviewedFreezeInput(f, actorUid, { reason = "Reviewed and confirmed the consolidated report", correctionNote = null, prepareReason = "prepare" } = {}) {
  const { preparation } = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid, reason: prepareReason });
  const binding = await v2Binding(f);
  return freezeInputFor(f, actorUid, preparation, binding, reason, correctionNote);
}

function freezeInputFor(f, actorUid, preparation, binding, reason, correctionNote = null) {
  return {
    outgoingShiftId: f.outgoing,
    actorUid,
    expectedRevision: binding.aggregate.revision,
    expectedSnapshotHash: binding.snapshotHash,
    expectedGuardRevision: binding.guard.guardRevision,
    expectedFencingEpoch: binding.guard.fencingEpoch,
    preparationRevision: preparation.preparationRevision,
    contentDigest: preparation.contentDigest,
    evidenceSnapshotHash: preparation.evidenceSnapshotHash,
    workSnapshotVersion: preparation.workSnapshotVersion,
    reason,
    correctionNote,
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
const as403 = (pattern) => expectsStatus(AssignmentOperationError, 403, pattern);
const as400 = (pattern) => expectsStatus(AssignmentOperationError, 400, pattern);
const as413 = () => expectsStatus(AssignmentOperationError, 413, /document limit/);

function rowOf(content, uid) {
  return content.attendance.find((row) => row.uid === uid);
}

const absenceBase = (f, stamp, subject, overrides = {}) => ({
  outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: subject,
  absenceType: "not_yet_in", reason: "Has not arrived at the office", reportedDepartureTime: null,
  expectedRevision: stamp.aggregate.revision, expectedSnapshotHash: stamp.snapshotHash, ...overrides,
});

// ---------------------------------------------------------------------------
// §5/§6/§9 — preparation
// ---------------------------------------------------------------------------

test("1. Preparation writes the deterministic preparation_<fingerprint> document with full review stamps, canonical ISO writes and exactly one audit event", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const reservation = await readEqualHandoverReservation(f.outgoing);
  const fingerprint = reservation.aggregate.reservation.handoverId;
  assert.match(fingerprint, /^handover_v2_[0-9a-f]{64}$/);

  const first = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "first review" });
  assert.equal(first.replayed, false);
  const expectedId = `preparation_${fingerprint}`;
  assert.equal(first.preparation.id, expectedId);

  const raw = await ref("handover_report_preparations_v2", expectedId).get();
  assert.ok(raw.exists);
  const stored = raw.data();
  assert.equal(stored.schema, "equal-handover-report-preparation-v2");
  assert.equal(typeof stored.createdAt, "string", "TECH-HO-16A: stored timestamps must be canonical ISO strings, not driver maps");
  assert.equal(typeof stored.updatedAt, "string");
  assert.match(stored.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(stored.outgoingShiftId, f.outgoing);
  assert.equal(stored.handoverDocumentId, createEqualHandoverDocumentId(f.outgoing));
  assert.equal(stored.reservationId, fingerprint);
  assert.equal(stored.preparationRevision, 1);
  assert.equal(stored.guardProtocolOwner, "v2");
  assert.equal(stored.aggregateRevision, reservation.aggregate.revision);
  assert.equal(stored.aggregateSnapshotHash, reservation.snapshotHash);
  assert.equal(stored.guardRevision, reservation.guard.guardRevision);
  assert.equal(stored.fencingEpoch, reservation.guard.fencingEpoch);
  assert.equal(stored.contentDigest, digestEqualHandoverReportV2Content(stored.content));
  assert.equal(stored.revisionHistory.length, 1);
  assert.equal(stored.revisionHistory[0].preparedBy, f.out[0]);
  assert.equal(stored.blockers.length, 5, "clean fixture: four unverified stations plus outside broadcast");

  const preparedAudits = await auditsByAction("EQUAL_HANDOVER_REPORT_PREPARED_V2");
  assert.equal(preparedAudits.length, 1);
  assert.equal(preparedAudits[0][1].preparationId, expectedId);

  // Equal preparation authority: the second outgoing technician reviewing the
  // identical content replays without a revision bump or a second audit.
  const second = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: null });
  assert.equal(second.replayed, true);
  assert.equal(second.preparation.preparationRevision, 1);
  assert.equal((await auditsByAction("EQUAL_HANDOVER_REPORT_PREPARED_V2")).length, 1);

  // §6 hydration boundary: a Date written through the driver (stored as a
  // Firestore Timestamp) is hydrated to a canonical ISO string in content.
  await ref("shifts", f.outgoing).update({ actualStart: new Date("2020-01-01T00:30:00.000Z") });
  const rawShift = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(typeof rawShift.actualStart, "object", "the driver stored the Date as a Timestamp");
  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.live.content.staff.actualStart, "2020-01-01T00:30:00.000Z");
});

test("2. Preparation authorization matrix: incoming, unrelated, supervisor, admin and broken profiles are rejected without touching any operational state", async () => {
  await clearDb();
  const f = await makeReservedFixture({ managerRole: "admin" });
  const before = await operationalState();
  for (const actorUid of [f.incoming[0], f.incoming[1], f.unrelated, f.manager]) {
    await assert.rejects(
      () => prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid, reason: null }),
      as403(/outgoing reserved technician|not authorized/),
    );
  }
  const patches = [
    { mustChangePassword: true },
    { statusOperation: { kind: "role_change" } },
    { status: "inactive" },
    { role: "supervisor" },
  ];
  for (const patch of patches) {
    await ref("users", f.out[0]).update(patch);
    await assert.rejects(
      () => prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null }),
      as403(/not authorized/),
    );
    await ref("users", f.out[0]).update({ mustChangePassword: false, statusOperation: null, status: "active", role: "technician" });
  }
  await ref("users", f.out[0]).delete();
  await assert.rejects(
    () => prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null }),
    as403(/not authorized/),
  );
  assert.deepEqual(await operationalState(), before, "Rejected preparation must not mutate any operational state");
});

test("3. Preparation without a v2 reservation is 404; a cancelled reservation is refused by lifecycle before any write", async () => {
  await clearDb();
  const begun = await makeActiveShiftFixture();
  await beginShiftHandover({ shiftId: begun.outgoing, actorUid: begun.out[0], authority: "equal-technician" });
  await assert.rejects(
    () => prepareEqualHandoverReport({ outgoingShiftId: begun.outgoing, actorUid: begun.out[0], reason: null }),
    expectsStatus(AssignmentOperationError, 404),
  );
  await assert.rejects(
    () => prepareEqualHandoverReport({ outgoingShiftId: "not-a-shift", actorUid: begun.out[0], reason: null }),
    expectsStatus(AssignmentOperationError, 404),
  );

  const f = await makeReservedFixture();
  const binding = await v2Binding(f);
  await cancelEqualHandoverReservationForTechnicians({
    outgoingShiftId: f.outgoing, actorUid: f.out[1],
    expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.expectedSnapshotHash,
    reason: "Cycle aborted",
  });
  await assert.rejects(
    () => prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null }),
    as409(/lifecycle does not permit report preparation/),
  );
  assert.equal((await preparationDoc(f)).exists, false);
});

test("4. Changed sources create revision 2 with immutable history; createdAt is preserved and the audit records the previous revision", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const first = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "first" });
  await seedTask(f);
  await sleep();
  const second = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: "added pending work" });
  assert.equal(second.replayed, false);
  assert.equal(second.preparation.preparationRevision, 2);
  assert.equal(second.preparation.preparedBy, f.out[1]);
  assert.equal(second.preparation.createdAt, first.preparation.createdAt, "createdAt must be preserved across revisions");
  assert.notEqual(second.preparation.contentDigest, first.preparation.contentDigest);
  assert.deepEqual(second.preparation.revisionHistory.map((entry) => entry.preparationRevision), [1, 2]);
  assert.equal(second.preparation.revisionHistory[1].contentDigest, second.preparation.contentDigest);
  assert.equal(second.preparation.revisionHistory[0].contentDigest, first.preparation.contentDigest);

  const prepared = await auditsByAction("EQUAL_HANDOVER_REPORT_PREPARED_V2");
  assert.equal(prepared.length, 2);
  const latest = prepared.find(([, audit]) => audit.preparationRevision === 2)[1];
  assert.equal(latest.previousPreparationRevision, 1);
  assert.equal(latest.previousContentDigest, first.preparation.contentDigest);
  assert.equal(latest.reason, "added pending work");

  // The stored document re-validates against the authoritative domain schema.
  const raw = (await ref("handover_report_preparations_v2", second.preparation.id).get()).data();
  assert.equal(assertEqualHandoverReportPreparationV2(raw).preparationRevision, 2);
});

// ---------------------------------------------------------------------------
// §4 — real operational substance
// ---------------------------------------------------------------------------

test("5. The report reflects real shift operations: recorded broadcasts and outside coverage clear the operational blockers", async () => {
  await clearDb();
  const bare = await makeReservedFixture({ ops: "none" });
  const barePrep = await prepareEqualHandoverReport({ outgoingShiftId: bare.outgoing, actorUid: bare.out[0], reason: null });
  assert.deepEqual(
    barePrep.preparation.content.completeness.blockers
      .filter((line) => line.startsWith("Missing verified broadcast observation: "))
      .map((line) => line.slice("Missing verified broadcast observation: ".length)).sort(),
    ["Adom FM", "Asempa FM", "Hitz FM", "Joy FM"],
  );
  assert.ok(barePrep.preparation.content.completeness.blockers.includes("Outside broadcast information is missing."));

  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  const prep = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null });
  assert.deepEqual(prep.preparation.content.completeness.blockers, [], "authoritative station records must flow through to the report");
  assert.equal(prep.preparation.content.operations.latest.length, 5);
  for (const name of ["Joy FM", "Adom FM", "Asempa FM", "Hitz FM"]) {
    assert.ok(prep.preparation.content.operations.latest.some((item) => item.kind === "broadcast" && item.stationName === name));
  }
  assert.ok(prep.preparation.content.operations.latest.some((item) => item.kind === "outside_broadcast"));

  // Pending authoritative work surfaces as a readiness blocker.
  await seedTask(f);
  const drifted = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: "pending work added" });
  assert.equal(drifted.preparation.preparationRevision, 2);
  assert.ok(drifted.preparation.content.completeness.blockers.some((line) => line.startsWith(`Pending task ${f.outgoing}-task:`)));
  assert.equal(drifted.preparation.content.pendingTasks.length, 1);
  assert.equal(drifted.preparation.content.pendingTasks[0].disposition, "unclassified");
});

test("6. Missing incident records are never described as proof that no faults occurred", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "none" });
  const prep = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null });
  assert.ok(prep.preparation.content.completeness.warnings.includes(
    "No fault or technical activity records were submitted. This is not a declaration of no faults.",
  ));

  await clearDb();
  const g = await makeReservedFixture({ ops: "incident" });
  const other = await prepareEqualHandoverReport({ outgoingShiftId: g.outgoing, actorUid: g.out[0], reason: null });
  assert.equal(other.preparation.content.completeness.warnings.some((line) => line.includes("not a declaration of no faults")), false);
  assert.ok(other.preparation.content.operations.latest.some((item) => item.kind === "incident"));
});

test("7. Attendance merges legacy personal records and v2 evidence; missing attendance stays missing and is never synthesized", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  await seedLegacyAttendance(f, f.out[0], { clockIn: "2020-01-01T05:55:00.000Z", clockOut: "2020-01-01T14:05:00.000Z" });
  await seedAttendanceEvidence(f, { uid: f.incoming[0], position: "incoming_tech_a",
    kind: ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN, clockIn: "2030-01-01T05:58:00.000Z", eventTime: "2030-01-01T05:58:00.000Z" });

  const evidenceBefore = await collectionState("attendance_evidence_v2");
  const legacyBefore = await collectionState("shift_attendance");
  const { preparation } = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null });
  const content = preparation.content;

  const outA = rowOf(content, f.out[0]);
  assert.equal(outA.clockIn, "2020-01-01T05:55:00.000Z");
  assert.equal(outA.clockOut, "2020-01-01T14:05:00.000Z");
  assert.equal(outA.departureProvenance, "personal");
  assert.equal(outA.hoursWorked, (Date.parse("2020-01-01T14:05:00.000Z") - Date.parse("2020-01-01T05:55:00.000Z")) / 3_600_000);
  assert.equal(outA.payableHours, "policy_unresolved", "the report never infers a payable-hours policy decision");
  assert.equal(outA.legacyAttendance.shiftId, f.outgoing);

  const inA = rowOf(content, f.incoming[0]);
  assert.equal(inA.clockIn, "2030-01-01T05:58:00.000Z");
  assert.equal(inA.reportingEvidence.kind, ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN);
  assert.equal(inA.reportingEvidence.personallyAuthenticated, true);
  assert.equal(inA.clockOut, null);

  const inB = rowOf(content, f.incoming[1]);
  assert.equal(inB.clockIn, null);
  assert.equal(inB.clockOut, null);
  assert.equal(inB.reportingEvidence, null);
  assert.equal(inB.legacyAttendance, null);
  assert.ok(content.completeness.warnings.some((line) => line.startsWith("Attendance missing: ") && line.includes(inB.name)));
  assert.ok(content.completeness.warnings.some((line) => line.startsWith("Hours worked cannot be determined:")));

  assert.deepEqual(await collectionState("attendance_evidence_v2"), evidenceBefore, "the report writes no attendance evidence");
  assert.deepEqual(await collectionState("shift_attendance"), legacyBefore);
});

test("8. A colleague-attested departure keeps hoursWorked undetermined and payableHours policy_unresolved", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  await seedLegacyAttendance(f, f.out[1], { clockIn: "2020-01-01T05:50:00.000Z", clockOut: null });
  await seedAttendanceEvidence(f, { uid: f.out[1], position: "outgoing_tech_b",
    kind: ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION,
    clockOut: "2020-01-01T13:40:00.000Z", reportedDepartureTime: "2020-01-01T13:40:00.000Z",
    eventTime: "2020-01-01T13:41:00.000Z", attestedByUid: f.out[0], attestationReason: "Left after handoff to the relief desk." });

  const { preparation } = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null });
  const row = rowOf(preparation.content, f.out[1]);
  assert.equal(row.clockOut, null, "a colleague attestation never becomes a personal clock-out");
  assert.equal(row.clockIn, "2020-01-01T05:50:00.000Z");
  assert.equal(row.departureProvenance, "colleague_attested");
  assert.equal(row.hoursWorked, null);
  assert.equal(row.payableHours, "policy_unresolved");
  assert.equal(row.reportingEvidence.kind, ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION);
  assert.equal(row.reportingEvidence.attestedByUid, f.out[0]);
  assert.ok(preparation.content.completeness.warnings.some((line) => line.startsWith("Hours worked cannot be determined:")));
});

test("9. Conflicting attendance evidence fails closed and blocks preparation", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  await seedAttendanceEvidence(f, { uid: f.out[1], position: "outgoing_tech_b",
    kind: ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT,
    clockOut: "2020-01-01T14:00:00.000Z", eventTime: "2020-01-01T14:00:00.000Z" });
  await seedAttendanceEvidence(f, { uid: f.out[1], position: "outgoing_tech_b",
    kind: ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION,
    clockOut: "2020-01-01T13:00:00.000Z", reportedDepartureTime: "2020-01-01T13:00:00.000Z",
    eventTime: "2020-01-01T13:01:00.000Z", attestedByUid: f.out[0], attestationReason: "Contradictory attestation." });
  const before = await operationalState();
  await assert.rejects(
    () => prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null }),
    as409(/colleague attestation contradicts a personal clock-out/),
  );
  assert.deepEqual(await operationalState(), before);

  // Two clock-in records for one participant also fail closed.
  await clearDb();
  const g = await makeReservedFixture();
  await seedAttendanceEvidence(g, { uid: g.incoming[0], position: "incoming_tech_a",
    kind: ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
    clockIn: "2030-01-01T05:58:00.000Z", eventTime: "2030-01-01T05:58:00.000Z" });
  await seedAttendanceEvidence(g, { uid: g.incoming[0], position: "incoming_tech_a",
    kind: ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE,
    clockIn: "2030-01-01T06:20:00.000Z", eventTime: "2030-01-01T06:20:00.000Z",
    lateReason: "Transport delay acknowledged by the colleague on duty." });
  const gBefore = await operationalState();
  await assert.rejects(
    () => prepareEqualHandoverReport({ outgoingShiftId: g.outgoing, actorUid: g.out[0], reason: null }),
    as409(/Conflicting attendance evidence exists for a participant/),
  );
  assert.deepEqual(await operationalState(), gBefore);
});

test("10. Staff names come from authoritative profiles; missing names are flagged, never invented", async () => {
  await clearDb();
  const f = await makeReservedFixture({ named: false });
  const { preparation } = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null });
  assert.equal(preparation.content.participants.length, 4);
  assert.ok(preparation.content.participants.every((participant) => participant.name === null));
  assert.ok(preparation.content.completeness.warnings.includes(
    "One or more staff names are missing from authoritative account profiles.",
  ));
  await ref("users", f.out[0]).update({ fullName: "Real Name" });
  const drifted = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: "profile updated" });
  assert.equal(rowOf(drifted.preparation.content, f.out[0]).name, "Real Name");
});

// ---------------------------------------------------------------------------
// §8 — absence evidence
// ---------------------------------------------------------------------------

test("11. Absence declaration updates the aggregate with audit history and never touches attendance collections", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const before = await v2Binding(f);
  const result = await recordEqualHandoverAbsenceV2(absenceBase(f, before, f.incoming[0], { reason: "Incoming technician not yet in" }));
  assert.equal(result.replayed, false);
  assert.equal(result.aggregate.revision, before.aggregate.revision + 1);
  assert.equal(result.aggregate.absences.length, 1);
  const absence = result.aggregate.absences.find((item) => item.technicianUid === f.incoming[0]);
  assert.equal(absence.position, "incoming_tech_a");
  assert.equal(absence.absenceType, "not_yet_in");
  assert.equal(absence.recordedBy, f.out[0]);
  assert.equal(absence.attestedByUid, f.out[0]);
  assert.equal(absence.reportedDepartureTime, null);

  const stored = await getV2Document(f);
  assert.equal(stored.absences.length, 1);
  assert.equal(stored.revision, before.aggregate.revision + 1);

  const audits = await auditsByAction("EQUAL_HANDOVER_ABSENCE_RECORDED_V2");
  assert.equal(audits.length, 1);
  assert.equal(audits[0][1].previousDeclaration, null);
  assert.equal(audits[0][1].revision, stored.revision);
  assert.equal(audits[0][1].absence.technicianUid, f.incoming[0]);

  assert.equal((await collectionState("attendance_evidence_v2")).length, 0, "an absence declaration must not finalize or fabricate attendance evidence");
  assert.equal((await collectionState("shift_attendance")).length, 0);
});

test("12. Outgoing absence requires absent_left_office with a reported departure time; incoming absence requires not_yet_in", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const binding = await v2Binding(f);
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.out[1], { absenceType: "not_yet_in" })),
    expectsStatus(EqualHandoverDomainError, 400, /absent_left_office/),
  );
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.out[1], { absenceType: "absent_left_office" })),
    expectsStatus(EqualHandoverDomainError, 400, /reported departure time/),
  );
  const declared = await recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.out[1], {
    absenceType: "absent_left_office", reason: "Left the office before the relief pair arrived",
    reportedDepartureTime: "2020-01-01T23:45:00.000Z",
  }));
  assert.equal(declared.replayed, false);
  assert.equal(declared.aggregate.absences[0].absenceType, "absent_left_office");
  assert.equal(declared.aggregate.absences[0].reportedDepartureTime, "2020-01-01T23:45:00.000Z");

  await clearDb();
  const g = await makeReservedFixture();
  const gBinding = await v2Binding(g);
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(g, gBinding, g.incoming[0], {
      absenceType: "absent_left_office", reason: "Wrong side type", reportedDepartureTime: "2020-01-01T22:00:00.000Z",
    })),
    expectsStatus(EqualHandoverDomainError, 400, /not_yet_in/),
  );
  assert.equal((await getV2Document(g)).absences.length, 0);
});

test("13. Absence authorization: no self-declaration, no outsider, no supervisor, server-derived actor", async () => {
  await clearDb();
  const f = await makeReservedFixture({ managerRole: "supervisor" });
  const binding = await v2Binding(f);
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.out[0])),
    as403(/cannot declare their own absence/),
  );
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.unrelated)),
    as403(/Unauthorized handover participant/),
  );
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.out[1], { actorUid: f.manager })),
    as403(/outgoing reserved technician|not authorized/),
  );
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.out[1], { actorUid: f.incoming[0] })),
    as403(/outgoing reserved technician/),
  );
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.incoming[0], { absenceType: "unsupported_type" })),
    as400(/Unsupported absence type/),
  );
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.incoming[0], { reason: "   " })),
    as400(/absence reason/),
  );
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.incoming[0], { expectedSnapshotHash: "0".repeat(63) })),
    as400(/revision or snapshot hash/),
  );
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, { aggregate: { revision: 99 }, snapshotHash: binding.snapshotHash }, f.incoming[0])),
    (error) => error instanceof EqualHandoverDomainError && error.status === 409,
  );
  assert.equal((await getV2Document(f)).absences.length, 0, "rejected declarations leave the aggregate untouched");
});

test("14. At most one participant absence may stand; clearing reopens the declaration right", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const binding = await v2Binding(f);
  const declared = await recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.out[1], {
    absenceType: "absent_left_office", reason: "Departed early", reportedDepartureTime: "2020-01-01T21:30:00.000Z",
  }));
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, declared, f.incoming[0])),
    as409(/Only one participant absence/),
  );
  // The subject cannot clear their own declaration; a colleague can.
  await assert.rejects(
    () => clearEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], technicianUid: f.out[1],
      expectedRevision: declared.aggregate.revision, expectedSnapshotHash: declared.snapshotHash }),
    as403(/cannot clear their own absence/),
  );
  const cleared = await clearEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: f.out[1],
    expectedRevision: declared.aggregate.revision, expectedSnapshotHash: declared.snapshotHash });
  assert.equal(cleared.replayed, false);
  assert.deepEqual(cleared.aggregate.absences, []);
  assert.equal(cleared.aggregate.revision, declared.aggregate.revision + 1);

  const afterClear = await v2Binding(f);
  const incoming = await recordEqualHandoverAbsenceV2(absenceBase(f, afterClear, f.incoming[0]));
  assert.equal(incoming.replayed, false);

  assert.equal((await auditsByAction("EQUAL_HANDOVER_ABSENCE_RECORDED_V2")).length, 2);
  const clearedAudits = await auditsByAction("EQUAL_HANDOVER_ABSENCE_CLEARED_V2");
  assert.equal(clearedAudits.length, 1);
  assert.equal(clearedAudits[0][1].clearedDeclaration.technicianUid, f.out[1]);
  assert.equal(clearedAudits[0][1].clearedDeclaration.reason, "Departed early");
});

test("15. Absence cannot replace genuine personal attendance evidence (legacy or v2)", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  await seedLegacyAttendance(f, f.out[1], { clockIn: "2020-01-01T05:50:00.000Z", clockOut: "2020-01-01T14:00:00.000Z" });
  const binding = await v2Binding(f);
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.out[1], {
      absenceType: "absent_left_office", reason: "Duplicate claim", reportedDepartureTime: "2020-01-01T13:00:00.000Z" })),
    as409(/already has personal clock-out evidence/),
  );

  await seedAttendanceEvidence(f, { uid: f.incoming[0], position: "incoming_tech_a",
    kind: ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN, clockIn: "2030-01-01T05:58:00.000Z", eventTime: "2030-01-01T05:58:00.000Z" });
  const drifted = await v2Binding(f);
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2(absenceBase(f, drifted, f.incoming[0])),
    as409(/already has personal clock-in evidence/),
  );
  assert.equal((await getV2Document(f)).absences.length, 0);
});

test("16. Replaying an identical declaration or a no-op clear changes nothing; prior declarations survive only in immutable audit history", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const binding = await v2Binding(f);
  const input = absenceBase(f, binding, f.incoming[0], { reason: "Stuck in transit" });
  const first = await recordEqualHandoverAbsenceV2(input);
  const replay = await recordEqualHandoverAbsenceV2(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.aggregate.revision, first.aggregate.revision);
  assert.equal((await auditsByAction("EQUAL_HANDOVER_ABSENCE_RECORDED_V2")).length, 1);

  const reCleared = await clearEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: f.incoming[1],
    expectedRevision: first.aggregate.revision, expectedSnapshotHash: first.snapshotHash });
  // No absence for incoming[1] exists: the domain returns the aggregate
  // unchanged and the persistence layer replays without a write or audit.
  assert.equal(reCleared.replayed, true);
  assert.equal((await auditsByAction("EQUAL_HANDOVER_ABSENCE_CLEARED_V2")).length, 0);

  const cleared = await clearEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: f.incoming[0],
    expectedRevision: first.aggregate.revision, expectedSnapshotHash: first.snapshotHash });
  assert.equal(cleared.replayed, false);
  assert.deepEqual(cleared.aggregate.absences, []);
  const clearAudit = (await auditsByAction("EQUAL_HANDOVER_ABSENCE_CLEARED_V2"))[0][1];
  assert.equal(clearAudit.clearedDeclaration.reason, "Stuck in transit");
  assert.equal((await getV2Document(f)).absences.length, 0);
});

// ---------------------------------------------------------------------------
// §7/§9/§10 — freeze
// ---------------------------------------------------------------------------

test("17. Freeze writes one immutable v2 report document, binds the reservation, and records the deterministic audit event", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  const before = await v2Binding(f);
  const input = await reviewedFreezeInput(f, f.out[0]);
  const frozen = await freezeEqualHandoverReport(input);
  assert.equal(frozen.replayed, false);

  const expectedId = createEqualHandoverReportV2Id({
    reservationId: before.aggregate.reservation.handoverId,
    preparationRevision: input.preparationRevision,
    contentDigest: input.contentDigest,
    aggregateRevision: before.aggregate.revision,
    version: 1,
  });
  assert.equal(frozen.report.id, expectedId);
  assert.match(expectedId, /^report_v2_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const raw = (await ref("handover_reports_v2", expectedId).get()).data();
  const report = assertFrozenEqualHandoverReportV2(raw);
  assert.equal(report.schema, "handover-report-v2");
  assert.equal(report.version, 1);
  assert.equal(report.supersedesReportId, null);
  assert.equal(report.outgoingShiftId, f.outgoing);
  assert.equal(report.reservationId, before.aggregate.reservation.handoverId);
  assert.equal(report.preparationId, `preparation_${before.aggregate.reservation.handoverId}`);
  assert.equal(report.digest, input.contentDigest);
  assert.equal(report.evidenceSnapshotHash, input.evidenceSnapshotHash);
  assert.equal(report.workSnapshotVersion, input.workSnapshotVersion);
  assert.equal(report.guardRevision, before.guard.guardRevision);
  assert.equal(report.fencingEpoch, before.guard.fencingEpoch);
  assert.equal(report.frozenBy, f.out[0]);
  assert.equal(typeof raw.frozenAt, "string", "frozen timestamps are canonical ISO strings in storage");
  assert.match(raw.frozenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(digestEqualHandoverReportV2Content(report.content), report.digest);

  const binding = assertEqualHandoverReportV2Binding(report.binding);
  assert.equal(binding.id, expectedId);
  assert.equal(binding.aggregateRevision, before.aggregate.revision, "binding records the pre-freeze revision");
  assert.deepEqual(binding, report.binding);

  const stored = await getV2Document(f);
  assert.deepEqual(stored.reportBinding, JSON.parse(JSON.stringify(binding)));
  assert.equal(stored.revision, before.aggregate.revision + 1);
  assert.equal(stored.lifecycleStatus, "collecting_confirmations");

  const audits = await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2");
  assert.equal(audits.length, 1);
  assert.equal(audits[0][1].reportId, expectedId);
  assert.equal(audits[0][1].aggregateRevision, before.aggregate.revision);
  assert.equal(audits[0][1].nextAggregateRevision, before.aggregate.revision + 1);
  assert.equal(audits[0][1].correctionNote, null);

  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.preparationDrifted, false);
  assert.ok(state.frozenReport);
});

test("18. Retry safety: an identical completed freeze replays the same immutable report with no duplicate documents or audit events, including concurrent duplicates", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  const input = await reviewedFreezeInput(f, f.out[0]);
  const first = await freezeEqualHandoverReport(input);

  const replay = await freezeEqualHandoverReport(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.report.id, first.report.id);
  assert.deepEqual((await reportsState()).map(([id]) => id), [first.report.id]);
  assert.equal((await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).length, 1);
  assert.equal((await getV2Document(f)).reportBinding.id, first.report.id);

  // A concurrent duplicate issued as two in-flight calls settles on one
  // immutable report: the deterministic id makes the loser replay.
  await clearDb();
  const g = await makeReservedFixture({ ops: "full" });
  const second = await reviewedFreezeInput(g, g.out[1]);
  const raced = await Promise.all([freezeEqualHandoverReport(second), freezeEqualHandoverReport(second)]);
  assert.equal(raced.filter((result) => result.replayed === false).length, 1);
  assert.equal((await reportsState()).length, 1);
  assert.equal(raced[0].report.id, raced[1].report.id);
});

test("19. Freeze refuses stale evidence: every reviewed stamp is re-verified inside the transaction", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const input = await reviewedFreezeInput(f, f.out[0]);

  await assert.rejects(() => freezeEqualHandoverReport({ ...input, expectedRevision: input.expectedRevision + 1 }),
    as409(/Stale equal handover reservation evidence/));
  await assert.rejects(() => freezeEqualHandoverReport({ ...input, expectedSnapshotHash: "f".repeat(64) }),
    as409(/Stale equal handover reservation evidence/));
  await assert.rejects(() => freezeEqualHandoverReport({ ...input, expectedGuardRevision: input.expectedGuardRevision + 1 }),
    as409(/guard changed/));
  await assert.rejects(() => freezeEqualHandoverReport({ ...input, expectedFencingEpoch: input.expectedFencingEpoch + 1 }),
    as409(/guard changed/));
  await assert.rejects(() => freezeEqualHandoverReport({ ...input, preparationRevision: input.preparationRevision + 1 }),
    as409(/preparation revision changed/));
  await assert.rejects(() => freezeEqualHandoverReport({ ...input, contentDigest: "e".repeat(64) }),
    as409(/preparation revision changed/));
  await assert.rejects(() => freezeEqualHandoverReport({ ...input, reason: null }),
    as400(/freeze reason/));

  // A reservation change after preparation invalidates the preparation even
  // when the caller replays its own reviewed stamps against the new revision.
  const binding = await v2Binding(f);
  const declared = await recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.incoming[0]));
  await assert.rejects(() => freezeEqualHandoverReport({
    ...input, expectedRevision: declared.aggregate.revision, expectedSnapshotHash: declared.snapshotHash,
  }), as409(/reservation changed after this report was prepared/));

  assert.equal((await reportsState()).length, 0, "a refused freeze writes no report document");
  assert.equal((await getV2Document(f)).reportBinding, null);
});

test("20. A stale preparation cannot freeze: live operational sources are recomputed in the freeze transaction", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  await seedTask(f);
  const input = await reviewedFreezeInput(f, f.out[0]);
  // Silent raw-source mutation bypassing the aggregate: the live digest must
  // catch it at freeze time (§7 write-barrier gap closure).
  await sleep();
  await ref("tasks", `${f.outgoing}-task`).update({ title: "Renamed after review", updatedAt: new Date().toISOString() });
  const before = await operationalState();
  await assert.rejects(() => freezeEqualHandoverReport(input),
    as409(/stale preparation cannot freeze/));
  const after = await operationalState();
  assert.deepEqual(after.reports, [], "the stale freeze created no report");
  assert.deepEqual(after.equalHandoversV2, before.equalHandoversV2, "the reservation is untouched by the rejected freeze");
});

test("21. Terminal task lifecycle cannot escape source-change detection", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  const task = await seedTask(f);
  const input = await reviewedFreezeInput(f, f.out[0]);
  await sleep();
  await ref("tasks", task.id).update({ status: "completed", updatedAt: new Date().toISOString() });
  // The pending→terminal transition changes the live digest even though the
  // task disappears from pendingTasks: terminal evidence is hashed, so the
  // stale preparation is caught before the freeze can bind.
  await assert.rejects(() => freezeEqualHandoverReport(input), as409(/stale preparation cannot freeze/));

  const reprepared = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: "task completed after review" });
  assert.equal(reprepared.preparation.preparationRevision, 2);
  assert.deepEqual(reprepared.preparation.content.pendingTasks, []);
  assert.equal(reprepared.preparation.content.terminalTaskEvidence.length, 1);
  const terminal = reprepared.preparation.content.terminalTaskEvidence[0];
  assert.equal(terminal.status, "completed");
  assert.match(terminal.workHash, /^[0-9a-f]{64}$/);

  const current = await v2Binding(f);
  const frozen = await freezeEqualHandoverReport(freezeInputFor(f, f.out[0], reprepared.preparation, current, "Freeze after terminal transition"));
  assert.equal(frozen.replayed, false);
  assert.equal(frozen.report.content.terminalTaskEvidence.length, 1);

  // A terminal-content change after the freeze is detected the same way: the
  // next preparation must carry a new digest.
  await sleep();
  await ref("tasks", task.id).update({ title: "Retitled terminal task", updatedAt: new Date().toISOString() });
  const drifted = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "terminal title drift" });
  assert.equal(drifted.replayed, false);
  assert.equal(drifted.preparation.preparationRevision, 3);
  assert.notEqual(drifted.preparation.contentDigest, reprepared.preparation.contentDigest);
});

test("22. Freeze authority: only an outgoing reserved technician with a clean profile may freeze", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const input = await reviewedFreezeInput(f, f.out[0]);
  const before = await operationalState();
  for (const actorUid of [f.incoming[0], f.incoming[1], f.unrelated, f.manager]) {
    await assert.rejects(() => freezeEqualHandoverReport({ ...input, actorUid }), as403(/outgoing reserved technician|not authorized/));
  }
  await ref("users", f.out[0]).update({ mustChangePassword: true });
  await assert.rejects(() => freezeEqualHandoverReport(input), as403(/not authorized/));
  await ref("users", f.out[0]).update({ mustChangePassword: false });
  assert.deepEqual(await operationalState(), before, "a refused freeze must not mutate any operational state");
  assert.equal((await reportsState()).length, 0);
});

test("23. Freeze requires a preparation and is refused once the reservation leaves the collecting lifecycle", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const binding = await v2Binding(f);
  await assert.rejects(() => freezeEqualHandoverReport({
    outgoingShiftId: f.outgoing, actorUid: f.out[0],
    expectedRevision: binding.aggregate.revision, expectedSnapshotHash: binding.snapshotHash,
    expectedGuardRevision: binding.guard.guardRevision, expectedFencingEpoch: binding.guard.fencingEpoch,
    preparationRevision: 1, contentDigest: "a".repeat(64), evidenceSnapshotHash: "b".repeat(64),
    workSnapshotVersion: "c".repeat(64), reason: "No preparation exists", correctionNote: null,
  }), as409(/Prepare and review/));

  const input = await reviewedFreezeInput(f, f.out[0]);
  await cancelEqualHandoverReservationForTechnicians({
    outgoingShiftId: f.outgoing, actorUid: f.out[1],
    expectedRevision: input.expectedRevision, expectedSnapshotHash: input.expectedSnapshotHash,
    reason: "Abort before freeze",
  });
  await assert.rejects(() => freezeEqualHandoverReport(input), as409(/lifecycle does not permit report freezing/));
  assert.equal((await reportsState()).length, 0);
});

test("24. The freeze transaction never completes the handover: no confirmations, no incoming shift, no control advance, no attendance finalization", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  const input = await reviewedFreezeInput(f, f.out[0]);
  const before = await operationalState();
  const frozen = await freezeEqualHandoverReport(input);

  const stored = await getV2Document(f);
  assert.equal(stored.lifecycleStatus, "collecting_confirmations");
  assert.deepEqual(stored.confirmations, []);
  assert.deepEqual(stored.historicalConfirmations, []);

  const shiftIds = (await collectionState("shifts")).map(([id]) => id);
  assert.ok(!shiftIds.includes(stored.reservation.reservedIncomingShiftId), "the freeze must not create the incoming shift");
  assert.equal(shiftIds.length, 1);

  // Only the v2 aggregate, the report document and its audit may differ from
  // the pre-freeze snapshot.
  const after = await operationalState();
  assert.deepEqual(after.shifts, before.shifts);
  assert.deepEqual(after.operationalShiftControl, before.operationalShiftControl);
  assert.deepEqual(after.guards, before.guards, "the freeze must not advance the shared guard");
  assert.deepEqual(after.guardHistory, before.guardHistory);
  assert.deepEqual(after.technicianSchedules, before.technicianSchedules);
  assert.deepEqual(after.shiftMembers, before.shiftMembers);
  assert.deepEqual(after.handovers, before.handovers, "v1 handover aggregates are untouched");
  assert.deepEqual(after.handoverTransfers, before.handoverTransfers);
  assert.deepEqual(after.attendanceV2, before.attendanceV2, "the freeze never finalizes attendance evidence");
  assert.deepEqual(after.attendanceOperationsV2, before.attendanceOperationsV2);
  assert.deepEqual(after.attendanceLegacy, before.attendanceLegacy);
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(after.operationEvents, before.operationEvents);
  assert.deepEqual(after.preparations, before.preparations, "the freeze rewrites no preparation document");

  const newAudits = after.auditLogs.filter(([id]) => !before.auditLogs.some(([existingId]) => existingId === id));
  assert.equal(newAudits.length, 1);
  assert.equal(newAudits[0][1].action, "EQUAL_HANDOVER_REPORT_FROZEN_V2");
  assert.equal(frozen.report.content.staff.incomingShiftId, stored.reservation.reservedIncomingShiftId);
});

test("25. A correction freezes a new immutable version; the earlier report document is never rewritten", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  // A terminal task keeps the report blocker-free while still providing
  // authoritative work content whose correction must be detectable.
  const task = await seedTask(f, "completed");
  const first = await freezeEqualHandoverReport(await reviewedFreezeInput(f, f.out[0], { reason: "Initial consolidated review" }));
  const v1Bytes = JSON.stringify((await ref("handover_reports_v2", first.report.id).get()).data());

  await sleep();
  await ref("tasks", task.id).update({ title: "Corrected description of work", updatedAt: new Date().toISOString() });

  // Wrong preparation stamps cannot freeze even against a fresh binding.
  const afterFirst = await v2Binding(f);
  await assert.rejects(() => freezeEqualHandoverReport({
    outgoingShiftId: f.outgoing, actorUid: f.out[1],
    expectedRevision: afterFirst.aggregate.revision, expectedSnapshotHash: afterFirst.snapshotHash,
    expectedGuardRevision: afterFirst.guard.guardRevision, expectedFencingEpoch: afterFirst.guard.fencingEpoch,
    preparationRevision: 99, contentDigest: "d".repeat(64), evidenceSnapshotHash: "d".repeat(64),
    workSnapshotVersion: "d".repeat(64), reason: "wrong stamps", correctionNote: null,
  }), as409(/preparation revision changed/));

  const secondInput = await reviewedFreezeInput(f, f.out[1], { reason: "Corrected after title fix" });
  await assert.rejects(() => freezeEqualHandoverReport({ ...secondInput, correctionNote: null }),
    as400(/requires an explicit correction note/));
  const second = await freezeEqualHandoverReport({ ...secondInput, correctionNote: "Task title was corrected after the first freeze." });

  assert.equal(second.report.version, 2);
  assert.equal(second.report.supersedesReportId, first.report.id);
  assert.equal(second.replayed, false);
  assert.deepEqual((await reportsState()).map(([id]) => id).sort(), [first.report.id, second.report.id].sort());
  assert.equal(JSON.stringify((await ref("handover_reports_v2", first.report.id).get()).data()), v1Bytes,
    "§9: previously frozen report content is never rewritten");

  const stored = await getV2Document(f);
  assert.equal(stored.reportBinding.id, second.report.id);
  assert.equal(stored.reportBinding.preparationRevision, 2);
  const audit = (await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).find(([, event]) => event.reportVersion === 2)[1];
  assert.equal(audit.supersedesReportId, first.report.id);
  assert.equal(audit.correctionNote, "Task title was corrected after the first freeze.");

  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.frozenReport.version, 2);
  assert.equal(state.preparationDrifted, false);
});

test("26. An absence invalidates the prepared review; a later clear restores the reviewed content and the replay refresh still allows a clean freeze", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  const first = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null });
  const binding = await v2Binding(f);

  await recordEqualHandoverAbsenceV2(absenceBase(f, binding, f.incoming[0]));
  const afterDeclare = await v2Binding(f);
  await assert.rejects(() => freezeEqualHandoverReport({
    ...freezeInputFor(f, f.out[0], first.preparation, afterDeclare, "attempt with absence"),
  }), as409(/reservation changed after this report was prepared/));

  const cleared = await clearEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: f.incoming[0],
    expectedRevision: afterDeclare.aggregate.revision, expectedSnapshotHash: afterDeclare.snapshotHash });
  const refreshed = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: null });
  assert.equal(refreshed.replayed, true, "content identical to the reviewed revision replays without a revision bump");
  assert.equal(refreshed.preparation.preparationRevision, 1);
  assert.equal(refreshed.preparation.aggregateRevision, cleared.aggregate.revision, "review stamps refresh to the current revision");

  const current = await v2Binding(f);
  const frozen = await freezeEqualHandoverReport(freezeInputFor(f, f.out[0], refreshed.preparation, current, "Freeze after cleared absence"));
  assert.equal(frozen.replayed, false);
  assert.deepEqual(frozen.report.content.absences, []);
  assert.equal(frozen.report.preparationRevision, 1);
});

// ---------------------------------------------------------------------------
// Read view and schema separation
// ---------------------------------------------------------------------------

test("27. Read view: outgoing participate fully, incoming and supervisors read only, non-participants are refused; reads mutate nothing", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const { preparation } = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null });

  const before = await operationalState();
  const incomingView = await readEqualHandoverReportState(f.outgoing, f.incoming[0]);
  assert.equal(incomingView.preparation.contentDigest, preparation.contentDigest);
  assert.equal(incomingView.guard.protocolOwner, "v2");
  assert.equal(incomingView.frozenReport, null);
  assert.equal(incomingView.preparationDrifted, false);

  const managerView = await readEqualHandoverReportState(f.outgoing, f.manager);
  assert.equal(managerView.aggregate.reservation.handoverId, preparation.content.reservationId);
  assert.equal(managerView.preparationDrifted, false);
  await assert.rejects(() => readEqualHandoverReportState(f.outgoing, f.unrelated), as403(/belongs to another shift/));
  await assert.rejects(() => readEqualHandoverReportState(f.outgoing, "ghost-user"), as403(/cannot access this report/));
  await assert.rejects(() => readEqualHandoverReportState("missing-shift", f.out[0]), expectsStatus(AssignmentOperationError, 404));
  assert.deepEqual(await operationalState(), before, "reads must not stamp activity or write documents");
});

test("28. A v1-shaped report binding can never validate as a v2 binding; v2 report documents use dedicated collections", async () => {
  const v1Shaped = {
    schema: "handover-report-v1",
    id: "report_v1_legacy",
    digest: "a".repeat(64),
    evidenceSnapshotHash: "b".repeat(64),
    workSnapshotVersion: "c".repeat(64),
    preparationId: "preparation_x",
    preparationRevision: 1,
    reservationId: `handover_v2_${"d".repeat(64)}`,
    aggregateRevision: 1,
    fencingEpoch: 1,
    frozenBy: "someone",
    frozenAt: historical,
  };
  assert.throws(() => assertEqualHandoverReportV2Binding(v1Shaped), EqualHandoverReportDomainError);
  // A relabeled v2 schema must still fail: the report document id and the
  // reservation fingerprint carry the v2 shape contract.
  assert.throws(() => assertEqualHandoverReportV2Binding({ ...v1Shaped, schema: "handover-report-v2" }),
    EqualHandoverReportDomainError);
  assert.notEqual(createEqualHandoverDocumentId("shift-1"), createHandoverDocumentId("shift-1"),
    "the v2 aggregate location is distinct from the v1 stable document");
});

// ---------------------------------------------------------------------------
// §11 — reservation compatibility
// ---------------------------------------------------------------------------

test("29. Replacement fails closed once a frozen report is bound; cancellation preserves the report and its audit", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  const frozen = await freezeEqualHandoverReport(await reviewedFreezeInput(f, f.out[0], { prepareReason: null }));
  await addEligiblePair(f.outgoing, `${f.outgoing}-newpair`, [`${f.outgoing}-newa`, `${f.outgoing}-newb`]);
  const binding = await v2Binding(f);
  await assert.rejects(
    () => replaceEqualHandoverReservationForTechnicians({
      outgoingShiftId: f.outgoing, actorUid: f.out[1],
      incomingPermanentPairId: `${f.outgoing}-newpair`, shiftType: "morning", scheduledStart, scheduledEnd,
      expectedRevision: binding.aggregate.revision, expectedSnapshotHash: binding.snapshotHash,
    }),
    as409(/Unexpected report or confirmation evidence/),
  );

  await cancelEqualHandoverReservationForTechnicians({
    outgoingShiftId: f.outgoing, actorUid: f.out[0],
    expectedRevision: binding.aggregate.revision, expectedSnapshotHash: binding.snapshotHash,
    reason: "Cycle ended after freeze",
  });
  const stored = await getV2Document(f);
  assert.equal(stored.lifecycleStatus, "cancelled");
  assert.equal(stored.reportBinding.id, frozen.report.id, "cancellation keeps the frozen report bound for auditability");
  assert.ok((await ref("handover_reports_v2", frozen.report.id).get()).exists);
  assert.equal((await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).length, 1);
  await assert.rejects(() => prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null }),
    as409(/lifecycle does not permit/));
});

// ---------------------------------------------------------------------------
// Concurrency and size limits
// ---------------------------------------------------------------------------

test("30. Concurrent preparation by both outgoing technicians settles deterministically on one document", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const results = await Promise.all([
    prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null }),
    prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: null }),
  ]);
  const docs = await collectionState("handover_report_preparations_v2");
  assert.equal(docs.length, 1);
  assert.equal(docs[0][1].preparationRevision, 1);
  assert.equal(results.filter((result) => result.replayed === false).length, 1);
  assert.equal((await auditsByAction("EQUAL_HANDOVER_REPORT_PREPARED_V2")).length, 1);
});

test("31. Oversized evidence is rejected (413), never truncated, and nothing is persisted", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const eventId = randomUUID();
  const event = {
    id: eventId, recordId: eventId, shiftId: f.outgoing, revision: 1,
    kind: "incident", category: "fault", title: "Oversized incident",
    description: "x".repeat(900_000), location: "Studio", actionTaken: "None",
    status: "open", severity: "low", linkedTaskId: null, occurredAt: "2020-01-01T03:00:00.000Z",
    authorUid: f.out[0], authorName: "Ada Out-A",
    originalReporterUid: f.out[0], originalReporterName: "Ada Out-A",
    createdAt: "2020-01-01T03:00:01.000Z", provenance: "authenticated_technician",
  };
  await ref("shift_operation_events", eventId).set(event);
  await ref("shift_operation_heads", eventId).set(event);
  const before = await operationalState();
  await assert.rejects(
    () => prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: null }),
    as413(),
  );
  const after = await operationalState();
  assert.equal(after.preparations.length, 0, "the oversized preparation is rejected before any write");
  assert.deepEqual(after.equalHandoversV2, before.equalHandoversV2);
  assert.deepEqual(after.auditLogs, before.auditLogs);
});

// ---------------------------------------------------------------------------
// §12 — route surface (real route modules, session boundary stubbed only)
// ---------------------------------------------------------------------------

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

const reportRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/report/route.ts",
);
const absenceRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/absence/route.ts",
);
const freezeRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/report/freeze/route.ts",
);

test("32. With HANDOVER_V2_DEV absent or false every v2 report route returns 404 and executes no workflow", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const before = await operationalState();
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2`;
  const params = { params: Promise.resolve({ shiftId: f.outgoing }) };
  for (const flag of [undefined, "false"]) {
    if (flag === undefined) delete process.env.HANDOVER_V2_DEV;
    else process.env.HANDOVER_V2_DEV = flag;
    const post = await reportRoute.POST(
      new NextRequest(`${base}/report`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: '{"reason":null}' }), params);
    assert.equal(post.status, 404);
    const get = await reportRoute.GET(
      new NextRequest(`${base}/report`, { method: "GET", headers: { origin: "http://localhost:3000" } }), params);
    assert.equal(get.status, 404);
    assert.equal((await get.json()).error, "Not found.");
    const absence = await absenceRoute.POST(
      new NextRequest(`${base}/absence`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }), params);
    assert.equal(absence.status, 404);
    const clear = await absenceRoute.DELETE(
      new NextRequest(`${base}/absence`, { method: "DELETE", headers: { origin: "http://localhost:3000" }, body: "{}" }), params);
    assert.equal(clear.status, 404);
    const freeze = await freezeRoute.POST(
      new NextRequest(`${base}/freeze`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }), params);
    assert.equal(freeze.status, 404);
  }
  assert.deepEqual(await operationalState(), before, "a disabled gate must not execute any report workflow");
});

test("33. Enabled mutation routes answer 401 without a session and 403 for a foreign origin, always no-store", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  process.env.HANDOVER_V2_DEV = "true";
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2`;
  const params = { params: Promise.resolve({ shiftId: f.outgoing }) };
  try {
    for (const [route, path, method] of [
      [reportRoute, "/report", "POST"], [absenceRoute, "/absence", "POST"],
      [absenceRoute, "/absence", "DELETE"], [freezeRoute, "/freeze", "POST"],
    ]) {
      const request = new NextRequest(`${base}${path}`, { method, headers: { origin: "http://localhost:3000" }, body: "{}" });
      const response = await route[method](request, params);
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const foreign = await route[method](
        new NextRequest(`${base}${path}`, { method, headers: { origin: "http://evil.example" }, body: "{}" }), params);
      assert.equal(foreign.status, 401, "the session gate precedes the origin check");
    }

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    const foreignOrigin = await reportRoute.POST(
      new NextRequest(`${base}/report`, { method: "POST", headers: { origin: "http://evil.example" }, body: '{"reason":null}' }), params);
    assert.equal(foreignOrigin.status, 403);
    assert.equal((await foreignOrigin.json()).error, "Invalid request origin.");
    const foreignFreeze = await freezeRoute.POST(
      new NextRequest(`${base}/freeze`, { method: "POST", headers: { origin: "https://evil.example:8443" }, body: "{}" }), params);
    assert.equal(foreignFreeze.status, 403);
    const foreignAbsence = await absenceRoute.POST(
      new NextRequest(`${base}/absence`, { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" }), params);
    assert.equal(foreignAbsence.status, 403);
  } finally {
    routeSessionUser = null;
    delete process.env.HANDOVER_V2_DEV;
  }
});

test("34. Supervisor and forced-password sessions are refused mutation routes; supervisors may still read", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  process.env.HANDOVER_V2_DEV = "true";
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2`;
  const params = { params: Promise.resolve({ shiftId: f.outgoing }) };
  try {
    routeSessionUser = { uid: f.manager, role: "supervisor", mustChangePassword: false };
    const prepare = await reportRoute.POST(
      new NextRequest(`${base}/report`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: '{"reason":null}' }), params);
    assert.equal(prepare.status, 403);
    assert.equal((await prepare.json()).error, "A supervisor cannot prepare or freeze a v2 handover report.");
    const freeze = await freezeRoute.POST(
      new NextRequest(`${base}/freeze`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }), params);
    assert.equal(freeze.status, 403);
    assert.equal((await freeze.json()).error, "Your account is not authorized to freeze v2 handover reports.");
    const absence = await absenceRoute.POST(
      new NextRequest(`${base}/absence`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }), params);
    assert.equal(absence.status, 403);
    assert.equal((await absence.json()).error, "Your account is not authorized to declare handover absences.");

    const read = await reportRoute.GET(
      new NextRequest(`${base}/report`, { method: "GET", headers: { origin: "http://localhost:3000" } }), params);
    assert.equal(read.status, 200);
    const payload = await read.json();
    assert.equal(payload.success, true);
    assert.equal(payload.report.aggregate.reservation.handoverId, (await v2Binding(f)).aggregate.reservation.handoverId);

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: true };
    const forced = await reportRoute.POST(
      new NextRequest(`${base}/report`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: '{"reason":null}' }), params);
    assert.equal(forced.status, 403);
    assert.equal((await forced.json()).error, "Change your password before using handover reports.");
    const forcedAbsence = await absenceRoute.POST(
      new NextRequest(`${base}/absence`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }), params);
    assert.equal(forcedAbsence.status, 403);
    const forcedFreeze = await freezeRoute.POST(
      new NextRequest(`${base}/freeze`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }), params);
    assert.equal(forcedFreeze.status, 403);
    assert.equal((await preparationDoc(f)).exists, false, "the session gate precedes any workflow");
  } finally {
    routeSessionUser = null;
    delete process.env.HANDOVER_V2_DEV;
  }
});

test("35. Route end-to-end: prepare, absence record/clear, freeze 201 then replay 200, verified against stored documents", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  process.env.HANDOVER_V2_DEV = "true";
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2`;
  const params = { params: Promise.resolve({ shiftId: f.outgoing }) };
  try {
    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    const post = async (route, path, body, method = "POST") => route[method](
      new NextRequest(`${base}${path}`, { method, headers: { origin: "http://localhost:3000" }, body: JSON.stringify(body) }), params);

    const prepared = await post(reportRoute, "/report", { reason: "route review" });
    assert.equal(prepared.status, 200);
    const preparedBody = await prepared.json();
    assert.equal(preparedBody.replayed, false);
    assert.equal(preparedBody.preparation.preparedBy, f.out[0], "the actor UID is server-derived, never body-supplied");

    const binding = await v2Binding(f);
    const declared = await post(absenceRoute, "/absence", {
      technicianUid: f.incoming[0], absenceType: "not_yet_in", reason: "Arriving late", reportedDepartureTime: null,
      expectedRevision: binding.aggregate.revision, expectedSnapshotHash: binding.snapshotHash,
    });
    assert.equal(declared.status, 200);
    const declaredBody = await declared.json();
    assert.equal(declaredBody.reservation.aggregate.absences.length, 1);

    const absentPrep = await post(reportRoute, "/report", { reason: "absence reviewed" });
    const absentPrepBody = await absentPrep.json();
    assert.equal(absentPrepBody.preparation.preparationRevision, 2);
    assert.equal(absentPrepBody.preparation.content.absences.length, 1);

    const cleared = await post(absenceRoute, "/absence", {
      technicianUid: f.incoming[0],
      expectedRevision: declaredBody.reservation.aggregate.revision, expectedSnapshotHash: declaredBody.reservation.snapshotHash,
    }, "DELETE");
    assert.equal(cleared.status, 200);

    // The absence was cleared, so this is a third reviewed revision whose
    // content matches the first one but whose chain continues from revision 2.
    const restored = await post(reportRoute, "/report", { reason: "absence cleared" });
    const restoredBody = await restored.json();
    assert.equal(restoredBody.replayed, false);
    assert.equal(restoredBody.preparation.preparationRevision, 3);

    const current = await v2Binding(f);
    const preparation = restoredBody.preparation;
    const freezeBody = {
      expectedRevision: current.aggregate.revision, expectedSnapshotHash: current.snapshotHash,
      expectedGuardRevision: current.guard.guardRevision, expectedFencingEpoch: current.guard.fencingEpoch,
      preparationRevision: preparation.preparationRevision, contentDigest: preparation.contentDigest,
      evidenceSnapshotHash: preparation.evidenceSnapshotHash, workSnapshotVersion: preparation.workSnapshotVersion,
      reason: "Route-level freeze", correctionNote: null,
    };
    const frozen = await post(freezeRoute, "/freeze", freezeBody);
    assert.equal(frozen.status, 201);
    const frozenBody = await frozen.json();
    assert.equal(frozenBody.replayed, false);
    assert.ok((await ref("handover_reports_v2", frozenBody.report.id).get()).exists);

    const replay = await post(freezeRoute, "/freeze", freezeBody);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    assert.equal((await reportsState()).length, 1);

    const badBody = await post(reportRoute, "/report", { reason: null, actorUid: f.unrelated });
    assert.equal(badBody.status, 400);
    assert.equal((await badBody.json()).error, "Missing or unsupported report request fields.");
    const malformed = await reportRoute.POST(
      new NextRequest(`${base}/report`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "not json" }), params);
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, "Invalid report JSON.");
  } finally {
    routeSessionUser = null;
    delete process.env.HANDOVER_V2_DEV;
  }
});

test("36. Strict body parsers reject missing, extra, malformed or oversized fields before any service call", () => {
  const hex64 = "a".repeat(64);
  assert.deepEqual(parsePrepareBody({ reason: null }), { reason: null });
  assert.deepEqual(parsePrepareBody({ reason: "reviewed" }), { reason: "reviewed" });
  assert.throws(() => parsePrepareBody({}), as400(/Missing or unsupported/));
  assert.throws(() => parsePrepareBody({ reason: null, extra: 1 }), as400(/Missing or unsupported/));
  assert.throws(() => parsePrepareBody({ reason: 5 }), as400(/preparation reason/));
  assert.throws(() => parsePrepareBody(null), as400(/Invalid report request/));

  const absenceOk = { technicianUid: "tech-1", absenceType: "not_yet_in", reason: "Late", reportedDepartureTime: historical,
    expectedRevision: 3, expectedSnapshotHash: hex64 };
  assert.equal(parseAbsenceRecordBody(absenceOk).technicianUid, "tech-1");
  assert.throws(() => parseAbsenceRecordBody({ ...absenceOk, absenceType: "ghosted" }), as400(/Unsupported absence type/));
  assert.throws(() => parseAbsenceRecordBody({ ...absenceOk, reportedDepartureTime: "2020-01-01 00:00" }), as400(/canonical UTC/));
  assert.throws(() => parseAbsenceRecordBody({ ...absenceOk, technicianUid: "bad/../uid" }), as400(/technician UID/));
  assert.throws(() => parseAbsenceRecordBody({ ...absenceOk, expectedRevision: 0 }), as400(/expected revision/));
  assert.throws(() => parseAbsenceRecordBody({ ...absenceOk, reason: "x".repeat(1_001) }), as400(/absence reason/));
  assert.throws(() => parseAbsenceClearBody({ technicianUid: "tech-1", expectedRevision: 1 }), as400(/Missing or unsupported/));

  const freezeOk = { expectedRevision: 1, expectedSnapshotHash: hex64, expectedGuardRevision: 1, expectedFencingEpoch: 1,
    preparationRevision: 1, contentDigest: hex64, evidenceSnapshotHash: hex64, workSnapshotVersion: hex64,
    reason: "freeze", correctionNote: null };
  assert.equal(parseFreezeBody(freezeOk).preparationRevision, 1);
  assert.throws(() => parseFreezeBody({ ...freezeOk, contentDigest: "short" }), as400(/content digest/));
  assert.throws(() => parseFreezeBody({ ...freezeOk, expectedFencingEpoch: -1 }), as400(/fencing epoch/));
  assert.throws(() => parseFreezeBody({ ...freezeOk, reason: "" }), as400(/freeze reason/));
  assert.throws(() => parseFreezeBody({ ...freezeOk, correctionNote: "x".repeat(4_001) }), as400(/correction note/));
});

// ---------------------------------------------------------------------------
// §13 — workspace gating
// ---------------------------------------------------------------------------

test("37. The technician workspace lists v2 handovers only while the development gate is enabled; managers never see v2 entries", async () => {
  await clearDb();
  const f = await makeReservedFixture();
  const actor = (uid, role) => ({ uid, role, mustChangePassword: false });

  const closed = await getHandoverWorkspace(actor(f.out[0], "technician"));
  assert.deepEqual(closed.v2Reports, []);

  process.env.HANDOVER_V2_DEV = "true";
  try {
    const open = await getHandoverWorkspace(actor(f.out[0], "technician"));
    assert.equal(open.v2Reports.length, 1);
    assert.equal(open.v2Reports[0].shiftId, f.outgoing);
    assert.equal(open.v2Reports[0].status, "collecting_confirmations");

    // The currently reserved incoming pair may see the entry (read-only).
    const incomingView = await getHandoverWorkspace(actor(f.incoming[1], "technician"));
    assert.equal(incomingView.v2Reports.length, 1);

    const managerView = await getHandoverWorkspace(actor(f.manager, "supervisor"));
    assert.deepEqual(managerView.v2Reports, []);
    assert.ok(managerView.pairs.length >= 1);
  } finally {
    delete process.env.HANDOVER_V2_DEV;
  }
  const hidden = await getHandoverWorkspace(actor(f.out[0], "technician"));
  assert.deepEqual(hidden.v2Reports, []);
  assert.equal(OPERATIONAL_COLLECTIONS.HANDOVER_REPORT_PREPARATIONS_V2, "handover_report_preparations_v2");
  assert.equal(OPERATIONAL_COLLECTIONS.HANDOVER_REPORTS_V2, "handover_reports_v2");
  assert.equal(getOperationalCollections().handoverReportsV2.id, "handover_reports_v2");
});

test("38. Preparation and report documents live only in the dedicated v2 collections; the preparation is keyed by the reservation fingerprint", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  const binding = await v2Binding(f);
  const fingerprint = binding.aggregate.reservation.handoverId;
  const frozen = await freezeEqualHandoverReport(await reviewedFreezeInput(f, f.out[1], { prepareReason: null }));
  assert.deepEqual((await collectionState("handover_report_preparations_v2")).map(([id]) => id), [`preparation_${fingerprint}`]);
  assert.deepEqual((await reportsState()).map(([id]) => id), [frozen.report.id]);
  assert.equal((await collectionState("handovers")).length, 0, "no v1 handover aggregate is involved in the v2 flow");
  const doc = await preparationDoc(f);
  assert.equal(doc.data.reservationId, fingerprint);
  assert.notEqual(fingerprint, createEqualHandoverDocumentId(f.outgoing),
    "the preparation is keyed by the reservation fingerprint, never the Firestore document id");
  assert.equal(createEqualHandoverId(assertEqualHandoverAggregate(await getV2Document(f)).identity), fingerprint);
});

test("39. §14.9 Work-readiness blockers prevent freeze: an incomplete reviewed report can never be frozen", async () => {
  await clearDb();
  const incomplete = await makeReservedFixture({ ops: "none" });
  const incompleteInput = await reviewedFreezeInput(incomplete, incomplete.out[0]);
  const before = await operationalState();
  await assert.rejects(() => freezeEqualHandoverReport(incompleteInput),
    as409(/Report is incomplete: Missing verified broadcast observation: Joy FM/));
  assert.deepEqual(await reportsState(), [], "a blocked freeze writes no report document");
  assert.equal((await getV2Document(incomplete)).reportBinding, null);
  assert.deepEqual(await operationalState(), before, "the refused freeze mutates nothing");

  // An unclassified pending task blocks the freeze even with complete
  // operational coverage, and resolving the task to terminal evidence clears it.
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  const task = await seedTask(f);
  const taskInput = await reviewedFreezeInput(f, f.out[0]);
  await assert.rejects(() => freezeEqualHandoverReport(taskInput),
    as409(/Report is incomplete: Pending task .*: unclassified/));
  assert.deepEqual(await reportsState(), []);

  await sleep();
  await ref("tasks", task.id).update({ status: "completed", updatedAt: new Date().toISOString() });
  const resolved = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: "task resolved" });
  assert.deepEqual(resolved.preparation.blockers, []);
  const frozen = await freezeEqualHandoverReport(
    freezeInputFor(f, f.out[0], resolved.preparation, await v2Binding(f), "Freeze after work resolution"));
  assert.equal(frozen.replayed, false);
  assert.equal(frozen.report.content.completeness.blockers.length, 0);
  assert.equal((await reportsState()).length, 1);
});

// ---------------------------------------------------------------------------
// §7 read-view drift authority after a freeze
// ---------------------------------------------------------------------------

test("40. Read view flags evidence that changes after a freeze as drift; the completed freeze replays and only a fresh review creates version 2", async () => {
  await clearDb();
  const f = await makeReservedFixture({ ops: "full" });
  await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "initial review" });
  await recordEqualHandoverAbsenceV2(absenceBase(f, await v2Binding(f), f.incoming[0]));
  const reviewed = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: "review with the declaration" });
  assert.equal(reviewed.preparation.preparationRevision, 2);

  const first = await freezeEqualHandoverReport(
    freezeInputFor(f, f.out[0], reviewed.preparation, await v2Binding(f), "Initial consolidated review"));
  assert.deepEqual(first.report.content.absences.map((item) => item.technicianUid), [f.incoming[0]]);
  const firstBytes = JSON.stringify((await ref("handover_reports_v2", first.report.id).get()).data());
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[0])).preparationDrifted, false,
    "a freeze that consumed the reviewed preparation is not drift");

  // Withdrawing the declaration moves the live evidence away from the frozen
  // review, so the read view must flag it exactly like the freeze authority does.
  await sleep();
  const beforeClear = await v2Binding(f);
  await clearEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], technicianUid: f.incoming[0],
    expectedRevision: beforeClear.aggregate.revision, expectedSnapshotHash: beforeClear.snapshotHash });
  const drifted = await readEqualHandoverReportState(f.outgoing, f.out[1]);
  assert.equal(drifted.preparationDrifted, true, "evidence changed after a freeze must flag the reviewed preparation as stale");

  // Replaying the completed freeze request stays idempotent: the same immutable
  // version is returned and no second version, binding change or audit appears.
  const replay = await freezeEqualHandoverReport(
    freezeInputFor(f, f.out[1], drifted.preparation, await v2Binding(f), "replay after the withdrawal"));
  assert.equal(replay.replayed, true);
  assert.equal(replay.report.id, first.report.id);
  assert.equal((await reportsState()).length, 1, "a replay writes no second version");
  assert.equal((await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).length, 1);
  assert.equal(JSON.stringify((await ref("handover_reports_v2", first.report.id).get()).data()), firstBytes,
    "§9: replaying never rewrites a frozen report");

  // The withdrawal only becomes report evidence after a fresh review.
  await sleep();
  const corrected = await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: "review after the withdrawal" });
  assert.equal(corrected.preparation.preparationRevision, 3);
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[0])).preparationDrifted, false);
  const secondInput = freezeInputFor(f, f.out[0], corrected.preparation, await v2Binding(f), "Corrected after the withdrawal");
  await assert.rejects(() => freezeEqualHandoverReport(secondInput), as400(/requires an explicit correction note/));
  const second = await freezeEqualHandoverReport({
    ...secondInput, correctionNote: "The incoming colleague reached the suite; the declaration was withdrawn.",
  });
  assert.equal(second.report.version, 2);
  assert.equal(second.report.supersedesReportId, first.report.id);
  assert.deepEqual(second.report.content.absences, []);
  assert.deepEqual(first.report.content.absences.map((item) => item.technicianUid), [f.incoming[0]]);
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[1])).preparationDrifted, false);
  assert.equal(JSON.stringify((await ref("handover_reports_v2", first.report.id).get()).data()), firstBytes,
    "§9: the earlier frozen version is never rewritten by a later correction");
});
