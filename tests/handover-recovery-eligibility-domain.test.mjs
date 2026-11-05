/**
 * Phase 8C.3 — network-free contract tests for the recovery-eligibility
 * classifier and evidence digest.
 *
 * No emulator, no Firebase, no route module. These tests pin:
 *   - each of the nine classifications is reachable and distinguishable;
 *   - precedence is exactly the documented order and every refusal is reported;
 *   - a proven acceptance always outranks uncertainty and conflicts;
 *   - unverifiable evidence never becomes a confident refusal;
 *   - the digest is deterministic, order-insensitive where order is not
 *     semantic, sensitive to every safety-relevant field, and independent of
 *     evaluation time and actor identity;
 *   - no result can ever claim execution authority.
 *
 * Run: node --import tsx --test tests/handover-recovery-eligibility-domain.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS as C,
  HANDOVER_RECOVERY_ELIGIBILITY_DETAILS as D,
  HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA,
  HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION,
  HANDOVER_RECOVERY_ELIGIBILITY_PRECEDENCE,
  HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA,
  HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA_VERSION,
} from "../src/types/handover-recovery-eligibility.ts";
import {
  classifyHandoverRecoveryEligibility,
  createHandoverRecoveryEligibilityDigest,
  createHandoverRecoveryEligibilityResult,
  handoverRecoveryEligibilityDigestInput,
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
const EVIDENCE_ID = (uid, kind) => `att2_ev_${uid}_${kind}`;
const OPERATION_ID = (uid, kind) => `att2_op_${uid}_${kind}`;

function identity(overrides = {}) {
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
    ...overrides,
  };
}

function guardView(overrides = {}) {
  const id = identity();
  return {
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
    ...overrides,
  };
}

function aggregateView(overrides = {}, identityOverrides = {}) {
  const id = identity(identityOverrides);
  return {
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
    ...overrides,
  };
}

function application(uid, overrides = {}) {
  return {
    technicianUid: uid,
    receiptId: `acceptance_app_v1_${uid}`,
    present: false,
    receiptHash: null,
    outcome: null,
    evidenceKind: null,
    auditId: `acceptance_application_v1_${uid}`,
    auditPresent: false,
    unreadable: false,
    ...overrides,
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
    legacyOperationId: `att2_op_legacy_${uid}_${kind}`,
    legacyOperationPresent: false,
    legacyOperationStatus: null,
    legacyOperationInterrupted: false,
    requestDigest: null,
    unreadable: false,
    ...overrides,
  };
}

// A complete, eligible read model: a committed zero-acceptance handover whose
// window has closed on the server clock.
function model(overrides = {}) {
  return {
    handoverDocumentId: HANDOVER,
    outgoingShiftId: OUTGOING,
    incomingShiftId: INCOMING,
    aggregate: aggregateView(),
    guard: guardView(),
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
    applications: [application(IN_A), application(IN_B)],
    memberships: [],
    attendance: [],
    evidence: [
      evidenceSlot(IN_A, "incoming_clock_in"),
      evidenceSlot(IN_A, "incoming_late_acceptance"),
      evidenceSlot(IN_B, "incoming_clock_in"),
      evidenceSlot(IN_B, "incoming_late_acceptance"),
    ],
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
    reviewCase: { present: false, id: "review_case_1", status: null, caseRevision: null, fingerprint: null, unreadable: false },
    kindSetComplete: true,
    ...overrides,
  };
}

function classify(overrides) {
  return classifyHandoverRecoveryEligibility(model(overrides));
}

function assertRefusal(conclusion, classification, detail) {
  assert.equal(conclusion.classification, classification);
  assert.ok(
    conclusion.refusals.some((entry) => entry.code === classification && entry.detail === detail),
    `expected ${classification}/${detail}, got ${conclusion.refusals.map((r) => `${r.code}/${r.detail}`).join(" ")}`,
  );
}

// ---------------------------------------------------------------------------
// 1. The eligible baseline
// ---------------------------------------------------------------------------

test("01 a committed, expired, zero-acceptance handover is eligible for review only", () => {
  const conclusion = classify();
  assert.equal(conclusion.classification, C.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
  assert.deepEqual(conclusion.refusals, []);
  const result = createHandoverRecoveryEligibilityResult(model(), conclusion, "2026-11-01T00:00:00.000Z");
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.executionAuthority, "none");
  assert.equal(result.readModelStability, "point_in_time_transaction");
  assert.match(result.concurrencyNotice, /not an execution authorization/i);
  assert.equal(result.schema, HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA);
  assert.equal(result.schemaVersion, HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA_VERSION);
});

test("02 the result references only identifiers, never document bodies", () => {
  const conclusion = classify();
  const result = createHandoverRecoveryEligibilityResult(model(), conclusion, "2026-11-01T00:00:00.000Z");
  assert.deepEqual(Object.keys(result.references).sort(), [
    "activationReceiptId",
    "applicationReceiptIds",
    "commitReceiptId",
    "guardId",
    "latestActivationAt",
    "reviewCaseId",
    "scheduledEnd",
    "slotGeneration",
  ]);
  assert.deepEqual(result.references.applicationReceiptIds, [
    `acceptance_app_v1_${IN_A}`,
    `acceptance_app_v1_${IN_B}`,
  ]);
});

test("03 the digest is deterministic for equivalent reads", () => {
  const first = createHandoverRecoveryEligibilityDigest(model(), classify());
  const second = createHandoverRecoveryEligibilityDigest(model(), classify());
  assert.deepEqual(first, second);
  assert.equal(first.schema, HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA);
  assert.equal(first.schemaVersion, HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION);
  assert.equal(first.algorithm, "sha256");
  assert.match(first.value, /^[0-9a-f]{64}$/);
});

test("04 the digest excludes evaluation time and actor identity", () => {
  const conclusion = classify();
  const early = createHandoverRecoveryEligibilityResult(model(), conclusion, "2026-11-01T00:00:00.000Z");
  const late = createHandoverRecoveryEligibilityResult(model(), conclusion, "2027-01-01T00:00:00.000Z");
  assert.notEqual(early.evaluatedAt, late.evaluatedAt);
  assert.deepEqual(early.evidenceDigest, late.evidenceDigest);
});

test("05 the digest ignores non-semantic array order but keeps semantic order", () => {
  const base = model();
  const reordered = model({
    memberships: [...base.memberships].reverse(),
    attendance: [...base.attendance].reverse(),
    evidence: [...base.evidence].reverse(),
    reconciliation: [...base.reconciliation].reverse(),
  });
  assert.equal(
    createHandoverRecoveryEligibilityDigest(base, classify()).value,
    createHandoverRecoveryEligibilityDigest(reordered, classifyHandoverRecoveryEligibility(reordered)).value,
  );
  const identityReordered = model({
    aggregate: aggregateView({}, { outgoingTechnicianIds: [OUT_B, OUT_A] }),
    outgoingShift: { ...base.outgoingShift, primaryTechnicianIds: [OUT_B, OUT_A] },
  });
  assert.notEqual(
    createHandoverRecoveryEligibilityDigest(base, classify()).value,
    createHandoverRecoveryEligibilityDigest(identityReordered, classifyHandoverRecoveryEligibility(identityReordered)).value,
    "technician position order is semantic and must change the digest",
  );
});

test("06 every safety-relevant field changes the digest", () => {
  const baseInput = handoverRecoveryEligibilityDigestInput(model(), classify());
  const mutations = [
    model({ aggregate: aggregateView({ revision: 5 }) }),
    model({ guard: guardView({ guardRevision: 2 }) }),
    model({ outgoingShift: { ...model().outgoingShift, actualEnd: "2026-10-31T16:00:00.000Z" } }),
    model({ slot: { ...model().slot, generation: 2 } }),
    model({ activationWindow: { ...model().activationWindow, closedAtEvaluation: false } }),
    model({ commitReceipt: { present: false, id: "handover-commit-v2_x", receiptHash: null, valid: false } }),
    model({ applications: [application(IN_A, { present: true, auditPresent: true }), application(IN_B)] }),
    model({ memberships: [{ id: `${INCOMING}_${IN_A}`, present: true, joinedAt: SCHEDULED_START, leftAt: null }] }),
    model({ reviewCase: { present: true, id: "review_case_1", status: "open", caseRevision: 1, fingerprint: "e".repeat(64), unreadable: false } }),
  ];
  for (const mutation of mutations) {
    const input = handoverRecoveryEligibilityDigestInput(
      mutation,
      classifyHandoverRecoveryEligibility(mutation),
    );
    assert.notEqual(input, baseInput, "a safety-relevant change must change the digest material");
  }
});

test("07 the digest schema is not derived from caller input alone", () => {
  assert.equal(
    createHandoverRecoveryEligibilityDigest(model(), classify()).value,
    createHandoverRecoveryEligibilityDigest(model(), classify()).value,
  );
  const empty = model({ aggregate: { ...model().aggregate, present: false, identity: null, reservation: null, reportBinding: null } });
  assert.notEqual(
    createHandoverRecoveryEligibilityDigest(empty, classifyHandoverRecoveryEligibility(empty)).value,
    createHandoverRecoveryEligibilityDigest(model(), classify()).value,
  );
});

// ---------------------------------------------------------------------------
// 2. Applicability and readability
// ---------------------------------------------------------------------------

test("08 an absent aggregate is not applicable", () => {
  assertRefusal(
    classify({
      aggregate: {
        present: false,
        id: HANDOVER,
        lifecycleStatus: null,
        revision: null,
        snapshotHash: null,
        identity: null,
        reservation: null,
        reportBinding: null,
        unreadable: false,
      },
    }),
    C.HANDOVER_NOT_APPLICABLE,
    D.HANDOVER_NOT_FOUND,
  );
});

test("09 an unreadable aggregate stops short of eligibility", () => {
  assertRefusal(
    classify({ aggregate: aggregateView({ unreadable: true, identity: null, reservation: null }) }),
    C.EVIDENCE_UNVERIFIABLE,
    D.AGGREGATE_UNREADABLE,
  );
});

test("10 an uncommitted aggregate is not applicable", () => {
  assertRefusal(
    classify({ aggregate: aggregateView({ lifecycleStatus: "collecting_confirmations" }) }),
    C.HANDOVER_NOT_APPLICABLE,
    D.AGGREGATE_NOT_COMMITTED,
  );
});

test("11 a cancelled aggregate is terminal and not applicable", () => {
  assertRefusal(
    classify({ aggregate: aggregateView({ lifecycleStatus: "cancelled" }) }),
    C.HANDOVER_NOT_APPLICABLE,
    D.AGGREGATE_TERMINAL,
  );
});

test("12 a completed aggregate proves an acceptance", () => {
  const conclusion = classify({ aggregate: aggregateView({ lifecycleStatus: "completed" }) });
  assertRefusal(conclusion, C.ACCEPTANCE_EXISTS, D.AGGREGATE_COMPLETED);
});

// ---------------------------------------------------------------------------
// 3. Commit, report and guard integrity
// ---------------------------------------------------------------------------

test("13 a missing frozen report binding is inconsistent", () => {
  assertRefusal(
    classify({ aggregate: aggregateView({ reportBinding: null }) }),
    C.INCONSISTENT_EVIDENCE,
    D.REPORT_BINDING_MISSING,
  );
});

test("14 a missing commit receipt is inconsistent", () => {
  assertRefusal(
    classify({ commitReceipt: { present: false, id: "handover-commit-v2_x", receiptHash: null, valid: false } }),
    C.INCONSISTENT_EVIDENCE,
    D.COMMIT_RECEIPT_MISSING,
  );
});

test("15 an invalid commit receipt is inconsistent", () => {
  assertRefusal(
    classify({ commitReceipt: { present: true, id: "handover-commit-v2_x", receiptHash: "c".repeat(64), valid: false } }),
    C.INCONSISTENT_EVIDENCE,
    D.COMMIT_RECEIPT_INVALID,
  );
});

test("16 an unverifiable frozen report stops short of eligibility", () => {
  assertRefusal(
    classify({ report: { ...model().report, verified: false } }),
    C.EVIDENCE_UNVERIFIABLE,
    D.REPORT_UNREADABLE,
  );
});

test("17 a missing guard is a binding conflict", () => {
  assertRefusal(
    classify({ guard: guardView({ present: false }) }),
    C.GUARD_BINDING_CONFLICT,
    D.GUARD_MISSING,
  );
});

test("18 an unreadable guard stops short of eligibility", () => {
  assertRefusal(
    classify({ guard: guardView({ unreadable: true }) }),
    C.EVIDENCE_UNVERIFIABLE,
    D.GUARD_UNREADABLE,
  );
});

test("19 a v1 guard is a binding conflict", () => {
  assertRefusal(
    classify({ guard: guardView({ protocolOwner: "v1" }) }),
    C.GUARD_BINDING_CONFLICT,
    D.GUARD_NOT_V2,
  );
});

test("20 a guard of another handover is a binding conflict", () => {
  assertRefusal(
    classify({ guard: guardView({ ownerHandoverDocumentId: "handover_v2_other" }) }),
    C.GUARD_BINDING_CONFLICT,
    D.GUARD_OWNER_MISMATCH,
  );
});

test("21 a guard of another reservation is a binding conflict", () => {
  assertRefusal(
    classify({ guard: guardView({ reservationId: "handover_v2_other" }) }),
    C.GUARD_BINDING_CONFLICT,
    D.GUARD_RESERVATION_MISMATCH,
  );
});

test("22 a guard with a different slot lineage is a binding conflict", () => {
  assertRefusal(
    classify({ guard: guardView({ successorSlotToken: TOKEN }) }),
    C.GUARD_BINDING_CONFLICT,
    D.GUARD_TOKEN_MISMATCH,
  );
});

test("23 a guard epoch that no longer matches the frozen report is a binding conflict", () => {
  assertRefusal(
    classify({ guard: guardView({ fencingEpoch: 2 }) }),
    C.GUARD_BINDING_CONFLICT,
    D.GUARD_EPOCH_MISMATCH,
  );
});

test("24 a guard that is not ahead of its archived history is a binding conflict", () => {
  assertRefusal(
    classify({
      guardHistory: {
        present: true,
        unreadable: false,
        entries: [
          {
            id: "guard_archive_1_hash",
            ownerLifecycleState: "cancelled",
            guardRevision: 1,
            fencingEpoch: 1,
            outgoingSlotToken: TOKEN,
            terminalEvidenceRef: null,
          },
        ],
      },
    }),
    C.GUARD_BINDING_CONFLICT,
    D.GUARD_REVISION_MISMATCH,
  );
});

test("25 an unreadable guard archive stops short of eligibility", () => {
  assertRefusal(
    classify({ guardHistory: { present: true, unreadable: true, entries: [] } }),
    C.EVIDENCE_UNVERIFIABLE,
    D.GUARD_HISTORY_UNREADABLE,
  );
});

test("26 a non-active guard is a binding conflict", () => {
  assertRefusal(
    classify({ guard: guardView({ ownerLifecycleState: "pending" }) }),
    C.GUARD_BINDING_CONFLICT,
    D.GUARD_LIFECYCLE_NOT_ACTIVE,
  );
});

test("27 an active guard with unexplained terminal evidence is refused", () => {
  assertRefusal(
    classify({ guard: guardView({ terminalEvidenceRef: "guard_archive_unknown" }) }),
    C.GUARD_BINDING_CONFLICT,
    D.GUARD_LIFECYCLE_NOT_ACTIVE,
  );
});

test("28 an active re-acquired guard bound to its archived predecessor stays eligible", () => {
  const archived = {
    id: "guard_archive_1_hash",
    ownerLifecycleState: "cancelled",
    guardRevision: 1,
    fencingEpoch: 1,
    outgoingSlotToken: TOKEN,
    terminalEvidenceRef: null,
  };
  const conclusion = classify({
    aggregate: aggregateView({ reportBinding: { ...aggregateView().reportBinding, fencingEpoch: 2 } }),
    guard: guardView({ guardRevision: 3, fencingEpoch: 2, terminalEvidenceRef: archived.id }),
    guardHistory: { present: true, unreadable: false, entries: [archived] },
  });
  assert.equal(conclusion.classification, C.ELIGIBLE_FOR_ABANDONMENT_REVIEW, JSON.stringify(conclusion.refusals));
});

test("29 a terminal guard while the aggregate is open is inconsistent", () => {
  assertRefusal(
    classify({ guard: guardView({ ownerLifecycleState: "completed" }) }),
    C.INCONSISTENT_EVIDENCE,
    D.GUARD_TERMINAL_AGGREGATE_OPEN,
  );
});

test("30 an ambiguous legacy reservation stops short of eligibility", () => {
  assertRefusal(
    classify({ legacyHandover: { present: true, id: `handover_${OUTGOING}`, lifecycleStatus: "collecting_confirmations" } }),
    C.EVIDENCE_UNVERIFIABLE,
    D.LEGACY_RESERVATION_AMBIGUOUS,
  );
});

// ---------------------------------------------------------------------------
// 4. Shift and slot ownership
// ---------------------------------------------------------------------------

test("31 a missing outgoing shift stops short of eligibility", () => {
  assertRefusal(
    classify({
      outgoingShift: {
        present: false,
        id: OUTGOING,
        status: null,
        actualStart: null,
        actualEnd: null,
        handoverStartedAt: null,
        permanentPairId: null,
        primaryTechnicianIds: [],
        unreadable: false,
      },
    }),
    C.EVIDENCE_UNVERIFIABLE,
    D.OUTGOING_SHIFT_UNREADABLE,
  );
});

test("32 a completed outgoing shift proves an acceptance", () => {
  assertRefusal(
    classify({ outgoingShift: { ...model().outgoingShift, status: "completed", actualEnd: SCHEDULED_END } }),
    C.ACCEPTANCE_EXISTS,
    D.OUTGOING_SHIFT_COMPLETED,
  );
});

test("33 an outgoing shift outside handover-pending is inconsistent", () => {
  assertRefusal(
    classify({ outgoingShift: { ...model().outgoingShift, status: "active" } }),
    C.INCONSISTENT_EVIDENCE,
    D.OUTGOING_SHIFT_STATUS_MISMATCH,
  );
});

test("34 an outgoing shift with a different pair is inconsistent", () => {
  assertRefusal(
    classify({ outgoingShift: { ...model().outgoingShift, permanentPairId: "pair-other" } }),
    C.INCONSISTENT_EVIDENCE,
    D.OUTGOING_SHIFT_BINDING_MISMATCH,
  );
});

test("35 a missing global slot is a slot binding conflict", () => {
  assertRefusal(
    classify({
      slot: {
        present: false,
        slotStatus: null,
        shiftId: null,
        shiftStatus: null,
        slotToken: null,
        generation: null,
        updatedAt: null,
        unreadable: false,
      },
    }),
    C.SLOT_BINDING_CONFLICT,
    D.SLOT_MISSING,
  );
});

test("36 an unreadable global slot stops short of eligibility", () => {
  assertRefusal(
    classify({ slot: { ...model().slot, unreadable: true } }),
    C.EVIDENCE_UNVERIFIABLE,
    D.SLOT_UNREADABLE,
  );
});

test("37 a slot owned by another shift is a slot binding conflict", () => {
  assertRefusal(
    classify({ slot: { ...model().slot, shiftId: "shift-other" } }),
    C.SLOT_BINDING_CONFLICT,
    D.SLOT_NOT_OWNED,
  );
});

test("38 a slot that is not consumed is a slot binding conflict", () => {
  assertRefusal(
    classify({ slot: { ...model().slot, slotStatus: "pending" } }),
    C.SLOT_BINDING_CONFLICT,
    D.SLOT_STATUS_MISMATCH,
  );
});

test("39 a slot whose shift status is not handover-pending is a slot binding conflict", () => {
  assertRefusal(
    classify({ slot: { ...model().slot, shiftStatus: "active" } }),
    C.SLOT_BINDING_CONFLICT,
    D.SLOT_SHIFT_STATUS_MISMATCH,
  );
});

test("40 a slot with another token is a slot binding conflict", () => {
  assertRefusal(
    classify({ slot: { ...model().slot, slotToken: SUCCESSOR } }),
    C.SLOT_BINDING_CONFLICT,
    D.SLOT_TOKEN_MISMATCH,
  );
});

test("41 a slot with another generation is a slot binding conflict", () => {
  assertRefusal(
    classify({ slot: { ...model().slot, generation: 2 } }),
    C.SLOT_BINDING_CONFLICT,
    D.SLOT_GENERATION_MISMATCH,
  );
});

// ---------------------------------------------------------------------------
// 5. Acceptance proofs
// ---------------------------------------------------------------------------

test("42 a created incoming shift proves an acceptance", () => {
  assertRefusal(
    classify({ incomingShift: { present: true, id: INCOMING, status: "scheduled", actualStart: null } }),
    C.ACCEPTANCE_EXISTS,
    D.INCOMING_SHIFT_ACTIVATED,
  );
});

test("43 a valid activation receipt proves an acceptance", () => {
  assertRefusal(
    classify({ activationReceipt: { present: true, id: "handover-activation-v2_x", receiptHash: "f".repeat(64), valid: true } }),
    C.ACCEPTANCE_EXISTS,
    D.ACTIVATION_RECEIPT_VALID,
  );
});

test("44 an invalid activation receipt is inconsistent", () => {
  assertRefusal(
    classify({ activationReceipt: { present: true, id: "handover-activation-v2_x", receiptHash: "f".repeat(64), valid: false } }),
    C.INCONSISTENT_EVIDENCE,
    D.ACTIVATION_RECEIPT_INVALID,
  );
});

test("45 an application receipt without its audit is inconsistent", () => {
  assertRefusal(
    classify({
      applications: [application(IN_A, { present: true }), application(IN_B)],
    }),
    C.INCONSISTENT_EVIDENCE,
    D.APPLICATION_WITHOUT_AUDIT,
  );
});

test("46 an acceptance audit without its receipt is inconsistent", () => {
  assertRefusal(
    classify({
      applications: [application(IN_A), application(IN_B, { auditPresent: true })],
    }),
    C.INCONSISTENT_EVIDENCE,
    D.AUDIT_WITHOUT_APPLICATION,
  );
});

test("47 an applied application receipt proves an acceptance", () => {
  assertRefusal(
    classify({
      applications: [application(IN_A, { present: true, auditPresent: true, outcome: "applied" }), application(IN_B)],
    }),
    C.ACCEPTANCE_EXISTS,
    D.APPLICATION_RECEIPT_VALID,
  );
});

test("48 an unreadable application receipt stops short of eligibility", () => {
  assertRefusal(
    classify({ applications: [application(IN_A, { unreadable: true }), application(IN_B)] }),
    C.EVIDENCE_UNVERIFIABLE,
    D.APPLICATION_UNREADABLE,
  );
});

test("49 incoming membership without a receipt is inconsistent", () => {
  assertRefusal(
    classify({
      memberships: [{ id: `${INCOMING}_${IN_A}`, present: true, joinedAt: SCHEDULED_START, leftAt: null }],
    }),
    C.INCONSISTENT_EVIDENCE,
    D.MEMBERSHIP_WITHOUT_RECEIPT,
  );
});

test("50 incoming attendance without a receipt is inconsistent", () => {
  assertRefusal(
    classify({
      attendance: [{ id: `${INCOMING}_${IN_A}`, present: true, clockIn: SCHEDULED_START, clockOut: null }],
    }),
    C.INCONSISTENT_EVIDENCE,
    D.ATTENDANCE_WITHOUT_RECEIPT,
  );
});

// ---------------------------------------------------------------------------
// 6. Evidence, reconciliation and review state
// ---------------------------------------------------------------------------

test("51 unreadable personal evidence stops short of eligibility", () => {
  assertRefusal(
    classify({
      evidence: [evidenceSlot(IN_A, "incoming_clock_in", { unreadable: true }), ...model().evidence.slice(1)],
    }),
    C.EVIDENCE_UNVERIFIABLE,
    D.EVIDENCE_UNREADABLE,
  );
});

test("52 a pending evidence operation is uncertain, never eligible", () => {
  assertRefusal(
    classify({
      evidence: [
        evidenceSlot(IN_A, "incoming_clock_in", { operationPresent: true, operationStatus: "pending" }),
        ...model().evidence.slice(1),
      ],
    }),
    C.ACCEPTANCE_OUTCOME_UNCERTAIN,
    D.OPERATION_PENDING,
  );
});

test("53 an interrupted evidence operation is uncertain, never eligible", () => {
  assertRefusal(
    classify({
      evidence: [
        evidenceSlot(IN_A, "incoming_clock_in", { operationPresent: true, operationStatus: "finalized", operationInterrupted: true }),
        ...model().evidence.slice(1),
      ],
    }),
    C.ACCEPTANCE_OUTCOME_UNCERTAIN,
    D.OPERATION_INTERRUPTED,
  );
});

test("54 finalized evidence without a receipt is uncertain, never eligible", () => {
  assertRefusal(
    classify({
      evidence: [
        evidenceSlot(IN_A, "incoming_clock_in", { present: true, finalizedAt: SCHEDULED_START, snapshotHash: "a".repeat(64) }),
        ...model().evidence.slice(1),
      ],
    }),
    C.ACCEPTANCE_OUTCOME_UNCERTAIN,
    D.EVIDENCE_WITHOUT_RECEIPT,
  );
});

test("54b a pending legacy acceptance operation is uncertain, never eligible", () => {
  assertRefusal(
    classify({
      evidence: [
        evidenceSlot(IN_A, "incoming_clock_in", {
          legacyOperationPresent: true,
          legacyOperationStatus: "pending",
        }),
        ...model().evidence.slice(1),
      ],
    }),
    C.ACCEPTANCE_OUTCOME_UNCERTAIN,
    D.OPERATION_PENDING,
  );
});

test("54c an interrupted legacy acceptance operation is uncertain, never eligible", () => {
  assertRefusal(
    classify({
      evidence: [
        evidenceSlot(IN_A, "incoming_clock_in", {
          legacyOperationPresent: true,
          legacyOperationStatus: "finalized",
          legacyOperationInterrupted: true,
        }),
        ...model().evidence.slice(1),
      ],
    }),
    C.ACCEPTANCE_OUTCOME_UNCERTAIN,
    D.OPERATION_INTERRUPTED,
  );
});

test("54d atomic and legacy operations for one evidence slot are inconsistent", () => {
  assertRefusal(
    classify({
      evidence: [
        evidenceSlot(IN_A, "incoming_clock_in", {
          operationPresent: true,
          operationStatus: "finalized",
          legacyOperationPresent: true,
          legacyOperationStatus: "finalized",
        }),
        ...model().evidence.slice(1),
      ],
    }),
    C.INCONSISTENT_EVIDENCE,
    D.DUPLICATE_EVIDENCE_OPERATIONS,
  );
});

test("55 every review-relevant reconciliation status is mapped to a refusal", () => {
  const cases = [
    ["APPLIED_VALIDATED", C.ACCEPTANCE_EXISTS, D.APPLICATION_RECEIPT_VALID],
    ["EVIDENCE_ONLY", C.ACCEPTANCE_OUTCOME_UNCERTAIN, D.EVIDENCE_WITHOUT_RECEIPT],
    ["COMMIT_UNVERIFIABLE", C.ACCEPTANCE_OUTCOME_UNCERTAIN, D.OPERATION_INTERRUPTED],
    ["INCONSISTENT_HISTORY", C.INCONSISTENT_EVIDENCE, D.RECONCILIATION_REQUIRES_REVIEW],
    ["BINDING_CONFLICT", C.INCONSISTENT_EVIDENCE, D.RECONCILIATION_REQUIRES_REVIEW],
    ["GUARD_CONFLICT", C.INCONSISTENT_EVIDENCE, D.RECONCILIATION_REQUIRES_REVIEW],
    ["ADMIN_REVIEW_REQUIRED", C.INCONSISTENT_EVIDENCE, D.RECONCILIATION_REQUIRES_REVIEW],
  ];
  for (const [status, classification, detail] of cases) {
    const conclusion = classify({
      reconciliation: [
        { technicianUid: IN_A, status, reason: "SYNTHETIC" },
        { technicianUid: IN_B, status: "NOT_APPLIED", reason: "NO_APPLICATION_RECORD" },
      ],
    });
    assert.notEqual(conclusion.classification, C.ELIGIBLE_FOR_ABANDONMENT_REVIEW, status);
    assert.ok(
      conclusion.refusals.some((entry) => entry.code === classification && entry.detail === detail),
      `${status} must map to ${classification}/${detail}`,
    );
  }
});

test("56 an unreadable review case stops short of eligibility", () => {
  assertRefusal(
    classify({
      reviewCase: { present: true, id: "review_case_1", status: null, caseRevision: null, fingerprint: null, unreadable: true },
    }),
    C.EVIDENCE_UNVERIFIABLE,
    D.REVIEW_CASE_UNREADABLE,
  );
});

test("57 an incomplete evidence-kind enumeration cannot prove absence", () => {
  assertRefusal(
    classify({ kindSetComplete: false }),
    C.EVIDENCE_UNVERIFIABLE,
    D.KIND_SET_UNVERIFIED,
  );
});

// ---------------------------------------------------------------------------
// 7. Window and precedence
// ---------------------------------------------------------------------------

test("58 a closed window is required: otherwise the window is still open", () => {
  assertRefusal(
    classify({ activationWindow: { ...model().activationWindow, closedAtEvaluation: false } }),
    C.ACTIVATION_WINDOW_OPEN,
    D.ACTIVATION_WINDOW_OPEN,
  );
});

test("59 the window is evaluated last: a contradiction outranks an open window", () => {
  const conclusion = classify({
    activationWindow: { ...model().activationWindow, closedAtEvaluation: false },
    memberships: [{ id: `${INCOMING}_${IN_A}`, present: true, joinedAt: SCHEDULED_START, leftAt: null }],
  });
  assert.equal(conclusion.classification, C.INCONSISTENT_EVIDENCE);
  assert.equal(conclusion.refusals.some((entry) => entry.code === C.ACTIVATION_WINDOW_OPEN), false);
});

test("60 a proven acceptance outranks guard conflicts", () => {
  const conclusion = classify({
    guard: guardView({ protocolOwner: "v1" }),
    activationReceipt: { present: true, id: "handover-activation-v2_x", receiptHash: "f".repeat(64), valid: true },
  });
  assert.equal(conclusion.classification, C.ACCEPTANCE_EXISTS);
});

test("61 unverifiable evidence outranks a proven acceptance", () => {
  const conclusion = classify({
    activationReceipt: { present: true, id: "handover-activation-v2_x", receiptHash: "f".repeat(64), valid: true },
    kindSetComplete: false,
  });
  assert.equal(conclusion.classification, C.EVIDENCE_UNVERIFIABLE);
});

test("62 not-applicable outranks every other refusal", () => {
  const conclusion = classify({
    aggregate: aggregateView({ lifecycleStatus: "cancelled" }),
    kindSetComplete: false,
    guard: guardView({ protocolOwner: "v1" }),
  });
  assert.equal(conclusion.classification, C.HANDOVER_NOT_APPLICABLE);
});

test("63 every applicable refusal is reported, not only the primary one", () => {
  const conclusion = classify({
    guard: guardView({ protocolOwner: "v1" }),
    slot: { ...model().slot, shiftId: "shift-other" },
    activationWindow: { ...model().activationWindow, closedAtEvaluation: false },
  });
  const details = new Set(conclusion.refusals.map((entry) => entry.detail));
  assert.ok(details.has(D.GUARD_NOT_V2));
  assert.ok(details.has(D.SLOT_NOT_OWNED));
  assert.equal(conclusion.classification, C.GUARD_BINDING_CONFLICT);
});

test("64 the precedence table is exactly the documented order", () => {
  assert.deepEqual(HANDOVER_RECOVERY_ELIGIBILITY_PRECEDENCE, [
    C.HANDOVER_NOT_APPLICABLE,
    C.EVIDENCE_UNVERIFIABLE,
    C.ACCEPTANCE_EXISTS,
    C.ACCEPTANCE_OUTCOME_UNCERTAIN,
    C.INCONSISTENT_EVIDENCE,
    C.GUARD_BINDING_CONFLICT,
    C.SLOT_BINDING_CONFLICT,
    C.ACTIVATION_WINDOW_OPEN,
  ]);
});

test("65 the nine classifications are exactly the nine documented codes", () => {
  assert.deepEqual(Object.values(C).sort(), [
    "acceptance_exists",
    "acceptance_outcome_uncertain",
    "activation_window_open",
    "eligible_for_abandonment_review",
    "evidence_unverifiable",
    "guard_binding_conflict",
    "handover_not_applicable",
    "inconsistent_evidence",
    "slot_binding_conflict",
  ]);
});
