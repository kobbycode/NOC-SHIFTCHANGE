import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  finalizeEqualHandoverReservationV2,
  isEqualHandoverIncomingAttendanceResolved,
} from "@/lib/operations/equal-handover-report-firestore";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// Deferred reservation-guard terminalization (§5). The activation and late-join
// transactions deliberately leave the guard ACTIVE so an unarrived partner's
// `incoming_late_acceptance` can still finalize. This recovery route closes the
// guard only once BOTH reserved incoming technicians have personally accepted —
// derived from authoritative server state, never from a client claim — so a
// guard can never be terminalized while a supported late acceptance is still
// pending. It is idempotent and makes no payable-hours or attendance-correction
// policy decision; those remain `policy_unresolved`.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.mustChangePassword) {
    return respond({ success: false, error: "Change your password before using handover reports." }, 403);
  }
  if (!["technician", "admin", "supervisor"].includes(actor.role)) {
    return respond({ success: false, error: "Your account is not authorized to finalize v2 handovers." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    const { shiftId } = await context.params;
    let body: unknown;
    try { body = await request.json(); }
    catch { body = {}; }
    if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length > 0) {
      return respond({ success: false, error: "Handover finalization takes no fields." }, 400);
    }
    if (!(await isEqualHandoverIncomingAttendanceResolved(shiftId))) {
      return respond({
        success: false,
        error: "Every reserved incoming technician must personally accept before this reservation can be finalized.",
      }, 409);
    }
    const result = await finalizeEqualHandoverReservationV2({ outgoingShiftId: shiftId, actorUid: actor.uid });
    return respond({
      success: true,
      status: result.status,
      outgoingShiftId: result.outgoingShiftId,
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 reservation finalization failed:");
  }
}
