import { getCurrentUser } from "@/lib/auth/session";
import { getHandoverReport } from "@/lib/operations/handover-report";
import { HandoverReport } from "@/components/operations/handover-report-view";
export default async function ReportPage({params}:{params:Promise<{shiftId:string}>}){const actor=await getCurrentUser();if(!actor)return null;const {shiftId}=await params;return <HandoverReport report={await getHandoverReport(actor,shiftId)}/>;}
