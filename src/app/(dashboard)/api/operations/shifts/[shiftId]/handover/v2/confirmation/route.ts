import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { confirmEqualHandoverParticipantV2 } from "@/lib/operations/equal-handover-report-firestore";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  parseConfirmBody,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// A confirmation is always personal: the authenticated session actor is the
// confirming technician and is the only identity the service trusts. The
// request body carries no technician UID, role or timestamp — only the
// optimistic concurrency binding. The service re-authorizes the actor against a
// fresh Firestore profile and the reservation membership inside the transaction.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account is not authorized to confirm this handover." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    const { shiftId } = await context.params;
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid confirmation JSON." }, 400); }
    const result = await confirmEqualHandoverParticipantV2({
      outgoingShiftId: shiftId,
      actorUid: actor.uid,
      ...parseConfirmBody(body),
    });
    return respond({
      success: true,
      confirmation: { aggregate: result.aggregate, snapshotHash: result.snapshotHash, replayed: result.replayed },
    }, 200);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 confirmation failed:");
  }
}
