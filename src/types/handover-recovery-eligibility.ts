// Phase 8C.3 — authoritative recovery eligibility.
//
// A read-only contract. Nothing here can be written to Firestore, and no value
// here is an execution authorization. `eligible_for_abandonment_review` means
// only that the authoritative record currently supports considering
// abandonment; a future executor must re-evaluate inside its own transaction.

export const HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA = "handover-recovery-eligibility-v1" as const;
export const HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA_VERSION = 1 as const;
export const HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA =
  "handover-recovery-eligibility-evidence" as const;
// Version 2: 8C.4B added the fail-closed orphan-operation rule, so a digest now
// proves it was produced by the corrected classifier. Version 1 digests are not
// reproducible under this build and must never be treated as equivalent.
export const HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION = 2 as const;

export const HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS = {
  ELIGIBLE_FOR_ABANDONMENT_REVIEW: "eligible_for_abandonment_review",
  ACTIVATION_WINDOW_OPEN: "activation_window_open",
  ACCEPTANCE_EXISTS: "acceptance_exists",
  ACCEPTANCE_OUTCOME_UNCERTAIN: "acceptance_outcome_uncertain",
  INCONSISTENT_EVIDENCE: "inconsistent_evidence",
  GUARD_BINDING_CONFLICT: "guard_binding_conflict",
  SLOT_BINDING_CONFLICT: "slot_binding_conflict",
  HANDOVER_NOT_APPLICABLE: "handover_not_applicable",
  EVIDENCE_UNVERIFIABLE: "evidence_unverifiable",
} as const;

export type HandoverRecoveryEligibilityClassification =
  (typeof HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS)[keyof typeof HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS];

export const HANDOVER_RECOVERY_ELIGIBILITY_DETAILS = {
  HANDOVER_NOT_FOUND: "HANDOVER_NOT_FOUND",
  AGGREGATE_UNREADABLE: "AGGREGATE_UNREADABLE",
  AGGREGATE_NOT_COMMITTED: "AGGREGATE_NOT_COMMITTED",
  AGGREGATE_TERMINAL: "AGGREGATE_TERMINAL",
  REPORT_BINDING_MISSING: "REPORT_BINDING_MISSING",
  REPORT_UNREADABLE: "REPORT_UNREADABLE",
  COMMIT_RECEIPT_MISSING: "COMMIT_RECEIPT_MISSING",
  COMMIT_RECEIPT_INVALID: "COMMIT_RECEIPT_INVALID",
  ACTIVATION_RECEIPT_VALID: "ACTIVATION_RECEIPT_VALID",
  ACTIVATION_RECEIPT_INVALID: "ACTIVATION_RECEIPT_INVALID",
  ACTIVATION_RECEIPT_CONFLICT: "ACTIVATION_RECEIPT_CONFLICT",
  APPLICATION_RECEIPT_VALID: "APPLICATION_RECEIPT_VALID",
  AGGREGATE_COMPLETED: "AGGREGATE_COMPLETED",
  INCOMING_SHIFT_ACTIVATED: "INCOMING_SHIFT_ACTIVATED",
  OPERATION_PENDING: "OPERATION_PENDING",
  OPERATION_INTERRUPTED: "OPERATION_INTERRUPTED",
  OPERATION_WITHOUT_EVIDENCE: "OPERATION_WITHOUT_EVIDENCE",
  DUPLICATE_EVIDENCE_OPERATIONS: "DUPLICATE_EVIDENCE_OPERATIONS",
  EVIDENCE_WITHOUT_RECEIPT: "EVIDENCE_WITHOUT_RECEIPT",
  APPLICATION_WITHOUT_AUDIT: "APPLICATION_WITHOUT_AUDIT",
  AUDIT_WITHOUT_APPLICATION: "AUDIT_WITHOUT_APPLICATION",
  INCOMING_SHIFT_WITHOUT_RECEIPT: "INCOMING_SHIFT_WITHOUT_RECEIPT",
  MEMBERSHIP_WITHOUT_RECEIPT: "MEMBERSHIP_WITHOUT_RECEIPT",
  ATTENDANCE_WITHOUT_RECEIPT: "ATTENDANCE_WITHOUT_RECEIPT",
  GUARD_MISSING: "GUARD_MISSING",
  GUARD_UNREADABLE: "GUARD_UNREADABLE",
  GUARD_NOT_V2: "GUARD_NOT_V2",
  GUARD_OWNER_MISMATCH: "GUARD_OWNER_MISMATCH",
  GUARD_RESERVATION_MISMATCH: "GUARD_RESERVATION_MISMATCH",
  GUARD_TOKEN_MISMATCH: "GUARD_TOKEN_MISMATCH",
  GUARD_REVISION_MISMATCH: "GUARD_REVISION_MISMATCH",
  GUARD_EPOCH_MISMATCH: "GUARD_EPOCH_MISMATCH",
  GUARD_HISTORY_UNREADABLE: "GUARD_HISTORY_UNREADABLE",
  GUARD_LIFECYCLE_NOT_ACTIVE: "GUARD_LIFECYCLE_NOT_ACTIVE",
  GUARD_TERMINAL_AGGREGATE_OPEN: "GUARD_TERMINAL_AGGREGATE_OPEN",
  SLOT_MISSING: "SLOT_MISSING",
  SLOT_UNREADABLE: "SLOT_UNREADABLE",
  SLOT_NOT_OWNED: "SLOT_NOT_OWNED",
  SLOT_STATUS_MISMATCH: "SLOT_STATUS_MISMATCH",
  SLOT_SHIFT_STATUS_MISMATCH: "SLOT_SHIFT_STATUS_MISMATCH",
  SLOT_TOKEN_MISMATCH: "SLOT_TOKEN_MISMATCH",
  SLOT_GENERATION_MISMATCH: "SLOT_GENERATION_MISMATCH",
  ACTIVATION_WINDOW_OPEN: "ACTIVATION_WINDOW_OPEN",
  REVIEW_CASE_UNREADABLE: "REVIEW_CASE_UNREADABLE",
  LEGACY_RESERVATION_AMBIGUOUS: "LEGACY_RESERVATION_AMBIGUOUS",
  KIND_SET_UNVERIFIED: "KIND_SET_UNVERIFIED",
  OUTGOING_SHIFT_UNREADABLE: "OUTGOING_SHIFT_UNREADABLE",
  OUTGOING_SHIFT_STATUS_MISMATCH: "OUTGOING_SHIFT_STATUS_MISMATCH",
  OUTGOING_SHIFT_BINDING_MISMATCH: "OUTGOING_SHIFT_BINDING_MISMATCH",
  OUTGOING_SHIFT_COMPLETED: "OUTGOING_SHIFT_COMPLETED",
  APPLICATION_UNREADABLE: "APPLICATION_UNREADABLE",
  EVIDENCE_UNREADABLE: "EVIDENCE_UNREADABLE",
  RECONCILIATION_REQUIRES_REVIEW: "RECONCILIATION_REQUIRES_REVIEW",
} as const;

export type HandoverRecoveryEligibilityDetail =
  (typeof HANDOVER_RECOVERY_ELIGIBILITY_DETAILS)[keyof typeof HANDOVER_RECOVERY_ELIGIBILITY_DETAILS];

// Highest precedence first. The primary classification is the first entry of
// this list that appears among the refusals.
export const HANDOVER_RECOVERY_ELIGIBILITY_PRECEDENCE: readonly HandoverRecoveryEligibilityClassification[] =
  [
    HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.HANDOVER_NOT_APPLICABLE,
    HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.EVIDENCE_UNVERIFIABLE,
    HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.ACCEPTANCE_EXISTS,
    HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.ACCEPTANCE_OUTCOME_UNCERTAIN,
    HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.INCONSISTENT_EVIDENCE,
    HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.GUARD_BINDING_CONFLICT,
    HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.SLOT_BINDING_CONFLICT,
    HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.ACTIVATION_WINDOW_OPEN,
  ];

export interface HandoverRecoveryEligibilityIdentityView {
  outgoingShiftId: string;
  outgoingPermanentPairId: string;
  outgoingTechnicianIds: string[];
  outgoingSlotToken: string;
  outgoingGeneration: number;
  incomingShiftId: string;
  incomingPermanentPairId: string;
  incomingTechnicianIds: string[];
  successorSlotToken: string;
  successorGeneration: number;
  shiftType: string;
  scheduledStart: string;
  scheduledEnd: string;
}

export interface HandoverRecoveryEligibilityReservationView {
  handoverId: string;
  reservedIncomingShiftId: string;
  revision: number;
  outgoingSlotToken: string;
  outgoingGeneration: number;
  successorSlotToken: string;
  expectedSuccessorGeneration: number;
  reservedAt: string;
  reservedBy: string;
}

export interface HandoverRecoveryEligibilityReportBindingView {
  present: boolean;
  id: string | null;
  reportDigest: string | null;
  frozenAt: string | null;
  aggregateRevision: number | null;
  fencingEpoch: number | null;
}

export interface HandoverRecoveryEligibilityAggregateView {
  present: boolean;
  id: string;
  lifecycleStatus: string | null;
  revision: number | null;
  snapshotHash: string | null;
  identity: HandoverRecoveryEligibilityIdentityView | null;
  reservation: HandoverRecoveryEligibilityReservationView | null;
  reportBinding: HandoverRecoveryEligibilityReportBindingView | null;
  unreadable: boolean;
}

export interface HandoverRecoveryEligibilityGuardView {
  present: boolean;
  id: string;
  protocolOwner: string | null;
  ownerHandoverDocumentId: string | null;
  ownerLifecycleState: string | null;
  guardRevision: number | null;
  fencingEpoch: number | null;
  outgoingSlotToken: string | null;
  outgoingGeneration: number | null;
  successorSlotToken: string | null;
  successorGeneration: number | null;
  reservationId: string | null;
  reservedIncomingShiftId: string | null;
  reservedAt: string | null;
  terminalEvidenceRef: string | null;
  unreadable: boolean;
}

export interface HandoverRecoveryEligibilityGuardHistoryEntryView {
  id: string;
  ownerLifecycleState: string;
  guardRevision: number;
  fencingEpoch: number;
  outgoingSlotToken: string;
  terminalEvidenceRef: string | null;
}

export interface HandoverRecoveryEligibilityGuardHistoryView {
  present: boolean;
  unreadable: boolean;
  entries: HandoverRecoveryEligibilityGuardHistoryEntryView[];
}

export interface HandoverRecoveryEligibilityLegacyHandoverView {
  present: boolean;
  id: string;
  lifecycleStatus: string | null;
}

export interface HandoverRecoveryEligibilityShiftView {
  present: boolean;
  id: string;
  status: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  handoverStartedAt: string | null;
  permanentPairId: string | null;
  primaryTechnicianIds: string[];
  unreadable: boolean;
}

export interface HandoverRecoveryEligibilitySlotView {
  present: boolean;
  slotStatus: string | null;
  shiftId: string | null;
  shiftStatus: string | null;
  slotToken: string | null;
  generation: number | null;
  updatedAt: string | null;
  unreadable: boolean;
}

export interface HandoverRecoveryEligibilityWindowView {
  scheduledStart: string;
  scheduledEnd: string;
  latestActivationAt: string;
  closedAtEvaluation: boolean;
}

export interface HandoverRecoveryEligibilityReceiptView {
  present: boolean;
  id: string;
  receiptHash: string | null;
  valid: boolean;
}

export interface HandoverRecoveryEligibilityIncomingShiftView {
  present: boolean;
  id: string;
  status: string | null;
  actualStart: string | null;
}

export interface HandoverRecoveryEligibilityApplicationView {
  technicianUid: string;
  receiptId: string;
  present: boolean;
  receiptHash: string | null;
  outcome: string | null;
  evidenceKind: string | null;
  auditId: string;
  auditPresent: boolean;
  unreadable: boolean;
}

export interface HandoverRecoveryEligibilityMembershipView {
  id: string;
  present: boolean;
  joinedAt: string | null;
  leftAt: string | null;
}

export interface HandoverRecoveryEligibilityAttendanceView {
  id: string;
  present: boolean;
  clockIn: string | null;
  clockOut: string | null;
}

export interface HandoverRecoveryEligibilityEvidenceView {
  id: string;
  technicianUid: string;
  kind: string;
  present: boolean;
  finalizedAt: string | null;
  snapshotHash: string | null;
  guardRevision: number | null;
  fencingEpoch: number | null;
  operationId: string;
  operationPresent: boolean;
  operationStatus: string | null;
  operationInterrupted: boolean;
  // The pre-atomic acceptance writer derives a different evidence event id, so
  // its operation document is a distinct id that must also be read before the
  // absence of an acceptance attempt can be claimed.
  legacyOperationId: string;
  legacyOperationPresent: boolean;
  legacyOperationStatus: string | null;
  legacyOperationInterrupted: boolean;
  requestDigest: string | null;
  unreadable: boolean;
}

export interface HandoverRecoveryEligibilityReconciliationView {
  technicianUid: string;
  status: string;
  reason: string;
}

export interface HandoverRecoveryEligibilityReportView {
  present: boolean;
  id: string | null;
  reportDigest: string | null;
  evidenceSnapshotHash: string | null;
  frozenAt: string | null;
  verified: boolean;
}

export interface HandoverRecoveryEligibilityReviewCaseView {
  present: boolean;
  id: string;
  status: string | null;
  caseRevision: number | null;
  fingerprint: string | null;
  unreadable: boolean;
}

export interface HandoverRecoveryEligibilityReadModel {
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  aggregate: HandoverRecoveryEligibilityAggregateView;
  guard: HandoverRecoveryEligibilityGuardView;
  guardHistory: HandoverRecoveryEligibilityGuardHistoryView;
  legacyHandover: HandoverRecoveryEligibilityLegacyHandoverView;
  outgoingShift: HandoverRecoveryEligibilityShiftView;
  slot: HandoverRecoveryEligibilitySlotView;
  activationWindow: HandoverRecoveryEligibilityWindowView;
  commitReceipt: HandoverRecoveryEligibilityReceiptView;
  activationReceipt: HandoverRecoveryEligibilityReceiptView;
  incomingShift: HandoverRecoveryEligibilityIncomingShiftView;
  applications: HandoverRecoveryEligibilityApplicationView[];
  memberships: HandoverRecoveryEligibilityMembershipView[];
  attendance: HandoverRecoveryEligibilityAttendanceView[];
  evidence: HandoverRecoveryEligibilityEvidenceView[];
  reconciliation: HandoverRecoveryEligibilityReconciliationView[];
  report: HandoverRecoveryEligibilityReportView;
  reviewCase: HandoverRecoveryEligibilityReviewCaseView;
  kindSetComplete: boolean;
}

export interface HandoverRecoveryEligibilityRefusal {
  code: HandoverRecoveryEligibilityClassification;
  detail: HandoverRecoveryEligibilityDetail;
  message: string;
}

export interface HandoverRecoveryEligibilityConclusion {
  classification: HandoverRecoveryEligibilityClassification;
  reason: string;
  refusals: HandoverRecoveryEligibilityRefusal[];
}

export interface HandoverRecoveryEligibilityDigest {
  schema: typeof HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_SCHEMA;
  schemaVersion: typeof HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION;
  algorithm: "sha256";
  value: string;
}

export interface HandoverRecoveryEligibilityResult {
  schema: typeof HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA;
  schemaVersion: typeof HANDOVER_RECOVERY_ELIGIBILITY_SCHEMA_VERSION;
  evaluatedAt: string;
  executionAuthorized: false;
  executionAuthority: "none";
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  classification: HandoverRecoveryEligibilityClassification;
  reason: string;
  refusals: HandoverRecoveryEligibilityRefusal[];
  evidenceDigest: HandoverRecoveryEligibilityDigest;
  references: {
    guardId: string;
    commitReceiptId: string;
    activationReceiptId: string;
    applicationReceiptIds: string[];
    reviewCaseId: string;
    slotGeneration: number | null;
    scheduledEnd: string;
    latestActivationAt: string;
  };
  readModelStability: "point_in_time_transaction";
  concurrencyNotice: string;
}
