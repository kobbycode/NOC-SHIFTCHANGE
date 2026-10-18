/**
 * Firestore emulator integration tests for the v2 attendance evidence persistence.
 *
 * Run via: tests/run-attendance-evidence-emulator.ps1
 *
 * Safety invariant: every test uses the isolated synthetic project
 * "demo-shiftchange-attendance" on emulator port 8089. The guard at the top of
 * this file refuses to run against any other project or host, so production
 * credentials and data can never be reached from this suite.
 *
 * IMPORTANT: these tests call the trusted persistence primitives directly with
 * a synthetic server authentication time. That proves the persistence layer
 * only finalizes when handed a trusted authentication descriptor; it is NOT
 * evidence that browser password authentication is integrated (no such
 * coordinator exists yet).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const project = "demo-shiftchange-attendance";
const host = process.env.FIRESTORE_EMULATOR_HOST;
const requiredEnv = [
  "FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
];
if (
  !host ||
  !["127.0.0.1:8089", "localhost:8089"].includes(host) ||
  requiredEnv.some((key) => process.env[key] !== project)
) {
  throw new Error("Refusing to run attendance emulator tests outside the isolated demo emulator.");
}
const probe = await fetch(
  `http://${host}/v1/projects/${project}/databases/(default)/documents`,
);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

// ---------------------------------------------------------------------------
// Module imports (dynamic — requires --conditions=react-server for server-only)
// ---------------------------------------------------------------------------

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { getOperationalCollections } = await import("../src/lib/operations/collections.ts");
const {
  beginAttendanceEvidenceOperation,
  finalizeAttendanceEvidenceOperation,
  resumeAttendanceEvidenceOperation,
  abortAttendanceEvidenceOperation,
  readAttendanceEvidenceState,
  AttendanceEvidenceDomainError,
} = await import("../src/lib/operations/attendance-evidence-firestore.ts");
const {
  attendanceEvidenceId,
  attendanceEvidenceSlotId,
} = await import("../src/lib/operations/attendance-evidence-domain.ts");
const handoverDomain = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const guardDomain = await import("../src/lib/operations/handover-reservation-guard-domain.ts");
const { cancelReservationGuard } = await import(
  "../src/lib/operations/handover-reservation-guard.ts"
);

const db = getAdminFirestore();
const collections = getOperationalCollections();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The persistence layer stamps each operation with the real server clock at
// request acceptance, and evidence may never be timed before that. The shift
// window therefore hangs off the actual clock instead of a fixed past date.
const baseMs = Math.ceil((Date.now() + 30 * 60 * 1000) / 1000) * 1000;
const atMin = (minutes) => new Date(baseMs + minutes * 60 * 1000).toISOString();
const nonCanonical = (minutes) => atMin(minutes).replace(".000Z", "Z");
const scheduledStart = atMin(0);
const scheduledEnd = atMin(540);
const reservedAt = atMin(-120);
const at = reservedAt;

let seq = 0;

async function clearDb() {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200);
}

/**
 * Build a live v2 equal handover aggregate plus its shared reservation guard,
 * persisted exactly as the (future) reservation workflow would persist them.
 */
async function makeHandoverFixture() {
  const prefix = `att${++seq}`;
  const outgoingShiftId = `${prefix}-outgoing`;
  const identity = handoverDomain.createEqualHandoverIdentity({
    schema: "equal-handover-v2",
    outgoingShiftId,
    outgoingPermanentPairId: `${prefix}-pair-out`,
    outgoingTechnicianIds: [`${prefix}-out-a`, `${prefix}-out-b`],
    outgoingSlotToken: randomUUID(),
    outgoingGeneration: 1,
    incomingShiftId: `${prefix}-incoming`,
    incomingPermanentPairId: `${prefix}-pair-in`,
    incomingTechnicianIds: [`${prefix}-in-a`, `${prefix}-in-b`],
    successorSlotToken: randomUUID(),
    successorGeneration: 2,
    shiftType: "morning",
    scheduledStart,
    scheduledEnd,
  });
  const aggregate = handoverDomain.createEqualHandover({
    identity,
    reservedAt,
    reservedBy: `${prefix}-supervisor`,
  });
  const handoverDocumentId = handoverDomain.createEqualHandoverDocumentId(outgoingShiftId);
  const guard = guardDomain.createInitialReservationGuard({
    outgoingShiftId,
    protocolOwner: "v2",
    ownerHandoverDocumentId: handoverDocumentId,
    outgoingSlotToken: identity.outgoingSlotToken,
    outgoingGeneration: identity.outgoingGeneration,
    successorSlotToken: identity.successorSlotToken,
    successorGeneration: identity.successorGeneration,
    reservationId: aggregate.reservation.handoverId,
    reservedIncomingShiftId: identity.incomingShiftId,
    reservedAt,
    reservedBy: `${prefix}-supervisor`,
  });

  const batch = db.batch();
  batch.set(collections.handovers.doc(handoverDocumentId), aggregate);
  batch.set(
    collections.handoverReservationGuards.doc(guard.id),
    guardDomain.assertHandoverReservationGuard(guard),
  );
  await batch.commit();

  return {
    prefix,
    identity,
    aggregate,
    reservation: aggregate.reservation,
    handoverId: aggregate.reservation.handoverId,
    handoverDocumentId,
    guardDocumentId: guard.id,
    incomingUid: `${prefix}-in-a`,
    incomingPosition: "incoming_tech_a",
    outgoingUid: `${prefix}-out-a`,
    outgoingPosition: "outgoing_tech_a",
    colleagueUid: `${prefix}-out-b`,
    supervisorUid: `${prefix}-supervisor`,
  };
}

function makeRequest(f, overrides = {}) {
  return {
    schema: "attendance-evidence-v2",
    handoverId: f.handoverId,
    handoverDocumentId: f.handoverDocumentId,
    eventId: `${f.prefix}-event-${randomUUID()}`,
    position: f.incomingPosition,
    technicianUid: f.incomingUid,
    kind: "incoming_clock_in",
    scheduledStart,
    scheduledEnd,
    reportedDepartureTime: null,
    attestedByUid: null,
    attestationReason: null,
    lateReason: null,
    handoverRevision: f.reservation.revision,
    snapshotHash: handoverDomain.createEqualHandoverSnapshot(f.aggregate).snapshotHash,
    expectedGuardRevision: f.reservation.revision,
    expectedFencingEpoch: f.reservation.revision,
    ...overrides,
  };
}

function personal(method = "personal_password_confirmation", uid = undefined) {
  return {
    verifiedTechnicianUid: uid ?? null,
    method,
  };
}

async function operationDoc(operationId) {
  const snap = await collections.attendanceEvidenceOperationsV2.doc(operationId).get();
  return snap.exists ? snap.data() : null;
}

async function evidenceDoc(f, kind, technicianUid) {
  const id = attendanceEvidenceId(
    attendanceEvidenceSlotId({ handoverId: f.handoverId, technicianUid, kind }),
  );
  const snap = await collections.attendanceEvidenceV2.doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function count(collection) {
  const snap = await collections[collection].get();
  return snap.size;
}

/** Finalize through the trusted primitive with a synthetic server clock. */
async function finalize(f, request, serverAuthenticationTime, authentication) {
  const begun = await beginAttendanceEvidenceOperation({ request });
  const result = await finalizeAttendanceEvidenceOperation({
    operationId: begun.operation.id,
    identity: f.identity,
    reservation: f.reservation,
    trustedAuthentication: authentication,
    serverAuthenticationTime,
  });
  return { begun, result };
}

test.beforeEach(clearDb);

// ---------------------------------------------------------------------------
// Required scenario coverage (Firestore persistence)
// ---------------------------------------------------------------------------

// 1, 2 + server-authoritative timing.
test("1-2. first personal confirmation persists a server-timed clock-in; nothing before it counts", async () => {
  const f = await makeHandoverFixture();
  const request = makeRequest(f);

  // Before any operation exists there is no attendance of any kind.
  const before = await readAttendanceEvidenceState({
    handoverId: f.handoverId,
    technicianUid: f.incomingUid,
    kind: "incoming_clock_in",
  });
  assert.deepEqual(before, { operation: null, evidence: null });

  const begun = await beginAttendanceEvidenceOperation({ request });
  assert.equal(begun.outcome, "created");
  const pending = await operationDoc(begun.operation.id);
  assert.equal(pending.status, "pending");
  assert.equal(await count("attendanceEvidenceV2"), 0);

  const finalized = await finalizeAttendanceEvidenceOperation({
    operationId: begun.operation.id,
    identity: f.identity,
    reservation: f.reservation,
    trustedAuthentication: personal("personal_password_confirmation", f.incomingUid),
    serverAuthenticationTime: atMin(1.5),
  });
  assert.equal(finalized.needsResume, false);
  assert.equal(finalized.evidence.clockIn, atMin(1.5));
  assert.equal(finalized.evidence.eventTime, atMin(1.5));

  // Persisted as Firestore Timestamps, not caller-supplied strings.
  const stored = await evidenceDoc(f, "incoming_clock_in", f.incomingUid);
  assert.equal(stored.eventTime.constructor.name, "Timestamp");
  assert.equal(stored.eventTime.toDate().toISOString(), atMin(1.5));
  assert.equal(
    (await operationDoc(finalized.operation.id)).status,
    "finalized",
  );

  const readBack = await readAttendanceEvidenceState({
    handoverId: f.handoverId,
    technicianUid: f.incomingUid,
    kind: "incoming_clock_in",
  });
  assert.equal(readBack.evidence.operationId, finalized.operation.id);
  assert.equal(readBack.evidence.technicianUid, f.incomingUid);
  assert.equal(readBack.evidence.incomingShiftId, f.identity.incomingShiftId);
  assert.equal(readBack.evidence.eventId, request.eventId);
});

// 10. A pending operation is never presented as attendance.
test("10. pending operations cannot be read as attendance and cannot be resumed", async () => {
  const f = await makeHandoverFixture();
  const begun = await beginAttendanceEvidenceOperation({ request: makeRequest(f) });

  await assert.rejects(
    () => resumeAttendanceEvidenceOperation(begun.operation.id),
    /still pending/,
  );
  const state = await readAttendanceEvidenceState({
    handoverId: f.handoverId,
    technicianUid: f.incomingUid,
    kind: "incoming_clock_in",
  });
  assert.equal(state.evidence, null);
  assert.equal(await count("attendanceEvidenceV2"), 0);

  // A failed password check aborts the pending work; the record stays auditable.
  const aborted = await abortAttendanceEvidenceOperation(begun.operation.id, "password check failed");
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.abortReason, "password check failed");
  assert.equal(await evidenceDoc(f, "incoming_clock_in", f.incomingUid), null);
  await assert.rejects(
    () => abortAttendanceEvidenceOperation(begun.operation.id, "again"),
    /Only pending attendance operations/,
  );
  await assert.rejects(
    () => finalizeAttendanceEvidenceOperation({
      operationId: begun.operation.id,
      identity: f.identity,
      reservation: f.reservation,
      trustedAuthentication: personal("personal_password_confirmation", f.incomingUid),
      serverAuthenticationTime: atMin(1),
    }),
    /was aborted/,
  );
});

// 7. Identical retry is idempotent.
test("7. identical retry replays the stored operation without new documents", async () => {
  const f = await makeHandoverFixture();
  const request = makeRequest(f);
  const first = await beginAttendanceEvidenceOperation({ request });
  const requestedAt = (await operationDoc(first.operation.id)).requestedAt.toDate().getTime();

  const second = await beginAttendanceEvidenceOperation({ request });
  assert.equal(second.outcome, "idempotent_replay");
  assert.equal(second.operation.id, first.operation.id);
  const replay = await operationDoc(second.operation.id);
  assert.equal(replay.requestedAt.toDate().getTime(), requestedAt);
  assert.equal(await count("attendanceEvidenceOperationsV2"), 1);

  const finalized = await finalizeAttendanceEvidenceOperation({
    operationId: first.operation.id,
    identity: f.identity,
    reservation: f.reservation,
    trustedAuthentication: personal("personal_password_confirmation", f.incomingUid),
    serverAuthenticationTime: atMin(2),
  });
  const again = await finalizeAttendanceEvidenceOperation({
    operationId: first.operation.id,
    identity: f.identity,
    reservation: f.reservation,
    trustedAuthentication: personal("personal_password_confirmation", f.incomingUid),
    serverAuthenticationTime: atMin(90),
  });
  // Re-finalizing a terminal operation never re-times the original event.
  assert.equal(again.evidence.clockIn, finalized.evidence.clockIn);
  assert.equal(again.evidence.clockIn, atMin(2));
  assert.equal(await count("attendanceEvidenceV2"), 1);
});

// 8. Conflicting retry fails safely.
test("8. a different payload reusing the same event ID is rejected and preserved", async () => {
  const f = await makeHandoverFixture();
  const request = makeRequest(f);
  const first = await beginAttendanceEvidenceOperation({ request });

  await assert.rejects(
    () => beginAttendanceEvidenceOperation({
      request: makeRequest(f, {
        eventId: request.eventId,
        position: "incoming_tech_b",
        lateReason: "different payload",
      }),
    }),
    (error) =>
      error instanceof AttendanceEvidenceDomainError &&
      /already exists for this event ID/.test(error.message) &&
      error.status === 409,
  );

  const stored = await operationDoc(first.operation.id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.request.lateReason, null);
  assert.equal(stored.request.position, f.incomingPosition);
  assert.equal(await count("attendanceEvidenceOperationsV2"), 1);
});

// 9. Concurrent requests converge to one authoritative event.
test("9. concurrent identical begins converge to a single operation", async () => {
  const f = await makeHandoverFixture();
  const request = makeRequest(f);
  const results = await Promise.allSettled([
    beginAttendanceEvidenceOperation({ request }),
    beginAttendanceEvidenceOperation({ request }),
    beginAttendanceEvidenceOperation({ request }),
  ]);
  for (const result of results) {
    assert.equal(result.status, "fulfilled", String(result.reason));
  }
  const ids = new Set(results.map((result) => result.value.operation.id));
  assert.equal(ids.size, 1);
  assert.equal(await count("attendanceEvidenceOperationsV2"), 1);
  assert.equal(
    results.filter((result) => result.value.outcome === "created").length,
    1,
  );
});

test("9b. concurrent competing events for one slot finalize exactly one clock-in", async () => {
  const f = await makeHandoverFixture();
  const eventA = makeRequest(f, { eventId: `${f.prefix}-A` });
  const eventB = makeRequest(f, { eventId: `${f.prefix}-B` });
  const [begunA, begunB] = await Promise.all([
    beginAttendanceEvidenceOperation({ request: eventA }),
    beginAttendanceEvidenceOperation({ request: eventB }),
  ]);

  const settled = await Promise.allSettled([
    finalizeAttendanceEvidenceOperation({
      operationId: begunA.operation.id,
      identity: f.identity,
      reservation: f.reservation,
      trustedAuthentication: personal("personal_password_confirmation", f.incomingUid),
      serverAuthenticationTime: atMin(1),
    }),
    finalizeAttendanceEvidenceOperation({
      operationId: begunB.operation.id,
      identity: f.identity,
      reservation: f.reservation,
      trustedAuthentication: personal("personal_password_confirmation", f.incomingUid),
      serverAuthenticationTime: atMin(4),
    }),
  ]);
  const ok = settled.filter((item) => item.status === "fulfilled");
  const rejected = settled.filter((item) => item.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason.message), /Duplicate attendance evidence|already exists/);

  const stored = await evidenceDoc(f, "incoming_clock_in", f.incomingUid);
  assert.equal(stored.operationId, ok[0].value.operation.id);
  // Whichever event won, exactly one clock-in exists and it carries that
  // winner's server time; the loser's time never lands in storage.
  assert.equal(stored.eventTime.toDate().toISOString(), ok[0].value.evidence.eventTime);
  assert.ok(
    [atMin(1), atMin(4)].includes(stored.eventTime.toDate().toISOString()),
  );
  assert.equal(await count("attendanceEvidenceV2"), 1);
});

// 6 + 12. Duplicate clock-in is rejected and the original event is preserved.
test("6-12. a second confirmation cannot create or re-time the original clock-in", async () => {
  const f = await makeHandoverFixture();
  const { result } = await finalize(
    f,
    makeRequest(f),
    atMin(3),
    personal("personal_password_confirmation", f.incomingUid),
  );
  const original = await evidenceDoc(f, "incoming_clock_in", f.incomingUid);

  // Reconfirmation of a corrected report must preserve the original clock-in.
  await assert.rejects(
    () => finalize(
      f,
      makeRequest(f, { eventId: `${f.prefix}-reconfirm` }),
      atMin(180),
      personal("personal_password_confirmation", f.incomingUid),
    ),
    (error) =>
      error instanceof AttendanceEvidenceDomainError &&
      /already exists for this slot/.test(error.message),
  );
  const after = await evidenceDoc(f, "incoming_clock_in", f.incomingUid);
  assert.deepEqual(after, original);
  assert.equal(after.clockIn.toDate().toISOString(), atMin(3));
  assert.equal(result.evidence.clockIn, atMin(3));
});

// 11. An interrupted finalization can be resumed.
test("11. interrupted finalization resumes to the authoritative stored event", async () => {
  const f = await makeHandoverFixture();
  const begun = await beginAttendanceEvidenceOperation({ request: makeRequest(f) });
  const finalized = await finalizeAttendanceEvidenceOperation({
    operationId: begun.operation.id,
    identity: f.identity,
    reservation: f.reservation,
    trustedAuthentication: personal("personal_password_confirmation", f.incomingUid),
    serverAuthenticationTime: atMin(1),
  });

  // Simulate the crash window between the committed evidence write and the
  // acknowledgement read-back.
  const interrupted = {
    ...(await operationDoc(begun.operation.id)),
    interruptedFinalization: true,
  };
  await collections.attendanceEvidenceOperationsV2.doc(begun.operation.id).set(interrupted);

  const resumed = await resumeAttendanceEvidenceOperation(begun.operation.id);
  assert.equal(resumed.operation.interruptedFinalization, false);
  assert.equal(resumed.evidence.eventTime, finalized.evidence.eventTime);
  assert.equal(
    (await evidenceDoc(f, "incoming_clock_in", f.incomingUid)).eventTime
      .toDate()
      .toISOString(),
    atMin(1),
  );
  assert.equal(await count("attendanceEvidenceV2"), 1);

  // Resuming again is a no-op.
  const second = await resumeAttendanceEvidenceOperation(begun.operation.id);
  assert.equal(second.evidence.eventTime, resumed.evidence.eventTime);
});

test("11b. resume reports recovery instead of guessing when evidence is missing", async () => {
  const f = await makeHandoverFixture();
  const begun = await beginAttendanceEvidenceOperation({ request: makeRequest(f) });
  await collections.attendanceEvidenceOperationsV2.doc(begun.operation.id).set({
    ...(await operationDoc(begun.operation.id)),
    status: "finalized",
    interruptedFinalization: true,
  });
  await assert.rejects(
    () => resumeAttendanceEvidenceOperation(begun.operation.id),
    /missing its evidence document/,
  );
});

// 14. Late personal acceptance uses the server acceptance time.
test("14. late acceptance stores the acceptance time and keeps the receipt untouched", async () => {
  const f = await makeHandoverFixture();
  const request = makeRequest(f, {
    kind: "incoming_late_acceptance",
    lateReason: "road closure delayed the route",
  });
  const { result } = await finalize(
    f,
    request,
    atMin(25),
    personal("personal_password_acceptance", f.incomingUid),
  );
  assert.equal(result.evidence.kind, "incoming_late_acceptance");
  assert.equal(result.evidence.clockIn, atMin(25));
  assert.equal(result.evidence.lateReason, "road closure delayed the route");
  assert.equal(result.evidence.personallyAuthenticated, true);

  // Exactly five minutes stays on time and needs no reason.
  const onTime = await finalize(
    f,
    makeRequest(f, { eventId: `${f.prefix}-ontime`, kind: "incoming_clock_in" }),
    atMin(5),
    personal("personal_password_confirmation", f.incomingUid),
  );
  assert.equal(onTime.result.evidence.clockIn, atMin(5));

  // The handover receipt/aggregate is not rewritten by attendance evidence.
  const handover = await collections.handovers.doc(f.handoverDocumentId).get();
  assert.equal(handover.data().revision, f.aggregate.revision);
  assert.deepEqual(
    handoverDomain.assertEqualHandoverAggregate(handover.data()).confirmations,
    [],
  );
});

// 15 + 16. Colleague-attested departure provenance, and it cannot displace a personal clock-out.
test("15-16. attested departure keeps provenance and conflicts fail closed", async () => {
  const f = await makeHandoverFixture();
  const attestation = await finalize(
    f,
    makeRequest(f, {
      kind: "outgoing_absent_departure_attestation",
      position: f.outgoingPosition,
      technicianUid: f.outgoingUid,
      attestedByUid: f.colleagueUid,
      attestationReason: "colleague saw the office empty",
      reportedDepartureTime: atMin(460),
    }),
    atMin(485),
    personal("colleague_attestation", f.colleagueUid),
  );
  const stored = await evidenceDoc(f, "outgoing_absent_departure_attestation", f.outgoingUid);
  assert.equal(stored.attestedByUid, f.colleagueUid);
  assert.equal(stored.technicianUid, f.outgoingUid);
  assert.equal(stored.attestationReason, "colleague saw the office empty");
  assert.equal(stored.reportedDepartureTime, atMin(460));
  assert.equal(stored.eventTime.toDate().toISOString(), atMin(485));
  assert.equal(stored.personallyAuthenticated, false);
  assert.equal(stored.clockIn, null);
  assert.equal(attestation.result.evidence.kind, "outgoing_absent_departure_attestation");

  // A later personal clock-out may not silently replace the attested record.
  await assert.rejects(
    () => finalize(
      f,
      makeRequest(f, {
        kind: "outgoing_personal_clock_out",
        position: f.outgoingPosition,
        technicianUid: f.outgoingUid,
      }),
      atMin(490),
      personal("server_issued_personal_clock_out", f.outgoingUid),
    ),
    (error) =>
      error instanceof AttendanceEvidenceDomainError &&
      /Conflicting attendance evidence already exists/.test(error.message),
  );
  const after = await evidenceDoc(f, "outgoing_absent_departure_attestation", f.outgoingUid);
  assert.deepEqual(after, stored);
  assert.equal(await evidenceDoc(f, "outgoing_personal_clock_out", f.outgoingUid), null);
});

test("16b. personal clock-out first blocks a later colleague attestation", async () => {
  const f = await makeHandoverFixture();
  await finalize(
    f,
    makeRequest(f, {
      kind: "outgoing_personal_clock_out",
      position: f.outgoingPosition,
      technicianUid: f.outgoingUid,
    }),
    atMin(480),
    personal("server_issued_personal_clock_out", f.outgoingUid),
  );
  const original = await evidenceDoc(f, "outgoing_personal_clock_out", f.outgoingUid);
  assert.equal(original.clockOut.toDate().toISOString(), atMin(480));
  assert.equal(original.clockIn, null);

  await assert.rejects(
    () => finalize(
      f,
      makeRequest(f, {
        kind: "outgoing_absent_departure_attestation",
        position: f.outgoingPosition,
        technicianUid: f.outgoingUid,
        attestedByUid: f.colleagueUid,
        attestationReason: "late claim of departure",
        reportedDepartureTime: atMin(420),
      }),
      atMin(510),
      personal("colleague_attestation", f.colleagueUid),
    ),
    (error) => error instanceof AttendanceEvidenceDomainError,
  );
  assert.deepEqual(
    await evidenceDoc(f, "outgoing_personal_clock_out", f.outgoingUid),
    original,
  );
});

// 17. Invalid reported departure times never reach storage.
test("17. invalid reported departure times are rejected before persisting", async () => {
  const f = await makeHandoverFixture();
  for (const reportedDepartureTime of [
    "not-a-time",
    nonCanonical(460),
    atMin(-13 * 60),
    atMin(660),
  ]) {
    await assert.rejects(
      () => beginAttendanceEvidenceOperation({
        request: makeRequest(f, {
          kind: "outgoing_absent_departure_attestation",
          position: f.outgoingPosition,
          technicianUid: f.outgoingUid,
          attestedByUid: f.colleagueUid,
          attestationReason: "reported by colleague",
          reportedDepartureTime,
        }),
      }),
      (error) => error instanceof AttendanceEvidenceDomainError,
      reportedDepartureTime,
    );
  }
  assert.equal(await count("attendanceEvidenceOperationsV2"), 0);
});

// 13. A missing incoming technician gains no fabricated attendance.
test("13. an absent incoming technician has no clock-in evidence", async () => {
  const f = await makeHandoverFixture();
  const absent = await readAttendanceEvidenceState({
    handoverId: f.handoverId,
    technicianUid: f.incomingUid,
    kind: "incoming_clock_in",
  });
  assert.deepEqual(absent, { operation: null, evidence: null });
  assert.equal(await count("attendanceEvidenceV2"), 0);

  // The future personal-acceptance path stays available: nothing about the
  // absence blocks a later trusted acceptance for the same technician.
  const accepted = await finalize(
    f,
    makeRequest(f, {
      kind: "incoming_late_acceptance",
      lateReason: "arrived after transport failure",
    }),
    atMin(70),
    personal("personal_password_acceptance", f.incomingUid),
  );
  assert.equal(accepted.result.evidence.clockIn, atMin(70));

  // But no signature or password verification may be invented for the absent
  // technician by anyone else.
  await assert.rejects(
    () => finalize(
      f,
      makeRequest(f, {
        kind: "incoming_clock_in",
        eventId: `${f.prefix}-by-proxy`,
      }),
      atMin(80),
      personal("personal_password_confirmation", f.colleagueUid),
    ),
    (error) =>
      error instanceof AttendanceEvidenceDomainError &&
      /subject technician.s own verified authentication/.test(error.message),
  );
});

// 18. Legacy v1 attendance documents are never touched.
test("18. legacy v1 attendance records stay byte-identical", async () => {
  const f = await makeHandoverFixture();
  const legacyId = `${f.identity.incomingShiftId}_${f.incomingUid}`;
  const legacy = {
    id: legacyId,
    shiftId: f.identity.incomingShiftId,
    technicianId: f.incomingUid,
    status: "present",
    isProvisional: false,
    clockIn: null,
    clockOut: null,
    recordedAt: at,
    updatedAt: at,
  };
  await collections.shiftAttendance.doc(legacyId).set(legacy);

  await finalize(
    f,
    makeRequest(f),
    atMin(1),
    personal("personal_password_confirmation", f.incomingUid),
  );

  const stored = await collections.shiftAttendance.doc(legacyId).get();
  assert.deepEqual(stored.data(), legacy);
  assert.equal(await count("shiftAttendance"), 1);
  assert.equal(await count("attendanceEvidenceV2"), 1);
  assert.ok(
    collections.attendanceEvidenceV2.path !== collections.shiftAttendance.path,
    "v2 evidence must live in a dedicated collection",
  );
});

// 20. Guard ownership inconsistencies block unsafe evidence creation.
test("20. reservation guard inconsistencies fail closed", async () => {
  const f = await makeHandoverFixture();

  // Stale guard revision in the request blocks the begin.
  await assert.rejects(
    () => beginAttendanceEvidenceOperation({
      request: makeRequest(f, { expectedGuardRevision: f.reservation.revision + 5 }),
    }),
    (error) => error instanceof AttendanceEvidenceDomainError && /stale guard revision/.test(error.message),
  );

  // A v1-owned guard blocks v2 evidence.
  const foreign = await makeHandoverFixture();
  await collections.handoverReservationGuards.doc(foreign.guardDocumentId).set({
    ...(await collections.handoverReservationGuards.doc(foreign.guardDocumentId).get())
      .data(),
    protocolOwner: "v1",
    ownerHandoverDocumentId: `handover_${foreign.identity.outgoingShiftId}`,
  });
  await assert.rejects(
    () => beginAttendanceEvidenceOperation({ request: makeRequest(foreign) }),
    (error) => error instanceof AttendanceEvidenceDomainError && /different handover protocol/.test(error.message),
  );

  // A cancelled guard blocks an already-pending finalization.
  const third = await makeHandoverFixture();
  const begun = await beginAttendanceEvidenceOperation({ request: makeRequest(third) });
  await db.runTransaction(async (transaction) => {
    await cancelReservationGuard(transaction, {
      outgoingShiftId: third.identity.outgoingShiftId,
      protocolOwner: "v2",
      expectedGuardRevision: third.reservation.revision,
      expectedFencingEpoch: third.reservation.revision,
      recordedAt: atMin(-60),
      actorUid: third.supervisorUid,
    });
  });
  await assert.rejects(
    () => finalizeAttendanceEvidenceOperation({
      operationId: begun.operation.id,
      identity: third.identity,
      reservation: third.reservation,
      trustedAuthentication: personal("personal_password_confirmation", third.incomingUid),
      serverAuthenticationTime: atMin(1),
    }),
    (error) => error instanceof AttendanceEvidenceDomainError && error.status === 409,
  );
  assert.equal(await count("attendanceEvidenceV2"), 0);

  // A missing handover document blocks finalization.
  const fourth = await makeHandoverFixture();
  const fourthBegun = await beginAttendanceEvidenceOperation({ request: makeRequest(fourth) });
  await collections.handovers.doc(fourth.handoverDocumentId).delete();
  await assert.rejects(
    () => finalizeAttendanceEvidenceOperation({
      operationId: fourthBegun.operation.id,
      identity: fourth.identity,
      reservation: fourth.reservation,
      trustedAuthentication: personal("personal_password_confirmation", fourth.incomingUid),
      serverAuthenticationTime: atMin(1),
    }),
    (error) => error instanceof AttendanceEvidenceDomainError && /handover document is missing/.test(error.message),
  );
});

test("20b. a stale handover identity or a legacy document binding is rejected", async () => {
  const f = await makeHandoverFixture();
  const begun = await beginAttendanceEvidenceOperation({ request: makeRequest(f) });
  const stale = handoverDomain.createEqualHandoverIdentity({
    ...f.identity,
    incomingTechnicianIds: [`${f.prefix}-other`, `${f.prefix}-other-b`],
  });
  await assert.rejects(
    () => finalizeAttendanceEvidenceOperation({
      operationId: begun.operation.id,
      identity: stale,
      reservation: f.reservation,
      trustedAuthentication: personal("personal_password_confirmation", f.incomingUid),
      serverAuthenticationTime: atMin(1),
    }),
    (error) => error instanceof AttendanceEvidenceDomainError && /coordinator identity is stale/.test(error.message),
  );

  // Legacy (non-v2) handover document IDs cannot carry v2 evidence at all.
  await assert.rejects(
    () => beginAttendanceEvidenceOperation({
      request: makeRequest(f, {
        handoverDocumentId: `handover_${f.identity.outgoingShiftId}`,
      }),
    }),
    (error) =>
      error instanceof AttendanceEvidenceDomainError &&
      /document binding/i.test(error.message),
  );
});

test("20c. a caller-supplied clock cannot bypass server timing", async () => {
  const f = await makeHandoverFixture();
  const begun = await beginAttendanceEvidenceOperation({
    request: makeRequest(f, { scheduledStart: scheduledStart }),
  });
  await assert.rejects(
    () => finalizeAttendanceEvidenceOperation({
      operationId: begun.operation.id,
      identity: f.identity,
      reservation: f.reservation,
      trustedAuthentication: personal("personal_password_confirmation", f.incomingUid),
      serverAuthenticationTime: nonCanonical(1),
    }),
    (error) => error instanceof AttendanceEvidenceDomainError && /canonical server authentication time/.test(error.message),
  );
  assert.equal(await count("attendanceEvidenceV2"), 0);
});
