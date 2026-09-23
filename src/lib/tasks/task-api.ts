import type {
  TaskListResult,
  TaskListApiResponse,
  CreateTaskInput,
  CreateTaskApiResponse,
  CreateTaskAssignmentInput,
  CreateTaskAssignmentApiResponse,
} from "./task-api-types";

/*
 * Shared API error.
 *
 * Preserves the HTTP status so that
 * frontend components can distinguish
 * authentication, authorization,
 * validation, and operational conflicts.
 */

export class TaskApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);

    this.name = "TaskApiError";
  }
}

/*
 * Read a JSON response safely.
 *
 * An unexpected HTML response, such
 * as a missing Next.js route, must not
 * crash the frontend JSON parser.
 */

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
    throw new TaskApiError(
      "The server returned an unexpected response.",
      response.status
    );
  }

  try {
    return await response.json();
  } catch {
    throw new TaskApiError(
      "The server returned invalid JSON.",
      response.status
    );
  }
}

/*
 * Validate the standard API response.
 */

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
    throw new TaskApiError(
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

    throw new TaskApiError(
      message,
      response.status
    );
  }

  return data as T;
}

/*
 * Retrieve tasks visible to the
 * currently authenticated user.
 *
 * The server determines task visibility
 * according to the user's role.
 */

export async function getTasks():
  Promise<TaskListResult> {
  const response = await fetch(
    "/api/operations/tasks",
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
      TaskListApiResponse
    >(
      response,
      data
    );

  if (
    result.success !== true ||
    !Array.isArray(result.tasks) ||
    typeof result.total !== "number"
  ) {
    throw new TaskApiError(
      "The task retrieval response is invalid.",
      response.status
    );
  }

  return {
    tasks: result.tasks,

    total: result.total,
  };
}

/*
 * Create a new operational task.
 *
 * Only administrators and supervisors
 * are authorized by the backend.
 */

export async function createOperationalTask(
  input: CreateTaskInput
): Promise<
  CreateTaskApiResponse & {
    success: true;
  }
> {
  const response = await fetch(
    "/api/operations/tasks",
    {
      method: "POST",

      credentials: "same-origin",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify(input),
    }
  );

  const data =
    await readApiResponse(response);

  const result =
    requireSuccessfulResponse<
      CreateTaskApiResponse
    >(
      response,
      data
    );

  if (
    result.success !== true ||
    !result.task
  ) {
    throw new TaskApiError(
      "The task creation response is invalid.",
      response.status
    );
  }

  return result;
}

/*
 * Create a technician assignment.
 *
 * The server validates the technician,
 * task, actor, and assignment state
 * inside the authoritative transaction.
 */

export async function assignOperationalTask(
  taskId: string,
  input: CreateTaskAssignmentInput
): Promise<
  CreateTaskAssignmentApiResponse & {
    success: true;
  }
> {
  if (
    !taskId ||
    taskId.includes("/")
  ) {
    throw new TaskApiError(
      "Please select a valid task.",
      400
    );
  }

  const response = await fetch(
    `/api/operations/tasks/${
      encodeURIComponent(taskId)
    }/assignments`,
    {
      method: "POST",

      credentials: "same-origin",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify(input),
    }
  );

  const data =
    await readApiResponse(response);

  const result =
    requireSuccessfulResponse<
      CreateTaskAssignmentApiResponse
    >(
      response,
      data
    );

  if (
    result.success !== true ||
    !result.assignment
  ) {
    throw new TaskApiError(
      "The task assignment response is invalid.",
      response.status
    );
  }

  return result;
}