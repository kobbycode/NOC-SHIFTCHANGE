"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { EqualHandoverReportState } from "@/lib/operations/equal-handover-report-firestore";
import type { EqualHandoverReportV2Content } from "@/types/handover-report-v2";
import { reportAttendanceLabels, reportNoticeCategory } from "@/lib/operations/handover-report-attendance-view";
import { PasswordInput } from "@/components/ui/password-input";

import { IncomingAcceptanceAtomicPanel } from "./incoming-acceptance-atomic";
import {
  HandoverSessionNotice,
  IncomingIdentityPicker,
  type ConsoleIncomingIdentity,
  type HandoverSessionOutcome,
} from "./handover-console-session";
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

export function EqualHandoverWorkflowV2({ uid, initialState, atomicAcceptanceEnabled }: { uid: string; initialState: EqualHandoverReportState; atomicAcceptanceEnabled: boolean }) {
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
  // The last page of the A–E form is a shared console: whoever is signed in may
  // hand it to one of the TWO reserved incoming identities, and only those two
  // are ever offered. An incoming technician starts on their own identity; an
  // outgoing console must name the person accepting before anything is read.
  const [acceptingUid, setAcceptingUid] = useState(() => (isIncoming ? uid : ""));
  // Identity-scoped local receipts: a committed acceptance stays closed for that
  // person even when its status can no longer be re-read from this console.
  const [acceptedUids, setAcceptedUids] = useState<string[]>([]);
  const [acceptedSession, setAcceptedSession] = useState<{ session: HandoverSessionOutcome; label: string } | null>(null);
  const incomingIdentities: ConsoleIncomingIdentity[] = aggregate.identity.incomingTechnicianIds.map((id, index) => {
    const participant = content.participants.find((item) => item.uid === id && item.side === "incoming");
    return { uid: id, label: `${participant?.name ?? "Unnamed technician"} (incoming technician ${index === 0 ? "A" : "B"})` };
  });
  const declaredLateReasons: Record<string, string> = Object.fromEntries(
    aggregate.absences
      .filter((item) => item.absenceType === "not_yet_in" && aggregate.identity.incomingTechnicianIds.includes(item.technicianUid))
      .map((item) => [item.technicianUid, item.reason]),
  );
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

  // Read-only refresh of the authoritative report state, shared with the
  // atomic acceptance panel so its success/failure display always reflects
  // persisted evidence rather than an optimistic local guess.
  const refreshReport = async () => {
    const refreshed = await fetch(`${base}/report`, { headers: { Accept: "application/json" } });
    const refreshResult = await refreshed.json();
    if (refreshed.ok && refreshResult.success) setState(refreshResult.report);
    router.refresh();
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

  // §4 — confirming is a personal act: the participant submits their OWN
  // current password, verified server-side outside any transaction. For an
  // outgoing participant that verified password also finalizes their personal
  // confirmation attendance evidence. The password lives only in the transient
  // form field, is never logged, and is cleared as soon as the request settles.
  const confirmSelf = async (form: HTMLFormElement) => {
    const password = String(new FormData(form).get("password") ?? "");
    if (!password) { setError("Your password is required to confirm this handover."); return; }
    try {
      await run("/confirmation", "POST", {
        expectedRevision: aggregate.revision,
        expectedSnapshotHash: state.snapshotHash,
        password,
      }, "Your personal confirmation has been recorded.");
    } finally {
      form.reset();
    }
  };

  // The two-stage lifecycle (§1 addendum) replaces M07's atomic transfer. The
  // outgoing commit closes the reviewed handover into `awaiting_incoming_acceptance`
  // without creating any shift, membership or attendance; the incoming
  // acceptance is what activates the reserved shift with the technician's own
  // password. Closing the handover is an outgoing action taken as that person,
  // so the committing technician submits their OWN current password too. The
  // button enable state below is only a display convenience — the server
  // re-derives every authority and prerequisite inside its own transaction
  // (§10), so a client-forged flag cannot bypass either step.
  const reviewedBinding = () => ({
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: state.snapshotHash,
    expectedGuardRevision: guard?.guardRevision ?? 0,
    expectedFencingEpoch: guard?.fencingEpoch ?? 0,
  });

  const commitOutgoing = async (form: HTMLFormElement) => {
    if (lock.current || !guard) return;
    const password = String(new FormData(form).get("password") ?? "");
    if (!password) { setError("Your password is required to commit this handover."); return; }
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${base}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...reviewedBinding(), password }),
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
      form.reset();
      lock.current = false; setBusy(false);
    }
  };

  // §4 — the accept console submits the SELECTED incoming technician's OWN
  // current password, verified server-side outside any transaction, and always
  // names that technician: accepting signs them in on this shared console.
  const acceptIncoming = async (form: HTMLFormElement) => {
    if (lock.current || !guard) return;
    if (!acceptingUid) { setError("Select the incoming technician who is accepting at this console."); return; }
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    if (!password) { setError("Your password is required to accept this handover."); return; }
    const submittingUid = acceptingUid;
    const label = incomingIdentities.find((identity) => identity.uid === submittingUid)?.label ?? "selected incoming technician";
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${base}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...reviewedBinding(), technicianUid: submittingUid, password }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "The v2 handover acceptance failed.");
      // §12 — the notice NEVER claims an activated shift until the server has
      // confirmed the committed operation; the status below is the authoritative
      // outcome returned by the accept route.
      if (result.status === "ACTIVATED") {
        setNotice(`Handover accepted. The incoming shift is now active from ${accra(result.receipt?.activatedAt ?? null)}.`);
      } else if (result.status === "JOINED") {
        setNotice("Joined the active incoming shift. Attendance is recorded independently at the acceptance clock.");
      } else if (result.status === "ALREADY_JOINED") {
        setNotice("This acceptance is already recorded — no duplicate shift or attendance was created.");
      } else {
        setNotice("Handover acceptance succeeded.");
      }
      setAcceptedUids((current) => current.includes(submittingUid) ? current : [...current, submittingUid]);
      if (result.session) setAcceptedSession({ session: result.session as HandoverSessionOutcome, label });
      // The acceptance may have replaced this console session. Re-reading the
      // report through a session that was just revoked would only fail.
      if (result.session?.issued === false) return;
      const refreshed = await fetch(`${base}/report`, { headers: { Accept: "application/json" } });
      const refreshResult = await refreshed.json();
      if (refreshed.ok && refreshResult.success) setState(refreshResult.report);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The v2 handover acceptance failed.");
    } finally {
      // The credential never outlives the request.
      const passwordInput = form.elements.namedItem("password");
      if (passwordInput instanceof HTMLInputElement) passwordInput.value = "";
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
  // The acceptance console is available to ANY participant of the reserved pair,
  // because it is a shared console: an outgoing technician hands it over by
  // letting one of the two reserved incoming identities accept here.
  const isConsoleParticipant = isOutgoing || isIncoming;
  const canAccept = isConsoleParticipant && guard !== null && acceptingUid !== "" &&
    !acceptedUids.includes(acceptingUid) && (isAwaitingAcceptance || isCompleted);

  const pendingParticipants = POSITION_LABELS.filter(
    ({ position }) => participantState(position) === "awaiting_confirmation",
  );
  const collecting = aggregate.lifecycleStatus === "collecting_confirmations";
  let nextStep = "Review the handover evidence below.";
  let action: { label: string; target: string } | undefined;

  if (isCompleted) {
    nextStep = "The incoming shift has been activated.";
    if (isIncoming && guard) {
      nextStep += " Check your acceptance status below.";
      action = { label: "View acceptance", target: "handover-acceptance" };
    }
  } else if (isAwaitingAcceptance) {
    nextStep = "Waiting for a reserved incoming technician to accept and activate the next shift.";
    if (isConsoleParticipant && guard) {
      action = { label: "Go to acceptance", target: "handover-acceptance" };
    }
  } else if (collecting) {
    if (!aggregate.reportBinding || preparationDrifted) {
      nextStep = preparationDrifted
        ? "The evidence changed. The outgoing team needs to review and freeze an updated report."
        : "The outgoing team needs to freeze the report before participants can confirm.";
      if (isOutgoing) {
        action = { label: "Go to report preparation", target: "handover-preparation" };
      }
    } else if (canConfirm) {
      nextStep = "Review the frozen report and record your own confirmation.";
      action = { label: "Go to your confirmation", target: "handover-confirmation" };
    } else if (canCommit) {
      nextStep = "The handover is ready for you to commit for incoming acceptance.";
      action = { label: "Go to commit", target: "handover-commit" };
    } else if (pendingParticipants.length > 0) {
      nextStep = "Waiting for participant confirmations or supported absences.";
    } else if (!readiness.ready || blockers.length > 0 || !guard) {
      nextStep = "The outgoing team needs to resolve the remaining readiness checks.";
    } else {
      nextStep = "Waiting for a confirmed outgoing technician to commit the handover.";
    }
  }

  return <div className="space-y-6">
    <header className="space-y-1">
      <h1 className="text-2xl font-bold">Equal-technician handover report (v2)</h1>
      <p className="text-sm">Status: {aggregate.lifecycleStatus.replaceAll("_", " ")} · Revision {aggregate.revision} · Guard {guard ? "active" : "unavailable"}</p>
      <p className="text-sm">Scheduled {accra(aggregate.reservation.scheduledStart)} – {accra(aggregate.reservation.scheduledEnd)} (Africa/Accra)</p>
    </header>

    <section aria-labelledby="handover-next-step" className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
      <h2 id="handover-next-step" className="font-semibold">Next step</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">{nextStep}</p>
      {collecting && pendingParticipants.length > 0 && (
        <p className="mt-2 text-sm">
          <span className="font-medium">Awaiting confirmation: </span>
          {pendingParticipants.map(({ label, position }) => position === myPosition ? `${label} (you)` : label).join(", ")}
        </p>
      )}
      {action && (
        <a href={`#${action.target}`} className="btn-accent mt-3 inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold">
          {action.label}
        </a>
      )}
    </section>

    {isCompleted && <section aria-label="Handover activated" className="rounded-xl border border-green-600 p-4 text-sm space-y-1">
      <h2 className="font-semibold text-green-800">Handover activated</h2>
      <p>This equal-technician handover is complete. The outgoing shift is closed and the incoming shift was activated by the first reserved incoming technician&rsquo;s password acceptance. Every subsequent incoming acceptance joins the same active shift with its own independent attendance clock.</p>
      <p>Frozen report {frozenReport ? `version ${frozenReport.version}` : "unavailable"} · guard {guard ? "active" : "unavailable"}. This record is immutable; further acceptance attempts replay this result.</p>
    </section>}

    {isAwaitingAcceptance && <section aria-label="Awaiting incoming acceptance" className="rounded-xl border border-amber-500 p-4 text-sm space-y-1">
      <h2 className="font-semibold text-amber-800">Awaiting incoming acceptance</h2>
      <p>The outgoing pair has committed this handover. The reserved incoming shift has NOT been created yet — an incoming technician must now accept with their OWN current password, and that first authorized acceptance is what activates the shift exactly once.</p>
      <p>The outgoing shift remains handover_pending and continues to own the operational slot until acceptance; no shift, membership or attendance is fabricated while acceptance is pending.</p>
    </section>}

    <section aria-label="Handover readiness" className={`rounded-xl border p-4 text-sm ${readiness.ready ? "border-green-600" : "border-neutral-500"}`}>
      <h2 className="font-semibold">Readiness: {readiness.ready ? "all confirmations and permitted exceptions satisfied" : "not ready"}</h2>
      <p className="mt-1">Confirmed {readiness.confirmedCount} of {readiness.requiredConfirmations} · absences {readiness.absenceCount} of {readiness.supportedAbsences} supported · report {readiness.boundReportId ? `v${readiness.boundReportVersion} (newest v${readiness.newestReportVersion})` : "not frozen"}.</p>
      {!readiness.ready && <ul className="mt-2 space-y-0.5 text-red-700">{readiness.reasons.map((reason) => <li key={reason}>• {reason.replaceAll("_", " ")}</li>)}</ul>}
      <p className="mt-2 italic">Readiness is derived from authoritative evidence and is not a completed handover or a transfer authorization.</p>
    </section>

    {myPosition && !isCompleted && !isAwaitingAcceptance && <section id="handover-confirmation" className="scroll-mt-24 rounded-xl border p-5 space-y-2 text-sm">
      <h2 className="text-lg font-semibold">Your confirmation</h2>
      <p>Position: {POSITION_LABELS.find((item) => item.position === myPosition)?.label} · state: {participantState(myPosition).replaceAll("_", " ")}.</p>
      {myConfirmation && <p>You personally confirmed at {accra(myConfirmation.confirmedAt)} against the frozen report version bound to your confirmation.</p>}
      {myAbsence && <p>A colleague recorded you as {myAbsence.absenceType.replaceAll("_", " ")}; an absence is not a personal confirmation.</p>}
      {canConfirm && <form className="grid gap-3 max-w-md" onSubmit={event => { event.preventDefault(); void confirmSelf(event.currentTarget as HTMLFormElement); }}>
        <p className="text-sm text-neutral-600">Confirming is a personal act: it requires <strong>your own current password</strong>, verified server-side before any write and never stored, logged or included in a receipt (§4). A colleague or a supervisor cannot confirm for you.</p>
        <label className="text-sm">Your current password<PasswordInput className={field} name="password" autoComplete="current-password" required maxLength={256}/></label>
        <button disabled={busy} className="btn-accent w-fit rounded-lg p-2">{busy ? "Working…" : "Confirm this handover for myself"}</button>
      </form>}
      {aggregate.reportBinding === null && <p>Confirmation is available only after the consolidated report is frozen.</p>}
    </section>}

    <section aria-label="Participant confirmations" className="rounded-xl border p-5 space-y-2 text-sm overflow-x-auto">
      <h2 className="text-lg font-semibold">Participant confirmations</h2>
      <table className="w-full text-left">
        <thead><tr><th>Participant</th><th>Side</th><th>Technician</th><th>State</th><th>Report binding</th></tr></thead>
        <tbody>{POSITION_LABELS.map((item) => {
          const confirmation = aggregate.confirmations.find((c) => c.position === item.position);
          const positionAbsence = aggregate.absences.find((a) => a.position === item.position);
          const uidFor = item.side === "outgoing" ? aggregate.identity.outgoingTechnicianIds : aggregate.identity.incomingTechnicianIds;
          const technicianUid = (item.position === "outgoing_tech_a" || item.position === "incoming_tech_a") ? uidFor[0] : uidFor[1];
          const technician = content.participants.find((participant) => participant.uid === technicianUid)?.name ?? "Unnamed technician";
          return <tr key={item.position}>
            <td>{item.label}</td>
            <td>{item.side}</td>
            <td>{technicianUid === uid ? `${technician} (you)` : technician}</td>
            <td>{participantState(item.position).replaceAll("_", " ")}</td>
            <td>{confirmation ? "bound" : positionAbsence ? positionAbsence.absenceType.replaceAll("_", " ") : "—"}</td>
          </tr>;
        })}</tbody>
      </table>
    </section>

    {frozenReport && <div className="rounded-xl border p-4 text-sm">Frozen report version {frozenReport.version}{frozenReport.supersedesReportId ? " (supersedes an earlier version)" : ""} frozen by {content.participants.find((participant) => participant.uid === frozenReport.frozenBy)?.name ?? "an unavailable profile"} at {accra(frozenReport.frozenAt)}.</div>}
    {preparationDrifted && <div className="rounded-xl border border-amber-500 p-4 text-sm">The authoritative sources changed since the last preparation. Re-prepare and review the consolidated report before freezing.</div>}
    {!preparation && !preparationDrifted && !frozenReport && <div className="rounded-xl border p-4 text-sm">No preparation exists yet. Prepare the consolidated report to begin the review.</div>}
    {notice && <p className="text-sm text-green-700">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

    {isOutgoing && !isCompleted && !isAwaitingAcceptance && <section id="handover-preparation" className="scroll-mt-24 space-y-3 rounded-xl border p-5">
      <h2 className="text-lg font-semibold">Outgoing technician actions</h2>
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void prepare(event.currentTarget as HTMLFormElement); }}>
        <label className="text-sm">Optional preparation note<input className={field} name="reason" maxLength={2000} placeholder="Why this revision is being prepared"/></label>
        <button disabled={busy || aggregate.lifecycleStatus !== "collecting_confirmations"} className="btn-accent w-fit rounded-lg p-2">{busy ? "Working…" : preparationDrifted || !preparation ? "Prepare consolidated report" : "Re-prepare identical report"}</button>
      </form>
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void declareAbsence(event.currentTarget as HTMLFormElement); }}>
        <label className="text-sm">Absent colleague (declared by a colleague, never self)<select className={field} name="subject" required>
          <option value="">Select participant</option>
          {content.participants.filter(item => item.uid !== uid).map(item => <option key={item.uid} value={item.uid}>{item.name ?? "Unnamed technician"} ({item.side})</option>)}
        </select></label>
        <label className="text-sm">Reason<input className={field} name="reason" required maxLength={1000}/></label>
        <label className="text-sm">Reported departure time (outgoing absences only)<input className={field} name="departure" type="datetime-local"/></label>
        <button disabled={busy} className="btn-accent w-fit rounded-lg p-2">Declare absence</button>
      </form>
      {absence && <div className="text-sm">Declared: {absence.absenceType.replaceAll("_", " ")} · {content.participants.find((participant) => participant.uid === absence.technicianUid)?.name ?? "Unnamed technician"}
        <button disabled={busy} className="ml-3 rounded-lg border p-2" onClick={() => void clearAbsence(absence.technicianUid)}>Clear declaration</button>
      </div>}
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void freeze(event.currentTarget as HTMLFormElement); }}>
        <label className="text-sm">Freeze reason<input className={field} name="reason" required maxLength={1000}/></label>
        {frozenReport && <label className="text-sm">Correction note (required for a later version)<input className={field} name="correctionNote" required maxLength={4000}/></label>}
        <button disabled={busy || !preparation || preparationDrifted || !guard || aggregate.lifecycleStatus !== "collecting_confirmations"} className="btn-accent w-fit rounded-lg p-2">Review complete — freeze report</button>
      </form>
      <p className="text-sm">Confirm the handover for yourself using the &ldquo;Your confirmation&rdquo; section above.</p>
    </section>}

    {isOutgoing && !isCompleted && !isAwaitingAcceptance && <section id="handover-commit" aria-label="Commit for incoming acceptance" className="scroll-mt-24 space-y-3 rounded-xl border p-5">
      <h2 className="text-lg font-semibold">Commit for incoming acceptance</h2>
      <ul className="space-y-1 text-sm">
        <li>{aggregate.reportBinding !== null ? "• Consolidated report frozen" : "• Consolidated report not frozen yet"}</li>
        <li>{myConfirmation ? "• You have personally confirmed this handover" : "• You must personally confirm this handover first"}</li>
        <li>{`• Confirmations: ${readiness.confirmedCount}/${readiness.requiredConfirmations} · supported absences: ${readiness.absenceCount}/${readiness.supportedAbsences}`}</li>
        <li>{blockers.length === 0 ? "• No report completeness blockers" : `• ${blockers.length} blocker(s) must be resolved`}</li>
        <li>{preparationDrifted ? "• Sources changed since review — re-prepare and freeze" : "• Review is current"}</li>
      </ul>
      {!isConfirmedOutgoing && <p className="text-sm">Only an outgoing technician who has personally confirmed (not declared absent) can commit this handover for incoming acceptance.</p>}
      <form className="grid gap-3 max-w-md" onSubmit={event => { event.preventDefault(); void commitOutgoing(event.currentTarget as HTMLFormElement); }}>
        <label className="text-sm">Your current password<PasswordInput className={field} name="password" autoComplete="current-password" required maxLength={256}/></label>
        <button
          disabled={!canCommit || busy}
          className="btn-accent w-fit rounded-lg p-2"
        >{busy ? "Working…" : "Commit handover — await incoming acceptance"}</button>
      </form>
      {!canCommit && !busy && <p className="text-sm text-neutral-600">Committing is available only when every prerequisite above is satisfied.</p>}
      <p className="text-sm text-neutral-600">Committing closes the handover as <em>you</em>, so it requires your own current password; the password is verified server-side before any write and is never stored, logged or included in the commitment receipt. This display gate is not an authorization: the server re-derives your authority, the reviewed evidence, readiness and completeness inside its own transaction and can still reject the request even when this button is enabled. Committing does NOT create the incoming shift — that only happens on a reserved incoming technician&rsquo;s own password acceptance.</p>
      {!isConfirmedOutgoing && !myConfirmation && !myAbsence && myPosition && <p className="text-sm">You have not confirmed yet — use the confirmation section above.</p>}
    </section>}

    {isConsoleParticipant && (isAwaitingAcceptance || isCompleted) && <div id="handover-acceptance" className="scroll-mt-24">{atomicAcceptanceEnabled
      ? <IncomingAcceptanceAtomicPanel
          base={base}
          consoleUid={uid}
          incomingIdentities={incomingIdentities}
          declaredLateReasons={declaredLateReasons}
          scheduledStart={aggregate.reservation.scheduledStart}
          lifecycleSignature={`${aggregate.lifecycleStatus}:${aggregate.revision}:${state.snapshotHash}`}
          onAuthoritativeChange={refreshReport}
        />
      : <section aria-label="Accept handover" className="space-y-3 rounded-xl border border-green-600 p-5">
        <h2 className="text-lg font-semibold">Accept handover with a password</h2>
        <p className="text-sm">
          {isAwaitingAcceptance
            ? <>This is the shared console. The selected reserved incoming technician accepts with <strong>their own current password</strong>; that acceptance activates the reserved incoming shift exactly once and records <em>their</em> attendance at the authoritative acceptance clock. Their partner joins the same active shift when they accept later.</>
            : <>The incoming shift is already active. Accepting joins that same shift with an independent attendance time; the first technician&rsquo;s clock is never overwritten and no new shift is created.</>}
        </p>
        <p className="text-sm text-neutral-600">The password is verified server-side before any write and is never stored, logged, or included in the audit receipt (§4). A supervisor or an outgoing technician cannot accept this handover for the incoming technician (§10). The accepting technician is signed in on this console by their acceptance.</p>
        <IncomingIdentityPicker
          identities={incomingIdentities}
          value={acceptingUid}
          disabled={busy}
          onChange={(identityUid) => { setAcceptingUid(identityUid); setError(""); setNotice(""); }}
        />
        {canAccept && <form className="grid gap-3 max-w-md" onSubmit={event => { event.preventDefault(); void acceptIncoming(event.currentTarget as HTMLFormElement); }}>
          <label className="text-sm">{incomingIdentities.find((identity) => identity.uid === acceptingUid)?.label ?? "Select an incoming technician"}&rsquo;s own current password<PasswordInput className={field} name="password" autoComplete="current-password" required maxLength={256}/></label>
          <button disabled={busy} className="btn-accent w-fit rounded-lg p-2">{busy ? "Working…" : "Accept and start my shift"}</button>
        </form>}
        {acceptedUids.includes(acceptingUid) && <p className="text-sm text-green-700">This acceptance was recorded from this console. A further attempt for the same technician would replay it.</p>}
        {!canAccept && !acceptedUids.includes(acceptingUid) && <p className="text-sm text-neutral-600">Acceptance is available only for a reserved incoming technician of this pair on an active reservation.</p>}
        {acceptedSession && <HandoverSessionNotice session={acceptedSession.session} label={acceptedSession.label} />}
      </section>}</div>}

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
        <p><strong>Successor slot generation:</strong> {content.slotLineage.successorGeneration}</p>
      </div>

      <div className="rounded-xl border p-5 space-y-2 text-sm overflow-x-auto">
        <h3 className="font-semibold">Attendance and absences</h3>
        <table className="w-full text-left text-sm">
          <thead><tr><th>Participant</th><th>Side</th><th>Reporting</th><th>Clock-in</th><th>Clock-out</th><th>Clock evidence</th><th>Departure</th><th>Worked hours</th><th>Payable</th><th>Absence</th><th>Evidence</th></tr></thead>
          <tbody>{content.attendance.map(row => { const labels = reportAttendanceLabels(row, content.outgoingShiftId); return <tr key={row.position}>
            <td>{row.name ?? "Unnamed technician"}</td><td>{row.side}</td><td>{labels.reporting}</td><td>{row.clockIn === null ? labels.clocks === "Not yet due" ? "Not yet due" : "Unknown" : accra(row.clockIn)}</td><td>{row.clockOut === null ? labels.clocks === "Not yet due" ? "Not yet due" : "Unknown" : accra(row.clockOut)}</td><td>{labels.clocks}</td>
            <td>{row.departureProvenance ?? "—"}</td><td>{labels.hours}</td>
            <td>{row.payableHours}</td><td>{row.absenceDeclared?.replaceAll("_", " ") ?? "—"}</td>
            <td>{row.reportingEvidence ? `${row.reportingEvidence.kind} · ${row.reportingEvidence.personallyAuthenticated ? "personal" : row.reportingEvidence.attestedByUid ? `attested by ${content.participants.find((participant) => participant.uid === row.reportingEvidence?.attestedByUid)?.name ?? "an unavailable profile"}` : "reporting record only"} · ${accra(row.reportingEvidence.eventTime)}` : row.legacyAttendance ? "legacy record (see reporting status)" : "No evidence recorded"}</td>
          </tr>; })}</tbody>
        </table>
        <p>Reporting confirmation does not establish personal clock-in, clock-out or worked hours. Unknown clocks and hours remain unknown.</p>
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
        <ul>{content.terminalTaskEvidence.map(task => <li key={task.id}>{task.title} · {task.status} · closed {accra(task.updatedAt)}</li>)}</ul>
        <p>Work snapshot {content.workSnapshot.version}</p>
      </div>

      <div className="rounded-xl border p-5 space-y-2 text-sm">
        <h3 className="font-semibold">Completeness</h3>
        <p className="font-semibold text-red-700">Blockers ({content.completeness.blockers.length})</p>
        <ul>{content.completeness.blockers.map(item => <li key={item}>• {item}</li>)}</ul>
        <p className="pt-2 font-semibold">Evidence notices ({content.completeness.warnings.length})</p>
        {["Evidence required", "Not yet due", "Information", "Historical / unclassified"].map(category => {
          const notices = content.completeness.warnings.filter(item => reportNoticeCategory(item) === category);
          return notices.length > 0 && <div key={category}><p className="font-medium">{category} ({notices.length})</p><ul>{notices.map(item => <li key={item}>• {item}</li>)}</ul></div>;
        })}
      </div>

      {content.corrections.length > 0 && <div className="rounded-xl border p-5 space-y-1 text-sm"><h3 className="font-semibold">Report corrections</h3>
        <ul>{content.corrections.map(item => <li key={item.id}>{accra(item.recordedAt)} · {content.participants.find((participant) => participant.uid === item.recordedBy)?.name ?? "recorded by an unavailable profile"}: {item.note}</li>)}</ul></div>}

      {preparation && <div className="rounded-xl border p-5 space-y-1 text-sm">
        <h3 className="font-semibold">Preparation revision {preparation.preparationRevision}</h3>
        <p>Work snapshot {preparation.workSnapshotVersion}</p>
        <p>Reviewed against reservation revision {preparation.aggregateRevision}</p>
        <p>First prepared {accra(preparation.createdAt)} · last updated {accra(preparation.updatedAt)}</p>
        <details><summary className="cursor-pointer">Revision history ({preparation.revisionHistory.length})</summary>
          <ul>{preparation.revisionHistory.map(entry => <li key={entry.preparationRevision}>Revision {entry.preparationRevision} · {accra(entry.preparedAt)} · {content.participants.find((participant) => participant.uid === entry.preparedBy)?.name ?? "an unavailable profile"}{entry.reason ? ` · ${entry.reason}` : ""}</li>)}</ul>
        </details>
      </div>}

      {frozenReport && <div className="rounded-xl border p-5 space-y-1 text-sm">
        <h3 className="font-semibold">Freeze binding</h3>
        <p>Preparation revision {frozenReport.preparationRevision} · aggregate revision {frozenReport.aggregateRevision}</p>
        <p>Frozen by {content.participants.find((participant) => participant.uid === frozenReport.frozenBy)?.name ?? "an unavailable profile"} at {accra(frozenReport.frozenAt)}</p>
        <p>Reason: {frozenReport.reason}{frozenReport.correctionNote ? ` · Correction: ${frozenReport.correctionNote}` : ""}</p>
      </div>}
    </section>
  </div>;
}
