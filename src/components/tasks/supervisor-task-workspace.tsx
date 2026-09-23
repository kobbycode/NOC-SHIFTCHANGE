"use client";

import {
  useCallback,
  useEffect,
  useState,
} from "react";

import {
  AlertCircle,
  ClipboardList,
  Loader2,
  RefreshCw,
} from "lucide-react";

import {
  getTasks,
  TaskApiError,
} from "@/lib/tasks/task-api";

import type {
  TaskListItem,
} from "@/lib/tasks/task-api-types";

import {
  TaskCard,
} from "./task-card";

export function SupervisorTaskWorkspace() {
  const [tasks, setTasks] =
    useState<TaskListItem[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState<string | null>(null);

  const [refreshing, setRefreshing] =
    useState(false);

  /*
   * Retrieve tasks through the
   * authoritative task API.
   */

  const loadTasks = useCallback(
    async (refresh = false) => {
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
      } catch (caughtError) {
        /*
         * Clear previously loaded task
         * data if retrieval fails.
         *
         * This prevents stale operational
         * information from remaining
         * visible after an authorization
         * or account-status change.
         */

        setTasks([]);

        if (
          caughtError instanceof
          TaskApiError
        ) {
          setError(
            caughtError.message
          );
        } else {
          setError(
            "Unable to retrieve operational tasks."
          );
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  /*
   * Loading state.
   */

  if (loading) {
    return (
      <div
        className="
          flex min-h-64
          items-center justify-center
          rounded-2xl
          border border-slate-200
          bg-white
          dark:border-slate-800
          dark:bg-slate-950
        "
        role="status"
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
          items-center
          justify-between
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
            assignment responsibilities,
            and current task statuses.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            void loadTasks(true);
          }}
          disabled={refreshing}
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

          Refresh Tasks
        </button>
      </div>

      {/* API error */}

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
            {tasks.map(
              (item) => (
                <TaskCard
                  key={item.task.id}
                  item={item}
                  showAssignments
                />
              )
            )}
          </div>
        )}
    </section>
  );
}