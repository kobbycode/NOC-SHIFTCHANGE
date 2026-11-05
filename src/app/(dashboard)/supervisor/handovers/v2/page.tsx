import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getSupervisorV2HandoverList } from "@/lib/operations/supervisor-handover-v2";
import { SupervisorHandoverV2List } from "@/components/operations/supervisor-handover-v2-list";

// The (dashboard)/supervisor layout already requires an active supervisor
// session; the read service re-verifies the live profile server-side.
export default async function SupervisorV2HandoversPage() {
  if (process.env.HANDOVER_V2_DEV !== "true") notFound();
  const actor = await getCurrentUser();
  if (!actor) return null;
  const rows = await getSupervisorV2HandoverList(actor);
  return <SupervisorHandoverV2List rows={rows} />;
}
