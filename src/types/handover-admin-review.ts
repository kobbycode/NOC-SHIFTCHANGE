// Phase 8B — administrative handover review.
//
// These types describe a strictly administrative surface. Review cases and
// decisions are metadata about what an administrator observed and concluded;
// they never represent acceptance, attendance, guard closure or any other
// operational evidence. No field in this contract is written back to a
// handover, guard, receipt, evidence, membership or attendance document.

import type {
  EqualHandoverLifecycleStatus,
  EqualHandoverPosition,
} from "./equal-technician-handover";
import type {
  IncomingAcceptanceOutcome,
} from "./incoming-acceptance-application";

export const HANDOVER_REVIEW_CASE_SCHEMA = "handover-admin-review-case-v1" as const;
export const HANDOVER_REVIEW_DECISION_SCHEMA = "handover-admin-review-decision-v1" as const;
export const HANDOVER_REVIEW_CASE_COLLECTION = "handover_review_cases_v1";
export const HANDOVER_REVIEW_DECISION_COLLECTION = "handover_review_decisions_v1";

export const HANDOVER_REVIEW_CASE_STATUSES = {
  OPEN: "open",
  UNDER_INVESTIGATION: "under_investigation",
  ESCALATED: "escalated",
  CLOSED: "closed",
} as const;

export type HandoverReviewCaseStatus =
  (typeof HANDOVER_REVIEW_CASE_STATUSES)[keyof typeof HANDOVER_REVIEW_CASE_STATUSES];

export const HANDOVER_REVIEW_DECISION_TYPES = {
  ACKNOWLEDGE_VALID_COMPLETED_STATE: "acknowledge_valid_completed_state",
  MARK_FURTHER_INVESTIGATION: "mark_further_investigation",
  RECORD_ADMINISTRATIVE_FINDING: "record_administrative_finding",
  CLOSE_REVIEW_CASE: "close_review_case",
  ESCALATE: "escalate",
} as const;

export type HandoverReviewDecisionType =
  (typeof HANDOVER_REVIEW_DECISION_TYPES)[keyof typeof HANDOVER_REVIEW_DECISION_TYPES];

export const HANDOVER_REVIEW_DECISION_TYPE_LIST = [
  HANDOVER_REVIEW_DECISION_TYPES.ACKNOWLEDGE_VALID_COMPLETED_STATE,
  HANDOVER_REVIEW_DECISION_TYPES.MARK_FURTHER_INVESTIGATION,
  HANDOVER_REVIEW_DECISION_TYPES.RECORD_ADMINISTRATIVE_FINDING,
  HANDOVER_REVIEW_DECISION_TYPES.CLOSE_REVIEW_CASE,
  HANDOVER_REVIEW_DECISION_TYPES.ESCALATE,
] as const;

export const HANDOVER_REVIEW_CLASSIFICATIONS = {
  NOT_REVIEWABLE: "not_reviewable",
  NOT_ACTIVATED: "not_activated",
  AWAITING_FIRST_ACCEPTANCE: "awaiting_first_acceptance",
  AWAITING_PARTNER_ACCEPTANCE: "awaiting_partner_acceptance",
  ELIGIBLE_FOR_NORMAL_CLOSURE: "eligible_for_normal_closure",
  JOINING_WINDOW_EXPIRED: "joining_window_expired",
  COMPLETED_VALID: "completed_valid",
  COMPLETED_EXCEPTIONAL: "completed_exceptional",
  INCONSISTENT_REVIEW_REQUIRED: "inconsistent_review_required",
} as const;

export type HandoverReviewClassification =
  (typeof HANDOVER_REVIEW_CLASSIFICATIONS)[keyof typeof HANDOVER_REVIEW_CLASSIFICATIONS];

// Deliberately read-only verification outcomes. `validated` means the
// persisted acceptance receipt and every operational artifact proved
// consistent at review time; it never asserts that an acceptance was created
// or repaired by the administrator.
export const HANDOVER_REVIEW_VERIFICATION_STATUSES = {
  VALIDATED: "validated",
  NOT_APPLIED: "not_applied",
  INCONSISTENT: "inconsistent",
  COMMIT_UNVERIFIABLE: "commit_unverifiable",
  BINDING_CONFLICT: "binding_conflict",
  GUARD_CONFLICT: "guard_conflict",
} as const;

export type HandoverReviewVerificationStatus =
  (typeof HANDOVER_REVIEW_VERIFICATION_STATUSES)[keyof typeof HANDOVER_REVIEW_VERIFICATION_STATUSES];

export interface HandoverReviewReason {
  code: string;
  subjectUid: string | null;
  message: string;
}

export interface HandoverReviewParticipant {
  position: EqualHandoverPosition;
  side: "outgoing" | "incoming";
  technicianUid: string;
  fullName: string | null;
}

export interface HandoverReviewApplicationProjection {
  position: EqualHandoverPosition;
  technicianUid: string;
  fullName: string | null;
  receiptPresent: boolean;
  receiptId: string | null;
  receiptHash: string | null;
  outcome: IncomingAcceptanceOutcome | null;
  operationalAppliedAt: string | null;
  verificationStatus: HandoverReviewVerificationStatus;
  verificationCode: string | null;
  verificationMessage: string | null;
  evidencePresent: boolean;
  operationFinalized: boolean;
  membershipPresent: boolean;
  attendancePresent: boolean;
  applicationAuditPresent: boolean;
  declaredNotYetIn: boolean;
}

export interface HandoverReviewGuardProjection {
  id: string;
  ownerHandoverDocumentId: string;
  protocolOwner: string;
  ownerLifecycleState: string;
  guardRevision: number;
  fencingEpoch: number;
  terminalEvidenceRef: string | null;
  reservedAt: string;
  finalizationAuditPresent: boolean;
}

export interface HandoverReviewActivationProjection {
  receiptId: string;
  present: boolean;
  valid: boolean;
  receiptHash: string | null;
  actorUid: string | null;
  activatedAt: string | null;
  boundReportId: string | null;
  message: string | null;
}

export interface HandoverReviewReportProjection {
  present: boolean;
  valid: boolean;
  reportId: string | null;
  digest: string | null;
  evidenceSnapshotHash: string | null;
  message: string | null;
}

export interface HandoverReviewShiftSummary {
  shiftId: string;
  status: string | null;
  actualStart: string | null;
  actualEnd: string | null;
}

export interface HandoverReviewAbsenceView {
  technicianUid: string;
  absenceType: string;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

export interface HandoverReviewCaseRecord {
  id: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  status: HandoverReviewCaseStatus;
  caseRevision: number;
  classificationAtLastDecision: HandoverReviewClassification;
  fingerprintAtLastDecision: string;
  createdBy: string;
  decisionCount: number;
  lastDecisionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface HandoverReviewDecisionRecord {
  schema: typeof HANDOVER_REVIEW_DECISION_SCHEMA;
  id: string;
  caseId: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  decisionType: HandoverReviewDecisionType;
  actorUid: string;
  actorRole: "admin";
  reason: string;
  finding: string | null;
  resolutionSummary: string | null;
  escalationTarget: string | null;
  expectedCaseRevision: number;
  caseRevisionAfter: number;
  caseStatusBefore: HandoverReviewCaseStatus;
  caseStatusAfter: HandoverReviewCaseStatus;
  evidenceFingerprint: string;
  classification: HandoverReviewClassification;
  reviewReasonCodes: string[];
  requestHash: string;
  idempotencyKey: string;
  recordedAt: string;
}

export interface HandoverReviewProjection {
  caseId: string;
  handoverDocumentId: string;
  handoverId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  shiftType: "morning" | "night";
  scheduledStart: string;
  scheduledEnd: string;
  aggregateRevision: number;
  aggregateLifecycleStatus: EqualHandoverLifecycleStatus;
  aggregateUpdatedAt: string;
  guardLifecycleState: string | null;
  guardLifecycleReason: string | null;
  report: HandoverReviewReportProjection;
  guard: HandoverReviewGuardProjection | null;
  activation: HandoverReviewActivationProjection;
  participants: HandoverReviewParticipant[];
  applications: HandoverReviewApplicationProjection[];
  absences: HandoverReviewAbsenceView[];
  shifts: {
    outgoing: HandoverReviewShiftSummary;
    incoming: HandoverReviewShiftSummary;
  };
  classification: HandoverReviewClassification;
  reviewReasons: HandoverReviewReason[];
  requiresReview: boolean;
  evidenceFingerprint: string;
  generatedAt: string;
  caseStatus: HandoverReviewCaseStatus;
  caseRevision: number;
  caseRecord: HandoverReviewCaseRecord | null;
  allowedDecisions: HandoverReviewDecisionType[];
  decisions: HandoverReviewDecisionRecord[];
}

export interface HandoverReviewQueueItem {
  caseId: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  shiftType: "morning" | "night";
  scheduledStart: string;
  scheduledEnd: string;
  aggregateLifecycleStatus: EqualHandoverLifecycleStatus;
  guardLifecycleState: string | null;
  guardLifecycleReason: string | null;
  classification: HandoverReviewClassification;
  reviewReasons: HandoverReviewReason[];
  participants: HandoverReviewParticipant[];
  caseStatus: HandoverReviewCaseStatus;
  caseRevision: number;
  evidenceFingerprint: string;
  updatedAt: string;
}

export interface HandoverReviewFingerprintApplication {
  technicianUid: string;
  receiptId: string | null;
  receiptHash: string | null;
  outcome: IncomingAcceptanceOutcome | null;
  operationalAppliedAt: string | null;
  verificationStatus: HandoverReviewVerificationStatus;
  verificationCode: string | null;
  evidencePresent: boolean;
  operationFinalized: boolean;
  membershipPresent: boolean;
  attendancePresent: boolean;
  applicationAuditPresent: boolean;
  declaredNotYetIn: boolean;
}

export interface HandoverReviewFingerprintInput {
  handoverDocumentId: string;
  aggregateRevision: number;
  aggregateLifecycleStatus: EqualHandoverLifecycleStatus;
  guard: {
    id: string;
    ownerLifecycleState: string;
    guardRevision: number;
    fencingEpoch: number;
    terminalEvidenceRef: string | null;
  } | null;
  activation: {
    receiptId: string | null;
    receiptHash: string | null;
    valid: boolean;
  };
  report: {
    reportId: string | null;
    digest: string | null;
    valid: boolean;
  };
  applications: HandoverReviewFingerprintApplication[];
  classification: HandoverReviewClassification;
  reviewReasonCodes: string[];
}

// Phase 8C.2a — append-only historical adjudication.
//
// An adjudication is a second, independent administrative ledger. It records
// that the authoritative evidence BEHIND a previously acknowledged review
// decision no longer proves the state that decision recorded. It is created
// beside the original case and decisions; nothing in this contract updates,
// rewrites, reopens or repairs a review case, a review decision, or any
// operational document.

export const HANDOVER_REVIEW_ADJUDICATION_SCHEMA =
  "handover-admin-review-adjudication-v1" as const;
export const HANDOVER_REVIEW_ADJUDICATION_COLLECTION =
  "handover_review_adjudications_v1";

// The only status an adjudication can ever have. Recorded under a name that
// cannot be mistaken for an operational outcome: recording an adjudication
// changes no shift, no handover, no acceptance and no review case revision.
export const HANDOVER_REVIEW_ADJUDICATION_STATUS =
  "recorded_without_operational_change" as const;

export const HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT = "none" as const;

// Server-derived reasons why an adjudication cannot be recorded. These are
// diagnostic labels for the eligibility proof, never stored fields.
export const HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE = {
  CASE_NOT_FOUND: "case_not_found",
  CASE_NOT_CLOSED: "case_not_closed",
  NO_ACKNOWLEDGEMENT: "no_acknowledged_decision",
  HISTORY_MISMATCH: "case_history_mismatch",
  NO_CONTRADICTION: "no_verified_contradiction",
  EVIDENCE_UNCHANGED: "evidence_unchanged",
} as const;

export type HandoverReviewAdjudicationIneligibleCode =
  (typeof HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE)[keyof typeof HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE];

export interface HandoverReviewAdjudicationEvidenceReference {
  code: string;
  subjectUid: string | null;
  message: string;
  references: string[];
}

export interface HandoverReviewAdjudicationRecord {
  schema: typeof HANDOVER_REVIEW_ADJUDICATION_SCHEMA;
  id: string;
  caseId: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  // Everything below about the original decision is read from the persisted
  // decision and case record inside the transaction, never from the request.
  originalDecisionId: string;
  originalDecisionType: HandoverReviewDecisionType;
  originalDecisionActorUid: string;
  originalDecisionRecordedAt: string;
  originalDecisionFingerprint: string;
  originalDecisionClassification: HandoverReviewClassification;
  originalCaseRevision: number;
  originalCaseStatus: HandoverReviewCaseStatus;
  // Everything below is re-derived from live authoritative evidence.
  currentClassification: HandoverReviewClassification;
  currentEvidenceDigest: string;
  contradictionReasonCodes: string[];
  evidenceReferences: HandoverReviewAdjudicationEvidenceReference[];
  // The administrator's own words and identity.
  actorUid: string;
  actorRole: "admin";
  finding: string;
  requestHash: string;
  idempotencyKey: string;
  status: typeof HANDOVER_REVIEW_ADJUDICATION_STATUS;
  operationalEffect: typeof HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT;
  auditId: string;
  adjudicatedAt: string;
}

export interface HandoverReviewAdjudicationEligibility {
  handoverDocumentId: string;
  caseId: string;
  caseStatus: HandoverReviewCaseStatus;
  eligible: boolean;
  ineligibleCode: HandoverReviewAdjudicationIneligibleCode | null;
  message: string;
  acknowledgedDecision: HandoverReviewDecisionRecord | null;
  previousClassification: HandoverReviewClassification | null;
  previousEvidenceDigest: string | null;
  currentClassification: HandoverReviewClassification;
  currentEvidenceDigest: string;
  currentReviewReasonCodes: string[];
  contradictionReasonCodes: string[];
  evidenceReferences: HandoverReviewAdjudicationEvidenceReference[];
  existingAdjudicationIds: string[];
  generatedAt: string;
}
