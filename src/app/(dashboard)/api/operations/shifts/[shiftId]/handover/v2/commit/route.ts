import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAdminAuth } from "@/lib/firebase/admin";
import { PasswordReauthenticationError, reauthenticatePassword } from "@/lib/auth/password-reauthentication";
import { commitEqualHandoverOutgoingV2 } from "@/lib/operations/equal-handover-report-firestore";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  parseCommitBody,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import { requireTechnicianWriteAuthority } from "@/lib/operations/technician-write-authority-firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// Stage 1 (§2 addendum): a personally confirmed outgoing technician closes the
// reviewed handover into `awaiting_incoming_acceptance`. This never pre-creates
// the incoming shift, never touches the operational slot, guard, membership or
// attendance, and never fabricates a joined technician — it only flips the v2
// lifecycle and records the deterministic commitment receipt. Closing a handover
// is an outgoing action taken as that person, so the actor reauthenticates with
// their OWN password, verified here strictly BEFORE the transaction and never
// stored, logged or echoed. The actor remains the verified session technician,
// the request carries only the reviewed binding plus that password, and the
// service receives no credential.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account is not authorized to commit v2 handovers." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);

  const { shiftId } = await context.params;
  let body: unknown;
  try { body = await request.json(); }
  catch { return respond({ success: false, error: "Invalid commit JSON." }, 400); }
  let reviewed;
  try {
    reviewed = parseCommitBody(body);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 commit request rejected:");
  }
  const { password, ...binding } = reviewed;

  try {
    await requireTechnicianWriteAuthority({ uid: actor.uid, role: actor.role });
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 commit authority check failed:");
  }

  try {
    const auth = getAdminAuth();
    const account = await auth.getUser(actor.uid);
    if (account.uid !== actor.uid || account.disabled === true || !account.email ||
        account.email.toLowerCase() !== actor.email.toLowerCase()) {
      return respond({ success: false, error: "This account cannot commit handovers." }, 403);
    }
    const email = account.email;
    await reauthenticatePassword({ expectedUid: actor.uid, email, password });
    const current = await auth.getUser(actor.uid);
    if (current.uid !== actor.uid || current.disabled === true || current.email !== email) {
      return respond({ success: false, error: "Your account changed. Sign in again before committing." }, 403);
    }
  } catch (error) {
    if (error instanceof PasswordReauthenticationError) return respond({ success: false, error: error.message }, error.status);
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "auth/user-not-found") {
      return respond({ success: false, error: "This account cannot commit handovers." }, 403);
    }
    // Upstream exceptions can carry credentials; never log the raw payload.
    console.error("Equal handover v2 commit password reauthentication failed.");
    return respond({ success: false, error: "Unable to verify your password. Please try again later." }, 503);
  }

  try {
    const result = await commitEqualHandoverOutgoingV2({
      outgoingShiftId: shiftId,
      actorUid: actor.uid,
      ...binding,
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
