// Phase 8C.4B §5 — the trusted HTTP boundary for Version 2 dual approval.
//
// Version 2 approvals authorize nothing. Every response body — success and
// failure alike — carries `recoveryExecutionEligible: false`, and there is no
// endpoint in this family that can execute a recovery.
//
// The password seam is reused deliberately: `authenticateHandoverRecoveryApproval`
// is the only place a password enters the approval flow, it verifies the caller's
// own password before any Firestore transaction, and the proof base it returns is
// field-for-field the shape the Version 2 services require. This module never
// stores, logs or forwards a credential, and it never touches a Version 1
// approval document.

import "server-only";

import { NextResponse } from "next/server";

import { PasswordReauthenticationError } from "@/lib/auth/password-reauthentication";
import { getCurrentUser } from "@/lib/auth/session";
import { HandoverRecoveryApprovalError } from "./handover-recovery-approval-domain";
import type { HandoverRecoveryApprovalHttpActor } from "./handover-recovery-approval-coordinator";
import {
  HandoverRecoveryApprovalV2Error,
  HandoverRecoveryApprovalV2InputError,
} from "./handover-recovery-approval-v2-domain";
import { parseHandoverRecoveryDocumentId } from "./handover-recovery-eligibility-firestore";

export function approvalV2Json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function approvalV2Failure(message: string, status: number, code?: string) {
  return approvalV2Json(
    {
      success: false,
      error: message,
      ...(code ? { code } : {}),
      recoveryExecutionEligible: false,
    },
    status,
  );
}

// A Version 2 error carries its own code and status; the shared authentication
// coordinator answers with its Version 1 error classes, which describe
// authentication rather than approval state, so they are mapped explicitly
// instead of falling through to the generic branch.
export function mapHandoverRecoveryApprovalV2Error(error: unknown) {
  if (error instanceof HandoverRecoveryApprovalV2InputError) {
    return approvalV2Failure(error.message, 400);
  }
  if (
    error instanceof HandoverRecoveryApprovalV2Error ||
    error instanceof HandoverRecoveryApprovalError ||
    error instanceof PasswordReauthenticationError
  ) {
    return approvalV2Json(
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
  console.error("Handover recovery approval v2 request failed.");
  return approvalV2Failure("The recovery approval request could not be completed.", 500);
}

export type RecoveryApproverV2 =
  | { actor: HandoverRecoveryApprovalHttpActor }
  | { error: ReturnType<typeof approvalV2Failure> };

// The same authority the services enforce internally, checked here first so an
// unauthorized caller never reaches a read.
export async function authorizeRecoveryApproverV2(): Promise<RecoveryApproverV2> {
  const actor = await getCurrentUser();
  if (!actor) {
    return { error: approvalV2Failure("Please sign in to continue.", 401) };
  }
  if ((actor.role !== "admin" && actor.role !== "supervisor") || actor.mustChangePassword) {
    return {
      error: approvalV2Failure(
        "Only authorized supervisors and administrators can approve recovery intents.",
        403,
      ),
    };
  }
  return { actor };
}

// A handover document ID is validated with the classifier's own grammar, and an
// unparseable one reports the same 404 the request path reports, so the read
// surface and the write surface never disagree about an unknown handover.
export type RecoveryHandoverParamV2 =
  | { handoverDocumentId: string }
  | { error: ReturnType<typeof approvalV2Failure> };

export function recoveryHandoverDocumentIdV2(value: unknown): RecoveryHandoverParamV2 {
  try {
    return { handoverDocumentId: parseHandoverRecoveryDocumentId(value).handoverDocumentId };
  } catch {
    return {
      error: approvalV2Failure(
        "Invalid handover document.",
        404,
        "RECOVERY_APPROVAL_V2_HANDOVER_NOT_FOUND",
      ),
    };
  }
}
