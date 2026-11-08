import assert from "node:assert/strict";
import test from "node:test";
import { atomicAcceptanceWorld } from "./helpers/atomic-acceptance-world.mjs";

// Network-free contract tests for the 09M-R3B.2 Phase 3 atomic acceptance
// service. Every scenario runs against the in-memory transactional double
// (read-before-write ordering, optimistic conflicts, all-or-nothing commit,
// unresolved server timestamps, fault injection); no emulator or network is
// contacted, and the production HTTP route is never loaded.

const FIRST = "first_activation";
const JOIN = "subsequent_join";

async function rejectWithCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      assert.equal(
        error.code,
        code,
        `expected ${code}, received ${error.code}: ${error.message}`,
      );
    } else {
      assert.fail(
        `expected rejection with ${code}, received ${error?.name ?? "Error"}: ${error?.message}`,
      );
    }
    return error;
  }
  return assert.fail(`expected rejection with ${code}, but the application succeeded`);
}

async function rejectWith(promise, name, status) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.name, name, `unexpected error ${error.name}: ${error.message}`);
    if (status !== undefined) assert.equal(error.status, status);
    return error;
  }
  return assert.fail(`expected ${name}, but the application succeeded`);
}

function incomingEntries(world, collection) {
  return world
    .entries(collection)
    .filter(([path]) => path.startsWith(`${collection}/${world.incomingShiftId}_`));
}

function evidenceRefs(world, uid, kind = "incoming_clock_in") {
  const identity = world.applicationDomain.createIncomingAcceptanceApplicationIdentity({
    handoverId: world.aggregate().reservation.handoverId,
    technicianUid: uid,
    kind,
  });
  return {
    identity,
    evidencePath: `attendance_evidence_v2/${identity.evidenceId}`,
    operationPath: `attendance_evidence_operations_v2/${identity.operationId}`,
  };
}

function auditDocs(world, action) {
  return world
    .entries("audit_logs")
    .filter(([, value]) => value.action === action);
}

// A commit gate makes both transactions reach their write phase before either
// is allowed to persist, so the optimistic-conflict path is genuinely exercised.
function gateCommits(world, expected = 2) {
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 250));
  world.hooks.beforeCommit = async () => {
    arrivals += 1;
    if (arrivals >= expected) release();
    await Promise.race([gate, timeout]);
  };
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

test("first activation applies evidence, participation and receipt in one transaction", async () => {
  const world = await atomicAcceptanceWorld();
  const appliedAt = world.iso(world.firstAppliedMs);
  const result = await world.apply("in-a");

  assert.equal(result.status, "APPLIED");
  assert.equal(result.replayed, false);
  assert.equal(result.outcome, FIRST);
  assert.equal(result.commitState, "committed_validated");
  assert.equal(result.guardCleanup, "pending");
  assert.equal(result.technicianUid, "in-a");
  assert.equal(result.position, world.positionOf("in-a"));
  assert.equal(result.handoverDocumentId, world.documentId);
  assert.equal(result.incomingShiftId, world.incomingShiftId);
  assert.match(result.receiptHash, /^[0-9a-f]{64}$/);
  assert.equal(result.receipt.receiptHash, result.receiptHash);
  assert.equal(result.receipt.outcome, FIRST);
  assert.equal(result.receipt.operationalAppliedAt, appliedAt);
  assert.equal(result.receipt.personalEvidenceEventAt, appliedAt);
  assert.equal(result.receipt.membershipId, `${world.incomingShiftId}_in-a`);
  assert.equal(result.receipt.attendanceId, `${world.incomingShiftId}_in-a`);

  // A single caller-owned transaction produced the whole outcome.
  assert.equal(world.commits(), 1);
  assert.equal(world.authCalls, 0, "no password or auth lookup may happen inside the service");

  assert.equal(world.aggregate().lifecycleStatus, "completed");
  const incoming = world.records.get("shifts/incoming");
  assert.equal(incoming.status, "active");
  assert.equal(incoming.actualStart, appliedAt);
  assert.equal(incoming.primaryTechnicianIds.length, 2);
  const outgoing = world.records.get("shifts/outgoing");
  assert.equal(outgoing.status, "completed");
  assert.equal(outgoing.actualEnd, appliedAt);
  const control = world.records.get("operational_shift_control/global");
  assert.equal(control.shiftId, "incoming");
  assert.equal(control.shiftStatus, "active");
  assert.equal(control.slotStatus, "consumed");

  // Only the authenticated technician is manufactured into participation; the
  // reserved partner is not, and no absence is converted into attendance.
  assert.equal(incomingEntries(world, "shift_members").length, 1);
  assert.equal(incomingEntries(world, "shift_attendance").length, 1);
  const membership = world.records.get(world.membershipPath("in-a"));
  assert.equal(membership.technicianId, "in-a");
  assert.equal(membership.role, "primary");
  assert.equal(membership.joinedAt, appliedAt);
  const attendance = world.records.get(world.attendancePath("in-a"));
  assert.equal(attendance.technicianId, "in-a");
  assert.equal(attendance.status, "present");
  assert.equal(attendance.recordedAt, appliedAt);
  assert.equal(world.records.has(world.membershipPath("in-b")), false);
  assert.equal(world.records.has(world.attendancePath("in-b")), false);

  const refs = evidenceRefs(world, "in-a");
  const evidence = world.records.get(refs.evidencePath);
  const operation = world.records.get(refs.operationPath);
  assert.equal(evidence.technicianUid, "in-a");
  assert.equal(evidence.kind, "incoming_clock_in");
  assert.equal(evidence.eventTime.toDate().toISOString(), appliedAt);
  assert.equal(evidence.clockIn.toDate().toISOString(), appliedAt);
  assert.equal(evidence.personallyAuthenticated, true);
  assert.equal(
    evidence.authenticationMethod,
    world.load("lib/operations/attendance-evidence-domain")
      .attendanceAuthenticationMethodForKind("incoming_clock_in"),
  );
  assert.equal(operation.status, "finalized");
  assert.equal(operation.interruptedFinalization, false);
  assert.equal(operation.evidenceId, refs.identity.evidenceId);
  assert.equal(
    operation.requestedAt.toDate().toISOString(),
    appliedAt,
    "new-protocol requestedAt must be the trusted server timestamp",
  );

  // Deterministic activation + per-person application audit records.
  const activations = auditDocs(world, "EQUAL_SHIFT_ACTIVATED_INCOMING_V2");
  assert.equal(activations.length, 1);
  const activation = activations[0][1];
  assert.equal(activation.actorUid, "in-a");
  assert.equal(activation.activatedAt, appliedAt);
  assert.equal(result.receipt.activationReceiptId, activation.id);
  assert.equal(result.receipt.activationReceiptHash, activation.receiptHash);
  const applications = auditDocs(world, "INCOMING_ACCEPTANCE_APPLIED_V1");
  assert.equal(applications.length, 1);
  assert.equal(applications[0][1].receiptId, result.receipt.id);
  assert.equal(applications[0][1].receiptHash, result.receiptHash);

  // Guard completion is a separate transaction: the service never touches it.
  assert.equal(
    world.writes.some((write) => write.path.startsWith("handover_reservation_guards/")),
    false,
  );
  assert.equal(world.guard().ownerLifecycleState, "active");
});

test("second technician joins without recreating the handover or overwriting the first", async () => {
  const world = await atomicAcceptanceWorld();
  const first = await world.apply("in-a");
  const firstReceiptPath = world.receiptPath("in-a");
  const firstRefs = evidenceRefs(world, "in-a");
  const before = world.snapshot();

  const joinAt = world.firstAppliedMs + 60_000;
  const second = await world.apply("in-b", { appliedMs: joinAt });

  assert.equal(second.status, "APPLIED");
  assert.equal(second.outcome, JOIN);
  assert.equal(second.guardCleanup, "pending");
  assert.equal(second.technicianUid, "in-b");
  assert.equal(second.position, world.positionOf("in-b"));
  assert.equal(second.receipt.activationReceiptId, first.receipt.activationReceiptId);
  assert.equal(second.receipt.activationReceiptHash, first.receipt.activationReceiptHash);

  const after = world.snapshot();
  assert.deepEqual(after["shifts/incoming"], before["shifts/incoming"]);
  assert.deepEqual(after[firstReceiptPath], before[firstReceiptPath]);
  assert.deepEqual(after[firstRefs.evidencePath], before[firstRefs.evidencePath]);
  assert.deepEqual(after[firstRefs.operationPath], before[firstRefs.operationPath]);
  assert.equal(auditDocs(world, "EQUAL_SHIFT_ACTIVATED_INCOMING_V2").length, 1);
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 2);
  assert.equal(incomingEntries(world, "shift_members").length, 2);
  assert.equal(incomingEntries(world, "shift_attendance").length, 2);
  assert.equal(world.aggregate().lifecycleStatus, "completed");
  assert.equal(
    world.writes.filter((write) => write.path === "operational_shift_control/global").length,
    1,
    "joining must not transfer operational control again",
  );
});

test("either incoming technician may be the first to activate", async () => {
  const world = await atomicAcceptanceWorld();
  const first = await world.apply("in-b");
  assert.equal(first.outcome, FIRST);
  assert.equal(first.receipt.position, world.positionOf("in-b"));

  const second = await world.apply("in-a", { appliedMs: world.firstAppliedMs + 30_000 });
  assert.equal(second.outcome, JOIN);
  assert.equal(second.receipt.position, world.positionOf("in-a"));
  assert.equal(second.receipt.technicianUid, "in-a");

  const receipts = world
    .entries("incoming_acceptance_applications_v1")
    .map(([, value]) => value);
  assert.deepEqual(
    receipts.map((receipt) => receipt.outcome).sort(),
    [FIRST, JOIN].sort(),
  );
  assert.equal(new Set(receipts.map((receipt) => receipt.id)).size, 2);
});

test("concurrent applications produce exactly one activation and one join", async () => {
  const world = await atomicAcceptanceWorld();
  gateCommits(world);

  const [left, right] = await Promise.allSettled([
    world.apply("in-a"),
    world.apply("in-b"),
  ]);
  assert.equal(left.status, "fulfilled", `${left.reason?.name}: ${left.reason?.message}`);
  assert.equal(right.status, "fulfilled", `${right.reason?.name}: ${right.reason?.message}`);
  delete world.hooks.beforeCommit;

  const outcomes = [left.value, right.value].map((result) => result.outcome).sort();
  assert.deepEqual(outcomes, [FIRST, JOIN].sort());
  assert.notEqual(left.value.technicianUid, right.value.technicianUid);

  // One activation receipt, one incoming shift, one control transfer, but two
  // independently authored receipts/evidence/participation records.
  assert.equal(auditDocs(world, "EQUAL_SHIFT_ACTIVATED_INCOMING_V2").length, 1);
  assert.equal(world.entries("shifts").filter(([path]) => path === "shifts/incoming").length, 1);
  assert.equal(
    world.writes.filter((write) => write.path === "operational_shift_control/global").length,
    1,
  );
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 2);
  assert.equal(auditDocs(world, "INCOMING_ACCEPTANCE_APPLIED_V1").length, 2);
  assert.equal(incomingEntries(world, "shift_members").length, 2);
  assert.equal(incomingEntries(world, "shift_attendance").length, 2);
  assert.equal(world.entries("attendance_evidence_v2").length, 2);
  assert.equal(world.entries("attendance_evidence_operations_v2").length, 2);

  const receipts = world
    .entries("incoming_acceptance_applications_v1")
    .map(([, value]) => value);
  assert.equal(new Set(receipts.map((receipt) => receipt.id)).size, 2);
  assert.equal(new Set(receipts.map((receipt) => receipt.activationReceiptId)).size, 1);
  assert.equal(world.aggregate().lifecycleStatus, "completed");
});

test("concurrent duplicate requests from the same technician replay without duplicate records", async () => {
  const world = await atomicAcceptanceWorld();
  gateCommits(world);

  const [left, right] = await Promise.allSettled([world.apply("in-a"), world.apply("in-a")]);
  const fulfilled = [left, right].filter((item) => item.status === "fulfilled");
  assert.equal(fulfilled.length, 2);
  const statuses = fulfilled.map((item) => item.value.status).sort();
  assert.deepEqual(statuses, ["APPLIED", "REPLAYED"]);
  delete world.hooks.beforeCommit;

  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 1);
  assert.equal(incomingEntries(world, "shift_members").length, 1);
  assert.equal(incomingEntries(world, "shift_attendance").length, 1);
  assert.equal(world.entries("attendance_evidence_v2").length, 1);
  assert.equal(world.entries("attendance_evidence_operations_v2").length, 1);
  assert.equal(auditDocs(world, "INCOMING_ACCEPTANCE_APPLIED_V1").length, 1);
});

test("a duplicate request replays write-free and preserves the original timestamps", async () => {
  const world = await atomicAcceptanceWorld();
  const first = await world.apply("in-a");
  const refs = evidenceRefs(world, "in-a");
  const before = {
    receipt: world.snapshot()[world.receiptPath("in-a")],
    evidence: world.snapshot()[refs.evidencePath],
    operation: world.snapshot()[refs.operationPath],
    membership: world.snapshot()[world.membershipPath("in-a")],
    writes: world.writes.length,
  };

  const replay = await world.apply("in-a", { nonce: "a-brand-new-nonce" });

  assert.equal(replay.status, "REPLAYED");
  assert.equal(replay.replayed, true);
  assert.equal(replay.outcome, FIRST);
  assert.equal(replay.commitState, "committed_validated");
  assert.equal(replay.receiptHash, first.receiptHash);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(world.writes.length, before.writes, "a replay must not write anything");
  assert.deepEqual(world.snapshot()[world.receiptPath("in-a")], before.receipt);
  assert.deepEqual(world.snapshot()[refs.evidencePath], before.evidence);
  assert.deepEqual(world.snapshot()[refs.operationPath], before.operation);
  assert.deepEqual(world.snapshot()[world.membershipPath("in-a")], before.membership);
});

test("a receipt whose linked participation records were altered cannot be replayed", async () => {
  const world = await atomicAcceptanceWorld();
  await world.apply("in-a");
  const membership = world.records.get(world.membershipPath("in-a"));
  membership.technicianId = "in-b";

  await rejectWithCode(world.apply("in-a"), "PARTICIPATION_INCONSISTENT");
});

test("a failed transaction leaves no partial evidence or participation", async () => {
  const world = await atomicAcceptanceWorld();
  const before = world.snapshot();
  world.hooks.commit = () => {
    throw new Error("commit rejected by storage");
  };

  await assert.rejects(world.apply("in-a"), /commit rejected by storage/);

  assert.deepEqual(world.snapshot(), before);
  assert.equal(world.writes.length, 0);
  assert.equal(world.commits(), 0);
  delete world.hooks.commit;
});

test("a failed join leaves the first technician's activation untouched", async () => {
  const world = await atomicAcceptanceWorld();
  await world.apply("in-a");
  const before = world.snapshot();

  world.hooks.commit = () => {
    throw new Error("join commit rejected");
  };
  await assert.rejects(
    world.apply("in-b", { appliedMs: world.firstAppliedMs + 60_000 }),
    /join commit rejected/,
  );
  assert.deepEqual(world.snapshot(), before);
  delete world.hooks.commit;

  const join = await world.apply("in-b", { appliedMs: world.firstAppliedMs + 60_000 });
  assert.equal(join.outcome, JOIN);
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 2);
});

test("a lost commit acknowledgement never duplicates writes on retry", async () => {
  const world = await atomicAcceptanceWorld();
  world.hooks.afterCommit = () => {
    throw new Error("acknowledgement lost");
  };

  await assert.rejects(world.apply("in-a"), /acknowledgement lost/);
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 1);
  assert.equal(incomingEntries(world, "shift_members").length, 1);
  const committedReceipt = world.snapshot()[world.receiptPath("in-a")];
  const writesAfterCommit = world.writes.length;
  delete world.hooks.afterCommit;

  const retry = await world.apply("in-a");
  assert.equal(retry.status, "REPLAYED");
  assert.equal(world.writes.length, writesAfterCommit);
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 1);
  assert.deepEqual(world.snapshot()[world.receiptPath("in-a")], committedReceipt);
});

test("an unreadable commit is reported as an unknown outcome, never as success", async () => {
  const world = await atomicAcceptanceWorld();
  world.hooks.directRead = () => {
    throw new Error("read-back unavailable");
  };

  const error = await rejectWith(
    world.apply("in-a"),
    "AtomicAcceptanceServiceError",
    503,
  );
  assert.equal(error.code, "APPLICATION_OUTCOME_UNKNOWN");
  assert.equal(error.commitState, "committed_unreadable");
  delete world.hooks.directRead;

  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 1);
  const replay = await world.apply("in-a");
  assert.equal(replay.status, "REPLAYED");
});

test("an unresolved server timestamp is not a success and hydrates later", async () => {
  const world = await atomicAcceptanceWorld();
  world.resolveServerTimestamps = false;

  const error = await rejectWith(
    world.apply("in-a"),
    "AtomicAcceptanceServiceError",
    503,
  );
  assert.equal(error.code, "APPLICATION_OUTCOME_UNKNOWN");
  assert.equal(error.commitState, "committed_unresolved");

  const receiptPath = world.receiptPath("in-a");
  const stored = world.records.get(receiptPath);
  assert.equal(stored.committedAt.__serverTimestamp, true);
  const storedHash = stored.receiptHash;

  // A background hydration resolves the marker; the receipt hash excludes
  // committedAt, so it must remain identical.
  hydrateServerTimestamps(world);
  world.resolveServerTimestamps = true;
  const writesAfterHydration = world.writes.length;

  const replay = await world.apply("in-a");
  assert.equal(replay.status, "REPLAYED");
  assert.equal(replay.commitState, "committed_validated");
  assert.equal(replay.receiptHash, storedHash);
  assert.equal(world.records.get(receiptPath).receiptHash, storedHash);
  assert.equal(world.writes.length, writesAfterHydration);
});

test("a tampered persisted receipt is rejected instead of returned", async () => {
  const world = await atomicAcceptanceWorld();
  const receiptPath = world.receiptPath("in-a");
  let originalOutcome;
  world.hooks.afterCommit = () => {
    const stored = world.records.get(receiptPath);
    originalOutcome = stored.outcome;
    stored.outcome = JOIN;
  };

  const error = await rejectWith(
    world.apply("in-a"),
    "AtomicAcceptanceServiceError",
    503,
  );
  assert.equal(error.code, "APPLICATION_OUTCOME_UNKNOWN");
  assert.equal(error.commitState, "committed_inconsistent");
  delete world.hooks.afterCommit;

  world.records.get(receiptPath).outcome = originalOutcome;
  const replay = await world.apply("in-a");
  assert.equal(replay.status, "REPLAYED");
  assert.equal(replay.outcome, FIRST);
});

test("a stale guard revision fails closed", async () => {
  const world = await atomicAcceptanceWorld();
  const staleBinding = world.reviewedBinding();
  const currentGuard = world.guard();
  world.records.set(world.guardPath, {
    ...currentGuard,
    guardRevision: currentGuard.guardRevision + 1,
  });

  await rejectWithCode(world.apply("in-a", { binding: staleBinding }), "REVIEW_BINDING_CHANGED");
  assert.equal(world.writes.length, 0);
});

test("a changed aggregate binding fails closed", async () => {
  const world = await atomicAcceptanceWorld();
  const binding = world.reviewedBinding();
  // The technician reviewed a different handover state than the one on disk.
  binding.snapshotHash = "0".repeat(64);

  await rejectWithCode(world.apply("in-a", { binding }), "REVIEW_BINDING_CHANGED");
  assert.equal(world.writes.length, 0);
});

test("disabled and unreserved accounts cannot initiate", async () => {
  const world = await atomicAcceptanceWorld();
  world.profile("in-a").status = "suspended";
  await rejectWith(world.apply("in-a"), "AssignmentOperationError", 403);
  assert.equal(world.writes.length, 0);

  world.profile("in-a").status = "active";
  await rejectWithCode(world.apply("c"), "AUTH_IDENTITY_CHANGED");
  assert.equal(world.writes.length, 0);
});

test("authentication proofs must match the request nonce and stay fresh", async () => {
  const world = await atomicAcceptanceWorld();
  const binding = world.reviewedBinding();
  const appliedMs = world.firstAppliedMs;

  const wrongNonce = world.proofFor({
    actorUid: "in-a",
    binding,
    lateReason: null,
    appliedMs,
    nonce: "nonce-from-another-request",
  });
  await rejectWithCode(
    world.apply("in-a", { nonce: "expected-nonce", proof: wrongNonce }),
    "AUTHENTICATION_PROOF_INVALID",
  );

  const expired = world.proofFor({
    actorUid: "in-a",
    binding,
    lateReason: null,
    appliedMs,
    nonce: "expired-nonce",
    verifiedAtMonotonicMs: 900_000,
  });
  await rejectWithCode(
    world.apply("in-a", { nonce: "expired-nonce", proof: expired }),
    "AUTHENTICATION_EXPIRED",
  );
  assert.equal(world.writes.length, 0);
});

test("acceptance inside the fifteen-minute grace needs no late reason", async () => {
  const world = await atomicAcceptanceWorld();
  const insideGrace = Date.parse(world.scheduledStart) + 6 * 60_000;

  const result = await world.apply("in-a", { appliedMs: insideGrace });
  assert.equal(result.outcome, FIRST);
  assert.equal(result.receipt.lateReason, null);
  assert.equal(result.receipt.lateReasonSource, "not_required");
});

test("late acceptance requires and records a meaningful reason", async () => {
  const world = await atomicAcceptanceWorld();
  const appliedMs = Date.parse(world.scheduledStart) + 16 * 60_000;

  await rejectWithCode(world.apply("in-a", { appliedMs }), "LATE_REASON_REQUIRED");
  assert.equal(world.writes.length, 0);

  const reason = "Delayed train on the north line";
  const result = await world.apply("in-a", { appliedMs, lateReason: reason });
  assert.equal(result.outcome, FIRST);
  assert.equal(result.receipt.lateReason, reason);
  assert.equal(typeof result.receipt.lateReasonSource, "string");
  const evidence = world.records.get(evidenceRefs(world, "in-a").evidencePath);
  assert.equal(evidence.lateReason, reason);
});

test("first activation honours the activation window", async () => {
  const world = await atomicAcceptanceWorld();
  const start = Date.parse(world.scheduledStart);

  await rejectWithCode(
    world.apply("in-a", { appliedMs: start - 16 * 60_000 }),
    "ACTIVATION_NOT_OPEN",
  );
  await rejectWithCode(
    world.apply("in-a", {
      appliedMs: start + 61 * 60_000,
      lateReason: "Unexpected road closure",
    }),
    "ACTIVATION_WINDOW_EXPIRED",
  );
  assert.equal(world.writes.length, 0);
});

test("the partner cannot join after the shift has ended", async () => {
  const world = await atomicAcceptanceWorld();
  await world.apply("in-a");
  const end = Date.parse(world.scheduledEnd);

  await rejectWithCode(
    world.apply("in-b", { appliedMs: end, lateReason: "Arrived after shift end" }),
    "JOIN_WINDOW_CLOSED",
  );
  assert.equal(world.records.has(world.membershipPath("in-b")), false);
  assert.equal(world.records.has(world.receiptPath("in-b")), false);
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 1);
});

test("guard cleanup is a separate transaction whose failure cannot invalidate an application", async () => {
  const world = await atomicAcceptanceWorld();
  const applied = await world.apply("in-a");
  assert.equal(applied.guardCleanup, "pending");
  assert.equal(
    world.writes.some((write) => write.path.startsWith("handover_reservation_guards/")),
    false,
  );
  assert.equal(world.guard().ownerLifecycleState, "active");
  const before = world.snapshot();

  world.hooks.commit = () => {
    throw new Error("guard cleanup transaction failed");
  };
  await assert.rejects(
    world.db.runTransaction(async (transaction) => {
      await transaction.get(world.db.doc(world.guardPath));
      transaction.set(world.db.doc(world.guardPath), {
        ...world.guard(),
        ownerLifecycleState: "completed",
      });
    }),
    /guard cleanup transaction failed/,
  );
  delete world.hooks.commit;

  assert.deepEqual(world.snapshot(), before);
  const replay = await world.apply("in-a");
  assert.equal(replay.status, "REPLAYED");
  assert.equal(replay.outcome, FIRST);
});

test("finalized evidence without an application receipt cannot be promoted", async () => {
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
  assert.equal(plan.mode, "create_operation_and_evidence");
  await world.db.runTransaction(async (transaction) => {
    evidenceModule.applyAtomicAcceptanceEvidencePlan(transaction, plan);
  });
  assert.equal(world.records.has(`attendance_evidence_v2/${plan.evidenceId}`), true);
  assert.equal(
    world.records.get(`attendance_evidence_operations_v2/${plan.operationId}`).status,
    "finalized",
  );

  await rejectWithCode(world.apply("in-a"), "EVIDENCE_BINDING_CONFLICT");
  assert.equal(world.entries("incoming_acceptance_applications_v1").length, 0);
  assert.equal(world.records.has(world.membershipPath("in-a")), false);
  assert.equal(world.records.has("shifts/incoming"), false);
  assert.equal(auditDocs(world, "INCOMING_ACCEPTANCE_APPLIED_V1").length, 0);
});

test("completion audit and notification outbox commit atomically with acceptance", async () => {
  const world = await atomicAcceptanceWorld({ notificationsEnabled: true });
  await world.apply("in-a");

  assert.equal(world.commits(), 1);
  // Four HANDOVER_COMPLETED intents (all participants) plus one owner-approved
  // SHIFT_STARTED intent for the accepting technician's partner.
  assert.equal(world.entries("notification_outbox").length, 5);
  assert.equal(world.entries("notifications").length, 5);
  const recipients = new Set(
    world.entries("notification_outbox").map(([, value]) => value.recipientUid),
  );
  assert.deepEqual([...recipients].sort(), ["in-a", "in-b", "out-a", "out-b"]);
  const started = world.entries("notification_outbox")
    .map(([, value]) => value)
    .filter((value) => value.eventKind === "shift_started");
  assert.equal(started.length, 1);
  assert.equal(started[0].recipientUid, "in-b");
  assert.equal(auditDocs(world, "EQUAL_SHIFT_ACTIVATED_INCOMING_V2").length, 1);
  assert.equal(auditDocs(world, "INCOMING_ACCEPTANCE_APPLIED_V1").length, 1);
});

test("a failed acceptance rolls back audit and outbox writes together", async () => {
  const world = await atomicAcceptanceWorld({ notificationsEnabled: true });
  const before = world.snapshot();
  world.hooks.commit = () => {
    throw new Error("storage refused the batch");
  };

  await assert.rejects(world.apply("in-a"), /storage refused the batch/);

  assert.deepEqual(world.snapshot(), before);
  assert.equal(world.entries("notification_outbox").length, 0);
  assert.equal(world.entries("notifications").length, 0);
  assert.equal(auditDocs(world, "EQUAL_SHIFT_ACTIVATED_INCOMING_V2").length, 0);
  assert.equal(auditDocs(world, "INCOMING_ACCEPTANCE_APPLIED_V1").length, 0);
});
