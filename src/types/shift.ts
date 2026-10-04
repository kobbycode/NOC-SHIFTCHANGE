
export const SHIFT_TYPES = {
  MORNING: "morning",
  NIGHT: "night",
} as const;

export type ShiftType =
  (typeof SHIFT_TYPES)[keyof typeof SHIFT_TYPES];

export const SHIFT_STATUSES = {
  SCHEDULED: "scheduled",
  ACTIVE: "active",
  HANDOVER_PENDING: "handover_pending",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

export type ShiftStatus =
  (typeof SHIFT_STATUSES)[keyof typeof SHIFT_STATUSES];

export const SHIFT_MEMBER_ROLES = {
  PRIMARY: "primary",
  ADDITIONAL: "additional",
} as const;

export type ShiftMemberRole =
  (typeof SHIFT_MEMBER_ROLES)[keyof typeof SHIFT_MEMBER_ROLES];

export interface Shift {
  id: string;

  operationalSlotToken: string | null;

  permanentPairId: string | null;

  shiftType: ShiftType;

  status: ShiftStatus;

  scheduledStart: string;
  scheduledEnd: string;

  actualStart: string | null;
  actualEnd: string | null;

  primaryTechnicianIds: string[];

  createdBy: string;

  createdAt: string;
  updatedAt: string;
}

export interface ShiftMember {
  id: string;

  shiftId: string;
  technicianId: string;

  role: ShiftMemberRole;

  joinedAt: string;
  leftAt: string | null;
}