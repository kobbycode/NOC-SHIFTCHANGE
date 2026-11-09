// Phase 8C.4 — pure domain for the recovery abandonment transition.
//
// Everything here is deterministic and side-effect free: no Firestore imports,
// no clock, no credentials. The execution service (8C.5) supplies server-derived
// values and this module decides the recovery-specific refusals, the
// create-once identifiers and the successor slot token.

import { createHash } from "node:crypto";

import {
  HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS,
  type HandoverRecoveryEligibilityClassification,
} from "@/types/handover-recovery-eligibility";

export const HANDOVER_RECOVERY_ABANDONMENT_SCHEMA = "handover-recovery-abandonment-v1" as const;

export const HANDOVER_RECOVERY_ABANDONMENT_AUDIT_ACTION = "HANDOVER_STALLED_ABANDONED_V1" as const;

export const HANDOVER_RECOVERY_ABANDONMENT_AUDIT_PREFIX = "handover_abandonment_v1_" as const;

// The recovery refusal vocabulary of the contract (§6.4). These are distinct
// from the eligibility classification on purpose: the classifier answers "may
// this be reviewed", these answer "may execution proceed".
export const HANDOVER_RECOVERY_ABANDONMENT_REFUSALS = {
  NOT_APPLICABLE: "RECOVERY_NOT_APPLICABLE",
  WINDOW_OPEN: "RECOVERY_WINDOW_OPEN",
  ACCEPTANCE_EXISTS: "RECOVERY_ACCEPTANCE_EXISTS",
  STATE_INCONSISTENT: "RECOVERY_STATE_INCONSISTENT",
  STALE_OR_APPLIED: "RECOVERY_STALE_OR_APPLIED",
  APPROVAL_STALE: "RECOVERY_APPROVAL_STALE",
  APPROVAL_EXPIRED: "RECOVERY_APPROVAL_EXPIRED",
  APPROVAL_INVALID: "RECOVERY_APPROVAL_INVALID",
  ALREADY_APPLIED: "RECOVERY_ALREADY_APPLIED",
  OUTCOME_UNKNOWN: "HANDOVER_RECOVERY_OUTCOME_UNKNOWN",
} as const;

export type HandoverRecoveryAbandonmentRefusal =
  (typeof HANDOVER_RECOVERY_ABANDONMENT_REFUSALS)[keyof typeof HANDOVER_RECOVERY_ABANDONMENT_REFUSALS];

export class HandoverRecoveryAbandonmentError extends Error {
  readonly code: HandoverRecoveryAbandonmentRefusal;
  readonly status: number;
  // Every refusal is raised before or instead of a commit, so it is safe for a
  // caller to treat the attempt as not applied — except an unknown outcome,
  // where the transaction may in fact have committed.
  readonly notCommitted: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: HandoverRecoveryAbandonmentRefusal,
    message: string,
    status = 409,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HandoverRecoveryAbandonmentError";
    this.code = code;
    this.status = status;
    this.notCommitted = code !== HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.OUTCOME_UNKNOWN;
    this.details = Object.freeze({ ...details });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = value[key];
        return acc;
      }, {}),
  );
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
      `Invalid ${label}.`,
      400,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Create-once identifiers (§6.5)
// ---------------------------------------------------------------------------

/**
 * Derived from the approval id alone, so a retried or duplicated attempt
 * recomputes the same id and `transaction.create` collides instead of writing a
 * second abandonment.
 */
export function createHandoverAbandonmentAuditId(approvalId: string): string {
  identifier(approvalId, "approval id");
  return (
    HANDOVER_RECOVERY_ABANDONMENT_AUDIT_PREFIX +
    sha256(
      canonical({
        namespace: "handover-recovery-abandonment-v1",
        approvalId,
      }),
    )
  );
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function parseUuid(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, ""), "hex");
}

function uuidV5(name: string, namespace: string): string {
  const digest = createHash("sha1")
    .update(Buffer.concat([parseUuid(namespace), Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function stableNamespaceUuid(label: string): string {
  const bytes = Buffer.from(createHash("sha256").update(label, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

const RECOVERY_NAMESPACE = stableNamespaceUuid("shiftchange-operational-recovery");

/**
 * RFC 4122 version 5 shaped, derived from `{ approvalId, generation }`. Version 5
 * is inside the range `requireSlotToken` accepts, and the same approval always
 * yields the same token, so a replay is detectable by token reuse.
 */
export function createHandoverAbandonmentSlotToken(input: {
  approvalId: string;
  generation: number;
}): string {
  const approvalId = identifier(input.approvalId, "approval id");
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    throw new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
      "The operational slot generation is invalid.",
      409,
    );
  }
  return uuidV5(
    canonical({ approvalId, generation: input.generation }),
    RECOVERY_NAMESPACE,
  );
}

// ---------------------------------------------------------------------------
// Refusal mapping
// ---------------------------------------------------------------------------

/**
 * Translates the eligibility classifier's conclusion into the execution
 * refusal vocabulary. `eligible_for_abandonment_review` is the only value that
 * proceeds, and even that is not authority: the caller re-evaluates inside its
 * own transaction and fences on the approval binding.
 */
export function refusalForAbandonmentClassification(
  classification: HandoverRecoveryEligibilityClassification,
): HandoverRecoveryAbandonmentRefusal | null {
  switch (classification) {
    case HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.ELIGIBLE_FOR_ABANDONMENT_REVIEW:
      return null;
    case HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.ACTIVATION_WINDOW_OPEN:
      return HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.WINDOW_OPEN;
    case HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.ACCEPTANCE_EXISTS:
    case HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.ACCEPTANCE_OUTCOME_UNCERTAIN:
      return HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.ACCEPTANCE_EXISTS;
    case HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.SLOT_BINDING_CONFLICT:
      return HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STALE_OR_APPLIED;
    case HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.HANDOVER_NOT_APPLICABLE:
      return HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.NOT_APPLICABLE;
    case HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.INCONSISTENT_EVIDENCE:
    case HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.GUARD_BINDING_CONFLICT:
    case HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS.EVIDENCE_UNVERIFIABLE:
      return HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT;
    default: {
      const exhaustive: never = classification;
      throw new HandoverRecoveryAbandonmentError(
        HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.STATE_INCONSISTENT,
        `Unsupported recovery classification: ${String(exhaustive)}`,
        409,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Approval fences (F-5)
// ---------------------------------------------------------------------------

export interface HandoverAbandonmentApprovalState {
  intentFingerprint: string;
  recomputedIntentFingerprint: string;
  storedStatus: string;
  voidedAt: string | null;
  consumedAt: string | null;
  expiresAt: string;
  approvals: readonly {
    actorUid: string;
    actorRole: string;
    proofFingerprint: string;
  }[];
}

/**
 * F-5: both approvals must still describe the freshly re-read intent. The
 * fingerprint is the binding, so a revision, guard, slot, lifecycle, evidence,
 * review-case or action change fails here before any write.
 */
export function evaluateHandoverAbandonmentApprovalFence(
  input: HandoverAbandonmentApprovalState,
  nowIso: string,
): HandoverRecoveryAbandonmentError | null {
  if (input.intentFingerprint !== input.recomputedIntentFingerprint) {
    return new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_STALE,
      "The evidence changed after this intent was approved; request a new approval.",
    );
  }
  if (input.voidedAt !== null) {
    return new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
      "This approval intent was revoked.",
    );
  }
  if (input.consumedAt !== null) {
    return new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.ALREADY_APPLIED,
      "This approval has already been used; recovery is once-only.",
    );
  }
  if (input.storedStatus !== "fully_approved") {
    return new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
      "Both a supervisor and an administrator must approve this intent before it can execute.",
    );
  }
  if (Date.parse(nowIso) >= Date.parse(input.expiresAt)) {
    return new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_EXPIRED,
      "This approval intent has expired; request a new intent.",
    );
  }
  if (input.approvals.length !== 2) {
    return new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
      "A fully approved record must carry exactly two signatures.",
    );
  }
  const [first, second] = input.approvals;
  if (first.actorUid === second.actorUid) {
    return new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
      "Both signatures belong to the same person.",
    );
  }
  if (first.proofFingerprint === second.proofFingerprint) {
    return new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
      "Both signatures reuse one authentication proof.",
    );
  }
  const roles = new Set([first.actorRole, second.actorRole]);
  if (!roles.has("supervisor") || !roles.has("admin")) {
    return new HandoverRecoveryAbandonmentError(
      HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
      "Approvals must contain exactly one supervisor and one administrator.",
    );
  }
  return null;
}
