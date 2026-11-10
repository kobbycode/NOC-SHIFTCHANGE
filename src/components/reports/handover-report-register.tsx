import Link from "next/link";

import { formatDate, formatDateTime } from "@/lib/format";

import type { HandoverReportRegisterView } from "@/lib/operations/report-register";

function reportBadge(report: HandoverReportRegisterView["reports"][number]) {
  if (report.blockers > 0) {
    return {
      label: `${report.blockers} blocker${report.blockers === 1 ? "" : "s"}`,
      className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    };
  }

  if (report.warnings > 0) {
    return {
      label: `${report.warnings} warning${report.warnings === 1 ? "" : "s"}`,
      className: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    };
  }

  return {
    label: "Complete",
    className: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  };
}

export function HandoverReportRegister({
  view,
  audience,
  v2Enabled,
}: {
  view: HandoverReportRegisterView;
  audience: "admin" | "supervisor";
  v2Enabled: boolean;
}) {
  const stats = [
    ["Frozen reports", view.totals.reports],
    ["Shifts covered", view.totals.shifts],
    ["Corrected versions", view.totals.corrections],
    ["With warnings", view.totals.withWarnings],
  ] as const;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)]"
          >
            <p className="text-sm text-[var(--muted)]">{label}</p>
            <p className="mt-2 text-2xl font-bold">{value}</p>
          </div>
        ))}
      </div>

      {view.totals.latestFrozenAt && (
        <p className="text-sm text-[var(--muted)]">
          Latest freeze: {formatDateTime(view.totals.latestFrozenAt)}
        </p>
      )}

      {view.recordsSkipped > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {view.recordsSkipped} stored report record
          {view.recordsSkipped === 1 ? "" : "s"} could not be read as a frozen
          handover report and require administrator review.
        </div>
      )}

      {view.reports.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <h2 className="text-lg font-semibold">No frozen handover reports yet</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--muted)]">
            Reports appear here once an outgoing team freezes a consolidated
            handover report. The frozen report keeps the station checks, pending
            tasks, attendance evidence, and confirmations recorded at that moment.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {view.reports.map((report) => {
            const badge = reportBadge(report);
            const detailHref =
              audience === "supervisor"
                ? `/supervisor/handovers/v2/${encodeURIComponent(report.outgoingShiftId)}`
                : null;

            return (
              <article
                key={report.reportId}
                className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold">
                      {report.shiftLabel} ·{" "}
                      {formatDate(report.shiftDate ?? report.scheduledStart)}
                    </h2>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      Frozen {formatDateTime(report.frozenAt)} by {report.frozenBy}
                      {" · "}
                      Version {report.version}
                    </p>
                  </div>

                  <span
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>

                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                  <div>
                    <dt className="text-[var(--muted)]">Outgoing team</dt>
                    <dd className="mt-1 break-words font-medium">
                      {report.outgoingTeam.length > 0
                        ? report.outgoingTeam.join(", ")
                        : "—"}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-[var(--muted)]">Incoming team</dt>
                    <dd className="mt-1 break-words font-medium">
                      {report.incomingTeam.length > 0
                        ? report.incomingTeam.join(", ")
                        : "—"}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-[var(--muted)]">Broadcast checks</dt>
                    <dd className="mt-1 font-medium">
                      {report.verifiedStations} of {report.stationCount} verified
                    </dd>
                  </div>

                  <div>
                    <dt className="text-[var(--muted)]">Operational records</dt>
                    <dd className="mt-1 font-medium">{report.recordsRecorded}</dd>
                  </div>

                  <div>
                    <dt className="text-[var(--muted)]">Pending tasks carried</dt>
                    <dd className="mt-1 font-medium">{report.pendingTasks}</dd>
                  </div>

                  <div>
                    <dt className="text-[var(--muted)]">Recorded absences</dt>
                    <dd className="mt-1 font-medium">{report.absences}</dd>
                  </div>
                </dl>

                {report.missingStations.length > 0 && (
                  <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
                    Unverified stations at freeze: {report.missingStations.join(", ")}
                  </p>
                )}

                {report.reason && (
                  <p className="mt-3 text-sm text-[var(--muted)]">
                    <span className="font-medium text-[var(--foreground)]">
                      Freeze reason:
                    </span>{" "}
                    {report.reason}
                  </p>
                )}

                {report.correctionNote && (
                  <p className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--elevated)] p-3 text-sm">
                    <span className="font-medium">Correction note:</span>{" "}
                    {report.correctionNote}
                  </p>
                )}

                {detailHref && (
                  <div className="mt-4 border-t border-[var(--border)] pt-3">
                    {v2Enabled ? (
                      <Link
                        className="text-sm font-medium text-[var(--foreground)] underline underline-offset-4"
                        href={detailHref}
                      >
                        Open the handover record →
                      </Link>
                    ) : (
                      <p className="text-xs text-[var(--muted)]">
                        The v2 handover record is not enabled in this environment.
                      </p>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
