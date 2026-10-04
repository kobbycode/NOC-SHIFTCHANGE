import "server-only";

import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  recoverExpiredScheduledShift,
} from "@/lib/operations/recover-expired-scheduled-shift";

import {
  AssignmentOperationError,
} from "@/lib/operations/assignment-transaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
   * This endpoint intentionally accepts
   * no request body. The authenticated
   * session is the only actor authority.
   */

  void request;

  const actor =
    await getCurrentUser();

  if (!actor) {
    return errorResponse(
      "Please sign in to continue.",
      401
    );
  }

  /*
   * Expired scheduled-shift recovery is
   * deliberately administrator-only.
   *
   * Supervisors must not receive this
   * exceptional recovery authority.
   */

  if (actor.role !== "admin") {
    return errorResponse(
      "Only authorized administrators can recover an expired scheduled shift.",
      403
    );
  }

  if (actor.mustChangePassword) {
    return errorResponse(
      "Please complete your password change before continuing.",
      403
    );
  }

  const {
    shiftId,
  } = await context.params;

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
   * The service revalidates administrator
   * authority and every operational
   * recovery invariant inside Firestore.
   */

  try {
    const result =
      await recoverExpiredScheduledShift({
        shiftId,
        actorUid: actor.uid,
      });

    return NextResponse.json(
      {
        success: true,

        message:
          "Expired scheduled shift recovered successfully.",

        shift: {
          id: shiftId,
          status: result.status,
          cancelledAt:
            result.cancelledAt,
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
      "Expired scheduled shift recovery failed:",
      error
    );

    return errorResponse(
      "The expired scheduled shift could not be recovered. Administrator review is required.",
      500
    );
  }
}
