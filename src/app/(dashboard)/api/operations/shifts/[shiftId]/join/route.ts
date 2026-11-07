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
  joinShift,
} from "@/lib/operations/join-shift";

import {
  requireTechnicianWriteAuthority,
} from "@/lib/operations/technician-write-authority-firestore";

import {
  normalizeAttendanceLocationEvidence,
} from "@/lib/operations/attendance-location-evidence";

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
  const actor = await getCurrentUser();

  if (!actor) {
    return errorResponse(
      "Authentication is required.",
      401
    );
  }

  if (actor.role !== "technician") {
    return errorResponse(
      "Only technicians can join shifts.",
      403
    );
  }

  if (actor.mustChangePassword) {
    return errorResponse(
      "Please change your initial password before joining a shift.",
      403
    );
  }

  const origin = request.headers.get("origin");
  const expectedOrigin =
    process.env.APP_ORIGIN ??
    request.nextUrl.origin;

  if (!origin || origin !== expectedOrigin) {
    return errorResponse(
      "This request is not allowed.",
      403
    );
  }

  const { shiftId } = await context.params;

  if (
    typeof shiftId !== "string" ||
    !shiftId.trim() ||
    shiftId !== shiftId.trim() ||
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

  try {
    await requireTechnicianWriteAuthority({
      uid: actor.uid,
      role: actor.role,
    });

    // Coarse presence evidence is optional and never blocks a join: a missing
    // or malformed payload records an explicit not-captured state instead.
    let locationPayload: unknown;
    const text = await request.text();
    if (text.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return errorResponse(
          "Please provide a valid JSON request body.",
          400
        );
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) => key !== "locationEvidence"
        )
      ) {
        return errorResponse(
          "The join request contains unsupported fields.",
          400
        );
      }
      locationPayload = (
        body as Record<string, unknown>
      ).locationEvidence;
    }

    const attendance = await joinShift({
      shiftId,
      actorUid: actor.uid,
      locationEvidence: normalizeAttendanceLocationEvidence(
        locationPayload,
        new Date().toISOString(),
      ),
    });

    return NextResponse.json(
      {
        success: true,
        message: "Shift joined successfully.",
        attendance: {
          id: attendance.id,
          shiftId: attendance.shiftId,
          technicianId: attendance.technicianId,
          status: attendance.status,
          participationAuthority:
            attendance.participationAuthority,
          recordedAt: attendance.recordedAt,
        },
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    if (error instanceof AssignmentOperationError) {
      return errorResponse(
        error.message,
        error.status
      );
    }

    console.error(
      "Shift join failed:",
      {
        shiftId,
        actorUid: actor.uid,
        error,
      }
    );

    return errorResponse(
      "You could not join the selected shift. Please try again or contact a supervisor.",
      500
    );
  }
}