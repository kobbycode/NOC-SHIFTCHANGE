import {
  TechnicianShiftWorkspace,
} from "@/components/shifts/technician-shift-workspace";
import Link from "next/link";

export default function TechnicianDashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
          Technician Overview
        </h1>

        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Your shift, attendance, and assigned responsibilities.
        </p>
      </div>

      <TechnicianShiftWorkspace />

      <Link href="/technician/operations" className="block rounded-xl border border-blue-200 bg-blue-50 p-5 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
        <h2 className="font-semibold">Open Shift Operations</h2>
        <p className="mt-2 text-sm">Record broadcast checks, faults, activities, and outside broadcasts. Review your shared shift records and their histories.</p>
      </Link>
    </div>
  );
}
