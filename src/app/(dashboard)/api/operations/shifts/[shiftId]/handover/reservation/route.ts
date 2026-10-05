import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";
import { HandoverDomainError, createHandoverDocumentId } from "@/lib/operations/handover-domain";
import { NextShiftAuthorizationDomainError } from "@/lib/operations/next-shift-authorization-domain";
import { initializeFormalHandover, replaceFormalHandoverReservation, cancelFormalHandoverReservation,
  parseFormalHandoverRequest } from "@/lib/operations/formal-handover";

export const runtime = "nodejs";
type Context = { params: Promise<{ shiftId: string }> };
function errorResponse(error: string, status: number) {
  return NextResponse.json({ success: false, error }, { status });
}
async function handle(request: NextRequest, context: Context, operation: "initialize" | "replace" | "cancel") {
  const actor = await getCurrentUser();
  if (!actor) return errorResponse("Please sign in to continue.", 401);
  if ((actor.role !== "admin" && actor.role !== "supervisor") || actor.mustChangePassword) {
    return errorResponse("Your account is not authorized to manage handover reservations.", 403);
  }
  const expectedOrigin = process.env.APP_ORIGIN ?? request.nextUrl.origin;
  if (request.headers.get("origin") !== expectedOrigin) return errorResponse("Invalid request origin.", 403);
  try {
    const { shiftId } = await context.params;
    createHandoverDocumentId(shiftId);
    let body: unknown;
    try { body = await request.json(); }
    catch { return errorResponse("Invalid reservation JSON.", 400); }
    const authority = { outgoingShiftId: shiftId, actorUid: actor.uid, expectedRole: actor.role };
    const result = operation === "initialize" ? await initializeFormalHandover({
      ...parseFormalHandoverRequest(body, "initialize"), ...authority,
    }) : operation === "replace" ? await replaceFormalHandoverReservation({
      ...parseFormalHandoverRequest(body, "replace"), ...authority,
    }) : await cancelFormalHandoverReservation({ ...parseFormalHandoverRequest(body, "cancel"), ...authority });
    return NextResponse.json({ success: true, handover: result }, { status: operation === "initialize" ? 201 : 200 });
  } catch (error) {
    if (error instanceof AssignmentOperationError || error instanceof HandoverDomainError || error instanceof NextShiftAuthorizationDomainError) {
      return errorResponse(error.message, error.status);
    }
    console.error("Formal handover reservation failed:", error);
    return errorResponse("Unable to update the handover reservation. Please try again.", 500);
  }
}
export async function POST(request: NextRequest, context: Context) { return handle(request, context, "initialize"); }
export async function PUT(request: NextRequest, context: Context) { return handle(request, context, "replace"); }
export async function DELETE(request: NextRequest, context: Context) { return handle(request, context, "cancel"); }
