// Phase 8C.4B — versioned dual-approval contract for stalled-handover recovery.
//
// This is a separate, versioned record from the Phase 8C.2b Version 1 approval.
// A Version 2 approval binds the authoritative evidence digest produced by the
// Phase 8C.3 classifier (and the classifier's own schema version), so both
// signatures refer to one canonical intent that can be re-derived and re-checked
// inside a transaction.
//
// Like Version 1, this contract records intent and personal approvals only. It
// never executes, consumes, abandons or repairs anything, and no execution
// endpoint exists. `recoveryExecutionEligible` is a literal `false` and is never
// accepted from a caller. Version 1 documents are permanently non-executable and
// are never migrated, upgraded or rewritten by anything in this file.

import type { EqualHandoverLifecycleStatus } from "./equal-technician-handover";
import type { HandoverReviewCaseStatus } from "./handover-admin-review";
import type { HandoverRecoveryEligibilityClassification } from "./handover-recovery-eligibility";

export const HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA = "handover-recovery-approval-v2" as const;
export const HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION = 1 as const;
export const HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION = "handover_recovery_approvals_v2" as const;
export const HANDOVER_RECOVERY_APPROVAL_V2_ACTION = "abandon_stalled_handover" as const;
export const HANDOVER_RECOVERY_APPROVAL_V2_PROOF_SCHEMA =
  "handover-recovery-approval-v2-proof-v1" as const;
export const HANDOVER_RECOVERY_APPROVAL_V2_ID_PREFIX = "handover_recovery_approval_v2_" as const;
export const HANDOVER_RECOVERY_APPROVAL_V2_AUDIT_ID_PREFIX =
  "handover_recovery_approval_v2_audit_" as const;

// A Version 2 approval is complete, not executable: `fully_approved` records that
// two distinct authenticated people signed one canonical intent. Nothing in this
// milestone may treat any approval as authority to change an operational record.
export const HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON =
  "approval_records_signed_intent_only_no_execution_path_exists" as const;

export const HANDOVER_RECOVERY_APPROVAL_V2_ROLES = {
  SUPERVISOR: "supervisor",
  ADMIN: "admin",
} as const;

export type HandoverRecoveryApprovalV2Role =
  (typeof HANDOVER_RECOVERY_APPROVAL_V2_ROLES)[keyof typeof HANDOVER_RECOVERY_APPROVAL_V2_ROLES];

// Persisted states. `expired` is derived from `expiresAt` at read time, so no
// scheduler and no implicit write is ever required.
export const HANDOVER_RECOVERY_APPROVAL_V2_STATUSES = {
  AWAITING_SECOND_APPROVAL: "awaiting_second_approval",
  FULLY_APPROVED: "fully_approved",
  VOIDED: "voided",
} as const;

export type HandoverRecoveryApprovalV2Status =
  (typeof HANDOVER_RECOVERY_APPROVAL_V2_STATUSES)[keyof typeof HANDOVER_RECOVERY_APPROVAL_V2_STATUSES];

export const HANDOVER_RECOVERY_APPROVAL_V2_EFFECTIVE_STATUSES = {
  ...HANDOVER_RECOVERY_APPROVAL_V2_STATUSES,
  EXPIRED: "expired",
} as const;

export type HandoverRecoveryApprovalV2EffectiveStatus =
  (typeof HANDOVER_RECOVERY_APPROVAL_V2_EFFECTIVE_STATUSES)[keyof typeof HANDOVER_RECOVERY_APPROVAL_V2_EFFECTIVE_STATUSES];

export const HANDOVER_RECOVERY_APPROVAL_V2_EVENTS = {
  REQUESTED: "requested",
  COUNTERSIGNED: "countersigned",
  VOIDED: "voided",
  REISSUED: "reissued",
} as const;

export type HandoverRecoveryApprovalV2Event =
  (typeof HANDOVER_RECOVERY_APPROVAL_V2_EVENTS)[keyof typeof HANDOVER_RECOVERY_APPROVAL_V2_EVENTS];

// The classifier facts an approval binds. Every value here is read by the server
// inside the approval transaction; none of it is supplied by a caller.
export interface HandoverRecoveryApprovalV2EvidenceBinding {
  // The eligibility result schema that produced the classification.
  eligibilitySchema: string;
  eligibilitySchemaVersion: number;
  // The digest envelope: the classifier's own schema, version and algorithm, so
  // a bound digest can never be replayed against a different classifier build.
  evidenceDigestSchema: string;
  evidenceDigestSchemaVersion: number;
  evidenceDigestAlgorithm: "sha256";
  evidenceDigest: string;
  classification: HandoverRecoveryEligibilityClassification;
}

// Every field is authoritative server state. Guard identity is present whenever
// the classifier could bind a guard, and null only when the guard document is
// absent — a state the classifier itself refuses, so it can never be approved.
export interface HandoverRecoveryApprovalV2Binding {
  evidence: HandoverRecoveryApprovalV2EvidenceBinding;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  aggregateRevision: number;
  aggregateSnapshotHash: string;
  aggregateLifecycleStatus: EqualHandoverLifecycleStatus;
  guardId: string | null;
  guardRevision: number;
  fencingEpoch: number;
  // The global operational slot the handover still holds.
  globalSlotToken: string | null;
  globalSlotGeneration: number | null;
  successorSlotToken: string;
  successorSlotGeneration: number;
  reviewCaseId: string;
  reviewCaseStatus: HandoverReviewCaseStatus | "none";
  reviewCaseRevision: number;
  reviewCaseFingerprint: string | null;
}

export interface HandoverRecoveryApprovalV2Signature {
  actorUid: string;
  actorRole: HandoverRecoveryApprovalV2Role;
  // Digest of the personal password proof, never the proof or any credential.
  proofFingerprint: string;
  approvedAt: string;
  proofExpiresAt: string;
}

export interface HandoverRecoveryApprovalV2Record {
  schema: typeof HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA;
  schemaVersion: typeof HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION;
  id: string;
  action: typeof HANDOVER_RECOVERY_APPROVAL_V2_ACTION;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  binding: HandoverRecoveryApprovalV2Binding;
  intentFingerprint: string;
  // Literal false for every state, including `fully_approved`.
  recoveryExecutionEligible: false;
  nonExecutableReason: typeof HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  approvals: HandoverRecoveryApprovalV2Signature[];
  requestHash: string;
  revision: number;
  status: HandoverRecoveryApprovalV2Status;
  // A voided Version 2 intent is terminal. Reissue is the only successor path,
  // so these two fields always point at each other and the voided original is
  // never rewritten beyond its tombstone.
  replacesApprovalId: string | null;
  reissuedAsApprovalId: string | null;
  requestAuditId: string;
  countersignAuditId: string | null;
  voidAuditId: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  // The evaluation that produced the bound digest, kept for audit. Deliberately
  // outside the canonical intent: re-evaluation always yields a new timestamp,
  // so including it would make every countersignature impossible.
  boundEvaluatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface HandoverRecoveryApprovalV2View {
  approval: HandoverRecoveryApprovalV2Record;
  effectiveStatus: HandoverRecoveryApprovalV2EffectiveStatus;
  approvalCount: number;
  requiredSecondRole: HandoverRecoveryApprovalV2Role | null;
  recoveryExecutionEligible: false;
}
