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
  acceptEqualHandoverIncomingV2,
  finalizeEqualHandoverReservationV2,
  isEqualHandoverIncomingAttendanceResolved,
  readEqualHandoverAcceptanceContext,
} from "@/lib/operations/equal-handover-report-firestore";
import {
  AttendanceEvidenceDomainError,
  beginAttendanceEvidenceOperation,
  finalizeAttendanceEvidenceOperation,
  resumeAttendanceEvidenceOperation,
} from "@/lib/operations/attendance-evidence-firestore";
import {
  handoverV2Enabled,
  mapHandoverV2ReportError,
  parseAcceptBody,
  respond,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// Stage 2 / Stage 3 (§3-#5 addendum): a reserved INCOMING technician accepts the
// handover with their OWN password. This route is the trusted acceptance
// coordinator: it verifies the personal password event OUTSIDE any transaction,
// captures the authoritative server clock at that instant, records the
// technician's incoming attendance evidence against the still-ACTIVE reservation
// guard, then lets the activation/join transaction re-derive every authority and
// write the shift activation + `shift_attendance` atomically. It never trusts a
// client technician UID, role, evidence kind or timestamp (§4): those come only
// from the verified session and the authoritative context read. The FIRST
// authorized acceptance activates the reserved incoming shift exactly once; a
// LATER acceptance joins the already-active shift with its own independent
// attendance time. Passwords are never persisted or logged.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account is not authorized to accept v2 handovers." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);

  const { shiftId } = await context.params;
  let body: unknown;
  try { body = await request.json(); }
  catch { return respond({ success: false, error: "Invalid acceptance JSON." }, 400); }
  // Malformed acceptance bodies (missing password or any reviewed binding
  // field) are refused with their proper 400 here, matching the commit route —
  // they must never escape the handler as an unhandled 500 (§11).
  let reviewed;
  try {
    reviewed = parseAcceptBody(body);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 acceptance request rejected:");
  }

  // Authoritative context: derives the caller's incoming-technician authority,
  // the evidence kind (personal clock-in vs audited late acceptance), the
  // deterministic event id and the live guard/snapshot binding. It authorizes
  // nothing and changes nothing — the accept transaction re-derives all of it.
  let ctx;
  try {
    ctx = await readEqualHandoverAcceptanceContext(shiftId, actor.uid);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 acceptance context read failed:");
  }

  // Acceptance opens only after the outgoing commit, and never on stale review
  // or a moved guard — rejected before any credential exchange or evidence write.
  if (ctx.lifecycleStatus === "collecting_confirmations") {
    return respond({ success: false, error: "This handover is not yet awaiting incoming acceptance." }, 409);
  }
  if (ctx.lifecycleStatus === "cancelled" || ctx.lifecycleStatus === "superseded") {
    return respond({ success: false, error: `The handover is ${ctx.lifecycleStatus}; acceptance is closed.` }, 409);
  }
  if (reviewed.expectedRevision !== ctx.aggregate.revision || reviewed.expectedSnapshotHash !== ctx.snapshotHash) {
    return respond({ success: false, error: "The handover changed since it was reviewed. Reload and accept the updated handover." }, 409);
  }
  if (reviewed.expectedGuardRevision !== ctx.guardRevision || reviewed.expectedFencingEpoch !== ctx.fencingEpoch) {
    return respond({ success: false, error: "The reservation guard changed since this handover was reviewed." }, 409);
  }

  // Fresh personal password reauthentication, completed strictly BEFORE any
  // transaction, using the authoritative Auth account email — never a client
  // email or UID. Mirrors the proven confirmation route and discards all tokens.
  try {
    const auth = getAdminAuth();
    const account = await auth.getUser(actor.uid);
    if (account.uid !== actor.uid || account.disabled === true || !account.email ||
        account.email.toLowerCase() !== actor.email.toLowerCase()) {
      return respond({ success: false, error: "This account cannot accept the handover." }, 403);
    }
    const email = account.email;
    await reauthenticatePassword({ expectedUid: actor.uid, email, password: reviewed.password });
    const current = await auth.getUser(actor.uid);
    if (current.uid !== actor.uid || current.disabled === true || current.email !== email) {
      return respond({ success: false, error: "Your account changed. Sign in again before accepting." }, 403);
    }
  } catch (error) {
    if (error instanceof PasswordReauthenticationError) return respond({ success: false, error: error.message }, error.status);
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "auth/user-not-found") {
      return respond({ success: false, error: "This account cannot accept the handover." }, 403);
    }
    // Upstream exceptions can carry credentials; never log the raw payload.
    console.error("Equal handover v2 acceptance password reauthentication failed.");
    return respond({ success: false, error: "Unable to verify your password. Please try again later." }, 503);
  }

  // The authoritative acceptance clock, derived only from this trusted server
  // process — never from a client value and never backdated. It is captured the
  // instant the personal password event verified for the replay/join path, and
  // re-captured immediately AFTER the attendance operation request is accepted
  // below (§6): `beginAttendanceEvidenceOperation` stamps the operation's
  // `requestedAt` with this same process clock at commit time, and the evidence
  // domain requires the finalization time never precede that request time
  // (attendance-evidence-domain.ts `buildAttendanceEvidence`). Re-reading the
  // clock after begin records the acceptance instant at the operation-request
  // boundary without inverting that ordering.
  let serverAuthenticationTime = new Date().toISOString();

  // Pre-activation incoming attendance provenance. Idempotent by deterministic
  // event id; skipped entirely once the technician already has authoritative
  // attendance, so a replay never re-times or duplicates the event.
  let evidenceWritten = false;
  if (!ctx.alreadyAccepted) {
    const evidenceRequest: AttendanceEvidenceRequest = {
      schema: "attendance-evidence-v2",
      handoverId: ctx.reservation.handoverId,
      handoverDocumentId: ctx.handoverDocumentId,
      eventId: ctx.eventId,
      position: ctx.actorPosition,
      technicianUid: actor.uid,
      kind: ctx.evidenceKind,
      scheduledStart: ctx.identity.scheduledStart,
      scheduledEnd: ctx.identity.scheduledEnd,
      reportedDepartureTime: null,
      attestedByUid: null,
      attestationReason: null,
      lateReason: ctx.lateReason,
      handoverRevision: ctx.aggregate.revision,
      snapshotHash: ctx.snapshotHash,
      expectedGuardRevision: ctx.guardRevision,
      expectedFencingEpoch: ctx.fencingEpoch,
    };
    const trustedAuthentication: AttendanceTrustedAuthentication = {
      verifiedTechnicianUid: actor.uid,
      method: ctx.authenticationMethod,
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
      return mapHandoverV2ReportError(error, "Equal handover v2 acceptance evidence failed:");
    }
  }

  // Commit the authoritative activation/join (shift, control, membership and
  // `shift_attendance`) — the transaction re-derives every invariant (§6).
  try {
    const result = await acceptEqualHandoverIncomingV2({
      outgoingShiftId: shiftId,
      actorUid: actor.uid,
      serverAuthenticationTime,
      expectedRevision: reviewed.expectedRevision,
      expectedSnapshotHash: reviewed.expectedSnapshotHash,
      expectedGuardRevision: reviewed.expectedGuardRevision,
      expectedFencingEpoch: reviewed.expectedFencingEpoch,
    });

    // Terminalize the deferred guard only once BOTH incoming technicians have
    // personally accepted. A lingering active guard for an unarrived partner is
    // correct and remains recoverable; never fail the committed acceptance.
    let guardFinalized = false;
    try {
      if (await isEqualHandoverIncomingAttendanceResolved(shiftId)) {
        await finalizeEqualHandoverReservationV2({ outgoingShiftId: shiftId, actorUid: actor.uid });
        guardFinalized = true;
      }
    } catch (error) {
      console.error("Equal handover v2 guard finalization deferred; acceptance already committed:", error);
    }

    return respond({
      success: true,
      status: result.status,
      outcome: result.outcome,
      receipt: result.receipt,
      reservation: { aggregate: result.aggregate, snapshotHash: result.snapshotHash },
      outgoingShiftId: result.outgoingShiftId,
      incomingShiftId: result.incomingShiftId,
      acceptingTechnicianUid: result.acceptingTechnicianUid,
      replayed: result.replayed,
      evidenceWritten,
      guardFinalized,
    }, 200);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 incoming acceptance failed:");
  }
}
