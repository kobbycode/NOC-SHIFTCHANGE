import { getCurrentUser } from "@/lib/auth/session";
import { getHandoverWorkspace } from "@/lib/operations/handover-workspace";
import { HandoverWorkspace } from "@/components/operations/handover-workspace";
export default async function HandoversPage() {
  const actor = await getCurrentUser(); if (!actor) return null;
  return <HandoverWorkspace data={await getHandoverWorkspace(actor)} manager={false}/>;
}
