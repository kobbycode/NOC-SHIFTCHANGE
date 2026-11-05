"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { EqualHandoverInitiationContext } from "@/lib/operations/handover-initiation-v2";

const field = "block w-full rounded-lg border bg-transparent p-2";
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

function toLocalInputValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function clock(value: string | null): string {
  return value === null ? "—" : new Date(value).toLocaleString();
}

// One intended reservation maps to one key: the key is derived from the
// selection alone, never from the acting technician, so a double click, a
// page reload with the same choices, or the partner technician submitting the
// identical reservation all replay the same deterministic proposal instead of
// creating a second one.
async function reservationIdempotencyKey(input: {
  outgoingShiftId: string;
  incomingPermanentPairId: string;
  shiftType: string;
  scheduledStart: string;
  scheduledEnd: string;
}): Promise<string> {
  const material = [
    "equal-handover-v2-initialize",
    input.outgoingShiftId,
    input.incomingPermanentPairId,
    input.shiftType,
    input.scheduledStart,
    input.scheduledEnd,
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

type Outcome = { ok: boolean; status: number; error: string | null; payload: Record<string, unknown> };

// Entry point for the technician handover list: an outgoing shift that is ready
// to begin or reserve has no v2 aggregate yet, so the existing aggregate list
// cannot link to it.
export function EqualHandoverInitiationEntries({ initiations }: { initiations: readonly EqualHandoverInitiationContext[] }) {
  const router = useRouter();
  return <section aria-labelledby="v2-initiation-entries" className="mb-6 space-y-3">
    <h2 id="v2-initiation-entries" className="text-lg font-semibold">Start an equal-technician handover (v2 preview)</h2>
    <label className="block max-w-xl text-sm">Eligible outgoing shift
      <select className={field} defaultValue=""
        onChange={event => { if (event.target.value) router.push(`/technician/handovers/v2/${encodeURIComponent(event.target.value)}`); }}>
        <option value="">Select a shift</option>
        {initiations.map(item => <option key={item.outgoingShiftId} value={item.outgoingShiftId}>
          {item.outgoingShiftId} · {item.shiftStatus?.replaceAll("_", " ")} · {item.step === "begin" ? "begin the handover" : "reserve the incoming pair"}
        </option>)}
      </select>
    </label>
    <p className="text-sm">Either outgoing technician of the pair can initiate; opening the shift shows the same step for both, and a repeated initiation replays the existing reservation instead of creating another one.</p>
  </section>;
}

export function EqualHandoverInitiationV2({ context }: { context: EqualHandoverInitiationContext }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [missingEvidence, setMissingEvidence] = useState<string[]>([]);
  const lock = useRef(false);

  const base = `/api/operations/shifts/${encodeURIComponent(context.outgoingShiftId)}/handover/v2`;
  const { candidates, suggested } = context;

  const post = async (path: string, body: Record<string, unknown>): Promise<Outcome> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    const success = payload?.success === true;
    return {
      ok: response.ok && success,
      status: response.status,
      error: response.ok && success ? null
        : typeof payload?.error === "string" ? payload.error
          : response.status === 401 ? "Your session expired. Sign in again and retry."
            : response.status === 404 ? "The equal-technician handover workflow is not available."
              : "The v2 handover action failed. Please try again.",
      payload: payload as Record<string, unknown>,
    };
  };

  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setMissingEvidence([]);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The v2 handover action failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const begin = () => run(async () => {
    const result = await post("/begin", {});
    // A completeness rejection is not a state conflict: nothing changed on
    // the server, so show exactly which mandatory evidence is missing and
    // send the technician to the operational-record workflow instead of
    // refreshing or implying the handover started.
    if (!result.ok && result.payload?.code === "HANDOVER_OPERATIONAL_EVIDENCE_INCOMPLETE") {
      setMissingEvidence(Array.isArray(result.payload.missingRequirements)
        ? result.payload.missingRequirements.filter((item): item is string => typeof item === "string")
        : []);
      setError(result.error ?? "Record the missing operational evidence before beginning this handover.");
      return;
    }
    // A concurrent begin by the partner technician surfaces as a conflict; in
    // every conflict case the server state is authoritative, so reload it and
    // let the workflow (or the reservation step) render instead of a dead end.
    if (!result.ok && result.status === 409) {
      setError(result.error ?? "The handover state changed.");
      router.refresh();
      return;
    }
    if (!result.ok) {
      setError(result.error ?? "Unable to begin this handover.");
      return;
    }
    setNotice("Handover begun. The outgoing shift is now awaiting the incoming pair reservation.");
    router.refresh();
  });

  const reserve = async (form: HTMLFormElement) => {
    const values = new FormData(form);
    const incomingPermanentPairId = String(values.get("pairId") ?? "");
    const shiftType = String(values.get("shiftType") ?? "morning");
    const scheduledStart = new Date(String(values.get("start") ?? "")).toISOString();
    const scheduledEnd = new Date(String(values.get("end") ?? "")).toISOString();
    if (!incomingPermanentPairId) { setError("Select the incoming permanent pair."); return; }
    if (!Number.isFinite(Date.parse(String(values.get("start")))) || !Number.isFinite(Date.parse(String(values.get("end"))))) {
      setError("Provide both incoming start and end times."); return;
    }
    const span = Date.parse(scheduledEnd) - Date.parse(scheduledStart);
    if (span <= 0 || span > MAX_WINDOW_MS) {
      setError("The incoming shift must end after it starts and last no more than 24 hours."); return;
    }
    await run(async () => {
      const idempotencyKey = await reservationIdempotencyKey({
        outgoingShiftId: context.outgoingShiftId, incomingPermanentPairId, shiftType, scheduledStart, scheduledEnd,
      });
      const result = await post("/reservation", { incomingPermanentPairId, shiftType, scheduledStart, scheduledEnd, idempotencyKey });
      if (!result.ok) {
        setError(result.error ?? "Unable to reserve the incoming pair.");
        // "A reservation already exists" and lineage conflicts are settled by
        // the server: reload so the existing reservation renders.
        if (result.status === 409) router.refresh();
        return;
      }
      // The route wraps the writer result: { reservation: { aggregate, replayed, ... } }.
      const reservation = result.payload?.reservation as
        | { replayed?: boolean; aggregate?: { identity?: { incomingTechnicianIds?: string[] } } }
        | undefined;
      setNotice(reservation?.replayed
        ? "This reservation was already recorded for the same incoming pair and window — no duplicate was created."
        : `Incoming pair reserved (${reservation?.aggregate?.identity?.incomingTechnicianIds?.length ?? 2} technicians). The v2 report workflow is now open for review and confirmation.`);
      form.reset();
      router.refresh();
    });
  };

  return <div className="space-y-6">
    <header className="space-y-1">
      <h1 className="text-2xl font-bold">Begin equal-technician handover (v2)</h1>
      <p className="text-sm">Outgoing shift {context.outgoingShiftId} · status {context.shiftStatus?.replaceAll("_", " ") ?? "unknown"} · permanent pair {context.permanentPairId ?? "—"}</p>
      <p className="text-sm">Scheduled {clock(context.outgoingWindow.scheduledStart)} – {clock(context.outgoingWindow.scheduledEnd)}</p>
    </header>

    {notice && <p role="status" aria-live="polite" className="rounded-xl border border-green-600 p-3 text-sm text-green-800">{notice}</p>}
    {error && <p role="alert" className="rounded-xl border border-red-600 p-3 text-sm text-red-700">{error}</p>}
    {missingEvidence.length > 0 && <section role="alert" aria-labelledby="v2-missing-evidence" className="rounded-xl border border-amber-600 p-3 text-sm">
      <h3 id="v2-missing-evidence" className="font-semibold">The handover has not started — record this mandatory evidence first:</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5">{missingEvidence.map(item => <li key={item}>{item}</li>)}</ul>
      <p className="mt-2">Add the missing records on the <a className="text-blue-600 underline" href="/technician/operations">shift operations page</a>, then begin the handover again. This shift is still active and operational edits remain open.</p>
    </section>}

    {context.step === "begin" && <section aria-labelledby="v2-begin-heading" className="space-y-3 rounded-xl border p-5">
      <h2 id="v2-begin-heading" className="text-lg font-semibold">Step 1 · Begin the handover</h2>
      <p className="text-sm">Beginning the handover moves this shift to <strong>handover pending</strong> and locks further operational edits. Either outgoing technician may do this exactly once; if your colleague begins it first this action replays their state instead of creating a second handover.</p>
      <p className="text-sm">All mandatory operational evidence (a verified broadcast observation for every station and outside-broadcast information or an explicit none declaration) must already be recorded — the server rejects an incomplete begin.</p>
      <button type="button" disabled={busy} onClick={begin} aria-busy={busy} className="rounded-lg bg-blue-700 p-3 text-white disabled:opacity-60">
        {busy ? "Working…" : "Begin handover"}
      </button>
    </section>}

    {context.step === "reserve" && <section aria-labelledby="v2-reserve-heading" className="space-y-3 rounded-xl border p-5">
      <h2 id="v2-reserve-heading" className="text-lg font-semibold">Step 2 · Reserve the incoming pair</h2>
      <p className="text-sm">The handover has begun. Reserve the incoming permanent pair and its shift window; this creates the v2 reservation and opens the consolidated report for review. The incoming shift itself is only activated when a reserved incoming technician accepts with their own password.</p>
      {candidates.length === 0
        ? <p className="text-sm">No other active permanent pair is available to receive this shift. A supervisor must create or activate a pair first.</p>
        : <form className="grid gap-3 sm:grid-cols-2" aria-busy={busy} onSubmit={event => { event.preventDefault(); void reserve(event.currentTarget as HTMLFormElement); }}>
          <fieldset disabled={busy} className="contents">
            <label className="text-sm">Incoming permanent pair
              <select className={field} name="pairId" required defaultValue="">
                <option value="">Select pair</option>
                {candidates.map(candidate => <option key={candidate.pairId} value={candidate.pairId}>{candidate.label}</option>)}
              </select>
            </label>
            <label className="text-sm">Shift type
              <select className={field} name="shiftType" defaultValue={suggested?.shiftType ?? "morning"}>
                <option value="morning">Morning</option>
                <option value="night">Night</option>
              </select>
            </label>
            <label className="text-sm">Incoming start (local time)
              <input className={field} name="start" type="datetime-local" required defaultValue={toLocalInputValue(suggested?.scheduledStart ?? null)} />
            </label>
            <label className="text-sm">Incoming end (local time)
              <input className={field} name="end" type="datetime-local" required defaultValue={toLocalInputValue(suggested?.scheduledEnd ?? null)} />
            </label>
            <button type="submit" disabled={busy} className="w-fit rounded-lg bg-blue-700 p-3 text-white disabled:opacity-60">
              {busy ? "Working…" : "Reserve incoming pair"}
            </button>
          </fieldset>
        </form>}
    </section>}

    {context.step === "unavailable" && <section aria-label="Initiation unavailable" className="space-y-2 rounded-xl border border-neutral-500 p-5 text-sm">
      <h2 className="font-semibold">This shift cannot start an equal-technician handover yet</h2>
      <ul className="space-y-1">{context.blockers.map(blocker => <li key={blocker}>• {blocker.replaceAll("_", " ")}</li>)}</ul>
      <p className="italic">These conditions are display-only. The server re-derives every authorization and prerequisite before it records anything.</p>
    </section>}

    <p className="text-sm">If you expected an existing handover, <button type="button" className="text-blue-600 underline" onClick={() => router.refresh()}>reload this view from the server</button>.</p>
  </div>;
}
