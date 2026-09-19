
export default function AdminDashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          Administration Overview
        </h1>

        <p className="mt-1 text-sm text-slate-500">
          Manage users, stations, and technical operations.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          "Total Users",
          "Active Shifts",
          "Open Tasks",
          "Stations",
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
  