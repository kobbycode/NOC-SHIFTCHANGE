"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  AlertCircle,
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
      return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }
}

export function TechnicianShiftWorkspace() {
  const [
    currentShift,
    setCurrentShift,
  ] =
    useState<TechnicianCurrentShiftResult | null>(
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

          setCurrentShift(
            result,
          );

          return true;
        } catch (caughtError) {
          setCurrentShift(null);

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

        setCurrentShift(
          result,
        );

        setError(null);
      })
      .catch(
        (caughtError: unknown) => {
          if (cancelled) {
            return;
          }

          setCurrentShift(null);

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
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">
            My Shift
          </h2>

          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Your authoritative current
            operational shift and attendance
            state.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            void handleRefresh();
          }}
          disabled={
            actionsDisabled
          }
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
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

      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />

          <span>
            {error}
          </span>
        </div>
      )}

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

      {loading ? (
        <div className="flex min-h-48 items-center justify-center rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="text-center">
            <Loader2 className="mx-auto h-7 w-7 animate-spin text-slate-500" />

            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
              Loading your current shift...
            </p>
          </div>
        </div>
      ) : !currentShift ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <CalendarClock className="mx-auto h-8 w-8 text-slate-400" />

          <h3 className="mt-4 font-semibold text-slate-900 dark:text-white">
            No current shift
          </h3>

          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            There is no current operational
            shift assigned or authorized for
            you.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
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

          <div className="mt-6 border-t border-slate-200 pt-5 dark:border-slate-800">
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
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
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

                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Starting the shift does not
                  record attendance. After the
                  shift becomes active, use
                  Join Shift to participate.
                </p>
              </div>
            )}

            {currentShift.canJoin && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => {
                    void handleJoinShift();
                  }}
                  disabled={
                    actionsDisabled
                  }
                  className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
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

                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Join Shift is the explicit
                  attendance action for this
                  active shift.
                </p>
              </div>
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

            {!currentShift.attendance &&
              currentShift.status ===
                "scheduled" &&
              !currentShift.canStart && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                  This shift is assigned to
                  you. Refresh My Shift when
                  it becomes active, then use
                  Join Shift to record your
                  attendance.
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
