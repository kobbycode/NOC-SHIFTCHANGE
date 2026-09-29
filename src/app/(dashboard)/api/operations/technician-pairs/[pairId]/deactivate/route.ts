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
  deactivateTechnicianPair,
} from "@/lib/operations/deactivate-technician-pair";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    pairId: string;
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

/**
 * Deactivate one permanent technician pair.
 *
 * This route performs only the HTTP/session boundary.
 * The authoritative service transaction validates the
 * pair, both deterministic reservations, actor state,
 * and protected operational responsibility.
 *
 * Deactivation preserves the historical pair record.
 * Pair membership is not shift attendance.
 *
 * Permanent account revocation remains disabled.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  /*
   * PHASE 1:
   * Authenticate the current actor.
   */

  const actor =
    await getCurrentUser();

  if (!actor) {
    return errorResponse(
      "Please sign in to continue.",
      401
    );
  }

  /*
   * PHASE 2:
   * Enforce manager authorization before
   * accepting the mutation request.
   */

  if (
    actor.role !== "admin" &&
    actor.role !== "supervisor"
  ) {
    return errorResponse(
      "Only administrators and supervisors can deactivate technician pairs.",
      403
    );
  }

  if (
    actor.mustChangePassword === true
  ) {
    return errorResponse(
      "Please change your initial password before deactivating technician pairs.",
      403
    );
  }

  /*
   * PHASE 3:
   * Require the stricter same-origin policy
   * already used by technician-pair creation.
   */

  const origin =
    request.headers.get("origin");

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
   * Validate only the route identifier.
   *
   * This action accepts no request body.
   * Actor identity, lifecycle state, timestamps,
   * reservations, account state, and audit data
   * are never accepted from the client.
   */

  const {
    pairId,
  } = await context.params;

  if (
    typeof pairId !== "string" ||
    !pairId.trim() ||
    pairId.includes("/") ||
    pairId.length > 128
  ) {
    return errorResponse(
      "Please provide a valid technician pair identifier.",
      400
    );
  }

  /*
   * PHASE 5:
   * Delegate all authoritative lifecycle
   * decisions to the transactional service.
   *
   * The route must not directly mutate the pair,
   * reservation, shift, attendance, task, audit,
   * or account-status collections.
   */

  try {
    const pair =
      await deactivateTechnicianPair(
        {
          pairId,
        },
        {
          uid: actor.uid,
        }
      );

    return NextResponse.json(
      {
        success: true,
        message:
          "Technician pair deactivated successfully.",
        pair,
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
      "Technician pair deactivation failed:",
      {
        pairId,
        actorUid: actor.uid,
        error,
      }
    );

    return errorResponse(
      "The technician pair could not be deactivated. Please try again or contact an administrator.",
      500
    );
  }
}