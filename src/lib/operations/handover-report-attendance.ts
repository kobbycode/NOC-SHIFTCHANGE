import type { Attendance } from "@/types/attendance";
import type { AttendanceEvidence } from "@/types/attendance-evidence";
import { ATTENDANCE_EVIDENCE_KINDS } from "@/types/attendance-evidence";
import type { EqualHandoverPosition, EqualHandoverSide, EqualAbsenceType } from "@/types/equal-technician-handover";
import type { EqualHandoverReportV2AttendanceRow } from "@/types/handover-report-v2";
import { readAttendanceRecord } from "./attendance-read-domain";
import { attendanceEvidenceCountsAsClockIn, computeAttendanceWorkedDuration } from "./attendance-evidence-domain";
import { AssignmentOperationError } from "./assignment-transaction";
import { EqualHandoverReportDomainError } from "./equal-handover-report-domain";

export const LEGACY_REPORTING_KIND = "legacy_present_reporting";

/** Reporting confirmation is separate from personal clocks and never creates evidence. */
export function buildReportAttendanceRow(input: {
  outgoingShiftId: string;
  position: EqualHandoverPosition;
  side: EqualHandoverSide;
  uid: string;
  name: string | null;
  legacy: Attendance | null;
  evidence: AttendanceEvidence[];
  absenceDeclared: EqualAbsenceType | null;
}): EqualHandoverReportV2AttendanceRow {
  const { side, uid, position } = input;
  const legacy = input.legacy === null ? null : readAttendanceRecord(`${input.outgoingShiftId}_${uid}`, input.legacy);
  const personalLegacy = side === "outgoing" && legacy?.isProvisional === false ? legacy : null;
  const usableLegacy = personalLegacy?.status === "present"
    ? legacy : null;
  const own = input.evidence.filter(record => record.technicianUid === uid);
  if (own.some(record => record.position !== position || record.outgoingShiftId !== input.outgoingShiftId)) {
    throw new EqualHandoverReportDomainError("Attendance evidence identity is inconsistent; administrator review required.");
  }
  const clockIns = own.filter(attendanceEvidenceCountsAsClockIn);
  const clockOuts = own.filter(record => record.kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT && record.clockOut !== null);
  const attestations = own.filter(record => record.kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION);
  if (clockIns.length > 1 || clockOuts.length > 1 || attestations.length > 1) {
    throw new AssignmentOperationError("Conflicting attendance evidence exists for a participant; administrator review required.", 409);
  }
  if (clockOuts.length === 1 && attestations.length === 1) {
    throw new AssignmentOperationError("A colleague attestation contradicts a personal clock-out; administrator review required.", 409);
  }
  const clockIn = side === "incoming" ? clockIns[0]?.clockIn ?? null : personalLegacy?.clockIn ?? null;
  // Incoming legacy records read under the outgoing shift can never provide clocks.
  const clockOut = side === "outgoing" ? personalLegacy?.clockOut ?? clockOuts[0]?.clockOut ?? null : null;
  const departureProvenance = clockOut !== null ? "personal" : side === "outgoing" && attestations.length ? "colleague_attested" : null;
  const source = side === "incoming" ? clockIns[0] : clockOuts[0] ?? attestations[0];
  const reportingEvidence = source ? {
    kind: source.kind,
    authenticationMethod: source.authenticationMethod,
    personallyAuthenticated: source.personallyAuthenticated,
    eventTime: source.eventTime,
    attestedByUid: source.attestedByUid,
    lateReason: source.lateReason,
  } : usableLegacy ? {
    kind: LEGACY_REPORTING_KIND,
    authenticationMethod: "legacy_reporting_record",
    personallyAuthenticated: false,
    eventTime: usableLegacy.recordedAt,
    attestedByUid: null,
    lateReason: null,
  } : null;
  const duration = computeAttendanceWorkedDuration({ clockIn, clockOut });
  return {
    position, side, uid, name: input.name, clockIn, clockOut, reportingEvidence,
    legacyAttendance: legacy,
    hoursWorked: duration.status === "computed" && duration.workedMs !== null ? duration.workedMs / 3_600_000 : null,
    payableHours: "policy_unresolved", departureProvenance, absenceDeclared: input.absenceDeclared,
  };
}

/** Keep the persisted string-array contract; classification is explicit in each new notice. */
export function reportAttendanceNotices(row: EqualHandoverReportV2AttendanceRow): string[] {
  const name = row.name ?? row.uid;
  if (row.absenceDeclared !== null) return [`Information: Declared absence (${row.absenceDeclared.replaceAll("_", " ")}): ${name}`];
  if (row.side === "incoming" && row.reportingEvidence === null) {
    return [`Not yet due: Awaiting personal acceptance: ${name}. Worked hours: Not yet applicable.`];
  }
  const notices: string[] = [];
  if (row.side === "outgoing") {
    const legacy = row.legacyAttendance;
    if (legacy?.isProvisional) notices.push(`Evidence required: Reporting attendance is provisional: ${name}`);
    else if (legacy && legacy.status !== "present") notices.push(`Evidence required: Reporting attendance status is ${legacy.status}: ${name}`);
    else if (!legacy && row.reportingEvidence === null) notices.push(`Evidence required: Reporting attendance missing: ${name}`);
    if (row.clockIn === null || row.clockOut === null) notices.push(`Evidence required: Personal clock evidence unavailable: ${name}`);
  }
  if (row.hoursWorked === null) notices.push(`Information: Worked hours unknown: ${name}`);
  return notices;
}
