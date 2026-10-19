import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";
import { HandoverDomainError } from "@/lib/operations/handover-domain";
import { EqualHandoverDomainError } from "@/lib/operations/equal-technician-handover-domain";
import { HandoverReservationGuardError } from "@/lib/operations/handover-reservation-guard-domain";
import { NextShiftAuthorizationDomainError } from "@/lib/operations/next-shift-authorization-domain";
import { beginEqualTechnicianShiftHandover } from "@/lib/operations/begin-shift-handover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

function v2Enabled(): boolean {
  return process.env.HANDOVER_V2_DEV === "true";
}

function respond(error: string, status: number) {
  return NextResponse.json({ success: false, error },
    { status, headers: { "Cache-Control": "no-store" } });
}

function mapError(error: unknown) {
  if (
    error instanceof AssignmentOperationError ||
    error instanceof HandoverDomainError ||
    error instanceof EqualHandoverDomainError ||
    error instanceof HandoverReservationGuardError ||
    error instanceof NextShiftAuthorizationDomainError
  ) {
    return respond(error.message, error.status);
  }
  console.error("Equal technician handover begin failed:", error);
  return respond("Unable to begin the handover. Please try again.", 500);
}

export async function POST(request: NextRequest, context: Context) {
  // Strict, default-off server gate: with the flag absent or false no v2
  // mutation logic executes at all.
  if (!v2Enabled()) return respond("Not found.", 404);

  const actor = await getCurrentUser();
  if (!actor) return respond("Please sign in to continue.", 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond("Your account is not authorized to begin this handover.", 403);
  }
  const expectedOrigin = process.env.APP_ORIGIN ?? request.nextUrl.origin;
  if (request.headers.get("origin") !== expectedOrigin) return respond("Invalid request origin.", 403);

  try {
    const { shiftId } = await context.params;
    const body = await request.json().catch(() => null);
    if (body !== null && Object.keys(body as object).length > 0) {
      return respond("Missing or unsupported handover fields.", 400);
    }
    const result = await beginEqualTechnicianShiftHandover({
      shiftId,
      // The actor identity always comes from the verified session, never a
      // request-body UID.
      actorUid: actor.uid,
    });
    return NextResponse.json({ success: true, handover: result },
      { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return mapError(error);
  }
}
