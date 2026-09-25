
"use client";

import {
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  createOperationalTask,
  TaskApiError,
} from "@/lib/tasks/task-api";

import type {
  CreateTaskInput,
} from "@/lib/tasks/task-api-types";

interface TaskCreationFormProps {
  onCreated: () => Promise<void>;
  onCancel: () => void;
}

export function TaskCreationForm({
  onCreated,
  onCancel,
}: TaskCreationFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] =
    useState("");

  const [priority, setPriority] =
    useState<CreateTaskInput["priority"]>(
      "medium",
    );

  const [submitting, setSubmitting] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const [success, setSuccess] =
    useState<string | null>(null);

  const submissionInProgress = useRef(false);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (submissionInProgress.current) {
      return;
    }

    const cleanTitle = title.trim();
    const cleanDescription =
      description.trim();

    setError(null);
    setSuccess(null);

    if (!cleanTitle) {
      setError("Please enter a task title.");
      return;
    }

    if (!cleanDescription) {
      setError(
        "Please enter a task description.",
      );
      return;
    }

    const input: CreateTaskInput = {
      title: cleanTitle,
      description: cleanDescription,
      priority,
      sectionId: null,
      shiftId: null,
    };

    submissionInProgress.current = true;
    setSubmitting(true);

    let created = false;

    try {
      const result =
        await createOperationalTask(input);

      created = true;

      setSuccess(
        `Task "${result.task.title}" created successfully.`,
      );

      setTitle("");
      setDescription("");
      setPriority("medium");

      try {
        await onCreated();
      } catch {
        setError(
          "Task created, but the task list could not be refreshed. Refresh the page before creating another task.",
        );
      }
    } catch (caughtError) {
      if (caughtError instanceof TaskApiError) {
        setError(caughtError.message);
      } else {
        setError(
          "The task creation request could not be confirmed. Refresh the task list before retrying.",
        );
      }
    } finally {
      submissionInProgress.current = false;
      setSubmitting(false);
    }

    if (created) {
      return;
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-900 dark:text-white">
          Create Operational Task
        </h2>

        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Create a task for technician assignment
          and operational tracking.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {success && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
        >
          {success}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="space-y-5"
      >
        <div>
          <label
            htmlFor="task-title"
            className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300"
          >
            Task Title
          </label>

          <input
            id="task-title"
            type="text"
            value={title}
            onChange={(event) =>
              setTitle(event.target.value)
            }
            disabled={submitting}
            required
            maxLength={200}
            placeholder="Enter task title"
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          />
        </div>

        <div>
          <label
            htmlFor="task-description"
            className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300"
          >
            Task Description
          </label>

          <textarea
            id="task-description"
            value={description}
            onChange={(event) =>
              setDescription(event.target.value)
            }
            disabled={submitting}
            required
            rows={5}
            maxLength={5000}
            placeholder="Describe the operational work required"
            className="w-full resize-y rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          />
        </div>

        <div>
          <label
            htmlFor="task-priority"
            className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300"
          >
            Priority
          </label>

          <select
            id="task-priority"
            value={priority}
            onChange={(event) =>
              setPriority(
                event.target.value as
                  CreateTaskInput["priority"],
              )
            }
            disabled={submitting}
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          >
            <option value="low">
              Low
            </option>

            <option value="medium">
              Medium
            </option>

            <option value="high">
              High
            </option>

            <option value="critical">
              Critical
            </option>
          </select>
        </div>

        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
          This task will initially be created
          without a linked shift or section.
          Technician assignment can be
          performed after task creation.
        </div>

        <div className="flex flex-wrap justify-end gap-3 border-t border-slate-200 pt-5 dark:border-slate-800">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
          >
            Cancel
          </button>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting
              ? "Creating Task..."
              : "Create Task"}
          </button>
        </div>
      </form>
    </section>
  );
}