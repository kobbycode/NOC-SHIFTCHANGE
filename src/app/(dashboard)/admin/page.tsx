import Link from "next/link";
import { Suspense } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  FileSearch,
  Radio,
  ShieldCheck,
  Users,
} from "lucide-react";

import { getCurrentUser } from "@/lib/auth/session";
import { formatDateTime, humanize } from "@/lib/format";
import { getDashboardOverview } from "@/lib/operations/dashboard-overview";
import { getStationDirectory } from "@/lib/operations/station-directory";
import type { AppUser } from "@/types/auth";

const stationPreviewSize = 4;
const panelClass = "rounded-2xl border border-[var(--border)] bg-[var(--surface)]";
const rowClass = "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5";
const rowListClass = "divide-y divide-[var(--border)] border-t border-[var(--border)]";
const linkFocusClass =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--foreground)]";

const shortcuts = [
  { label: "Manage accounts", href: "/admin/users", icon: Users },
  { label: "Review handovers", href: "/admin/handovers/review", icon: FileSearch },
  { label: "View audit logs", href: "/admin/audit-logs", icon: ShieldCheck },
];

async function StationChecks({ actor }: { actor: AppUser }) {
  const directory = await getStationDirectory(actor).catch((error: unknown) => {
    console.error("Unable to load station checks for the admin dashboard.", error);
    return null;
  });

  if (!directory) {
    return <p className={`${rowClass} ${rowListClass} text-sm text-[var(--muted)]`}>Station checks are unavailable.</p>;
  }

  const enabledStations = directory.stations.filter((station) => station.enabled);
  if (enabledStations.length === 0) {
    return <p className={`${rowClass} ${rowListClass} text-sm text-[var(--muted)]`}>No enabled stations to display.</p>;
  }

  const preview = enabledStations.slice(0, stationPreviewSize);

  return (
    <>
      <ul className={rowListClass}>
        {preview.map((station) => {
          const checkedAt = formatDateTime(station.lastCheckedAt);
          const status = station.latestStatus
            ? humanize(station.latestStatus)
            : station.lastCheckedAt
              ? "Status unavailable"
              : "Not checked";

          return (
            <li key={station.stationId} className={rowClass}>
              <Radio size={17} className="shrink-0 text-[var(--muted)]" aria-hidden="true" />
              <div className="min-w-0 flex-1 basis-28">
                <p className="wrap-anywhere text-sm font-medium">{station.name}</p>
                {checkedAt !== "—" && (
                  <time dateTime={station.lastCheckedAt ?? undefined} className="text-xs text-[var(--muted)]">
                    {checkedAt}
                  </time>
                )}
              </div>
              <span className="rounded-full bg-[var(--elevated)] px-2.5 py-1 text-xs font-medium">
                {status}
              </span>
            </li>
          );
        })}
      </ul>
      {enabledStations.length > preview.length && (
        <p className={`${rowClass} ${rowListClass} text-xs text-[var(--muted)]`}>
          Showing {preview.length} of {enabledStations.length} enabled stations
        </p>
      )}
    </>
  );
}

export default async function AdminDashboardPage() {
  const actor = await getCurrentUser();
  if (!actor) return null;

  const overview = await getDashboardOverview(actor);
  const hasCurrentShift = overview.currentShift !== "No current shift";
  const metrics = [
    { label: "Unfinished tasks", value: overview.openTasks },
    { label: "Handovers awaiting confirmation", value: overview.pendingHandovers },
    { label: "Enabled broadcast stations", value: overview.stations },
    { label: "User accounts", value: overview.totalUsers },
  ];

  return (
    <div className="space-y-5 sm:space-y-6">
      <header>
        <p className="text-xs font-semibold tracking-wider text-[var(--muted)] uppercase">NOC overview</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Operations dashboard</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Shift coverage, open work, and the latest station checks.
        </p>
      </header>

      <section
        aria-labelledby="admin-current-shift"
        className={`${panelClass} flex flex-wrap items-center gap-x-4 gap-y-3 p-4 sm:p-5`}
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[var(--accent)] text-[var(--foreground)] dark:text-[var(--accent-foreground)]">
          <CalendarClock size={21} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 basis-36">
          <h2 id="admin-current-shift" className="text-sm font-medium text-[var(--muted)]">Current shift</h2>
          <p className="mt-0.5 text-xl font-semibold tracking-tight">{overview.currentShift}</p>
        </div>
        {hasCurrentShift && (
          <p className="rounded-full bg-[var(--elevated)] px-3 py-1.5 text-sm">
            <span className="font-semibold tabular-nums">{overview.techniciansOnDuty}</span>
            {" "}{overview.techniciansOnDuty === 1 ? "technician" : "technicians"} on duty
          </p>
        )}
      </section>

      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {metrics.map(({ label, value }) => (
          <div key={label} className={`${panelClass} flex flex-col justify-between gap-2 p-4 sm:p-5`}>
            <dt className="text-sm text-[var(--muted)]">{label}</dt>
            <dd className="text-2xl font-semibold tracking-tight tabular-nums">{value ?? "—"}</dd>
          </div>
        ))}
      </dl>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="admin-station-checks" className={panelClass}>
          <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
            <div>
              <h2 id="admin-station-checks" className="font-semibold">Station checks</h2>
              <p className="text-sm text-[var(--muted)]">Latest recorded broadcast checks</p>
            </div>
            <Link
              href="/admin/stations"
              className={`inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium hover:bg-[var(--elevated)] ${linkFocusClass}`}
            >
              View stations
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          </header>
          <Suspense
            fallback={
              <p role="status" className={`${rowClass} ${rowListClass} text-sm text-[var(--muted)]`}>
                Loading station checks…
              </p>
            }
          >
            <StationChecks actor={actor} />
          </Suspense>
        </section>

        <section aria-labelledby="admin-quick-actions" className={panelClass}>
          <header className="px-4 py-3 sm:px-5">
            <h2 id="admin-quick-actions" className="font-semibold">Quick actions</h2>
            <p className="text-sm text-[var(--muted)]">Administrator tools</p>
          </header>
          <ul className={rowListClass}>
            {shortcuts.map(({ label, href, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  className={`flex min-h-12 items-center gap-3 px-4 py-3 text-sm font-medium hover:bg-[var(--elevated)] sm:px-5 ${linkFocusClass}`}
                >
                  <Icon size={17} className="shrink-0 text-[var(--muted)]" aria-hidden="true" />
                  <span className="flex-1">{label}</span>
                  <ArrowUpRight size={15} className="shrink-0 text-[var(--muted)]" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
