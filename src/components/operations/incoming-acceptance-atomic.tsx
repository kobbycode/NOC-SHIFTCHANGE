"use client";
// 09M-R3B.2 Phase 6 — technician-facing atomic incoming acceptance.
//
// The panel NEVER falls back to the legacy split writer. It reads the
// technician's own receipt-backed status first, submits only the atomic
// endpoint with a freshly read reviewed binding, and treats any 503/unknown
// commit state as UNCONFIRMED (never as "acceptance failed"). A submission is
// only announced as successful when the persisted receipt reconciles
// (APPLIED_VALIDATED). The reservation guard is never closed automatically:
// after both validated acceptances a reserved incoming technician must
// explicitly finalize it.
import { useCallback, useEffect, useRef, useState } from "react";

const field = "block w-full rounded-lg border bg-transparent p-2";

const GUARD_STATE_LABELS: Record<string, string> = {
  awaiting_first_acceptance: "Awaiting the first incoming acceptance",
  awaiting_partner_acceptance: "Awaiting the partner's acceptance",
  eligible_for_normal_closure: "Both acceptances validated — eligible for normal closure",
  exceptional_closure_authorized: "Exceptional closure authorized (supervisor action required)",
  joining_window_expired: "Joining window expired",
  guard_finalized: "Reservation guard finalized",
  inconsistent_review_required: "Inconsistent history — administrator review required",
};

function stamp(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("en-GB", { timeZone: "Africa/Accra" }) : "—";
}
function short(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "—";
}

type AcceptanceStatus = {
  applied: boolean;
  outcome: string | null;
  receiptId: string | null;
  receiptHash: string | null;
  operationalAppliedAt: string | null;
  retryWouldReplay: boolean;
  requiresAdministrativeReview: boolean;
};

type StatusEnvelope = {
  success: boolean;
  error?: string;
  status?: string;
  reason?: string;
  guidance?: string;
  partnerApplied?: boolean;
  acceptance?: AcceptanceStatus;
  lifecycle?: {
    guardLifecycleState?: string | null;
    guardClosureState?: string | null;
    guardClosureReason?: string | null;
    outstandingTechnicianUids?: string[];
    guardTerminalEvidenceRef?: string | null;
  };
  diagnostics?: { attendancePresent?: boolean };
};

type ReportEnvelope = {
  success: boolean;
  error?: string;
  report?: {
    aggregate: { revision: number };
    snapshotHash: string;
    guard: { guardRevision: number; fencingEpoch: number } | null;
  };
};

type AcceptEnvelope = {
  success?: boolean;
  error?: string;
  code?: string;
  outcomeUnknown?: boolean;
  commitState?: string;
  retryable?: boolean;
  refreshStatus?: boolean;
  outcome?: string | null;
  replayed?: boolean;
  acceptance?: { receiptId?: string; receiptHash?: string; operationalAppliedAt?: string | null };
  reconciliation?: { status?: string; guidance?: string } | null;
};

type FinalizeEnvelope = {
  success?: boolean;
  error?: string;
  code?: string;
  outcomeUnknown?: boolean;
  commitState?: string;
  status?: string;
  replayed?: boolean;
  mode?: string;
  guard?: { revision?: number; terminalEvidenceRef?: string | null };
  audit?: { id?: string; state?: string };
};

type StatusState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; data: StatusEnvelope };

const OUTCOME_LABELS: Record<string, string> = {
  FIRST_ACTIVATION: "First activation — your acceptance activated the reserved incoming shift.",
  SUBSEQUENT_JOIN: "Subsequent join — you joined the already-active incoming shift.",
};

export function IncomingAcceptanceAtomicPanel({
  base,
  scheduledStart,
  lifecycleSignature,
  declaredLateReason,
  onAuthoritativeChange,
}: {
  base: string;
  scheduledStart: string;
  lifecycleSignature: string;
  declaredLateReason: string | null;
  onAuthoritativeChange: () => Promise<void>;
}) {
  const [statusState, setStatusState] = useState<StatusState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState("");
  const [statusNotice, setStatusNotice] = useState("");
  const [accepted, setAccepted] = useState<AcceptEnvelope | null>(null);
  const [lateReasonRequired, setLateReasonRequired] = useState(
    () => Date.now() > Date.parse(scheduledStart) + 5 * 60 * 1000,
  );
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");
  const [finalizeUnconfirmed, setFinalizeUnconfirmed] = useState("");
  const [finalizeDone, setFinalizeDone] = useState<FinalizeEnvelope | null>(null);
  const submitLock = useRef(false);
  const finalizeLock = useRef(false);

  const applyStatus = useCallback((result: StatusEnvelope, manual: boolean) => {
    setStatusState({ phase: "ready", data: result });
    if (!manual) return;
    if (result.acceptance?.requiresAdministrativeReview === true) {
      setUnconfirmed("");
      setStatusNotice("Status refreshed: an administrator must review this handover before any further action.");
    } else if (result.acceptance?.applied === true) {
      setUnconfirmed("");
      setStatusNotice("Status refreshed: your acceptance is recorded and validated.");
    } else if (result.lifecycle?.guardClosureState === "guard_finalized") {
      setUnconfirmed("");
      setStatusNotice("Status refreshed: this handover is closed, so no acceptance can be submitted.");
    } else if (result.status === "NOT_APPLIED") {
      // Only a deliberate, user-initiated status read may clear an
      // unconfirmed outcome; nothing here resubmits on its own.
      setUnconfirmed("");
      setStatusNotice("Status refreshed: no acceptance application is recorded for you. You may submit again when ready.");
    } else {
      setStatusNotice(`Status refreshed: ${result.status?.replaceAll("_", " ").toLowerCase() ?? "unknown"} — follow the guidance shown.`);
    }
  }, []);

  const fetchStatus = useCallback(async (): Promise<{ result: StatusEnvelope } | { error: string }> => {
    try {
      const response = await fetch(`${base}/accept/atomic/status`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const result = (await response.json()) as StatusEnvelope;
      if (!response.ok || !result.success) {
        return { error: result.error ?? "Acceptance status could not be read." };
      }
      return { result };
    } catch {
      return { error: "Acceptance status could not be read. Check the connection and refresh status." };
    }
  }, [base]);

  const readStatus = useCallback(async (manual: boolean) => {
    setStatusState({ phase: "loading" });
    if (manual) setStatusNotice("");
    const outcome = await fetchStatus();
    if ("error" in outcome) {
      setStatusState({ phase: "error", message: outcome.error });
      return;
    }
    applyStatus(outcome.result, manual);
  }, [applyStatus, fetchStatus]);

  // The automatic read happens after the request resolves, never by setting
  // state synchronously inside the effect; lifecycleSignature re-reads after an
  // authoritative change (for example a partner's acceptance).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const outcome = await fetchStatus();
      if (cancelled) return;
      if ("error" in outcome) {
        setStatusState({ phase: "error", message: outcome.error });
        return;
      }
      applyStatus(outcome.result, false);
    })();
    return () => { cancelled = true; };
  }, [applyStatus, fetchStatus, lifecycleSignature]);

  const data = statusState.phase === "ready" ? statusState.data : null;
  const acceptance = data?.acceptance ?? null;
  const applied = acceptance?.applied === true || accepted !== null;
  const guardState = data?.lifecycle?.guardClosureState ?? null;
  const outstandingGuardUids = data?.lifecycle?.outstandingTechnicianUids ?? [];
  const canOfferForm = data !== null && data.status === "NOT_APPLIED" &&
    acceptance?.requiresAdministrativeReview !== true &&
    guardState !== "guard_finalized";
  const effectiveLateRequired = declaredLateReason === null && lateReasonRequired;
  const receiptId = acceptance?.receiptId ?? accepted?.acceptance?.receiptId ?? null;
  const receiptHash = acceptance?.receiptHash ?? accepted?.acceptance?.receiptHash ?? null;
  const appliedAt = acceptance?.operationalAppliedAt ?? accepted?.acceptance?.operationalAppliedAt ?? null;
  const outcome = acceptance?.outcome ?? accepted?.outcome ?? null;

  const submit = async (form: HTMLFormElement) => {
    if (submitLock.current) return;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    const lateReason = String(values.get("lateReason") ?? "").trim();
    if (!password) { setFormError("Your own current password is required."); return; }
    if (effectiveLateRequired && !lateReason) {
      setFormError("A non-empty late-arrival reason is required for an acceptance more than five minutes after the scheduled start.");
      return;
    }
    submitLock.current = true; setBusy(true); setFormError(""); setUnconfirmed(""); setStatusNotice("");
    try {
      // A fresh authoritative binding is read immediately before the atomic
      // request so a partner's acceptance (which moves the aggregate revision)
      // cannot make this submission stale.
      const reportResponse = await fetch(`${base}/report`, { headers: { Accept: "application/json" }, cache: "no-store" });
      const reportResult = (await reportResponse.json()) as ReportEnvelope;
      if (!reportResponse.ok || !reportResult.success || !reportResult.report) {
        setFormError(reportResult.error ?? "The reviewed handover could not be re-read. No acceptance was sent.");
        return;
      }
      const report = reportResult.report;
      if (!report.guard) {
        setFormError("The reservation guard is unavailable. No acceptance was sent.");
        return;
      }
      const response = await fetch(`${base}/accept/atomic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: report.aggregate.revision,
          expectedSnapshotHash: report.snapshotHash,
          expectedGuardRevision: report.guard.guardRevision,
          expectedFencingEpoch: report.guard.fencingEpoch,
          password,
          // A declared absence reason is authoritative and is never re-typed or
          // overwritten; the body intentionally carries null for it.
          lateReason: declaredLateReason === null ? (lateReason || null) : null,
        }),
      });
      let result: AcceptEnvelope | null = null;
      try { result = (await response.json()) as AcceptEnvelope; }
      catch { result = null; }

      if (response.ok && result?.success) {
        if (result.reconciliation?.status === "APPLIED_VALIDATED") {
          setAccepted(result);
          form.reset();
          await onAuthoritativeChange();
          await readStatus(false);
        } else {
          // Committed but not independently verified — never claim success.
          setUnconfirmed("The acceptance request reached the server, but its persisted receipt could not be independently verified. Treat the outcome as UNCONFIRMED — do not submit again. Use “Refresh acceptance status”.");
        }
        return;
      }
      if (response.status === 503 || result?.outcomeUnknown === true) {
        setUnconfirmed("The acceptance outcome is UNCONFIRMED (no validated receipt was returned). This is NOT proof that acceptance failed. Do not submit again — refresh the acceptance status.");
        return;
      }
      if (result?.code === "LATE_REASON_REQUIRED") {
        setLateReasonRequired(true);
        setFormError(result.error ?? "A late-arrival reason is required.");
        return;
      }
      setFormError(result?.error ?? "The acceptance request was refused.");
      if (result?.refreshStatus === true) {
        setStatusNotice("The handover may have changed. Refresh the acceptance status before deciding what to do next.");
      }
    } catch {
      setUnconfirmed("The acceptance request could not be confirmed — the network response was lost. The outcome is UNCONFIRMED; do not submit again. Refresh the acceptance status.");
    } finally {
      submitLock.current = false; setBusy(false);
    }
  };

  const finalizeGuard = async () => {
    if (finalizeLock.current) return;
    finalizeLock.current = true; setFinalizeBusy(true); setFinalizeError(""); setFinalizeUnconfirmed("");
    try {
      const response = await fetch(`${base}/guard/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      let result: FinalizeEnvelope | null = null;
      try { result = (await response.json()) as FinalizeEnvelope; }
      catch { result = null; }
      if (response.ok && result?.success) {
        setFinalizeDone(result);
        await onAuthoritativeChange();
        await readStatus(false);
        return;
      }
      if (response.status === 503 || result?.outcomeUnknown === true) {
        setFinalizeUnconfirmed("The guard finalization outcome is UNCONFIRMED. This is not proof that it failed. Do not resubmit — reload the status.");
        return;
      }
      setFinalizeError(result?.error ?? "The guard could not be finalized.");
    } catch {
      setFinalizeUnconfirmed("The guard finalization response was lost. The outcome is UNCONFIRMED; reload the status instead of resubmitting.");
    } finally {
      finalizeLock.current = false; setFinalizeBusy(false);
    }
  };

  return <section aria-label="Accept handover atomically" className="space-y-3 rounded-xl border border-green-600 p-5">
    <h2 className="text-lg font-semibold">Accept handover with your own password</h2>
    <p className="text-sm">Acceptance is submitted through the atomic protocol: one transaction either produces a validated receipt or an explicit non-committed/unknown outcome. There is no fallback to the legacy acceptance writer.</p>
    <p className="text-sm text-neutral-600">Your password is verified server-side before any write and is never stored, logged or included in the receipt. A supervisor or an outgoing technician cannot accept this handover for you.</p>

    {statusState.phase === "loading" && <p className="text-sm" role="status">Reading your acceptance status…</p>}
    {statusState.phase === "error" && <div className="space-y-2 text-sm">
      <p role="alert" className="text-red-700">{statusState.message}</p>
      <button type="button" disabled={busy} onClick={() => void readStatus(true)} className="rounded-lg border p-2">Refresh acceptance status</button>
    </div>}

    {data !== null && <div className="rounded-lg border p-3 text-sm space-y-1">
      <p>Status: <strong>{applied ? "acceptance recorded and validated" : (data.status ?? "unknown").replaceAll("_", " ").toLowerCase()}</strong>{data.reason ? ` · ${data.reason.replaceAll("_", " ").toLowerCase()}` : ""}</p>
      {!applied && <p className="text-neutral-600">Guidance: {(data.guidance ?? "NONE").replaceAll("_", " ").toLowerCase()}.</p>}
      {data.partnerApplied !== undefined && <p>Partner acceptance: {data.partnerApplied ? "recorded" : "not yet recorded"}.</p>}
      {guardState && <p>Reservation guard: {GUARD_STATE_LABELS[guardState] ?? guardState.replaceAll("_", " ")}.</p>}
      {outstandingGuardUids.length > 0 && <p>Outstanding acceptance: {outstandingGuardUids.join(", ")}.</p>}
      <button type="button" disabled={busy || finalizeBusy} onClick={() => void readStatus(true)} className="rounded-lg border p-1 text-xs">Refresh acceptance status</button>
      {statusNotice && <p className="text-green-700">{statusNotice}</p>}
    </div>}

    {accepted !== null && <p className="text-sm text-green-700">Your acceptance has been recorded and independently validated.</p>}

    {unconfirmed && <div role="alert" className="rounded-lg border border-amber-500 p-3 text-sm space-y-2">
      <p className="font-semibold text-amber-800">Outcome unconfirmed</p>
      <p>{unconfirmed}</p>
      <button type="button" disabled={busy} onClick={() => void readStatus(true)} className="rounded-lg border p-2">Refresh acceptance status</button>
    </div>}

    {applied && <div className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-semibold">{outcome ? OUTCOME_LABELS[outcome] ?? outcome.replaceAll("_", " ").toLowerCase() : "Your acceptance is recorded."}</p>
      <p>Receipt {receiptId ?? "—"} · hash {short(receiptHash)} · operational application {stamp(appliedAt)}.</p>
      {acceptance?.retryWouldReplay === true && <p>A further attempt by you would replay this receipt; it cannot create a second application or attendance record.</p>}
      {data?.diagnostics?.attendancePresent === true
        ? <p>An attendance record for you exists on the incoming shift. Only that persisted record is authoritative for your clock time.</p>
        : <p className="text-neutral-600">The status read does not confirm an attendance record. No clock time is inferred or invented here.</p>}
      {data?.partnerApplied === false && <p className="text-neutral-600">Your partner has not accepted yet. The reservation guard remains active and is never closed automatically after the first acceptance.</p>}
    </div>}

    {applied && guardState === "eligible_for_normal_closure" && <div className="space-y-2 rounded-lg border border-green-600 p-3 text-sm">
      <p className="font-semibold">Both incoming acceptances are validated.</p>
      <p>The reservation guard is still active. A reserved incoming technician must finalize it explicitly — this never happens automatically.</p>
      <button type="button" disabled={finalizeBusy} onClick={() => void finalizeGuard()} className="w-fit rounded-lg bg-green-700 p-2 text-white">{finalizeBusy ? "Finalizing…" : "Finalize reservation guard"}</button>
    </div>}
    {applied && guardState === "guard_finalized" && <div className="rounded-lg border p-3 text-sm">
      <p className="font-semibold text-green-800">Reservation guard finalized.</p>
      <p>Terminal evidence {data?.lifecycle?.guardTerminalEvidenceRef ?? finalizeDone?.guard?.terminalEvidenceRef ?? "—"}{finalizeDone?.audit?.id ? ` · audit ${finalizeDone.audit.id}` : ""}.</p>
    </div>}
    {applied && guardState === "joining_window_expired" && <p className="text-sm text-neutral-600">The joining window has closed. Closing the guard now requires an authorized exceptional closure by a supervisor; a technician cannot declare it.</p>}
    {applied && guardState === "inconsistent_review_required" && <p role="alert" className="text-sm text-red-700">The records do not agree. Administrator review is required; do not resubmit.</p>}

    {applied && guardState === null && <p className="text-sm text-neutral-600">Guard state is not available from this status read. Refresh the acceptance status before taking further action.</p>}

    {(finalizeUnconfirmed || finalizeError) && <div role="alert" className="rounded-lg border border-amber-500 p-3 text-sm space-y-2">
      {finalizeUnconfirmed && <p>{finalizeUnconfirmed}</p>}
      {finalizeError && <p className="text-red-700">{finalizeError}</p>}
      <button type="button" disabled={busy} onClick={() => void readStatus(true)} className="rounded-lg border p-2">Refresh acceptance status</button>
    </div>}

    {!applied && canOfferForm && <form className="grid max-w-md gap-3" onSubmit={event => { event.preventDefault(); void submit(event.currentTarget as HTMLFormElement); }}>
      {declaredLateReason !== null
        ? <div className="rounded-lg border p-3 text-sm">
          <p className="font-semibold">Declared late arrival</p>
          <p>A colleague recorded that you had not yet arrived, with the reason: <strong>{declaredLateReason}</strong>. That declared reason is authoritative for this late acceptance and is submitted unchanged; you do not re-type it.</p>
        </div>
        : effectiveLateRequired && <label className="text-sm">Late-arrival reason (required — more than five minutes after the scheduled start)<input className={field} name="lateReason" required maxLength={1000}/></label>}
      <label className="text-sm">Your current password<input className={field} name="password" type="password" autoComplete="current-password" required maxLength={256}/></label>
      <button disabled={busy} className="w-fit rounded-lg bg-green-700 p-2 text-white">{busy ? "Submitting…" : "Accept and start my shift"}</button>
      <p className="text-sm text-neutral-600">The button is disabled while a submission is pending. After an unconfirmed outcome the form stays closed until you deliberately refresh the acceptance status.</p>
    </form>}

    {!applied && guardState === "guard_finalized" && <div className="rounded-lg border p-3 text-sm space-y-1">
      <p className="font-semibold">This handover is closed.</p>
      <p>The reservation guard is finalized, so no acceptance can be submitted now. If you were documented as not yet in, that declaration remains your only record for this handover — no acceptance, attendance or clock time is created for you.</p>
    </div>}

    {!applied && data !== null && !canOfferForm && guardState !== "guard_finalized" && <p className="text-sm text-neutral-600">
      {acceptance?.requiresAdministrativeReview
        ? "Your acceptance records are inconsistent and require administrator review. Do not submit again."
        : "Acceptance is not available from this state. Follow the status guidance above; if it persists, contact a supervisor."}
    </p>}

    {formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
  </section>;
}
