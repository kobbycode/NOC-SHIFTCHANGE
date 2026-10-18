import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Load types module
const typesSource = await readFile(
  new URL("../src/types/equal-technician-handover.ts", import.meta.url),
  "utf8",
);
const typesLoaded = { exports: {} };
runInNewContext(
  ts.transpileModule(typesSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { exports: typesLoaded.exports },
);
const types = typesLoaded.exports;

// Load domain module
const domainSource = await readFile(
  new URL("../src/lib/operations/equal-technician-handover-domain.ts", import.meta.url),
  "utf8",
);
const domainLoaded = { exports: {} };
runInNewContext(
  ts.transpileModule(domainSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    exports: domainLoaded.exports,
    structuredClone,
    TextEncoder,
    require(specifier) {
      if (specifier === "node:crypto") return { createHash };
      if (
        specifier === "@/types/equal-technician-handover" ||
        specifier.endsWith("equal-technician-handover")
      ) {
        return types;
      }
      if (
        specifier === "@/types/handover-report" ||
        specifier.endsWith("handover-report")
      ) {
        return {};
      }
      throw new Error(`Unexpected pure-domain import: ${specifier}`);
    },
  },
);
const domain = domainLoaded.exports;

// Common test fixtures
const token1 = "a0000000-0000-4000-8000-000000000001";
const token2 = "a0000000-0000-4000-8000-000000000002";

const at = "2026-10-04T08:00:00.000Z";
const later = "2026-10-04T08:02:00.000Z";
const endAt = "2026-10-04T17:00:00.000Z";

const reportBinding1 = {
  schema: "handover-report-v1",
  id: "report_00000000-0000-4000-8000-000000000001",
  digest: "1".repeat(64),
};

const reportBinding2 = {
  schema: "handover-report-v1",
  id: "report_00000000-0000-4000-8000-000000000002",
  digest: "2".repeat(64),
};

function validIdentity(overrides = {}) {
  return {
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
    scheduledStart: at,
    scheduledEnd: endAt,
    ...overrides,
  };
}

function validAggregate(overrides = {}) {
  return domain.createEqualHandover({
    identity: validIdentity(),
    reportBinding: reportBinding1,
    reservedAt: at,
    reservedBy: "supervisor-1",
    ...overrides,
  });
}

function context(aggregate, overrides = {}) {
  return {
    revision: aggregate.revision,
    snapshotHash: domain.createEqualHandoverSnapshot(aggregate).snapshotHash,
    recordedAt: later,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// 1. Valid two-outgoing/two-incoming identities
// ----------------------------------------------------------------------------
test("1. valid two-outgoing/two-incoming identities are accepted and normalized", () => {
  const id = domain.createEqualHandoverIdentity(validIdentity({
    outgoingSlotToken: token1.toUpperCase(),
    successorSlotToken: token2.toUpperCase(),
  }));
  assert.equal(id.schema, "equal-handover-v2");
  assert.equal(id.outgoingSlotToken, token1.toLowerCase());
  assert.equal(id.successorSlotToken, token2.toLowerCase());
  assert.deepEqual(id.outgoingTechnicianIds, ["out-tech-1", "out-tech-2"]);
  assert.deepEqual(id.incomingTechnicianIds, ["in-tech-1", "in-tech-2"]);
  assert.equal(id.successorGeneration, id.outgoingGeneration + 1);

  const docId = domain.createEqualHandoverDocumentId("shift-out");
  assert.equal(docId, "handover_v2_shift-out");
});

// ----------------------------------------------------------------------------
// 2. Rejection of duplicate or overlapping participant identities
// ----------------------------------------------------------------------------
test("2. rejection of duplicate or overlapping participant identities", () => {
  // Duplicate within outgoing
  assert.throws(
    () => domain.createEqualHandoverIdentity(validIdentity({ outgoingTechnicianIds: ["tech-1", "tech-1"] })),
    /Duplicate permanent participant identity/,
  );
  // Duplicate within incoming
  assert.throws(
    () => domain.createEqualHandoverIdentity(validIdentity({ incomingTechnicianIds: ["tech-2", "tech-2"] })),
    /Duplicate permanent participant identity/,
  );
  // Cross-side overlap (outgoing technician also in incoming)
  assert.throws(
    () => domain.createEqualHandoverIdentity(validIdentity({
      outgoingTechnicianIds: ["tech-1", "tech-2"],
      incomingTechnicianIds: ["tech-2", "tech-3"],
    })),
    /Cross-side duplicate participant identity/,
  );
  // Same shift IDs
  assert.throws(
    () => domain.createEqualHandoverIdentity(validIdentity({ incomingShiftId: "shift-out" })),
    /Incoming and outgoing shifts must differ/,
  );
});

// ----------------------------------------------------------------------------
// 3. Equal outgoing authority
// ----------------------------------------------------------------------------
test("3. equal outgoing authority: both outgoing technicians have equal standing", () => {
  // Outgoing tech A can confirm first
  const aggA = validAggregate();
  const resA = domain.confirmEqualHandoverParticipant(aggA, {
    ...context(aggA),
    actorUid: "out-tech-1",
    technicianUid: "out-tech-1",
  });
  assert.equal(resA.confirmations.length, 1);
  assert.equal(resA.confirmations[0].position, "outgoing_tech_a");

  // Outgoing tech B can confirm first with identical validity
  const aggB = validAggregate();
  const resB = domain.confirmEqualHandoverParticipant(aggB, {
    ...context(aggB),
    actorUid: "out-tech-2",
    technicianUid: "out-tech-2",
  });
  assert.equal(resB.confirmations.length, 1);
  assert.equal(resB.confirmations[0].position, "outgoing_tech_b");

  // Neither outgoing technician has 'primary' privilege or override power over the other
  const positions = domain.getEqualHandoverPositions(validIdentity());
  const outA = positions.find((p) => p.position === "outgoing_tech_a");
  const outB = positions.find((p) => p.position === "outgoing_tech_b");
  assert.equal(outA.side, "outgoing");
  assert.equal(outB.side, "outgoing");
});

// ----------------------------------------------------------------------------
// 4. Equal incoming authority
// ----------------------------------------------------------------------------
test("4. equal incoming authority: both incoming technicians have equal standing", () => {
  // Incoming tech A can confirm first
  const aggA = validAggregate();
  const resA = domain.confirmEqualHandoverParticipant(aggA, {
    ...context(aggA),
    actorUid: "in-tech-1",
    technicianUid: "in-tech-1",
  });
  assert.equal(resA.confirmations.length, 1);
  assert.equal(resA.confirmations[0].position, "incoming_tech_a");

  // Incoming tech B can confirm first
  const aggB = validAggregate();
  const resB = domain.confirmEqualHandoverParticipant(aggB, {
    ...context(aggB),
    actorUid: "in-tech-2",
    technicianUid: "in-tech-2",
  });
  assert.equal(resB.confirmations.length, 1);
  assert.equal(resB.confirmations[0].position, "incoming_tech_b");
});

// ----------------------------------------------------------------------------
// 5. Four-confirmation readiness
// ----------------------------------------------------------------------------
test("5. four-confirmation readiness: normal handover requires 4 independent confirmations", () => {
  let agg = validAggregate();
  const uids = ["out-tech-1", "out-tech-2", "in-tech-1", "in-tech-2"];

  for (const uid of uids) {
    agg = domain.confirmEqualHandoverParticipant(agg, {
      ...context(agg),
      actorUid: uid,
      technicianUid: uid,
    });
  }

  assert.equal(agg.confirmations.length, 4);
  const ready = domain.assertEqualHandoverReadyForTransfer(agg, context(agg));
  assert.equal(ready.lifecycleStatus, "collecting_confirmations");

  const completed = domain.completeEqualHandoverTransfer(agg, {
    ...context(agg),
    actorUid: "supervisor-1",
  });
  assert.equal(completed.lifecycleStatus, "completed");
});

// ----------------------------------------------------------------------------
// 6. Three-confirmation readiness with one valid absence
// ----------------------------------------------------------------------------
test("6. three-confirmation readiness with one valid absence", () => {
  // Case A: Missing incoming technician declared not_yet_in
  let aggA = validAggregate();
  // Record absence first
  aggA = domain.recordEqualHandoverAbsence(aggA, {
    ...context(aggA),
    actorUid: "supervisor-1",
    technicianUid: "in-tech-2",
    absenceType: "not_yet_in",
    reason: "Delayed in heavy transit",
  });

  // Confirm the remaining 3 technicians
  for (const uid of ["out-tech-1", "out-tech-2", "in-tech-1"]) {
    aggA = domain.confirmEqualHandoverParticipant(aggA, {
      ...context(aggA),
      actorUid: uid,
      technicianUid: uid,
    });
  }
  assert.equal(aggA.confirmations.length, 3);
  assert.equal(aggA.absences.length, 1);
  assert.ok(domain.assertEqualHandoverReadyForTransfer(aggA, context(aggA)));

  // Case B: Missing outgoing technician declared absent_left_office
  let aggB = validAggregate();
  aggB = domain.recordEqualHandoverAbsence(aggB, {
    ...context(aggB),
    actorUid: "supervisor-1",
    technicianUid: "out-tech-2",
    absenceType: "absent_left_office",
    reportedDepartureTime: "2026-10-04T07:45:00.000Z",
    attestedByUid: "out-tech-1",
    reason: "Medical emergency departure",
  });

  for (const uid of ["out-tech-1", "in-tech-1", "in-tech-2"]) {
    aggB = domain.confirmEqualHandoverParticipant(aggB, {
      ...context(aggB),
      actorUid: uid,
      technicianUid: uid,
    });
  }
  assert.equal(aggB.confirmations.length, 3);
  assert.equal(aggB.absences.length, 1);
  assert.ok(domain.assertEqualHandoverReadyForTransfer(aggB, context(aggB)));
});

// ----------------------------------------------------------------------------
// 7. Rejection of fabricated confirmations
// ----------------------------------------------------------------------------
test("7. rejection of fabricated confirmations", () => {
  const agg = validAggregate();

  // Tech 1 cannot confirm for Tech 2
  assert.throws(
    () => domain.confirmEqualHandoverParticipant(agg, {
      ...context(agg),
      actorUid: "out-tech-1",
      technicianUid: "out-tech-2",
    }),
    /A technician must confirm for self/,
  );

  // Supervisor cannot sign for a technician
  assert.throws(
    () => domain.confirmEqualHandoverParticipant(agg, {
      ...context(agg),
      actorUid: "supervisor-1",
      technicianUid: "out-tech-1",
    }),
    /A technician must confirm for self/,
  );

  // Admin cannot sign for a technician
  assert.throws(
    () => domain.confirmEqualHandoverParticipant(agg, {
      ...context(agg),
      actorUid: "admin-1",
      technicianUid: "in-tech-1",
    }),
    /A technician must confirm for self/,
  );

  // Confirming when marked absent without clearing is rejected
  const absentAgg = domain.recordEqualHandoverAbsence(agg, {
    ...context(agg),
    actorUid: "supervisor-1",
    technicianUid: "in-tech-2",
    absenceType: "not_yet_in",
    reason: "Late transit",
  });
  assert.throws(
    () => domain.confirmEqualHandoverParticipant(absentAgg, {
      ...context(absentAgg),
      actorUid: "in-tech-2",
      technicianUid: "in-tech-2",
    }),
    /Conflicting participant resolution: participant is recorded absent/,
  );
});

// ----------------------------------------------------------------------------
// 8. Rejection of unsupported absence combinations
// ----------------------------------------------------------------------------
test("8. rejection of unsupported absence combinations", () => {
  const agg = validAggregate();

  // Incoming marked with absent_left_office is rejected
  assert.throws(
    () => domain.recordEqualHandoverAbsence(agg, {
      ...context(agg),
      actorUid: "supervisor-1",
      technicianUid: "in-tech-1",
      absenceType: "absent_left_office",
      reportedDepartureTime: "2026-10-04T07:45:00.000Z",
      reason: "Invalid type for incoming",
    }),
    /Incoming participant absence type must be not_yet_in/,
  );

  // Outgoing marked with not_yet_in is rejected
  assert.throws(
    () => domain.recordEqualHandoverAbsence(agg, {
      ...context(agg),
      actorUid: "supervisor-1",
      technicianUid: "out-tech-1",
      absenceType: "not_yet_in",
      reason: "Invalid type for outgoing",
    }),
    /Outgoing participant absence type must be absent_left_office/,
  );

  // Outgoing absence missing reportedDepartureTime is rejected
  assert.throws(
    () => domain.recordEqualHandoverAbsence(agg, {
      ...context(agg),
      actorUid: "supervisor-1",
      technicianUid: "out-tech-1",
      absenceType: "absent_left_office",
      reason: "Missing departure time",
    }),
    /Outgoing participant absence requires reported departure time/,
  );

  // Empty reason is rejected
  assert.throws(
    () => domain.recordEqualHandoverAbsence(agg, {
      ...context(agg),
      actorUid: "supervisor-1",
      technicianUid: "in-tech-1",
      absenceType: "not_yet_in",
      reason: "   ",
    }),
    /A non-empty reason is required/,
  );

  // Multiple absences blocked on transfer readiness
  let multi = validAggregate();
  multi = domain.recordEqualHandoverAbsence(multi, {
    ...context(multi),
    actorUid: "supervisor-1",
    technicianUid: "in-tech-1",
    absenceType: "not_yet_in",
    reason: "Delayed transport",
  });
  multi = domain.recordEqualHandoverAbsence(multi, {
    ...context(multi),
    actorUid: "supervisor-1",
    technicianUid: "in-tech-2",
    absenceType: "not_yet_in",
    reason: "Also delayed",
  });
  // Confirm outgoing techs
  multi = domain.confirmEqualHandoverParticipant(multi, {
    ...context(multi),
    actorUid: "out-tech-1",
    technicianUid: "out-tech-1",
  });
  multi = domain.confirmEqualHandoverParticipant(multi, {
    ...context(multi),
    actorUid: "out-tech-2",
    technicianUid: "out-tech-2",
  });

  assert.throws(
    () => domain.assertEqualHandoverReadyForTransfer(multi, context(multi)),
    /Unsupported absence combination: multiple absences are blocked/,
  );
});

// ----------------------------------------------------------------------------
// 9. Rejection of unrelated participants
// ----------------------------------------------------------------------------
test("9. rejection of unrelated participants", () => {
  const agg = validAggregate();
  assert.throws(
    () => domain.confirmEqualHandoverParticipant(agg, {
      ...context(agg),
      actorUid: "unrelated-user",
      technicianUid: "unrelated-user",
    }),
    /Unauthorized handover participant/,
  );

  assert.throws(
    () => domain.recordEqualHandoverAbsence(agg, {
      ...context(agg),
      actorUid: "supervisor-1",
      technicianUid: "unrelated-user",
      absenceType: "not_yet_in",
      reason: "Not on this shift",
    }),
    /Unauthorized handover participant/,
  );
});

// ----------------------------------------------------------------------------
// 10. Current report revision and digest matching
// ----------------------------------------------------------------------------
test("10. confirmations must bind to current report revision and digest", () => {
  // Aggregate without frozen report cannot collect confirmations
  const unreportAgg = domain.createEqualHandover({
    identity: validIdentity(),
    reservedAt: at,
    reservedBy: "supervisor-1",
  });
  assert.equal(unreportAgg.reportBinding, null);
  assert.throws(
    () => domain.confirmEqualHandoverParticipant(unreportAgg, {
      ...context(unreportAgg),
      actorUid: "out-tech-1",
      technicianUid: "out-tech-1",
    }),
    /Freeze and review the consolidated report before confirmation/,
  );

  // Stale revision rejection
  const agg = validAggregate();
  assert.throws(
    () => domain.confirmEqualHandoverParticipant(agg, {
      ...context(agg),
      actorUid: "out-tech-1",
      technicianUid: "out-tech-1",
      revision: agg.revision + 5,
    }),
    /Stale handover revision/,
  );

  // Stale snapshot hash rejection
  assert.throws(
    () => domain.confirmEqualHandoverParticipant(agg, {
      ...context(agg),
      actorUid: "out-tech-1",
      technicianUid: "out-tech-1",
      snapshotHash: "0".repeat(64),
    }),
    /Stale handover snapshot/,
  );
});

// ----------------------------------------------------------------------------
// 11. Superseded confirmation invalidation
// ----------------------------------------------------------------------------
test("11. superseded confirmation invalidation upon report revision", () => {
  let agg = validAggregate();
  agg = domain.confirmEqualHandoverParticipant(agg, {
    ...context(agg),
    actorUid: "out-tech-1",
    technicianUid: "out-tech-1",
  });
  assert.equal(agg.confirmations.length, 1);

  // Revise the report
  const revised = domain.reviseEqualHandoverReport(agg, {
    ...context(agg),
    reportBinding: reportBinding2,
  });

  assert.equal(revised.revision, agg.revision + 1);
  assert.equal(revised.confirmations.length, 0); // Active confirmations cleared!
  assert.equal(revised.reportBinding.digest, reportBinding2.digest);

  // Handover is NOT ready for transfer with cleared confirmations
  assert.throws(
    () => domain.assertEqualHandoverReadyForTransfer(revised, context(revised)),
    /Incomplete handover: every participant requires confirmation/,
  );
});

// ----------------------------------------------------------------------------
// 12. Preservation of immutable historical evidence
// ----------------------------------------------------------------------------
test("12. preservation of immutable historical evidence", () => {
  let agg = validAggregate();
  agg = domain.confirmEqualHandoverParticipant(agg, {
    ...context(agg),
    actorUid: "out-tech-1",
    technicianUid: "out-tech-1",
  });

  const revised = domain.reviseEqualHandoverReport(agg, {
    ...context(agg),
    reportBinding: reportBinding2,
  });

  assert.equal(revised.historicalConfirmations.length, 1);
  const historical = revised.historicalConfirmations[0];
  assert.equal(historical.technicianUid, "out-tech-1");
  assert.equal(historical.revision, agg.revision);
  assert.equal(historical.invalidationReason, "report_revised");
  assert.equal(historical.reportBinding.digest, reportBinding1.digest);

  // Completed transfer aggregate cannot be modified
  for (const uid of ["out-tech-1", "out-tech-2", "in-tech-1", "in-tech-2"]) {
    agg = domain.confirmEqualHandoverParticipant(agg, {
      ...context(agg),
      actorUid: uid,
      technicianUid: uid,
    });
  }
  const completed = domain.completeEqualHandoverTransfer(agg, {
    ...context(agg),
    actorUid: "supervisor-1",
  });

  assert.throws(
    () => domain.confirmEqualHandoverParticipant(completed, {
      ...context(completed),
      actorUid: "out-tech-1",
      technicianUid: "out-tech-1",
    }),
    /Handover lifecycle does not permit mutation/,
  );
});

// ----------------------------------------------------------------------------
// 13. Correct five-minute lateness boundary
// ----------------------------------------------------------------------------
test("13. correct five-minute lateness boundary: exactly 5 min is on time; > 5 min is late", () => {
  const scheduledStart = "2026-10-04T08:00:00.000Z";

  // Early confirmation (7:55 AM)
  const early = domain.evaluateIncomingAttendanceLateness(scheduledStart, "2026-10-04T07:55:00.000Z");
  assert.equal(early.isLate, false);
  assert.equal(early.latenessMinutes, 0);
  assert.equal(early.lateReasonRequired, false);

  // Exact start time (8:00 AM)
  const exact = domain.evaluateIncomingAttendanceLateness(scheduledStart, "2026-10-04T08:00:00.000Z");
  assert.equal(exact.isLate, false);
  assert.equal(exact.latenessMinutes, 0);

  // Exactly 5 minutes after scheduled start (8:05:00.000 AM)
  const onTimeBoundary = domain.evaluateIncomingAttendanceLateness(scheduledStart, "2026-10-04T08:05:00.000Z");
  assert.equal(onTimeBoundary.isLate, false);
  assert.equal(onTimeBoundary.latenessMinutes, 5);
  assert.equal(onTimeBoundary.lateReasonRequired, false);

  // 1 millisecond past 5 minutes (8:05:00.001 AM) -> LATE
  const late1ms = domain.evaluateIncomingAttendanceLateness(scheduledStart, "2026-10-04T08:05:00.001Z");
  assert.equal(late1ms.isLate, true);
  assert.equal(late1ms.lateReasonRequired, true);

  // 1 second past 5 minutes (8:05:01.000 AM) -> LATE
  const late1sec = domain.evaluateIncomingAttendanceLateness(scheduledStart, "2026-10-04T08:05:01.000Z");
  assert.equal(late1sec.isLate, true);
  assert.equal(late1sec.lateReasonRequired, true);

  // Mandatory late reason when evaluating clock-in for late arrival
  assert.throws(
    () => domain.evaluateIncomingClockIn({
      technicianUid: "in-tech-1",
      confirmedAt: "2026-10-04T08:06:00.000Z",
      scheduledStart,
      lateReason: "",
    }),
    /A non-empty late reason is required when confirming more than five minutes after scheduled start/,
  );

  const lateClockIn = domain.evaluateIncomingClockIn({
    technicianUid: "in-tech-1",
    confirmedAt: "2026-10-04T08:06:00.000Z",
    scheduledStart,
    lateReason: "Traffic delay on main road",
  });
  assert.equal(lateClockIn.isLate, true);
  assert.equal(lateClockIn.lateReason, "Traffic delay on main road");
  assert.equal(lateClockIn.clockInTimestamp, "2026-10-04T08:06:00.000Z");
});

// ----------------------------------------------------------------------------
// 14. Incoming clock-in idempotency rules
// ----------------------------------------------------------------------------
test("14. incoming clock-in idempotency: initial evaluation creates clock-in; repeated call preserves it", () => {
  const scheduledStart = "2026-10-04T08:00:00.000Z";
  const initial = domain.evaluateIncomingClockIn({
    technicianUid: "in-tech-1",
    confirmedAt: "2026-10-04T08:03:00.000Z",
    scheduledStart,
  });

  assert.equal(initial.clockInTimestamp, "2026-10-04T08:03:00.000Z");
  assert.equal(initial.firstConfirmedAt, "2026-10-04T08:03:00.000Z");
  assert.equal(initial.isLate, false);

  // Repeated evaluation with existingClockIn returns identical state
  const repeated = domain.evaluateIncomingClockIn({
    technicianUid: "in-tech-1",
    confirmedAt: "2026-10-04T08:03:00.000Z",
    scheduledStart,
    existingClockIn: initial,
  });

  assert.deepEqual(repeated, initial);
});

// ----------------------------------------------------------------------------
// 15. Reconfirmation not resetting clock-in
// ----------------------------------------------------------------------------
test("15. reconfirmation does not reset clock-in", () => {
  const scheduledStart = "2026-10-04T08:00:00.000Z";
  const firstConfirmationTime = "2026-10-04T08:02:00.000Z";
  const reconfirmationTime = "2026-10-04T08:35:00.000Z";

  const firstClockIn = domain.evaluateIncomingClockIn({
    technicianUid: "in-tech-1",
    confirmedAt: firstConfirmationTime,
    scheduledStart,
  });
  assert.equal(firstClockIn.clockInTimestamp, firstConfirmationTime);
  assert.equal(firstClockIn.isLate, false);

  // Reconfirming at 8:35 AM with the existingClockIn record MUST retain original clock-in
  const reconfirmedClockIn = domain.evaluateIncomingClockIn({
    technicianUid: "in-tech-1",
    confirmedAt: reconfirmationTime,
    scheduledStart,
    existingClockIn: firstClockIn,
  });

  assert.equal(reconfirmedClockIn.clockInTimestamp, firstConfirmationTime);
  assert.equal(reconfirmedClockIn.firstConfirmedAt, firstConfirmationTime);
  assert.equal(reconfirmedClockIn.isLate, false);
});

// ----------------------------------------------------------------------------
// 16. Colleague-attested departure provenance
// ----------------------------------------------------------------------------
test("16. colleague-attested departure provenance is clearly distinguished from personal clock-out", () => {
  const departureTimestamp = "2026-10-04T17:00:00.000Z";

  // Personal clock-out
  const personal = domain.evaluateOutgoingDeparture({
    technicianUid: "out-tech-1",
    departureTimestamp,
    isPersonal: true,
  });
  assert.equal(personal.provenance, "personal");
  assert.equal(personal.attestedByUid, null);

  // Colleague-attested departure
  const colleague = domain.evaluateOutgoingDeparture({
    technicianUid: "out-tech-2",
    departureTimestamp,
    isPersonal: false,
    attestingColleagueUid: "out-tech-1",
    reason: "Departed at scheduled shift completion time with partner verification",
  });
  assert.equal(colleague.provenance, "colleague_attested");
  assert.equal(colleague.attestedByUid, "out-tech-1");
  assert.equal(colleague.reason, "Departed at scheduled shift completion time with partner verification");

  // Colleague self-attestation is rejected
  assert.throws(
    () => domain.evaluateOutgoingDeparture({
      technicianUid: "out-tech-2",
      departureTimestamp,
      isPersonal: false,
      attestingColleagueUid: "out-tech-2",
      reason: "Self attestation",
    }),
    /A technician cannot colleague-attest their own departure/,
  );
});

// ----------------------------------------------------------------------------
// 17. Explicit unresolved-policy outcomes
// ----------------------------------------------------------------------------
test("17. explicit unresolved-policy outcomes for payable hours and correction authority", () => {
  const policies = domain.resolveUnresolvedAttendancePolicies();
  assert.equal(policies.payableHoursEvaluation, "policy_unresolved");
  assert.equal(policies.attendanceCorrectionAuthority, "policy_unresolved");
  assert.equal(domain.UNRESOLVED_POLICY, "policy_unresolved");
});

// ----------------------------------------------------------------------------
// 18. Preservation of existing v1 domain tests
// ----------------------------------------------------------------------------
test("18. preservation of v1 domain contracts and separation of concerns", () => {
  // V2 aggregate has explicit separate schema
  const agg = validAggregate();
  assert.equal(agg.schema, "equal-handover-v2");

  // V2 participants use equal authority positions
  const participants = domain.resolveEqualHandoverParticipants(agg);
  assert.equal(participants.length, 4);
  assert.deepEqual(
    participants.map((p) => p.position),
    ["outgoing_tech_a", "outgoing_tech_b", "incoming_tech_a", "incoming_tech_b"],
  );

  // Late incoming acceptance uses server acceptance time
  const lateAcceptance = domain.evaluateLateIncomingAcceptance({
    technicianUid: "in-tech-2",
    scheduledStart: "2026-10-04T08:00:00.000Z",
    acceptedAt: "2026-10-04T09:15:00.000Z",
    lateReason: "Arrived after handover transfer completed",
  });
  assert.equal(lateAcceptance.acceptedAt, "2026-10-04T09:15:00.000Z");
  assert.equal(lateAcceptance.clockInTimestamp, "2026-10-04T09:15:00.000Z");
  assert.equal(lateAcceptance.isLate, true);
  assert.equal(lateAcceptance.latenessMinutes, 75);
});
