
"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

import {
  getTasks,
  completeOperationalTask,
  returnOperationalTask,
  TaskApiError,
} from "@/lib/tasks/task-api";

import type {
  TaskListItem,
} from "@/lib/tasks/task-api-types";

import { TaskCard } from "./task-card";

import { TaskAssignmentForm } from "./task-assignment-form";

import { TaskCreationForm } from "./task-creation-form";

export function SupervisorTaskWorkspace() {
  /*
   * Task creation form visibility.
   *
   * The form is initially hidden.
   * The supervisor must explicitly
   * open it before creating a task.
   */

  const [
    showCreateTaskForm,
    setShowCreateTaskForm,
  ] = useState(false);

  /*
   * Authoritative task retrieval state.
   */

  const [tasks, setTasks] =
    useState<TaskListItem[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [refreshing, setRefreshing] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  /*
   * Supervisor completion state.
   */

  const [
    completingTaskId,
    setCompletingTaskId,
  ] = useState<string | null>(null);

  const [
    completionMessage,
    setCompletionMessage,
  ] = useState<string | null>(null);

  const [
    completionError,
    setCompletionError,
  ] = useState<string | null>(null);

  /*
   * Supervisor return state.
   */

  const [
    returningTaskId,
    setReturningTaskId,
  ] = useState<string | null>(null);

  const [
    returnFormTaskId,
    setReturnFormTaskId,
  ] = useState<string | null>(null);

  const [
    returnReason,
    setReturnReason,
  ] = useState("");

  const [
    returnMessage,
    setReturnMessage,
  ] = useState<string | null>(null);

  const [
    returnError,
    setReturnError,
  ] = useState<string | null>(null);

  /*
   * Prevent concurrent lifecycle requests.
   */

  const lifecycleInProgress =
    useRef(false);

  /*
   * Prevent overlapping task retrievals.
   */

  const retrievalInProgress =
    useRef(false);

  /*
   * Retrieve authoritative task data.
   *
   * Clear previously loaded tasks if
   * retrieval fails.
   *
   * This prevents stale operational
   * information from remaining visible
   * after an authorization change.
   */

  const loadTasks = useCallback(
    async (
      refresh = false,
    ): Promise<boolean> => {
      if (
        retrievalInProgress.current
      ) {
        return false;
      }

      retrievalInProgress.current =
        true;

      if (refresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError(null);

      try {
        const result =
          await getTasks();

        setTasks(result.tasks);

        return true;
      } catch (caughtError) {
        setTasks([]);

        if (
          caughtError instanceof
          TaskApiError
        ) {
          setError(
            caughtError.message,
          );
        } else {
          setError(
            "Unable to retrieve operational tasks.",
          );
        }

        return false;
      } finally {
        retrievalInProgress.current =
          false;

        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  /*
   * Initial authoritative retrieval.
   */

  useEffect(() => {
    let active = true;

    async function loadInitialTasks() {
      if (retrievalInProgress.current) {
        return;
      }

      retrievalInProgress.current = true;

      try {
        const result = await getTasks();

        if (!active) {
          return;
        }

        setTasks(result.tasks);
      } catch (caughtError) {
        if (!active) {
          return;
        }

        setTasks([]);

        if (caughtError instanceof TaskApiError) {
          setError(caughtError.message);
        } else {
          setError(
            "Unable to retrieve operational tasks.",
          );
        }
      } finally {
        retrievalInProgress.current = false;

        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    void loadInitialTasks();

    return () => {
      active = false;
    };
  }, []);

  /*
   * Complete a task after verification.
   *
   * The authoritative backend
   * independently validates:
   *
   * - Authenticated actor identity
   * - Account eligibility
   * - Supervisor authority
   * - Task lifecycle status
   * - Assignment integrity
   * - Operational restrictions
   *
   * Permanent account revocation
   * remains disabled.
   */

  const handleCompleteTask =
    useCallback(
      async (
        taskId: string,
      ) => {
        if (
          lifecycleInProgress.current ||
          retrievalInProgress.current
        ) {
          return;
        }

        /*
         * Require explicit confirmation.
         */

        const confirmed =
          window.confirm(
            "Complete this task?\n\n" +
              "Confirm that you have verified the technician's submitted work.\n\n" +
              "The task will be marked as completed and no further task lifecycle actions will be available.",
          );

        if (!confirmed) {
          return;
        }

        lifecycleInProgress.current =
          true;

        setCompletingTaskId(taskId);

        setCompletionMessage(null);
        setCompletionError(null);

        setReturnMessage(null);
        setReturnError(null);

        try {
          /*
           * Execute the authoritative
           * completion transition.
           */

          await completeOperationalTask(
            taskId,
          );

          /*
           * Retrieve updated task data.
           */

          const refreshed =
            await loadTasks(true);

          if (refreshed) {
            setCompletionMessage(
              "Task completed successfully.",
            );
          } else {
            setCompletionMessage(
              "The completion request succeeded. Refresh the task list to verify its updated state.",
            );
          }
        } catch (caughtError) {
          setCompletionError(
            caughtError instanceof Error
              ? caughtError.message
              : "The task could not be completed.",
          );

          /*
           * Refresh after a conflict
           * or authorization failure.
           */

          await loadTasks(true);
        } finally {
          lifecycleInProgress.current =
            false;

          setCompletingTaskId(null);
        }
      },
      [loadTasks],
    );

  /*
   * Open the Return Task form.
   *
   * Opening the form does not
   * perform a lifecycle transition.
   */

  const handleOpenReturnForm =
    useCallback(
      (
        taskId: string,
      ) => {
        if (
          lifecycleInProgress.current ||
          retrievalInProgress.current
        ) {
          return;
        }

        setReturnFormTaskId(taskId);

        setReturnReason("");

        setReturnError(null);
        setReturnMessage(null);

        setCompletionError(null);
        setCompletionMessage(null);
      },
      [],
    );

  /*
   * Close the Return Task form.
   */

  const handleCancelReturn =
    useCallback(() => {
      if (
        lifecycleInProgress.current
      ) {
        return;
      }

      setReturnFormTaskId(null);

      setReturnReason("");

      setReturnError(null);
    }, []);

  /*
   * Return a submitted task
   * to the technician.
   *
   * The frontend supplies only:
   *
   * - Task identifier
   * - Return reason
   *
   * The backend determines the
   * acting user from the session.
   *
   * Account eligibility and
   * authorization remain enforced
   * by the authoritative service.
   *
   * Permanent account revocation
   * remains disabled.
   */

  const handleReturnTask =
    useCallback(
      async (
        taskId: string,
      ) => {
        if (
          lifecycleInProgress.current ||
          retrievalInProgress.current
        ) {
          return;
        }

        /*
         * Validate the selected form.
         */

        if (
          returnFormTaskId !== taskId
        ) {
          return;
        }

        /*
         * Validate the return reason.
         */

        const cleanReason =
          returnReason.trim();

        if (
          cleanReason.length < 10
        ) {
          setReturnError(
            "Please provide a return reason of at least 10 characters.",
          );

          return;
        }

        if (
          cleanReason.length > 1000
        ) {
          setReturnError(
            "The return reason cannot exceed 1000 characters.",
          );

          return;
        }

        /*
         * Require explicit confirmation.
         */

        const confirmed =
          window.confirm(
            "Return this task to the technician?\n\n" +
              "The task will move from Pending Verification back to In Progress.\n\n" +
              "Return reason:\n" +
              cleanReason,
          );

        if (!confirmed) {
          return;
        }

        /*
         * Prevent duplicate lifecycle
         * requests.
         */

        lifecycleInProgress.current =
          true;

        setReturningTaskId(taskId);

        setReturnError(null);
        setReturnMessage(null);

        setCompletionError(null);
        setCompletionMessage(null);

        try {
          /*
           * Execute the authoritative
           * return transition.
           */

          await returnOperationalTask(
            taskId,
            cleanReason,
          );

          /*
           * Clear the completed form.
           */

          setReturnFormTaskId(null);

          setReturnReason("");

          /*
           * Retrieve the authoritative
           * updated task state.
           */

          const refreshed =
            await loadTasks(true);

          if (refreshed) {
            setReturnMessage(
              "Task returned successfully. The technician can continue working and submit the task again.",
            );
          } else {
            setReturnMessage(
              "The return request succeeded. Refresh the task list to verify its updated state.",
            );
          }
        } catch (caughtError) {
          setReturnError(
            caughtError instanceof Error
              ? caughtError.message
              : "The task could not be returned.",
          );

          /*
           * Refresh after an operational
           * conflict or authorization
           * failure.
           *
           * The form is closed because
           * its previous task state may
           * no longer be authoritative.
           */

          setReturnFormTaskId(null);

          setReturnReason("");

          await loadTasks(true);
        } finally {
          lifecycleInProgress.current =
            false;

          setReturningTaskId(null);
        }
      },
      [
        loadTasks,
        returnFormTaskId,
        returnReason,
      ],
    );

  /*
   * Refresh the workspace.
   */

  const handleRefresh =
    useCallback(() => {
      if (
        lifecycleInProgress.current ||
        retrievalInProgress.current
      ) {
        return;
      }

      setCompletionMessage(null);
      setCompletionError(null);

      setReturnMessage(null);
      setReturnError(null);

      setReturnFormTaskId(null);

      setReturnReason("");

      void loadTasks(true);
    }, [loadTasks]);

  /*
   * Shared action availability.
   */

  const actionBusy =
    completingTaskId !== null ||
    returningTaskId !== null ||
    refreshing ||
    loading;

  /*
   * Loading state.
   */

  if (loading) {
    return (
      <div
        role="status"
        className="
          flex min-h-64
          items-center justify-center
          rounded-2xl
          border border-slate-200
          bg-white
          dark:border-slate-800
          dark:bg-slate-950
        "
      >
        <div className="text-center">
          <Loader2
            className="
              mx-auto mb-4
              animate-spin
              text-blue-600
            "
            size={32}
            aria-hidden="true"
          />

          <p
            className="
              text-sm text-slate-500
              dark:text-slate-400
            "
          >
            Loading operational tasks...
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-6">
      {/* Workspace header */}

      <div
        className="
          flex flex-wrap
          items-center justify-between
          gap-4
        "
      >
        <div>
          <h2
            className="
              text-xl font-semibold
              text-slate-900
              dark:text-white
            "
          >
            Operational Tasks
          </h2>

          <p
            className="
              mt-1 text-sm
              text-slate-500
              dark:text-slate-400
            "
          >
            View operational tasks,
            manage assignments,
            and verify submitted work.
          </p>
        </div>

        {/*
         * Workspace actions.
         *
         * Task creation and retrieval
         * remain separate operations.
         */}

        <div
          className="
            flex flex-wrap
            items-center gap-3
          "
        >
          {/* Create Task button */}

          <button
            type="button"
            onClick={() => {
              setShowCreateTaskForm(
                (current) => !current,
              );
            }}
            disabled={actionBusy}
            aria-expanded={
              showCreateTaskForm
            }
            aria-controls="supervisor-task-creation"
            className="
              inline-flex items-center
              justify-center
              rounded-xl
              bg-blue-600
              px-5 py-2
              text-sm font-semibold
              text-white
              transition-colors
              hover:bg-blue-700
              disabled:cursor-not-allowed
              disabled:opacity-50
            "
          >
            {showCreateTaskForm
              ? "Close Task Form"
              : "Create Task"}
          </button>

          {/* Refresh Tasks button */}

          <button
            type="button"
            onClick={handleRefresh}
            disabled={actionBusy}
            className="
              inline-flex items-center
              gap-2 rounded-xl
              border border-slate-200
              px-4 py-2 text-sm
              font-medium
              text-slate-700
              transition-colors
              hover:bg-slate-100
              disabled:cursor-not-allowed
              disabled:opacity-50
              dark:border-slate-700
              dark:text-slate-200
              dark:hover:bg-slate-800
            "
          >
            <RefreshCw
              size={16}
              className={
                refreshing
                  ? "animate-spin"
                  : ""
              }
              aria-hidden="true"
            />

            {refreshing
              ? "Refreshing..."
              : "Refresh Tasks"}
          </button>
        </div>
      </div>

      {/*
       * Supervisor task creation.
       *
       * TaskCreationForm performs
       * the authorized creation request.
       *
       * The workspace refreshes its
       * authoritative task list after
       * a successful creation.
       *
       * Existing task lifecycle
       * controls remain unchanged.
       */}

      {showCreateTaskForm && (
        <div
          id="supervisor-task-creation"
        >
          <TaskCreationForm
            onCreated={async () => {
              /*
               * Retrieve authoritative
               * task data after creation.
               */

              const refreshed =
                await loadTasks(true);

              if (!refreshed) {
                throw new Error(
                  "The task list could not be refreshed.",
                );
              }
            }}
            onCancel={() => {
              setShowCreateTaskForm(
                false,
              );
            }}
          />
        </div>
      )}

      {/* Retrieval errors */}

      {error && (
        <div
          role="alert"
          className="
            flex items-start gap-3
            rounded-xl
            border border-red-200
            bg-red-50 p-4
            text-sm text-red-700
            dark:border-red-900
            dark:bg-red-950
            dark:text-red-300
          "
        >
          <AlertCircle
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <div>
            <p className="font-semibold">
              Task retrieval failed
            </p>

            <p className="mt-1">
              {error}
            </p>
          </div>
        </div>
      )}

      {/* Completion success */}

      {completionMessage && (
        <div
          role="status"
          className="
            flex items-start gap-3
            rounded-xl
            border border-green-200
            bg-green-50 p-4
            text-sm text-green-700
            dark:border-green-900
            dark:bg-green-950
            dark:text-green-300
          "
        >
          <CheckCircle2
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>
            {completionMessage}
          </p>
        </div>
      )}

      {/* Completion errors */}

      {completionError && (
        <div
          role="alert"
          className="
            flex items-start gap-3
            rounded-xl
            border border-red-200
            bg-red-50 p-4
            text-sm text-red-700
            dark:border-red-900
            dark:bg-red-950
            dark:text-red-300
          "
        >
          <AlertCircle
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>
            {completionError}
          </p>
        </div>
      )}

      {/* Return success */}

      {returnMessage && (
        <div
          role="status"
          className="
            flex items-start gap-3
            rounded-xl
            border border-green-200
            bg-green-50 p-4
            text-sm text-green-700
            dark:border-green-900
            dark:bg-green-950
            dark:text-green-300
          "
        >
          <CheckCircle2
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>
            {returnMessage}
          </p>
        </div>
      )}

      {/* Return errors */}

      {returnError && (
        <div
          role="alert"
          className="
            flex items-start gap-3
            rounded-xl
            border border-red-200
            bg-red-50 p-4
            text-sm text-red-700
            dark:border-red-900
            dark:bg-red-950
            dark:text-red-300
          "
        >
          <AlertCircle
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>
            {returnError}
          </p>
        </div>
      )}

      {/* Task summary */}

      {!error && (
        <div
          className="
            flex items-center gap-4
            rounded-2xl
            border border-slate-200
            bg-white p-5
            dark:border-slate-800
            dark:bg-slate-950
          "
        >
          <div
            className="
              rounded-xl
              bg-blue-100 p-3
              text-blue-700
              dark:bg-blue-950
              dark:text-blue-300
            "
          >
            <ClipboardList
              size={24}
              aria-hidden="true"
            />
          </div>

          <div>
            <p
              className="
                text-sm text-slate-500
                dark:text-slate-400
              "
            >
              Total Operational Tasks
            </p>

            <p
              className="
                text-2xl font-bold
                text-slate-900
                dark:text-white
              "
            >
              {tasks.length}
            </p>
          </div>
        </div>
      )}

      {/* Empty state */}

      {!error &&
        tasks.length === 0 && (
          <div
            className="
              rounded-2xl
              border border-dashed
              border-slate-300
              bg-white p-12
              text-center
              dark:border-slate-700
              dark:bg-slate-950
            "
          >
            <ClipboardList
              className="
                mx-auto mb-4
                text-slate-400
              "
              size={40}
              aria-hidden="true"
            />

            <h3
              className="
                font-semibold
                text-slate-900
                dark:text-white
              "
            >
              No operational tasks
            </h3>

            <p
              className="
                mt-2 text-sm
                text-slate-500
                dark:text-slate-400
              "
            >
              No tasks are currently
              available for this workspace.
            </p>
          </div>
        )}

      {/* Task cards */}

      {!error &&
        tasks.length > 0 && (
          <div
            className="
              grid gap-5
              xl:grid-cols-2
            "
          >
            {tasks.map((item) => {
              const task =
                item.task;

              /*
               * Supervisor verification
               * actions are available
               * only while a task awaits
               * verification.
               *
               * The backend independently
               * validates authorization
               * and lifecycle eligibility.
               */

              const canVerify =
                task.status ===
                "pending_verification";

              const returnFormOpen =
                returnFormTaskId ===
                task.id;

              return (
                <TaskCard
                  key={task.id}
                  item={item}
                  showAssignments
                >
                  <div className="space-y-4">
                    {/* Existing assignment form */}

                    <TaskAssignmentForm
                      item={item}
                      onAssignmentCreated={async () => {
                        await loadTasks(
                          true,
                        );
                      }}
                    />

                    {/* Supervisor verification */}

                    {canVerify && (
                      <div
                        className="
                          space-y-4
                          border-t
                          border-slate-200
                          pt-4
                          dark:border-slate-800
                        "
                      >
                        <div>
                          <p
                            className="
                              text-sm
                              font-semibold
                              text-slate-900
                              dark:text-white
                            "
                          >
                            Supervisor Verification
                          </p>

                          <p
                            className="
                              mt-1
                              text-sm
                              text-slate-500
                              dark:text-slate-400
                            "
                          >
                            Review the submitted
                            work before completing
                            or returning this task.
                          </p>
                        </div>

                        {/* Complete Task */}

                        <button
                          type="button"
                          onClick={() =>
                            void handleCompleteTask(
                              task.id,
                            )
                          }
                          disabled={
                            actionBusy ||
                            returnFormTaskId !==
                              null
                          }
                          className="
                            inline-flex w-full
                            items-center
                            justify-center
                            gap-2
                            rounded-xl
                            bg-green-600
                            px-4 py-3
                            text-sm
                            font-semibold
                            text-white
                            transition-colors
                            hover:bg-green-700
                            disabled:cursor-not-allowed
                            disabled:opacity-50
                          "
                        >
                          {completingTaskId ===
                          task.id ? (
                            <>
                              <Loader2
                                size={18}
                                className="animate-spin"
                                aria-hidden="true"
                              />

                              Completing Task...
                            </>
                          ) : (
                            <>
                              <CheckCircle2
                                size={18}
                                aria-hidden="true"
                              />

                              Complete Task
                            </>
                          )}
                        </button>

                        {/* Open Return Task form */}

                        {!returnFormOpen && (
                          <button
                            type="button"
                            onClick={() =>
                              handleOpenReturnForm(
                                task.id,
                              )
                            }
                            disabled={
                              actionBusy ||
                              returnFormTaskId !==
                                null
                            }
                            className="
                              inline-flex w-full
                              items-center
                              justify-center
                              gap-2
                              rounded-xl
                              border
                              border-amber-300
                              bg-amber-50
                              px-4 py-3
                              text-sm
                              font-semibold
                              text-amber-800
                              transition-colors
                              hover:bg-amber-100
                              disabled:cursor-not-allowed
                              disabled:opacity-50
                              dark:border-amber-900
                              dark:bg-amber-950
                              dark:text-amber-300
                            "
                          >
                            <RotateCcw
                              size={18}
                              aria-hidden="true"
                            />

                            Return Task
                          </button>
                        )}

                        {/* Return Task form */}

                        {returnFormOpen && (
                          <div
                            className="
                              space-y-4
                              rounded-xl
                              border
                              border-amber-200
                              bg-amber-50
                              p-4
                              dark:border-amber-900
                              dark:bg-amber-950
                            "
                          >
                            <div>
                              <p
                                className="
                                  text-sm
                                  font-semibold
                                  text-amber-900
                                  dark:text-amber-200
                                "
                              >
                                Return Task for Corrections
                              </p>

                              <p
                                className="
                                  mt-1
                                  text-sm
                                  text-amber-800
                                  dark:text-amber-300
                                "
                              >
                                Explain what the
                                technician must
                                correct before
                                resubmitting
                                this task.
                              </p>
                            </div>

                            <div className="space-y-2">
                              <label
                                htmlFor={`return-reason-${task.id}`}
                                className="
                                  block
                                  text-sm
                                  font-medium
                                  text-slate-900
                                  dark:text-white
                                "
                              >
                                Return Reason
                              </label>

                              <textarea
                                id={`return-reason-${task.id}`}
                                value={
                                  returnReason
                                }
                                onChange={(
                                  event,
                                ) => {
                                  setReturnReason(
                                    event.target.value,
                                  );

                                  setReturnError(
                                    null,
                                  );
                                }}
                                maxLength={
                                  1000
                                }
                                rows={4}
                                disabled={
                                  actionBusy
                                }
                                placeholder="Describe the corrections required..."
                                className="
                                  w-full
                                  rounded-xl
                                  border
                                  border-slate-300
                                  bg-white
                                  px-4 py-3
                                  text-sm
                                  text-slate-900
                                  outline-none
                                  focus:border-blue-500
                                  focus:ring-2
                                  focus:ring-blue-500/20
                                  disabled:cursor-not-allowed
                                  disabled:opacity-50
                                  dark:border-slate-700
                                  dark:bg-slate-900
                                  dark:text-white
                                "
                              />

                              <p
                                className="
                                  text-xs
                                  text-slate-500
                                  dark:text-slate-400
                                "
                              >
                                Minimum 10
                                characters.
                                Maximum 1,000
                                characters.{" "}
                                {
                                  returnReason.trim()
                                    .length
                                }
                                /1000
                              </p>
                            </div>

                            <div
                              className="
                                flex flex-wrap
                                gap-3
                              "
                            >
                              <button
                                type="button"
                                onClick={
                                  handleCancelReturn
                                }
                                disabled={
                                  actionBusy
                                }
                                className="
                                  flex-1
                                  rounded-xl
                                  border
                                  border-slate-300
                                  bg-white
                                  px-4 py-3
                                  text-sm
                                  font-semibold
                                  text-slate-700
                                  hover:bg-slate-100
                                  disabled:cursor-not-allowed
                                  disabled:opacity-50
                                  dark:border-slate-700
                                  dark:bg-slate-900
                                  dark:text-slate-200
                                "
                              >
                                Cancel
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  void handleReturnTask(
                                    task.id,
                                  )
                                }
                                disabled={
                                  actionBusy ||
                                  returnReason.trim()
                                    .length <
                                    10 ||
                                  returnReason.trim()
                                    .length >
                                    1000
                                }
                                className="
                                  inline-flex
                                  flex-1
                                  items-center
                                  justify-center
                                  gap-2
                                  rounded-xl
                                  bg-amber-600
                                  px-4 py-3
                                  text-sm
                                  font-semibold
                                  text-white
                                  hover:bg-amber-700
                                  disabled:cursor-not-allowed
                                  disabled:opacity-50
                                "
                              >
                                {returningTaskId ===
                                task.id ? (
                                  <>
                                    <Loader2
                                      size={18}
                                      className="animate-spin"
                                      aria-hidden="true"
                                    />

                                    Returning...
                                  </>
                                ) : (
                                  <>
                                    <RotateCcw
                                      size={18}
                                      aria-hidden="true"
                                    />

                                    Confirm Return
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Completed task information */}

                    {task.status ===
                      "completed" && (
                      <div
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
                        <div
                          className="
                            flex items-center
                            gap-2
                          "
                        >
                          <CheckCircle2
                            size={18}
                            aria-hidden="true"
                          />

                          <p className="font-semibold">
                            Task Completed
                          </p>
                        </div>

                        <p className="mt-2">
                          This task has been
                          completed and verified.
                          No further task
                          lifecycle actions
                          are available.
                        </p>
                      </div>
                    )}
                  </div>
                </TaskCard>
              );
            })}
          </div>
        )}
    </section>
  );
}