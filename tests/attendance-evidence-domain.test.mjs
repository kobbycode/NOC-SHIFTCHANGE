import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Pure module loader (CommonJS-in-vm, matching the repo's test conventions)
// ---------------------------------------------------------------------------

const modules = new Map();

function loadModule(relativePath) {
  if (modules.has(relativePath)) {
    return modules.get(relativePath);
  }
  const source = await_readFile(relativePath);
  const loaded = { exports: {} };
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: loaded.exports,
      structuredClone,
      TextEncoder,
      setTimeout,
      require(specifier) {
        if (specifier === "node:crypto") {
          return { createHash };
        }
        if (
          specifier === "@/types/attendance-evidence" ||
          specifier.endsWith("types/attendance-evidence")
        ) {
          return loadModule("src/types/attendance-evidence.ts");
        }
        if (
          specifier === "@/types/equal-technician-handover" ||
          specifier.endsWith("types/equal-technician-handover")
        ) {
          return loadModule("src/types/equal-technician-handover.ts");
        }
        if (
          specifier === "@/types/handover-reservation-guard" ||
          specifier.endsWith("types/handover-reservation-guard")
        ) {
          return loadModule("src/types/handover-reservation-guard.ts");
        }
        if (specifier === "./equal-technician-handover-domain") {
          return loadModule("src/lib/operations/equal-technician-handover-domain.ts");
        }
        if (specifier === "./attendance-evidence-domain") {
          return loadModule("src/lib/operations/attendance-evidence-domain.ts");
        }
        if (
          specifier === "@/types/handover-report" ||
          specifier.endsWith("types/handover-report")
        ) {
          return {};
        }
        throw new Error(`Unexpected pure-domain import: ${specifier}`);
      },
    },
  );
  modules.set(relativePath, loaded.exports);
  return loaded.exports;
}

// Synchronous source read via decode of the pre-read buffer map below.
const sourceCache = new Map();
function await_readFile(relativePath) {
  const cached = sourceCache.get(relativePath);
  if (cached !== undefined) {
    return cached;
  }
  throw new Error(`Module source was not preloaded: ${relativePath}`);
}

const MODULE_PATHS = [
  "src/types/attendance-evidence.ts",
  "src/types/equal-technician-handover.ts",
  "src/types/handover-reservation-guard.ts",
  "src/lib/operations/equal-technician-handover-domain.ts",
  "src/lib/operations/attendance-evidence-domain.ts",
];
for (const path of MODULE_PATHS) {
  sourceCache.set(path, await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

const evidenceTypes = loadModule("src/types/attendance-evidence.ts");
const handoverDomain = loadModule("src/lib/operations/equal-technician-handover-domain.ts");
const attendance = loadModule("src/lib/operations/attendance-evidence-domain.ts");
const guardTypes = loadModule("src/types/handover-reservation-guard.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const token1 = "a0000000-0000-4000-8000-000000000001";
const token2 = "a0000000-0000-4000-8000-000000000002";

const scheduledStart = "2026-10-04T08:00:00.000Z";
const scheduledEnd = "2026-10-04T17:00:00.000Z";
const reservedAt = "2026-10-04T06:00:00.000Z";

const identity = handoverDomain.createEqualHandoverIdentity({
  schema: "equal-handover-v2",
  outgoingShiftId: "shift-out",
  outgoingPermanentPairId: "pair-out",
  outgoingTechnicianIds: ["out-tech-1", "out-tech-2"],
  outgoingSlotToken: token1,
  outgoingGeneration: 1,
  incomingShiftId: "shift-in",
  incomingPermanentPairId: "pair-in",
  incomingTechnicianIds: ["in-tech-1", "in-tech-2"],
  successorSlotToken: token2,
  successorGeneration: 2,
  shiftType: "morning",
  scheduledStart,
  scheduledEnd,
});

const handoverId = handoverDomain.createEqualHandoverId(identity);
const handoverDocumentId = handoverDomain.createEqualHandoverDocumentId("shift-out");

const aggregate = handoverDomain.createEqualHandover({
  identity,
  reservedAt,
  reservedBy: "supervisor-1",
});
const reservation = aggregate.reservation;

function makeGuard(overrides = {}) {
  const base = {
    id: `guard_${identity.outgoingShiftId}`,
    schema: guardTypes.HANDOVER_RESERVATION_GUARD_SCHEMA,
    outgoingShiftId: identity.outgoingShiftId,
    protocolOwner: "v2",
    ownerHandoverDocumentId: handoverDocumentId,
    ownerLifecycleState: "active",
    guardRevision: reservation.revision,
    fencingEpoch: reservation.revision,
    outgoingSlotToken: identity.outgoingSlotToken,
    outgoingGeneration: identity.outgoingGeneration,
    successorSlotToken: identity.successorSlotToken,
    successorGeneration: identity.successorGeneration,
    reservationId: handoverId,
    reservedIncomingShiftId: identity.incomingShiftId,
    reservedAt,
    reservedBy: "supervisor-1",
    retiredSuccessorSlotTokens: [],
    terminalEvidenceRef: null,
    createdAt: reservedAt,
    updatedAt: reservedAt,
    ...overrides,
  };
  return base;
}

function makeRequest(overrides = {}) {
  return {
    schema: evidenceTypes.ATTENDANCE_EVIDENCE_SCHEMA,
    handoverId,
    handoverDocumentId,
    eventId: "confirm-event-1",
    position: "incoming_tech_a",
    technicianUid: "in-tech-1",
    kind: "incoming_clock_in",
    scheduledStart,
    scheduledEnd,
    reportedDepartureTime: null,
    attestedByUid: null,
    attestationReason: null,
    lateReason: null,
    handoverRevision: reservation.revision,
    snapshotHash: handoverDomain.createEqualHandoverSnapshot(aggregate).snapshotHash,
    expectedGuardRevision: reservation.revision,
    expectedFencingEpoch: reservation.revision,
    ...overrides,
  };
}

function personalConfirmation(uid = "in-tech-1") {
  return {
    verifiedTechnicianUid: uid,
    method: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_CONFIRMATION,
  };
}

function buildFor(requestOverrides, serverTime, authentication = personalConfirmation()) {
  const request = attendance.assertAttendanceEvidenceRequest(makeRequest(requestOverrides));
  const operation = attendance.createPendingAttendanceOperation(request);
  return attendance.buildAttendanceEvidence({
    operation,
    serverTime,
    guard: makeGuard(),
    reservation,
    identity,
    trustedAuthentication: authentication,
  });
}

// ---------------------------------------------------------------------------
// Required scenario coverage
// ---------------------------------------------------------------------------

// 1. First valid incoming clock-in (personal password confirmation).
test("1. first valid personal confirmation establishes server-timed clock-in", () => {
  const evidence = buildFor({}, "2026-10-04T08:01:00.000Z");
  assert.equal(evidence.kind, "incoming_clock_in");
  assert.equal(evidence.clockIn, "2026-10-04T08:01:00.000Z");
  assert.equal(evidence.eventTime, "2026-10-04T08:01:00.000Z");
  assert.equal(evidence.personallyAuthenticated, true);
  assert.equal(evidence.technicianUid, "in-tech-1");
  assert.equal(evidence.incomingShiftId, "shift-in");
  assert.equal(evidence.handoverId, handoverId);
  assert.equal(evidence.operationId, attendance.attendanceOperationId("confirm-event-1"));
  assert.equal(evidence.eventId, "confirm-event-1");
  assert.equal(attendance.attendanceEvidenceCountsAsClockIn(evidence), true);
});

// 2. Login/reservation/report events are not clock-in and cannot finalize.
test("2. login, reservation and report events cannot establish clock-in", () => {
  assert.equal(
    evidenceTypes.ATTENDANCE_CLOCK_IN_EVIDENCE_KINDS.length,
    2,
    "only personal confirmation and personal late acceptance establish clock-in",
  );
  // A personal clock-out method can never authorize a clock-in kind.
  assert.throws(
    () =>
      attendance.buildAttendanceEvidence({
        operation: attendance.createPendingAttendanceOperation(
          attendance.assertAttendanceEvidenceRequest(makeRequest()),
        ),
        serverTime: "2026-10-04T08:01:00.000Z",
        guard: makeGuard(),
        reservation,
        identity,
        trustedAuthentication: {
          verifiedTechnicianUid: "in-tech-1",
          method: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.SERVER_ISSUED_PERSONAL_CLOCK_OUT,
        },
      }),
    /cannot finalize evidence kind/,
  );
  // A colleague attestation can never finalize a clock-in kind.
  assert.throws(
    () =>
      attendance.buildAttendanceEvidence({
        operation: attendance.createPendingAttendanceOperation(
          attendance.assertAttendanceEvidenceRequest(makeRequest()),
        ),
        serverTime: "2026-10-04T08:01:00.000Z",
        guard: makeGuard(),
        reservation,
        identity,
        trustedAuthentication: {
          verifiedTechnicianUid: "in-tech-2",
          method: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.COLLEAGUE_ATTESTATION,
        },
      }),
    /cannot finalize evidence kind/,
  );
  assert.equal(
    attendance.isPersonallyAuthenticatedMethod(
      evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.COLLEAGUE_ATTESTATION,
    ),
    false,
  );
});

// 3. Exactly five minutes after scheduled start is on time.
test("3. exactly five minutes after scheduled start is on time", () => {
  const evidence = buildFor({}, "2026-10-04T08:05:00.000Z");
  assert.equal(evidence.clockIn, "2026-10-04T08:05:00.000Z");
  const late = attendance.evaluateIncomingAttendanceLateness(
    scheduledStart,
    "2026-10-04T08:05:00.000Z",
  );
  assert.equal(late.isLate, false);
});

// 4. More than five minutes is late and keeps the server time.
test("4. more than five minutes after scheduled start is late", () => {
  const late = attendance.evaluateIncomingAttendanceLateness(
    scheduledStart,
    "2026-10-04T08:05:00.001Z",
  );
  assert.equal(late.isLate, true);
  assert.throws(
    () => buildFor({}, "2026-10-04T08:05:00.001Z"),
    /meaningful late reason is required/,
  );
  const evidence = buildFor({ lateReason: "traffic closure on route 9" }, "2026-10-04T08:20:00.000Z");
  assert.equal(evidence.clockIn, "2026-10-04T08:20:00.000Z");
  assert.equal(evidence.lateReason, "traffic closure on route 9");
});

// 5. Late clock-in without a meaningful reason is rejected. A missing reason
// is caught by the server-timing gate; a blank reason never even reaches it.
test("5. missing late reason is rejected for late confirmations", () => {
  assert.throws(
    () => buildFor({}, "2026-10-04T08:20:00.000Z"),
    /meaningful late reason is required/,
  );
  assert.throws(
    () => buildFor({ lateReason: "   " }, "2026-10-04T08:20:00.000Z"),
    /A non-empty reason is required/,
  );
  assert.throws(
    () => buildFor({ lateReason: "   " }, "2026-10-04T08:01:00.000Z"),
    /A non-empty reason is required/,
  );
});

// 6/7/8. Idempotent retry, duplicate slot, conflicting retry.
test("6-8. retries resolve idempotent, duplicate, or conflicting outcomes", () => {
  const request = attendance.assertAttendanceEvidenceRequest(makeRequest());
  const operation = attendance.createPendingAttendanceOperation(request);
  const digest = attendance.attendanceEvidenceRequestDigest(request);

  assert.deepEqual(
    attendance.resolveAttendanceOperationRetry({ existing: null, incomingRequestDigest: digest }),
    { kind: "fresh" },
  );
  assert.deepEqual(
    attendance.resolveAttendanceOperationRetry({ existing: operation, incomingRequestDigest: digest }),
    { kind: "idempotent_replay" },
  );
  const conflicting = attendance.resolveAttendanceOperationRetry({
    existing: operation,
    incomingRequestDigest: attendance.attendanceEvidenceRequestDigest(
      attendance.assertAttendanceEvidenceRequest(makeRequest({ eventId: "other-event" })),
    ),
  });
  assert.equal(conflicting.kind, "conflicting_retry");

  // Duplicate clock-in for the same slot: classified, original preserved.
  const evidence = buildFor({}, "2026-10-04T08:01:00.000Z");
  assert.equal(
    attendance.classifyAttendanceEvidenceConflict({
      existing: evidence,
      incomingKind: "incoming_clock_in",
      incomingTechnicianUid: "in-tech-1",
      incomingEventTime: "2026-10-04T09:00:00.000Z",
      incomingOperationId: "att2_op_other",
    }),
    "clock_in_reset",
  );

  // Deterministic ids: same event id -> same operation id; same slot parts -> same slot.
  assert.equal(
    attendance.attendanceOperationId("confirm-event-1"),
    attendance.attendanceOperationId("confirm-event-1"),
  );
  assert.equal(
    attendance.attendanceEvidenceSlotId({ handoverId, technicianUid: "in-tech-1", kind: "incoming_clock_in" }),
    operation.slotId,
  );
});

// 10. Pending operations never count as attendance.
test("10. pending operations do not count as attendance", () => {
  const operation = attendance.createPendingAttendanceOperation(
    attendance.assertAttendanceEvidenceRequest(makeRequest()),
  );
  assert.equal(operation.status, "pending");
  assert.equal(attendance.attendanceOperationCountsAsAttendance(operation), false);
  const finalized = { ...operation, status: "finalized", finalizedAt: "2026-10-04T08:01:00.000Z" };
  assert.equal(attendance.attendanceOperationCountsAsAttendance(finalized), true);
});

// 12. Reconfirmation cannot change or re-time the original clock-in.
test("12. report reconfirmation preserves the original clock-in", () => {
  const original = buildFor({}, "2026-10-04T08:01:00.000Z");
  // A later re-confirmation event for the same technician/handover/kind maps
  // to the same deterministic slot whose evidence already exists.
  const retriedRequest = attendance.assertAttendanceEvidenceRequest(
    makeRequest({ eventId: "reconfirm-event-2", snapshotHash: "b".repeat(64) }),
  );
  const retriedOperation = attendance.createPendingAttendanceOperation(retriedRequest);
  assert.equal(retriedOperation.slotId, original.slotId);
  assert.equal(
    attendance.classifyAttendanceEvidenceConflict({
      existing: original,
      incomingKind: retriedOperation.request.kind,
      incomingTechnicianUid: retriedOperation.request.technicianUid,
      incomingEventTime: "2026-10-04T09:30:00.000Z",
      incomingOperationId: retriedOperation.id,
    }),
    "clock_in_reset",
  );
  // evaluateIncomingClockIn keeps the stored clock-in across reconfirmations.
  const preserved = attendance.evaluateIncomingClockIn({
    technicianUid: "in-tech-1",
    confirmedAt: "2026-10-04T09:30:00.000Z",
    scheduledStart,
    existingClockIn: {
      technicianUid: "in-tech-1",
      clockInTimestamp: "2026-10-04T08:01:00.000Z",
      firstConfirmedAt: "2026-10-04T08:01:00.000Z",
      isLate: false,
      latenessMinutes: 0,
      lateReasonRequired: false,
    },
  });
  assert.equal(preserved.clockInTimestamp, "2026-10-04T08:01:00.000Z");
});

// 13. Missing incoming technician: no fabricated clock-in.
test("13. missing incoming technician never gets fabricated attendance", () => {
  const rule = attendance.absentIncomingAttendanceRule({
    absenceType: "not_yet_in",
    side: "incoming",
  });
  assert.equal(rule.createsClockInEvidence, false);
  assert.equal(rule.producesAttendanceEvidence, false);
  assert.equal(rule.personalConfirmationEstablished, false);
  assert.match(rule.futurePath, /personally authenticate/);
  assert.throws(
    () => attendance.absentIncomingAttendanceRule({ absenceType: "absent_left_office", side: "incoming" }),
    /not_yet_in/,
  );
  // Clock-in evidence kinds require personal password methods; attestation
  // can never produce a clock-in document.
  assert.throws(
    () =>
      attendance.assertAttendanceEvidenceRequest(
        makeRequest({ kind: "incoming_clock_in", attestedByUid: "in-tech-2" }),
      ),
    /cannot be attested by a colleague/,
  );
});

// 14. Late personal acceptance uses the server acceptance time.
test("14. late acceptance keeps server acceptance time, not transfer time", () => {
  const request = attendance.assertAttendanceEvidenceRequest(
    makeRequest({
      eventId: "accept-event-1",
      kind: "incoming_late_acceptance",
      position: "incoming_tech_b",
      technicianUid: "in-tech-2",
      lateReason: "ambulance detour",
    }),
  );
  const operation = attendance.createPendingAttendanceOperation(request);
  const acceptanceTime = "2026-10-04T09:45:00.000Z";
  const handoverTransferTime = "2026-10-04T08:30:00.000Z";
  void handoverTransferTime;
  const evidence = attendance.buildAttendanceEvidence({
    operation,
    serverTime: acceptanceTime,
    guard: makeGuard(),
    reservation,
    identity,
    trustedAuthentication: {
      verifiedTechnicianUid: "in-tech-2",
      method: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_ACCEPTANCE,
    },
  });
  assert.equal(evidence.clockIn, acceptanceTime);
  assert.equal(evidence.personallyAuthenticated, true);
  const evaluation = attendance.evaluateLateIncomingAcceptance({
    technicianUid: "in-tech-2",
    scheduledStart,
    acceptedAt: acceptanceTime,
    lateReason: "ambulance detour",
  });
  assert.equal(evaluation.clockInTimestamp, acceptanceTime);
  assert.equal(evaluation.isLate, true);
});

// 15. Outgoing colleague-attested departure preserves provenance.
test("15. colleague-attested departure preserves attester, reason and reported time", () => {
  const attestedBy = "out-tech-2";
  const request = attendance.assertAttendanceEvidenceRequest(
    makeRequest({
      eventId: "attest-event-1",
      kind: "outgoing_absent_departure_attestation",
      position: "outgoing_tech_a",
      technicianUid: "out-tech-1",
      attestedByUid: attestedBy,
      attestationReason: "left after acute episode, witnessed by colleague",
      reportedDepartureTime: "2026-10-04T16:30:00.000Z",
    }),
  );
  const operation = attendance.createPendingAttendanceOperation(request);
  const attesterServerTime = "2026-10-04T16:40:00.000Z";
  const evidence = attendance.buildAttendanceEvidence({
    operation,
    serverTime: attesterServerTime,
    guard: makeGuard(),
    reservation,
    identity,
    trustedAuthentication: {
      verifiedTechnicianUid: attestedBy,
      method: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.COLLEAGUE_ATTESTATION,
    },
  });
  assert.equal(evidence.personallyAuthenticated, false, "attestation is not personal attendance");
  assert.equal(evidence.attestedByUid, attestedBy);
  assert.equal(evidence.reportedDepartureTime, "2026-10-04T16:30:00.000Z");
  assert.equal(evidence.clockOut, "2026-10-04T16:30:00.000Z");
  assert.equal(evidence.eventTime, attesterServerTime);
  assert.equal(evidence.attestationReason, "left after acute episode, witnessed by colleague");
  assert.equal(attendance.attendanceEvidenceCountsAsClockIn(evidence), false);
  assert.equal(evidence.clockIn, null, "no fabricated clock-in for absent technician");
});

// 16. Personal clock-out cannot be silently overwritten.
test("16. personal clock-out blocks later colleague attestation", () => {
  const personalRequest = attendance.assertAttendanceEvidenceRequest(
    makeRequest({
      eventId: "personal-out-1",
      kind: "outgoing_personal_clock_out",
      position: "outgoing_tech_a",
      technicianUid: "out-tech-1",
    }),
  );
  const personalEvidence = attendance.buildAttendanceEvidence({
    operation: attendance.createPendingAttendanceOperation(personalRequest),
    serverTime: "2026-10-04T17:00:00.000Z",
    guard: makeGuard(),
    reservation,
    identity,
    trustedAuthentication: {
      verifiedTechnicianUid: "out-tech-1",
      method: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.SERVER_ISSUED_PERSONAL_CLOCK_OUT,
    },
  });
  assert.equal(personalEvidence.clockOut, "2026-10-04T17:00:00.000Z");
  assert.equal(
    attendance.classifyAttendanceEvidenceConflict({
      existing: personalEvidence,
      incomingKind: "outgoing_absent_departure_attestation",
      incomingTechnicianUid: "out-tech-1",
      incomingEventTime: "2026-10-04T17:05:00.000Z",
      incomingOperationId: "att2_op_other",
    }),
    "personal_clock_out_overwrite",
  );
});

// 17. Invalid reported departure times are rejected.
test("17. invalid reported departure times are rejected", () => {
  const base = {
    kind: "outgoing_absent_departure_attestation",
    position: "outgoing_tech_a",
    technicianUid: "out-tech-1",
    attestedByUid: "out-tech-2",
    attestationReason: "witnessed departure",
  };
  // Rejected at the request boundary, so an impossible departure time can
  // never be persisted as a pending operation, let alone become evidence.
  for (const reportedDepartureTime of [
    "2026-10-05T23:00:00.000Z",
    "2025-01-01T00:00:00.000Z",
    "2026-10-03T19:59:59.999Z",
    "2026-10-04T15:40:00Z",
  ]) {
    assert.throws(
      () =>
        attendance.assertAttendanceEvidenceRequest(
          makeRequest({ ...base, reportedDepartureTime }),
        ),
      /departure time|canonical reported departure time/,
      reportedDepartureTime,
    );
  }

  // A valid reported departure time builds attested evidence unchanged.
  const attested = attendance.buildAttendanceEvidence({
    operation: attendance.createPendingAttendanceOperation(
      attendance.assertAttendanceEvidenceRequest(
        makeRequest({ ...base, reportedDepartureTime: "2026-10-04T15:40:00.000Z" }),
      ),
    ),
    serverTime: "2026-10-04T16:40:00.000Z",
    guard: makeGuard(),
    reservation,
    identity,
    trustedAuthentication: {
      verifiedTechnicianUid: "out-tech-2",
      method: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.COLLEAGUE_ATTESTATION,
    },
  });
  assert.equal(attested.reportedDepartureTime, "2026-10-04T15:40:00.000Z");
  assert.equal(attested.eventTime, "2026-10-04T16:40:00.000Z");

  assert.throws(
    () =>
      attendance.assertAttendanceEvidenceRequest(
        makeRequest({ ...base, reportedDepartureTime: "not-a-time" }),
      ),
    /Invalid canonical reported departure time/,
  );
});

// 19 (pure part). Guard ownership inconsistencies block evidence creation.
test("19. guard ownership inconsistencies fail closed", () => {
  const expectations = attendance.attendanceGuardExpectations(reservation);
  assert.throws(
    () => attendance.assertAttendanceGuardOwnership(null, expectations),
    /requires an active reservation guard/,
  );
  assert.throws(
    () => attendance.assertAttendanceGuardOwnership(makeGuard({ protocolOwner: "v1" }), expectations),
    /different handover protocol/,
  );
  assert.throws(
    () => attendance.assertAttendanceGuardOwnership(makeGuard({ ownerLifecycleState: "cancelled" }), expectations),
    /cancelled/,
  );
  assert.throws(
    () => attendance.assertAttendanceGuardOwnership(makeGuard({ guardRevision: 99 }), expectations),
    /stale guard revision/,
  );
  assert.throws(
    () =>
      attendance.assertAttendanceGuardOwnership(
        makeGuard({ retiredSuccessorSlotTokens: [identity.successorSlotToken] }),
        expectations,
      ),
    /successor slot token is retired/,
  );
  // The full healthy guard passes.
  attendance.assertAttendanceGuardOwnership(makeGuard(), {
    ...expectations,
    expectedGuardRevision: reservation.revision,
    expectedFencingEpoch: reservation.revision,
  });
});

// 20 (pure part). Attendance calculations never assume or decide.
test("20. worked duration requires both endpoints and decides nothing", () => {
  const computed = attendance.computeAttendanceWorkedDuration({
    clockIn: "2026-10-04T08:01:00.000Z",
    clockOut: "2026-10-04T16:01:00.000Z",
  });
  assert.equal(computed.status, "computed");
  assert.equal(computed.workedMs, 8 * 60 * 60 * 1000);
  assert.equal(computed.breakDeductionApplied, false);
  assert.equal(computed.payableHours, "policy_unresolved");

  const insufficient = attendance.computeAttendanceWorkedDuration({
    clockIn: "2026-10-04T08:01:00.000Z",
    clockOut: null,
  });
  assert.equal(insufficient.status, "insufficient_evidence");
  assert.equal(insufficient.workedMs, null);

  const inverted = attendance.computeAttendanceWorkedDuration({
    clockIn: "2026-10-04T16:01:00.000Z",
    clockOut: "2026-10-04T08:01:00.000Z",
  });
  assert.equal(inverted.status, "insufficient_evidence");

  const policies = attendance.resolveUnresolvedAttendancePolicies();
  assert.equal(policies.payableHoursEvaluation, "policy_unresolved");
  assert.equal(policies.attendanceCorrectionAuthority, "policy_unresolved");
});

// Extra invariants: stale handover identity and cross-side misuse.
test("extra. stale handover revision and cross-side evidence fail closed", () => {
  assert.throws(
    () => buildFor({ handoverRevision: reservation.revision + 3 }, "2026-10-04T08:01:00.000Z"),
    /reservation revision/,
  );
  assert.throws(
    () =>
      attendance.buildAttendanceEvidence({
        operation: attendance.createPendingAttendanceOperation(
          attendance.assertAttendanceEvidenceRequest(
            makeRequest({ kind: "outgoing_personal_clock_out", position: "incoming_tech_a", technicianUid: "in-tech-1" }),
          ),
        ),
        serverTime: "2026-10-04T17:00:00.000Z",
        guard: makeGuard(),
        reservation,
        identity,
        trustedAuthentication: {
          verifiedTechnicianUid: "in-tech-1",
          method: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.SERVER_ISSUED_PERSONAL_CLOCK_OUT,
        },
      }),
    /does not match the participant side/,
  );
  assert.throws(
    () =>
      attendance.buildAttendanceEvidence({
        operation: attendance.createPendingAttendanceOperation(
          attendance.assertAttendanceEvidenceRequest(makeRequest()),
        ),
        serverTime: "2026-10-04T08:01:00.000Z",
        guard: makeGuard(),
        reservation,
        identity,
        trustedAuthentication: {
          verifiedTechnicianUid: "supervisor-1",
          method: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_CONFIRMATION,
        },
      }),
    /own verified authentication/,
  );
});
