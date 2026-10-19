import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { parseEqualHandoverTransferRequest, transferEqualHandoverV2 } from "@/lib/operations/equal-handover-report-firestore";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// The final v2 transfer is technician-only and derives all authority inside its
// own transaction from fresh Firestore evidence — a prior readiness result is
// never trusted (§4). The initiator must be a personally confirmed outgoing
// reserved technician; the caller may supply only the reviewed revision,
// snapshot hash and guard evidence, never an actor, role or timestamp.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account is not authorized to transfer v2 handovers." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    const { shiftId } = await context.params;
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid transfer JSON." }, 400); }
    const result = await transferEqualHandoverV2({
      outgoingShiftId: shiftId,
      actorUid: actor.uid,
      ...parseEqualHandoverTransferRequest(body),
    });
    return respond({
      success: true,
      status: result.status,
      transfer: result.receipt,
      reservation: { aggregate: result.aggregate, snapshotHash: result.snapshotHash },
      outgoingShiftId: result.outgoingShiftId,
      incomingShiftId: result.incomingShiftId,
      replayed: result.replayed,
    }, result.replayed ? 200 : 201);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 final transfer failed:");
  }
}
