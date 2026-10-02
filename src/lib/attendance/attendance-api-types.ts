import type {
  Attendance,
} from "@/types/attendance";

export interface AttendanceListItem
  extends Attendance {
  technicianName: string;
}

export interface ShiftAttendanceListResult {
  attendance: AttendanceListItem[];
  total: number;
}

export interface ShiftAttendanceListSuccessResponse {
  success: true;
  attendance: AttendanceListItem[];
  total: number;
}

export interface AttendanceApiErrorResponse {
  success: false;
  error: string;
}

export type ShiftAttendanceListApiResponse =
  | ShiftAttendanceListSuccessResponse
  | AttendanceApiErrorResponse;