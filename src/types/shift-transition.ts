
import type {
  ShiftStatus,
} from "./shift";

export const SHIFT_TRANSITION_ACTIONS = {
  STARTED: "SHIFT_STARTED",

  HANDOVER_STARTED:
    "SHIFT_HANDOVER_STARTED",

  COMPLETED: "SHIFT_COMPLETED",

  CANCELLED: "SHIFT_CANCELLED",
} as const;

export type ShiftTransitionAction =
  (typeof SHIFT_TRANSITION_ACTIONS)[
    keyof typeof SHIFT_TRANSITION_ACTIONS
  ];

export interface ShiftTransitionAudit {
  id: string;

  action: ShiftTransitionAction;

  actorUid: string;

  shiftId: string;

  previousStatus: ShiftStatus;

  newStatus: ShiftStatus;

  createdAt: string;

  details: string;
}