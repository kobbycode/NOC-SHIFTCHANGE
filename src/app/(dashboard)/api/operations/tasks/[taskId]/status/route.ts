
import "server-only";

import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  AssignmentOperationError,
} from "@/lib/operations/assignment-transaction";

import {
  transitionTask,
  type TaskLifecycleAction,
} from "@/lib/operations/task-lifecycle";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    taskId: string;
  }>;
};

const VALID_ACTIONS:
  TaskLifecycleAction[] = [
    "start",
    "submit",
    "return",
    "complete",
    "cancel",
  ];

function errorResponse(
  message: string,
  status: number
) {
  return NextResponse.json(
    {
      success: false,
      error: message,
    },
    {
      status,
    }
  );
}

export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    /*
     * PHASE 1:
     * Authenticate the request.
     */

    const actor =
      await getCurrentUser();

    if (!actor) {
      return errorResponse(
        "Authentication is required.",
        401
      );
    }

    if (
      actor.mustChangePassword ||
      ![
        "admin",
        "supervisor",
        "technician",
      ].includes(actor.role)
    ) {
      return errorResponse(
        "You are not authorized to update tasks.",
        403
      );
    }

    /*
     * PHASE 2:
     * Validate the task identifier.
     */

    const {
      taskId,
    } = await context.params;

    if (
      !taskId ||
      !taskId.trim() ||
      taskId.length > 512 ||
      taskId.includes("/")
    ) {
      return errorResponse(
        "Please select a valid task.",
        400
      );
    }

    /*
     * PHASE 3:
     * Parse the request body.
     */

    let body: unknown;

    try {
      body =
        await request.json();
    } catch {
      return errorResponse(
        "Invalid request data.",
        400
      );
    }

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return errorResponse(
        "Please provide valid task details.",
        400
      );
    }

    const input =
      body as Record<
        string,
        unknown
      >;

    const action =
      input.action;

    const reason =
      input.reason;

    /*
     * PHASE 4:
     * Validate the lifecycle action.
     */

    if (
      typeof action !== "string" ||
      !VALID_ACTIONS.includes(
        action as TaskLifecycleAction
      )
    ) {
      return errorResponse(
        "Please select a valid task action.",
        400
      );
    }

    if (
      reason !== undefined &&
      typeof reason !== "string"
    ) {
      return errorResponse(
        "Please provide a valid reason.",
        400
      );
    }

    /*
     * PHASE 5:
     * Execute the authoritative
     * lifecycle transaction.
     */

    const result =
      await transitionTask({
        taskId,

        actorUid:
          actor.uid,

        action:
          action as TaskLifecycleAction,

        reason:
          reason as
            string | undefined,
      });

    /*
     * PHASE 6:
     * Return the committed result.
     */

    return NextResponse.json(
      {
        success: true,

        message:
          "Task status updated successfully.",

        result,
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    if (
      error instanceof
        AssignmentOperationError
    ) {
      return errorResponse(
        error.message,
        error.status
      );
    }

    console.error(
      "Task lifecycle API error:",
      error
    );

    return errorResponse(
      "The task status could not be updated.",
      500
    );
  }
}