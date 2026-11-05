/**
 * Phase 8B — network-free contract tests for the administrative handover review
 * domain. No emulator, no Firebase, no route or UI module is loaded. These
 * tests pin the decision vocabulary, the acknowledgement precondition, the
 * fingerprint stability used for stale-decision detection and the queue rules.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE,
  HANDOVER_REVIEW_CASE_STATUSES,
  HANDOVER_REVIEW_CLASSIFICATIONS,
  HANDOVER_REVIEW_DECISION_TYPES,
} from "../src/types/handover-admin-review.ts";
import {
  HandoverAdjudicationError,
  HandoverReviewDecisionError,
  HandoverReviewInputError,
  adjudicationIneligible,
  allowedReviewDecisions,
  computeHandoverReviewFingerprint,
  createHandoverReviewAdjudicationAuditId,
  createHandoverReviewAdjudicationId,
  createHandoverReviewAuditId,
  createHandoverReviewCaseId,
  createHandoverReviewDecisionId,
  dedupeReviewReasons,
  evaluateHandoverAdjudicationEligibility,
  evaluateHandoverReviewDecision,
  findHistoricalAcknowledgedDecision,
  parseHandoverReviewAdjudicationBody,
  parseHandoverReviewDecisionBody,
  requiresHandoverReview,
} from "../src/lib/operations/handover-admin-review-domain.ts";

const FINGERPRINT = "a".repeat(64);
const KEY = "review-key-0001";

function body(overrides = {}) {
  return {
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION,
    idempotencyKey: KEY,
    expectedCaseRevision: 0,
    expectedFingerprint: FINGERPRINT,
    reason: "Investigate the missing personal acceptance before concluding.",
    ...overrides,
  };
}

function fingerprintInput(overrides = {}) {
  return {
    handoverDocumentId: "handover_v2_abc",
    aggregateRevision: 7,
    aggregateLifecycleStatus: "completed",
    guard: {
      id: "guard_abc",
      ownerLifecycleState: "active",
      guardRevision: 3,
      fencingEpoch: 2,
      terminalEvidenceRef: null,
    },
    activation: {
      receiptId: "activation_1",
      receiptHash: "b".repeat(64),
      valid: true,
    },
    report: {
      reportId: "report_1",
      digest: "c".repeat(64),
      valid: true,
    },
    applications: [
      {
        technicianUid: "tech-a",
        receiptId: "receipt-a",
        receiptHash: "d".repeat(64),
        outcome: "first_activation",
        operationalAppliedAt: "2026-10-29T08:00:00.000Z",
        verificationStatus: "validated",
        verificationCode: null,
        evidencePresent: true,
        operationFinalized: true,
        membershipPresent: true,
        attendancePresent: true,
        applicationAuditPresent: true,
        declaredNotYetIn: false,
      },
      {
        technicianUid: "tech-b",
        receiptId: null,
        receiptHash: null,
        outcome: null,
        operationalAppliedAt: null,
        verificationStatus: "not_applied",
        verificationCode: null,
        evidencePresent: false,
        operationFinalized: false,
        membershipPresent: false,
        attendancePresent: false,
        applicationAuditPresent: false,
        declaredNotYetIn: false,
      },
    ],
    classification: HANDOVER_REVIEW_CLASSIFICATIONS.AWAITING_PARTNER_ACCEPTANCE,
    reviewReasonCodes: [],
    ...overrides,
  };
}

test("case, decision and audit identities are deterministic and distinct", () => {
  const caseId = createHandoverReviewCaseId("handover_v2_abc");
  assert.equal(caseId, createHandoverReviewCaseId("handover_v2_abc"));
  assert.notEqual(caseId, createHandoverReviewCaseId("handover_v2_other"));
  assert.match(caseId, /^handover_review_case_v1_[0-9a-f]{40}$/);

  const decisionId = createHandoverReviewDecisionId(caseId, KEY);
  assert.equal(decisionId, createHandoverReviewDecisionId(caseId, KEY));
  assert.notEqual(decisionId, createHandoverReviewDecisionId(caseId, "review-key-0002"));
  assert.match(decisionId, /^handover_review_decision_v1_[0-9a-f]{40}$/);

  const auditId = createHandoverReviewAuditId(decisionId);
  assert.equal(auditId, createHandoverReviewAuditId(decisionId));
  assert.notEqual(auditId, decisionId);
  assert.match(auditId, /^handover_review_audit_v1_[0-9a-f]{40}$/);
});

test("a decision body is parsed strictly", () => {
  const parsed = parseHandoverReviewDecisionBody(body());
  assert.equal(parsed.decisionType, HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION);
  assert.equal(parsed.idempotencyKey, KEY);
  assert.equal(parsed.finding, null);
  assert.equal(parsed.requestHash.length, 64);

  const finding = parseHandoverReviewDecisionBody(
    body({
      decisionType: HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING,
      finding: "The partner receipt is absent and no join evidence exists.",
    }),
  );
  assert.equal(finding.finding, "The partner receipt is absent and no join evidence exists.");

  const close = parseHandoverReviewDecisionBody(
    body({
      decisionType: HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE,
      resolutionSummary: "Reviewed with operations and concluded without changes.",
    }),
  );
  assert.equal(
    close.resolutionSummary,
    "Reviewed with operations and concluded without changes.",
  );

  const escalate = parseHandoverReviewDecisionBody(
    body({
      decisionType: HANDOVER_REVIEW_DECISION_TYPES.ESCALATE,
      escalationTarget: "operations_manager",
    }),
  );
  assert.equal(escalate.escalationTarget, "operations_manager");
});

test("unsupported or incoherent decision bodies are rejected", () => {
  const cases = [
    body({ decisionType: "repair_handover" }),
    body({ idempotencyKey: "short" }),
    body({ expectedCaseRevision: -1 }),
    body({ expectedFingerprint: "not-a-hash" }),
    body({ reason: "too short" }),
    body({ unexpected: true }),
    body({
      decisionType: HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING,
    }),
    body({ finding: "A finding is not valid for this decision type." }),
    body({ decisionType: HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE }),
    body({
      decisionType: HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE,
      resolutionSummary: "Reviewed and concluded without operational changes.",
      finding: "A finding is not valid alongside closure.",
    }),
    body({ decisionType: HANDOVER_REVIEW_DECISION_TYPES.ESCALATE }),
    body({ escalationTarget: "operations_manager" }),
  ];
  for (const candidate of cases) {
    assert.throws(() => parseHandoverReviewDecisionBody(candidate), HandoverReviewInputError);
  }
});

test("only a fully proven completed handover may be acknowledged", () => {
  const reject = (classification, message) => {
    assert.throws(
      () =>
        evaluateHandoverReviewDecision({
          intent: parseHandoverReviewDecisionBody(
            body({
              decisionType:
                HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
            }),
          ),
          caseStatus: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
          classification,
          allowed: allowedReviewDecisions({
            caseStatus: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
            classification,
          }),
        }),
      (error) => {
        assert.ok(error instanceof HandoverReviewDecisionError);
        assert.equal(error.code, "REVIEW_DECISION_NOT_ALLOWED", message);
        return true;
      },
    );
  };

  for (const classification of [
    HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
    HANDOVER_REVIEW_CLASSIFICATIONS.JOINING_WINDOW_EXPIRED,
    HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_EXCEPTIONAL,
    HANDOVER_REVIEW_CLASSIFICATIONS.AWAITING_PARTNER_ACCEPTANCE,
  ]) {
    reject(classification, classification);
  }

  const outcome = evaluateHandoverReviewDecision({
    intent: parseHandoverReviewDecisionBody(
      body({ decisionType: HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE }),
    ),
    caseStatus: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
    classification: HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID,
    allowed: allowedReviewDecisions({
      caseStatus: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
      classification: HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID,
    }),
  });
  assert.equal(outcome.statusAfter, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(outcome.resolution, "valid_completed_state_confirmed");
});

test("case transitions stay administrative", () => {
  const caseStatus = HANDOVER_REVIEW_CASE_STATUSES.OPEN;
  const classification = HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
  const allowed = allowedReviewDecisions({ caseStatus, classification });
  const run = (decisionType, extra = {}) =>
    evaluateHandoverReviewDecision({
      intent: parseHandoverReviewDecisionBody(body({ decisionType, ...extra })),
      caseStatus,
      classification,
      allowed,
    });

  assert.equal(
    run(HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION).statusAfter,
    HANDOVER_REVIEW_CASE_STATUSES.UNDER_INVESTIGATION,
  );
  assert.equal(
    run(HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING, {
      finding: "The receipt and membership records disagree.",
    }).statusAfter,
    HANDOVER_REVIEW_CASE_STATUSES.OPEN,
  );
  assert.equal(
    run(HANDOVER_REVIEW_DECISION_TYPES.ESCALATE, {
      escalationTarget: "operations_manager",
    }).statusAfter,
    HANDOVER_REVIEW_CASE_STATUSES.ESCALATED,
  );
  const closed = run(HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE, {
    resolutionSummary: "Reviewed and concluded without operational changes.",
  });
  assert.equal(closed.statusAfter, HANDOVER_REVIEW_CASE_STATUSES.CLOSED);
  assert.equal(closed.resolution, "review_concluded_without_operational_change");

  assert.deepEqual(
    allowedReviewDecisions({
      caseStatus: HANDOVER_REVIEW_CASE_STATUSES.CLOSED,
      classification: HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
    }),
    [],
  );
  assert.throws(
    () =>
      evaluateHandoverReviewDecision({
        intent: parseHandoverReviewDecisionBody(body()),
        caseStatus: HANDOVER_REVIEW_CASE_STATUSES.CLOSED,
        classification,
        allowed: [],
      }),
    (error) => {
      assert.ok(error instanceof HandoverReviewDecisionError);
      assert.equal(error.code, "REVIEW_CASE_CLOSED");
      return true;
    },
  );
});

test("the queue includes only reviewable states or an active administrative case", () => {
  assert.equal(
    requiresHandoverReview({
      classification: HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
      caseStatus: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
    }),
    true,
  );
  assert.equal(
    requiresHandoverReview({
      classification: HANDOVER_REVIEW_CLASSIFICATIONS.JOINING_WINDOW_EXPIRED,
      caseStatus: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
    }),
    true,
  );
  assert.equal(
    requiresHandoverReview({
      classification: HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID,
      caseStatus: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
    }),
    false,
  );
  assert.equal(
    requiresHandoverReview({
      classification: HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID,
      caseStatus: HANDOVER_REVIEW_CASE_STATUSES.UNDER_INVESTIGATION,
    }),
    true,
  );
  assert.equal(
    requiresHandoverReview({
      classification: HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
      caseStatus: HANDOVER_REVIEW_CASE_STATUSES.CLOSED,
    }),
    false,
  );
});

test("the evidence fingerprint is stable, order-independent and sensitive", () => {
  const base = computeHandoverReviewFingerprint(fingerprintInput());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base, computeHandoverReviewFingerprint(fingerprintInput()));

  const reordered = {
    reviewReasonCodes: fingerprintInput().reviewReasonCodes,
    classification: fingerprintInput().classification,
    applications: fingerprintInput().applications.map((item) => ({ ...item })),
    report: { ...fingerprintInput().report },
    activation: { ...fingerprintInput().activation },
    guard: { ...fingerprintInput().guard },
    aggregateLifecycleStatus: "completed",
    aggregateRevision: 7,
    handoverDocumentId: "handover_v2_abc",
  };
  assert.equal(computeHandoverReviewFingerprint(reordered), base);

  const changedGuard = fingerprintInput({
    guard: { ...fingerprintInput().guard, guardRevision: 4 },
  });
  assert.notEqual(computeHandoverReviewFingerprint(changedGuard), base);

  const changedApplication = fingerprintInput({
    applications: [
      { ...fingerprintInput().applications[0], verificationStatus: "binding_conflict" },
      fingerprintInput().applications[1],
    ],
  });
  assert.notEqual(computeHandoverReviewFingerprint(changedApplication), base);

  const changedReason = fingerprintInput({
    reviewReasonCodes: ["JOIN_WINDOW_CLOSED"],
  });
  assert.notEqual(computeHandoverReviewFingerprint(changedReason), base);
});

test("review reasons are deduplicated per code and subject", () => {
  const deduped = dedupeReviewReasons([
    { code: "APPLICATION_INCONSISTENT", subjectUid: "tech-b", message: "b" },
    { code: "GUARD_MISSING", subjectUid: null, message: "guard" },
    { code: "APPLICATION_INCONSISTENT", subjectUid: "tech-b", message: "b-again" },
    { code: "APPLICATION_INCONSISTENT", subjectUid: "tech-a", message: "a" },
  ]);
  assert.deepEqual(
    deduped.map((item) => `${item.code}:${item.subjectUid ?? ""}`),
    [
      "APPLICATION_INCONSISTENT:tech-a",
      "APPLICATION_INCONSISTENT:tech-b",
      "GUARD_MISSING:",
    ],
  );
});

// ===========================================================================
// Phase 8C.2a — append-only historical adjudication (pure rules).
// ===========================================================================

const ADJUDICATION_CASE_ID = createHandoverReviewCaseId("handover_v2_abc");
const ADJUDICATION_DECISION_ID = createHandoverReviewDecisionId(
  ADJUDICATION_CASE_ID,
  "ack-key-0001",
);
const ACKNOWLEDGED_FINGERPRINT = "a".repeat(64);
const CONTRADICTED_FINGERPRINT = "b".repeat(64);

function adjudicationCaseRecord(overrides = {}) {
  return {
    id: ADJUDICATION_CASE_ID,
    handoverDocumentId: "handover_v2_abc",
    status: HANDOVER_REVIEW_CASE_STATUSES.CLOSED,
    caseRevision: 1,
    lastDecisionId: ADJUDICATION_DECISION_ID,
    fingerprintAtLastDecision: ACKNOWLEDGED_FINGERPRINT,
    ...overrides,
  };
}

function acknowledgedDecision(overrides = {}) {
  return {
    id: ADJUDICATION_DECISION_ID,
    caseId: ADJUDICATION_CASE_ID,
    handoverDocumentId: "handover_v2_abc",
    decisionType: HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
    classification: HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID,
    caseStatusAfter: HANDOVER_REVIEW_CASE_STATUSES.CLOSED,
    caseRevisionAfter: 1,
    evidenceFingerprint: ACKNOWLEDGED_FINGERPRINT,
    reviewReasonCodes: [],
    ...overrides,
  };
}

function adjudicationBody(overrides = {}) {
  return {
    originalDecisionId: ADJUDICATION_DECISION_ID,
    idempotencyKey: "adjudication-key-0001",
    expectedCaseRevision: 1,
    expectedFingerprint: CONTRADICTED_FINGERPRINT,
    finding: "The personal receipt that supported the acknowledgement is no longer present.",
    ...overrides,
  };
}

test("adjudication identities are content-derived from case, decision and evidence", () => {
  const base = createHandoverReviewAdjudicationId({
    caseId: ADJUDICATION_CASE_ID,
    originalDecisionId: ADJUDICATION_DECISION_ID,
    currentEvidenceDigest: CONTRADICTED_FINGERPRINT,
  });
  assert.match(base, /^handover_review_adjudication_v1_[0-9a-f]{40}$/);
  assert.equal(
    base,
    createHandoverReviewAdjudicationId({
      caseId: ADJUDICATION_CASE_ID,
      originalDecisionId: ADJUDICATION_DECISION_ID,
      currentEvidenceDigest: CONTRADICTED_FINGERPRINT,
    }),
  );
  assert.notEqual(
    base,
    createHandoverReviewAdjudicationId({
      caseId: ADJUDICATION_CASE_ID,
      originalDecisionId: ADJUDICATION_DECISION_ID,
      currentEvidenceDigest: ACKNOWLEDGED_FINGERPRINT,
    }),
  );
  assert.notEqual(
    base,
    createHandoverReviewAdjudicationId({
      caseId: ADJUDICATION_CASE_ID,
      originalDecisionId: createHandoverReviewDecisionId(ADJUDICATION_CASE_ID, "ack-key-0002"),
      currentEvidenceDigest: CONTRADICTED_FINGERPRINT,
    }),
  );
  assert.notEqual(
    base,
    createHandoverReviewAdjudicationId({
      caseId: createHandoverReviewCaseId("handover_v2_other"),
      originalDecisionId: ADJUDICATION_DECISION_ID,
      currentEvidenceDigest: CONTRADICTED_FINGERPRINT,
    }),
  );

  const auditId = createHandoverReviewAdjudicationAuditId(base);
  assert.match(auditId, /^handover_review_adjudication_audit_v1_[0-9a-f]{40}$/);
  assert.notEqual(auditId, base);
  assert.notEqual(auditId, createHandoverReviewAdjudicationAuditId(
    createHandoverReviewAdjudicationId({
      caseId: ADJUDICATION_CASE_ID,
      originalDecisionId: ADJUDICATION_DECISION_ID,
      currentEvidenceDigest: ACKNOWLEDGED_FINGERPRINT,
    }),
  ));
});

test("an adjudication body carries only the decision, the inspected fingerprint and the finding", () => {
  const parsed = parseHandoverReviewAdjudicationBody(adjudicationBody());
  assert.equal(parsed.originalDecisionId, ADJUDICATION_DECISION_ID);
  assert.equal(parsed.expectedCaseRevision, 1);
  assert.equal(parsed.expectedFingerprint, CONTRADICTED_FINGERPRINT);
  assert.equal(parsed.requestHash.length, 64);
  assert.equal(
    parsed.requestHash,
    parseHandoverReviewAdjudicationBody(adjudicationBody()).requestHash,
    "the request hash is stable for identical intent",
  );
  assert.notEqual(
    parsed.requestHash,
    parseHandoverReviewAdjudicationBody(
      adjudicationBody({ finding: "A different finding over the same contradiction." }),
    ).requestHash,
  );

  const rejected = [
    adjudicationBody({ classification: "completed_valid" }),
    adjudicationBody({ actorUid: "someone-else" }),
    adjudicationBody({ timestamp: "2026-10-31T00:00:00.000Z" }),
    adjudicationBody({ currentEvidenceDigest: CONTRADICTED_FINGERPRINT }),
    adjudicationBody({ originalDecisionId: "" }),
    adjudicationBody({ originalDecisionId: "decision with spaces" }),
    adjudicationBody({ idempotencyKey: "short" }),
    adjudicationBody({ expectedCaseRevision: -1 }),
    adjudicationBody({ expectedCaseRevision: 1.5 }),
    adjudicationBody({ expectedFingerprint: "not-a-hash" }),
    adjudicationBody({ finding: "too short" }),
    null,
    [],
    "not-an-object",
  ];
  for (const candidate of rejected) {
    assert.throws(
      () => parseHandoverReviewAdjudicationBody(candidate),
      HandoverReviewInputError,
      JSON.stringify(candidate),
    );
  }
});

test("the historical link is only proven by the acknowledgement that closed the case", () => {
  const ineligible = (input, code) => {
    const found = findHistoricalAcknowledgedDecision(input);
    assert.equal(found.decision, null, code);
    assert.equal(found.code, code);
    assert.ok(found.message.length > 0);
  };

  ineligible({ caseRecord: null, decisions: [] }, HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_FOUND);
  ineligible(
    {
      caseRecord: adjudicationCaseRecord({ status: HANDOVER_REVIEW_CASE_STATUSES.UNDER_INVESTIGATION }),
      decisions: [acknowledgedDecision()],
    },
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_CLOSED,
  );
  ineligible(
    { caseRecord: adjudicationCaseRecord({ lastDecisionId: null }), decisions: [] },
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_ACKNOWLEDGEMENT,
  );
  ineligible(
    { caseRecord: adjudicationCaseRecord(), decisions: [] },
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_ACKNOWLEDGEMENT,
  );
  ineligible(
    {
      caseRecord: adjudicationCaseRecord(),
      decisions: [
        acknowledgedDecision({
          decisionType: HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE,
          classification: HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
        }),
      ],
    },
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_ACKNOWLEDGEMENT,
  );
  ineligible(
    {
      caseRecord: adjudicationCaseRecord({ caseRevision: 2 }),
      decisions: [acknowledgedDecision()],
    },
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.HISTORY_MISMATCH,
  );
  ineligible(
    {
      caseRecord: adjudicationCaseRecord({ fingerprintAtLastDecision: CONTRADICTED_FINGERPRINT }),
      decisions: [acknowledgedDecision()],
    },
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.HISTORY_MISMATCH,
  );
  ineligible(
    {
      caseRecord: adjudicationCaseRecord({ handoverDocumentId: "handover_v2_other" }),
      decisions: [acknowledgedDecision()],
    },
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.HISTORY_MISMATCH,
  );
  ineligible(
    {
      caseRecord: adjudicationCaseRecord(),
      decisions: [acknowledgedDecision({ reviewReasonCodes: ["APPLICATION_INCONSISTENT"] })],
    },
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.HISTORY_MISMATCH,
  );

  const found = findHistoricalAcknowledgedDecision({
    caseRecord: adjudicationCaseRecord(),
    decisions: [acknowledgedDecision()],
  });
  assert.equal(found.decision?.id, ADJUDICATION_DECISION_ID);
  assert.equal(found.code, null);
});

test("eligibility requires live authoritative evidence that no longer supports the acknowledgement", () => {
  const assess = (overrides = {}) =>
    evaluateHandoverAdjudicationEligibility({
      caseRecord: adjudicationCaseRecord(),
      decisions: [acknowledgedDecision()],
      currentClassification: HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED,
      currentEvidenceDigest: CONTRADICTED_FINGERPRINT,
      currentReviewReasonCodes: ["APPLICATION_INCONSISTENT"],
      currentCaseRevision: 1,
      ...overrides,
    });

  const eligible = assess();
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.code, null);
  assert.equal(eligible.acknowledgedDecision?.id, ADJUDICATION_DECISION_ID);

  const noContradiction = assess({
    currentClassification: HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID,
    currentReviewReasonCodes: [],
  });
  assert.equal(noContradiction.eligible, false);
  assert.equal(noContradiction.code, HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_CONTRADICTION);

  const unchanged = assess({ currentEvidenceDigest: ACKNOWLEDGED_FINGERPRINT });
  assert.equal(unchanged.eligible, false);
  assert.equal(unchanged.code, HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.EVIDENCE_UNCHANGED);

  const unexplained = assess({ currentReviewReasonCodes: [] });
  assert.equal(unexplained.eligible, false);
  assert.equal(unexplained.code, HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.EVIDENCE_UNCHANGED);

  const drifted = assess({ currentCaseRevision: 2 });
  assert.equal(drifted.eligible, false);
  assert.equal(drifted.code, HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.HISTORY_MISMATCH);

  // The proof is never taken from the request: an eligibility assessment with no
  // case at all cannot be rescued by a contradictory-looking classification.
  const missing = assess({ caseRecord: null });
  assert.equal(missing.eligible, false);
  assert.equal(missing.code, HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_FOUND);
});

test("ineligibility maps to stable, non-retryable error codes", () => {
  const scope = (code) => ({
    eligible: false,
    code,
    message: "refused",
    acknowledgedDecision: null,
  });

  assert.throws(
    () => adjudicationIneligible(scope(HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_FOUND)),
    (error) => {
      assert.ok(error instanceof HandoverAdjudicationError);
      assert.equal(error.code, "ADJUDICATION_CASE_NOT_FOUND");
      assert.equal(error.status, 404);
      assert.equal(error.reasonCode, HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_FOUND);
      return true;
    },
  );

  for (const code of [
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.CASE_NOT_CLOSED,
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_ACKNOWLEDGEMENT,
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.HISTORY_MISMATCH,
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_CONTRADICTION,
    HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.EVIDENCE_UNCHANGED,
  ]) {
    assert.throws(
      () => adjudicationIneligible(scope(code)),
      (error) => {
        assert.ok(error instanceof HandoverAdjudicationError);
        assert.equal(error.code, "ADJUDICATION_NOT_ELIGIBLE");
        assert.equal(error.status, 409);
        assert.equal(error.reasonCode, code);
        return true;
      },
    );
  }
});
