"use client";
// 09M-R3B.2 Phase 6 — supervisor-authorized exceptional guard closure.
//
// Only a live, non-participating supervisor may authorize this closure, and the
// server additionally requires an existing authoritative `not_yet_in` absence
// for the subject. The closure records NO acceptance, attendance, membership,
// clock time or personal receipt for the absent technician: their absence
// declaration remains the only record of them for this handover.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const field = "block w-full rounded-lg border bg-transparent p-2";

type FinalizeEnvelope = {
  success?: boolean;
  error?: string;
  code?: string;
  outcomeUnknown?: boolean;
  commitState?: string;
  status?: string;
  replayed?: boolean;
  mode?: string;
  provenance?: unknown;
  guard?: { id?: string; revision?: number; terminalEvidenceRef?: string | null };
  closure?: { closureId?: string; subjectUid?: string } | null;
  audit?: { id?: string; state?: string };
};

export function SupervisorGuardClosure({
  shiftId,
  subjectUid,
  subjectName,
  absenceReason,
}: {
  shiftId: string;
  subjectUid: string;
  subjectName: string | null;
  absenceReason: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState("");
  const [done, setDone] = useState<FinalizeEnvelope | null>(null);
  const lock = useRef(false);
  // A stable closure id makes an explicit retry replay the same closure rather
  // than authorizing a second one. It is created on first submit, never on
  // render, so it is stable only within this user-initiated session.
  const closureId = useRef<string | null>(null);

  const submit = async (form: HTMLFormElement) => {
    if (lock.current) return;
    const values = new FormData(form);
    const reason = String(values.get("reason") ?? "").trim();
    if (!reason) { setError("A closure reason is required."); return; }
    if (closureId.current === null) {
      closureId.current = crypto.randomUUID();
    }
    lock.current = true; setBusy(true); setError(""); setUnconfirmed("");
    try {
      const response = await fetch(
        `/api/operations/shifts/${encodeURIComponent(shiftId)}/handover/v2/guard/finalize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ closure: { closureId: closureId.current, subjectUid, reason } }),
        },
      );
      let result: FinalizeEnvelope | null = null;
      try { result = (await response.json()) as FinalizeEnvelope; }
      catch { result = null; }
      if (response.ok && result?.success) {
        setDone(result);
        form.reset();
        router.refresh();
        return;
      }
      if (response.status === 503 || result?.outcomeUnknown === true) {
        setUnconfirmed("The closure outcome is UNCONFIRMED. This is not proof that it failed. Do not resubmit — reload the guard state.");
        return;
      }
      setError(result?.error ?? "The exceptional closure was refused.");
    } catch {
      setUnconfirmed("The closure response was lost. The outcome is UNCONFIRMED; reload the guard state instead of resubmitting.");
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  if (done !== null) {
    return <div className="rounded-lg border border-green-600 p-3 text-sm space-y-1">
      <p className="font-semibold text-green-800">Reservation guard closed exceptionally.</p>
      <p>Mode {done.mode ?? "exceptional_closure"}{done.replayed ? " (replayed)" : ""} · guard revision {done.guard?.revision ?? "—"}.</p>
      <p>No acceptance, attendance, membership or clock time was created for {subjectName ?? "the absent technician"}. The documented absence remains their only record.</p>
      <p className="text-neutral-600">Closure notifications are not emitted; no delivery is claimed.</p>
    </div>;
  }

  return <div className="rounded-lg border border-amber-500 p-3 text-sm space-y-2">
    <p className="font-semibold text-amber-800">Exceptional closure for {subjectName ?? "the absent technician"}</p>
    <p>One reserved incoming technician accepted; the other has an authoritative <em>not yet in</em> absence declaration and no application records.</p>
    <p>Authoritative absence reason: <strong>{absenceReason}</strong></p>
    <p className="text-neutral-700">This closes the reservation guard only. It creates no acceptance, attendance, membership, clock time or personal receipt for {subjectName ?? "the absent technician"}.</p>
    <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void submit(event.currentTarget as HTMLFormElement); }}>
      <label className="text-sm">Supervisor closure reason<input className={field} name="reason" required maxLength={2000}/></label>
      <button disabled={busy} className="btn-accent w-fit rounded-lg p-2">{busy ? "Closing…" : "Authorize exceptional guard closure"}</button>
    </form>
    {unconfirmed && <div role="alert" className="space-y-1">
      <p>{unconfirmed}</p>
      <button type="button" disabled={busy} onClick={() => router.refresh()} className="rounded-lg border p-2">Reload guard state</button>
    </div>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
  </div>;
}
