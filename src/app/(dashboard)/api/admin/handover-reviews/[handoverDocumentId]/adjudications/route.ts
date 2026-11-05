import "server-only";

import { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  handoverV2Enabled,
  sameOrigin,
} from "@/lib/operations/handover-v2-report-http";
import {
  listHandoverAdjudications,
  recordHandoverReviewAdjudication,
} from "@/lib/operations/handover-admin-review-firestore";
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

// Phase 8C.2a — the immutable adjudication ledger for one review case.
export async function GET(_request: Request, context: Context) {
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

  const { handoverDocumentId } = await context.params;
  if (!validReviewDocumentId(handoverDocumentId)) {
    return reviewFailure("Invalid handover document.", 400);
  }

  try {
    const adjudications = await listHandoverAdjudications({ handoverDocumentId });
    return reviewJson({ success: true, adjudications });
  } catch (error) {
    return mapHandoverReviewError(error);
  }
}

// Recording an adjudication appends an investigative finding only. The actor
// comes from the verified session, every historical and evidence field is
// derived inside the transaction, and no operational or historical document is
// ever updated.
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
    return reviewFailure("Provide a historical adjudication.", 400);
  }

  try {
    const result = await recordHandoverReviewAdjudication({
      handoverDocumentId,
      actorUid: actor.uid,
      body,
      nowIso: new Date().toISOString(),
    });
    return reviewJson({
      success: true,
      replayed: result.replayed,
      adjudication: result.adjudication,
      eligibility: result.eligibility,
      review: result.projection,
      audit: {
        id: result.auditId,
        state: "recorded",
        operationalEffect: result.adjudication.operationalEffect,
      },
    });
  } catch (error) {
    return mapHandoverReviewError(error);
  }
}
