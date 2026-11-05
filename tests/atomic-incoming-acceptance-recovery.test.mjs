import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { atomicAcceptanceWorld } from "./helpers/atomic-acceptance-world.mjs";

// Each world compiles a fresh module graph in its own VM context. Releasing
// them between tests keeps the whole suite inside a modest heap.
afterEach(() => {
  if (typeof globalThis.gc === "function") globalThis.gc();
});

// Network-free contract tests for 09M-R3B.2 Phase 4A: receipt-backed guard
// finalization, the explicit guard lifecycle state machine and read-only
// acceptance reconciliation. Everything runs against the in-memory
// transactional double; no emulator or network is contacted, and neither the
// production acceptance route nor the UI is loaded.

const FIRST = "first_activation";
const JOIN = "subsequent_join";

const GUARD_FINALIZATION_ACTION = "EQUAL_HANDOVER_GUARD_FINALIZED_V1";
const GUARD_CLOSURE_ACTION = "EQUAL_HANDOVER_GUARD_EXCEPTIONAL_CLOSURE_V1";
const APPLICATION_ACTION = "INCOMING_ACCEPTANCE_APPLIED_V1";
const ACTIVATION_ACTION = "EQUAL_SHIFT_ACTIVATED_INCOMING_V2";

function auditDocs(world, action) {
  return world.entries("audit_logs").filter(([, value]) => value.action === action);
}

function guardWrites(world) {
  return world.writes.filter((write) => write.path.startsWith("handover_reservation_guards/"));
}

function finalizeAt(world, offsetMs) {
  return world.iso(world.firstAppliedMs + offsetMs);
}

async function rejectGuard(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.name, "GuardFinalizationError", `unexpected error ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `expected ${code}, received ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected GuardFinalizationError ${code}, but finalization succeeded`);
}

async function applyBoth(world, gapMs = 60_000) {
  const first = await world.apply("in-a");
  const join = await world.apply("in-b", { appliedMs: world.firstAppliedMs + gapMs });
  return { first, join };
}

function hydrateServerTimestamps(world) {
  const seconds = Math.floor(world.clockMs / 1000);
  const nanoseconds = (world.clockMs % 1000) * 1e6;
  const marker = { seconds, nanoseconds, toDate: () => new Date(world.clockMs) };
  const walk = (value) => {
    if (!value || typeof value !== "object") return value;
    if (value.__serverTimestamp === true) return marker;
    if (typeof value.toDate === "function") return value;
    if (Array.isArray(value)) return value.map(walk);
    for (const key of Object.keys(value)) value[key] = walk(value[key]);
    return value;
  };
  for (const [path, record] of world.records) {
    world.records.set(path, walk(record));
  }
}

function lifecycleInput(world, { nowIso = world.finalizeNowIso, closureSubjectUid = null } = {}) {
  const aggregate = world.aggregate();
  const activation = auditDocs(world, ACTIVATION_ACTION)[0]?.[1] ?? null;
  const applications = aggregate.identity.incomingTechnicianIds.map((uid) => {
    const stored = world.records.get(world.receiptPath(uid));
    const receipt = stored ? world.service.readPersistedReceipt(stored) : null;
    const kindSlots = ["incoming_clock_in", "incoming_late_acceptance"]
      .map((kind) => world.applicationDomain.createIncomingAcceptanceApplicationIdentity({
        handoverId: aggregate.reservation.handoverId,
        technicianUid: uid,
        kind,
      }));
    const evidenceIds = receipt === null ? kindSlots.map((slot) => slot.evidenceId) : [receipt.evidenceId];
    const operationIds = receipt === null
      ? kindSlots.map((slot) => slot.operationId)
      : [receipt.evidenceOperationId];
    return {
      technicianUid: uid,
      receipt,
      evidencePresent: evidenceIds.some((id) => world.records.has(`attendance_evidence_v2/${id}`)),
      operationFinalized: operationIds.some(
        (id) => world.records.get(`attendance_evidence_operations_v2/${id}`)?.status === "finalized",
      ),
      membershipPresent: world.records.has(world.membershipPath(uid)),
      attendancePresent: world.records.has(world.attendancePath(uid)),
      declaredNotYetIn: aggregate.absences.some(
        (item) => item.technicianUid === uid && item.absenceType === "not_yet_in",
      ),
    };
  });
  return {
    handoverDocumentId: world.documentId,
    aggregateLifecycleStatus: aggregate.lifecycleStatus,
    scheduledStart: aggregate.identity.scheduledStart,
    scheduledEnd: aggregate.identity.scheduledEnd,
    nowIso,
    guard: world.guard(),
    activationReceiptId: activation?.id ?? null,
    activationReceiptHash: activation?.receiptHash ?? null,
    activationActorUid: activation?.actorUid ?? null,
    applications,
    exceptionalClosure: closureSubjectUid === null
      ? null
      : {
          closureId: `closure_${closureSubjectUid}`,
          subjectUid: closureSubjectUid,
          authorizedBy: "sup-1",
          reason: "Declared not yet in.",
          recordedAt: world.iso(Date.parse(world.scheduledStart) + 60_000),
        },
  };
}

// ---------------------------------------------------------------------------
// Requirement 1/3 — the guard lifecycle state machine
// ---------------------------------------------------------------------------

test("a first acceptance never finalizes the guard and leaves the partner eligible", async () => {
  const world = await atomicAcceptanceWorld();
  const initialRevision = world.guard().guardRevision;
  const applied = await world.apply("in-a");

  assert.equal(applied.outcome, FIRST);
  assert.equal(applied.guardCleanup, "pending");
  assert.equal(world.guard().ownerLifecycleState, "active");
  assert.equal(world.guard().terminalEvidenceRef, null);
  assert.equal(world.guard().guardRevision, initialRevision);

  const error = await rejectGuard(world.finalizeGuard(), "GUARD_FINALIZATION_NOT_ELIGIBLE");
  assert.equal(error.status, 409);
  assert.equal(error.lifecycleState, "awaiting_partner_acceptance");
  assert.equal(error.commitState, "not_committed");
  assert.equal(guardWrites(world).length, 0);
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 0);

  // The partner can still join after the failed cleanup attempt.
  const join = await world.apply("in-b", { appliedMs: world.firstAppliedMs + 60_000 });
  assert.equal(join.outcome, JOIN);
  assert.equal(world.guard().ownerLifecycleState, "active");
});

test("the classifier names every guard lifecycle state explicitly", async () => {
  const classify = (world, options) =>
    world.guardLifecycle.classifyIncomingAcceptanceGuardLifecycle(lifecycleInput(world, options));

  const fresh = await atomicAcceptanceWorld();
  const awaitingFirst = classify(fresh);
  assert.equal(awaitingFirst.state, "awaiting_first_acceptance");
  assert.equal(awaitingFirst.reason, "HANDOVER_NOT_ACTIVATED");
  assert.equal(awaitingFirst.automatic, false);

  await fresh.apply("in-a");
  const awaitingPartner = classify(fresh);
  assert.equal(awaitingPartner.state, "awaiting_partner_acceptance");
  assert.equal(awaitingPartner.reason, "PARTNER_NOT_YET_APPLIED");
  assert.deepEqual([...awaitingPartner.missingTechnicianUids], ["in-b"]);
  assert.equal(awaitingPartner.requiresOperatorWorkflow, false);

  // The same handover now reaches eligibility and then completion in order.
  await fresh.apply("in-b", { appliedMs: fresh.firstAppliedMs + 60_000 });
  const eligible = classify(fresh);
  assert.equal(eligible.state, "eligible_for_normal_closure");
  assert.equal(eligible.reason, "NORMAL_CLOSURE_READY");
  assert.equal(eligible.automatic, true);
  assert.equal(eligible.missingTechnicianUids.length, 0);

  await fresh.finalizeGuard({ nowIso: finalizeAt(fresh, 180_000) });
  const finalized = classify(fresh);
  assert.equal(finalized.state, "guard_finalized");
  assert.equal(finalized.reason, "GUARD_FINALIZED");
  assert.equal(
    finalized.terminalEvidenceRef,
    auditDocs(fresh, ACTIVATION_ACTION)[0][1].id,
  );

  const exceptionWorld = await atomicAcceptanceWorld();
  await exceptionWorld.apply("in-a");
  exceptionWorld.setAbsence("in-b");
  const exception = classify(exceptionWorld, { closureSubjectUid: "in-b" });
  assert.equal(exception.state, "exceptional_closure_authorized");
  assert.equal(exception.reason, "EXCEPTIONAL_CLOSURE_READY");
  assert.equal(exception.automatic, false);
  assert.equal(exception.requiresOperatorWorkflow, true);
  assert.equal(exception.closureSubjectUid, "in-b");
  assert.equal(exception.terminalEvidenceRef, null);

  const expiredWorld = await atomicAcceptanceWorld();
  await expiredWorld.apply("in-a");
  const expired = classify(expiredWorld, { nowIso: expiredWorld.scheduledEnd });
  assert.equal(expired.state, "joining_window_expired");
  assert.equal(expired.reason, "JOIN_WINDOW_CLOSED");
  assert.deepEqual([...expired.missingTechnicianUids], ["in-b"]);

  const inconsistentWorld = await atomicAcceptanceWorld();
  inconsistentWorld.patchRecord(inconsistentWorld.guardPath, { ownerLifecycleState: "cancelled" });
  const cancelled = classify(inconsistentWorld);
  assert.equal(cancelled.state, "inconsistent_review_required");
  assert.equal(cancelled.reason, "GUARD_CANCELLED");
  assert.equal(cancelled.requiresOperatorWorkflow, true);

  const mismatchedInput = lifecycleInput(inconsistentWorld);
  mismatchedInput.guard = { ...mismatchedInput.guard, ownerHandoverDocumentId: "handover_v2_other" };
  const mismatched = inconsistentWorld.guardLifecycle.classifyIncomingAcceptanceGuardLifecycle(
    mismatchedInput,
  );
  assert.equal(mismatched.state, "inconsistent_review_required");
  assert.equal(mismatched.reason, "GUARD_OWNER_MISMATCH");

  const missingInput = lifecycleInput(inconsistentWorld);
  missingInput.guard = null;
  const missingGuard = inconsistentWorld.guardLifecycle.classifyIncomingAcceptanceGuardLifecycle(
    missingInput,
  );
  assert.equal(missingGuard.state, "inconsistent_review_required");
  assert.equal(missingGuard.reason, "GUARD_MISSING");
});

// ---------------------------------------------------------------------------
// Requirement 2 — receipt-backed normal finalization
// ---------------------------------------------------------------------------

test("both personal applications permit normal guard finalization with a deterministic audit", async () => {
  const world = await atomicAcceptanceWorld();
  const { first, join } = await applyBoth(world);
  const activationId = first.receipt.activationReceiptId;
  const initialRevision = world.guard().guardRevision;
  const aggregateBefore = world.snapshot()["equal_handovers_v2/handover_v2_outgoing"];
  const writesBefore = world.writes.length;

  const result = await world.finalizeGuard({ nowIso: finalizeAt(world, 180_000) });

  assert.equal(result.status, "FINALIZED");
  assert.equal(result.replayed, false);
  assert.equal(result.mode, "normal_closure");
  assert.equal(result.commitState, "committed_validated");
  assert.equal(result.provenance, "phase4a_audited");
  assert.equal(result.terminalEvidenceRef, activationId);
  assert.equal(result.activationReceiptId, activationId);
  assert.equal(result.activationReceiptHash, first.receipt.activationReceiptHash);
  assert.equal(result.auditState, "created");
  assert.equal(result.lifecycleState, "completed");
  assert.equal(result.closure, null);
  assert.equal(result.applications.length, 2);
  assert.deepEqual(
    [...result.applications.map((application) => [application.technicianUid, application.outcome])],
    [["in-a", FIRST], ["in-b", JOIN]],
  );
  assert.equal(result.applications[1].receiptHash, join.receiptHash);

  const guard = world.guard();
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, activationId);
  assert.equal(guard.guardRevision, initialRevision + 1);

  const audits = auditDocs(world, GUARD_FINALIZATION_ACTION);
  assert.equal(audits.length, 1);
  const [auditPath, audit] = audits[0];
  assert.equal(auditPath, `audit_logs/${result.auditId}`);
  assert.equal(audit.schema, "equal-handover-guard-finalization-audit-v1");
  assert.equal(audit.mode, "normal_closure");
  assert.equal(audit.guardRevisionBefore, initialRevision);
  assert.equal(audit.guardRevisionAfter, initialRevision + 1);
  assert.equal(audit.terminalEvidenceRef, activationId);
  assert.equal(audit.authorizedByUid, "in-a");
  assert.deepEqual([...audit.technicianUids], ["in-a", "in-b"]);
  assert.equal(audit.applications.length, 2);
  assert.equal(audit.closure, null);
  assert.equal(typeof audit.createdAt.toDate, "function", "audit commit marker must be resolved");

  // Finalization writes exactly the guard and its audit; it never touches the
  // aggregate, the shift, the frozen report or the applications.
  assert.deepEqual(
    world.writes.slice(writesBefore).map((write) => write.path).sort(),
    [`audit_logs/${result.auditId}`, "handover_reservation_guards/guard_outgoing"].sort(),
  );
  assert.deepEqual(world.snapshot()["equal_handovers_v2/handover_v2_outgoing"], aggregateBefore);
  assert.equal(world.aggregate().lifecycleStatus, "completed");
});

test("duplicate finalization requests replay without a second audit or write", async () => {
  const world = await atomicAcceptanceWorld();
  await applyBoth(world);
  const first = await world.finalizeGuard({ nowIso: finalizeAt(world, 180_000) });
  const snapshotBefore = world.snapshot();
  const writesBefore = world.writes.length;

  const replay = await world.finalizeGuard({ nowIso: finalizeAt(world, 240_000) });

  assert.equal(replay.status, "ALREADY_FINALIZED");
  assert.equal(replay.replayed, true);
  assert.equal(replay.commitState, "committed_validated");
  assert.equal(replay.provenance, "phase4a_audited");
  assert.equal(replay.auditState, "existing");
  assert.equal(replay.auditId, first.auditId);
  assert.equal(replay.terminalEvidenceRef, first.terminalEvidenceRef);
  assert.equal(replay.applications.length, 0);
  assert.equal(replay.closure, null);
  assert.equal(world.writes.length, writesBefore, "a replay must not write");
  assert.deepEqual(world.snapshot(), snapshotBefore);
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 1);
});

test("a failed finalization commit rolls back the guard and the audit together", async () => {
  const world = await atomicAcceptanceWorld();
  await applyBoth(world);
  const before = world.snapshot();
  const writesBefore = world.writes.length;
  world.hooks.commit = () => {
    throw new Error("guard finalization commit rejected");
  };

  await assert.rejects(
    world.finalizeGuard({ nowIso: finalizeAt(world, 180_000) }),
    /guard finalization commit rejected/,
  );
  delete world.hooks.commit;

  assert.deepEqual(world.snapshot(), before);
  assert.equal(world.writes.length, writesBefore);
  assert.equal(world.guard().ownerLifecycleState, "active");
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 0);

  const retry = await world.finalizeGuard({ nowIso: finalizeAt(world, 180_000) });
  assert.equal(retry.status, "FINALIZED");
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 1);
});

test("finalization without the partner receipt is refused and the guard stays active", async () => {
  const world = await atomicAcceptanceWorld();
  await world.apply("in-a");

  const error = await rejectGuard(
    world.finalizeGuard({ nowIso: finalizeAt(world, 180_000) }),
    "GUARD_FINALIZATION_NOT_ELIGIBLE",
  );
  assert.equal(error.lifecycleState, "awaiting_partner_acceptance");
  assert.equal(world.guard().ownerLifecycleState, "active");
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 1);
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 0);
});

test("a receipt whose attendance or membership was altered blocks finalization and reconciliation", async () => {
  const world = await atomicAcceptanceWorld();
  await applyBoth(world);
  world.patchRecord(world.attendancePath("in-a"), { technicianId: "in-b" });

  const error = await rejectGuard(
    world.finalizeGuard({ nowIso: finalizeAt(world, 180_000) }),
    "GUARD_FINALIZATION_INCONSISTENT",
  );
  assert.equal(error.status, 409);
  assert.equal(world.guard().ownerLifecycleState, "active");
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 0);

  const reconciled = await world.reconcile("in-a");
  assert.equal(reconciled.status, "INCONSISTENT_HISTORY");
  assert.equal(reconciled.applied, false);
  assert.equal(reconciled.requiresAdministrativeReview, true);
  assert.equal(reconciled.receiptId, world.receiptId("in-a"));
});

// ---------------------------------------------------------------------------
// Requirement 3 — exceptional closure
// ---------------------------------------------------------------------------

test("a supervisor may close an absent technician's guard without fabricating participation", async () => {
  const world = await atomicAcceptanceWorld();
  const applied = await world.apply("in-a");
  const supervisor = world.addSupervisor("sup-1");
  world.setAbsence("in-b");
  const closure = world.closureFor("in-b");
  const beforeAuditCount = auditDocs(world, APPLICATION_ACTION).length;
  const writesBefore = world.writes.length;

  const result = await world.finalizeGuard({
    actorUid: supervisor,
    nowIso: world.closureNowIso,
    exceptionalClosure: closure,
  });

  assert.equal(result.status, "FINALIZED");
  assert.equal(result.mode, "exceptional_closure");
  assert.equal(result.provenance, "phase4a_audited");
  assert.equal(result.terminalEvidenceRef, closure.closureId);
  assert.equal(result.auditId.startsWith("guard_finalization_v1_"), true);
  assert.deepEqual([...result.applications.map((item) => item.technicianUid)], ["in-a"]);
  assert.equal(result.applications[0].receiptId, applied.receipt.id);
  assert.equal(result.closure.closureId, closure.closureId);
  assert.equal(result.closure.subjectUid, "in-b");
  assert.equal(result.closure.authorizedBy, supervisor);
  assert.equal(result.closure.absenceReason, "Declared not yet in.");

  const guard = world.guard();
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, closure.closureId);

  const audits = auditDocs(world, GUARD_CLOSURE_ACTION);
  assert.equal(audits.length, 1);
  assert.equal(audits[0][0], `audit_logs/${result.auditId}`);
  assert.equal(audits[0][1].mode, "exceptional_closure");
  assert.equal(audits[0][1].closure.subjectUid, "in-b");
  assert.equal(audits[0][1].closure.absenceReason, "Declared not yet in.");
  assert.equal(audits[0][1].closure.authorizedBy, supervisor);
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 0);

  // No membership, attendance, receipt, evidence or application audit was
  // created for the absent technician.
  assert.equal(world.records.has(world.membershipPath("in-b")), false);
  assert.equal(world.records.has(world.attendancePath("in-b")), false);
  assert.equal(world.records.has(world.receiptPath("in-b")), false);
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 1);
  assert.equal(auditDocs(world, APPLICATION_ACTION).length, beforeAuditCount);
  const inB = world.applicationDomain.createIncomingAcceptanceApplicationIdentity({
    handoverId: world.aggregate().reservation.handoverId,
    technicianUid: "in-b",
    kind: "incoming_clock_in",
  });
  assert.equal(world.records.has(`attendance_evidence_v2/${inB.evidenceId}`), false);
  assert.equal(world.records.has(`attendance_evidence_operations_v2/${inB.operationId}`), false);

  // Only the guard and its authorization audit were written.
  const finalizationWrites = world.writes.slice(writesBefore);
  assert.deepEqual(
    finalizationWrites.map((write) => write.path).sort(),
    [`audit_logs/${result.auditId}`, "handover_reservation_guards/guard_outgoing"].sort(),
  );
  assert.equal(guardWrites(world).length, 1);

  const replay = await world.finalizeGuard({
    actorUid: supervisor,
    nowIso: world.closureNowIso,
    exceptionalClosure: closure,
  });
  assert.equal(replay.status, "ALREADY_FINALIZED");
  assert.equal(replay.provenance, "phase4a_audited");
  assert.equal(replay.auditId, result.auditId);
  assert.equal(auditDocs(world, GUARD_CLOSURE_ACTION).length, 1);
});

test("invalid or fabricated exception closures never finalize the guard", async () => {
  // No authoritative absence declaration.
  const noAbsence = await atomicAcceptanceWorld();
  await noAbsence.apply("in-a");
  noAbsence.addSupervisor("sup-1");
  const missingAbsence = await rejectGuard(
    noAbsence.finalizeGuard({
      actorUid: "sup-1",
      nowIso: noAbsence.closureNowIso,
      exceptionalClosure: noAbsence.closureFor("in-b"),
    }),
    "GUARD_FINALIZATION_NOT_ELIGIBLE",
  );
  assert.equal(missingAbsence.lifecycleState, "exceptional_closure_authorized");
  assert.equal(noAbsence.guard().ownerLifecycleState, "active");
  assert.equal(auditDocs(noAbsence, GUARD_CLOSURE_ACTION).length, 0);

  // A participating technician cannot authorize their own exception closure.
  const fabricated = await atomicAcceptanceWorld();
  await fabricated.apply("in-a");
  fabricated.addSupervisor("sup-1");
  fabricated.setAbsence("in-b");

  const unauthorized = await rejectGuard(
    fabricated.finalizeGuard({
      actorUid: "in-a",
      nowIso: fabricated.closureNowIso,
      exceptionalClosure: fabricated.closureFor("in-b"),
    }),
    "GUARD_FINALIZATION_UNAUTHORIZED",
  );
  assert.equal(unauthorized.status, 403);
  assert.equal(fabricated.guard().ownerLifecycleState, "active");

  // The closure subject must be the other reserved incoming technician.
  const wrongSubject = await rejectGuard(
    fabricated.finalizeGuard({
      actorUid: "sup-1",
      nowIso: fabricated.closureNowIso,
      exceptionalClosure: fabricated.closureFor("out-a"),
    }),
    "GUARD_FINALIZATION_NOT_ELIGIBLE",
  );
  assert.equal(wrongSubject.lifecycleState, null);

  // The closure cannot predate the activation it replaces.
  const premature = await rejectGuard(
    fabricated.finalizeGuard({
      actorUid: "sup-1",
      nowIso: fabricated.closureNowIso,
      exceptionalClosure: fabricated.closureFor("in-b", {
        recordedAt: fabricated.iso(fabricated.firstAppliedMs - 120_000),
      }),
    }),
    "GUARD_FINALIZATION_NOT_ELIGIBLE",
  );
  assert.equal(premature.lifecycleState, "exceptional_closure_authorized");

  assert.equal(fabricated.guard().ownerLifecycleState, "active");
  assert.equal(auditDocs(fabricated, GUARD_CLOSURE_ACTION).length, 0);
});

test("the joining window expiring leaves the guard active for operator review", async () => {
  const world = await atomicAcceptanceWorld();
  await world.apply("in-a");

  const error = await rejectGuard(
    world.finalizeGuard({ nowIso: world.scheduledEnd }),
    "GUARD_FINALIZATION_NOT_ELIGIBLE",
  );
  assert.equal(error.lifecycleState, "joining_window_expired");
  assert.equal(world.guard().ownerLifecycleState, "active");
  assert.equal(world.guard().terminalEvidenceRef, null);
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 0);

  // The expired window is exactly the boundary the join service enforces.
  await assert.rejects(
    world.apply("in-b", {
      appliedMs: Date.parse(world.scheduledEnd),
      lateReason: "Arrived after shift end",
    }),
    (candidate) => candidate.code === "JOIN_WINDOW_CLOSED",
  );
});

// ---------------------------------------------------------------------------
// Requirement 4 — read-only reconciliation
// ---------------------------------------------------------------------------

test("reconciliation proves an application after the HTTP acknowledgement is lost", async () => {
  const world = await atomicAcceptanceWorld();
  world.hooks.afterCommit = () => {
    throw new Error("acknowledgement lost");
  };
  await assert.rejects(world.apply("in-a"), /acknowledgement lost/);
  delete world.hooks.afterCommit;
  const snapshotBefore = world.snapshot();
  const writesBefore = world.writes.length;

  const reconciled = await world.reconcile("in-a");

  assert.equal(reconciled.readOnly, true);
  assert.equal(reconciled.status, "APPLIED_VALIDATED");
  assert.equal(reconciled.reason, "RECEIPT_EVIDENCE_PARTICIPATION_AUDIT_VALIDATED");
  assert.equal(reconciled.applied, true);
  assert.equal(reconciled.retryWouldReplay, true);
  assert.equal(reconciled.requiresAdministrativeReview, false);
  assert.equal(reconciled.outcome, FIRST);
  assert.equal(reconciled.receiptId, world.receiptId("in-a"));
  assert.equal(reconciled.operationalAppliedAt, world.iso(world.firstAppliedMs));
  assert.equal(reconciled.partnerTechnicianUid, "in-b");
  assert.equal(reconciled.partnerApplied, false);
  assert.equal(reconciled.evidencePresent, true);
  assert.equal(reconciled.operationFinalized, true);
  assert.equal(reconciled.membershipPresent, true);
  assert.equal(reconciled.attendancePresent, true);
  assert.equal(reconciled.applicationAuditPresent, true);
  assert.equal(reconciled.guardLifecycleState, "active");
  assert.equal(reconciled.legacyClassification, null);
  assert.equal(world.writes.length, writesBefore, "reconciliation must not write");
  assert.deepEqual(world.snapshot(), snapshotBefore);
});

test("a reserved technician with no artifacts is reported as not applied", async () => {
  const world = await atomicAcceptanceWorld();
  const fresh = await world.reconcile("in-b");
  assert.equal(fresh.status, "NOT_APPLIED");
  assert.equal(fresh.reason, "NO_APPLICATION_RECORD");
  assert.equal(fresh.applied, false);
  assert.equal(fresh.retryWouldReplay, false);
  assert.equal(fresh.partnerApplied, false);

  await world.apply("in-a");
  const waiting = await world.reconcile("in-b");
  assert.equal(waiting.status, "NOT_APPLIED", "an activated handover does not imply the partner applied");
  assert.equal(waiting.partnerApplied, true);
  assert.equal(waiting.guardLifecycleState, "active");
});

test("an unresolved commit marker is never reported as applied and heals when resolved", async () => {
  const world = await atomicAcceptanceWorld();
  world.resolveServerTimestamps = false;
  await assert.rejects(
    world.apply("in-a"),
    (candidate) => candidate.code === "APPLICATION_OUTCOME_UNKNOWN",
  );

  const unresolved = await world.reconcile("in-a");
  assert.equal(unresolved.status, "COMMIT_UNVERIFIABLE");
  assert.equal(unresolved.reason, "COMMIT_MARKER_UNRESOLVED");
  assert.equal(unresolved.applied, false);
  assert.equal(unresolved.requiresAdministrativeReview, false);
  assert.equal(unresolved.receiptId, world.receiptId("in-a"));

  hydrateServerTimestamps(world);
  world.resolveServerTimestamps = true;
  const hydrated = await world.reconcile("in-a");
  assert.equal(hydrated.status, "APPLIED_VALIDATED");
  assert.equal(hydrated.retryWouldReplay, true);
});

test("a tampered application receipt blocks both finalization and reconciliation", async () => {
  const world = await atomicAcceptanceWorld();
  await applyBoth(world);
  world.patchRecord(world.receiptPath("in-a"), { outcome: JOIN });

  const error = await rejectGuard(
    world.finalizeGuard({ nowIso: finalizeAt(world, 180_000) }),
    "GUARD_FINALIZATION_INCONSISTENT",
  );
  assert.equal(error.status, 409);
  assert.equal(world.guard().ownerLifecycleState, "active");

  const reconciled = await world.reconcile("in-a");
  assert.equal(reconciled.status, "INCONSISTENT_HISTORY");
  assert.equal(reconciled.reason, "MALFORMED_APPLICATION_RECEIPT");
  assert.equal(reconciled.applied, false);
  assert.equal(reconciled.requiresAdministrativeReview, true);
});

test("finalized legacy evidence without participation is reported as evidence-only", async () => {
  const world = await atomicAcceptanceWorld();
  const evidenceModule = world.load("lib/operations/atomic-acceptance-evidence");
  const attendanceDomain = world.load("lib/operations/attendance-evidence-domain");
  const schema = world.load("types/attendance-evidence").ATTENDANCE_EVIDENCE_SCHEMA;

  const aggregate = world.aggregate();
  const binding = world.reviewedBinding();
  const applicationIdentity = world.applicationDomain.createIncomingAcceptanceApplicationIdentity({
    handoverId: aggregate.reservation.handoverId,
    technicianUid: "in-a",
    kind: "incoming_clock_in",
  });
  const request = {
    schema,
    handoverId: aggregate.reservation.handoverId,
    handoverDocumentId: world.documentId,
    eventId: applicationIdentity.eventId,
    position: world.positionOf("in-a"),
    technicianUid: "in-a",
    kind: "incoming_clock_in",
    scheduledStart: aggregate.identity.scheduledStart,
    scheduledEnd: aggregate.identity.scheduledEnd,
    reportedDepartureTime: null,
    attestedByUid: null,
    attestationReason: null,
    lateReason: null,
    handoverRevision: aggregate.revision,
    snapshotHash: binding.snapshotHash,
    expectedGuardRevision: binding.guardRevision,
    expectedFencingEpoch: binding.fencingEpoch,
  };
  const plan = evidenceModule.planAtomicAcceptanceEvidence(
    {
      operation: null,
      slotEvidence: null,
      otherKindEvidence: [],
      guard: world.guard(),
      handover: aggregate,
    },
    {
      request,
      identity: aggregate.identity,
      reservation: aggregate.reservation,
      trustedAuthentication: {
        verifiedTechnicianUid: "in-a",
        method: attendanceDomain.attendanceAuthenticationMethodForKind("incoming_clock_in"),
      },
      serverAuthenticationTime: world.iso(world.firstAppliedMs),
    },
  );
  await world.db.runTransaction(async (transaction) => {
    evidenceModule.applyAtomicAcceptanceEvidencePlan(transaction, plan);
  });
  // A freshly composed plan carries interruptedFinalization until the
  // acknowledgement is durably recorded; this fixture models a legacy record
  // whose evidence and operation were finalized and acknowledged, but which
  // never produced an operational application.
  world.patchRecord(
    `attendance_evidence_operations_v2/${plan.operationId}`,
    { interruptedFinalization: false },
  );
  const writesBefore = world.writes.length;

  const reconciled = await world.reconcile("in-a");

  assert.equal(reconciled.status, "EVIDENCE_ONLY");
  assert.equal(reconciled.reason, "EVIDENCE_WITHOUT_OPERATIONAL_APPLICATION");
  assert.equal(reconciled.legacyClassification, "LEGACY_UNAPPLIED_AUTHENTICATED_ATTEMPT");
  assert.equal(reconciled.applied, false);
  assert.equal(reconciled.evidencePresent, true);
  assert.equal(reconciled.operationFinalized, true);
  assert.equal(reconciled.membershipPresent, false);
  assert.equal(reconciled.attendancePresent, false);
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 0);
  assert.equal(world.writes.length, writesBefore);
});

// ---------------------------------------------------------------------------
// Requirement 5 — audit and notification consistency
// ---------------------------------------------------------------------------

test("guard finalization is audit- and outbox-idempotent and never announces acceptance", async () => {
  const world = await atomicAcceptanceWorld({ notificationsEnabled: true });
  const first = await world.apply("in-a");
  const join = await world.apply("in-b", { appliedMs: world.firstAppliedMs + 60_000 });

  assert.deepEqual({ ...first.notificationDelivery }, {
    enabled: true,
    outboxState: "written",
    intentsQueued: 4,
    intentsExisting: 0,
  });
  assert.deepEqual({ ...join.notificationDelivery }, {
    enabled: true,
    outboxState: "not_required",
    intentsQueued: 0,
    intentsExisting: 0,
  });
  assert.equal(world.entries("notification_outbox").length, 4);
  assert.equal(world.entries("notifications").length, 4);
  const outboxSnapshot = world.entries("notification_outbox")
    .map(([path, value]) => [path, value])
    .sort(([left], [right]) => (left < right ? -1 : 1));

  const finalized = await world.finalizeGuard({ nowIso: finalizeAt(world, 180_000) });
  assert.equal(finalized.status, "FINALIZED");
  const replay = await world.finalizeGuard({ nowIso: finalizeAt(world, 240_000) });
  assert.equal(replay.status, "ALREADY_FINALIZED");

  assert.equal(world.entries("notification_outbox").length, 4, "finalization emits no notification");
  assert.equal(world.entries("notifications").length, 4);
  assert.deepEqual(
    world.entries("notification_outbox")
      .map(([path, value]) => [path, value])
      .sort(([left], [right]) => (left < right ? -1 : 1)),
    outboxSnapshot,
  );
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 1);
  assert.equal(auditDocs(world, ACTIVATION_ACTION).length, 1);
  assert.equal(auditDocs(world, APPLICATION_ACTION).length, 2);
});

test("disabled notification delivery is reported explicitly, never as delivered", async () => {
  const world = await atomicAcceptanceWorld();
  const applied = await world.apply("in-a");

  assert.deepEqual({ ...applied.notificationDelivery }, {
    enabled: false,
    outboxState: "disabled",
    intentsQueued: 0,
    intentsExisting: 0,
  });
  assert.equal(world.entries("notification_outbox").length, 0);
  assert.equal(world.entries("notifications").length, 0);
});

// ---------------------------------------------------------------------------
// Requirement 15/16 — concurrency and preservation
// ---------------------------------------------------------------------------

test("concurrent joining and guard cleanup converge on exactly one completion", async () => {
  const world = await atomicAcceptanceWorld();
  await world.apply("in-a");
  const initialRevision = world.guard().guardRevision;

  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 250));
  world.hooks.beforeCommit = async () => {
    arrivals += 1;
    if (arrivals >= 2) release();
    await Promise.race([gate, timeout]);
  };

  const [joinOutcome, finalizeOutcome] = await Promise.allSettled([
    world.apply("in-b", { appliedMs: world.firstAppliedMs + 60_000 }),
    world.finalizeGuard({ nowIso: finalizeAt(world, 240_000) }),
  ]);
  delete world.hooks.beforeCommit;

  assert.equal(joinOutcome.status, "fulfilled", `${joinOutcome.reason?.name}: ${joinOutcome.reason?.message}`);
  assert.equal(joinOutcome.value.outcome, JOIN);

  // The cleanup transaction either committed after the join or read the
  // pre-join state and failed closed. A retry must then converge on one guard
  // completion and one audit — never a second closure.
  let finalized;
  if (finalizeOutcome.status === "fulfilled") {
    finalized = finalizeOutcome.value;
  } else {
    assert.equal(finalizeOutcome.reason.name, "GuardFinalizationError");
    assert.equal(finalizeOutcome.reason.code, "GUARD_FINALIZATION_NOT_ELIGIBLE");
    finalized = await world.finalizeGuard({ nowIso: finalizeAt(world, 300_000) });
  }
  assert.equal(finalized.status, "FINALIZED");

  assert.equal(world.guard().ownerLifecycleState, "completed");
  assert.equal(world.guard().guardRevision, initialRevision + 1);
  assert.equal(
    world.guard().terminalEvidenceRef,
    auditDocs(world, ACTIVATION_ACTION)[0][1].id,
  );
  assert.equal(guardWrites(world).length, 1);
  assert.equal(auditDocs(world, GUARD_FINALIZATION_ACTION).length, 1);
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 2);
  assert.equal(auditDocs(world, APPLICATION_ACTION).length, 2);
});

test("guard finalization preserves frozen reports, activation and application history", async () => {
  const world = await atomicAcceptanceWorld({ notificationsEnabled: true });
  const { first, join } = await applyBoth(world);
  const activation = auditDocs(world, ACTIVATION_ACTION)[0];
  const reportPath = `handover_reports_v2/${world.aggregate().reportBinding.id}`;
  const preservedPaths = [
    reportPath,
    activation[0],
    world.receiptPath("in-a"),
    world.receiptPath("in-b"),
    world.aggregatePath,
    "shifts/incoming",
    "shifts/outgoing",
    "operational_shift_control/global",
    `attendance_evidence_v2/${first.receipt.evidenceId}`,
    `attendance_evidence_v2/${join.receipt.evidenceId}`,
    `attendance_evidence_operations_v2/${first.receipt.evidenceOperationId}`,
    `attendance_evidence_operations_v2/${join.receipt.evidenceOperationId}`,
    world.membershipPath("in-a"),
    world.membershipPath("in-b"),
    world.attendancePath("in-a"),
    world.attendancePath("in-b"),
  ];
  const before = new Map(preservedPaths.map((path) => [path, world.snapshot()[path]]));
  const domain = world.load("lib/operations/equal-technician-handover-domain");
  const aggregateHash = domain.createEqualHandoverSnapshot(world.aggregate()).snapshotHash;

  await world.finalizeGuard({ nowIso: finalizeAt(world, 180_000) });

  for (const path of preservedPaths) {
    assert.deepEqual(world.snapshot()[path], before.get(path), `${path} must be untouched`);
  }
  assert.equal(
    domain.createEqualHandoverSnapshot(world.aggregate()).snapshotHash,
    aggregateHash,
  );
  assert.equal(world.aggregate().lifecycleStatus, "completed");
  assert.deepEqual(
    auditDocs(world, ACTIVATION_ACTION).length,
    1,
    "activation history is append-only",
  );
  assert.deepEqual(
    world.entries("incoming_acceptance_applications_v1").length,
    2,
    "application history is append-only",
  );
  assert.deepEqual(
    auditDocs(world, APPLICATION_ACTION).length,
    2,
    "application audits are append-only",
  );
});
