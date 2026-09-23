import {
  TASK_PRIORITIES,
  type TaskPriority,
} from "@/types/task";

import {
  TASK_PRIORITY_LABELS,
} from "@/lib/tasks/task-format";

interface TaskPriorityBadgeProps {
  priority: TaskPriority;
}

const PRIORITY_STYLES:
  Record<TaskPriority, string> = {
    [TASK_PRIORITIES.LOW]:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",

    [TASK_PRIORITIES.MEDIUM]:
      "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",

    [TASK_PRIORITIES.HIGH]:
      "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",

    [TASK_PRIORITIES.CRITICAL]:
      "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  };

export function TaskPriorityBadge({
  priority,
}: TaskPriorityBadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center
        rounded-full
        px-3 py-1
        text-xs font-semibold
        ${PRIORITY_STYLES[priority]}
      `}
    >
      {TASK_PRIORITY_LABELS[priority]}
    </span>
  );
}