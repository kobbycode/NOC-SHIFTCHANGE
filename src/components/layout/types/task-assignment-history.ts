
import type {
  TaskAcceptanceStatus,
} from "@/types/task";

export const TASK_ASSIGNMENT_EVENTS = {
  ASSIGNED: "assigned",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  TRANSFERRED: "transferred",
} as const;

export type TaskAssignmentEvent =
  (typeof TASK_ASSIGNMENT_EVENTS)[keyof
    typeof TASK_ASSIGNMENT_EVENTS];

export interface TaskAssignmentHistory {
  id: string;

  taskId: string;
  assignmentId: string;

  assignmentGeneration?: number;
  originalGeneration?: number;
  replacementAssignmentId?: string;
  replacementGeneration?: number;

  event: TaskAssignmentEvent;

  previousTechnicianId: string | null;
  newTechnicianId: string;

  responsibility: "lead" | "support";

  previousAcceptanceStatus:
    TaskAcceptanceStatus | null;

  newAcceptanceStatus:
    TaskAcceptanceStatus;

  performedBy: string;

  reason: string;

  createdAt: string;
}
