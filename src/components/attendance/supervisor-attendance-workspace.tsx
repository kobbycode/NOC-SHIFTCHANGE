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
  ClipboardCheck,
  Loader2,
  RefreshCw,
  UserCheck,
} from "lucide-react";

import {
  AttendanceApiError,
  getShiftAttendance,
} from "@/lib/attendance/attendance-api";

import type {
  AttendanceListItem,
} from "@/lib/attendance/attendance-api-types";

import {
  getShifts,
  ShiftApiError,
} from "@/lib/shifts/shift-api";

import type {
  Shift,
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

function formatAttendanceStatus(
  status: AttendanceListItem["status"],
): string {
  switch (status) {
    case "present":
      return "Present";

    case "absent":
      return "Absent";

    case "late":
      return "Late";

    case "excused":
      return "Excused";

    case "on_leave":
      return "On Leave";

    case "not_yet_arrived":
      return "Not Yet Arrived";

    default:
      return status;
  }
}

function formatParticipationAuthority(
  authority:
    AttendanceListItem[
      "participationAuthority"
    ],
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

function shiftStatusClasses(
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

function attendanceStatusClasses(
  status: AttendanceListItem["status"],
): string {
  switch (status) {
    case "present":
      return "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300";

    case "late":
    case "not_yet_arrived":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300";

    case "absent":
      return "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300";

    case "excused":
    case "on_leave":
      return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300";

    default:
      return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }
}

export function SupervisorAttendanceWorkspace() {
  const [shifts, setShifts] =
    useState<Shift[]>([]);

  const [
    selectedShiftId,
    setSelectedShiftId,
  ] = useState<string | null>(
    null,
  );

  const [
    attendance,
    setAttendance,
  ] = useState<
    AttendanceListItem[]
  >([]);

  const [loading, setLoading] =
    useState(true);

  const [
    refreshing,
    setRefreshing,
  ] = useState(false);

  const [
    attendanceLoading,
    setAttendanceLoading,
  ] = useState(true);

  const [error, setError] =
    useState<string | null>(
      null,
    );

  const [
    attendanceError,
    setAttendanceError,
  ] = useState<string | null>(
    null,
  );

  const retrievalInProgress =
    useRef(false);

  const attendanceRequestId =
    useRef(0);

  const selectedShift =
    shifts.find(
      (shift) =>
        shift.id ===
        selectedShiftId,
    ) ?? null;

  const loadAttendance =
    useCallback(
      async (
        shiftId: string,
      ): Promise<void> => {
        const requestId =
          ++attendanceRequestId.current;

        try {
          const result =
            await getShiftAttendance(
              shiftId,
            );

          if (
            requestId !==
            attendanceRequestId.current
          ) {
            return;
          }

          setAttendance(
            result.attendance,
          );
        } catch (
          caughtError
        ) {
          if (
            requestId !==
            attendanceRequestId.current
          ) {
            return;
          }

          setAttendance([]);

          if (
            caughtError instanceof
            AttendanceApiError
          ) {
            setAttendanceError(
              caughtError.message,
            );
          } else {
            setAttendanceError(
              "Unable to retrieve attendance for this shift.",
            );
          }
        } finally {
          if (
            requestId ===
            attendanceRequestId.current
          ) {
            setAttendanceLoading(
              false,
            );
          }
        }
      },
      [],
    );

  const loadShifts =
    useCallback(
      async (): Promise<void> => {
        if (
          retrievalInProgress.current
        ) {
          return;
        }

        retrievalInProgress.current =
          true;

        try {
          const result =
            await getShifts();

          setError(null);

          setShifts(
            result.shifts,
          );

          setSelectedShiftId(
            (
              currentShiftId,
            ) => {
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
                result.shifts[0]
                  ?.id ??
                null
              );
            },
          );
        } catch (
          caughtError
        ) {
          setShifts([]);
          setSelectedShiftId(
            null,
          );
          setAttendance([]);
          setAttendanceError(
            null,
          );

          attendanceRequestId.current +=
            1;

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
    let cancelled = false;

    void getShifts()
      .then((result) => {
        if (cancelled) {
          return;
        }

        setError(null);

        setShifts(
          result.shifts,
        );

        setSelectedShiftId(
          result.shifts[0]
            ?.id ??
            null,
        );
      })
      .catch(
        (caughtError) => {
          if (cancelled) {
            return;
          }

          setShifts([]);
          setSelectedShiftId(
            null,
          );

          setAttendance([]);
          setAttendanceError(
            null,
          );

          attendanceRequestId.current +=
            1;

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
        },
      )
      .finally(() => {
        if (cancelled) {
          return;
        }

        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedShiftId) {
      attendanceRequestId.current +=
        1;

      return;
    }

    const requestId =
      ++attendanceRequestId.current;

    void getShiftAttendance(
      selectedShiftId,
    )
      .then((result) => {
        if (
          requestId !==
          attendanceRequestId.current
        ) {
          return;
        }

        setAttendanceError(
          null,
        );

        setAttendance(
          result.attendance,
        );
      })
      .catch(
        (caughtError) => {
          if (
            requestId !==
            attendanceRequestId.current
          ) {
            return;
          }

          setAttendance([]);

          if (
            caughtError instanceof
            AttendanceApiError
          ) {
            setAttendanceError(
              caughtError.message,
            );
          } else {
            setAttendanceError(
              "Unable to retrieve attendance for this shift.",
            );
          }
        },
      )
      .finally(() => {
        if (
          requestId !==
          attendanceRequestId.current
        ) {
          return;
        }

        setAttendanceLoading(
          false,
        );
      });
  }, [selectedShiftId]);

  async function handleRefresh() {
    const shiftId =
      selectedShiftId;

    setRefreshing(true);
    setError(null);

    if (shiftId) {
      setAttendanceLoading(
        true,
      );

      setAttendanceError(
        null,
      );

      setAttendance([]);
    }

    await loadShifts();

    if (shiftId) {
      await loadAttendance(
        shiftId,
      );
    }
  }

  return (
    <section className="space-y-6">
      <div
        className="
          flex flex-wrap items-center
          justify-between gap-4
        "
      >
        <div>
          <h2
            className="
              text-xl font-bold
              text-slate-900
              dark:text-white
            "
          >
            Shift Attendance
          </h2>

          <p
            className="
              mt-1 text-sm
              text-slate-500
              dark:text-slate-400
            "
          >
            Read-only attendance
            recorded through
            authoritative shift
            participation.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            void handleRefresh();
          }}
          disabled={
            loading ||
            refreshing ||
            attendanceLoading
          }
          className="
            inline-flex items-center
            gap-2 rounded-xl border
            border-slate-300 bg-white
            px-4 py-2 text-sm
            font-medium text-slate-700
            shadow-sm transition
            hover:bg-slate-50
            disabled:cursor-not-allowed
            disabled:opacity-60
            dark:border-slate-700
            dark:bg-slate-900
            dark:text-slate-200
            dark:hover:bg-slate-800
          "
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
          className="
            flex items-start gap-3
            rounded-xl border
            border-red-200
            bg-red-50 p-4
            text-sm text-red-700
            dark:border-red-900
            dark:bg-red-950
            dark:text-red-300
          "
        >
          <AlertCircle
            className="
              mt-0.5 h-5 w-5
              shrink-0
            "
          />

          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div
          className="
            flex min-h-48
            items-center
            justify-center
            rounded-2xl border
            border-slate-200
            bg-white p-8
            shadow-sm
            dark:border-slate-800
            dark:bg-slate-950
          "
        >
          <div className="text-center">
            <Loader2
              className="
                mx-auto h-7 w-7
                animate-spin
                text-slate-500
              "
            />

            <p
              className="
                mt-3 text-sm
                text-slate-500
                dark:text-slate-400
              "
            >
              Loading operational
              shifts...
            </p>
          </div>
        </div>
      ) : shifts.length === 0 ? (
        <div
          className="
            rounded-2xl border
            border-slate-200
            bg-white p-8
            text-center shadow-sm
            dark:border-slate-800
            dark:bg-slate-950
          "
        >
          <CalendarClock
            className="
              mx-auto h-8 w-8
              text-slate-400
            "
          />

          <h3
            className="
              mt-4 font-semibold
              text-slate-900
              dark:text-white
            "
          >
            No shifts available
          </h3>

          <p
            className="
              mt-2 text-sm
              text-slate-500
              dark:text-slate-400
            "
          >
            No operational shift
            records are currently
            available.
          </p>
        </div>
      ) : (
        <div
          className="
            grid gap-6
            xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]
          "
        >
          <div className="space-y-3">
            {shifts.map(
              (shift) => {
                const selected =
                  shift.id ===
                  selectedShiftId;

                return (
                  <button
                    key={shift.id}
                    type="button"
                    onClick={() => {
                      if (
                        shift.id ===
                        selectedShiftId
                      ) {
                        return;
                      }

                      setAttendanceLoading(
                        true,
                      );

                      setAttendanceError(
                        null,
                      );

                      setAttendance([]);

                      setSelectedShiftId(
                        shift.id,
                      );
                    }}
                    className={`
                      w-full rounded-2xl
                      border p-5
                      text-left shadow-sm
                      transition
                      ${
                        selected
                          ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-950/40"
                          : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-slate-700"
                      }
                    `}
                  >
                    <div
                      className="
                        flex flex-wrap
                        items-start
                        justify-between
                        gap-3
                      "
                    >
                      <div>
                        <p
                          className="
                            font-semibold
                            text-slate-900
                            dark:text-white
                          "
                        >
                          {formatShiftType(
                            shift.shiftType,
                          )}{" "}
                          Shift
                        </p>

                        <p
                          className="
                            mt-1 text-xs
                            text-slate-500
                            dark:text-slate-400
                          "
                        >
                          {formatDateTime(
                            shift.scheduledStart,
                          )}
                        </p>
                      </div>

                      <span
                        className={`
                          rounded-full
                          border px-2.5
                          py-1 text-xs
                          font-medium
                          ${shiftStatusClasses(
                            shift.status,
                          )}
                        `}
                      >
                        {formatShiftStatus(
                          shift.status,
                        )}
                      </span>
                    </div>
                  </button>
                );
              },
            )}
          </div>

          {selectedShift && (
            <div
              className="
                rounded-2xl border
                border-slate-200
                bg-white p-6
                shadow-sm
                dark:border-slate-800
                dark:bg-slate-950
              "
            >
              <div
                className="
                  flex flex-wrap
                  items-start
                  justify-between
                  gap-4
                "
              >
                <div>
                  <p
                    className="
                      text-sm font-medium
                      text-slate-500
                      dark:text-slate-400
                    "
                  >
                    Selected Shift
                  </p>

                  <h3
                    className="
                      mt-1 text-xl
                      font-bold
                      text-slate-900
                      dark:text-white
                    "
                  >
                    {formatShiftType(
                      selectedShift.shiftType,
                    )}{" "}
                    Shift
                  </h3>

                  <p
                    className="
                      mt-1 text-sm
                      text-slate-500
                      dark:text-slate-400
                    "
                  >
                    {formatDateTime(
                      selectedShift.scheduledStart,
                    )}
                  </p>
                </div>

                <span
                  className={`
                    rounded-full border
                    px-3 py-1 text-xs
                    font-medium
                    ${shiftStatusClasses(
                      selectedShift.status,
                    )}
                  `}
                >
                  {formatShiftStatus(
                    selectedShift.status,
                  )}
                </span>
              </div>

              <div
                className="
                  mt-6 flex
                  items-center
                  justify-between
                  border-b
                  border-slate-200
                  pb-4
                  dark:border-slate-800
                "
              >
                <div
                  className="
                    flex items-center
                    gap-2
                  "
                >
                  <ClipboardCheck
                    className="
                      h-5 w-5
                      text-slate-500
                    "
                  />

                  <h4
                    className="
                      font-semibold
                      text-slate-900
                      dark:text-white
                    "
                  >
                    Attendance Records
                  </h4>
                </div>

                {!attendanceLoading &&
                  !attendanceError && (
                    <span
                      className="
                        rounded-full
                        bg-slate-100
                        px-2.5 py-1
                        text-xs
                        font-medium
                        text-slate-600
                        dark:bg-slate-800
                        dark:text-slate-300
                      "
                    >
                      {attendance.length}
                    </span>
                  )}
              </div>

              {attendanceLoading ? (
                <div
                  className="
                    flex min-h-40
                    items-center
                    justify-center
                  "
                >
                  <div className="text-center">
                    <Loader2
                      className="
                        mx-auto h-6 w-6
                        animate-spin
                        text-slate-500
                      "
                    />

                    <p
                      className="
                        mt-3 text-sm
                        text-slate-500
                        dark:text-slate-400
                      "
                    >
                      Loading attendance...
                    </p>
                  </div>
                </div>
              ) : attendanceError ? (
                <div
                  role="alert"
                  className="
                    mt-5 flex
                    items-start gap-3
                    rounded-xl border
                    border-red-200
                    bg-red-50 p-4
                    text-sm text-red-700
                    dark:border-red-900
                    dark:bg-red-950
                    dark:text-red-300
                  "
                >
                  <AlertCircle
                    className="
                      mt-0.5 h-5 w-5
                      shrink-0
                    "
                  />

                  <span>
                    {attendanceError}
                  </span>
                </div>
              ) : attendance.length ===
                0 ? (
                <div
                  className="
                    py-10 text-center
                  "
                >
                  <UserCheck
                    className="
                      mx-auto h-8 w-8
                      text-slate-400
                    "
                  />

                  <h4
                    className="
                      mt-4 font-semibold
                      text-slate-900
                      dark:text-white
                    "
                  >
                    No attendance records
                  </h4>

                  <p
                    className="
                      mx-auto mt-2
                      max-w-md text-sm
                      text-slate-500
                      dark:text-slate-400
                    "
                  >
                    No attendance records
                    have been recorded for
                    this shift. Missing
                    attendance records are
                    not interpreted as
                    absence.
                  </p>
                </div>
              ) : (
                <div
                  className="
                    mt-5 space-y-4
                  "
                >
                  {attendance.map(
                    (record) => (
                      <article
                        key={record.id}
                        className="
                          rounded-xl border
                          border-slate-200
                          p-4
                          dark:border-slate-800
                        "
                      >
                        <div
                          className="
                            flex flex-wrap
                            items-start
                            justify-between
                            gap-3
                          "
                        >
                          <div>
                            <p
                              className="
                                font-semibold
                                text-slate-900
                                dark:text-white
                              "
                            >
                              {
                                record.technicianName
                              }
                            </p>

                            <p
                              className="
                                mt-1 text-xs
                                text-slate-500
                                dark:text-slate-400
                              "
                            >
                              {formatParticipationAuthority(
                                record.participationAuthority,
                              )}
                            </p>
                          </div>

                          <span
                            className={`
                              rounded-full
                              border px-2.5
                              py-1 text-xs
                              font-medium
                              ${attendanceStatusClasses(
                                record.status,
                              )}
                            `}
                          >
                            {formatAttendanceStatus(
                              record.status,
                            )}
                          </span>
                        </div>

                        <dl
                          className="
                            mt-4 grid
                            gap-4 text-sm
                            sm:grid-cols-2
                          "
                        >
                          <div>
                            <dt
                              className="
                                text-xs
                                font-medium
                                uppercase
                                tracking-wide
                                text-slate-400
                              "
                            >
                              Joined At
                            </dt>

                            <dd
                              className="
                                mt-1
                                text-slate-700
                                dark:text-slate-200
                              "
                            >
                              {formatDateTime(
                                record.recordedAt,
                              )}
                            </dd>
                          </div>

                          <div>
                            <dt
                              className="
                                text-xs
                                font-medium
                                uppercase
                                tracking-wide
                                text-slate-400
                              "
                            >
                              Record Type
                            </dt>

                            <dd
                              className="
                                mt-1
                                text-slate-700
                                dark:text-slate-200
                              "
                            >
                              {record.isProvisional
                                ? "Provisional"
                                : "Authoritative"}
                            </dd>
                          </div>

                          <div>
                            <dt
                              className="
                                text-xs
                                font-medium
                                uppercase
                                tracking-wide
                                text-slate-400
                              "
                            >
                              Clock In
                            </dt>

                            <dd
                              className="
                                mt-1
                                text-slate-700
                                dark:text-slate-200
                              "
                            >
                              {formatDateTime(
                                record.clockIn,
                              )}
                            </dd>
                          </div>

                          <div>
                            <dt
                              className="
                                text-xs
                                font-medium
                                uppercase
                                tracking-wide
                                text-slate-400
                              "
                            >
                              Clock Out
                            </dt>

                            <dd
                              className="
                                mt-1
                                text-slate-700
                                dark:text-slate-200
                              "
                            >
                              {formatDateTime(
                                record.clockOut,
                              )}
                            </dd>
                          </div>
                        </dl>
                      </article>
                    ),
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}