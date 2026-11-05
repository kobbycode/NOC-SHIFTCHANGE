// 09M-R3B.2 Phase 5 — HTTP boundary for the atomic incoming-acceptance
// protocol, the read-only acceptance status endpoint and the receipt-backed
// guard finalization route.
//
// The atomic protocol is gated by its OWN explicit server-side switch in
// addition to the existing v2 flag. Both default to disabled, so the new
// routes answer 404 in every existing environment unless an operator opts in
// deliberately. These helpers never fall back to the legacy split writer: once
// an atomic attempt starts, the caller either gets a validated receipt or an
// explicit non-committed/unknown outcome.

import "server-only";

import { NextResponse } from "next/server";
import { AssignmentOperationError } from "./assignment-transaction";
import { PasswordReauthenticationError } from "@/lib/auth/password-reauthentication";
import { IncomingAcceptanceApplicationError } from "./incoming-acceptance-application-domain";
import {
  AtomicAcceptanceServiceError,
  type AtomicAcceptanceCommitState,
  type AtomicAcceptanceNotificationReport,
} from "./incoming-acceptance-application-firestore";
import { GuardFinalizationError } from "./incoming-acceptance-guard-finalization";
import {
  IncomingAcceptanceReconciliationError,
  type IncomingAcceptanceReconciliationResult,
} from "./incoming-acceptance-reconciliation";
import { handoverV2Enabled, respond } from "./handover-v2-report-http";
import type { IncomingAcceptanceReviewedBinding } from "@/types/incoming-acceptance-application";

// Separate, explicit, server-only gate. `HANDOVER_V2_ATOMIC_ACCEPTANCE` is
// never read by the browser and is absent from every existing environment, so
// the atomic protocol stays dark until a deliberate opt-in.
export const ATOMIC_ACCEPTANCE_GATE = "HANDOVER_V2_ATOMIC_ACCEPTANCE";

export function handoverV2AtomicAcceptanceEnabled(): boolean {
  return handoverV2Enabled() && process.env[ATOMIC_ACCEPTANCE_GATE] === "true";
}

export const ACCEPTANCE_RESPONSE_CODES = {
  APPLIED_FIRST_ACTIVATION: "ACCEPTANCE_APPLIED_FIRST_ACTIVATION",
  APPLIED_SUBSEQUENT_JOIN: "ACCEPTANCE_APPLIED_SUBSEQUENT_JOIN",
  ALREADY_APPLIED: "ACCEPTANCE_ALREADY_APPLIED",
  COMMIT_UNKNOWN: "ACCEPTANCE_COMMIT_UNKNOWN",
  RECONCILIATION_CONFLICT: "ACCEPTANCE_RECONCILIATION_CONFLICT",
  BINDING_CONFLICT: "ACCEPTANCE_BINDING_CONFLICT",
  WINDOW_CLOSED: "ACCEPTANCE_WINDOW_CLOSED",
  NOT_APPLIED: "ACCEPTANCE_NOT_APPLIED",
  ADMIN_REVIEW_REQUIRED: "ACCEPTANCE_ADMIN_REVIEW_REQUIRED",
  GUARD_FINALIZED: "GUARD_FINALIZED",
  GUARD_ALREADY_FINALIZED: "GUARD_ALREADY_FINALIZED",
  GUARD_NOT_ELIGIBLE: "GUARD_NOT_ELIGIBLE",
  GUARD_UNAUTHORIZED: "GUARD_UNAUTHORIZED",
  GUARD_CONFLICT: "GUARD_CONFLICT",
  GUARD_COMMIT_UNKNOWN: "GUARD_COMMIT_UNKNOWN",
} as const;

export type AcceptanceResponseCode =
  (typeof ACCEPTANCE_RESPONSE_CODES)[keyof typeof ACCEPTANCE_RESPONSE_CODES];

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

export interface AtomicAcceptanceRequest {
  expectedRevision: number;
  expectedSnapshotHash: string;
  expectedGuardRevision: number;
  expectedFencingEpoch: number;
  password: string;
  lateReason: string | null;
}

export interface GuardClosureRequest {
  closureId: string;
  subjectUid: string;
  reason: string;
}

function invalid(message: string): never {
  throw new AssignmentOperationError(message, 400);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Invalid request body.");
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(data: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(data).some((key) => !allowed.includes(key))) {
    invalid("Missing or unsupported request fields.");
  }
}

function requireRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`Invalid ${label}.`);
  return value as number;
}

function requireHex64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid(`Invalid ${label}.`);
  return value;
}

function requirePassword(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid("Your password is required to accept this handover.");
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 128 ||
      value.includes("/") || value === "." || value === "..") {
    invalid(`Invalid ${label}.`);
  }
  return value;
}

function optionalLateReason(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 1_000) invalid("Invalid late reason.");
  return value;
}

// The technician's own late-arrival reason is optional in the body; the service
// decides whether it is REQUIRED from authoritative time and absence records.
// The body still never carries a technician UID, role, evidence kind, receipt,
// shift state or clock.
export function parseAtomicAcceptBody(body: unknown): AtomicAcceptanceRequest {
  const data = objectBody(body);
  rejectUnknownKeys(data, [
    "expectedRevision",
    "expectedSnapshotHash",
    "expectedGuardRevision",
    "expectedFencingEpoch",
    "password",
    "lateReason",
  ]);
  return {
    expectedRevision: requireRevision(data.expectedRevision, "expected revision"),
    expectedSnapshotHash: requireHex64(data.expectedSnapshotHash, "expected snapshot hash"),
    expectedGuardRevision: requireRevision(data.expectedGuardRevision, "expected guard revision"),
    expectedFencingEpoch: requireRevision(data.expectedFencingEpoch, "expected fencing epoch"),
    password: requirePassword(data.password),
    lateReason: optionalLateReason(data.lateReason),
  };
}

// An empty body requests normal closure. An exceptional closure names the
// absent partner and the authorization reason; the server derives the actor and
// the decision clock, and the service re-validates the absence and reason.
export function parseGuardFinalizeBody(body: unknown): GuardClosureRequest | null {
  const data = objectBody(body);
  if (Object.keys(data).length === 0) return null;
  rejectUnknownKeys(data, ["closure"]);
  const closure = objectBody(data.closure);
  rejectUnknownKeys(closure, ["closureId", "subjectUid", "reason"]);
  if (typeof closure.reason !== "string" || !closure.reason.trim() ||
      closure.reason.trim().length > 2_000) {
    invalid("A non-empty closure reason is required.");
  }
  return {
    closureId: requireIdentifier(closure.closureId, "closure ID"),
    subjectUid: requireIdentifier(closure.subjectUid, "closure subject"),
    reason: closure.reason.trim(),
  };
}

// ---------------------------------------------------------------------------
// Reviewed binding
// ---------------------------------------------------------------------------

// Built only from the authoritative acceptance context. The frozen report was
// stamped before freezing revised the aggregate, so the live revision is
// overlaid exactly as the coordinator-side reviewed binding does.
export function buildReviewedBinding(input: {
  handoverId: string;
  handoverDocumentId: string;
  aggregateRevision: number;
  snapshotHash: string;
  report: IncomingAcceptanceReviewedBinding["report"] | null;
  guardRevision: number;
  fencingEpoch: number;
}): IncomingAcceptanceReviewedBinding {
  if (input.report === null) {
    throw new AssignmentOperationError(
      "This handover has no frozen report binding; incoming acceptance is not available.",
      409,
    );
  }
  const binding: IncomingAcceptanceReviewedBinding = {
    handoverId: input.handoverId,
    handoverDocumentId: input.handoverDocumentId,
    aggregateRevision: input.aggregateRevision,
    snapshotHash: input.snapshotHash,
    report: { ...input.report, aggregateRevision: input.aggregateRevision },
    guardRevision: input.guardRevision,
    fencingEpoch: input.fencingEpoch,
  };
  return binding;
}

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export function atomicRespond(payload: Record<string, unknown>, status: number) {
  return respond(payload, status);
}

export function notificationPosture(report: AtomicAcceptanceNotificationReport) {
  // An outbox entry is a QUEUED intent, never proof of push delivery.
  return {
    delivery: "not_claimed",
    enabled: report.enabled,
    outboxState: report.outboxState,
    intentsQueued: report.intentsQueued,
    intentsExisting: report.intentsExisting,
  };
}

export const RECONCILIATION_GUIDANCE: Record<IncomingAcceptanceReconciliationResult["status"], string> = {
  APPLIED_VALIDATED: "NONE",
  NOT_APPLIED: "RETRY_ACCEPTANCE",
  EVIDENCE_ONLY: "CONTACT_ADMIN",
  COMMIT_UNVERIFIABLE: "REFRESH_STATUS",
  BINDING_CONFLICT: "REVIEW_AND_RETRY",
  GUARD_CONFLICT: "CONTACT_ADMIN",
  INCONSISTENT_HISTORY: "CONTACT_ADMIN",
  ADMIN_REVIEW_REQUIRED: "CONTACT_ADMIN",
};

export function reconciliationView(result: IncomingAcceptanceReconciliationResult) {
  return {
    status: result.status,
    reason: result.reason,
    guidance: RECONCILIATION_GUIDANCE[result.status],
    applied: result.applied,
    retryWouldReplay: result.retryWouldReplay,
    requiresAdministrativeReview: result.requiresAdministrativeReview,
  };
}

export class AtomicAcceptanceHttpError extends Error {
  public readonly code: AcceptanceResponseCode;
  public readonly status: number;
  public readonly commitState: AtomicAcceptanceCommitState;
  public readonly lifecycleState: string | null;
  public readonly retryable: boolean;
  public readonly refreshStatus: boolean;

  constructor(input: {
    code: AcceptanceResponseCode;
    status: number;
    message: string;
    commitState: AtomicAcceptanceCommitState;
    lifecycleState?: string | null;
    retryable?: boolean;
    refreshStatus?: boolean;
  }) {
    super(input.message);
    this.name = "AtomicAcceptanceHttpError";
    this.code = input.code;
    this.status = input.status;
    this.commitState = input.commitState;
    this.lifecycleState = input.lifecycleState ?? null;
    this.retryable = input.retryable ?? false;
    this.refreshStatus = input.refreshStatus ?? false;
  }
}

function failure(input: {
  status: number;
  code: string;
  message: string;
  commitState: AtomicAcceptanceCommitState;
  lifecycleState?: string | null;
  retryable?: boolean;
  refreshStatus?: boolean;
}) {
  // A 503 means the outcome is UNKNOWN, never that the transaction rolled back.
  const outcomeUnknown = input.commitState !== "not_committed";
  return atomicRespond({
    success: false,
    code: input.code,
    error: input.message,
    commitState: input.commitState,
    outcomeUnknown,
    rolledBack: input.commitState === "not_committed",
    retryable: input.retryable ?? false,
    refreshStatus: input.refreshStatus ?? outcomeUnknown,
    lifecycleState: input.lifecycleState ?? null,
  }, outcomeUnknown ? 503 : input.status);
}

export function mapAtomicAcceptanceError(error: unknown, fallback: string) {
  if (error instanceof AtomicAcceptanceHttpError) {
    return failure({
      status: error.status,
      code: error.code,
      message: error.message,
      commitState: error.commitState,
      lifecycleState: error.lifecycleState,
      retryable: error.retryable,
      refreshStatus: error.refreshStatus,
    });
  }
  if (error instanceof IncomingAcceptanceApplicationError) {
    return failure({
      status: error.status,
      code: error.code,
      message: error.message,
      commitState: "not_committed",
      retryable: error.status === 409,
      refreshStatus: error.status === 409,
    });
  }
  if (error instanceof AtomicAcceptanceServiceError) {
    return failure({
      status: error.status,
      code: error.code,
      message: error.message,
      commitState: error.commitState,
      retryable: true,
      refreshStatus: true,
    });
  }
  if (error instanceof GuardFinalizationError) {
    return failure({
      status: error.status,
      code: error.code,
      message: error.message,
      commitState: error.commitState,
      lifecycleState: error.lifecycleState,
      retryable: error.status === 503 || error.status === 409,
      refreshStatus: true,
    });
  }
  if (error instanceof PasswordReauthenticationError) {
    return failure({
      status: error.status,
      code: error.code,
      message: error.message,
      commitState: "not_committed",
      retryable: error.code === "SERVICE_UNAVAILABLE",
      refreshStatus: error.code === "SERVICE_UNAVAILABLE",
    });
  }
  if (error instanceof IncomingAcceptanceReconciliationError) {
    return failure({
      status: error.status,
      code: error.code,
      message: error.message,
      commitState: "not_committed",
    });
  }
  if (error instanceof AssignmentOperationError) {
    const conflict = error.status === 409;
    return failure({
      status: error.status,
      code: conflict
        ? ACCEPTANCE_RESPONSE_CODES.BINDING_CONFLICT
        : ACCEPTANCE_RESPONSE_CODES.NOT_APPLIED,
      message: error.message,
      commitState: "not_committed",
      retryable: conflict,
      refreshStatus: conflict,
    });
  }
  console.error(fallback, error);
  return atomicRespond({
    success: false,
    code: "ACCEPTANCE_INTERNAL_ERROR",
    error: "Unable to complete the atomic handover acceptance. Please try again.",
    commitState: "not_committed",
    outcomeUnknown: false,
    rolledBack: true,
    retryable: true,
    refreshStatus: true,
    lifecycleState: null,
  }, 500);
}

export function mapGuardFinalizationError(error: unknown, fallback: string) {
  if (error instanceof GuardFinalizationError) {
    const code =
      error.code === "GUARD_FINALIZATION_UNAUTHORIZED"
        ? ACCEPTANCE_RESPONSE_CODES.GUARD_UNAUTHORIZED
        : error.code === "GUARD_FINALIZATION_CONFLICT"
          ? ACCEPTANCE_RESPONSE_CODES.GUARD_CONFLICT
          : error.code === "GUARD_FINALIZATION_UNVERIFIABLE" ||
              error.code === "GUARD_FINALIZATION_OUTCOME_UNKNOWN"
            ? ACCEPTANCE_RESPONSE_CODES.GUARD_COMMIT_UNKNOWN
            : ACCEPTANCE_RESPONSE_CODES.GUARD_NOT_ELIGIBLE;
    return failure({
      status: error.status,
      code,
      message: error.message,
      commitState: error.commitState,
      lifecycleState: error.lifecycleState,
      retryable: error.status === 503 || error.status === 409,
      refreshStatus: true,
    });
  }
  if (error instanceof AssignmentOperationError) {
    return failure({
      status: error.status,
      code: ACCEPTANCE_RESPONSE_CODES.GUARD_NOT_ELIGIBLE,
      message: error.message,
      commitState: "not_committed",
      retryable: error.status === 409,
      refreshStatus: error.status === 409,
    });
  }
  console.error(fallback, error);
  return atomicRespond({
    success: false,
    code: "GUARD_FINALIZATION_INTERNAL_ERROR",
    error: "Unable to finalize the handover guard. Please try again.",
    commitState: "not_committed",
    outcomeUnknown: false,
    rolledBack: true,
    retryable: true,
    refreshStatus: true,
    lifecycleState: null,
  }, 500);
}

export function noStoreResponse(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}
