
import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  createShiftMember,
} from "@/lib/operations/create-shift-member";

import {
  AssignmentOperationError,
} from "@/lib/operations/assignment-transaction";

import {
  SHIFT_MEMBER_ROLES,
} from "@/types/shift";

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

function isValidId(
  value: unknown,
  maxLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/")
  );
}

export async function POST(
  request: NextRequest,
  context: RouteContext
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
      "Only administrators and supervisors can manage shift memberships.",
      403
    );
  }

  if (actor.mustChangePassword) {
    return errorResponse(
      "Please change your initial password before managing shifts.",
      403
    );
  }

  /*
   * PHASE 3:
   * Check the request origin.
   *
   * APP_ORIGIN must be configured to the
   * trusted HTTPS application origin
   * in production.
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
   * Validate the shift identifier.
   */

  const { shiftId } = await context.params;

  if (!isValidId(shiftId, 512)) {
    return errorResponse(
      "Please provide a valid shift identifier.",
      400
    );
  }

  /*
   * PHASE 5:
   * Parse the request body.
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
      "Please provide valid shift membership details.",
      400
    );
  }

  const input = body as Record<
    string,
    unknown
  >;

  const technicianUid =
    input.technicianUid;

  const role = input.role;

  /*
   * PHASE 6:
   * Validate membership details.
   */

  if (!isValidId(technicianUid, 128)) {
    return errorResponse(
      "Please select a valid technician.",
      400
    );
  }

  if (
    role !== SHIFT_MEMBER_ROLES.PRIMARY &&
    role !== SHIFT_MEMBER_ROLES.ADDITIONAL
  ) {
    return errorResponse(
      "Please select a valid shift membership role.",
      400
    );
  }

  /*
   * PHASE 7:
   * Invoke the existing transactional
   * membership service.
   *
   * Never trust an assignedBy value
   * supplied in the request body.
   */

  try {
    const member =
      await createShiftMember({
        shiftId,
        technicianUid,
        role,
        assignedBy: actor.uid,
      });

    return NextResponse.json(
      {
        success: true,

        message:
          "Technician assigned to the shift successfully.",

        member,
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    /*
     * Return known operational errors
     * as clear English messages.
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
     * Unexpected errors are logged
     * server-side.
     */

    console.error(
      "Shift membership creation failed:",
      {
        shiftId,
        technicianUid,
        actorUid: actor.uid,
        error,
      }
    );

    return errorResponse(
      "The technician could not be assigned to the shift. Please try again or contact an administrator.",
      500
    );
  }
}