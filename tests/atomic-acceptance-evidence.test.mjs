/**
 * Network-free tests for the transaction-composable incoming attendance
 * evidence plan. No Firebase SDK, emulator, server-only module or network is
 * reachable: Firestore is an in-memory transaction double.
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const MODULE_PATHS = [
  "src/types/attendance-evidence.ts",
  "src/types/equal-technician-handover.ts",
  "src/types/handover-reservation-guard.ts",
  "src/types/handover-report-v2.ts",
  "src/types/incoming-acceptance-application.ts",
  "src/lib/operations/equal-handover-report-domain.ts",
  "src/lib/operations/equal-technician-handover-domain.ts",
  "src/lib/operations/attendance-evidence-domain.ts",
  "src/lib/operations/incoming-acceptance-application-domain.ts",
  "src/lib/operations/handover-reservation-guard-domain.ts",
  "src/lib/operations/collections.ts",
  "src/lib/operations/attendance-evidence-firestore-state.ts",
  "src/lib/operations/atomic-acceptance-evidence.ts",
];

const sources = new Map();
for (const path of MODULE_PATHS) {
  sources.set(path, await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}
const compiled = new Map();
for (const path of MODULE_PATHS) {
  compiled.set(
    path,
    ts.transpileModule(sources.get(path), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );
}

const OUT_A = "out-a";
const OUT_B = "out-b";
const IN_A = "in-a";
const IN_B = "in-b";
const OUTGOING = "outgoing";
const INCOMING = "incoming";
const DOC = "handover_v2_outgoing";
const GUARD = "guard_outgoing";
const TOKEN = "a0000000-0000-4000-8000-000000000001";
const SUCCESSOR = "a0000000-0000-4000-8000-000000000002";
const RESERVED_AT = "2026-10-28T07:50:00.000Z";
const START = "2026-10-28T08:00:00.000Z";
const END = "2026-10-28T16:00:00.000Z";
const AUTH_TIME = "2026-10-28T08:01:00.000Z";

class Timestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  static fromDate(date) {
    const ms = date.getTime();
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }
  toDate() {
    return new Date(this.seconds * 1000 + this.nanoseconds / 1e6);
  }
}

function clone(value) {
  if (value instanceof Timestamp) return new Timestamp(value.seconds, value.nanoseconds);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function createWorld() {
  const records = new Map();
  const writes = [];
  const reads = [];
  let writing = false;
  let commits = 0;
  let independentCommits = 0;
  let commitFailure = false;
  let failReadPath = null;
  let orderViolation = false;

  const snapshot = (path) => ({
    id: path.slice(path.indexOf("/") + 1),
    exists: records.has(path),
    data: () => clone(records.get(path)),
  });
  const ref = (path) => ({
    path,
    id: path.slice(path.indexOf("/") + 1),
    get: async () => snapshot(path),
  });
  const db = {
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async () => {
      independentCommits += 1;
      throw new Error("The composable evidence adapter must never start its own transaction.");
    },
  };
  const transaction = {
    get: async (target) => {
      if (writing) orderViolation = true;
      if (failReadPath !== null && target.path === failReadPath) {
        throw new Error(`Injected read failure at ${target.path}`);
      }
      reads.push(target.path);
      return snapshot(target.path);
    },
    create: (target, data) => {
      writing = true;
      writes.push({ op: "create", path: target.path, data: clone(data) });
    },
    set: (target, data) => {
      writing = true;
      writes.push({ op: "set", path: target.path, data: clone(data) });
    },
  };
  const commit = () => {
    commits += 1;
    if (commitFailure) throw new Error("Injected transaction commit failure");
    for (const write of writes) {
      if (write.op === "create") assert.equal(records.has(write.path), false, `duplicate ${write.path}`);
      records.set(write.path, clone(write.data));
    }
  };
  return {
    records,
    writes,
    reads,
    db,
    transaction,
    commit,
    get commits() { return commits; },
    get independentCommits() { return independentCommits; },
    get orderViolation() { return orderViolation; },
    set commitFailure(value) { commitFailure = value; },
    set failReadPath(value) { failReadPath = value; },
  };
}

function createLoader(world) {
  const cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    if (!compiled.has(path)) throw new Error(`Module source was not preloaded: ${path}`);
    const exports = {};
    cache.set(path, exports);
    runInNewContext(compiled.get(path), {
      exports,
      Object,
      Array,
      Map,
      Set,
      Math,
      JSON,
      Date,
      TextEncoder,
      structuredClone: clone,
      console,
      process: { env: {} },
      require(specifier) {
        if (specifier === "server-only") return {};
        if (specifier === "node:crypto") return { createHash };
        if (specifier === "firebase-admin/firestore") {
          return { Timestamp, FieldValue: { serverTimestamp: () => Timestamp.fromDate(new Date()) } };
        }
        if (specifier === "@/lib/firebase/admin") {
          return { getAdminFirestore: () => world.db };
        }
        let target;
        if (specifier.startsWith("@/")) target = `src/${specifier.slice(2)}.ts`;
        else if (specifier.startsWith("./")) {
          const directory = path.slice(0, path.lastIndexOf("/") + 1);
          target = `${directory}${specifier.slice(2)}.ts`;
        } else {
          throw new Error(`Unexpected import: ${specifier}`);
        }
        return load(target);
      },
    });
    return exports;
  }
  return load;
}

function createFixture() {
  const world = createWorld();
  const load = createLoader(world);
  const eq = load("src/lib/operations/equal-technician-handover-domain.ts");
  const guardDomain = load("src/lib/operations/handover-reservation-guard-domain.ts");
  const evidence = load("src/lib/operations/attendance-evidence-domain.ts");
  const phase1 = load("src/lib/operations/incoming-acceptance-application-domain.ts");
  const composition = load("src/lib/operations/atomic-acceptance-evidence.ts");

  const identity = {
    schema: "equal-handover-v2",
    outgoingShiftId: OUTGOING,
    outgoingPermanentPairId: "out-pair",
    outgoingTechnicianIds: [OUT_A, OUT_B],
    outgoingSlotToken: TOKEN,
    outgoingGeneration: 1,
    incomingShiftId: INCOMING,
    incomingPermanentPairId: "in-pair",
    incomingTechnicianIds: [IN_A, IN_B],
    successorSlotToken: SUCCESSOR,
    successorGeneration: 2,
    shiftType: "morning",
    scheduledStart: START,
    scheduledEnd: END,
  };
  let aggregate = eq.createEqualHandover({ identity, reservedAt: RESERVED_AT, reservedBy: OUT_A });
  let guard = guardDomain.createInitialReservationGuard({
    outgoingShiftId: OUTGOING,
    protocolOwner: "v2",
    ownerHandoverDocumentId: DOC,
    outgoingSlotToken: TOKEN,
    outgoingGeneration: 1,
    successorSlotToken: SUCCESSOR,
    successorGeneration: 2,
    reservationId: aggregate.reservation.handoverId,
    reservedIncomingShiftId: INCOMING,
    reservedAt: RESERVED_AT,
    reservedBy: OUT_A,
  });
  world.records.set(`equal_handovers_v2/${DOC}`, aggregate);
  world.records.set(`handover_reservation_guards/${GUARD}`, guard);

  const appIdentity = phase1.createIncomingAcceptanceApplicationIdentity({
    handoverId: aggregate.reservation.handoverId,
    technicianUid: IN_A,
    kind: evidence.ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
  });
  const request = {
    schema: "attendance-evidence-v2",
    handoverId: aggregate.reservation.handoverId,
    handoverDocumentId: DOC,
    eventId: appIdentity.eventId,
    position: "incoming_tech_a",
    technicianUid: IN_A,
    kind: evidence.ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
    scheduledStart: START,
    scheduledEnd: END,
    reportedDepartureTime: null,
    attestedByUid: null,
    attestationReason: null,
    lateReason: null,
    handoverRevision: aggregate.revision,
    snapshotHash: eq.createEqualHandoverSnapshot(aggregate).snapshotHash,
    expectedGuardRevision: guard.guardRevision,
    expectedFencingEpoch: guard.fencingEpoch,
  };
  const input = {
    request,
    identity: aggregate.identity,
    reservation: aggregate.reservation,
    trustedAuthentication: {
      verifiedTechnicianUid: IN_A,
      method: evidence.ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_CONFIRMATION,
    },
    serverAuthenticationTime: AUTH_TIME,
  };

  return {
    world,
    load,
    eq,
    guardDomain,
    evidence,
    phase1,
    composition,
    appIdentity,
    request,
    input,
    get aggregate() { return aggregate; },
    get guard() { return guard; },
    set guard(value) { guard = value; },
    set aggregate(value) { aggregate = value; },
  };
}

function prepare(fixture, input = fixture.input) {
  return fixture.composition.prepareAtomicAcceptanceEvidence(fixture.world.transaction, input);
}

function seedEvidence(fixture, kind, uid = IN_A, lateReason = null) {
  const identity = fixture.phase1.createIncomingAcceptanceApplicationIdentity({
    handoverId: fixture.aggregate.reservation.handoverId,
    technicianUid: uid,
    kind,
  });
  const request = {
    ...fixture.request,
    eventId: identity.eventId,
    technicianUid: uid,
    position: uid === IN_A ? "incoming_tech_a" : "incoming_tech_b",
    kind,
    lateReason,
  };
  const pending = fixture.evidence.assertAttendanceOperation({
    ...fixture.evidence.createPendingAttendanceOperation(request),
    requestedAt: AUTH_TIME,
  });
  const built = fixture.evidence.buildAttendanceEvidence({
    operation: pending,
    serverTime: AUTH_TIME,
    guard: fixture.guard,
    reservation: fixture.aggregate.reservation,
    identity: fixture.aggregate.identity,
    trustedAuthentication: {
      verifiedTechnicianUid: uid,
      method: fixture.evidence.attendanceAuthenticationMethodForKind(kind),
    },
  });
  fixture.world.records.set(`attendance_evidence_v2/${built.id}`, clone(built));
  return { pending, evidence: built };
}

test("a clean request plans one finalized operation and one evidence document without committing", async () => {
  const fixture = createFixture();
  const plan = await prepare(fixture);

  assert.equal(plan.mode, "create_operation_and_evidence");
  assert.equal(plan.operation.status, "finalized");
  assert.equal(plan.operation.interruptedFinalization, true);
  assert.equal(plan.operation.requestedAt, AUTH_TIME);
  assert.equal(plan.evidence.eventTime, AUTH_TIME);
  assert.equal(plan.evidence.operationId, plan.operationId);
  assert.equal(plan.operationId, fixture.appIdentity.operationId);
  assert.equal(plan.evidenceId, fixture.appIdentity.evidenceId);
  assert.equal(plan.operationalAcceptance, false);
  assert.equal(plan.acknowledgementRequired, true);
  assert.deepEqual(fixture.world.writes.map((write) => write.op), ["create", "create"]);
  assert.equal(fixture.world.commits, 0);
  assert.equal(fixture.world.independentCommits, 0);
  assert.equal(fixture.world.orderViolation, false);

  fixture.world.commit();
  assert.equal(fixture.world.commits, 1);
  const storedOperation = fixture.world.records.get(`attendance_evidence_operations_v2/${plan.operationId}`);
  const storedEvidence = fixture.world.records.get(`attendance_evidence_v2/${plan.evidenceId}`);
  assert.equal(storedOperation.status, "finalized");
  assert.equal(storedEvidence.operationId, plan.operationId);
  assert.equal(storedEvidence.eventTime.toDate().toISOString(), AUTH_TIME);
  assert.equal(storedEvidence.clockIn.toDate().toISOString(), AUTH_TIME);
  assert.equal(storedEvidence.personallyAuthenticated, true);
});

test("finalized evidence replays without writes, even after the guard completes", async () => {
  const fixture = createFixture();
  const plan = await prepare(fixture);
  fixture.world.commit();

  const stored = fixture.world.records.get(`attendance_evidence_operations_v2/${plan.operationId}`);
  fixture.world.records.set(`attendance_evidence_operations_v2/${plan.operationId}`, {
    ...stored,
    interruptedFinalization: false,
  });
  const guard = fixture.world.records.get(`handover_reservation_guards/${GUARD}`);
  fixture.world.records.set(`handover_reservation_guards/${GUARD}`, {
    ...guard,
    ownerLifecycleState: "completed",
  });
  fixture.world.writes.length = 0;

  const replay = await prepare(fixture);
  assert.equal(replay.mode, "replay_finalized_operation");
  assert.equal(replay.operation.id, plan.operation.id);
  assert.equal(replay.evidence.id, plan.evidence.id);
  assert.equal(replay.operationalAcceptance, false);
  assert.equal(replay.acknowledgementRequired, false);
  assert.deepEqual(fixture.world.writes, []);
  assert.equal(fixture.world.commits, 1);
});

test("a finalized but unapplied legacy slot replays as evidence only, never acceptance", async () => {
  const fixture = createFixture();
  const seeded = seedEvidence(
    fixture,
    fixture.evidence.ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
  );
  const finalized = fixture.evidence.assertAttendanceOperation({
    ...seeded.pending,
    status: "finalized",
    interruptedFinalization: false,
    finalizedAt: seeded.evidence.finalizedAt,
  });
  fixture.world.records.set(`attendance_evidence_operations_v2/${finalized.id}`, clone(finalized));

  const plan = await prepare(fixture);
  assert.equal(plan.mode, "replay_finalized_operation");
  assert.equal(plan.operation.status, "finalized");
  assert.equal(plan.evidence.eventTime, AUTH_TIME);
  assert.equal(plan.operationalAcceptance, false);
  assert.deepEqual(fixture.world.writes, []);
});

test("conflicting same-technician clock-in evidence fails closed without writes", async () => {
  const fixture = createFixture();
  seedEvidence(
    fixture,
    fixture.evidence.ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE,
    IN_A,
    "Late arrival",
  );

  await assert.rejects(
    () => prepare(fixture),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /Conflicting attendance evidence/);
      return true;
    },
  );
  assert.deepEqual(fixture.world.writes, []);
  assert.equal(fixture.world.commits, 0);
});

test("a trusted authentication subject other than the evidence subject is rejected", async () => {
  const fixture = createFixture();
  const input = {
    ...fixture.input,
    trustedAuthentication: {
      ...fixture.input.trustedAuthentication,
      verifiedTechnicianUid: IN_B,
    },
  };
  await assert.rejects(
    () => prepare(fixture, input),
    (error) => error.status === 403,
  );
  assert.deepEqual(fixture.world.writes, []);
});

test("a foreign handover document binding is rejected before any write", async () => {
  const fixture = createFixture();
  const input = {
    ...fixture.input,
    request: { ...fixture.input.request, handoverDocumentId: "handover_v2_other" },
  };
  await assert.rejects(
    () => prepare(fixture, input),
    (error) => error.status === 409,
  );
  assert.deepEqual(fixture.world.writes, []);
});

test("a stale reviewed guard binding is rejected before any write", async () => {
  const fixture = createFixture();
  const guard = fixture.world.records.get(`handover_reservation_guards/${GUARD}`);
  fixture.world.records.set(`handover_reservation_guards/${GUARD}`, {
    ...guard,
    guardRevision: guard.guardRevision + 1,
  });
  await assert.rejects(
    () => prepare(fixture),
    (error) => error.status === 409 && /stale guard revision/.test(error.message),
  );
  assert.deepEqual(fixture.world.writes, []);
});

test("a matching pending operation is finalized in place, not duplicated", async () => {
  const fixture = createFixture();
  const pending = fixture.evidence.assertAttendanceOperation({
    ...fixture.evidence.createPendingAttendanceOperation(fixture.request),
    requestedAt: "2026-10-28T07:59:00.000Z",
  });
  fixture.world.records.set(`attendance_evidence_operations_v2/${pending.id}`, clone(pending));

  const plan = await prepare(fixture);
  assert.equal(plan.mode, "finalize_pending_operation");
  assert.equal(plan.operation.id, pending.id);
  assert.equal(plan.operation.status, "finalized");
  assert.deepEqual(fixture.world.writes.map((write) => write.op), ["create", "set"]);
  fixture.world.commit();
  assert.equal(
    fixture.world.records.get(`attendance_evidence_operations_v2/${pending.id}`).status,
    "finalized",
  );
  assert.equal(fixture.world.records.has(`attendance_evidence_v2/${plan.evidenceId}`), true);
});

test("a pending operation with a changed reviewed binding is rejected, never adopted", async () => {
  const fixture = createFixture();
  const pending = fixture.evidence.assertAttendanceOperation({
    ...fixture.evidence.createPendingAttendanceOperation({
      ...fixture.request,
      expectedGuardRevision: fixture.request.expectedGuardRevision + 1,
    }),
    requestedAt: "2026-10-28T07:59:00.000Z",
  });
  fixture.world.records.set(`attendance_evidence_operations_v2/${pending.id}`, clone(pending));

  await assert.rejects(
    () => prepare(fixture),
    (error) => error.status === 409 && /different request binding/.test(error.message),
  );
  assert.deepEqual(fixture.world.writes, []);
});

test("all authoritative reads precede the first queued write", async () => {
  const fixture = createFixture();
  await prepare(fixture);
  assert.equal(fixture.world.orderViolation, false);
  assert.ok(fixture.world.reads.length > 0);
  assert.deepEqual(fixture.world.writes.map((write) => write.op), ["create", "create"]);
});

test("a read failure leaves the transaction with no queued writes", async () => {
  const fixture = createFixture();
  fixture.world.failReadPath = `equal_handovers_v2/${DOC}`;
  await assert.rejects(
    () => prepare(fixture),
    /Injected read failure/,
  );
  assert.deepEqual(fixture.world.writes, []);
});

test("a commit failure leaves no partial operation or evidence records", async () => {
  const fixture = createFixture();
  await prepare(fixture);
  const before = clone([...fixture.world.records]);
  fixture.world.commitFailure = true;
  assert.throws(() => fixture.world.commit(), /Injected transaction commit failure/);
  assert.deepEqual(clone([...fixture.world.records]), before);
  assert.equal(
    fixture.world.records.has(
      `attendance_evidence_v2/${fixture.appIdentity.evidenceId}`,
    ),
    false,
  );
});

test("deterministic identities are stable across independent planning runs", async () => {
  const first = createFixture();
  const second = createFixture();
  const firstPlan = await prepare(first);
  const secondPlan = await prepare(second);
  assert.equal(firstPlan.operationId, secondPlan.operationId);
  assert.equal(firstPlan.evidenceId, secondPlan.evidenceId);
  assert.equal(firstPlan.evidence.eventId, secondPlan.evidence.eventId);
  assert.equal(firstPlan.evidence.slotId, secondPlan.evidence.slotId);
  assert.equal(firstPlan.evidenceDigest, secondPlan.evidenceDigest);
});

test("the evidence digest is preserved through persistence and replay", async () => {
  const fixture = createFixture();
  const plan = await prepare(fixture);
  const expected = fixture.phase1.createIncomingAcceptanceEvidenceDigest(plan.evidence);
  assert.equal(plan.evidenceDigest, expected);
  fixture.world.commit();
  fixture.world.writes.length = 0;
  const replay = await prepare(fixture);
  assert.equal(replay.evidenceDigest, expected);
  assert.deepEqual(fixture.world.writes, []);
});

test("Phase 1 receipt identities and evidence digest bind to the composited evidence", async () => {
  const fixture = createFixture();
  const plan = await prepare(fixture);
  const receipt = fixture.phase1.createIncomingAcceptanceApplicationReceipt({
    handoverDocumentId: DOC,
    outgoingShiftId: OUTGOING,
    incomingShiftId: INCOMING,
    technicianUid: IN_A,
    position: "incoming_tech_a",
    outcome: "first_activation",
    activationReceiptId: "handover-activation-v2-fixture",
    activationReceiptHash: "a".repeat(64),
    evidenceKind: plan.evidence.kind,
    evidenceDigest: plan.evidenceDigest,
    membershipId: `${INCOMING}_${IN_A}`,
    attendanceId: `${INCOMING}_${IN_A}`,
    reviewedBinding: {
      handoverId: fixture.aggregate.reservation.handoverId,
      handoverDocumentId: DOC,
      aggregateRevision: fixture.aggregate.revision,
      snapshotHash: fixture.request.snapshotHash,
      report: {
        schema: "handover-report-v2",
        id: "report_v2_fixture",
        digest: "b".repeat(64),
        evidenceSnapshotHash: "c".repeat(64),
        workSnapshotVersion: "work-v1",
        preparationId: "preparation_fixture",
        preparationRevision: 1,
        reservationId: fixture.aggregate.reservation.handoverId,
        aggregateRevision: fixture.aggregate.revision,
        fencingEpoch: fixture.guard.fencingEpoch,
        frozenBy: OUT_A,
        frozenAt: "2026-10-28T07:55:00.000Z",
      },
      guardRevision: fixture.guard.guardRevision,
      fencingEpoch: fixture.guard.fencingEpoch,
    },
    appliedGuardBinding: {
      protocolOwner: "v2",
      handoverDocumentId: DOC,
      reservationId: fixture.aggregate.reservation.handoverId,
      incomingShiftId: INCOMING,
      lifecycleState: "active",
      guardRevision: fixture.guard.guardRevision,
      fencingEpoch: fixture.guard.fencingEpoch,
      outgoingSlotToken: fixture.guard.outgoingSlotToken,
      outgoingGeneration: fixture.guard.outgoingGeneration,
      successorSlotToken: fixture.guard.successorSlotToken,
      successorGeneration: fixture.guard.successorGeneration,
    },
    requestAcceptedAt: "2026-10-28T08:00:58.000Z",
    passwordVerifiedAt: "2026-10-28T08:00:59.000Z",
    authAccountCheckedAt: "2026-10-28T08:00:59.500Z",
    personalEvidenceEventAt: plan.evidence.eventTime,
    operationalAppliedAt: plan.evidence.eventTime,
    lateReason: null,
    absenceReference: null,
  });
  assert.equal(receipt.evidenceEventId, plan.evidence.eventId);
  assert.equal(receipt.evidenceOperationId, plan.operationId);
  assert.equal(receipt.evidenceId, plan.evidenceId);
  assert.equal(receipt.evidenceDigest, plan.evidenceDigest);
  assert.deepEqual(receipt.committedAt, { state: "unresolved" });
});

test("Firestore commit time remains unhashed metadata and hydrates only on read-back", async () => {
  const fixture = createFixture();
  const plan = await prepare(fixture);
  const receipt = fixture.phase1.createIncomingAcceptanceApplicationReceipt({
    handoverDocumentId: DOC,
    outgoingShiftId: OUTGOING,
    incomingShiftId: INCOMING,
    technicianUid: IN_A,
    position: "incoming_tech_a",
    outcome: "first_activation",
    activationReceiptId: "handover-activation-v2-fixture",
    activationReceiptHash: "a".repeat(64),
    evidenceKind: plan.evidence.kind,
    evidenceDigest: plan.evidenceDigest,
    membershipId: `${INCOMING}_${IN_A}`,
    attendanceId: `${INCOMING}_${IN_A}`,
    reviewedBinding: {
      handoverId: fixture.aggregate.reservation.handoverId,
      handoverDocumentId: DOC,
      aggregateRevision: fixture.aggregate.revision,
      snapshotHash: fixture.request.snapshotHash,
      report: {
        schema: "handover-report-v2",
        id: "report_v2_fixture",
        digest: "b".repeat(64),
        evidenceSnapshotHash: "c".repeat(64),
        workSnapshotVersion: "work-v1",
        preparationId: "preparation_fixture",
        preparationRevision: 1,
        reservationId: fixture.aggregate.reservation.handoverId,
        aggregateRevision: fixture.aggregate.revision,
        fencingEpoch: fixture.guard.fencingEpoch,
        frozenBy: OUT_A,
        frozenAt: "2026-10-28T07:55:00.000Z",
      },
      guardRevision: fixture.guard.guardRevision,
      fencingEpoch: fixture.guard.fencingEpoch,
    },
    appliedGuardBinding: {
      protocolOwner: "v2",
      handoverDocumentId: DOC,
      reservationId: fixture.aggregate.reservation.handoverId,
      incomingShiftId: INCOMING,
      lifecycleState: "active",
      guardRevision: fixture.guard.guardRevision,
      fencingEpoch: fixture.guard.fencingEpoch,
      outgoingSlotToken: fixture.guard.outgoingSlotToken,
      outgoingGeneration: fixture.guard.outgoingGeneration,
      successorSlotToken: fixture.guard.successorSlotToken,
      successorGeneration: fixture.guard.successorGeneration,
    },
    requestAcceptedAt: "2026-10-28T08:00:58.000Z",
    passwordVerifiedAt: "2026-10-28T08:00:59.000Z",
    authAccountCheckedAt: "2026-10-28T08:00:59.500Z",
    personalEvidenceEventAt: plan.evidence.eventTime,
    operationalAppliedAt: plan.evidence.eventTime,
    lateReason: null,
    absenceReference: null,
  });

  assert.throws(
    () => fixture.phase1.assertIncomingAcceptanceApplicationReceipt(receipt, { requireResolvedCommit: true }),
    /commit timestamp is not resolved/,
  );
  const hydrated = fixture.phase1.hydrateIncomingAcceptanceCommittedAt(receipt, {
    seconds: 1_790_000_000,
    nanoseconds: 123_000_000,
  });
  assert.deepEqual(hydrated.committedAt, {
    state: "resolved",
    seconds: 1_790_000_000,
    nanoseconds: 123_000_000,
  });
  assert.equal(hydrated.receiptHash, receipt.receiptHash);
  fixture.phase1.assertIncomingAcceptanceApplicationReceipt(hydrated, {
    requireResolvedCommit: true,
  });
});

test("an evidence replay never fabricates an application or operational acceptance", async () => {
  const fixture = createFixture();
  const plan = await prepare(fixture);
  fixture.world.commit();
  const replay = await prepare(fixture);
  assert.equal(replay.operationalAcceptance, false);
  assert.equal(fixture.world.records.has("incoming_acceptance_applications_v1"), false);
  assert.equal(fixture.world.records.has("shift_attendance"), false);
  assert.equal(fixture.world.records.has("shift_members"), false);
});
