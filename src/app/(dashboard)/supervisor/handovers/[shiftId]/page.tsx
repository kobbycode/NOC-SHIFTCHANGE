import { getCurrentUser } from "@/lib/auth/session";
import { getHandoverReport } from "@/lib/operations/handover-report";
import { HandoverWorkflow } from "@/components/operations/handover-workflow";
export default async function ReportPage({params}:{params:Promise<{shiftId:string}>}){const actor=await getCurrentUser();if(!actor)return null;const {shiftId}=await params;return <HandoverWorkflow initialReport={await getHandoverReport(actor,shiftId)} uid={actor.uid} role={actor.role}/>;}
