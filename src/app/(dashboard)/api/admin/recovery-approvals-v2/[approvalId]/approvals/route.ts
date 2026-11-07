import "server-only";

import { NextRequest } from "next/server";

import {
  handoverV2Enabled,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import { authenticateHandoverRecoveryApproval } from "@/lib/operations/handover-recovery-approval-coordinator";
import { countersignHandoverRecoveryApprovalV2 } from "@/lib/operations/handover-recovery-approval-v2-firestore";
import {
  parseHandoverRecoveryApprovalV2CountersignBody,
  validHandoverRecoveryApprovalV2Id,
} from "@/lib/operations/handover-recovery-approval-v2-domain";
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

// The complementary role personally adds the second signature. The evidence is
// re-read and reclassified inside this transaction: if anything moved after the
// first signature, the second is refused rather than the intent being rewritten.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) {
    return approvalV2Failure("Not found.", 404);
  }

  const resolved = await authorizeRecoveryApproverV2();
  if ("error" in resolved) return resolved.error;
  if (!sameOrigin(request)) {
    return approvalV2Failure("Invalid request origin.", 403);
  }

  const { approvalId } = await context.params;
  if (!validHandoverRecoveryApprovalV2Id(approvalId)) {
    return approvalV2Failure("Invalid approval.", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return approvalV2Failure("Provide a complementary approval.", 400);
  }

  try {
    const { intent, credential } = parseHandoverRecoveryApprovalV2CountersignBody(body);
    const authentication = await authenticateHandoverRecoveryApproval({
      actor: resolved.actor,
      password: credential.password,
    });
    const result = await countersignHandoverRecoveryApprovalV2({
      approvalId,
      actorUid: resolved.actor.uid,
      intent,
      authentication,
    });
    return approvalV2Json({
      success: true,
      replayed: result.replayed,
      approval: result.view,
      audit: { id: result.auditId, state: result.replayed ? "replayed" : "recorded" },
      recoveryExecutionEligible: false,
    });
  } catch (error) {
    return mapHandoverRecoveryApprovalV2Error(error);
  }
}
