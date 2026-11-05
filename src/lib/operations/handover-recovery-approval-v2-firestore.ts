// Phase 8C.4B — Firestore transactions for Version 2 dual approval.
//
// Each operation runs ONE transaction. Requesting and countersigning each
// re-read the authoritative evidence and re-run the corrected classifier inside
// that same transaction, so a signature can only ever attach to the intent the
// current evidence actually supports — never to a digest captured beforehand.
//
// Read fan-out is deliberately narrow: one eligibility evaluation per write
// transaction, and the eligibility read model is the single source for every
// binding field, so no operational document is read twice. Voiding, reading and
// listing evaluate nothing at all. That matters because a wide eligibility read
// set contends with live acceptance writers.
//
// Writes are confined to two collections: the Version 2 approval and its audit
// entry. No shift, attendance, membership, guard, report, acceptance, receipt or
// review document is created or modified, and no execution path exists. The
// Version 1 approval collection is never read, migrated or rewritten here.

import "server-only";

import { FieldValue, type DocumentReference, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";

import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  HANDOVER_RECOVERY_APPROVAL_V2_ACTION,
  HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION,
  HANDOVER_RECOVERY_APPROVAL_V2_EVENTS,
  HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON,
  HANDOVER_RECOVERY_APPROVAL_V2_ROLES,
  HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA,
  HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION,
  HANDOVER_RECOVERY_APPROVAL_V2_STATUSES,
  type HandoverRecoveryApprovalV2Binding,
  type HandoverRecoveryApprovalV2Record,
  type HandoverRecoveryApprovalV2Role,
  type HandoverRecoveryApprovalV2Signature,
  type HandoverRecoveryApprovalV2View,
} from "@/types/handover-recovery-approval-v2";
import { canonicalApprovalMaterial } from "./handover-recovery-approval-domain";
import {
  HANDOVER_RECOVERY_APPROVAL_V2_INTENT_MAX_AGE_MS,
  HandoverRecoveryApprovalV2Error,
  approvalV2Fail,
  assertApprovalV2IntentNotExpired,
  assertApprovalV2SignatureAppendable,
  assertHandoverRecoveryApprovalV2Proof,
  assertHandoverRecoveryApprovalV2Record,
  assertRequiredApprovalV2Pair,
  createHandoverRecoveryApprovalV2AuditId,
  createHandoverRecoveryApprovalV2Binding,
  createHandoverRecoveryApprovalV2Id,
  createHandoverRecoveryApprovalV2IntentFingerprint,
  createHandoverRecoveryApprovalV2Proof,
  createHandoverRecoveryApprovalV2ReissueId,
  createHandoverRecoveryApprovalV2RequestHash,
  createHandoverRecoveryApprovalV2View,
  type HandoverRecoveryApprovalV2CountersignIntent,
  type HandoverRecoveryApprovalV2Proof,
  type HandoverRecoveryApprovalV2ReissueIntent,
  type HandoverRecoveryApprovalV2RequestIntent,
  type HandoverRecoveryApprovalV2VoidIntent,
} from "./handover-recovery-approval-v2-domain";
import {
  HandoverRecoveryEligibilityError,
  evaluateHandoverRecoveryEligibilityInTransaction,
  prepareHandoverRecoveryEligibilityRequest,
  type HandoverRecoveryEligibilityTransactionRequest,
} from "./handover-recovery-eligibility-firestore";

export interface HandoverRecoveryApprovalV2Authentication {
  actorUid: string;
  requestNonce: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  verifiedAtMonotonicMs: number;
  nowIso: string;
  nowMonotonicMs: number;
}

export interface HandoverRecoveryApprovalV2Outcome {
  replayed: boolean;
  view: HandoverRecoveryApprovalV2View;
  auditId: string;
}

type TransactionReader = (reference: DocumentReference) => Promise<DocumentSnapshot>;

function assertAuthenticationSubjectV2(
  actorUid: string,
  authentication: HandoverRecoveryApprovalV2Authentication,
): void {
  if (authentication.actorUid !== actorUid) {
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_AUTH_IDENTITY_CHANGED",
      "The verified authentication subject does not match the session subject.",
    );
  }
}

// A transaction failure must never be reported as a fresh refusal if the write
// actually landed, and must never be reported as success if it did not.
function isExpectedV2Failure(error: unknown): boolean {
  return (
    error instanceof HandoverRecoveryApprovalV2Error ||
    (error instanceof Error && error.name === "HandoverRecoveryApprovalV2InputError")
  );
}

// ---------------------------------------------------------------------------
// Authoritative reads shared by every operation
// ---------------------------------------------------------------------------

function transactionReaderV2(transaction: Transaction): TransactionReader {
  return (reference) => transaction.get(reference);
}

function assertLiveApproverV2(data: unknown): HandoverRecoveryApprovalV2Role {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN",
      "Only a live supervisor or administrator may approve.",
    );
  }
  const profile = data as Record<string, unknown>;
  const role = profile.role;
  if (
    role !== HANDOVER_RECOVERY_APPROVAL_V2_ROLES.SUPERVISOR &&
    role !== HANDOVER_RECOVERY_APPROVAL_V2_ROLES.ADMIN
  ) {
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN",
      "Only a supervisor or administrator may approve.",
    );
  }
  if (
    profile.status !== "active" ||
    profile.statusOperation != null ||
    profile.mustChangePassword === true
  ) {
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN",
      "This account is not currently allowed to approve.",
    );
  }
  return role;
}

function eligibilityUnavailable(error: unknown): never {
  if (error instanceof HandoverRecoveryEligibilityError) {
    approvalV2Fail(
      error.code === "ELIGIBILITY_FORBIDDEN"
        ? "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN"
        : error.code === "ELIGIBILITY_INVALID_HANDOVER"
          ? "RECOVERY_APPROVAL_V2_HANDOVER_NOT_FOUND"
          : "RECOVERY_APPROVAL_V2_ELIGIBILITY_UNAVAILABLE",
      error.message,
    );
  }
  throw error;
}

// The whole binding comes from this one evaluation: the digest, the exact
// classification, the aggregate, the guard, the global slot and the review case.
// A binding is never assembled from a cached or caller-supplied digest.
async function bindCurrentRecoveryIntent(
  transaction: Transaction,
  request: HandoverRecoveryEligibilityTransactionRequest,
): Promise<{
  binding: HandoverRecoveryApprovalV2Binding;
  evaluatedAt: string;
  intentFingerprint: string;
}> {
  try {
    const evaluation = await evaluateHandoverRecoveryEligibilityInTransaction(
      transaction,
      request,
    );
    const binding = createHandoverRecoveryApprovalV2Binding(evaluation);
    return {
      binding,
      evaluatedAt: evaluation.result.evaluatedAt,
      intentFingerprint: createHandoverRecoveryApprovalV2IntentFingerprint(binding),
    };
  } catch (error) {
    if (error instanceof HandoverRecoveryApprovalV2Error) throw error;
    eligibilityUnavailable(error);
  }
}

function approvalReferenceV2(approvalId: string): DocumentReference {
  return getAdminFirestore().collection(HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION).doc(approvalId);
}

async function readApprovalV2(
  read: TransactionReader,
  approvalId: string,
): Promise<HandoverRecoveryApprovalV2Record | null> {
  const snapshot = await read(approvalReferenceV2(approvalId));
  if (!snapshot.exists) return null;
  return assertHandoverRecoveryApprovalV2Record(snapshot.data(), approvalId);
}

function auditReferenceV2(auditId: string): DocumentReference {
  return getAdminFirestore().collection("audit_logs").doc(auditId);
}

function approvalMaterialV2(record: HandoverRecoveryApprovalV2Record): Record<string, unknown> {
  return { ...record };
}

function approvalAuditV2(input: {
  action: string;
  actorUid: string;
  actorRole: HandoverRecoveryApprovalV2Role;
  handoverDocumentId: string;
  approvalId: string;
  intentFingerprint: string;
  evidenceDigest: string;
  classification: string;
  reason: string;
  details: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    action: input.action,
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    targetHandoverDocumentId: input.handoverDocumentId,
    approvalId: input.approvalId,
    approvalSchema: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA,
    approvalSchemaVersion: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION,
    approvalAction: HANDOVER_RECOVERY_APPROVAL_V2_ACTION,
    intentFingerprint: input.intentFingerprint,
    evidenceDigest: input.evidenceDigest,
    eligibilityClassification: input.classification,
    reason: input.reason,
    recoveryExecutionEligible: false,
    ...input.extra,
    details: input.details,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function replayOutcomeV2(
  record: HandoverRecoveryApprovalV2Record,
  nowIso: string,
  auditId: string,
): HandoverRecoveryApprovalV2Outcome {
  return { replayed: true, view: createHandoverRecoveryApprovalV2View(record, nowIso), auditId };
}

function freshOutcomeV2(
  record: HandoverRecoveryApprovalV2Record,
  nowIso: string,
  auditId: string,
): HandoverRecoveryApprovalV2Outcome {
  return { replayed: false, view: createHandoverRecoveryApprovalV2View(record, nowIso), auditId };
}

function signatureV2(input: {
  actorUid: string;
  actorRole: HandoverRecoveryApprovalV2Role;
  proof: HandoverRecoveryApprovalV2Proof;
}): HandoverRecoveryApprovalV2Signature {
  return {
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    proofFingerprint: input.proof.proofFingerprint,
    approvedAt: input.proof.verifiedAt,
    proofExpiresAt: input.proof.proofExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Request (first approval, by the requester)
// ---------------------------------------------------------------------------

export async function requestHandoverRecoveryApprovalV2(input: {
  actorUid: string;
  intent: HandoverRecoveryApprovalV2RequestIntent;
  authentication: HandoverRecoveryApprovalV2Authentication;
}): Promise<HandoverRecoveryApprovalV2Outcome> {
  assertAuthenticationSubjectV2(input.actorUid, input.authentication);
  // Validated before any transaction opens, so a bad handover id never takes
  // part in a read.
  const eligibilityRequest = await prepareHandoverRecoveryEligibilityRequest({
    handoverDocumentId: input.intent.handoverDocumentId,
    actorUid: input.actorUid,
    now: new Date(input.authentication.nowIso),
  }).catch(eligibilityUnavailable);

  const db = getAdminFirestore();
  const nowIso = input.authentication.nowIso;
  let approvalId = "";
  let auditId = "";

  try {
    return await db.runTransaction(async (transaction) => {
      const read = transactionReaderV2(transaction);
      const profile = await read(db.collection("users").doc(input.actorUid));
      const actorRole = assertLiveApproverV2(profile.data());

      const { binding, evaluatedAt, intentFingerprint } = await bindCurrentRecoveryIntent(
        transaction,
        eligibilityRequest,
      );
      approvalId = createHandoverRecoveryApprovalV2Id({
        handoverDocumentId: binding.handoverDocumentId,
        intentFingerprint,
      });
      auditId = createHandoverRecoveryApprovalV2AuditId({
        approvalId,
        event: HANDOVER_RECOVERY_APPROVAL_V2_EVENTS.REQUESTED,
      });

      const requestHash = createHandoverRecoveryApprovalV2RequestHash({
        requestedBy: input.actorUid,
        handoverDocumentId: binding.handoverDocumentId,
        intentFingerprint,
        reason: input.intent.reason,
      });

      const existing = await readApprovalV2(read, approvalId);
      const auditSnapshot = await read(auditReferenceV2(auditId));

      if (existing !== null) {
        // A voided intent is terminal: repeating the request must never look
        // like a live replay. Reissue is the only way to a new identity.
        if (existing.status === HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED) {
          approvalV2Fail(
            "RECOVERY_APPROVAL_V2_ALREADY_VOIDED",
            existing.reissuedAsApprovalId === null
              ? "This intent was voided. Reissue it to create a new request identity."
              : `This intent was voided and reissued as ${existing.reissuedAsApprovalId}.`,
          );
        }
        if (
          existing.requestedBy === input.actorUid &&
          existing.requestHash === requestHash
        ) {
          return replayOutcomeV2(existing, nowIso, existing.requestAuditId);
        }
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_REQUEST_CONFLICT",
          "An approval already exists for this intent. The complementary role must approve it.",
        );
      }
      if (auditSnapshot.exists) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED",
          "A prior approval attempt has an unverified outcome. Verify before trying again.",
        );
      }

      const proof = createHandoverRecoveryApprovalV2Proof({
        actorUid: input.actorUid,
        actorRole,
        intentFingerprint,
        requestNonce: input.authentication.requestNonce,
        verifiedAt: input.authentication.verifiedAt,
        authAccountCheckedAt: input.authentication.authAccountCheckedAt,
        verifiedAtMonotonicMs: input.authentication.verifiedAtMonotonicMs,
      });
      assertHandoverRecoveryApprovalV2Proof({
        proof,
        expectedActorUid: input.actorUid,
        expectedActorRole: actorRole,
        expectedIntentFingerprint: intentFingerprint,
        expectedRequestNonce: input.authentication.requestNonce,
        nowIso,
        nowMonotonicMs: input.authentication.nowMonotonicMs,
      });

      const record: HandoverRecoveryApprovalV2Record = {
        schema: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA,
        schemaVersion: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION,
        id: approvalId,
        action: HANDOVER_RECOVERY_APPROVAL_V2_ACTION,
        handoverDocumentId: binding.handoverDocumentId,
        outgoingShiftId: binding.outgoingShiftId,
        incomingShiftId: binding.incomingShiftId,
        binding,
        intentFingerprint,
        recoveryExecutionEligible: false,
        nonExecutableReason: HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON,
        reason: input.intent.reason,
        requestedBy: input.actorUid,
        requestedAt: nowIso,
        expiresAt: new Date(
          Date.parse(nowIso) + HANDOVER_RECOVERY_APPROVAL_V2_INTENT_MAX_AGE_MS,
        ).toISOString(),
        approvals: [
          signatureV2({ actorUid: input.actorUid, actorRole, proof }),
        ],
        requestHash,
        revision: 1,
        status: HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL,
        replacesApprovalId: null,
        reissuedAsApprovalId: null,
        requestAuditId: auditId,
        countersignAuditId: null,
        voidAuditId: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        boundEvaluatedAt: evaluatedAt,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      transaction.create(approvalReferenceV2(approvalId), approvalMaterialV2(record));
      transaction.create(
        auditReferenceV2(auditId),
        approvalAuditV2({
          action: "HANDOVER_RECOVERY_APPROVAL_V2_REQUESTED",
          actorUid: input.actorUid,
          actorRole,
          handoverDocumentId: record.handoverDocumentId,
          approvalId,
          intentFingerprint,
          evidenceDigest: binding.evidence.evidenceDigest,
          classification: binding.evidence.classification,
          reason: input.intent.reason,
          details:
            "A supervisor or administrator personally approved a Version 2 recovery intent that was re-evaluated from authoritative evidence inside this transaction. The approval is non-executable and no operational record was changed.",
        }),
      );

      return freshOutcomeV2(record, nowIso, auditId);
    });
  } catch (error) {
    if (isExpectedV2Failure(error)) throw error;
    if (approvalId && auditId) {
      const record = await readApprovalV2(
        (reference) => reference.get(),
        approvalId,
      ).catch(() => null);
      if (record !== null && record.requestedBy === input.actorUid) {
        const expectedHash = createHandoverRecoveryApprovalV2RequestHash({
          requestedBy: input.actorUid,
          handoverDocumentId: record.handoverDocumentId,
          intentFingerprint: record.intentFingerprint,
          reason: input.intent.reason,
        });
        if (
          record.requestHash === expectedHash &&
          record.status !== HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED
        ) {
          return replayOutcomeV2(record, nowIso, record.requestAuditId);
        }
      }
    }
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED",
      "The approval outcome could not be confirmed. Verify before trying again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Complementary approval (second signature)
// ---------------------------------------------------------------------------

export async function countersignHandoverRecoveryApprovalV2(input: {
  approvalId: string;
  actorUid: string;
  intent: HandoverRecoveryApprovalV2CountersignIntent;
  authentication: HandoverRecoveryApprovalV2Authentication;
}): Promise<HandoverRecoveryApprovalV2Outcome> {
  assertAuthenticationSubjectV2(input.actorUid, input.authentication);
  const db = getAdminFirestore();
  const nowIso = input.authentication.nowIso;
  let auditId = "";

  try {
    return await db.runTransaction(async (transaction) => {
      const read = transactionReaderV2(transaction);
      const profile = await read(db.collection("users").doc(input.actorUid));
      const actorRole = assertLiveApproverV2(profile.data());

      const stored = await readApprovalV2(read, input.approvalId);
      if (stored === null) {
        approvalV2Fail("RECOVERY_APPROVAL_V2_NOT_FOUND", "The approval was not found.");
      }

      auditId = createHandoverRecoveryApprovalV2AuditId({
        approvalId: input.approvalId,
        event: HANDOVER_RECOVERY_APPROVAL_V2_EVENTS.COUNTERSIGNED,
        discriminator: input.actorUid,
      });
      const auditSnapshot = await read(auditReferenceV2(auditId));

      if (stored.status === HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_ALREADY_VOIDED",
          "This approval was voided; it can no longer be signed.",
        );
      }
      if (
        stored.approvals.length === 2 &&
        stored.approvals[1].actorUid === input.actorUid
      ) {
        return replayOutcomeV2(
          stored,
          nowIso,
          stored.countersignAuditId ?? stored.requestAuditId,
        );
      }
      assertApprovalV2SignatureAppendable({
        approvals: stored.approvals,
        actorUid: input.actorUid,
        actorRole,
      });
      if (input.intent.expectedRevision !== stored.revision) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_STALE",
          "The approval changed since it was inspected. Reload and review again.",
        );
      }
      assertApprovalV2IntentNotExpired(stored, nowIso);
      if (auditSnapshot.exists) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED",
          "A prior countersignature attempt has an unverified outcome.",
        );
      }

      // Re-read and reclassify on THIS transaction. Both signatures must refer
      // to the same canonical intent, so anything that moved — the evidence
      // digest, the classification, the aggregate, the guard, the global slot
      // or the review case — refuses the second signature outright. The intent
      // is never silently rewritten to match the new state.
      const eligibilityRequest = await prepareHandoverRecoveryEligibilityRequest({
        handoverDocumentId: stored.handoverDocumentId,
        actorUid: input.actorUid,
        now: new Date(nowIso),
      }).catch(eligibilityUnavailable);
      const { binding, intentFingerprint } = await bindCurrentRecoveryIntent(
        transaction,
        eligibilityRequest,
      );
      if (
        intentFingerprint !== stored.intentFingerprint ||
        canonicalApprovalMaterial(binding) !== canonicalApprovalMaterial(stored.binding)
      ) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_STALE",
          "The authoritative evidence or handover state changed after the first approval. Void this intent and request a new one.",
        );
      }

      const proof = createHandoverRecoveryApprovalV2Proof({
        actorUid: input.actorUid,
        actorRole,
        intentFingerprint,
        requestNonce: input.authentication.requestNonce,
        verifiedAt: input.authentication.verifiedAt,
        authAccountCheckedAt: input.authentication.authAccountCheckedAt,
        verifiedAtMonotonicMs: input.authentication.verifiedAtMonotonicMs,
      });
      assertHandoverRecoveryApprovalV2Proof({
        proof,
        expectedActorUid: input.actorUid,
        expectedActorRole: actorRole,
        expectedIntentFingerprint: intentFingerprint,
        expectedRequestNonce: input.authentication.requestNonce,
        nowIso,
        nowMonotonicMs: input.authentication.nowMonotonicMs,
      });

      const approvals = [
        ...stored.approvals,
        signatureV2({ actorUid: input.actorUid, actorRole, proof }),
      ];
      assertRequiredApprovalV2Pair(approvals);
      const record: HandoverRecoveryApprovalV2Record = {
        ...stored,
        approvals,
        revision: 2,
        status: HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.FULLY_APPROVED,
        countersignAuditId: auditId,
        updatedAt: nowIso,
      };

      transaction.update(approvalReferenceV2(input.approvalId), {
        approvals,
        revision: record.revision,
        status: record.status,
        countersignAuditId: auditId,
        updatedAt: nowIso,
      });
      transaction.create(
        auditReferenceV2(auditId),
        approvalAuditV2({
          action: "HANDOVER_RECOVERY_APPROVAL_V2_COUNTERSIGNED",
          actorUid: input.actorUid,
          actorRole,
          handoverDocumentId: stored.handoverDocumentId,
          approvalId: input.approvalId,
          intentFingerprint,
          evidenceDigest: binding.evidence.evidenceDigest,
          classification: binding.evidence.classification,
          reason: stored.reason,
          extra: { requestedBy: stored.requestedBy, approvals: approvals.length },
          details:
            "The complementary role personally approved the intent after it was re-evaluated from authoritative evidence inside this transaction. The first signature was preserved; the approval remains non-executable and no operational record was changed.",
        }),
      );

      return freshOutcomeV2(record, nowIso, auditId);
    });
  } catch (error) {
    if (isExpectedV2Failure(error)) throw error;
    const snapshot = await approvalReferenceV2(input.approvalId).get().catch(() => null);
    if (snapshot !== null && snapshot.exists) {
      try {
        const stored = assertHandoverRecoveryApprovalV2Record(snapshot.data(), input.approvalId);
        if (stored.approvals.some((item) => item.actorUid === input.actorUid)) {
          return replayOutcomeV2(stored, nowIso, stored.countersignAuditId ?? stored.requestAuditId);
        }
      } catch {
        // fall through to the unverified outcome
      }
    }
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED",
      "The countersignature outcome could not be confirmed. Verify before trying again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Void (terminal)
// ---------------------------------------------------------------------------

// Voiding never re-evaluates eligibility: an intent that no longer matches the
// evidence still has to be closable by a person who signed it.
export async function voidHandoverRecoveryApprovalV2(input: {
  approvalId: string;
  actorUid: string;
  intent: HandoverRecoveryApprovalV2VoidIntent;
  authentication: HandoverRecoveryApprovalV2Authentication;
}): Promise<HandoverRecoveryApprovalV2Outcome> {
  assertAuthenticationSubjectV2(input.actorUid, input.authentication);
  const db = getAdminFirestore();
  const nowIso = input.authentication.nowIso;
  let auditId = "";

  try {
    return await db.runTransaction(async (transaction) => {
      const read = transactionReaderV2(transaction);
      const profile = await read(db.collection("users").doc(input.actorUid));
      const actorRole = assertLiveApproverV2(profile.data());

      const stored = await readApprovalV2(read, input.approvalId);
      if (stored === null) {
        approvalV2Fail("RECOVERY_APPROVAL_V2_NOT_FOUND", "The approval was not found.");
      }

      auditId = createHandoverRecoveryApprovalV2AuditId({
        approvalId: input.approvalId,
        event: HANDOVER_RECOVERY_APPROVAL_V2_EVENTS.VOIDED,
        discriminator: input.intent.idempotencyKey,
      });
      if (
        stored.status === HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED &&
        stored.voidAuditId === auditId &&
        stored.voidedBy === input.actorUid &&
        stored.voidReason === input.intent.reason
      ) {
        return replayOutcomeV2(stored, nowIso, auditId);
      }
      if (stored.status === HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_ALREADY_VOIDED",
          "This approval is already voided and cannot be changed.",
        );
      }
      if (!stored.approvals.some((item) => item.actorUid === input.actorUid)) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN",
          "Only a person who approved this intent may void it.",
        );
      }
      if (stored.reissuedAsApprovalId !== null) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_ALREADY_REISSUED",
          `This intent was already reissued as ${stored.reissuedAsApprovalId}.`,
        );
      }

      const auditSnapshot = await read(auditReferenceV2(auditId));
      if (auditSnapshot.exists) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED",
          "A prior void attempt has an unverified outcome.",
        );
      }

      const proof = createHandoverRecoveryApprovalV2Proof({
        actorUid: input.actorUid,
        actorRole,
        intentFingerprint: stored.intentFingerprint,
        requestNonce: input.authentication.requestNonce,
        verifiedAt: input.authentication.verifiedAt,
        authAccountCheckedAt: input.authentication.authAccountCheckedAt,
        verifiedAtMonotonicMs: input.authentication.verifiedAtMonotonicMs,
      });
      assertHandoverRecoveryApprovalV2Proof({
        proof,
        expectedActorUid: input.actorUid,
        expectedActorRole: actorRole,
        expectedIntentFingerprint: stored.intentFingerprint,
        expectedRequestNonce: input.authentication.requestNonce,
        nowIso,
        nowMonotonicMs: input.authentication.nowMonotonicMs,
      });

      const record: HandoverRecoveryApprovalV2Record = {
        ...stored,
        status: HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED,
        voidAuditId: auditId,
        voidedAt: nowIso,
        voidedBy: input.actorUid,
        voidReason: input.intent.reason,
        updatedAt: nowIso,
      };

      transaction.update(approvalReferenceV2(input.approvalId), {
        status: record.status,
        voidAuditId: auditId,
        voidedAt: nowIso,
        voidedBy: input.actorUid,
        voidReason: input.intent.reason,
        updatedAt: nowIso,
      });
      transaction.create(
        auditReferenceV2(auditId),
        approvalAuditV2({
          action: "HANDOVER_RECOVERY_APPROVAL_V2_VOIDED",
          actorUid: input.actorUid,
          actorRole,
          handoverDocumentId: stored.handoverDocumentId,
          approvalId: input.approvalId,
          intentFingerprint: stored.intentFingerprint,
          evidenceDigest: stored.binding.evidence.evidenceDigest,
          classification: stored.binding.evidence.classification,
          reason: input.intent.reason,
          extra: { priorApprovalCount: stored.approvals.length },
          details:
            "An approver voided this Version 2 intent. Voiding is terminal; a future intent requires reissue with a new identity. No operational record was changed.",
        }),
      );

      return freshOutcomeV2(record, nowIso, auditId);
    });
  } catch (error) {
    if (isExpectedV2Failure(error)) throw error;
    const snapshot = await approvalReferenceV2(input.approvalId).get().catch(() => null);
    if (snapshot !== null && snapshot.exists) {
      try {
        const stored = assertHandoverRecoveryApprovalV2Record(snapshot.data(), input.approvalId);
        if (stored.voidAuditId === auditId) {
          return replayOutcomeV2(stored, nowIso, auditId);
        }
      } catch {
        // fall through
      }
    }
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED",
      "The void outcome could not be confirmed. Verify before trying again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Reissue (new identity, preserving the voided original)
// ---------------------------------------------------------------------------

export async function reissueHandoverRecoveryApprovalV2(input: {
  approvalId: string;
  actorUid: string;
  intent: HandoverRecoveryApprovalV2ReissueIntent;
  authentication: HandoverRecoveryApprovalV2Authentication;
}): Promise<HandoverRecoveryApprovalV2Outcome> {
  assertAuthenticationSubjectV2(input.actorUid, input.authentication);
  const db = getAdminFirestore();
  const nowIso = input.authentication.nowIso;
  let newApprovalId = "";
  let auditId = "";

  try {
    return await db.runTransaction(async (transaction) => {
      const read = transactionReaderV2(transaction);
      const profile = await read(db.collection("users").doc(input.actorUid));
      const actorRole = assertLiveApproverV2(profile.data());

      const original = await readApprovalV2(read, input.approvalId);
      if (original === null) {
        approvalV2Fail("RECOVERY_APPROVAL_V2_NOT_FOUND", "The approval was not found.");
      }
      if (original.status !== HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.VOIDED) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_NOT_VOIDED",
          "Only a voided approval can be reissued.",
        );
      }

      newApprovalId = createHandoverRecoveryApprovalV2ReissueId({
        voidedApprovalId: input.approvalId,
        idempotencyKey: input.intent.idempotencyKey,
      });
      auditId = createHandoverRecoveryApprovalV2AuditId({
        approvalId: newApprovalId,
        event: HANDOVER_RECOVERY_APPROVAL_V2_EVENTS.REISSUED,
        discriminator: input.approvalId,
      });

      const existing = await readApprovalV2(read, newApprovalId);
      if (existing !== null) {
        if (
          existing.requestedBy === input.actorUid &&
          existing.reason === input.intent.reason &&
          existing.replacesApprovalId === input.approvalId
        ) {
          return replayOutcomeV2(existing, nowIso, existing.requestAuditId);
        }
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_IDEMPOTENCY_CONFLICT",
          "This reissue identity already exists with a different request.",
        );
      }
      if (
        original.reissuedAsApprovalId !== null &&
        original.reissuedAsApprovalId !== newApprovalId
      ) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_ALREADY_REISSUED",
          `This intent was already reissued as ${original.reissuedAsApprovalId}.`,
        );
      }
      if (original.reissuedAsApprovalId === newApprovalId) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED",
          "The voided original names this reissue, but the reissued record cannot be read.",
        );
      }

      // A reissued intent is a fresh claim about the current evidence, so it is
      // reclassified here rather than inherited from the voided original.
      const eligibilityRequest = await prepareHandoverRecoveryEligibilityRequest({
        handoverDocumentId: original.handoverDocumentId,
        actorUid: input.actorUid,
        now: new Date(nowIso),
      }).catch(eligibilityUnavailable);
      const { binding, evaluatedAt, intentFingerprint } = await bindCurrentRecoveryIntent(
        transaction,
        eligibilityRequest,
      );
      const requestHash = createHandoverRecoveryApprovalV2RequestHash({
        requestedBy: input.actorUid,
        handoverDocumentId: binding.handoverDocumentId,
        intentFingerprint,
        reason: input.intent.reason,
      });

      const auditSnapshot = await read(auditReferenceV2(auditId));
      if (auditSnapshot.exists) {
        approvalV2Fail(
          "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED",
          "A prior reissue attempt has an unverified outcome.",
        );
      }

      const proof = createHandoverRecoveryApprovalV2Proof({
        actorUid: input.actorUid,
        actorRole,
        intentFingerprint,
        requestNonce: input.authentication.requestNonce,
        verifiedAt: input.authentication.verifiedAt,
        authAccountCheckedAt: input.authentication.authAccountCheckedAt,
        verifiedAtMonotonicMs: input.authentication.verifiedAtMonotonicMs,
      });
      assertHandoverRecoveryApprovalV2Proof({
        proof,
        expectedActorUid: input.actorUid,
        expectedActorRole: actorRole,
        expectedIntentFingerprint: intentFingerprint,
        expectedRequestNonce: input.authentication.requestNonce,
        nowIso,
        nowMonotonicMs: input.authentication.nowMonotonicMs,
      });

      const record: HandoverRecoveryApprovalV2Record = {
        schema: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA,
        schemaVersion: HANDOVER_RECOVERY_APPROVAL_V2_SCHEMA_VERSION,
        id: newApprovalId,
        action: HANDOVER_RECOVERY_APPROVAL_V2_ACTION,
        handoverDocumentId: binding.handoverDocumentId,
        outgoingShiftId: binding.outgoingShiftId,
        incomingShiftId: binding.incomingShiftId,
        binding,
        intentFingerprint,
        recoveryExecutionEligible: false,
        nonExecutableReason: HANDOVER_RECOVERY_APPROVAL_V2_NON_EXECUTABLE_REASON,
        reason: input.intent.reason,
        requestedBy: input.actorUid,
        requestedAt: nowIso,
        expiresAt: new Date(
          Date.parse(nowIso) + HANDOVER_RECOVERY_APPROVAL_V2_INTENT_MAX_AGE_MS,
        ).toISOString(),
        approvals: [
          signatureV2({ actorUid: input.actorUid, actorRole, proof }),
        ],
        requestHash,
        revision: 1,
        status: HANDOVER_RECOVERY_APPROVAL_V2_STATUSES.AWAITING_SECOND_APPROVAL,
        replacesApprovalId: input.approvalId,
        reissuedAsApprovalId: null,
        requestAuditId: auditId,
        countersignAuditId: null,
        voidAuditId: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        boundEvaluatedAt: evaluatedAt,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      transaction.create(approvalReferenceV2(newApprovalId), approvalMaterialV2(record));
      transaction.update(approvalReferenceV2(input.approvalId), {
        reissuedAsApprovalId: newApprovalId,
        updatedAt: nowIso,
      });
      transaction.create(
        auditReferenceV2(auditId),
        approvalAuditV2({
          action: "HANDOVER_RECOVERY_APPROVAL_V2_REISSUED",
          actorUid: input.actorUid,
          actorRole,
          handoverDocumentId: record.handoverDocumentId,
          approvalId: newApprovalId,
          intentFingerprint,
          evidenceDigest: binding.evidence.evidenceDigest,
          classification: binding.evidence.classification,
          reason: input.intent.reason,
          extra: {
            replacesApprovalId: input.approvalId,
            voidedIntentFingerprint: original.intentFingerprint,
          },
          details:
            "A new Version 2 request identity was issued from a voided intent against the evidence re-read in this transaction. The voided original is preserved and now names its successor; nothing executable was created.",
        }),
      );

      return freshOutcomeV2(record, nowIso, auditId);
    });
  } catch (error) {
    if (isExpectedV2Failure(error)) throw error;
    if (newApprovalId && auditId) {
      const snapshot = await approvalReferenceV2(newApprovalId).get().catch(() => null);
      if (snapshot !== null && snapshot.exists) {
        try {
          const record = assertHandoverRecoveryApprovalV2Record(snapshot.data(), newApprovalId);
          if (
            record.requestedBy === input.actorUid &&
            record.replacesApprovalId === input.approvalId
          ) {
            return replayOutcomeV2(record, nowIso, record.requestAuditId);
          }
        } catch {
          // fall through
        }
      }
    }
    approvalV2Fail(
      "RECOVERY_APPROVAL_V2_OUTCOME_UNVERIFIED",
      "The reissue outcome could not be confirmed. Verify before trying again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export async function readHandoverRecoveryApprovalV2(input: {
  approvalId: string;
  nowIso: string;
}): Promise<HandoverRecoveryApprovalV2View> {
  const snapshot = await approvalReferenceV2(input.approvalId).get();
  if (!snapshot.exists) {
    approvalV2Fail("RECOVERY_APPROVAL_V2_NOT_FOUND", "The approval was not found.");
  }
  const record = assertHandoverRecoveryApprovalV2Record(snapshot.data(), input.approvalId);
  return createHandoverRecoveryApprovalV2View(record, input.nowIso);
}

export async function listHandoverRecoveryApprovalsV2(input: {
  handoverDocumentId: string;
  nowIso: string;
}): Promise<HandoverRecoveryApprovalV2View[]> {
  const snapshot = await getAdminFirestore()
    .collection(HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION)
    .where("handoverDocumentId", "==", input.handoverDocumentId)
    .limit(50)
    .get();

  const views: HandoverRecoveryApprovalV2View[] = [];
  for (const document of snapshot.docs) {
    let record: HandoverRecoveryApprovalV2Record;
    try {
      record = assertHandoverRecoveryApprovalV2Record(document.data(), document.id);
    } catch {
      approvalV2Fail(
        "RECOVERY_APPROVAL_V2_STATE_INCONSISTENT",
        `Approval ${document.id} cannot be read safely.`,
      );
    }
    views.push(createHandoverRecoveryApprovalV2View(record, input.nowIso));
  }
  return views.sort((left, right) =>
    left.approval.requestedAt === right.approval.requestedAt
      ? left.approval.id.localeCompare(right.approval.id)
      : left.approval.requestedAt.localeCompare(right.approval.requestedAt),
  );
}

export type { HandoverRecoveryApprovalV2RequestIntent };
export type { HandoverRecoveryApprovalV2CountersignIntent };
export type { HandoverRecoveryApprovalV2VoidIntent };
export type { HandoverRecoveryApprovalV2ReissueIntent };
