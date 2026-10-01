export const NEXT_SHIFT_AUTHORIZATION_STATUSES = {
  PENDING: "pending",
  CONSUMED: "consumed",
  COMPLETED: "completed",
  EXPIRED: "expired",
} as const;

export type NextShiftAuthorizationStatus =
  (typeof NEXT_SHIFT_AUTHORIZATION_STATUSES)[keyof typeof NEXT_SHIFT_AUTHORIZATION_STATUSES];

export interface NextShiftAuthorization {
  id: string;
  slotToken: string;
  slotGeneration: number;
  permanentPairId: string;
  authorizedTechnicianUid: string;
  status: NextShiftAuthorizationStatus;
  shiftId: string | null;
  consumedAt: string | null;
  completedAt: string | null;
  expiredAt: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}