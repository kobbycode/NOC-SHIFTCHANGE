import "server-only";

import { NextRequest } from "next/server";

import {
  handoverV2Enabled,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import { authenticateHandoverRecoveryApproval } from "@/lib/operations/handover-recovery-approval-coordinator";
import { reissueHandoverRecoveryApprovalV2 } from "@/lib/operations/handover-recovery-approval-v2-firestore";
import {
  parseHandoverRecoveryApprovalV2ReissueBody,
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

// Reissue mints a brand new Version 2 identity from a voided original and
// reclassifies it against the evidence as it stands now; it never inherits the
// voided intent's conclusion, and the original is preserved untouched.
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
    return approvalV2Failure("Provide a reissue request.", 400);
  }

  try {
    const { intent, credential } = parseHandoverRecoveryApprovalV2ReissueBody(body);
    const authentication = await authenticateHandoverRecoveryApproval({
      actor: resolved.actor,
      password: credential.password,
    });
    const result = await reissueHandoverRecoveryApprovalV2({
      approvalId,
      actorUid: resolved.actor.uid,
      intent,
      authentication,
    });
    return approvalV2Json(
      {
        success: true,
        replayed: result.replayed,
        approval: result.view,
        audit: { id: result.auditId, state: result.replayed ? "replayed" : "recorded" },
        recoveryExecutionEligible: false,
      },
      result.replayed ? 200 : 201,
    );
  } catch (error) {
    return mapHandoverRecoveryApprovalV2Error(error);
  }
}
