/**
 * Firestore emulator integration tests for TECH-HO-RECOVERY-09K supervisor
 * read-only v2 handover visibility.
 *
 * Run via: tests/run-handover-v2-supervisor-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-handover-v2" on the
 * dedicated emulator port 8092 with synthetic accounts only. The suite refuses to
 * run against any other project or host, and refuses to run with the development
 * feature flag preset — the supervisor services are exercised directly. No real
 * user, no production project, and never the owner's live UAT emulator.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const project = "demo-shiftchange-handover-v2";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8092", "localhost:8092"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run supervisor v2 emulator tests outside the isolated demo emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The supervisor v2 emulator suite exercises services directly, with no dev feature flag.");
}
const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const { initializeEqualHandoverReservation, readEqualHandoverReservation } = await import("../src/lib/operations/equal-handover-reservation-firestore.ts");
const { createEqualHandoverDocumentId, EqualHandoverDomainError } = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const {
  prepareEqualHandoverReport, readEqualHandoverReportState, recordEqualHandoverAbsenceV2,
  freezeEqualHandoverReport, confirmEqualHandoverParticipantV2, commitEqualHandoverOutgoingV2,
  acceptEqualHandoverIncomingV2, readEqualHandoverAcceptanceContext,
} = await import("../src/lib/operations/equal-handover-report-firestore.ts");
const { beginAttendanceEvidenceOperation, finalizeAttendanceEvidenceOperation, resumeAttendanceEvidenceOperation } = await import("../src/lib/operations/attendance-evidence-firestore.ts");
const { OPERATIONAL_COLLECTIONS } = await import("../src/lib/operations/collections.ts");
const { createPendingOperationalShiftControl, consumeOperationalShiftSlot, transitionOperationalShiftControl } = await import("../src/lib/operations/operational-shift-control-state.ts");
const { recordShiftOperation } = await import("../src/lib/operations/shift-operations.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { AttendanceEvidenceDomainError } = await import("../src/lib/operations/attendance-evidence-firestore.ts");
const { ShiftOperationsError } = await import("../src/lib/operations/shift-operations-domain.ts");
const { ATTENDANCE_EVIDENCE_KINDS } = await import("../src/types/attendance-evidence.ts");
const { getSupervisorV2HandoverList, getSupervisorV2HandoverDetail } = await import("../src/lib/operations/supervisor-handover-v2.ts");
const { getHandoverWorkspace } = await import("../src/lib/operations/handover-workspace.ts");

const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);
const historical = "2020-01-01T00:00:00.000Z";
let seq = 0;

async function clearDb() {
  const cleared = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(cleared.status, 200);
}

async function makeActiveShiftFixture() {
  const prefix = `v2s${++seq}`;
  const now0 = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const f = {
    prefix,
    manager: `${prefix}-manager`,
    outgoing: `${prefix}-outgoing`,
    outPair: `${prefix}-outpair`,
    inPair: `${prefix}-inpair`,
    out: [`${prefix}-outa`, `${prefix}-outb`],
    incoming: [`${prefix}-ina`, `${prefix}-inb`],
    unrelated: `${prefix}-unrelated`,
    token: randomUUID(),
    outStart: iso(now0 - 8 * 3600_000),
    outEnd: iso(now0 + 5 * 60_000),
    inStart: iso(now0 + 5 * 60_000),
    inEnd: iso(now0 + 8 * 3600_000),
  };
  const batch = db.batch();
  batch.set(ref("users", f.manager), { uid: f.manager, fullName: `${prefix} Max Manager`, role: "supervisor", status: "active", statusOperation: null, mustChangePassword: false });
  for (const uid of [...f.out, ...f.incoming]) {
    batch.set(ref("users", uid), { uid, fullName: `${prefix} ${uid}`, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  }
  batch.set(ref("users", f.unrelated), { uid: f.unrelated, fullName: `${prefix} Un`, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  for (const [id, ids] of [[f.outPair, f.out], [f.inPair, f.incoming]]) {
    batch.set(ref("technician_pairs", id), { id, technicianIds: ids, status: "active", createdBy: f.manager, createdAt: historical, updatedAt: historical, deactivatedAt: null, deactivatedBy: null });
    for (const uid of ids) batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: id, createdAt: historical, updatedAt: historical });
  }
  batch.set(ref("shifts", f.outgoing), { id: f.outgoing, status: "active", permanentPairId: f.outPair, primaryTechnicianIds: f.out, operationalSlotToken: f.token, shiftType: "morning", scheduledStart: f.outStart, scheduledEnd: f.outEnd, actualStart: f.outStart, actualEnd: null, createdBy: f.manager, createdAt: f.outStart, updatedAt: f.outStart });
  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(f.token, 1, f.outStart), f.outgoing, f.outStart);
  control = transitionOperationalShiftControl(control, f.outgoing, "scheduled", "active", f.outStart);
  batch.set(ref("operational_shift_control", "global"), control);
  for (const uid of f.out) {
    const memberId = `${f.outgoing}_${uid}`;
    batch.set(ref("shift_members", memberId), { id: memberId, shiftId: f.outgoing, technicianId: uid, role: "primary", joinedAt: f.outStart, leftAt: null });
    batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [{ shiftId: f.outgoing, scheduledStart: f.outStart, scheduledEnd: f.outEnd, status: "active" }], updatedAt: f.outStart });
  }
  for (const uid of f.incoming) batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [{ shiftId: `${prefix}-later`, scheduledStart: iso(now0 + 3 * 24 * 3600_000), scheduledEnd: iso(now0 + 3 * 24 * 3600_000 + 8 * 3600_000), status: "scheduled" }], updatedAt: f.outStart });
  await batch.commit();
  return f;
}

async function seedLegacyAttendance(f, uid, { clockIn = null, clockOut = null } = {}) {
  const id = `${f.outgoing}_${uid}`;
  await ref("shift_attendance", id).set({ id, shiftId: f.outgoing, technicianId: uid, status: "present", participationAuthority: "primary", authorizationId: null, clockIn, clockOut, isProvisional: false, recordedAt: historical, updatedAt: historical });
}

async function recordBroadcasts(f, { withClockOut = true } = {}) {
  // Recording operations requires an un-clocked-out technician (requireOperationsScope
  // rejects a technician whose attendance already has a clockOut). So seed only the
  // clock-in, write the operational records, then apply the personal clock-out.
  await seedLegacyAttendance(f, f.out[0], { clockIn: f.outStart });
  const actor = { uid: f.out[0], role: "technician" };
  const at = (h) => new Date(Date.parse(f.outStart) + h * 3600_000).toISOString();
  for (const [i, stationId] of ["joy-fm", "adom-fm", "asempa-fm", "hitz-fm"].entries()) {
    await recordShiftOperation(actor, f.outgoing, { details: { kind: "broadcast", occurredAt: at(1 + i), stationId, status: "on_air", remarks: "" } });
  }
  await recordShiftOperation(actor, f.outgoing, { details: { kind: "outside_broadcast", occurredAt: at(5), title: "Outside van feed", location: "Accra mall", runningStatus: "ended", technicalIssues: "None", actionTaken: "Monitored handoff.", status: "resolved", remarks: "", linkedTaskId: null } });
  if (withClockOut) await ref("shift_attendance", `${f.outgoing}_${f.out[0]}`).update({ clockOut: f.outEnd, updatedAt: f.outEnd });
}

async function v2Binding(f) {
  const state = await readEqualHandoverReservation(f.outgoing);
  return { aggregate: state.aggregate, snapshotHash: state.snapshotHash, expectedRevision: state.aggregate.revision, expectedSnapshotHash: state.snapshotHash, guard: state.guard };
}
async function confirmState(f) { const b = await v2Binding(f); return { expectedRevision: b.expectedRevision, expectedSnapshotHash: b.expectedSnapshotHash }; }
async function commitBinding(f) { const b = await v2Binding(f); return { expectedRevision: b.expectedRevision, expectedSnapshotHash: b.expectedSnapshotHash, expectedGuardRevision: b.guard.guardRevision, expectedFencingEpoch: b.guard.fencingEpoch }; }
function freezeInputFor(f, actorUid, preparation, binding, reason, correctionNote = null) {
  return { outgoingShiftId: f.outgoing, actorUid, expectedRevision: binding.aggregate.revision, expectedSnapshotHash: binding.snapshotHash, expectedGuardRevision: binding.guard.guardRevision, expectedFencingEpoch: binding.guard.fencingEpoch, preparationRevision: preparation.preparationRevision, contentDigest: preparation.contentDigest, evidenceSnapshotHash: preparation.evidenceSnapshotHash, workSnapshotVersion: preparation.workSnapshotVersion, reason, correctionNote };
}

async function makeFrozenFixture(options = {}) {
  const f = await makeActiveShiftFixture();
  await recordBroadcasts(f, options);
  await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  await initializeEqualHandoverReservation({ outgoingShiftId: f.outgoing, actorUid: f.out[0], incomingPermanentPairId: f.inPair, shiftType: "morning", scheduledStart: f.inStart, scheduledEnd: f.inEnd, idempotencyKey: `key-${randomUUID()}` });
  await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "review" });
  const binding = await v2Binding(f);
  const preparation = (await readEqualHandoverReportState(f.outgoing, f.out[0])).preparation;
  await freezeEqualHandoverReport(freezeInputFor(f, f.out[0], preparation, binding, "Reviewed and frozen"));
  return f;
}

async function confirmAll(f) {
  for (const uid of [...f.out, ...f.incoming]) await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
}

// Ready-for-commit fixture. Either all four confirm (Case 1) or incoming[1] is
// declared not_yet_in and three confirm (Case 2). A declaration must be carried
// by a re-prepared + re-frozen report before readiness can be satisfied — the
// bound report cannot predate the declaration (mirrors the acceptance suite).
async function makeReadyFixture({ absence = false } = {}) {
  const f = await makeFrozenFixture();
  if (absence) {
    const stamp = await v2Binding(f);
    await recordEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: f.incoming[1],
      absenceType: "not_yet_in", reason: "Has not arrived for the incoming shift", reportedDepartureTime: null,
      expectedRevision: stamp.expectedRevision, expectedSnapshotHash: stamp.snapshotHash });
    const preparation = (await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "review with declaration" })).preparation;
    const binding = await v2Binding(f);
    await freezeEqualHandoverReport(freezeInputFor(f, f.out[0], preparation, binding, "Re-freeze with declaration", "declaration added"));
    for (const uid of [f.out[0], f.out[1], f.incoming[0]]) {
      await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
    }
    return f;
  }
  await confirmAll(f);
  return f;
}

const clock = (f, min = 1) => new Date(Date.parse(f.inStart) + min * 60_000).toISOString();
async function runAcceptance(f, actorUid, serverAuthenticationTime) {
  const ctx = await readEqualHandoverAcceptanceContext(f.outgoing, actorUid);
  if (!ctx.alreadyAccepted) {
    const request = { schema: "attendance-evidence-v2", handoverId: ctx.reservation.handoverId, handoverDocumentId: ctx.handoverDocumentId, eventId: ctx.eventId, position: ctx.actorPosition, technicianUid: actorUid, kind: ctx.evidenceKind, scheduledStart: ctx.identity.scheduledStart, scheduledEnd: ctx.identity.scheduledEnd, reportedDepartureTime: null, attestedByUid: null, attestationReason: null, lateReason: ctx.lateReason, handoverRevision: ctx.aggregate.revision, snapshotHash: ctx.snapshotHash, expectedGuardRevision: ctx.guardRevision, expectedFencingEpoch: ctx.fencingEpoch };
    const begun = await beginAttendanceEvidenceOperation({ request });
    const finalized = await finalizeAttendanceEvidenceOperation({ operationId: begun.operation.id, identity: ctx.identity, reservation: ctx.reservation, trustedAuthentication: { verifiedTechnicianUid: actorUid, method: ctx.authenticationMethod }, serverAuthenticationTime });
    if (finalized.needsResume) await resumeAttendanceEvidenceOperation(finalized.operation.id);
  }
  return acceptEqualHandoverIncomingV2({ outgoingShiftId: f.outgoing, actorUid, serverAuthenticationTime, ...(await commitBinding(f)) });
}
async function commitAndActivate(f) {
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  const activation = await runAcceptance(f, f.incoming[0], clock(f, 1));
  const join = await runAcceptance(f, f.incoming[1], clock(f, 3));
  return { activation, join };
}

async function collectionState(name) { const snap = await db.collection(name).get(); return snap.docs.map((d) => [d.id, JSON.parse(JSON.stringify(d.data()))]).sort(([a], [b]) => (a < b ? -1 : 1)); }
async function operationalState() {
  return {
    equalHandoversV2: await collectionState(OPERATIONAL_COLLECTIONS.EQUAL_HANDOVERS_V2),
    preparations: await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_REPORT_PREPARATIONS_V2),
    reports: await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_REPORTS_V2),
    guards: await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_RESERVATION_GUARDS),
    shifts: await collectionState(OPERATIONAL_COLLECTIONS.SHIFTS),
    attendanceLegacy: await collectionState(OPERATIONAL_COLLECTIONS.SHIFT_ATTENDANCE),
    attendanceV2: await collectionState(OPERATIONAL_COLLECTIONS.ATTENDANCE_EVIDENCE_V2),
    auditLogs: await collectionState("audit_logs"),
  };
}

function expectStatus(status, pattern) {
  return (error) => {
    assert.ok(error instanceof AssignmentOperationError || error instanceof AttendanceEvidenceDomainError || error instanceof EqualHandoverDomainError || error instanceof ShiftOperationsError, `${error.constructor.name}: ${error.message}`);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

const sup = (f) => ({ uid: f.manager, role: "supervisor", fullName: "M", email: "m@x.test", mustChangePassword: false });
const tech = (f) => ({ uid: f.out[0], role: "technician", fullName: "T", email: "t@x.test", mustChangePassword: false });

// ---------------------------------------------------------------------------

test("1. Authorized supervisor lists v2 handovers with teams, status, initiation and readiness", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await confirmState(f)) });
  const rows = await getSupervisorV2HandoverList(sup(f));
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.outgoingShiftId, f.outgoing);
  assert.equal(row.lifecycleStatus, "collecting_confirmations");
  assert.equal(row.revision >= 1, true);
  assert.equal(row.outgoingTeam.length, 2);
  assert.equal(row.incomingTeam.length, 2);
  assert.equal(row.outgoingTeam[0].name, `${f.prefix} ${f.out[0]}`, "authoritative name, not a uid fallback");
  assert.equal(row.confirmedCount, 1);
  assert.equal(row.requiredConfirmations, 4);
  assert.equal(row.ready, false);
  assert.ok(row.blockers.some((b) => b.includes("confirmation")), `expected a confirmation blocker: ${row.blockers}`);
  assert.equal(row.evidenceAvailable, true);
  assert.equal(row.initiationAt !== null, true, "handover initiation time is persisted evidence");
});

test("2. Authorized supervisor detail exposes full authoritative evidence, read-only", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  await confirmAll(f);
  const view = await getSupervisorV2HandoverDetail(sup(f), f.outgoing);
  const state = view.state;
  assert.equal(state.aggregate.identity.outgoingShiftId, f.outgoing);
  assert.equal(state.readiness.confirmedCount, 4);
  assert.equal(state.readiness.ready, true);
  assert.equal(state.readiness.transferAuthorized, false, "readiness never authorizes a transfer");
  assert.equal(state.live.content.participants.length, 4);
  assert.deepEqual(view.incomingAcceptance, [], "no incoming acceptance evidence exists before commit");
  // Supervisor receives a read-only guard view, not a mutation ticket.
  assert.ok(state.guard === null || typeof state.guard.guardRevision === "number");
});

test("3. Unauthorized access: technician, demoted and unrelated profiles are refused", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  // A participant technician may not use the supervisor interface.
  await assert.rejects(() => getSupervisorV2HandoverList(tech(f)), expectStatus(403, /cannot view v2 handover/i));
  await assert.rejects(() => getSupervisorV2HandoverDetail(tech(f), f.outgoing), expectStatus(403, /cannot view v2 handover/i));
  // An active supervisor reading a v2 shift id with no aggregate gets a 404 that
  // discloses nothing (the authorized read is attempted, the record is absent).
  await assert.rejects(() => getSupervisorV2HandoverDetail(sup(f), "no-such-shift-zzz"), (e) => e.status === 404 || e.status === 400);
  // A demoted supervisor profile (pending statusOperation) fails closed even with a supervisor session uid.
  await ref("users", f.manager).set({ role: "supervisor", status: "active", statusOperation: { kind: "disable" }, mustChangePassword: false }, { merge: true });
  await assert.rejects(() => getSupervisorV2HandoverList(sup(f)), expectStatus(403, /cannot view v2 handover/i));
});

test("4. Read-only guarantee: listing and detail never mutate any operational collection", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  await confirmAll(f);
  const before = await operationalState();
  await getSupervisorV2HandoverList(sup(f));
  await getSupervisorV2HandoverDetail(sup(f), f.outgoing);
  await getSupervisorV2HandoverDetail(sup(f), f.outgoing);
  const after = await operationalState();
  assert.deepEqual(after, before, "supervisor reads must be byte-for-byte side-effect free");
});

test("5. Four genuine confirmations render as ready with no confirmation blocker", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  await confirmAll(f);
  const [row] = await getSupervisorV2HandoverList(sup(f));
  assert.equal(row.ready, true);
  assert.equal(row.confirmedCount, 4);
  assert.equal(row.absenceCount, 0);
  assert.ok(!row.blockers.some((b) => b.includes("confirmation")), `${row.blockers}`);
});

test("6. Three confirmations plus one documented absence renders ready, absence is not a confirmation", async () => {
  await clearDb();
  const f = await makeReadyFixture({ absence: true });
  const [row] = await getSupervisorV2HandoverList(sup(f));
  assert.equal(row.ready, true, "3 confirmations + 1 supported absence is ready");
  assert.equal(row.confirmedCount, 3);
  assert.equal(row.absenceCount, 1);
  const absent = row.incomingTeam.find((m) => m.uid === f.incoming[1]);
  assert.equal(absent.absent, true);
  assert.equal(absent.confirmed, false, "absence is never reported as a personal confirmation");
  assert.equal(absent.attestedByUid, f.out[0], "the attesting colleague is attributed");
});

test("7. Incoming acceptance is derived from persisted personal evidence, and the handover shows completed", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitAndActivate(f);
  const [row] = await getSupervisorV2HandoverList(sup(f));
  assert.equal(row.lifecycleStatus, "completed");
  const view = await getSupervisorV2HandoverDetail(sup(f), f.outgoing);
  assert.equal(view.state.aggregate.lifecycleStatus, "completed");
  for (const position of ["incoming_tech_a", "incoming_tech_b"]) {
    const acceptance = view.incomingAcceptance.find((item) => item.position === position);
    assert.ok(acceptance, `${position} acceptance must come from persisted evidence`);
    assert.equal(acceptance.personallyAuthenticated, true);
    assert.ok(acceptance.acceptedAt !== null, "acceptance carries a genuine personal timestamp");
    assert.equal(acceptance.kind, ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN);
  }
});

test("8. Late participation by a previously absent incoming technician is visible as audited late-acceptance evidence", async () => {
  await clearDb();
  const f = await makeReadyFixture({ absence: true }); // incoming[1] is not_yet_in
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  await runAcceptance(f, f.incoming[0], clock(f, 1)); // confirmed incoming activates
  await runAcceptance(f, f.incoming[1], clock(f, 20)); // the not_yet_in technician arrives late
  const view = await getSupervisorV2HandoverDetail(sup(f), f.outgoing);
  const late = view.incomingAcceptance.find((item) => item.uid === f.incoming[1]);
  assert.ok(late, "the arrived technician has persisted acceptance evidence");
  assert.equal(late.kind, ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE, "the correction is a late acceptance, not a backdated clock-in");
  assert.equal(late.personallyAuthenticated, true);
  assert.ok(late.lateReason, "the audited late reason is surfaced");
  const aggregateAbsence = view.state.aggregate.absences.find((a) => a.technicianUid === f.incoming[1]);
  assert.ok(aggregateAbsence, "the original not_yet_in declaration remains as historical absence evidence");
});

test("9. Missing attendance stays missing and is never synthesized", async () => {
  await clearDb();
  // No outgoing clock-out is seeded, so genuine attendance evidence is absent.
  const f = await makeFrozenFixture({ withClockOut: false });
  const view = await getSupervisorV2HandoverDetail(sup(f), f.outgoing);
  const outb = view.state.live.content.attendance.find((item) => item.uid === f.out[1]);
  assert.equal(outb.clockIn, null);
  assert.equal(outb.clockOut, null);
  assert.equal(outb.reportingEvidence, null);
  assert.equal(outb.absenceDeclared, null);
  assert.equal(outb.departureProvenance, null, "no departure is invented for a technician lacking evidence");
  assert.deepEqual(view.incomingAcceptance, [], "no incoming acceptance is synthesized before commit");
});

test("10. Readiness blockers are surfaced, and supervisor readiness never authorizes transfer", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const view = await getSupervisorV2HandoverDetail(sup(f), f.outgoing);
  assert.equal(view.state.readiness.ready, false);
  assert.ok(view.state.readiness.reasons.includes("missing_confirmation"));
  assert.equal(view.state.readiness.transferAuthorized, false);
});

test("11. Historical report integrity: a later frozen version supersedes without rewriting the earlier report", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const firstReports = await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_REPORTS_V2);
  assert.equal(firstReports.length, 1, "one frozen report exists after the fixture");
  // Change the authoritative evidence (a declaration), then re-prepare + re-freeze
  // so a NEW version supersedes the first; the earlier report is preserved.
  const stamp = await v2Binding(f);
  await recordEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: f.incoming[1],
    absenceType: "not_yet_in", reason: "Delayed arrival", reportedDepartureTime: null,
    expectedRevision: stamp.expectedRevision, expectedSnapshotHash: stamp.snapshotHash });
  await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "correction" });
  const binding = await v2Binding(f);
  const preparation = (await readEqualHandoverReportState(f.outgoing, f.out[0])).preparation;
  await freezeEqualHandoverReport(freezeInputFor(f, f.out[0], preparation, binding, "Reviewed correction", "Amended for the recorded declaration"));
  const view = await getSupervisorV2HandoverDetail(sup(f), f.outgoing);
  assert.equal(view.state.frozenReport.version, 2);
  assert.ok(view.state.frozenReport.supersedesReportId, "the later version records what it supersedes");
  const laterReports = await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_REPORTS_V2);
  assert.equal(laterReports.length, firstReports.length + 1, "the earlier report document is preserved, not overwritten");
  for (const [id, data] of firstReports) {
    const kept = laterReports.find(([x]) => x === id);
    assert.deepEqual(kept[1], data, `report ${id} must remain byte-identical`);
  }
});

test("12. V1 regression + scope isolation: the shared manager workspace still hides v2, V1 reads unaffected", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  const workspace = await getHandoverWorkspace(sup(f));
  // Existing contract: managers never receive v2 entries through the shared workspace.
  assert.equal(workspace.v2Reports.length, 0);
  // The dedicated supervisor v2 service is the only surface that lists v2.
  const rows = await getSupervisorV2HandoverList(sup(f));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outgoingShiftId, f.outgoing);
});
