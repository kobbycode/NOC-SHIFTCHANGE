import {
  TechnicianShiftWorkspace,
} from "@/components/shifts/technician-shift-workspace";

export default function TechnicianDashboardPage() {
  return (
    <div className="space-y-5 sm:space-y-6">
      <header>
        <p className="text-xs font-semibold tracking-wider text-[var(--muted)] uppercase">
          Technician workspace
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
          Technician Overview
        </h1>

        <p className="mt-2 text-sm text-[var(--muted)]">
          Your current shift and attendance.
        </p>
      </header>

      <TechnicianShiftWorkspace />
    </div>
  );
}
