import "server-only";

import { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { handoverV2Enabled } from "@/lib/operations/handover-v2-report-http";
import { evaluateHandoverRecoveryEligibility } from "@/lib/operations/handover-recovery-eligibility-firestore";
import {
  eligibilityFailure,
  eligibilityJson,
  mapHandoverRecoveryEligibilityError,
} from "@/lib/operations/handover-recovery-eligibility-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 8C.3 — read-only recovery eligibility. This endpoint classifies the
// evidence and returns a point-in-time digest; it writes nothing and cannot
// authorize an abandonment.
export async function GET(request: NextRequest) {
  if (!handoverV2Enabled()) {
    return eligibilityFailure("Not found.", 404);
  }

  const actor = await getCurrentUser();
  if (!actor) {
    return eligibilityFailure("Please sign in to continue.", 401);
  }
  if (
    (actor.role !== "admin" && actor.role !== "supervisor") ||
    actor.mustChangePassword
  ) {
    return eligibilityFailure(
      "Only authorized supervisors and administrators can inspect recovery eligibility.",
      403,
    );
  }

  const handoverDocumentId = request.nextUrl.searchParams.get("handoverDocumentId");
  try {
    const { result } = await evaluateHandoverRecoveryEligibility({
      handoverDocumentId,
      actorUid: actor.uid,
    });
    return eligibilityJson({
      success: true,
      eligibility: result,
      recoveryExecutionEligible: false,
    });
  } catch (error) {
    return mapHandoverRecoveryEligibilityError(error);
  }
}
