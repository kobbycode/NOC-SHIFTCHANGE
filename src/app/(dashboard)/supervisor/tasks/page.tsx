import {
  requireUser,
} from "@/lib/auth/session";

import {
  SupervisorTaskWorkspace,
} from "@/components/tasks/supervisor-task-workspace";

export default async function SupervisorTasksPage() {
  /*
   * Require an authenticated supervisor.
   *
   * The existing session service
   * validates Firebase authentication,
   * account status, and role.
   */

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
          Task Management
        </h1>

        <p
          className="
            mt-2 text-sm
            text-slate-500
            dark:text-slate-400
          "
        >
          Monitor operational tasks,
          technician assignments,
          and task progress.
        </p>
      </div>

      <SupervisorTaskWorkspace />
    </main>
  );
}