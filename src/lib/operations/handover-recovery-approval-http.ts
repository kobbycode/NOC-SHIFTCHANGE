import "server-only";

import { NextResponse } from "next/server";

import { PasswordReauthenticationError } from "@/lib/auth/password-reauthentication";
import {
  HandoverRecoveryApprovalError,
  HandoverRecoveryApprovalInputError,
} from "./handover-recovery-approval-domain";

export function approvalJson(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function approvalFailure(message: string, status: number) {
  return approvalJson(
    { success: false, error: message, recoveryExecutionEligible: false },
    status,
  );
}

export function mapHandoverRecoveryApprovalError(error: unknown) {
  if (error instanceof HandoverRecoveryApprovalInputError) {
    return approvalFailure(error.message, 400);
  }
  if (error instanceof HandoverRecoveryApprovalError) {
    return approvalJson(
      {
        success: false,
        error: error.message,
        code: error.code,
        recoveryExecutionEligible: false,
      },
      error.status,
    );
  }
  if (error instanceof PasswordReauthenticationError) {
    return approvalJson(
      {
        success: false,
        error: error.message,
        code: error.code,
        recoveryExecutionEligible: false,
      },
      error.status,
    );
  }
  // Never log the request or an upstream payload: both can carry credentials.
  console.error("Handover recovery approval request failed.");
  return approvalFailure("The recovery approval request could not be completed.", 500);
}
