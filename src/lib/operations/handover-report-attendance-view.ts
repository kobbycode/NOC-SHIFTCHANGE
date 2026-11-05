import type { EqualHandoverReportV2AttendanceRow } from "@/types/handover-report-v2";

/** Display stored report fields only. Do not regenerate historical report content. */
export function reportAttendanceLabels(row: EqualHandoverReportV2AttendanceRow, outgoingShiftId?: string) {
  const awaiting = row.side === "incoming" && row.reportingEvidence === null && row.absenceDeclared === null;
  const legacy = row.legacyAttendance;
  const reportingConfirmed = row.reportingEvidence?.kind === "legacy_present_reporting" ||
    (row.side === "outgoing" && outgoingShiftId !== undefined && legacy?.shiftId === outgoingShiftId &&
      legacy.technicianId === row.uid && legacy.id === `${outgoingShiftId}_${row.uid}` &&
      legacy.status === "present" && legacy.isProvisional === false);
  return {
    reporting: row.absenceDeclared !== null ? "Declared absence" : awaiting ? "Awaiting personal acceptance"
      : reportingConfirmed ? "Reporting confirmed"
      : row.reportingEvidence ? "Recorded evidence" : "Reporting confirmation unavailable",
    clocks: awaiting ? "Not yet due" : row.clockIn === null || row.clockOut === null ? "Personal clock evidence unavailable" : "Personal clocks recorded",
    hours: awaiting ? "Not yet applicable" : row.hoursWorked === null ? "Unknown" : row.hoursWorked.toFixed(2),
  };
}

export function reportNoticeCategory(notice: string): string {
  if (notice.startsWith("Information: ")) return "Information";
  if (notice.startsWith("Not yet due: ")) return "Not yet due";
  if (notice.startsWith("Evidence required: ")) return "Evidence required";
  return "Historical / unclassified";
}
