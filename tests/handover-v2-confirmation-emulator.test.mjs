/**
 * Firestore emulator integration tests for equal-technician v2 handover
 * participant CONFIRMATIONS and authoritative READINESS
 * (TECH-HO-RECOVERY-06 §11): authenticated self-confirmations, immutable frozen
 * report-version binding, absence-aware readiness, concurrency/idempotency and
 * supersession invalidation.
 *
 * Run via: tests/run-handover-v2-confirmation-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-handover-v2" on the
 * dedicated report-emulator port 8092 with synthetic accounts only. The suite
 * refuses to run against any other project or host, and refuses to run with the
 * development feature flag preset; the route-gate tests set and clear it around
 * the handler invocation only.
 *
 * Every assertion targets final persisted Firestore documents and audit
 * evidence, not only service return values. The suite invokes the real
 * production writers — there is no parallel fake dataset. This milestone never
 * completes a transfer, creates the incoming shift or finalizes attendance, and
 * the tests prove those collections stay byte-unchanged.
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
  throw new Error("Refusing to run v2 confirmation emulator tests outside the isolated demo emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The v2 confirmation emulator suite must exercise services directly, with no dev feature flag.");
}
const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const {
  initializeEqualHandoverReservation,
  cancelEqualHandoverReservationForTechnicians,
  readEqualHandoverReservation,
} = await import("../src/lib/operations/equal-handover-reservation-firestore.ts");
const { createEqualHandoverDocumentId } = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const { EQUAL_HANDOVER_READINESS_REASONS } = await import("../src/lib/operations/equal-handover-readiness-domain.ts");
const {
  prepareEqualHandoverReport,
  readEqualHandoverReportState,
  recordEqualHandoverAbsenceV2,
  clearEqualHandoverAbsenceV2,
  freezeEqualHandoverReport,
  confirmEqualHandoverParticipantV2,
} = await import("../src/lib/operations/equal-handover-report-firestore.ts");
const { parseConfirmBody } = await import("../src/lib/operations/handover-v2-report-http.ts");
const { OPERATIONAL_COLLECTIONS } = await import("../src/lib/operations/collections.ts");
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");
const { recordShiftOperation } = await import("../src/lib/operations/shift-operations.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { EqualHandoverDomainError } = await import("../src/lib/operations/equal-technician-handover-domain.ts");

const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);

const historical = "2020-01-01T00:00:00.000Z";
const scheduledStart = "2030-01-01T06:00:00.000Z";
const scheduledEnd = "2030-01-01T14:00:00.000Z";
let seq = 0;
let routeSessionUser = null;

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

async function makeActiveShiftFixture() {
  const prefix = `v2c${++seq}`;
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
  batch.set(ref("users", f.manager), { uid: f.manager, fullName: `${prefix} Max Manager`, role: "supervisor", status: "active", statusOperation: null, mustChangePassword: false });
  for (const uid of [...f.out, ...f.incoming]) {
    batch.set(ref("users", uid), { uid, fullName: `${prefix} ${uid}`, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
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
  batch.set(ref("shifts", f.outgoing), {
    id: f.outgoing, status: "active", permanentPairId: f.outPair, primaryTechnicianIds: f.out,
    operationalSlotToken: f.token, shiftType: "morning", scheduledStart, scheduledEnd,
    actualStart: historical, actualEnd: null, createdBy: f.manager, createdAt: historical, updatedAt: historical,
  });
  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(f.token, 1, historical), f.outgoing, historical);
  control = transitionOperationalShiftControl(control, f.outgoing, "scheduled", "active", historical);
  batch.set(ref("operational_shift_control", "global"), control);
  for (const uid of f.out) {
    const memberId = `${f.outgoing}_${uid}`;
    batch.set(ref("shift_members", memberId), { id: memberId, shiftId: f.outgoing, technicianId: uid, role: "primary", joinedAt: historical, leftAt: null });
    batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [{ shiftId: f.outgoing, scheduledStart, scheduledEnd, status: "active" }], updatedAt: historical });
  }
  for (const uid of f.incoming) {
    batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [{ shiftId: "unrelated-shift", scheduledStart: "2030-01-03T06:00:00.000Z", scheduledEnd: "2030-01-03T14:00:00.000Z", status: "scheduled" }], updatedAt: historical });
  }
  await batch.commit();
  return f;
}

// Broadcast + outside-broadcast evidence clears the completeness blockers so a
// report can be frozen and therefore confirmed.
async function recordBroadcasts(f) {
  await seedLegacyAttendance(f, f.out[0]);
  const actor = { uid: f.out[0], role: "technician" };
  const at = (minute) => `2020-01-01T0${minute}:00:00.000Z`;
  for (const [index, stationId] of ["joy-fm", "adom-fm", "asempa-fm", "hitz-fm"].entries()) {
    await recordShiftOperation(actor, f.outgoing, { details: { kind: "broadcast", occurredAt: at(1 + index), stationId, status: "on_air", remarks: "" } });
  }
  await recordShiftOperation(actor, f.outgoing, { details: {
    kind: "outside_broadcast", occurredAt: at(5), title: "Outside van feed", location: "Accra mall",
    runningStatus: "ended", technicalIssues: "None", actionTaken: "Monitored handoff.", status: "resolved", remarks: "", linkedTaskId: null,
  } });
}

async function seedLegacyAttendance(f, uid, { clockIn = null, clockOut = null } = {}) {
  const id = `${f.outgoing}_${uid}`;
  const record = { id, shiftId: f.outgoing, technicianId: uid, status: "present",
    participationAuthority: "primary", authorizationId: null, clockIn, clockOut, isProvisional: false,
    recordedAt: historical, updatedAt: historical };
  await ref("shift_attendance", id).set(record);
  return record;
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

async function makeFrozenFixture() {
  const f = await makeActiveShiftFixture();
  await recordBroadcasts(f);
  await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  await initializeEqualHandoverReservation(initInput(f));
  await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "review" });
  const binding = await v2Binding(f);
  const preparation = (await readEqualHandoverReportState(f.outgoing, f.out[0])).preparation;
  await freezeEqualHandoverReport(freezeInputFor(f, f.out[0], preparation, binding, "Reviewed and frozen"));
  return f;
}

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

async function collectionState(name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((doc) => [doc.id, doc.data()]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function operationalState() {
  return {
    equalHandoversV2: await collectionState(OPERATIONAL_COLLECTIONS.EQUAL_HANDOVERS_V2),
    preparations: await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_REPORT_PREPARATIONS_V2),
    reports: await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_REPORTS_V2),
    handovers: await collectionState(OPERATIONAL_COLLECTIONS.HANDOVERS),
    guards: await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_RESERVATION_GUARDS),
    shifts: await collectionState(OPERATIONAL_COLLECTIONS.SHIFTS),
    technicianSchedules: await collectionState(OPERATIONAL_COLLECTIONS.TECHNICIAN_SCHEDULES),
    shiftMembers: await collectionState(OPERATIONAL_COLLECTIONS.SHIFT_MEMBERS),
    operationalShiftControl: await collectionState(OPERATIONAL_COLLECTIONS.OPERATIONAL_SHIFT_CONTROL),
    auditLogs: await collectionState("audit_logs"),
    attendanceLegacy: await collectionState(OPERATIONAL_COLLECTIONS.SHIFT_ATTENDANCE),
    attendanceV2: await collectionState(OPERATIONAL_COLLECTIONS.ATTENDANCE_EVIDENCE_V2),
    handoverTransfers: await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_TASK_TRANSFERS),
    tasks: await collectionState(OPERATIONAL_COLLECTIONS.TASKS),
  };
}

async function auditsByAction(action) {
  return (await collectionState("audit_logs")).filter(([, audit]) => audit.action === action);
}

function freezeInputFor(f, actorUid, preparation, binding, reason, correctionNote = null) {
  return {
    outgoingShiftId: f.outgoing, actorUid,
    expectedRevision: binding.aggregate.revision, expectedSnapshotHash: binding.snapshotHash,
    expectedGuardRevision: binding.guard.guardRevision, expectedFencingEpoch: binding.guard.fencingEpoch,
    preparationRevision: preparation.preparationRevision, contentDigest: preparation.contentDigest,
    evidenceSnapshotHash: preparation.evidenceSnapshotHash, workSnapshotVersion: preparation.workSnapshotVersion,
    reason, correctionNote,
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
const as403 = (pattern) => expectsStatus(AssignmentOperationError, 403, pattern);
const as400 = (pattern) => expectsStatus(AssignmentOperationError, 400, pattern);
// The pure v2 domain surfaces its own typed error for revision, snapshot,
// lifecycle, self-confirmation and absence-side rules; the transport wrappers
// surface AssignmentOperationError for authorization and guard failures.
const dAs409 = (pattern) => expectsStatus(EqualHandoverDomainError, 409, pattern);
const dAs400 = (pattern) => expectsStatus(EqualHandoverDomainError, 400, pattern);

async function seedTask(f, status = "open", id = `${f.outgoing}-task`) {
  await ref("tasks", id).set({ id, shiftId: f.outgoing, title: "Post-freeze work", description: "Pending",
    priority: "medium", sectionId: null, status, createdBy: f.manager, createdAt: historical, updatedAt: historical });
  return id;
}

async function confirmState(f) {
  const b = await v2Binding(f);
  return { expectedRevision: b.expectedRevision, expectedSnapshotHash: b.expectedSnapshotHash };
}

const absenceBase = (f, subject, overrides = {}) => ({
  outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: subject,
  absenceType: "not_yet_in", reason: "Has not arrived at the office", reportedDepartureTime: null,
  ...(subject === f.incoming[0] ? {} : { absenceType: "absent_left_office", reportedDepartureTime: "2030-01-01T13:30:00.000Z" }),
  ...overrides,
});

async function withAbsenceStamp(f, subject, overrides) {
  const stamp = await v2Binding(f);
  return recordEqualHandoverAbsenceV2({
    ...absenceBase(f, subject, overrides),
    expectedRevision: stamp.expectedRevision,
    expectedSnapshotHash: stamp.snapshotHash,
  });
}

// ---------------------------------------------------------------------------
// Route harness (vm shim) — session-derived actor only.
// ---------------------------------------------------------------------------

function jsonResponse(body, options = {}) {
  const headers = new Map(Object.entries(options.headers ?? {}));
  return { status: options.status ?? 200, body, headers: { get: (name) => headers.get(name) ?? null }, json: async () => body };
}

async function loadRouteModule(file) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const specifiers = [...new Set(source.match(/"@\/[^"]+"/g)?.map((literal) => literal.slice(1, -1)) ?? [])];
  const preloadedDeps = new Map();
  for (const name of specifiers) {
    if (name === "@/lib/auth/session") continue;
    const base = `../src/${name.slice(2)}`;
    const hit = [`${base}.ts`, `${base}/index.ts`].find((c) => existsSync(new URL(c, import.meta.url)));
    if (!hit) throw new Error(`Unresolvable v2 route dependency: ${name}`);
    preloadedDeps.set(name, await import(new URL(hit, import.meta.url).href));
  }
  const moduleExports = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
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

const confirmationRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/confirmation/route.ts",
);
const readinessRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/readiness/route.ts",
);

const CONFIRM = EQUAL_HANDOVER_READINESS_REASONS.MISSING_CONFIRMATION;

// ===========================================================================
// §4 — each outgoing technician confirms independently, personal attribution.
// ===========================================================================

test("1. Each outgoing technician confirms independently and the confirmation persists on the aggregate with full binding evidence", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  for (const uid of [f.out[0], f.out[1]]) {
    const stamp = await confirmState(f);
    const result = await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...stamp });
    assert.equal(result.replayed, false);
    assert.equal(result.aggregate.confirmations.length, uid === f.out[0] ? 1 : 2);
  }
  const stored = await getV2Document(f);
  assert.equal(stored.confirmations.length, 2);
  const positions = stored.confirmations.map((c) => c.position).sort();
  assert.deepEqual(positions, ["outgoing_tech_a", "outgoing_tech_b"]);
  for (const confirmation of stored.confirmations) {
    assert.equal(confirmation.technicianUid, confirmation.position === "outgoing_tech_a" ? f.out[0] : f.out[1]);
    assert.equal(confirmation.reportBinding.id, stored.reportBinding.id, "confirmation binds the exact frozen report");
    assert.equal(confirmation.reportBinding.evidenceSnapshotHash, stored.reportBinding.evidenceSnapshotHash);
    assert.match(confirmation.snapshotHash, /^[0-9a-f]{64}$/);
  }
  const audits = await auditsByAction("EQUAL_HANDOVER_CONFIRMED_V2");
  assert.equal(audits.length, 2, "one accepted audit per participant");
});

test("2. Incoming reserved technicians confirm for self under the audited four-person obligation", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  for (const uid of [f.out[0], f.out[1], f.incoming[0], f.incoming[1]]) {
    const stamp = await confirmState(f);
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...stamp });
  }
  const stored = await getV2Document(f);
  assert.equal(stored.confirmations.length, 4);
  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.readiness.ready, true, "four genuine confirmations satisfy readiness");
  assert.deepEqual(state.readiness.reasons, []);
  assert.equal(state.readiness.confirmedCount, 4);
  assert.equal(state.readiness.transferAuthorized, false, "readiness is never a transfer authorization");
});

test("3. Equal authority: either outgoing technician may act and confirmation order does not matter", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const first = await confirmState(f);
  await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...first });
  const second = await confirmState(f);
  await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...second });
  const stored = await getV2Document(f);
  assert.deepEqual(stored.confirmations.map((c) => c.position).sort(), ["outgoing_tech_a", "outgoing_tech_b"]);
  assert.equal(stored.revision, (await v2Binding(f)).expectedRevision, "a confirmation does not bump the reservation revision");
});

test("4. Missing confirmations block readiness with a typed reason and no ready state", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.readiness.ready, false);
  assert.deepEqual(state.readiness.reasons, [CONFIRM]);
  assert.deepEqual(state.readiness.missingConfirmations, ["incoming_tech_a", "incoming_tech_b", "outgoing_tech_a", "outgoing_tech_b"]);
});

// ===========================================================================
// §5 — absence-aware confirmation policy.
// ===========================================================================

test("5. Three confirmations plus one supported incoming absence satisfies the four-person requirement", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  await withAbsenceStamp(f, f.incoming[0], { absenceType: "not_yet_in" });
  // Re-prepare + re-freeze so the report binds the declaration, then confirm three.
  const preparation = (await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: "carry the declaration" })).preparation;
  const binding = await v2Binding(f);
  await freezeEqualHandoverReport(freezeInputFor(f, f.out[1], preparation, binding, "Freeze with the declaration", "Absence recorded after the first freeze"));
  for (const uid of [f.out[0], f.out[1], f.incoming[1]]) {
    const stamp = await confirmState(f);
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...stamp });
  }
  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.readiness.ready, true, "3 confirmations + 1 supported absence is ready");
  assert.equal(state.readiness.confirmedCount, 3);
  assert.equal(state.readiness.absenceCount, 1);
});

test("6. An unsupported absence category is rejected and never substitutes for a confirmation", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const stamp = await v2Binding(f);
  await assert.rejects(
    () => recordEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: f.incoming[0],
      absenceType: "absent_left_office", reason: "wrong category", reportedDepartureTime: "2030-01-01T13:00:00.000Z",
      expectedRevision: stamp.expectedRevision, expectedSnapshotHash: stamp.snapshotHash }),
    dAs400(/Incoming participant absence type must be not_yet_in/),
  );
  const before = await operationalState();
  const outsiderStamp = await confirmState(f);
  await assert.rejects(() => confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.unrelated, ...outsiderStamp }), as403());
  assert.deepEqual(await operationalState(), before, "a rejected absence and a rejected confirmation leave Firestore unchanged");
});

test("7. A personal confirmation and an absence are mutually exclusive for one position", async () => {
  // Direction 1 — a recorded absence takes precedence: self-confirming over a
  // supported absence is refused by the domain and mutates nothing.
  await clearDb();
  const f = await makeFrozenFixture();
  await withAbsenceStamp(f, f.incoming[0], { absenceType: "not_yet_in" });
  const absentStamp = await confirmState(f);
  const before = await operationalState();
  await assert.rejects(
    () => confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[0], ...absentStamp }),
    dAs409(/Conflicting participant resolution/),
  );
  assert.deepEqual(await operationalState(), before, "a refused confirmation over an absence mutates nothing");
  const absentStored = await getV2Document(f);
  assert.equal(absentStored.confirmations.length, 0, "the refusal records no confirmation");
  assert.equal(absentStored.absences.length, 1, "the supported absence stands unchanged");

  // Direction 2 — the authoritative contract invalidates, not rejects: a
  // colleague declaration over a standing confirmation revises the aggregate,
  // moving the confirmation to immutable history rather than coexisting with it.
  await clearDb();
  const g = await makeFrozenFixture();
  const stamp = await confirmState(g);
  await confirmEqualHandoverParticipantV2({ outgoingShiftId: g.outgoing, actorUid: g.incoming[0], ...stamp });
  const afterConfirm = await getV2Document(g);
  assert.equal(afterConfirm.confirmations.filter((c) => c.position === "incoming_tech_a").length, 1);
  const afterConfirmStamp = await v2Binding(g);
  const declared = await recordEqualHandoverAbsenceV2({ outgoingShiftId: g.outgoing, actorUid: g.out[0], technicianUid: g.incoming[0],
    absenceType: "not_yet_in", reason: "Colleague attests the arrival absence", reportedDepartureTime: null,
    expectedRevision: afterConfirmStamp.expectedRevision, expectedSnapshotHash: afterConfirmStamp.expectedSnapshotHash });
  assert.equal(declared.replayed, false);
  const stored = await getV2Document(g);
  assert.equal(stored.absences.length, 1, "the absence is recorded");
  assert.equal(stored.confirmations.filter((c) => c.position === "incoming_tech_a").length, 0, "no position holds both a live confirmation and an absence");
  const moved = stored.historicalConfirmations.filter((c) => c.position === "incoming_tech_a");
  assert.equal(moved.length, 1, "the prior confirmation is preserved as immutable history");
  assert.equal(moved[0].invalidationReason, "absence_recorded");
});

// ===========================================================================
// §4 — authorization, impersonation, replay.
// ===========================================================================

test("8. An outsider technician and a foreign origin are refused; only a reserved participant may confirm", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const stamp = await confirmState(f);
  await assert.rejects(
    () => confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.unrelated, ...stamp }),
    as403(/Only a reserved handover participant/),
  );
  await assert.rejects(
    () => confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.manager, ...stamp }),
    as403(/not authorized to access v2 handover reports/),
  );
  assert.equal((await getV2Document(f)).confirmations.length, 0);
});

test("9. Confirmation identity is session-only: the domain refuses proxy confirmation and the body cannot name a technician", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const stamp = await confirmState(f);
  // Self-only is enforced structurally: the writer passes actorUid as both
  // actor and subject. A proxy attempt (actor confirming for another uid) is
  // rejected by the domain before any write.
  await assert.rejects(async () => {
    const { confirmEqualHandoverParticipant } = await import("../src/lib/operations/equal-technician-handover-domain.ts");
    const aggregate = await getV2Document(f);
    confirmEqualHandoverParticipant(aggregate, { ...stamp, revision: aggregate.revision, snapshotHash: stamp.expectedSnapshotHash,
      recordedAt: new Date().toISOString(), actorUid: f.out[0], technicianUid: f.out[1] });
  }, (error) => error instanceof EqualHandoverDomainError && error.status === 403 && /must confirm for self/.test(error.message));
  // The HTTP parser rejects any extra body field, so a client cannot inject a
  // technician UID at all.
  assert.throws(() => parseConfirmBody({ expectedRevision: stamp.expectedRevision, expectedSnapshotHash: stamp.expectedSnapshotHash, technicianUid: f.out[1] }), as400(/Missing or unsupported/));
});

test("10. Duplicate confirmation replay is idempotent: no second entry and no second audit event", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const stamp = await confirmState(f);
  const first = await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...stamp });
  assert.equal(first.replayed, false);
  const replay = await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...stamp });
  assert.equal(replay.replayed, true);
  const stored = await getV2Document(f);
  assert.equal(stored.confirmations.length, 1, "a replay adds no duplicate confirmation");
  assert.equal((await auditsByAction("EQUAL_HANDOVER_CONFIRMED_V2")).length, 1, "a replay adds no duplicate audit");
});

test("11. Concurrent confirmations by distinct participants both commit with a stable revision", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const stamp = await confirmState(f);
  const results = await Promise.all([
    confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...stamp }),
    confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...stamp }),
    confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[0], ...stamp }),
    confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[1], ...stamp }),
  ]);
  assert.ok(results.every((r) => r.replayed === false));
  const stored = await getV2Document(f);
  assert.equal(stored.confirmations.length, 4, "four concurrent personal confirmations all land");
  assert.equal((await auditsByAction("EQUAL_HANDOVER_CONFIRMED_V2")).length, 4);
});

test("12. A stale snapshot hash is rejected explicitly and writes nothing", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const before = await operationalState();
  await assert.rejects(
    () => confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0],
      expectedRevision: 1, expectedSnapshotHash: "f".repeat(64) }),
    dAs409(/Stale/),
  );
  assert.deepEqual(await operationalState(), before);
});

// ===========================================================================
// §8 — report corrections and invalidation.
// ===========================================================================

test("13. A new frozen report version never inherits prior confirmations; they move to immutable history", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  for (const uid of [f.out[0], f.out[1], f.incoming[0], f.incoming[1]]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
  const firstReportId = (await getV2Document(f)).reportBinding.id;
  assert.equal((await getV2Document(f)).confirmations.length, 4);
  // Authoritative work evidence changes after the freeze (a direct write to the
  // tasks collection; the shift record is locked once handover begins). A
  // corrected review is prepared and re-frozen as version 2.
  await seedTask(f, "completed");
  const preparation = (await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "corrected review" })).preparation;
  const binding = await v2Binding(f);
  const second = await freezeEqualHandoverReport(freezeInputFor(f, f.out[0], preparation, binding, "Freeze corrected report", "Post-freeze work closed"));
  assert.equal(second.report.version, 2);
  const stored = await getV2Document(f);
  assert.equal(stored.reportBinding.id, second.report.id);
  assert.equal(stored.confirmations.length, 0, "the new report version starts with zero confirmations");
  assert.equal(stored.historicalConfirmations.length, 4, "the prior round is preserved as history");
  assert.ok(stored.historicalConfirmations.every((c) => c.invalidationReason === "report_revised"));
  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.readiness.ready, false, "readiness blocks until a fresh confirmation round");
  assert.deepEqual(state.readiness.reasons, [CONFIRM]);
  assert.notEqual(stored.reportBinding.id, firstReportId);
});

test("14. Evidence drift after confirmation is surfaced as a stale-report blocker while confirmations survive", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  for (const uid of [f.out[0], f.out[1], f.incoming[0], f.incoming[1]]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[0])).readiness.ready, true);
  // Bound evidence moves after every confirmation; the frozen report itself is
  // never rewritten, so readiness reports the stale-binding blocker.
  await seedTask(f, "completed");
  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.readiness.ready, false);
  assert.ok(state.readiness.reasons.includes(EQUAL_HANDOVER_READINESS_REASONS.REPORT_EVIDENCE_STALE), "stale bound evidence is a typed blocker");
  assert.equal(state.aggregate.confirmations.length, 4, "drift alone does not erase personal confirmations");
});

test("15. Absence withdrawal returns the handover to a missing-confirmation blocker and is auditable", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  await withAbsenceStamp(f, f.incoming[0], { absenceType: "not_yet_in" });
  const preparation = (await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[1], reason: "review with declaration" })).preparation;
  const binding = await v2Binding(f);
  await freezeEqualHandoverReport(freezeInputFor(f, f.out[1], preparation, binding, "Freeze with declaration", "declaration added"));
  for (const uid of [f.out[0], f.out[1], f.incoming[1]]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[0])).readiness.ready, true);
  const stamp = await v2Binding(f);
  await clearEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: f.incoming[0],
    expectedRevision: stamp.expectedRevision, expectedSnapshotHash: stamp.snapshotHash });
  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.readiness.ready, false, "withdrawing the absence reopens the confirmation obligation");
  assert.ok(state.readiness.reasons.includes(CONFIRM));
  assert.equal((await auditsByAction("EQUAL_HANDOVER_ABSENCE_CLEARED_V2")).length, 1, "the withdrawal is auditable");
});

// ===========================================================================
// §7/§11 — lifecycle, immutability, and boundary proofs.
// ===========================================================================

test("16. Cancellation closes the lifecycle and confirmations are rejected with no state change", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const binding = await v2Binding(f);
  await cancelEqualHandoverReservationForTechnicians({ outgoingShiftId: f.outgoing, actorUid: f.out[0],
    expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.snapshotHash, reason: "Cancelled for test" });
  const before = await operationalState();
  const stamp = await confirmState(f);
  await assert.rejects(
    () => confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...stamp }),
    dAs409(/lifecycle/),
  );
  assert.deepEqual(await operationalState(), before, "a rejected post-cancellation confirmation mutates nothing");
});

test("17. The bound frozen report document and its audit are never mutated by confirmations", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const reportId = (await getV2Document(f)).reportBinding.id;
  const reportBefore = (await ref("handover_reports_v2", reportId).get()).data();
  const freezeAuditsBefore = (await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).map(([id]) => id).sort();
  for (const uid of [f.out[0], f.out[1], f.incoming[0], f.incoming[1]]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
  assert.deepEqual((await ref("handover_reports_v2", reportId).get()).data(), reportBefore, "the frozen report is immutable");
  assert.deepEqual((await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).map(([id]) => id).sort(), freezeAuditsBefore);
});

test("18. Confirmation audit records bind the exact report identity, actor and reservation with no credential material", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await confirmState(f)) });
  const [auditId, audit] = (await auditsByAction("EQUAL_HANDOVER_CONFIRMED_V2"))[0];
  assert.match(auditId, /^audit_confirm_v2_[0-9a-f]{40}$/);
  assert.equal(audit.actorUid, f.out[0]);
  assert.equal(audit.protocol, "equal-handover-v2");
  assert.equal(audit.reservationId, (await getV2Document(f)).reservation.handoverId);
  assert.equal(audit.reportId, (await getV2Document(f)).reportBinding.id);
  assert.equal(audit.confirmation.position, "outgoing_tech_a");
  assert.ok(!/password|refreshToken|idToken|sessionCookie|cookie/i.test(JSON.stringify(audit)), "audit must not carry credentials");
});

test("19. Confirmations never create the incoming shift, finalize attendance, transfer tasks or complete the handover", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const incomingShiftId = (await getV2Document(f)).reservation.reservedIncomingShiftId;
  const before = await operationalState();
  for (const uid of [f.out[0], f.out[1], f.incoming[0], f.incoming[1]]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
  assert.equal((await ref("shifts", incomingShiftId).get()).exists, false, "no incoming shift is created");
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.SHIFT_ATTENDANCE), before.attendanceLegacy, "no attendance finalized");
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.ATTENDANCE_EVIDENCE_V2), before.attendanceV2, "no evidence finalized");
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_TASK_TRANSFERS), before.handoverTransfers, "no task transferred");
  assert.equal((await getV2Document(f)).lifecycleStatus, "collecting_confirmations", "readiness ready must not complete the handover");
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[0])).readiness.ready, true);
});

test("20. The legacy V1 handover collections are never touched by v2 confirmations", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const before = await collectionState(OPERATIONAL_COLLECTIONS.HANDOVERS);
  for (const uid of [f.out[0], f.out[1], f.incoming[0], f.incoming[1]]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.HANDOVERS), before, "no V1 handover document is created or mutated");
});

// ===========================================================================
// §9 — API surface (gate, session, origin, readiness GET).
// ===========================================================================

test("21. Confirmation and readiness routes return 404 with the dev gate disabled and run no workflow", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const before = await operationalState();
  delete process.env.HANDOVER_V2_DEV;
  const params = { params: Promise.resolve({ shiftId: f.outgoing }) };
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2`;
  routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
  try {
    const post = await confirmationRoute.POST(new NextRequest(`${base}/confirmation`, { method: "POST", headers: { origin: "http://localhost:3000" }, body: '{"expectedRevision":1,"expectedSnapshotHash":"' + "a".repeat(64) + '"}' }), params);
    assert.equal(post.status, 404);
    const get = await readinessRoute.GET(new NextRequest(`${base}/readiness`, { method: "GET", headers: { origin: "http://localhost:3000" } }), params);
    assert.equal(get.status, 404);
  } finally {
    routeSessionUser = null;
  }
  assert.deepEqual(await operationalState(), before);
});

test("22. Enabled confirmation route: 401 without session, 403 for foreign origin, 403 for supervisor, always no-store", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  process.env.HANDOVER_V2_DEV = "true";
  const stamp = await confirmState(f);
  const body = JSON.stringify(stamp);
  const params = { params: Promise.resolve({ shiftId: f.outgoing }) };
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2/confirmation`;
  try {
    routeSessionUser = null;
    const anon = await confirmationRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body }), params);
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get("Cache-Control"), "no-store");

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    const foreign = await confirmationRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://evil.example" }, body }), params);
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).error, "Invalid request origin.");

    routeSessionUser = { uid: f.manager, role: "supervisor", mustChangePassword: false };
    const supervisor = await confirmationRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body }), params);
    assert.equal(supervisor.status, 403, "a supervisor cannot confirm");

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: true };
    const forced = await confirmationRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body }), params);
    assert.equal(forced.status, 403, "a forced-password session cannot confirm");

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    const ok = await confirmationRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body }), params);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("Cache-Control"), "no-store");
    assert.equal((await ok.json()).confirmation.replayed, false);
  } finally {
    routeSessionUser = null;
    delete process.env.HANDOVER_V2_DEV;
  }
});

test("23. Readiness GET returns the authoritative derived readiness for a participant", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  process.env.HANDOVER_V2_DEV = "true";
  const params = { params: Promise.resolve({ shiftId: f.outgoing }) };
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2/readiness`;
  try {
    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    const before = await readinessRoute.GET(new NextRequest(base, { method: "GET", headers: { origin: "http://localhost:3000" } }), params);
    assert.equal(before.status, 200);
    assert.equal((await before.json()).readiness.ready, false);
    for (const uid of [f.out[0], f.out[1], f.incoming[0], f.incoming[1]]) {
      await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
    }
    const after = await readinessRoute.GET(new NextRequest(base, { method: "GET", headers: { origin: "http://localhost:3000" } }), params);
    const readiness = (await after.json()).readiness;
    assert.equal(readiness.ready, true);
    assert.equal(readiness.transferAuthorized, false);
    assert.equal(after.headers.get("Cache-Control"), "no-store");
  } finally {
    routeSessionUser = null;
    delete process.env.HANDOVER_V2_DEV;
  }
});
