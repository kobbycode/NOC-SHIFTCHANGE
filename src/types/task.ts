
export const TASK_STATUSES = {
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  PENDING_VERIFICATION: "pending_verification",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

export type TaskStatus =
  (typeof TASK_STATUSES)[keyof
    typeof TASK_STATUSES];

export const TASK_ACCEPTANCE_STATUSES = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
} as const;

export type TaskAcceptanceStatus =
  (typeof TASK_ACCEPTANCE_STATUSES)[keyof
    typeof TASK_ACCEPTANCE_STATUSES];

export const TASK_PRIORITIES = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const;

export type TaskPriority =
  (typeof TASK_PRIORITIES)[keyof
    typeof TASK_PRIORITIES];

export const TASK_RESPONSIBILITY_STATUSES = {
  ACTIVE: "active",
  RELEASED: "released",
} as const;

export type TaskResponsibilityStatus =
  (typeof TASK_RESPONSIBILITY_STATUSES)[keyof
    typeof TASK_RESPONSIBILITY_STATUSES];

export interface Task {
  id: string;

  title: string;
  description: string;

  priority: TaskPriority;
  status: TaskStatus;

  sectionId: string | null;
  shiftId: string | null;

  createdBy: string;

  createdAt: string;
  updatedAt: string;
}

export interface TaskAssignment {
  id: string;

  taskId: string;
  technicianId: string;

  responsibility: "lead" | "support";

  acceptanceStatus: TaskAcceptanceStatus;

  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;

  assignedAt: string;

  /*
   * Optional for legacy assignments.
   * Missing responsibilityStatus
   * represents active responsibility.
   */

  responsibilityStatus?:
    TaskResponsibilityStatus;

  releasedAt?: string | null;

  releasedBy?: string | null;

  transferredTo?: string | null;
}