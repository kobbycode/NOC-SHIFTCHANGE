import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  RECONCILIATION_GUIDANCE,
  atomicRespond,
  handoverV2AtomicAcceptanceEnabled,
  mapAtomicAcceptanceError,
} from "@/lib/operations/handover-v2-atomic-http";
import { reconcileIncomingAcceptance } from "@/lib/operations/incoming-acceptance-reconciliation";
import { readIncomingAcceptanceGuardLifecycle } from "@/lib/operations/incoming-acceptance-guard-finalization";
import { authorizeHandoverConsoleActor } from "@/lib/operations/equal-handover-report-firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// 09M-R3B.2 Phase 5 — read-only acceptance status. It performs no writes and
// reports only receipt-backed state. A technician may read their own acceptance,
// and — because the last page of the A–E form is a shared console that offers
// both reserved incoming identities — a participant of this reserved pair may
// also read a NAMED reserved incoming technician of the same handover. That
// discloses nothing the participant cannot already read from `/report`. Anyone
// outside the pair, or any uid outside the incoming roster, is refused before any
// acceptance read. An active supervisor may read a reserved incoming technician.
export async function GET(request: NextRequest, context: Context) {
  if (!handoverV2AtomicAcceptanceEnabled()) {
    return atomicRespond({ success: false, error: "Not found." }, 404);
  }
  const actor = await getCurrentUser();
  if (!actor) return atomicRespond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.mustChangePassword) {
    return atomicRespond(
      { success: false, error: "Change your password before viewing handover acceptance." },
      403,
    );
  }

  const requested = request.nextUrl.searchParams.get("technicianUid");
  try {
    const { shiftId } = await context.params;
    let technicianUid: string;
    if (actor.role === "technician") {
      if (requested === null || requested === actor.uid) {
        technicianUid = actor.uid;
      } else {
        const roster = await authorizeHandoverConsoleActor(shiftId, actor.uid);
        if (!roster.incomingTechnicianIds.includes(requested)) {
          return atomicRespond(
            { success: false, error: "You may only read acceptance status for this handover's reserved incoming technicians." },
            403,
          );
        }
        technicianUid = requested;
      }
    } else if (actor.role === "supervisor") {
      if (requested === null || requested.length === 0 || requested.length > 128) {
        return atomicRespond(
          { success: false, error: "A technician UID is required to read acceptance status." },
          400,
        );
      }
      technicianUid = requested;
    } else {
      return atomicRespond(
        { success: false, error: "Your account is not authorized to read acceptance status." },
        403,
      );
    }

    const status = await reconcileIncomingAcceptance({
      outgoingShiftId: shiftId,
      technicianUid,
    });
    // The guard decision is the same pure classification the finalization
    // transaction enforces; it is read-only here and drives the truthful
    // "eligible / outstanding partner / review required" display.
    const guardClosure = await readIncomingAcceptanceGuardLifecycle({
      outgoingShiftId: shiftId,
      technicianUid,
      nowIso: new Date().toISOString(),
    });
    // A terminal guard means acceptance can no longer be submitted by anyone.
    // The reconciliation guidance for a technician with no receipt would
    // otherwise still say "retry acceptance", which is impossible here.
    const guidance = guardClosure?.state === "guard_finalized" && !status.applied
      ? "ACCEPTANCE_CLOSED"
      : RECONCILIATION_GUIDANCE[status.status];
    return atomicRespond({
      success: true,
      readOnly: true,
      status: status.status,
      reason: status.reason,
      guidance,
      technicianUid: status.technicianUid,
      partnerTechnicianUid: status.partnerTechnicianUid,
      partnerApplied: status.partnerApplied,
      handover: {
        documentId: status.handoverDocumentId,
        outgoingShiftId: status.outgoingShiftId,
        incomingShiftId: status.incomingShiftId,
        aggregateLifecycleStatus: status.aggregateLifecycleStatus,
      },
      acceptance: {
        applied: status.applied,
        outcome: status.outcome,
        receiptId: status.receiptId,
        receiptHash: status.receiptHash,
        operationalAppliedAt: status.operationalAppliedAt,
        retryWouldReplay: status.retryWouldReplay,
        requiresAdministrativeReview: status.requiresAdministrativeReview,
      },
      lifecycle: {
        guardLifecycleState: status.guardLifecycleState,
        guardClosureState: guardClosure?.state ?? null,
        guardClosureReason: guardClosure?.reason ?? null,
        outstandingTechnicianUids: guardClosure?.missingTechnicianUids ?? [],
        guardTerminalEvidenceRef: status.guardTerminalEvidenceRef,
        activationReceiptId: status.activationReceiptId,
        activationReceiptHash: status.activationReceiptHash,
      },
      diagnostics: {
        evidencePresent: status.evidencePresent,
        operationFinalized: status.operationFinalized,
        membershipPresent: status.membershipPresent,
        attendancePresent: status.attendancePresent,
        applicationAuditPresent: status.applicationAuditPresent,
        legacyClassification: status.legacyClassification,
      },
      // No proof, password, credential or token material is stored or returned.
    }, 200);
  } catch (error) {
    return mapAtomicAcceptanceError(error, "Incoming acceptance status read failed:");
  }
}
