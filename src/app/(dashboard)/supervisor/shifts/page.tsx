import {
  requireUser,
} from "@/lib/auth/session";

import {
  SupervisorShiftWorkspace,
} from "@/components/shifts/supervisor-shift-workspace";

export default async function SupervisorShiftsPage() {
  await requireUser([
    "supervisor",
  ]);

  return (
    <main className="space-y-8 p-6">
      <div>
        <h1
          className="
            text-3xl font-bold
            tracking-tight
            text-slate-900
            dark:text-white
          "
        >
          Shift Management
        </h1>

        <p
          className="
            mt-2 text-sm
            text-slate-500
            dark:text-slate-400
          "
        >
          Monitor operational shifts,
          technician membership,
          and shift status.
        </p>
      </div>

      <SupervisorShiftWorkspace />
    </main>
  );
}