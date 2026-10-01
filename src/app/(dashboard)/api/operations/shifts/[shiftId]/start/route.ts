
import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  startShift,
} from "@/lib/operations/start-shift";

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
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  /*
   * PHASE 1:
   * Authenticate the current user.
   *
   * getCurrentUser verifies the Firebase
   * session cookie, account status,
   * role, and pending account operations.
   */

  const actor = await getCurrentUser();

  if (!actor) {
    return errorResponse(
      "Please sign in to continue.",
      401
    );
  }

  /*
   * PHASE 2:
   * Enforce role-based authorization.
   */

  if (
    actor.role !== "admin" &&
    actor.role !== "supervisor" &&
    actor.role !== "technician"
  ) {
    return errorResponse(
      "Only administrators, supervisors, or an explicitly authorized temporary technician can start shifts.",
      403
    );
  }

  /*
   * Prevent users from performing operational
   * actions before completing their mandatory
   * initial password change.
   */

  if (actor.mustChangePassword) {
    return errorResponse(
      "Please change your initial password before starting a shift.",
      403
    );
  }

  /*
   * PHASE 3:
   * Validate the shift identifier.
   */

  const { shiftId } = await context.params;

  if (
    typeof shiftId !== "string" ||
    shiftId.length === 0 ||
    shiftId.length > 512 ||
    shiftId.includes("/") ||
    shiftId === "." ||
    shiftId === ".."
  ) {
    return errorResponse(
      "Please provide a valid shift identifier.",
      400
    );
  }

  /*
   * PHASE 4:
   * Validate the request origin.
   *
   * The session cookie uses SameSite=Lax.
   * This additional check rejects requests
   * with a foreign Origin.
   *
   * The application should also enforce
   * HTTPS in production.
   */

  const origin = request.headers.get(
    "origin"
  );

  if (origin) {
    const expectedOrigin =
      request.nextUrl.origin;

    if (origin !== expectedOrigin) {
      return errorResponse(
        "This request is not allowed.",
        403
      );
    }
  }

  /*
   * PHASE 5:
   * Invoke the authoritative operational
   * service.
   *
   * Do not write directly to the shifts
   * or technician_schedules collections.
   *
   * startShift performs its own
   * transactional authorization,
   * eligibility, membership, and
   * scheduling checks.
   */

  try {
    const result = await startShift({
      shiftId,
      actorUid: actor.uid,
    });

    /*
     * PHASE 6:
     * Return the successful transition.
     */

    return NextResponse.json(
      {
        success: true,

        message:
          "Shift started successfully.",

        shift: {
          id: result.shiftId,

          status: result.status,

          actualStart:
            result.actualStart,
        },
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    /*
     * PHASE 7:
     * Return known operational errors
     * without exposing Firebase internals.
     */

    if (
      error instanceof
      AssignmentOperationError
    ) {
      return errorResponse(
        error.message,
        error.status
      );
    }

    /*
     * Unexpected errors must be logged
     * server-side, not exposed to clients.
     */

    console.error(
      "Shift activation failed:",
      {
        shiftId,
        actorUid: actor.uid,
        error,
      }
    );

    return errorResponse(
      "The shift could not be started. Please try again or contact an administrator.",
      500
    );
  }
}