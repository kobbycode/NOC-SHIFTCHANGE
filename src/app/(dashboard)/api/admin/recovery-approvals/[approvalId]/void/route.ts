import "server-only";

import { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  handoverV2Enabled,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import {
  parseHandoverRecoveryApprovalVoidBody,
  validHandoverRecoveryApprovalId,
} from "@/lib/operations/handover-recovery-approval-domain";
import { authenticateHandoverRecoveryApproval } from "@/lib/operations/handover-recovery-approval-coordinator";
import { voidHandoverRecoveryApproval } from "@/lib/operations/handover-recovery-approval-firestore";
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

// Voiding is an explicit, terminal act by a person who approved the intent.
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
      "Only authorized supervisors and administrators can void recovery intents.",
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
    return approvalFailure("Provide a void request.", 400);
  }

  try {
    const { intent, credential } = parseHandoverRecoveryApprovalVoidBody(body);
    const authentication = await authenticateHandoverRecoveryApproval({
      actor,
      password: credential.password,
    });
    const result = await voidHandoverRecoveryApproval({
      approvalId,
      actorUid: actor.uid,
      intent,
      authentication,
    });
    return approvalJson({
      success: true,
      replayed: result.replayed,
      approval: result.view,
      audit: { id: result.auditId, state: result.replayed ? "replayed" : "recorded" },
      recoveryExecutionEligible: false,
    });
  } catch (error) {
    return mapHandoverRecoveryApprovalError(error);
  }
}
