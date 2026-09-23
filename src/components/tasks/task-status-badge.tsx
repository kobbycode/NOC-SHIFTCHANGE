import {
  TASK_STATUSES,
  type TaskStatus,
} from "@/types/task";

import {
  TASK_STATUS_LABELS,
} from "@/lib/tasks/task-format";

interface TaskStatusBadgeProps {
  status: TaskStatus;
}

const STATUS_STYLES:
  Record<TaskStatus, string> = {
    [TASK_STATUSES.OPEN]:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",

    [TASK_STATUSES.IN_PROGRESS]:
      "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",

    [TASK_STATUSES.PENDING_VERIFICATION]:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",

    [TASK_STATUSES.COMPLETED]:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",

    [TASK_STATUSES.CANCELLED]:
      "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  };

export function TaskStatusBadge({
  status,
}: TaskStatusBadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center
        rounded-full
        px-3 py-1
        text-xs font-semibold
        ${STATUS_STYLES[status]}
      `}
    >
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}