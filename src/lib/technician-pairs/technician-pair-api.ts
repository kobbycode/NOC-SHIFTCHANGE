import type {
  TechnicianPairListApiResponse,
  TechnicianPairListResult,
} from "./technician-pair-api-types";

export class TechnicianPairApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);

    this.name =
      "TechnicianPairApiError";
  }
}

async function readApiResponse(
  response: Response
): Promise<unknown> {
  const contentType =
    response.headers.get(
      "content-type"
    );

  if (
    !contentType
      ?.toLowerCase()
      .includes("application/json")
  ) {
    throw new TechnicianPairApiError(
      "The server returned an unexpected response.",
      response.status
    );
  }

  try {
    return await response.json();
  } catch {
    throw new TechnicianPairApiError(
      "The server returned invalid JSON.",
      response.status
    );
  }
}

function requireSuccessfulResponse(
  response: Response,
  data: unknown
): TechnicianPairListApiResponse & {
  success: true;
} {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("success" in data)
  ) {
    throw new TechnicianPairApiError(
      "The server returned an invalid response.",
      response.status
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

    throw new TechnicianPairApiError(
      message,
      response.status
    );
  }

  return data as TechnicianPairListApiResponse & {
    success: true;
  };
}

/**
 * Retrieve the permanent technician-pair
 * domain visible to the current manager.
 *
 * This is a read-only API call.
 *
 * Pair membership is not shift attendance.
 */
export async function getTechnicianPairs():
  Promise<TechnicianPairListResult> {
  const response =
    await fetch(
      "/api/operations/technician-pairs",
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      }
    );

  const data =
    await readApiResponse(
      response
    );

  const result =
    requireSuccessfulResponse(
      response,
      data
    );

  if (
    !Array.isArray(result.pairs) ||
    typeof result.total !== "number" ||
    result.total !== result.pairs.length
  ) {
    throw new TechnicianPairApiError(
      "The technician-pair retrieval response is invalid.",
      response.status
    );
  }

  return {
    pairs: result.pairs,
    total: result.total,
  };
}