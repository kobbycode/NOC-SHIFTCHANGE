
import "server-only";

import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  transitionTask,
  type TaskLifecycleAction,
} from "@/lib/operations/task-lifecycle";

import {
  AssignmentOperationError,
} from "@/lib/operations/assignment-transaction";

export const runtime = "nodejs";

/*
 * AUTHORITATIVE TASK LIFECYCLE API
 *
 * All lifecycle transitions must
 * execute through the server-side
 * transactional service.
 */

interface RouteContext {
  params: Promise<{
    taskId: string;
  }>;
}

const VALID_ACTIONS = [
  "start",
  "submit",
  "return",
  "complete",
  "cancel",
] as const;

function isLifecycleAction(
  value: unknown
): value is TaskLifecycleAction {
  return (
    typeof value === "string" &&
    VALID_ACTIONS.some(
      (action) => action === value
    )
  );
}

function validIdentifier(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !value.includes("/")
  );
}

export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  /*
   * PHASE 1:
   * Authenticate the request.
   */

  const user =
    await getCurrentUser();

  if (!user) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Authentication is required.",
      },
      {
        status: 401,
      }
    );
  }

  /*
   * PHASE 2:
   * Validate the current session.
   *
   * The authoritative service will
   * independently validate the
   * account inside its transaction.
   */

  if (
    user.mustChangePassword ||
    ![
      "admin",
      "supervisor",
      "technician",
    ].includes(user.role)
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "You are not authorized to perform task lifecycle operations.",
      },
      {
        status: 403,
      }
    );
  }

  /*
   * PHASE 3:
   * Validate the task identifier.
   */

  const {
    taskId,
  } = await context.params;

  if (
    !validIdentifier(taskId)
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Please provide a valid task identifier.",
      },
      {
        status: 400,
      }
    );
  }

  /*
   * PHASE 4:
   * Parse the request body.
   */

  let body: unknown;

  try {
    body =
      await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error:
          "Please provide a valid JSON request body.",
      },
      {
        status: 400,
      }
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Please provide valid task lifecycle details.",
      },
      {
        status: 400,
      }
    );
  }

  const data =
    body as Record<
      string,
      unknown
    >;

  /*
   * PHASE 5:
   * Validate the lifecycle action.
   */

  if (
    !isLifecycleAction(
      data.action
    )
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Please select a valid task lifecycle action.",
      },
      {
        status: 400,
      }
    );
  }

  const action =
    data.action;

  /*
   * PHASE 6:
   * Validate the optional reason.
   */

  if (
    data.reason !== undefined &&
    typeof data.reason !== "string"
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Please provide a valid reason.",
      },
      {
        status: 400,
      }
    );
  }

  const reason =
    typeof data.reason === "string"
      ? data.reason.trim()
      : undefined;

  if (
    reason !== undefined &&
    reason.length > 1000
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "The reason cannot exceed 1000 characters.",
      },
      {
        status: 400,
      }
    );
  }

  if (
    (
      action === "return" ||
      action === "cancel"
    ) &&
    (
      !reason ||
      reason.length < 10
    )
  ) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Please provide a reason of at least 10 characters.",
      },
      {
        status: 400,
      }
    );
  }

  /*
   * PHASE 7:
   * Execute the authoritative
   * task lifecycle service.
   */

  try {
    const result =
      await transitionTask({
        taskId,

        actorUid:
          user.uid,

        action,

        reason,
      });

    return NextResponse.json(
      {
        success: true,

        message:
          "Task lifecycle updated successfully.",

        result,
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    /*
     * Return expected operational
     * errors without exposing
     * internal server information.
     */

    if (
      error instanceof
      AssignmentOperationError
    ) {
      return NextResponse.json(
        {
          success: false,

          error:
            error.message,
        },
        {
          status:
            error.status,
        }
      );
    }

    console.error(
      "Task lifecycle operation failed:",
      error
    );

    return NextResponse.json(
      {
        success: false,

        error:
          "The task lifecycle operation could not be completed.",
      },
      {
        status: 500,
      }
    );
  }
}