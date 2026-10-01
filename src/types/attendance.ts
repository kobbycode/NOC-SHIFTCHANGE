
export const ATTENDANCE_STATUSES = {
  PRESENT: "present",
  ABSENT: "absent",
  LATE: "late",
  EXCUSED: "excused",
  ON_LEAVE: "on_leave",
  NOT_YET_ARRIVED: "not_yet_arrived",
} as const;

export type AttendanceStatus =
  (typeof ATTENDANCE_STATUSES)[keyof typeof ATTENDANCE_STATUSES];

export const ATTENDANCE_PARTICIPATION_AUTHORITIES = {
  PRIMARY: "primary",
  TEMPORARY_AUTHORIZED: "temporary_authorized",
} as const;

export type AttendanceParticipationAuthority =
  (typeof ATTENDANCE_PARTICIPATION_AUTHORITIES)[keyof typeof ATTENDANCE_PARTICIPATION_AUTHORITIES];

export interface Attendance {
  id: string;

  shiftId: string;
  technicianId: string;

  status: AttendanceStatus;

  participationAuthority:
    AttendanceParticipationAuthority;

  authorizationId: string | null;

  clockIn: string | null;
  clockOut: string | null;

  isProvisional: boolean;

  recordedAt: string;
  updatedAt: string;
}