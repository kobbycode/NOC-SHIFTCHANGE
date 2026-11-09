// TECH-HO-RECOVERY-09K — read-only supervisor list of v2 equal-technician
// handovers. Presentational only: no mutation affordance. Readiness and
// blockers come from the authoritative derived evidence in each row; a null
// readiness renders an honest "unavailable" state.
import Link from "next/link";
import type { SupervisorV2HandoverRow, SupervisorV2ParticipantView } from "@/lib/operations/supervisor-handover-v2";

function stamp(value: string | null): string {
  return value ? new Date(value).toLocaleString("en-GB", { timeZone: "Africa/Accra" }) : "—";
}

function teamSummary(members: SupervisorV2ParticipantView[]): string {
  if (members.length === 0) return "—";
  return members.map((member) => {
    const who = member.name ?? "Unnamed technician";
    if (member.absent) return `${who} (absent)`;
    if (member.confirmed) return `${who} (confirmed)`;
    return `${who} (awaiting)`;
  }).join(", ");
}

function statusBadge(row: SupervisorV2HandoverRow) {
  if (row.ready === null) return <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-700">Evidence unavailable</span>;
  if (row.lifecycleStatus === "completed") return <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">Completed</span>;
  if (row.ready) return <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">Ready</span>;
  return <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Not ready</span>;
}

export function SupervisorHandoverV2List({ rows }: { rows: SupervisorV2HandoverRow[] }) {
  return <main className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
    <header className="space-y-1">
      <Link href="/supervisor/handovers" className="text-sm text-blue-700 underline">← Handovers</Link>
      <h1 className="text-2xl font-bold">Equal-technician handovers (v2)</h1>
      <p className="text-sm text-neutral-600">Read-only supervision of both technician teams, progress, participation and documented exceptions.</p>
    </header>

    {rows.length === 0
      ? <p className="rounded-xl border p-5 text-sm text-neutral-600">No v2 equal-technician handovers exist yet.</p>
      : <ul className="space-y-3">{rows.map((row) => <li key={row.outgoingShiftId}>
        <Link href={`/supervisor/handovers/v2/${encodeURIComponent(row.outgoingShiftId)}`} className="block space-y-2 rounded-xl border p-5 hover:border-blue-500">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">Handover starting {stamp(row.scheduledStart)}</p>
            {statusBadge(row)}
          </div>
          <p className="text-sm">{row.lifecycleStatus.replaceAll("_", " ")} · Revision {row.revision} · Scheduled {stamp(row.scheduledStart)} · Initiated {stamp(row.initiationAt)}</p>
          <p className="text-sm"><span className="font-medium">Outgoing:</span> {teamSummary(row.outgoingTeam)}</p>
          <p className="text-sm"><span className="font-medium">Incoming:</span> {teamSummary(row.incomingTeam)}</p>
          <p className="text-sm">Confirmed {row.confirmedCount}/{row.requiredConfirmations} · absences {row.absenceCount}</p>
          {row.ready === null
            ? <p className="text-sm text-red-700">Authoritative readiness unavailable for this handover — open the detail view.</p>
            : row.blockers.length > 0
              ? <ul className="text-sm text-red-700">{row.blockers.map((blocker) => <li key={blocker}>• {blocker}</li>)}</ul>
              : <p className="text-sm text-green-700">No outstanding blockers.</p>}
          <p className="text-sm text-blue-600">Open read-only report →</p>
        </Link>
      </li>)}</ul>}
  </main>;
}
