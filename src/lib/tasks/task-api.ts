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
    public readonly status: number,
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

async function readApiResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");

  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new TaskApiError(
      "The server returned an unexpected response.",
      response.status,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new TaskApiError(
      "The server returned invalid JSON.",
      response.status,
    );
  }
}

/*
 * Validate the standard API response.
 */

function requireSuccessfulResponse<T extends { success: boolean }>(
  response: Response,
  data: unknown,
): T {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("success" in data)
  ) {
    throw new TaskApiError(
      "The server returned an invalid response.",
      response.status,
    );
  }

  const result = data as Record<string, unknown>;

  if (!response.ok || result.success !== true) {
    const message =
      typeof result.error === "string"
        ? result.error
        : "The requested operation failed.";

    throw new TaskApiError(message, response.status);
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

export async function getTasks(): Promise<TaskListResult> {
  const response = await fetch("/api/operations/tasks", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });

  const data = await readApiResponse(response);

  const result = requireSuccessfulResponse<TaskListApiResponse>(response, data);

  if (
    result.success !== true ||
    !Array.isArray(result.tasks) ||
    typeof result.total !== "number"
  ) {
    throw new TaskApiError(
      "The task retrieval response is invalid.",
      response.status,
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

export async function createOperationalTask(input: CreateTaskInput): Promise<
  CreateTaskApiResponse & {
    success: true;
  }
> {
  const response = await fetch("/api/operations/tasks", {
    method: "POST",

    credentials: "same-origin",

    cache: "no-store",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify(input),
  });

  const data = await readApiResponse(response);

  const result = requireSuccessfulResponse<CreateTaskApiResponse>(
    response,
    data,
  );

  if (result.success !== true || !result.task) {
    throw new TaskApiError(
      "The task creation response is invalid.",
      response.status,
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
  input: CreateTaskAssignmentInput,
): Promise<
  CreateTaskAssignmentApiResponse & {
    success: true;
  }
> {
  if (!taskId || taskId.includes("/")) {
    throw new TaskApiError("Please select a valid task.", 400);
  }

  const response = await fetch(
    `/api/operations/tasks/${encodeURIComponent(taskId)}/assignments`,
    {
      method: "POST",
      credentials: "same-origin",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify(input),
    },
  );

  const data = await readApiResponse(response);

  const result = requireSuccessfulResponse<CreateTaskAssignmentApiResponse>(
    response,
    data,
  );

  if (result.success !== true || !result.assignment) {
    throw new TaskApiError(
      "The task assignment response is invalid.",
      response.status,
    );
  }

  return result;
}

/*
 * Eligible technician retrieval.
 */

export interface EligibleTechnician {
  uid: string;
  fullName: string;
}

export interface EligibleTechniciansResult {
  technicians: EligibleTechnician[];
  total: number;
}

interface EligibleTechniciansApiResponse {
  success: boolean;
  technicians?: EligibleTechnician[];
  total?: number;
  error?: string;
}

export async function getEligibleTechnicians(): Promise<EligibleTechniciansResult> {
  const response = await fetch("/api/operations/technicians/eligible", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });

  const data = await readApiResponse(response);

  const result = requireSuccessfulResponse<EligibleTechniciansApiResponse>(
    response,
    data,
  );

  if (!Array.isArray(result.technicians) || typeof result.total !== "number") {
    throw new TaskApiError(
      "The technician retrieval response is invalid.",
      response.status,
    );
  }

  return {
    technicians: result.technicians,
    total: result.total,
  };
}

/*
 * Accept an operational task assignment.
 *
 * The backend independently validates
 * the authenticated technician,
 * assignment ownership, account status,
 * and task eligibility.
 */

export async function acceptOperationalTaskAssignment(
  taskId: string,
  assignmentId: string,
): Promise<void> {
  if (
    !taskId ||
    !assignmentId ||
    taskId.includes("/") ||
    assignmentId.includes("/")
  ) {
    throw new TaskApiError("Please select a valid task assignment.", 400);
  }

  const response = await fetch(
    `/api/operations/tasks/${encodeURIComponent(
      taskId,
    )}/assignments/${encodeURIComponent(assignmentId)}/accept`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    },
  );

  const data = await readApiResponse(response);

  const result = requireSuccessfulResponse<{
    success: boolean;
    message?: string;

    assignment?: {
      taskId: string;
      acceptanceStatus: string;
    };
  }>(response, data);

  if (
    result.success !== true ||
    result.assignment?.taskId !== taskId ||
    result.assignment?.acceptanceStatus !== "accepted"
  ) {
    throw new TaskApiError(
      "The assignment acceptance response is invalid.",
      response.status,
    );
  }
}

/*
 * Start an accepted operational task.
 *
 * The authenticated actor is determined
 * by the server-side session.
 *
 * The authoritative lifecycle service
 * validates account eligibility,
 * assignment ownership, responsibility,
 * and the permitted task transition.
 *
 * Permanent account revocation
 * remains disabled.
 */

export async function startOperationalTask(taskId: string): Promise<void> {
  if (
    !taskId ||
    taskId.trim().length === 0 ||
    taskId.length > 512 ||
    taskId.includes("/")
  ) {
    throw new TaskApiError("Please select a valid task.", 400);
  }

  const response = await fetch(
    `/api/operations/tasks/${encodeURIComponent(taskId)}/lifecycle`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        action: "start",
      }),
    },
  );

  const data = await readApiResponse(response);

  const result = requireSuccessfulResponse<{
    success: boolean;
    message?: string;

    result?: {
      taskId: string;
      previousStatus: string;
      status: string;
      performedBy: string;
      updatedAt: string;
    };
  }>(response, data);

  if (
    result.success !== true ||
    result.result?.taskId !== taskId ||
    result.result?.previousStatus !== "open" ||
    result.result?.status !== "in_progress" ||
    typeof result.result.performedBy !== "string" ||
    typeof result.result.updatedAt !== "string"
  ) {
    throw new TaskApiError(
      "The task-start response is invalid. Refresh the task list to verify its current state.",
      response.status,
    );
  }
}

/*
 * Submit an in-progress operational task
 * for supervisor verification.
 *
 * The server independently validates:
 *
 * - Authenticated technician identity
 * - Account eligibility
 * - Assignment ownership
 * - Accepted lead responsibility
 * - Permitted lifecycle transition
 *
 * Permanent account revocation
 * remains disabled.
 */

export async function submitOperationalTask(taskId: string): Promise<void> {
  if (
    !taskId ||
    taskId.trim().length === 0 ||
    taskId.length > 512 ||
    taskId.includes("/")
  ) {
    throw new TaskApiError("Please select a valid task.", 400);
  }

  const response = await fetch(
    `/api/operations/tasks/${encodeURIComponent(taskId)}/lifecycle`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        action: "submit",
      }),
    },
  );

  const data = await readApiResponse(response);

  const result = requireSuccessfulResponse<{
    success: boolean;
    message?: string;

    result?: {
      taskId: string;
      previousStatus: string;
      status: string;
      performedBy: string;
      updatedAt: string;
    };
  }>(response, data);

  if (
    result.success !== true ||
    result.result?.taskId !== taskId ||
    result.result?.previousStatus !== "in_progress" ||
    result.result?.status !== "pending_verification" ||
    typeof result.result.performedBy !== "string" ||
    typeof result.result.updatedAt !== "string"
  ) {
    throw new TaskApiError(
      "The task-submission response is invalid. Refresh the task list to verify its current state.",
      response.status,
    );
  }
}

/*
 * Complete a task after supervisor verification.
 *
 * The authoritative backend independently validates:
 *
 * - Authenticated administrator or supervisor
 * - Account eligibility
 * - Current task status
 * - Assignment integrity
 * - Shift-linked task restrictions
 *
 * Permanent account revocation remains disabled.
 */

export async function completeOperationalTask(taskId: string): Promise<void> {
  if (
    !taskId ||
    taskId.trim().length === 0 ||
    taskId.length > 512 ||
    taskId.includes("/")
  ) {
    throw new TaskApiError("Please select a valid task.", 400);
  }

  const response = await fetch(
    `/api/operations/tasks/${encodeURIComponent(taskId)}/lifecycle`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        action: "complete",
      }),
    },
  );

  const data = await readApiResponse(response);

  const result = requireSuccessfulResponse<{
    success: boolean;
    message?: string;

    result?: {
      taskId: string;
      previousStatus: string;
      status: string;
      performedBy: string;
      updatedAt: string;
    };
  }>(response, data);

  if (
    result.success !== true ||
    result.result?.taskId !== taskId ||
    result.result?.previousStatus !== "pending_verification" ||
    result.result?.status !== "completed" ||
    typeof result.result.performedBy !== "string" ||
    typeof result.result.updatedAt !== "string"
  ) {
    throw new TaskApiError(
      "The task-completion response is invalid. Refresh the task list to verify its current state.",
      response.status,
    );
  }
}

/*
 * LESSON 4C.9CH
 *
 * Return a submitted operational task
 * to the technician for corrections.
 *
 * This frontend helper only requests
 * the authoritative lifecycle transition.
 *
 * The backend independently validates:
 *
 * - Authenticated actor identity
 * - Administrator or supervisor role
 * - Active account eligibility
 * - Current task status
 * - Assignment integrity
 * - Shift-linked task restrictions
 * - Required return reason
 *
 * The permitted transition is:
 *
 * pending_verification -> in_progress
 *
 * The backend records the return reason,
 * return actor, return timestamp,
 * and authoritative lifecycle audit.
 *
 * Account-blocking safeguards remain active.
 *
 * Permanent account revocation
 * remains disabled.
 */

export async function returnOperationalTask(
  taskId: string,
  reason: string,
): Promise<void> {
  /*
   * PHASE 1:
   * Validate the task identifier.
   */

  if (
    !taskId ||
    taskId.trim().length === 0 ||
    taskId.length > 512 ||
    taskId.includes("/")
  ) {
    throw new TaskApiError("Please select a valid task.", 400);
  }

  /*
   * PHASE 2:
   * Validate the return reason.
   *
   * This provides immediate frontend
   * validation before contacting
   * the authoritative backend.
   */

  if (typeof reason !== "string") {
    throw new TaskApiError("Please provide a valid return reason.", 400);
  }

  const cleanReason = reason.trim();

  if (cleanReason.length < 10) {
    throw new TaskApiError(
      "Please provide a return reason of at least 10 characters.",
      400,
    );
  }

  if (cleanReason.length > 1000) {
    throw new TaskApiError(
      "The return reason cannot exceed 1000 characters.",
      400,
    );
  }

  /*
   * PHASE 3:
   * Request the authoritative
   * return transition.
   *
   * The server determines the actor
   * from the authenticated session.
   *
   * No actor UID, role, or account
   * status is supplied by the client.
   */

  const response = await fetch(
    `/api/operations/tasks/${encodeURIComponent(taskId)}/lifecycle`,
    {
      method: "POST",

      credentials: "same-origin",

      cache: "no-store",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        action: "return",
        reason: cleanReason,
      }),
    },
  );

  /*
   * PHASE 4:
   * Read the server response safely.
   */

  const data = await readApiResponse(response);

  /*
   * PHASE 5:
   * Validate the standard
   * API success response.
   *
   * Authentication failures,
   * authorization failures,
   * validation errors, and
   * operational conflicts are
   * preserved as TaskApiError.
   */

  const result = requireSuccessfulResponse<{
    success: boolean;

    message?: string;

    result?: {
      taskId: string;

      previousStatus: string;

      status: string;

      performedBy: string;

      updatedAt: string;
    };
  }>(response, data);

  /*
   * PHASE 6:
   * Validate the authoritative
   * lifecycle transition result.
   *
   * The return operation must move
   * the task from pending verification
   * back to in progress.
   *
   * A malformed success response
   * must not be treated as verified
   * completion of the operation.
   */

  if (
    result.success !== true ||
    result.result?.taskId !== taskId ||
    result.result?.previousStatus !== "pending_verification" ||
    result.result?.status !== "in_progress" ||
    typeof result.result.performedBy !== "string" ||
    result.result.performedBy.trim().length === 0 ||
    typeof result.result.updatedAt !== "string" ||
    Number.isNaN(Date.parse(result.result.updatedAt))
  ) {
    throw new TaskApiError(
      "The task-return response is invalid. Refresh the task list to verify its current state.",
      response.status,
    );
  }

  /*
   * PHASE 7:
   * The authoritative API has
   * confirmed the expected transition.
   *
   * The supervisor workspace will
   * independently refresh task data
   * before displaying the new state.
   */

  return;
}
