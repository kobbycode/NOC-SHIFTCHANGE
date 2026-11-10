"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { LifeBuoy, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";

import {
  HANDOVER_REVIEW_CASE_STATUSES,
  HANDOVER_REVIEW_DECISION_TYPES,
  type HandoverReviewAdjudicationEligibility,
  type HandoverReviewAdjudicationRecord,
  type HandoverReviewCaseStatus,
  type HandoverReviewClassification,
  type HandoverReviewDecisionType,
  type HandoverReviewProjection,
  type HandoverReviewQueueItem,
} from "@/types/handover-admin-review";
import { HandoverRecoveryPanel } from "@/components/operations/handover-recovery-panel";

// Phase 8C.2a — the mandated confirmation wording. An adjudication is an
// investigative finding about historical evidence; it must never be presented
// as a repair.
const ADJUDICATION_CONFIRMATION_TEXT =
  "This records an investigative finding. It does not reopen the original case, alter technician evidence, or recover the handover.";

const panelClass = "rounded-2xl border border-[var(--border)] bg-[var(--surface)]";
const secondaryButtonClass =
  "min-h-11 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--elevated)] focus-visible:outline-2 focus-visible:outline-[var(--foreground)] disabled:opacity-50";
const inputClass =
  "mt-1 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

const CLASSIFICATION_LABELS: Record<HandoverReviewClassification, string> = {
  not_reviewable: "Not reviewable",
  not_activated: "Not activated",
  awaiting_first_acceptance: "Awaiting first acceptance",
  awaiting_partner_acceptance: "Awaiting partner acceptance",
  eligible_for_normal_closure: "Normal closure available",
  joining_window_expired: "Joining window expired",
  completed_valid: "Completed — fully proven",
  completed_exceptional: "Completed — exceptional closure",
  inconsistent_review_required: "Inconsistent — review required",
};

const CLASSIFICATION_STYLES: Record<HandoverReviewClassification, string> = {
  not_reviewable: "bg-[var(--elevated)] text-[var(--foreground)]",
  not_activated: "bg-[var(--elevated)] text-[var(--foreground)]",
  awaiting_first_acceptance: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  awaiting_partner_acceptance: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  eligible_for_normal_closure: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
  joining_window_expired: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  completed_valid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  completed_exceptional: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
  inconsistent_review_required: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

const CASE_STATUS_LABELS: Record<HandoverReviewCaseStatus, string> = {
  open: "Open",
  under_investigation: "Under investigation",
  escalated: "Escalated",
  closed: "Closed",
};

const DECISION_LABELS: Record<HandoverReviewDecisionType, string> = {
  acknowledge_valid_completed_state: "Acknowledge valid completed state",
  mark_further_investigation: "Mark for further investigation",
  record_administrative_finding: "Record administrative finding",
  close_review_case: "Close review case without changing evidence",
  escalate: "Escalate review",
};

const POSITION_LABELS: Record<string, string> = {
  outgoing_tech_a: "Outgoing technician A",
  outgoing_tech_b: "Outgoing technician B",
  incoming_tech_a: "Incoming technician A",
  incoming_tech_b: "Incoming technician B",
};

class ReviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ReviewRequestError";
  }
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `review-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
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

async function fetchQueue(): Promise<HandoverReviewQueueItem[]> {
  const response = await fetch("/api/admin/handover-reviews", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  const result = await readJson(response);
  if (!response.ok) {
    throw new ReviewRequestError(
      typeof result.error === "string" ? result.error : "Unable to load the review queue.",
      response.status,
      typeof result.code === "string" ? result.code : null,
    );
  }
  return Array.isArray(result.queue) ? (result.queue as HandoverReviewQueueItem[]) : [];
}

async function fetchDetail(
  handoverDocumentId: string,
  signal?: AbortSignal,
): Promise<HandoverReviewProjection> {
  const response = await fetch(
    `/api/admin/handover-reviews/${encodeURIComponent(handoverDocumentId)}`,
    {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    },
  );
  const result = await readJson(response);
  if (!response.ok) {
    throw new ReviewRequestError(
      typeof result.error === "string" ? result.error : "Unable to load the review case.",
      response.status,
      typeof result.code === "string" ? result.code : null,
    );
  }
  return result.review as HandoverReviewProjection;
}

async function fetchAdjudicationEligibility(
  handoverDocumentId: string,
  signal?: AbortSignal,
): Promise<{
  eligibility: HandoverReviewAdjudicationEligibility;
  adjudications: HandoverReviewAdjudicationRecord[];
}> {
  const response = await fetch(
    `/api/admin/handover-reviews/${encodeURIComponent(handoverDocumentId)}/adjudication-eligibility`,
    {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    },
  );
  const result = await readJson(response);
  if (!response.ok) {
    throw new ReviewRequestError(
      typeof result.error === "string"
        ? result.error
        : "Unable to load the adjudication eligibility.",
      response.status,
      typeof result.code === "string" ? result.code : null,
    );
  }
  return {
    eligibility: result.eligibility as HandoverReviewAdjudicationEligibility,
    adjudications: Array.isArray(result.adjudications)
      ? (result.adjudications as HandoverReviewAdjudicationRecord[])
      : [],
  };
}

async function recordAdjudication(input: {
  handoverDocumentId: string;
  originalDecisionId: string;
  expectedCaseRevision: number;
  expectedFingerprint: string;
  idempotencyKey: string;
  finding: string;
}): Promise<{
  replayed: boolean;
  adjudication: HandoverReviewAdjudicationRecord;
  eligibility: HandoverReviewAdjudicationEligibility;
  review: HandoverReviewProjection;
}> {
  const response = await fetch(
    `/api/admin/handover-reviews/${encodeURIComponent(input.handoverDocumentId)}/adjudications`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalDecisionId: input.originalDecisionId,
        expectedCaseRevision: input.expectedCaseRevision,
        expectedFingerprint: input.expectedFingerprint,
        idempotencyKey: input.idempotencyKey,
        finding: input.finding,
      }),
    },
  );
  const result = await readJson(response);
  if (!response.ok) {
    throw new ReviewRequestError(
      typeof result.error === "string"
        ? result.error
        : "The adjudication could not be recorded.",
      response.status,
      typeof result.code === "string" ? result.code : null,
    );
  }
  return {
    replayed: result.replayed === true,
    adjudication: result.adjudication as HandoverReviewAdjudicationRecord,
    eligibility: result.eligibility as HandoverReviewAdjudicationEligibility,
    review: result.review as HandoverReviewProjection,
  };
}

function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: string;
}) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <div className="mt-1 text-sm text-[var(--foreground)]">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={`p-4 sm:p-5 ${panelClass}`}>
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function HandoverReviewWorkspace({ actorUid }: { actorUid: string }) {
  const recoveryDialog = useRef<HTMLDialogElement>(null);
  const [queue, setQueue] = useState<HandoverReviewQueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recoveryDocumentId, setRecoveryDocumentId] = useState("");
  const [recoveryTarget, setRecoveryTarget] = useState("");

  const [reviewCase, setReviewCase] = useState<{
    documentId: string;
    projection: HandoverReviewProjection;
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [decisionType, setDecisionType] = useState<HandoverReviewDecisionType | "">("");
  const [reason, setReason] = useState("");
  const [finding, setFinding] = useState("");
  const [resolutionSummary, setResolutionSummary] = useState("");
  const [escalationTarget, setEscalationTarget] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [decisionNotice, setDecisionNotice] = useState("");

  const [adjudicationLedger, setAdjudicationLedger] = useState<{
    documentId: string;
    eligibility: HandoverReviewAdjudicationEligibility;
    records: HandoverReviewAdjudicationRecord[];
  } | null>(null);
  const [adjudicationError, setAdjudicationError] = useState("");
  const [adjudicationNotice, setAdjudicationNotice] = useState("");
  const [adjudicationFormOpen, setAdjudicationFormOpen] = useState(false);
  const [adjudicationFinding, setAdjudicationFinding] = useState("");
  const [adjudicationAcknowledged, setAdjudicationAcknowledged] = useState(false);
  const [adjudicationKey, setAdjudicationKey] = useState(newIdempotencyKey);
  const [adjudicating, setAdjudicating] = useState(false);

  const resetDecisionForm = useCallback(() => {
    setDecisionType("");
    setReason("");
    setFinding("");
    setResolutionSummary("");
    setEscalationTarget("");
    setIdempotencyKey(newIdempotencyKey());
    setDecisionError("");
    setDecisionNotice("");
    setAdjudicationFormOpen(false);
    setAdjudicationFinding("");
    setAdjudicationAcknowledged(false);
    setAdjudicationKey(newIdempotencyKey());
    setAdjudicationError("");
    setAdjudicationNotice("");
  }, []);

  const loadQueue = useCallback(
    (current: string | null = null): Promise<void> =>
      fetchQueue()
        .then((items) => {
          const next =
            current && items.some((item) => item.handoverDocumentId === current)
              ? current
              : (items[0]?.handoverDocumentId ?? null);
          setQueue(items);
          setQueueError("");
          setQueueLoading(false);
          if (next !== current) {
            resetDecisionForm();
            setDetailLoading(true);
          }
          setSelectedId(next);
        })
        .catch((error: unknown) => {
          setQueueLoading(false);
          setQueueError(
            error instanceof Error
              ? error.message
              : "Unable to load the review queue.",
          );
        }),
    [resetDecisionForm],
  );

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const review =
    reviewCase?.documentId === selectedId ? reviewCase.projection : null;

  useEffect(() => {
    if (!selectedId) return undefined;
    const controller = new AbortController();
    fetchDetail(selectedId, controller.signal)
      .then((projection) => {
        if (controller.signal.aborted) return;
        setReviewCase({ documentId: selectedId, projection });
        setDetailError("");
        setDetailLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetailError(
          error instanceof Error ? error.message : "Unable to load the review case.",
        );
        setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId]);

  const reviewCaseStatus = review?.caseStatus ?? null;
  const adjudication =
    adjudicationLedger && adjudicationLedger.documentId === selectedId
      ? adjudicationLedger
      : null;

  useEffect(() => {
    if (!selectedId || reviewCaseStatus !== HANDOVER_REVIEW_CASE_STATUSES.CLOSED) {
      return undefined;
    }
    const controller = new AbortController();
    fetchAdjudicationEligibility(selectedId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setAdjudicationLedger({
          documentId: selectedId,
          eligibility: result.eligibility,
          records: result.adjudications,
        });
        setAdjudicationError("");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAdjudicationError(
          error instanceof Error
            ? error.message
            : "Unable to load the adjudication eligibility.",
        );
      });
    return () => controller.abort();
  }, [selectedId, reviewCaseStatus]);

  const allowedDecisions = useMemo(
    () => review?.allowedDecisions ?? [],
    [review],
  );
  const activeDecisionType: HandoverReviewDecisionType | "" =
    allowedDecisions.includes(decisionType as HandoverReviewDecisionType)
      ? decisionType
      : (allowedDecisions[0] ?? "");

  async function reloadDetail(): Promise<void> {
    if (!selectedId) return;
    setDetailLoading(true);
    try {
      const projection = await fetchDetail(selectedId);
      setReviewCase({ documentId: selectedId, projection });
      setDetailError("");
    } catch (error) {
      setDetailError(
        error instanceof Error ? error.message : "Unable to refresh the review case.",
      );
    } finally {
      setDetailLoading(false);
    }
  }

  async function submitDecision(): Promise<void> {
    if (!selectedId || !review || !activeDecisionType || submitting) return;
    setSubmitting(true);
    setDecisionError("");
    setDecisionNotice("");

    try {
      const response = await fetch(
        `/api/admin/handover-reviews/${encodeURIComponent(selectedId)}/decisions`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decisionType: activeDecisionType,
            idempotencyKey,
            expectedCaseRevision: review.caseRevision,
            expectedFingerprint: review.evidenceFingerprint,
            reason,
            finding:
              activeDecisionType === HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING
                ? finding
                : null,
            resolutionSummary:
              activeDecisionType === HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE
                ? resolutionSummary
                : null,
            escalationTarget:
              activeDecisionType === HANDOVER_REVIEW_DECISION_TYPES.ESCALATE
                ? escalationTarget
                : null,
          }),
        },
      );
      const result = await readJson(response);

      if (!response.ok) {
        const message =
          typeof result.error === "string"
            ? result.error
            : "The review decision could not be recorded.";
        setDecisionError(message);
        if (response.status === 409 && result.code === "REVIEW_DECISION_STALE") {
          await reloadDetail();
        }
        return;
      }

      if (result.review) {
        setReviewCase({
          documentId: selectedId,
          projection: result.review as HandoverReviewProjection,
        });
      }
      setDecisionNotice(
        result.replayed === true
          ? "This decision was already recorded. The existing record is shown below."
          : "Decision recorded. No operational evidence was changed.",
      );
      setIdempotencyKey(newIdempotencyKey());
      setReason("");
      setFinding("");
      setResolutionSummary("");
      setEscalationTarget("");
      void loadQueue(selectedId);
    } catch {
      setDecisionError("The review decision could not be sent. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function refreshAdjudicationLedger(): Promise<void> {
    if (!selectedId) return;
    try {
      const result = await fetchAdjudicationEligibility(selectedId);
      setAdjudicationLedger({
        documentId: selectedId,
        eligibility: result.eligibility,
        records: result.adjudications,
      });
    } catch (error) {
      setAdjudicationError(
        error instanceof Error
          ? error.message
          : "Unable to refresh the adjudication history.",
      );
    }
  }

  async function submitAdjudication(): Promise<void> {
    const ledger = adjudicationLedger;
    const originalDecision = ledger?.eligibility.acknowledgedDecision ?? null;
    if (
      !selectedId ||
      !review ||
      !ledger ||
      !originalDecision ||
      !ledger.eligibility.eligible ||
      adjudicating
    ) {
      return;
    }
    if (adjudicationFinding.trim().length < 10) {
      setAdjudicationError("Describe the finding in at least 10 characters.");
      return;
    }
    if (!adjudicationAcknowledged) {
      setAdjudicationError(
        "Confirm that you understand this records an investigative finding only.",
      );
      return;
    }

    setAdjudicating(true);
    setAdjudicationError("");
    setAdjudicationNotice("");

    try {
      const result = await recordAdjudication({
        handoverDocumentId: selectedId,
        originalDecisionId: originalDecision.id,
        expectedCaseRevision: review.caseRevision,
        expectedFingerprint: review.evidenceFingerprint,
        idempotencyKey: adjudicationKey,
        finding: adjudicationFinding,
      });

      setReviewCase({ documentId: selectedId, projection: result.review });
      setAdjudicationLedger({
        documentId: selectedId,
        eligibility: result.eligibility,
        records: ledger.records.some((record) => record.id === result.adjudication.id)
          ? ledger.records
          : [result.adjudication, ...ledger.records],
      });
      setAdjudicationNotice(
        result.replayed
          ? "This adjudication was already recorded by this administrator. The original record is unchanged."
          : "Adjudication recorded. No operational evidence, review case or review decision was changed.",
      );
      setAdjudicationFormOpen(false);
      setAdjudicationFinding("");
      setAdjudicationAcknowledged(false);
      setAdjudicationKey(newIdempotencyKey());
      void refreshAdjudicationLedger();
      void loadQueue(selectedId);
    } catch (error) {
      setAdjudicationError(
        error instanceof Error
          ? error.message
          : "The adjudication could not be recorded.",
      );
      if (error instanceof ReviewRequestError && error.status === 409) {
        await reloadDetail();
        await refreshAdjudicationLedger();
        if (
          error.code === "ADJUDICATION_IDEMPOTENCY_CONFLICT" ||
          error.code === "ADJUDICATION_ALREADY_RECORDED"
        ) {
          setAdjudicationKey(newIdempotencyKey());
        }
      }
    } finally {
      setAdjudicating(false);
    }
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wider text-[var(--muted)] uppercase">
            Administration
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Handover Review</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
            Inspect completed handovers and record administrative findings. Operational evidence is read-only.
          </p>
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => recoveryDialog.current?.showModal()}
          className="btn-accent inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold"
        >
          <LifeBuoy size={17} aria-hidden="true" />
          Find stalled handover
        </button>
      </header>

      <dialog
        ref={recoveryDialog}
        aria-labelledby="handover-recovery-title"
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-2xl backdrop:bg-black/60 sm:p-6"
      >
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)]">
            <LifeBuoy size={19} aria-hidden="true" />
          </span>
          <h2 id="handover-recovery-title" className="text-lg font-semibold">Find stalled handover</h2>
        </div>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Look up a handover that may be missing from the review queue. The recovery panel checks its eligibility.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = recoveryDocumentId.trim();
            if (!trimmed) return;
            setRecoveryTarget(trimmed);
            recoveryDialog.current?.close();
          }}
          className="mt-4 space-y-4"
        >
          <label className="block text-sm font-medium">
            Handover document ID
            <input
              required
              value={recoveryDocumentId}
              onChange={(event) => setRecoveryDocumentId(event.target.value)}
              placeholder="handover_v2_…"
              className={`font-mono ${inputClass}`}
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => recoveryDialog.current?.close()}
              className={`px-4 ${secondaryButtonClass}`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={recoveryDocumentId.trim().length === 0}
              className="btn-accent min-h-11 rounded-lg px-4 text-sm font-semibold disabled:opacity-50"
            >
              Open recovery
            </button>
          </div>
        </form>
      </dialog>

      {recoveryTarget && (
        <section aria-labelledby="direct-recovery-title" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="direct-recovery-title" className="font-semibold">Direct recovery lookup</h2>
            <button
              type="button"
              onClick={() => {
                setRecoveryTarget("");
                setRecoveryDocumentId("");
              }}
              className={`px-4 ${secondaryButtonClass}`}
            >
              Close recovery
            </button>
          </div>
          <HandoverRecoveryPanel
            handoverDocumentId={recoveryTarget}
            actorUid={actorUid}
            actorRole="admin"
          />
        </section>
      )}

      <div className={`grid items-start gap-4 ${selectedId ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" : ""}`}>
        <section aria-labelledby="review-queue-title" className={`min-w-0 overflow-hidden ${panelClass}`}>
          <div className="flex items-center justify-between gap-3 p-4 sm:px-5">
            <div>
              <h2 id="review-queue-title" className="font-semibold">Review queue</h2>
              {((!queueLoading && !queueError) || queue.length > 0) && (
                <p className="mt-1 text-sm tabular-nums text-[var(--muted)]">
                  {queue.length} {queue.length === 1 ? "case" : "cases"}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="Refresh review queue"
              disabled={queueLoading}
              onClick={() => {
                setQueueLoading(true);
                void loadQueue(selectedId);
                void reloadDetail();
              }}
              className={`grid size-11 shrink-0 place-items-center ${secondaryButtonClass}`}
            >
              <RefreshCw size={18} aria-hidden="true" className={queueLoading ? "motion-safe:animate-spin" : undefined} />
            </button>
          </div>

          {queueError && (
            <p role="alert" className="border-t border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {queueError}
            </p>
          )}

          {queueLoading && queue.length === 0 ? (
            <p role="status" className="border-t border-[var(--border)] p-4 text-sm text-[var(--muted)]">
              Loading review queue…
            </p>
          ) : queue.length === 0 ? (
            !queueError && (
              <div className="flex items-start gap-3 border-t border-[var(--border)] p-4 sm:p-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--elevated)] text-emerald-700 dark:text-emerald-300">
                  <ShieldCheck size={19} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-semibold">No handovers in the review queue</p>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Completed handovers appear here after the shift ends. Exceptions and expired joining windows appear first.
                  </p>
                </div>
              </div>
            )
          ) : (
            <ul className="max-h-80 divide-y divide-[var(--border)] overflow-y-auto border-t border-[var(--border)] xl:max-h-[36rem]">
              {queue.map((item) => {
                const selected = item.handoverDocumentId === selectedId;
                return (
                  <li key={item.handoverDocumentId}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        if (selected) return;
                        resetDecisionForm();
                        setDetailError("");
                        setDetailLoading(true);
                        setSelectedId(item.handoverDocumentId);
                      }}
                      className={`w-full border-l-2 px-4 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--foreground)] sm:px-5 ${
                        selected
                          ? "border-[var(--accent)] bg-[var(--elevated)]"
                          : "border-transparent hover:bg-[var(--elevated)]"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                        <p className="text-sm font-semibold">
                          {item.shiftType === "night" ? "Night" : "Morning"} handover
                        </p>
                        <span className="text-xs font-medium text-[var(--muted)]">
                          {CASE_STATUS_LABELS[item.caseStatus]}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {formatTimestamp(item.scheduledStart)} → {formatTimestamp(item.scheduledEnd)}
                      </p>
                      <div className="mt-2">
                        <Badge tone={CLASSIFICATION_STYLES[item.classification]}>
                          {CLASSIFICATION_LABELS[item.classification]}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-[var(--muted)]">
                        {item.reviewReasons[0]?.message ??
                          "No review reason is raised; this completion is fully proven."}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Case evidence" hidden={!selectedId} className="min-w-0 space-y-5">
          {!selectedId ? null : detailLoading && review === null ? (
            <p role="status" className={`p-5 text-sm text-[var(--muted)] ${panelClass}`}>
              Loading case evidence…
            </p>
          ) : detailError ? (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {detailError}
            </p>
          ) : review === null ? (
            <p className={`p-5 text-sm text-[var(--muted)] ${panelClass}`}>
              The case could not be displayed.
            </p>
          ) : (
            <>
              <section className={`p-4 sm:p-5 ${panelClass}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={CLASSIFICATION_STYLES[review.classification]}>
                        {CLASSIFICATION_LABELS[review.classification]}
                      </Badge>
                      <Badge tone="bg-[var(--elevated)] text-[var(--foreground)]">
                        Case: {CASE_STATUS_LABELS[review.caseStatus]}
                      </Badge>
                      <span className="text-xs text-[var(--muted)]">
                        revision {review.caseRevision}
                      </span>
                    </div>
                    <h2 className="mt-3 text-lg font-semibold">
                      {review.shiftType === "night" ? "Night" : "Morning"} handover review
                    </h2>
                  </div>
                  <div className="text-right text-xs text-[var(--muted)]">
                    <p>Reviewed at</p>
                    <p className="font-medium">{formatTimestamp(review.generatedAt)}</p>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label="Outgoing shift">
                    <p className="text-xs text-[var(--muted)]">
                      Status: {review.shifts.outgoing.status ?? "unknown"}
                    </p>
                  </Field>
                  <Field label="Incoming shift">
                    <p className="text-xs text-[var(--muted)]">
                      Status: {review.shifts.incoming.status ?? "unknown"}
                    </p>
                  </Field>
                  <Field label="Scheduled window">
                    <p>{formatTimestamp(review.scheduledStart)}</p>
                    <p className="text-xs text-[var(--muted)]">to {formatTimestamp(review.scheduledEnd)}</p>
                  </Field>
                  <Field label="Handover lifecycle">
                    <p>{review.aggregateLifecycleStatus.replaceAll("_", " ")}</p>
                    <p className="text-xs text-[var(--muted)]">
                      Aggregate revision {review.aggregateRevision}
                    </p>
                  </Field>
                  <Field label="Guard lifecycle">
                    <p>{review.guardLifecycleState ?? "unavailable"}</p>
                    <p className="text-xs text-[var(--muted)]">
                      {review.guardLifecycleReason ?? "no reason"}
                    </p>
                  </Field>
                  <Field label="Reservation guard">
                    {review.guard ? (
                      <>
                        <p className="text-xs text-[var(--muted)]">
                          {review.guard.ownerLifecycleState} · revision {review.guard.guardRevision} ·
                          fencing {review.guard.fencingEpoch}
                        </p>
                        <p className="text-xs text-[var(--muted)]">
                          Finalization audit: {review.guard.finalizationAuditPresent ? "present" : "absent"}
                        </p>
                      </>
                    ) : (
                      <p className="text-amber-700 dark:text-amber-300">No readable reservation guard.</p>
                    )}
                  </Field>
                </div>
              </section>

              <HandoverRecoveryPanel
                handoverDocumentId={review.handoverDocumentId}
                actorUid={actorUid}
                actorRole="admin"
              />

              <Section title="Activation and frozen report">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Activation receipt">
                    <p className="text-xs text-[var(--muted)]">
                      Present: {review.activation.present ? "yes" : "no"} · Valid:{" "}
                      {review.activation.valid ? "yes" : "no"}
                    </p>
                    <p className="text-xs text-[var(--muted)]">
                      Activated at: {formatTimestamp(review.activation.activatedAt)}
                    </p>
                    {review.activation.message ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{review.activation.message}</p>
                    ) : null}
                  </Field>
                  <Field label="Frozen v2 report">
                    <p className="text-xs text-[var(--muted)]">
                      Binding valid: {review.report.valid ? "yes" : "no"}
                    </p>
                    {review.report.message ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{review.report.message}</p>
                    ) : null}
                  </Field>
                </div>
              </Section>

              <Section title="Reserved participants">
                <ul className="grid gap-3 sm:grid-cols-2">
                  {review.participants.map((participant) => (
                    <li
                      key={participant.position}
                      className="rounded-lg border border-[var(--border)] bg-[var(--elevated)] p-3"
                    >
                      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                        {POSITION_LABELS[participant.position] ?? participant.position}
                      </p>
                      <p className="mt-1 text-sm font-medium">
                        {participant.fullName ?? "Unnamed account"}
                      </p>
                    </li>
                  ))}
                </ul>
              </Section>

              <Section title="Personal acceptance evidence">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-[var(--muted)]">
                        <th className="pb-2 pr-4">Technician</th>
                        <th className="pb-2 pr-4">Verification</th>
                        <th className="pb-2 pr-4">Receipt</th>
                        <th className="pb-2 pr-4">Artifacts</th>
                        <th className="pb-2">Declared not yet in</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {review.applications.map((application) => (
                        <tr key={application.technicianUid} className="align-top">
                          <td className="py-3 pr-4">
                            <p className="font-medium">
                              {application.fullName ?? "Unnamed account"}
                            </p>
                            <p className="text-xs text-[var(--muted)]">
                              {POSITION_LABELS[application.position] ?? application.position}
                            </p>
                          </td>
                          <td className="py-3 pr-4">
                            <p className="font-medium">{application.verificationStatus.replaceAll("_", " ")}</p>
                            {application.verificationCode ? (
                              <p className="font-mono text-[11px] text-[var(--muted)]">
                                {application.verificationCode}
                              </p>
                            ) : null}
                            {application.verificationMessage ? (
                              <p className="mt-1 max-w-xs text-xs text-[var(--muted)]">
                                {application.verificationMessage}
                              </p>
                            ) : null}
                          </td>
                          <td className="py-3 pr-4 text-xs text-[var(--muted)]">
                            <p>{application.receiptPresent ? "present" : "absent"}</p>
                            <p>Outcome: {application.outcome ?? "—"}</p>
                            <p>Applied: {formatTimestamp(application.operationalAppliedAt)}</p>
                          </td>
                          <td className="py-3 pr-4 text-xs text-[var(--muted)]">
                            <p>Evidence: {application.evidencePresent ? "yes" : "no"}</p>
                            <p>Operation finalized: {application.operationFinalized ? "yes" : "no"}</p>
                            <p>Membership: {application.membershipPresent ? "yes" : "no"}</p>
                            <p>Attendance: {application.attendancePresent ? "yes" : "no"}</p>
                            <p>Application audit: {application.applicationAuditPresent ? "yes" : "no"}</p>
                          </td>
                          <td className="py-3 text-xs text-[var(--muted)]">
                            {application.declaredNotYetIn ? "yes" : "no"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section title="Reasons for review">
                {review.reviewReasons.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">
                    No review reason is raised by the current evidence.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {review.reviewReasons.map((item) => (
                      <li
                        key={`${item.code}-${item.subjectUid ?? "handover"}`}
                        className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
                      >
                        <p className="font-mono text-xs">{item.code}</p>
                        <p className="mt-1">{item.message}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {review.absences.length > 0 ? (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                      Recorded absences
                    </p>
                    <ul className="mt-2 space-y-2 text-sm">
                      {review.absences.map((absence) => (
                        <li key={`${absence.technicianUid}-${absence.absenceType}`}>
                          <span className="font-medium">{absence.absenceType.replaceAll("_", " ")}</span>{" "}
                          — {absence.reason} (recorded by{" "}
                          {absence.recordedBy} at {formatTimestamp(absence.recordedAt)})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Section>

              {reviewCaseStatus === HANDOVER_REVIEW_CASE_STATUSES.CLOSED ? (
                <Section title="Historical integrity concern">
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    A closed review case cannot take another administrative decision. If
                    live authoritative evidence now contradicts the acknowledgement that
                    closed it, an adjudication records that contradiction as an
                    investigative finding only: it does not reopen the case, alter
                    technician evidence, or recover the handover.
                  </div>

                  <div
                    role="status"
                    aria-live="polite"
                    className={
                      adjudicationNotice
                        ? "mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                        : "sr-only"
                    }
                  >
                    {adjudicationNotice}
                  </div>
                  {adjudicationError ? (
                    <p
                      role="alert"
                      className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                    >
                      {adjudicationError}
                    </p>
                  ) : null}

                  {!adjudication ? (
                    <p className="mt-4 text-sm text-[var(--muted)]">
                      {adjudicationError
                        ? "Adjudication eligibility is unavailable for this case."
                        : "Checking historical integrity…"}
                    </p>
                  ) : (
                    <div className="mt-4 space-y-5">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Original decision">
                          {adjudication.eligibility.acknowledgedDecision ? (
                            <>
                              <p>
                                {DECISION_LABELS[
                                  adjudication.eligibility.acknowledgedDecision.decisionType
                                ]}
                              </p>
                              <p className="text-xs text-[var(--muted)]">
                                Recorded{" "}
                                {formatTimestamp(
                                  adjudication.eligibility.acknowledgedDecision.recordedAt,
                                )}
                              </p>
                              <p className="text-xs text-[var(--muted)]">
                                Case after:{" "}
                                {
                                  CASE_STATUS_LABELS[
                                    adjudication.eligibility.acknowledgedDecision.caseStatusAfter
                                  ]
                                }{" "}
                                · revision{" "}
                                {adjudication.eligibility.acknowledgedDecision.caseRevisionAfter}
                              </p>
                              <p className="text-xs text-[var(--muted)]">
                                Classification:{" "}
                                {CLASSIFICATION_LABELS[
                                  adjudication.eligibility.acknowledgedDecision.classification
                                ]}
                              </p>
                            </>
                          ) : (
                            <p className="text-amber-700 dark:text-amber-300">
                              No acknowledged closing decision is recorded for this case.
                            </p>
                          )}
                        </Field>
                        <Field label="Evidence comparison">
                          <p className="text-xs text-[var(--muted)]">Previous classification</p>
                          <p>
                            {adjudication.eligibility.previousClassification
                              ? CLASSIFICATION_LABELS[
                                  adjudication.eligibility.previousClassification
                                ]
                              : "—"}
                          </p>
                          <p className="mt-2 text-xs text-[var(--muted)]">Current classification</p>
                          <p>
                            {CLASSIFICATION_LABELS[
                              adjudication.eligibility.currentClassification
                            ]}
                          </p>
                        </Field>
                      </div>

                      {adjudication.eligibility.evidenceReferences.length > 0 ? (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                            Verified contradiction
                          </p>
                          <ul className="mt-2 space-y-2">
                            {adjudication.eligibility.evidenceReferences.map((reference) => (
                              <li
                                key={`${reference.code}-${reference.subjectUid ?? "handover"}`}
                                className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                              >
                                <p className="font-mono text-xs">{reference.code}</p>
                                <p className="mt-1">{reference.message}</p>
                                <ul className="mt-2 space-y-1">
                                  {reference.references.map((path) => (
                                    <li
                                      key={path}
                                      className="break-all font-mono text-[11px] text-red-800/80 dark:text-red-300/80"
                                    >
                                      {path}
                                    </li>
                                  ))}
                                </ul>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {adjudication.eligibility.eligible ? (
                        adjudicationFormOpen ? (
                          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
                            <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                              {ADJUDICATION_CONFIRMATION_TEXT}
                            </p>
                            <label className="mt-4 block text-sm">
                              <span className="font-medium">Investigative finding</span>
                              <textarea
                                value={adjudicationFinding}
                                onChange={(event) => setAdjudicationFinding(event.target.value)}
                                rows={3}
                                maxLength={2000}
                                className={inputClass}
                                placeholder="Describe the contradiction you are recording."
                              />
                              <span className="text-xs text-[var(--muted)]">
                                10–2000 characters. Stored with your administrator identity.
                              </span>
                            </label>
                            <label className="mt-3 flex items-start gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={adjudicationAcknowledged}
                                onChange={(event) =>
                                  setAdjudicationAcknowledged(event.target.checked)
                                }
                                className="mt-1"
                              />
                              <span>
                                I understand this records an investigative finding and does
                                not change any operational record.
                              </span>
                            </label>
                            <div className="mt-4 flex flex-wrap items-center gap-3">
                              <button
                                type="button"
                                onClick={() => void submitAdjudication()}
                                disabled={
                                  adjudicating ||
                                  !adjudicationAcknowledged ||
                                  adjudicationFinding.trim().length < 10
                                }
                                className="btn-accent rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {adjudicating ? "Recording…" : "Confirm and record adjudication"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setAdjudicationFormOpen(false);
                                  setAdjudicationFinding("");
                                  setAdjudicationAcknowledged(false);
                                  setAdjudicationError("");
                                }}
                                className={`px-4 ${secondaryButtonClass}`}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                setAdjudicationError("");
                                setAdjudicationNotice("");
                                setAdjudicationFormOpen(true);
                              }}
                              className="rounded-lg border border-amber-700 px-4 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-50 dark:text-amber-200 dark:hover:bg-amber-950"
                            >
                              Record adjudication
                            </button>
                            <span className="text-xs text-[var(--muted)]">
                              Adds an immutable investigative record. Nothing else changes.
                            </span>
                          </div>
                        )
                      ) : (
                        <p className="rounded-lg border border-[var(--border)] bg-[var(--elevated)] p-3 text-sm text-[var(--muted)]">
                          {adjudication.eligibility.message}
                          {adjudication.eligibility.ineligibleCode ? (
                            <span className="ml-2 font-mono text-[11px] text-[var(--muted)]">
                              {adjudication.eligibility.ineligibleCode}
                            </span>
                          ) : null}
                        </p>
                      )}

                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                          Adjudication history ({adjudication.records.length})
                        </p>
                        {adjudication.records.length === 0 ? (
                          <p className="mt-2 text-sm text-[var(--muted)]">
                            No adjudication has been recorded for this handover.
                          </p>
                        ) : (
                          <ol className="mt-2 space-y-3">
                            {adjudication.records.map((record) => (
                              <li
                                key={record.id}
                                className="rounded-lg border border-[var(--border)] bg-[var(--elevated)] p-3 text-sm"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="font-semibold">Adjudication recorded</p>
                                  <p className="text-xs text-[var(--muted)]">
                                    {formatTimestamp(record.adjudicatedAt)}
                                  </p>
                                </div>
                                <p className="mt-2">{record.finding}</p>
                                <p className="mt-1 text-xs text-[var(--muted)]">
                                  Recorded by{" "}
                                  {record.actorRole === "admin" ? "an administrator" : record.actorRole}
                                </p>
                                <p className="mt-1 text-[11px] text-[var(--muted)]">
                                  {CLASSIFICATION_LABELS[record.originalDecisionClassification]} →{" "}
                                  {CLASSIFICATION_LABELS[record.currentClassification]}
                                </p>
                                <p className="text-[11px] text-[var(--muted)]">
                                  Status: {record.status.replaceAll("_", " ")} · operational
                                  effect: {record.operationalEffect}
                                </p>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    </div>
                  )}
                </Section>
              ) : null}

              <Section title="Administrative decision">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--elevated)] p-3 text-xs text-[var(--muted)]">
                  Decisions in this workspace only record administrative findings and
                  case status. They never change acceptance, attendance, guard,
                  activation or report evidence, and they cannot reopen an acceptance
                  window.
                </div>

                {decisionNotice ? (
                  <p
                    role="status"
                    aria-live="polite"
                    className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                  >
                    {decisionNotice}
                  </p>
                ) : null}
                {decisionError ? (
                  <p
                    role="alert"
                    className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                  >
                    {decisionError}
                  </p>
                ) : null}

                {review.caseStatus === HANDOVER_REVIEW_CASE_STATUSES.CLOSED ? (
                  <p className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm text-[var(--muted)]">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    This review case is closed. No further administrative decision can
                    be recorded.
                  </p>
                ) : allowedDecisions.length === 0 ? (
                  <p className="mt-4 text-sm text-[var(--muted)]">
                    No administrative decision is available for this case.
                  </p>
                ) : (
                  <div className="mt-4 space-y-4">
                    <label className="block text-sm">
                      <span className="font-medium">Decision</span>
                      <select
                        value={activeDecisionType}
                        onChange={(event) =>
                          setDecisionType(event.target.value as HandoverReviewDecisionType)
                        }
                        className={inputClass}
                      >
                        {allowedDecisions.map((value) => (
                          <option key={value} value={value}>
                            {DECISION_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block text-sm">
                      <span className="font-medium">Reason</span>
                      <textarea
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        rows={3}
                        maxLength={2000}
                        className={inputClass}
                        placeholder="Explain what was reviewed and why this decision is appropriate."
                      />
                      <span className="text-xs text-[var(--muted)]">
                        10–2000 characters. Stored with your administrator identity.
                      </span>
                    </label>

                    {activeDecisionType ===
                    HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING ? (
                      <label className="block text-sm">
                        <span className="font-medium">Administrative finding</span>
                        <textarea
                          value={finding}
                          onChange={(event) => setFinding(event.target.value)}
                          rows={3}
                          maxLength={2000}
                          className={inputClass}
                          placeholder="State the finding for the record."
                        />
                      </label>
                    ) : null}

                    {activeDecisionType === HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE ? (
                      <label className="block text-sm">
                        <span className="font-medium">Resolution summary</span>
                        <textarea
                          value={resolutionSummary}
                          onChange={(event) => setResolutionSummary(event.target.value)}
                          rows={3}
                          maxLength={2000}
                          className={inputClass}
                          placeholder="Summarize how the review is concluded without changing operational evidence."
                        />
                      </label>
                    ) : null}

                    {activeDecisionType === HANDOVER_REVIEW_DECISION_TYPES.ESCALATE ? (
                      <label className="block text-sm">
                        <span className="font-medium">Escalation target</span>
                        <input
                          value={escalationTarget}
                          onChange={(event) => setEscalationTarget(event.target.value)}
                          maxLength={120}
                          className={inputClass}
                          placeholder="Team or authority receiving the escalation."
                        />
                      </label>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void submitDecision()}
                        disabled={submitting || reason.trim().length < 10}
                        className="btn-accent rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {submitting ? "Recording…" : "Record decision"}
                      </button>
                    </div>
                  </div>
                )}
              </Section>

              <Section title="Administrative decision history">
                {review.decisions.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">
                    No administrative decision has been recorded for this handover.
                  </p>
                ) : (
                  <ol className="space-y-3">
                    {review.decisions.map((decision) => (
                      <li
                        key={decision.id}
                        className="rounded-lg border border-[var(--border)] bg-[var(--elevated)] p-3 text-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold">{DECISION_LABELS[decision.decisionType]}</p>
                          <p className="text-xs text-[var(--muted)]">
                            {formatTimestamp(decision.recordedAt)}
                          </p>
                        </div>
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {decision.caseStatusBefore} →{" "}
                          {decision.caseStatusAfter} · revision {decision.caseRevisionAfter}
                        </p>
                        <p className="mt-2">{decision.reason}</p>
                        {decision.finding ? (
                          <p className="mt-1 text-xs">
                            <span className="font-semibold">Finding:</span> {decision.finding}
                          </p>
                        ) : null}
                        {decision.resolutionSummary ? (
                          <p className="mt-1 text-xs">
                            <span className="font-semibold">Resolution:</span>{" "}
                            {decision.resolutionSummary}
                          </p>
                        ) : null}
                        {decision.escalationTarget ? (
                          <p className="mt-1 text-xs">
                            <span className="font-semibold">Escalated to:</span>{" "}
                            {decision.escalationTarget}
                          </p>
                        ) : null}
                        <p className="mt-1 text-[11px] text-[var(--muted)]">
                          Classification: {CLASSIFICATION_LABELS[decision.classification]}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>

              {review.caseRecord ? (
                <p className="inline-flex items-center gap-2 text-xs text-[var(--muted)]">
                  <TriangleAlert className="h-3.5 w-3.5" />
                  Case last updated {formatTimestamp(review.caseRecord.updatedAt)}
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
