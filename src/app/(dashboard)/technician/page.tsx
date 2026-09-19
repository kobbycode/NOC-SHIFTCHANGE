
export default function TechnicianDashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          Technician Overview
        </h1>

        <p className="mt-1 text-sm text-slate-500">
          Your shift, attendance, and assigned responsibilities.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[
          "My Shift",
          "My Assigned Tasks",
          "Outstanding Faults",
        ].map((label) => (
          <div
            key={label}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800"
          >
            <p className="text-sm text-slate-500">
              {label}
            </p>

            <p className="mt-3 text-2xl font-bold">
              —
            </p>

            <p className="mt-2 text-xs text-slate-400">
              Awaiting live data
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
  