import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAdminAuth } from "@/lib/firebase/admin";
import { PasswordReauthenticationError, authenticatePasswordForSession } from "@/lib/auth/password-reauthentication";
import { applySessionCookie } from "@/lib/auth/session-cookie";
import type {
  AttendanceEvidenceRequest,
  AttendanceTrustedAuthentication,
} from "@/types/attendance-evidence";
import {
  acceptEqualHandoverIncomingV2,
  authorizeHandoverConsoleActor,
  finalizeEqualHandoverReservationV2,
  isEqualHandoverIncomingAttendanceResolved,
  readEqualHandoverAcceptanceContext,
} from "@/lib/operations/equal-handover-report-firestore";
import { issueIncomingHandoverSession } from "@/lib/operations/handover-session-issuance";
import { markActionedByReference } from "@/lib/notifications/notification-service";
import { NOTIFICATION_EVENT_KINDS } from "@/types/notification";
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
import { handoverV2AtomicAcceptanceEnabled } from "@/lib/operations/handover-v2-atomic-http";
import { normalizeAttendanceLocationEvidence } from "@/lib/operations/attendance-location-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// Stage 2 / Stage 3 (§3-#5 addendum): a reserved INCOMING technician accepts the
// handover with their OWN password on the last page of the A–E form, and that
// acceptance is what signs them in on this shared console. The session holding
// the console is NOT the accepting technician — it is usually still an outgoing
// technician — so it is authorized only as a participant of this handover, while
// every acceptance authority, evidence record and clock is derived from the
// named incoming technician whose credential is verified here.
//
// This route is the trusted acceptance coordinator: it verifies that personal
// password OUTSIDE any transaction, captures the authoritative server clock at
// that instant, records the technician's incoming attendance evidence against
// the still-ACTIVE reservation guard, then lets the activation/join transaction
// re-derive every authority and write the shift activation + `shift_attendance`
// atomically. It never trusts a client role, evidence kind or timestamp (§4), and
// the named UID is constrained to the authoritative incoming roster before it
// authorizes anything. The FIRST authorized acceptance activates the reserved
// incoming shift exactly once; a LATER acceptance joins the already-active shift
// with its own independent attendance time.
//
// Only after the acceptance commits does it exchange the one-shot id token for
// the incoming technician's session cookie and revoke the outgoing pair. The
// password and the id token are never persisted, logged or echoed, and no
// credential ever reaches the service or the receipt.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) return respond({ success: false, error: "Not found." }, 404);
  const consoleActor = await getCurrentUser();
  if (!consoleActor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (consoleActor.role !== "technician" || consoleActor.mustChangePassword) {
    return respond({ success: false, error: "Your account is not authorized to accept v2 handovers." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);

  // With the atomic protocol enabled this legacy split writer refuses the
  // intent outright: an acceptance must never silently fall back to the old
  // evidence-then-transaction path once the atomic gate is on.
  if (handoverV2AtomicAcceptanceEnabled()) {
    return respond({
      success: false,
      code: "ACCEPTANCE_ATOMIC_PROTOCOL_ENABLED",
      error: "Atomic incoming acceptance is enabled for this environment. Use the atomic acceptance interface; the legacy acceptance writer is disabled.",
    }, 409);
  }

  const { shiftId } = await context.params;
  let body: unknown;
  try { body = await request.json(); }
  catch { return respond({ success: false, error: "Invalid acceptance JSON." }, 400); }
  // Malformed acceptance bodies (missing password, missing accepting technician
  // or any reviewed binding field) are refused with their proper 400 here,
  // matching the commit route — they must never escape as an unhandled 500 (§11).
  let reviewed;
  try {
    reviewed = parseAcceptBody(body);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 acceptance request rejected:");
  }
  const { technicianUid: acceptingTechnicianUid, password } = reviewed;

  // The console itself must belong to this reserved pair. This discloses nothing
  // about another shift and is never a substitute for the accepting technician's
  // own credential below.
  try {
    await authorizeHandoverConsoleActor(shiftId, consoleActor.uid);
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 acceptance console authorization failed:");
  }

  // Authoritative context for the ACCEPTING technician: derives their incoming
  // authority, the evidence kind (personal clock-in vs audited late acceptance),
  // the deterministic event id and the live guard/snapshot binding. It authorizes
  // nothing and changes nothing — the accept transaction re-derives all of it.
  let ctx;
  try {
    ctx = await readEqualHandoverAcceptanceContext(shiftId, acceptingTechnicianUid);
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

  // Fresh personal password verification for the NAMED incoming technician,
  // strictly BEFORE any transaction, using their authoritative Auth account
  // email — never a client email. This is the only credential path that retains
  // a one-shot id token, because acceptance must also sign that person in.
  let idToken: string;
  try {
    const auth = getAdminAuth();
    const account = await auth.getUser(acceptingTechnicianUid);
    if (account.uid !== acceptingTechnicianUid || account.disabled === true || !account.email) {
      return respond({ success: false, error: "This account cannot accept the handover." }, 403);
    }
    const email = account.email;
    const verified = await authenticatePasswordForSession({ expectedUid: acceptingTechnicianUid, email, password });
    idToken = verified.idToken;
    const current = await auth.getUser(acceptingTechnicianUid);
    if (current.uid !== acceptingTechnicianUid || current.disabled === true || current.email !== email) {
      return respond({ success: false, error: "Your account changed. Sign in again before accepting." }, 403);
    }
  } catch (error) {
    if (error instanceof PasswordReauthenticationError) return respond({ success: false, error: error.message }, error.status);
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "auth/user-not-found") {
      return respond({ success: false, error: "This account cannot accept the handover." }, 403);
    }
    // Upstream exceptions can carry credentials; never log the raw payload.
    console.error("Equal handover v2 acceptance password verification failed.");
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
      technicianUid: acceptingTechnicianUid,
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
      verifiedTechnicianUid: acceptingTechnicianUid,
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
      actorUid: acceptingTechnicianUid,
      serverAuthenticationTime,
      expectedRevision: reviewed.expectedRevision,
      expectedSnapshotHash: reviewed.expectedSnapshotHash,
      expectedGuardRevision: reviewed.expectedGuardRevision,
      expectedFencingEpoch: reviewed.expectedFencingEpoch,
      // Coarse presence evidence for this personal act; a missing or malformed
      // payload records an explicit not-captured state and never blocks.
      locationEvidence: normalizeAttendanceLocationEvidence(
        reviewed.locationEvidence,
        serverAuthenticationTime,
      ),
    });

    // Terminalize the deferred guard only once BOTH incoming technicians have
    // personally accepted. A lingering active guard for an unarrived partner is
    // correct and remains recoverable; never fail the committed acceptance.
    let guardFinalized = false;
    try {
      if (await isEqualHandoverIncomingAttendanceResolved(shiftId)) {
        await finalizeEqualHandoverReservationV2({ outgoingShiftId: shiftId, actorUid: acceptingTechnicianUid });
        guardFinalized = true;
      }
    } catch (error) {
      console.error("Equal handover v2 guard finalization deferred; acceptance already committed:", error);
    }

    // Best-effort ONLY after the authoritative acceptance committed. Never in the
    // transaction; a failure here cannot affect the accepted handover.
    await markActionedByReference(acceptingTechnicianUid, {
      eventKinds: [NOTIFICATION_EVENT_KINDS.INCOMING_ACCEPTANCE_REQUIRED],
      outgoingShiftId: shiftId,
    }, new Date().toISOString()).catch(() => {});

    // The shared console becomes the accepting technician's session, and the
    // outgoing pair is signed out — once, on the first committed acceptance.
    // Post-commit and best-effort: a failure here is reported truthfully and can
    // never un-commit the acceptance. The one-shot token is consumed here and
    // never appears in the response body, a receipt or a log.
    const issuance = await issueIncomingHandoverSession({
      outgoingShiftId: shiftId,
      handoverDocumentId: ctx.handoverDocumentId,
      acceptingTechnicianUid,
      consoleActorUid: consoleActor.uid,
      outgoingTechnicianIds: ctx.identity.outgoingTechnicianIds,
      idToken,
      firstActivation: result.status === "ACTIVATED",
      acceptanceReceiptId: result.receipt?.id ?? null,
      nowIso: new Date().toISOString(),
    });

    const response = respond({
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
      session: {
        issued: issuance.issued,
        firstActivation: result.status === "ACTIVATED",
        acceptingTechnicianUid,
        consoleActorUid: consoleActor.uid,
        issuanceId: issuance.issuanceId,
        issuanceRecorded: issuance.issuanceRecorded,
        replayed: issuance.replayed,
        outgoingSessionsRevoked: issuance.outgoingSessionsRevoked,
        revokedOutgoingTechnicianUids: issuance.revokedOutgoingTechnicianUids,
      },
    }, 200);
    if (issuance.sessionCookie !== null) applySessionCookie(response, issuance.sessionCookie);
    return response;
  } catch (error) {
    return mapHandoverV2ReportError(error, "Equal handover v2 incoming acceptance failed:");
  }
}