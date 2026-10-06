import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";
import { HandoverDomainError, createHandoverDocumentId } from "@/lib/operations/handover-domain";
import { NextShiftAuthorizationDomainError } from "@/lib/operations/next-shift-authorization-domain";
import { parseFormalHandoverResolutionRequest, persistFormalHandoverResolution } from "@/lib/operations/formal-handover-resolution";

export const runtime = "nodejs";
type Context = { params: Promise<{ shiftId: string }> };
function response(body: object, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function failure(message: string, status: number) { return response({ success: false, error: message }, status); }

export async function POST(request: NextRequest, context: Context) {
  try {
    const actor = await getCurrentUser();
    if (!actor) return failure("Authentication is required.", 401);
    if ((actor.role !== "admin" && actor.role !== "supervisor") || actor.mustChangePassword !== false) {
      return failure("Only eligible supervisors or admins can resolve handover participants.", 403);
    }
    const expectedOrigin = process.env.APP_ORIGIN ?? request.nextUrl.origin;
    if (request.headers.get("origin") !== expectedOrigin) return failure("Invalid request origin.", 403);
    const { shiftId } = await context.params;
    createHandoverDocumentId(shiftId);
    let body: unknown;
    try { body = await request.json(); }
    catch { return failure("Invalid resolution JSON.", 400); }
    const reviewed = parseFormalHandoverResolutionRequest(body);
    const outcome = await persistFormalHandoverResolution({ ...reviewed,
      outgoingShiftId: shiftId, actorUid: actor.uid, actorRole: actor.role });
    if (outcome.status === "REVIEW_REQUIRED") {
      return response({ success: false, error: "Handover work changed. Review the updated handover before resolving.",
        handover: outcome.handover }, 409);
    }
    return response({ success: true, message: "Handover resolution recorded.",
      alreadyResolved: outcome.status === "ALREADY_RESOLVED", handover: outcome.handover }, 200);
  } catch (error) {
    if (error instanceof AssignmentOperationError || error instanceof HandoverDomainError ||
        error instanceof NextShiftAuthorizationDomainError) return failure(error.message, error.status);
    console.error("Formal handover resolution failed.");
    return failure("Unable to resolve handover. Please try again.", 500);
  }
}
