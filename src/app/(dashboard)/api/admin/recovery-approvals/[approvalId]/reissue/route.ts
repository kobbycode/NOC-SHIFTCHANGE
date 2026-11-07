import "server-only";

import { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  handoverV2Enabled,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import {
  parseHandoverRecoveryApprovalReissueBody,
  validHandoverRecoveryApprovalId,
} from "@/lib/operations/handover-recovery-approval-domain";
import { authenticateHandoverRecoveryApproval } from "@/lib/operations/handover-recovery-approval-coordinator";
import { reissueHandoverRecoveryApproval } from "@/lib/operations/handover-recovery-approval-firestore";
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

// A voided intent can be reissued under a new server-generated identity. The
// voided original is preserved and names its successor.
export async function POST(request: NextRequest, context: Context) {
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
      "Only authorized supervisors and administrators can reissue recovery intents.",
      403,
    );
  }
  if (!sameOrigin(request)) {
    return approvalFailure("Invalid request origin.", 403);
  }

  const { approvalId } = await context.params;
  if (!validHandoverRecoveryApprovalId(approvalId)) {
    return approvalFailure("Invalid approval.", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return approvalFailure("Provide a reissue request.", 400);
  }

  try {
    const { intent, credential } = parseHandoverRecoveryApprovalReissueBody(body);
    const authentication = await authenticateHandoverRecoveryApproval({
      actor,
      password: credential.password,
    });
    const result = await reissueHandoverRecoveryApproval({
      approvalId,
      actorUid: actor.uid,
      intent,
      authentication,
    });
    return approvalJson(
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
    return mapHandoverRecoveryApprovalError(error);
  }
}
