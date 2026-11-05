import assert from "node:assert/strict";
import test from "node:test";
import { modules, store, fixtureRecords } from "./formal-handover-transfer-fixtures.mjs";

// All persistence is the existing in-memory transactional fixture. No SDK/network.
const equalEvidence = (a, b, message) => assert.deepEqual(structuredClone(a), structuredClone(b), message);
const load = modules();
const { buildReportAttendanceRow: build, reportAttendanceNotices: notices } = load("lib/operations/handover-report-attendance");
const { reportAttendanceLabels: labels, reportNoticeCategory } = load("lib/operations/handover-report-attendance-view");
const join = load("lib/operations/shift-join-domain");
const at = "2026-10-23T12:00:00.000Z";
const legacy = (overrides = {}) => ({ ...join.createShiftAttendanceRecord({ shiftId: "outgoing", technicianUid: "out-a", participationAuthority: "primary", authorizationId: null, recordedAt: at }), ...overrides });
const row = (overrides = {}) => build({ outgoingShiftId: "outgoing", uid: "out-a", position: "outgoing_tech_a", side: "outgoing", name: "Alpha", legacy: legacy(), evidence: [], absenceDeclared: null, ...overrides });

test("legacy present confirms reporting only, with null personal clocks and unknown hours", () => {
  const r = row();
  assert.equal(r.reportingEvidence.kind, "legacy_present_reporting");
  assert.equal(r.reportingEvidence.eventTime, at);
  assert.equal(r.reportingEvidence.personallyAuthenticated, false);
  assert.equal(r.clockIn, null); assert.equal(r.clockOut, null); assert.equal(r.hoursWorked, null);
  assert.equal(labels(r).reporting, "Reporting confirmed");
  assert.equal(labels(r).clocks, "Personal clock evidence unavailable");
  assert.equal(labels(r).hours, "Unknown");
  equalEvidence(Array.from(notices(r)), ["Evidence required: Personal clock evidence unavailable: Alpha", "Information: Worked hours unknown: Alpha"]);
});
test("missing outgoing reporting evidence is required and is never an absence declaration", () => {
  const r = row({ legacy: null });
  assert.ok(notices(r).includes("Evidence required: Reporting attendance missing: Alpha"));
  assert.equal(r.absenceDeclared, null);
});
for (const change of [{ isProvisional: true }, { status: "absent" }, { status: "late" }, { status: "not_yet_arrived" }]) {
  test(`unconfirmed legacy reporting preserves personal clocks independently: ${JSON.stringify(change)}`, () => {
    const record = legacy({ clockIn: at, clockOut: "2026-10-23T20:00:00.000Z", ...change });
    const r = row({ legacy: record });
    assert.equal(r.reportingEvidence, null);
    assert.equal(r.clockIn, change.isProvisional ? null : at);
    assert.equal(r.clockOut, change.isProvisional ? null : "2026-10-23T20:00:00.000Z");
    assert.equal(r.hoursWorked, change.isProvisional ? null : 8);
    equalEvidence(r.legacyAttendance, record);
    assert.ok(notices(r).some(n => n.startsWith("Evidence required: Reporting attendance")));
  });
}
for (const change of [{ shiftId: "foreign" }, { technicianId: "foreign" }, { recordedAt: "invalid" }, { status: "invalid" }]) {
  test(`invalid or mismatched legacy record fails closed: ${JSON.stringify(change)}`, () => assert.throws(() => row({ legacy: legacy(change) })));
}
test("incoming attendance before acceptance is not yet due even if an outgoing-scoped legacy row exists", () => {
  const r = row({ side: "incoming", position: "incoming_tech_a" });
  assert.equal(r.reportingEvidence, null); assert.equal(r.clockIn, null); assert.equal(r.clockOut, null); assert.equal(r.hoursWorked, null);
  assert.equal(labels(r).reporting, "Awaiting personal acceptance"); assert.equal(labels(r).hours, "Not yet applicable");
  equalEvidence(Array.from(notices(r)), ["Not yet due: Awaiting personal acceptance: Alpha. Worked hours: Not yet applicable."]);
});
for (const clocks of [{ clockIn: at }, { clockOut: at }, {}]) {
  test(`one or both unknown clocks never yield worked hours: ${JSON.stringify(clocks)}`, () => assert.equal(row({ legacy: legacy(clocks) }).hoursWorked, null));
}
test("worked hours require two valid personal clocks", () => {
  assert.equal(row({ legacy: legacy({ clockIn: at, clockOut: "2026-10-23T20:00:00.000Z" }) }).hoursWorked, 8);
  assert.throws(() => row({ legacy: legacy({ clockIn: at, clockOut: "2026-10-23T11:00:00.000Z" }) }));
});
test("explicit absence stays explicit without synthesizing clocks or hours", () => {
  const r = row({ legacy: null, absenceDeclared: "absent_left_office" });
  assert.equal(r.hoursWorked, null); assert.equal(r.clockOut, null);
  equalEvidence(Array.from(notices(r)), ["Information: Declared absence (absent left office): Alpha"]);
  const incoming = row({ side: "incoming", position: "incoming_tech_a", legacy: null, absenceDeclared: "not_yet_in" });
  assert.equal(labels(incoming).reporting, "Declared absence");
  assert.equal(notices(incoming).some(n => n.startsWith("Not yet due:")), false);
});
test("historical warning strings remain unclassified and unchanged", () => {
  for (const s of ["Attendance missing: Alpha", "Hours worked cannot be determined: Alpha"]) assert.equal(reportNoticeCategory(s), "Historical / unclassified");
  assert.equal(reportNoticeCategory("Information: Worked hours unknown: Alpha"), "Information");
  assert.equal(reportNoticeCategory("Not yet due: Awaiting personal acceptance: Alpha"), "Not yet due");
  assert.equal(reportNoticeCategory("Evidence required: Reporting attendance missing: Alpha"), "Evidence required");
});

function fixture() {
  const f = store({
    "lib/notifications/notification-outbox": () => "export const notificationsEnabled = () => false; export function writeOutboxEntries() {}",
    "lib/notifications/notification-hooks": () => "export const absenceIntents = () => []; export const commitIntents = absenceIntents; export const completionIntents = absenceIntents; export const confirmationIntents = absenceIntents;",
  });
  const base = fixtureRecords(f.load, { count: 0 });
  for (const [path, data] of base.records) f.records.set(path, structuredClone(data));
  const domain = f.load("lib/operations/equal-technician-handover-domain");
  const identity = { ...base.aggregate.identity, schema: "equal-handover-v2", outgoingTechnicianIds: base.out, incomingTechnicianIds: base.incoming };
  delete identity.outgoingPrimaryTechnicianIds; delete identity.incomingPrimaryTechnicianIds;
  const aggregate = domain.createEqualHandover({ identity, reservedAt: base.at, reservedBy: base.out[0] });
  f.records.set("equal_handovers_v2/handover_v2_outgoing", aggregate);
  const guard = f.load("lib/operations/handover-reservation-guard-domain").createInitialReservationGuard({ outgoingShiftId: "outgoing", protocolOwner: "v2", ownerHandoverDocumentId: "handover_v2_outgoing", outgoingSlotToken: identity.outgoingSlotToken, outgoingGeneration: identity.outgoingGeneration, successorSlotToken: identity.successorSlotToken, successorGeneration: identity.successorGeneration, reservationId: aggregate.reservation.handoverId, reservedIncomingShiftId: "incoming", reservedAt: base.at, reservedBy: base.out[0] });
  f.records.set(`handover_reservation_guards/${guard.id}`, guard);
  for (const uid of [...base.out, ...base.incoming]) f.records.get(`users/${uid}`).fullName = uid;
  for (const uid of base.out) f.records.set(`shift_attendance/outgoing_${uid}`, join.createShiftAttendanceRecord({ shiftId: "outgoing", technicianUid: uid, participationAuthority: "primary", authorizationId: null, recordedAt: base.at }));
  const stations = f.load("types/shift-operations").DEFAULT_BROADCAST_STATIONS;
  for (const [i, station] of stations.entries()) {
    const id = `broadcast-${i}`;
    f.records.set(`shift_operation_events/${id}`, { id, recordId: id, shiftId: "outgoing", revision: 1, kind: "broadcast", stationId: station.id, stationName: station.name, status: "on_air", occurredAt: base.at, remarks: "Observed", authorUid: "out-a", authorName: "Alpha", originalReporterUid: "out-a", originalReporterName: "Alpha", createdAt: base.at, provenance: "authenticated_technician" });
  }
  const original = [...f.records.values()].find(r => r.stationName === "Asempa FM");
  assert.ok(original, "fixture includes Asempa FM");
  f.records.set("shift_operation_events/asempa-correction", { ...original, id: "asempa-correction", revision: 2, remarks: "Corrected observation", authorUid: "out-b", authorName: "Beta", createdAt: new Date(Date.parse(base.at) + 1000).toISOString() });
  f.records.set("shift_operation_events/no-ob", { id: "no-ob", recordId: "no-ob", shiftId: "outgoing", revision: 1, kind: "no_ob", occurredAt: base.at, remarks: "No outside broadcast declared", authorUid: "out-a", authorName: "Alpha", originalReporterUid: "out-a", originalReporterName: "Alpha", createdAt: base.at, provenance: "authenticated_technician" });
  return { ...base, ...f, aggregate, guard, api: f.load("lib/operations/equal-handover-report-firestore"), domain };
}
const prepare = f => f.api.prepareEqualHandoverReport({ outgoingShiftId: "outgoing", actorUid: "out-a", reason: null });
function freezeInput(f, p) {
  const aggregate = f.records.get("equal_handovers_v2/handover_v2_outgoing");
  return { outgoingShiftId: "outgoing", actorUid: "out-a", reason: "Reviewed synthetic fixture", correctionNote: null, preparationRevision: p.preparationRevision, contentDigest: p.contentDigest, evidenceSnapshotHash: p.evidenceSnapshotHash, workSnapshotVersion: p.workSnapshotVersion, expectedRevision: aggregate.revision, expectedSnapshotHash: f.domain.createEqualHandoverSnapshot(aggregate).snapshotHash, expectedGuardRevision: f.guard.guardRevision, expectedFencingEpoch: f.guard.fencingEpoch };
}
test("production preparation preserves all six events and provenance and creates no attendance/membership", async () => {
  const f = fixture(), before = structuredClone(f.records);
  const { preparation: p } = await prepare(f);
  assert.equal(p.content.operations.events.length, 6);
  assert.equal(p.content.operations.events.filter(e => e.stationName === "Asempa FM").length, 2);
  assert.equal(p.content.completeness.blockers.length, 0);
  assert.equal(p.warnings.length, 7);
  for (const [key, value] of before) if (/^(shift_operation_events|shift_members|shift_attendance)\//.test(key)) equalEvidence(f.records.get(key), value);
  assert.ok(f.calls.filter(([op]) => op !== "read").every(([, path]) => /^(handover_report_preparations_v2|audit_logs|users)\//.test(path)));
});
test("historical prepared content detects semantic drift, cannot freeze, and only explicit preparation creates a new revision", async () => {
  const f = fixture(); const { preparation: p } = await prepare(f);
  const historical = structuredClone(p), rd = f.load("lib/operations/equal-handover-report-domain");
  for (const r of historical.content.attendance) r.reportingEvidence = null;
  historical.content.completeness.warnings = ["No fault or technical activity records were submitted. This is not a declaration of no faults.", ...historical.content.attendance.flatMap(r => [`Attendance missing: ${r.name}`, `Hours worked cannot be determined: ${r.name}`])];
  historical.warnings = historical.content.completeness.warnings;
  historical.contentDigest = rd.digestEqualHandoverReportV2Content(historical.content);
  historical.revisionHistory[0].contentDigest = historical.contentDigest;
  rd.assertEqualHandoverReportPreparationV2(historical);
  f.records.set(`handover_report_preparations_v2/${p.id}`, historical);
  const before = structuredClone(f.records);
  const state = await f.api.readEqualHandoverReportState("outgoing", "out-a");
  assert.equal(state.preparationDrifted, true);
  equalEvidence(f.records, before, "read does not update the prepared report");
  await assert.rejects(() => f.api.freezeEqualHandoverReport(freezeInput(f, historical)), /stale preparation cannot freeze/);
  equalEvidence(f.records, before, "incompatible freeze makes no writes");
  const next = (await prepare(f)).preparation;
  assert.equal(next.preparationRevision, 2);
  assert.equal(next.revisionHistory[0].contentDigest, historical.contentDigest);
  assert.notEqual(next.contentDigest, historical.contentDigest);
});
test("frozen report digest and binding survive new reads and identical freeze retries byte for byte", async () => {
  const f = fixture(), p = (await prepare(f)).preparation;
  const input = freezeInput(f, p), first = await f.api.freezeEqualHandoverReport(input);
  const key = `handover_reports_v2/${first.report.id}`, saved = structuredClone(f.records.get(key));
  await f.api.readEqualHandoverReportState("outgoing", "out-a");
  const replay = await f.api.freezeEqualHandoverReport(input);
  assert.equal(replay.replayed, true); equalEvidence(f.records.get(key), saved);
  assert.equal(f.load("lib/operations/equal-handover-report-domain").digestEqualHandoverReportV2Content(saved.content), saved.digest);
  assert.ok(f.calls.filter(([op, path]) => op !== "read" && path === key).every(([op]) => op === "create"));
  const state = await f.api.readEqualHandoverReportState("outgoing", "out-a");
  assert.equal(state.readiness.ready, false);
  assert.equal(state.readiness.missingConfirmations.length, 4);
});
test("historical frozen semantics stay immutable and surface drift without silently changing digests", async () => {
  const f = fixture(), p = (await prepare(f)).preparation;
  const first = await f.api.freezeEqualHandoverReport(freezeInput(f, p));
  const key = `handover_reports_v2/${first.report.id}`, historical = structuredClone(first.report);
  historical.content.completeness.warnings = ["Attendance missing: out-a", "Hours worked cannot be determined: out-a"];
  for (const r of historical.content.attendance) r.reportingEvidence = null;
  const rd = f.load("lib/operations/equal-handover-report-domain");
  historical.digest = rd.digestEqualHandoverReportV2Content(historical.content);
  historical.binding.digest = historical.digest;
  rd.assertFrozenEqualHandoverReportV2(historical);
  f.records.set(key, historical);
  f.records.get("equal_handovers_v2/handover_v2_outgoing").reportBinding = structuredClone(historical.binding);
  const before = structuredClone(f.records);
  const state = await f.api.readEqualHandoverReportState("outgoing", "out-a");
  assert.ok(state.readiness.reasons.includes("report_evidence_stale"));
  assert.equal(state.frozenReport.digest, historical.digest);
  equalEvidence(f.records, before);
  equalEvidence(state.frozenReport.content.completeness.warnings, historical.content.completeness.warnings);
});
for (const kind of ["incoming_clock_in", "incoming_late_acceptance"]) test(`authoritative ${kind} remains personal evidence with unknown worked hours`, () => {
  const f = fixture(), ed = f.load("lib/operations/attendance-evidence-domain");
  const request = { schema: "attendance-evidence-v2", handoverId: f.aggregate.reservation.handoverId, handoverDocumentId: "handover_v2_outgoing", eventId: `event-${kind}`, position: "incoming_tech_a", technicianUid: "in-a", kind, scheduledStart: f.aggregate.identity.scheduledStart, scheduledEnd: f.aggregate.identity.scheduledEnd, reportedDepartureTime: null, attestedByUid: null, attestationReason: null, lateReason: kind === "incoming_late_acceptance" ? "Delayed arrival" : null, handoverRevision: f.aggregate.revision, snapshotHash: f.domain.createEqualHandoverSnapshot(f.aggregate).snapshotHash, expectedGuardRevision: f.guard.guardRevision, expectedFencingEpoch: f.guard.fencingEpoch };
  const evidence = ed.buildAttendanceEvidence({ operation: ed.createPendingAttendanceOperation(request), serverTime: new Date().toISOString(), guard: f.guard, reservation: f.aggregate.reservation, identity: f.aggregate.identity, trustedAuthentication: { verifiedTechnicianUid: "in-a", method: kind === "incoming_late_acceptance" ? "personal_password_acceptance" : "personal_password_confirmation" } });
  ed.assertAttendanceEvidence(evidence);
  const r = row({ uid: "in-a", position: "incoming_tech_a", side: "incoming", legacy: null, evidence: [evidence] });
  assert.equal(r.clockIn, evidence.clockIn); assert.equal(r.clockOut, null); assert.equal(r.hoursWorked, null);
  assert.equal(r.reportingEvidence.personallyAuthenticated, true);
  assert.equal(notices(r).some(n => n.startsWith("Not yet due:")), false);
  assert.throws(() => row({ uid: "in-a", position: "incoming_tech_b", side: "incoming", legacy: null, evidence: [evidence] }), /identity is inconsistent/);
  assert.throws(() => row({ uid: "in-a", position: "incoming_tech_a", side: "incoming", legacy: null, evidence: [evidence, evidence] }), /Conflicting attendance/);
});
test("colleague departure attestation cannot become personal clock-out or worked hours", () => {
  const f = fixture(), ed = f.load("lib/operations/attendance-evidence-domain");
  const request = { schema: "attendance-evidence-v2", handoverId: f.aggregate.reservation.handoverId, handoverDocumentId: "handover_v2_outgoing", eventId: "attested-departure", position: "outgoing_tech_b", technicianUid: "out-b", kind: "outgoing_absent_departure_attestation", scheduledStart: f.aggregate.identity.scheduledStart, scheduledEnd: f.aggregate.identity.scheduledEnd, reportedDepartureTime: f.at, attestedByUid: "out-a", attestationReason: "Colleague observed departure", lateReason: null, handoverRevision: f.aggregate.revision, snapshotHash: f.domain.createEqualHandoverSnapshot(f.aggregate).snapshotHash, expectedGuardRevision: f.guard.guardRevision, expectedFencingEpoch: f.guard.fencingEpoch };
  const evidence = ed.buildAttendanceEvidence({ operation: ed.createPendingAttendanceOperation(request), serverTime: new Date().toISOString(), guard: f.guard, reservation: f.aggregate.reservation, identity: f.aggregate.identity, trustedAuthentication: { verifiedTechnicianUid: "out-a", method: "colleague_attestation" } });
  ed.assertAttendanceEvidence(evidence);
  const record = { ...f.records.get("shift_attendance/outgoing_out-b"), clockIn: at };
  const r = row({ uid: "out-b", position: "outgoing_tech_b", legacy: record, evidence: [evidence] });
  assert.equal(r.clockIn, at); assert.equal(r.clockOut, null); assert.equal(r.hoursWorked, null);
  assert.equal(r.departureProvenance, "colleague_attested");
  assert.equal(r.reportingEvidence.personallyAuthenticated, false);
});
test("broadcast completeness still blocks freezing and missing confirmations still block readiness", async () => {
  const f = fixture();
  for (const key of [...f.records.keys()]) if (key.startsWith("shift_operation_events/")) f.records.delete(key);
  const p = (await prepare(f)).preparation;
  assert.equal(p.blockers.length, 5);
  await assert.rejects(() => f.api.freezeEqualHandoverReport(freezeInput(f, p)), /Report is incomplete/);
  const state = await f.api.readEqualHandoverReportState("outgoing", "out-a");
  assert.equal(state.readiness.ready, false);
});
