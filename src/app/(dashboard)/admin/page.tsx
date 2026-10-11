import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getDashboardOverview } from "@/lib/operations/dashboard-overview";
export default async function AdminDashboardPage() {
  const actor = await getCurrentUser(); if (!actor) return null;
  const overview = await getDashboardOverview(actor);
  return <div className="space-y-6"><header><h1 className="text-2xl font-bold">Administration Overview</h1><p className="mt-2 text-sm text-slate-500">Authoritative account and technical operations summary.</p></header><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[["Total users", overview.totalUsers], ["Current shift", overview.currentShift], ["Unfinished tasks", overview.openTasks], ["Broadcast stations", overview.stations]].map(([label, value]) => <div key={label} className="rounded-xl border bg-white p-5 shadow-sm dark:bg-slate-950"><p className="text-sm text-slate-500">{label}</p><p className="mt-3 text-xl font-bold">{value}</p></div>)}</div><Link className="inline-block rounded-lg bg-blue-700 px-4 py-3 text-white" href="/admin/users">Manage accounts</Link></div>;
}
