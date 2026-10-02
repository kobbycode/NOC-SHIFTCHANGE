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
  listShiftAttendance,
} from "@/lib/operations/list-shift-attendance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    shiftId: string;
  }>;
};

function errorResponse(
  message: string,
  status: number,
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
    },
  );
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
) {
  const actor =
    await getCurrentUser();

  if (!actor) {
    return errorResponse(
      "Authentication is required.",
      401,
    );
  }

  if (actor.mustChangePassword) {
    return errorResponse(
      "You must change your password before accessing attendance.",
      403,
    );
  }

  if (
    actor.role !== "admin" &&
    actor.role !== "supervisor"
  ) {
    return errorResponse(
      "You are not authorized to retrieve attendance.",
      403,
    );
  }

  const { shiftId } =
    await context.params;

  try {
    const result =
      await listShiftAttendance(
        actor,
        shiftId,
      );

    return NextResponse.json(
      {
        success: true,
        attendance:
          result.attendance,
        total: result.total,
      },
      {
        status: 200,
        headers: {
          "Cache-Control":
            "no-store",
        },
      },
    );
  } catch (error) {
    if (
      error instanceof
      AssignmentOperationError
    ) {
      return errorResponse(
        error.message,
        error.status,
      );
    }

    console.error(
      "Shift attendance retrieval failed:",
      {
        shiftId,
        actorUid: actor.uid,
        error,
      },
    );

    return errorResponse(
      "Attendance could not be retrieved.",
      500,
    );
  }
}