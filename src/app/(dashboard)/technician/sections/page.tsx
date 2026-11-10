import Link from "next/link";

import { RecordPageNotice } from "@/components/dashboards/record-page-notice";

import { getCurrentUser } from "@/lib/auth/session";

import { formatDateTime, humanize } from "@/lib/format";

import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";

import { getTechnicianCurrentShift } from "@/lib/operations/get-technician-current-shift";

import { ShiftOperationsError } from "@/lib/operations/shift-operations-domain";

import { getTechnicianSectionsRecord } from "@/lib/operations/technician-operations-views";

export const dynamic = "force-dynamic";

function broadcastTone(status: string | null): string {
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

function severityTone(severity: string): string {
  switch (severity) {
    case "critical":
    case "high":
      return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
    case "medium":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300";
    default:
      return "bg-[var(--elevated)] text-[var(--muted)]";
  }
}

function recordTone(status: string): string {
  switch (status) {
    case "resolved":
      return "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300";
    case "monitoring":
    case "investigating":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300";
    case "open":
      return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
    default:
      return "bg-[var(--elevated)] text-[var(--muted)]";
  }
}

export default async function TechnicianSectionsPage() {
  const actor = await getCurrentUser();

  if (!actor) return null;

  let current;

  try {
    current = await getTechnicianCurrentShift(actor);
  } catch (error) {
    if (!(error instanceof AssignmentOperationError)) throw error;

    return (
      <RecordPageNotice
        title="Sections Record"
        description="Read-only record of every operational section for your current shift."
        heading="Shift record unavailable"
        body={error.message}
      />
    );
  }

  if (!current) {
    return (
      <RecordPageNotice
        title="Sections Record"
        description="Read-only record of every operational section for your current shift."
        heading="No current operational shift"
        body="The sections record opens once a shift is assigned to you and active."
      />
    );
  }

  if (current.status === "scheduled") {
    return (
      <RecordPageNotice
        title="Sections Record"
        description="Read-only record of every operational section for your current shift."
        heading="This shift has not started yet"
        body={`The shift is scheduled to begin at ${formatDateTime(current.scheduledStart)}.`}
      />
    );
  }

  let record;

  try {
    record = await getTechnicianSectionsRecord(actor, current.id);
  } catch (error) {
    if (
      !(error instanceof ShiftOperationsError) &&
      !(error instanceof AssignmentOperationError)
    ) {
      throw error;
    }

    return (
      <RecordPageNotice
        title="Sections Record"
        description="Read-only record of every operational section for your current shift."
        heading="This shift record is not available"
        body={error.message}
      />
    );
  }

  const stats = [
    ["Broadcast checks", `${record.counts.broadcastVerified}/${record.counts.broadcastTotal}`],
    ["Faults & activities", record.counts.incidents],
    ["Outside broadcasts", record.counts.outsideBroadcasts],
    ["Operational records", record.recordsRecorded],
  ] as const;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sections Record</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {humanize(current.shiftType)} shift · {humanize(current.status)} ·{" "}
            {formatDateTime(current.scheduledStart)} –{" "}
            {formatDateTime(current.scheduledEnd)}
          </p>
        </div>

        <Link
          className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--elevated)]"
          href="/technician/operations"
        >
          Open Shift Operations
        </Link>
      </header>

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

      {record.missingStations.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          Missing or unverified broadcast checks:{" "}
          {record.missingStations.join(", ")}. Your supervisor reviews missing
          evidence; it cannot be added after handover begins.
        </div>
      )}

      <section
        aria-labelledby="sections-broadcast-title"
        className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
      >
        <h2 id="sections-broadcast-title" className="text-lg font-semibold">
          Broadcast checks
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
            <thead className="bg-[var(--elevated)] text-xs uppercase tracking-wide text-[var(--muted)]">
              <tr>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Station
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Latest status
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Observed
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Recorded by
                </th>
              </tr>
            </thead>
            <tbody>
              {record.stations.map((station) => (
                <tr key={station.name} className="border-t border-[var(--border)]">
                  <td className="px-3 py-3 font-medium">{station.name}</td>
                  <td className="px-3 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${broadcastTone(
                        station.status,
                      )}`}
                    >
                      {station.status ? humanize(station.status) : "Not checked"}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-[var(--muted)]">
                    {formatDateTime(station.occurredAt)}
                  </td>
                  <td className="px-3 py-3 text-[var(--muted)]">
                    {station.authorName ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section
          aria-labelledby="sections-faults-title"
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
        >
          <h2 id="sections-faults-title" className="text-lg font-semibold">
            Faults &amp; activities
          </h2>

          {record.incidents.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--muted)]">
              No faults or technical activities have been recorded this shift.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {record.incidents.map((incident) => (
                <li
                  key={`${incident.occurredAt}-${incident.title}`}
                  className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-semibold">{incident.title}</p>
                    <div className="flex shrink-0 gap-2">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${severityTone(
                          incident.severity,
                        )}`}
                      >
                        {humanize(incident.severity)}
                      </span>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${recordTone(
                          incident.status,
                        )}`}
                      >
                        {humanize(incident.status)}
                      </span>
                    </div>
                  </div>

                  <p className="mt-2 text-sm text-[var(--muted)]">
                    {incident.location || "Location not recorded"} ·{" "}
                    {formatDateTime(incident.occurredAt)} · {incident.authorName}
                  </p>

                  {incident.actionTaken && (
                    <p className="mt-2 text-sm">{incident.actionTaken}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          aria-labelledby="sections-outside-title"
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
        >
          <h2 id="sections-outside-title" className="text-lg font-semibold">
            Outside broadcasts
          </h2>

          {record.outsideBroadcasts.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--muted)]">
              No outside broadcasts have been recorded this shift.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {record.outsideBroadcasts.map((broadcast) => (
                <li
                  key={`${broadcast.occurredAt}-${broadcast.title}`}
                  className="rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-semibold">{broadcast.title}</p>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${recordTone(
                        broadcast.status,
                      )}`}
                    >
                      {humanize(broadcast.status)}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-[var(--muted)]">
                    {broadcast.location} · {humanize(broadcast.runningStatus)} ·{" "}
                    {formatDateTime(broadcast.occurredAt)} ·{" "}
                    {broadcast.authorName}
                  </p>

                  {broadcast.actionTaken && (
                    <p className="mt-2 text-sm">{broadcast.actionTaken}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section
        aria-labelledby="sections-no-ob-title"
        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
      >
        <h2 id="sections-no-ob-title" className="text-lg font-semibold">
          No outside broadcast
        </h2>

        {record.noOb ? (
          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--elevated)] p-4 text-sm">
            <p className="font-medium">
              Declared {formatDateTime(record.noOb.occurredAt)} by{" "}
              {record.noOb.authorName}
            </p>
            {record.noOb.remarks && <p className="mt-1">{record.noOb.remarks}</p>}
          </div>
        ) : record.outsideBroadcastCompleteness === "conflicting" ? (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
            Conflicting outside-broadcast evidence was recorded. Ask your
            supervisor to review the shift record.
          </p>
        ) : record.counts.outsideBroadcasts > 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">
            Not declared. Outside broadcast records exist for this shift.
          </p>
        ) : (
          <p className="mt-3 text-sm text-[var(--muted)]">
            No declaration recorded yet.
          </p>
        )}
      </section>

      <p className="text-xs text-[var(--muted)]">
        Record last updated: {formatDateTime(record.updatedAt)}. Records are
        shared by both technicians on shift; each entry keeps its original author.
      </p>
    </div>
  );
}
