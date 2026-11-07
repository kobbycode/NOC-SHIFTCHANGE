import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { applySessionCookie } from "@/lib/auth/session-cookie";
import {
  ACCEPTANCE_RESPONSE_CODES,
  atomicRespond,
  handoverV2AtomicAcceptanceEnabled,
  mapAtomicAcceptanceError,
  notificationPosture,
  parseAtomicAcceptBody,
  reconciliationView,
} from "@/lib/operations/handover-v2-atomic-http";
import { coordinateAtomicIncomingAcceptance } from "@/lib/operations/incoming-acceptance-http-coordinator";
import { issueIncomingHandoverSession } from "@/lib/operations/handover-session-issuance";
import { sameOrigin } from "@/lib/operations/handover-v2-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

function committedAtIso(receipt: { committedAt: { state: string; seconds?: number; nanoseconds?: number } }) {
  if (receipt.committedAt.state !== "resolved") return null;
  return new Date(
    (receipt.committedAt.seconds ?? 0) * 1_000 +
      Math.floor((receipt.committedAt.nanoseconds ?? 0) / 1_000_000),
  ).toISOString();
}

// 09M-R3B.2 Phase 5 — the ONLY HTTP entry point for the atomic incoming
// acceptance protocol. It is doubly gated (`HANDOVER_V2_DEV` AND the separate
// `HANDOVER_V2_ATOMIC_ACCEPTANCE` switch) and defaults to 404. The route never
// falls back to the legacy split writer: an atomic attempt either produces a
// validated receipt or an explicit non-committed/unknown outcome.
//
// Phase 3 session issuance: the console session authorizes use of this console
// but is NOT the accepting technician. The coordinator verifies the named
// reserved incoming technician's own password; only after the acceptance has
// committed does this route exchange that one-shot token for their session
// cookie and revoke the outgoing pair on the first activation. The receipt, its
// hash and the reconciliation view are unchanged by issuance.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2AtomicAcceptanceEnabled()) {
    return atomicRespond({ success: false, error: "Not found." }, 404);
  }
  const consoleActor = await getCurrentUser();
  if (!consoleActor) return atomicRespond({ success: false, error: "Please sign in to continue." }, 401);
  if (consoleActor.role !== "technician" || consoleActor.mustChangePassword) {
    return atomicRespond(
      { success: false, error: "Your account is not authorized to accept v2 handovers." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return atomicRespond({ success: false, error: "Invalid request origin." }, 403);
  }

  const { shiftId } = await context.params;
  let body: unknown;
  try { body = await request.json(); }
  catch { return atomicRespond({ success: false, error: "Invalid acceptance JSON." }, 400); }

  let reviewed;
  try {
    reviewed = parseAtomicAcceptBody(body);
  } catch (error) {
    return mapAtomicAcceptanceError(error, "Atomic acceptance request rejected:");
  }

  try {
    const { result, receipt, reconciliation, sessionCredential } = await coordinateAtomicIncomingAcceptance({
      outgoingShiftId: shiftId,
      actor: {
        uid: consoleActor.uid,
        email: consoleActor.email,
        role: consoleActor.role,
        mustChangePassword: consoleActor.mustChangePassword,
      },
      reviewed,
    });

    const code = result.replayed
      ? ACCEPTANCE_RESPONSE_CODES.ALREADY_APPLIED
      : result.outcome === "first_activation"
        ? ACCEPTANCE_RESPONSE_CODES.APPLIED_FIRST_ACTIVATION
        : ACCEPTANCE_RESPONSE_CODES.APPLIED_SUBSEQUENT_JOIN;
    const partnerApplied =
      reconciliation?.partnerApplied ?? (result.outcome === "subsequent_join");

    // Post-commit only, and never inside a transaction. Issuance cannot fail the
    // acceptance: it reports its own outcome truthfully instead of throwing.
    const issuance = await issueIncomingHandoverSession({
      outgoingShiftId: sessionCredential.outgoingShiftId,
      handoverDocumentId: sessionCredential.handoverDocumentId,
      acceptingTechnicianUid: sessionCredential.acceptingTechnicianUid,
      consoleActorUid: sessionCredential.consoleActorUid,
      outgoingTechnicianIds: sessionCredential.outgoingTechnicianIds,
      idToken: sessionCredential.idToken,
      firstActivation: sessionCredential.firstActivation,
      acceptanceReceiptId: sessionCredential.acceptanceReceiptId,
      nowIso: new Date().toISOString(),
    });

    const response = atomicRespond({
      success: true,
      code,
      status: result.status,
      replayed: result.replayed,
      outcome: result.outcome,
      commitState: result.commitState,
      technician: { uid: result.technicianUid },
      handover: {
        documentId: result.handoverDocumentId,
        outgoingShiftId: result.outgoingShiftId,
        incomingShiftId: result.incomingShiftId,
        position: result.position,
      },
      acceptance: {
        receiptId: receipt.id,
        receiptHash: receipt.receiptHash,
        requestAcceptedAt: receipt.requestAcceptedAt,
        passwordVerifiedAt: receipt.passwordVerifiedAt,
        operationalAppliedAt: receipt.operationalAppliedAt,
        committedAt: committedAtIso(receipt),
        lateReasonSource: receipt.lateReasonSource,
        reviewedBinding: receipt.reviewedBinding,
      },
      lifecycle: {
        aggregateLifecycleStatus: reconciliation?.aggregateLifecycleStatus ?? "completed",
        partnerApplied,
        acceptanceComplete: partnerApplied,
        guardState: result.guardCleanup,
        nextAction: partnerApplied ? "GUARD_FINALIZATION_ELIGIBLE" : "AWAIT_PARTNER_ACCEPTANCE",
        guardFinalization: "separate_authorized_route",
      },
      notifications: notificationPosture(result.notificationDelivery),
      reconciliation: reconciliation === null ? null : reconciliationView(reconciliation),
      session: {
        issued: issuance.issued,
        firstActivation: sessionCredential.firstActivation,
        acceptingTechnicianUid: sessionCredential.acceptingTechnicianUid,
        consoleActorUid: sessionCredential.consoleActorUid,
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
    return mapAtomicAcceptanceError(error, "Atomic incoming acceptance failed:");
  }
}
