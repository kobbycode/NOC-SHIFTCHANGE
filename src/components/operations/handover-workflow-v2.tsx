"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { EqualHandoverReportState } from "@/lib/operations/equal-handover-report-firestore";
import type { EqualHandoverReportV2Content } from "@/types/handover-report-v2";

const field = "block w-full rounded-lg border bg-transparent p-2";

function accra(value: string | null): string {
  return value === null ? "—" : new Date(value).toLocaleString("en-GB", { timeZone: "Africa/Accra" });
}

function short(value: string | null): string {
  return value === null ? "—" : value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export function EqualHandoverWorkflowV2({ uid, initialState }: { uid: string; initialState: EqualHandoverReportState }) {
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);

  const { aggregate, guard, preparation, frozenReport, live, preparationDrifted } = state;
  const isOutgoing = aggregate.identity.outgoingTechnicianIds.includes(uid);
  const isIncoming = aggregate.identity.incomingTechnicianIds.includes(uid);
  const content: EqualHandoverReportV2Content = (frozenReport?.content ?? preparation?.content ?? live.content);
  const base = `/api/operations/shifts/${encodeURIComponent(aggregate.identity.outgoingShiftId)}/handover/v2`;

  const run = async (path: string, method: "POST" | "DELETE", body: Record<string, unknown>, success: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "The v2 report action failed.");
      setNotice(success);
      const refreshed = await fetch(`${base}/report`, { headers: { Accept: "application/json" } });
      const refreshResult = await refreshed.json();
      if (refreshed.ok && refreshResult.success) setState(refreshResult.report);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The v2 report action failed.");
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  const prepare = async (form: HTMLFormElement) => {
    const values = new FormData(form);
    const reason = String(values.get("reason") ?? "").trim();
    await run("/report", "POST", { reason: reason || null }, preparation ? "Report re-prepared for review." : "Consolidated report prepared for review.");
  };

  const declareAbsence = async (form: HTMLFormElement) => {
    const values = new FormData(form);
    const technicianUid = String(values.get("subject") ?? "");
    const subject = content.participants.find((item) => item.uid === technicianUid);
    const departure = String(values.get("departure") ?? "");
    await run("/absence", "POST", {
      technicianUid,
      absenceType: subject?.side === "outgoing" ? "absent_left_office" : "not_yet_in",
      reason: String(values.get("reason") ?? ""),
      reportedDepartureTime: subject?.side === "outgoing" && departure ? new Date(departure).toISOString() : null,
      expectedRevision: aggregate.revision,
      expectedSnapshotHash: state.snapshotHash,
    }, "Absence declaration recorded. Re-prepare the report to include it.");
  };

  const clearAbsence = (technicianUid: string) => run("/absence", "DELETE", {
    technicianUid,
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: state.snapshotHash,
  }, "Absence declaration cleared. Re-prepare the report to include the change.");

  const freeze = async (form: HTMLFormElement) => {
    if (!preparation || !guard) return;
    const values = new FormData(form);
    const correctionNote = String(values.get("correctionNote") ?? "").trim();
    await run("/report/freeze", "POST", {
      expectedRevision: aggregate.revision,
      expectedSnapshotHash: state.snapshotHash,
      expectedGuardRevision: guard.guardRevision,
      expectedFencingEpoch: guard.fencingEpoch,
      preparationRevision: preparation.preparationRevision,
      contentDigest: preparation.contentDigest,
      evidenceSnapshotHash: preparation.evidenceSnapshotHash,
      workSnapshotVersion: preparation.workSnapshotVersion,
      reason: String(values.get("reason") ?? ""),
      correctionNote: correctionNote || null,
    }, frozenReport ? "Corrected report frozen as a new immutable version." : "Report frozen. It is now immutable.");
  };

  const absence = aggregate.absences[0] ?? null;

  return <div className="space-y-6">
    <header className="space-y-1">
      <h1 className="text-2xl font-bold">Equal-technician handover report (v2)</h1>
      <p className="text-sm">{aggregate.identity.outgoingShiftId} → {aggregate.reservation.reservedIncomingShiftId} · {aggregate.lifecycleStatus.replaceAll("_", " ")} · Revision {aggregate.revision} · Guard {guard ? `r${guard.guardRevision} / epoch ${guard.fencingEpoch}` : "unavailable"}</p>
      <p className="text-sm">Scheduled {accra(aggregate.reservation.scheduledStart)} – {accra(aggregate.reservation.scheduledEnd)} (Africa/Accra)</p>
    </header>

    {frozenReport && <div className="rounded-xl border p-4 text-sm">Frozen report <strong>{frozenReport.id}</strong> (version {frozenReport.version}{frozenReport.supersedesReportId ? `, supersedes ${frozenReport.supersedesReportId}` : ""}) frozen by {frozenReport.frozenBy} at {accra(frozenReport.frozenAt)} · digest {short(frozenReport.digest)}.</div>}
    {preparationDrifted && <div className="rounded-xl border border-amber-500 p-4 text-sm">The authoritative sources changed since the last preparation. Re-prepare and review the consolidated report before freezing.</div>}
    {!preparation && !preparationDrifted && <div className="rounded-xl border p-4 text-sm">No preparation exists yet. Prepare the consolidated report to begin the review.</div>}
    {notice && <p className="text-sm text-green-700">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

    {isOutgoing && <section className="space-y-3 rounded-xl border p-5">
      <h2 className="text-lg font-semibold">Outgoing technician actions</h2>
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void prepare(event.currentTarget as HTMLFormElement); }}>
        <label className="text-sm">Optional preparation note<input className={field} name="reason" maxLength={2000} placeholder="Why this revision is being prepared"/></label>
        <button disabled={busy || aggregate.lifecycleStatus !== "collecting_confirmations"} className="w-fit rounded-lg bg-blue-700 p-2 text-white">{busy ? "Working…" : preparationDrifted || !preparation ? "Prepare consolidated report" : "Re-prepare identical report"}</button>
      </form>
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void declareAbsence(event.currentTarget as HTMLFormElement); }}>
        <label className="text-sm">Absent colleague (declared by a colleague, never self)<select className={field} name="subject" required>
          <option value="">Select participant</option>
          {content.participants.filter(item => item.uid !== uid).map(item => <option key={item.uid} value={item.uid}>{item.name ?? item.uid} ({item.side})</option>)}
        </select></label>
        <label className="text-sm">Reason<input className={field} name="reason" required maxLength={1000}/></label>
        <label className="text-sm">Reported departure time (outgoing absences only)<input className={field} name="departure" type="datetime-local"/></label>
        <button disabled={busy} className="w-fit rounded-lg bg-blue-700 p-2 text-white">Declare absence</button>
      </form>
      {absence && <div className="text-sm">Declared: {absence.absenceType.replaceAll("_", " ")} · {absence.technicianUid}
        <button disabled={busy} className="ml-3 rounded-lg border p-2" onClick={() => void clearAbsence(absence.technicianUid)}>Clear declaration</button>
      </div>}
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void freeze(event.currentTarget as HTMLFormElement); }}>
        <label className="text-sm">Freeze reason<input className={field} name="reason" required maxLength={1000}/></label>
        {frozenReport && <label className="text-sm">Correction note (required for a later version)<input className={field} name="correctionNote" required maxLength={4000}/></label>}
        <button disabled={busy || !preparation || preparationDrifted || !guard || aggregate.lifecycleStatus !== "collecting_confirmations"} className="w-fit rounded-lg bg-blue-700 p-2 text-white">Review complete — freeze report</button>
      </form>
      <p className="text-sm">Participant confirmations and the final shift transfer arrive in a later milestone; no confirmation or transfer action is available here.</p>
    </section>}
    {!isOutgoing && isIncoming && <div className="rounded-xl border p-4 text-sm">You are an incoming technician for this reserved pair. This view is read-only until your shift begins.</div>}

    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{frozenReport ? "Frozen report content (immutable)" : preparation && !preparationDrifted ? "Prepared report (awaiting review)" : "Live consolidated evidence"}</h2>
      <div className="grid gap-3 rounded-xl border p-5 text-sm sm:grid-cols-2">
        <p><strong>Date:</strong> {content.staff.shiftDate} · {content.staff.shiftType}</p>
        <p><strong>Location:</strong> {content.staff.engineeringLocation ?? "—"}</p>
        <p><strong>Scheduled:</strong> {accra(content.staff.scheduledStart)} – {accra(content.staff.scheduledEnd)}</p>
        <p><strong>Actual start:</strong> {accra(content.staff.actualStart)}</p>
        <p><strong>Handover started:</strong> {accra(content.staff.handoverStartedAt)}</p>
        <p><strong>Successor slot:</strong> {content.slotLineage.successorSlotToken} (gen {content.slotLineage.successorGeneration})</p>
      </div>

      <div className="rounded-xl border p-5 space-y-2 text-sm overflow-x-auto">
        <h3 className="font-semibold">Attendance and absences</h3>
        <table className="w-full text-left text-sm">
          <thead><tr><th>Participant</th><th>Side</th><th>Clock-in</th><th>Clock-out</th><th>Departure</th><th>Hours</th><th>Payable</th><th>Absence</th><th>Evidence</th></tr></thead>
          <tbody>{content.attendance.map(row => <tr key={row.position}>
            <td>{row.name ?? row.uid}</td><td>{row.side}</td><td>{accra(row.clockIn)}</td><td>{accra(row.clockOut)}</td>
            <td>{row.departureProvenance ?? "—"}</td><td>{row.hoursWorked === null ? "—" : row.hoursWorked.toFixed(2)}</td>
            <td>{row.payableHours}</td><td>{row.absenceDeclared?.replaceAll("_", " ") ?? "—"}</td>
            <td>{row.reportingEvidence ? `${row.reportingEvidence.kind} · ${row.reportingEvidence.personallyAuthenticated ? "personal" : `attested by ${row.reportingEvidence.attestedByUid ?? "—"}`}` : row.legacyAttendance ? "legacy record" : "missing"}</td>
          </tr>)}</tbody>
        </table>
        {content.attendance.some(row => row.clockIn === null && row.clockOut === null && row.absenceDeclared === null) && <p>Missing attendance remains missing — it is never synthesized.</p>}
      </div>

      <div className="rounded-xl border p-5 space-y-2 text-sm">
        <h3 className="font-semibold">Broadcast operations</h3>
        <ul>{content.operations.broadcast.map(item => <li key={item.stationId}>{item.stationName}: {item.observation ? `${item.observation.kind === "broadcast" ? item.observation.status : "observed"} · ${accra(item.observation.occurredAt)}` : "no verified observation"}</li>)}</ul>
        <p>Outside broadcasts: {content.operations.completeness.outsideBroadcast.replaceAll("_", " ")}</p>
        <details className="space-y-1"><summary className="cursor-pointer font-semibold">Event log ({content.operations.events.length})</summary>
          <ul>{content.operations.events.map(event => <li key={event.id}>{accra(event.occurredAt)} · {event.kind === "incident" ? `${event.title} (${event.severity})` : event.kind === "broadcast" ? `${event.stationName} ${event.status}` : event.kind === "outside_broadcast" ? `Outside: ${event.title}` : "No outside broadcast declared"}</li>)}</ul>
        </details>
        <p className="italic">A missing fault record is not proof that no faults occurred.</p>
      </div>

      <div className="rounded-xl border p-5 space-y-2 text-sm">
        <h3 className="font-semibold">Pending tasks ({content.pendingTasks.length})</h3>
        {content.pendingTasks.length === 0 && <p>No pending tasks recorded.</p>}
        <ul>{content.pendingTasks.map(task => <li key={task.id}><strong>{task.title}</strong> · {task.status.replaceAll("_", " ")} · {task.priority} · disposition: {task.disposition.replaceAll("_", " ")}{task.carryForwardEligible ? " · carry-forward eligible" : ""}</li>)}</ul>
        <h3 className="pt-2 font-semibold">Terminal task evidence ({content.terminalTaskEvidence.length})</h3>
        {content.terminalTaskEvidence.length === 0 && <p>No tasks completed or cancelled during this shift.</p>}
        <ul>{content.terminalTaskEvidence.map(task => <li key={task.id}>{task.title} · {task.status} · closed {accra(task.updatedAt)} · work hash {short(task.workHash)}</li>)}</ul>
        <p>Work snapshot {short(content.workSnapshot.version)}</p>
      </div>

      <div className="rounded-xl border p-5 space-y-2 text-sm">
        <h3 className="font-semibold">Completeness</h3>
        <p className="font-semibold text-red-700">Blockers ({content.completeness.blockers.length})</p>
        <ul>{content.completeness.blockers.map(item => <li key={item}>• {item}</li>)}</ul>
        <p className="pt-2 font-semibold text-amber-700">Warnings ({content.completeness.warnings.length})</p>
        <ul>{content.completeness.warnings.map(item => <li key={item}>• {item}</li>)}</ul>
      </div>

      {content.corrections.length > 0 && <div className="rounded-xl border p-5 space-y-1 text-sm"><h3 className="font-semibold">Report corrections</h3>
        <ul>{content.corrections.map(item => <li key={item.id}>{accra(item.recordedAt)} · {item.recordedBy}: {item.note}</li>)}</ul></div>}

      {preparation && <div className="rounded-xl border p-5 space-y-1 text-sm">
        <h3 className="font-semibold">Preparation revision {preparation.preparationRevision}</h3>
        <p>Content digest {short(preparation.contentDigest)} · Evidence hash {short(preparation.evidenceSnapshotHash)} · Work snapshot {short(preparation.workSnapshotVersion)}</p>
        <p>Reviewed against reservation revision {preparation.aggregateRevision} · Guard r{preparation.guardRevision} epoch {preparation.fencingEpoch}</p>
        <p>First prepared {accra(preparation.createdAt)} · last updated {accra(preparation.updatedAt)}</p>
        <details><summary className="cursor-pointer">Revision history ({preparation.revisionHistory.length})</summary>
          <ul>{preparation.revisionHistory.map(entry => <li key={entry.preparationRevision}>Revision {entry.preparationRevision} · {accra(entry.preparedAt)} · {entry.preparedBy} · {short(entry.contentDigest)}{entry.reason ? ` · ${entry.reason}` : ""}</li>)}</ul>
        </details>
      </div>}

      {frozenReport && <div className="rounded-xl border p-5 space-y-1 text-sm">
        <h3 className="font-semibold">Freeze binding</h3>
        <p>Report {frozenReport.id} · digest {short(frozenReport.digest)} · evidence {short(frozenReport.evidenceSnapshotHash)}</p>
        <p>Reservation {short(frozenReport.reservationId)} · preparation revision {frozenReport.preparationRevision} · aggregate revision {frozenReport.aggregateRevision}</p>
        <p>Guard revision {frozenReport.guardRevision} · fencing epoch {frozenReport.fencingEpoch} · frozen by {frozenReport.frozenBy} at {accra(frozenReport.frozenAt)}</p>
        <p>Reason: {frozenReport.reason}{frozenReport.correctionNote ? ` · Correction: ${frozenReport.correctionNote}` : ""}</p>
      </div>}
    </section>
  </div>;
}
