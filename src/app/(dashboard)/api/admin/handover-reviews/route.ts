import "server-only";

import { getCurrentUser } from "@/lib/auth/session";
import { handoverV2Enabled } from "@/lib/operations/handover-v2-report-http";
import { listHandoverReviewQueue } from "@/lib/operations/handover-admin-review-firestore";
import {
  mapHandoverReviewError,
  reviewFailure,
  reviewJson,
} from "@/lib/operations/handover-admin-review-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 8B — administrator-only review queue. Read-only: no operational
// mutation is reachable from this endpoint.
export async function GET() {
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

  try {
    const nowIso = new Date().toISOString();
    const queue = await listHandoverReviewQueue({ nowIso });
    return reviewJson({
      success: true,
      queue,
      count: queue.length,
      generatedAt: nowIso,
    });
  } catch (error) {
    return mapHandoverReviewError(error);
  }
}
