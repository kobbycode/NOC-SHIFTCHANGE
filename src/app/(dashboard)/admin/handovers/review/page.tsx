import { notFound } from "next/navigation";

import { HandoverReviewWorkspace } from "@/components/admin/handover-review-workspace";
import { requireUser } from "@/lib/auth/session";
import { handoverV2Enabled } from "@/lib/operations/handover-v2-report-http";

export const dynamic = "force-dynamic";

export default async function AdminHandoverReviewPage() {
  await requireUser(["admin"]);

  if (!handoverV2Enabled()) {
    notFound();
  }

  return <HandoverReviewWorkspace />;
}
