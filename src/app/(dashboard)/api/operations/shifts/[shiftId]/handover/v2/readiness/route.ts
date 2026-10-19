import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readEqualHandoverReportState } from "@/lib/operations/equal-handover-report-firestore";
import { handoverV2Enabled, mapHandoverV2ReportError, respond } from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// Readiness is a derived result recomputed from authoritative current evidence
// on every request; it is never a stored flag and never a transfer
// authorization. The final transfer milestone re-derives it inside its own
// transaction. Any handover participant, supervisor or admin may read it; the
// service re-authorizes against a fresh profile and rejects non-participants.
export async function GET(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.mustChangePassword) {
    return respond({ success: false, error: "Change your password before using handover reports." }, 403);
  }
  try {
    const { shiftId } = await context.params;
    const state = await readEqualHandoverReportState(shiftId, actor.uid);
    return respond({ success: true, readiness: state.readiness }, 200);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 readiness read failed:");
  }
}
