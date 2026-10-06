import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAdminAuth } from "@/lib/firebase/admin";
import { PasswordReauthenticationError, reauthenticatePassword } from "@/lib/auth/password-reauthentication";
import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";
import { HandoverDomainError, createHandoverDocumentId } from "@/lib/operations/handover-domain";
import { NextShiftAuthorizationDomainError } from "@/lib/operations/next-shift-authorization-domain";
import { persistFormalHandoverConfirmation } from "@/lib/operations/formal-handover-confirmation";

export const runtime = "nodejs";
type Context = { params: Promise<{ shiftId: string }> };
function response(body: object, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function failure(message: string, status: number) {
  return response({ success: false, error: message }, status);
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const actor = await getCurrentUser();
    if (!actor) return failure("Authentication is required.", 401);
    if (actor.role !== "technician" || actor.mustChangePassword === true) {
      return failure("Only eligible technicians can confirm their own handover.", 403);
    }
    const expectedOrigin = process.env.APP_ORIGIN ?? request.nextUrl.origin;
    if (request.headers.get("origin") !== expectedOrigin) return failure("Invalid request origin.", 403);
    const { shiftId } = await context.params;
    createHandoverDocumentId(shiftId);
    let body: unknown;
    try { body = await request.json(); }
    catch { return failure("Invalid confirmation JSON.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid confirmation request.", 400);
    const data = body as Record<string, unknown>;
    const keys = Object.keys(data);
    if (keys.length !== 3 || keys.some((key) => !["password", "expectedRevision", "expectedSnapshotHash"].includes(key)) ||
        typeof data.password !== "string" || !data.password || !Number.isSafeInteger(data.expectedRevision) ||
        (data.expectedRevision as number) < 1 || typeof data.expectedSnapshotHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(data.expectedSnapshotHash)) return failure("Invalid confirmation request.", 400);
    // Project only reviewed binding and trusted session identity into persistence.
    const input = { outgoingShiftId: shiftId, actorUid: actor.uid,
      expectedRevision: data.expectedRevision as number, expectedSnapshotHash: data.expectedSnapshotHash };
    const auth = getAdminAuth();
    const account = await auth.getUser(actor.uid);
    if (account.uid !== actor.uid || account.disabled === true || !account.email ||
        account.email.toLowerCase() !== actor.email.toLowerCase()) {
      return failure("This account cannot confirm handover.", 403);
    }
    const email = account.email;
    await reauthenticatePassword({ expectedUid: actor.uid, email, password: data.password });
    const currentAccount = await auth.getUser(actor.uid);
    if (currentAccount.uid !== actor.uid || currentAccount.disabled === true || currentAccount.email !== email) {
      return failure("Your account changed. Sign in again before confirming.", 403);
    }
    const outcome = await persistFormalHandoverConfirmation(input);
    if (outcome.status === "REVIEW_REQUIRED") {
      return response({ success: false, error: "Handover work changed. Review the updated handover before confirming.",
        handover: outcome.handover }, 409);
    }
    return response({ success: true, message: "Handover confirmation recorded.",
      alreadyConfirmed: outcome.status === "ALREADY_CONFIRMED", confirmation: outcome.confirmation,
      handover: outcome.handover }, 200);
  } catch (error) {
    if (error instanceof PasswordReauthenticationError || error instanceof AssignmentOperationError ||
        error instanceof HandoverDomainError || error instanceof NextShiftAuthorizationDomainError) {
      return failure(error.message, error.status);
    }
    if (error && typeof error === "object" && "code" in error && error.code === "auth/user-not-found") {
      return failure("This account cannot confirm handover.", 403);
    }
    // Upstream exceptions can contain credentials; never log their raw payload.
    console.error("Formal handover confirmation failed.");
    return failure("Unable to confirm handover. Please try again.", 500);
  }
}
