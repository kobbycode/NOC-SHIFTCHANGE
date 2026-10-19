import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { commitEqualHandoverOutgoingV2 } from "@/lib/operations/equal-handover-report-firestore";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  parseCommitBody,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// Stage 1 (§2 addendum): a personally confirmed outgoing technician closes the
// reviewed handover into `awaiting_incoming_acceptance`. This never pre-creates
// the incoming shift, never touches the operational slot, guard, membership or
// attendance, and never fabricates a joined technician — it only flips the v2
// lifecycle and records the deterministic commitment receipt. Committing is a
// M07-parity outgoing action, so no password is required, but the actor is the
// verified session technician and the request carries only the reviewed binding.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account is not authorized to commit v2 handovers." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    const { shiftId } = await context.params;
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid commit JSON." }, 400); }
    const result = await commitEqualHandoverOutgoingV2({
      outgoingShiftId: shiftId,
      actorUid: actor.uid,
      ...parseCommitBody(body),
    });
    return respond({
      success: true,
      status: result.status,
      receipt: result.receipt,
      reservation: { aggregate: result.aggregate, snapshotHash: result.snapshotHash },
      outgoingShiftId: result.outgoingShiftId,
      incomingShiftId: result.incomingShiftId,
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 outgoing commit failed:");
  }
}
