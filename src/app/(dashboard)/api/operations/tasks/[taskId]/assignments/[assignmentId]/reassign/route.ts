
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
  reassignTask,
} from "@/lib/operations/reassign-task";

import {
  getTaskAssignmentId,
} from "@/lib/operations/assignment-identity";

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

function validIdentifier(
  value: unknown,
  maxLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !value.includes("/")
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
      ].includes(actor.role)
    ) {
      return errorResponse(
        "You are not authorized to reassign tasks.",
        403
      );
    }

    /*
     * PHASE 2:
     * Validate route parameters.
     */

    const {
      taskId,
      assignmentId,
    } = await context.params;

    if (
      !validIdentifier(taskId, 512) ||
      !validIdentifier(
        assignmentId,
        1500
      )
    ) {
      return errorResponse(
        "Please select a valid assignment.",
        400
      );
    }

    /*
     * PHASE 3:
     * Parse request data.
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
        "Invalid request data.",
        400
      );
    }

    const input =
      body as Record<
        string,
        unknown
      >;

    const originalTechnicianUid =
      input.originalTechnicianUid;

    const replacementTechnicianUid =
      input.replacementTechnicianUid;

    const reason =
      input.reason;

    if (
      !validIdentifier(
        originalTechnicianUid,
        128
      ) ||
      !validIdentifier(
        replacementTechnicianUid,
        128
      )
    ) {
      return errorResponse(
        "Please select valid technicians.",
        400
      );
    }

    if (
      typeof reason !== "string" ||
      reason.trim().length < 10 ||
      reason.trim().length > 1000
    ) {
      return errorResponse(
        "Please provide a reassignment reason between 10 and 1000 characters.",
        400
      );
    }

    /*
     * Verify that the requested
     * assignment belongs to the
     * original technician and task.
     */

    const expectedAssignmentId =
      getTaskAssignmentId(
        taskId,
        originalTechnicianUid
      );

    if (
      assignmentId !==
      expectedAssignmentId
    ) {
      return errorResponse(
        "The selected assignment does not match the original technician.",
        400
      );
    }

    /*
     * PHASE 4:
     * Execute the authoritative
     * reassignment transaction.
     */

    const result =
      await reassignTask({
        taskId,

        originalTechnicianUid,

        replacementTechnicianUid,

        performedBy:
          actor.uid,

        reason:
          reason.trim(),
      });

    return NextResponse.json(
      {
        success: true,

        message:
          "Task reassigned successfully.",

        previousAssignmentId:
          result.previousAssignmentId,

        replacementAssignment:
          result.replacementAssignment,

        releasedAt:
          result.releasedAt,
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
      "Task reassignment API error:",
      error
    );

    return errorResponse(
      "The task reassignment could not be completed.",
      500
    );
  }
}