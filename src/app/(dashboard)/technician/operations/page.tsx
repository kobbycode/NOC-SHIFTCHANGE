import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getTechnicianCurrentShift } from "@/lib/operations/get-technician-current-shift";
import { getShiftOperations } from "@/lib/operations/shift-operations";
import { ShiftOperationsWorkspace } from "@/components/operations/shift-operations-workspace";
export default async function ShiftOperationsPage() {
  const actor=await getCurrentUser();
  if(!actor)return null;
  const current=await getTechnicianCurrentShift(actor);
  if(!current?.joinedAt) return <div className="space-y-4"><h1 className="text-2xl font-bold">Shift Operations</h1><p>Join your current shift before recording operations.</p><Link className="text-blue-600 underline" href="/technician">Open shift and attendance</Link></div>;
  return <ShiftOperationsWorkspace initial={await getShiftOperations(actor,current.id)} />;
}
