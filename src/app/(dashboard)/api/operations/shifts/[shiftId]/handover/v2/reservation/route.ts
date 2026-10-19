import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";
import { HandoverDomainError } from "@/lib/operations/handover-domain";
import { EqualHandoverDomainError } from "@/lib/operations/equal-technician-handover-domain";
import { HandoverReservationGuardError } from "@/lib/operations/handover-reservation-guard-domain";
import { NextShiftAuthorizationDomainError } from "@/lib/operations/next-shift-authorization-domain";
import {
  cancelEqualHandoverReservationForTechnicians,
  initializeEqualHandoverReservation,
  parseEqualHandoverRequest,
  readEqualHandoverReservation,
  replaceEqualHandoverReservationForTechnicians,
} from "@/lib/operations/equal-handover-reservation-firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

function v2Enabled(): boolean {
  return process.env.HANDOVER_V2_DEV === "true";
}

function respond(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

function mapError(error: unknown, fallback: string) {
  if (
    error instanceof AssignmentOperationError ||
    error instanceof HandoverDomainError ||
    error instanceof EqualHandoverDomainError ||
    error instanceof HandoverReservationGuardError ||
    error instanceof NextShiftAuthorizationDomainError
  ) {
    return respond({ success: false, error: error.message }, error.status);
  }
  console.error(fallback, error);
  return respond({ success: false, error: "Unable to update the handover reservation. Please try again." }, 500);
}

async function sessionTechnician() {
  const actor = await getCurrentUser();
  if (!actor) return { error: respond({ success: false, error: "Please sign in to continue." }, 401) };
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return { error: respond({ success: false, error: "Your account is not authorized to manage equal handover reservations." }, 403) };
  }
  return { actor };
}

function sameOrigin(request: NextRequest) {
  const expectedOrigin = process.env.APP_ORIGIN ?? request.nextUrl.origin;
  return request.headers.get("origin") === expectedOrigin;
}

export async function GET(request: NextRequest, context: Context) {
  if (!v2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const session = await sessionTechnician();
  if (session.error) return session.error;
  try {
    const { shiftId } = await context.params;
    const state = await readEqualHandoverReservation(shiftId);
    if (!state) return respond({ success: false, error: "The equal handover reservation was not found." }, 404);
    // Read-back is limited to the four participants' authoritative profiles.
    const profile = await getAdminFirestore().collection("users").doc(session.actor.uid).get();
    const data = profile.data();
    const isParticipant = [
      ...state.aggregate.identity.outgoingTechnicianIds,
      ...state.aggregate.identity.incomingTechnicianIds,
    ].includes(session.actor.uid);
    if (!isParticipant || !profile.exists || data?.role !== "technician" ||
        data?.status !== "active" || data?.statusOperation != null) {
      return respond({ success: false, error: "Your account is not authorized to manage equal handover reservations." }, 403);
    }
    return respond({ success: true, reservation: state }, 200);
  } catch (error) {
    return mapError(error, "Equal handover reservation read failed:");
  }
}

async function mutate(request: NextRequest, context: Context, operation: "initialize" | "replace" | "cancel") {
  if (!v2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const session = await sessionTechnician();
  if (session.error) return session.error;
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    const { shiftId } = await context.params;
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid reservation JSON." }, 400); }
    const authority = { outgoingShiftId: shiftId, actorUid: session.actor.uid };
    const result = operation === "initialize"
      ? await initializeEqualHandoverReservation({ ...parseEqualHandoverRequest(body, "initialize"), ...authority })
      : operation === "replace"
        ? await replaceEqualHandoverReservationForTechnicians({ ...parseEqualHandoverRequest(body, "replace"), ...authority })
        : await cancelEqualHandoverReservationForTechnicians({ ...parseEqualHandoverRequest(body, "cancel"), ...authority });
    return respond({ success: true, reservation: result }, operation === "initialize" && !result.replayed ? 201 : 200);
  } catch (error) {
    return mapError(error, "Equal handover reservation mutation failed:");
  }
}

export async function POST(request: NextRequest, context: Context) {
  return mutate(request, context, "initialize");
}
export async function PUT(request: NextRequest, context: Context) {
  return mutate(request, context, "replace");
}
export async function DELETE(request: NextRequest, context: Context) {
  return mutate(request, context, "cancel");
}
