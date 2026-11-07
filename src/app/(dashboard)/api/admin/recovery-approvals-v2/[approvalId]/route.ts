import "server-only";

import { NextRequest } from "next/server";

import { handoverV2Enabled } from "@/lib/operations/handover-v2-report-http";
import { readHandoverRecoveryApprovalV2 } from "@/lib/operations/handover-recovery-approval-v2-firestore";
import { validHandoverRecoveryApprovalV2Id } from "@/lib/operations/handover-recovery-approval-v2-domain";
import {
  approvalV2Failure,
  approvalV2Json,
  authorizeRecoveryApproverV2,
  mapHandoverRecoveryApprovalV2Error,
} from "@/lib/operations/handover-recovery-approval-v2-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ approvalId: string }>;
};

// One Version 2 approval, with its effective status derived at read time. An
// expired intent reports as expired without any write and without a scheduler.
export async function GET(_request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) {
    return approvalV2Failure("Not found.", 404);
  }

  const resolved = await authorizeRecoveryApproverV2();
  if ("error" in resolved) return resolved.error;

  const { approvalId } = await context.params;
  if (!validHandoverRecoveryApprovalV2Id(approvalId)) {
    return approvalV2Failure("Invalid approval.", 400);
  }

  try {
    const approval = await readHandoverRecoveryApprovalV2({
      approvalId,
      nowIso: new Date().toISOString(),
    });
    return approvalV2Json({
      success: true,
      approval,
      recoveryExecutionEligible: false,
    });
  } catch (error) {
    return mapHandoverRecoveryApprovalV2Error(error);
  }
}
