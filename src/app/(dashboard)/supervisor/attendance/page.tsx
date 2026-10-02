import {
  requireUser,
} from "@/lib/auth/session";

import {
  SupervisorAttendanceWorkspace,
} from "@/components/attendance/supervisor-attendance-workspace";

export default async function SupervisorAttendancePage() {
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
          Attendance
        </h1>

        <p
          className="
            mt-2 text-sm
            text-slate-500
            dark:text-slate-400
          "
        >
          Review authoritative
          technician attendance records
          for operational shifts.
        </p>
      </div>

      <SupervisorAttendanceWorkspace />
    </main>
  );
}