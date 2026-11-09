/**
 * Phase 8C.4 — pure domain tests for the recovery abandonment transition.
 *
 * Covers the new terminal transition, the create-once identifiers of §6.5, the
 * F-5 approval fence, the refusal mapping of §6.4 and the two contract
 * assumptions A-2 (one activation-receipt derivation) and A-3 (a version 5
 * shaped successor slot token is accepted by the operational control).
 *
 * Uses runInNewContext + ts.transpileModule — no Firebase, no server-only
 * imports, no clock.
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

async function loadPure(relativePath, resolve) {
  const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const loaded = { exports: {} };
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: loaded.exports,
      structuredClone,
      TextEncoder,
      Buffer,
      require(specifier) {
        if (specifier === "node:crypto") return { createHash };
        const hit = resolve(specifier);
        if (hit) return hit;
        throw new Error(`Unexpected pure-domain import: ${specifier}`);
      },
    },
  );
  return loaded.exports;
}

// Loaded in dependency order, exactly as the modules import each other.
const classificationTypes = await loadPure("src/types/handover-recovery-eligibility.ts", () => null);
const reportTypes = await loadPure("src/types/handover-report-v2.ts", () => null);
const handoverTypes = await loadPure("src/types/equal-technician-handover.ts", (specifier) => {
  if (specifier.endsWith("handover-report-v2")) return reportTypes;
  return null;
});
const evidenceTypes = await loadPure("src/types/attendance-evidence.ts", () => null);
const incomingTypes = await loadPure(
  "src/types/incoming-acceptance-application.ts",
  (specifier) => {
    if (specifier.endsWith("types/attendance-evidence")) return evidenceTypes;
    if (specifier.endsWith("types/equal-technician-handover")) return handoverTypes;
    return null;
  },
);
const reportDomain = await loadPure(
  "src/lib/operations/equal-handover-report-domain.ts",
  (specifier) => {
    if (specifier.endsWith("handover-report-v2")) return reportTypes;
    if (specifier.endsWith("equal-technician-handover")) return handoverTypes;
    return null;
  },
);
const domain = await loadPure(
  "src/lib/operations/equal-technician-handover-domain.ts",
  (specifier) => {
    if (specifier.endsWith("equal-technician-handover")) return handoverTypes;
    if (specifier.endsWith("handover-report-v2")) return reportTypes;
    if (specifier.endsWith("equal-handover-report-domain")) return reportDomain;
    if (specifier.endsWith("handover-report")) return {};
    return null;
  },
);
const attendance = await loadPure(
  "src/lib/operations/attendance-evidence-domain.ts",
  (specifier) => {
    if (specifier.endsWith("types/attendance-evidence")) return evidenceTypes;
    if (specifier.endsWith("equal-technician-handover")) return handoverTypes;
    if (specifier.endsWith("equal-technician-handover-domain")) return domain;
    if (specifier.endsWith("equal-handover-report-domain")) return reportDomain;
    if (specifier.endsWith("handover-report-v2")) return reportTypes;
    if (specifier.endsWith("handover-report")) return {};
    return null;
  },
);
const acceptance = await loadPure(
  "src/lib/operations/incoming-acceptance-application-domain.ts",
  (specifier) => {
    if (specifier.endsWith("types/attendance-evidence")) return evidenceTypes;
    if (specifier.endsWith("types/equal-technician-handover")) return handoverTypes;
    if (specifier.endsWith("incoming-acceptance-application")) return incomingTypes;
    if (specifier.endsWith("attendance-evidence-domain")) return attendance;
    if (specifier.endsWith("equal-technician-handover-domain")) return domain;
    return null;
  },
);
const abandonment = await loadPure(
  "src/lib/operations/handover-recovery-abandonment-domain.ts",
  (specifier) => {
    if (specifier.endsWith("handover-recovery-eligibility")) return classificationTypes;
    return null;
  },
);
const control = await loadPure("src/lib/operations/operational-shift-control-state.ts", () => ({}));
const classifications = classificationTypes;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const token1 = "a0000000-0000-4000-8000-000000000001";
const token2 = "a0000000-0000-4000-8000-000000000002";

const at = "2026-10-04T08:00:00.000Z";
const later = "2026-10-04T08:02:00.000Z";
const recoveryAt = "2026-10-04T10:00:00.000Z";
const endAt = "2026-10-04T17:00:00.000Z";

const reservationFingerprint = `handover_v2_${"f".repeat(64)}`;

const reportBinding = {
  schema: "handover-report-v2",
  id: "report_v2_00000000-0000-4000-8000-000000000001",
  digest: "1".repeat(64),
  evidenceSnapshotHash: "e".repeat(64),
  workSnapshotVersion: "3".repeat(64),
  preparationId: `preparation_${reservationFingerprint}`,
  preparationRevision: 1,
  reservationId: reservationFingerprint,
  aggregateRevision: 1,
  fencingEpoch: 1,
  frozenBy: "out-tech-1",
  frozenAt: at,
};

function identity() {
  return {
    schema: "equal-handover-v2",
    outgoingShiftId: "shift-out",
    outgoingPermanentPairId: "pair-out",
    outgoingTechnicianIds: ["out-tech-1", "out-tech-2"],
    outgoingSlotToken: token1,
    outgoingGeneration: 1,
    incomingShiftId: "shift-in",
    incomingPermanentPairId: "pair-in",
    incomingTechnicianIds: ["in-tech-1", "in-tech-2"],
    successorSlotToken: token2,
    successorGeneration: 2,
    shiftType: "morning",
    scheduledStart: at,
    scheduledEnd: endAt,
  };
}

function collectingAggregate() {
  return domain.createEqualHandover({
    identity: identity(),
    reportBinding,
    reservedAt: at,
    reservedBy: "supervisor-1",
  });
}

function context(aggregate, overrides = {}) {
  return {
    revision: aggregate.revision,
    snapshotHash: domain.createEqualHandoverSnapshot(aggregate).snapshotHash,
    recordedAt: later,
    ...overrides,
  };
}

/** The stalled state of the recovery design: committed, awaiting acceptance. */
function awaitingAggregate() {
  let aggregate = collectingAggregate();
  for (const uid of ["out-tech-1", "out-tech-2", "in-tech-1", "in-tech-2"]) {
    aggregate = domain.confirmEqualHandoverParticipant(aggregate, {
      ...context(aggregate),
      actorUid: uid,
      technicianUid: uid,
    });
  }
  aggregate = domain.commitEqualHandoverOutgoingTransfer(aggregate, {
    ...context(aggregate),
    actorUid: "out-tech-1",
  });
  assert.equal(aggregate.lifecycleStatus, "awaiting_incoming_acceptance");
  return aggregate;
}

function abandonInput(aggregate, overrides = {}) {
  return {
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: domain.createEqualHandoverSnapshot(aggregate).snapshotHash,
    expectedLifecycleStatus: aggregate.lifecycleStatus,
    recordedAt: recoveryAt,
    actorUid: "admin-1",
    ...overrides,
  };
}

function canonical(value) {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// 1. The transition itself
// ---------------------------------------------------------------------------

test("1. only a committed, awaiting-acceptance handover can be abandoned", () => {
  const collecting = collectingAggregate();
  assert.throws(
    () =>
      domain.abandonEqualHandover(collecting, {
        ...abandonInput(collecting),
        expectedLifecycleStatus: "awaiting_incoming_acceptance",
      }),
    /not awaiting incoming acceptance|may only abandon/i,
  );

  const awaiting = awaitingAggregate();
  assert.throws(
    () =>
      domain.abandonEqualHandover(awaiting, abandonInput(awaiting, {
        expectedLifecycleStatus: "collecting_confirmations",
      })),
    /may only abandon/i,
  );

  // The existing close transition still refuses this lifecycle (H-4 unchanged).
  assert.throws(
    () =>
      domain.closeEqualHandover(awaiting, {
        ...context(awaiting),
        actorUid: "admin-1",
        status: "cancelled",
      }),
    /Handover lifecycle does not permit mutation/,
  );
});

test("2. abandonment is terminal, advances updatedAt and preserves every other field", () => {
  const awaiting = awaitingAggregate();
  const before = canonical(awaiting);

  const abandoned = domain.abandonEqualHandover(awaiting, abandonInput(awaiting));

  assert.equal(abandoned.lifecycleStatus, "cancelled");
  assert.equal(abandoned.updatedAt, recoveryAt);
  // Confirmations and absences bind to the aggregate revision and to a
  // revision-bearing snapshot, so the revision deliberately does not move.
  assert.equal(abandoned.revision, awaiting.revision);
  assert.deepEqual(abandoned.identity, awaiting.identity);
  assert.deepEqual(abandoned.reservation, awaiting.reservation);
  assert.deepEqual(abandoned.reportBinding, awaiting.reportBinding);
  assert.deepEqual(abandoned.confirmations, awaiting.confirmations);
  assert.deepEqual(abandoned.absences, awaiting.absences);
  assert.deepEqual(abandoned.historicalConfirmations, awaiting.historicalConfirmations);

  // The lifecycle is invisible to the snapshot hash, so the hash alone can never
  // prove this transition (H-3); the explicit lifecycle is what distinguishes it.
  assert.equal(
    domain.createEqualHandoverSnapshot(abandoned).snapshotHash,
    domain.createEqualHandoverSnapshot(awaiting).snapshotHash,
  );

  // Nothing but lifecycle and updatedAt differs.
  const changed = JSON.parse(before);
  delete changed.lifecycleStatus;
  delete changed.updatedAt;
  const after = JSON.parse(JSON.stringify(abandoned));
  delete after.lifecycleStatus;
  delete after.updatedAt;
  assert.equal(canonical(after), canonical(changed));
});

test("3. stale or malformed concurrency evidence is refused", () => {
  const awaiting = awaitingAggregate();

  assert.throws(
    () => domain.abandonEqualHandover(awaiting, abandonInput(awaiting, {
      expectedRevision: awaiting.revision - 1,
    })),
    /Stale handover revision/,
  );
  assert.throws(
    () => domain.abandonEqualHandover(awaiting, abandonInput(awaiting, {
      expectedSnapshotHash: "0".repeat(64),
    })),
    /Stale handover snapshot/,
  );
  assert.throws(
    () => domain.abandonEqualHandover(awaiting, abandonInput(awaiting, {
      recordedAt: at,
    })),
    /Stale recovery timestamp/,
  );
  assert.throws(
    () => domain.abandonEqualHandover(awaiting, abandonInput(awaiting, {
      actorUid: "",
    })),
    /Invalid recovery actor UID/,
  );
});

test("4. a cancelled handover can never be abandoned twice or accepted afterwards", () => {
  const awaiting = awaitingAggregate();
  const abandoned = domain.abandonEqualHandover(awaiting, abandonInput(awaiting));

  assert.throws(
    () => domain.abandonEqualHandover(abandoned, abandonInput(abandoned, {
      expectedLifecycleStatus: "awaiting_incoming_acceptance",
    })),
    /not awaiting incoming acceptance|may only abandon/i,
  );
  assert.throws(
    () => domain.activateEqualHandoverIncomingTransfer(abandoned, {
      revision: abandoned.revision,
      snapshotHash: domain.createEqualHandoverSnapshot(abandoned).snapshotHash,
      recordedAt: recoveryAt,
      actorUid: "in-tech-1",
    }),
    /does not permit incoming acceptance/,
  );
});

// ---------------------------------------------------------------------------
// 2. Create-once identifiers (§6.5)
// ---------------------------------------------------------------------------

const approvalA = `handover_recovery_approval_v2_${"1".repeat(64)}`;
const approvalB = `handover_recovery_approval_v2_${"2".repeat(64)}`;

test("5. the abandonment audit id is deterministic and scoped to the approval", () => {
  const first = abandonment.createHandoverAbandonmentAuditId(approvalA);
  const second = abandonment.createHandoverAbandonmentAuditId(approvalA);
  const other = abandonment.createHandoverAbandonmentAuditId(approvalB);

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^handover_abandonment_v1_[0-9a-f]{64}$/);

  // Pinned vector: the id must not drift, because it is the uniqueness fence
  // that makes recovery once-only.
  assert.equal(
    first,
    "handover_abandonment_v1_" +
      createHash("sha256")
        .update(
          JSON.stringify({
            approvalId: approvalA,
            namespace: "handover-recovery-abandonment-v1",
          }),
        )
        .digest("hex"),
  );
});

test("6. A-3: the successor token is version 5 shaped, deterministic and accepted by the control", () => {
  const token = abandonment.createHandoverAbandonmentSlotToken({
    approvalId: approvalA,
    generation: 2,
  });
  assert.match(
    token,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    token,
    abandonment.createHandoverAbandonmentSlotToken({ approvalId: approvalA, generation: 2 }),
  );
  assert.notEqual(
    token,
    abandonment.createHandoverAbandonmentSlotToken({ approvalId: approvalA, generation: 3 }),
  );
  assert.notEqual(
    token,
    abandonment.createHandoverAbandonmentSlotToken({ approvalId: approvalB, generation: 2 }),
  );

  // A-3: the same value must survive the operational control's own validation.
  const pending = control.createPendingOperationalShiftControl(
    token,
    2,
    recoveryAt,
    token1,
    recoveryAt,
  );
  assert.equal(pending.slotToken, token);
  assert.equal(control.assertOperationalShiftControl(pending).slotToken, token);

  assert.throws(
    () => abandonment.createHandoverAbandonmentSlotToken({ approvalId: approvalA, generation: 0 }),
    /generation is invalid/,
  );
});

// ---------------------------------------------------------------------------
// 3. Refusal vocabulary (§6.4)
// ---------------------------------------------------------------------------

test("7. every eligibility classification maps to one recovery refusal", () => {
  const C = classifications.HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS;
  const R = abandonment.HANDOVER_RECOVERY_ABANDONMENT_REFUSALS;

  assert.equal(abandonment.refusalForAbandonmentClassification(C.ELIGIBLE_FOR_ABANDONMENT_REVIEW), null);
  assert.equal(abandonment.refusalForAbandonmentClassification(C.ACTIVATION_WINDOW_OPEN), R.WINDOW_OPEN);
  assert.equal(abandonment.refusalForAbandonmentClassification(C.ACCEPTANCE_EXISTS), R.ACCEPTANCE_EXISTS);
  assert.equal(
    abandonment.refusalForAbandonmentClassification(C.ACCEPTANCE_OUTCOME_UNCERTAIN),
    R.ACCEPTANCE_EXISTS,
  );
  assert.equal(abandonment.refusalForAbandonmentClassification(C.INCONSISTENT_EVIDENCE), R.STATE_INCONSISTENT);
  assert.equal(abandonment.refusalForAbandonmentClassification(C.GUARD_BINDING_CONFLICT), R.STATE_INCONSISTENT);
  assert.equal(abandonment.refusalForAbandonmentClassification(C.EVIDENCE_UNVERIFIABLE), R.STATE_INCONSISTENT);
  assert.equal(abandonment.refusalForAbandonmentClassification(C.SLOT_BINDING_CONFLICT), R.STALE_OR_APPLIED);
  assert.equal(abandonment.refusalForAbandonmentClassification(C.HANDOVER_NOT_APPLICABLE), R.NOT_APPLICABLE);

  // Exhaustiveness: every declared classification is handled above.
  const declared = Object.values(C).sort();
  assert.deepEqual(declared, [
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

// ---------------------------------------------------------------------------
// 4. Approval fence (F-5)
// ---------------------------------------------------------------------------

function approvalState(overrides = {}) {
  return {
    intentFingerprint: "f".repeat(64),
    recomputedIntentFingerprint: "f".repeat(64),
    storedStatus: "fully_approved",
    voidedAt: null,
    consumedAt: null,
    expiresAt: "2026-10-05T10:00:00.000Z",
    approvals: [
      { actorUid: "supervisor-1", actorRole: "supervisor", proofFingerprint: "a".repeat(64) },
      { actorUid: "admin-1", actorRole: "admin", proofFingerprint: "b".repeat(64) },
    ],
    ...overrides,
  };
}

test("8. the approval fence accepts one fresh dual signature and refuses every stale shape", () => {
  const fence = abandonment.evaluateHandoverAbandonmentApprovalFence;
  assert.equal(fence(approvalState(), recoveryAt), null);

  const code = (state, now = recoveryAt) => {
    const error = fence(state, now);
    assert.ok(error, "expected a refusal");
    return error.code;
  };
  const R = abandonment.HANDOVER_RECOVERY_ABANDONMENT_REFUSALS;

  assert.equal(code(approvalState({ recomputedIntentFingerprint: "e".repeat(64) })), R.APPROVAL_STALE);
  assert.equal(code(approvalState({ voidedAt: recoveryAt })), R.APPROVAL_INVALID);
  assert.equal(code(approvalState({ consumedAt: recoveryAt })), R.ALREADY_APPLIED);
  assert.equal(code(approvalState({ storedStatus: "awaiting_second_approval" })), R.APPROVAL_INVALID);
  assert.equal(
    code(approvalState(), "2026-10-05T10:00:00.000Z"),
    R.APPROVAL_EXPIRED,
  );
  assert.equal(
    code(
      approvalState({
        approvals: [
          { actorUid: "supervisor-1", actorRole: "supervisor", proofFingerprint: "a".repeat(64) },
          { actorUid: "admin-1", actorRole: "admin", proofFingerprint: "b".repeat(64) },
          { actorUid: "admin-2", actorRole: "admin", proofFingerprint: "c".repeat(64) },
        ],
      }),
    ),
    R.APPROVAL_INVALID,
  );
  assert.equal(
    code(
      approvalState({
        approvals: [
          { actorUid: "same", actorRole: "supervisor", proofFingerprint: "a".repeat(64) },
          { actorUid: "same", actorRole: "admin", proofFingerprint: "b".repeat(64) },
        ],
      }),
    ),
    R.APPROVAL_INVALID,
  );
  assert.equal(
    code(
      approvalState({
        approvals: [
          { actorUid: "supervisor-1", actorRole: "supervisor", proofFingerprint: "a".repeat(64) },
          { actorUid: "admin-1", actorRole: "admin", proofFingerprint: "a".repeat(64) },
        ],
      }),
    ),
    R.APPROVAL_INVALID,
  );
  assert.equal(
    code(
      approvalState({
        approvals: [
          { actorUid: "supervisor-1", actorRole: "supervisor", proofFingerprint: "a".repeat(64) },
          { actorUid: "supervisor-2", actorRole: "supervisor", proofFingerprint: "b".repeat(64) },
        ],
      }),
    ),
    R.APPROVAL_INVALID,
  );
});

test("9. every refusal carries its HTTP status and the not-committed marker", () => {
  const error = abandonment.evaluateHandoverAbandonmentApprovalFence(
    approvalState({ consumedAt: recoveryAt }),
    recoveryAt,
  );
  assert.equal(error.status, 409);
  assert.equal(error.notCommitted, true);
  assert.equal(error.name, "HandoverRecoveryAbandonmentError");

  // An unknown outcome is the one refusal that may describe a commit, so it
  // must never advertise that nothing was written.
  const unknown = new abandonment.HandoverRecoveryAbandonmentError(
    abandonment.HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.OUTCOME_UNKNOWN,
    "unknown",
    503,
  );
  assert.equal(unknown.notCommitted, false);
});

// ---------------------------------------------------------------------------
// 5. A-2: one activation-receipt derivation for both writers
// ---------------------------------------------------------------------------

test("10. A-2: the activation anchor id is pinned to one derivation", () => {
  const documentId = `handover_v2_${"a".repeat(64)}`;
  assert.equal(
    acceptance.createIncomingAcceptanceActivationReceiptId(documentId),
    "handover-activation-v2-deb16d7f786254d768914250505f63ed281a9e81a3393c0670842db639f03c85",
  );
});
