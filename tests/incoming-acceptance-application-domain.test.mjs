/**
 * Pure domain tests for the atomic incoming-acceptance application protocol.
 * runInNewContext + ts.transpileModule only: no Firebase, no server-only imports,
 * no network and no shared state.
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const MODULE_PATHS = [
  "src/types/attendance-evidence.ts",
  "src/types/equal-technician-handover.ts",
  "src/types/handover-report-v2.ts",
  "src/types/incoming-acceptance-application.ts",
  "src/lib/operations/equal-handover-report-domain.ts",
  "src/lib/operations/equal-technician-handover-domain.ts",
  "src/lib/operations/attendance-evidence-domain.ts",
  "src/lib/operations/incoming-acceptance-application-domain.ts",
];

const sources = new Map();
for (const path of MODULE_PATHS) {
  sources.set(path, await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

const modules = new Map();

function load(path) {
  if (modules.has(path)) return modules.get(path);
  if (!sources.has(path)) throw new Error(`Module source was not preloaded: ${path}`);
  const loaded = { exports: {} };
  runInNewContext(
    ts.transpileModule(sources.get(path), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: loaded.exports,
      structuredClone,
      console,
      require(specifier) {
        if (specifier === "node:crypto") return { createHash };
        if (specifier.endsWith("types/attendance-evidence")) {
          return load("src/types/attendance-evidence.ts");
        }
        if (specifier.endsWith("types/equal-technician-handover")) {
          return load("src/types/equal-technician-handover.ts");
        }
        if (specifier.endsWith("types/handover-report-v2")) {
          return load("src/types/handover-report-v2.ts");
        }
        if (specifier.endsWith("types/incoming-acceptance-application")) {
          return load("src/types/incoming-acceptance-application.ts");
        }
        if (specifier === "./equal-handover-report-domain") {
          return load("src/lib/operations/equal-handover-report-domain.ts");
        }
        if (specifier === "./equal-technician-handover-domain") {
          return load("src/lib/operations/equal-technician-handover-domain.ts");
        }
        if (specifier === "./attendance-evidence-domain") {
          return load("src/lib/operations/attendance-evidence-domain.ts");
        }
        if (specifier === "./incoming-acceptance-application-domain") {
          return load("src/lib/operations/incoming-acceptance-application-domain.ts");
        }
        throw new Error(`Unexpected pure-domain import: ${specifier}`);
      },
    },
  );
  modules.set(path, loaded.exports);
  return loaded.exports;
}

const domain = load("src/lib/operations/incoming-acceptance-application-domain.ts");
const evidenceTypes = load("src/types/attendance-evidence.ts");

const CLOCK_IN = evidenceTypes.ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN;
const LATE_ACCEPTANCE = evidenceTypes.ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE;

const H = `handover_v2_${"a".repeat(64)}`;
const DOC = "handover_v2_shift_outgoing";
const OUTGOING = "shift_outgoing";
const INCOMING = "shift_incoming";
const A = "tech_in_a";
const B = "tech_in_b";
const START = "2026-10-28T08:00:00.000Z";
const END = "2026-10-28T16:00:00.000Z";
const ACTIVATION = "2026-10-28T08:00:00.000Z";
const JOIN = "2026-10-28T09:00:00.000Z";
const FIRST_REQUEST = "2026-10-28T07:59:58.000Z";
const FIRST_PASSWORD = "2026-10-28T07:59:59.000Z";
const FIRST_ACCOUNT = "2026-10-28T07:59:59.500Z";
const JOIN_REQUEST = "2026-10-28T08:59:58.000Z";
const JOIN_PASSWORD = "2026-10-28T08:59:59.000Z";
const JOIN_ACCOUNT = "2026-10-28T08:59:59.500Z";

function baseReport(overrides = {}) {
  return {
    schema: "handover-report-v2",
    id: "report_v2_00000000-0000-4000-8000-000000000001",
    digest: "1".repeat(64),
    evidenceSnapshotHash: "2".repeat(64),
    workSnapshotVersion: "work-v1",
    preparationId: `preparation_${H}`,
    preparationRevision: 3,
    reservationId: H,
    aggregateRevision: 7,
    fencingEpoch: 4,
    frozenBy: "tech_out_a",
    frozenAt: "2026-10-28T07:30:00.000Z",
    ...overrides,
  };
}

function baseReviewedBinding(overrides = {}) {
  return {
    handoverId: H,
    handoverDocumentId: DOC,
    aggregateRevision: 7,
    snapshotHash: "3".repeat(64),
    report: baseReport(),
    guardRevision: 5,
    fencingEpoch: 4,
    ...overrides,
  };
}

function baseGuardBinding(overrides = {}) {
  return {
    protocolOwner: "v2",
    handoverDocumentId: DOC,
    reservationId: H,
    incomingShiftId: INCOMING,
    lifecycleState: "active",
    guardRevision: 5,
    fencingEpoch: 4,
    outgoingSlotToken: "outgoing_slot",
    outgoingGeneration: 2,
    successorSlotToken: "incoming_slot",
    successorGeneration: 3,
    ...overrides,
  };
}

function activationReceipt(actorUid = A, activatedAt = ACTIVATION) {
  const receipt = {
    id: domain.createIncomingAcceptanceActivationReceiptId(DOC),
    schema: "equal-handover-activation-v2",
    action: "EQUAL_SHIFT_ACTIVATED_INCOMING_V2",
    outcome: "INCOMING_ACTIVATED",
    protocol: "equal-handover-v2",
    handoverDocumentId: DOC,
    outgoingShiftId: OUTGOING,
    incomingShiftId: INCOMING,
    finalRevision: 8,
    finalSnapshotHash: "4".repeat(64),
    boundReportId: baseReport().id,
    actorUid,
    actorRole: "technician",
    activatedAt,
    operationalControlBefore: { shiftId: OUTGOING },
    operationalControlAfter: { shiftId: INCOMING },
  };
  return { ...receipt, receiptHash: domain.computeIncomingAcceptanceActivationReceiptHash(receipt) };
}

function fixture(input) {
  const {
    uid,
    position,
    outcome,
    operationalAppliedAt,
    requestAcceptedAt,
    passwordVerifiedAt,
    authAccountCheckedAt,
    kind = CLOCK_IN,
    lateReason = null,
    absenceReference = null,
  } = input;
  const activation = activationReceipt(A, ACTIVATION);
  const identity = domain.createIncomingAcceptanceApplicationIdentity({
    handoverId: H,
    technicianUid: uid,
    kind,
  });
  const evidence = {
    id: identity.evidenceId,
    slotId: identity.slotId,
    operationId: identity.operationId,
    eventId: identity.eventId,
    handoverId: H,
    technicianUid: uid,
    kind,
    eventTime: operationalAppliedAt,
    authenticationMethod: evidenceTypes.ATTENDANCE_AUTHENTICATION_METHODS[
      kind === LATE_ACCEPTANCE ? "PERSONAL_PASSWORD_ACCEPTANCE" : "PERSONAL_PASSWORD_CONFIRMATION"
    ],
    personallyAuthenticated: true,
    guardRevision: 5,
    fencingEpoch: 4,
  };
  const operation = {
    id: identity.operationId,
    status: "finalized",
    eventId: identity.eventId,
    technicianUid: uid,
    kind,
    evidenceId: identity.evidenceId,
    interruptedFinalization: false,
  };
  const membership = {
    id: `${INCOMING}_${uid}`,
    shiftId: INCOMING,
    technicianId: uid,
    role: "primary",
    leftAt: null,
    joinedAt: operationalAppliedAt,
  };
  const attendance = {
    id: `${INCOMING}_${uid}`,
    shiftId: INCOMING,
    technicianId: uid,
    status: "present",
    participationAuthority: "primary",
    authorizationId: null,
    isProvisional: false,
    clockIn: null,
    clockOut: null,
    recordedAt: operationalAppliedAt,
    updatedAt: operationalAppliedAt,
  };
  const receipt = domain.createIncomingAcceptanceApplicationReceipt({
    handoverDocumentId: DOC,
    outgoingShiftId: OUTGOING,
    incomingShiftId: INCOMING,
    technicianUid: uid,
    position,
    outcome,
    activationReceiptId: activation.id,
    activationReceiptHash: activation.receiptHash,
    evidenceKind: kind,
    evidenceDigest: domain.createIncomingAcceptanceEvidenceDigest(evidence),
    membershipId: membership.id,
    attendanceId: attendance.id,
    reviewedBinding: baseReviewedBinding(),
    appliedGuardBinding: baseGuardBinding(),
    requestAcceptedAt,
    passwordVerifiedAt,
    authAccountCheckedAt,
    personalEvidenceEventAt: operationalAppliedAt,
    operationalAppliedAt,
    lateReason,
    absenceReference,
  });
  const hydrated = domain.hydrateIncomingAcceptanceCommittedAt(receipt, {
    seconds: 1_790_000_000,
    nanoseconds: 0,
  });
  return { receipt: hydrated, activation, evidence, operation, membership, attendance, identity };
}

function firstFixture() {
  return fixture({
    uid: A,
    position: "incoming_tech_a",
    outcome: "first_activation",
    operationalAppliedAt: ACTIVATION,
    requestAcceptedAt: FIRST_REQUEST,
    passwordVerifiedAt: FIRST_PASSWORD,
    authAccountCheckedAt: FIRST_ACCOUNT,
  });
}

function joinFixture() {
  return fixture({
    uid: B,
    position: "incoming_tech_b",
    outcome: "subsequent_join",
    operationalAppliedAt: JOIN,
    requestAcceptedAt: JOIN_REQUEST,
    passwordVerifiedAt: JOIN_PASSWORD,
    authAccountCheckedAt: JOIN_ACCOUNT,
  });
}

function rehash(receipt) {
  const next = structuredClone(receipt);
  next.receiptHash = domain.computeIncomingAcceptanceReceiptHash(next);
  return next;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, "IncomingAcceptanceApplicationError");
    assert.equal(error.code, code, `expected ${code}, received ${error.code}`);
    return true;
  });
}

function reservation(overrides = {}) {
  return {
    handoverId: H,
    handoverDocumentId: DOC,
    outgoingShiftId: OUTGOING,
    incomingShiftId: INCOMING,
    incomingTechnicianIds: [A, B],
    scheduledStart: START,
    scheduledEnd: END,
    ...overrides,
  };
}

// 1 -------------------------------------------------------------------------
test("deterministic application identity is stable and independent of mutable bindings", () => {
  const first = domain.createIncomingAcceptanceApplicationIdentity({ handoverId: H, technicianUid: A, kind: CLOCK_IN });
  const again = domain.createIncomingAcceptanceApplicationIdentity({ handoverId: H, technicianUid: A, kind: CLOCK_IN });
  const late = domain.createIncomingAcceptanceApplicationIdentity({ handoverId: H, technicianUid: A, kind: LATE_ACCEPTANCE });
  const other = domain.createIncomingAcceptanceApplicationIdentity({ handoverId: H, technicianUid: B, kind: CLOCK_IN });

  assert.deepEqual(first, again);
  assert.equal(first.businessKeyHash, late.businessKeyHash);
  assert.equal(first.receiptId, late.receiptId);
  assert.equal(first.auditId, late.auditId);
  assert.notEqual(first.eventId, late.eventId);
  assert.notEqual(first.operationId, late.operationId);
  assert.notEqual(first.evidenceId, late.evidenceId);
  assert.notEqual(first.businessKeyHash, other.businessKeyHash);
  assert.match(first.receiptId, /^acceptance_app_v1_[0-9a-f]{64}$/);
  assert.match(first.auditId, /^acceptance_application_v1_[0-9a-f]{64}$/);
  assert.match(first.eventId, /^atomic_acceptance_v1_[0-9a-f]{64}$/);
});

// 2 -------------------------------------------------------------------------
test("valid first-activation receipt, evidence, participation and outcome validate together", () => {
  const { receipt, activation, evidence, operation, membership, attendance } = firstFixture();
  domain.assertIncomingAcceptanceApplicationReceipt(receipt, { requireResolvedCommit: true });
  domain.assertIncomingAcceptanceReservation(receipt, reservation());
  domain.assertIncomingAcceptanceEvidenceConsistency({ receipt, operation, evidence });
  domain.assertIncomingAcceptanceParticipationConsistency({ receipt, membership, attendance });
  domain.assertIncomingAcceptanceOutcome({
    receipt,
    activationReceipt: activation,
    incomingShift: { id: INCOMING, status: "active", actualStart: ACTIVATION },
    scheduledStart: START,
    scheduledEnd: END,
  });

  assert.equal(receipt.outcome, "first_activation");
  assert.equal(receipt.technicianUid, A);
  assert.equal(receipt.committedAt.state, "resolved");
  assert.match(receipt.receiptHash, /^[0-9a-f]{64}$/);
});

// 3 -------------------------------------------------------------------------
test("valid second-join receipt references the existing activation and stays inside the shift", () => {
  const { receipt, activation } = joinFixture();
  domain.assertIncomingAcceptanceApplicationReceipt(receipt, { requireResolvedCommit: true });
  domain.assertIncomingAcceptanceReservation(receipt, reservation());
  domain.assertIncomingAcceptanceOutcome({
    receipt,
    activationReceipt: activation,
    incomingShift: { id: INCOMING, status: "active", actualStart: ACTIVATION },
    scheduledStart: START,
    scheduledEnd: END,
  });
  assert.equal(receipt.outcome, "subsequent_join");
  assert.equal(receipt.operationalAppliedAt, JOIN);
});

test("receipt hash tampering and unresolved commit are rejected", () => {
  const { receipt } = firstFixture();
  const tampered = { ...structuredClone(receipt), lateReason: "rewritten" };
  expectCode(
    () => domain.assertIncomingAcceptanceApplicationReceipt(tampered, { requireResolvedCommit: true }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );

  const unresolved = domain.createIncomingAcceptanceApplicationReceipt({
    handoverDocumentId: DOC,
    outgoingShiftId: OUTGOING,
    incomingShiftId: INCOMING,
    technicianUid: A,
    position: "incoming_tech_a",
    outcome: "first_activation",
    activationReceiptId: receipt.activationReceiptId,
    activationReceiptHash: receipt.activationReceiptHash,
    evidenceKind: CLOCK_IN,
    evidenceDigest: receipt.evidenceDigest,
    membershipId: `${INCOMING}_${A}`,
    attendanceId: `${INCOMING}_${A}`,
    reviewedBinding: baseReviewedBinding(),
    appliedGuardBinding: baseGuardBinding(),
    requestAcceptedAt: FIRST_REQUEST,
    passwordVerifiedAt: FIRST_PASSWORD,
    authAccountCheckedAt: FIRST_ACCOUNT,
    personalEvidenceEventAt: ACTIVATION,
    operationalAppliedAt: ACTIVATION,
    lateReason: null,
    absenceReference: null,
  });
  assert.equal(unresolved.committedAt.state, "unresolved");
  expectCode(
    () => domain.assertIncomingAcceptanceApplicationReceipt(unresolved, { requireResolvedCommit: true }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
});

// 4 -------------------------------------------------------------------------
test("a receipt for a technician outside the reserved incoming roster is rejected", () => {
  const { receipt } = firstFixture();
  expectCode(
    () => domain.assertIncomingAcceptanceReservation(receipt, reservation({ incomingTechnicianIds: [B, "tech_in_c"] })),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceReservation(receipt, reservation({ incomingTechnicianIds: [B, A] })),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
});

// 5 -------------------------------------------------------------------------
test("foreign handover and incoming-shift bindings are rejected", () => {
  const { receipt } = firstFixture();
  expectCode(
    () => domain.assertIncomingAcceptanceReservation(receipt, reservation({ handoverId: `handover_v2_${"b".repeat(64)}` })),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceReservation(receipt, reservation({ incomingShiftId: "shift_other" })),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
});

// 6 -------------------------------------------------------------------------
test("mismatched evidence, operation and digest references are rejected", () => {
  const { receipt, evidence, operation } = firstFixture();
  expectCode(
    () => domain.assertIncomingAcceptanceEvidenceConsistency({
      receipt,
      operation,
      evidence: { ...evidence, id: "att2_ev_wrong" },
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceEvidenceConsistency({
      receipt,
      operation,
      evidence: { ...evidence, eventTime: "2026-10-28T08:00:01.000Z" },
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceEvidenceConsistency({
      receipt,
      operation: { ...operation, status: "pending" },
      evidence,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceEvidenceConsistency({
      receipt: rehash({ ...receipt, evidenceDigest: "0".repeat(64) }),
      operation,
      evidence,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
});

// 7 -------------------------------------------------------------------------
test("membership and attendance must both match the receipt and legacy operational shape", () => {
  const { receipt, membership, attendance } = firstFixture();
  domain.assertIncomingAcceptanceParticipationConsistency({ receipt, membership, attendance });

  expectCode(
    () => domain.assertIncomingAcceptanceParticipationConsistency({
      receipt,
      membership: { ...membership, id: `${INCOMING}_tech_other` },
      attendance,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceParticipationConsistency({
      receipt,
      membership,
      attendance: { ...attendance, clockIn: ACTIVATION },
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceParticipationConsistency({
      receipt,
      membership,
      attendance: { ...attendance, recordedAt: "2026-10-28T08:00:02.000Z" },
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT,
  );
  domain.assertIncomingAcceptanceParticipationConsistency({
    receipt,
    membership: { ...membership, leftAt: "2026-10-28T16:00:00.000Z" },
    attendance,
    allowHistoricalDeparture: true,
  });
  expectCode(
    () => domain.assertIncomingAcceptanceParticipationConsistency({
      receipt,
      membership: { ...membership, leftAt: "2026-10-28T07:00:00.000Z" },
      attendance,
      allowHistoricalDeparture: true,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.PARTICIPATION_INCONSISTENT,
  );
});

// 8 -------------------------------------------------------------------------
test("authentication proof expires after the 60-second freshness window", () => {
  const binding = baseReviewedBinding();
  const proof = domain.createIncomingAcceptanceAuthenticationProof({
    requestNonce: "nonce-1",
    verifiedTechnicianUid: A,
    verifiedAt: FIRST_PASSWORD,
    authAccountCheckedAt: FIRST_ACCOUNT,
    reviewedBinding: binding,
    lateReason: null,
    verifiedAtMonotonicMs: 1_000,
  });
  domain.assertIncomingAcceptanceAuthenticationProof({
    proof,
    expectedTechnicianUid: A,
    expectedRequestNonce: "nonce-1",
    reviewedBinding: binding,
    lateReason: null,
    nowIso: "2026-10-28T08:00:29.000Z",
    nowMonotonicMs: 30_000,
  });
  expectCode(
    () => domain.assertIncomingAcceptanceAuthenticationProof({
      proof,
      expectedTechnicianUid: A,
      expectedRequestNonce: "nonce-1",
      reviewedBinding: binding,
      lateReason: null,
      nowIso: "2026-10-28T08:01:00.001Z",
      nowMonotonicMs: 61_001,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_EXPIRED,
  );
});

// 9 -------------------------------------------------------------------------
test("a proof created for another subject cannot authorize acceptance", () => {
  const binding = baseReviewedBinding();
  const proof = domain.createIncomingAcceptanceAuthenticationProof({
    requestNonce: "nonce-1",
    verifiedTechnicianUid: A,
    verifiedAt: FIRST_PASSWORD,
    authAccountCheckedAt: FIRST_ACCOUNT,
    reviewedBinding: binding,
    lateReason: null,
    verifiedAtMonotonicMs: 1_000,
  });
  expectCode(
    () => domain.assertIncomingAcceptanceAuthenticationProof({
      proof,
      expectedTechnicianUid: B,
      expectedRequestNonce: "nonce-1",
      reviewedBinding: binding,
      lateReason: null,
      nowIso: "2026-10-28T08:00:00.000Z",
      nowMonotonicMs: 10_000,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.AUTH_IDENTITY_CHANGED,
  );
});

// 10 ------------------------------------------------------------------------
test("a replayed, malformed or rebound proof is rejected", () => {
  const binding = baseReviewedBinding();
  const proof = domain.createIncomingAcceptanceAuthenticationProof({
    requestNonce: "nonce-1",
    verifiedTechnicianUid: A,
    verifiedAt: FIRST_PASSWORD,
    authAccountCheckedAt: FIRST_ACCOUNT,
    reviewedBinding: binding,
    lateReason: null,
    verifiedAtMonotonicMs: 1_000,
  });
  const baseInput = {
    proof,
    expectedTechnicianUid: A,
    expectedRequestNonce: "nonce-1",
    reviewedBinding: binding,
    lateReason: null,
    nowIso: "2026-10-28T08:00:00.000Z",
    nowMonotonicMs: 10_000,
  };
  expectCode(
    () => domain.assertIncomingAcceptanceAuthenticationProof({ ...baseInput, expectedRequestNonce: "nonce-2" }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_PROOF_INVALID,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceAuthenticationProof({ ...baseInput, proof: { ...proof, password: "secret" } }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_PROOF_INVALID,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceAuthenticationProof({ ...baseInput, proof: { ...proof, schema: "other" } }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.AUTHENTICATION_PROOF_INVALID,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceAuthenticationProof({
      ...baseInput,
      reviewedBinding: baseReviewedBinding({ guardRevision: 6 }),
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.REVIEW_BINDING_CHANGED,
  );
});

// 11 ------------------------------------------------------------------------
test("timestamp ordering rejects regressions without clamping or backdating", () => {
  const valid = {
    requestAcceptedAt: FIRST_REQUEST,
    passwordVerifiedAt: FIRST_PASSWORD,
    authAccountCheckedAt: FIRST_ACCOUNT,
    personalEvidenceEventAt: ACTIVATION,
    operationalAppliedAt: ACTIVATION,
    outcome: "first_activation",
    origin: "native_atomic",
    aggregateUpdatedAt: "2026-10-28T07:45:00.000Z",
  };
  domain.assertIncomingAcceptanceClockOrder(valid);

  expectCode(
    () => domain.assertIncomingAcceptanceClockOrder({ ...valid, requestAcceptedAt: "2026-10-28T08:00:01.000Z" }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.CLOCK_ORDER_CONFLICT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceClockOrder({ ...valid, aggregateUpdatedAt: "2026-10-28T08:00:00.000Z" }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.CLOCK_ORDER_CONFLICT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceClockOrder({ ...valid, personalEvidenceEventAt: "2026-10-28T07:59:59.000Z" }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
  domain.assertIncomingAcceptanceClockOrder({
    ...valid,
    origin: "legacy_recovery",
    expectedLegacyEventTime: ACTIVATION,
  });
  expectCode(
    () => domain.assertIncomingAcceptanceClockOrder({
      ...valid,
      origin: "legacy_recovery",
      expectedLegacyEventTime: "2026-10-28T07:10:00.000Z",
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
});

test("first activation window is inclusive and reports early and expired distinctly", () => {
  const bounds = {
    earliestActivationAt: "2026-10-28T07:45:00.000Z",
    latestActivationAt: "2026-10-28T09:00:00.000Z",
  };
  domain.assertFirstActivationWindow({ operationalAppliedAt: "2026-10-28T07:45:00.000Z", ...bounds });
  domain.assertFirstActivationWindow({ operationalAppliedAt: "2026-10-28T09:00:00.000Z", ...bounds });
  expectCode(
    () => domain.assertFirstActivationWindow({ operationalAppliedAt: "2026-10-28T07:44:59.999Z", ...bounds }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.ACTIVATION_NOT_OPEN,
  );
  expectCode(
    () => domain.assertFirstActivationWindow({ operationalAppliedAt: "2026-10-28T09:00:00.001Z", ...bounds }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.ACTIVATION_WINDOW_EXPIRED,
  );
  expectCode(
    () => domain.assertFirstActivationWindow({
      operationalAppliedAt: ACTIVATION,
      earliestActivationAt: "2026-10-28T09:00:00.000Z",
      latestActivationAt: "2026-10-28T08:00:00.000Z",
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_INCONSISTENT,
  );
});

// 12 ------------------------------------------------------------------------
test("second join is bounded by activation and scheduled end", () => {
  domain.assertIncomingAcceptanceJoinWindow({
    activationTime: ACTIVATION,
    joinTime: ACTIVATION,
    scheduledStart: START,
    scheduledEnd: END,
  });
  domain.assertIncomingAcceptanceJoinWindow({
    activationTime: ACTIVATION,
    joinTime: "2026-10-28T15:59:59.999Z",
    scheduledStart: START,
    scheduledEnd: END,
  });
  expectCode(
    () => domain.assertIncomingAcceptanceJoinWindow({
      activationTime: ACTIVATION,
      joinTime: "2026-10-28T07:59:59.999Z",
      scheduledStart: START,
      scheduledEnd: END,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_NOT_OPEN,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceJoinWindow({
      activationTime: ACTIVATION,
      joinTime: END,
      scheduledStart: START,
      scheduledEnd: END,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_CLOSED,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceJoinWindow({
      activationTime: ACTIVATION,
      joinTime: JOIN,
      scheduledStart: END,
      scheduledEnd: START,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_INCONSISTENT,
  );
});

// 13 ------------------------------------------------------------------------
test("late-arrival reason is trimmed, bounded and required only after the grace period", () => {
  assert.equal(domain.normalizeIncomingAcceptanceLateReason({ reason: "  Night bus  ", required: true }), "Night bus");
  assert.equal(domain.normalizeIncomingAcceptanceLateReason({ reason: "", required: false }), null);
  assert.equal(domain.normalizeIncomingAcceptanceLateReason({ reason: "x".repeat(1_000), required: true }).length, 1_000);

  expectCode(
    () => domain.normalizeIncomingAcceptanceLateReason({ reason: null, required: true }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_REQUIRED,
  );
  expectCode(
    () => domain.normalizeIncomingAcceptanceLateReason({ reason: "   ", required: true }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_REQUIRED,
  );
  expectCode(
    () => domain.normalizeIncomingAcceptanceLateReason({ reason: "x".repeat(1_001), required: true }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_INVALID,
  );
  expectCode(
    () => domain.normalizeIncomingAcceptanceLateReason({ reason: "bad\u0007reason", required: true }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_INVALID,
  );

  assert.equal(domain.isIncomingAcceptanceLateReasonRequired({
    scheduledStart: START,
    operationalAppliedAt: "2026-10-28T08:05:00.000Z",
  }), false);
  assert.equal(domain.isIncomingAcceptanceLateReasonRequired({
    scheduledStart: START,
    operationalAppliedAt: "2026-10-28T08:05:00.001Z",
  }), true);
});

// 14 ------------------------------------------------------------------------
test("completed legacy history is read-only and never promoted to a native receipt", () => {
  const result = domain.classifyIncomingAcceptanceLegacyState({
    aggregateLifecycleStatus: "completed",
    activationReceiptPresent: true,
    activationReceiptConsistent: true,
    membershipPresent: true,
    attendancePresent: true,
    evidence: null,
    operation: null,
    nativeReceipt: null,
  });
  assert.equal(result.classification, "LEGACY_APPLIED_UNATTESTED_V1");
  assert.equal(result.readOnly, true);
  assert.equal(result.receiptBacked, false);
  assert.equal(result.modernReceipt, null);
  assert.equal(result.postDisposition, "LEGACY_READ_ONLY");

  const native = firstFixture();
  const nativeResult = domain.classifyIncomingAcceptanceLegacyState({
    aggregateLifecycleStatus: "completed",
    activationReceiptPresent: true,
    activationReceiptConsistent: true,
    membershipPresent: true,
    attendancePresent: true,
    evidence: { present: true, finalized: true, interruptedFinalization: false },
    operation: { present: true, status: "finalized" },
    nativeReceipt: native.receipt,
  });
  assert.equal(nativeResult.classification, "NATIVE_APPLIED");
  assert.equal(nativeResult.receiptBacked, true);
  assert.equal(nativeResult.modernReceipt, native.receipt);
});

// 15 ------------------------------------------------------------------------
test("finalized evidence without operational participation is an unapplied authenticated attempt", () => {
  const result = domain.classifyIncomingAcceptanceLegacyState({
    aggregateLifecycleStatus: "completed",
    activationReceiptPresent: true,
    activationReceiptConsistent: true,
    membershipPresent: false,
    attendancePresent: false,
    evidence: { present: true, finalized: true, interruptedFinalization: false },
    operation: { present: true, status: "finalized" },
    nativeReceipt: null,
  });
  assert.equal(result.classification, "LEGACY_UNAPPLIED_AUTHENTICATED_ATTEMPT");
  assert.equal(result.readOnly, true);
  assert.equal(result.receiptBacked, false);
  assert.equal(result.postDisposition, "RECOVERY_REVIEW");
});

// 16 ------------------------------------------------------------------------
test("pending and acknowledgement-interrupted legacy operations are classified separately", () => {
  const pending = domain.classifyIncomingAcceptanceLegacyState({
    aggregateLifecycleStatus: "awaiting_incoming_acceptance",
    activationReceiptPresent: false,
    activationReceiptConsistent: false,
    membershipPresent: false,
    attendancePresent: false,
    evidence: null,
    operation: { present: true, status: "pending" },
    nativeReceipt: null,
  });
  assert.equal(pending.classification, "LEGACY_PENDING_INTENT");
  assert.equal(pending.postDisposition, "RECOVERY_REVIEW");

  const interrupted = domain.classifyIncomingAcceptanceLegacyState({
    aggregateLifecycleStatus: "completed",
    activationReceiptPresent: true,
    activationReceiptConsistent: true,
    membershipPresent: false,
    attendancePresent: false,
    evidence: { present: true, finalized: true, interruptedFinalization: true },
    operation: { present: true, status: "finalized" },
    nativeReceipt: null,
  });
  assert.equal(interrupted.classification, "LEGACY_ACK_INTERRUPTED");
  assert.equal(interrupted.postDisposition, "RECOVERY_REVIEW");

  const aborted = domain.classifyIncomingAcceptanceLegacyState({
    aggregateLifecycleStatus: "awaiting_incoming_acceptance",
    activationReceiptPresent: false,
    activationReceiptConsistent: false,
    membershipPresent: false,
    attendancePresent: false,
    evidence: null,
    operation: { present: true, status: "aborted" },
    nativeReceipt: null,
  });
  assert.equal(aborted.classification, "LEGACY_ABORTED_INTENT");
});

// 17 ------------------------------------------------------------------------
test("guard completion is eligible only when both personal receipts and records validate", () => {
  const first = firstFixture();
  const join = joinFixture();
  const result = domain.evaluateIncomingAcceptanceGuardCompletion({
    reservedTechnicianIds: [A, B],
    activationReceiptId: first.activation.id,
    activationReceiptHash: first.activation.receiptHash,
    activationActorUid: A,
    aggregateLifecycleStatus: "completed",
    applications: [
      {
        technicianUid: A,
        receipt: first.receipt,
        evidencePresent: true,
        operationFinalized: true,
        membershipPresent: true,
        attendancePresent: true,
        declaredNotYetIn: false,
      },
      {
        technicianUid: B,
        receipt: join.receipt,
        evidencePresent: true,
        operationFinalized: true,
        membershipPresent: true,
        attendancePresent: true,
        declaredNotYetIn: false,
      },
    ],
  });
  assert.equal(result.status, "eligible");
  assert.equal(result.automatic, true);
  assert.equal(result.terminalEvidenceRef, first.activation.id);
  assert.equal(result.fabricatedReceipt, false);
  assert.deepEqual(result.technicianUids, [A, B]);
});

// 18 ------------------------------------------------------------------------
test("an exceptional closure is explicit, operator-bound and never automatic", () => {
  const first = firstFixture();
  const result = domain.evaluateIncomingAcceptanceGuardCompletion({
    reservedTechnicianIds: [A, B],
    activationReceiptId: first.activation.id,
    activationReceiptHash: first.activation.receiptHash,
    activationActorUid: A,
    aggregateLifecycleStatus: "completed",
    applications: [
      {
        technicianUid: A,
        receipt: first.receipt,
        evidencePresent: true,
        operationFinalized: true,
        membershipPresent: true,
        attendancePresent: true,
        declaredNotYetIn: false,
      },
      {
        technicianUid: B,
        receipt: null,
        evidencePresent: false,
        operationFinalized: false,
        membershipPresent: false,
        attendancePresent: false,
        declaredNotYetIn: true,
      },
    ],
    exceptionalClosure: {
      closureId: "guard_closure_1",
      subjectUid: B,
      authorizedBy: "supervisor_1",
      reason: "Operator verified that the partner did not arrive.",
      recordedAt: "2026-10-28T17:00:00.000Z",
    },
  });
  assert.equal(result.status, "exceptional_closure_authorized");
  assert.equal(result.automatic, false);
  assert.equal(result.requiresOperatorWorkflow, true);
  assert.equal(result.fabricatedReceipt, false);
  assert.equal(result.subjectUid, B);
  assert.equal(result.terminalEvidenceRef, "guard_closure_1");
});

// 19 ------------------------------------------------------------------------
test("attendance or a not-yet-in declaration never fabricates an absent partner's receipt", () => {
  const first = firstFixture();
  const result = domain.evaluateIncomingAcceptanceGuardCompletion({
    reservedTechnicianIds: [A, B],
    activationReceiptId: first.activation.id,
    activationReceiptHash: first.activation.receiptHash,
    activationActorUid: A,
    aggregateLifecycleStatus: "completed",
    applications: [
      {
        technicianUid: A,
        receipt: first.receipt,
        evidencePresent: true,
        operationFinalized: true,
        membershipPresent: true,
        attendancePresent: true,
        declaredNotYetIn: false,
      },
      {
        technicianUid: B,
        receipt: null,
        evidencePresent: true,
        operationFinalized: true,
        membershipPresent: true,
        attendancePresent: true,
        declaredNotYetIn: true,
      },
    ],
  });
  assert.equal(result.status, "not_eligible");
  assert.equal(result.reason, "PERSONAL_RECEIPT_MISSING");
  assert.deepEqual(result.missingTechnicianUids, [B]);
  assert.equal(result.fabricatedReceipt, false);
  assert.equal(Object.hasOwn(result, "receipt"), false);
});

// 20 ------------------------------------------------------------------------
test("classification and validation never mutate frozen report bytes or bindings", () => {
  const frozenReport = Object.freeze(baseReport());
  const frozenBinding = Object.freeze({ ...baseReviewedBinding(), report: frozenReport });
  const before = JSON.stringify(frozenBinding);

  domain.assertReviewedBindingMatches(frozenBinding, structuredClone(frozenBinding));
  const built = domain.createIncomingAcceptanceApplicationReceipt({
    handoverDocumentId: DOC,
    outgoingShiftId: OUTGOING,
    incomingShiftId: INCOMING,
    technicianUid: A,
    position: "incoming_tech_a",
    outcome: "first_activation",
    activationReceiptId: activationReceipt().id,
    activationReceiptHash: activationReceipt().receiptHash,
    evidenceKind: CLOCK_IN,
    evidenceDigest: "5".repeat(64),
    membershipId: `${INCOMING}_${A}`,
    attendanceId: `${INCOMING}_${A}`,
    reviewedBinding: frozenBinding,
    appliedGuardBinding: baseGuardBinding(),
    requestAcceptedAt: FIRST_REQUEST,
    passwordVerifiedAt: FIRST_PASSWORD,
    authAccountCheckedAt: FIRST_ACCOUNT,
    personalEvidenceEventAt: ACTIVATION,
    operationalAppliedAt: ACTIVATION,
    lateReason: null,
    absenceReference: null,
  });
  domain.classifyIncomingAcceptanceLegacyState({
    aggregateLifecycleStatus: "completed",
    activationReceiptPresent: true,
    activationReceiptConsistent: true,
    membershipPresent: true,
    attendancePresent: true,
    evidence: null,
    operation: null,
    nativeReceipt: null,
  });

  assert.equal(JSON.stringify(frozenBinding), before);
  assert.notEqual(built.reviewedBinding, frozenBinding);
  assert.deepEqual(built.reviewedBinding, JSON.parse(before));
});

test("legacy recovery writes remain disabled in this phase", () => {
  expectCode(
    () => domain.assertIncomingAcceptanceLegacyRecoveryWritesEnabled(),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.LEGACY_RECOVERY_DISABLED,
  );
});

test("outcome validation rejects a first activation attributed to a partner and an out-of-window join", () => {
  const first = firstFixture();
  expectCode(
    () => domain.assertIncomingAcceptanceOutcome({
      receipt: first.receipt,
      activationReceipt: activationReceipt(B),
      incomingShift: { id: INCOMING, status: "active", actualStart: ACTIVATION },
      scheduledStart: START,
      scheduledEnd: END,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceOutcome({
      receipt: first.receipt,
      activationReceipt: activationReceipt(),
      incomingShift: { id: INCOMING, status: "active", actualStart: "2026-10-28T08:00:01.000Z" },
      scheduledStart: START,
      scheduledEnd: END,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );

  const join = joinFixture();
  expectCode(
    () => domain.assertIncomingAcceptanceOutcome({
      receipt: rehash({ ...join.receipt, operationalAppliedAt: END, personalEvidenceEventAt: END, committedAt: { state: "unresolved" } }),
      activationReceipt: activationReceipt(),
      incomingShift: { id: INCOMING, status: "active", actualStart: ACTIVATION },
      scheduledStart: START,
      scheduledEnd: END,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.JOIN_WINDOW_CLOSED,
  );
  expectCode(
    () => domain.assertIncomingAcceptanceOutcome({
      receipt: join.receipt,
      activationReceipt: activationReceipt(B),
      incomingShift: { id: INCOMING, status: "active", actualStart: ACTIVATION },
      scheduledStart: START,
      scheduledEnd: END,
    }),
    domain.INCOMING_ACCEPTANCE_ERROR_CODES.APPLICATION_RECEIPT_INCONSISTENT,
  );
});
