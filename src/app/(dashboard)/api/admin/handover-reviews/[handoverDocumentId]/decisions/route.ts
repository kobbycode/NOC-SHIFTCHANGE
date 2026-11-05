import "server-only";

import { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  handoverV2Enabled,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import { recordHandoverReviewDecision } from "@/lib/operations/handover-admin-review-firestore";
import {
  mapHandoverReviewError,
  reviewFailure,
  reviewJson,
  validReviewDocumentId,
} from "@/lib/operations/handover-admin-review-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ handoverDocumentId: string }>;
};

// Phase 8B — administrative decision only. The actor is derived from the
// verified session, the decision clock is the server clock, and the accepted
// decision set cannot create or repair operational evidence.
export async function POST(request: NextRequest, context: Context) {
  if (!handoverV2Enabled()) {
    return reviewFailure("Not found.", 404);
  }

  const actor = await getCurrentUser();
  if (!actor) {
    return reviewFailure("Please sign in to continue.", 401);
  }
  if (actor.role !== "admin" || actor.mustChangePassword) {
    return reviewFailure(
      "Only authorized administrators can review handover exceptions.",
      403,
    );
  }
  if (!sameOrigin(request)) {
    return reviewFailure("Invalid request origin.", 403);
  }

  const { handoverDocumentId } = await context.params;
  if (!validReviewDocumentId(handoverDocumentId)) {
    return reviewFailure("Invalid handover document.", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reviewFailure("Provide a valid review decision.", 400);
  }

  try {
    const result = await recordHandoverReviewDecision({
      handoverDocumentId,
      actorUid: actor.uid,
      body,
      nowIso: new Date().toISOString(),
    });
    return reviewJson({
      success: true,
      replayed: result.replayed,
      decision: result.decision,
      review: result.projection,
      audit: { id: result.auditId, state: "recorded" },
    });
  } catch (error) {
    return mapHandoverReviewError(error);
  }
}
