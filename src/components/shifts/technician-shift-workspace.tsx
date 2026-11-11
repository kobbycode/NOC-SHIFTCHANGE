"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import Link from "next/link";
import {
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Loader2,
  Play,
  RefreshCw,
  UserCheck,
} from "lucide-react";

import {
  getTechnicianCurrentShift,
  joinShift,
  ShiftApiError,
  startShift,
} from "@/lib/shifts/shift-api";

import type {
  TechnicianCurrentShiftResult,
  TechnicianCurrentShiftSnapshot,
  TechnicianWriteAuthorityResult,
} from "@/lib/shifts/shift-api-types";

function formatShiftType(
  shiftType:
    TechnicianCurrentShiftResult["shiftType"],
): string {
  switch (shiftType) {
    case "morning":
      return "Morning";

    case "night":
      return "Night";

    default:
      return shiftType;
  }
}

function formatShiftStatus(
  status:
    TechnicianCurrentShiftResult["status"],
): string {
  switch (status) {
    case "scheduled":
      return "Scheduled";

    case "active":
      return "Active";

    case "handover_pending":
      return "Handover Pending";

    default:
      return status;
  }
}

function formatParticipationAuthority(
  authority:
    TechnicianCurrentShiftResult["participationAuthority"],
): string {
  switch (authority) {
    case "primary":
      return "Primary Technician";

    case "temporary_authorized":
      return "Temporary Authorized";

    default:
      return authority;
  }
}

function formatDateTime(
  value: string | null,
): string {
  if (!value) {
    return "Not recorded";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return value;
  }

  return date.toLocaleString();
}

function statusClasses(
  status:
    TechnicianCurrentShiftResult["status"],
): string {
  switch (status) {
    case "scheduled":
      return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300";

    case "active":
      return "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300";

    case "handover_pending":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300";

    default:
      return "border-[var(--border)] bg-[var(--elevated)] text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }
}

export function TechnicianShiftWorkspace() {
  const [
    snapshot,
    setSnapshot,
  ] =
    useState<TechnicianCurrentShiftSnapshot | null>(
      null,
    );

  const [
    loading,
    setLoading,
  ] =
    useState(true);

  const [
    refreshing,
    setRefreshing,
  ] =
    useState(false);

  const [
    error,
    setError,
  ] =
    useState<string | null>(
      null,
    );

  const [
    action,
    setAction,
  ] =
    useState<
      "start" | "join" | null
    >(null);

  const [
    actionError,
    setActionError,
  ] =
    useState<string | null>(
      null,
    );

  const [
    actionSuccess,
    setActionSuccess,
  ] =
    useState<string | null>(
      null,
    );

  const retrievalInProgress =
    useRef(false);

  const currentShift =
    snapshot?.currentShift ??
    null;

  const writeAuthority:
    TechnicianWriteAuthorityResult |
    null =
    snapshot?.writeAuthority ??
    null;

  const actionInProgress =
    useRef(false);

  const loadCurrentShift =
    useCallback(
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
            await getTechnicianCurrentShift();

          setSnapshot(
            result,
          );

          return true;
        } catch (caughtError) {
          setSnapshot(null);

          if (
            caughtError instanceof
            ShiftApiError
          ) {
            setError(
              caughtError.message,
            );
          } else {
            setError(
              "Unable to retrieve your current shift.",
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

  useEffect(() => {
    let cancelled = false;

    retrievalInProgress.current =
      true;

    void getTechnicianCurrentShift()
      .then((result) => {
        if (cancelled) {
          return;
        }

        setSnapshot(
          result,
        );

        setError(null);
      })
      .catch(
        (caughtError: unknown) => {
          if (cancelled) {
            return;
          }

          setSnapshot(null);

          if (
            caughtError instanceof
            ShiftApiError
          ) {
            setError(
              caughtError.message,
            );
          } else {
            setError(
              "Unable to retrieve your current shift.",
            );
          }
        },
      )
      .finally(() => {
        if (cancelled) {
          return;
        }

        retrievalInProgress.current =
          false;

        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;

      retrievalInProgress.current =
        false;
    };
  }, []);

  async function handleRefresh() {
    setActionError(null);
    setActionSuccess(null);

    await loadCurrentShift(
      true,
    );
  }

  async function handleStartShift() {
    if (
      !currentShift ||
      !currentShift.canStart ||
      actionInProgress.current
    ) {
      return;
    }

    const shiftId =
      currentShift.id;

    actionInProgress.current =
      true;

    setAction("start");
    setActionError(null);
    setActionSuccess(null);

    try {
      await startShift(
        shiftId,
      );

      /*
       * Do not manufacture active state
       * or attendance locally.
       *
       * Reload the authoritative server
       * projection after the action.
       */
      const refreshed =
        await loadCurrentShift(
          true,
        );

      if (refreshed) {
        setActionSuccess(
          "Shift started successfully. Join the active shift to record your attendance.",
        );
      } else {
        setActionSuccess(
          "Shift started successfully, but the updated shift state could not be retrieved. Refresh My Shift before continuing.",
        );
      }
    } catch (caughtError) {
      if (
        caughtError instanceof
        ShiftApiError
      ) {
        setActionError(
          caughtError.message,
        );
      } else {
        setActionError(
          "The shift could not be started.",
        );
      }
    } finally {
      actionInProgress.current =
        false;

      setAction(null);
    }
  }

  async function handleJoinShift() {
    if (
      !currentShift ||
      !currentShift.canJoin ||
      !writeAuthority?.mayWrite ||
      actionInProgress.current
    ) {
      return;
    }

    const shiftId =
      currentShift.id;

    actionInProgress.current =
      true;

    setAction("join");
    setActionError(null);
    setActionSuccess(null);

    try {
      await joinShift(
        shiftId,
      );

      /*
       * Explicit join is the attendance
       * boundary.
       *
       * Reload authoritative state rather
       * than constructing attendance in
       * the browser.
       */
      const refreshed =
        await loadCurrentShift(
          true,
        );

      if (refreshed) {
        setActionSuccess(
          "Shift joined successfully. Your attendance has been recorded.",
        );
      } else {
        setActionSuccess(
          "Shift joined successfully, but the updated attendance state could not be retrieved. Refresh My Shift to retrieve the authoritative record.",
        );
      }
    } catch (caughtError) {
      if (
        caughtError instanceof
        ShiftApiError
      ) {
        setActionError(
          caughtError.message,
        );
      } else {
        setActionError(
          "The shift could not be joined.",
        );
      }
    } finally {
      actionInProgress.current =
        false;

      setAction(null);
    }
  }

  const actionsDisabled =
    loading ||
    refreshing ||
    action !== null;

  return (
    <section aria-labelledby="my-shift-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="my-shift-title" className="text-xl font-semibold">
          My Shift
        </h2>

        <button
          type="button"
          onClick={() => {
            void handleRefresh();
          }}
          disabled={
            actionsDisabled
          }
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-medium hover:bg-[var(--elevated)] focus-visible:outline-2 focus-visible:outline-[var(--foreground)] disabled:opacity-60"
        >
          <RefreshCw
            className={
              refreshing
                ? "h-4 w-4 animate-spin"
                : "h-4 w-4"
            }
          />

          {refreshing
            ? "Refreshing..."
            : "Refresh"}
        </button>
      </div>

      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />

          <span>
            {actionError}
          </span>
        </div>
      )}

      {actionSuccess && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
        >
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />

          <span>
            {actionSuccess}
          </span>
        </div>
      )}

      {writeAuthority && !writeAuthority.mayWrite && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />

          <div>
            <p className="font-medium">
              Read-only
            </p>

            <p className="mt-1 text-xs">
              {writeAuthority.message}
            </p>
          </div>
        </div>
      )}

      {loading || (refreshing && !snapshot) ? (
        <div role="status" className="flex min-h-40 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
          <div className="text-center">
            <Loader2 className="mx-auto size-6 text-[var(--muted)] motion-safe:animate-spin" aria-hidden="true" />

            <p className="mt-3 text-sm text-[var(--muted)] dark:text-slate-400">
              Loading your current shift...
            </p>
          </div>
        </div>
      ) : error || !currentShift ? (
        <div
          role={error ? "alert" : undefined}
          className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--elevated)] text-[var(--muted)]">
            {error ? <AlertCircle size={19} aria-hidden="true" /> : <CalendarClock size={19} aria-hidden="true" />}
          </span>
          <div>
            <h3 className="font-semibold">{error ? "Unable to verify shift status" : "No current shift"}</h3>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {error ? "Select Refresh to check your shift status again." : "There is no current operational shift assigned or authorized for you."}
            </p>
            {error && <p className="mt-2 text-xs text-[var(--muted)]">{error}</p>}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--muted)] dark:text-slate-400">
                Current Operational Shift
              </p>

              <h3 className="mt-1 text-xl font-bold text-slate-900 dark:text-white">
                {formatShiftType(
                  currentShift.shiftType,
                )}{" "}
                Shift
              </h3>
            </div>

            <span
              className={`rounded-full border px-3 py-1 text-xs font-medium ${statusClasses(
                currentShift.status,
              )}`}
            >
              {formatShiftStatus(
                currentShift.status,
              )}
            </span>
          </div>

          <dl className="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Participation
              </dt>

              <dd className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                {formatParticipationAuthority(
                  currentShift.participationAuthority,
                )}
              </dd>
            </div>

            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Scheduled Start
              </dt>

              <dd className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                {formatDateTime(
                  currentShift.scheduledStart,
                )}
              </dd>
            </div>

            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Scheduled End
              </dt>

              <dd className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                {formatDateTime(
                  currentShift.scheduledEnd,
                )}
              </dd>
            </div>

            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Actual Start
              </dt>

              <dd className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                {formatDateTime(
                  currentShift.actualStart,
                )}
              </dd>
            </div>

            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Attendance
              </dt>

              <dd className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                {currentShift.attendance
                  ? "Present"
                  : "No attendance record"}
              </dd>
            </div>

            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Joined At
              </dt>

              <dd className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                {formatDateTime(
                  currentShift.joinedAt,
                )}
              </dd>
            </div>
          </dl>

          <div className="mt-6 border-t border-[var(--border)] pt-5 dark:border-slate-800">
            {currentShift.canStart && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => {
                    void handleStartShift();
                  }}
                  disabled={
                    actionsDisabled
                  }
                  className="btn-accent inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {action === "start" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}

                  {action === "start"
                    ? "Starting Shift..."
                    : "Start Shift"}
                </button>

                <p className="text-xs text-[var(--muted)] dark:text-slate-400">
                  Starting the shift does not
                  record attendance. After the
                  shift becomes active, use
                  Join Shift to participate.
                </p>
              </div>
            )}

            {currentShift.canJoin &&
              writeAuthority?.mayWrite && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => {
                    void handleJoinShift();
                  }}
                  disabled={
                    actionsDisabled
                  }
                  className="btn-accent inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {action === "join" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserCheck className="h-4 w-4" />
                  )}

                  {action === "join"
                    ? "Joining Shift..."
                    : "Join Shift"}
                </button>

                <p className="text-xs text-[var(--muted)] dark:text-slate-400">
                  Join Shift is the explicit
                  attendance action for this
                  active shift.
                </p>
              </div>
            )}

            {currentShift.canJoin &&
              writeAuthority &&
              !writeAuthority.mayWrite && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Join Shift is unavailable
                  while this view is
                  read-only.
                </p>
              )}

            {currentShift.attendance && (
              <div className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />

                <div>
                  <p className="font-medium">
                    Shift joined
                  </p>

                  <p className="mt-1 text-xs">
                    Attendance was recorded at{" "}
                    {formatDateTime(
                      currentShift.joinedAt,
                    )}.
                  </p>
                </div>
              </div>
            )}

            {currentShift.status === "active" && currentShift.attendance && writeAuthority?.mayWrite && (
              <Link
                href="/technician/operations"
                className="btn-accent mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold"
              >
                Open Shift Operations
                <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            )}

            {!currentShift.attendance &&
              currentShift.status ===
                "scheduled" &&
              !currentShift.canStart && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                  {currentShift.firstShiftBootstrapAvailable ? (
                    <>
                      This shift is assigned to
                      you. Either technician on
                      the pair can start it, but
                      your account is not
                      currently eligible to do
                      so. Ask your supervisor to
                      review your account status
                      and pair membership.
                    </>
                  ) : (
                    <>
                      This shift is assigned to
                      you. It activates when a
                      reserved incoming
                      technician accepts the
                      outgoing handover with
                      their own password on the
                      last page of the handover
                      form. Refresh My Shift
                      once it is active. Only the
                      technician who accepted
                      that handover can change
                      operational data; every
                      other technician view is
                      read-only.
                    </>
                  )}
                </div>
              )}

            {!currentShift.attendance &&
              currentShift.status ===
                "handover_pending" && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                  Handover is pending. New
                  shift participation is
                  closed.
                </div>
              )}
          </div>
        </div>
      )}
    </section>
  );
}
