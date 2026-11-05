import "server-only";

import { NextResponse } from "next/server";

import { HandoverRecoveryEligibilityError } from "./handover-recovery-eligibility-firestore";

export function eligibilityJson(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function eligibilityFailure(message: string, status: number, code?: string) {
  return eligibilityJson(
    {
      success: false,
      error: message,
      ...(code ? { code } : {}),
      recoveryExecutionEligible: false,
    },
    status,
  );
}

export function mapHandoverRecoveryEligibilityError(error: unknown) {
  if (error instanceof HandoverRecoveryEligibilityError) {
    return eligibilityJson(
      {
        success: false,
        error: error.message,
        code: error.code,
        recoveryExecutionEligible: false,
      },
      error.status,
    );
  }
  // An unreadable store is never a definitive classification, and the request
  // is never logged: it carries no credentials, but the failure may.
  console.error("Handover recovery eligibility request failed.");
  return eligibilityFailure(
    "Recovery eligibility cannot be verified right now. Refresh and try again.",
    503,
    "ELIGIBILITY_UNAVAILABLE",
  );
}
