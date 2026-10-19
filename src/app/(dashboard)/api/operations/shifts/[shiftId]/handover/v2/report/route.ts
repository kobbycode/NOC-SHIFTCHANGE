import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { prepareEqualHandoverReport, readEqualHandoverReportState } from "@/lib/operations/equal-handover-report-firestore";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  parsePrepareBody,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

async function sessionActor() {
  const actor = await getCurrentUser();
  if (!actor) return { error: respond({ success: false, error: "Please sign in to continue." }, 401) };
  if (actor.mustChangePassword) {
    return { error: respond({ success: false, error: "Change your password before using handover reports." }, 403) };
  }
  return { actor };
}

async function sessionTechnician() {
  const session = await sessionActor();
  if (session.error) return session;
  if (session.actor.role !== "technician") {
    return { error: respond({ success: false, error: "A supervisor cannot prepare or freeze a v2 handover report." }, 403) };
  }
  return session;
}

// GET is read-only: outgoing technicians, the currently reserved incoming
// technicians and supervisors/admins may read; the service re-authorizes
// against fresh Firestore profiles and rejects non-participant technicians.
export async function GET(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const session = await sessionActor();
  if (session.error) return session.error;
  try {
    const { shiftId } = await context.params;
    const state = await readEqualHandoverReportState(shiftId, session.actor.uid);
    return respond({ success: true, report: state }, 200);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 report read failed:");
  }
}

// POST prepares (or re-prepares) the consolidated report; either outgoing
// technician holds equal preparation authority.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const session = await sessionTechnician();
  if (session.error) return session.error;
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    const { shiftId } = await context.params;
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid report JSON." }, 400); }
    const result = await prepareEqualHandoverReport({
      outgoingShiftId: shiftId,
      actorUid: session.actor.uid,
      ...parsePrepareBody(body),
    });
    return respond({ success: true, preparation: result.preparation, replayed: result.replayed }, 200);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 report preparation failed:");
  }
}
