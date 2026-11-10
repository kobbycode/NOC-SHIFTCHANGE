import Link from "next/link";

import { RecordPageNotice } from "@/components/dashboards/record-page-notice";

import { getCurrentUser } from "@/lib/auth/session";

import { formatDateTime, humanize } from "@/lib/format";

import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";

import { getTechnicianCurrentShift } from "@/lib/operations/get-technician-current-shift";

import { ShiftOperationsError } from "@/lib/operations/shift-operations-domain";

import { getTechnicianEquipmentView } from "@/lib/operations/technician-operations-views";

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

export default async function TechnicianEquipmentPage() {
  const actor = await getCurrentUser();

  if (!actor) return null;

  let current;

  try {
    current = await getTechnicianCurrentShift(actor);
  } catch (error) {
    if (!(error instanceof AssignmentOperationError)) throw error;

    return (
      <RecordPageNotice
        title="Equipment"
        description="Stations and locations referenced in your current shift records."
        heading="Equipment view unavailable"
        body={error.message}
      />
    );
  }

  if (!current) {
    return (
      <RecordPageNotice
        title="Equipment"
        description="Stations and locations referenced in your current shift records."
        heading="No current operational shift"
        body="Equipment locations appear once a shift is assigned to you and active."
      />
    );
  }

  if (current.status === "scheduled") {
    return (
      <RecordPageNotice
        title="Equipment"
        description="Stations and locations referenced in your current shift records."
        heading="This shift has not started yet"
        body={`The shift is scheduled to begin at ${formatDateTime(current.scheduledStart)}.`}
      />
    );
  }

  let view;

  try {
    view = await getTechnicianEquipmentView(actor, current.id);
  } catch (error) {
    if (
      !(error instanceof ShiftOperationsError) &&
      !(error instanceof AssignmentOperationError)
    ) {
      throw error;
    }

    return (
      <RecordPageNotice
        title="Equipment"
        description="Stations and locations referenced in your current shift records."
        heading="This shift record is not available"
        body={error.message}
      />
    );
  }

  const stats = [
    ["Station checks", `${view.counts.verifiedStations}/${view.counts.totalStations}`],
    ["Recorded locations", view.counts.locations],
  ] as const;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Equipment</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Configured stations and the locations recorded against faults and
            outside broadcasts in your current shift.
          </p>
        </div>

        <Link
          className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--elevated)]"
          href="/technician/operations"
        >
          Open Shift Operations
        </Link>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
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

      <section
        aria-labelledby="equipment-stations-title"
        className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
      >
        <h2 id="equipment-stations-title" className="text-lg font-semibold">
          Broadcast stations
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
            <thead className="bg-[var(--elevated)] text-xs uppercase tracking-wide text-[var(--muted)]">
              <tr>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Station
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Latest check
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
              {view.stations.map((station) => (
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

      <section
        aria-labelledby="equipment-locations-title"
        className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
      >
        <h2 id="equipment-locations-title" className="text-lg font-semibold">
          Recorded locations
        </h2>

        {view.locations.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No fault or outside-broadcast locations have been recorded this
            shift.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
              <thead className="bg-[var(--elevated)] text-xs uppercase tracking-wide text-[var(--muted)]">
                <tr>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Location / equipment
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Section
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Record
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Recorded
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.locations.map((location) => (
                  <tr
                    key={`${location.section}-${location.name}`}
                    className="border-t border-[var(--border)] align-top"
                  >
                    <td className="px-3 py-3 font-medium">{location.name}</td>
                    <td className="px-3 py-3 text-[var(--muted)]">
                      {location.section}
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-medium">{location.title}</p>
                      {location.actionTaken && (
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {location.actionTaken}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${recordTone(
                          location.status,
                        )}`}
                      >
                        {humanize(location.status)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-[var(--muted)]">
                      {formatDateTime(location.occurredAt)}
                      <span className="block text-xs">{location.authorName}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-[var(--muted)]">
          Equipment inventory is not tracked separately. This view lists the
          configured stations and the station or equipment locations captured in
          this shift&apos;s fault and outside-broadcast records.
        </p>
      </section>
    </div>
  );
}
