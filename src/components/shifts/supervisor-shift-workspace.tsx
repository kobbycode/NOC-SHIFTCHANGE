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
  Loader2,
  RefreshCw,
  Users,
} from "lucide-react";

import {
  getShiftMembers,
  getShifts,
  ShiftApiError,
} from "@/lib/shifts/shift-api";

import type {
  Shift,
  ShiftMember,
  ShiftStatus,
  ShiftType,
} from "@/types/shift";

function formatShiftType(
  shiftType: ShiftType,
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
  status: ShiftStatus,
): string {
  switch (status) {
    case "scheduled":
      return "Scheduled";
    case "active":
      return "Active";
    case "handover_pending":
      return "Handover Pending";
    case "completed":
      return "Completed";
    default:
      return status;
  }
}

function formatDateTime(
  value: string | null,
): string {
  if (!value) {
    return "Not recorded";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function statusClasses(
  status: ShiftStatus,
): string {
  switch (status) {
    case "scheduled":
      return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300";

    case "active":
      return "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300";

    case "handover_pending":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300";

    case "completed":
      return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";

    default:
      return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }
}

export function SupervisorShiftWorkspace() {
  const [shifts, setShifts] =
    useState<Shift[]>([]);

  const [
    selectedShiftId,
    setSelectedShiftId,
  ] = useState<string | null>(null);

  const [members, setMembers] =
    useState<ShiftMember[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [refreshing, setRefreshing] =
    useState(false);

  const [
    membersLoading,
    setMembersLoading,
  ] = useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const [
    membersError,
    setMembersError,
  ] = useState<string | null>(null);

  const retrievalInProgress =
    useRef(false);

  const memberRequestId =
    useRef(0);

  const selectedShift =
    shifts.find(
      (shift) =>
        shift.id === selectedShiftId,
    ) ?? null;

  const loadMembers = useCallback(
    async (
      shiftId: string,
    ): Promise<void> => {
      const requestId =
        ++memberRequestId.current;

      setMembersLoading(true);
      setMembersError(null);
      setMembers([]);

      try {
        const result =
          await getShiftMembers(shiftId);

        if (
          requestId !==
          memberRequestId.current
        ) {
          return;
        }

        setMembers(result.members);
      } catch (caughtError) {
        if (
          requestId !==
          memberRequestId.current
        ) {
          return;
        }

        setMembers([]);

        if (
          caughtError instanceof
          ShiftApiError
        ) {
          setMembersError(
            caughtError.message,
          );
        } else {
          setMembersError(
            "Unable to retrieve shift membership.",
          );
        }
      } finally {
        if (
          requestId ===
          memberRequestId.current
        ) {
          setMembersLoading(false);
        }
      }
    },
    [],
  );

  const loadShifts = useCallback(
    async (
      refresh = false,
    ): Promise<void> => {
      if (
        retrievalInProgress.current
      ) {
        return;
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
          await getShifts();

        setShifts(result.shifts);

        setSelectedShiftId(
          (currentShiftId) => {
            if (
              currentShiftId &&
              result.shifts.some(
                (shift) =>
                  shift.id ===
                  currentShiftId,
              )
            ) {
              return currentShiftId;
            }

            return (
              result.shifts[0]?.id ??
              null
            );
          },
        );
      } catch (caughtError) {
        setShifts([]);
        setSelectedShiftId(null);
        setMembers([]);
        setMembersError(null);

        memberRequestId.current += 1;

        if (
          caughtError instanceof
          ShiftApiError
        ) {
          setError(
            caughtError.message,
          );
        } else {
          setError(
            "Unable to retrieve operational shifts.",
          );
        }
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
    void loadShifts();
  }, [loadShifts]);

  useEffect(() => {
    if (!selectedShiftId) {
      memberRequestId.current += 1;
      setMembers([]);
      setMembersError(null);
      setMembersLoading(false);
      return;
    }

    void loadMembers(
      selectedShiftId,
    );
  }, [
    selectedShiftId,
    loadMembers,
  ]);

  async function handleRefresh() {
    await loadShifts(true);
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">
            Operational Shifts
          </h2>

          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Authoritative shift and
            technician membership data.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            void handleRefresh();
          }}
          disabled={
            loading ||
            refreshing
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

          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-48 items-center justify-center rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="text-center">
            <Loader2 className="mx-auto h-7 w-7 animate-spin text-slate-500" />

            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
              Loading operational shifts...
            </p>
          </div>
        </div>
      ) : shifts.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <CalendarClock className="mx-auto h-8 w-8 text-slate-400" />

          <h3 className="mt-4 font-semibold text-slate-900 dark:text-white">
            No shifts available
          </h3>

          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            No operational shift records
            are currently available.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="space-y-3">
            {shifts.map((shift) => {
              const selected =
                shift.id ===
                selectedShiftId;

              return (
                <button
                  key={shift.id}
                  type="button"
                  onClick={() =>
                    setSelectedShiftId(
                      shift.id,
                    )
                  }
                  className={`w-full rounded-2xl border p-5 text-left shadow-sm transition ${
                    selected
                      ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-950/40"
                      : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-slate-700"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-white">
                        {formatShiftType(
                          shift.shiftType,
                        )}{" "}
                        Shift
                      </p>

                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {formatDateTime(
                          shift.scheduledStart,
                        )}
                      </p>
                    </div>

                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusClasses(
                        shift.status,
                      )}`}
                    >
                      {formatShiftStatus(
                        shift.status,
                      )}
                    </span>
                  </div>

                  <div className="mt-4 grid gap-2 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2">
                    <span>
                      Start:{" "}
                      {formatDateTime(
                        shift.scheduledStart,
                      )}
                    </span>

                    <span>
                      End:{" "}
                      {formatDateTime(
                        shift.scheduledEnd,
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {selectedShift && (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
                    Selected Shift
                  </p>

                  <h3 className="mt-1 text-xl font-bold text-slate-900 dark:text-white">
                    {formatShiftType(
                      selectedShift.shiftType,
                    )}{" "}
                    Shift
                  </h3>
                </div>

                <span
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${statusClasses(
                    selectedShift.status,
                  )}`}
                >
                  {formatShiftStatus(
                    selectedShift.status,
                  )}
                </span>
              </div>

              <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Scheduled Start
                  </dt>

                  <dd className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                    {formatDateTime(
                      selectedShift.scheduledStart,
                    )}
                  </dd>
                </div>

                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Scheduled End
                  </dt>

                  <dd className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                    {formatDateTime(
                      selectedShift.scheduledEnd,
                    )}
                  </dd>
                </div>

                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Actual Start
                  </dt>

                  <dd className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                    {formatDateTime(
                      selectedShift.actualStart,
                    )}
                  </dd>
                </div>

                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Actual End
                  </dt>

                  <dd className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                    {formatDateTime(
                      selectedShift.actualEnd,
                    )}
                  </dd>
                </div>
              </dl>

              <div className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-slate-500" />

                  <h4 className="font-semibold text-slate-900 dark:text-white">
                    Technician Membership
                  </h4>
                </div>

                {membersLoading ? (
                  <div className="mt-5 flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Loading membership...
                  </div>
                ) : membersError ? (
                  <div
                    role="alert"
                    className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                  >
                    {membersError}
                  </div>
                ) : members.length === 0 ? (
                  <p className="mt-5 text-sm text-slate-500 dark:text-slate-400">
                    No technicians are
                    currently recorded for
                    this shift.
                  </p>
                ) : (
                  <div className="mt-5 space-y-3">
                    {members.map(
                      (member) => (
                        <div
                          key={member.id}
                          className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-slate-900 dark:text-white">
                                Technician
                              </p>

                              <p className="mt-1 break-all text-xs text-slate-500 dark:text-slate-400">
                                {
                                  member.technicianId
                                }
                              </p>
                            </div>

                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium capitalize text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                              {member.role}
                            </span>
                          </div>

                          <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                            Joined:{" "}
                            {formatDateTime(
                              member.joinedAt,
                            )}
                          </div>

                          {member.leftAt && (
                            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                              Left:{" "}
                              {formatDateTime(
                                member.leftAt,
                              )}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}