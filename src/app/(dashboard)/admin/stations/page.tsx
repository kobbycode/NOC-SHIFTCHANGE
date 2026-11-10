import { getCurrentUser } from "@/lib/auth/session";

import { formatDateTime, humanize } from "@/lib/format";

import { getStationDirectory } from "@/lib/operations/station-directory";

export const dynamic = "force-dynamic";

function statusTone(status: string | null): string {
  switch (status) {
    case "on_air":
      return "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300";
    case "degraded":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300";
    case "off_air":
      return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
    default:
      return "bg-[var(--elevated)] text-[var(--muted)]";
  }
}

export default async function AdminStationsPage() {
  const actor = await getCurrentUser();

  if (!actor) return null;

  const view = await getStationDirectory(actor);
  const records = view.sections.reduce(
    (total, section) => total + (section.records ?? 0),
    0,
  );

  const stats = [
    ["Configured stations", view.totals.total],
    ["Enabled", view.totals.enabled],
    ["Disabled", view.totals.disabled],
    ["Operational records", records],
  ] as const;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Stations &amp; Sections</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Broadcast station configuration and the operational sections recorded
          during shifts. Shift operations accept records only for enabled
          stations.
        </p>
      </header>

      {!view.totals.configured && (
        <p className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-4 text-sm">
          No station collection is configured, so the built-in default station
          list is in use ({view.totals.total} stations).
        </p>
      )}

      {view.totals.invalid > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {view.totals.invalid} station configuration record
          {view.totals.invalid === 1 ? "" : "s"} is malformed and needs
          administrator review. Malformed records are excluded from shift
          operations.
        </div>
      )}

      {view.totals.belowMinimum && (
        <div
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          The enabled station set is outside the supported 1–{view.totals.max}{" "}
          range. Operational records will be rejected until it is corrected.
        </div>
      )}

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

      <section aria-labelledby="station-directory-title" className="space-y-4">
        <h2 id="station-directory-title" className="text-lg font-semibold">
          Station directory
        </h2>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {view.stations.map((station) => (
            <article
              key={station.stationId}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)]"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="min-w-0 break-words text-lg font-semibold">
                  {station.name}
                </h3>

                <span
                  className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                    station.enabled
                      ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                      : "bg-[var(--elevated)] text-[var(--muted)]"
                  }`}
                >
                  {station.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>

              <div className="mt-4 space-y-2 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-[var(--muted)]">Latest check</span>

                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(
                      station.latestStatus,
                    )}`}
                  >
                    {station.latestStatus ? humanize(station.latestStatus) : "Not checked"}
                  </span>
                </p>

                <p className="text-[var(--muted)]">
                  Last recorded {formatDateTime(station.lastCheckedAt)}
                  {station.lastCheckedBy ? ` · ${station.lastCheckedBy}` : ""}
                </p>

                <p className="text-[var(--muted)]">
                  {station.checks} recorded check{station.checks === 1 ? "" : "s"}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="station-sections-title" className="space-y-4">
        <h2 id="station-sections-title" className="text-lg font-semibold">
          Operational sections
        </h2>

        <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <thead className="bg-[var(--elevated)] text-xs uppercase tracking-wide text-[var(--muted)]">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Section
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  What it records
                </th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">
                  Stored records
                </th>
              </tr>
            </thead>
            <tbody>
              {view.sections.map((section) => (
                <tr key={section.key} className="border-t border-[var(--border)]">
                  <td className="px-4 py-3 font-medium">{section.label}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {section.description}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">
                    {section.records ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-[var(--muted)]">
          Station configuration is managed by the server and shown read-only
          here. Disabled stations keep their historic records but are not offered
          for new broadcast checks.
        </p>
      </section>
    </div>
  );
}
