import "server-only";

import { NextRequest } from "next/server";

import {
  handoverV2Enabled,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import { authenticateHandoverRecoveryApproval } from "@/lib/operations/handover-recovery-approval-coordinator";
import {
  listHandoverRecoveryApprovalsV2,
  requestHandoverRecoveryApprovalV2,
} from "@/lib/operations/handover-recovery-approval-v2-firestore";
import {
  approvalV2Failure,
  approvalV2Json,
  authorizeRecoveryApproverV2,
  mapHandoverRecoveryApprovalV2Error,
  recoveryHandoverDocumentIdV2,
} from "@/lib/operations/handover-recovery-approval-v2-http";
import { parseHandoverRecoveryApprovalV2RequestBody } from "@/lib/operations/handover-recovery-approval-v2-domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only Version 2 approval state for one handover.
export async function GET(request: NextRequest) {
  if (!handoverV2Enabled()) {
    return approvalV2Failure("Not found.", 404);
  }

  const resolved = await authorizeRecoveryApproverV2();
  if ("error" in resolved) return resolved.error;

  const param = recoveryHandoverDocumentIdV2(
    request.nextUrl.searchParams.get("handoverDocumentId"),
  );
  if ("error" in param) return param.error;

  try {
    const approvals = await listHandoverRecoveryApprovalsV2({
      handoverDocumentId: param.handoverDocumentId,
      nowIso: new Date().toISOString(),
    });
    return approvalV2Json({
      success: true,
      approvals,
      recoveryExecutionEligible: false,
    });
  } catch (error) {
    return mapHandoverRecoveryApprovalV2Error(error);
  }
}

// The requester records the first personal approval. This binds the classifier's
// digest and classification to one intent, and writes exactly one approval
// document and one audit row. Nothing operational is written and no recovery is
// authorized.
export async function POST(request: NextRequest) {
  if (!handoverV2Enabled()) {
    return approvalV2Failure("Not found.", 404);
  }

  const resolved = await authorizeRecoveryApproverV2();
  if ("error" in resolved) return resolved.error;
  if (!sameOrigin(request)) {
    return approvalV2Failure("Invalid request origin.", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return approvalV2Failure("Provide a recovery approval request.", 400);
  }

  try {
    const { intent, credential } = parseHandoverRecoveryApprovalV2RequestBody(body);
    const authentication = await authenticateHandoverRecoveryApproval({
      actor: resolved.actor,
      password: credential.password,
    });
    const result = await requestHandoverRecoveryApprovalV2({
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
