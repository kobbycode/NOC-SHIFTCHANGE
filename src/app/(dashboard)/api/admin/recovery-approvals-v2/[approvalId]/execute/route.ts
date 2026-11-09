import "server-only";

import { NextRequest } from "next/server";

import { sameOrigin } from "@/lib/operations/handover-v2-report-http";
import {
  approvalV2Reason,
  idempotencyKey as parseIdempotencyKey,
  validHandoverRecoveryApprovalV2Id,
} from "@/lib/operations/handover-recovery-approval-v2-domain";
import {
  executeHandoverAbandonment,
  readHandoverAbandonmentStatus,
} from "@/lib/operations/handover-recovery-execution-firestore";
import {
  authorizeRecoveryExecutor,
  executionFailure,
  executionJson,
  mapHandoverRecoveryExecutionError,
  recoveryExecutionEnabled,
} from "@/lib/operations/handover-recovery-execution-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ approvalId: string }>;
};

// S9 — whether this approval's recovery was applied. It reads the create-once
// audit row and never infers an outcome from anything else.
export async function GET(_request: NextRequest, context: Context) {
  if (!recoveryExecutionEnabled()) {
    return executionFailure("Not found.", 404);
  }

  const resolved = await authorizeRecoveryExecutor();
  if ("error" in resolved) return resolved.error;

  const { approvalId } = await context.params;
  if (!validHandoverRecoveryApprovalV2Id(approvalId)) {
    return executionFailure("Invalid approval.", 400);
  }

  try {
    const status = await readHandoverAbandonmentStatus({ approvalId });
    return executionJson({
      success: true,
      execution: status,
      recoveryExecutionEligible: false,
    });
  } catch (error) {
    return mapHandoverRecoveryExecutionError(error);
  }
}

// The one endpoint that can abandon an equal handover. It takes no bound state
// from the caller — only the approval id, a reason and an idempotency key — and
// the executor re-derives and fences every condition inside its own transaction.
export async function POST(request: NextRequest, context: Context) {
  if (!recoveryExecutionEnabled()) {
    return executionFailure("Not found.", 404);
  }

  const resolved = await authorizeRecoveryExecutor();
  if ("error" in resolved) return resolved.error;
  if (!sameOrigin(request)) {
    return executionFailure("Invalid request origin.", 403);
  }

  const { approvalId } = await context.params;
  if (!validHandoverRecoveryApprovalV2Id(approvalId)) {
    return executionFailure("Invalid approval.", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return executionFailure("Provide a recovery execution request.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return executionFailure("Provide a recovery execution request.", 400);
  }
  const data = body as Record<string, unknown>;
  if (Object.keys(data).some((key) => key !== "reason" && key !== "idempotencyKey")) {
    return executionFailure("Unsupported recovery execution field.", 400);
  }

  try {
    const outcome = await executeHandoverAbandonment({
      approvalId,
      actorUid: resolved.actor.uid,
      reason: approvalV2Reason(data.reason),
      idempotencyKey: parseIdempotencyKey(data.idempotencyKey),
    });
    return executionJson({
      success: true,
      status: outcome.status,
      execution: {
        auditId: outcome.auditId,
        handoverDocumentId: outcome.handoverDocumentId,
        outgoingShiftId: outcome.outgoingShiftId,
        incomingShiftId: outcome.incomingShiftId,
        approvalId: outcome.approvalId,
        executedBy: outcome.executedBy,
        executedAt: outcome.executedAt,
      },
      recoveryExecutionEligible: false,
    });
  } catch (error) {
    return mapHandoverRecoveryExecutionError(error);
  }
}
