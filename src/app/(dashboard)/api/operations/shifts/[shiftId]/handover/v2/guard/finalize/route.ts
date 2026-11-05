import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  ACCEPTANCE_RESPONSE_CODES,
  atomicRespond,
  handoverV2AtomicAcceptanceEnabled,
  mapGuardFinalizationError,
  parseGuardFinalizeBody,
} from "@/lib/operations/handover-v2-atomic-http";
import { sameOrigin } from "@/lib/operations/handover-v2-report-http";
import { finalizeIncomingAcceptanceGuardAtomically } from "@/lib/operations/incoming-acceptance-guard-finalization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ shiftId: string }> };

// 09M-R3B.2 Phase 5 — receipt-backed guard finalization. Normal closure happens
// only after BOTH reserved incoming technicians hold validated application
// receipts; an exceptional closure is allowed only for an existing authorized
// `not_yet_in` declaration and only for a non-participating supervisor. The
// actor and decision clock are server-derived. There is no automatic closure
// after the first acceptance.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2AtomicAcceptanceEnabled()) {
    return atomicRespond({ success: false, error: "Not found." }, 404);
  }
  const actor = await getCurrentUser();
  if (!actor) return atomicRespond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.mustChangePassword) {
    return atomicRespond(
      { success: false, error: "Change your password before finalizing handover guards." },
      403,
    );
  }
  if (actor.role !== "technician" && actor.role !== "supervisor") {
    return atomicRespond(
      { success: false, error: "Your account is not authorized to finalize handover guards." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return atomicRespond({ success: false, error: "Invalid request origin." }, 403);
  }

  const { shiftId } = await context.params;
  let body: unknown = {};
  try {
    const text = await request.text();
    body = text.trim().length === 0 ? {} : JSON.parse(text);
  } catch {
    return atomicRespond({ success: false, error: "Invalid guard finalization JSON." }, 400);
  }
  let closure;
  try {
    closure = parseGuardFinalizeBody(body);
  } catch (error) {
    return mapGuardFinalizationError(error, "Guard finalization request rejected:");
  }

  try {
    const nowIso = new Date().toISOString();
    const result = await finalizeIncomingAcceptanceGuardAtomically({
      outgoingShiftId: shiftId,
      actorUid: actor.uid,
      nowIso,
      // The decision time is the trusted server clock, never a client field.
      exceptionalClosure: closure === null ? null : { ...closure, recordedAt: nowIso },
    });
    return atomicRespond({
      success: true,
      code: result.status === "FINALIZED"
        ? ACCEPTANCE_RESPONSE_CODES.GUARD_FINALIZED
        : ACCEPTANCE_RESPONSE_CODES.GUARD_ALREADY_FINALIZED,
      status: result.status,
      replayed: result.replayed,
      mode: result.mode,
      provenance: result.provenance,
      commitState: result.commitState,
      lifecycleState: result.lifecycleState,
      handover: {
        documentId: result.handoverDocumentId,
        outgoingShiftId: result.outgoingShiftId,
        incomingShiftId: result.incomingShiftId,
      },
      guard: {
        id: result.guardId,
        revision: result.guardRevision,
        terminalEvidenceRef: result.terminalEvidenceRef,
      },
      applications: result.applications,
      closure: result.closure,
      audit: { id: result.auditId, state: result.auditState },
      notifications: {
        // Closure notifications require a separate product decision; none are
        // emitted or claimed here.
        delivery: "not_claimed",
        state: "not_emitted",
        reason: "closure_notification_requires_product_decision",
      },
    }, 200);
  } catch (error) {
    return mapGuardFinalizationError(error, "Guard finalization failed:");
  }
}
