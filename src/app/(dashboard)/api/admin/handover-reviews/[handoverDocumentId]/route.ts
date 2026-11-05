import "server-only";

import { getCurrentUser } from "@/lib/auth/session";
import { handoverV2Enabled } from "@/lib/operations/handover-v2-report-http";
import { readHandoverReviewCase } from "@/lib/operations/handover-admin-review-firestore";
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
    const review = await readHandoverReviewCase({
      handoverDocumentId,
      nowIso: new Date().toISOString(),
    });
    return reviewJson({ success: true, review });
  } catch (error) {
    return mapHandoverReviewError(error);
  }
}
