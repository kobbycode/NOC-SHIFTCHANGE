import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAdminAuth } from "@/lib/firebase/admin";
import { PasswordReauthenticationError, reauthenticatePassword } from "@/lib/auth/password-reauthentication";
import type {
  AttendanceEvidenceRequest,
  AttendanceTrustedAuthentication,
} from "@/types/attendance-evidence";
import {
  confirmEqualHandoverParticipantV2,
  readEqualHandoverConfirmationContext,
} from "@/lib/operations/equal-handover-report-firestore";
import {
  AttendanceEvidenceDomainError,
  beginAttendanceEvidenceOperation,
  finalizeAttendanceEvidenceOperation,
  resumeAttendanceEvidenceOperation,
} from "@/lib/operations/attendance-evidence-firestore";
import { markActionedByReference } from "@/lib/notifications/notification-service";
import { NOTIFICATION_EVENT_KINDS } from "@/types/notification";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  parseConfirmBody,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import { requireTechnicianWriteAuthority } from "@/lib/operations/technician-write-authority-firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// A confirmation is always personal: the authenticated session actor is the
// confirming technician and is the only identity the service trusts. The
// request body carries no technician UID, role or timestamp — only the
// optimistic concurrency binding plus the actor's OWN password, which this
// route verifies server-side before any transaction and never stores, logs or
// echoes. An OUTGOING participant's verified password also finalizes their
// `outgoing_personal_confirmation` attendance evidence against the live
// reservation guard; an incoming participant's confirmation establishes no
// attendance, which only their passworded acceptance creates. The service then
// re-authorizes the actor against a fresh Firestore profile and the reservation
// membership inside the transaction. Passwords never reach a service.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account is not authorized to confirm this handover." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);

  const { shiftId } = await context.params;
  let body: unknown;
  try { body = await request.json(); }
  catch { return respond({ success: false, error: "Invalid confirmation JSON." }, 400); }
  let reviewed;
  try {
    reviewed = parseConfirmBody(body);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 confirmation request rejected:");
  }
  // The password is consumed by the reauthentication below and is never passed
  // to a service, a receipt or an audit record.
  const { password, ...binding } = reviewed;

  try {
    await requireTechnicianWriteAuthority({ uid: actor.uid, role: actor.role });
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 confirmation authority check failed:");
  }

  // Authoritative context: derives the caller's participant authority, the live
  // guard/snapshot binding and — only for an outgoing participant still owing a
  // confirmation — the deterministic personal evidence binding. It authorizes
  // nothing and changes nothing; the confirmation writer re-derives all of it.
  let ctx;
  try {
    ctx = await readEqualHandoverConfirmationContext(shiftId, actor.uid, binding);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 confirmation context read failed:");
  }

  // Fresh personal password reauthentication, completed strictly BEFORE any
  // transaction, using the authoritative Auth account email — never a client
  // email or UID. All tokens are discarded by the primitive.
  try {
    const auth = getAdminAuth();
    const account = await auth.getUser(actor.uid);
    if (account.uid !== actor.uid || account.disabled === true || !account.email ||
        account.email.toLowerCase() !== actor.email.toLowerCase()) {
      return respond({ success: false, error: "This account cannot confirm handover." }, 403);
    }
    const email = account.email;
    await reauthenticatePassword({ expectedUid: actor.uid, email, password });
    const current = await auth.getUser(actor.uid);
    if (current.uid !== actor.uid || current.disabled === true || current.email !== email) {
      return respond({ success: false, error: "Your account changed. Sign in again before confirming." }, 403);
    }
  } catch (error) {
    if (error instanceof PasswordReauthenticationError) return respond({ success: false, error: error.message }, error.status);
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "auth/user-not-found") {
      return respond({ success: false, error: "This account cannot confirm handover." }, 403);
    }
    // Upstream exceptions can carry credentials; never log the raw payload.
    console.error("Equal handover v2 confirmation password reauthentication failed.");
    return respond({ success: false, error: "Unable to verify your password. Please try again later." }, 503);
  }

  // The authoritative confirmation clock, derived only from this trusted server
  // process — never from a client value and never backdated. Re-captured
  // immediately AFTER the operation request is accepted, because the evidence
  // domain requires the finalization time never precede the operation's
  // `requestedAt`.
  let serverAuthenticationTime = new Date().toISOString();

  let evidenceWritten = false;
  if (ctx.evidenceBinding) {
    const evidenceRequest: AttendanceEvidenceRequest = {
      schema: "attendance-evidence-v2",
      handoverId: ctx.reservation.handoverId,
      handoverDocumentId: ctx.handoverDocumentId,
      eventId: ctx.evidenceBinding.eventId,
      position: ctx.actorPosition,
      technicianUid: actor.uid,
      kind: ctx.evidenceBinding.kind,
      scheduledStart: ctx.identity.scheduledStart,
      scheduledEnd: ctx.identity.scheduledEnd,
      reportedDepartureTime: null,
      attestedByUid: null,
      attestationReason: null,
      lateReason: null,
      handoverRevision: ctx.aggregate.revision,
      snapshotHash: ctx.snapshotHash,
      expectedGuardRevision: ctx.guardRevision,
      expectedFencingEpoch: ctx.fencingEpoch,
    };
    const trustedAuthentication: AttendanceTrustedAuthentication = {
      verifiedTechnicianUid: actor.uid,
      method: ctx.evidenceBinding.authenticationMethod,
    };
    try {
      const begun = await beginAttendanceEvidenceOperation({ request: evidenceRequest });
      serverAuthenticationTime = new Date().toISOString();
      const finalized = await finalizeAttendanceEvidenceOperation({
        operationId: begun.operation.id,
        identity: ctx.identity,
        reservation: ctx.reservation,
        trustedAuthentication,
        serverAuthenticationTime,
      });
      if (finalized.needsResume) await resumeAttendanceEvidenceOperation(finalized.operation.id);
      evidenceWritten = true;
    } catch (error) {
      if (error instanceof AttendanceEvidenceDomainError) return respond({ success: false, error: error.message }, error.status);
      return mapHandoverV2ReportError(error, "Equal handover v2 confirmation evidence failed:");
    }
  }

  try {
    const result = await confirmEqualHandoverParticipantV2({
      outgoingShiftId: shiftId,
      actorUid: actor.uid,
      ...binding,
    });
    // Best-effort ONLY after the authoritative confirmation committed. A failure
    // here cannot affect the confirmation and never participates in its transaction.
    await markActionedByReference(actor.uid, {
      eventKinds: [NOTIFICATION_EVENT_KINDS.OUTGOING_CONFIRMATION_REQUIRED],
      outgoingShiftId: shiftId,
    }, new Date().toISOString()).catch(() => {});
    return respond({
      success: true,
      confirmation: { aggregate: result.aggregate, snapshotHash: result.snapshotHash, replayed: result.replayed },
      evidenceWritten,
    }, 200);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 confirmation failed:");
  }
}
