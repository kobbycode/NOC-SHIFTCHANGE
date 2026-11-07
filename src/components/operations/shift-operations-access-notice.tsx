import Link from "next/link";

export type ShiftOperationsAccessReason =
  | { kind: "no_shift" }
  | { kind: "scheduled"; scheduledStart: string }
  | { kind: "join_available" }
  | { kind: "join_closed"; shiftStatus: string }
  | { kind: "clocked_out" }
  | { kind: "read_only"; message: string }
  | { kind: "unavailable"; message: string };

function formatTime(value: string): string {
  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : value;
}

function copyFor(
  reason: ShiftOperationsAccessReason,
): { title: string; body: string } {
  switch (reason.kind) {
    case "no_shift":
      return {
        title: "No current operational shift",
        body: "Shift Operations opens once a shift is assigned to you and active. Technicians start the first shift themselves; later shifts activate automatically when an incoming technician accepts the handover.",
      };
    case "scheduled":
      return {
        title: "This shift has not started yet",
        body: `Records can only be entered during the shift itself, which is scheduled to begin at ${formatTime(reason.scheduledStart)}.`,
      };
    case "join_available":
      return {
        title: "Join this shift to start recording",
        body: "Joining is the attendance boundary: until you join, records cannot be attributed to you. Open My Shift and select Join shift.",
      };
    case "join_closed":
      return {
        title: "Record entry is closed for this shift",
        body: "Handover has already begun, so joining and operational record entry are both closed. Records are only accepted while the shift is active, and missing evidence is never added retroactively. Ask your supervisor to review this shift's attendance and records.",
      };
    case "clocked_out":
      return {
        title: "You have clocked out of this shift",
        body: "Operational records are attributed to the technicians who are present on shift. Ask your supervisor to review anything that still needs recording.",
      };
    case "read_only":
      return {
        title: "This view is read-only",
        body: `${reason.message} You can still review your own shifts, your attendance and lateness, the records and tasks you authored, and your own handover receipts from My Shift.`,
      };
    case "unavailable":
      return {
        title: "Shift Operations is unavailable",
        body: reason.message,
      };
  }
}

export function ShiftOperationsAccessNotice({
  reason,
}: {
  reason: ShiftOperationsAccessReason;
}) {
  const copy = copyFor(reason);

  const needsSupervisor =
    reason.kind === "join_closed" || reason.kind === "clocked_out";

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Shift Operations</h1>

        <p className="mt-1 text-sm text-slate-500">
          Shared shift records · Individual authorship
        </p>
      </div>

      <div
        role="status"
        className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-900"
      >
        <h2 className="text-lg font-semibold">{copy.title}</h2>

        <p className="text-sm">{copy.body}</p>

        {reason.kind === "join_closed" && (
          <p className="text-xs">Shift status: {reason.shiftStatus}</p>
        )}

        {needsSupervisor && (
          <p className="text-sm font-medium">
            This is a supervisor review matter, not something you can resolve
            from this screen.
          </p>
        )}

        <div className="flex flex-wrap gap-3 pt-1">
          <Link
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white"
            href="/technician"
          >
            Open My Shift
          </Link>

          <Link
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium"
            href="/technician/handovers"
          >
            Open Handovers
          </Link>
        </div>
      </div>
    </section>
  );
}
