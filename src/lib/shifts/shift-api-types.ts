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
