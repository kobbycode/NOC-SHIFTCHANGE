/**
 * Phase 8C.3 — authoritative recovery-eligibility reader, exercised against
 * the production services through the network-free Firestore fixture.
 *
 * The fixture builds a real committed v2 handover by calling the production
 * report/preparation/confirmation/commit services, then the reader is invoked
 * exactly as the HTTP route invokes it (one read-only transaction, server
 * clock supplied by the caller). Every document id asserted here is derived
 * from the production factories, never guessed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceFixture } from "./helpers/acceptance-integrity-fixtures.mjs";

const DOCUMENT = "handover_v2_outgoing";
const OUTGOING_SHIFT = "outgoing";
const AGGREGATE_PATH = `equal_handovers_v2/${DOCUMENT}`;
const GUARD_PATH = "handover_reservation_guards/guard_outgoing";
const SLOT_PATH = "operational_shift_control/global";
const LEGACY_PATH = "handovers/handover_outgoing";

const ELIGIBLE = "eligible_for_abandonment_review";
const WINDOW_OPEN = "activation_window_open";
const ACCEPTANCE_EXISTS = "acceptance_exists";
const OUTCOME_UNCERTAIN = "acceptance_outcome_uncertain";
const INCONSISTENT = "inconsistent_evidence";
const GUARD_CONFLICT = "guard_binding_conflict";
const SLOT_CONFLICT = "slot_binding_conflict";
const NOT_APPLICABLE = "handover_not_applicable";
const UNVERIFIABLE = "evidence_unverifiable";

function snapshotRecords(f) {
  return structuredClone([...f.records]);
}

// A v2-native reservation: the legacy collecting-confirmations record created
// by the shared fixture would make the identity model ambiguous, which is a
// separate scenario below.
async function world(options = {}) {
  const f = await acceptanceFixture(options);
  const legacy = structuredClone(f.records.get(LEGACY_PATH));
  f.records.delete(LEGACY_PATH);
  const api = f.load("lib/operations/handover-recovery-eligibility-firestore");
  const aggregate = f.records.get(AGGREGATE_PATH);
  const latest = Date.parse(aggregate.identity.scheduledStart) + 60 * 60_000;
  const closedAt = new Date(latest + 1_000);
  const openAt = new Date(latest - 60_000);
  const evaluate = (input = {}) =>
    api.evaluateHandoverRecoveryEligibility({
      handoverDocumentId: DOCUMENT,
      actorUid: "manager",
      now: closedAt,
      ...input,
    });
  return { f, legacy, api, aggregate, latest, closedAt, openAt, evaluate };
}

// The read model is produced inside a vm realm, so every array crossing that
// boundary is copied into this realm before strict comparison.
const details = (result) => Array.from(result.refusals, (entry) => `${entry.code}:${entry.detail}`);

async function assertRejects(f, operation, status, code) {
  const before = snapshotRecords(f);
  await assert.rejects(operation, (error) => {
    assert.equal(error.name, "HandoverRecoveryEligibilityError");
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
  assert.deepEqual(snapshotRecords(f), before);
}

// ---------------------------------------------------------------------------
// 1-7. Eligible result, determinism, digest, zero writes.
// ---------------------------------------------------------------------------

test("01 a committed zero-acceptance handover past its window is eligible for review only", async () => {
  const { evaluate, closedAt } = await world();
  const { result, readModel } = await evaluate();

  assert.equal(result.classification, ELIGIBLE);
  assert.equal(result.refusals.length, 0);
  assert.equal(result.schema, "handover-recovery-eligibility-v1");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.evaluatedAt, closedAt.toISOString());
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.executionAuthority, "none");
  assert.equal(result.readModelStability, "point_in_time_transaction");
  assert.match(result.concurrencyNotice, /not an execution authorization/);
  assert.equal(result.handoverDocumentId, DOCUMENT);
  assert.equal(result.outgoingShiftId, OUTGOING_SHIFT);
  assert.equal(result.incomingShiftId, "incoming");
  assert.match(result.reason, /consideration of abandonment only/);

  assert.equal(result.evidenceDigest.schema, "handover-recovery-eligibility-evidence");
  // 8C.4B §2 raised the digest envelope to version 2 when the fail-closed
  // OPERATION_WITHOUT_EVIDENCE rule landed, so a digest proves which classifier
  // build produced it. Pre-correction (version 1) digests are not reproducible.
  assert.equal(result.evidenceDigest.schemaVersion, 2);
  assert.equal(result.evidenceDigest.algorithm, "sha256");
  assert.match(result.evidenceDigest.value, /^[0-9a-f]{64}$/);

  assert.equal(result.references.guardId, "guard_outgoing");
  assert.match(result.references.commitReceiptId, /^handover-commit-v2-[0-9a-f]{64}$/);
  assert.match(result.references.activationReceiptId, /^handover-activation-v2-[0-9a-f]{64}$/);
  assert.equal(result.references.applicationReceiptIds.length, 2);
  assert.equal(result.references.slotGeneration, 1);
  assert.equal(result.references.latestActivationAt, readModel.activationWindow.latestActivationAt);
  assert.match(result.references.latestActivationAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(readModel.aggregate.lifecycleStatus, "awaiting_incoming_acceptance");
  assert.equal(readModel.guard.ownerLifecycleState, "active");
  assert.equal(readModel.commitReceipt.valid, true);
  assert.equal(readModel.activationReceipt.present, false);
  assert.equal(readModel.incomingShift.present, false);
  assert.equal(readModel.report.verified, true);
  assert.equal(readModel.activationWindow.closedAtEvaluation, true);
  assert.deepEqual(
    Array.from(readModel.reconciliation, (entry) => `${entry.status}/${entry.reason}`),
    ["NOT_APPLIED/NO_APPLICATION_RECORD", "NOT_APPLIED/NO_APPLICATION_RECORD"],
  );
  assert.equal(readModel.kindSetComplete, true);
});

test("02 a caller cannot supply the classification, digest or execution authority", async () => {
  const { evaluate } = await world();
  const baseline = (await evaluate()).result;
  const forged = (
    await evaluate({
      classification: ACCEPTANCE_EXISTS,
      executionAuthorized: true,
      executionAuthority: "operator",
      evidenceDigest: { value: "f".repeat(64) },
      refusals: [{ code: ACCEPTANCE_EXISTS, detail: "INCOMING_SHIFT_ACTIVATED" }],
      readModelStability: "client",
    })
  ).result;

  assert.deepEqual(forged, baseline);
  assert.equal(forged.executionAuthorized, false);
  assert.notEqual(forged.evidenceDigest.value, "f".repeat(64));
});

test("03 an open activation window refuses abandonment before any other success", async () => {
  const { evaluate, openAt, closedAt } = await world();
  const open = (await evaluate({ now: openAt })).result;
  const closed = (await evaluate({ now: closedAt })).result;

  assert.equal(open.classification, WINDOW_OPEN);
  assert.deepEqual(details(open), [`${WINDOW_OPEN}:ACTIVATION_WINDOW_OPEN`]);
  assert.match(open.reason, /window is still open until/);
  assert.equal(open.evaluatedAt, openAt.toISOString());
  assert.notEqual(open.evidenceDigest.value, closed.evidenceDigest.value);
  assert.equal(closed.classification, ELIGIBLE);
});

test("04 equivalent reads at the same server time are byte-identical", async () => {
  const { evaluate } = await world();
  const first = (await evaluate()).result;
  const second = (await evaluate()).result;
  assert.deepEqual(second, first);
  assert.equal(second.evidenceDigest.value, first.evidenceDigest.value);
});

test("05 evaluation time and viewer identity never enter the digest", async () => {
  const { f, evaluate, closedAt } = await world();
  const baseline = (await evaluate()).result;
  f.records.set("users/manager-2", {
    uid: "manager-2",
    role: "admin",
    status: "active",
    statusOperation: null,
    mustChangePassword: false,
    fullName: "Manager Two",
  });

  const later = (await evaluate({ now: new Date(closedAt.getTime() + 600_000) })).result;
  const otherViewer = (await evaluate({ actorUid: "manager-2" })).result;
  const supervisorViewer = await (async () => {
    const supervisor = structuredClone(f.records.get("users/manager"));
    f.records.set("users/manager", { ...supervisor, role: "supervisor" });
    const result = (await evaluate()).result;
    f.records.set("users/manager", supervisor);
    return result;
  })();

  assert.equal(later.evidenceDigest.value, baseline.evidenceDigest.value);
  assert.equal(otherViewer.evidenceDigest.value, baseline.evidenceDigest.value);
  assert.equal(supervisorViewer.evidenceDigest.value, baseline.evidenceDigest.value);
  assert.notEqual(later.evaluatedAt, baseline.evaluatedAt);
});

test("06 evaluation is read-only: no writes, no direct reads, no reauthentication", async () => {
  const { f, evaluate } = await world();
  const before = snapshotRecords(f);
  const writes = f.writes.length;
  const authCalls = f.authCalls.length;
  let directReads = 0;
  f.hooks.directRead = () => {
    directReads += 1;
  };

  await evaluate();

  assert.equal(f.writes.length, writes);
  assert.equal(directReads, 0, "authoritative reads must go through the transaction");
  assert.equal(f.authCalls.length, authCalls);
  assert.deepEqual(snapshotRecords(f), before);
});

test("07 a safety-relevant change produces a different digest", async () => {
  const { f, evaluate } = await world();
  const baseline = (await evaluate()).result;

  const control = structuredClone(f.records.get(SLOT_PATH));
  const touched = { ...control, updatedAt: new Date(Date.parse(control.updatedAt) + 1_000).toISOString() };
  f.records.set(SLOT_PATH, touched);

  const mutated = (await evaluate()).result;
  assert.equal(mutated.classification, ELIGIBLE);
  assert.notEqual(mutated.evidenceDigest.value, baseline.evidenceDigest.value);
});

test("08 document insertion order does not change the digest", async () => {
  const { f, evaluate } = await world();
  const baseline = (await evaluate()).result;

  f.records = new Map([...f.records].reverse());
  const reversed = (await evaluate()).result;
  assert.equal(reversed.evidenceDigest.value, baseline.evidenceDigest.value);
});

// ---------------------------------------------------------------------------
// 9-13. Aggregate applicability and readability.
// ---------------------------------------------------------------------------

test("09 a completed aggregate reports that acceptance exists", async () => {
  const { f, evaluate } = await world();
  f.records.set(AGGREGATE_PATH, { ...f.records.get(AGGREGATE_PATH), lifecycleStatus: "completed" });
  const result = (await evaluate()).result;
  assert.equal(result.classification, ACCEPTANCE_EXISTS);
  assert.ok(details(result).includes(`${ACCEPTANCE_EXISTS}:AGGREGATE_COMPLETED`));
});

test("10 a cancelled aggregate is not applicable to abandonment", async () => {
  const { f, evaluate } = await world();
  f.records.set(AGGREGATE_PATH, { ...f.records.get(AGGREGATE_PATH), lifecycleStatus: "cancelled" });
  const result = (await evaluate()).result;
  assert.equal(result.classification, NOT_APPLICABLE);
  assert.deepEqual(details(result), [`${NOT_APPLICABLE}:AGGREGATE_TERMINAL`]);
});

test("11 an uncommitted aggregate is not applicable", async () => {
  const { f, evaluate } = await world();
  f.records.set(AGGREGATE_PATH, { ...f.records.get(AGGREGATE_PATH), lifecycleStatus: "collecting_confirmations" });
  const result = (await evaluate()).result;
  assert.equal(result.classification, NOT_APPLICABLE);
  assert.deepEqual(details(result), [`${NOT_APPLICABLE}:AGGREGATE_NOT_COMMITTED`]);
});

test("12 a missing aggregate is reported as not found, not guessed", async () => {
  const { f, evaluate } = await world();
  f.records.delete(AGGREGATE_PATH);
  const { result, readModel } = await evaluate();
  assert.equal(result.classification, NOT_APPLICABLE);
  assert.deepEqual(details(result), [`${NOT_APPLICABLE}:HANDOVER_NOT_FOUND`]);
  assert.equal(readModel.aggregate.present, false);
  assert.equal(readModel.applications.length, 0);
});

test("13 an unreadable aggregate or one bound to another document is unverifiable", async () => {
  const corrupt = await world();
  corrupt.f.records.set(AGGREGATE_PATH, { schema: "not-equal-handover-v2" });
  const corruptResult = (await corrupt.evaluate()).result;
  assert.equal(corruptResult.classification, UNVERIFIABLE);
  assert.deepEqual(details(corruptResult), [`${UNVERIFIABLE}:AGGREGATE_UNREADABLE`]);

  const moved = await world();
  const aggregate = moved.f.records.get(AGGREGATE_PATH);
  moved.f.records.set(AGGREGATE_PATH, {
    ...aggregate,
    identity: { ...aggregate.identity, outgoingShiftId: "handover_v2_other" },
  });
  const movedResult = (await moved.evaluate()).result;
  assert.equal(movedResult.classification, UNVERIFIABLE);
  assert.deepEqual(details(movedResult), [`${UNVERIFIABLE}:AGGREGATE_UNREADABLE`]);
});

// ---------------------------------------------------------------------------
// 14-18. Commit receipt and frozen report.
// ---------------------------------------------------------------------------

test("14 a missing outgoing commit receipt is inconsistent evidence", async () => {
  const { f, evaluate } = await world();
  const receiptId = (await evaluate()).readModel.commitReceipt.id;
  f.records.delete(`audit_logs/${receiptId}`);
  const result = (await evaluate()).result;
  assert.equal(result.classification, INCONSISTENT);
  assert.ok(details(result).includes(`${INCONSISTENT}:COMMIT_RECEIPT_MISSING`));
});

test("15 a tampered commit receipt is inconsistent evidence", async () => {
  const { f, evaluate } = await world();
  const receiptId = (await evaluate()).readModel.commitReceipt.id;
  const receipt = f.records.get(`audit_logs/${receiptId}`);
  f.records.set(`audit_logs/${receiptId}`, { ...receipt, receiptHash: "0".repeat(64) });
  const result = (await evaluate()).result;
  assert.equal(result.classification, INCONSISTENT);
  assert.ok(details(result).includes(`${INCONSISTENT}:COMMIT_RECEIPT_INVALID`));
});

test("16 a missing or tampered frozen report is unverifiable", async () => {
  const missing = await world();
  const reportId = (await missing.evaluate()).readModel.report.id;
  assert.ok(reportId);
  missing.f.records.delete(`handover_reports_v2/${reportId}`);
  const missingResult = (await missing.evaluate()).result;
  assert.equal(missingResult.classification, UNVERIFIABLE);
  assert.ok(details(missingResult).includes(`${UNVERIFIABLE}:REPORT_UNREADABLE`));

  const tampered = await world();
  const tamperedId = (await tampered.evaluate()).readModel.report.id;
  const report = tampered.f.records.get(`handover_reports_v2/${tamperedId}`);
  tampered.f.records.set(`handover_reports_v2/${tamperedId}`, { ...report, digest: "1".repeat(64) });
  const tamperedResult = (await tampered.evaluate()).result;
  assert.equal(tamperedResult.classification, UNVERIFIABLE);
  assert.ok(details(tamperedResult).includes(`${UNVERIFIABLE}:REPORT_UNREADABLE`));
});

// ---------------------------------------------------------------------------
// 19-24. Guard, slot, legacy and shift bindings.
// ---------------------------------------------------------------------------

test("19 a missing guard is a binding conflict and the report cannot be verified", async () => {
  const { f, evaluate } = await world();
  f.records.delete(GUARD_PATH);
  const { result, readModel } = await evaluate();
  assert.equal(result.classification, UNVERIFIABLE);
  assert.ok(details(result).includes(`${GUARD_CONFLICT}:GUARD_MISSING`));
  assert.equal(readModel.report.verified, false);
});

test("20 an unreadable guard is unverifiable", async () => {
  const { f, evaluate } = await world();
  f.records.set(GUARD_PATH, { ...f.records.get(GUARD_PATH), protocolOwner: "v9" });
  const result = (await evaluate()).result;
  assert.equal(result.classification, UNVERIFIABLE);
  assert.ok(details(result).includes(`${UNVERIFIABLE}:GUARD_UNREADABLE`));
});

test("21 a guard owned by protocol v1 is a binding conflict", async () => {
  const { f, evaluate } = await world();
  f.records.set(GUARD_PATH, { ...f.records.get(GUARD_PATH), protocolOwner: "v1" });
  const result = (await evaluate()).result;
  assert.equal(result.classification, GUARD_CONFLICT);
  assert.ok(details(result).includes(`${GUARD_CONFLICT}:GUARD_NOT_V2`));
});

test("22 an unvalidatable guard archive is unverifiable", async () => {
  const { f, evaluate } = await world();
  f.records.set("handover_reservation_guard_history/forged_archive", {
    outgoingShiftId: OUTGOING_SHIFT,
    schema: "forged",
  });
  const result = (await evaluate()).result;
  assert.equal(result.classification, UNVERIFIABLE);
  assert.ok(details(result).includes(`${UNVERIFIABLE}:GUARD_HISTORY_UNREADABLE`));
});

test("23 a legacy collecting-confirmations record makes the identity ambiguous", async () => {
  const { f, evaluate, legacy } = await world();
  f.records.set(LEGACY_PATH, { ...legacy, lifecycleStatus: "collecting_confirmations" });
  const result = (await evaluate()).result;
  assert.equal(result.classification, UNVERIFIABLE);
  assert.ok(details(result).includes(`${UNVERIFIABLE}:LEGACY_RESERVATION_AMBIGUOUS`));
});

test("24 a completed legacy record does not make a v2 reservation ambiguous", async () => {
  const { f, evaluate, legacy } = await world();
  f.records.set(LEGACY_PATH, { ...legacy, lifecycleStatus: "completed" });
  const result = (await evaluate()).result;
  assert.equal(result.classification, ELIGIBLE);
  assert.equal(result.refusals.length, 0);
});

test("25 a missing global slot is a slot conflict", async () => {
  const { f, evaluate } = await world();
  f.records.delete(SLOT_PATH);
  const result = (await evaluate()).result;
  assert.equal(result.classification, SLOT_CONFLICT);
  assert.deepEqual(details(result), [`${SLOT_CONFLICT}:SLOT_MISSING`]);
});

test("26 a slot generation mismatch is a slot conflict", async () => {
  const { f, evaluate } = await world();
  const control = f.records.get(SLOT_PATH);
  // A structurally valid second-generation slot that still carries the token
  // this handover reserved: only the generation diverges.
  f.records.set(SLOT_PATH, {
    ...control,
    generation: 2,
    previousSlotToken: "a0000000-0000-4000-8000-0000000000ff",
    advancedAt: control.createdAt,
  });
  const result = (await evaluate()).result;
  assert.equal(result.classification, SLOT_CONFLICT);
  assert.ok(details(result).includes(`${SLOT_CONFLICT}:SLOT_GENERATION_MISMATCH`));
});

test("27 a closed outgoing shift reports that acceptance exists", async () => {
  const { f, evaluate } = await world();
  f.records.set("shifts/outgoing", {
    ...f.records.get("shifts/outgoing"),
    status: "completed",
    actualEnd: new Date(Date.parse(f.records.get("shifts/outgoing").actualStart) + 60_000).toISOString(),
  });
  const result = (await evaluate()).result;
  assert.equal(result.classification, ACCEPTANCE_EXISTS);
  assert.ok(details(result).includes(`${ACCEPTANCE_EXISTS}:OUTGOING_SHIFT_COMPLETED`));
});

// ---------------------------------------------------------------------------
// 28-32. Acceptance artifacts and uncertain outcomes.
// ---------------------------------------------------------------------------

test("28 an incoming membership without a receipt is inconsistent evidence", async () => {
  const { f, evaluate } = await world();
  f.records.set("shift_members/incoming_in-a", {
    id: "incoming_in-a",
    shiftId: "incoming",
    technicianId: "in-a",
    role: "primary",
    joinedAt: f.iso(),
    leftAt: null,
  });
  const result = (await evaluate()).result;
  assert.equal(result.classification, INCONSISTENT);
  assert.ok(details(result).includes(`${INCONSISTENT}:MEMBERSHIP_WITHOUT_RECEIPT`));
});

test("29 a pending evidence operation leaves the acceptance outcome uncertain", async () => {
  const { f, evaluate } = await world();
  f.failOnce("afterBegin");
  assert.notEqual((await f.post("in-a")).status, 200);
  const result = (await evaluate()).result;
  assert.equal(result.classification, OUTCOME_UNCERTAIN);
  assert.ok(details(result).includes(`${OUTCOME_UNCERTAIN}:OPERATION_PENDING`));
});

test("30 finalized legacy evidence without any receipt leaves the outcome uncertain", async () => {
  const { f, evaluate } = await world();
  f.failOnce("afterFinalize");
  assert.notEqual((await f.post("in-a")).status, 200);
  assert.equal(f.entries("attendance_evidence_v2").length, 1);
  const { result, readModel } = await evaluate();
  assert.equal(result.classification, OUTCOME_UNCERTAIN);
  assert.ok(details(result).includes(`${OUTCOME_UNCERTAIN}:EVIDENCE_WITHOUT_RECEIPT`));
  const evidence = readModel.evidence.find(
    (entry) => entry.technicianUid === "in-a" && entry.kind === "incoming_clock_in",
  );
  assert.equal(evidence.present, true);
  assert.equal(evidence.operationPresent, false);
  assert.equal(evidence.legacyOperationPresent, true);
  assert.equal(evidence.legacyOperationStatus, "finalized");
  assert.equal(evidence.legacyOperationInterrupted, false);
  assert.ok(f.records.has(`attendance_evidence_operations_v2/${evidence.legacyOperationId}`));
});

test("30b an interrupted finalization acknowledgement is uncertain, not eligible", async () => {
  const { f, evaluate } = await world();
  f.failOnce("afterFinalize");
  assert.notEqual((await f.post("in-a")).status, 200);
  const stored = f.entries("attendance_evidence_operations_v2");
  assert.equal(stored.length, 1);
  f.records.set(stored[0][0], {
    ...stored[0][1],
    status: "finalized",
    interruptedFinalization: true,
  });
  const { result } = await evaluate();
  assert.equal(result.classification, OUTCOME_UNCERTAIN);
  assert.ok(details(result).includes(`${OUTCOME_UNCERTAIN}:OPERATION_INTERRUPTED`));
});

test("31 an unreadable review case is unverifiable", async () => {
  const { f, evaluate } = await world();
  const reviewCaseId = f.load("lib/operations/handover-admin-review-domain").createHandoverReviewCaseId(DOCUMENT);
  f.records.set(`handover_review_cases_v1/${reviewCaseId}`, { schema: "forged" });
  const result = (await evaluate()).result;
  assert.equal(result.classification, UNVERIFIABLE);
  assert.ok(details(result).includes(`${UNVERIFIABLE}:REVIEW_CASE_UNREADABLE`));
});

// ---------------------------------------------------------------------------
// 33-35. Real acceptance: A-2 activation-receipt-id equivalence.
// ---------------------------------------------------------------------------

test("33 a real acceptance is detected and its deterministic receipt id matches the reader", async () => {
  const { f, evaluate } = await world();
  const accepted = await f.post("in-a");
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, "ACTIVATED");

  const domain = f.load("lib/operations/incoming-acceptance-application-domain");
  const derivedId = domain.createIncomingAcceptanceActivationReceiptId(DOCUMENT);
  const storedReceipt = f.records.get(`audit_logs/${derivedId}`);
  assert.ok(storedReceipt, "the production acceptance must write the derived activation receipt id");
  assert.equal(storedReceipt.action, "EQUAL_SHIFT_ACTIVATED_INCOMING_V2");
  assert.equal(storedReceipt.schema, "equal-handover-activation-v2");
  assert.equal(storedReceipt.handoverDocumentId, DOCUMENT);
  assert.equal(storedReceipt.outgoingShiftId, OUTGOING_SHIFT);
  assert.equal(f.summary().activationReceipts, 1);

  const { result, readModel } = await evaluate();
  assert.equal(result.classification, ACCEPTANCE_EXISTS);
  assert.equal(result.references.activationReceiptId, derivedId);
  assert.equal(readModel.activationReceipt.id, derivedId);
  assert.equal(readModel.activationReceipt.valid, true);
  assert.equal(readModel.incomingShift.present, true);
  const observed = details(result);
  for (const expected of [
    `${ACCEPTANCE_EXISTS}:AGGREGATE_COMPLETED`,
    `${ACCEPTANCE_EXISTS}:INCOMING_SHIFT_ACTIVATED`,
    `${ACCEPTANCE_EXISTS}:ACTIVATION_RECEIPT_VALID`,
  ]) {
    assert.ok(observed.includes(expected), `missing ${expected} in ${observed.join(", ")}`);
  }
  // The legacy acceptance writer never writes an atomic personal receipt, so
  // the reader must prove the attempt through the legacy operation document.
  assert.equal(f.entries("incoming_acceptance_applications_v1").length, 0);
  assert.ok(readModel.applications.every((entry) => !entry.present && !entry.auditPresent));
  const evidence = readModel.evidence.find(
    (entry) => entry.technicianUid === "in-a" && entry.kind === "incoming_clock_in",
  );
  assert.equal(evidence.present, true);
  assert.equal(evidence.operationPresent, false);
  assert.equal(evidence.legacyOperationPresent, true);
  assert.equal(evidence.legacyOperationStatus, "finalized");
  assert.equal(evidence.legacyOperationInterrupted, false);
  assert.ok(readModel.reconciliation.some((entry) => entry.status === "ADMIN_REVIEW_REQUIRED"));
});

test("34 a legacy acceptance without an atomic receipt is reported as review-required evidence", async () => {
  const { f, evaluate } = await world();
  assert.equal((await f.post("in-a")).status, 200);
  const { result, readModel } = await evaluate();
  assert.ok(readModel.applications.every((entry) => !entry.present));
  assert.equal(readModel.evidence.filter((entry) => entry.present).length, 1);
  assert.ok(details(result).includes(`${INCONSISTENT}:RECONCILIATION_REQUIRES_REVIEW`));
  const domain = f.load("lib/operations/incoming-acceptance-application-domain");
  const derived = domain.createIncomingAcceptanceApplicationIdentity({
    handoverId: readModel.aggregate.reservation.handoverId,
    technicianUid: "in-a",
    kind: "incoming_clock_in",
  });
  assert.equal(f.records.has(`incoming_acceptance_applications_v1/${derived.receiptId}`), false);
  assert.equal(f.records.has(`audit_logs/${derived.auditId}`), false);
});

test("35 concurrent creation of the absent incoming shift forces an A-1 retry", async () => {
  const { f, evaluate } = await world();
  const readsBefore = f.retries;
  const concurrent = { id: "incoming", status: "active", actualStart: null, permanentPairId: "in-pair", primaryTechnicianIds: ["in-a", "in-b"] };
  f.hooks.beforeCommit = async () => {
    delete f.hooks.beforeCommit;
    await f.db.doc("shifts/incoming").set(concurrent);
  };

  const { result } = await evaluate();

  assert.ok(f.retries > readsBefore, "the absent-document read must be re-validated");
  assert.equal(result.classification, ACCEPTANCE_EXISTS);
  assert.ok(details(result).includes(`${ACCEPTANCE_EXISTS}:INCOMING_SHIFT_ACTIVATED`));
  // The only write in the whole evaluation is the injected concurrent one.
  assert.deepEqual(f.writes, [{ op: "set", path: "shifts/incoming" }]);
});

// ---------------------------------------------------------------------------
// 36-39. Authorization and input canonicalisation.
// ---------------------------------------------------------------------------

test("36 only an active, settled admin or supervisor may evaluate", async () => {
  const { f, evaluate } = await world();
  const manager = structuredClone(f.records.get("users/manager"));
  const forbidden = async (record) => {
    if (record === null) f.records.delete("users/manager");
    else f.records.set("users/manager", record);
    await assertRejects(f, evaluate(), 403, "ELIGIBILITY_FORBIDDEN");
    f.records.set("users/manager", manager);
  };

  await forbidden({ ...manager, role: "technician" });
  await forbidden({ ...manager, status: "suspended" });
  await forbidden({ ...manager, statusOperation: "recovery" });
  await forbidden({ ...manager, mustChangePassword: true });
  await forbidden(null);
  await assertRejects(f, evaluate({ actorUid: "ghost" }), 403, "ELIGIBILITY_FORBIDDEN");
  await assertRejects(f, evaluate({ actorUid: "  " }), 403, "ELIGIBILITY_FORBIDDEN");
  await assertRejects(f, evaluate({ actorUid: 42 }), 403, "ELIGIBILITY_FORBIDDEN");

  f.records.set("users/manager", { ...manager, role: "supervisor" });
  assert.equal((await evaluate()).result.classification, ELIGIBLE);
});

test("37 malformed or non-canonical document ids are rejected without reads", async () => {
  const { f, api } = await world();
  const before = snapshotRecords(f);
  for (const value of [undefined, null, 42, "", "handover_outgoing", "handover_v2_", "handover_v2_ bad", "handover_v2_a/b"]) {
    await assertRejects(
      f,
      api.evaluateHandoverRecoveryEligibility({ handoverDocumentId: value, actorUid: "manager" }),
      400,
      "ELIGIBILITY_INVALID_HANDOVER",
    );
  }
  assert.deepEqual(snapshotRecords(f), before);
  const { handoverDocumentId, outgoingShiftId } = api.parseHandoverRecoveryDocumentId(DOCUMENT);
  assert.equal(handoverDocumentId, DOCUMENT);
  assert.equal(outgoingShiftId, OUTGOING_SHIFT);
});

test("38 an invalid server clock is a 503, never a classification", async () => {
  const { f, evaluate } = await world();
  await assertRejects(f, evaluate({ now: new Date(Number.NaN) }), 503, "ELIGIBILITY_UNAVAILABLE");
});

test("39 an unexpected read failure is a 503 and never a partial classification", async () => {
  const { f, evaluate } = await world();
  f.hooks.beforeCommit = () => {
    delete f.hooks.beforeCommit;
    throw new Error("Injected read failure");
  };
  await assertRejects(f, evaluate(), 503, "ELIGIBILITY_UNAVAILABLE");
});
