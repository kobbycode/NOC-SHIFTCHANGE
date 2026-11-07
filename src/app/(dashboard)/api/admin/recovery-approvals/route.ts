import "server-only";

import { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  handoverV2Enabled,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import {
  listHandoverRecoveryApprovals,
  requestHandoverRecoveryApproval,
} from "@/lib/operations/handover-recovery-approval-firestore";
import {
  parseHandoverRecoveryApprovalRequestBody,
  validHandoverDocumentId,
} from "@/lib/operations/handover-recovery-approval-domain";
import { authenticateHandoverRecoveryApproval } from "@/lib/operations/handover-recovery-approval-coordinator";
import {
  approvalFailure,
  approvalJson,
  mapHandoverRecoveryApprovalError,
} from "@/lib/operations/handover-recovery-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function approver() {
  const actor = await getCurrentUser();
  if (!actor) return { error: approvalFailure("Please sign in to continue.", 401) } as const;
  if (
    (actor.role !== "admin" && actor.role !== "supervisor") ||
    actor.mustChangePassword
  ) {
    return {
      error: approvalFailure(
        "Only authorized supervisors and administrators can approve recovery intents.",
        403,
      ),
    } as const;
  }
  return { actor } as const;
}

// Phase 8C.2b — read-only approval state for one handover.
export async function GET(request: NextRequest) {
  if (!handoverV2Enabled()) {
    return approvalFailure("Not found.", 404);
  }

  const resolved = await approver();
  if ("error" in resolved) return resolved.error;

  const handoverDocumentId = request.nextUrl.searchParams.get("handoverDocumentId");
  if (!validHandoverDocumentId(handoverDocumentId)) {
    return approvalFailure("Invalid handover document.", 400);
  }

  try {
    const approvals = await listHandoverRecoveryApprovals({
      handoverDocumentId,
      nowIso: new Date().toISOString(),
    });
    return approvalJson({
      success: true,
      approvals,
      recoveryExecutionEligible: false,
    });
  } catch (error) {
    return mapHandoverRecoveryApprovalError(error);
  }
}

// The requester records the first personal approval. This creates exactly one
// approval document and one audit row; nothing operational is written.
export async function POST(request: NextRequest) {
  if (!handoverV2Enabled()) {
    return approvalFailure("Not found.", 404);
  }

  const resolved = await approver();
  if ("error" in resolved) return resolved.error;
  if (!sameOrigin(request)) {
    return approvalFailure("Invalid request origin.", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return approvalFailure("Provide a recovery approval request.", 400);
  }

  try {
    const { intent, credential } = parseHandoverRecoveryApprovalRequestBody(body);
    const authentication = await authenticateHandoverRecoveryApproval({
      actor: resolved.actor,
      password: credential.password,
    });
    const result = await requestHandoverRecoveryApproval({
      actorUid: resolved.actor.uid,
      handoverDocumentId: intent.handoverDocumentId,
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
