/**
 * Firestore emulator integration tests for the equal-technician v2 ATOMIC FINAL
 * TRANSFER (TECH-HO-RECOVERY-07 §11). The suite drives the real production
 * writers end-to-end — reservation → freeze → confirmations → readiness →
 * transfer — and asserts final persisted Firestore documents, not service
 * return values. It proves the transfer derives its own authorization (§4),
 * replays idempotently from a deterministic receipt rather than a client random
 * id (§5), and never touches attendance, task transfers or the V1 lifecycle
 * (§7/§8).
 *
 * Run via: tests/run-handover-v2-transfer-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-handover-v2" on the
 * dedicated report-emulator port 8092 with synthetic accounts only. The suite
 * refuses to run against any other project or host, and refuses to run with the
 * development feature flag preset; the route-gate tests set and clear it around
 * the handler invocation only.
 *
 * Unlike the confirmation suite, the scheduled windows here are anchored to
 * Date.now() rather than a fixed future date, because the transfer enforces the
 * real shift activation window (assertShiftActivationWindow) against the
 * incoming reservation's scheduled start.
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
  transferEqualHandoverV2,
  parseEqualHandoverTransferRequest,
} = await import("../src/lib/operations/equal-handover-report-firestore.ts");
const { OPERATIONAL_COLLECTIONS } = await import("../src/lib/operations/collections.ts");
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");
const { recordShiftOperation } = await import("../src/lib/operations/shift-operations.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");

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
// wall clock so the transfer's activation window can pass.
// ---------------------------------------------------------------------------

async function makeActiveShiftFixture() {
  const prefix = `v2t${++seq}`;
  const now0 = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const f = {
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
// report can be frozen, confirmed and finally transferred. All observations
// fall inside the outgoing shift window (>= actualStart) and in the past.
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
// confirmed — the authoritative precondition for a transfer.
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
  const snap = await ref("equal_handovers_v2", createEqualHandoverDocumentId(f.outgoing)).get();
  return snap.exists ? snap.data() : null;
}

async function getGuard(f) {
  const snap = await ref(OPERATIONAL_COLLECTIONS.HANDOVER_RESERVATION_GUARDS, `guard_${f.outgoing}`).get();
  return snap.exists ? snap.data() : null;
}

// The exact reviewed evidence a transfer request may carry — and nothing else.
async function transferState(f) {
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
const as409 = (pattern) => expectsStatus(AssignmentOperationError, 409, pattern);

async function seedTask(f, status = "open", id = `${f.outgoing}-task`) {
  await ref("tasks", id).set({ id, shiftId: f.outgoing, title: "Post-freeze work", description: "Pending",
    priority: "medium", sectionId: null, status, createdBy: f.manager, createdAt: f.outStart, updatedAt: f.outStart });
  return id;
}

async function confirmState(f) {
  const b = await v2Binding(f);
  return { expectedRevision: b.expectedRevision, expectedSnapshotHash: b.expectedSnapshotHash };
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

const transferRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/transfer/route.ts",
);

// ===========================================================================
// §6/§7 — golden path: one atomic transaction moves the whole handover.
// ===========================================================================

test("1. A confirmed outgoing technician transfers atomically: aggregate completed, incoming shift created, outgoing completed", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  const before = await operationalState();
  const state = await transferState(f);
  const result = await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state });
  assert.equal(result.status, "TRANSFERRED");
  assert.equal(result.replayed, false);
  assert.equal(result.aggregate.lifecycleStatus, "completed");
  assert.equal(result.snapshotHash, createEqualHandoverSnapshot(result.aggregate).snapshotHash, "result snapshot binds the completed aggregate");

  const stored = await getV2Document(f);
  assert.equal(stored.lifecycleStatus, "completed", "aggregate persists the completed lifecycle");
  assert.ok(!before.shifts.map(([id]) => id).includes(identity.incomingShiftId), "incoming shift did not exist before");
  const incoming = await ref("shifts", identity.incomingShiftId).get();
  assert.equal(incoming.exists, true, "the reserved incoming shift is now created");
  const created = incoming.data();
  assert.equal(created.id, identity.incomingShiftId);
  assert.equal(created.status, "active");
  assert.equal(created.operationalSlotToken, identity.successorSlotToken);
  assert.equal(created.permanentPairId, identity.incomingPermanentPairId);
  assert.deepEqual(created.primaryTechnicianIds, [...identity.incomingTechnicianIds]);
  assert.equal(created.operationalGeneration, identity.successorGeneration);
  assert.equal(created.previousShiftId, f.outgoing);
  assert.equal(created.previousOperationalSlotToken, identity.outgoingSlotToken);
  assert.equal(created.handoverDocumentId, createEqualHandoverDocumentId(f.outgoing));
  assert.equal(created.actualEnd, null);
  assert.equal(typeof created.actualStart, "string");

  const outgoing = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(outgoing.status, "completed", "the outgoing shift is completed");
  assert.equal(outgoing.completedBy, f.out[0]);
  assert.equal(typeof outgoing.actualEnd, "string");
});

test("2. Either outgoing reserved technician may initiate the transfer (equal authority)", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const state = await transferState(f);
  const result = await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...state });
  assert.equal(result.status, "TRANSFERRED");
  assert.equal(result.receipt.actorUid, f.out[1]);
  const incoming = await ref("shifts", (await getV2Document(f)).identity.incomingShiftId).get();
  assert.equal(incoming.exists, true);
});

test("3. Outgoing memberships finalize and incoming memberships are created", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  for (const uid of identity.outgoingTechnicianIds) {
    const m = (await ref("shift_members", `${f.outgoing}_${uid}`).get()).data();
    assert.equal(typeof m.leftAt, "string", "outgoing membership is closed");
  }
  for (const uid of identity.incomingTechnicianIds) {
    const m = (await ref("shift_members", `${identity.incomingShiftId}_${uid}`).get()).data();
    assert.equal(m.shiftId, identity.incomingShiftId);
    assert.equal(m.technicianId, uid);
    assert.equal(m.role, "primary");
    assert.equal(m.leftAt, null);
  }
});

test("4. Technician schedules move atomically: outgoing entry dropped, incoming entry activated", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  for (const uid of identity.outgoingTechnicianIds) {
    const entries = (await ref("technician_schedules", uid).get()).data().entries;
    assert.ok(!entries.some((e) => e.shiftId === f.outgoing), "outgoing schedule entry removed");
  }
  for (const uid of identity.incomingTechnicianIds) {
    const entry = (await ref("technician_schedules", uid).get()).data().entries.find((e) => e.shiftId === identity.incomingShiftId);
    assert.equal(entry.status, "active", "incoming schedule entry activated");
  }
});

test("5. Operational control advances to the incoming successor exactly once", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  const before = (await ref("operational_shift_control", "global").get()).data();
  assert.equal(before.generation, identity.outgoingGeneration);
  await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  const after = (await ref("operational_shift_control", "global").get()).data();
  assert.equal(after.generation, identity.successorGeneration, "control generation advanced by one");
  assert.equal(after.slotToken.toLowerCase(), identity.successorSlotToken.toLowerCase());
  assert.equal(after.shiftId, identity.incomingShiftId);
});

test("6. The reservation guard completes and pins the transfer receipt as terminal evidence", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  const guard = await getGuard(f);
  assert.equal(guard.ownerLifecycleState, "completed");
  const [receiptId] = (await auditsByAction("EQUAL_SHIFT_HANDOVER_TRANSFERRED_V2"))[0];
  assert.equal(guard.terminalEvidenceRef, receiptId, "guard terminal evidence is the committed receipt");
});

test("7. The transfer receipt is a durable, self-verifiable audit record bound to the frozen report", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const storedBefore = await getV2Document(f);
  const state = await transferState(f);
  const result = await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state });
  const audits = await auditsByAction("EQUAL_SHIFT_HANDOVER_TRANSFERRED_V2");
  assert.equal(audits.length, 1, "exactly one transfer receipt");
  const [receiptId, receipt] = audits[0];
  assert.equal(receipt.id, receiptId);
  assert.equal(receipt.schema, "equal-handover-transfer-v2");
  assert.equal(receipt.protocol, "equal-handover-v2");
  assert.equal(receipt.outcome, "TRANSFERRED");
  assert.equal(receipt.actorRole, "technician");
  assert.equal(receipt.outgoingShiftId, f.outgoing);
  assert.equal(receipt.incomingShiftId, storedBefore.identity.incomingShiftId);
  assert.equal(receipt.finalRevision, result.aggregate.revision);
  assert.equal(receipt.finalSnapshotHash, createEqualHandoverSnapshot(result.aggregate).snapshotHash);
  assert.equal(receipt.boundReportId, storedBefore.reportBinding.id, "receipt names the frozen report it transferred");
  assert.match(receipt.receiptHash, /^[0-9a-f]{64}$/);
  assert.ok(!/password|refreshToken|idToken|sessionCookie|cookie/i.test(JSON.stringify(receipt)), "receipt must not carry credentials");
});

test("8. Absence-aware readiness: three confirmations plus one supported absence still authorizes a transfer", async () => {
  await clearDb();
  const f = await makeReadyFixture({ absence: true });
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[0])).readiness.ready, true);
  const result = await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  assert.equal(result.status, "TRANSFERRED");
  const incoming = await ref("shifts", (await getV2Document(f)).identity.incomingShiftId).get();
  assert.equal(incoming.exists, true);
});

// ===========================================================================
// §4 — authorization is derived by the transfer, never inherited.
// ===========================================================================

test("9. A supervisor, an incoming technician and an unrelated technician cannot initiate the transfer", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  const before = await operationalState();
  const state = await transferState(f);
  await assert.rejects(
    () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.manager, ...state }),
    as403(/not authorized to access v2 handover reports/),
  );
  await assert.rejects(
    () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.incoming[0], ...state }),
    as403(/outgoing reserved technician/),
  );
  await assert.rejects(
    () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.unrelated, ...state }),
    as403(/outgoing reserved technician/),
  );
  assert.deepEqual(await operationalState(), before, "unauthorized attempts mutate nothing");
  assert.equal((await ref("shifts", identity.incomingShiftId).get()).exists, false);
});

test("10. An outgoing technician who has not personally confirmed cannot transfer, even when the handover is otherwise ready", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  // everyone except out[1] confirms; readiness is blocked, and out[1] lacks the
  // personal confirmation that the transfer authority requires.
  for (const uid of [f.out[0], f.incoming[0], f.incoming[1]]) {
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: uid, ...(await confirmState(f)) });
  }
  const before = await operationalState();
  await assert.rejects(
    async () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...(await transferState(f)) }),
    as403(/personally confirmed outgoing technician/),
  );
  assert.deepEqual(await operationalState(), before);
});

test("11. A confirmed outgoing technician cannot transfer while other confirmations are missing: readiness is re-derived", async () => {
  await clearDb();
  const f = await makeFrozenFixture();
  await confirmEqualHandoverParticipantV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await confirmState(f)) });
  const before = await operationalState();
  await assert.rejects(
    async () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) }),
    as409(/not ready to transfer/),
  );
  assert.deepEqual(await operationalState(), before);
  assert.equal((await getV2Document(f)).lifecycleStatus, "collecting_confirmations");
});

test("12. A prior readiness GET is not trusted: transfer refuses when evidence no longer supports it", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  assert.equal((await readEqualHandoverReportState(f.outgoing, f.out[0])).readiness.ready, true, "readiness was true moments ago");
  // Authoritative work evidence moves after readiness was observed, so the
  // bound report drifts and the transfer's live re-derivation refuses.
  await seedTask(f, "open");
  const before = await operationalState();
  await assert.rejects(
    async () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) }),
    as409(/ready to transfer|incomplete report/),
  );
  assert.deepEqual(await operationalState(), before, "a refused transfer mutates nothing");
});

// ===========================================================================
// §4/§5 — stale reviewed evidence, guard epoch and idempotency.
// ===========================================================================

test("13. A stale expectedRevision is rejected and writes nothing", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const state = await transferState(f);
  const before = await operationalState();
  await assert.rejects(
    () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state, expectedRevision: state.expectedRevision + 1 }),
    as409(/Stale equal handover revision|revision/),
  );
  assert.deepEqual(await operationalState(), before);
});

test("14. A stale expectedSnapshotHash is rejected and writes nothing", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const state = await transferState(f);
  const before = await operationalState();
  await assert.rejects(
    () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state, expectedSnapshotHash: "f".repeat(64) }),
    (error) => error instanceof AssignmentOperationError && error.status === 409,
  );
  assert.deepEqual(await operationalState(), before);
});

test("15. A stale guard revision or fencing epoch is rejected and writes nothing", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const state = await transferState(f);
  const before = await operationalState();
  await assert.rejects(
    () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state, expectedGuardRevision: state.expectedGuardRevision + 99 }),
    as409(/reservation guard changed/),
  );
  await assert.rejects(
    () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...state, expectedFencingEpoch: state.expectedFencingEpoch + 7 }),
    as409(/reservation guard changed/),
  );
  assert.deepEqual(await operationalState(), before);
});

test("16. A replayed transfer returns the committed receipt and mutates nothing", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const first = await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  assert.equal(first.replayed, false);
  const afterFirst = await operationalState();
  // Fresh reviewed evidence for the now-completed reservation drives the replay.
  const replay = await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...(await transferState(f)) });
  assert.equal(replay.status, "ALREADY_TRANSFERRED");
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.id, first.receipt.id);
  assert.equal(replay.receipt.receiptHash, first.receipt.receiptHash);
  assert.deepEqual(await operationalState(), afterFirst, "a replay writes nothing new");
  assert.equal((await auditsByAction("EQUAL_SHIFT_HANDOVER_TRANSFERRED_V2")).length, 1);
});

test("17. Concurrent transfers by two confirmed technicians commit exactly one transfer", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  const shared = await transferState(f);
  const settled = await Promise.allSettled([
    transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...shared }),
    transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[1], ...shared }),
  ]);
  const fulfilled = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const committed = fulfilled.filter((r) => r.status === "TRANSFERRED");
  assert.equal(committed.length, 1, "exactly one call performs the transfer");
  const rejected = settled.filter((r) => r.status === "rejected");
  for (const r of rejected) assert.ok(r.reason instanceof AssignmentOperationError || r.reason instanceof EqualHandoverDomainError);
  // A single durable transfer regardless of how the loser was resolved.
  assert.equal((await auditsByAction("EQUAL_SHIFT_HANDOVER_TRANSFERRED_V2")).length, 1);
  assert.equal((await ref("shifts", identity.incomingShiftId).get()).exists, true);
  const after = (await ref("operational_shift_control", "global").get()).data();
  assert.equal(after.generation, identity.successorGeneration, "control advanced exactly once, not twice");
});

// ===========================================================================
// §7/§8 — boundary: attendance, tasks and V1 are never touched.
// ===========================================================================

test("18. The transfer never synthesizes or finalizes attendance", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await operationalState();
  await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.SHIFT_ATTENDANCE), before.attendanceLegacy, "legacy attendance byte-unchanged");
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.ATTENDANCE_EVIDENCE_V2), before.attendanceV2, "v2 attendance evidence byte-unchanged");
});

test("19. The transfer never creates task transfers or mutates tasks", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await operationalState();
  await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.HANDOVER_TASK_TRANSFERS), before.handoverTransfers, "no task re-parented");
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.TASKS), before.tasks, "no task fabricated complete");
});

test("20. The legacy V1 handover lifecycle is never entered by a v2 transfer", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await collectionState(OPERATIONAL_COLLECTIONS.HANDOVERS);
  await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  assert.deepEqual(await collectionState(OPERATIONAL_COLLECTIONS.HANDOVERS), before, "no V1 handover document created or mutated");
});

test("21. The bound frozen report and its freeze audit are immutable across the transfer", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const reportId = (await getV2Document(f)).reportBinding.id;
  const reportBefore = (await ref("handover_reports_v2", reportId).get()).data();
  const freezeAuditsBefore = (await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).map(([id]) => id).sort();
  await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  assert.deepEqual((await ref("handover_reports_v2", reportId).get()).data(), reportBefore, "the frozen report is not rewritten");
  assert.deepEqual((await auditsByAction("EQUAL_HANDOVER_REPORT_FROZEN_V2")).map(([id]) => id).sort(), freezeAuditsBefore);
});

test("22. Cancelling the reservation closes the lifecycle; a later transfer is refused and creates no shift", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const identity = (await getV2Document(f)).identity;
  const binding = await v2Binding(f);
  await cancelEqualHandoverReservationForTechnicians({ outgoingShiftId: f.outgoing, actorUid: f.out[0],
    expectedRevision: binding.expectedRevision, expectedSnapshotHash: binding.snapshotHash, reason: "Cancelled for test" });
  // The cancelled reservation is no longer in the collecting lifecycle, so the
  // transfer's authoritative lifecycle gate refuses it regardless of any stale
  // reviewed evidence the caller carries.
  await assert.rejects(
    async () => transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) }),
    (error) => (error instanceof AssignmentOperationError || error instanceof EqualHandoverDomainError) && error.status === 409,
  );
  assert.equal((await ref("shifts", identity.incomingShiftId).get()).exists, false, "no incoming shift created after cancellation");
  assert.notEqual((await getV2Document(f)).lifecycleStatus, "completed", "the cancelled handover did not complete");
  assert.equal((await auditsByAction("EQUAL_SHIFT_HANDOVER_TRANSFERRED_V2")).length, 0, "no transfer receipt after cancellation");
});

// ===========================================================================
// §5 — the transfer request carries reviewed evidence, never authority.
// ===========================================================================

test("23. The transfer parser refuses any body field other than reviewed evidence", () => {
  const base = { expectedRevision: 1, expectedSnapshotHash: "a".repeat(64), expectedGuardRevision: 1, expectedFencingEpoch: 1 };
  assert.deepEqual(parseEqualHandoverTransferRequest(base), base);
  for (const injected of ["actorUid", "role", "transferredAt", "technicianUid", "transferAuthorized"]) {
    assert.throws(() => parseEqualHandoverTransferRequest({ ...base, [injected]: "x" }), as400(/only the reviewed revision/));
  }
  assert.throws(() => parseEqualHandoverTransferRequest({ ...base, expectedSnapshotHash: "not-a-hash" }), as400(/Invalid transfer revision/));
  assert.throws(() => parseEqualHandoverTransferRequest({ ...base, expectedRevision: 0 }), as400(/Invalid transfer revision/));
});

// ===========================================================================
// §9 — API surface (gate, session, origin, success).
// ===========================================================================

test("24. The transfer route returns 404 with the dev gate disabled and runs no workflow", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  const before = await operationalState();
  delete process.env.HANDOVER_V2_DEV;
  const params = { params: Promise.resolve({ shiftId: f.outgoing }) };
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2/transfer`;
  routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
  try {
    const post = await transferRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }), params);
    assert.equal(post.status, 404);
  } finally {
    routeSessionUser = null;
  }
  assert.deepEqual(await operationalState(), before);
});

test("25. Enabled transfer route: 401 anon, 403 foreign origin, 403 supervisor, 403 forced password, 201 then 200 replay", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  process.env.HANDOVER_V2_DEV = "true";
  const state = await transferState(f);
  const body = JSON.stringify(state);
  const params = { params: Promise.resolve({ shiftId: f.outgoing }) };
  const base = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2/transfer`;
  try {
    routeSessionUser = null;
    const anon = await transferRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body }), params);
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get("Cache-Control"), "no-store");

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    const foreign = await transferRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://evil.example" }, body }), params);
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).error, "Invalid request origin.");

    routeSessionUser = { uid: f.manager, role: "supervisor", mustChangePassword: false };
    const supervisor = await transferRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body }), params);
    assert.equal(supervisor.status, 403, "a supervisor cannot transfer");

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: true };
    const forced = await transferRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body }), params);
    assert.equal(forced.status, 403, "a forced-password session cannot transfer");

    routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
    const ok = await transferRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body }), params);
    assert.equal(ok.status, 201, "a fresh committed transfer is 201");
    assert.equal(ok.headers.get("Cache-Control"), "no-store");
    const payload = await ok.json();
    assert.equal(payload.success, true);
    assert.equal(payload.status, "TRANSFERRED");
    assert.equal(payload.replayed, false);

    const replay = await transferRoute.POST(new NextRequest(base, { method: "POST", headers: { origin: "http://localhost:3000" }, body: JSON.stringify(await transferState(f)) }), params);
    assert.equal(replay.status, 200, "a replay of the committed transfer is 200");
    assert.equal((await replay.json()).replayed, true);
  } finally {
    routeSessionUser = null;
    delete process.env.HANDOVER_V2_DEV;
  }
});

test("26. A completed v2 handover reads back as a coherent terminal report for the technician", async () => {
  await clearDb();
  const f = await makeReadyFixture();
  await transferEqualHandoverV2({ outgoingShiftId: f.outgoing, actorUid: f.out[0], ...(await transferState(f)) });
  const state = await readEqualHandoverReportState(f.outgoing, f.out[0]);
  assert.equal(state.aggregate.lifecycleStatus, "completed");
  assert.equal(state.readiness.ready, false, "a completed handover is no longer open for transfer");
  assert.ok(state.frozenReport !== null, "the terminal view still exposes the immutable frozen report");
});
