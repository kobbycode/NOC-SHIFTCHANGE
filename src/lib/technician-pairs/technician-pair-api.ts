import type {
  CreateTechnicianPairInput,
  TechnicianPairCreateResult,
  TechnicianPairDeactivateResult,
} from "@/lib/technician-pairs/technician-pair-api-types";
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

function requireSuccessfulResponse<
  T extends { success: boolean }
>(
  response: Response,
  data: unknown
): T {
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

  return data as T;
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
    requireSuccessfulResponse<TechnicianPairListApiResponse>(
      response,
      data
    );

  if (
    result.success !== true ||
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

/**
 * Request creation of one permanent technician pair.
 *
 * This client sends only technicianIds. All authoritative
 * actor, technician eligibility, reservation, pair status,
 * timestamp, audit, and account-state decisions remain on
 * the server.
 */
export async function createTechnicianPair(
  input: CreateTechnicianPairInput
) {
  const response =
    await fetch(
      "/api/operations/technician-pairs",
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          technicianIds:
            input.technicianIds,
        }),
      }
    );

  const data =
    await readApiResponse(
      response
    );

  const result =
    requireSuccessfulResponse<TechnicianPairCreateResult>(
      response,
      data
    );

  if (
    result.success !== true ||
    !result.pair
  ) {
    throw new TechnicianPairApiError(
      "The technician pair could not be created.",
      response.status
    );
  }

  return result;
}

/**
 * Request deactivation of one permanent technician pair.
 *
 * The pair identifier is carried only in the route path.
 * No mutation body, actor identity, lifecycle state,
 * reservation data, timestamps, audit data, attendance,
 * or account-state data are supplied by the client.
 *
 * The server-side transactional service remains authoritative.
 */
export async function deactivateTechnicianPair(
  pairId: string
): Promise<TechnicianPairDeactivateResult> {
  const response =
    await fetch(
      `/api/operations/technician-pairs/${encodeURIComponent(
        pairId
      )}/deactivate`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      }
    );

  const data =
    await readApiResponse(
      response
    );

  const result =
    requireSuccessfulResponse<TechnicianPairDeactivateResult>(
      response,
      data
    );

  if (
    result.success !== true ||
    !result.pair
  ) {
    throw new TechnicianPairApiError(
      "The technician pair could not be deactivated.",
      response.status
    );
  }

  return result;
}
