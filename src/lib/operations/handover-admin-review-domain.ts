// Phase 8B — pure administrative review domain.
//
// This module decides what an administrator may record. It performs no I/O and
// mutates nothing. Every rule here is deliberately conservative: a decision can
// only describe an observation, and an acknowledgement is only permitted when
// the live evidence proves a valid completed handover.

import { createHash } from "node:crypto";

import {
  HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE,
  HANDOVER_REVIEW_ADJUDICATION_SCHEMA,
  HANDOVER_REVIEW_CASE_STATUSES,
  HANDOVER_REVIEW_CLASSIFICATIONS,
  HANDOVER_REVIEW_DECISION_TYPE_LIST,
  HANDOVER_REVIEW_DECISION_TYPES,
  type HandoverReviewAdjudicationIneligibleCode,
  type HandoverReviewCaseRecord,
  type HandoverReviewCaseStatus,
  type HandoverReviewClassification,
  type HandoverReviewDecisionRecord,
  type HandoverReviewDecisionType,
  type HandoverReviewFingerprintInput,
  type HandoverReviewReason,
} from "@/types/handover-admin-review";

export class HandoverReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoverReviewInputError";
  }
}

export type HandoverReviewDecisionErrorCode =
  | "REVIEW_DECISION_TYPE_UNSUPPORTED"
  | "REVIEW_DECISION_NOT_ALLOWED"
  | "REVIEW_CASE_CLOSED"
  | "REVIEW_DECISION_STALE"
  | "REVIEW_IDEMPOTENCY_CONFLICT";

export class HandoverReviewDecisionError extends Error {
  constructor(
    public readonly code: HandoverReviewDecisionErrorCode,
    message: string,
    public readonly status: 409 = 409,
  ) {
    super(message);
    this.name = "HandoverReviewDecisionError";
  }
}

export interface HandoverReviewDecisionIntent {
  decisionType: HandoverReviewDecisionType;
  idempotencyKey: string;
  expectedCaseRevision: number;
  expectedFingerprint: string;
  reason: string;
  finding: string | null;
  resolutionSummary: string | null;
  escalationTarget: string | null;
  requestHash: string;
}

export interface HandoverReviewDecisionOutcome {
  statusAfter: HandoverReviewCaseStatus;
  resolution: "valid_completed_state_confirmed" | "review_concluded_without_operational_change" | null;
}

const DECISION_FIELDS = [
  "decisionType",
  "idempotencyKey",
  "expectedCaseRevision",
  "expectedFingerprint",
  "reason",
  "finding",
  "resolutionSummary",
  "escalationTarget",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") {
    throw new HandoverReviewInputError(`Provide a ${label}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minimum || trimmed.length > maximum) {
    throw new HandoverReviewInputError(
      `The ${label} must contain between ${minimum} and ${maximum} characters.`,
    );
  }
  return trimmed;
}

function optionalText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, label, minimum, maximum);
}

function isDecisionType(value: unknown): value is HandoverReviewDecisionType {
  return (
    typeof value === "string" &&
    (HANDOVER_REVIEW_DECISION_TYPE_LIST as readonly string[]).includes(value)
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = stableValue(value[key]);
    }
    return result;
  }
  return value;
}

export function canonicalReviewMaterial(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function sha256Hex64(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function referenceDigest(namespace: string, value: unknown): string {
  return sha256Hex64(canonicalReviewMaterial({ namespace, value })).slice(0, 40);
}

export function createHandoverReviewCaseId(handoverDocumentId: string): string {
  return `handover_review_case_v1_${referenceDigest("handover-admin-review-case-v1", {
    handoverDocumentId,
  })}`;
}

export function createHandoverReviewDecisionId(caseId: string, idempotencyKey: string): string {
  return `handover_review_decision_v1_${referenceDigest("handover-admin-review-decision-v1", {
    caseId,
    idempotencyKey,
  })}`;
}

export function createHandoverReviewAuditId(decisionId: string): string {
  return `handover_review_audit_v1_${referenceDigest("handover-admin-review-audit-v1", {
    decisionId,
  })}`;
}

export function computeHandoverReviewFingerprint(
  input: HandoverReviewFingerprintInput,
): string {
  return sha256Hex64(canonicalReviewMaterial(input));
}

export function parseHandoverReviewDecisionBody(body: unknown): HandoverReviewDecisionIntent {
  if (!isPlainObject(body)) {
    throw new HandoverReviewInputError("Provide a review decision.");
  }
  const unknownKey = Object.keys(body).find(
    (key) => !(DECISION_FIELDS as readonly string[]).includes(key),
  );
  if (unknownKey !== undefined) {
    throw new HandoverReviewInputError("The review decision contains unsupported fields.");
  }
  if (!isDecisionType(body.decisionType)) {
    throw new HandoverReviewInputError("Choose a supported review decision.");
  }
  if (
    typeof body.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(body.idempotencyKey)
  ) {
    throw new HandoverReviewInputError("Provide a valid idempotency key.");
  }
  if (
    !Number.isSafeInteger(body.expectedCaseRevision) ||
    (body.expectedCaseRevision as number) < 0 ||
    (body.expectedCaseRevision as number) > 1_000_000
  ) {
    throw new HandoverReviewInputError("Provide the review case revision that was inspected.");
  }
  if (
    typeof body.expectedFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.expectedFingerprint)
  ) {
    throw new HandoverReviewInputError("Provide the evidence fingerprint that was inspected.");
  }

  const decisionType = body.decisionType;
  const reason = requiredText(body.reason, "decision reason", 10, 2_000);
  const finding = optionalText(body.finding, "administrative finding", 10, 2_000);
  const resolutionSummary = optionalText(
    body.resolutionSummary,
    "resolution summary",
    10,
    2_000,
  );
  const escalationTarget = optionalText(
    body.escalationTarget,
    "escalation target",
    2,
    120,
  );

  if (decisionType === HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING) {
    if (finding === null) {
      throw new HandoverReviewInputError("An administrative finding is required.");
    }
  } else if (finding !== null) {
    throw new HandoverReviewInputError("An administrative finding is only valid for that decision.");
  }

  if (decisionType === HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE) {
    if (resolutionSummary === null) {
      throw new HandoverReviewInputError("A resolution summary is required to close a review case.");
    }
  } else if (resolutionSummary !== null) {
    throw new HandoverReviewInputError("A resolution summary is only valid when closing a review case.");
  }

  if (decisionType === HANDOVER_REVIEW_DECISION_TYPES.ESCALATE) {
    if (escalationTarget === null) {
      throw new HandoverReviewInputError("An escalation target is required.");
    }
  } else if (escalationTarget !== null) {
    throw new HandoverReviewInputError("An escalation target is only valid for escalation.");
  }

  return {
    decisionType,
    idempotencyKey: body.idempotencyKey,
    expectedCaseRevision: body.expectedCaseRevision as number,
    expectedFingerprint: body.expectedFingerprint,
    reason,
    finding,
    resolutionSummary,
    escalationTarget,
    requestHash: sha256Hex64(
      canonicalReviewMaterial({
        decisionType,
        reason,
        finding,
        resolutionSummary,
        escalationTarget,
        expectedCaseRevision: body.expectedCaseRevision,
        expectedFingerprint: body.expectedFingerprint,
      }),
    ),
  };
}

export function allowedReviewDecisions(input: {
  caseStatus: HandoverReviewCaseStatus;
  classification: HandoverReviewClassification;
}): HandoverReviewDecisionType[] {
  if (input.caseStatus === HANDOVER_REVIEW_CASE_STATUSES.CLOSED) return [];
  const allowed: HandoverReviewDecisionType[] = [
    HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION,
    HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING,
    HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE,
    HANDOVER_REVIEW_DECISION_TYPES.ESCALATE,
  ];
  if (input.classification === HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID) {
    allowed.unshift(HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE);
  }
  return allowed;
}

export function evaluateHandoverReviewDecision(input: {
  intent: HandoverReviewDecisionIntent;
  caseStatus: HandoverReviewCaseStatus;
  classification: HandoverReviewClassification;
  allowed: HandoverReviewDecisionType[];
}): HandoverReviewDecisionOutcome {
  const { intent, caseStatus, classification } = input;

  if (caseStatus === HANDOVER_REVIEW_CASE_STATUSES.CLOSED) {
    throw new HandoverReviewDecisionError(
      "REVIEW_CASE_CLOSED",
      "This review case is closed. No further administrative decision can be recorded.",
    );
  }
  if (!input.allowed.includes(intent.decisionType)) {
    throw new HandoverReviewDecisionError(
      "REVIEW_DECISION_NOT_ALLOWED",
      "This decision is not permitted for the current review state.",
    );
  }

  switch (intent.decisionType) {
    case HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE:
      if (classification !== HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID) {
        throw new HandoverReviewDecisionError(
          "REVIEW_DECISION_NOT_ALLOWED",
          "Only a handover whose operational completion is fully proven can be acknowledged.",
        );
      }
      return {
        statusAfter: HANDOVER_REVIEW_CASE_STATUSES.CLOSED,
        resolution: "valid_completed_state_confirmed",
      };
    case HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION:
      return {
        statusAfter: HANDOVER_REVIEW_CASE_STATUSES.UNDER_INVESTIGATION,
        resolution: null,
      };
    case HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING:
      return { statusAfter: caseStatus, resolution: null };
    case HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE:
      return {
        statusAfter: HANDOVER_REVIEW_CASE_STATUSES.CLOSED,
        resolution: "review_concluded_without_operational_change",
      };
    case HANDOVER_REVIEW_DECISION_TYPES.ESCALATE:
      return {
        statusAfter: HANDOVER_REVIEW_CASE_STATUSES.ESCALATED,
        resolution: null,
      };
  }
}

export function requiresHandoverReview(input: {
  classification: HandoverReviewClassification;
  caseStatus: HandoverReviewCaseStatus;
}): boolean {
  if (input.caseStatus === HANDOVER_REVIEW_CASE_STATUSES.CLOSED) return false;
  if (
    input.caseStatus === HANDOVER_REVIEW_CASE_STATUSES.UNDER_INVESTIGATION ||
    input.caseStatus === HANDOVER_REVIEW_CASE_STATUSES.ESCALATED
  ) {
    return true;
  }
  return (
    input.classification === HANDOVER_REVIEW_CLASSIFICATIONS.JOINING_WINDOW_EXPIRED ||
    input.classification === HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED
  );
}

export function dedupeReviewReasons(reasons: HandoverReviewReason[]): HandoverReviewReason[] {
  const seen = new Set<string>();
  const result: HandoverReviewReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.code}\u0000${reason.subjectUid ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reason);
  }
  return result.sort((left, right) =>
    left.code === right.code
      ? (left.subjectUid ?? "").localeCompare(right.subjectUid ?? "")
      : left.code.localeCompare(right.code),
  );
}

// ===========================================================================
// Phase 8C.2a — append-only historical adjudication.
//
// Pure rules only: identity, request parsing, and the eligibility proof that
// links an administrator's finding to a real acknowledged decision whose
// authoritative evidence no longer supports it. Nothing here performs I/O, and
// no rule can reopen, update or repair a review case, a decision, or any
// operational record.
// ===========================================================================

export type HandoverAdjudicationErrorCode =
  | "ADJUDICATION_CASE_NOT_FOUND"
  | "ADJUDICATION_DECISION_NOT_FOUND"
  | "ADJUDICATION_NOT_ELIGIBLE"
  | "ADJUDICATION_STALE"
  | "ADJUDICATION_IDEMPOTENCY_CONFLICT"
  | "ADJUDICATION_ALREADY_RECORDED"
  | "ADJUDICATION_OUTCOME_UNVERIFIED";

export class HandoverAdjudicationError extends Error {
  constructor(
    public readonly code: HandoverAdjudicationErrorCode,
    message: string,
    public readonly status: 404 | 409 | 503 = 409,
    public readonly reasonCode: HandoverReviewAdjudicationIneligibleCode | null = null,
  ) {
    super(message);
    this.name = "HandoverAdjudicationError";
  }
}

export interface HandoverReviewAdjudicationIntent {
  originalDecisionId: string;
  idempotencyKey: string;
  expectedCaseRevision: number;
  expectedFingerprint: string;
  finding: string;
  requestHash: string;
}

const ADJUDICATION_FIELDS = [
  "originalDecisionId",
  "idempotencyKey",
  "expectedCaseRevision",
  "expectedFingerprint",
  "finding",
] as const;

export function createHandoverReviewAdjudicationId(input: {
  caseId: string;
  originalDecisionId: string;
  currentEvidenceDigest: string;
}): string {
  return `handover_review_adjudication_v1_${referenceDigest(
    HANDOVER_REVIEW_ADJUDICATION_SCHEMA,
    {
      caseId: input.caseId,
      originalDecisionId: input.originalDecisionId,
      currentEvidenceDigest: input.currentEvidenceDigest,
    },
  )}`;
}

export function createHandoverReviewAdjudicationAuditId(adjudicationId: string): string {
  return `handover_review_adjudication_audit_v1_${referenceDigest(
    "handover-admin-review-adjudication-audit-v1",
    { adjudicationId },
  )}`;
}

export function parseHandoverReviewAdjudicationBody(
  body: unknown,
): HandoverReviewAdjudicationIntent {
  if (!isPlainObject(body)) {
    throw new HandoverReviewInputError("Provide a historical adjudication.");
  }
  const unknownKey = Object.keys(body).find(
    (key) => !(ADJUDICATION_FIELDS as readonly string[]).includes(key),
  );
  if (unknownKey !== undefined) {
    throw new HandoverReviewInputError(
      "The adjudication contains unsupported fields.",
    );
  }
  if (
    typeof body.originalDecisionId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(body.originalDecisionId)
  ) {
    throw new HandoverReviewInputError("Identify the original review decision.");
  }
  if (
    typeof body.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(body.idempotencyKey)
  ) {
    throw new HandoverReviewInputError("Provide a valid idempotency key.");
  }
  if (
    !Number.isSafeInteger(body.expectedCaseRevision) ||
    (body.expectedCaseRevision as number) < 0 ||
    (body.expectedCaseRevision as number) > 1_000_000
  ) {
    throw new HandoverReviewInputError(
      "Provide the review case revision that was inspected.",
    );
  }
  if (
    typeof body.expectedFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.expectedFingerprint)
  ) {
    throw new HandoverReviewInputError(
      "Provide the current evidence fingerprint that was inspected.",
    );
  }
  // Only the administrator's own finding is supplied. Classification, actor,
  // timestamps and every digest are derived on the server.
  const finding = requiredText(body.finding, "adjudication finding", 10, 2_000);
  const intent = {
    originalDecisionId: body.originalDecisionId,
    idempotencyKey: body.idempotencyKey,
    expectedCaseRevision: body.expectedCaseRevision as number,
    expectedFingerprint: body.expectedFingerprint,
    finding,
  };
  return {
    ...intent,
    requestHash: sha256Hex64(canonicalReviewMaterial(intent)),
  };
}

/**
 * The decision an acknowledgement-closed case is still on, or the reason the
 * historical link cannot be proven. `caseRecord.lastDecisionId` is the only
 * pointer the case keeps, and it must agree with the decision's own recorded
 * revision and fingerprint; a disagreement means the history was disturbed,
 * which is not something an adjudication is allowed to assert.
 */
export function findHistoricalAcknowledgedDecision(input: {
  caseRecord: HandoverReviewCaseRecord | null;
  decisions: HandoverReviewDecisionRecord[];
}): {
  decision: HandoverReviewDecisionRecord | null;
  code: HandoverReviewAdjudicationIneligibleCode | null;
  message: string;
} {
  const { caseRecord } = input;
  if (caseRecord === null) {
    return {
      decision: null,
      code: HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_FOUND,
      message: "No administrative review case exists for this handover.",
    };
  }
  if (caseRecord.status !== HANDOVER_REVIEW_CASE_STATUSES.CLOSED) {
    return {
      decision: null,
      code: HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_CLOSED,
      message:
        "Only a closed historical review case can be adjudicated; this case is still live.",
    };
  }
  const decision =
    caseRecord.lastDecisionId === null
      ? null
      : (input.decisions.find((item) => item.id === caseRecord.lastDecisionId) ?? null);
  if (decision === null) {
    return {
      decision: null,
      code: HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_ACKNOWLEDGEMENT,
      message:
        "The closing decision recorded on this case cannot be read from the decision history.",
    };
  }
  if (
    decision.decisionType !==
      HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE ||
    decision.classification !== HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID ||
    decision.caseStatusAfter !== HANDOVER_REVIEW_CASE_STATUSES.CLOSED
  ) {
    return {
      decision: null,
      code: HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_ACKNOWLEDGEMENT,
      message:
        "This case was not closed by an acknowledgement of a fully proven completed handover.",
    };
  }
  if (
    caseRecord.caseRevision !== decision.caseRevisionAfter ||
    caseRecord.fingerprintAtLastDecision !== decision.evidenceFingerprint ||
    decision.handoverDocumentId !== caseRecord.handoverDocumentId ||
    decision.caseId !== caseRecord.id ||
    decision.reviewReasonCodes.length !== 0
  ) {
    return {
      decision: null,
      code: HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.HISTORY_MISMATCH,
      message:
        "The acknowledged decision no longer agrees with the case history it closed.",
    };
  }
  return { decision, code: null, message: "" };
}

export interface HandoverAdjudicationEligibilityAssessment {
  eligible: boolean;
  code: HandoverReviewAdjudicationIneligibleCode | null;
  message: string;
  acknowledgedDecision: HandoverReviewDecisionRecord | null;
}

/**
 * Prove that evidence which once supported an acknowledgement no longer does.
 *
 * The contradiction is never taken from the request: it is whatever the live
 * read model now derives. An acknowledgement was only ever possible on a
 * fully proven completion, so a current classification that no longer proves
 * completion, over an unchanged case history, is a genuine post-decision
 * integrity concern. Anything else — a still-valid completion, a case that was
 * never acknowledged, a disturbed history — is refused.
 */
export function evaluateHandoverAdjudicationEligibility(input: {
  caseRecord: HandoverReviewCaseRecord | null;
  decisions: HandoverReviewDecisionRecord[];
  currentClassification: HandoverReviewClassification;
  currentEvidenceDigest: string;
  currentReviewReasonCodes: readonly string[];
  currentCaseRevision: number;
}): HandoverAdjudicationEligibilityAssessment {
  const found = findHistoricalAcknowledgedDecision({
    caseRecord: input.caseRecord,
    decisions: input.decisions,
  });
  if (found.decision === null) {
    return {
      eligible: false,
      code: found.code,
      message: found.message,
      acknowledgedDecision: null,
    };
  }
  if (input.currentCaseRevision !== found.decision.caseRevisionAfter) {
    return {
      eligible: false,
      code: HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.HISTORY_MISMATCH,
      message:
        "The review case moved after the acknowledgement, so the historical link cannot be proven.",
      acknowledgedDecision: found.decision,
    };
  }
  if (
    input.currentClassification !==
    HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED
  ) {
    return {
      eligible: false,
      code: HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_CONTRADICTION,
      message:
        "The current authoritative evidence does not contradict the acknowledged completion.",
      acknowledgedDecision: found.decision,
    };
  }
  if (
    input.currentReviewReasonCodes.length === 0 ||
    input.currentEvidenceDigest === found.decision.evidenceFingerprint
  ) {
    return {
      eligible: false,
      code: HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.EVIDENCE_UNCHANGED,
      message:
        "No contradictory or unverifiable evidence was detected against the acknowledged state.",
      acknowledgedDecision: found.decision,
    };
  }
  return {
    eligible: true,
    code: null,
    message:
      "The acknowledged valid completion is no longer supported by the authoritative evidence.",
    acknowledgedDecision: found.decision,
  };
}

export function adjudicationIneligible(
  assessment: HandoverAdjudicationEligibilityAssessment,
): never {
  throw new HandoverAdjudicationError(
    assessment.code === HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_FOUND
      ? "ADJUDICATION_CASE_NOT_FOUND"
      : "ADJUDICATION_NOT_ELIGIBLE",
    assessment.message,
    assessment.code === HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_FOUND ? 404 : 409,
    assessment.code,
  );
}
