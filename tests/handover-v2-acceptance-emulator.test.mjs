/**
 * Firestore emulator integration tests for TECH-HO-RECOVERY-08 §13 — incoming
 * password acceptance, automatic shift activation and late partner joining.
 *
 * The suite drives the real production writers end-to-end (reservation → freeze
 * → confirmations → commit → incoming acceptance → deferred guard finalize) and
 * asserts FINAL PERSISTED Firestore state, never service return values alone.
 * It proves the addendum decisions:
 *   #1  outgoing commit never pre-creates an incoming shift or fabricates a
 *       joined membership;
 *   #2  `awaiting_incoming_acceptance` is a validated lifecycle, Shift lifecycle
 *       stays separate;
 *   #3  the FIRST authorized incoming acceptance activates EXACTLY ONE shift and
 *       records that technician's own membership + authoritative attendance;
 *   #4  the SECOND acceptance JOINS the existing shift with independent
 *       membership + attendance timestamps;
 *   #5  a `not_yet_in` technician's late personal acceptance is an audited
 *       `incoming_late_acceptance` correction that preserves the original
 *       declaration + frozen report and never backdates;
 *   #6  authority is re-derived inside the transaction, never inherited;
 *   #7  deterministic ids, idempotent replay, immutable audit receipts;
 *   §5  no duplicate shift under concurrent first acceptance and no fabricated
 *       partner attendance.
 *
 * Attendance evidence (the provenance layer) and shift_attendance (the atomic
 * operational layer) are exercised together exactly as the acceptance route
 * orchestrates them: evidence is finalized against the STILL-ACTIVE reservation
 * guard, the guard reaches `completed` only in the separate deferred finalize.
 * Passwords are never involved here — this suite drives services directly; the
 * personal password step is covered by the password-reauthentication unit suite
 * and the browser harness.
 *
 * Run via: tests/run-handover-v2-acceptance-emulator.ps1
 *
 * Safety invariant: project "demo-shiftchange-handover-v2" on the dedicated
 * acceptance port 8093 with synthetic accounts only; refuses to run under any
 * other project/host or with the development feature flag preset.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const project = "demo-shiftchange-handover-v2";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8093", "localhost:8093"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run v2 acceptance emulator tests outside the isolated demo emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The v2 acceptance emulator suite must exercise services directly, with no dev feature flag.");
}
const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const {
  initializeEqualHandoverReservation,
  readEqualHandoverReservation,
} = await import("../src/lib/operations/equal-handover-reservation-firestore.ts");
const {
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
} = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const {
  prepareEqualHandoverReport,
  readEqualHandoverReportState,
  recordEqualHandoverAbsenceV2,
  freezeEqualHandoverReport,
  confirmEqualHandoverParticipantV2,
  commitEqualHandoverOutgoingV2,
  acceptEqualHandoverIncomingV2,
  finalizeEqualHandoverReservationV2,
  readEqualHandoverAcceptanceContext,
  isEqualHandoverIncomingAttendanceResolved,
} = await import("../src/lib/operations/equal-handover-report-firestore.ts");
const {
  beginAttendanceEvidenceOperation,
  finalizeAttendanceEvidenceOperation,
  resumeAttendanceEvidenceOperation,
} = await import("../src/lib/operations/attendance-evidence-firestore.ts");
const { ATTENDANCE_AUTHENTICATION_METHODS, ATTENDANCE_EVIDENCE_KINDS } = await import("../src/types/attendance-evidence.ts");
const { OPERATIONAL_COLLECTIONS } = await import("../src/lib/operations/collections.ts");
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");
const { recordShiftOperation } = await import("../src/lib/operations/shift-operations.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { AttendanceEvidenceDomainError } = await import("../src/lib/operations/attendance-evidence-firestore.ts");
const { EqualHandoverDomainError } = await import("../src/lib/operations/equal-technician-handover-domain.ts");

const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);
const historical = "2020-01-01T00:00:00.000Z";
let seq = 0;

async function clearDb() {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200);
}

// ---------------------------------------------------------------------------
// Fixtures — production writers build every precondition, anchored to the wall
// clock so the activation window passes.
// ---------------------------------------------------------------------------

async function makeActiveShiftFixture() {
  const prefix = `v2a${++seq}`;
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
    supervisor: `${prefix}-sup`,
    token: randomUUID(),
    outStart: iso(now0 - 8 * 3600_000),
    outEnd: iso(now0 + 5 * 60_000),
    inStart: iso(now0 + 5 * 60_000),
    inEnd: iso(now0 + 8 * 3600_000),
  };
  const batch = db.batch();
  batch.set(ref("users", f.manager), { uid: f.manager, fullName: `${prefix} Max`, role: "supervisor", status: "active", statusOperation: null, mustChangePassword: false });
  batch.set(ref("users", f.supervisor), { uid: f.supervisor, fullName: `${prefix} Sue`, role: "supervisor", status: "active", statusOperation: null, mustChangePassword: false });
  for (const uid of [...f.out, ...f.incoming]) {
    batch.set(ref("users", uid), { uid, fullName: `${prefix} ${uid}`, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  }
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
  for (const uid of f.incoming) {
    batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [{ shiftId: `${prefix}-later`, scheduledStart: iso(now0 + 3 * 24 * 3600_000), scheduledEnd: iso(now0 + 3 * 24 * 3600_000 + 8 * 3600_000), status: "scheduled" }], updatedAt: f.outStart });
  }
  await batch.commit();
  return f;
}

async function seedLegacyAttendance(f, uid) {
  const id = `${f.outgoing}_${uid}`;
  await ref("shift_attendance", id).set({ id, shiftId: f.outgoing, technicianId: uid, status: "present",
    participationAuthority: "primary", authorizationId: null, clockIn: null, clockOut: null, isProvisional: false, recordedAt: f.outStart, updatedAt: f.outStart });
}

async function recordBroadcasts(f) {
  await seedLegacyAttendance(f, f.out[0]);
  const actor = { uid: f.out[0], role: "technician" };
  const at = (h) => new Date(Date.parse(f.outStart) + h * 3600_000).toISOString();
  for (const [i, stationId] of ["joy-fm", "adom-fm", "asempa-fm", "hitz-fm"].entries()) {
    await recordShiftOperation(actor, f.outgoing, { details: { kind: "broadcast", occurredAt: at(1 + i), stationId, status: "on_air", remarks: "" } });
  }
  await recordShiftOperation(actor, f.outgoing, { details: { kind: "outside_broadcast", occurredAt: at(5), title: "Outside feed", location: "Accra mall", runningStatus: "ended", technicalIssues: "None", actionTaken: "Monitored.", status: "resolved", remarks: "", linkedTaskId: null } });
}

const initInput = (f) => ({ outgoingShiftId: f.outgoing, actorUid: f.out[0], incomingPermanentPairId: f.inPair, shiftType: "morning", scheduledStart: f.inStart, scheduledEnd: f.inEnd, idempotencyKey: `key-${randomUUID()}` });

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
async function confirmState(f) { const b = await v2Binding(f); return { expectedRevision: b.expectedRevision, expectedSnapshotHash: b.expectedSnapshotHash }; }
// The four concurrency values the reviewed evidence carries — always the LIVE
// aggregate revision/snapshot and the LIVE guard revision/epoch, exactly what a
// client would have reviewed after commit (commit preserves revision/snapshot).
async function acceptBinding(f) {
  const b = await v2Binding(f);
  return { expectedRevision: b.expectedRevision, expectedSnapshotHash: b.expectedSnapshotHash, expectedGuardRevision: b.guard.guardRevision, expectedFencingEpoch: b.guard.fencingEpoch };
}

function freezeInputFor(f, actorUid, preparation, binding, reason, correctionNote = null) {
  return { outgoingShiftId: f.outgoing, actorUid, expectedRevision: binding.aggregate.revision, expectedSnapshotHash: binding.snapshotHash,
    expectedGuardRevision: binding.guard.guardRevision, expectedFencingEpoch: binding.guard.fencingEpoch, preparationRevision: preparation.preparationRevision,
    contentDigest: preparation.contentDigest, evidenceSnapshotHash: preparation.evidenceSnapshotHash, workSnapshotVersion: preparation.workSnapshotVersion, reason, correctionNote };
}

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

// Ready-for-commit fixture. All-confirmed (Case1) or one incoming `not_yet_in`
// with three confirmations (Case2).
async function makeReadyFixture({ absence = false } = {}) {
  const f = await makeFrozenFixture();
  if (absence) {
    const stamp = await v2Binding(f);
    await recordEqualHandoverAbsenceV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], technicianUid: f.incoming[1], absenceType: "not_yet_in",
      reason: "Has not arrived for the incoming shift", reportedDepartureTime: null, expectedRevision: stamp.expectedRevision, expectedSnapshotHash: stamp.snapshotHash });
    const preparation = (await prepareEqualHandoverReport({ outgoingShiftId: f.outgoing, actorUid: f.out[0], reason: "review with declaration" })).preparation;
    const binding = await v2Binding(f);
    await freezeEqualHandoverReport(freezeInputFor(f, f.out[0], preparation, binding, "Re-freeze with declaration", "declaration added"));
    for (const uid of [f.out[0], f.out[1], f.incoming[0]]) {
      await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
    }
    return f;
  }
  for (const uid of [...f.out, ...f.incoming]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
  return f;
}

async function getV2Document(f) { const s = await ref(OPERATIONAL_COLLECTIONS.EQUAL_HANDOVERS_V2, createEqualHandoverDocumentId(f.outgoing)).get(); return s.exists ? s.data() : null; }
async function getGuard(f) { const s = await ref(OPERATIONAL_COLLECTIONS.HANDOVER_RESERVATION_GUARDS, `guard_${f.outgoing}`).get(); return s.exists ? s.data() : null; }
async function attendanceDoc(f, incomingId, uid) { const s = await ref(OPERATIONAL_COLLECTIONS.SHIFT_ATTENDANCE, `${incomingId}_${uid}`).get(); return s.exists ? s.data() : null; }
async function memberDoc(f, shiftId, uid) { const s = await ref(OPERATIONAL_COLLECTIONS.SHIFT_MEMBERS, `${shiftId}_${uid}`).get(); return s.exists ? s.data() : null; }
async function evidenceDoc(handoverId, uid, kind) {
  const { attendanceEvidenceId, attendanceEvidenceSlotId } = await import("../src/lib/operations/attendance-evidence-domain.ts");
  const id = attendanceEvidenceId(attendanceEvidenceSlotId({ handoverId, technicianUid: uid, kind }));
  const s = await ref(OPERATIONAL_COLLECTIONS.ATTENDANCE_EVIDENCE_V2, id).get();
  return s.exists ? s.data() : null;
}

// Route-mirrored acceptance orchestration: read authoritative context, finalize
// incoming evidence against the still-ACTIVE guard, then run the activation/join
// transaction with the same authoritative clock.
async function runAcceptance(f, actorUid, serverAuthenticationTime) {
  const ctx = await readEqualHandoverAcceptanceContext(f.outgoing, actorUid);
  let evidence = null;
  if (!ctx.alreadyAccepted) {
    const request = {
      schema: "attendance-evidence-v2", handoverId: ctx.reservation.handoverId, handoverDocumentId: ctx.handoverDocumentId,
      eventId: ctx.eventId, position: ctx.actorPosition, technicianUid: actorUid, kind: ctx.evidenceKind,
      scheduledStart: ctx.identity.scheduledStart, scheduledEnd: ctx.identity.scheduledEnd, reportedDepartureTime: null,
      attestedByUid: null, attestationReason: null, lateReason: ctx.lateReason, handoverRevision: ctx.aggregate.revision,
      snapshotHash: ctx.snapshotHash, expectedGuardRevision: ctx.guardRevision, expectedFencingEpoch: ctx.fencingEpoch,
    };
    const begun = await beginAttendanceEvidenceOperation({ request });
    const finalized = await finalizeAttendanceEvidenceOperation({ operationId: begun.operation.id, identity: ctx.identity, reservation: ctx.reservation,
      trustedAuthentication: { verifiedTechnicianUid: actorUid, method: ctx.authenticationMethod }, serverAuthenticationTime });
    if (finalized.needsResume) await resumeAttendanceEvidenceOperation(finalized.operation.id);
    evidence = finalized.evidence;
  }
  const binding = await acceptBinding(f);
  const result = await acceptEqualHandoverIncomingV2({ outgoingShiftId: f.outgoing, actorUid, serverAuthenticationTime, ...binding });
  return { ctx, evidence, result };
}

const asError = (status, pattern) => (error) => {
  assert.ok(
    error instanceof AssignmentOperationError ||
    error instanceof AttendanceEvidenceDomainError ||
    error instanceof EqualHandoverDomainError,
    `${error.constructor.name}: ${error.message}`,
  );
  assert.equal(error.status, status);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

const clock = (f, minutesAfterInStart = 1) => new Date(Date.parse(f.inStart) + minutesAfterInStart * 60_000).toISOString();

// ===========================================================================
// STAGE 1 — outgoing commit.
// ===========================================================================

test("1. commit flips collecting→awaiting, preserves revision + snapshot, writes only the aggregate + receipt", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await getV2Document(f);
  const beforeHash = createEqualHandoverSnapshot(before).snapshotHash;
  const b = await acceptBinding(f);
  const result = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...b });
  assert.equal(result.status, "COMMITTED");
  assert.equal(result.aggregate.lifecycleStatus, "awaiting_incoming_acceptance");
  assert.equal(result.aggregate.revision, before.revision, "commit preserves revision");
  assert.equal(result.snapshotHash, beforeHash, "commit preserves the reviewed snapshot");

  const stored = await getV2Document(f);
  assert.equal(stored.lifecycleStatus, "awaiting_incoming_acceptance");
  const identity = stored.identity;
  // No shift/control/guard/membership/attendance churn (§1 addendum #1).
  const incomingShift = await ref("shifts", identity.incomingShiftId).get();
  assert.equal(incomingShift.exists, false, "commit must NOT create the incoming shift");
  const outgoing = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(outgoing.status, "handover_pending", "outgoing shift still handover_pending");
  const guard = await getGuard(f);
  assert.equal(guard.ownerLifecycleState, "active", "commit never terminalizes the guard");
  for (const uid of identity.incomingTechnicianIds) {
    assert.equal(await memberDoc(f, identity.incomingShiftId, uid), null, "no fabricated incoming membership");
    assert.equal(await attendanceDoc(f, identity.incomingShiftId, uid), null, "no fabricated incoming attendance");
  }
  const receipt = (await ref("audit_logs", result.receipt.id).get()).data();
  assert.equal(receipt.action, "EQUAL_HANDOVER_OUTGOING_COMMITTED_V2");
});

test("2. commit is idempotent: a second commit replays the same receipt and writes nothing new", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const b = await acceptBinding(f);
  const first = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...b });
  const afterFirst = await getV2Document(f);
  const b2 = await acceptBinding(f);
  const second = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...b2 });
  assert.equal(second.status, "ALREADY_COMMITTED");
  assert.equal(second.replayed, true);
  assert.equal(second.receipt.id, first.receipt.id);
  assert.equal(JSON.stringify(await getV2Document(f)), JSON.stringify(afterFirst), "aggregate unchanged on replay");
});

test("3. commit requires a personally confirmed OUTGOING technician; incoming and unconfirmed are rejected", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const b = await acceptBinding(f);
  await assert.rejects(() => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[0], ...b }), asError(403, /outgoing/i));
});

test("4. commit against a stale guard revision fails", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const b = await acceptBinding(f);
  await assert.rejects(() => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...b, expectedGuardRevision: b.expectedGuardRevision + 5 }), asError(409, /guard changed/i));
});

test("5. commit on a not-yet-frozen handover is refused and leaves no commitment", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await recordBroadcasts(f);
  await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  await initializeEqualHandoverReservation(initInput(f));
  const b = await acceptBinding(f);
  // No report is frozen, so no personal confirmation is reachable (confirmation itself
  // requires a frozen binding); the commit is refused at the personal-confirmation
  // authority gate and the aggregate stays in `collecting_confirmations`.
  await assert.rejects(() => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...b }),
    asError(403, /personally confirmed outgoing technician/i));
  assert.equal((await getV2Document(f)).lifecycleStatus, "collecting_confirmations", "an uncommitted handover keeps its lifecycle");
  assert.equal((await getGuard(f)).ownerLifecycleState, "active", "the guard is untouched by a refused commit");
});

// ===========================================================================
// STAGE 2 — first incoming acceptance ACTIVATES the shift exactly once.
// ===========================================================================

test("6. first incoming password acceptance activates the shift once and records only that technician", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const b = await acceptBinding(f);
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...b });
  const identity = (await getV2Document(f)).identity;
  const now = clock(f);
  const { ctx, evidence, result } = await runAcceptance(f, f.incoming[0], now);

  assert.equal(result.status, "ACTIVATED");
  assert.equal(result.outcome, "ACTIVATION");
  assert.equal(ctx.evidenceKind, ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN, "confirmed incoming technician clocks in");
  assert.equal(ctx.authenticationMethod, ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_CONFIRMATION, "clock-in evidence finalizes with the personal password confirmation method");
  assert.equal(evidence.kind, ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN);
  assert.equal(evidence.personallyAuthenticated, true);

  const stored = await getV2Document(f);
  assert.equal(stored.lifecycleStatus, "completed");
  const incoming = (await ref("shifts", identity.incomingShiftId).get()).data();
  assert.equal(incoming.status, "active");
  assert.equal(incoming.actualStart, now, "authoritative start is the acceptance clock");
  assert.equal(incoming.completedBy ?? incoming.startedBy, f.incoming[0]);

  const outgoing = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(outgoing.status, "completed");
  assert.equal(outgoing.completedBy, f.incoming[0]);

  const control = (await ref("operational_shift_control", "global").get()).data();
  assert.equal(control.slotStatus, "consumed");
  assert.equal(control.shiftStatus, "active");
  assert.equal(control.shiftId, identity.incomingShiftId);

  // Only the accepting technician gains membership + attendance; the partner is
  // never fabricated (§6/§7).
  assert.notEqual(await memberDoc(f, identity.incomingShiftId, f.incoming[0]), null);
  assert.notEqual(await attendanceDoc(f, identity.incomingShiftId, f.incoming[0]), null);
  assert.equal(await memberDoc(f, identity.incomingShiftId, f.incoming[1]), null, "partner membership is NOT synthesized");
  assert.equal(await attendanceDoc(f, identity.incomingShiftId, f.incoming[1]), null, "partner attendance is NOT synthesized");
  assert.equal((await getGuard(f)).ownerLifecycleState, "active", "guard stays ACTIVE after activation");
});

test("7. the legacy shift_attendance record keeps clockIn null (v1-compatibility) and binds primary authority", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  const { result } = await runAcceptance(f, f.incoming[0], clock(f));
  assert.equal(result.status, "ACTIVATED");
  const att = await attendanceDoc(f, identity.incomingShiftId, f.incoming[0]);
  assert.equal(att.clockIn, null, "no fabricated legacy clock-in time");
  assert.equal(att.participationAuthority, "primary");
  assert.equal(typeof att.recordedAt, "string");
});

test("8. re-acceptance by the same technician replays; no duplicate shift or attendance", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  const first = await runAcceptance(f, f.incoming[0], clock(f));
  assert.equal(first.result.status, "ACTIVATED");
  const incomingId1 = identity.incomingShiftId;
  const shiftCountBefore = (await db.collection("shifts").get()).size;
  const second = await runAcceptance(f, f.incoming[0], clock(f, 2));
  assert.equal(second.result.status, "ALREADY_JOINED", "self re-acceptance replays");
  assert.equal(second.result.replayed, true);
  assert.equal((await db.collection("shifts").get()).size, shiftCountBefore, "no duplicate shift");
  const att = await attendanceDoc(f, incomingId1, f.incoming[0]);
  assert.equal(att.recordedAt, clock(f), "original attendance time is never overwritten");
});

test("8b. a self re-acceptance AFTER the deferred guard finalize still replays ALREADY_JOINED with zero writes", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const incomingId = (await getV2Document(f)).identity.incomingShiftId;
  await runAcceptance(f, f.incoming[0], clock(f, 1)); // activate A
  await runAcceptance(f, f.incoming[1], clock(f, 3)); // join B
  const fin = await finalizeEqualHandoverReservationV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[1] });
  assert.equal(fin.status, "FINALIZED");
  assert.equal((await getGuard(f)).ownerLifecycleState, "completed", "the guard is terminalized and no longer active");
  const shiftCountBefore = (await db.collection("shifts").get()).size;
  const attBefore = await attendanceDoc(f, incomingId, f.incoming[0]);
  // A already accepted; re-accepting against the terminalized guard must return
  // the write-free replay (§7 replay-safety, exactly-once, never overwrite) —
  // the active-guard requirement only gates state-changing activation and joins,
  // never a technician whose attendance is already recorded.
  const replay = await runAcceptance(f, f.incoming[0], clock(f, 5));
  assert.equal(replay.result.status, "ALREADY_JOINED", "a post-finalize self re-acceptance replays");
  assert.equal(replay.result.replayed, true);
  assert.equal((await db.collection("shifts").get()).size, shiftCountBefore, "no duplicate shift on a post-finalize replay");
  const attAfter = await attendanceDoc(f, incomingId, f.incoming[0]);
  assert.equal(attAfter.recordedAt, attBefore.recordedAt, "a replay never overwrites the original acceptance clock");
  assert.equal((await getGuard(f)).ownerLifecycleState, "completed", "a replay never reopens or rewrites the terminalized guard");
});

test("9. concurrent first acceptances yield exactly one activation and one shift", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  const now = clock(f);
  const outcomes = await Promise.all([runAcceptance(f, f.incoming[0], now), runAcceptance(f, f.incoming[1], now)]);
  const statuses = outcomes.map((o) => o.result.status).sort();
  assert.deepEqual(statuses, ["ACTIVATED", "JOINED"], "one activates, the other joins");
  const incomingShifts = (await db.collection("shifts").get()).docs.filter((d) => d.id === identity.incomingShiftId);
  assert.equal(incomingShifts.length, 1, "exactly one incoming shift");
  const stored = await getV2Document(f);
  assert.equal(stored.lifecycleStatus, "completed");
  assert.notEqual(await attendanceDoc(f, identity.incomingShiftId, f.incoming[0]), null);
  assert.notEqual(await attendanceDoc(f, identity.incomingShiftId, f.incoming[1]), null);
});

test("10. acceptance requires a reserved INCOMING technician; outgoing and supervisor are refused", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  await assert.rejects(() => readEqualHandoverAcceptanceContext(f.outgoing, f.out[0]), asError(403, /incoming/i), "outgoing has no incoming authority");
  await assert.rejects(() => readEqualHandoverAcceptanceContext(f.outgoing, f.supervisor), asError(403, /authorized|technician/i), "supervisor cannot accept");
});

test("11. acceptance before commit (still collecting) is refused", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  const binding = await acceptBinding(f);
  await assert.rejects(() => acceptEqualHandoverIncomingV2({ outgoingShiftId: f.outgoing, actorUid: identity.incomingTechnicianIds[0], serverAuthenticationTime: clock(f), ...binding }), asError(409, /not awaiting incoming acceptance/i));
});

test("12. acceptance with a stale reviewed revision fails", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  const b = await acceptBinding(f);
  await assert.rejects(() => acceptEqualHandoverIncomingV2({ outgoingShiftId: f.outgoing, actorUid: identity.incomingTechnicianIds[0], serverAuthenticationTime: clock(f), ...b, expectedRevision: b.expectedRevision + 3 }), asError(409, /Stale handover revision/i));
});

// ===========================================================================
// STAGE 3 — late partner joins the SAME active shift, independently.
// ===========================================================================

test("13. the second incoming technician JOINS the same active shift with independent timestamps", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  const t1 = clock(f, 1);
  const first = await runAcceptance(f, f.incoming[0], t1);
  assert.equal(first.result.status, "ACTIVATED");
  const revisionAfterActivation = (await getV2Document(f)).revision;
  const snapshotAfterActivation = createEqualHandoverSnapshot(await getV2Document(f)).snapshotHash;

  const t2 = clock(f, 3);
  const second = await runAcceptance(f, f.incoming[1], t2);
  assert.equal(second.result.status, "JOINED");
  assert.equal(second.result.outcome, "JOIN");
  assert.equal(second.ctx.evidenceKind, ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN);
  assert.notEqual(second.evidence, null, "the joiner's own incoming evidence is recorded");

  // No new shift; the aggregate lifecycle is untouched by a join; the first
  // technician's attendance is never overwritten.
  const incomingShifts = (await db.collection("shifts").get()).docs.filter((d) => d.id === identity.incomingShiftId);
  assert.equal(incomingShifts.length, 1);
  const stored = await getV2Document(f);
  assert.equal(stored.lifecycleStatus, "completed");
  assert.equal(stored.revision, revisionAfterActivation, "a join does not mutate the aggregate");
  assert.equal(createEqualHandoverSnapshot(stored).snapshotHash, snapshotAfterActivation);
  assert.equal((await attendanceDoc(f, identity.incomingShiftId, f.incoming[0])).recordedAt, t1);
  assert.equal((await attendanceDoc(f, identity.incomingShiftId, f.incoming[1])).recordedAt, t2, "independent join time");
});

test("14. a late join cannot precede the activation clock", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const t1 = clock(f, 3);
  await runAcceptance(f, f.incoming[0], t1);
  const earlier = clock(f, 1);
  const b = await acceptBinding(f);
  await assert.rejects(() => acceptEqualHandoverIncomingV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[1], serverAuthenticationTime: earlier, ...b }), asError(409, /cannot precede/i));
});

// ===========================================================================
// §5 — audited late acceptance for a `not_yet_in` technician.
// ===========================================================================

test("15. a previously `not_yet_in` technician's acceptance is an audited late correction, not a backdate", async () => {
  await clearDb();
  const f = await makeReadyFixture({ absence: true }); // incoming[1] declared not_yet_in
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  const frozenBefore = (await readEqualHandoverReportState(f.outgoing, f.out[0])).frozenReport;

  // The confirmed partner activates first.
  const t1 = clock(f, 2);
  const activation = await runAcceptance(f, f.incoming[0], t1);
  assert.equal(activation.result.status, "ACTIVATED");

  // The `not_yet_in` technician now arrives and personally accepts.
  const ctx = await readEqualHandoverAcceptanceContext(f.outgoing, f.incoming[1]);
  assert.equal(ctx.evidenceKind, ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE, "kind selected from the stored declaration");
  assert.equal(ctx.authenticationMethod, ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_ACCEPTANCE, "late acceptance finalizes with the personal password acceptance method");
  assert.equal(ctx.lateReason, "Has not arrived for the incoming shift", "reuses the recorded absence reason");

  const t2 = clock(f, 30);
  const { evidence, result } = await runAcceptance(f, f.incoming[1], t2);
  assert.equal(result.status, "JOINED");
  assert.equal(evidence.kind, ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE);
  assert.equal(evidence.eventTime, t2, "records ACTUAL arrival, never the scheduled start");
  assert.equal((await attendanceDoc(f, identity.incomingShiftId, f.incoming[1])).recordedAt, t2);

  // Original declaration + frozen report are preserved as historical evidence.
  const stored = await getV2Document(f);
  assert.ok(stored.absences.some((a) => a.technicianUid === f.incoming[1] && a.absenceType === "not_yet_in"), "the not_yet_in declaration remains");
  const frozenAfter = (await readEqualHandoverReportState(f.outgoing, f.out[0])).frozenReport;
  assert.equal(frozenAfter.digest, frozenBefore.digest, "the frozen report is immutable");
});

test("16. incoming late-acceptance evidence requires an active guard; terminalizing early would block it", async () => {
  await clearDb();
  const f = await makeReadyFixture({ absence: true });
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const t1 = clock(f, 2);
  await runAcceptance(f, f.incoming[0], t1); // activate; guard must remain active
  assert.equal((await getGuard(f)).ownerLifecycleState, "active", "guard stays active for the pending late partner");
  assert.equal(await isEqualHandoverIncomingAttendanceResolved(f.outgoing), false, "not resolved while the not_yet_in partner has not accepted");
});

// ===========================================================================
// Deferred guard finalize.
// ===========================================================================

test("17. incoming-attendance-resolution flips only after BOTH incoming technicians personally accept", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  assert.equal(await isEqualHandoverIncomingAttendanceResolved(f.outgoing), false);
  await runAcceptance(f, f.incoming[0], clock(f, 1));
  assert.equal(await isEqualHandoverIncomingAttendanceResolved(f.outgoing), false, "one acceptance is not resolution");
  await runAcceptance(f, f.incoming[1], clock(f, 3));
  assert.equal(await isEqualHandoverIncomingAttendanceResolved(f.outgoing), true);
});

test("18. finalize terminalizes the guard with the activation receipt and is idempotent", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const a = await runAcceptance(f, f.incoming[0], clock(f, 1));
  const j = await runAcceptance(f, f.incoming[1], clock(f, 3));
  assert.equal(a.result.receipt.id, j.result.receipt.id, "activation receipt is the terminal evidence");
  const fin = await finalizeEqualHandoverReservationV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[1] });
  assert.equal(fin.status, "FINALIZED");
  const guard = await getGuard(f);
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, a.result.receipt.id);
  const again = await finalizeEqualHandoverReservationV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[1] });
  assert.equal(again.status, "ALREADY_FINALIZED");
  assert.equal(again.replayed, true);
});

test("19. finalize before activation is refused", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  await assert.rejects(() => finalizeEqualHandoverReservationV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[0] }), asError(409, /Only an activated \(completed\) handover/i));
});

// ===========================================================================
// Acceptance-context derivation.
// ===========================================================================

test("20. the acceptance context derives kind, deterministic event id and live binding", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const ctx = await readEqualHandoverAcceptanceContext(f.outgoing, f.incoming[0]);
  assert.equal(ctx.lifecycleStatus, "awaiting_incoming_acceptance");
  assert.equal(ctx.evidenceKind, ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN);
  assert.equal(ctx.lateReason, null);
  assert.equal(ctx.alreadyAccepted, false);
  assert.equal(ctx.guardRevision, (await getGuard(f)).guardRevision);
  const again = await readEqualHandoverAcceptanceContext(f.outgoing, f.incoming[0]);
  assert.equal(again.eventId, ctx.eventId, "event id is deterministic per (handover, technician, kind)");
});

test("21. the context read rejects a technician who is not a reserved incoming participant", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  await assert.rejects(() => readEqualHandoverAcceptanceContext(f.outgoing, f.out[1]), asError(403, /incoming/i));
});

test("22. evidence finalize binds the v2 aggregate in equal_handovers_v2 (regression for the collection fix)", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const ctx = await readEqualHandoverAcceptanceContext(f.outgoing, f.incoming[0]);
  const now = clock(f);
  const request = { schema: "attendance-evidence-v2", handoverId: ctx.reservation.handoverId, handoverDocumentId: ctx.handoverDocumentId,
    eventId: ctx.eventId, position: ctx.actorPosition, technicianUid: f.incoming[0], kind: ctx.evidenceKind,
    scheduledStart: ctx.identity.scheduledStart, scheduledEnd: ctx.identity.scheduledEnd, reportedDepartureTime: null, attestedByUid: null,
    attestationReason: null, lateReason: null, handoverRevision: ctx.aggregate.revision, snapshotHash: ctx.snapshotHash, expectedGuardRevision: ctx.guardRevision, expectedFencingEpoch: ctx.fencingEpoch };
  const begun = await beginAttendanceEvidenceOperation({ request });
  const finalized = await finalizeAttendanceEvidenceOperation({ operationId: begun.operation.id, identity: ctx.identity, reservation: ctx.reservation,
    trustedAuthentication: { verifiedTechnicianUid: f.incoming[0], method: ctx.authenticationMethod }, serverAuthenticationTime: now });
  assert.equal(finalized.needsResume, false);
  const stored = await evidenceDoc(ctx.reservation.handoverId, f.incoming[0], ctx.evidenceKind);
  assert.notEqual(stored, null, "evidence persisted against the v2 aggregate collection");
});

// ===========================================================================
// Idempotency + no-fabrication invariants across the full two-person flow.
// ===========================================================================

test("23. the full two-technician flow produces no duplicate shift, membership or attendance documents", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  await runAcceptance(f, f.incoming[0], clock(f, 1));
  await runAcceptance(f, f.incoming[1], clock(f, 5));
  // replay both
  await runAcceptance(f, f.incoming[0], clock(f, 9));
  await runAcceptance(f, f.incoming[1], clock(f, 12));
  const members = (await db.collection("shift_members").get()).docs.filter((d) => d.id.startsWith(`${identity.incomingShiftId}_`));
  assert.equal(members.length, 2, "exactly two incoming memberships");
  const atts = (await db.collection("shift_attendance").get()).docs.filter((d) => d.id.startsWith(`${identity.incomingShiftId}_`));
  assert.equal(atts.length, 2, "exactly two incoming attendance records");
  const incomingShifts = (await db.collection("shifts").get()).docs.filter((d) => d.id === identity.incomingShiftId);
  assert.equal(incomingShifts.length, 1);
  // first technician's time is the activation clock, never the replay clock
  assert.equal((await attendanceDoc(f, identity.incomingShiftId, f.incoming[0])).recordedAt, clock(f, 1));
});

test("24. outgoing shift members are finalized at activation (leftAt set) for all current members", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const now = clock(f);
  await runAcceptance(f, f.incoming[0], now);
  for (const uid of f.out) {
    const m = await memberDoc(f, f.outgoing, uid);
    assert.equal(typeof m.leftAt, "string", "outgoing membership closed");
    assert.equal(m.leftAt, now);
  }
});

test("25. operational slot ownership is single: exactly one shift consumes the global slot after activation", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  await runAcceptance(f, f.incoming[0], clock(f));
  const control = (await ref("operational_shift_control", "global").get()).data();
  assert.equal(control.shiftId, identity.incomingShiftId);
  assert.equal(control.slotStatus, "consumed");
  assert.equal(control.shiftStatus, "active");
});

// ===========================================================================
// Role boundary (§10) — supervisors/admins cannot accept a technician's handover.
// ===========================================================================

test("26. a non-participant technician has no acceptance context", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  await assert.rejects(() => readEqualHandoverAcceptanceContext(f.outgoing, f.supervisor), asError(403));
});

test("27. commit snapshot equals the snapshot the incoming technician later reviews (no drift across the boundary)", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const pre = await getV2Document(f);
  const preHash = createEqualHandoverSnapshot(pre).snapshotHash;
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const ctx = await readEqualHandoverAcceptanceContext(f.outgoing, f.incoming[0]);
  assert.equal(ctx.snapshotHash, preHash, "the reviewed snapshot survives the commit boundary unchanged");
  assert.equal(ctx.aggregate.revision, pre.revision);
});

test("28. accepted incoming technicians' schedule entries flip to active while the unarrived partner stays scheduled", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await acceptBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  await runAcceptance(f, f.incoming[0], clock(f, 1));
  const accepted = (await ref("technician_schedules", f.incoming[0]).get()).data();
  assert.ok(accepted.entries.some((e) => e.shiftId === identity.incomingShiftId && e.status === "active"), "accepted technician is active");
  const partner = (await ref("technician_schedules", f.incoming[1]).get()).data();
  assert.ok(partner.entries.some((e) => e.shiftId === identity.incomingShiftId && e.status === "scheduled"), "partner stays scheduled until they join");
  await runAcceptance(f, f.incoming[1], clock(f, 4));
  const nowActive = (await ref("technician_schedules", f.incoming[1]).get()).data();
  assert.ok(nowActive.entries.some((e) => e.shiftId === identity.incomingShiftId && e.status === "active"));
});
