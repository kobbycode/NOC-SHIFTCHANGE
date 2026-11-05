import { getCurrentUser } from "@/lib/auth/session";
import { getHandoverWorkspace, v2WorkspaceEnabled } from "@/lib/operations/handover-workspace";
import { listEqualHandoverInitiationShifts } from "@/lib/operations/handover-initiation-v2";
import { EqualHandoverInitiationEntries } from "@/components/operations/handover-initiation-v2";
import { HandoverWorkspace } from "@/components/operations/handover-workspace";
export default async function HandoversPage() {
  const actor = await getCurrentUser(); if (!actor) return null;
  // The v2 workspace list below only shows reservations that already exist, so
  // an eligible outgoing shift with no aggregate yet would have no entry point.
  const initiations = v2WorkspaceEnabled() && actor.role === "technician"
    ? await listEqualHandoverInitiationShifts(actor.uid) : [];
  const data = await getHandoverWorkspace(actor);
  return <>
    {initiations.length > 0 && <EqualHandoverInitiationEntries initiations={initiations}/>}
    <HandoverWorkspace data={data} manager={false}/>
  </>;
}
