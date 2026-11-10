"use client";

import {
  type FormEvent,
  useRef,
  useState,
} from "react";

import Link from "next/link";

import {
  AlertCircle,
  CalendarPlus,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Users,
} from "lucide-react";

import {
  createShift,
  ShiftApiError,
} from "@/lib/shifts/shift-api";

import type {
  TechnicianPairWithTechnicians,
} from "@/lib/technician-pairs/technician-pair-display";

import {
  TECHNICIAN_PAIR_STATUSES,
} from "@/types/technician-pair";

import {
  SHIFT_TYPES,
  type Shift,
  type ShiftType,
} from "@/types/shift";

import {
  buildScheduledWindow,
  formatSchedulingDateTime,
  getSchedulingCalendarDate,
  isValidCalendarDate,
  SCHEDULING_TIMEZONE,
} from "@/lib/scheduling/shift-schedule-policy";

interface SupervisorShiftSchedulingProps {
  pairs: TechnicianPairWithTechnicians[];
  pairsLoading: boolean;
  pairsError: string | null;
  onReloadPairs: () => void;
  onShiftCreated: (
    shift: Shift
  ) => void;
}

function formatShiftType(
  shiftType: ShiftType
): string {
  return shiftType === SHIFT_TYPES.MORNING
    ? "Morning"
    : "Night";
}

function windowStartsInFuture(
  scheduledStart: string
): boolean {
  return (
    Date.parse(scheduledStart) > Date.now()
  );
}

export function SupervisorShiftScheduling({
  pairs,
  pairsLoading,
  pairsError,
  onReloadPairs,
  onShiftCreated,
}: SupervisorShiftSchedulingProps) {
  const [pairId, setPairId] =
    useState("");

  const [shiftDate, setShiftDate] =
    useState(() =>
      getSchedulingCalendarDate()
    );

  const [today] = useState(() =>
    getSchedulingCalendarDate()
  );

  const [shiftType, setShiftType] =
    useState<ShiftType>(
      SHIFT_TYPES.MORNING
    );

  const [reviewing, setReviewing] =
    useState(false);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [submitError, setSubmitError] =
    useState<string | null>(null);

  const [submitting, setSubmitting] =
    useState(false);

  const [createdShift, setCreatedShift] =
    useState<Shift | null>(null);

  const submittingRef = useRef(false);

  const activePairs = pairs.filter(
    (pair) =>
      pair.status ===
      TECHNICIAN_PAIR_STATUSES.ACTIVE
  );

  const selectedPair =
    activePairs.find(
      (pair) => pair.id === pairId
    ) ?? null;

  const selectedPairId =
    selectedPair?.id ?? "";

  const scheduledWindow =
    isValidCalendarDate(shiftDate)
      ? buildScheduledWindow(
          shiftType,
          shiftDate
        )
      : null;

  function validateSelection():
    string | null {
    if (!selectedPair) {
      return "Select an active permanent technician pair.";
    }

    if (!isValidCalendarDate(shiftDate)) {
      return "Select a valid shift date.";
    }

    if (!scheduledWindow) {
      return "The selected shift window is invalid.";
    }

    if (
      !windowStartsInFuture(
        scheduledWindow.scheduledStart
      )
    ) {
      return "The shift must start in the future. Select a later date.";
    }

    return null;
  }

  function handleReview(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setCreatedShift(null);
    setSubmitError(null);

    const validationError =
      validateSelection();

    if (validationError) {
      setFormError(validationError);
      return;
    }

    setFormError(null);
    setReviewing(true);
  }

  function handleEdit() {
    if (submittingRef.current) return;

    setReviewing(false);
    setSubmitError(null);
  }

  async function handleConfirm() {
    if (
      submittingRef.current ||
      !selectedPair ||
      !scheduledWindow
    ) {
      return;
    }

    const validationError =
      validateSelection();

    if (validationError) {
      setReviewing(false);
      setFormError(validationError);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const shift = await createShift({
        shiftType,
        scheduledStart:
          scheduledWindow.scheduledStart,
        scheduledEnd:
          scheduledWindow.scheduledEnd,
        permanentPairId:
          selectedPair.id,
      });

      setCreatedShift(shift);
      setReviewing(false);

      onShiftCreated(shift);
    } catch (caughtError) {
      setSubmitError(
        caughtError instanceof ShiftApiError
          ? caughtError.message
          : "The shift could not be scheduled."
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-white">
            <CalendarPlus className="h-5 w-5 text-blue-600" />
            Schedule a Shift
          </h2>

          <p className="mt-1 text-sm text-[var(--muted)] dark:text-slate-400">
            Create a scheduled shift for one
            active permanent technician pair.
            The server independently validates
            the acting account, pair, technician
            eligibility, the operational slot and
            the scheduling window.
          </p>
        </div>

        <button
          type="button"
          onClick={onReloadPairs}
          disabled={pairsLoading || submitting}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-[var(--surface)] px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-[var(--elevated)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <RefreshCw
            className={
              pairsLoading
                ? "h-4 w-4 animate-spin"
                : "h-4 w-4"
            }
          />
          Reload pairs
        </button>
      </div>

      {pairsError && (
        <div
          role="alert"
          className="mt-5 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />

          <span>{pairsError}</span>
        </div>
      )}

      {createdShift && (
        <div
          role="status"
          className="mt-5 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
        >
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />

            <div className="space-y-1">
              <p className="font-semibold">
                Shift scheduled successfully.
              </p>

              <p>
                {formatShiftType(
                  createdShift.shiftType
                )}{" "}
                shift ·{" "}
                {formatSchedulingDateTime(
                  createdShift.scheduledStart
                )}{" "}
                –{" "}
                {formatSchedulingDateTime(
                  createdShift.scheduledEnd
                )}{" "}
                ({SCHEDULING_TIMEZONE})
              </p>

              <p className="break-all text-xs text-green-700 dark:text-green-400">
                Shift ID: {createdShift.id}
              </p>

              <p className="text-xs text-green-700 dark:text-green-400">
                Status: Scheduled. Activation
                remains pending until the shift
                is started through the authorised
                activation flow.
              </p>
            </div>
          </div>
        </div>
      )}

      {!reviewing ? (
        <form
          onSubmit={handleReview}
          className="mt-6 space-y-6"
        >
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <label
                htmlFor="shift-pair"
                className="block text-sm font-medium text-slate-700 dark:text-slate-200"
              >
                Permanent Technician Pair
              </label>

              <select
                id="shift-pair"
                name="permanentPairId"
                value={selectedPairId}
                onChange={(event) => {
                  setPairId(
                    event.target.value
                  );
                  setFormError(null);
                  setCreatedShift(null);
                }}
                disabled={
                  pairsLoading ||
                  activePairs.length === 0
                }
                className="mt-2 w-full rounded-xl border border-slate-300 bg-[var(--surface)] px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="">
                  {pairsLoading
                    ? "Loading technician pairs..."
                    : activePairs.length === 0
                      ? "No active technician pairs"
                      : "Select a technician pair"}
                </option>

                {activePairs.map((pair) => (
                  <option
                    key={pair.id}
                    value={pair.id}
                  >
                    {pair.technicians[0].fullName}{" "}
                    &{" "}
                    {pair.technicians[1].fullName}
                  </option>
                ))}
              </select>

              {selectedPair ? (
                <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-4 dark:border-slate-800 dark:bg-slate-900">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)] dark:text-slate-400">
                    <Users className="h-4 w-4" />
                    Assigned Technicians
                  </div>

                  <ul className="mt-2 space-y-1 text-sm text-slate-700 dark:text-slate-200">
                    {selectedPair.technicians.map(
                      (technician) => (
                        <li
                          key={technician.uid}
                        >
                          {
                            technician.fullName
                          }
                        </li>
                      )
                    )}
                  </ul>

                  <p className="mt-2 text-xs text-[var(--muted)] dark:text-slate-400">
                    Both technicians hold equal
                    authority on this shift.
                    Individual attendance is
                    recorded separately.
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-xs text-[var(--muted)] dark:text-slate-400">
                  Manage permanent pairs in{" "}
                  <Link
                    href="/supervisor/technician-pairs"
                    className="text-blue-700 underline dark:text-blue-400"
                  >
                    Technician Pair Management
                  </Link>
                  .
                </p>
              )}
            </div>

            <div className="space-y-5">
              <div>
                <label
                  htmlFor="shift-date"
                  className="block text-sm font-medium text-slate-700 dark:text-slate-200"
                >
                  Shift Date ({SCHEDULING_TIMEZONE})
                </label>

                <input
                  id="shift-date"
                  name="scheduledDate"
                  type="date"
                  value={shiftDate}
                  min={today}
                  onChange={(event) => {
                    setShiftDate(
                      event.target.value
                    );
                    setFormError(null);
                    setCreatedShift(null);
                  }}
                  disabled={submitting}
                  className="mt-2 w-full rounded-xl border border-slate-300 bg-[var(--surface)] px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>

              <fieldset>
                <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  Shift Type
                </legend>

                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      SHIFT_TYPES.MORNING,
                      SHIFT_TYPES.NIGHT,
                    ] as const
                  ).map((type) => (
                    <label
                      key={type}
                      className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                        shiftType === type
                          ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--foreground)] dark:bg-[var(--accent)]/20"
                          : "border-slate-300 bg-[var(--surface)] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      }`}
                    >
                      <input
                        type="radio"
                        name="shiftType"
                        value={type}
                        checked={
                          shiftType === type
                        }
                        onChange={() => {
                          setShiftType(type);
                          setFormError(null);
                          setCreatedShift(null);
                        }}
                        disabled={submitting}
                      />

                      {formatShiftType(type)}
                    </label>
                  ))}
                </div>

                <p className="mt-2 text-xs text-[var(--muted)] dark:text-slate-400">
                  Morning: 08:00–17:00.
                  Night: 17:00–08:00 the
                  following day.
                </p>
              </fieldset>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] dark:text-slate-400">
              Computed Window
            </p>

            {scheduledWindow ? (
              <>
                <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
                  {formatSchedulingDateTime(
                    scheduledWindow.scheduledStart
                  )}{" "}
                  –{" "}
                  {formatSchedulingDateTime(
                    scheduledWindow.scheduledEnd
                  )}{" "}
                  ({SCHEDULING_TIMEZONE})
                </p>

                <p className="mt-1 break-all text-xs text-[var(--muted)] dark:text-slate-400">
                  UTC:{" "}
                  {
                    scheduledWindow.scheduledStart
                  }{" "}
                  –{" "}
                  {
                    scheduledWindow.scheduledEnd
                  }
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-[var(--muted)] dark:text-slate-400">
                Select a valid shift date to
                compute the window.
              </p>
            )}
          </div>

          {formError && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />

              <span>{formError}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={
              pairsLoading ||
              submitting ||
              activePairs.length === 0
            }
            className="btn-accent inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
          >
            Review Shift
          </button>
        </form>
      ) : (
        <div className="mt-6 space-y-5">
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 dark:border-blue-900 dark:bg-blue-950/40">
            <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">
              Review before submission
            </p>

            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                  Technician Pair
                </dt>

                <dd className="mt-1 text-sm text-blue-950 dark:text-blue-100">
                  {selectedPair?.technicians
                    .map(
                      (technician) =>
                        technician.fullName
                    )
                    .join(" & ")}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                  Shift Type
                </dt>

                <dd className="mt-1 text-sm text-blue-950 dark:text-blue-100">
                  {formatShiftType(shiftType)}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                  Start
                </dt>

                <dd className="mt-1 text-sm text-blue-950 dark:text-blue-100">
                  {scheduledWindow
                    ? formatSchedulingDateTime(
                        scheduledWindow.scheduledStart
                      )
                    : "—"}{" "}
                  ({SCHEDULING_TIMEZONE})
                </dd>
              </div>

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                  End
                </dt>

                <dd className="mt-1 text-sm text-blue-950 dark:text-blue-100">
                  {scheduledWindow
                    ? formatSchedulingDateTime(
                        scheduledWindow.scheduledEnd
                      )
                    : "—"}{" "}
                  ({SCHEDULING_TIMEZONE})
                </dd>
              </div>
            </dl>

            <p className="mt-4 text-xs text-blue-700 dark:text-blue-300">
              Submission reserves the current
              operational shift slot. If another
              shift is already scheduled or
              active, the server rejects the
              request.
            </p>
          </div>

          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />

              <span>{submitError}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                void handleConfirm();
              }}
              disabled={submitting}
              className="btn-accent inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Scheduling Shift...
                </>
              ) : (
                "Confirm and Schedule"
              )}
            </button>

            <button
              type="button"
              onClick={handleEdit}
              disabled={submitting}
              className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-[var(--surface)] px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-[var(--elevated)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Edit Details
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
