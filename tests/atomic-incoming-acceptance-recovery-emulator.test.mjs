/**
 * Firestore emulator integration suite for the 09M-R3B.2 Phase 4A guard
 * finalization and acceptance reconciliation services. Unlike the network-free
 * double, this suite exercises the real Firestore transaction API: commit
 * contention and optimistic retries, server timestamps, post-commit read-back
 * and persisted-state validation.
 *
 * Run via: tests/run-atomic-acceptance-recovery-emulator.ps1
 *
 * Isolation invariant: project "demo-atomic-acceptance-r4a" on the dedicated
 * Firestore port 8182 only, no import/export, synthetic records only. The suite
 * refuses to run under any other project or host. The presentation, 09D, 09L
 * and 09M UAT stacks are never contacted.
 *
 * Fault-injection scenarios (rolled-back commits, lost acknowledgements,
 * unreadable read-backs, unresolved commit markers, tampered receipts) are
 * covered by tests/atomic-incoming-acceptance-recovery.test.mjs, which can
 * intercept the commit boundary; a real emulator cannot simulate those losses.
 */
import assert from "node:assert/strict";
import test from "node:test";

const project = "demo-atomic-acceptance-r4a";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8182", "localhost:8182"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run recovery emulator tests outside the isolated demo emulator.");
}
if (process.env.NOTIFICATIONS_ENABLED !== "true") {
  throw new Error("The recovery emulator suite requires its dedicated notification setting.");
}

const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { Timestamp } = await import("firebase-admin/firestore");
const { acceptanceFixture } = await import("./helpers/acceptance-integrity-fixtures.mjs");
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { applyIncomingAcceptanceApplicationAtomically } = await import(
  "../src/lib/operations/incoming-acceptance-application-firestore.ts"
);
const applicationDomain = await import("../src/lib/operations/incoming-acceptance-application-domain.ts");
const {
  createEqualHandoverSnapshot,
  getEqualHandoverPositions,
} = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const { finalizeIncomingAcceptanceGuardAtomically } = await import(
  "../src/lib/operations/incoming-acceptance-guard-finalization.ts"
);
const { reconcileIncomingAcceptance } = await import(
  "../src/lib/operations/incoming-acceptance-reconciliation.ts"
);

const db = getAdminFirestore();
const aggregatePath = "equal_handovers_v2/handover_v2_outgoing";
const guardPath = "handover_reservation_guards/guard_outgoing";
const receiptsCollection = "incoming_acceptance_applications_v1";
const GUARD_FINALIZATION_ACTION = "EQUAL_HANDOVER_GUARD_FINALIZED_V1";
const GUARD_CLOSURE_ACTION = "EQUAL_HANDOVER_GUARD_EXCEPTIONAL_CLOSURE_V1";

const read = async (path) => (await db.doc(path).get()).data();

function toFirestore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && Number.isSafeInteger(value.seconds) && Number.isSafeInteger(value.nanoseconds)) {
    return new Timestamp(value.seconds, value.nanoseconds);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toFirestore);
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toFirestore(item);
    }
    return result;
  }
  return value;
}

async function seed() {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200);
  const base = await acceptanceFixture();
  let batch = db.batch();
  let count = 0;
  for (const [path, value] of base.records) {
    batch.set(db.doc(path), toFirestore(structuredClone(value)));
    count += 1;
    if (count === 400) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
  return base;
}

async function reviewedBinding() {
  const aggregate = await read(aggregatePath);
  const guard = await read(guardPath);
  return {
    handoverId: aggregate.reservation.handoverId,
    handoverDocumentId: "handover_v2_outgoing",
    aggregateRevision: aggregate.revision,
    snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
    // Freezing revises the aggregate after the immutable report is stamped; the
    // reviewed report carries the live revision overlaid by the coordinator.
    report: { ...aggregate.reportBinding, aggregateRevision: aggregate.revision },
    guardRevision: guard.guardRevision,
    fencingEpoch: guard.fencingEpoch,
  };
}

async function firstAppliedMs() {
  const aggregate = await read(aggregatePath);
  return Math.max(
    Date.parse(aggregate.updatedAt) + 60_000,
    Date.parse(aggregate.identity.scheduledStart) + 60_000,
  );
}

async function apply(uid, overrides = {}) {
  const appliedMs = overrides.appliedMs ?? (await firstAppliedMs());
  const binding = overrides.binding ?? (await reviewedBinding());
  const lateReason = overrides.lateReason ?? null;
  const nonce = `nonce-${uid}-${appliedMs}`;
  const iso = (ms) => new Date(ms).toISOString();
  const proof = applicationDomain.createIncomingAcceptanceAuthenticationProof({
    requestNonce: nonce,
    verifiedTechnicianUid: uid,
    verifiedAt: iso(appliedMs - 2000),
    authAccountCheckedAt: iso(appliedMs - 1000),
    reviewedBinding: binding,
    lateReason,
    verifiedAtMonotonicMs: 1_000_000,
  });
  return applyIncomingAcceptanceApplicationAtomically({
    outgoingShiftId: "outgoing",
    actorUid: uid,
    reviewedBinding: binding,
    lateReason,
    requestNonce: nonce,
    proof,
    requestAcceptedAt: iso(appliedMs - 3000),
    operationalAppliedAt: iso(appliedMs),
    nowIso: iso(appliedMs + 100),
    nowMonotonicMs: 1_004_000,
  });
}

async function finalize(actorUid, overrides = {}) {
  const aggregate = await read(aggregatePath);
  const nowIso = overrides.nowIso
    ?? new Date(Date.parse(aggregate.updatedAt) + 60_000).toISOString();
  return finalizeIncomingAcceptanceGuardAtomically({
    outgoingShiftId: "outgoing",
    actorUid,
    nowIso,
    exceptionalClosure: overrides.exceptionalClosure ?? null,
  });
}

async function reconcile(uid) {
  return reconcileIncomingAcceptance({ outgoingShiftId: "outgoing", technicianUid: uid });
}

async function count(collection) {
  return (await db.collection(collection).get()).size;
}

async function audits(action) {
  return (await db.collection("audit_logs").where("action", "==", action).get()).docs.map((doc) => doc.data());
}

/**
 * Records an authoritative not_yet_in declaration for an incoming technician.
 * Production records this through the handover workflow; the test writes the
 * smallest valid aggregate mutation so the closure is backed by real state.
 */
async function declareNotYetIn(uid) {
  const aggregate = await read(aggregatePath);
  const position = getEqualHandoverPositions(aggregate.identity)
    .find((entry) => entry.technicianUid === uid && entry.side === "incoming")?.position;
  assert.ok(position);
  const absence = {
    position,
    technicianUid: uid,
    absenceType: "not_yet_in",
    reportedDepartureTime: null,
    recordedBy: aggregate.identity.outgoingTechnicianIds[0],
    attestedByUid: null,
    reason: "Declared not yet in.",
    recordedRevision: aggregate.revision,
    revision: aggregate.revision,
    recordedAt: aggregate.updatedAt,
  };
  const absences = [...aggregate.absences, absence];
  const snapshotHash = createEqualHandoverSnapshot({ ...aggregate, absences }).snapshotHash;
  const confirmations = aggregate.confirmations
    .filter((item) => item.position !== position)
    .map((item) => ({ ...item, snapshotHash }));
  await db.doc(aggregatePath).update({ absences, confirmations });
  return absence;
}

test("first and second acceptance leave the guard active and both receipts valid", async () => {
  await seed();
  const first = await apply("in-a");
  const join = await apply("in-b");
  assert.equal(first.outcome, "first_activation");
  assert.equal(join.outcome, "subsequent_join");

  const guard = await read(guardPath);
  assert.equal(guard.ownerLifecycleState, "active");
  assert.equal(guard.terminalEvidenceRef, null);

  for (const uid of ["in-a", "in-b"]) {
    const reconciled = await reconcile(uid);
    assert.equal(reconciled.status, "APPLIED_VALIDATED", uid);
    assert.equal(reconciled.readOnly, true);
    assert.equal(reconciled.retryWouldReplay, true);
    assert.equal(reconciled.applied, true);
    assert.equal(reconciled.partnerApplied, true);
    assert.equal(reconciled.guardLifecycleState, "active");
    assert.equal(reconciled.evidencePresent, true);
    assert.equal(reconciled.operationFinalized, true);
    assert.equal(reconciled.membershipPresent, true);
    assert.equal(reconciled.attendancePresent, true);
    assert.equal(reconciled.applicationAuditPresent, true);
  }

  // Neither acceptance finalized the guard, and no finalization audit exists.
  assert.equal((await audits(GUARD_FINALIZATION_ACTION)).length, 0);
  assert.equal((await db.collection("audit_logs")
    .where("action", "==", "EQUAL_SHIFT_ACTIVATED_INCOMING_V2").get()).size, 1);
});

test("normal finalization completes the guard once with a deterministic audit", async () => {
  await seed();
  await apply("in-a");
  await apply("in-b");
  const guardBefore = await read(guardPath);

  const result = await finalize("in-a");
  assert.equal(result.status, "FINALIZED");
  assert.equal(result.replayed, false);
  assert.equal(result.mode, "normal_closure");
  assert.equal(result.commitState, "committed_validated");
  assert.equal(result.provenance, "phase4a_audited");
  assert.equal(result.auditState, "created");
  assert.equal(result.guardRevision, guardBefore.guardRevision + 1);
  assert.equal(result.lifecycleState, "completed");
  assert.equal(result.applications.length, 2);
  assert.deepEqual(
    [...result.applications.map((application) => application.technicianUid)].sort(),
    ["in-a", "in-b"],
  );

  const guard = await read(guardPath);
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, result.terminalEvidenceRef);
  assert.equal(guard.guardRevision, guardBefore.guardRevision + 1);

  const audit = await read(`audit_logs/${result.auditId}`);
  assert.equal(audit.action, GUARD_FINALIZATION_ACTION);
  assert.equal(audit.schema, "equal-handover-guard-finalization-audit-v1");
  assert.equal(audit.mode, "normal_closure");
  assert.equal(audit.terminalEvidenceRef, result.terminalEvidenceRef);
  assert.equal(audit.guardRevisionBefore, guardBefore.guardRevision);
  assert.equal(audit.guardRevisionAfter, guardBefore.guardRevision + 1);
  assert.ok(audit.createdAt instanceof Timestamp);
  assert.deepEqual([...audit.technicianUids].sort(), ["in-a", "in-b"]);

  const replay = await finalize("in-b");
  assert.equal(replay.status, "ALREADY_FINALIZED");
  assert.equal(replay.replayed, true);
  assert.equal(replay.auditId, result.auditId);
  assert.equal(replay.auditState, "existing");
  assert.deepEqual(await read(guardPath), guard);
  assert.equal((await audits(GUARD_FINALIZATION_ACTION)).length, 1);

  // Reconciliation still proves the application after the guard is terminal.
  const reconciled = await reconcile("in-a");
  assert.equal(reconciled.status, "APPLIED_VALIDATED");
  assert.equal(reconciled.guardLifecycleState, "completed");
  assert.equal(reconciled.guardTerminalEvidenceRef, result.terminalEvidenceRef);
});

test("finalization without the partner receipt is refused and the guard stays active", async () => {
  await seed();
  await apply("in-a");
  const aggregate = await read(aggregatePath);
  const nowIso = new Date(Math.min(
    Date.parse(aggregate.identity.scheduledEnd) - 60_000,
    Date.parse(aggregate.updatedAt) + 60_000,
  )).toISOString();

  await assert.rejects(
    finalize("in-a", { nowIso }),
    (error) => {
      assert.equal(error.code, "GUARD_FINALIZATION_NOT_ELIGIBLE", `${error.name}: ${error.message}`);
      assert.equal(error.commitState, "not_committed");
      assert.equal(error.lifecycleState, "awaiting_partner_acceptance");
      return true;
    },
  );
  assert.equal((await read(guardPath)).ownerLifecycleState, "active");
  assert.equal((await audits(GUARD_FINALIZATION_ACTION)).length, 0);
  assert.equal(await count(receiptsCollection), 1);
});

test("altered attendance blocks finalization and reconciliation", async () => {
  await seed();
  const first = await apply("in-a");
  await apply("in-b");
  await db.doc(`shift_attendance/incoming_${first.technicianUid}`).delete();

  await assert.rejects(
    finalize("in-a"),
    (error) => {
      // The lifecycle gate sees an application that no longer proves its
      // attendance, so the guard is refused before any verification write.
      assert.equal(error.code, "GUARD_FINALIZATION_NOT_ELIGIBLE", `${error.name}: ${error.message}`);
      assert.equal(error.lifecycleState, "inconsistent_review_required");
      return true;
    },
  );
  assert.equal((await read(guardPath)).ownerLifecycleState, "active");
  assert.equal((await audits(GUARD_FINALIZATION_ACTION)).length, 0);

  const reconciled = await reconcile("in-a");
  assert.equal(reconciled.status, "INCONSISTENT_HISTORY");
  assert.equal(reconciled.applied, false);
  assert.equal(reconciled.requiresAdministrativeReview, true);
});

test("a tampered application receipt blocks finalization and reconciliation", async () => {
  await seed();
  await apply("in-a");
  const join = await apply("in-b");
  const stored = await read(`${receiptsCollection}/${join.receipt.id}`);
  await db.doc(`${receiptsCollection}/${join.receipt.id}`).update({
    operationalAppliedAt: new Date(Date.parse(stored.operationalAppliedAt) + 1000).toISOString(),
  });

  await assert.rejects(
    finalize("in-a"),
    (error) => {
      assert.equal(error.code, "GUARD_FINALIZATION_INCONSISTENT", `${error.name}: ${error.message}`);
      return true;
    },
  );
  assert.equal((await read(guardPath)).ownerLifecycleState, "active");

  const reconciled = await reconcile("in-b");
  assert.equal(reconciled.status, "INCONSISTENT_HISTORY");
  assert.equal(reconciled.reason, "MALFORMED_APPLICATION_RECEIPT");
  assert.equal(reconciled.requiresAdministrativeReview, true);
});

test("the joining window closing leaves the guard active for operator review", async () => {
  await seed();
  await apply("in-a");
  const aggregate = await read(aggregatePath);

  await assert.rejects(
    finalize("in-a", { nowIso: aggregate.identity.scheduledEnd }),
    (error) => {
      assert.equal(error.code, "GUARD_FINALIZATION_NOT_ELIGIBLE", `${error.name}: ${error.message}`);
      assert.equal(error.lifecycleState, "joining_window_expired");
      return true;
    },
  );
  assert.equal((await read(guardPath)).ownerLifecycleState, "active");

  await assert.rejects(
    apply("in-b", {
      appliedMs: Date.parse(aggregate.identity.scheduledEnd),
      lateReason: "Arrived after the joining window.",
    }),
    (error) => {
      assert.equal(error.code, "JOIN_WINDOW_CLOSED", `${error.name}: ${error.message}`);
      return true;
    },
  );
  assert.equal(await count(receiptsCollection), 1);
});

test("a supervisor may close an absent technician's guard without fabricating participation", async () => {
  await seed();
  await apply("in-a");
  const activation = await read(aggregatePath);
  await db.doc("users/sup-1").set({
    uid: "sup-1",
    role: "supervisor",
    status: "active",
    statusOperation: null,
    mustChangePassword: false,
    fullName: "Synthetic Supervisor",
  });
  await declareNotYetIn("in-b");

  const closureId = "closure_r4a_outgoing_1";
  const recordedAt = new Date(Date.parse(activation.updatedAt) + 30_000).toISOString();
  const nowIso = new Date(Date.parse(activation.updatedAt) + 60_000).toISOString();
  const result = await finalize("sup-1", {
    nowIso,
    exceptionalClosure: {
      closureId,
      subjectUid: "in-b",
      reason: "Partner declared not yet in; operator closed the reservation.",
      recordedAt,
    },
  });

  assert.equal(result.status, "FINALIZED");
  assert.equal(result.mode, "exceptional_closure");
  assert.equal(result.provenance, "phase4a_audited");
  assert.equal(result.terminalEvidenceRef, closureId);
  assert.equal(result.closure.subjectUid, "in-b");
  assert.equal(result.closure.absenceReason, "Declared not yet in.");
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].technicianUid, "in-a");

  const guard = await read(guardPath);
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, closureId);

  const [closureAudit] = await audits(GUARD_CLOSURE_ACTION);
  assert.equal(closureAudit.id, result.auditId);
  assert.equal(closureAudit.mode, "exceptional_closure");
  assert.equal(closureAudit.closure.subjectUid, "in-b");
  assert.equal(closureAudit.authorizedByUid, "sup-1");
  assert.equal((await audits(GUARD_FINALIZATION_ACTION)).length, 0);

  // Zero fabricated artifacts for the absent technician.
  const absentReceiptId = applicationDomain.createIncomingAcceptanceApplicationIdentity({
    handoverId: activation.reservation.handoverId,
    technicianUid: "in-b",
    kind: "incoming_clock_in",
  }).receiptId;
  assert.equal(await read(`${receiptsCollection}/${absentReceiptId}`), undefined);
  assert.equal(await read("shift_members/incoming_in-b"), undefined);
  assert.equal(await read("shift_attendance/incoming_in-b"), undefined);
  assert.equal((await db.collection("attendance_evidence_v2")
    .where("technicianUid", "==", "in-b").get()).size, 0);
  assert.equal((await db.collection("attendance_evidence_operations_v2")
    .where("request.technicianUid", "==", "in-b").get()).size, 0);

  // The absent technician is never reported as applied.
  const reconciled = await reconcile("in-b");
  assert.equal(reconciled.status, "NOT_APPLIED");
  assert.equal(reconciled.reason, "NO_APPLICATION_RECORD");
  assert.equal(reconciled.applied, false);

  // The closure replays without a second audit or write.
  const replay = await finalize("sup-1", {
    nowIso,
    exceptionalClosure: {
      closureId,
      subjectUid: "in-b",
      reason: "Partner declared not yet in; operator closed the reservation.",
      recordedAt,
    },
  });
  assert.equal(replay.status, "ALREADY_FINALIZED");
  assert.equal(replay.mode, "exceptional_closure");
  assert.equal(replay.auditId, result.auditId);
  assert.equal((await audits(GUARD_CLOSURE_ACTION)).length, 1);
});

test("concurrent finalization converges on exactly one guard completion", async () => {
  await seed();
  await apply("in-a");
  await apply("in-b");
  const guardBefore = await read(guardPath);
  const aggregate = await read(aggregatePath);
  const nowIso = new Date(Math.min(
    Date.parse(aggregate.identity.scheduledEnd) - 60_000,
    Date.parse(aggregate.updatedAt) + 60_000,
  )).toISOString();

  const outcomes = await Promise.all([
    finalize("in-a", { nowIso }),
    finalize("in-b", { nowIso }),
  ]);
  assert.deepEqual(outcomes.map((item) => item.status).sort(), ["ALREADY_FINALIZED", "FINALIZED"]);
  assert.equal(outcomes[0].auditId, outcomes[1].auditId);

  const guard = await read(guardPath);
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.guardRevision, guardBefore.guardRevision + 1);
  assert.equal((await audits(GUARD_FINALIZATION_ACTION)).length, 1);
  assert.equal(await count("incoming_acceptance_applications_v1"), 2);
});

test("finalization preserves frozen reports, activation and application history", async () => {
  await seed();
  const first = await apply("in-a");
  const join = await apply("in-b");
  const aggregate = await read(aggregatePath);
  const evidence = [
    await read(`attendance_evidence_v2/${first.receipt.evidenceId}`),
    await read(`attendance_evidence_v2/${join.receipt.evidenceId}`),
  ];
  const operations = [
    await read(`attendance_evidence_operations_v2/${first.receipt.evidenceOperationId}`),
    await read(`attendance_evidence_operations_v2/${join.receipt.evidenceOperationId}`),
  ];
  const before = {
    report: await read(`handover_reports_v2/${aggregate.reportBinding.id}`),
    activation: await read(`audit_logs/${first.receipt.activationReceiptId}`),
    receipts: [
      await read(`${receiptsCollection}/${first.receipt.id}`),
      await read(`${receiptsCollection}/${join.receipt.id}`),
    ],
    applications: [
      await read(`audit_logs/${first.receipt.auditId}`),
      await read(`audit_logs/${join.receipt.auditId}`),
    ],
    membership: [
      await read("shift_members/incoming_in-a"),
      await read("shift_members/incoming_in-b"),
    ],
    attendance: [
      await read("shift_attendance/incoming_in-a"),
      await read("shift_attendance/incoming_in-b"),
    ],
    incoming: await read("shifts/incoming"),
    outgoing: await read("shifts/outgoing"),
    control: await read("operational_shift_control/global"),
    evidence,
    operations,
    aggregate,
  };

  const result = await finalize("in-a");
  assert.equal(result.status, "FINALIZED");

  assert.deepEqual(await read(`handover_reports_v2/${aggregate.reportBinding.id}`), before.report);
  assert.deepEqual(await read(`audit_logs/${first.receipt.activationReceiptId}`), before.activation);
  assert.deepEqual(await read(`${receiptsCollection}/${first.receipt.id}`), before.receipts[0]);
  assert.deepEqual(await read(`${receiptsCollection}/${join.receipt.id}`), before.receipts[1]);
  assert.deepEqual(await read(`audit_logs/${first.receipt.auditId}`), before.applications[0]);
  assert.deepEqual(await read(`audit_logs/${join.receipt.auditId}`), before.applications[1]);
  assert.deepEqual(await read("shift_members/incoming_in-a"), before.membership[0]);
  assert.deepEqual(await read("shift_members/incoming_in-b"), before.membership[1]);
  assert.deepEqual(await read("shift_attendance/incoming_in-a"), before.attendance[0]);
  assert.deepEqual(await read("shift_attendance/incoming_in-b"), before.attendance[1]);
  assert.deepEqual(await read("shifts/incoming"), before.incoming);
  assert.deepEqual(await read("shifts/outgoing"), before.outgoing);
  assert.deepEqual(await read("operational_shift_control/global"), before.control);
  assert.deepEqual(await read(`attendance_evidence_v2/${first.receipt.evidenceId}`), before.evidence[0]);
  assert.deepEqual(await read(`attendance_evidence_v2/${join.receipt.evidenceId}`), before.evidence[1]);
  assert.deepEqual(
    await read(`attendance_evidence_operations_v2/${first.receipt.evidenceOperationId}`),
    before.operations[0],
  );
  assert.deepEqual(
    await read(`attendance_evidence_operations_v2/${join.receipt.evidenceOperationId}`),
    before.operations[1],
  );
  assert.deepEqual(await read(aggregatePath), before.aggregate);
  assert.equal(await count(receiptsCollection), 2);
  assert.equal(await count("attendance_evidence_v2"), 2);
  assert.equal(await count("attendance_evidence_operations_v2"), 2);
});
