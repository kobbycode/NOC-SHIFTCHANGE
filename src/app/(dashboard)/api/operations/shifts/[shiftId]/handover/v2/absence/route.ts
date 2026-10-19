import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  clearEqualHandoverAbsenceV2,
  recordEqualHandoverAbsenceV2,
} from "@/lib/operations/equal-handover-report-firestore";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  parseAbsenceClearBody,
  parseAbsenceRecordBody,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// Absence declarations are colleague attestations by an outgoing reserved
// technician only; the service enforces fresh-profile authority, the no
// self-declaration rule and the single-absence limit, and never finalizes
// attendance evidence because of a declaration.
async function mutate(request: NextRequest, context: Context, operation: "record" | "clear") {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account is not authorized to declare handover absences." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    const { shiftId } = await context.params;
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid absence JSON." }, 400); }
    const authority = { outgoingShiftId: shiftId, actorUid: actor.uid };
    const result = operation === "record"
      ? await recordEqualHandoverAbsenceV2({ ...authority, ...parseAbsenceRecordBody(body) })
      : await clearEqualHandoverAbsenceV2({ ...authority, ...parseAbsenceClearBody(body) });
    return respond({
      success: true,
      reservation: { aggregate: result.aggregate, snapshotHash: result.snapshotHash, replayed: result.replayed },
    }, 200);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 absence mutation failed:");
  }
}

export async function POST(request: NextRequest, context: Context) {
  return mutate(request, context, "record");
}

export async function DELETE(request: NextRequest, context: Context) {
  return mutate(request, context, "clear");
}
