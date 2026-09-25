"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  UserPlus,
} from "lucide-react";

import {
  assignOperationalTask,
  getEligibleTechnicians,
  TaskApiError,
  type EligibleTechnician,
} from "@/lib/tasks/task-api";

import type {
  TaskListItem,
} from "@/lib/tasks/task-api-types";

interface TaskAssignmentFormProps {
  item: TaskListItem;

  onAssignmentCreated: () => Promise<void>;
}

export function TaskAssignmentForm({
  item,
  onAssignmentCreated,
}: TaskAssignmentFormProps) {
  const [technicians, setTechnicians] =
    useState<EligibleTechnician[]>([]);

  const [technicianUid, setTechnicianUid] =
    useState("");

  const [responsibility, setResponsibility] =
    useState<"lead" | "support">("lead");

  const [loading, setLoading] =
    useState(true);

  const [submitting, setSubmitting] =
    useState(false);

  const submittingRef = useRef(false);

  const [error, setError] =
    useState<string | null>(null);

  const [success, setSuccess] =
    useState<string | null>(null);

  const task = item.task;

  const taskClosed =
    task.status === "completed" ||
    task.status === "cancelled";

  /*
   * Retrieve eligible technicians.
   */

  useEffect(() => {
    let active = true;

    async function loadTechnicians() {
      setLoading(true);
      setError(null);
      setTechnicians([]);

      try {
        const result =
          await getEligibleTechnicians();

        if (!active) {
          return;
        }

        setTechnicians(
          result.technicians
        );
      } catch (caughtError) {
        if (!active) {
          return;
        }

        setError(
          caughtError instanceof TaskApiError
            ? caughtError.message
            : "Unable to retrieve eligible technicians."
        );
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadTechnicians();

    return () => {
      active = false;
    };
  }, []);

  /*
   * Submit assignment.
   */

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (
      submittingRef.current ||
      taskClosed ||
      !technicianUid
    ) {
      return;
    }

    const selectedTechnician =
      technicians.find(
        (technician) =>
          technician.uid === technicianUid
      );

    if (!selectedTechnician) {
      setError(
        "Please select an eligible technician."
      );

      return;
    }

    /*
     * Client-side duplicate prevention.
     *
     * The authoritative backend remains
     * responsible for enforcing assignment
     * uniqueness.
     */

    const alreadyAssigned =
      item.assignments.some(
        (assignment) =>
          assignment.technicianId ===
          technicianUid
      );

    if (alreadyAssigned) {
      setError(
        "This technician already has an assignment record for this task."
      );

      return;
    }

    submittingRef.current = true;

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      await assignOperationalTask(
        task.id,
        {
          technicianUid,
          responsibility,
        }
      );

      setSuccess(
        `Task successfully assigned to ${selectedTechnician.fullName}.`
      );

      setTechnicianUid("");
      setResponsibility("lead");

      await onAssignmentCreated();
    } catch (caughtError) {
      setError(
        caughtError instanceof TaskApiError
          ? caughtError.message
          : "Unable to assign the selected technician."
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (taskClosed) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <UserPlus
          size={18}
          className="text-blue-600"
          aria-hidden="true"
        />

        <h4 className="text-sm font-semibold text-slate-900 dark:text-white">
          Assign Technician
        </h4>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <AlertCircle
            size={18}
            className="shrink-0"
            aria-hidden="true"
          />

          <span>{error}</span>
        </div>
      )}

      {success && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
        >
          <CheckCircle2
            size={18}
            className="shrink-0"
            aria-hidden="true"
          />

          <span>{success}</span>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <div className="space-y-2">
          <label
            htmlFor={`technician-${task.id}`}
            className="block text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            Technician
          </label>

          <select
            id={`technician-${task.id}`}
            value={technicianUid}
            onChange={(event) => {
              setTechnicianUid(
                event.target.value
              );

              setError(null);
              setSuccess(null);
            }}
            disabled={
              loading ||
              submitting ||
              technicians.length === 0
            }
            required
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          >
            <option value="">
              {loading
                ? "Loading technicians..."
                : "Select a technician"}
            </option>

            {technicians.map(
              (technician) => {
                const alreadyAssigned =
                  item.assignments.some(
                    (assignment) =>
                      assignment.technicianId ===
                      technician.uid
                  );

                return (
                  <option
                    key={technician.uid}
                    value={technician.uid}
                    disabled={alreadyAssigned}
                  >
                    {technician.fullName}
                    {alreadyAssigned
                      ? " — Already assigned"
                      : ""}
                  </option>
                );
              }
            )}
          </select>
        </div>

        <div className="space-y-2">
          <label
            htmlFor={`responsibility-${task.id}`}
            className="block text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            Responsibility
          </label>

          <select
            id={`responsibility-${task.id}`}
            value={responsibility}
            onChange={(event) => {
              setResponsibility(
                event.target.value as
                  | "lead"
                  | "support"
              );
            }}
            disabled={submitting}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
          >
            <option value="lead">
              Lead Technician
            </option>

            <option value="support">
              Support Technician
            </option>
          </select>
        </div>

        <button
          type="submit"
          disabled={
            loading ||
            submitting ||
            !technicianUid
          }
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <>
              <Loader2
                size={16}
                className="animate-spin"
                aria-hidden="true"
              />

              Assigning Technician...
            </>
          ) : (
            <>
              <UserPlus
                size={16}
                aria-hidden="true"
              />

              Assign Technician
            </>
          )}
        </button>
      </form>
    </div>
  );
}