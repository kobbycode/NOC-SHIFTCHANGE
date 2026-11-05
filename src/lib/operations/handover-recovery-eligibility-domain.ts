// Phase 8C.3 — pure recovery-eligibility classification and evidence digest.
//
// No I/O, no clock, no persistence. The caller supplies an authoritative read
// model taken inside one read-only transaction; this module only decides what
// that model means and reduces it to a deterministic digest. Nothing here can
// authorize execution: every result carries executionAuthorized: false.

import { createHash } from "node:crypto";

import {
  HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS,
  HANDOVER_RECOVERY_ELIGIBILITY_DETAILS,
  HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA,
  HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION,
  HANDOVER_RECOVERY_ELIGIBILITY_PRECEDENCE,
  HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA,
  HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA_VERSION,
  type HandoverRecoveryEligibilityClassification,
  type HandoverRecoveryEligibilityConclusion,
  type HandoverRecoveryEligibilityDetail,
  type HandoverRecoveryEligibilityDigest,
  type HandoverRecoveryEligibilityReadModel,
  type HandoverRecoveryEligibilityRefusal,
  type HandoverRecoveryEligibilityResult,
} from "@/types/handover-recovery-eligibility";

const CLASSIFICATION = HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS;
const DETAIL = HANDOVER_RECOVERY_ELIGIBILITY_DETAILS;

export const HANDOVER_RECOVERY_ELIGIBILITY_CONCURRENCY_NOTICE =
  "This is a point-in-time read. It is not an execution authorization; any future executor must re-evaluate inside its own transaction.";

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalHandoverRecoveryEligibilityMaterial(value: unknown): string {
  return canonical(value);
}

function refuse(
  refusals: HandoverRecoveryEligibilityRefusal[],
  code: HandoverRecoveryEligibilityClassification,
  detail: HandoverRecoveryEligibilityDetail,
  message: string,
): void {
  if (refusals.some((entry) => entry.code === code && entry.detail === detail)) return;
  refusals.push({ code, detail, message });
}

function conclude(
  refusals: HandoverRecoveryEligibilityRefusal[],
): HandoverRecoveryEligibilityConclusion {
  const primary = HANDOVER_RECOVERY_ELIGIBILITY_PRECEDENCE.find((code) =>
    refusals.some((entry) => entry.code === code),
  );
  if (!primary) {
    return {
      classification: CLASSIFICATION.ELIGIBLE_FOR_ABANDONMENT_REVIEW,
      reason:
        "Every authoritative precondition holds: the committed handover has no acceptance, its guard and slot bindings are intact, and the activation window has closed on the server clock. This supports consideration of abandonment only.",
      refusals: [],
    };
  }
  const first = refusals.find((entry) => entry.code === primary);
  return {
    classification: primary,
    reason: first?.message ?? "The handover is not eligible for abandonment review.",
    refusals,
  };
}

/**
 * Classify one authoritative read model. Every applicable refusal is reported;
 * the primary classification is the highest-precedence entry.
 */
export function classifyHandoverRecoveryEligibility(
  model: HandoverRecoveryEligibilityReadModel,
): HandoverRecoveryEligibilityConclusion {
  const refusals: HandoverRecoveryEligibilityRefusal[] = [];

  if (!model.kindSetComplete) {
    refuse(
      refusals,
      CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
      DETAIL.KIND_SET_UNVERIFIED,
      "The complete set of incoming-acceptance evidence kinds cannot be proven for this build, so no acceptance absence can be established.",
    );
  }

  const aggregate = model.aggregate;
  if (!aggregate.present) {
    refuse(
      refusals,
      CLASSIFICATION.HANDOVER_NOT_APPLICABLE,
      DETAIL.HANDOVER_NOT_FOUND,
      "No equal-handover v2 aggregate exists for this document.",
    );
    return conclude(refusals);
  }
  if (aggregate.unreadable || aggregate.identity === null || aggregate.reservation === null) {
    refuse(
      refusals,
      CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
      DETAIL.AGGREGATE_UNREADABLE,
      "The handover aggregate cannot be validated, so its bindings cannot be trusted.",
    );
    return conclude(refusals);
  }

  const identity = aggregate.identity;
  const reservation = aggregate.reservation;

  if (aggregate.lifecycleStatus === "completed") {
    refuse(
      refusals,
      CLASSIFICATION.ACCEPTANCE_EXISTS,
      DETAIL.AGGREGATE_COMPLETED,
      "The handover aggregate is completed, which only an incoming acceptance can produce.",
    );
  } else if (aggregate.lifecycleStatus === "cancelled") {
    refuse(
      refusals,
      CLASSIFICATION.HANDOVER_NOT_APPLICABLE,
      DETAIL.AGGREGATE_TERMINAL,
      "The handover aggregate is already cancelled; abandonment has nothing left to release.",
    );
    return conclude(refusals);
  } else if (aggregate.lifecycleStatus !== "awaiting_incoming_acceptance") {
    refuse(
      refusals,
      CLASSIFICATION.HANDOVER_NOT_APPLICABLE,
      DETAIL.AGGREGATE_NOT_COMMITTED,
      `The handover is in lifecycle "${aggregate.lifecycleStatus ?? "unknown"}"; only a committed, awaiting-acceptance handover can be considered.`,
    );
    return conclude(refusals);
  }

  if (aggregate.reportBinding === null || !aggregate.reportBinding.present) {
    refuse(
      refusals,
      CLASSIFICATION.INCONSISTENT_EVIDENCE,
      DETAIL.REPORT_BINDING_MISSING,
      "An awaiting-acceptance handover has no frozen report binding; the committed state is inconsistent.",
    );
  }

  if (!model.commitReceipt.present) {
    refuse(
      refusals,
      CLASSIFICATION.INCONSISTENT_EVIDENCE,
      DETAIL.COMMIT_RECEIPT_MISSING,
      "The deterministic outgoing commit receipt is missing, so the handover is not provably committed.",
    );
  } else if (!model.commitReceipt.valid) {
    refuse(
      refusals,
      CLASSIFICATION.INCONSISTENT_EVIDENCE,
      DETAIL.COMMIT_RECEIPT_INVALID,
      "The outgoing commit receipt does not validate against the current aggregate.",
    );
  }

  if (!model.report.present || !model.report.verified) {
    refuse(
      refusals,
      CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
      DETAIL.REPORT_UNREADABLE,
      "The frozen handover report bound to this aggregate cannot be read and verified.",
    );
  }

  const guard = model.guard;
  if (model.guardHistory.unreadable) {
    refuse(
      refusals,
      CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
      DETAIL.GUARD_HISTORY_UNREADABLE,
      "Archived reservation-guard evidence exists but cannot be validated, so the current guard revision cannot be proven.",
    );
  }
  if (!guard.present) {
    refuse(
      refusals,
      CLASSIFICATION.GUARD_BINDING_CONFLICT,
      DETAIL.GUARD_MISSING,
      "No reservation guard exists for this outgoing shift.",
    );
  } else if (guard.unreadable) {
    refuse(
      refusals,
      CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
      DETAIL.GUARD_UNREADABLE,
      "The reservation guard cannot be validated.",
    );
  } else {
    if (guard.protocolOwner !== "v2") {
      refuse(
        refusals,
        CLASSIFICATION.GUARD_BINDING_CONFLICT,
        DETAIL.GUARD_NOT_V2,
        `The reservation guard is owned by protocol "${guard.protocolOwner ?? "unknown"}".`,
      );
    }
    if (guard.ownerHandoverDocumentId !== model.handoverDocumentId) {
      refuse(
        refusals,
        CLASSIFICATION.GUARD_BINDING_CONFLICT,
        DETAIL.GUARD_OWNER_MISMATCH,
        "The reservation guard belongs to a different handover document.",
      );
    }
    if (
      guard.reservationId !== reservation.handoverId ||
      guard.reservedIncomingShiftId !== identity.incomingShiftId
    ) {
      refuse(
        refusals,
        CLASSIFICATION.GUARD_BINDING_CONFLICT,
        DETAIL.GUARD_RESERVATION_MISMATCH,
        "The reservation guard no longer binds this reservation and incoming shift.",
      );
    }
    if (
      guard.outgoingSlotToken !== identity.outgoingSlotToken ||
      guard.outgoingGeneration !== identity.outgoingGeneration ||
      guard.successorSlotToken !== identity.successorSlotToken ||
      guard.successorGeneration !== identity.successorGeneration
    ) {
      refuse(
        refusals,
        CLASSIFICATION.GUARD_BINDING_CONFLICT,
        DETAIL.GUARD_TOKEN_MISMATCH,
        "The reservation guard carries a different slot token or generation lineage.",
      );
    }
    if (
      aggregate.reportBinding !== null &&
      aggregate.reportBinding.present &&
      aggregate.reportBinding.fencingEpoch !== null &&
      guard.fencingEpoch !== null &&
      aggregate.reportBinding.fencingEpoch !== guard.fencingEpoch
    ) {
      refuse(
        refusals,
        CLASSIFICATION.GUARD_BINDING_CONFLICT,
        DETAIL.GUARD_EPOCH_MISMATCH,
        "The reservation guard fencing epoch no longer matches the epoch the report was frozen at.",
      );
    }
    const revisionMismatch = model.guardHistory.entries.some(
      (entry) =>
        entry.id === guard.id ||
        (guard.guardRevision !== null && entry.guardRevision >= guard.guardRevision) ||
        (guard.fencingEpoch !== null && entry.fencingEpoch > guard.fencingEpoch),
    );
    if (revisionMismatch) {
      refuse(
        refusals,
        CLASSIFICATION.GUARD_BINDING_CONFLICT,
        DETAIL.GUARD_REVISION_MISMATCH,
        "The live reservation guard revision is not ahead of its archived history.",
      );
    }
    if (guard.ownerLifecycleState === "cancelled" || guard.ownerLifecycleState === "completed") {
      refuse(
        refusals,
        CLASSIFICATION.INCONSISTENT_EVIDENCE,
        DETAIL.GUARD_TERMINAL_AGGREGATE_OPEN,
        `The reservation guard is "${guard.ownerLifecycleState}" while the aggregate still awaits acceptance.`,
      );
    } else if (
      guard.ownerLifecycleState !== "active" ||
      // A re-acquired guard is active but records its cancelled predecessor's
      // archive as terminal evidence. Any other terminal reference on an active
      // guard is unexplained and must be refused.
      (guard.terminalEvidenceRef !== null &&
        !model.guardHistory.entries.some((entry) => entry.id === guard.terminalEvidenceRef))
    ) {
      refuse(
        refusals,
        CLASSIFICATION.GUARD_BINDING_CONFLICT,
        DETAIL.GUARD_LIFECYCLE_NOT_ACTIVE,
        "The reservation guard is not active, or it carries terminal evidence that is not a validated archived predecessor.",
      );
    }
  }

  if (
    model.legacyHandover.present &&
    (model.legacyHandover.lifecycleStatus === "collecting_confirmations" ||
      model.legacyHandover.lifecycleStatus === null)
  ) {
    refuse(
      refusals,
      CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
      DETAIL.LEGACY_RESERVATION_AMBIGUOUS,
      "A legacy reservation record exists for the same outgoing shift without a readable lifecycle, so the identity model is ambiguous.",
    );
  }

  const outgoing = model.outgoingShift;
  if (!outgoing.present || outgoing.unreadable) {
    refuse(
      refusals,
      CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
      DETAIL.OUTGOING_SHIFT_UNREADABLE,
      "The outgoing shift record is missing or cannot be validated.",
    );
  } else if (outgoing.actualEnd !== null || outgoing.status === "completed") {
    refuse(
      refusals,
      CLASSIFICATION.ACCEPTANCE_EXISTS,
      DETAIL.OUTGOING_SHIFT_COMPLETED,
      "The outgoing shift is closed, which only the incoming acceptance path performs.",
    );
  } else if (
    outgoing.status !== "handover_pending" ||
    outgoing.actualStart === null ||
    outgoing.handoverStartedAt === null ||
    Date.parse(outgoing.handoverStartedAt) < Date.parse(outgoing.actualStart)
  ) {
    refuse(
      refusals,
      CLASSIFICATION.INCONSISTENT_EVIDENCE,
      DETAIL.OUTGOING_SHIFT_STATUS_MISMATCH,
      "The outgoing shift is not in the started, handover-pending state an acceptance would have required.",
    );
  } else if (
    outgoing.permanentPairId !== identity.outgoingPermanentPairId ||
    outgoing.primaryTechnicianIds.join(",") !== identity.outgoingTechnicianIds.join(",")
  ) {
    refuse(
      refusals,
      CLASSIFICATION.INCONSISTENT_EVIDENCE,
      DETAIL.OUTGOING_SHIFT_BINDING_MISMATCH,
      "The outgoing shift pair or technicians differ from the reserved handover identity.",
    );
  }

  const slot = model.slot;
  if (!slot.present) {
    refuse(
      refusals,
      CLASSIFICATION.SLOT_BINDING_CONFLICT,
      DETAIL.SLOT_MISSING,
      "The global operational slot document is missing.",
    );
  } else if (slot.unreadable) {
    refuse(
      refusals,
      CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
      DETAIL.SLOT_UNREADABLE,
      "The global operational slot cannot be validated.",
    );
  } else {
    if (slot.shiftId !== identity.outgoingShiftId) {
      refuse(
        refusals,
        CLASSIFICATION.SLOT_BINDING_CONFLICT,
        DETAIL.SLOT_NOT_OWNED,
        "The global slot belongs to a different shift.",
      );
    }
    if (slot.slotStatus !== "consumed") {
      refuse(
        refusals,
        CLASSIFICATION.SLOT_BINDING_CONFLICT,
        DETAIL.SLOT_STATUS_MISMATCH,
        `The global slot status is "${slot.slotStatus ?? "unknown"}", not "consumed".`,
      );
    }
    if (slot.shiftStatus !== "handover_pending") {
      refuse(
        refusals,
        CLASSIFICATION.SLOT_BINDING_CONFLICT,
        DETAIL.SLOT_SHIFT_STATUS_MISMATCH,
        `The global slot records shift status "${slot.shiftStatus ?? "unknown"}", not "handover_pending".`,
      );
    }
    if (slot.slotToken !== identity.outgoingSlotToken) {
      refuse(
        refusals,
        CLASSIFICATION.SLOT_BINDING_CONFLICT,
        DETAIL.SLOT_TOKEN_MISMATCH,
        "The global slot token is not the token reserved by this handover.",
      );
    }
    if (slot.generation !== identity.outgoingGeneration) {
      refuse(
        refusals,
        CLASSIFICATION.SLOT_BINDING_CONFLICT,
        DETAIL.SLOT_GENERATION_MISMATCH,
        "The global slot generation is not the generation reserved by this handover.",
      );
    }
  }

  if (model.incomingShift.present) {
    refuse(
      refusals,
      CLASSIFICATION.ACCEPTANCE_EXISTS,
      DETAIL.INCOMING_SHIFT_ACTIVATED,
      "The incoming shift exists, and only a committed first activation creates it.",
    );
  }

  if (model.activationReceipt.present) {
    if (model.activationReceipt.valid) {
      refuse(
        refusals,
        CLASSIFICATION.ACCEPTANCE_EXISTS,
        DETAIL.ACTIVATION_RECEIPT_VALID,
        "The deterministic activation receipt exists and validates: an acceptance committed.",
      );
    } else {
      refuse(
        refusals,
        CLASSIFICATION.INCONSISTENT_EVIDENCE,
        DETAIL.ACTIVATION_RECEIPT_INVALID,
        "An activation receipt exists at the deterministic id but does not validate.",
      );
    }
  }

  let acceptanceProven = refusals.some(
    (entry) => entry.code === CLASSIFICATION.ACCEPTANCE_EXISTS,
  );

  for (const application of model.applications) {
    if (application.unreadable) {
      refuse(
        refusals,
        CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
        DETAIL.APPLICATION_UNREADABLE,
        `The application receipt for technician ${application.technicianUid} cannot be validated.`,
      );
      continue;
    }
    if (application.present) {
      if (!application.auditPresent) {
        refuse(
          refusals,
          CLASSIFICATION.INCONSISTENT_EVIDENCE,
          DETAIL.APPLICATION_WITHOUT_AUDIT,
          `Technician ${application.technicianUid} has an application receipt without its audit record.`,
        );
        continue;
      }
      refuse(
        refusals,
        CLASSIFICATION.ACCEPTANCE_EXISTS,
        DETAIL.APPLICATION_RECEIPT_VALID,
        `Technician ${application.technicianUid} has an applied acceptance receipt.`,
      );
      acceptanceProven = true;
    } else if (application.auditPresent) {
      refuse(
        refusals,
        CLASSIFICATION.INCONSISTENT_EVIDENCE,
        DETAIL.AUDIT_WITHOUT_APPLICATION,
        `Technician ${application.technicianUid} has an acceptance audit record without its application receipt.`,
      );
    }
  }

  if (!acceptanceProven) {
    for (const membership of model.memberships) {
      if (membership.present) {
        refuse(
          refusals,
          CLASSIFICATION.INCONSISTENT_EVIDENCE,
          DETAIL.MEMBERSHIP_WITHOUT_RECEIPT,
          `Incoming membership ${membership.id} exists although no acceptance receipt does.`,
        );
      }
    }
    for (const attendance of model.attendance) {
      if (attendance.present) {
        refuse(
          refusals,
          CLASSIFICATION.INCONSISTENT_EVIDENCE,
          DETAIL.ATTENDANCE_WITHOUT_RECEIPT,
          `Incoming attendance ${attendance.id} exists although no acceptance receipt does.`,
        );
      }
    }
  }

  for (const evidence of model.evidence) {
    if (evidence.unreadable) {
      refuse(
        refusals,
        CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
        DETAIL.EVIDENCE_UNREADABLE,
        `Personal incoming evidence ${evidence.id} for technician ${evidence.technicianUid} cannot be validated.`,
      );
      continue;
    }
    if (evidence.operationPresent && evidence.legacyOperationPresent) {
      refuse(
        refusals,
        CLASSIFICATION.INCONSISTENT_EVIDENCE,
        DETAIL.DUPLICATE_EVIDENCE_OPERATIONS,
        `Technician ${evidence.technicianUid} has both atomic and legacy acceptance operations for evidence ${evidence.id}.`,
      );
      continue;
    }
    const pendingOperationId =
      evidence.operationStatus === "pending"
        ? evidence.operationId
        : evidence.legacyOperationStatus === "pending"
          ? evidence.legacyOperationId
          : null;
    if (pendingOperationId !== null) {
      refuse(
        refusals,
        CLASSIFICATION.ACCEPTANCE_OUTCOME_UNCERTAIN,
        DETAIL.OPERATION_PENDING,
        `Evidence operation ${pendingOperationId} for technician ${evidence.technicianUid} is still pending.`,
      );
      continue;
    }
    const interruptedOperationId = evidence.operationInterrupted
      ? evidence.operationId
      : evidence.legacyOperationInterrupted
        ? evidence.legacyOperationId
        : null;
    if (interruptedOperationId !== null) {
      refuse(
        refusals,
        CLASSIFICATION.ACCEPTANCE_OUTCOME_UNCERTAIN,
        DETAIL.OPERATION_INTERRUPTED,
        `Evidence operation ${interruptedOperationId} for technician ${evidence.technicianUid} was interrupted during finalization.`,
      );
      continue;
    }
    if (evidence.present && !acceptanceProven) {
      refuse(
        refusals,
        CLASSIFICATION.ACCEPTANCE_OUTCOME_UNCERTAIN,
        DETAIL.EVIDENCE_WITHOUT_RECEIPT,
        `Personal incoming evidence ${evidence.id} exists without any acceptance receipt.`,
      );
    }
    // A finalized operation is itself an assertion that an authoritative
    // evidence document exists. If that document is absent the slot is
    // contradictory, and "no evidence" cannot be read as "no acceptance
    // attempt". An aborted operation is deliberately excluded: the coordinator
    // abort contract terminates the attempt precisely because no evidence may
    // exist, so the abort record is that attempt's authoritative evidence.
    if (!evidence.present) {
      const orphanOperationId =
        evidence.operationStatus === "finalized"
          ? evidence.operationId
          : evidence.legacyOperationStatus === "finalized"
            ? evidence.legacyOperationId
            : null;
      if (orphanOperationId !== null) {
        refuse(
          refusals,
          CLASSIFICATION.INCONSISTENT_EVIDENCE,
          DETAIL.OPERATION_WITHOUT_EVIDENCE,
          `Attendance operation ${orphanOperationId} is finalized but personal incoming evidence ${evidence.id} for technician ${evidence.technicianUid} is missing; the absence of acceptance cannot be claimed.`,
        );
      }
    }
  }

  for (const reconciliation of model.reconciliation) {
    switch (reconciliation.status) {
      case "APPLIED_VALIDATED":
        refuse(
          refusals,
          CLASSIFICATION.ACCEPTANCE_EXISTS,
          DETAIL.APPLICATION_RECEIPT_VALID,
          `Reconciliation reports an applied acceptance for technician ${reconciliation.technicianUid}.`,
        );
        break;
      case "EVIDENCE_ONLY":
        refuse(
          refusals,
          CLASSIFICATION.ACCEPTANCE_OUTCOME_UNCERTAIN,
          DETAIL.EVIDENCE_WITHOUT_RECEIPT,
          `Reconciliation for technician ${reconciliation.technicianUid} reports evidence without an operational application (${reconciliation.reason}).`,
        );
        break;
      case "COMMIT_UNVERIFIABLE":
        refuse(
          refusals,
          CLASSIFICATION.ACCEPTANCE_OUTCOME_UNCERTAIN,
          DETAIL.OPERATION_INTERRUPTED,
          `Reconciliation for technician ${reconciliation.technicianUid} reports an unverifiable commit (${reconciliation.reason}).`,
        );
        break;
      case "INCONSISTENT_HISTORY":
      case "BINDING_CONFLICT":
      case "GUARD_CONFLICT":
      case "ADMIN_REVIEW_REQUIRED":
        refuse(
          refusals,
          CLASSIFICATION.INCONSISTENT_EVIDENCE,
          DETAIL.RECONCILIATION_REQUIRES_REVIEW,
          `Reconciliation for technician ${reconciliation.technicianUid} requires review (${reconciliation.status}/${reconciliation.reason}).`,
        );
        break;
      default:
        break;
    }
  }

  if (model.reviewCase.unreadable) {
    refuse(
      refusals,
      CLASSIFICATION.EVIDENCE_UNVERIFIABLE,
      DETAIL.REVIEW_CASE_UNREADABLE,
      "An administrative review case exists but cannot be validated.",
    );
  }

  if (refusals.length === 0 && !model.activationWindow.closedAtEvaluation) {
    refuse(
      refusals,
      CLASSIFICATION.ACTIVATION_WINDOW_OPEN,
      DETAIL.ACTIVATION_WINDOW_OPEN,
      `The activation window is still open until ${model.activationWindow.latestActivationAt}; abandonment cannot be considered yet.`,
    );
  }

  return conclude(refusals);
}

function digestMaterial(
  model: HandoverRecoveryEligibilityReadModel,
  conclusion: HandoverRecoveryEligibilityConclusion,
): Record<string, unknown> {
  return {
    schema: HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA,
    schemaVersion: HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION,
    handoverDocumentId: model.handoverDocumentId,
    outgoingShiftId: model.outgoingShiftId,
    incomingShiftId: model.incomingShiftId,
    classification: conclusion.classification,
    refusals: conclusion.refusals
      .map((entry) => `${entry.code}:${entry.detail}`)
      .slice()
      .sort(),
    aggregate: {
      present: model.aggregate.present,
      id: model.aggregate.id,
      lifecycleStatus: model.aggregate.lifecycleStatus,
      revision: model.aggregate.revision,
      snapshotHash: model.aggregate.snapshotHash,
      unreadable: model.aggregate.unreadable,
      identity: model.aggregate.identity,
      reservation: model.aggregate.reservation,
      reportBinding: model.aggregate.reportBinding,
    },
    guard: model.guard,
    guardHistory: {
      present: model.guardHistory.present,
      unreadable: model.guardHistory.unreadable,
      entries: model.guardHistory.entries.slice().sort((left, right) => left.id.localeCompare(right.id)),
    },
    legacyHandover: model.legacyHandover,
    outgoingShift: model.outgoingShift,
    slot: model.slot,
    activationWindow: model.activationWindow,
    commitReceipt: model.commitReceipt,
    activationReceipt: model.activationReceipt,
    incomingShift: model.incomingShift,
    applications: model.applications,
    memberships: model.memberships.slice().sort((left, right) => left.id.localeCompare(right.id)),
    attendance: model.attendance.slice().sort((left, right) => left.id.localeCompare(right.id)),
    evidence: model.evidence.slice().sort((left, right) => left.id.localeCompare(right.id)),
    reconciliation: model.reconciliation
      .slice()
      .sort((left, right) => left.technicianUid.localeCompare(right.technicianUid)),
    report: model.report,
    reviewCase: model.reviewCase,
    kindSetComplete: model.kindSetComplete,
  };
}

/**
 * Versioned canonical digest over the complete authoritative read model and the
 * conclusion it produced. Evaluation time and actor identity are deliberately
 * absent, so the same evidence always yields the same digest.
 */
export function createHandoverRecoveryEligibilityDigest(
  model: HandoverRecoveryEligibilityReadModel,
  conclusion: HandoverRecoveryEligibilityConclusion,
): HandoverRecoveryEligibilityDigest {
  const value = createHash("sha256")
    .update(canonical(digestMaterial(model, conclusion)))
    .digest("hex");
  return {
    schema: HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA,
    schemaVersion: HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION,
    algorithm: "sha256",
    value,
  };
}

export function createHandoverRecoveryEligibilityResult(
  model: HandoverRecoveryEligibilityReadModel,
  conclusion: HandoverRecoveryEligibilityConclusion,
  evaluatedAt: string,
): HandoverRecoveryEligibilityResult {
  return {
    schema: HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA,
    schemaVersion: HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA_VERSION,
    evaluatedAt,
    executionAuthorized: false,
    executionAuthority: "none",
    handoverDocumentId: model.handoverDocumentId,
    outgoingShiftId: model.outgoingShiftId,
    incomingShiftId: model.incomingShiftId,
    classification: conclusion.classification,
    reason: conclusion.reason,
    refusals: conclusion.refusals,
    evidenceDigest: createHandoverRecoveryEligibilityDigest(model, conclusion),
    references: {
      guardId: model.guard.id,
      commitReceiptId: model.commitReceipt.id,
      activationReceiptId: model.activationReceipt.id,
      applicationReceiptIds: model.applications.map((entry) => entry.receiptId),
      reviewCaseId: model.reviewCase.id,
      slotGeneration: model.slot.generation,
      scheduledEnd: model.activationWindow.scheduledEnd,
      latestActivationAt: model.activationWindow.latestActivationAt,
    },
    readModelStability: "point_in_time_transaction",
    concurrencyNotice: HANDOVER_RECOVERY_ELIGIBILITY_CONCURRENCY_NOTICE,
  };
}

/**
 * The digest of a read model must never be derivable from caller input alone.
 * Exposed for tests that prove equivalence across evaluation paths.
 */
export function handoverRecoveryEligibilityDigestInput(
  model: HandoverRecoveryEligibilityReadModel,
  conclusion: HandoverRecoveryEligibilityConclusion,
): string {
  return canonical(digestMaterial(model, conclusion));
}
