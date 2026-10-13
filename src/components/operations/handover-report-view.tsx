"use client";

import type { HandoverReportView } from "@/types/handover-report";

const show = (value: string | null | undefined) => {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};

const label = (value: string) => value.replaceAll("_", " ");

function evidenceValue(value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  if (Array.isArray(value)) {
    return value.length === 0 ? "None" : value.map(String).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function HandoverReport({ report }: { report: HandoverReportView }) {
  const { content, handover } = report;
  const { staff, operations } = content;
  const staffName = (uid: string) =>
    [...staff.outgoing, ...staff.incoming].find(person => person.uid === uid)?.name;
  const confirmationSnapshotHashes = [
    ...new Set(
      report.participants
        .filter(participant => participant.state === "confirmed")
        .map(participant => participant.confirmation.snapshotHash),
    ),
  ];
  const sharedConfirmationSnapshotHash =
    confirmationSnapshotHashes.length === 1
      ? confirmationSnapshotHashes[0]
      : null;
  const receiptFields = [
    ["Schema", "schema"],
    ["Action", "action"],
    ["Outcome", "outcome"],
    ["Receipt ID", "id"],
    ["Receipt SHA-256", "receiptHash"],
    ["Handover ID", "handoverDocumentId"],
    ["Outgoing shift ID", "outgoingShiftId"],
    ["Incoming shift ID", "incomingShiftId"],
    ["Final revision", "finalRevision"],
    ["Final snapshot SHA-256", "finalSnapshotHash"],
    ["Transfer actor", "actorUid"],
    ["Transfer authority", "actorRole"],
    ["Transferred at", "transferredAt"],
    ["Incoming attendance technician IDs", "incomingAttendanceTechnicianIds"],
    ["Task transfer evidence IDs", "taskTransferIds"],
    ["Released assignment IDs", "releasedAssignmentIds"],
    ["Reservation evidence", "reservation"],
    ["Operational control before", "operationalControlBefore"],
    ["Operational control after", "operationalControlAfter"],
  ] as const;

  return (
    <article className="handover-print space-y-6 rounded-xl border bg-white p-5 text-slate-900 sm:p-8 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">
            Technical Department
          </p>
          <h1 className="mt-2 text-2xl font-bold">Shift Handover Report</h1>
          <p className="mt-2 text-sm">
            {staff.shiftDate} · {label(staff.shiftType)} ·{" "}
            {report.frozen
              ? "Frozen report evidence"
              : "Live preview — not authenticated report evidence"}
          </p>
          <p className="text-xs text-slate-500">
            Outgoing shift: {staff.shiftId}
          </p>
        </div>
        <button
          type="button"
          className="print:hidden rounded-lg border px-4 py-2"
          onClick={() => window.print()}
        >
          Print / Save as PDF
        </button>
      </header>

      <section>
        <h2 className="mb-3 text-lg font-semibold">A. Staff information</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Scheduled shift</dt>
            <dd>{show(staff.scheduledStart)} – {show(staff.scheduledEnd)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Actual start</dt>
            <dd>{show(staff.actualStart)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Outgoing technicians</dt>
            <dd>
              {staff.outgoing
                .map(person => person.name ?? `${person.uid} (name missing)`)
                .join(" · ")}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Incoming technicians</dt>
            <dd>
              {staff.incoming.length
                ? staff.incoming
                    .map(person => person.name ?? `${person.uid} (name missing)`)
                    .join(" · ")
                : "Not reserved"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Engineering / location</dt>
            <dd>{staff.engineeringLocation ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Handover state</dt>
            <dd>
              {handover ? label(handover.lifecycleStatus) : "Not initiated"} ·
              {" "}Started: {show(staff.handoverStartedAt)}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">
          B. Attendance and reporting
        </h2>
        <div className="overflow-x-auto">
          <table className="attendance-report-table w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "Technician / record ID",
                  "Reporting confirmation",
                  "Clock-in",
                  "Clock-out",
                  "Hours",
                  "Attendance",
                ].map(title => (
                  <th className="border-b p-2" key={title}>{title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.attendance.map(row => (
                <tr key={row.uid}>
                  <td className="border-b p-2">
                    <strong>{row.name ?? row.uid}</strong>
                    <p className="break-all text-xs">Technician UID: {row.uid}</p>
                    {row.evidence && (
                      <p className="break-all text-xs">
                        Attendance ID: {row.evidence.id}
                        {row.evidence.authorizationId
                          ? ` · Authorization ID: ${row.evidence.authorizationId}`
                          : ""}
                      </p>
                    )}
                  </td>
                  <td className="border-b p-2">{show(row.reportingTime)}</td>
                  <td className="border-b p-2">{show(row.evidence?.clockIn)}</td>
                  <td className="border-b p-2">{show(row.evidence?.clockOut)}</td>
                  <td className="border-b p-2">
                    {row.hoursWorked?.toFixed(2) ?? "Undetermined"}
                  </td>
                  <td className="border-b p-2">
                    {row.evidence ? label(row.evidence.status) : "Not recorded"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Reporting confirmation is attendance evidence, not a fabricated
          clock-in. Late reasons appear only when recorded by the attendance
          system.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">C. Broadcast status</h2>
        <div className="overflow-x-auto">
          <table className="broadcast-report-table w-full text-left text-sm">
            <thead>
              <tr>
                {["Station", "Status", "Last observed", "Technician / audit IDs", "Remarks"].map(title => (
                  <th className="border-b p-2" key={title}>{title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {operations.broadcast.map(row => {
                const observation = row.observation;
                return (
                  <tr key={row.stationId}>
                    <td className="border-b p-2">{row.stationName}</td>
                    <td className="border-b p-2">
                      {observation?.kind === "broadcast"
                        ? label(observation.status)
                        : "NOT VERIFIED — missing observation"}
                    </td>
                    <td className="border-b p-2">{show(observation?.occurredAt)}</td>
                    <td className="break-all border-b p-2">
                      {observation ? (
                        <>
                          <strong>{observation.authorName}</strong>
                          <p>UID: {observation.authorUid}</p>
                          <p>Record: {observation.recordId}</p>
                          <p>Event: {observation.id} · Revision {observation.revision}</p>
                        </>
                      ) : "Not recorded"}
                    </td>
                    <td className="border-b p-2">
                      {observation?.kind === "broadcast"
                        ? observation.remarks
                        : "Not recorded"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">
          D. Faults and technical activities
        </h2>
        {operations.latest.filter(record => record.kind === "incident").length === 0 &&
          <p className="text-sm">No fault or activity information submitted.</p>}
        {operations.latest
          .filter(record => record.kind === "incident")
          .map(record => record.kind === "incident" && (
            <div
              key={record.recordId}
              className="mb-3 space-y-2 rounded-lg border p-4 text-sm"
            >
              <h3 className="font-semibold">
                {record.title} · {label(record.category)} · {label(record.severity)} · {label(record.status)}
              </h3>
              <p>{record.description}</p>
              <p className="break-all">
                Record ID: {record.recordId} · Location: {record.location || "Not recorded"}
              </p>
              <p>
                Reported {show(record.occurredAt)} by {record.originalReporterName}
                {" "}({record.originalReporterUid})
              </p>
              <p>Linked task: {record.linkedTaskId ?? "None"}</p>
              <ol className="space-y-1">
                {operations.events
                  .filter(event => event.recordId === record.recordId)
                  .sort((a, b) => a.revision - b.revision)
                  .map(event => (
                    <li key={event.id}>
                      {show(event.createdAt)} · {event.authorName} ({event.authorUid})
                      {" "}· Event {event.id} · Revision {event.revision}:{" "}
                      {"actionTaken" in event
                        ? event.actionTaken || "No action recorded"
                        : ""}
                      {"status" in event ? ` (${label(event.status)})` : ""}
                    </li>
                  ))}
              </ol>
            </div>
          ))}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">E. Outside broadcasts</h2>
        <p className="mb-3 text-sm">
          Section status: {label(operations.completeness.outsideBroadcast)}
        </p>
        {operations.latest
          .filter(record => record.kind === "outside_broadcast" || record.kind === "no_ob")
          .map(record => (
            <div
              key={record.recordId}
              className="mb-3 rounded-lg border p-4 text-sm"
            >
              <p className="break-all">
                Record ID: {record.recordId} · Event ID: {record.id} ·
                {" "}Revision {record.revision}
              </p>
              <p>
                Reported by {record.authorName} ({record.authorUid}) ·
                {" "}{show(record.createdAt)}
              </p>
              {record.kind === "outside_broadcast" ? (
                <>
                  <h3 className="font-semibold">
                    {record.title} · {record.location} · {label(record.runningStatus)}
                  </h3>
                  <p>Started {show(record.occurredAt)} · {label(record.status)}</p>
                  <p>Technical issues: {record.technicalIssues || "None recorded"}</p>
                  <p>Remarks: {record.remarks || "None"}</p>
                  <p>Linked task: {record.linkedTaskId ?? "None"}</p>
                  <ol>
                    {operations.events
                      .filter(event => event.recordId === record.recordId)
                      .sort((a, b) => a.revision - b.revision)
                      .map(event => (
                        <li key={event.id}>
                          {show(event.createdAt)} · {event.authorName} ({event.authorUid})
                          {" "}· Event {event.id} · Revision {event.revision}:{" "}
                          {"actionTaken" in event
                            ? event.actionTaken || "No action recorded"
                            : ""}
                        </li>
                      ))}
                  </ol>
                </>
              ) : (
                <p>
                  No outside broadcasts during this shift — {record.authorName},
                  {" "}{show(record.createdAt)}
                </p>
              )}
            </div>
          ))}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Pending tasks</h2>
        {content.pendingTasks.length === 0 &&
          <p className="text-sm">No unfinished tasks linked to this shift.</p>}
        {content.pendingTasks.map(task => (
          <div className="mb-3 rounded-lg border p-4 text-sm" key={task.id}>
            <h3 className="font-semibold">
              {task.title} · {label(task.priority)} · {label(task.status)}
            </h3>
            <p className="break-all">Task ID: {task.id}</p>
            <p>
              Disposition: {label(task.disposition)} · Carry-forward eligible:{" "}
              {task.carryForwardEligible ? "Yes" : "No"}
            </p>
            {task.reason && <p>Reason: {task.reason}</p>}
            <ul>
              {task.assignments.map(assignment => (
                <li key={assignment.id} className="break-all">
                  Assignment ID: {assignment.id} · Technician UID: {assignment.technicianUid}
                  {" "}· {assignment.responsibility} · {assignment.acceptance}
                  {" "}· {assignment.responsibilityStatus}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="text-xs text-slate-500">
          Reviewing carry-forward tasks does not accept or create incoming task
          assignments.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Completeness</h2>
        {content.completeness.blockers.length === 0 ? (
          <p className="text-sm">Required operational and work sections are complete.</p>
        ) : (
          <ul className="list-inside list-disc text-sm text-red-700">
            {content.completeness.blockers.map(item => <li key={item}>{item}</li>)}
          </ul>
        )}
      </section>

      <div className="handover-final-evidence">
        {content.completeness.warnings.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold">Completeness notes</h2>
            <ul className="list-inside list-disc text-sm text-amber-700">
              {content.completeness.warnings.map(item => <li key={item}>{item}</li>)}
            </ul>
          </section>
        )}

        {handover && (
          <section className="confirmation-evidence">
            <h2 className="mb-3 text-lg font-semibold">
              Participant evidence · Revision {handover.revision}
            </h2>
            {sharedConfirmationSnapshotHash && (
              <p className="break-all text-xs">
                Shared confirmation snapshot SHA-256: {sharedConfirmationSnapshotHash}
              </p>
            )}
            <ul className="space-y-2 text-sm">
              {report.participants.map(participant => {
                const evidence = participant.state === "confirmed"
                  ? `Confirmed ${show(participant.confirmation.confirmedAt)} · revision ${participant.confirmation.revision}${sharedConfirmationSnapshotHash ? " · binds shared report snapshot" : ` · snapshot ${participant.confirmation.snapshotHash}`}`
                  : participant.state === "absent"
                    ? `Absent: ${participant.absence.reason} · authorized by ${participant.absence.recordedBy} · recorded ${show(participant.absence.recordedAt)} · revision ${participant.absence.revision}`
                    : participant.state === "supervisor_exception"
                      ? `Exception: ${participant.exception.reason} · authorized by ${participant.exception.supervisorUid} · recorded ${show(participant.exception.recordedAt)} · revision ${participant.exception.revision}`
                      : "Awaiting confirmation";
                return (
                  <li
                    key={participant.position}
                    className="participant-evidence-row break-all rounded-lg border p-3"
                  >
                    <strong className="text-base">
                      {staffName(participant.technicianUid) ?? label(participant.position)}
                    </strong>
                    <p>
                      {label(participant.position)} · {participant.technicianUid}
                      {" "}· {label(participant.state)}
                    </p>
                    <p>{evidence}</p>
                  </li>
                );
              })}
            </ul>
            {!report.frozen && (
              <p className="mt-2 text-sm text-amber-700">
                Existing confirmations currently bind the work handover snapshot.
                This live report has not been frozen as authenticated report evidence.
              </p>
            )}
          </section>
        )}

        {content.corrections.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold">Controlled report corrections</h2>
            <ol className="space-y-3 text-sm">
              {content.corrections.map(note => (
                <li key={note.id} className="break-all">
                  <p>{note.note}</p>
                  <p className="text-xs text-slate-500">
                    Correction ID: {note.id} · {note.recordedBy} ·
                    {" "}{show(note.recordedAt)} · Original evidence retained
                  </p>
                </li>
              ))}
            </ol>
          </section>
        )}

        {handover?.reportBinding && (
          <section className="binding-evidence break-all text-xs">
            <h2 className="mb-2 font-semibold">Authenticated report binding</h2>
            <p>{handover.reportBinding.schema} · {handover.reportBinding.id}</p>
            <p>Report SHA-256: {handover.reportBinding.digest}</p>
            <p>Confirmation snapshot: {report.snapshotHash}</p>
          </section>
        )}

        {report.receipt && (
          <section className="transfer-evidence">
            <h2 className="mb-3 text-lg font-semibold">Transfer receipt</h2>
            <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
              {receiptFields.map(([title, key]) => (
                <div key={key}>
                  <dt className="font-semibold text-slate-600">{title}</dt>
                  <dd className="break-all">{evidenceValue(report.receipt?.[key])}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </article>
  );
}
