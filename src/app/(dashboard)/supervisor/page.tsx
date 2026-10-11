import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getDashboardOverview } from "@/lib/operations/dashboard-overview";
export default async function SupervisorDashboardPage() {
  const actor = await getCurrentUser(); if (!actor) return null;
  const overview = await getDashboardOverview(actor);
  const cards = [["Current shift", overview.currentShift, "/supervisor/shifts"], ["Technicians reporting on duty", overview.techniciansOnDuty, "/supervisor/attendance"], ["Unfinished tasks", overview.openTasks, "/supervisor/tasks"], ["Pending handovers", overview.pendingHandovers, "/supervisor/handovers"]] as const;
  return <div className="space-y-6"><header><h1 className="text-2xl font-bold">Supervisor Overview</h1><p className="mt-2 text-sm text-slate-500">Current operational ownership, recorded attendance, work, and handover reviews.</p></header><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value, href]) => <Link key={label} href={href} className="rounded-xl border bg-white p-5 shadow-sm hover:border-blue-500 dark:bg-slate-950"><p className="text-sm text-slate-500">{label}</p><p className="mt-3 text-xl font-bold">{value}</p><p className="mt-3 text-xs text-blue-600">Open workspace →</p></Link>)}</div></div>;
}
