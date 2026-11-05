/**
 * Phase 8C.4B §2 — network-free contract tests for the orphan-evidence safety
 * correction (finding F-1 from Phase 8C.4A).
 *
 * F-1 was: an attendance evidence *operation* document could exist with status
 * `finalized` while its authoritative evidence document was absent, and the
 * classifier had no rule for that shape, so the handover still read
 * `eligible_for_abandonment_review`.
 *
 * These tests pin the correction:
 *   - a terminal operation that asserts an evidence document which is missing is
 *     refused as inconsistent_evidence / OPERATION_WITHOUT_EVIDENCE and can never
 *     classify eligible, for the atomic and the legacy writer alike;
 *   - the correction reports the contradiction, it never fabricates the evidence
 *     (the read model still shows the slot absent after classification);
 *   - pending, interrupted and duplicated operations keep their existing
 *     fail-closed refusals and are not swallowed by the new rule;
 *   - an aborted operation with no evidence is NOT refused, because the
 *     coordinator abort contract terminates the attempt precisely because no
 *     evidence may exist — the abort record is that attempt's evidence;
 *   - an aborted operation that does have evidence stays refused by the existing
 *     evidence-without-receipt rule;
 *   - every orphan shape moves the evidence digest, the digest stays
 *     deterministic, and no result ever claims execution authority.
 *
 * Run: node --import tsx --test tests/handover-recovery-orphan-eligibility.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS as C,
  HANDOVER_RECOVERY_ELIGIBILITY_DETAILS as D,
  HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION,
  HANDOVER_RECOVERY_ELIGIBILITY_PRECEDENCE,
} from "../src/types/handover-recovery-eligibility.ts";
import {
  classifyHandoverRecoveryEligibility,
  createHandoverRecoveryEligibilityResult,
} from "../src/lib/operations/handover-recovery-eligibility-domain.ts";

const HANDOVER = "handover_v2_shift-outgoing";
const OUTGOING = "shift-outgoing";
const INCOMING = "shift_v2c_0123456789abcdef0123456789abcdef01234567";
const TOKEN = "10000000-0000-4000-8000-000000000001";
const SUCCESSOR = "20000000-0000-4000-8000-000000000002";
const OUT_PAIR = "pair-outgoing";
const IN_PAIR = "pair-incoming";
const OUT_A = "out-a";
const OUT_B = "out-b";
const IN_A = "in-a";
const IN_B = "in-b";
const RESERVATION = "handover_v2_reservation";
const SCHEDULED_START = "2026-10-31T08:00:00.000Z";
const SCHEDULED_END = "2026-10-31T16:00:00.000Z";
const HANDOVER_STARTED = "2026-10-31T08:05:00.000Z";
const LATEST_ACTIVATION = "2026-10-31T09:00:00.000Z";
const FINALIZED_AT = "2026-10-31T08:40:00.000Z";
const ABORTED_AT = "2026-10-31T08:41:00.000Z";
const EVIDENCE_ID = (uid, kind) => `att2_ev_${uid}_${kind}`;
const OPERATION_ID = (uid, kind) => `att2_op_${uid}_${kind}`;
const LEGACY_OPERATION_ID = (uid, kind) => `att2_op_legacy_${uid}_${kind}`;

function identity() {
  return {
    outgoingShiftId: OUTGOING,
    outgoingPermanentPairId: OUT_PAIR,
    outgoingTechnicianIds: [OUT_A, OUT_B],
    outgoingSlotToken: TOKEN,
    outgoingGeneration: 1,
    incomingShiftId: INCOMING,
    incomingPermanentPairId: IN_PAIR,
    incomingTechnicianIds: [IN_A, IN_B],
    successorSlotToken: SUCCESSOR,
    successorGeneration: 2,
    shiftType: "morning",
    scheduledStart: SCHEDULED_START,
    scheduledEnd: SCHEDULED_END,
  };
}

function evidenceSlot(uid, kind, overrides = {}) {
  return {
    id: EVIDENCE_ID(uid, kind),
    technicianUid: uid,
    kind,
    present: false,
    finalizedAt: null,
    snapshotHash: null,
    guardRevision: null,
    fencingEpoch: null,
    operationId: OPERATION_ID(uid, kind),
    operationPresent: false,
    operationStatus: null,
    operationInterrupted: false,
    legacyOperationId: LEGACY_OPERATION_ID(uid, kind),
    legacyOperationPresent: false,
    legacyOperationStatus: null,
    legacyOperationInterrupted: false,
    requestDigest: null,
    unreadable: false,
    ...overrides,
  };
}

function slotPair(overridesA = {}, overridesB = {}) {
  return [
    evidenceSlot(IN_A, "incoming_clock_in", overridesA),
    evidenceSlot(IN_A, "incoming_late_acceptance"),
    evidenceSlot(IN_B, "incoming_clock_in", overridesB),
    evidenceSlot(IN_B, "incoming_late_acceptance"),
  ];
}

// A complete, eligible read model: a committed zero-acceptance handover whose
// activation window has closed on the server clock.
function model(overrides = {}) {
  const id = identity();
  return {
    handoverDocumentId: HANDOVER,
    outgoingShiftId: OUTGOING,
    incomingShiftId: INCOMING,
    aggregate: {
      present: true,
      id: HANDOVER,
      lifecycleStatus: "awaiting_incoming_acceptance",
      revision: 4,
      snapshotHash: "a".repeat(64),
      identity: id,
      reservation: {
        handoverId: RESERVATION,
        reservedIncomingShiftId: id.incomingShiftId,
        revision: 4,
        outgoingSlotToken: id.outgoingSlotToken,
        outgoingGeneration: id.outgoingGeneration,
        successorSlotToken: id.successorSlotToken,
        expectedSuccessorGeneration: id.successorGeneration,
        reservedAt: SCHEDULED_START,
        reservedBy: OUT_A,
      },
      reportBinding: {
        present: true,
        id: "report_1",
        reportDigest: "b".repeat(64),
        frozenAt: SCHEDULED_START,
        aggregateRevision: 4,
        fencingEpoch: 1,
      },
      unreadable: false,
    },
    guard: {
      present: true,
      id: `guard_${OUTGOING}`,
      protocolOwner: "v2",
      ownerHandoverDocumentId: HANDOVER,
      ownerLifecycleState: "active",
      guardRevision: 1,
      fencingEpoch: 1,
      outgoingSlotToken: id.outgoingSlotToken,
      outgoingGeneration: id.outgoingGeneration,
      successorSlotToken: id.successorSlotToken,
      successorGeneration: id.successorGeneration,
      reservationId: RESERVATION,
      reservedIncomingShiftId: id.incomingShiftId,
      reservedAt: SCHEDULED_START,
      terminalEvidenceRef: null,
      unreadable: false,
    },
    guardHistory: { present: false, unreadable: false, entries: [] },
    legacyHandover: { present: false, id: `handover_${OUTGOING}`, lifecycleStatus: null },
    outgoingShift: {
      present: true,
      id: OUTGOING,
      status: "handover_pending",
      actualStart: SCHEDULED_START,
      actualEnd: null,
      handoverStartedAt: HANDOVER_STARTED,
      permanentPairId: OUT_PAIR,
      primaryTechnicianIds: [OUT_A, OUT_B],
      unreadable: false,
    },
    slot: {
      present: true,
      slotStatus: "consumed",
      shiftId: OUTGOING,
      shiftStatus: "handover_pending",
      slotToken: TOKEN,
      generation: 1,
      updatedAt: HANDOVER_STARTED,
      unreadable: false,
    },
    activationWindow: {
      scheduledStart: SCHEDULED_START,
      scheduledEnd: SCHEDULED_END,
      latestActivationAt: LATEST_ACTIVATION,
      closedAtEvaluation: true,
    },
    commitReceipt: { present: true, id: "handover-commit-v2_x", receiptHash: "c".repeat(64), valid: true },
    activationReceipt: { present: false, id: "handover-activation-v2_x", receiptHash: null, valid: false },
    incomingShift: { present: false, id: INCOMING, status: null, actualStart: null },
    applications: [IN_A, IN_B].map((uid) => ({
      technicianUid: uid,
      receiptId: `acceptance_app_v1_${uid}`,
      present: false,
      receiptHash: null,
      outcome: null,
      evidenceKind: null,
      auditId: `acceptance_application_v1_${uid}`,
      auditPresent: false,
      unreadable: false,
    })),
    memberships: [],
    attendance: [],
    evidence: slotPair(),
    reconciliation: [
      { technicianUid: IN_A, status: "NOT_APPLIED", reason: "NO_APPLICATION_RECORD" },
      { technicianUid: IN_B, status: "NOT_APPLIED", reason: "NO_APPLICATION_RECORD" },
    ],
    report: {
      present: true,
      id: "report_1",
      reportDigest: "b".repeat(64),
      evidenceSnapshotHash: "d".repeat(64),
      frozenAt: SCHEDULED_START,
      verified: true,
    },
    reviewCase: {
      present: false,
      id: "review_case_1",
      status: null,
      caseRevision: null,
      fingerprint: null,
      unreadable: false,
    },
    kindSetComplete: true,
    ...overrides,
  };
}

function details(conclusion) {
  return conclusion.refusals.map((entry) => `${entry.code}:${entry.detail}`);
}

function classify(overrides) {
  return classifyHandoverRecoveryEligibility(model(overrides));
}

function digest(overrides) {
  return createHandoverRecoveryEligibilityResult(model(overrides), classify(overrides), FINALIZED_AT)
    .evidenceDigest;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

test("01 the clean zero-acceptance baseline still classifies eligible", () => {
  const conclusion = classify();
  assert.equal(conclusion.classification, C.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
  assert.deepEqual(conclusion.refusals, []);
  assert.equal(conclusion.refusals.some((entry) => entry.detail === D.OPERATION_WITHOUT_EVIDENCE), false);
});

test("02 the correction did not change the classification set or its precedence", () => {
  assert.equal(HANDOVER_RECOVERY_ELIGIBILITY_PRECEDENCE.length, 8);
  assert.deepEqual(Object.values(C).length, 9);
  assert.equal(C.ELIGIBLE_FOR_ABANDONMENT_REVIEW, "eligible_for_abandonment_review");
  assert.equal(HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION, 2);
  assert.equal(D.OPERATION_WITHOUT_EVIDENCE, "OPERATION_WITHOUT_EVIDENCE");
});

// ---------------------------------------------------------------------------
// The F-1 orphan shapes
// ---------------------------------------------------------------------------

test("03 a finalized atomic operation with no evidence is inconsistent, never eligible", () => {
  const conclusion = classify({
    evidence: slotPair({ operationPresent: true, operationStatus: "finalized", requestDigest: "e".repeat(64) }),
  });
  assert.equal(conclusion.classification, C.INCONSISTENT_EVIDENCE);
  assert.ok(details(conclusion).includes(`${C.INCONSISTENT_EVIDENCE}:${D.OPERATION_WITHOUT_EVIDENCE}`));
  assert.notEqual(conclusion.classification, C.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
});

test("04 a finalized legacy operation with no evidence is refused through the legacy id", () => {
  const conclusion = classify({
    evidence: slotPair({ legacyOperationPresent: true, legacyOperationStatus: "finalized" }),
  });
  assert.equal(conclusion.classification, C.INCONSISTENT_EVIDENCE);
  const refusal = conclusion.refusals.find((entry) => entry.detail === D.OPERATION_WITHOUT_EVIDENCE);
  assert.ok(refusal, JSON.stringify(details(conclusion)));
  assert.ok(refusal.message.includes(LEGACY_OPERATION_ID(IN_A, "incoming_clock_in")));
  assert.ok(refusal.message.includes(IN_A));
  assert.ok(refusal.message.includes(EVIDENCE_ID(IN_A, "incoming_clock_in")));
});

test("05 the refusal names the contradiction and cannot be read as an acceptance claim", () => {
  const conclusion = classify({
    evidence: slotPair({ operationPresent: true, operationStatus: "finalized" }),
  });
  const refusal = conclusion.refusals.find((entry) => entry.detail === D.OPERATION_WITHOUT_EVIDENCE);
  assert.match(refusal.message, /finalized but personal incoming evidence .* is missing/);
  assert.match(refusal.message, /absence of acceptance cannot be claimed/);
  // No acceptance is claimed anywhere: the applications stay absent.
  assert.equal(conclusion.refusals.some((entry) => entry.detail === D.APPLICATION_RECEIPT_VALID), false);
});

test("06 the correction does not fabricate evidence: the read model still shows the slot absent", () => {
  const overrides = { evidence: slotPair({ operationPresent: true, operationStatus: "finalized" }) };
  const before = model(overrides).evidence[0];
  const conclusion = classify(overrides);
  assert.equal(before.present, false);
  assert.equal(before.finalizedAt, null);
  assert.equal(before.snapshotHash, null);
  assert.equal(conclusion.classification, C.INCONSISTENT_EVIDENCE);
  const after = model(overrides).evidence[0];
  assert.deepEqual(after, before);
});

test("07 orphaned slots on both technicians refuse the handover as one deduplicated refusal", () => {
  const conclusion = classify({
    evidence: slotPair(
      { operationPresent: true, operationStatus: "finalized" },
      { legacyOperationPresent: true, legacyOperationStatus: "finalized" },
    ),
  });
  assert.equal(conclusion.classification, C.INCONSISTENT_EVIDENCE);
  const orphans = conclusion.refusals.filter((entry) => entry.detail === D.OPERATION_WITHOUT_EVIDENCE);
  // Refusals deduplicate by code+detail (the pre-existing 8C.3 convention), so
  // two orphaned slots collapse to one entry naming the first technician.
  assert.equal(orphans.length, 1);
  assert.ok(orphans[0].message.includes(IN_A));
});

test("08 a higher-precedence refusal does not hide the orphan refusal", () => {
  const conclusion = classify({
    kindSetComplete: false,
    evidence: slotPair({ operationPresent: true, operationStatus: "finalized" }),
  });
  assert.equal(conclusion.classification, C.EVIDENCE_UNVERIFIABLE);
  assert.ok(details(conclusion).includes(`${C.INCONSISTENT_EVIDENCE}:${D.OPERATION_WITHOUT_EVIDENCE}`));
});

test("09 an orphan operation with an open window still reports both refusals", () => {
  const conclusion = classify({
    activationWindow: {
      scheduledStart: SCHEDULED_START,
      scheduledEnd: SCHEDULED_END,
      latestActivationAt: "2099-01-01T00:00:00.000Z",
      closedAtEvaluation: false,
    },
    evidence: slotPair({ operationPresent: true, operationStatus: "finalized" }),
  });
  assert.equal(conclusion.classification, C.INCONSISTENT_EVIDENCE);
  assert.ok(details(conclusion).includes(`${C.INCONSISTENT_EVIDENCE}:${D.OPERATION_WITHOUT_EVIDENCE}`));
});

// ---------------------------------------------------------------------------
// Neighbouring operation states that must keep their own fail-closed behaviour
// ---------------------------------------------------------------------------

test("10 a pending operation keeps OPERATION_PENDING and is not re-labelled", () => {
  const conclusion = classify({
    evidence: slotPair({ operationPresent: true, operationStatus: "pending" }),
  });
  assert.equal(conclusion.classification, C.ACCEPTANCE_OUTCOME_UNCERTAIN);
  assert.ok(details(conclusion).includes(`${C.ACCEPTANCE_OUTCOME_UNCERTAIN}:${D.OPERATION_PENDING}`));
  assert.equal(details(conclusion).includes(`${C.INCONSISTENT_EVIDENCE}:${D.OPERATION_WITHOUT_EVIDENCE}`), false);
});

test("11 an interrupted finalization outranks the orphan rule and stays uncertain", () => {
  const conclusion = classify({
    evidence: slotPair({
      operationPresent: true,
      operationStatus: "finalized",
      operationInterrupted: true,
    }),
  });
  assert.equal(conclusion.classification, C.ACCEPTANCE_OUTCOME_UNCERTAIN);
  assert.ok(details(conclusion).includes(`${C.ACCEPTANCE_OUTCOME_UNCERTAIN}:${D.OPERATION_INTERRUPTED}`));
  assert.equal(details(conclusion).includes(`${C.INCONSISTENT_EVIDENCE}:${D.OPERATION_WITHOUT_EVIDENCE}`), false);
});

test("12 duplicated atomic and legacy operations stay inconsistent and are not double-reported", () => {
  const conclusion = classify({
    evidence: slotPair({
      operationPresent: true,
      operationStatus: "finalized",
      legacyOperationPresent: true,
      legacyOperationStatus: "finalized",
    }),
  });
  assert.equal(conclusion.classification, C.INCONSISTENT_EVIDENCE);
  assert.ok(details(conclusion).includes(`${C.INCONSISTENT_EVIDENCE}:${D.DUPLICATE_EVIDENCE_OPERATIONS}`));
  assert.equal(details(conclusion).includes(`${C.INCONSISTENT_EVIDENCE}:${D.OPERATION_WITHOUT_EVIDENCE}`), false);
});

test("13 conflicting statuses across the two writers are inconsistent, never eligible", () => {
  const conclusion = classify({
    evidence: slotPair({
      operationPresent: true,
      operationStatus: "finalized",
      legacyOperationPresent: true,
      legacyOperationStatus: "pending",
    }),
  });
  assert.notEqual(conclusion.classification, C.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
  assert.equal(conclusion.classification, C.INCONSISTENT_EVIDENCE);
});

test("14 an unreadable operation beside absent evidence fails closed as unverifiable", () => {
  const conclusion = classify({
    evidence: slotPair({ operationPresent: true, operationStatus: null, unreadable: true }),
  });
  assert.equal(conclusion.classification, C.EVIDENCE_UNVERIFIABLE);
  assert.ok(details(conclusion).includes(`${C.EVIDENCE_UNVERIFIABLE}:${D.EVIDENCE_UNREADABLE}`));
});

// ---------------------------------------------------------------------------
// The analysed exception: a controlled abort is terminal *and* evidence-free
// ---------------------------------------------------------------------------

test("15 an aborted operation with no evidence is the documented coherent abort outcome", () => {
  const conclusion = classify({
    evidence: slotPair({
      operationPresent: true,
      operationStatus: "aborted",
    }),
  });
  // Fail-closed means refusing ambiguous states; this state is unambiguous:
  // abortAttendanceEvidenceOperation only ever aborts a pending operation and
  // writes no evidence, so the abort record is that attempt's evidence.
  assert.equal(details(conclusion).includes(`${C.INCONSISTENT_EVIDENCE}:${D.OPERATION_WITHOUT_EVIDENCE}`), false);
  assert.equal(conclusion.classification, C.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
});

test("16 an aborted operation that does have evidence stays refused by the existing rule", () => {
  const conclusion = classify({
    evidence: slotPair({
      present: true,
      finalizedAt: FINALIZED_AT,
      snapshotHash: "f".repeat(64),
      guardRevision: 1,
      fencingEpoch: 1,
      operationPresent: true,
      operationStatus: "aborted",
    }),
  });
  assert.notEqual(conclusion.classification, C.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
  assert.equal(conclusion.classification, C.ACCEPTANCE_OUTCOME_UNCERTAIN);
  assert.ok(details(conclusion).includes(`${C.ACCEPTANCE_OUTCOME_UNCERTAIN}:${D.EVIDENCE_WITHOUT_RECEIPT}`));
});

test("17 a finalized operation beside present evidence is not an orphan", () => {
  const conclusion = classify({
    evidence: slotPair({
      present: true,
      finalizedAt: FINALIZED_AT,
      snapshotHash: "f".repeat(64),
      guardRevision: 1,
      fencingEpoch: 1,
      operationPresent: true,
      operationStatus: "finalized",
    }),
  });
  assert.equal(details(conclusion).includes(`${C.INCONSISTENT_EVIDENCE}:${D.OPERATION_WITHOUT_EVIDENCE}`), false);
  assert.ok(details(conclusion).includes(`${C.ACCEPTANCE_OUTCOME_UNCERTAIN}:${D.EVIDENCE_WITHOUT_RECEIPT}`));
});

// ---------------------------------------------------------------------------
// Digest consequences
// ---------------------------------------------------------------------------

test("18 the correction moves the evidence digest for every orphan shape", () => {
  const baseline = digest();
  const atomic = digest({ evidence: slotPair({ operationPresent: true, operationStatus: "finalized" }) });
  const legacy = digest({ evidence: slotPair({ legacyOperationPresent: true, legacyOperationStatus: "finalized" }) });
  const aborted = digest({ evidence: slotPair({ operationPresent: true, operationStatus: "aborted" }) });
  const values = [baseline.value, atomic.value, legacy.value, aborted.value];
  assert.equal(new Set(values).size, values.length, JSON.stringify(values));
  for (const entry of [atomic, legacy, aborted]) {
    assert.equal(entry.schemaVersion, HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION);
    assert.equal(entry.algorithm, "sha256");
    assert.match(entry.value, /^[0-9a-f]{64}$/);
  }
});

test("19 an orphan classification is deterministic across repeated evaluation", () => {
  const overrides = { evidence: slotPair({ operationPresent: true, operationStatus: "finalized" }) };
  const first = digest(overrides);
  const second = digest(overrides);
  assert.deepEqual(first, second);
  assert.equal(classify(overrides).classification, classify(overrides).classification);
});

test("20 no orphan result can claim execution authority", () => {
  const overrides = { evidence: slotPair({ operationPresent: true, operationStatus: "finalized" }) };
  const result = createHandoverRecoveryEligibilityResult(model(overrides), classify(overrides), FINALIZED_AT);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.executionAuthority, "none");
  assert.equal(result.readModelStability, "point_in_time_transaction");
  assert.match(result.concurrencyNotice, /must re-evaluate inside its own transaction/);
});
