"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { EqualHandoverReportState } from "@/lib/operations/equal-handover-report-firestore";
import type { EqualHandoverReportV2Content } from "@/types/handover-report-v2";
const field = "block w-full rounded-lg border bg-transparent p-2";

const POSITION_LABELS: { position: string; side: "outgoing" | "incoming"; label: string }[] = [
  { position: "outgoing_tech_a", side: "outgoing", label: "Outgoing technician A" },
  { position: "outgoing_tech_b", side: "outgoing", label: "Outgoing technician B" },
  { position: "incoming_tech_a", side: "incoming", label: "Incoming technician A" },
  { position: "incoming_tech_b", side: "incoming", label: "Incoming technician B" },
];

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

  const { aggregate, guard, preparation, frozenReport, live, preparationDrifted, readiness } = state;
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

  const confirmSelf = () => run("/confirmation", "POST", {
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: state.snapshotHash,
  }, "Your personal confirmation has been recorded.");

  // The two-stage lifecycle (§1 addendum) replaces M07's atomic transfer. The
  // outgoing commit closes the reviewed handover into `awaiting_incoming_acceptance`
  // without creating any shift, membership or attendance; the incoming
  // acceptance is what activates the reserved shift with the technician's own
  // password. The button enable state below is only a display convenience — the
  // server re-derives every authority and prerequisite inside its own
  // transaction (§10), so a client-forged flag cannot bypass either step.
  const reviewedBinding = () => ({
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: state.snapshotHash,
    expectedGuardRevision: guard?.guardRevision ?? 0,
    expectedFencingEpoch: guard?.fencingEpoch ?? 0,
  });

  const commitOutgoing = async () => {
    if (lock.current || !guard) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${base}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reviewedBinding()),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "The v2 handover commit failed.");
      setNotice(result.replayed
        ? "This handover was already committed — an incoming technician must now accept with their own password."
        : "Committed for incoming acceptance. The incoming shift activates only when a reserved incoming technician accepts with their own password.");
      const refreshed = await fetch(`${base}/report`, { headers: { Accept: "application/json" } });
      const refreshResult = await refreshed.json();
      if (refreshed.ok && refreshResult.success) setState(refreshResult.report);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The v2 handover commit failed.");
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  // §4 — the accept button submits the technician's OWN current password,
  // verified server-side outside any transaction. The password is never stored
  // by this component beyond the transient form field and never logged; the
  // session cookie alone is not enough to accept a personal handover.
  const acceptIncoming = async (form: HTMLFormElement) => {
    if (lock.current || !guard) return;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    if (!password) { setError("Your password is required to accept this handover."); return; }
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${base}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...reviewedBinding(), password }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "The v2 handover acceptance failed.");
      // §12 — the notice NEVER claims an activated shift until the server has
      // confirmed the committed operation; the status below is the authoritative
      // outcome returned by the accept route.
      if (result.status === "ACTIVATED") {
        setNotice(`Handover accepted. The incoming shift ${result.incomingShiftId} is now active from ${accra(result.receipt?.activatedAt ?? null)}.`);
      } else if (result.status === "JOINED") {
        setNotice(`Joined the active incoming shift ${result.incomingShiftId}. Your attendance is recorded independently at the acceptance clock.`);
      } else if (result.status === "ALREADY_JOINED") {
        setNotice("Your earlier acceptance is already recorded — no duplicate shift or attendance was created.");
      } else {
        setNotice("Handover acceptance succeeded.");
      }
      form.reset();
      const refreshed = await fetch(`${base}/report`, { headers: { Accept: "application/json" } });
      const refreshResult = await refreshed.json();
      if (refreshed.ok && refreshResult.success) setState(refreshResult.report);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The v2 handover acceptance failed.");
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  const absence = aggregate.absences[0] ?? null;
  // A position is the participant's exact slot, not just their side: index 0 of
  // the outgoing pair is outgoing_tech_a and index 1 is outgoing_tech_b (and the
  // same for the incoming pair), so each technician maps to exactly one position.
  const outgoingIds = aggregate.identity.outgoingTechnicianIds;
  const incomingIds = aggregate.identity.incomingTechnicianIds;
  const myPosition =
    outgoingIds[0] === uid ? "outgoing_tech_a"
      : outgoingIds[1] === uid ? "outgoing_tech_b"
        : incomingIds[0] === uid ? "incoming_tech_a"
          : incomingIds[1] === uid ? "incoming_tech_b"
            : null;
  const myConfirmation = myPosition ? aggregate.confirmations.find((c) => c.position === myPosition) : undefined;
  const myAbsence = myPosition ? aggregate.absences.find((a) => a.position === myPosition) : undefined;

  const participantState = (position: string) => {
    if (aggregate.confirmations.some((c) => c.position === position)) return "confirmed";
    if (aggregate.absences.some((a) => a.position === position)) return "absent";
    return "awaiting_confirmation";
  };

  const canConfirm = myPosition !== null && !myConfirmation && !myAbsence &&
    aggregate.lifecycleStatus === "collecting_confirmations" && aggregate.reportBinding !== null;

  const isAwaitingAcceptance = aggregate.lifecycleStatus === "awaiting_incoming_acceptance";
  const isCompleted = aggregate.lifecycleStatus === "completed";
  const isConfirmedOutgoing = isOutgoing && myConfirmation !== undefined;
  const blockers = content.completeness.blockers;
  // Display prerequisite only — never a substitute for the server's own
  // authorization: a personally confirmed outgoing technician, a bound and
  // current frozen report, satisfied readiness and no visible blockers.
  const canCommit = isConfirmedOutgoing && guard !== null &&
    aggregate.lifecycleStatus === "collecting_confirmations" && aggregate.reportBinding !== null &&
    readiness.ready && blockers.length === 0 && !preparationDrifted;
  // An incoming technician may accept once the outgoing commit has opened the
  // acceptance window; a later acceptance after completion is a JOIN on the same
  // active shift. The server decides which branch fires and re-derives authority.
  const canAccept = isIncoming && guard !== null && (isAwaitingAcceptance || isCompleted);

  return <div className="space-y-6">
    <header className="space-y-1">
      <h1 className="text-2xl font-bold">Equal-technician handover report (v2)</h1>
      <p className="text-sm">{aggregate.identity.outgoingShiftId} → {aggregate.reservation.reservedIncomingShiftId} · {aggregate.lifecycleStatus.replaceAll("_", " ")} · Revision {aggregate.revision} · Guard {guard ? `r${guard.guardRevision} / epoch ${guard.fencingEpoch}` : "unavailable"}</p>
      <p className="text-sm">Scheduled {accra(aggregate.reservation.scheduledStart)} – {accra(aggregate.reservation.scheduledEnd)} (Africa/Accra)</p>
    </header>

    {isCompleted && <section aria-label="Handover activated" className="rounded-xl border border-green-600 p-4 text-sm space-y-1">
      <h2 className="font-semibold text-green-800">Handover activated</h2>
      <p>This equal-technician handover is complete. The outgoing shift {aggregate.identity.outgoingShiftId} is closed and the incoming shift {aggregate.identity.incomingShiftId} was activated by the first reserved incoming technician&rsquo;s password acceptance. Every subsequent incoming acceptance joins the same active shift with its own independent attendance clock.</p>
      <p>Frozen report {frozenReport ? `v${frozenReport.version} (${short(frozenReport.id)})` : "unavailable"} · guard {guard ? `r${guard.guardRevision} / epoch ${guard.fencingEpoch}` : "unavailable"}. This record is immutable; further acceptance attempts replay this result.</p>
    </section>}

    {isAwaitingAcceptance && <section aria-label="Awaiting incoming acceptance" className="rounded-xl border border-amber-500 p-4 text-sm space-y-1">
      <h2 className="font-semibold text-amber-800">Awaiting incoming acceptance</h2>
      <p>The outgoing pair has committed this handover. The reserved incoming shift {aggregate.reservation.reservedIncomingShiftId} has NOT been created yet — an incoming technician must now accept with their OWN current password, and that first authorized acceptance is what activates the shift exactly once.</p>
      <p>The outgoing shift remains handover_pending and continues to own the operational slot until acceptance; no shift, membership or attendance is fabricated while acceptance is pending.</p>
    </section>}

    <section aria-label="Handover readiness" className={`rounded-xl border p-4 text-sm ${readiness.ready ? "border-green-600" : "border-neutral-500"}`}>
      <h2 className="font-semibold">Readiness: {readiness.ready ? "all confirmations and permitted exceptions satisfied" : "not ready"}</h2>
      <p className="mt-1">Confirmed {readiness.confirmedCount} of {readiness.requiredConfirmations} · absences {readiness.absenceCount} of {readiness.supportedAbsences} supported · report {readiness.boundReportId ? `v${readiness.boundReportVersion} (newest v${readiness.newestReportVersion})` : "not frozen"}.</p>
      {!readiness.ready && <ul className="mt-2 space-y-0.5 text-red-700">{readiness.reasons.map((reason) => <li key={reason}>• {reason.replaceAll("_", " ")}</li>)}</ul>}
      <p className="mt-2 italic">Readiness is derived from authoritative evidence and is not a completed handover or a transfer authorization.</p>
    </section>

    {myPosition && !isCompleted && !isAwaitingAcceptance && <section className="rounded-xl border p-5 space-y-2 text-sm">
      <h2 className="text-lg font-semibold">Your confirmation</h2>
      <p>Position: {POSITION_LABELS.find((item) => item.position === myPosition)?.label} · state: {participantState(myPosition).replaceAll("_", " ")}.</p>
      {myConfirmation && <p>You personally confirmed at {accra(myConfirmation.confirmedAt)} against report {short(myConfirmation.reportBinding.id)} (digest {short(myConfirmation.reportBinding.digest)}).</p>}
      {myAbsence && <p>A colleague recorded you as {myAbsence.absenceType.replaceAll("_", " ")}; an absence is not a personal confirmation.</p>}
      {canConfirm && <button disabled={busy} onClick={() => void confirmSelf()} className="rounded-lg bg-blue-700 p-2 text-white">{busy ? "Working…" : "Confirm this handover for myself"}</button>}
      {aggregate.reportBinding === null && <p>Confirmation is available only after the consolidated report is frozen.</p>}
    </section>}

    <section aria-label="Participant confirmations" className="rounded-xl border p-5 space-y-2 text-sm overflow-x-auto">
      <h2 className="text-lg font-semibold">Participant confirmations</h2>
      <table className="w-full text-left">
        <thead><tr><th>Participant</th><th>Side</th><th>Technician</th><th>State</th><th>Report</th></tr></thead>
        <tbody>{POSITION_LABELS.map((item) => {
          const confirmation = aggregate.confirmations.find((c) => c.position === item.position);
          const positionAbsence = aggregate.absences.find((a) => a.position === item.position);
          const uidFor = item.side === "outgoing" ? aggregate.identity.outgoingTechnicianIds : aggregate.identity.incomingTechnicianIds;
          const technicianUid = (item.position === "outgoing_tech_a" || item.position === "incoming_tech_a") ? uidFor[0] : uidFor[1];
          return <tr key={item.position}>
            <td>{item.label}</td>
            <td>{item.side}</td>
            <td>{technicianUid === uid ? `${technicianUid} (you)` : technicianUid}</td>
            <td>{participantState(item.position).replaceAll("_", " ")}</td>
            <td>{confirmation ? short(confirmation.reportBinding.id) : positionAbsence ? positionAbsence.absenceType.replaceAll("_", " ") : "—"}</td>
          </tr>;
        })}</tbody>
      </table>
    </section>

    {frozenReport && <div className="rounded-xl border p-4 text-sm">Frozen report <strong>{frozenReport.id}</strong> (version {frozenReport.version}{frozenReport.supersedesReportId ? `, supersedes ${frozenReport.supersedesReportId}` : ""}) frozen by {frozenReport.frozenBy} at {accra(frozenReport.frozenAt)} · digest {short(frozenReport.digest)}.</div>}
    {preparationDrifted && <div className="rounded-xl border border-amber-500 p-4 text-sm">The authoritative sources changed since the last preparation. Re-prepare and review the consolidated report before freezing.</div>}
    {!preparation && !preparationDrifted && <div className="rounded-xl border p-4 text-sm">No preparation exists yet. Prepare the consolidated report to begin the review.</div>}
    {notice && <p className="text-sm text-green-700">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

    {isOutgoing && !isCompleted && !isAwaitingAcceptance && <section className="space-y-3 rounded-xl border p-5">
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
      <p className="text-sm">Confirm the handover for yourself using the &ldquo;Your confirmation&rdquo; section above.</p>
    </section>}

    {isOutgoing && !isCompleted && !isAwaitingAcceptance && <section aria-label="Commit for incoming acceptance" className="space-y-3 rounded-xl border p-5">
      <h2 className="text-lg font-semibold">Commit for incoming acceptance</h2>
      <ul className="space-y-1 text-sm">
        <li>{aggregate.reportBinding !== null ? "• Consolidated report frozen" : "• Consolidated report not frozen yet"}</li>
        <li>{myConfirmation ? "• You have personally confirmed this handover" : "• You must personally confirm this handover first"}</li>
        <li>{`• Confirmations: ${readiness.confirmedCount}/${readiness.requiredConfirmations} · supported absences: ${readiness.absenceCount}/${readiness.supportedAbsences}`}</li>
        <li>{blockers.length === 0 ? "• No report completeness blockers" : `• ${blockers.length} blocker(s) must be resolved`}</li>
        <li>{preparationDrifted ? "• Sources changed since review — re-prepare and freeze" : "• Review is current"}</li>
      </ul>
      {!isConfirmedOutgoing && <p className="text-sm">Only an outgoing technician who has personally confirmed (not declared absent) can commit this handover for incoming acceptance.</p>}
      <button
        disabled={!canCommit || busy}
        onClick={() => void commitOutgoing()}
        className="w-fit rounded-lg bg-green-700 p-2 text-white"
      >{busy ? "Working…" : "Commit handover — await incoming acceptance"}</button>
      {!canCommit && !busy && <p className="text-sm text-neutral-600">Committing is available only when every prerequisite above is satisfied.</p>}
      <p className="text-sm text-neutral-600">This display gate is not an authorization: the server re-derives your authority, the reviewed evidence, readiness and completeness inside its own transaction and can still reject the request even when this button is enabled. Committing does NOT create the incoming shift — that only happens on a reserved incoming technician&rsquo;s own password acceptance.</p>
      {!isConfirmedOutgoing && !myConfirmation && !myAbsence && myPosition && <p className="text-sm">You have not confirmed yet — use the confirmation section above.</p>}
    </section>}

    {isIncoming && (isAwaitingAcceptance || isCompleted) && <section aria-label="Accept handover" className="space-y-3 rounded-xl border border-green-600 p-5">
      <h2 className="text-lg font-semibold">Accept handover with your password</h2>
      <p className="text-sm">
        {isAwaitingAcceptance
          ? <>You are a reserved incoming technician. Accepting with <strong>your own current password</strong> will activate the reserved incoming shift {aggregate.reservation.reservedIncomingShiftId} exactly once and record <em>your</em> attendance at the authoritative acceptance clock. Your partner will join the same active shift when they accept later.</>
          : <>The incoming shift {aggregate.identity.incomingShiftId} is already active. Accepting joins that same shift with your own independent attendance time; the first technician&rsquo;s clock is never overwritten and no new shift is created.</>}
      </p>
      <p className="text-sm text-neutral-600">The password is verified server-side before any write and is never stored, logged, or included in the audit receipt (§4). A supervisor or an outgoing technician cannot accept this handover for you (§10).</p>
      {canAccept && <form className="grid gap-3 max-w-md" onSubmit={event => { event.preventDefault(); void acceptIncoming(event.currentTarget as HTMLFormElement); }}>
        <label className="text-sm">Your current password<input className={field} name="password" type="password" autoComplete="current-password" required maxLength={256}/></label>
        <button disabled={busy} className="w-fit rounded-lg bg-green-700 p-2 text-white">{busy ? "Working…" : "Accept and start my shift"}</button>
      </form>}
      {!canAccept && <p className="text-sm text-neutral-600">Acceptance is available only to a reserved incoming technician on an active reservation.</p>}
    </section>}

    {!isOutgoing && !isIncoming && <div className="rounded-xl border p-4 text-sm">You are not a participant in this reserved pair. This report is read-only for you.</div>}
    {isIncoming && aggregate.lifecycleStatus === "collecting_confirmations" && <div className="rounded-xl border p-4 text-sm">You are an incoming technician for this reserved pair. Your report view is read-only until the outgoing pair commits the handover. You can confirm this handover for yourself in the &ldquo;Your confirmation&rdquo; section once the report is frozen; accepting and activating the incoming shift becomes available only after the commit.</div>}


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
