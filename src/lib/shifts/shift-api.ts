import type {
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
