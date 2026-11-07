import "server-only";

import { getCurrentUser } from "@/lib/auth/session";
import { handoverV2Enabled } from "@/lib/operations/handover-v2-report-http";
import {
  validHandoverRecoveryApprovalId,
} from "@/lib/operations/handover-recovery-approval-domain";
import { readHandoverRecoveryApproval } from "@/lib/operations/handover-recovery-approval-firestore";
import {
  approvalFailure,
  approvalJson,
  mapHandoverRecoveryApprovalError,
} from "@/lib/operations/handover-recovery-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ approvalId: string }>;
};

// Phase 8C.2b — read-only state of one approval intent.
export async function GET(_request: Request, context: Context) {
  if (!handoverV2Enabled()) {
    return approvalFailure("Not found.", 404);
  }

  const actor = await getCurrentUser();
  if (!actor) {
    return approvalFailure("Please sign in to continue.", 401);
  }
  if (
    (actor.role !== "admin" && actor.role !== "supervisor") ||
    actor.mustChangePassword
  ) {
    return approvalFailure(
      "Only authorized supervisors and administrators can review recovery intents.",
      403,
    );
  }

  const { approvalId } = await context.params;
  if (!validHandoverRecoveryApprovalId(approvalId)) {
    return approvalFailure("Invalid approval.", 400);
  }

  try {
    const approval = await readHandoverRecoveryApproval({
      approvalId,
      nowIso: new Date().toISOString(),
    });
    return approvalJson({
      success: true,
      approval,
      recoveryExecutionEligible: false,
    });
  } catch (error) {
    return mapHandoverRecoveryApprovalError(error);
  }
}
