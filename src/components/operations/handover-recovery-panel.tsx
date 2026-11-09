"use client";

// Phase 8C.6 — the operator surface for abandoning a stalled equal handover.
//
// The panel is deliberately thin: it never decides authority, never derives a
// binding and never claims that an approval authorizes anything. It reads the
// classifier and the approval documents, then sends the same requests the
// runbook sends. Every refusal comes from the server and is shown verbatim.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";

import type {
  HandoverRecoveryApprovalV2EffectiveStatus,
  HandoverRecoveryApprovalV2Role,
  HandoverRecoveryApprovalV2View,
} from "@/types/handover-recovery-approval-v2";
import type {
  HandoverRecoveryEligibilityClassification,
  HandoverRecoveryEligibilityResult,
} from "@/types/handover-recovery-eligibility";

type ActorRole = "admin" | "supervisor";

type ExecutionStatus = {
  approvalId: string;
  handoverDocumentId: string;
  applied: boolean;
  auditId: string;
  executedBy: string | null;
  executedAt: string | null;
};

type ExecutionRead =
  | { state: "applied"; status: ExecutionStatus }
  | { state: "not_applied" }
  | { state: "disabled" }
  | { state: "error"; message: string };

type ActionKind = "request" | "countersign" | "void" | "reissue" | "execute";

type OpenAction = {
  kind: ActionKind;
  approvalId: string | null;
};

const ELIGIBILITY_LABELS: Record<HandoverRecoveryEligibilityClassification, string> = {
  eligible_for_abandonment_review: "Eligible for abandonment review",
  activation_window_open: "Activation window still open",
  acceptance_exists: "Acceptance evidence exists",
  acceptance_outcome_uncertain: "Acceptance outcome uncertain",
  inconsistent_evidence: "Inconsistent evidence",
  guard_binding_conflict: "Guard binding conflict",
  slot_binding_conflict: "Operational slot conflict",
  handover_not_applicable: "Handover not applicable",
  evidence_unverifiable: "Evidence unverifiable",
};

const EFFECTIVE_STATUS_LABELS: Record<HandoverRecoveryApprovalV2EffectiveStatus, string> = {
  awaiting_second_approval: "Awaiting second signature",
  fully_approved: "Fully approved",
  voided: "Voided",
  expired: "Expired",
};

const ROLE_LABELS: Record<HandoverRecoveryApprovalV2Role, string> = {
  supervisor: "Supervisor",
  admin: "Administrator",
};

const EXECUTION_COPY =
  "Executing cancels the outgoing shift administratively, releases the operational slot, ends roster membership without recording a clock-out, removes the shift from each technician's schedule, marks the handover cancelled and cancels the reservation guard. It writes no acceptance, attendance, membership or technician evidence, and it cannot be undone.";

class RecoveryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "RecoveryRequestError";
  }
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function getJson(url: string): Promise<{ response: Response; result: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  return { response, result: await readJson(response) };
}

async function fetchEligibility(handoverDocumentId: string): Promise<HandoverRecoveryEligibilityResult> {
  const { response, result } = await getJson(
    `/api/admin/recovery-eligibility?handoverDocumentId=${encodeURIComponent(handoverDocumentId)}`,
  );
  if (!response.ok) {
    throw new RecoveryRequestError(
      typeof result.error === "string" ? result.error : "Unable to classify this handover.",
      response.status,
      typeof result.code === "string" ? result.code : null,
    );
  }
  return result.eligibility as HandoverRecoveryEligibilityResult;
}

async function fetchApprovals(handoverDocumentId: string): Promise<HandoverRecoveryApprovalV2View[]> {
  const { response, result } = await getJson(
    `/api/admin/recovery-approvals-v2?handoverDocumentId=${encodeURIComponent(handoverDocumentId)}`,
  );
  if (!response.ok) {
    throw new RecoveryRequestError(
      typeof result.error === "string" ? result.error : "Unable to load recovery intents.",
      response.status,
      typeof result.code === "string" ? result.code : null,
    );
  }
  return Array.isArray(result.approvals)
    ? (result.approvals as HandoverRecoveryApprovalV2View[])
    : [];
}

async function fetchExecution(approvalId: string): Promise<ExecutionRead> {
  const { response, result } = await getJson(
    `/api/admin/recovery-approvals-v2/${encodeURIComponent(approvalId)}/execute`,
  );
  if (response.status === 404) return { state: "disabled" };
  if (!response.ok) {
    return {
      state: "error",
      message:
        typeof result.error === "string"
          ? result.error
          : "The execution status could not be read.",
    };
  }
  const execution = result.execution as ExecutionStatus | undefined;
  if (!execution) return { state: "error", message: "The execution status was not returned." };
  return execution.applied ? { state: "applied", status: execution } : { state: "not_applied" };
}

function Badge({ children, tone }: { children: ReactNode; tone: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {children}
    </span>
  );
}

function statusTone(status: HandoverRecoveryApprovalV2EffectiveStatus): string {
  switch (status) {
    case "fully_approved":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200";
    case "awaiting_second_approval":
      return "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200";
    case "voided":
      return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    case "expired":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200";
  }
}

function eligibilityTone(classification: HandoverRecoveryEligibilityClassification): string {
  return classification === "eligible_for_abandonment_review"
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
    : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <div className="mt-1 text-sm text-slate-800 dark:text-slate-100">{children}</div>
    </div>
  );
}

export function HandoverRecoveryPanel({
  handoverDocumentId,
  actorUid,
  actorRole,
}: {
  handoverDocumentId: string;
  actorUid: string;
  actorRole: ActorRole;
}) {
  const [eligibility, setEligibility] = useState<HandoverRecoveryEligibilityResult | null>(null);
  const [approvals, setApprovals] = useState<HandoverRecoveryApprovalV2View[]>([]);
  const [executions, setExecutions] = useState<Record<string, ExecutionRead>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const [action, setAction] = useState<OpenAction | null>(null);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(
    (): Promise<void> =>
      Promise.all([
        fetchEligibility(handoverDocumentId),
        fetchApprovals(handoverDocumentId),
      ])
        .then(async ([nextEligibility, nextApprovals]) => {
          setEligibility(nextEligibility);
          setApprovals(nextApprovals);
          setLoadError("");

          if (actorRole === "admin") {
            const fullyApproved = nextApprovals.filter(
              (view) => view.effectiveStatus === "fully_approved",
            );
            const reads = await Promise.all(
              fullyApproved.map(async (view) => {
                try {
                  return [view.approval.id, await fetchExecution(view.approval.id)] as const;
                } catch {
                  return [
                    view.approval.id,
                    { state: "error", message: "The execution status could not be read." } as const,
                  ] as const;
                }
              }),
            );
            setExecutions(Object.fromEntries(reads));
          } else {
            setExecutions({});
          }
        })
        .catch((error: unknown) => {
          setLoadError(
            error instanceof Error ? error.message : "Unable to load recovery state.",
          );
        })
        .finally(() => {
          setLoading(false);
          setRefreshing(false);
        }),
    [handoverDocumentId, actorRole],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ordered = useMemo(
    () => [...approvals].sort((left, right) => right.approval.requestedAt.localeCompare(left.approval.requestedAt)),
    [approvals],
  );
  // Any intent that is not voided still occupies the intent identity for the
  // current evidence: an expired one must be voided (then reissued) before a
  // fresh request is possible, so only a fully voided history reopens the form.
  const hasBlockingIntent = ordered.some((view) => view.effectiveStatus !== "voided");
  const eligible = eligibility?.classification === "eligible_for_abandonment_review";

  function openAction(kind: ActionKind, approvalId: string | null = null): void {
    setAction({ kind, approvalId });
    setReason("");
    setPassword("");
    setAcknowledged(false);
    setIdempotencyKey(newIdempotencyKey());
    setActionError("");
    setNotice("");
  }

  function closeAction(): void {
    setAction(null);
    setReason("");
    setPassword("");
    setAcknowledged(false);
    setActionError("");
  }

  async function submitAction(): Promise<void> {
    if (!action || busy) return;
    const trimmed = reason.trim();
    const needsReason = action.kind !== "countersign";
    const needsPassword = action.kind !== "execute";

    if (needsReason && trimmed.length < 10) {
      setActionError("Describe the reason in at least 10 characters.");
      return;
    }
    if (needsPassword && password.length === 0) {
      setActionError("Enter your current password to sign this request.");
      return;
    }
    if (action.kind === "execute" && !acknowledged) {
      setActionError("Confirm that you understand this cannot be undone.");
      return;
    }

    const approvalId = action.approvalId;
    const view = approvalId
      ? approvals.find((item) => item.approval.id === approvalId) ?? null
      : null;
    if (action.kind !== "request" && !view) {
      setActionError("This intent is no longer available. Refresh the panel.");
      return;
    }

    let url: string;
    let body: Record<string, unknown>;
    switch (action.kind) {
      case "request":
        url = "/api/admin/recovery-approvals-v2";
        body = {
          handoverDocumentId,
          reason: trimmed,
          idempotencyKey,
          password,
        };
        break;
      case "countersign":
        url = `/api/admin/recovery-approvals-v2/${encodeURIComponent(approvalId as string)}/approvals`;
        body = { expectedRevision: view!.approval.revision, password };
        break;
      case "void":
        url = `/api/admin/recovery-approvals-v2/${encodeURIComponent(approvalId as string)}/void`;
        body = { reason: trimmed, idempotencyKey, password };
        break;
      case "reissue":
        url = `/api/admin/recovery-approvals-v2/${encodeURIComponent(approvalId as string)}/reissue`;
        body = { reason: trimmed, idempotencyKey, password };
        break;
      case "execute":
        url = `/api/admin/recovery-approvals-v2/${encodeURIComponent(approvalId as string)}/execute`;
        body = { reason: trimmed, idempotencyKey };
        break;
    }

    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await readJson(response);

      if (!response.ok) {
        const message =
          typeof result.error === "string" ? result.error : "The request could not be completed.";
        const code = typeof result.code === "string" ? ` (${result.code})` : "";
        setActionError(`${message}${code}`);
        setPassword("");
        if (response.status === 409 || result.verificationRequired === true) {
          await refresh();
        }
        return;
      }

      const replayed = result.replayed === true;
      if (action.kind === "request") {
        setNotice(
          replayed
            ? "This exact intent was already recorded. The existing request is shown below."
            : "Recovery intent recorded. It needs the complementary role's signature before an administrator can execute it.",
        );
      } else if (action.kind === "countersign") {
        setNotice(
          replayed
            ? "This signature was already recorded. The existing approval is shown below."
            : "Second signature recorded. The intent is fully approved; an administrator can execute the recovery.",
        );
      } else if (action.kind === "void") {
        setNotice("Intent voided. Voiding is terminal; reissue it to create a new intent.");
      } else if (action.kind === "reissue") {
        setNotice("Intent reissued. The new intent needs both signatures before execution.");
      } else {
        setNotice(
          result.status === "already_applied"
            ? "This recovery was already applied. No further writes were made."
            : "Recovery executed. The outgoing shift was cancelled administratively and the handover is now terminal.",
        );
      }
      closeAction();
      await refresh();
    } catch {
      setActionError("The request could not be sent. Please try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  function renderActionForm(kind: ActionKind, approvalId: string | null) {
    const isOpen = action?.kind === kind && action.approvalId === approvalId;
    if (!isOpen) return null;
    const needsReason = kind !== "countersign";
    const needsPassword = kind !== "execute";
    return (
      <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
        {kind === "execute" ? (
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            {EXECUTION_COPY}
          </p>
        ) : null}
        {needsReason ? (
          <label className="mt-3 block text-sm">
            <span className="font-medium">
              {kind === "void"
                ? "Why is this intent being voided?"
                : kind === "reissue"
                  ? "Why is this intent being reissued?"
                  : kind === "execute"
                    ? "Execution reason"
                    : "Why does this handover need recovery?"}
            </span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={2000}
              className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:bg-slate-950"
            />
            <span className="text-xs text-slate-500">10–2000 characters. Stored with your identity.</span>
          </label>
        ) : null}
        {needsPassword ? (
          <label className="mt-3 block text-sm">
            <span className="font-medium">Your current password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="mt-1 w-full rounded-lg border bg-white px-3 py-2 dark:bg-slate-950"
            />
            <span className="text-xs text-slate-500">
              Reauthenticates you for this act only. It is never stored.
            </span>
          </label>
        ) : null}
        {kind === "execute" ? (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-1"
            />
            <span>
              I understand this abandons the handover, cancels the outgoing shift and cannot be
              undone.
            </span>
          </label>
        ) : null}
        {actionError ? (
          <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {actionError}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void submitAction()}
            disabled={
              busy ||
              (needsReason && reason.trim().length < 10) ||
              (needsPassword && password.length === 0) ||
              (kind === "execute" && !acknowledged)
            }
            className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Sending…" : kind === "execute" ? "Execute recovery" : "Sign and send"}
          </button>
          <button
            type="button"
            onClick={closeAction}
            disabled={busy}
            className="rounded-lg border bg-white px-4 py-2 text-sm font-medium dark:bg-slate-950"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function renderIntent(view: HandoverRecoveryApprovalV2View) {
    const record = view.approval;
    const execution = executions[record.id];
    const applied = execution?.state === "applied";
    const signedByActor = record.approvals.some((signature) => signature.actorUid === actorUid);
    const canCountersign =
      view.effectiveStatus === "awaiting_second_approval" &&
      view.requiredSecondRole === actorRole &&
      !signedByActor;
    const canVoid = view.effectiveStatus !== "voided" && signedByActor && !applied;
    const canReissue =
      view.effectiveStatus === "voided" &&
      record.reissuedAsApprovalId === null &&
      execution?.state !== "applied";

    return (
      <li key={record.id} className="rounded-lg border bg-slate-50 p-4 text-sm dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={statusTone(view.effectiveStatus)}>
            {EFFECTIVE_STATUS_LABELS[view.effectiveStatus]}
          </Badge>
          <span className="text-xs text-slate-500">revision {record.revision}</span>
        </div>
        <p className="mt-2">{record.reason}</p>
        <p className="mt-1 text-xs text-slate-500">
          Requested by {record.requestedBy} at {formatTimestamp(record.requestedAt)} · expires{" "}
          {formatTimestamp(record.expiresAt)}
        </p>
        {record.voidedBy ? (
          <p className="mt-1 text-xs text-slate-500">
            Voided by {record.voidedBy} at {formatTimestamp(record.voidedAt)}: {record.voidReason}
          </p>
        ) : null}

        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Signatures ({view.approvalCount}/2)
          </p>
          <ul className="mt-1 space-y-1">
            {record.approvals.map((signature) => (
              <li key={`${signature.actorUid}-${signature.approvedAt}`} className="text-xs text-slate-600 dark:text-slate-300">
                <span className="font-medium">{ROLE_LABELS[signature.actorRole]}</span>{" "}
                signed {formatTimestamp(signature.approvedAt)}
              </li>
            ))}
            {view.requiredSecondRole ? (
              <li className="text-xs text-amber-700">
                Waiting for a {ROLE_LABELS[view.requiredSecondRole].toLowerCase()} signature.
              </li>
            ) : null}
          </ul>
        </div>

        {view.effectiveStatus === "fully_approved" ? (
          <div className="mt-3 rounded-lg border bg-white p-3 text-xs dark:bg-slate-950">
            {actorRole === "supervisor" ? (
              <p className="text-slate-600 dark:text-slate-300">
                Fully approved. An administrator must execute the recovery; approval alone changes
                nothing.
              </p>
            ) : execution === undefined ? (
              <p className="text-slate-500">Reading the execution status…</p>
            ) : execution.state === "error" ? (
              <p className="text-red-700">{execution.message}</p>
            ) : execution.state === "disabled" ? (
              <p className="text-amber-700">
                Execution is not enabled on this deployment. The approval is recorded; use the
                recovery runbook if execution is intended.
              </p>
            ) : execution.state === "applied" ? (
              <p className="inline-flex items-center gap-2 font-medium text-emerald-700">
                <ShieldCheck className="h-4 w-4" />
                Recovery applied by {execution.status.executedBy ?? "an administrator"} at{" "}
                {formatTimestamp(execution.status.executedAt)}
              </p>
            ) : (
              <>
                <p className="text-slate-600 dark:text-slate-300">
                  Fully approved. Execution is available on this deployment and is a separate,
                  irreversible act.
                </p>
                <button
                  type="button"
                  onClick={() => openAction("execute", record.id)}
                  className="mt-2 rounded-lg border border-amber-700 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50 dark:text-amber-200 dark:hover:bg-amber-950"
                >
                  Execute recovery
                </button>
                {renderActionForm("execute", record.id)}
              </>
            )}
          </div>
        ) : null}

        {canCountersign ? (
          <>
            <button
              type="button"
              onClick={() => openAction("countersign", record.id)}
              className="mt-3 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Countersign as {ROLE_LABELS[actorRole].toLowerCase()}
            </button>
            {renderActionForm("countersign", record.id)}
          </>
        ) : null}

        {view.effectiveStatus === "awaiting_second_approval" && !canCountersign ? (
          <p className="mt-3 text-xs text-slate-500">
            {signedByActor
              ? "You signed this intent. A different person in the complementary role must sign it."
              : `A ${view.requiredSecondRole ? ROLE_LABELS[view.requiredSecondRole].toLowerCase() : "complementary role"} signature is required.`}
          </p>
        ) : null}

        {view.effectiveStatus === "expired" ? (
          <p className="mt-3 text-xs text-amber-700">
            This intent expired. It changes nothing; an approver must void it before a new intent
            can be issued.
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          {canReissue ? (
            <button
              type="button"
              onClick={() => openAction("reissue", record.id)}
              className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
            >
              Reissue intent
            </button>
          ) : null}
          {canVoid ? (
            <button
              type="button"
              onClick={() => openAction("void", record.id)}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              Void intent
            </button>
          ) : null}
        </div>
        {renderActionForm("void", record.id)}
        {renderActionForm("reissue", record.id)}
      </li>
    );
  }

  return (
    <section className="rounded-xl border bg-white p-5 shadow-sm dark:bg-slate-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Stalled-handover recovery
        </h3>
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            void refresh();
          }}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-950 dark:hover:bg-slate-900"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh recovery state
        </button>
      </div>

      <p className="mt-2 max-w-3xl text-xs text-slate-500">
        Abandoning a stalled equal handover needs one supervisor signature and one administrator
        signature on the same intent, each with that person&rsquo;s own password. An administrator
        then executes it. Signing records intent only; execution is the only step that changes an
        operational record.
      </p>

      {notice ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          {notice}
        </p>
      ) : null}
      {loadError ? (
        <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {loadError}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-3 text-sm text-slate-500">Classifying the current evidence…</p>
      ) : eligibility === null ? null : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Classification">
              <Badge tone={eligibilityTone(eligibility.classification)}>
                {ELIGIBILITY_LABELS[eligibility.classification]}
              </Badge>
              <p className="mt-1 text-xs text-slate-500">{eligibility.reason}</p>
            </Field>
            <Field label="Evaluated">
              <p className="text-sm">{formatTimestamp(eligibility.evaluatedAt)}</p>
              <p className="text-xs text-slate-500">
                This is a point-in-time classification, not an execution authorization.
              </p>
            </Field>
          </div>

          {eligibility.refusals.length > 0 ? (
            <details className="rounded-lg border bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              <summary className="cursor-pointer font-medium">
                Classification refusals ({eligibility.refusals.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {eligibility.refusals.map((refusal) => (
                  <li key={`${refusal.code}-${refusal.detail}`}>
                    <span className="font-mono text-[11px]">{refusal.code}</span> ·{" "}
                    {refusal.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {!eligible && ordered.length === 0 ? (
            <p className="inline-flex items-start gap-2 rounded-lg border bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              No recovery intent can be requested while the classifier reports this
              classification. The refusal list above is the evidence that blocks it.
            </p>
          ) : (
            <>
              {eligible && !hasBlockingIntent ? (
                <div>
                  <button
                    type="button"
                    onClick={() => openAction("request")}
                    className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white"
                  >
                    Request recovery intent
                  </button>
                  {renderActionForm("request", null)}
                </div>
              ) : null}

              {ordered.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No recovery intent has been recorded for this handover.
                </p>
              ) : (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Recovery intents ({ordered.length})
                  </p>
                  <ol className="mt-2 space-y-3">{ordered.map(renderIntent)}</ol>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
