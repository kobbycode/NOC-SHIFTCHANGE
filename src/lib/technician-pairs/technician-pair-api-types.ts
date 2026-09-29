import type {
  TechnicianPair,
} from "@/types/technician-pair";

export interface TechnicianPairListResult {
  pairs: TechnicianPair[];
  total: number;
}

export interface TechnicianPairListSuccessResponse {
  success: true;
  pairs: TechnicianPair[];
  total: number;
}

export interface TechnicianPairApiErrorResponse {
  success: false;
  error: string;
}

export type TechnicianPairListApiResponse =
  | TechnicianPairListSuccessResponse
  | TechnicianPairApiErrorResponse;

/**
 * Public client input for permanent technician-pair creation.
 *
 * The API accepts only the two technician UIDs.
 * Actor identity, role, pair status, timestamps, attendance,
 * account state, and audit information remain server-owned.
 */
export interface CreateTechnicianPairInput {
  technicianIds: [string, string];
}

export interface TechnicianPairCreateSuccess {
  success: true;
  message: string;
  pair: TechnicianPair;
}

export interface TechnicianPairCreateError {
  success: false;
  error: string;
}

export type TechnicianPairCreateResult =
  | TechnicianPairCreateSuccess
  | TechnicianPairCreateError;
