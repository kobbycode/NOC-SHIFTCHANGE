
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
  respondToTaskAssignment,
} from "@/lib/operations/respond-to-task-assignment";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    taskId: string;
    assignmentId: string;
  }>;
};

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
     * Authenticate the acting technician.
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
      actor.role !== "technician" ||
      actor.mustChangePassword
    ) {
      return errorResponse(
        "Only eligible technicians can reject task assignments.",
        403
      );
    }

    /*
     * PHASE 2:
     * Validate the rejection request.
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

    const rejectionReason =
      input.rejectionReason;

    if (
      typeof rejectionReason !== "string" ||
      rejectionReason.trim().length < 5 ||
      rejectionReason.trim().length > 1000
    ) {
      return errorResponse(
        "Please provide a rejection reason between 5 and 1000 characters.",
        400
      );
    }

    /*
     * PHASE 3:
     * Read the route identifiers.
     */

    const {
      taskId,
      assignmentId,
    } = await context.params;

    /*
     * PHASE 4:
     * Execute the authoritative
     * rejection transaction.
     */

    const assignment =
      await respondToTaskAssignment({
        taskId,

        assignmentId,

        technicianUid:
          actor.uid,

        action:
          "reject",

        rejectionReason:
          rejectionReason.trim(),
      });

    return NextResponse.json(
      {
        success: true,

        message:
          "Task assignment rejected successfully. The operational responsibility remains pending administrator review.",

        assignment,
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
      "Task rejection API error:",
      error
    );

    return errorResponse(
      "The task rejection request could not be completed.",
      500
    );
  }
}