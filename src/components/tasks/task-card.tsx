import {
  CalendarClock,
  ClipboardList,
  Users,
} from "lucide-react";

import type {
  TaskListItem,
} from "@/lib/tasks/task-api-types";

import {
  formatTaskDate,
  TASK_ACCEPTANCE_LABELS,
  TASK_RESPONSIBILITY_LABELS,
} from "@/lib/tasks/task-format";

import {
  TaskStatusBadge,
} from "./task-status-badge";

import {
  TaskPriorityBadge,
} from "./task-priority-badge";

interface TaskCardProps {
  item: TaskListItem;

  showAssignments?: boolean;

  children?: React.ReactNode;
}

export function TaskCard({
  item,
  showAssignments = true,
  children,
}: TaskCardProps) {
  const {
    task,
    assignments,
  } = item;

  const activeAssignments =
    assignments.filter(
      (assignment) =>
        assignment.responsibilityStatus !==
          "released" &&
        assignment.releasedAt == null
    );

  return (
    <article
      className="
        overflow-hidden rounded-2xl
        border border-slate-200
        bg-white shadow-sm
        dark:border-slate-800
        dark:bg-slate-950
      "
    >
      <div className="space-y-5 p-6">
        <div
          className="
            flex flex-wrap items-start
            justify-between gap-4
          "
        >
          <div className="min-w-0 flex-1">
            <div
              className="
                mb-3 flex flex-wrap
                items-center gap-2
              "
            >
              <TaskStatusBadge
                status={task.status}
              />

              <TaskPriorityBadge
                priority={task.priority}
              />
            </div>

            <h3
              className="
                text-lg font-semibold
                text-slate-900
                dark:text-white
              "
            >
              {task.title}
            </h3>

            <p
              className="
                mt-2 whitespace-pre-wrap
                text-sm leading-6
                text-slate-600
                dark:text-slate-400
              "
            >
              {task.description}
            </p>
          </div>

          <ClipboardList
            className="text-slate-400"
            size={22}
            aria-hidden="true"
          />
        </div>

        <div
          className="
            grid gap-3 text-sm
            text-slate-500
            dark:text-slate-400
            sm:grid-cols-2
          "
        >
          <div className="flex items-center gap-2">
            <CalendarClock
              size={16}
              aria-hidden="true"
            />

            <span>
              Created:{" "}
              {formatTaskDate(
                task.createdAt
              )}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Users
              size={16}
              aria-hidden="true"
            />

            <span>
              {activeAssignments.length}
              {" "}
              active assignment
              {activeAssignments.length === 1
                ? ""
                : "s"}
            </span>
          </div>
        </div>

        {showAssignments && (
          <div
            className="
              space-y-3 border-t
              border-slate-200 pt-4
              dark:border-slate-800
            "
          >
            <h4
              className="
                text-sm font-semibold
                text-slate-900
                dark:text-white
              "
            >
              Task Assignments
            </h4>

            {assignments.length === 0 ? (
              <p
                className="
                  text-sm text-slate-500
                "
              >
                No assignments recorded.
              </p>
            ) : (
              <div className="space-y-2">
                {assignments.map(
                  (assignment) => {
                    const released =
                      assignment
                        .responsibilityStatus ===
                        "released" ||
                      assignment.releasedAt != null;

                    return (
                      <div
                        key={assignment.id}
                        className="
                          rounded-xl
                          bg-slate-50 p-3
                          text-sm
                          dark:bg-slate-900
                        "
                      >
                        <p
                          className="
                            break-all
                            font-medium
                            text-slate-900
                            dark:text-white
                          "
                        >
                          Technician:{" "}
                          {assignment.technicianId}
                        </p>

                        <div
                          className="
                            mt-2 flex flex-wrap
                            gap-x-4 gap-y-1
                            text-xs text-slate-500
                            dark:text-slate-400
                          "
                        >
                          <span>
                            Responsibility:{" "}
                            {assignment.responsibility}
                          </span>

                          <span>
                            Acceptance:{" "}
                            {
                              TASK_ACCEPTANCE_LABELS[
                                assignment
                                  .acceptanceStatus
                              ]
                            }
                          </span>

                          <span>
                            Status:{" "}
                            {
                              TASK_RESPONSIBILITY_LABELS[
                                released
                                  ? "released"
                                  : "active"
                              ]
                            }
                          </span>
                        </div>
                      </div>
                    );
                  }
                )}
              </div>
            )}
          </div>
        )}

        {children && (
          <div
            className="
              border-t border-slate-200
              pt-4 dark:border-slate-800
            "
          >
            {children}
          </div>
        )}
      </div>
    </article>
  );
}