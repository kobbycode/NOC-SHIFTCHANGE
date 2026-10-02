import {
  ATTENDANCE_PARTICIPATION_AUTHORITIES,
  ATTENDANCE_STATUSES,
} from "@/types/attendance";

import type {
  AttendanceListItem,
  ShiftAttendanceListApiResponse,
  ShiftAttendanceListResult,
} from "./attendance-api-types";

export class AttendanceApiError
  extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);

    this.name = "AttendanceApiError";
  }
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isCanonicalTimestamp(
  value: unknown,
): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const timestamp =
    Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return (
    new Date(timestamp).toISOString() ===
    value
  );
}

function isNullableTimestamp(
  value: unknown,
): value is string | null {
  return (
    value === null ||
    isCanonicalTimestamp(value)
  );
}

function isAttendanceListItem(
  value: unknown,
  expectedShiftId: string,
): value is AttendanceListItem {
  if (!isRecord(value)) {
    return false;
  }

  const {
    id,
    shiftId,
    technicianId,
    technicianName,
    status,
    participationAuthority,
    authorizationId,
    clockIn,
    clockOut,
    isProvisional,
    recordedAt,
    updatedAt,
  } = value;

  if (
    typeof id !== "string" ||
    typeof shiftId !== "string" ||
    typeof technicianId !== "string" ||
    typeof technicianName !== "string" ||
    technicianName.trim().length === 0 ||
    shiftId !== expectedShiftId ||
    id !==
      `${shiftId}_${technicianId}` ||
    typeof isProvisional !== "boolean" ||
    !isCanonicalTimestamp(recordedAt) ||
    !isCanonicalTimestamp(updatedAt) ||
    !isNullableTimestamp(clockIn) ||
    !isNullableTimestamp(clockOut)
  ) {
    return false;
  }

  if (
    !Object.values(
      ATTENDANCE_STATUSES,
    ).some(
      (allowedStatus) =>
        allowedStatus === status,
    )
  ) {
    return false;
  }

  if (
    !Object.values(
      ATTENDANCE_PARTICIPATION_AUTHORITIES,
    ).some(
      (allowedAuthority) =>
        allowedAuthority ===
        participationAuthority,
    )
  ) {
    return false;
  }

  if (
    authorizationId !== null &&
    typeof authorizationId !== "string"
  ) {
    return false;
  }

  if (
    participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY &&
    authorizationId !== null
  ) {
    return false;
  }

  if (
    participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.TEMPORARY_AUTHORIZED &&
    (
      typeof authorizationId !==
        "string" ||
      authorizationId.length === 0
    )
  ) {
    return false;
  }

  if (
    Date.parse(updatedAt) <
    Date.parse(recordedAt)
  ) {
    return false;
  }

  if (
    clockIn !== null &&
    clockOut !== null &&
    Date.parse(clockOut) <
      Date.parse(clockIn)
  ) {
    return false;
  }

  return true;
}

async function readApiResponse(
  response: Response,
): Promise<unknown> {
  const contentType =
    response.headers.get(
      "content-type",
    );

  if (
    !contentType
      ?.toLowerCase()
      .includes(
        "application/json",
      )
  ) {
    throw new AttendanceApiError(
      "The server returned an unexpected response.",
      response.status,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new AttendanceApiError(
      "The server returned invalid JSON.",
      response.status,
    );
  }
}

function requireSuccessfulResponse(
  response: Response,
  data: unknown,
): ShiftAttendanceListApiResponse {
  if (
    !isRecord(data) ||
    !("success" in data)
  ) {
    throw new AttendanceApiError(
      "The server returned an invalid attendance response.",
      response.status,
    );
  }

  if (
    !response.ok ||
    data.success !== true
  ) {
    const message =
      typeof data.error === "string"
        ? data.error
        : "Attendance could not be retrieved.";

    throw new AttendanceApiError(
      message,
      response.status,
    );
  }

  return data as unknown as
    ShiftAttendanceListApiResponse;
}

export async function getShiftAttendance(
  shiftId: string,
): Promise<ShiftAttendanceListResult> {
  const normalizedShiftId =
    shiftId.trim();

  if (
    !normalizedShiftId ||
    normalizedShiftId === "." ||
    normalizedShiftId === ".." ||
    normalizedShiftId.includes("/") ||
    normalizedShiftId.length > 512
  ) {
    throw new AttendanceApiError(
      "Please provide a valid shift identifier.",
      400,
    );
  }

  const response =
    await fetch(
      `/api/operations/shifts/${encodeURIComponent(
        normalizedShiftId,
      )}/attendance`,
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      },
    );

  const data =
    await readApiResponse(
      response,
    );

  const result =
    requireSuccessfulResponse(
      response,
      data,
    );

  if (
    result.success !== true ||
    !Array.isArray(
      result.attendance,
    ) ||
    !Number.isInteger(
      result.total,
    ) ||
    result.total < 0 ||
    result.total !==
      result.attendance.length ||
    !result.attendance.every(
      (record) =>
        isAttendanceListItem(
          record,
          normalizedShiftId,
        ),
    )
  ) {
    throw new AttendanceApiError(
      "The attendance retrieval response is invalid.",
      response.status,
    );
  }

  return {
    attendance:
      result.attendance,
    total: result.total,
  };
}