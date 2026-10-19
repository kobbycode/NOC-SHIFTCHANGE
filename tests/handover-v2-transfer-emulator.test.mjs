/**
 * Firestore emulator integration tests for the equal-technician v2 TWO-STAGE
 * FINAL HANDOVER (TECH-HO-RECOVERY-07 §11, re-scoped for M08 §8).
 *
 * M07 shipped a single atomic `transferEqualHandoverV2` that moved the whole
 * handover — including creating and activating the incoming shift — in one
 * transaction. M08 decision #1 retired that path: an active incoming shift may
 * never exist without an incoming technician's OWN password acceptance. The
 * lifecycle is now split:
 *
 *     collecting_confirmations
 *        │  commitEqualHandoverOutgoingV2   (outgoing technician; NO password)
 *        ▼
 *     awaiting_incoming_acceptance
 *        │  acceptEqualHandoverIncomingV2   (first incoming acceptance — the
 *        ▼                                   ONLY event that creates + activates
 *     completed                              the incoming shift)
 *
 *     guard.ownerLifecycleState: active ──finalizeEqualHandoverReservationV2──▶ completed
 *
 * This suite drives the real production writers end-to-end — reservation →
 * freeze → confirmations → COMMIT → incoming ACCEPTANCE → deferred guard
 * FINALIZE — and asserts FINAL PERSISTED Firestore state, never service return
 * values alone. Where M07's atomic-transfer postconditions no longer apply,
 * they are replaced by EXPLICIT two-stage checks (addendum #8): the commit must
 * create no shift/slot/membership/attendance, acceptance is the sole shift-
 * creating event, and only finalize terminalizes the guard.
 *
 * It proves the split preserves the M07 guarantees the retirement must not lose:
 * the commit derives its own authorization (§4), replays idempotently from a
 * deterministic receipt rather than a client random id (§5), carries reviewed
 * evidence and never authority, and never touches attendance at commit, task
 * transfers or the V1 lifecycle (§7/§8). The commit and finalize ROUTES need no
 * password, so they are exercised through the real route handlers; the incoming
 * acceptance is driven through the same service the password-accept route calls
 * (the personal password step belongs to the acceptance + browser suites, which
 * bring up the Auth emulator).
 *
 * Run via: tests/run-handover-v2-transfer-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-handover-v2" on the
 * dedicated transfer-emulator port 8092 with synthetic accounts only. The suite
 * refuses to run against any other project or host, and refuses to run with the
 * development feature flag preset; the route-gate tests set and clear it around
 * the handler invocation only.
 *
 * Scheduled windows are anchored to Date.now() because incoming acceptance
 * enforces the real shift activation window against the incoming reservation's
 * scheduled start.
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
  throw new Error("Refusing to run v2 transfer emulator tests outside the isolated demo emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The v2 transfer emulator suite must exercise services directly, with no dev feature flag.");
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
const {
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
  EqualHandoverDomainError,
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
  parseEqualHandoverTransferRequest,
} = await import("../src/lib/operations/equal-handover-report-firestore.ts");
const { parseCommitBody } = await import("../src/lib/operations/handover-v2-report-http.ts");
const {
  beginAttendanceEvidenceOperation,
  finalizeAttendanceEvidenceOperation,
  resumeAttendanceEvidenceOperation,
} = await import("../src/lib/operations/attendance-evidence-firestore.ts");
const { OPERATIONAL_COLLECTIONS } = await import("../src/lib/operations/collections.ts");
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");
const { recordShiftOperation } = await import("../src/lib/operations/shift-operations.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { AttendanceEvidenceDomainError } = await import("../src/lib/operations/attendance-evidence-firestore.ts");

const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);

const historical = "2020-01-01T00:00:00.000Z";
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
// Fixtures — the production writers build every precondition, anchored to the
// wall clock so the incoming acceptance's activation window can pass.
// ---------------------------------------------------------------------------

async function makeActiveShiftFixture() {
  const prefix = `v2t${++seq}`;
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
    operationalSlotToken: f.token, shiftType: "morning", scheduledStart: f.outStart, scheduledEnd: f.outEnd,
    actualStart: f.outStart, actualEnd: null, createdBy: f.manager, createdAt: f.outStart, updatedAt: f.outStart,
  });
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

// Broadcast + outside-broadcast evidence clears the completeness blockers so a
// report can be frozen, confirmed, committed and finally accepted. All
// observations fall inside the outgoing shift window (>= actualStart) and in the past.
async function recordBroadcasts(f) {
  await seedLegacyAttendance(f, f.out[0]);
  const actor = { uid: f.out[0], role: "technician" };
  const at = (hoursAfterStart) => new Date(Date.parse(f.outStart) + hoursAfterStart * 3600_000).toISOString();
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
    recordedAt: f.outStart, updatedAt: f.outStart };
  await ref("shift_attendance", id).set(record);
  return record;
}

const initInput = (f, overrides = {}) => ({
  outgoingShiftId: f.outgoing,
  actorUid: f.out[0],
  incomingPermanentPairId: f.inPair,
  shiftType: "morning",
  scheduledStart: f.inStart,
  scheduledEnd: f.inEnd,
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

// A frozen report whose four reserved participants have all personally
// confirmed — the authoritative precondition for an outgoing commit.
async function makeReadyFixture({ absence = false } = {}) {
  const f = await makeFrozenFixture();
  if (absence) {
    // incoming[1] is declared absent by a colleague, so only the other three
    // confirm; readiness is satisfied by 3 confirmations + 1 supported absence.
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
  for (const uid of [...f.out, ...f.incoming]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
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
  const snap = await ref(OPERATIONAL_COLLECTIONS.EQUAL_HANDOVERS_V2, createEqualHandoverDocumentId(f.outgoing)).get();
  return snap.exists ? snap.data() : null;
}

async function getGuard(f) {
  const snap = await ref(OPERATIONAL_COLLECTIONS.HANDOVER_RESERVATION_GUARDS, `guard_${f.outgoing}`).get();
  return snap.exists ? snap.data() : null;
}

async function attendanceDoc(incomingId, uid) {
  const s = await ref(OPERATIONAL_COLLECTIONS.SHIFT_ATTENDANCE, `${incomingId}_${uid}`).get();
  return s.exists ? s.data() : null;
}
async function memberDoc(shiftId, uid) {
  const s = await ref(OPERATIONAL_COLLECTIONS.SHIFT_MEMBERS, `${shiftId}_${uid}`).get();
  return s.exists ? s.data() : null;
}

// The exact reviewed evidence a commit/accept request may carry — and nothing else.
async function commitBinding(f) {
  const b = await v2Binding(f);
  return {
    expectedRevision: b.expectedRevision,
    expectedSnapshotHash: b.expectedSnapshotHash,
    expectedGuardRevision: b.guard.guardRevision,
    expectedFencingEpoch: b.guard.fencingEpoch,
  };
}

async function collectionState(name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((doc) => [doc.id, doc.data()]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// Everything the split must leave untouched at each stage boundary. The
// aggregate + audit_logs are the only collections a commit may write.
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

// The collections a commit must NOT touch — everything except the aggregate and
// its commitment receipt.
function shiftAndEvidenceState(s) {
  const { equalHandoversV2, auditLogs, ...untouched } = s;
  void equalHandoversV2; void auditLogs;
  return untouched;
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

function asError(status, pattern) {
  return (error) => {
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
}
const as403 = (pattern) => asError(403, pattern);
const as400 = (pattern) => asError(400, pattern);
const as409 = (pattern) => asError(409, pattern);

async function seedTask(f, status = "open", id = `${f.outgoing}-task`) {
  await ref("tasks", id).set({ id, shiftId: f.outgoing, title: "Post-freeze work", description: "Pending",
    priority: "medium", sectionId: null, status, createdBy: f.manager, createdAt: f.outStart, updatedAt: f.outStart });
  return id;
}

async function confirmState(f) {
  const b = await v2Binding(f);
  return { expectedRevision: b.expectedRevision, expectedSnapshotHash: b.expectedSnapshotHash };
}

const clock = (f, minutesAfterInStart = 1) => new Date(Date.parse(f.inStart) + minutesAfterInStart * 60_000).toISOString();

// Route-mirrored acceptance orchestration: read authoritative context, finalize
// incoming evidence against the still-ACTIVE guard, then run the activation/join
// transaction with the same authoritative clock. This is the exact service
// sequence the password-accept route drives (minus the personal password check,
// which belongs to the acceptance + browser suites that bring up the Auth emulator).
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
  const binding = await commitBinding(f);
  const result = await acceptEqualHandoverIncomingV2({ outgoingShiftId: f.outgoing, actorUid, serverAuthenticationTime, ...binding });
  return { ctx, evidence, result };
}

// Commit then accept both incoming technicians — the sole path to a completed,
// activated handover. Returns the identity + activation clock.
async function commitAndActivate(f) {
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  const t1 = clock(f, 1);
  const activation = await runAcceptance(f, f.incoming[0], t1);
  const t2 = clock(f, 3);
  const join = await runAcceptance(f, f.incoming[1], t2);
  return { identity, activation, join, t1, t2 };
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

const commitRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/commit/route.ts",
);
const finalizeRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/finalize/route.ts",
);

const commitParams = (f) => ({ params: Promise.resolve({ shiftId: f.outgoing }) });
const commitUrl = (f) => `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2/commit`;
const finalizeUrl = (f) => `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2/finalize`;
const sameOrigin = (url, method, body) => new NextRequest(url, { method, headers: { origin: "http://localhost:3000" }, body });

// ===========================================================================
// STAGE BOUNDARIES — the split replaces the retired atomic transfer.
// ===========================================================================

test("1. Stage 1 commit flips collecting→awaiting and creates NO shift, slot, membership or attendance", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await getV2Document(f);
  const beforeHash = createEqualHandoverSnapshot(before).snapshotHash;
  const identity = before.identity;
  const beforeOps = await operationalState();

  const result = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });

  assert.equal(result.status, "COMMITTED");
  assert.equal(result.replayed, false);
  assert.equal(result.aggregate.lifecycleStatus, "awaiting_incoming_acceptance");
  assert.equal(result.aggregate.revision, before.revision, "commit preserves the reviewed revision");
  assert.equal(result.snapshotHash, beforeHash, "commit preserves the reviewed snapshot (only lifecycle/updatedAt move)");

  const stored = await getV2Document(f);
  assert.equal(stored.lifecycleStatus, "awaiting_incoming_acceptance");
  assert.equal((await ref("shifts", identity.incomingShiftId).get()).exists, false, "commit must NOT create the incoming shift");
  const outgoing = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(outgoing.status, "handover_pending", "the outgoing shift stays handover_pending and still owns the slot");
  assert.equal((await getGuard(f)).ownerLifecycleState, "active", "commit never terminalizes the guard");
  for (const uid of identity.incomingTechnicianIds) {
    assert.equal(await memberDoc(identity.incomingShiftId, uid), null, "no fabricated incoming membership");
    assert.equal(await attendanceDoc(identity.incomingShiftId, uid), null, "no fabricated incoming attendance");
  }

  const afterOps = await operationalState();
  assert.deepEqual(shiftAndEvidenceState(afterOps), shiftAndEvidenceState(beforeOps), "commit touches only the aggregate + receipt");
  const newReceipt = (await ref("audit_logs", result.receipt.id).get()).data();
  assert.equal(newReceipt.action, "EQUAL_HANDOVER_OUTGOING_COMMITTED_V2");
});

test("2. Stage 2 first incoming acceptance is the ONLY event that creates and activates the incoming shift", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  const now = clock(f);

  const { result } = await runAcceptance(f, f.incoming[0], now);
  assert.equal(result.status, "ACTIVATED");
  assert.equal(result.outcome, "ACTIVATION");

  const incoming = (await ref("shifts", identity.incomingShiftId).get()).data();
  assert.equal(incoming.id, identity.incomingShiftId);
  assert.equal(incoming.status, "active", "acceptance — not commit — activates the shift");
  assert.equal(incoming.actualStart, now, "the activation clock is authoritative");
  assert.equal(incoming.operationalSlotToken, identity.successorSlotToken);
  assert.equal(incoming.permanentPairId, identity.incomingPermanentPairId);
  assert.deepEqual(incoming.primaryTechnicianIds, [...identity.incomingTechnicianIds]);
  assert.equal(incoming.previousShiftId, f.outgoing);
  assert.equal(incoming.handoverDocumentId, createEqualHandoverDocumentId(f.outgoing));
  assert.equal(incoming.actualEnd, null);

  assert.equal((await getV2Document(f)).lifecycleStatus, "completed");
  const outgoing = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(outgoing.status, "completed", "acceptance completes the outgoing shift");
  assert.equal(outgoing.completedBy, f.incoming[0]);

  // Only the accepting technician gains membership + attendance; the partner is
  // never fabricated (§6/§7).
  assert.notEqual(await memberDoc(identity.incomingShiftId, f.incoming[0]), null);
  assert.notEqual(await attendanceDoc(identity.incomingShiftId, f.incoming[0]), null);
  assert.equal(await memberDoc(identity.incomingShiftId, f.incoming[1]), null, "partner membership is NOT synthesized");
  assert.equal(await attendanceDoc(identity.incomingShiftId, f.incoming[1]), null, "partner attendance is NOT synthesized");
});

test("3. Second incoming acceptance JOINS the same active shift; never a second shift", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  const t1 = clock(f, 1);
  await runAcceptance(f, f.incoming[0], t1);
  const revisionAfterActivation = (await getV2Document(f)).revision;
  const snapshotAfterActivation = createEqualHandoverSnapshot(await getV2Document(f)).snapshotHash;

  const t2 = clock(f, 3);
  const second = await runAcceptance(f, f.incoming[1], t2);
  assert.equal(second.result.status, "JOINED");
  assert.equal(second.result.outcome, "JOIN");
  assert.notEqual(second.evidence, null, "the joiner records their own incoming evidence");

  const incomingShifts = (await db.collection("shifts").get()).docs.filter((d) => d.id === identity.incomingShiftId);
  assert.equal(incomingShifts.length, 1, "exactly one incoming shift");
  assert.equal((await getV2Document(f)).revision, revisionAfterActivation, "a join does not mutate the aggregate");
  assert.equal(createEqualHandoverSnapshot(await getV2Document(f)).snapshotHash, snapshotAfterActivation);
  assert.equal((await attendanceDoc(identity.incomingShiftId, f.incoming[0])).recordedAt, t1, "first technician's clock is never overwritten");
  assert.equal((await attendanceDoc(identity.incomingShiftId, f.incoming[1])).recordedAt, t2, "independent join time");
});

test("4. Deferred finalize is the only step that terminalizes the guard, pinning the activation receipt", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const { identity, activation } = await commitAndActivate(f);
  assert.equal((await getGuard(f)).ownerLifecycleState, "active", "the guard stays active through commit + acceptances");
  assert.equal(await isEqualHandoverIncomingAttendanceResolved(f.outgoing), true, "both acceptances landed");

  const fin = await finalizeEqualHandoverReservationV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[1] });
  assert.equal(fin.status, "FINALIZED");
  const guard = await getGuard(f);
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, activation.result.receipt.id, "terminal evidence is the activation receipt");
  assert.equal((await ref("shifts", identity.incomingShiftId).get()).exists, true, "finalizing does not disturb the active shift");

  const again = await finalizeEqualHandoverReservationV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[1] });
  assert.equal(again.status, "ALREADY_FINALIZED");
  assert.equal(again.replayed, true);
});

test("5. Outgoing memberships close and incoming schedules activate at acceptance, not at commit", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  const identity = (await getV2Document(f)).identity;
  // Commit alone leaves the outgoing memberships open and the incoming
  // technicians still scheduled (not active).
  for (const uid of identity.outgoingTechnicianIds) {
    assert.equal((await memberDoc(f.outgoing, uid)).leftAt, null, "commit does not close outgoing membership");
  }
  assert.ok(!(await ref("technician_schedules", f.incoming[0]).get()).data().entries
    .some((e) => e.shiftId === identity.incomingShiftId && e.status === "active"), "no incoming activation at commit");

  await runAcceptance(f, f.incoming[0], clock(f));
  for (const uid of identity.outgoingTechnicianIds) {
    assert.equal(typeof (await memberDoc(f.outgoing, uid)).leftAt, "string", "acceptance closes outgoing membership");
  }
  const accepted = (await ref("technician_schedules", f.incoming[0]).get()).data();
  assert.ok(accepted.entries.some((e) => e.shiftId === identity.incomingShiftId && e.status === "active"), "accepted technician active");
});

test("6. Operational control advances to the incoming successor exactly once, only at acceptance", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  const before = (await ref("operational_shift_control", "global").get()).data();
  assert.equal(before.generation, identity.outgoingGeneration);
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  assert.deepEqual((await ref("operational_shift_control", "global").get()).data(), before, "commit never advances the slot");
  await runAcceptance(f, f.incoming[0], clock(f));
  await runAcceptance(f, f.incoming[1], clock(f, 3));
  const after = (await ref("operational_shift_control", "global").get()).data();
  assert.equal(after.generation, identity.successorGeneration, "control advanced by exactly one");
  assert.equal(after.slotToken.toLowerCase(), identity.successorSlotToken.toLowerCase());
  assert.equal(after.shiftId, identity.incomingShiftId);
});

// ===========================================================================
// §4 — authorization is derived by the commit, never inherited.
// ===========================================================================

test("7. A supervisor, an incoming technician and an unrelated technician cannot commit the outgoing handover", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await operationalState();
  const state = await commitBinding(f);
  await assert.rejects(
    () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.manager, ...state }),
    as403(/not authorized|outgoing reserved technician|technician/i),
  );
  await assert.rejects(
    () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[0], ...state }),
    as403(/outgoing reserved technician/i),
  );
  await assert.rejects(
    () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.unrelated, ...state }),
    as403(/outgoing reserved technician/i),
  );
  assert.deepEqual(await operationalState(), before, "unauthorized attempts mutate nothing");
});

test("8. Either confirmed outgoing technician may commit the handover (equal authority)", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const result = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...(await commitBinding(f)) });
  assert.equal(result.status, "COMMITTED");
  assert.equal(result.receipt.actorUid, f.out[1]);
});

test("9. An outgoing technician who has not personally confirmed cannot commit", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  for (const uid of [f.out[0], f.incoming[0], f.incoming[1]]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
  const before = await operationalState();
  await assert.rejects(
    async () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...(await commitBinding(f)) }),
    as403(/personally confirmed outgoing technician/i),
  );
  assert.deepEqual(await operationalState(), before);
});

test("10. A confirmed outgoing technician cannot commit while other confirmations are missing: readiness is re-derived", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await confirmState(f)) });
  const before = await operationalState();
  await assert.rejects(
    async () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) }),
    as409(/not ready to commit|incomplete report/i),
  );
  assert.deepEqual(await operationalState(), before);
  assert.equal((await getV2Document(f)).lifecycleStatus, "collecting_confirmations");
});

test("11. A prior readiness GET is not trusted: commit refuses when live evidence no longer supports it", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[0])).readiness.ready, true, "readiness was true moments ago");
  // Authoritative work evidence moves after readiness was observed, so the bound
  // report drifts and the commit's live re-derivation refuses.
  await seedTask(f, "open");
  const before = await operationalState();
  await assert.rejects(
    async () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) }),
    as409(/ready to commit|incomplete report/i),
  );
  assert.deepEqual(await operationalState(), before, "a refused commit mutates nothing");
});

test("12. Absence-aware readiness: three confirmations plus one supported absence still authorizes a commit", async () => {
  await clearDb();
  const f = await makeReadyFixture({ absence: true });
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[0])).readiness.ready, true);
  const result = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  assert.equal(result.status, "COMMITTED");
  assert.equal(result.aggregate.lifecycleStatus, "awaiting_incoming_acceptance");
});

// ===========================================================================
// §4/§5 — stale reviewed evidence, guard epoch and commit idempotency.
// ===========================================================================

test("13. A stale expectedRevision is rejected and writes nothing", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const state = await commitBinding(f);
  const before = await operationalState();
  await assert.rejects(
    () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state, expectedRevision: state.expectedRevision + 1 }),
    as409(/Stale equal handover revision|revision|snapshot/i),
  );
  assert.deepEqual(await operationalState(), before);
});

test("14. A stale expectedSnapshotHash is rejected and writes nothing", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const state = await commitBinding(f);
  const before = await operationalState();
  await assert.rejects(
    () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state, expectedSnapshotHash: "f".repeat(64) }),
    as409(/Stale equal handover revision|revision|snapshot/i),
  );
  assert.deepEqual(await operationalState(), before);
});

test("15. A stale guard revision or fencing epoch is rejected and writes nothing", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const state = await commitBinding(f);
  const before = await operationalState();
  await assert.rejects(
    () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state, expectedGuardRevision: state.expectedGuardRevision + 99 }),
    as409(/reservation guard changed/i),
  );
  await assert.rejects(
    () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state, expectedFencingEpoch: state.expectedFencingEpoch + 7 }),
    as409(/reservation guard changed/i),
  );
  assert.deepEqual(await operationalState(), before);
});

test("16. A replayed commit returns the committed receipt and mutates nothing", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const first = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  assert.equal(first.replayed, false);
  const afterFirst = await operationalState();
  const replay = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...(await commitBinding(f)) });
  assert.equal(replay.status, "ALREADY_COMMITTED");
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.id, first.receipt.id);
  assert.equal(replay.receipt.receiptHash, first.receipt.receiptHash);
  assert.deepEqual(await operationalState(), afterFirst, "a replay writes nothing new");
  assert.equal((await auditsByAction("EQUAL_HANDOVER_OUTGOING_COMMITTED_V2")).length, 1);
});

test("17. Concurrent commits by two confirmed technicians commit exactly once", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const shared = await commitBinding(f);
  const settled = await Promise.allSettled([
    commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...shared }),
    commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...shared }),
  ]);
  const fulfilled = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const committed = fulfilled.filter((r) => r.status === "COMMITTED");
  assert.equal(committed.length, 1, "exactly one call performs the commit");
  for (const r of settled.filter((r) => r.status === "rejected")) {
    assert.ok(r.reason instanceof AssignmentOperationError || r.reason instanceof EqualHandoverDomainError, `loser: ${r.reason}`);
  }
  assert.equal((await auditsByAction("EQUAL_HANDOVER_OUTGOING_COMMITTED_V2")).length, 1, "a single durable commitment");
  assert.equal((await getV2Document(f)).lifecycleStatus, "awaiting_incoming_acceptance");
});

test("18. The commit receipt is a durable, self-verifiable audit record bound to the frozen report", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const storedBefore = await getV2Document(f);
  const result = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  const audits = await auditsByAction("EQUAL_HANDOVER_OUTGOING_COMMITTED_V2");
  assert.equal(audits.length, 1, "exactly one commitment receipt");
  const [receiptId, receipt] = audits[0];
  assert.equal(receipt.id, receiptId);
  assert.equal(receipt.schema, "equal-handover-commit-v2");
  assert.equal(receipt.protocol, "equal-handover-v2");
  assert.equal(receipt.outcome, "AWAITING_INCOMING_ACCEPTANCE");
  assert.equal(receipt.actorRole, "technician");
  assert.equal(receipt.outgoingShiftId, f.outgoing);
  assert.equal(receipt.incomingShiftId, storedBefore.identity.incomingShiftId);
  assert.equal(receipt.finalSnapshotHash, createEqualHandoverSnapshot(result.aggregate).snapshotHash);
  assert.equal(receipt.boundReportId, storedBefore.reportBinding.id, "receipt names the frozen report it committed");
  assert.match(receipt.receiptHash, /^[0-9a-f]{64}$/);
  assert.ok(!/password|refreshToken|idToken|sessionCookie|cookie/i.test(JSON.stringify(receipt)), "receipt must not carry credentials");
});

// ===========================================================================
// §7/§8 — boundary: attendance, tasks and V1 are never touched by the commit,
// and only the accepting technician's attendance is ever recorded.
// ===========================================================================

test("19. The commit synthesizes no attendance; only the accepting technician's own attendance is ever recorded", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await operationalState();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.SHIFT_ATTENDANCE), before.attendanceLegacy, "commit leaves attendance byte-unchanged");
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.ATTENDANCE_EVIDENCE_V2), before.attendanceV2, "commit records no v2 evidence");

  const identity = (await getV2Document(f)).identity;
  await runAcceptance(f, f.incoming[0], clock(f));
  const attAfterOne = await collectionState(OPERATIONAL_COLLECTIONS.SHIFT_ATTENDANCE);
  const atts = attAfterOne.filter(([id]) => id.startsWith(`${identity.incomingShiftId}_`));
  assert.equal(atts.length, 1, "one acceptance records exactly one incoming attendance");
  assert.equal(atts[0][1].clockIn, null, "the legacy clock-in is never fabricated");
});

test("20. Neither commit nor acceptance creates task transfers or mutates tasks", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await operationalState();
  await commitAndActivate(f);
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_TASK_TRANSFERS), before.handoverTransfers, "no task re-parented");
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.TASKS), before.tasks, "no task fabricated complete");
});

test("21. The legacy V1 handover lifecycle is never entered across the two-stage flow", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await collectionState(OPERATIONAL_COLLECTIONS.HANDOVERS);
  await commitAndActivate(f);
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.HANDOVERS), before, "no V1 handover document created or mutated");
});

test("22. The bound frozen report and its freeze audit are immutable across commit → acceptance → finalize", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const reportId = (await getV2Document(f)).reportBinding.id;
  const reportBefore = (await ref("handover_reports_v2", reportId).get()).data();
  const freezeAuditsBefore = (await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).map(([id]) => id).sort();
  await commitAndActivate(f);
  await finalizeEqualHandoverReservationV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[1] });
  assert.deepEqual((await ref("handover_reports_v2", reportId).get()).data(), reportBefore, "the frozen report is not rewritten");
  assert.deepEqual((await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).map(([id]) => id).sort(), freezeAuditsBefore);
});

test("23. Cancelling the reservation blocks the commit and creates no shift", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  const binding = await v2Binding(f);
  await cancelEqualHandoverReservationForTechnicians({ outgoingShiftId: f.outgoing, actorUid: f.out[0],
    expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.snapshotHash, reason: "Cancelled for test" });
  // The cancelled reservation is no longer in the collecting lifecycle, so the
  // commit's authoritative lifecycle gate refuses it regardless of stale evidence.
  await assert.rejects(
    async () => commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) }),
    (error) => (error instanceof AssignmentOperationError || error instanceof EqualHandoverDomainError) && error.status === 409,
  );
  assert.equal((await ref("shifts", identity.incomingShiftId).get()).exists, false, "no incoming shift created after cancellation");
  assert.notEqual((await getV2Document(f)).lifecycleStatus, "awaiting_incoming_acceptance", "the cancelled handover did not commit");
  assert.equal((await auditsByAction("EQUAL_HANDOVER_OUTGOING_COMMITTED_V2")).length, 0, "no commitment receipt after cancellation");
});

// ===========================================================================
// §5 — the request carries reviewed evidence, never authority.
// ===========================================================================

test("24. The commit/transfer parsers refuse any field other than reviewed evidence", () => {
  const base = { expectedRevision: 1, expectedSnapshotHash: "a".repeat(64), expectedGuardRevision: 1, expectedFencingEpoch: 1 };
  assert.deepEqual(parseEqualHandoverTransferRequest(base), base);
  assert.deepEqual(parseCommitBody(base), base);
  for (const injected of ["actorUid", "role", "committedAt", "technicianUid", "transferAuthorized", "password"]) {
    assert.throws(() => parseEqualHandoverTransferRequest({ ...base, [injected]: "x" }), as400(/only the reviewed revision/));
    assert.throws(() => parseCommitBody({ ...base, [injected]: "x" }), as400(/Missing or unsupported report request fields/));
  }
  assert.throws(() => parseEqualHandoverTransferRequest({ ...base, expectedSnapshotHash: "not-a-hash" }), as400(/Invalid transfer revision/));
  assert.throws(() => parseEqualHandoverTransferRequest({ ...base, expectedRevision: 0 }), as400(/Invalid transfer revision/));
});

// ===========================================================================
// §9 — API surface (gate, session, origin, status). The commit + finalize
// routes need no password, so the real handlers are exercised directly.
// ===========================================================================

test("25. The commit route returns 404 with the dev gate disabled and runs no workflow", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await operationalState();
  delete process.env.HANDOVER_V2_DEV;
  routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
  try {
    const post = await commitRoute.POST(sameOrigin(commitUrl(f), "POST", "{}"), commitParams(f));
    assert.equal(post.status, 404);
  } finally {
    routeSessionUser = null;
  }
  assert.deepEqual(await operationalState(), before);
});

test("26. Enabled commit route: 401 anon, 403 foreign origin, 403 supervisor, 403 forced password, 200 fresh then 200 replay", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  process.env.HANDOVER_V2_DEV = "true";
  const body = JSON.stringify(await commitBinding(f));
  try {
    routeSessionUser = null;
    const anon = await commitRoute.POST(sameOrigin(commitUrl(f), "POST", body), commitParams(f));
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get("Cache-Control"), "no-store");

    const foreign = new NextRequest(commitUrl(f), { method: "POST", headers: { origin: "http://evil.example" }, body });
    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    const foreignResp = await commitRoute.POST(foreign, commitParams(f));
    assert.equal(foreignResp.status, 403);
    assert.equal((await foreignResp.json()).error, "Invalid request origin.");

    routeSessionUser = { uid: f.manager, role: "supervisor", mustChangePassword: false };
    const supervisor = await commitRoute.POST(sameOrigin(commitUrl(f), "POST", body), commitParams(f));
    assert.equal(supervisor.status, 403, "a supervisor cannot commit");

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: true };
    const forced = await commitRoute.POST(sameOrigin(commitUrl(f), "POST", body), commitParams(f));
    assert.equal(forced.status, 403, "a forced-password session cannot commit");

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    const ok = await commitRoute.POST(sameOrigin(commitUrl(f), "POST", body), commitParams(f));
    assert.equal(ok.status, 200, "a fresh commitment is 200");
    assert.equal(ok.headers.get("Cache-Control"), "no-store");
    const payload = await ok.json();
    assert.equal(payload.success, true);
    assert.equal(payload.status, "COMMITTED");
    assert.equal(payload.replayed, false);
    assert.equal(payload.reservation.aggregate.lifecycleStatus, "awaiting_incoming_acceptance");

    const replay = await commitRoute.POST(sameOrigin(commitUrl(f), "POST", JSON.stringify(await commitBinding(f))), commitParams(f));
    assert.equal(replay.status, 200, "a replay of the committed handover is 200");
    assert.equal((await replay.json()).replayed, true);
  } finally {
    routeSessionUser = null;
    delete process.env.HANDOVER_V2_DEV;
  }
});

test("27. Finalize route: 404 gate, 401 anon, 403 foreign origin, 409 before resolution, 400 non-empty body, 200 once resolved", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });

  // 404 before the gate is opened.
  delete process.env.HANDOVER_V2_DEV;
  routeSessionUser = { uid: f.incoming[0], role: "technician", mustChangePassword: false };
  try {
    const gated = await finalizeRoute.POST(sameOrigin(finalizeUrl(f), "POST", "{}"), commitParams(f));
    assert.equal(gated.status, 404);
  } finally {
    routeSessionUser = null;
  }

  process.env.HANDOVER_V2_DEV = "true";
  try {
    routeSessionUser = null;
    const anon = await finalizeRoute.POST(sameOrigin(finalizeUrl(f), "POST", "{}"), commitParams(f));
    assert.equal(anon.status, 401);

    routeSessionUser = { uid: f.incoming[0], role: "technician", mustChangePassword: false };
    const foreignResp = await finalizeRoute.POST(
      new NextRequest(finalizeUrl(f), { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" }), commitParams(f));
    assert.equal(foreignResp.status, 403);

    // One acceptance is not full resolution → 409.
    await runAcceptance(f, f.incoming[0], clock(f));
    const notReady = await finalizeRoute.POST(sameOrigin(finalizeUrl(f), "POST", "{}"), commitParams(f));
    assert.equal(notReady.status, 409, "finalize is refused while a partner has not accepted");

    const badBody = await finalizeRoute.POST(sameOrigin(finalizeUrl(f), "POST", JSON.stringify({ actorUid: "x" })), commitParams(f));
    assert.equal(badBody.status, 400, "the finalize route takes no fields");

    await runAcceptance(f, f.incoming[1], clock(f, 3));
    const ok = await finalizeRoute.POST(sameOrigin(finalizeUrl(f), "POST", "{}"), commitParams(f));
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.success, true);
    assert.equal(payload.status, "FINALIZED");
    assert.equal((await getGuard(f)).ownerLifecycleState, "completed");
  } finally {
    routeSessionUser = null;
    delete process.env.HANDOVER_V2_DEV;
  }
});

test("28. A committed handover rejects acceptance before activation, and a completed handover reads back as a coherent terminal report", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await commitAndActivate(f);
  await finalizeEqualHandoverReservationV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[1] });

  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.aggregate.lifecycleStatus, "completed");
  assert.equal(state.readiness.ready, false, "a completed handover is no longer open for commit");
  assert.ok(state.frozenReport !== null, "the terminal view still exposes the immutable frozen report");

  // A late commit against the completed lifecycle replays its commitment receipt.
  const replay = await commitEqualHandoverOutgoingV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await commitBinding(f)) });
  assert.equal(replay.status, "ALREADY_COMMITTED");
});
