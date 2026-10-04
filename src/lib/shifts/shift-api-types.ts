import type {
  Attendance,
} from "@/types/attendance";
import type {
  Shift,
  ShiftMember,
} from "@/types/shift";

/*
 * Shared authoritative shift retrieval
 * types.
 */
export interface ShiftListResult {
  shifts: Shift[];
  total: number;
}

/*
 * Successful shift retrieval response.
 */
export interface ShiftListSuccessResponse {
  success: true;
  shifts: Shift[];
  total: number;
}

/*
 * Standard Shift API error response.
 */
export interface ShiftApiErrorResponse {
  success: false;
  error: string;
}

/*
 * Shift retrieval response.
 */
export type ShiftListApiResponse =
  | ShiftListSuccessResponse
  | ShiftApiErrorResponse;

/*
 * Authoritative membership retrieval result.
 */
export interface ShiftMemberListResult {
  members: ShiftMember[];
  total: number;
}

/*
 * Successful membership retrieval response.
 */
export interface ShiftMemberListSuccessResponse {
  success: true;
  members: ShiftMember[];
  total: number;
}

/*
 * Shift-membership retrieval response.
 */
export type ShiftMemberListApiResponse =
  | ShiftMemberListSuccessResponse
  | ShiftApiErrorResponse;


  /*
 * Authoritative begin-handover result.
 */
export interface ShiftHandoverResult {
  shiftId: string;
  status: "handover_pending";
  handoverStartedAt: string;
}

/*
 * Successful begin-handover response.
 */
export interface ShiftHandoverSuccessResponse {
  success: true;
  message: string;
  shift: {
    id: string;
    status: "handover_pending";
    handoverStartedAt: string;
  };
}

/*
 * Begin-handover API response.
 */
export type ShiftHandoverApiResponse =
  | ShiftHandoverSuccessResponse
  | ShiftApiErrorResponse;

/*
 * Authoritative shift-completion result.
 */
export interface ShiftCompletionResult {
  shiftId: string;
  status: "completed";
  actualEnd: string;
}

/*
 * Successful shift-completion response.
 */
export interface ShiftCompletionSuccessResponse {
  success: true;
  message: string;
  shift: {
    id: string;
    status: "completed";
    actualEnd: string;
  };
}

/*
 * Shift-completion API response.
 */
export type ShiftCompletionApiResponse =
  | ShiftCompletionSuccessResponse
  | ShiftApiErrorResponse;
/*
 * Technician-scoped authoritative
 * current-shift projection.
 *
 * This is intentionally narrower than the
 * supervisor/admin shift-list model.
 */
export interface TechnicianCurrentShiftResult {
  id: string;

  shiftType:
    Shift["shiftType"];

  status:
    | "scheduled"
    | "active"
    | "handover_pending";

  scheduledStart: string;
  scheduledEnd: string;

  actualStart: string | null;
  actualEnd: null;

  participationAuthority:
    Attendance["participationAuthority"];

  authorizationId: string | null;

  attendance: Attendance | null;

  joinedAt: string | null;

  canStart: boolean;
  canJoin: boolean;
}

/*
 * Successful technician current-shift
 * retrieval response.
 */
export interface TechnicianCurrentShiftSuccessResponse {
  success: true;

  currentShift:
    TechnicianCurrentShiftResult | null;
}

/*
 * Technician current-shift API response.
 */
export type TechnicianCurrentShiftApiResponse =
  | TechnicianCurrentShiftSuccessResponse
  | ShiftApiErrorResponse;

/*
 * Authoritative shift-start result exposed
 * to the browser.
 *
 * Starting a shift does not create
 * attendance.
 */
export interface ShiftStartResult {
  shiftId: string;
  status: "active";
  actualStart: string;
}

/*
 * Successful shift-start API response.
 */
export interface ShiftStartSuccessResponse {
  success: true;
  message: string;

  shift: {
    id: string;
    status: "active";
    actualStart: string;
  };
}

/*
 * Shift-start API response.
 */
export type ShiftStartApiResponse =
  | ShiftStartSuccessResponse
  | ShiftApiErrorResponse;

/*
 * Authoritative attendance record returned
 * by explicit technician join.
 *
 * The join endpoint intentionally returns
 * only the fields required by the immediate
 * client transition. The full authoritative
 * current-shift projection is reloaded after
 * the action.
 */
export interface ShiftJoinResult {
  id: string;
  shiftId: string;
  technicianId: string;

  status:
    Attendance["status"];

  participationAuthority:
    Attendance["participationAuthority"];

  recordedAt: string;
}

/*
 * Successful explicit shift-join response.
 */
export interface ShiftJoinSuccessResponse {
  success: true;
  message: string;

  attendance: ShiftJoinResult;
}

/*
 * Shift-join API response.
 */
export type ShiftJoinApiResponse =
  | ShiftJoinSuccessResponse
  | ShiftApiErrorResponse;
