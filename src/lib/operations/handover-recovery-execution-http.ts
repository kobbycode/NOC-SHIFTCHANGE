// Phase 8C.5 — the trusted HTTP boundary for recovery execution.
//
// Every handler in this family is gated twice: the Version 2 handover flag must
// be on AND `HANDOVER_RECOVERY_EXECUTION_ENABLED` must be the literal string
// "true". The second gate defaults off everywhere, so the execution surface is
// unreachable unless an operator deliberately enables it on a disposable stack.
//
// Neither endpoint accepts authority from the request. The actor comes from the
// session, the approval id comes from the path, and every precondition is re-read
// inside the executor's transaction. Responses never claim execution authority:
// `recoveryExecutionEligible` is always false.

import "server-only";

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { handoverV2Enabled } from "./handover-v2-report-http";
import type { HandoverRecoveryApprovalHttpActor } from "./handover-recovery-approval-coordinator";
import {
  HANDOVER_RECOVERY_ABANDONMENT_REFUSALS,
  HandoverRecoveryAbandonmentError,
} from "./handover-recovery-abandonment-domain";
import { HandoverRecoveryApprovalV2InputError } from "./handover-recovery-approval-v2-domain";

export function recoveryExecutionEnabled(): boolean {
  return handoverV2Enabled() && process.env.HANDOVER_RECOVERY_EXECUTION_ENABLED === "true";
}

export function executionJson(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function executionFailure(
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return executionJson(
    {
      success: false,
      error: message,
      ...extra,
      recoveryExecutionEligible: false,
    },
    status,
  );
}

export function mapHandoverRecoveryExecutionError(error: unknown) {
  if (error instanceof HandoverRecoveryAbandonmentError) {
    return executionJson(
      {
        success: false,
        error: error.message,
        code: error.code,
        notCommitted: error.notCommitted,
        // An unknown outcome may describe a committed transaction. The caller
        // must read the execution status back before any retry.
        ...(error.code === HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.OUTCOME_UNKNOWN
          ? { verificationRequired: true }
          : {}),
        ...(Object.keys(error.details).length ? { details: error.details } : {}),
        recoveryExecutionEligible: false,
      },
      error.status,
    );
  }
  if (error instanceof HandoverRecoveryApprovalV2InputError) {
    return executionFailure(error.message, 400);
  }
  // Never log the request or an upstream payload.
  console.error("Handover recovery execution request failed.");
  return executionFailure("The recovery outcome could not be confirmed.", 503, {
    verificationRequired: true,
  });
}

export type RecoveryExecutor =
  | { actor: HandoverRecoveryApprovalHttpActor }
  | { error: ReturnType<typeof executionFailure> };

// Execution is narrower than approval: only a live administrator, and the same
// authority is re-checked against the profile document inside the transaction.
export async function authorizeRecoveryExecutor(): Promise<RecoveryExecutor> {
  const actor = await getCurrentUser();
  if (!actor) {
    return { error: executionFailure("Please sign in to continue.", 401) };
  }
  if (actor.role !== "admin" || actor.mustChangePassword) {
    return {
      error: executionFailure("Only an administrator can execute a recovery.", 403),
    };
  }
  return { actor };
}
