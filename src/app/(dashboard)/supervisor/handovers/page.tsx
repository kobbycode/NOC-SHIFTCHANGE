import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getHandoverWorkspace } from "@/lib/operations/handover-workspace";
import { HandoverWorkspace } from "@/components/operations/handover-workspace";
export default async function HandoversPage() {
  const actor = await getCurrentUser(); if (!actor) return null;
  // TECH-HO-RECOVERY-09K: supervisor read-only discovery of v2 handovers lives on
  // its own route so the shared manager workspace contract is unchanged.
  const v2Enabled = process.env.HANDOVER_V2_DEV === "true";
  return <div className="space-y-4">
    {v2Enabled && <div className="px-4 pt-4 sm:px-6"><Link href="/supervisor/handovers/v2" className="rounded-lg border px-3 py-2 text-sm text-blue-700 hover:border-blue-500">View equal-technician handovers (v2, read-only) →</Link></div>}
    <HandoverWorkspace data={await getHandoverWorkspace(actor)} manager={actor.role === "supervisor" || actor.role === "admin"}/>
  </div>;
}
