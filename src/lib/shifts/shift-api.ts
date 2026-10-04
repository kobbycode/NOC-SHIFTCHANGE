import {
  ATTENDANCE_PARTICIPATION_AUTHORITIES,
  ATTENDANCE_STATUSES,
} from "@/types/attendance";

import {
  SHIFT_STATUSES,
  SHIFT_TYPES,
} from "@/types/shift";
import type {
  ShiftCompletionApiResponse,
  ShiftCompletionResult,
  ShiftHandoverApiResponse,
  ShiftHandoverResult,
  ShiftListApiResponse,
  ShiftListResult,
  ShiftMemberListApiResponse,
  ShiftMemberListResult,
  ShiftJoinApiResponse,
  ShiftJoinResult,
  ShiftStartApiResponse,
  ShiftStartResult,
  TechnicianCurrentShiftApiResponse,
  TechnicianCurrentShiftResult,
} from "./shift-api-types";

/*
 * Shared Shift API error.
 *
 * Preserves the HTTP status so frontend
 * components can distinguish authentication,
 * authorization, and server failures.
 */
export class ShiftApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);

    this.name = "ShiftApiError";
  }
}

/*
 * Read a JSON response safely.
 *
 * Unexpected HTML or another response type
 * must not crash the frontend JSON parser.
 */
async function readApiResponse(
  response: Response
): Promise<unknown> {
  const contentType =
    response.headers.get("content-type");

  if (
    !contentType
      ?.toLowerCase()
      .includes("application/json")
  ) {
    throw new ShiftApiError(
      "The server returned an unexpected response.",
      response.status,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new ShiftApiError(
      "The server returned invalid JSON.",
      response.status,
    );
  }
}

/*
 * Validate the standard Shift API response.
 */
function requireSuccessfulResponse<
  T extends { success: boolean }
>(
  response: Response,
  data: unknown,
): T {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("success" in data)
  ) {
    throw new ShiftApiError(
      "The server returned an invalid response.",
      response.status,
    );
  }

  const result =
    data as Record<string, unknown>;

  if (
    !response.ok ||
    result.success !== true
  ) {
    const message =
      typeof result.error === "string"
        ? result.error
        : "The requested operation failed.";

    throw new ShiftApiError(
      message,
      response.status
    );
  }

  return data as T;
}

/*
 * Retrieve shifts visible to the currently
 * authenticated user.
 *
 * Shift visibility and account authorization
 * are determined by the server.
 */
export async function getShifts():
Promise<ShiftListResult> {
  const response =
    await fetch(
      "/api/operations/shifts",
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      }
    );

  const data =
    await readApiResponse(response);

  const result =
    requireSuccessfulResponse<
      ShiftListApiResponse
    >(response, data);

  if (
    result.success !== true ||
    !Array.isArray(result.shifts) ||
    typeof result.total !== "number"
  ) {
    throw new ShiftApiError(
      "The shift retrieval response is invalid.",
      response.status,
    );
  }

  return {
    shifts: result.shifts,
    total: result.total,
  };
}


/*
 * Retrieve authoritative membership records
 * for one operational shift.
 *
 * Membership visibility and account
 * authorization are determined by the server.
 */
export async function getShiftMembers(
  shiftId: string,
): Promise<ShiftMemberListResult> {
  const normalizedShiftId = shiftId.trim();

  if (
    !normalizedShiftId ||
    normalizedShiftId.includes("/") ||
    normalizedShiftId.length > 512
  ) {
    throw new ShiftApiError(
      "Please provide a valid shift identifier.",
      400,
    );
  }

  const response = await fetch(
    `/api/operations/shifts/${encodeURIComponent(
      normalizedShiftId
    )}/members`,
    {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    }
  );

  const data =
    await readApiResponse(response);

  const result =
    requireSuccessfulResponse<
      ShiftMemberListApiResponse
    >(response, data);

  if (
    result.success !== true ||
    !Array.isArray(result.members) ||
    typeof result.total !== "number"
  ) {
    throw new ShiftApiError(
      "The shift membership response is invalid.",
      response.status,
    );
  }

  return {
    members: result.members,
    total: result.total,
  };
}

/*
 * Begin handover for one active operational
 * shift.
 *
 * Lifecycle validation and authorization
 * remain authoritative on the server.
 */
export async function beginShiftHandover(
  shiftId: string,
): Promise<ShiftHandoverResult> {
  const normalizedShiftId = shiftId.trim();

  if (
    !normalizedShiftId ||
    normalizedShiftId.includes("/") ||
    normalizedShiftId.length > 512
  ) {
    throw new ShiftApiError(
      "Please provide a valid shift identifier.",
      400,
    );
  }

  const response = await fetch(
    `/api/operations/shifts/${encodeURIComponent(
      normalizedShiftId
    )}/handover`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    }
  );

  const data =
    await readApiResponse(response);

  const result =
    requireSuccessfulResponse<
      ShiftHandoverApiResponse
    >(response, data);

  if (
    result.success !== true ||
    !result.shift ||
    result.shift.id !== normalizedShiftId ||
    result.shift.status !==
      "handover_pending" ||
    typeof result.shift.handoverStartedAt !==
      "string" ||
    !Number.isFinite(
      Date.parse(
        result.shift.handoverStartedAt
      )
    )
  ) {
    throw new ShiftApiError(
      "The shift handover response is invalid.",
      response.status,
    );
  }

  return {
    shiftId: result.shift.id,
    status: result.shift.status,
    handoverStartedAt:
      result.shift.handoverStartedAt,
  };
}

/*
 * Complete one handover-pending operational
 * shift.
 *
 * Lifecycle validation and authorization
 * remain authoritative on the server.
 */
export async function completeShift(
  shiftId: string,
): Promise<ShiftCompletionResult> {
  const normalizedShiftId = shiftId.trim();

  if (
    !normalizedShiftId ||
    normalizedShiftId.includes("/") ||
    normalizedShiftId.length > 512
  ) {
    throw new ShiftApiError(
      "Please provide a valid shift identifier.",
      400,
    );
  }

  const response = await fetch(
    `/api/operations/shifts/${encodeURIComponent(
      normalizedShiftId
    )}/complete`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    }
  );

  const data =
    await readApiResponse(response);

  const result =
    requireSuccessfulResponse<
      ShiftCompletionApiResponse
    >(response, data);

  if (
    result.success !== true ||
    !result.shift ||
    result.shift.id !== normalizedShiftId ||
    result.shift.status !== "completed" ||
    typeof result.shift.actualEnd !==
      "string" ||
    !Number.isFinite(
      Date.parse(result.shift.actualEnd)
    )
  ) {
    throw new ShiftApiError(
      "The shift completion response is invalid.",
      response.status,
    );
  }

  return {
    shiftId: result.shift.id,
    status: result.shift.status,
    actualEnd: result.shift.actualEnd,
  };
}
function isShiftApiRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isCanonicalShiftApiTimestamp(
  value: unknown,
): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const timestamp =
    Date.parse(value);

  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() ===
      value
  );
}

function isNullableShiftApiTimestamp(
  value: unknown,
): value is string | null {
  return (
    value === null ||
    isCanonicalShiftApiTimestamp(value)
  );
}

function normalizeOperationalShiftId(
  shiftId: string,
): string {
  const normalizedShiftId =
    shiftId.trim();

  if (
    !normalizedShiftId ||
    normalizedShiftId === "." ||
    normalizedShiftId === ".." ||
    normalizedShiftId.includes("/") ||
    normalizedShiftId.length > 512
  ) {
    throw new ShiftApiError(
      "Please provide a valid shift identifier.",
      400,
    );
  }

  return normalizedShiftId;
}

function isAllowedParticipationAuthority(
  value: unknown,
): value is
  | "primary"
  | "temporary_authorized" {
  return Object.values(
    ATTENDANCE_PARTICIPATION_AUTHORITIES,
  ).some(
    (authority) =>
      authority === value,
  );
}

function isPresentShiftAttendanceStatus(
  value: unknown,
): value is "present" {
  return (
    value ===
    ATTENDANCE_STATUSES.PRESENT
  );
}

function isTechnicianCurrentShiftAttendance(
  value: unknown,
  expectedShiftId: string,
  expectedAuthority:
    | "primary"
    | "temporary_authorized",
  expectedAuthorizationId:
    string | null,
): boolean {
  if (!isShiftApiRecord(value)) {
    return false;
  }

  const {
    id,
    shiftId,
    technicianId,
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
    shiftId !== expectedShiftId ||
    typeof technicianId !== "string" ||
    !technicianId.trim() ||
    id !==
      `${expectedShiftId}_${technicianId}` ||
    !isPresentShiftAttendanceStatus(
      status,
    ) ||
    participationAuthority !==
      expectedAuthority ||
    authorizationId !==
      expectedAuthorizationId ||
    typeof isProvisional !==
      "boolean" ||
    !isNullableShiftApiTimestamp(
      clockIn,
    ) ||
    !isNullableShiftApiTimestamp(
      clockOut,
    ) ||
    !isCanonicalShiftApiTimestamp(
      recordedAt,
    ) ||
    !isCanonicalShiftApiTimestamp(
      updatedAt,
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

function isTechnicianCurrentShift(
  value: unknown,
): value is TechnicianCurrentShiftResult {
  if (!isShiftApiRecord(value)) {
    return false;
  }

  const {
    id,
    shiftType,
    status,
    scheduledStart,
    scheduledEnd,
    actualStart,
    actualEnd,
    participationAuthority,
    authorizationId,
    attendance,
    joinedAt,
    canStart,
    canJoin,
  } = value;

  if (
    typeof id !== "string" ||
    !id.trim() ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.length > 512 ||
    !Object.values(
      SHIFT_TYPES,
    ).some(
      (allowedType) =>
        allowedType === shiftType,
    ) ||
    (
      status !==
        SHIFT_STATUSES.SCHEDULED &&
      status !==
        SHIFT_STATUSES.ACTIVE &&
      status !==
        SHIFT_STATUSES.HANDOVER_PENDING
    ) ||
    !isCanonicalShiftApiTimestamp(
      scheduledStart,
    ) ||
    !isCanonicalShiftApiTimestamp(
      scheduledEnd,
    ) ||
    Date.parse(scheduledEnd) <=
      Date.parse(scheduledStart) ||
    !isNullableShiftApiTimestamp(
      actualStart,
    ) ||
    actualEnd !== null ||
    !isAllowedParticipationAuthority(
      participationAuthority,
    ) ||
    typeof canStart !== "boolean" ||
    typeof canJoin !== "boolean"
  ) {
    return false;
  }

  if (
    participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY
  ) {
    if (authorizationId !== null) {
      return false;
    }
  } else if (
    typeof authorizationId !== "string" ||
    !authorizationId.trim()
  ) {
    return false;
  }

  if (
    status ===
      SHIFT_STATUSES.SCHEDULED
  ) {
    if (
      actualStart !== null ||
      attendance !== null ||
      joinedAt !== null ||
      canJoin ||
      canStart !==
        (
          participationAuthority ===
          ATTENDANCE_PARTICIPATION_AUTHORITIES.TEMPORARY_AUTHORIZED
        )
    ) {
      return false;
    }

    return true;
  }

  if (
    !isCanonicalShiftApiTimestamp(
      actualStart,
    )
  ) {
    return false;
  }

  if (attendance === null) {
    if (joinedAt !== null) {
      return false;
    }
  } else {
    if (
      !isTechnicianCurrentShiftAttendance(
        attendance,
        id,
        participationAuthority,
        authorizationId,
      )
    ) {
      return false;
    }

    if (
      !isShiftApiRecord(
        attendance,
      ) ||
      joinedAt !==
        attendance.recordedAt
    ) {
      return false;
    }
  }

  if (
    status ===
      SHIFT_STATUSES.ACTIVE
  ) {
    return (
      canStart === false &&
      canJoin ===
        (attendance === null)
    );
  }

  return (
    canStart === false &&
    canJoin === false
  );
}

/*
 * Retrieve only the operational shift that
 * is authoritative and relevant to the
 * currently authenticated technician.
 *
 * This deliberately does not use getShifts(),
 * because the general shift-list endpoint
 * remains restricted to supervisors/admins.
 */
export async function getTechnicianCurrentShift():
Promise<TechnicianCurrentShiftResult | null> {
  const response =
    await fetch(
      "/api/operations/technician/current-shift",
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
    requireSuccessfulResponse<
      TechnicianCurrentShiftApiResponse
    >(
      response,
      data,
    );

  if (
    result.success !== true ||
    !(
      result.currentShift === null ||
      isTechnicianCurrentShift(
        result.currentShift,
      )
    )
  ) {
    throw new ShiftApiError(
      "The technician current-shift response is invalid.",
      response.status,
    );
  }

  return result.currentShift;
}

/*
 * Request authoritative shift activation.
 *
 * For a technician, the server independently
 * verifies exact temporary authorization,
 * slot ownership, eligibility, and the
 * activation window.
 *
 * Starting a shift is not attendance.
 */
export async function startShift(
  shiftId: string,
): Promise<ShiftStartResult> {
  const normalizedShiftId =
    normalizeOperationalShiftId(
      shiftId,
    );

  const response =
    await fetch(
      `/api/operations/shifts/${encodeURIComponent(
        normalizedShiftId,
      )}/start`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      },
    );

  const data =
    await readApiResponse(
      response,
    );

  const result =
    requireSuccessfulResponse<
      ShiftStartApiResponse
    >(
      response,
      data,
    );

  if (
    result.success !== true ||
    !isShiftApiRecord(
      result.shift,
    ) ||
    result.shift.id !==
      normalizedShiftId ||
    result.shift.status !==
      SHIFT_STATUSES.ACTIVE ||
    !isCanonicalShiftApiTimestamp(
      result.shift.actualStart,
    )
  ) {
    throw new ShiftApiError(
      "The shift-start response is invalid.",
      response.status,
    );
  }

  return {
    shiftId:
      result.shift.id,
    status:
      result.shift.status,
    actualStart:
      result.shift.actualStart,
  };
}

/*
 * Explicitly join an active shift.
 *
 * This is the participation boundary that
 * creates authoritative attendance.
 *
 * The caller should reload
 * getTechnicianCurrentShift() after success
 * instead of constructing optimistic
 * attendance state locally.
 */
export async function joinShift(
  shiftId: string,
): Promise<ShiftJoinResult> {
  const normalizedShiftId =
    normalizeOperationalShiftId(
      shiftId,
    );

  const response =
    await fetch(
      `/api/operations/shifts/${encodeURIComponent(
        normalizedShiftId,
      )}/join`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      },
    );

  const data =
    await readApiResponse(
      response,
    );

  const result =
    requireSuccessfulResponse<
      ShiftJoinApiResponse
    >(
      response,
      data,
    );

  if (
    result.success !== true ||
    !isShiftApiRecord(
      result.attendance,
    )
  ) {
    throw new ShiftApiError(
      "The shift-join response is invalid.",
      response.status,
    );
  }

  const attendance =
    result.attendance;

  const {
    id,
    shiftId:
      attendanceShiftId,
    technicianId,
    status,
    participationAuthority,
    recordedAt,
  } = attendance;

  if (
    typeof technicianId !== "string" ||
    !technicianId.trim() ||
    attendanceShiftId !==
      normalizedShiftId ||
    id !==
      `${normalizedShiftId}_${technicianId}` ||
    status !==
      ATTENDANCE_STATUSES.PRESENT ||
    !isAllowedParticipationAuthority(
      participationAuthority,
    ) ||
    !isCanonicalShiftApiTimestamp(
      recordedAt,
    )
  ) {
    throw new ShiftApiError(
      "The shift-join response is invalid.",
      response.status,
    );
  }

  return {
    id,
    shiftId:
      attendanceShiftId,
    technicianId,
    status,
    participationAuthority,
    recordedAt,
  };
}
