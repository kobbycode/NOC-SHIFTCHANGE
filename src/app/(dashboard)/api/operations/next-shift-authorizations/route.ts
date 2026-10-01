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
  createNextShiftAuthorization,
  listCurrentNextShiftAuthorizations,
} from "@/lib/operations/next-shift-authorizations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function requireManager(
  role: string,
  mustChangePassword: boolean
): boolean {
  return (
    !mustChangePassword &&
    (role === "admin" || role === "supervisor")
  );
}

export async function GET() {
  try {
    const actor = await getCurrentUser();

    if (!actor) {
      return errorResponse(
        "Authentication is required.",
        401
      );
    }

    if (
      !requireManager(
        actor.role,
        actor.mustChangePassword
      )
    ) {
      return errorResponse(
        "You are not authorized to retrieve next-shift authorizations.",
        403
      );
    }

    const result =
      await listCurrentNextShiftAuthorizations(
        actor
      );

    return NextResponse.json(
      {
        success: true,
        ...result,
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
      error instanceof AssignmentOperationError
    ) {
      return errorResponse(
        error.message,
        error.status
      );
    }

    console.error(
      "Next-shift authorization retrieval failed:",
      error
    );

    return errorResponse(
      "Next-shift authorizations could not be retrieved.",
      500
    );
  }
}

export async function POST(
  request: NextRequest
) {
  const actor = await getCurrentUser();

  if (!actor) {
    return errorResponse(
      "Please sign in to continue.",
      401
    );
  }

  if (
    !requireManager(
      actor.role,
      actor.mustChangePassword
    )
  ) {
    return errorResponse(
      "Only administrators and supervisors can create next-shift authorizations.",
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

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      "Please provide valid request data.",
      400
    );
  }

  try {
    const authorization =
      await createNextShiftAuthorization(
        body,
        {
          uid: actor.uid,
          role: actor.role,
        }
      );

    return NextResponse.json(
      {
        success: true,
        message:
          "Temporary technician authorization created for the current next-shift slot.",
        authorization,
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
      error instanceof AssignmentOperationError
    ) {
      return errorResponse(
        error.message,
        error.status
      );
    }

    console.error(
      "Next-shift authorization creation failed:",
      {
        actorUid: actor.uid,
        error,
      }
    );

    return errorResponse(
      "Next-shift authorization could not be created.",
      500
    );
  }
}