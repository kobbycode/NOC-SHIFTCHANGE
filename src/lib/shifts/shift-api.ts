import type {
  ShiftCompletionApiResponse,
  ShiftCompletionResult,
  ShiftHandoverApiResponse,
  ShiftHandoverResult,
  ShiftListApiResponse,
  ShiftListResult,
  ShiftMemberListApiResponse,
  ShiftMemberListResult,
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
