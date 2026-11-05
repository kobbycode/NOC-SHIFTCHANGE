
import "server-only";

import {
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

import {
  markActionedByReference,
} from "@/lib/notifications/notification-service";

import {
  NOTIFICATION_EVENT_KINDS,
} from "@/types/notification";

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
  _request: Request,
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
        "Only eligible technicians can accept task assignments.",
        403
      );
    }

    /*
     * PHASE 2:
     * Read the authoritative route
     * identifiers.
     */

    const {
      taskId,
      assignmentId,
    } = await context.params;

    /*
     * PHASE 3:
     * Execute the transactional
     * acceptance service.
     *
     * The service verifies that the
     * assignment belongs to actor.uid.
     */

    const assignment =
      await respondToTaskAssignment({
        taskId,

        assignmentId,

        technicianUid:
          actor.uid,

        action:
          "accept",
      });

    // Best-effort ONLY after the authoritative acceptance committed. Gated by
    // NOTIFICATIONS_ENABLED internally and never in the transaction; a failure
    // here cannot affect the accepted assignment.
    await markActionedByReference(actor.uid, {
      eventKinds: [
        NOTIFICATION_EVENT_KINDS.TASK_ASSIGNED,
        NOTIFICATION_EVENT_KINDS.TASK_REASSIGNED,
      ],
      taskId,
    }, new Date().toISOString()).catch(() => {});

    return NextResponse.json(
      {
        success: true,

        message:
          "Task assignment accepted successfully.",

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
      "Task acceptance API error:",
      error
    );

    return errorResponse(
      "The task acceptance request could not be completed.",
      500
    );
  }
}