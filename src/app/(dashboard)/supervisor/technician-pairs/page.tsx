import {
  requireUser,
} from "@/lib/auth/session";

import {
  SupervisorTechnicianPairWorkspace,
} from "@/components/technician-pairs/supervisor-technician-pair-workspace";

export default async function SupervisorTechnicianPairsPage() {
  await requireUser([
    "supervisor",
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
          Technician Pair Management
        </h1>

        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Review permanent technician pair relationships.
          Pair membership is organizational and does not
          indicate that a technician attended a shift.
        </p>
      </div>

      <SupervisorTechnicianPairWorkspace />
    </div>
  );
}