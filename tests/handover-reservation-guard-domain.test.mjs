/**
 * Pure domain tests for the handover reservation guard.
 * Uses runInNewContext + ts.transpileModule — no Firebase, no server-only imports.
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Module loader helpers
// ---------------------------------------------------------------------------

async function loadModule(relPath, requireMap = {}) {
  const source = await readFile(new URL(relPath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  runInNewContext(compiled, {
    exports: mod.exports,
    structuredClone,
    require(specifier) {
      if (specifier === "node:crypto") return { createHash };
      for (const [key, val] of Object.entries(requireMap)) {
        if (specifier === key || specifier.endsWith(key.replace(/^@\//, "").replace(/\//g, "/"))) {
          return val;
        }
      }
      throw new Error(`Unexpected module import in pure domain test: ${specifier}`);
    },
  });
  return mod.exports;
}

// ---------------------------------------------------------------------------
// Load modules under test
// ---------------------------------------------------------------------------

const domain = await loadModule("../src/lib/operations/handover-reservation-guard-domain.ts", {
  "node:crypto": { createHash },
  "@/types/handover-reservation-guard": {},
  "@/types/handover": {},
});

const {
  HANDOVER_RESERVATION_GUARD_SCHEMA,
  HANDOVER_PROTOCOL_OWNERS,
  GUARD_LIFECYCLE_STATES,
  HandoverReservationGuardError,
  createHandoverReservationGuardDocumentId,
  assertHandoverReservationGuard,
  createInitialReservationGuard,
  assertSameOwnerRetry,
  transitionGuardForReplacement,
  transitionGuardForCancellation,
  transitionGuardForCompletion,
  adoptGuardlessLegacyReservation,
} = domain;

// ---------------------------------------------------------------------------
// Canonical fixtures
// ---------------------------------------------------------------------------

const tokenA = "a0000000-0000-4000-8000-000000000001";
const tokenB = "a0000000-0000-4000-8000-000000000002";
const tokenC = "a0000000-0000-4000-8000-000000000003";

const reservedAt = "2026-10-04T08:00:00.000Z";
const laterAt    = "2026-10-04T09:00:00.000Z";

function baseAcquireInput(overrides = {}) {
  return {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    ownerHandoverDocumentId: "handover_shift-out-001",
    outgoingSlotToken: tokenA,
    outgoingGeneration: 1,
    successorSlotToken: tokenB,
    successorGeneration: 2,
    reservationId: "res-001",
    reservedIncomingShiftId: "shift-in-001",
    reservedAt,
    reservedBy: "uid-supervisor-1",
    ...overrides,
  };
}

function initialGuard(overrides = {}) {
  return createInitialReservationGuard(baseAcquireInput(overrides));
}

// ---------------------------------------------------------------------------
// 1. Deterministic guard document ID
// ---------------------------------------------------------------------------

test("1. deterministic guard ID for safe Firestore identifiers", () => {
  // Simple alphanumeric IDs become guard_<id>
  const id1 = createHandoverReservationGuardDocumentId("shift-001");
  assert.equal(id1, "guard_shift-001");

  // Calling twice produces the same result
  const id2 = createHandoverReservationGuardDocumentId("shift-001");
  assert.equal(id1, id2);

  // IDs longer than 128 chars (but still valid identifier chars) trigger SHA-256 hashing
  const longId = "a".repeat(129);
  const id3 = createHandoverReservationGuardDocumentId(longId);
  assert.match(id3, /^guard_[0-9a-f]{32}$/);
  // Deterministic across calls
  const id4 = createHandoverReservationGuardDocumentId(longId);
  assert.equal(id3, id4);

  // Different IDs must not collide
  const id5 = createHandoverReservationGuardDocumentId("shift-002");
  assert.notEqual(id1, id5);
});

test("1b. guard ID validation rejects empty, whitespace, and invalid identifiers", () => {
  assert.throws(() => createHandoverReservationGuardDocumentId(""), /Invalid outgoing shift ID/);
  assert.throws(() => createHandoverReservationGuardDocumentId("  "), /Invalid outgoing shift ID/);
  assert.throws(() => createHandoverReservationGuardDocumentId("."), /Invalid outgoing shift ID/);
  assert.throws(() => createHandoverReservationGuardDocumentId(".."), /Invalid outgoing shift ID/);
});

// ---------------------------------------------------------------------------
// 2. Initial guard acquisition
// ---------------------------------------------------------------------------

test("2. initial guard acquisition produces a valid active guard", () => {
  const guard = initialGuard();

  assert.equal(guard.schema, HANDOVER_RESERVATION_GUARD_SCHEMA);
  assert.equal(guard.id, createHandoverReservationGuardDocumentId("shift-out-001"));
  assert.equal(guard.outgoingShiftId, "shift-out-001");
  assert.equal(guard.protocolOwner, HANDOVER_PROTOCOL_OWNERS.V1);
  assert.equal(guard.ownerHandoverDocumentId, "handover_shift-out-001");
  assert.equal(guard.ownerLifecycleState, GUARD_LIFECYCLE_STATES.ACTIVE);
  assert.equal(guard.guardRevision, 1);
  assert.equal(guard.fencingEpoch, 1);
  assert.equal(guard.outgoingSlotToken, tokenA.toLowerCase());
  assert.equal(guard.outgoingGeneration, 1);
  assert.equal(guard.successorSlotToken, tokenB.toLowerCase());
  assert.equal(guard.successorGeneration, 2);
  assert.equal(guard.reservationId, "res-001");
  assert.equal(guard.reservedIncomingShiftId, "shift-in-001");
  assert.equal(guard.reservedAt, reservedAt);
  assert.equal(guard.reservedBy, "uid-supervisor-1");
  assert.deepEqual(guard.retiredSuccessorSlotTokens, []);
  assert.ok(guard.terminalEvidenceRef === null || guard.terminalEvidenceRef === undefined);
  assert.equal(guard.createdAt, reservedAt);
  assert.equal(guard.updatedAt, reservedAt);
});

test("2b. initial guard normalizes tokens to lowercase", () => {
  const guard = initialGuard({
    outgoingSlotToken: tokenA.toUpperCase(),
    successorSlotToken: tokenB.toUpperCase(),
  });
  assert.equal(guard.outgoingSlotToken, tokenA.toLowerCase());
  assert.equal(guard.successorSlotToken, tokenB.toLowerCase());
});

test("2c. initial guard rejects invalid inputs", () => {
  // Missing outgoing shift ID
  assert.throws(() => initialGuard({ outgoingShiftId: "" }), /Invalid outgoing shift ID/);
  // Invalid protocol owner
  assert.throws(() => initialGuard({ protocolOwner: "v3" }), /Invalid protocol owner/);
  // Successor generation not outgoing + 1
  assert.throws(() => initialGuard({ successorGeneration: 5 }), /Successor generation must be outgoing generation \+ 1/);
  // Duplicate tokens
  assert.throws(() => initialGuard({ successorSlotToken: tokenA }), /Successor slot token cannot equal outgoing slot token/);
  // Non-UUID token
  assert.throws(() => initialGuard({ outgoingSlotToken: "not-a-uuid" }), /Invalid handover slot token/);
  // Non-positive generation
  assert.throws(() => initialGuard({ outgoingGeneration: 0 }), /Invalid outgoing generation/);
});

// ---------------------------------------------------------------------------
// 3. assertHandoverReservationGuard validates all fields
// ---------------------------------------------------------------------------

test("3. assertHandoverReservationGuard rejects malformed inputs", () => {
  // Completely wrong type
  assert.throws(() => assertHandoverReservationGuard(null), /Malformed reservation guard state/);
  assert.throws(() => assertHandoverReservationGuard("string"), /Malformed reservation guard state/);
  assert.throws(() => assertHandoverReservationGuard([]), /Malformed reservation guard state/);

  const valid = initialGuard();

  // Wrong schema
  assert.throws(
    () => assertHandoverReservationGuard({ ...valid, schema: "old-schema" }),
    /Unsupported reservation guard schema/,
  );

  // Mismatched guard ID
  assert.throws(
    () => assertHandoverReservationGuard({ ...valid, id: "guard_wrong" }),
    /Guard ID does not match outgoing shift ID/,
  );

  // Invalid lifecycle state
  assert.throws(
    () => assertHandoverReservationGuard({ ...valid, ownerLifecycleState: "pending" }),
    /Invalid guard lifecycle state/,
  );

  // Successor generation wrong
  assert.throws(
    () => assertHandoverReservationGuard({ ...valid, successorGeneration: valid.outgoingGeneration + 5 }),
    /Invalid successor generation/,
  );

  // Successor token equals outgoing
  assert.throws(
    () => assertHandoverReservationGuard({ ...valid, successorSlotToken: valid.outgoingSlotToken }),
    /Successor token cannot match outgoing slot token/,
  );

  // Contradictory timestamps
  assert.throws(
    () => assertHandoverReservationGuard({ ...valid, updatedAt: "2020-01-01T00:00:00.000Z" }),
    /Contradictory reservation guard timestamps/,
  );
});

test("3b. assertHandoverReservationGuard rejects retired token reuse", () => {
  const valid = initialGuard();
  // Retired token that matches the current outgoing token
  assert.throws(
    () => assertHandoverReservationGuard({
      ...valid,
      retiredSuccessorSlotTokens: [valid.outgoingSlotToken],
    }),
    /Reused or malformed retired successor token/,
  );

  // Retired token that matches the current successor token
  assert.throws(
    () => assertHandoverReservationGuard({
      ...valid,
      retiredSuccessorSlotTokens: [valid.successorSlotToken],
    }),
    /Reused or malformed retired successor token/,
  );

  // Duplicate retired tokens
  assert.throws(
    () => assertHandoverReservationGuard({
      ...valid,
      retiredSuccessorSlotTokens: [tokenC, tokenC],
    }),
    /Reused or malformed retired successor token/,
  );
});

// ---------------------------------------------------------------------------
// 4. Same-owner idempotent retry
// ---------------------------------------------------------------------------

test("4. assertSameOwnerRetry returns the existing guard unchanged when all fields match", () => {
  const guard = initialGuard();
  const retried = assertSameOwnerRetry(guard, baseAcquireInput());
  assert.deepEqual(retried, guard);
});

test("4b. assertSameOwnerRetry rejects terminal guard states", () => {
  const cancelled = transitionGuardForCancellation(initialGuard(), {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 1,
    expectedFencingEpoch: 1,
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });
  assert.throws(
    () => assertSameOwnerRetry(cancelled, baseAcquireInput()),
    /terminal state/,
  );
});

test("4c. assertSameOwnerRetry rejects cross-protocol retry", () => {
  const guard = initialGuard(); // owned by v1
  assert.throws(
    () => assertSameOwnerRetry(guard, baseAcquireInput({ protocolOwner: "v2" })),
    /owned by protocol v1.*Acquisition by protocol v2/s,
  );
});

test("4d. assertSameOwnerRetry rejects conflicting same-protocol identity", () => {
  const guard = initialGuard();
  // Different reservedIncomingShiftId means a different reservation — conflict
  assert.throws(
    () => assertSameOwnerRetry(guard, baseAcquireInput({ reservedIncomingShiftId: "shift-in-DIFFERENT" })),
    /conflicting active reservation guard/,
  );
});

// ---------------------------------------------------------------------------
// 5. Cross-protocol fencing (v1 blocks v2, v2 blocks v1)
// ---------------------------------------------------------------------------

test("5. v1-owned guard blocks v2 same-owner retry", () => {
  const guard = initialGuard({ protocolOwner: "v1" });
  assert.throws(
    () => assertSameOwnerRetry(guard, baseAcquireInput({ protocolOwner: "v2" })),
    /owned by protocol v1/,
  );
});

test("5b. v2-owned guard blocks v1 same-owner retry", () => {
  const guard = initialGuard({ protocolOwner: "v2" });
  assert.throws(
    () => assertSameOwnerRetry(guard, baseAcquireInput({ protocolOwner: "v1" })),
    /owned by protocol v2/,
  );
});

test("5c. cross-protocol replacement is rejected", () => {
  const guard = initialGuard({ protocolOwner: "v1" });
  assert.throws(
    () => transitionGuardForReplacement(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v2", // wrong protocol
      expectedGuardRevision: 1,
      expectedFencingEpoch: 1,
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenC,
      successorGeneration: 2,
      reservationId: "res-002",
      reservedIncomingShiftId: "shift-in-002",
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Cannot replace reservation guard owned by protocol v1 with protocol v2/,
  );
});

test("5d. cross-protocol cancellation is rejected", () => {
  const guard = initialGuard({ protocolOwner: "v1" });
  assert.throws(
    () => transitionGuardForCancellation(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v2",
      expectedGuardRevision: 1,
      expectedFencingEpoch: 1,
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Cannot cancel reservation guard owned by protocol v1 with protocol v2/,
  );
});

// ---------------------------------------------------------------------------
// 6. Stale revision and fencing epoch rejection
// ---------------------------------------------------------------------------

test("6. replacement rejects stale guard revision", () => {
  const guard = initialGuard();
  assert.throws(
    () => transitionGuardForReplacement(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      expectedGuardRevision: 99, // stale
      expectedFencingEpoch: 1,
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenC,
      successorGeneration: 2,
      reservationId: "res-002",
      reservedIncomingShiftId: "shift-in-002",
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Stale guard revision: expected 99, found 1/,
  );
});

test("6b. replacement rejects stale fencing epoch", () => {
  const guard = initialGuard();
  assert.throws(
    () => transitionGuardForReplacement(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      expectedGuardRevision: 1,
      expectedFencingEpoch: 99, // stale
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenC,
      successorGeneration: 2,
      reservationId: "res-002",
      reservedIncomingShiftId: "shift-in-002",
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Stale guard fencing epoch: expected 99, found 1/,
  );
});

test("6c. cancellation rejects stale revision", () => {
  const guard = initialGuard();
  assert.throws(
    () => transitionGuardForCancellation(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      expectedGuardRevision: 99,
      expectedFencingEpoch: 1,
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Stale guard revision/,
  );
});

// ---------------------------------------------------------------------------
// 7. Replacement: lineage preservation and fresh successor token
// ---------------------------------------------------------------------------

test("7. replacement preserves outgoing lineage and retires old successor token", () => {
  const guard = initialGuard();
  const replaced = transitionGuardForReplacement(guard, {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 1,
    expectedFencingEpoch: 1,
    outgoingSlotToken: tokenA, // must match exactly
    outgoingGeneration: 1,     // must match exactly
    successorSlotToken: tokenC, // fresh token
    successorGeneration: 2,
    reservationId: "res-002",
    reservedIncomingShiftId: "shift-in-002",
    recordedAt: laterAt,
    actorUid: "uid-supervisor-2",
  });

  // Outgoing lineage unchanged
  assert.equal(replaced.outgoingShiftId, "shift-out-001");
  assert.equal(replaced.outgoingSlotToken, tokenA.toLowerCase());
  assert.equal(replaced.outgoingGeneration, 1);

  // Successor updated
  assert.equal(replaced.successorSlotToken, tokenC.toLowerCase());
  assert.equal(replaced.successorGeneration, 2);

  // Old successor token retired
  assert.deepEqual(replaced.retiredSuccessorSlotTokens, [tokenB.toLowerCase()]);

  // Guard revision and fencing epoch both incremented
  assert.equal(replaced.guardRevision, 2);
  assert.equal(replaced.fencingEpoch, 2);

  // New reservation identity
  assert.equal(replaced.reservationId, "res-002");
  assert.equal(replaced.reservedIncomingShiftId, "shift-in-002");
  assert.equal(replaced.reservedBy, "uid-supervisor-2");

  // Timestamps
  assert.equal(replaced.updatedAt, laterAt);
  assert.equal(replaced.createdAt, reservedAt); // unchanged
});

test("7b. replacement rejects outgoing lineage mismatch", () => {
  const guard = initialGuard();
  assert.throws(
    () => transitionGuardForReplacement(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      expectedGuardRevision: 1,
      expectedFencingEpoch: 1,
      outgoingSlotToken: tokenB, // WRONG — this is the successor token, not outgoing
      outgoingGeneration: 1,
      successorSlotToken: tokenC,
      successorGeneration: 2,
      reservationId: "res-002",
      reservedIncomingShiftId: "shift-in-002",
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Replacement must retain the current outgoing operational lineage/,
  );
});

test("7c. replacement rejects reuse of current or retired successor token", () => {
  const guard = initialGuard();
  // Reuse of current successor token
  assert.throws(
    () => transitionGuardForReplacement(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      expectedGuardRevision: 1,
      expectedFencingEpoch: 1,
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenB, // same as current successor — not fresh
      successorGeneration: 2,
      reservationId: "res-002",
      reservedIncomingShiftId: "shift-in-002",
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /fresh, unretired successor token/,
  );

  // Reuse of outgoing token
  assert.throws(
    () => transitionGuardForReplacement(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      expectedGuardRevision: 1,
      expectedFencingEpoch: 1,
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenA, // same as outgoing
      successorGeneration: 2,
      reservationId: "res-002",
      reservedIncomingShiftId: "shift-in-002",
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /fresh, unretired successor token/,
  );
});

test("7d. replacement rejects non-active guards", () => {
  const cancelled = transitionGuardForCancellation(initialGuard(), {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 1,
    expectedFencingEpoch: 1,
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });
  assert.throws(
    () => transitionGuardForReplacement(cancelled, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      expectedGuardRevision: 2,
      expectedFencingEpoch: 1,
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenC,
      successorGeneration: 2,
      reservationId: "res-002",
      reservedIncomingShiftId: "shift-in-002",
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Cannot replace a non-active reservation guard/,
  );
});

// ---------------------------------------------------------------------------
// 8. Cancellation transition with terminal evidence reference
// ---------------------------------------------------------------------------

test("8. cancellation transitions to cancelled state with optional evidence ref", () => {
  const guard = initialGuard();
  const cancelled = transitionGuardForCancellation(guard, {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 1,
    expectedFencingEpoch: 1,
    terminalEvidenceRef: "cancellation-doc-001",
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });

  assert.equal(cancelled.ownerLifecycleState, GUARD_LIFECYCLE_STATES.CANCELLED);
  assert.equal(cancelled.guardRevision, 2);
  assert.equal(cancelled.terminalEvidenceRef, "cancellation-doc-001");
  assert.equal(cancelled.updatedAt, laterAt);

  // Fencing epoch unchanged on cancellation (only bumped on replacement)
  assert.equal(cancelled.fencingEpoch, 1);
});

test("8b. cancellation without evidence ref is valid", () => {
  const cancelled = transitionGuardForCancellation(initialGuard(), {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 1,
    expectedFencingEpoch: 1,
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });
  assert.equal(cancelled.ownerLifecycleState, GUARD_LIFECYCLE_STATES.CANCELLED);
  assert.ok(cancelled.terminalEvidenceRef === null || cancelled.terminalEvidenceRef === undefined);
});

test("8c. cancelled guard cannot be cancelled again", () => {
  const cancelled = transitionGuardForCancellation(initialGuard(), {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 1,
    expectedFencingEpoch: 1,
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });
  assert.throws(
    () => transitionGuardForCancellation(cancelled, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      expectedGuardRevision: cancelled.guardRevision,
      expectedFencingEpoch: cancelled.fencingEpoch,
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Cannot cancel a non-active reservation guard/,
  );
});

// ---------------------------------------------------------------------------
// 9. Completion transition with receipt idempotency
// ---------------------------------------------------------------------------

test("9. completion transitions to completed state with terminal evidence", () => {
  const guard = initialGuard();
  const completeInput = {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    receiptId: "transfer-receipt-001",
    outgoingSlotToken: tokenA,
    outgoingGeneration: 1,
    successorSlotToken: tokenB,
    successorGeneration: 2,
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  };
  const completed = transitionGuardForCompletion(guard, completeInput);

  assert.equal(completed.ownerLifecycleState, GUARD_LIFECYCLE_STATES.COMPLETED);
  assert.equal(completed.guardRevision, 2);
  assert.equal(completed.terminalEvidenceRef, "transfer-receipt-001");
  assert.equal(completed.updatedAt, laterAt);
});

test("9b. completion is idempotent: same receipt ID on already-completed guard returns guard unchanged", () => {
  const guard = initialGuard();
  const completeInput = {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    receiptId: "transfer-receipt-001",
    outgoingSlotToken: tokenA,
    outgoingGeneration: 1,
    successorSlotToken: tokenB,
    successorGeneration: 2,
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  };
  const first = transitionGuardForCompletion(guard, completeInput);
  const second = transitionGuardForCompletion(first, completeInput);
  assert.deepEqual(first, second);
});

test("9c. completion rejects different receipt on already-completed guard (silent resurrection prevention)", () => {
  const guard = initialGuard();
  const completed = transitionGuardForCompletion(guard, {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    receiptId: "transfer-receipt-001",
    outgoingSlotToken: tokenA,
    outgoingGeneration: 1,
    successorSlotToken: tokenB,
    successorGeneration: 2,
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });
  assert.throws(
    () => transitionGuardForCompletion(completed, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      receiptId: "DIFFERENT-receipt",
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenB,
      successorGeneration: 2,
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /already completed with a different receipt/,
  );
});

test("9d. completion rejects lineage mismatch", () => {
  const guard = initialGuard();
  assert.throws(
    () => transitionGuardForCompletion(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      receiptId: "transfer-receipt-001",
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenC, // WRONG — not the registered successor
      successorGeneration: 2,
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Transfer completion lineage does not match/,
  );
});

test("9e. completion rejects cancelled guard", () => {
  const cancelled = transitionGuardForCancellation(initialGuard(), {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 1,
    expectedFencingEpoch: 1,
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });
  assert.throws(
    () => transitionGuardForCompletion(cancelled, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      receiptId: "transfer-receipt-001",
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenB,
      successorGeneration: 2,
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /Cannot complete a non-active reservation guard/,
  );
});

// ---------------------------------------------------------------------------
// 10. Guardless legacy adoption
// ---------------------------------------------------------------------------

function buildLegacyAggregate(overrides = {}) {
  return {
    identity: {
      outgoingShiftId: "shift-out-001",
      outgoingPermanentPairId: "pair-out-001",
      outgoingPrimaryTechnicianIds: ["tech-a", "tech-b"],
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      incomingShiftId: "shift-in-001",
      incomingPermanentPairId: "pair-in-001",
      incomingPrimaryTechnicianIds: ["tech-c", "tech-d"],
      successorSlotToken: tokenB,
      successorGeneration: 2,
      shiftType: "morning",
      scheduledStart: reservedAt,
      scheduledEnd: laterAt,
    },
    reservation: {
      handoverId: "res-legacy-001",
      reservedIncomingShiftId: "shift-in-001",
      outgoingShiftId: "shift-out-001",
      incomingPermanentPairId: "pair-in-001",
      incomingPrimaryTechnicianIds: ["tech-c", "tech-d"],
      shiftType: "morning",
      scheduledStart: reservedAt,
      scheduledEnd: laterAt,
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenB,
      expectedSuccessorGeneration: 2,
      revision: 1,
      reservedAt,
      reservedBy: "uid-supervisor-1",
    },
    workSnapshot: { id: "ws-001", version: "1" },
    temporaryAuthorization: null,
    confirmations: [],
    absences: [],
    exceptions: [],
    revision: 1,
    lifecycleStatus: "collecting_confirmations",
    retiredSuccessorSlotTokens: [],
    createdAt: reservedAt,
    updatedAt: reservedAt,
    ...overrides,
  };
}

test("10. guardless legacy adoption for active (collecting_confirmations) handover", () => {
  const legacy = buildLegacyAggregate();
  const adopted = adoptGuardlessLegacyReservation(legacy);

  assert.equal(adopted.schema, HANDOVER_RESERVATION_GUARD_SCHEMA);
  assert.equal(adopted.protocolOwner, HANDOVER_PROTOCOL_OWNERS.V1);
  assert.equal(adopted.ownerLifecycleState, GUARD_LIFECYCLE_STATES.ACTIVE);
  assert.equal(adopted.outgoingShiftId, "shift-out-001");
  assert.equal(adopted.outgoingSlotToken, tokenA.toLowerCase());
  assert.equal(adopted.successorSlotToken, tokenB.toLowerCase());
  assert.equal(adopted.reservationId, "res-legacy-001");
  assert.equal(adopted.reservedIncomingShiftId, "shift-in-001");
  assert.equal(adopted.guardRevision, 1);
  assert.equal(adopted.fencingEpoch, 1);
  assert.ok(adopted.terminalEvidenceRef === null || adopted.terminalEvidenceRef === undefined);
});

test("10b. guardless legacy adoption for completed handover requires receipt ID", () => {
  const completed = buildLegacyAggregate({ lifecycleStatus: "completed" });

  // Without receipt — rejected
  assert.throws(
    () => adoptGuardlessLegacyReservation(completed),
    /Completed legacy handover adoption requires transfer receipt ID/,
  );

  // With receipt — accepted
  const adopted = adoptGuardlessLegacyReservation(completed, "transfer-receipt-legacy-001");
  assert.equal(adopted.ownerLifecycleState, GUARD_LIFECYCLE_STATES.COMPLETED);
  assert.equal(adopted.terminalEvidenceRef, "transfer-receipt-legacy-001");
});

test("10c. guardless legacy adoption for cancelled handover", () => {
  const cancelled = buildLegacyAggregate({ lifecycleStatus: "cancelled" });
  const adopted = adoptGuardlessLegacyReservation(cancelled);
  assert.equal(adopted.ownerLifecycleState, GUARD_LIFECYCLE_STATES.CANCELLED);
});

test("10d. guardless legacy adoption preserves retired successor slot tokens", () => {
  const legacy = buildLegacyAggregate({
    retiredSuccessorSlotTokens: [tokenC],
  });
  const adopted = adoptGuardlessLegacyReservation(legacy);
  assert.deepEqual(adopted.retiredSuccessorSlotTokens, [tokenC.toLowerCase()]);
});

// ---------------------------------------------------------------------------
// 11. Guard constants are correct
// ---------------------------------------------------------------------------

test("11. exported constants have expected values", () => {
  assert.equal(HANDOVER_RESERVATION_GUARD_SCHEMA, "handover-reservation-guard-v1");
  assert.equal(HANDOVER_PROTOCOL_OWNERS.V1, "v1");
  assert.equal(HANDOVER_PROTOCOL_OWNERS.V2, "v2");
  assert.equal(GUARD_LIFECYCLE_STATES.ACTIVE, "active");
  assert.equal(GUARD_LIFECYCLE_STATES.CANCELLED, "cancelled");
  assert.equal(GUARD_LIFECYCLE_STATES.COMPLETED, "completed");
});

test("11b. HandoverReservationGuardError carries correct name and default status", () => {
  const err = new HandoverReservationGuardError("test error");
  assert.equal(err.name, "HandoverReservationGuardError");
  assert.equal(err.message, "test error");
  assert.equal(err.status, 409);
  // Cross-VM-realm: err is not an instance of the outer Error, but has expected error shape
  assert.equal(typeof err.message, "string");
  assert.equal(typeof err.stack, "string");
});

test("11c. HandoverReservationGuardError accepts custom status", () => {
  const err = new HandoverReservationGuardError("not found", 404);
  assert.equal(err.status, 404);
});

// ---------------------------------------------------------------------------
// 12. Multi-replacement chain accumulates retired tokens correctly
// ---------------------------------------------------------------------------

test("12. multi-replacement chain accumulates retired tokens and increments fencing epochs", () => {
  const tokenD = "a0000000-0000-4000-8000-000000000004";
  const tokenE = "a0000000-0000-4000-8000-000000000005";

  let guard = initialGuard(); // outgoing=tokenA, successor=tokenB, rev=1, epoch=1

  // First replacement: tokenB -> tokenC
  guard = transitionGuardForReplacement(guard, {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 1,
    expectedFencingEpoch: 1,
    outgoingSlotToken: tokenA,
    outgoingGeneration: 1,
    successorSlotToken: tokenC,
    successorGeneration: 2,
    reservationId: "res-002",
    reservedIncomingShiftId: "shift-in-002",
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });
  assert.equal(guard.guardRevision, 2);
  assert.equal(guard.fencingEpoch, 2);
  assert.deepEqual(guard.retiredSuccessorSlotTokens, [tokenB.toLowerCase()]);

  // Second replacement: tokenC -> tokenD
  guard = transitionGuardForReplacement(guard, {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 2,
    expectedFencingEpoch: 2,
    outgoingSlotToken: tokenA,
    outgoingGeneration: 1,
    successorSlotToken: tokenD,
    successorGeneration: 2,
    reservationId: "res-003",
    reservedIncomingShiftId: "shift-in-003",
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });
  assert.equal(guard.guardRevision, 3);
  assert.equal(guard.fencingEpoch, 3);
  assert.deepEqual(guard.retiredSuccessorSlotTokens, [tokenB.toLowerCase(), tokenC.toLowerCase()]);

  // Third replacement: tokenD -> tokenE
  guard = transitionGuardForReplacement(guard, {
    outgoingShiftId: "shift-out-001",
    protocolOwner: "v1",
    expectedGuardRevision: 3,
    expectedFencingEpoch: 3,
    outgoingSlotToken: tokenA,
    outgoingGeneration: 1,
    successorSlotToken: tokenE,
    successorGeneration: 2,
    reservationId: "res-004",
    reservedIncomingShiftId: "shift-in-004",
    recordedAt: laterAt,
    actorUid: "uid-supervisor-1",
  });
  assert.equal(guard.guardRevision, 4);
  assert.equal(guard.fencingEpoch, 4);
  assert.deepEqual(guard.retiredSuccessorSlotTokens, [
    tokenB.toLowerCase(),
    tokenC.toLowerCase(),
    tokenD.toLowerCase(),
  ]);

  // Assert using a retired token is blocked
  assert.throws(
    () => transitionGuardForReplacement(guard, {
      outgoingShiftId: "shift-out-001",
      protocolOwner: "v1",
      expectedGuardRevision: 4,
      expectedFencingEpoch: 4,
      outgoingSlotToken: tokenA,
      outgoingGeneration: 1,
      successorSlotToken: tokenC, // tokenC was retired in step 2
      successorGeneration: 2,
      reservationId: "res-005",
      reservedIncomingShiftId: "shift-in-005",
      recordedAt: laterAt,
      actorUid: "uid-supervisor-1",
    }),
    /fresh, unretired successor token/,
  );
});
