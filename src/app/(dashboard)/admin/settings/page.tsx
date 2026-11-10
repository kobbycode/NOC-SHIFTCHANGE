import Link from "next/link";

import { getCurrentUser } from "@/lib/auth/session";

import { formatDateTime, humanize } from "@/lib/format";

import { getOperationalSettings } from "@/lib/operations/operational-settings";

import { SHIFT_ACTIVATION_WINDOW } from "@/lib/operations/shift-activation-window";

import { ATTENDANCE_LATENESS_GRACE_MS } from "@/types/equal-technician-handover";

export const dynamic = "force-dynamic";

const CONTROL_STATES = {
  not_initialized: "Not initialized",
  no_current_shift: "Awaiting shift setup",
  current_shift: "Shift assigned",
  needs_review: "Needs review",
} as const;

export default async function AdminSettingsPage() {
  const actor = await getCurrentUser();

  if (!actor) return null;

  const view = await getOperationalSettings(actor);
  const control = view.control;

  const policies = [
    {
      label: "Shift activation window",
      body: `A scheduled shift may start ${SHIFT_ACTIVATION_WINDOW.EARLY_MINUTES} minutes early and up to ${SHIFT_ACTIVATION_WINDOW.LATE_MINUTES} minutes after its scheduled start.`,
    },
    {
      label: "Attendance grace",
      body: `Arrival within ${ATTENDANCE_LATENESS_GRACE_MS / 60_000} minutes of the scheduled start is on time. Later arrival is recorded as late and requires a reason.`,
    },
    {
      label: "Single operational shift",
      body: "Only one shift owns the global operational slot at a time. The next shift activates when the incoming team accepts the handover.",
    },
    {
      label: "Record locking",
      body: "Operational records accept changes only while a shift is active. Entry locks when handover begins, and missing evidence is never added retroactively.",
    },
    {
      label: "Handover confirmation",
      body: "An equal-technician handover requires confirmation from all four participating technicians before it can be frozen and transferred.",
    },
    {
      label: "Immutable history",
      body: "Operational events and frozen handover reports keep an immutable revision history with individual authorship.",
    },
    {
      label: "First-login password change",
      body: "Accounts created by an administrator must change their initial password before using the workspace.",
    },
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Read-only snapshot of the operational configuration this deployment is
          enforcing.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <section
          aria-labelledby="settings-control-title"
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)]"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id="settings-control-title" className="text-lg font-semibold">
              Operational control
            </h2>

            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                control.state === "needs_review"
                  ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                  : control.state === "current_shift"
                    ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                    : "bg-[var(--elevated)] text-[var(--muted)]"
              }`}
            >
              {CONTROL_STATES[control.state]}
            </span>
          </div>

          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-[var(--muted)]">Slot generation</dt>
              <dd className="mt-1 font-medium">{control.generation ?? "—"}</dd>
            </div>

            {control.shift ? (
              <>
                <div>
                  <dt className="text-[var(--muted)]">Current shift</dt>
                  <dd className="mt-1 font-medium">
                    {humanize(control.shift.shiftType)} ·{" "}
                    {humanize(control.shift.status)}
                  </dd>
                </div>

                <div>
                  <dt className="text-[var(--muted)]">Scheduled</dt>
                  <dd className="mt-1 font-medium">
                    {formatDateTime(control.shift.scheduledStart)} –{" "}
                    {formatDateTime(control.shift.scheduledEnd)}
                  </dd>
                </div>

                <div>
                  <dt className="text-[var(--muted)]">Actual start</dt>
                  <dd className="mt-1 font-medium">
                    {formatDateTime(control.shift.actualStart)}
                  </dd>
                </div>
              </>
            ) : (
              <div>
                <dt className="text-[var(--muted)]">Current shift</dt>
                <dd className="mt-1 font-medium">
                  {control.state === "needs_review"
                    ? "The control record needs administrator review."
                    : "No shift currently owns the operational slot."}
                </dd>
              </div>
            )}

            <div>
              <dt className="text-[var(--muted)]">Slot consumed</dt>
              <dd className="mt-1 font-medium">
                {formatDateTime(control.consumedAt)}
              </dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="settings-workforce-title"
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)]"
        >
          <h2 id="settings-workforce-title" className="text-lg font-semibold">
            Workforce
          </h2>

          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
            {[
              ["Total accounts", view.workforce.total],
              ["Active accounts", view.workforce.active],
              ["Administrators", view.workforce.admins],
              ["Supervisors", view.workforce.supervisors],
              ["Technicians", view.workforce.technicians],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[var(--muted)]">{label}</dt>
                <dd className="mt-1 text-xl font-bold">{value}</dd>
              </div>
            ))}
          </dl>

          <Link
            className="mt-5 inline-block rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--elevated)]"
            href="/admin/users"
          >
            Manage user accounts
          </Link>
        </section>

        <section
          aria-labelledby="settings-stations-title"
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)] lg:col-span-2"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 id="settings-stations-title" className="text-lg font-semibold">
              Station configuration
            </h2>

            <Link
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--elevated)]"
              href="/admin/stations"
            >
              Open stations &amp; sections
            </Link>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-[var(--muted)]">Stations</dt>
              <dd className="mt-1 text-xl font-bold">{view.stations.total}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Enabled</dt>
              <dd className="mt-1 text-xl font-bold">{view.stations.enabled}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Maximum</dt>
              <dd className="mt-1 text-xl font-bold">{view.stations.max}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Source</dt>
              <dd className="mt-1 font-medium">
                {view.stations.configured ? "Station collection" : "Built-in defaults"}
              </dd>
            </div>
          </dl>

          {(view.stations.belowMinimum || view.stations.invalid > 0) && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              Station configuration requires review
              {view.stations.invalid > 0
                ? `: ${view.stations.invalid} malformed record${
                    view.stations.invalid === 1 ? "" : "s"
                  }`
                : ""}
              {view.stations.belowMinimum
                ? `; the enabled set must contain between 1 and ${view.stations.max} stations`
                : ""}
              .
            </div>
          )}
        </section>
      </div>

      <section aria-labelledby="settings-policies-title" className="space-y-4">
        <h2 id="settings-policies-title" className="text-lg font-semibold">
          Enforced policies
        </h2>

        <div className="grid gap-4 md:grid-cols-2">
          {policies.map((policy) => (
            <article
              key={policy.label}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)]"
            >
              <h3 className="font-semibold">{policy.label}</h3>
              <p className="mt-2 text-sm text-[var(--muted)]">{policy.body}</p>
            </article>
          ))}
        </div>
      </section>

      <p className="text-xs text-[var(--muted)]">
        Configuration changes are applied by the deploying administrator. This
        page never writes to the database.
      </p>
    </div>
  );
}
