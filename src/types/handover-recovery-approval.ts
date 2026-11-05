// Phase 8C.2b — versioned dual-approval substrate for future stalled-handover
// recovery.
//
// This contract records intent and two independent personal approvals. It never
// executes, consumes, abandons or repairs anything. A Version 1 approval is
// permanently non-executable because it was bound before the Phase 8C.3
// authoritative evidence digest existed; `recoveryExecutionEligible` is a
// literal `false` and is never accepted from a caller.

import type { EqualHandoverLifecycleStatus } from "./equal-technician-handover";
import type { HandoverReviewCaseStatus } from "./handover-admin-review";

export const HANDOVER_RECOVERY_APPROVAL_SCHEMA = "handover-recovery-approval-v1" as const;
export const HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION = 1 as const;
export const HANDOVER_RECOVERY_APPROVAL_COLLECTION = "handover_recovery_approvals_v1" as const;
export const HANDOVER_RECOVERY_APPROVAL_ACTION = "abandon_stalled_handover" as const;

// Version 2 must add the authoritative evidence digest from Phase 8C.3 and a new
// schema identifier. Version 1 documents are never migrated or upgraded in
// place; they remain readable, voided and non-executable forever.
export const HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON =
  "schema_version_1_binds_no_authoritative_evidence_digest" as const;

export const HANDOVER_RECOVERY_APPROVAL_ROLES = {
  SUPERVISOR: "supervisor",
  ADMIN: "admin",
} as const;

export type HandoverRecoveryApprovalRole =
  (typeof HANDOVER_RECOVERY_APPROVAL_ROLES)[keyof typeof HANDOVER_RECOVERY_APPROVAL_ROLES];

// Persisted states. `expired` is derived from `expiresAt` at read time so no
// scheduler or implicit write is required.
export const HANDOVER_RECOVERY_APPROVAL_STATUSES = {
  AWAITING_SECOND_APPROVAL: "awaiting_second_approval",
  FULLY_APPROVED: "fully_approved",
  VOIDED: "voided",
} as const;

export type HandoverRecoveryApprovalStatus =
  (typeof HANDOVER_RECOVERY_APPROVAL_STATUSES)[keyof typeof HANDOVER_RECOVERY_APPROVAL_STATUSES];

export const HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES = {
  ...HANDOVER_RECOVERY_APPROVAL_STATUSES,
  EXPIRED: "expired",
} as const;

export type HandoverRecoveryApprovalEffectiveStatus =
  (typeof HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES)[keyof typeof HANDOVER_RECOVERY_APPROVAL_EFFECTIVE_STATUSES];

export const HANDOVER_RECOVERY_APPROVAL_EVENTS = {
  REQUESTED: "requested",
  COUNTERSIGNED: "countersigned",
  VOIDED: "voided",
  REISSUED: "reissued",
} as const;

export type HandoverRecoveryApprovalEvent =
  (typeof HANDOVER_RECOVERY_APPROVAL_EVENTS)[keyof typeof HANDOVER_RECOVERY_APPROVAL_EVENTS];

// Every field is authoritative state that the server read inside the creating
// transaction. Nothing here is supplied by a caller.
export interface HandoverRecoveryApprovalBinding {
  aggregateRevision: number;
  aggregateSnapshotHash: string;
  aggregateLifecycleStatus: EqualHandoverLifecycleStatus;
  guardId: string | null;
  guardRevision: number;
  fencingEpoch: number;
  slotToken: string;
  slotGeneration: number;
  successorSlotToken: string;
  successorSlotGeneration: number;
  reviewCaseId: string;
  reviewCaseStatus: HandoverReviewCaseStatus | "none";
  reviewCaseRevision: number;
  reviewCaseFingerprint: string | null;
}

export interface HandoverRecoveryApprovalSignature {
  actorUid: string;
  actorRole: HandoverRecoveryApprovalRole;
  // Digest of the personal password proof, never the proof or any credential.
  proofFingerprint: string;
  approvedAt: string;
  proofExpiresAt: string;
}

export interface HandoverRecoveryApprovalRecord {
  schema: typeof HANDOVER_RECOVERY_APPROVAL_SCHEMA;
  schemaVersion: typeof HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION;
  id: string;
  action: typeof HANDOVER_RECOVERY_APPROVAL_ACTION;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  binding: HandoverRecoveryApprovalBinding;
  intentFingerprint: string;
  // Literal false: no reader may treat a version 1 approval as executable.
  recoveryExecutionEligible: false;
  nonExecutableReason: typeof HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  approvals: HandoverRecoveryApprovalSignature[];
  requestHash: string;
  revision: number;
  status: HandoverRecoveryApprovalStatus;
  replacesApprovalId: string | null;
  reissuedAsApprovalId: string | null;
  requestAuditId: string;
  countersignAuditId: string | null;
  voidAuditId: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

// Read model: persisted bytes plus the clock-derived effective state.
export interface HandoverRecoveryApprovalView {
  approval: HandoverRecoveryApprovalRecord;
  effectiveStatus: HandoverRecoveryApprovalEffectiveStatus;
  approvalCount: number;
  requiredSecondRole: HandoverRecoveryApprovalRole | null;
  recoveryExecutionEligible: false;
}
