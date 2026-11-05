import "server-only";

import { NextResponse } from "next/server";

import {
  HandoverAdjudicationError,
  HandoverReviewDecisionError,
  HandoverReviewInputError,
} from "./handover-admin-review-domain";
import { HandoverReviewServiceError } from "./handover-admin-review-firestore";

export function reviewJson(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function reviewFailure(message: string, status: number) {
  return reviewJson({ success: false, error: message }, status);
}

export function mapHandoverReviewError(error: unknown) {
  if (error instanceof HandoverReviewInputError) {
    return reviewFailure(error.message, 400);
  }
  if (error instanceof HandoverReviewDecisionError) {
    return reviewJson(
      { success: false, error: error.message, code: error.code },
      error.status,
    );
  }
  if (error instanceof HandoverReviewServiceError) {
    return reviewJson(
      { success: false, error: error.message, code: error.code },
      error.status,
    );
  }
  if (error instanceof HandoverAdjudicationError) {
    return reviewJson(
      {
        success: false,
        error: error.message,
        code: error.code,
        reasonCode: error.reasonCode,
      },
      error.status,
    );
  }
  console.error("Handover review request failed:", error);
  return reviewFailure("The handover review request could not be completed.", 500);
}

export function validReviewDocumentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".."
  );
}
