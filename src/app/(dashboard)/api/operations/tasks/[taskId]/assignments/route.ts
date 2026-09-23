
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
  createTaskAssignment,
} from "@/lib/operations/create-task-assignment";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    taskId: string;
  }>;
};

/*
 * ShiftChange 2.0
 *
 * Controlled task-assignment API.
 *
 * Permanent account revocation
 * remains disabled.
 */

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
     * Authenticate the acting user.
     */

    const actor = await getCurrentUser();

    if (!actor) {
      return errorResponse(
        "Authentication is required.",
        401
      );
    }

    if (
      actor.mustChangePassword ||
      !["admin", "supervisor"].includes(
        actor.role
      )
    ) {
      return errorResponse(
        "You are not authorized to assign tasks.",
        403
      );
    }

    /*
     * PHASE 2:
     * Validate the task identifier.
     */

    const { taskId } =
      await context.params;

    if (
      !taskId ||
      taskId.trim().length === 0 ||
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
      body = await request.json();
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
        "Invalid request data.",
        400
      );
    }

    const input =
      body as Record<string, unknown>;

    const technicianUid =
      input.technicianUid;

    const responsibility =
      input.responsibility;

    if (
      typeof technicianUid !==
        "string" ||
      technicianUid.trim().length === 0 ||
      technicianUid.length > 128 ||
      technicianUid.includes("/")
    ) {
      return errorResponse(
        "Please select a valid technician.",
        400
      );
    }

    if (
      responsibility !== "lead" &&
      responsibility !== "support"
    ) {
      return errorResponse(
        "Please select a valid task responsibility.",
        400
      );
    }

    /*
     * PHASE 4:
     * Execute the authoritative
     * assignment transaction.
     *
     * The service revalidates the
     * actor and technician accounts
     * inside Firestore.
     */

    const assignment =
      await createTaskAssignment({
        taskId,

        technicianUid,

        responsibility,

        assignedBy: actor.uid,
      });

    /*
     * PHASE 5:
     * Return the created assignment.
     */

    return NextResponse.json(
      {
        success: true,

        message:
          "Task assigned successfully.",

        assignment,
      },
      {
        status: 201,
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
      "Task-assignment API error:",
      error
    );

    return errorResponse(
      "The task-assignment request could not be completed.",
      500
    );
  }
}