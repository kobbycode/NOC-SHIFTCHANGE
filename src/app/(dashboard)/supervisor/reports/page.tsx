import Link from "next/link";

import { HandoverReportRegister } from "@/components/reports/handover-report-register";

import { getCurrentUser } from "@/lib/auth/session";

import { handoverV2Enabled } from "@/lib/operations/handover-v2-report-http";

import { getHandoverReportRegister } from "@/lib/operations/report-register";

export const dynamic = "force-dynamic";

export default async function SupervisorReportsPage() {
  const actor = await getCurrentUser();

  if (!actor) return null;

  const view = await getHandoverReportRegister(actor);
  const v2Enabled = handoverV2Enabled();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Frozen handover reports for operational shifts, including the
            evidence that was verified before the outgoing team handed over.
          </p>
        </div>

        {v2Enabled && (
          <Link
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--elevated)]"
            href="/supervisor/handovers/v2"
          >
            Open Handover Reports
          </Link>
        )}
      </header>

      <HandoverReportRegister
        view={view}
        audience="supervisor"
        v2Enabled={v2Enabled}
      />
    </div>
  );
}
