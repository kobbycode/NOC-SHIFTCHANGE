"use client";

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { HandoverReportView } from "@/types/handover-report";
import type { UserRole } from "@/types/auth";
import { HandoverReport } from "./handover-report-view";

const field = "block w-full rounded-lg border bg-transparent px-3 py-2";
const button = "rounded-lg bg-blue-700 px-4 py-2 text-white disabled:opacity-50";
export function HandoverWorkflow({ initialReport, uid, role }: { initialReport: HandoverReportView; uid: string; role: UserRole }) {
  const [report, setReport] = useState(initialReport);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const handover = report.handover;
  const shiftId = report.content.staff.shiftId;
  const base = `/api/operations/shifts/${encodeURIComponent(shiftId)}`;
  const manager = role === "supervisor" || role === "admin";
  const collecting = handover?.lifecycleStatus === "collecting_confirmations";
  const me = report.participants.find(person => person.technicianUid === uid);
  const transferBlockers = [
    ...(!report.frozen ? ["The report must be frozen for review."] : []),
    ...(report.participants.some(person => person.state === "awaiting_confirmation") ? ["Every participant position must be resolved."] : []),
    ...(!report.participants.some(person => person.side === "incoming" && person.state === "confirmed") ? ["At least one incoming permanent technician must authenticate their confirmation."] : []),
    ...report.content.completeness.blockers,
  ];
  const binding = { expectedRevision: handover?.revision, expectedSnapshotHash: report.snapshotHash };
  async function reload() {
    const response = await fetch(`${base}/report`, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || "Unable to refresh report.");
    setReport(result.report);
  }
  async function act(path: string | null, body?: object) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      if (path) {
        const response = await fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.success) {
          await reload();
          throw new Error(result.error || "Action could not be completed.");
        }
      }
      await reload(); setMessage(path ? "Saved. Review the current report and participant evidence below." : "Report refreshed.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to complete action."); }
    finally { lock.current = false; setBusy(false); }
  }
  function form(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget); }
  return <div className="space-y-5">
    <section className="print:hidden space-y-4 rounded-xl border bg-white p-5 dark:bg-slate-950" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Handover review and actions</h2><button className={button} disabled={busy} onClick={() => void act(null)}>Refresh report</button></div>
      <p className="text-sm">Review sections A–E and pending work before confirming. Report revisions invalidate earlier confirmations. Task acceptance remains a separate action.</p>
      {message && <p role="status" className="text-green-700">{message}</p>}{error && <p role="alert" className="text-red-700">{error}</p>}
      {handover && <p className="text-sm">Revision {handover.revision} · {handover.lifecycleStatus.replaceAll("_", " ")} · {report.participants.filter(person => person.state !== "awaiting_confirmation").length}/4 participant positions resolved</p>}
      {handover?.reportBinding && <div className="break-all rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-900"><p>Report: {handover.reportBinding.id}</p><p>Report SHA-256: {handover.reportBinding.digest}</p><p>Confirmation snapshot: {report.snapshotHash}</p></div>}
      {!handover && <p>Supervisor: reserve the incoming permanent pair from the Handovers screen after beginning handover in Shift Management.</p>}
      {collecting && <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
        {manager && <>
          <form className="space-y-3 rounded-lg border p-4" onSubmit={event => { const values = form(event); void act("report", { ...binding, reason: String(values.get("reason")), ...(values.get("correctionNote") ? { correctionNote: String(values.get("correctionNote")) } : {}) }); }}>
            <h3 className="font-semibold">{report.frozen ? "Revise the reviewed report" : "Freeze the complete report"}</h3>
            <p className="text-sm">Freezing captures authoritative records and pending work. Revising preserves the original evidence and clears all confirmations.</p>
            <label className="block text-sm">Review / revision reason<textarea className={field} name="reason" required maxLength={2000}/></label>
            <label className="block text-sm">Correction note (optional, retained in report history)<textarea className={field} name="correctionNote" maxLength={5000}/></label>
            <button className={button} type="submit">{report.frozen ? "Freeze revised report and clear confirmations" : "Freeze report for confirmation"}</button>
          </form>
          <div className="space-y-3"><h3 className="font-semibold">Classify unfinished tasks</h3>{report.content.pendingTasks.map(task => <form key={task.id} className="space-y-2 rounded-lg border p-4" onSubmit={event => { const values = form(event); void act(`handover/work/${encodeURIComponent(task.id)}/disposition`, { ...binding, operation: "classify", disposition: String(values.get("disposition")), reason: String(values.get("reason")) }); }}>
            <p>{task.title} · {task.disposition.replaceAll("_", " ")}</p><label className="block text-sm">Disposition<select className={field} name="disposition" defaultValue="carry_forward"><option value="carry_forward">Carry forward to incoming shift</option><option value="resolve_before_transfer">Must resolve before transfer</option></select></label>
            <label className="block text-sm">Reason<textarea className={field} name="reason" required minLength={10} maxLength={1000}/></label><button className={button}>Save disposition and revise snapshot</button>
          </form>)}</div>
          <details className="rounded-lg border p-4"><summary className="cursor-pointer font-semibold">Authorized absence or supervisor exception</summary><p className="my-3 text-sm">Record only a genuine operational reason. An exception is supervisor evidence, not a technician password confirmation.</p>
            <form className="space-y-3" onSubmit={event => { const values = form(event), operation = String(values.get("operation")); void act("handover/resolution", { ...binding, technicianUid: String(values.get("technicianUid")), operation, ...(operation === "clear" ? {} : { reason: String(values.get("reason")) }), ...(operation === "exception" ? { category: String(values.get("category")) } : {}) }); }}>
              <label className="block text-sm">Participant<select className={field} name="technicianUid">{report.participants.map(person => <option key={person.position} value={person.technicianUid}>{person.position.replaceAll("_", " ")} · {person.technicianUid}</option>)}</select></label>
              <label className="block text-sm">Action<select className={field} name="operation"><option value="absence">Record absence</option><option value="exception">Record supervisor exception</option><option value="clear">Clear resolution</option></select></label>
              <label className="block text-sm">Exception category<select className={field} name="category"><option value="unavailable">Unavailable</option><option value="emergency">Emergency</option><option value="operational_constraint">Operational constraint</option></select></label>
              <label className="block text-sm">Reason<textarea className={field} name="reason" maxLength={2000}/></label><button className={button}>Save participant resolution</button>
            </form>
          </details>
        </>}
        {!manager && me?.state === "awaiting_confirmation" && report.frozen && <form className="space-y-3 rounded-lg border p-4" onSubmit={event => { const values = form(event); const password = String(values.get("password")); event.currentTarget.reset(); void act("handover/confirmation", { ...binding, password }); }}>
          <h3 className="font-semibold">Confirm your reviewed report</h3><label className="flex items-start gap-2 text-sm"><input type="checkbox" required/>I have reviewed this report, pending work, and the displayed revision.</label>
          <label className="block text-sm">Your current password<input className={field} name="password" type="password" required autoComplete="current-password"/></label><button className={button}>Authenticate and confirm revision {handover?.revision}</button>
        </form>}
        {!manager && !report.frozen && <p className="text-amber-700">Awaiting supervisor report freeze before authentication.</p>}
        {!manager && me && me.state !== "awaiting_confirmation" && <p>Your participant status: {me.state.replaceAll("_", " ")}. Refresh to see other participants.</p>}
        {manager && <form className="space-y-3 rounded-lg border border-blue-300 p-4" onSubmit={event => { form(event); void act("handover/transfer", binding); }}>
          <h3 className="font-semibold">Final atomic transfer</h3><p className="text-sm">The server rechecks the frozen report, all participants, current ownership, work readiness, and capacity before moving operational control once.</p>
          {transferBlockers.length > 0 && <ul aria-label="Transfer blockers" className="list-inside list-disc text-sm text-amber-700">{transferBlockers.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
          <label className="flex gap-2 text-sm"><input required type="checkbox"/>I have reviewed the report and participant resolutions.</label>
          <button className={button} disabled={transferBlockers.length > 0}>Complete secure transfer</button>
        </form>}
      </fieldset>}
    </section>
    <HandoverReport report={report}/>
  </div>;
}
