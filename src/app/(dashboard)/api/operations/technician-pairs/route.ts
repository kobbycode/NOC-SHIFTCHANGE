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
  createTechnicianPair,
} from "@/lib/operations/create-technician-pair";

import {
  listTechnicianPairs,
} from "@/lib/operations/list-technician-pairs";

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

/**
 * Authoritative permanent technician-pair retrieval.
 *
 * Pair membership is an organizational relationship only.
 * It does not prove attendance on any shift and does not
 * itself create active operational responsibility.
 *
 * Permanent account revocation remains disabled.
 */
export async function GET() {
  try {
    const user =
      await getCurrentUser();

    if (!user) {
      return errorResponse(
        "Authentication is required.",
        401
      );
    }

    if (
      user.mustChangePassword === true
    ) {
      return errorResponse(
        "You must change your password before continuing.",
        403
      );
    }

    if (
      user.role !== "admin" &&
      user.role !== "supervisor"
    ) {
      return errorResponse(
        "You are not authorized to retrieve technician pairs.",
        403
      );
    }

    const pairs =
      await listTechnicianPairs({
        uid: user.uid,
        role: user.role,
      });

    return NextResponse.json(
      {
        success: true,
        pairs,
        total: pairs.length,
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
      "Failed to retrieve technician pairs:",
      error
    );

    return errorResponse(
      "Unable to retrieve technician pairs.",
      500
    );
  }
}

/**
 * Create one permanent technician pair.
 *
 * The browser supplies only the two technician UIDs.
 *
 * The authenticated actor identity and role are determined
 * by the server-side session. The authoritative creation
 * service independently revalidates the actor and both
 * technicians inside the Firestore transaction.
 *
 * Pair membership remains organizational configuration.
 * It is not shift attendance and does not itself establish
 * active operational responsibility.
 *
 * Permanent account revocation remains disabled.
 */
export async function POST(
  request: NextRequest
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
   * parsing any mutation request body.
   */
  if (
    actor.role !== "admin" &&
    actor.role !== "supervisor"
  ) {
    return errorResponse(
      "Only administrators and supervisors can create technician pairs.",
      403
    );
  }

  if (
    actor.mustChangePassword === true
  ) {
    return errorResponse(
      "Please change your initial password before creating technician pairs.",
      403
    );
  }

  /*
   * PHASE 3:
   * Require the same server-side same-origin
   * protection used by existing operational
   * mutation routes.
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
   * Parse the request body as untrusted input.
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
      "Please provide valid technician pair details.",
      400
    );
  }

  const input =
    body as Record<string, unknown>;

  /*
   * The public mutation contract accepts exactly
   * one field: technicianIds.
   *
   * Actor identity, role, pair ID, status,
   * timestamps, attendance, account state, and
   * audit data are never accepted from the client.
   */
  const inputKeys =
    Object.keys(input);

  if (
    inputKeys.length !== 1 ||
    inputKeys[0] !== "technicianIds"
  ) {
    return errorResponse(
      "Only technicianIds may be provided when creating a technician pair.",
      400
    );
  }

  const technicianIds =
    input.technicianIds;

  if (
    !Array.isArray(technicianIds) ||
    technicianIds.length !== 2 ||
    typeof technicianIds[0] !== "string" ||
    typeof technicianIds[1] !== "string"
  ) {
    return errorResponse(
      "Please select exactly two valid technicians.",
      400
    );
  }

  /*
   * Do not perform authoritative technician,
   * reservation, pair, or account-state decisions
   * in the route.
   *
   * Those checks belong to createTechnicianPair()
   * and execute transactionally.
   */
  try {
    const pair =
      await createTechnicianPair(
        {
          technicianIds: [
            technicianIds[0],
            technicianIds[1],
          ],
        },
        {
          uid: actor.uid,
        }
      );

    return NextResponse.json(
      {
        success: true,
        message:
          "Technician pair created successfully.",
        pair,
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
      "Technician pair creation failed:",
      {
        actorUid: actor.uid,
        error,
      }
    );

    return errorResponse(
      "The technician pair could not be created. Please try again or contact an administrator.",
      500
    );
  }
}