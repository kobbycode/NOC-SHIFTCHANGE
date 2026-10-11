import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";
import { HandoverDomainError, createHandoverDocumentId } from "@/lib/operations/handover-domain";
import { HandoverTransferError } from "@/lib/operations/handover-transfer-domain";
import { NextShiftAuthorizationDomainError } from "@/lib/operations/next-shift-authorization-domain";
import { ShiftCompletionDomainError } from "@/lib/operations/shift-completion-domain";
import { parseFormalHandoverTransferRequest, persistFormalHandoverTransfer } from "@/lib/operations/formal-handover-transfer";

export const runtime = "nodejs";
type Context = { params: Promise<{ shiftId: string }> };
function response(body: object, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function failure(message: string, status: number, code?: string) {
  return response({ success: false, error: message, ...(code ? { code } : {}) }, status);
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const actor = await getCurrentUser();
    if (!actor) return failure("Authentication is required.", 401);
    if ((actor.role !== "admin" && actor.role !== "supervisor") || actor.mustChangePassword !== false) {
      return failure("Only eligible supervisors or admins can transfer handovers.", 403);
    }
    if (request.headers.get("origin") !== (process.env.APP_ORIGIN ?? request.nextUrl.origin)) return failure("Invalid request origin.", 403);
    const { shiftId } = await context.params;
    createHandoverDocumentId(shiftId);
    let body: unknown;
    try { body = await request.json(); } catch { return failure("Invalid transfer JSON.", 400); }
    const reviewed = parseFormalHandoverTransferRequest(body);
    const outcome = await persistFormalHandoverTransfer({ ...reviewed, outgoingShiftId: shiftId, actorUid: actor.uid, actorRole: actor.role });
    if (outcome.status === "REVIEW_REQUIRED") return response({ success: false, status: outcome.status, error: "Handover work changed. Review the updated handover before transfer.",
      handover: outcome.handover }, 409);
    return response({ success: true, status: outcome.status, alreadyTransferred: outcome.status === "ALREADY_TRANSFERRED", receipt: outcome.receipt }, 200);
  } catch (error) {
    if (error instanceof HandoverTransferError) return failure(error.message, error.status, error.code);
    if (error instanceof AssignmentOperationError || error instanceof HandoverDomainError ||
        error instanceof NextShiftAuthorizationDomainError || error instanceof ShiftCompletionDomainError) return failure(error.message, error.status);
    console.error("Formal handover transfer failed.");
    return failure("Unable to transfer handover. Please try again.", 500);
  }
}
