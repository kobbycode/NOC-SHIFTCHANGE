// Phase 8C.2b — Firestore transactions for the dual-approval substrate.
//
// Each operation does ONE transaction. Every authoritative read happens before
// the first write, the approval document is created exactly once and a second
// signature is appended without ever rewriting the first. Nothing here touches
// an operational collection: no shift, attendance, membership, guard, report,
// acceptance, receipt or review document is written.

import "server-only";

import { FieldValue, type DocumentSnapshot, type DocumentReference, type Transaction } from "firebase-admin/firestore";

import { getAdminFirestore } from "@/lib/firebase/admin";
import { HANDOVER_REVIEW_CASE_SCHEMA, HANDOVER_REVIEW_CASE_STATUSES, type HandoverReviewCaseStatus } from "@/types/handover-admin-review";
import type { EqualHandoverAggregate } from "@/types/equal-technician-handover";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import {
  HANDOVER_RECOVERY_APPROVAL_ACTION,
  HANDOVER_RECOVERY_APPROVAL_COLLECTION,
  HANDOVER_RECOVERY_APPROVAL_EVENTS,
  HANDOVER_RECOVERY_APPROVAL_ROLES,
  HANDOVER_RECOVERY_APPROVAL_SCHEMA,
  HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION,
  HANDOVER_RECOVERY_APPROVAL_STATUSES,
  HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
  type HandoverRecoveryApprovalBinding,
  type HandoverRecoveryApprovalRecord,
  type HandoverRecoveryApprovalRole,
  type HandoverRecoveryApprovalSignature,
  type HandoverRecoveryApprovalView,
} from "@/types/handover-recovery-approval";
import { getOperationalCollections } from "./collections";
import {
  assertEqualHandoverAggregate,
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
} from "./equal-technician-handover-domain";
import { createHandoverReviewCaseId } from "./handover-admin-review-domain";
import {
  HANDOVER_RECOVERY_APPROVAL_INTENT_MAX_AGE_MS,
  HandoverRecoveryApprovalError,
  approvalFail,
  assertApprovalIntentNotExpired,
  assertApprovalSignatureAppendable,
  assertHandoverRecoveryApprovalProof,
  assertHandoverRecoveryApprovalRecord,
  assertRequiredApprovalPair,
  canonicalApprovalMaterial,
  createHandoverRecoveryApprovalAuditId,
  createHandoverRecoveryApprovalId,
  createHandoverRecoveryApprovalProof,
  createHandoverRecoveryApprovalRequestHash,
  createHandoverRecoveryApprovalView,
  createHandoverRecoveryIntentFingerprint,
  createHandoverRecoveryReissueApprovalId,
  type HandoverRecoveryApprovalCountersignIntent,
  type HandoverRecoveryApprovalReissueIntent,
  type HandoverRecoveryApprovalRequestIntent,
  type HandoverRecoveryApprovalVoidIntent,
} from "./handover-recovery-approval-domain";
import { assertHandoverReservationGuard } from "./handover-reservation-guard-domain";
import { readReservationGuardState } from "./handover-reservation-guard";

export interface HandoverRecoveryApprovalAuthentication {
  actorUid: string;
  requestNonce: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  verifiedAtMonotonicMs: number;
  nowIso: string;
  nowMonotonicMs: number;
}

export interface HandoverRecoveryApprovalOutcome {
  replayed: boolean;
  view: HandoverRecoveryApprovalView;
  auditId: string;
}

type TransactionReader = (reference: DocumentReference) => Promise<DocumentSnapshot>;

// The coordinator derives the proof from the authenticated session subject. A
// caller that pairs it with a different actor is refused before any read.
function assertAuthenticationSubject(
  actorUid: string,
  authentication: HandoverRecoveryApprovalAuthentication,
): void {
  if (authentication.actorUid !== actorUid) {
    approvalFail(
      "RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED",
      "The verified authentication subject does not match the session subject.",
    );
  }
}

// ---------------------------------------------------------------------------
// Authoritative reads shared by every operation
// ---------------------------------------------------------------------------

function transactionReader(transaction: Transaction): TransactionReader {
  return (reference) => transaction.get(reference);
}

function assertLiveApprover(data: unknown): HandoverRecoveryApprovalRole {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    approvalFail(
      "RECOVERY_APPROVAL_ROLE_FORBIDDEN",
      "Only a live supervisor or administrator may approve.",
    );
  }
  const profile = data as Record<string, unknown>;
  const role = profile.role;
  if (
    role !== HANDOVER_RECOVERY_APPROVAL_ROLES.SUPERVISOR &&
    role !== HANDOVER_RECOVERY_APPROVAL_ROLES.ADMIN
  ) {
    approvalFail(
      "RECOVERY_APPROVAL_ROLE_FORBIDDEN",
      "Only a supervisor or administrator may approve.",
    );
  }
  if (profile.status !== "active" || profile.statusOperation != null || profile.mustChangePassword === true) {
    approvalFail(
      "RECOVERY_APPROVAL_ROLE_FORBIDDEN",
      "This account is not currently allowed to approve.",
    );
  }
  return role;
}

function readReviewCase(
  snapshot: DocumentSnapshot,
  handoverDocumentId: string,
): {
  caseId: string;
  status: HandoverReviewCaseStatus | "none";
  revision: number;
  fingerprint: string | null;
} {
  if (!snapshot.exists) {
    return {
      caseId: createHandoverReviewCaseId(handoverDocumentId),
      status: "none",
      revision: 0,
      fingerprint: null,
    };
  }
  const value = snapshot.data() as Record<string, unknown> | undefined;
  const caseId = createHandoverReviewCaseId(handoverDocumentId);
  if (
    !value ||
    value.schema !== HANDOVER_REVIEW_CASE_SCHEMA ||
    value.id !== caseId ||
    value.handoverDocumentId !== handoverDocumentId ||
    !Number.isSafeInteger(value.caseRevision) ||
    (value.caseRevision as number) < 1 ||
    typeof value.fingerprintAtLastDecision !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.fingerprintAtLastDecision)
  ) {
    approvalFail(
      "RECOVERY_APPROVAL_STATE_INCONSISTENT",
      "The administrative review case cannot be bound safely.",
    );
  }
  const status = value.status;
  if (
    status !== HANDOVER_REVIEW_CASE_STATUSES.OPEN &&
    status !== HANDOVER_REVIEW_CASE_STATUSES.UNDER_INVESTIGATION &&
    status !== HANDOVER_REVIEW_CASE_STATUSES.ESCALATED &&
    status !== HANDOVER_REVIEW_CASE_STATUSES.CLOSED
  ) {
    approvalFail(
      "RECOVERY_APPROVAL_STATE_INCONSISTENT",
      "The administrative review case has an unsupported status.",
    );
  }
  return {
    caseId,
    status,
    revision: value.caseRevision as number,
    fingerprint: value.fingerprintAtLastDecision,
  };
}

async function readApprovalBinding(
  transaction: Transaction,
  read: TransactionReader,
  handoverDocumentId: string,
): Promise<{
  binding: HandoverRecoveryApprovalBinding;
  outgoingShiftId: string;
  incomingShiftId: string;
}> {
  const { equalHandoversV2, db } = getOperationalCollections();
  const aggregateSnapshot = await read(equalHandoversV2.doc(handoverDocumentId));
  if (!aggregateSnapshot.exists) {
    approvalFail(
      "RECOVERY_APPROVAL_HANDOVER_NOT_FOUND",
      "The handover was not found.",
    );
  }

  let aggregate: EqualHandoverAggregate;
  try {
    aggregate = assertEqualHandoverAggregate(aggregateSnapshot.data());
  } catch {
    approvalFail(
      "RECOVERY_APPROVAL_HANDOVER_UNREADABLE",
      "The handover cannot be bound without administrative review.",
    );
  }

  const outgoingShiftId = aggregate.identity.outgoingShiftId;
  if (createEqualHandoverDocumentId(outgoingShiftId) !== handoverDocumentId) {
    approvalFail(
      "RECOVERY_APPROVAL_HANDOVER_UNREADABLE",
      "The handover document identity does not match its shift.",
    );
  }

  const guardState = await readReservationGuardState(transaction, outgoingShiftId);
  let guard: HandoverReservationGuard | null = null;
  if (guardState.guardSnapshot.exists) {
    try {
      guard = assertHandoverReservationGuard(guardState.guardSnapshot.data());
    } catch {
      approvalFail(
        "RECOVERY_APPROVAL_HANDOVER_UNREADABLE",
        "The reservation guard cannot be bound safely.",
      );
    }
  }

  const reviewCase = readReviewCase(
    await read(db.collection("handover_review_cases_v1").doc(
      createHandoverReviewCaseId(handoverDocumentId),
    )),
    handoverDocumentId,
  );

  return {
    outgoingShiftId,
    incomingShiftId: aggregate.identity.incomingShiftId,
    binding: {
      aggregateRevision: aggregate.revision,
      aggregateSnapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
      aggregateLifecycleStatus: aggregate.lifecycleStatus,
      guardId: guard === null ? null : guard.id,
      guardRevision: guard === null ? 0 : guard.guardRevision,
      fencingEpoch: guard === null ? 0 : guard.fencingEpoch,
      slotToken: aggregate.identity.outgoingSlotToken,
      slotGeneration: aggregate.identity.outgoingGeneration,
      successorSlotToken: aggregate.identity.successorSlotToken,
      successorSlotGeneration: aggregate.identity.successorGeneration,
      reviewCaseId: reviewCase.caseId,
      reviewCaseStatus: reviewCase.status,
      reviewCaseRevision: reviewCase.revision,
      reviewCaseFingerprint: reviewCase.fingerprint,
    },
  };
}

function approvalReference(approvalId: string): DocumentReference {
  return getAdminFirestore().collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION).doc(approvalId);
}

async function readApproval(
  read: TransactionReader,
  approvalId: string,
): Promise<HandoverRecoveryApprovalRecord | null> {
  const snapshot = await read(approvalReference(approvalId));
  if (!snapshot.exists) return null;
  return assertHandoverRecoveryApprovalRecord(snapshot.data(), approvalId);
}

function auditReference(auditId: string): DocumentReference {
  return getAdminFirestore().collection("audit_logs").doc(auditId);
}

function approvalMaterial(record: HandoverRecoveryApprovalRecord): Record<string, unknown> {
  return { ...record };
}

function auditMaterial(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, createdAt: FieldValue.serverTimestamp() };
}

function approvalAudit(input: {
  action: string;
  actorUid: string;
  actorRole: HandoverRecoveryApprovalRole;
  handoverDocumentId: string;
  approvalId: string;
  intentFingerprint: string;
  reason: string;
  details: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return auditMaterial({
    action: input.action,
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    targetHandoverDocumentId: input.handoverDocumentId,
    approvalId: input.approvalId,
    approvalSchemaVersion: HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION,
    approvalAction: HANDOVER_RECOVERY_APPROVAL_ACTION,
    intentFingerprint: input.intentFingerprint,
    reason: input.reason,
    recoveryExecutionEligible: false,
    ...input.extra,
    details: input.details,
  });
}

function replayOutcome(record: HandoverRecoveryApprovalRecord, nowIso: string, auditId: string): HandoverRecoveryApprovalOutcome {
  return {
    replayed: true,
    view: createHandoverRecoveryApprovalView(record, nowIso),
    auditId,
  };
}

function freshOutcome(record: HandoverRecoveryApprovalRecord, nowIso: string, auditId: string): HandoverRecoveryApprovalOutcome {
  return {
    replayed: false,
    view: createHandoverRecoveryApprovalView(record, nowIso),
    auditId,
  };
}

// ---------------------------------------------------------------------------
// Request (first approval, by the requester)
// ---------------------------------------------------------------------------

export async function requestHandoverRecoveryApproval(input: {
  actorUid: string;
  handoverDocumentId: string;
  intent: HandoverRecoveryApprovalRequestIntent;
  authentication: HandoverRecoveryApprovalAuthentication;
}): Promise<HandoverRecoveryApprovalOutcome> {
  assertAuthenticationSubject(input.actorUid, input.authentication);
  const db = getAdminFirestore();
  const nowIso = input.authentication.nowIso;

  let approvalId = "";
  let auditId = "";
  try {
    return await db.runTransaction(async (transaction) => {
      const read = transactionReader(transaction);
      const profile = await read(db.collection("users").doc(input.actorUid));
      const actorRole = assertLiveApprover(profile.data());

      const { binding, outgoingShiftId, incomingShiftId } = await readApprovalBinding(
        transaction,
        read,
        input.handoverDocumentId,
      );
      const intentFingerprint = createHandoverRecoveryIntentFingerprint(binding);
      approvalId = createHandoverRecoveryApprovalId({
        handoverDocumentId: input.handoverDocumentId,
        intentFingerprint,
      });
      auditId = createHandoverRecoveryApprovalAuditId({
        approvalId,
        event: HANDOVER_RECOVERY_APPROVAL_EVENTS.REQUESTED,
      });

      const requestHash = createHandoverRecoveryApprovalRequestHash({
        requestedBy: input.actorUid,
        handoverDocumentId: input.handoverDocumentId,
        intentFingerprint,
        reason: input.intent.reason,
      });

      const existing = await readApproval(read, approvalId);
      const auditSnapshot = await read(auditReference(auditId));

      if (existing !== null) {
        // A voided intent is terminal: repeating the request must never look
        // like a live replay. Reissue is the only way to a new identity.
        if (existing.status === HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED) {
          approvalFail(
            "RECOVERY_APPROVAL_ALREADY_VOIDED",
            existing.reissuedAsApprovalId === null
              ? "This intent was voided. Reissue it to create a new request identity."
              : `This intent was voided and reissued as ${existing.reissuedAsApprovalId}.`,
          );
        }
        if (existing.requestedBy === input.actorUid && existing.requestHash === requestHash) {
          return replayOutcome(existing, nowIso, existing.requestAuditId);
        }
        approvalFail(
          "RECOVERY_APPROVAL_REQUEST_CONFLICT",
          "An approval already exists for this intent. The complementary role must approve it.",
        );
      }
      if (auditSnapshot.exists) {
        approvalFail(
          "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED",
          "A prior approval attempt has an unverified outcome. Verify before trying again.",
        );
      }

      const proof = createHandoverRecoveryApprovalProof({
        actorUid: input.actorUid,
        actorRole,
        intentFingerprint,
        requestNonce: input.authentication.requestNonce,
        verifiedAt: input.authentication.verifiedAt,
        authAccountCheckedAt: input.authentication.authAccountCheckedAt,
        verifiedAtMonotonicMs: input.authentication.verifiedAtMonotonicMs,
      });
      assertHandoverRecoveryApprovalProof({
        proof,
        expectedActorUid: input.actorUid,
        expectedActorRole: actorRole,
        expectedIntentFingerprint: intentFingerprint,
        expectedRequestNonce: input.authentication.requestNonce,
        nowIso,
        nowMonotonicMs: input.authentication.nowMonotonicMs,
      });

      const signature: HandoverRecoveryApprovalSignature = {
        actorUid: input.actorUid,
        actorRole,
        proofFingerprint: proof.proofFingerprint,
        approvedAt: input.authentication.verifiedAt,
        proofExpiresAt: proof.proofExpiresAt,
      };

      const record: HandoverRecoveryApprovalRecord = {
        schema: HANDOVER_RECOVERY_APPROVAL_SCHEMA,
        schemaVersion: HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION,
        id: approvalId,
        action: HANDOVER_RECOVERY_APPROVAL_ACTION,
        handoverDocumentId: input.handoverDocumentId,
        outgoingShiftId,
        incomingShiftId,
        binding,
        intentFingerprint,
        recoveryExecutionEligible: false,
        nonExecutableReason: HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
        reason: input.intent.reason,
        requestedBy: input.actorUid,
        requestedAt: nowIso,
        expiresAt: new Date(
          Date.parse(nowIso) + HANDOVER_RECOVERY_APPROVAL_INTENT_MAX_AGE_MS,
        ).toISOString(),
        approvals: [signature],
        requestHash,
        revision: 1,
        status: HANDOVER_RECOVERY_APPROVAL_STATUSES.AWAITING_SECOND_APPROVAL,
        replacesApprovalId: null,
        reissuedAsApprovalId: null,
        requestAuditId: auditId,
        countersignAuditId: null,
        voidAuditId: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      transaction.create(approvalReference(approvalId), approvalMaterial(record));
      transaction.create(
        auditReference(auditId),
        approvalAudit({
          action: "HANDOVER_RECOVERY_APPROVAL_REQUESTED",
          actorUid: input.actorUid,
          actorRole,
          handoverDocumentId: input.handoverDocumentId,
          approvalId,
          intentFingerprint,
          reason: input.intent.reason,
          details:
            "Requester recorded the first personal approval for a non-executable Version 1 recovery intent; no operational record was changed.",
        }),
      );

      return freshOutcome(record, nowIso, auditId);
    });
  } catch (error) {
    if (
      error instanceof HandoverRecoveryApprovalError ||
      error instanceof Error && error.name === "HandoverRecoveryApprovalInputError"
    ) {
      throw error;
    }
    if (approvalId && auditId) {
      const record = await readApproval(
        (reference) => reference.get(),
        approvalId,
      ).catch(() => null);
      if (record !== null && record.requestedBy === input.actorUid) {
        const expectedHash = createHandoverRecoveryApprovalRequestHash({
          requestedBy: input.actorUid,
          handoverDocumentId: input.handoverDocumentId,
          intentFingerprint: record.intentFingerprint,
          reason: input.intent.reason,
        });
        if (
          record.requestHash === expectedHash &&
          record.status !== HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED
        ) {
          return replayOutcome(record, nowIso, record.requestAuditId);
        }
      }
    }
    approvalFail(
      "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED",
      "The approval outcome could not be confirmed. Verify before trying again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Complementary approval (second signature)
// ---------------------------------------------------------------------------

export async function countersignHandoverRecoveryApproval(input: {
  approvalId: string;
  actorUid: string;
  intent: HandoverRecoveryApprovalCountersignIntent;
  authentication: HandoverRecoveryApprovalAuthentication;
}): Promise<HandoverRecoveryApprovalOutcome> {
  assertAuthenticationSubject(input.actorUid, input.authentication);
  const db = getAdminFirestore();
  const nowIso = input.authentication.nowIso;
  let auditId = "";

  try {
    return await db.runTransaction(async (transaction) => {
      const read = transactionReader(transaction);
      const profile = await read(db.collection("users").doc(input.actorUid));
      const actorRole = assertLiveApprover(profile.data());

      const stored = await readApproval(read, input.approvalId);
      if (stored === null) {
        approvalFail("RECOVERY_APPROVAL_NOT_FOUND", "The approval was not found.");
      }

      auditId = createHandoverRecoveryApprovalAuditId({
        approvalId: input.approvalId,
        event: HANDOVER_RECOVERY_APPROVAL_EVENTS.COUNTERSIGNED,
        discriminator: input.actorUid,
      });
      const auditSnapshot = await read(auditReference(auditId));

      if (stored.status === HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED) {
        approvalFail(
          "RECOVERY_APPROVAL_ALREADY_VOIDED",
          "This approval was voided; it can no longer be signed.",
        );
      }
      if (
        stored.approvals.length === 2 &&
        stored.approvals[1].actorUid === input.actorUid
      ) {
        return replayOutcome(
          stored,
          nowIso,
          stored.countersignAuditId ?? stored.requestAuditId,
        );
      }
      assertApprovalSignatureAppendable({
        approvals: stored.approvals,
        actorUid: input.actorUid,
        actorRole,
      });
      if (input.intent.expectedRevision !== stored.revision) {
        approvalFail(
          "RECOVERY_APPROVAL_STALE",
          "The approval changed since it was inspected. Reload and review again.",
        );
      }
      assertApprovalIntentNotExpired(stored, nowIso);
      if (auditSnapshot.exists) {
        approvalFail(
          "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED",
          "A prior countersignature attempt has an unverified outcome.",
        );
      }

      // The intent must still describe the live authoritative state. A moved
      // binding is refused, never silently rewritten; voiding stays explicit.
      const { binding } = await readApprovalBinding(transaction, read, stored.handoverDocumentId);
      const intentFingerprint = createHandoverRecoveryIntentFingerprint(binding);
      if (
        intentFingerprint !== stored.intentFingerprint ||
        canonicalApprovalMaterial(binding) !== canonicalApprovalMaterial(stored.binding)
      ) {
        approvalFail(
          "RECOVERY_APPROVAL_STALE",
          "The handover state changed after the first approval. Void this intent and request a new one.",
        );
      }

      const proof = createHandoverRecoveryApprovalProof({
        actorUid: input.actorUid,
        actorRole,
        intentFingerprint,
        requestNonce: input.authentication.requestNonce,
        verifiedAt: input.authentication.verifiedAt,
        authAccountCheckedAt: input.authentication.authAccountCheckedAt,
        verifiedAtMonotonicMs: input.authentication.verifiedAtMonotonicMs,
      });
      assertHandoverRecoveryApprovalProof({
        proof,
        expectedActorUid: input.actorUid,
        expectedActorRole: actorRole,
        expectedIntentFingerprint: intentFingerprint,
        expectedRequestNonce: input.authentication.requestNonce,
        nowIso,
        nowMonotonicMs: input.authentication.nowMonotonicMs,
      });

      const signature: HandoverRecoveryApprovalSignature = {
        actorUid: input.actorUid,
        actorRole,
        proofFingerprint: proof.proofFingerprint,
        approvedAt: input.authentication.verifiedAt,
        proofExpiresAt: proof.proofExpiresAt,
      };
      const approvals = [...stored.approvals, signature];
      assertRequiredApprovalPair(approvals);
      const record: HandoverRecoveryApprovalRecord = {
        ...stored,
        approvals,
        revision: 2,
        status: HANDOVER_RECOVERY_APPROVAL_STATUSES.FULLY_APPROVED,
        countersignAuditId: auditId,
        updatedAt: nowIso,
      };

      transaction.update(approvalReference(input.approvalId), {
        approvals,
        revision: record.revision,
        status: record.status,
        countersignAuditId: auditId,
        updatedAt: nowIso,
      });
      transaction.create(
        auditReference(auditId),
        approvalAudit({
          action: "HANDOVER_RECOVERY_APPROVAL_COUNTERSIGNED",
          actorUid: input.actorUid,
          actorRole,
          handoverDocumentId: stored.handoverDocumentId,
          approvalId: input.approvalId,
          intentFingerprint,
          reason: stored.reason,
          extra: { requestedBy: stored.requestedBy, approvals: approvals.length },
          details:
            "The complementary role personally approved the unchanged intent. The first signature was preserved byte-for-byte; the approval remains non-executable.",
        }),
      );

      return freshOutcome(record, nowIso, auditId);
    });
  } catch (error) {
    if (
      error instanceof HandoverRecoveryApprovalError ||
      error instanceof Error && error.name === "HandoverRecoveryApprovalInputError"
    ) {
      throw error;
    }
    const record = await approvalReference(input.approvalId).get().catch(() => null);
    if (record !== null && record.exists) {
      try {
        const stored = assertHandoverRecoveryApprovalRecord(record.data(), input.approvalId);
        if (stored.approvals.some((item) => item.actorUid === input.actorUid)) {
          return replayOutcome(stored, nowIso, stored.countersignAuditId ?? stored.requestAuditId);
        }
      } catch {
        // fall through to the unverified outcome
      }
    }
    approvalFail(
      "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED",
      "The countersignature outcome could not be confirmed. Verify before trying again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Void (terminal)
// ---------------------------------------------------------------------------

export async function voidHandoverRecoveryApproval(input: {
  approvalId: string;
  actorUid: string;
  intent: HandoverRecoveryApprovalVoidIntent;
  authentication: HandoverRecoveryApprovalAuthentication;
}): Promise<HandoverRecoveryApprovalOutcome> {
  assertAuthenticationSubject(input.actorUid, input.authentication);
  const db = getAdminFirestore();
  const nowIso = input.authentication.nowIso;
  let auditId = "";

  try {
    return await db.runTransaction(async (transaction) => {
      const read = transactionReader(transaction);
      const profile = await read(db.collection("users").doc(input.actorUid));
      const actorRole = assertLiveApprover(profile.data());

      const stored = await readApproval(read, input.approvalId);
      if (stored === null) {
        approvalFail("RECOVERY_APPROVAL_NOT_FOUND", "The approval was not found.");
      }

      auditId = createHandoverRecoveryApprovalAuditId({
        approvalId: input.approvalId,
        event: HANDOVER_RECOVERY_APPROVAL_EVENTS.VOIDED,
        discriminator: input.intent.idempotencyKey,
      });
      if (
        stored.status === HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED &&
        stored.voidAuditId === auditId &&
        stored.voidedBy === input.actorUid &&
        stored.voidReason === input.intent.reason
      ) {
        return replayOutcome(stored, nowIso, auditId);
      }
      if (stored.status === HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED) {
        approvalFail(
          "RECOVERY_APPROVAL_ALREADY_VOIDED",
          "This approval is already voided and cannot be changed.",
        );
      }
      if (!stored.approvals.some((item) => item.actorUid === input.actorUid)) {
        approvalFail(
          "RECOVERY_APPROVAL_ROLE_FORBIDDEN",
          "Only a person who approved this intent may void it.",
        );
      }
      if (stored.reissuedAsApprovalId !== null) {
        approvalFail(
          "RECOVERY_APPROVAL_ALREADY_REISSUED",
          `This intent was already reissued as ${stored.reissuedAsApprovalId}.`,
        );
      }

      const auditSnapshot = await read(auditReference(auditId));
      if (auditSnapshot.exists) {
        approvalFail(
          "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED",
          "A prior void attempt has an unverified outcome.",
        );
      }

      const proof = createHandoverRecoveryApprovalProof({
        actorUid: input.actorUid,
        actorRole,
        intentFingerprint: stored.intentFingerprint,
        requestNonce: input.authentication.requestNonce,
        verifiedAt: input.authentication.verifiedAt,
        authAccountCheckedAt: input.authentication.authAccountCheckedAt,
        verifiedAtMonotonicMs: input.authentication.verifiedAtMonotonicMs,
      });
      assertHandoverRecoveryApprovalProof({
        proof,
        expectedActorUid: input.actorUid,
        expectedActorRole: actorRole,
        expectedIntentFingerprint: stored.intentFingerprint,
        expectedRequestNonce: input.authentication.requestNonce,
        nowIso,
        nowMonotonicMs: input.authentication.nowMonotonicMs,
      });

      const record: HandoverRecoveryApprovalRecord = {
        ...stored,
        status: HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED,
        voidAuditId: auditId,
        voidedAt: nowIso,
        voidedBy: input.actorUid,
        voidReason: input.intent.reason,
        updatedAt: nowIso,
      };

      transaction.update(approvalReference(input.approvalId), {
        status: record.status,
        voidAuditId: auditId,
        voidedAt: nowIso,
        voidedBy: input.actorUid,
        voidReason: input.intent.reason,
        updatedAt: nowIso,
      });
      transaction.create(
        auditReference(auditId),
        approvalAudit({
          action: "HANDOVER_RECOVERY_APPROVAL_VOIDED",
          actorUid: input.actorUid,
          actorRole,
          handoverDocumentId: stored.handoverDocumentId,
          approvalId: input.approvalId,
          intentFingerprint: stored.intentFingerprint,
          reason: input.intent.reason,
          extra: { priorApprovalCount: stored.approvals.length },
          details:
            "An approver voided this intent. Voiding is terminal; a future intent requires reissue with a new identity.",
        }),
      );

      return freshOutcome(record, nowIso, auditId);
    });
  } catch (error) {
    if (
      error instanceof HandoverRecoveryApprovalError ||
      error instanceof Error && error.name === "HandoverRecoveryApprovalInputError"
    ) {
      throw error;
    }
    const snapshot = await approvalReference(input.approvalId).get().catch(() => null);
    if (snapshot !== null && snapshot.exists) {
      try {
        const stored = assertHandoverRecoveryApprovalRecord(snapshot.data(), input.approvalId);
        if (stored.voidAuditId === auditId) {
          return replayOutcome(stored, nowIso, auditId);
        }
      } catch {
        // fall through
      }
    }
    approvalFail(
      "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED",
      "The void outcome could not be confirmed. Verify before trying again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Reissue (new identity, preserving the voided original)
// ---------------------------------------------------------------------------

export async function reissueHandoverRecoveryApproval(input: {
  approvalId: string;
  actorUid: string;
  intent: HandoverRecoveryApprovalReissueIntent;
  authentication: HandoverRecoveryApprovalAuthentication;
}): Promise<HandoverRecoveryApprovalOutcome> {
  assertAuthenticationSubject(input.actorUid, input.authentication);
  const db = getAdminFirestore();
  const nowIso = input.authentication.nowIso;
  let newApprovalId = "";
  let auditId = "";

  try {
    return await db.runTransaction(async (transaction) => {
      const read = transactionReader(transaction);
      const profile = await read(db.collection("users").doc(input.actorUid));
      const actorRole = assertLiveApprover(profile.data());

      const original = await readApproval(read, input.approvalId);
      if (original === null) {
        approvalFail("RECOVERY_APPROVAL_NOT_FOUND", "The approval was not found.");
      }
      if (original.status !== HANDOVER_RECOVERY_APPROVAL_STATUSES.VOIDED) {
        approvalFail(
          "RECOVERY_APPROVAL_NOT_VOIDED",
          "Only a voided approval can be reissued.",
        );
      }

      newApprovalId = createHandoverRecoveryReissueApprovalId({
        voidedApprovalId: input.approvalId,
        idempotencyKey: input.intent.idempotencyKey,
      });
      auditId = createHandoverRecoveryApprovalAuditId({
        approvalId: newApprovalId,
        event: HANDOVER_RECOVERY_APPROVAL_EVENTS.REISSUED,
        discriminator: input.approvalId,
      });

      const existing = await readApproval(read, newApprovalId);
      if (existing !== null) {
        if (
          existing.requestedBy === input.actorUid &&
          existing.reason === input.intent.reason &&
          existing.replacesApprovalId === input.approvalId
        ) {
          return replayOutcome(existing, nowIso, existing.requestAuditId);
        }
        approvalFail(
          "RECOVERY_APPROVAL_IDEMPOTENCY_CONFLICT",
          "This reissue identity already exists with a different request.",
        );
      }
      if (
        original.reissuedAsApprovalId !== null &&
        original.reissuedAsApprovalId !== newApprovalId
      ) {
        approvalFail(
          "RECOVERY_APPROVAL_ALREADY_REISSUED",
          `This intent was already reissued as ${original.reissuedAsApprovalId}.`,
        );
      }
      if (original.reissuedAsApprovalId === newApprovalId) {
        approvalFail(
          "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED",
          "The voided original names this reissue, but the reissued record cannot be read.",
        );
      }

      const { binding, outgoingShiftId, incomingShiftId } = await readApprovalBinding(
        transaction,
        read,
        original.handoverDocumentId,
      );
      const intentFingerprint = createHandoverRecoveryIntentFingerprint(binding);
      const requestHash = createHandoverRecoveryApprovalRequestHash({
        requestedBy: input.actorUid,
        handoverDocumentId: original.handoverDocumentId,
        intentFingerprint,
        reason: input.intent.reason,
      });
      const auditSnapshot = await read(auditReference(auditId));
      if (auditSnapshot.exists) {
        approvalFail(
          "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED",
          "A prior reissue attempt has an unverified outcome.",
        );
      }

      const proof = createHandoverRecoveryApprovalProof({
        actorUid: input.actorUid,
        actorRole,
        intentFingerprint,
        requestNonce: input.authentication.requestNonce,
        verifiedAt: input.authentication.verifiedAt,
        authAccountCheckedAt: input.authentication.authAccountCheckedAt,
        verifiedAtMonotonicMs: input.authentication.verifiedAtMonotonicMs,
      });
      assertHandoverRecoveryApprovalProof({
        proof,
        expectedActorUid: input.actorUid,
        expectedActorRole: actorRole,
        expectedIntentFingerprint: intentFingerprint,
        expectedRequestNonce: input.authentication.requestNonce,
        nowIso,
        nowMonotonicMs: input.authentication.nowMonotonicMs,
      });

      const record: HandoverRecoveryApprovalRecord = {
        schema: HANDOVER_RECOVERY_APPROVAL_SCHEMA,
        schemaVersion: HANDOVER_RECOVERY_APPROVAL_SCHEMA_VERSION,
        id: newApprovalId,
        action: HANDOVER_RECOVERY_APPROVAL_ACTION,
        handoverDocumentId: original.handoverDocumentId,
        outgoingShiftId,
        incomingShiftId,
        binding,
        intentFingerprint,
        recoveryExecutionEligible: false,
        nonExecutableReason: HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
        reason: input.intent.reason,
        requestedBy: input.actorUid,
        requestedAt: nowIso,
        expiresAt: new Date(
          Date.parse(nowIso) + HANDOVER_RECOVERY_APPROVAL_INTENT_MAX_AGE_MS,
        ).toISOString(),
        approvals: [
          {
            actorUid: input.actorUid,
            actorRole,
            proofFingerprint: proof.proofFingerprint,
            approvedAt: input.authentication.verifiedAt,
            proofExpiresAt: proof.proofExpiresAt,
          },
        ],
        requestHash,
        revision: 1,
        status: HANDOVER_RECOVERY_APPROVAL_STATUSES.AWAITING_SECOND_APPROVAL,
        replacesApprovalId: input.approvalId,
        reissuedAsApprovalId: null,
        requestAuditId: auditId,
        countersignAuditId: null,
        voidAuditId: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      transaction.create(approvalReference(newApprovalId), approvalMaterial(record));
      transaction.update(approvalReference(input.approvalId), {
        reissuedAsApprovalId: newApprovalId,
        updatedAt: nowIso,
      });
      transaction.create(
        auditReference(auditId),
        approvalAudit({
          action: "HANDOVER_RECOVERY_APPROVAL_REISSUED",
          actorUid: input.actorUid,
          actorRole,
          handoverDocumentId: original.handoverDocumentId,
          approvalId: newApprovalId,
          intentFingerprint,
          reason: input.intent.reason,
          extra: { replacesApprovalId: input.approvalId, voidedIntentFingerprint: original.intentFingerprint },
          details:
            "A new request identity was issued from a voided intent. The voided original is preserved and now names its successor; nothing executable was created.",
        }),
      );

      return freshOutcome(record, nowIso, auditId);
    });
  } catch (error) {
    if (
      error instanceof HandoverRecoveryApprovalError ||
      error instanceof Error && error.name === "HandoverRecoveryApprovalInputError"
    ) {
      throw error;
    }
    if (newApprovalId && auditId) {
      const snapshot = await approvalReference(newApprovalId).get().catch(() => null);
      if (snapshot !== null && snapshot.exists) {
        try {
          const record = assertHandoverRecoveryApprovalRecord(snapshot.data(), newApprovalId);
          if (record.requestedBy === input.actorUid && record.replacesApprovalId === input.approvalId) {
            return replayOutcome(record, nowIso, record.requestAuditId);
          }
        } catch {
          // fall through
        }
      }
    }
    approvalFail(
      "RECOVERY_APPROVAL_OUTCOME_UNVERIFIED",
      "The reissue outcome could not be confirmed. Verify before trying again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export async function readHandoverRecoveryApproval(input: {
  approvalId: string;
  nowIso: string;
}): Promise<HandoverRecoveryApprovalView> {
  const snapshot = await approvalReference(input.approvalId).get();
  if (!snapshot.exists) {
    approvalFail("RECOVERY_APPROVAL_NOT_FOUND", "The approval was not found.");
  }
  const record = assertHandoverRecoveryApprovalRecord(snapshot.data(), input.approvalId);
  return createHandoverRecoveryApprovalView(record, input.nowIso);
}

export async function listHandoverRecoveryApprovals(input: {
  handoverDocumentId: string;
  nowIso: string;
}): Promise<HandoverRecoveryApprovalView[]> {
  const snapshot = await getAdminFirestore()
    .collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION)
    .where("handoverDocumentId", "==", input.handoverDocumentId)
    .limit(50)
    .get();

  const views: HandoverRecoveryApprovalView[] = [];
  for (const document of snapshot.docs) {
    let record: HandoverRecoveryApprovalRecord;
    try {
      record = assertHandoverRecoveryApprovalRecord(document.data(), document.id);
    } catch {
      approvalFail(
        "RECOVERY_APPROVAL_STATE_INCONSISTENT",
        `Approval ${document.id} cannot be read safely.`,
      );
    }
    views.push(createHandoverRecoveryApprovalView(record, input.nowIso));
  }
  return views.sort((left, right) =>
    left.approval.requestedAt === right.approval.requestedAt
      ? left.approval.id.localeCompare(right.approval.id)
      : left.approval.requestedAt.localeCompare(right.approval.requestedAt),
  );
}

export type { HandoverRecoveryApprovalRequestIntent };
export type { HandoverRecoveryApprovalCountersignIntent };
export type { HandoverRecoveryApprovalVoidIntent };
export type { HandoverRecoveryApprovalReissueIntent };
