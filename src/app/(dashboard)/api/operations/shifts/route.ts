
import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  createShift,
} from "@/lib/operations/create-shift";

import {
  listShifts,
} from "@/lib/operations/list-shifts";

import {
  AssignmentOperationError,
} from "@/lib/operations/assignment-transaction";

import {
  SHIFT_TYPES,
} from "@/types/shift";

export const runtime = "nodejs";

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

/**
 * Authoritative shift retrieval API.
 *
 * GET /api/operations/shifts
 *
 * Read-only.
 *
 * Permanent revocation remains disabled.
 */
export async function GET() {
  try {
    /*
     * PHASE 1:
     * Authenticate the current user.
     */
    const actor = await getCurrentUser();

    if (!actor) {
      return errorResponse(
        "Authentication is required.",
        401
      );
    }

    if (actor.mustChangePassword) {
      return errorResponse(
        "You must change your password before accessing shifts.",
        403
      );
    }

    /*
     * PHASE 2:
     * Retrieve authoritative shift data.
     *
     * Account state and role are
     * revalidated by listShifts().
     */
    const result =
      await listShifts(actor);

    /*
     * PHASE 3:
     * Return authorized results.
     */
    return NextResponse.json(
      {
        success: true,
        shifts: result.shifts,
        total: result.total,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
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
      "Shift retrieval failed:",
      error
    );

    return errorResponse(
      "Shifts could not be retrieved.",
      500
    );
  }
}

export async function POST(
  request: NextRequest
) {
  /*
   * PHASE 1:
   * Authenticate the current user.
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
    actor.role !== "supervisor"
  ) {
    return errorResponse(
      "Only administrators and supervisors can create shifts.",
      403
    );
  }

  if (actor.mustChangePassword) {
    return errorResponse(
      "Please change your initial password before creating shifts.",
      403
    );
  }

  /*
   * PHASE 3:
   * Require a same-origin browser request.
   *
   * The expected origin must be derived
   * from the trusted application origin
   * configured for the deployment.
   */

  const origin = request.headers.get(
    "origin"
  );

  const expectedOrigin =
    process.env.APP_ORIGIN ??
    request.nextUrl.origin;

  if (
    !origin ||
    origin !== expectedOrigin
  ) {
    return errorResponse(
      "This request is not allowed.",
      403
    );
  }

  /*
   * PHASE 4:
   * Parse and validate request data.
   */

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      "Please provide valid request data.",
      400
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return errorResponse(
      "Please provide valid shift details.",
      400
    );
  }

  const input = body as Record<
    string,
    unknown
  >;

  const {
    shiftType,
    scheduledStart,
    scheduledEnd,
    permanentPairId,
  } = input;

  if (
    Object.keys(input).length !== 4 ||
    typeof permanentPairId !== "string" ||
    !permanentPairId.trim() ||
    permanentPairId !== permanentPairId.trim() ||
    permanentPairId.length > 512 ||
    permanentPairId.includes("/")
  ) {
    return errorResponse(
      "Please select a valid permanent technician pair.",
      400
    );
  }

  if (
    shiftType !== SHIFT_TYPES.MORNING &&
    shiftType !== SHIFT_TYPES.NIGHT
  ) {
    return errorResponse(
      "Please select a valid shift type.",
      400
    );
  }

  if (
    typeof scheduledStart !== "string" ||
    typeof scheduledEnd !== "string"
  ) {
    return errorResponse(
      "Please provide valid shift start and end dates.",
      400
    );
  }

  /*
   * PHASE 5:
   * Invoke the authoritative transactional
   * shift creation service.
   */

  try {
    const shift = await createShift({
      shiftType,
      scheduledStart,
      scheduledEnd,
      permanentPairId,
      createdBy: actor.uid,
    });

    return NextResponse.json(
      {
        success: true,

        message:
          "Shift created successfully.",

        shift,
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store",
        },
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
      "Shift creation failed:",
      {
        actorUid: actor.uid,
        error,
      }
    );

    return errorResponse(
      "The shift could not be created. Please try again or contact an administrator.",
      500
    );
  }
}