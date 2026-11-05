// Pure contracts for the atomic incoming-acceptance application protocol.
// These records describe what R3B.2 may persist; nothing here writes Firestore.

import type { AttendanceAuthenticationMethod, AttendanceEvidenceKind } from "./attendance-evidence";
import type { EqualHandoverPosition } from "./equal-technician-handover";

export const INCOMING_ACCEPTANCE_APPLICATION_SCHEMA =
  "incoming-acceptance-application-v1" as const;
export const INCOMING_ACCEPTANCE_APPLICATION_PROTOCOL_VERSION = 1 as const;
export const INCOMING_ACCEPTANCE_APPLICATIONS_COLLECTION =
  "incoming_acceptance_applications_v1" as const;
export const INCOMING_ACCEPTANCE_AUTHENTICATION_PROOF_SCHEMA =
  "incoming-acceptance-authentication-proof-v1" as const;

export const INCOMING_ACCEPTANCE_APPLICATION_STATUSES = {
  APPLIED: "applied",
} as const;

export type IncomingAcceptanceApplicationStatus =
  (typeof INCOMING_ACCEPTANCE_APPLICATION_STATUSES)[keyof typeof INCOMING_ACCEPTANCE_APPLICATION_STATUSES];

export const INCOMING_ACCEPTANCE_OUTCOMES = {
  FIRST_ACTIVATION: "first_activation",
  SUBSEQUENT_JOIN: "subsequent_join",
} as const;

export type IncomingAcceptanceOutcome =
  (typeof INCOMING_ACCEPTANCE_OUTCOMES)[keyof typeof INCOMING_ACCEPTANCE_OUTCOMES];

export const INCOMING_ACCEPTANCE_LATE_REASON_SOURCES = {
  TECHNICIAN_SUPPLIED: "technician_supplied",
  NOT_REQUIRED: "not_required",
} as const;

export type IncomingAcceptanceLateReasonSource =
  (typeof INCOMING_ACCEPTANCE_LATE_REASON_SOURCES)[keyof typeof INCOMING_ACCEPTANCE_LATE_REASON_SOURCES];

export const INCOMING_ACCEPTANCE_ORIGINS = {
  NATIVE_ATOMIC: "native_atomic",
  LEGACY_RECOVERY: "legacy_recovery",
} as const;

export type IncomingAcceptanceOrigin =
  (typeof INCOMING_ACCEPTANCE_ORIGINS)[keyof typeof INCOMING_ACCEPTANCE_ORIGINS];

export const INCOMING_ACCEPTANCE_EVIDENCE_ROLES = {
  APPLIED_PERSONAL_EVENT: "applied_personal_event",
  PRIOR_AUTHENTICATED_ATTEMPT: "prior_authenticated_attempt",
} as const;

export type IncomingAcceptanceEvidenceRole =
  (typeof INCOMING_ACCEPTANCE_EVIDENCE_ROLES)[keyof typeof INCOMING_ACCEPTANCE_EVIDENCE_ROLES];

export const INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS = {
  NATIVE_APPLIED: "NATIVE_APPLIED",
  LEGACY_APPLIED_UNATTESTED_V1: "LEGACY_APPLIED_UNATTESTED_V1",
  LEGACY_UNAPPLIED_AUTHENTICATED_ATTEMPT: "LEGACY_UNAPPLIED_AUTHENTICATED_ATTEMPT",
  LEGACY_PENDING_INTENT: "LEGACY_PENDING_INTENT",
  LEGACY_ACK_INTERRUPTED: "LEGACY_ACK_INTERRUPTED",
  LEGACY_ABORTED_INTENT: "LEGACY_ABORTED_INTENT",
  NOT_APPLIED: "NOT_APPLIED",
  INCONSISTENT_REVIEW_REQUIRED: "INCONSISTENT_REVIEW_REQUIRED",
} as const;

export type IncomingAcceptanceLegacyClassification =
  (typeof INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS)[keyof typeof INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS];

// Firestore FieldValue.serverTimestamp() cannot be resolved inside a
// transaction callback, so pre-commit receipts carry the unresolved marker and
// authoritative read-back hydrates a resolved value. Neither is hashed.
export interface IncomingAcceptanceUnresolvedCommit {
  readonly state: "unresolved";
}

export interface IncomingAcceptanceResolvedCommit {
  readonly state: "resolved";
  readonly seconds: number;
  readonly nanoseconds: number;
}

export type IncomingAcceptanceCommitMarker =
  | IncomingAcceptanceUnresolvedCommit
  | IncomingAcceptanceResolvedCommit;

export interface IncomingAcceptanceAuthenticationProof {
  schema: typeof INCOMING_ACCEPTANCE_AUTHENTICATION_PROOF_SCHEMA;
  /** Request-local nonce; a new HTTP attempt must create a new proof. */
  requestNonce: string;
  verifiedTechnicianUid: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  reviewFingerprint: string;
  reasonDigest: string | null;
  /** Monotonic clock captured with the verification; never persisted. */
  verifiedAtMonotonicMs: number;
}

export interface IncomingAcceptanceReviewedReportBinding {
  schema: "handover-report-v2";
  id: string;
  digest: string;
  evidenceSnapshotHash: string;
  workSnapshotVersion: string;
  preparationId: string;
  preparationRevision: number;
  reservationId: string;
  aggregateRevision: number;
  fencingEpoch: number;
  frozenBy: string;
  frozenAt: string;
}

export interface IncomingAcceptanceReviewedBinding {
  handoverId: string;
  handoverDocumentId: string;
  aggregateRevision: number;
  snapshotHash: string;
  report: IncomingAcceptanceReviewedReportBinding;
  guardRevision: number;
  fencingEpoch: number;
}

export interface IncomingAcceptanceAppliedGuardBinding {
  protocolOwner: "v2";
  handoverDocumentId: string;
  reservationId: string;
  incomingShiftId: string;
  lifecycleState: "active";
  guardRevision: number;
  fencingEpoch: number;
  outgoingSlotToken: string;
  outgoingGeneration: number;
  successorSlotToken: string;
  successorGeneration: number;
}

export interface IncomingAcceptanceAbsenceReference {
  absenceType: "not_yet_in";
  technicianUid: string;
  recordedBy: string;
  recordedRevision: number;
  revision: number;
  recordedAt: string;
  reason: string;
}

export interface IncomingAcceptanceLegacyRecovery {
  approvalId: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  observedEvidenceDigest: string;
  observedOperationId: string;
  previousEvidenceId: string;
  previousEventTime: string;
  recoveredAt: string;
}

export interface IncomingAcceptanceApplicationIdentity {
  handoverId: string;
  technicianUid: string;
  kind: AttendanceEvidenceKind;
  businessKeyHash: string;
  receiptId: string;
  auditId: string;
  eventId: string;
  operationId: string;
  evidenceId: string;
  slotId: string;
}

export interface IncomingAcceptanceApplicationReceipt {
  schema: typeof INCOMING_ACCEPTANCE_APPLICATION_SCHEMA;
  protocolVersion: typeof INCOMING_ACCEPTANCE_APPLICATION_PROTOCOL_VERSION;
  id: string;
  businessKeyHash: string;
  status: IncomingAcceptanceApplicationStatus;
  handoverDocumentId: string;
  reservationId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  technicianUid: string;
  position: EqualHandoverPosition;
  outcome: IncomingAcceptanceOutcome;
  activationReceiptId: string;
  activationReceiptHash: string;
  evidenceEventId: string;
  evidenceOperationId: string;
  evidenceId: string;
  evidenceKind: AttendanceEvidenceKind;
  evidenceDigest: string;
  membershipId: string;
  attendanceId: string;
  reviewedBinding: IncomingAcceptanceReviewedBinding;
  appliedGuardBinding: IncomingAcceptanceAppliedGuardBinding;
  requestAcceptedAt: string;
  passwordVerifiedAt: string;
  authAccountCheckedAt: string;
  personalEvidenceEventAt: string;
  operationalAppliedAt: string;
  committedAt: IncomingAcceptanceCommitMarker;
  lateReason: string | null;
  lateReasonSource: IncomingAcceptanceLateReasonSource;
  absenceReference: IncomingAcceptanceAbsenceReference | null;
  origin: IncomingAcceptanceOrigin;
  evidenceRole: IncomingAcceptanceEvidenceRole;
  legacyRecovery: IncomingAcceptanceLegacyRecovery | null;
  auditId: string;
  receiptHash: string;
}

export interface IncomingAcceptanceEvidenceRecord {
  id: string;
  slotId: string;
  operationId: string;
  eventId: string;
  handoverId: string;
  technicianUid: string;
  kind: AttendanceEvidenceKind;
  eventTime: string | null;
  authenticationMethod: AttendanceAuthenticationMethod;
  personallyAuthenticated: boolean;
  guardRevision: number;
  fencingEpoch: number;
  [key: string]: unknown;
}

export interface IncomingAcceptanceOperationRecord {
  id: string;
  status: string;
  eventId: string;
  technicianUid: string;
  kind: AttendanceEvidenceKind;
  evidenceId: string;
  interruptedFinalization: boolean;
  [key: string]: unknown;
}

export interface IncomingAcceptanceMembershipRecord {
  id: string;
  shiftId: string;
  technicianId: string;
  role: string;
  leftAt: string | null;
  joinedAt?: string | null;
  [key: string]: unknown;
}

export interface IncomingAcceptanceAttendanceRecord {
  id: string;
  shiftId: string;
  technicianId: string;
  status: string;
  participationAuthority: string;
  authorizationId: string | null;
  isProvisional: boolean;
  clockIn: string | null;
  clockOut: string | null;
  recordedAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface IncomingAcceptanceIncomingShiftRecord {
  id: string;
  status: string;
  actualStart: string | null;
  [key: string]: unknown;
}

export interface IncomingAcceptanceReservationBinding {
  handoverId: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  incomingTechnicianIds: [string, string];
  scheduledStart: string;
  scheduledEnd: string;
}

export interface IncomingAcceptanceGuardApplicationState {
  technicianUid: string;
  receipt: IncomingAcceptanceApplicationReceipt | null;
  evidencePresent: boolean;
  operationFinalized: boolean;
  membershipPresent: boolean;
  attendancePresent: boolean;
  declaredNotYetIn: boolean;
}

export interface IncomingAcceptanceExceptionalClosure {
  closureId: string;
  subjectUid: string;
  authorizedBy: string;
  reason: string;
  recordedAt: string;
}

export interface IncomingAcceptanceLegacyState {
  aggregateLifecycleStatus: string;
  activationReceiptPresent: boolean;
  activationReceiptConsistent: boolean;
  membershipPresent: boolean;
  attendancePresent: boolean;
  evidence: {
    present: boolean;
    finalized: boolean;
    interruptedFinalization: boolean;
  } | null;
  operation: {
    present: boolean;
    status: string;
  } | null;
  nativeReceipt: IncomingAcceptanceApplicationReceipt | null;
}
