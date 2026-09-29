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