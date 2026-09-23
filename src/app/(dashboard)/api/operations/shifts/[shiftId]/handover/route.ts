
import "server-only";

import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  beginShiftHandover,
} from "@/lib/operations/begin-shift-handover";

import {
  AssignmentOperationError,
} from "@/lib/operations/assignment-transaction";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    shiftId: string;
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
  /*
   * Authenticate the current session.
   */

  const actor = await getCurrentUser();

  if (!actor) {
    return errorResponse(
      "Please sign in to continue.",
      401
    );
  }

  /*
   * Only administrators and supervisors
   * may begin shift handover.
   */

  if (
    actor.role !== "admin" &&
    actor.role !== "supervisor"
  ) {
    return errorResponse(
      "Your account is not authorized to begin shift handover.",
      403
    );
  }

  if (actor.mustChangePassword) {
    return errorResponse(
      "Please complete your password change before continuing.",
      403
    );
  }

  /*
   * Validate the requested shift identifier.
   */

  const { shiftId } =
    await context.params;

  if (
    !shiftId ||
    shiftId.includes("/") ||
    shiftId.length > 512
  ) {
    return errorResponse(
      "Please provide a valid shift.",
      400
    );
  }

  /*
   * The authenticated session supplies
   * the acting user's identity.
   *
   * Do not accept actorUid from
   * the request body.
   */

  try {
    const result =
      await beginShiftHandover({
        shiftId,
        actorUid: actor.uid,
      });

    return NextResponse.json(
      {
        success: true,

        message:
          "Shift handover started successfully.",

        shift: {
          id: result.shiftId,

          status: result.status,

          handoverStartedAt:
            result.handoverStartedAt,
        },
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
      "Shift handover failed:",
      error
    );

    return errorResponse(
      "Shift handover could not be started. Please try again.",
      500
    );
  }
}