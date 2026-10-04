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
  getTechnicianCurrentShift,
} from "@/lib/operations/get-technician-current-shift";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        "Cache-Control":
          "no-store",
      },
    },
  );
}

export async function GET() {
  const actor =
    await getCurrentUser();

  if (!actor) {
    return errorResponse(
      "Authentication is required.",
      401,
    );
  }

  if (
    actor.role !== "technician"
  ) {
    return errorResponse(
      "Only technicians can retrieve a technician current shift.",
      403,
    );
  }

  if (
    actor.mustChangePassword
  ) {
    return errorResponse(
      "Please change your initial password before accessing your shift.",
      403,
    );
  }

  try {
    const currentShift =
      await getTechnicianCurrentShift(
        actor,
      );

    return NextResponse.json(
      {
        success: true,
        currentShift,
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
      "Technician current-shift retrieval failed:",
      {
        actorUid:
          actor.uid,
        error,
      },
    );

    return errorResponse(
      "Your current shift could not be retrieved.",
      500,
    );
  }
}
