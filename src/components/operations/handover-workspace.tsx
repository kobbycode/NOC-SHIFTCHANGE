"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { HandoverWorkspaceData } from "@/lib/operations/handover-workspace";

export function HandoverWorkspace({ data, manager }: { data: HandoverWorkspaceData; manager: boolean }) {
  const router = useRouter(), lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const field = "block w-full rounded-lg border bg-transparent p-2";
  return <div className="space-y-6"><header><h1 className="text-2xl font-bold">Shift handovers</h1><p className="mt-2 text-sm">Review shared shift evidence, authenticate your confirmation, and retain completed reports.</p></header>
    {manager && <section className="space-y-3 rounded-xl border p-5"><h2 className="text-lg font-semibold">Prepare incoming reservation</h2><p className="text-sm">First finish operational entries, then begin handover in <Link className="text-blue-600 underline" href="/supervisor/shifts">Shift Management</Link>. Beginning handover locks operational edits.</p>
      {data.availableShifts.length === 0 ? <p className="text-sm">No unreserved shifts awaiting handover.</p> : <form className="grid gap-3 sm:grid-cols-2" onSubmit={async event => {
        event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError("");
        const values = new FormData(event.currentTarget), shiftId = String(values.get("shiftId"));
        try {
          const response = await fetch(`/api/operations/shifts/${encodeURIComponent(shiftId)}/handover/reservation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ incomingPermanentPairId: String(values.get("pairId")), shiftType: String(values.get("shiftType")), scheduledStart: new Date(String(values.get("start"))).toISOString(), scheduledEnd: new Date(String(values.get("end"))).toISOString() }) });
          const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error || "Reservation failed.");
          router.push(`/supervisor/handovers/${encodeURIComponent(shiftId)}`); router.refresh();
        } catch (failure) { setError(failure instanceof Error ? failure.message : "Reservation failed."); }
        finally { lock.current = false; setBusy(false); }
      }}>
        <fieldset disabled={busy} className="contents"><label className="text-sm">Outgoing shift<select className={field} name="shiftId" required>{data.availableShifts.map(shift => <option key={shift.id} value={shift.id}>{shift.id} · {new Date(shift.scheduledStart).toLocaleString()}</option>)}</select></label>
        <label className="text-sm">Incoming permanent pair<select className={field} name="pairId" required><option value="">Select pair</option>{data.pairs.map(pair => <option key={pair.id} value={pair.id}>{pair.label}</option>)}</select></label>
        <label className="text-sm">Shift type<select className={field} name="shiftType"><option value="morning">Morning</option><option value="night">Night</option></select></label><div/>
        <label className="text-sm">Incoming start (local time)<input className={field} name="start" type="datetime-local" required/></label><label className="text-sm">Incoming end (local time)<input className={field} name="end" type="datetime-local" required/></label>
        <button disabled={busy} className="rounded-lg bg-blue-700 p-3 text-white">{busy ? "Preparing…" : "Reserve incoming pair"}</button></fieldset>
      </form>}{error && <p role="alert" className="text-red-700">{error}</p>}</section>}
    <section className="space-y-3"><h2 className="text-lg font-semibold">{manager ? "Reports and participant reviews" : "Your outgoing and incoming handovers"}</h2>{data.reports.length === 0 && <p>No handovers available yet.</p>}{data.reports.map(report => <Link key={report.shiftId} href={`/${manager ? "supervisor" : "technician"}/handovers/${encodeURIComponent(report.shiftId)}`} className="block space-y-2 rounded-xl border p-5 hover:border-blue-500"><p className="font-semibold">{report.shiftId} → {report.incomingShiftId}</p><p className="text-sm">{report.status.replaceAll("_", " ")} · Revision {report.revision} · Incoming {new Date(report.scheduledStart).toLocaleString()}</p><p className="text-sm text-blue-600">Review report and participant evidence →</p></Link>)}</section>
  </div>;
}
