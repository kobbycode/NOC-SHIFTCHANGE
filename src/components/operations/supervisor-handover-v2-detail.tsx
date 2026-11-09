// TECH-HO-RECOVERY-09K — read-only supervisor view of one v2 equal-technician
// handover. It renders authoritative evidence already derived by
// readEqualHandoverReportState and exposes no attendance, acceptance or
// impersonation affordance. Attendance/acceptance are read from persisted
// evidence, never inferred from pair membership, schedule, notification state or
// a confirmation. The embedded recovery panel is a separate, server-authorized
// approval surface: it can only sign an intent, never alter evidence.
import Link from "next/link";
import type { SupervisorV2HandoverDetailView } from "@/lib/operations/supervisor-handover-v2";
import { EQUAL_HANDOVER_POSITIONS, EQUAL_HANDOVER_SIDES } from "@/types/equal-technician-handover";
import { ATTENDANCE_EVIDENCE_KINDS } from "@/types/attendance-evidence";
import { SupervisorGuardClosure } from "./supervisor-guard-closure";
import { HandoverRecoveryPanel } from "./handover-recovery-panel";

const POSITION_LABELS: Record<string, string> = {
  [EQUAL_HANDOVER_POSITIONS.OUTGOING_TECH_A]: "Outgoing technician A",
  [EQUAL_HANDOVER_POSITIONS.OUTGOING_TECH_B]: "Outgoing technician B",
  [EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_A]: "Incoming technician A",
  [EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_B]: "Incoming technician B",
};

function stamp(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("en-GB", { timeZone: "Africa/Accra" }) : "—";
}

// Authorship is shown by name. A uid the roster cannot resolve is reported as
// unattributed rather than printed raw.
function contributorName(
  participants: { uid: string; name: string | null }[],
  uid: string | null | undefined,
): string | null {
  if (!uid) return null;
  return participants.find((item) => item.uid === uid)?.name ?? null;
}

// A single participant's confirmation resolution, strictly from the aggregate.
function confirmationState(
  view: SupervisorV2HandoverDetailView,
  position: string,
): { label: string; detail: string } {
  const confirmation = view.state.aggregate.confirmations.find((item) => item.position === position);
  if (confirmation) {
    return {
      label: "Confirmed",
      detail: `Personally confirmed ${stamp(confirmation.confirmedAt)}.`,
    };
  }
  const absence = view.state.aggregate.absences.find((item) => item.position === position);
  if (absence) {
    return {
      label: "Absent with documented attestation",
      detail: `${absence.absenceType.replaceAll("_", " ")} · reason: ${absence.reason} · attested by ${contributorName(view.state.live.content.participants, absence.recordedBy) ?? "an unavailable profile"}${absence.reportedDepartureTime ? ` · reported departure ${stamp(absence.reportedDepartureTime)}` : ""}. An absence is not a personal confirmation.`,
    };
  }
  return { label: "Not confirmed", detail: "Awaiting this technician's own confirmation." };
}

// Incoming acceptance comes only from the persisted attendance-evidence-v2
// records read for this handover — never from a confirmation, the pair roster,
// the schedule or the successor shift status. When no evidence exists the state
// is reported accurately as not yet recorded rather than inferred.
function acceptanceState(
  view: SupervisorV2HandoverDetailView,
  position: string,
): { label: string; detail: string } {
  const lifecycle = view.state.aggregate.lifecycleStatus;
  if (lifecycle === "collecting_confirmations") {
    return { label: "Not applicable", detail: "Acceptance opens only after the outgoing pair commits the handover." };
  }
  const acceptance = view.incomingAcceptance.find((item) => item.position === position);
  if (acceptance && acceptance.acceptedAt) {
    const late = acceptance.lateReason ? ` · late participation: ${acceptance.lateReason}` : "";
    return {
      label: acceptance.kind === ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE ? "Accepted (late)" : "Accepted",
      detail: `Accepted ${stamp(acceptance.acceptedAt)} via ${acceptance.authenticationMethod ?? "personal password"}${acceptance.personallyAuthenticated ? " (personal password)" : ""}${late}.`,
    };
  }
  return { label: "Awaiting action", detail: "The incoming shift is active; this technician has not yet recorded their own acceptance evidence." };
}

export function SupervisorHandoverV2Detail({ view, atomicAcceptanceEnabled, recovery }: { view: SupervisorV2HandoverDetailView; atomicAcceptanceEnabled: boolean; recovery: { handoverDocumentId: string; actorUid: string } }) {
  const state = view.state;
  const { aggregate, readiness, live, frozenReport, preparation, preparationDrifted, guard } = state;
  const content = live.content;
  const isCompleted = aggregate.lifecycleStatus === "completed";
  const isAwaitingAcceptance = aggregate.lifecycleStatus === "awaiting_incoming_acceptance";

  const participantsBySide = (side: string) => content.participants.filter((item) => item.side === side);
  const lateAcceptances = view.incomingAcceptance.filter((item) => item.lateReason);

  // Exceptional closure is offered only when the persisted evidence shows
  // exactly one accepted incoming technician, the other reserved technician has
  // no acceptance record, that technician holds an authoritative `not_yet_in`
  // absence, and the guard is still active. The server re-derives all of this.
  const incomingIds = aggregate.identity.incomingTechnicianIds;
  const acceptedUids = new Set(view.incomingAcceptance.map((item) => item.uid));
  const missingIncomingUids = incomingIds.filter((uid) => !acceptedUids.has(uid));
  const guardActive = guard !== null && guard.ownerLifecycleState === "active";
  const closureSubjectUid =
    guardActive && isCompleted && acceptedUids.size === 1 && missingIncomingUids.length === 1
      ? missingIncomingUids[0]
      : null;
  const closureAbsence = closureSubjectUid === null
    ? undefined
    : aggregate.absences.find((item) => item.technicianUid === closureSubjectUid && item.absenceType === "not_yet_in");
  const closureSubjectName = closureSubjectUid === null
    ? null
    : content.participants.find((item) => item.uid === closureSubjectUid)?.name ?? null;

  return <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
    <header className="space-y-1">
      <Link href="/supervisor/handovers/v2" className="text-sm text-blue-700 underline">← All v2 handovers</Link>
      <h1 className="text-2xl font-bold">Supervisor view · Equal-technician handover (v2)</h1>
      <p className="text-sm text-neutral-600">The handover evidence is read-only here. Supervisors never accept a handover, declare attendance or clock anyone in; the recovery panel below can only add a recovery approval signature.</p>
      <p className="text-sm">Status: <strong>{aggregate.lifecycleStatus.replaceAll("_", " ")}</strong></p>
      <p className="text-sm">Scheduled {stamp(aggregate.identity.scheduledStart)}–{stamp(aggregate.identity.scheduledEnd)} (Africa/Accra) · Handover initiated {stamp(content.staff.handoverStartedAt)}</p>
    </header>

    {(isCompleted || isAwaitingAcceptance) && <section aria-label="Lifecycle notice" className={`rounded-xl border p-4 text-sm ${isCompleted ? "border-green-600" : "border-amber-500"}`}>
      {isCompleted
        ? <p>Completed. The outgoing shift is closed and the incoming shift was activated by the first reserved incoming technician&rsquo;s own password acceptance; later acceptances join the same active shift with independent attendance. This record is immutable.</p>
        : <p>Committed for incoming acceptance. The reserved incoming shift has not been created — the first incoming technician must accept with their own password; nothing is fabricated while acceptance is pending.</p>}
    </section>}

    <HandoverRecoveryPanel
      handoverDocumentId={recovery.handoverDocumentId}
      actorUid={recovery.actorUid}
      actorRole="supervisor"
    />

    <section aria-label="Readiness" className={`rounded-xl border p-4 text-sm ${readiness.ready ? "border-green-600" : "border-neutral-500"}`}>
      <h2 className="font-semibold">Readiness: {readiness.ready ? "all confirmations and permitted exceptions satisfied" : "not ready"}</h2>
      <p className="mt-1">Confirmed {readiness.confirmedCount} of {readiness.requiredConfirmations} · absences {readiness.absenceCount} of {readiness.supportedAbsences} supported · report {readiness.boundReportId ? `v${readiness.boundReportVersion} (newest v${readiness.newestReportVersion})` : "not frozen"}.</p>
      {readiness.reasons.length > 0 && <ul className="mt-2 space-y-0.5 text-red-700">{readiness.reasons.map((reason) => <li key={reason}>• {reason.replaceAll("_", " ")}</li>)}</ul>}
      <p className="mt-2 italic">Derived from authoritative evidence; not a completed handover and never a transfer authorization.</p>
    </section>

    <section aria-label="Outgoing team" className="rounded-xl border p-5 text-sm space-y-2">
      <h2 className="text-lg font-semibold">Outgoing team</h2>
      {participantsBySide(EQUAL_HANDOVER_SIDES.OUTGOING).map((item) => {
        const confirmation = confirmationState(view, item.position);
        return <div key={item.uid} className="flex flex-wrap items-baseline justify-between gap-2 border-b py-1 last:border-0">
          <span className="font-medium">{item.name ?? "Unnamed technician"} <span className="text-neutral-500">({POSITION_LABELS[item.position]})</span></span>
          <span className="text-neutral-700">{confirmation.label}</span>
          <span className="w-full text-neutral-500">{confirmation.detail}</span>
        </div>;
      })}
    </section>

    <section aria-label="Incoming team" className="rounded-xl border p-5 text-sm space-y-2">
      <h2 className="text-lg font-semibold">Incoming team</h2>
      {participantsBySide(EQUAL_HANDOVER_SIDES.INCOMING).map((item) => {
        const confirmation = confirmationState(view, item.position);
        const acceptance = acceptanceState(view, item.position);
        return <div key={item.uid} className="border-b py-2 last:border-0">
          <p className="font-medium">{item.name ?? "Unnamed technician"} <span className="text-neutral-500">({POSITION_LABELS[item.position]})</span></p>
          <p>Confirmation: <strong>{confirmation.label}</strong> — {confirmation.detail}</p>
          <p>Acceptance: <strong>{acceptance.label}</strong> — {acceptance.detail}</p>
        </div>;
      })}
    </section>

    <section aria-label="Incoming acceptance evidence" className="rounded-xl border p-5 text-sm space-y-2 overflow-x-auto">
      <h2 className="text-lg font-semibold">Incoming acceptance records</h2>
      {view.incomingAcceptance.length === 0
        ? <p className="text-neutral-600">{isAwaitingAcceptance
          ? "Committed for acceptance — no incoming technician has recorded their own password acceptance yet."
          : "No incoming acceptance evidence is persisted for this handover."}</p>
        : <table className="w-full text-left">
          <thead><tr><th>Participant</th><th>Evidence kind</th><th>Authenticated</th><th>Accepted at</th><th>Late reason</th></tr></thead>
          <tbody>{view.incomingAcceptance.map((item) => <tr key={item.uid}>
            <td>{POSITION_LABELS[item.position] ?? item.position}</td>
            <td>{item.kind?.replaceAll("_", " ") ?? "—"}</td>
            <td>{item.personallyAuthenticated ? "personal password" : item.authenticationMethod ?? "—"}</td>
            <td>{stamp(item.acceptedAt)}</td>
            <td>{item.lateReason ?? "—"}</td>
          </tr>)}</tbody>
        </table>}
      <p className="text-neutral-500 italic">Acceptance comes only from the technician&rsquo;s own persisted evidence; a completed handover&rsquo;s frozen report predates acceptance and is never rewritten to include it.</p>
    </section>

    {atomicAcceptanceEnabled && <section aria-label="Reservation guard closure" className="rounded-xl border p-5 text-sm space-y-2">
      <h2 className="text-lg font-semibold">Reservation guard</h2>
      {guard === null
        ? <p className="text-neutral-600">No reservation guard is readable for this handover.</p>
        : guard.ownerLifecycleState === "completed"
          ? <p>Finalized. The guard is terminal; no further closure is possible.</p>
          : <p>Active. It is never closed automatically after the first acceptance.</p>}
      {guard !== null && guard.ownerLifecycleState === "active" && !isCompleted && <p className="text-neutral-600">The incoming shift has not been activated yet; guard closure requires validated acceptances.</p>}
      {guard !== null && guard.ownerLifecycleState === "active" && isCompleted && closureSubjectUid !== null && closureAbsence !== undefined && <SupervisorGuardClosure
        shiftId={aggregate.identity.outgoingShiftId}
        subjectUid={closureSubjectUid}
        subjectName={closureSubjectName}
        absenceReason={closureAbsence.reason}
      />}
      {guard !== null && guard.ownerLifecycleState === "active" && isCompleted && closureSubjectUid !== null && closureAbsence === undefined && <p className="text-neutral-600">The outstanding incoming technician has no documented &ldquo;not yet in&rdquo; absence, so no exceptional closure can be authorized.</p>}
      {guard !== null && guard.ownerLifecycleState === "active" && isCompleted && closureSubjectUid === null && missingIncomingUids.length === 0 && acceptedUids.size >= 2 && <p>Both reserved incoming technicians hold recorded acceptance evidence. A reserved incoming technician must explicitly finalize the guard from their handover page; a supervisor cannot close it normally.</p>}
      {guard !== null && guard.ownerLifecycleState === "active" && isCompleted && closureSubjectUid === null && missingIncomingUids.length > 1 && <p className="text-neutral-600">No incoming acceptance is recorded yet; there is no closure to authorize.</p>}
      {guard !== null && guard.ownerLifecycleState === "active" && isCompleted && closureSubjectUid === null && missingIncomingUids.length === 1 && <p className="text-neutral-600">Acceptance records are inconsistent for this handover; administrator review is required before any closure.</p>}
      <p className="text-neutral-500 italic">Supervisors never accept a handover, declare attendance or clock anyone in. An exceptional closure creates no acceptance, attendance, membership or clock time for the absent technician.</p>
    </section>}

    <section aria-label="Documented absences" className="rounded-xl border p-5 text-sm space-y-1">
      <h2 className="text-lg font-semibold">Documented absences</h2>
      {aggregate.absences.length === 0
        ? <p className="text-neutral-600">No absence declarations are on record for this handover.</p>
        : aggregate.absences.map((absence) => <p key={absence.position}>• {POSITION_LABELS[absence.position]}: {absence.absenceType.replaceAll("_", " ")} · reason: {absence.reason} · attested by {contributorName(content.participants, absence.recordedBy) ?? "an unavailable profile"}{absence.reportedDepartureTime ? ` · departure ${stamp(absence.reportedDepartureTime)}` : ""}.</p>)}
    </section>

    <section aria-label="Historical evidence" className="rounded-xl border p-5 text-sm space-y-1">
      <h2 className="text-lg font-semibold">Late participation &amp; historical evidence</h2>
      {lateAcceptances.map((item) => <p key={`late-${item.uid}`}>• Late acceptance recorded for {POSITION_LABELS[item.position] ?? item.position}: {item.lateReason}</p>)}
      {aggregate.historicalConfirmations.length === 0
        ? <p className="text-neutral-600">No superseded or withdrawn confirmations in this aggregate&rsquo;s history.</p>
        : aggregate.historicalConfirmations.map((item) => <p key={`hist-${item.position}-${item.revision}`}>• Historical: {POSITION_LABELS[item.position]} confirmed at revision {item.revision}, invalidated {stamp(item.invalidatedAt)} — {item.invalidationReason}</p>)}
      {aggregate.absences.map((absence) => <p key={`hist-abs-${absence.position}`}>• Historical absence declaration: {POSITION_LABELS[absence.position]} documented as {absence.absenceType.replaceAll("_", " ")} by {contributorName(content.participants, absence.recordedBy) ?? "an unavailable profile"} — retained even if that technician later participates.</p>)}
      {lateAcceptances.length === 0 && aggregate.historicalConfirmations.length === 0 && aggregate.absences.length === 0 && <p className="text-neutral-500 italic">Historical evidence appears only when the authoritative sources record it; nothing is inferred.</p>}
    </section>

    <section aria-label="Attendance evidence" className="rounded-xl border p-5 text-sm space-y-2 overflow-x-auto">
      <h2 className="text-lg font-semibold">Attendance records</h2>
      {isCompleted && <p className="text-neutral-600">The frozen report predates incoming acceptance. Incoming clock-ins below come from the persisted acceptance evidence recorded after the freeze; they are never written back into the frozen report.</p>}
      <table className="w-full text-left">
        <thead><tr><th>Participant</th><th>Side</th><th>Clock-in</th><th>Clock-out</th><th>Departure</th><th>Absence</th><th>Evidence</th></tr></thead>
        <tbody>{content.attendance.map((row) => {
          const acceptance = view.incomingAcceptance.find((item) => item.position === row.position);
          const persistedClockIn = row.clockIn ?? acceptance?.acceptedAt ?? null;
          const persistedEvidence = row.reportingEvidence
            ? `${row.reportingEvidence.kind} · ${row.reportingEvidence.personallyAuthenticated ? "personal" : "attested"}`
            : acceptance?.kind
              ? `${acceptance.kind}${acceptance.personallyAuthenticated ? " · personal" : ""}`
              : row.legacyAttendance ? "legacy record" : "none recorded";
          return <tr key={row.position}>
            <td>{row.name ?? "Unnamed technician"}</td>
            <td>{row.side}</td>
            <td>{stamp(persistedClockIn)}{row.clockIn === null && acceptance?.acceptedAt ? " (acceptance evidence)" : ""}</td>
            <td>{stamp(row.clockOut)}</td>
            <td>{row.departureProvenance ?? "—"}</td>
            <td>{row.absenceDeclared?.replaceAll("_", " ") ?? "—"}</td>
            <td>{persistedEvidence}</td>
          </tr>;
        })}</tbody>
      </table>
      {content.attendance.some((row) => {
        const acceptance = view.incomingAcceptance.find((item) => item.position === row.position);
        return row.clockIn === null && row.clockOut === null && row.absenceDeclared === null && !acceptance?.acceptedAt && !row.reportingEvidence && !row.legacyAttendance;
      }) && <p className="text-neutral-600">Participants without acceptance, reported attendance or a documented absence are shown as having no recorded attendance — it is never synthesized.</p>}
    </section>

    <section aria-label="Operational records" className="rounded-xl border p-5 text-sm space-y-2">
      <h2 className="text-lg font-semibold">Operational records &amp; authorship</h2>
      {content.operations.events.length === 0
        ? <p className="text-neutral-600">No operational events are persisted for the outgoing shift.</p>
        : <ul>{content.operations.events.map((event) => <li key={event.id} className="border-b py-1 last:border-0">
          <span className="font-medium">{event.kind.replaceAll("_", " ")}</span> · {event.authorName ?? "author name not on record"}{event.originalReporterName ? <span className="text-neutral-500"> (original reporter {event.originalReporterName})</span> : null} · {stamp(event.occurredAt)}
        </li>)}</ul>}
    </section>

    <section aria-label="Tasks" className="rounded-xl border p-5 text-sm space-y-2">
      <h2 className="text-lg font-semibold">Outstanding and completed tasks</h2>
      <h3 className="font-semibold">Outstanding ({content.pendingTasks.length})</h3>
      {content.pendingTasks.length === 0
        ? <p className="text-neutral-600">No outstanding tasks in the frozen/live evidence.</p>
        : <ul>{content.pendingTasks.map((task) => {
          const assignees = task.assignments
            .map((item) => contributorName(content.participants, item.technicianUid))
            .filter((name): name is string => name !== null);
          return <li key={task.id}>• {task.title} <span className="text-neutral-500">({task.status} · {task.priority})</span>{task.assignments.length > 0 && <> · assigned {assignees.length > 0 ? assignees.join(", ") : "to an unavailable profile"}</>}</li>;
        })}</ul>}
      <h3 className="mt-2 font-semibold">Completed / terminal ({content.terminalTaskEvidence.length})</h3>
      {content.terminalTaskEvidence.length === 0
        ? <p className="text-neutral-600">No terminal task evidence recorded.</p>
        : <ul>{content.terminalTaskEvidence.map((task) => <li key={task.id}>• {task.title} <span className="text-neutral-500">({task.status} · updated {stamp(task.updatedAt)})</span></li>)}</ul>}
      <p className="text-neutral-500 italic">Task transfer history is not part of the v2 evidence model and is intentionally not shown rather than invented.</p>
    </section>

    <section aria-label="Report identity" className="rounded-xl border p-5 text-sm space-y-1">
      <h2 className="text-lg font-semibold">Report revision</h2>
      <p>Aggregate revision {aggregate.revision}</p>
      {frozenReport
        ? <p>Frozen report version {frozenReport.version}{frozenReport.supersedesReportId ? " (supersedes an earlier version)" : ""} frozen by {contributorName(content.participants, frozenReport.frozenBy) ?? "an unavailable profile"} at {stamp(frozenReport.frozenAt)}.</p>
        : <p>No frozen report bound yet. {preparation ? `Prepared at revision ${preparation.preparationRevision}.` : "No preparation exists yet."}{preparationDrifted ? " The reviewed evidence has since drifted." : ""}</p>}
    </section>

    <section aria-label="Corrections" className="rounded-xl border p-5 text-sm space-y-1">
      <h2 className="text-lg font-semibold">Persisted correction trail</h2>
      {content.corrections.length === 0
        ? <p className="text-neutral-600">No corrections recorded. A broader audit-log feed is not exposed by this read service and is intentionally not reconstructed here.</p>
        : <ul>{content.corrections.map((item) => <li key={item.id}>• {stamp(item.recordedAt)} · {contributorName(content.participants, item.recordedBy) ?? "recorded by an unavailable profile"}: {item.note}</li>)}</ul>}
    </section>

    <section aria-label="Notification activity" className="rounded-xl border p-5 text-sm space-y-2 overflow-x-auto">
      <h2 className="text-lg font-semibold">Notification activity (observability only)</h2>
      {!view.notificationActivity.available
        ? <p className="text-neutral-600">The notification subsystem is not active in this environment, so no delivery activity is recorded. This is not evidence that notifications failed — they were never enabled.</p>
        : <>
          <p>Created {view.notificationActivity.summary.created} · queued {view.notificationActivity.summary.queued} · transport-admitted {view.notificationActivity.summary.delivered} · failed {view.notificationActivity.summary.failed} · no-device {view.notificationActivity.summary.noDevice} · opened {view.notificationActivity.summary.opened} · actioned {view.notificationActivity.summary.actioned}.</p>
          {view.notificationActivity.rows.length === 0
            ? <p className="text-neutral-600">No notifications have been created for this handover yet.</p>
            : <table className="w-full text-left">
              <thead><tr><th>Recipient</th><th>Event</th><th>Delivery</th><th>Attempts</th><th>Opened (advisory)</th><th>Actioned (genuine)</th></tr></thead>
              <tbody>{view.notificationActivity.rows.map((row, index) => <tr key={`${row.recipientUid}-${row.eventKind}-${index}`}>
                <td>{contributorName(content.participants, row.recipientUid) ?? "a user outside this roster"}</td>
                <td>{row.eventKind.replaceAll("_", " ")}</td>
                <td>{row.deliveryStatus ?? "not queued"}{row.transportAccepted ? " · admitted" : ""}{row.lastErrorClass ? ` · ${row.lastErrorClass}` : ""}</td>
                <td>{row.attemptCount}</td>
                <td>{stamp(row.openedAt)}</td>
                <td>{stamp(row.actionedAt)}</td>
              </tr>)}</tbody>
            </table>}
          <p className="text-neutral-500 italic">&ldquo;Admitted&rdquo; means the push transport accepted the message — it is NOT a delivery or view receipt. &ldquo;Opened&rdquo; is the technician&rsquo;s own advisory read metadata. &ldquo;Actioned&rdquo; reflects a genuine confirmation/acceptance/task action, never a notification tap. None of this confirms a handover or records attendance.</p>
        </>}
    </section>

    {content.completeness.blockers.length > 0 && <section aria-label="Blockers" className="rounded-xl border border-red-500 p-5 text-sm space-y-1">
      <h2 className="text-lg font-semibold text-red-700">Report completeness blockers ({content.completeness.blockers.length})</h2>
      <ul>{content.completeness.blockers.map((item) => <li key={item}>• {item}</li>)}</ul>
    </section>}

    {content.completeness.warnings.length > 0 && <section aria-label="Warnings" className="rounded-xl border p-5 text-sm space-y-1">
      <h2 className="font-semibold">Warnings ({content.completeness.warnings.length})</h2>
      <ul>{content.completeness.warnings.map((item) => <li key={item}>• {item}</li>)}</ul>
    </section>}
  </main>;
}
