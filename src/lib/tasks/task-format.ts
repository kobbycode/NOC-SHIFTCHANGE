import {
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_ACCEPTANCE_STATUSES,
  TASK_RESPONSIBILITY_STATUSES,
  type TaskStatus,
  type TaskPriority,
  type TaskAcceptanceStatus,
  type TaskResponsibilityStatus,
} from "@/types/task";

/*
 * Human-readable task status labels.
 */

export const TASK_STATUS_LABELS:
  Record<TaskStatus, string> = {
    [TASK_STATUSES.OPEN]:
      "Open",

    [TASK_STATUSES.IN_PROGRESS]:
      "In Progress",

    [TASK_STATUSES.PENDING_VERIFICATION]:
      "Pending Verification",

    [TASK_STATUSES.COMPLETED]:
      "Completed",

    [TASK_STATUSES.CANCELLED]:
      "Cancelled",
  };

/*
 * Task priority labels.
 */

export const TASK_PRIORITY_LABELS:
  Record<TaskPriority, string> = {
    [TASK_PRIORITIES.LOW]:
      "Low",

    [TASK_PRIORITIES.MEDIUM]:
      "Medium",

    [TASK_PRIORITIES.HIGH]:
      "High",

    [TASK_PRIORITIES.CRITICAL]:
      "Critical",
  };

/*
 * Assignment acceptance labels.
 */

export const TASK_ACCEPTANCE_LABELS:
  Record<
    TaskAcceptanceStatus,
    string
  > = {
    [TASK_ACCEPTANCE_STATUSES.PENDING]:
      "Pending Acceptance",

    [TASK_ACCEPTANCE_STATUSES.ACCEPTED]:
      "Accepted",

    [TASK_ACCEPTANCE_STATUSES.REJECTED]:
      "Rejected",
  };

/*
 * Assignment responsibility labels.
 */

export const TASK_RESPONSIBILITY_LABELS:
  Record<
    TaskResponsibilityStatus,
    string
  > = {
    [TASK_RESPONSIBILITY_STATUSES.ACTIVE]:
      "Active",

    [TASK_RESPONSIBILITY_STATUSES.RELEASED]:
      "Released",
  };

/*
 * Display dates without assuming
 * that all legacy records contain
 * valid date values.
 */

export function formatTaskDate(
  value: string | null | undefined
): string {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

  if (
    !Number.isFinite(date.getTime())
  ) {
    return "Invalid date";
  }

  return date.toLocaleString(
    "en-GB",
    {
      dateStyle: "medium",

      timeStyle: "short",
    }
  );
}