
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  getTasks,
  acceptOperationalTaskAssignment,
  startOperationalTask,
  submitOperationalTask,
} from "@/lib/tasks/task-api";

import type {
  TaskListResult,
} from "@/lib/tasks/task-api-types";

type TaskItem =
  TaskListResult["tasks"][number];

type TaskFilter =
  | "all"
  | "pending"
  | "active"
  | "completed";

const FILTERS: {
  value: TaskFilter;
  label: string;
}[] = [
  {
    value: "all",
    label: "All Tasks",
  },
  {
    value: "pending",
    label: "Pending",
  },
  {
    value: "active",
    label: "Active",
  },
  {
    value: "completed",
    label: "Completed",
  },
];

/*
 * Format task and assignment statuses.
 */

function formatStatus(
  value: string
): string {
  return value
    .replace(/_/g, " ")
    .replace(
      /\b\w/g,
      (letter) => letter.toUpperCase()
    );
}

/*
 * Format authoritative date values.
 */

function formatDate(
  value: unknown
): string {
  if (typeof value !== "string") {
    return "Not available";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return date.toLocaleString();
}

/*
 * Retrieve the technician's
 * non-released assignment.
 *
 * The backend determines which
 * assignments are visible to
 * the authenticated technician.
 */

function getAssignment(
  item: TaskItem
) {
  return item.assignments.find(
    (assignment) =>
      assignment.responsibilityStatus !==
        "released" &&
      assignment.releasedAt == null
  );
}

/*
 * Task filtering.
 */

function matchesFilter(
  item: TaskItem,
  filter: TaskFilter
): boolean {
  if (filter === "all") {
    return true;
  }

  const status =
    item.task.status;

  const assignment =
    getAssignment(item);

  if (filter === "pending") {
    return (
      assignment?.acceptanceStatus ===
        "pending" &&
      status !== "completed" &&
      status !== "cancelled"
    );
  }

  if (filter === "active") {
    return [
      "open",
      "in_progress",
      "pending_verification",
    ].includes(status);
  }

  return status === "completed";
}

/*
 * Technician Task Workspace.
 */

export default function TechnicianTaskWorkspace() {
  /*
   * Authoritative task data.
   */

  const [
    tasks,
    setTasks,
  ] = useState<TaskItem[]>([]);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    refreshing,
    setRefreshing,
  ] = useState(false);

  const [
    error,
    setError,
  ] = useState<string | null>(null);

  const [
    filter,
    setFilter,
  ] = useState<TaskFilter>("all");

  /*
   * Assignment acceptance state.
   */

  const [
    acceptingAssignmentId,
    setAcceptingAssignmentId,
  ] = useState<string | null>(null);

  const [
    acceptanceMessage,
    setAcceptanceMessage,
  ] = useState<string | null>(null);

  const [
    acceptanceError,
    setAcceptanceError,
  ] = useState<string | null>(null);

  /*
   * Task-start state.
   */

  const [
    startingTaskId,
    setStartingTaskId,
  ] = useState<string | null>(null);

  const [
    taskStartMessage,
    setTaskStartMessage,
  ] = useState<string | null>(null);

  const [
    taskStartError,
    setTaskStartError,
  ] = useState<string | null>(null);

  /*
   * Task-submission state.
   */

  const [
    submittingTaskId,
    setSubmittingTaskId,
  ] = useState<string | null>(null);

  const [
    taskSubmissionMessage,
    setTaskSubmissionMessage,
  ] = useState<string | null>(null);

  const [
    taskSubmissionError,
    setTaskSubmissionError,
  ] = useState<string | null>(null);

  /*
   * Prevent overlapping operations.
   *
   * A single shared ref prevents
   * duplicate requests across all
   * task-action handlers.
   */

  const operationInProgress =
    useRef(false);

  const operationBusy =
    acceptingAssignmentId !== null ||
    startingTaskId !== null ||
    submittingTaskId !== null;

  /*
   * Clear operation feedback.
   */

  const clearFeedback =
    useCallback(() => {
      setAcceptanceMessage(null);
      setAcceptanceError(null);

      setTaskStartMessage(null);
      setTaskStartError(null);

      setTaskSubmissionMessage(null);
      setTaskSubmissionError(null);
    }, []);

  /*
   * Retrieve authoritative task data.
   *
   * The server independently checks:
   *
   * - Authentication
   * - Account status
   * - Password-change requirements
   * - User role
   * - Task visibility
   *
   * Permanent revocation remains
   * disabled.
   */

  const loadTasks =
    useCallback(
      async (
        showLoading = false
      ): Promise<boolean> => {
        if (showLoading) {
          setLoading(true);
        } else {
          setRefreshing(true);
        }

        setError(null);

        try {
          const result =
            await getTasks();

          setTasks(result.tasks);

          return true;
        } catch (caughtError) {
          /*
           * Do not continue displaying
           * previously retrieved task
           * data after an unsuccessful
           * authoritative retrieval.
           */

          setTasks([]);

          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Unable to retrieve tasks."
          );

          return false;
        } finally {
          setLoading(false);
          setRefreshing(false);
        }
      },
      []
    );

  /*
   * Initial task retrieval.
   */

  useEffect(() => {
    let cancelled = false;

    async function loadInitialTasks() {
      try {
        const result = await getTasks();

        if (cancelled) {
          return;
        }

        setTasks(result.tasks);
      } catch (caughtError) {
        if (cancelled) {
          return;
        }

        setTasks([]);

        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to retrieve operational tasks."
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadInitialTasks();

    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Accept a technician assignment.
   *
   * The backend independently
   * validates account eligibility,
   * assignment ownership, and
   * permitted assignment state.
   */

  const handleAcceptAssignment =
    useCallback(
      async (
        taskId: string,
        assignmentId: string
      ) => {
        if (
          operationInProgress.current
        ) {
          return;
        }

        operationInProgress.current =
          true;

        setAcceptingAssignmentId(
          assignmentId
        );

        clearFeedback();

        try {
          await acceptOperationalTaskAssignment(
            taskId,
            assignmentId
          );

          const refreshed =
            await loadTasks();

          if (refreshed) {
            setAcceptanceMessage(
              "Task assignment accepted successfully."
            );
          } else {
            setAcceptanceMessage(
              "Assignment accepted. Refresh the task list to retrieve its updated state."
            );
          }
        } catch (caughtError) {
          setAcceptanceError(
            caughtError instanceof Error
              ? caughtError.message
              : "The task assignment could not be accepted."
          );
        } finally {
          operationInProgress.current =
            false;

          setAcceptingAssignmentId(
            null
          );
        }
      },
      [
        loadTasks,
        clearFeedback,
      ]
    );

  /*
   * Start an accepted operational task.
   *
   * The backend independently validates:
   *
   * - Authenticated actor
   * - Account eligibility
   * - Assignment ownership
   * - Accepted lead responsibility
   * - Permitted lifecycle transition
   *
   * Permanent revocation remains
   * disabled.
   */

  const handleStartTask =
    useCallback(
      async (
        taskId: string
      ) => {
        if (
          operationInProgress.current
        ) {
          return;
        }

        operationInProgress.current =
          true;

        setStartingTaskId(taskId);

        clearFeedback();

        try {
          /*
           * Execute the authoritative
           * task-start transition.
           */

          await startOperationalTask(
            taskId
          );

          /*
           * Retrieve the updated
           * authoritative task state.
           */

          const refreshed =
            await loadTasks();

          if (refreshed) {
            setTaskStartMessage(
              "Task started successfully."
            );
          } else {
            setTaskStartMessage(
              "The task-start request succeeded. Refresh the task list to verify its updated state."
            );
          }
        } catch (caughtError) {
          setTaskStartError(
            caughtError instanceof Error
              ? caughtError.message
              : "The task could not be started."
          );
        } finally {
          operationInProgress.current =
            false;

          setStartingTaskId(null);
        }
      },
      [
        loadTasks,
        clearFeedback,
      ]
    );

  /*
   * Submit an in-progress task
   * for supervisor verification.
   *
   * The frontend requests the
   * transition through the existing
   * authoritative lifecycle API.
   *
   * The backend independently
   * validates account eligibility,
   * assignment ownership, accepted
   * lead responsibility, and the
   * permitted task transition.
   *
   * Permanent account revocation
   * remains disabled.
   */

  const handleSubmitTask =
    useCallback(
      async (
        taskId: string
      ) => {
        if (
          operationInProgress.current
        ) {
          return;
        }

        operationInProgress.current =
          true;

        setSubmittingTaskId(taskId);

        clearFeedback();

        try {
          /*
           * Execute the authoritative
           * task-submission transition.
           */

          await submitOperationalTask(
            taskId
          );

          /*
           * Retrieve the updated
           * authoritative task state.
           */

          const refreshed =
            await loadTasks();

          if (refreshed) {
            setTaskSubmissionMessage(
              "Task submitted for supervisor verification successfully."
            );
          } else {
            setTaskSubmissionMessage(
              "The submission request succeeded. Refresh the task list to verify its updated state."
            );
          }
        } catch (caughtError) {
          setTaskSubmissionError(
            caughtError instanceof Error
              ? caughtError.message
              : "The task could not be submitted for verification."
          );
        } finally {
          operationInProgress.current =
            false;

          setSubmittingTaskId(null);
        }
      },
      [
        loadTasks,
        clearFeedback,
      ]
    );

  /*
   * Filter authoritative task data.
   */

  const visibleTasks =
    useMemo(
      () =>
        tasks.filter(
          (item) =>
            matchesFilter(
              item,
              filter
            )
        ),
      [
        tasks,
        filter,
      ]
    );

  /*
   * Dashboard summary counts.
   */

  const pendingCount =
    tasks.filter(
      (item) =>
        matchesFilter(
          item,
          "pending"
        )
    ).length;

  const activeCount =
    tasks.filter(
      (item) =>
        matchesFilter(
          item,
          "active"
        )
    ).length;

  const completedCount =
    tasks.filter(
      (item) =>
        matchesFilter(
          item,
          "completed"
        )
    ).length;

  /*
   * Render the technician workspace.
   */

  return (
    <div className="space-y-6">
      {/* Page header */}

      <header
        className="
          flex flex-wrap
          items-center
          justify-between
          gap-4
        "
      >
        <div>
          <h1
            className="
              text-2xl
              font-bold
              text-slate-900
              dark:text-white
            "
          >
            My Tasks
          </h1>

          <p
            className="
              mt-1
              text-sm
              text-slate-500
              dark:text-slate-400
            "
          >
            View and manage your assigned
            operational tasks.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            if (
              operationInProgress.current
            ) {
              return;
            }

            clearFeedback();

            void loadTasks();
          }}
          disabled={
            loading ||
            refreshing ||
            operationBusy
          }
          className="
            rounded-xl
            bg-blue-600
            px-4 py-2
            text-sm
            font-medium
            text-white
            hover:bg-blue-700
            disabled:cursor-not-allowed
            disabled:opacity-50
          "
        >
          {refreshing
            ? "Refreshing..."
            : "Refresh Tasks"}
        </button>
      </header>

      {/* Task summary */}

      <div
        className="
          grid grid-cols-1
          gap-4
          sm:grid-cols-3
        "
      >
        {[
          {
            label:
              "Pending Acceptance",
            count:
              pendingCount,
          },
          {
            label:
              "Active Tasks",
            count:
              activeCount,
          },
          {
            label:
              "Completed Tasks",
            count:
              completedCount,
          },
        ].map(
          (summary) => (
            <div
              key={summary.label}
              className="
                rounded-2xl
                border
                border-slate-200
                bg-white
                p-5
                dark:border-slate-800
                dark:bg-slate-950
              "
            >
              <p
                className="
                  text-sm
                  text-slate-500
                "
              >
                {summary.label}
              </p>

              <p
                className="
                  mt-2
                  text-3xl
                  font-bold
                  text-slate-900
                  dark:text-white
                "
              >
                {summary.count}
              </p>
            </div>
          )
        )}
      </div>

      {/* Task filters */}

      <div
        className="
          flex flex-wrap
          gap-2
        "
      >
        {FILTERS.map(
          (option) => (
            <button
              key={option.value}
              type="button"
              onClick={() =>
                setFilter(
                  option.value
                )
              }
              aria-pressed={
                filter ===
                option.value
              }
              className={
                filter ===
                option.value
                  ? "rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white"
                  : "rounded-xl bg-slate-100 px-4 py-2 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200"
              }
            >
              {option.label}
            </button>
          )
        )}
      </div>

      {/* General retrieval errors */}

      {error && (
        <div
          role="alert"
          className="
            rounded-xl
            border
            border-red-200
            bg-red-50
            p-4
            text-sm
            text-red-700
            dark:border-red-900
            dark:bg-red-950
            dark:text-red-300
          "
        >
          {error}
        </div>
      )}

      {/* Assignment acceptance success */}

      {acceptanceMessage && (
        <div
          role="status"
          className="
            rounded-xl
            border
            border-green-200
            bg-green-50
            p-4
            text-sm
            text-green-700
            dark:border-green-900
            dark:bg-green-950
            dark:text-green-300
          "
        >
          {acceptanceMessage}
        </div>
      )}

      {/* Assignment acceptance errors */}

      {acceptanceError && (
        <div
          role="alert"
          className="
            rounded-xl
            border
            border-red-200
            bg-red-50
            p-4
            text-sm
            text-red-700
            dark:border-red-900
            dark:bg-red-950
            dark:text-red-300
          "
        >
          {acceptanceError}
        </div>
      )}

      {/* Task-start success */}

      {taskStartMessage && (
        <div
          role="status"
          className="
            rounded-xl
            border
            border-green-200
            bg-green-50
            p-4
            text-sm
            text-green-700
            dark:border-green-900
            dark:bg-green-950
            dark:text-green-300
          "
        >
          {taskStartMessage}
        </div>
      )}

      {/* Task-start errors */}

      {taskStartError && (
        <div
          role="alert"
          className="
            rounded-xl
            border
            border-red-200
            bg-red-50
            p-4
            text-sm
            text-red-700
            dark:border-red-900
            dark:bg-red-950
            dark:text-red-300
          "
        >
          {taskStartError}
        </div>
      )}

      {/* Task-submission success */}

      {taskSubmissionMessage && (
        <div
          role="status"
          className="
            rounded-xl
            border
            border-green-200
            bg-green-50
            p-4
            text-sm
            text-green-700
            dark:border-green-900
            dark:bg-green-950
            dark:text-green-300
          "
        >
          {taskSubmissionMessage}
        </div>
      )}

      {/* Task-submission errors */}

      {taskSubmissionError && (
        <div
          role="alert"
          className="
            rounded-xl
            border
            border-red-200
            bg-red-50
            p-4
            text-sm
            text-red-700
            dark:border-red-900
            dark:bg-red-950
            dark:text-red-300
          "
        >
          {taskSubmissionError}
        </div>
      )}

      {/* Task loading and empty states */}

      {loading ? (
        <div
          role="status"
          className="
            rounded-xl
            border
            border-slate-200
            p-8
            text-center
            text-slate-500
            dark:border-slate-800
          "
        >
          Loading assigned tasks...
        </div>
      ) : visibleTasks.length === 0 ? (
        <div
          className="
            rounded-xl
            border
            border-slate-200
            p-8
            text-center
            text-slate-500
            dark:border-slate-800
          "
        >
          {error
            ? "Tasks could not be loaded."
            : "No tasks found for this filter."}
        </div>
      ) : (
        <div
          className="
            grid grid-cols-1
            gap-4
            xl:grid-cols-2
          "
        >
          {visibleTasks.map(
            (item) => {
              const task =
                item.task;

              const assignment =
                getAssignment(
                  item
                );

              /*
               * Assignment acceptance
               * visibility.
               */

              const canAccept =
                assignment != null &&
                assignment.acceptanceStatus ===
                  "pending" &&
                assignment.responsibilityStatus !==
                  "released" &&
                assignment.releasedAt == null &&
                task.status !==
                  "completed" &&
                task.status !==
                  "cancelled";

              /*
               * Task-start visibility.
               *
               * Only an accepted,
               * active lead assignment
               * on an open task.
               */

              const canStart =
                assignment != null &&
                assignment.acceptanceStatus ===
                  "accepted" &&
                assignment.responsibility ===
                  "lead" &&
                assignment.responsibilityStatus ===
                  "active" &&
                assignment.releasedAt == null &&
                task.status ===
                  "open";

              /*
               * Task-submission visibility.
               *
               * Only an accepted,
               * active lead assignment
               * on an in-progress task.
               */

              const canSubmit =
                assignment != null &&
                assignment.acceptanceStatus ===
                  "accepted" &&
                assignment.responsibility ===
                  "lead" &&
                assignment.responsibilityStatus ===
                  "active" &&
                assignment.releasedAt == null &&
                task.status ===
                  "in_progress";

              return (
                <article
                  key={task.id}
                  className="
                    rounded-2xl
                    border
                    border-slate-200
                    bg-white
                    p-5
                    shadow-sm
                    dark:border-slate-800
                    dark:bg-slate-950
                  "
                >
                  {/* Task status and priority */}

                  <div
                    className="
                      flex flex-wrap
                      items-center
                      justify-between
                      gap-2
                    "
                  >
                    <span
                      className="
                        rounded-full
                        bg-blue-50
                        px-3 py-1
                        text-xs
                        font-medium
                        text-blue-700
                        dark:bg-blue-950
                        dark:text-blue-300
                      "
                    >
                      {formatStatus(
                        task.status
                      )}
                    </span>

                    <span
                      className="
                        text-xs
                        font-medium
                        text-slate-500
                      "
                    >
                      {formatStatus(
                        task.priority
                      )}{" "}
                      Priority
                    </span>
                  </div>

                  {/* Task title */}

                  <h2
                    className="
                      mt-4
                      text-lg
                      font-semibold
                      text-slate-900
                      dark:text-white
                    "
                  >
                    {task.title}
                  </h2>

                  {/* Task description */}

                  <p
                    className="
                      mt-2
                      whitespace-pre-wrap
                      text-sm
                      text-slate-600
                      dark:text-slate-400
                    "
                  >
                    {task.description}
                  </p>

                  {/* Assignment details */}

                  <div
                    className="
                      mt-4
                      space-y-2
                      border-t
                      border-slate-200
                      pt-4
                      text-sm
                      dark:border-slate-800
                    "
                  >
                    <p>
                      <strong>
                        Responsibility:
                      </strong>{" "}
                      {assignment
                        ? formatStatus(
                            assignment.responsibility
                          )
                        : "Not available"}
                    </p>

                    <p>
                      <strong>
                        Acceptance:
                      </strong>{" "}
                      {assignment
                        ? formatStatus(
                            assignment.acceptanceStatus
                          )
                        : "Not available"}
                    </p>

                    <p>
                      <strong>
                        Assigned:
                      </strong>{" "}
                      {formatDate(
                        assignment?.assignedAt
                      )}
                    </p>
                  </div>

                  {/* Assignment acceptance */}

                  {canAccept && assignment && (
                    <div
                      className="
                        mt-4
                        border-t
                        border-slate-200
                        pt-4
                        dark:border-slate-800
                      "
                    >
                      <button
                        type="button"
                        onClick={() =>
                          void handleAcceptAssignment(
                            task.id,
                            assignment.id
                          )
                        }
                        disabled={
                          operationBusy ||
                          loading ||
                          refreshing
                        }
                        className="
                          w-full
                          rounded-xl
                          bg-green-600
                          px-4
                          py-3
                          text-sm
                          font-semibold
                          text-white
                          transition-colors
                          hover:bg-green-700
                          disabled:cursor-not-allowed
                          disabled:opacity-50
                        "
                      >
                        {acceptingAssignmentId ===
                        assignment.id
                          ? "Accepting Assignment..."
                          : "Accept Assignment"}
                      </button>
                    </div>
                  )}

                  {/* Accepted assignment */}

                  {assignment?.acceptanceStatus ===
                    "accepted" &&
                    assignment.responsibilityStatus ===
                      "active" &&
                    assignment.releasedAt == null &&
                    task.status !==
                      "completed" &&
                    task.status !==
                      "cancelled" && (
                      <div
                        className="
                          mt-4
                          rounded-xl
                          border
                          border-green-200
                          bg-green-50
                          p-3
                          text-sm
                          font-medium
                          text-green-700
                          dark:border-green-900
                          dark:bg-green-950
                          dark:text-green-300
                        "
                      >
                        Assignment Accepted
                      </div>
                    )}

                  {/* Task-start action */}

                  {canStart && (
                    <div
                      className="
                        mt-4
                        border-t
                        border-slate-200
                        pt-4
                        dark:border-slate-800
                      "
                    >
                      <button
                        type="button"
                        onClick={() =>
                          void handleStartTask(
                            task.id
                          )
                        }
                        disabled={
                          operationBusy ||
                          loading ||
                          refreshing
                        }
                        className="
                          w-full
                          rounded-xl
                          bg-blue-600
                          px-4
                          py-3
                          text-sm
                          font-semibold
                          text-white
                          transition-colors
                          hover:bg-blue-700
                          disabled:cursor-not-allowed
                          disabled:opacity-50
                        "
                      >
                        {startingTaskId ===
                        task.id
                          ? "Starting Task..."
                          : "Start Task"}
                      </button>
                    </div>
                  )}

                  {/* Task-submission action */}

                  {canSubmit && (
                    <div
                      className="
                        mt-4
                        border-t
                        border-slate-200
                        pt-4
                        dark:border-slate-800
                      "
                    >
                      <button
                        type="button"
                        onClick={() =>
                          void handleSubmitTask(
                            task.id
                          )
                        }
                        disabled={
                          operationBusy ||
                          loading ||
                          refreshing
                        }
                        className="
                          w-full
                          rounded-xl
                          bg-green-600
                          px-4
                          py-3
                          text-sm
                          font-semibold
                          text-white
                          transition-colors
                          hover:bg-green-700
                          disabled:cursor-not-allowed
                          disabled:opacity-50
                        "
                      >
                        {submittingTaskId ===
                        task.id
                          ? "Submitting Task..."
                          : "Submit for Verification"}
                      </button>
                    </div>
                  )}

                  {/* Task in progress */}

                  {task.status ===
                    "in_progress" && (
                    <div
                      className="
                        mt-4
                        rounded-xl
                        border
                        border-blue-200
                        bg-blue-50
                        p-3
                        text-sm
                        font-medium
                        text-blue-700
                        dark:border-blue-900
                        dark:bg-blue-950
                        dark:text-blue-300
                      "
                    >
                      Task In Progress
                    </div>
                  )}

                  {/* Pending verification */}

                  {task.status ===
                    "pending_verification" && (
                    <div
                      className="
                        mt-4
                        rounded-xl
                        border
                        border-amber-200
                        bg-amber-50
                        p-3
                        text-sm
                        font-medium
                        text-amber-700
                        dark:border-amber-900
                        dark:bg-amber-950
                        dark:text-amber-300
                      "
                    >
                      Task submitted successfully.
                      Awaiting supervisor verification.
                    </div>
                  )}

                  {/* Completed task */}

                  {task.status ===
                    "completed" && (
                    <div
                      className="
                        mt-4
                        rounded-xl
                        border
                        border-slate-200
                        bg-slate-50
                        p-3
                        text-sm
                        text-slate-600
                        dark:border-slate-800
                        dark:bg-slate-900
                        dark:text-slate-300
                      "
                    >
                      This task has been completed.
                      No further task actions
                      are available.
                    </div>
                  )}

                  {/* Cancelled task */}

                  {task.status ===
                    "cancelled" && (
                    <div
                      className="
                        mt-4
                        rounded-xl
                        border
                        border-slate-200
                        bg-slate-50
                        p-3
                        text-sm
                        text-slate-600
                        dark:border-slate-800
                        dark:bg-slate-900
                        dark:text-slate-300
                      "
                    >
                      This task has been cancelled.
                      No further task actions
                      are available.
                    </div>
                  )}

                  {/* Task identifier */}

                  <div
                    className="
                      mt-4
                      rounded-xl
                      bg-slate-50
                      p-3
                      text-xs
                      text-slate-500
                      dark:bg-slate-900
                      dark:text-slate-400
                    "
                  >
                    Task ID:{" "}
                    <span
                      className="
                        break-all
                      "
                    >
                      {task.id}
                    </span>
                  </div>
                </article>
              );
            }
          )}
        </div>
      )}
    </div>
  );
}