import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { freezeEqualHandoverReport } from "@/lib/operations/equal-handover-report-firestore";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  parseFreezeBody,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// The freeze is technician-only (supervisors cannot freeze v2 reports), binds
// one immutable reviewed revision inside the authoritative transaction and is
// retry-safe: an identical completed request replays the same report instead
// of duplicating documents or audit events.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account is not authorized to freeze v2 handover reports." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    const { shiftId } = await context.params;
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid freeze JSON." }, 400); }
    const result = await freezeEqualHandoverReport({
      outgoingShiftId: shiftId,
      actorUid: actor.uid,
      ...parseFreezeBody(body),
    });
    return respond({
      success: true,
      report: result.report,
      reservation: { aggregate: result.aggregate, snapshotHash: result.snapshotHash },
      replayed: result.replayed,
    }, result.replayed ? 200 : 201);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 report freeze failed:");
  }
}
