// Phase 8B — read-only administrative projection and administrative decision
// persistence.
//
// SECURITY BOUNDARY: this module never writes to an operational collection.
// The only writes it performs are `handover_review_cases_v1`,
// `handover_review_decisions_v1`, the Phase 8C.2a append-only
// `handover_review_adjudications_v1` ledger, and an `audit_logs` attribution
// record. It cannot create an acceptance, receipt, evidence, membership,
// attendance, guard, activation or report record, and it never rewrites a
// timestamp. Phase 8C.2a additionally never updates or deletes an existing
// review case, review decision or adjudication: an adjudication is created
// beside history, and an existing adjudication is only ever replayed or
// refused.

import "server-only";

import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";

import type {
  EqualHandoverAggregate,
} from "@/types/equal-technician-handover";
import type {
  HandoverReservationGuard,
} from "@/types/handover-reservation-guard";
import type {
  IncomingAcceptanceApplicationReceipt,
  IncomingAcceptanceExceptionalClosure,
} from "@/types/incoming-acceptance-application";
import {
  HANDOVER_REVIEW_ADJUDICATION_COLLECTION,
  HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE,
  HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT,
  HANDOVER_REVIEW_ADJUDICATION_SCHEMA,
  HANDOVER_REVIEW_ADJUDICATION_STATUS,
  HANDOVER_REVIEW_CASE_COLLECTION,
  HANDOVER_REVIEW_CASE_SCHEMA,
  HANDOVER_REVIEW_CASE_STATUSES,
  HANDOVER_REVIEW_CLASSIFICATIONS,
  HANDOVER_REVIEW_DECISION_COLLECTION,
  HANDOVER_REVIEW_DECISION_SCHEMA,
  HANDOVER_REVIEW_VERIFICATION_STATUSES,
  type HandoverReviewAdjudicationEligibility,
  type HandoverReviewAdjudicationEvidenceReference,
  type HandoverReviewAdjudicationRecord,
  type HandoverReviewApplicationProjection,
  type HandoverReviewCaseRecord,
  type HandoverReviewCaseStatus,
  type HandoverReviewClassification,
  type HandoverReviewDecisionRecord,
  type HandoverReviewDecisionType,
  type HandoverReviewProjection,
  type HandoverReviewQueueItem,
  type HandoverReviewReason,
  type HandoverReviewVerificationStatus,
} from "@/types/handover-admin-review";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { getOperationalCollections } from "./collections";
import {
  assertEqualHandoverAggregate,
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
  getEqualHandoverPositions,
} from "./equal-technician-handover-domain";
import {
  assertHandoverReservationGuard,
  createHandoverReservationGuardDocumentId,
} from "./handover-reservation-guard-domain";
import {
  assertIncomingAcceptanceActivationReceipt,
  createIncomingAcceptanceActivationReceiptId,
  createIncomingAcceptanceApplicationIdentity,
  type IncomingAcceptanceActivationReceipt,
} from "./incoming-acceptance-application-domain";
import {
  assertReportDocument,
  AtomicAcceptanceServiceError,
  readPersistedReceipt,
} from "./incoming-acceptance-application-firestore";
import {
  IncomingAcceptanceVerificationError,
  verifyIncomingAcceptanceApplication,
} from "./incoming-acceptance-receipt-verification";
import { classifyIncomingAcceptanceGuardLifecycle } from "./incoming-acceptance-guard-lifecycle";
import {
  createGuardFinalizationAuditId,
  GUARD_CLOSURE_AUDIT_ACTION,
  GUARD_FINALIZATION_AUDIT_ACTION,
  GUARD_FINALIZATION_AUDIT_SCHEMA,
} from "./incoming-acceptance-guard-finalization";
import {
  adjudicationIneligible,
  allowedReviewDecisions,
  computeHandoverReviewFingerprint,
  createHandoverReviewAdjudicationAuditId,
  createHandoverReviewAdjudicationId,
  createHandoverReviewAuditId,
  createHandoverReviewCaseId,
  createHandoverReviewDecisionId,
  dedupeReviewReasons,
  evaluateHandoverAdjudicationEligibility,
  evaluateHandoverReviewDecision,
  parseHandoverReviewAdjudicationBody,
  parseHandoverReviewDecisionBody,
  requiresHandoverReview,
  HandoverAdjudicationError,
  HandoverReviewInputError,
  type HandoverReviewDecisionIntent,
} from "./handover-admin-review-domain";

export const HANDOVER_REVIEW_QUEUE_LIMIT = 60;

export class HandoverReviewServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "HandoverReviewServiceError";
  }
}

type SnapshotReader = (ref: DocumentReference) => Promise<DocumentSnapshot>;

function transactionReader(transaction: Transaction): SnapshotReader {
  return (ref) => transaction.get(ref);
}

function documentReader(): SnapshotReader {
  return (ref) => ref.get();
}

function isoFrom(value: unknown): string | null {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function incomingApplicationIdentity(handoverId: string, technicianUid: string) {
  return createIncomingAcceptanceApplicationIdentity({
    handoverId,
    technicianUid,
    kind: "incoming_clock_in",
  });
}

interface ApplicationReadSet {
  technicianUid: string;
  receipt: DocumentSnapshot;
  membership: DocumentSnapshot;
  attendance: DocumentSnapshot;
  audit: DocumentSnapshot;
  evidence: DocumentSnapshot | null;
  operation: DocumentSnapshot | null;
  receiptRecord: IncomingAcceptanceApplicationReceipt | null;
  readError: string | null;
}

export interface HandoverReviewDecisionResult {
  replayed: boolean;
  decision: HandoverReviewDecisionRecord;
  auditId: string;
  projection: HandoverReviewProjection;
}

function mapVerificationFailure(error: unknown): {
  status: HandoverReviewVerificationStatus;
  code: string;
  message: string;
} {
  if (error instanceof IncomingAcceptanceVerificationError) {
    switch (error.code) {
      case "UNRESOLVED_COMMIT":
        return {
          status: HANDOVER_REVIEW_VERIFICATION_STATUSES.COMMIT_UNVERIFIABLE,
          code: error.code,
          message: error.message,
        };
      case "BINDING_CONFLICT":
        return {
          status: HANDOVER_REVIEW_VERIFICATION_STATUSES.BINDING_CONFLICT,
          code: error.code,
          message: error.message,
        };
      default:
        return {
          status: HANDOVER_REVIEW_VERIFICATION_STATUSES.INCONSISTENT,
          code: error.code,
          message: error.message,
        };
    }
  }
  if (error instanceof AtomicAcceptanceServiceError) {
    return {
      status: HANDOVER_REVIEW_VERIFICATION_STATUSES.COMMIT_UNVERIFIABLE,
      code: String(error.code),
      message: error.message,
    };
  }
  return {
    status: HANDOVER_REVIEW_VERIFICATION_STATUSES.INCONSISTENT,
    code: "UNREADABLE_APPLICATION",
    message: "The application records could not be read consistently.",
  };
}

function readCaseRecord(id: string, data: unknown): HandoverReviewCaseRecord | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.schema !== HANDOVER_REVIEW_CASE_SCHEMA) return null;
  if (value.id !== id) return null;
  const status = value.status as HandoverReviewCaseStatus;
  if (
    status !== HANDOVER_REVIEW_CASE_STATUSES.OPEN &&
    status !== HANDOVER_REVIEW_CASE_STATUSES.UNDER_INVESTIGATION &&
    status !== HANDOVER_REVIEW_CASE_STATUSES.ESCALATED &&
    status !== HANDOVER_REVIEW_CASE_STATUSES.CLOSED
  ) {
    return null;
  }
  if (
    typeof value.handoverDocumentId !== "string" ||
    typeof value.outgoingShiftId !== "string" ||
    typeof value.incomingShiftId !== "string" ||
    !Number.isSafeInteger(value.caseRevision) ||
    (value.caseRevision as number) < 1 ||
    !Number.isSafeInteger(value.decisionCount) ||
    (value.decisionCount as number) < 1 ||
    typeof value.createdBy !== "string" ||
    typeof value.fingerprintAtLastDecision !== "string"
  ) {
    return null;
  }
  return {
    id,
    handoverDocumentId: value.handoverDocumentId,
    outgoingShiftId: value.outgoingShiftId,
    incomingShiftId: value.incomingShiftId,
    status,
    caseRevision: value.caseRevision as number,
    classificationAtLastDecision:
      value.classificationAtLastDecision as HandoverReviewClassification,
    fingerprintAtLastDecision: value.fingerprintAtLastDecision,
    createdBy: value.createdBy,
    decisionCount: value.decisionCount as number,
    lastDecisionId: stringOrNull(value.lastDecisionId),
    createdAt: isoFrom(value.createdAt),
    updatedAt: isoFrom(value.updatedAt),
  };
}

function readDecisionRecord(id: string, data: unknown): HandoverReviewDecisionRecord | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.schema !== HANDOVER_REVIEW_DECISION_SCHEMA || value.id !== id) return null;
  if (
    typeof value.caseId !== "string" ||
    typeof value.handoverDocumentId !== "string" ||
    typeof value.decisionType !== "string" ||
    typeof value.actorUid !== "string" ||
    typeof value.reason !== "string" ||
    typeof value.requestHash !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.recordedAt !== "string" ||
    typeof value.evidenceFingerprint !== "string" ||
    !Number.isSafeInteger(value.caseRevisionAfter) ||
    !Number.isSafeInteger(value.expectedCaseRevision) ||
    !Array.isArray(value.reviewReasonCodes)
  ) {
    return null;
  }
  return {
    schema: HANDOVER_REVIEW_DECISION_SCHEMA,
    id,
    caseId: value.caseId,
    handoverDocumentId: value.handoverDocumentId,
    outgoingShiftId: String(value.outgoingShiftId ?? ""),
    incomingShiftId: String(value.incomingShiftId ?? ""),
    decisionType: value.decisionType as HandoverReviewDecisionType,
    actorUid: value.actorUid,
    actorRole: "admin",
    reason: value.reason,
    finding: stringOrNull(value.finding),
    resolutionSummary: stringOrNull(value.resolutionSummary),
    escalationTarget: stringOrNull(value.escalationTarget),
    expectedCaseRevision: value.expectedCaseRevision as number,
    caseRevisionAfter: value.caseRevisionAfter as number,
    caseStatusBefore: value.caseStatusBefore as HandoverReviewCaseStatus,
    caseStatusAfter: value.caseStatusAfter as HandoverReviewCaseStatus,
    evidenceFingerprint: value.evidenceFingerprint,
    classification: value.classification as HandoverReviewClassification,
    reviewReasonCodes: value.reviewReasonCodes.filter(
      (item): item is string => typeof item === "string",
    ),
    requestHash: value.requestHash,
    idempotencyKey: value.idempotencyKey,
    recordedAt: value.recordedAt,
  };
}

async function readParticipantNames(
  read: SnapshotReader,
  technicianUids: string[],
): Promise<Map<string, string | null>> {
  const db = getAdminFirestore();
  const unique = [...new Set(technicianUids)];
  const snapshots = await Promise.all(
    unique.map((uid) => read(db.collection("users").doc(uid))),
  );
  const names = new Map<string, string | null>();
  unique.forEach((uid, index) => {
    const data = snapshots[index].data() as Record<string, unknown> | undefined;
    names.set(uid, typeof data?.fullName === "string" ? data.fullName : null);
  });
  return names;
}

function canonicalIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

// What the guard finalization audit proves about a completed guard. `absent`
// is only legitimate for a normal closure recorded before Phase 4A, which the
// finalization service itself describes as legacy guard-only provenance;
// anything else claims a closure the audit does not support.
type FinalizationEvidenceKind = "absent" | "normal" | "exceptional" | "unverified";

interface FinalizationEvidence {
  present: boolean;
  kind: FinalizationEvidenceKind;
  closure: IncomingAcceptanceExceptionalClosure | null;
}

function unverifiableAudit(): FinalizationEvidence {
  return { present: true, kind: "unverified", closure: null };
}

/**
 * Read-only projection of the guard finalization audit for a completed guard.
 *
 * The audit is the only authoritative exceptional-closure evidence, so a
 * closure is returned only when the record proves it end to end: finalization
 * schema, matching handover and guard, self-consistent terminal reference, and
 * a closure whose subject is a reserved incoming technician. A partial or
 * contradictory record yields `unverified` rather than no evidence, so the
 * completion badge can tell an absent legacy audit from a corrupted one.
 */
async function readFinalizationEvidence(input: {
  read: SnapshotReader;
  auditRef: DocumentReference | null;
  handoverDocumentId: string;
  guard: HandoverReservationGuard | null;
  reservedIncomingTechnicianUids: readonly string[];
}): Promise<FinalizationEvidence> {
  const { guard, auditRef } = input;
  if (
    guard === null ||
    guard.ownerLifecycleState !== "completed" ||
    typeof guard.terminalEvidenceRef !== "string" ||
    guard.terminalEvidenceRef.length === 0 ||
    auditRef === null
  ) {
    return { present: false, kind: "absent", closure: null };
  }
  const snapshot = await input.read(auditRef);
  if (!snapshot.exists) return { present: false, kind: "absent", closure: null };
  const data = snapshot.data() as Record<string, unknown> | undefined;
  if (
    data === undefined ||
    data.schema !== GUARD_FINALIZATION_AUDIT_SCHEMA ||
    data.handoverDocumentId !== input.handoverDocumentId ||
    data.guardId !== guard.id ||
    data.terminalEvidenceRef !== guard.terminalEvidenceRef ||
    typeof data.mode !== "string"
  ) {
    return unverifiableAudit();
  }
  const closure = data.closure as Record<string, unknown> | null | undefined;
  if (data.mode === "normal_closure") {
    if (data.action !== GUARD_FINALIZATION_AUDIT_ACTION || closure !== null) {
      return unverifiableAudit();
    }
    return { present: true, kind: "normal", closure: null };
  }
  if (
    data.mode !== "exceptional_closure" ||
    data.action !== GUARD_CLOSURE_AUDIT_ACTION ||
    closure === undefined ||
    closure === null
  ) {
    return unverifiableAudit();
  }
  const subjectUid = closure.subjectUid;
  if (
    closure.closureId !== guard.terminalEvidenceRef ||
    typeof subjectUid !== "string" ||
    !input.reservedIncomingTechnicianUids.includes(subjectUid) ||
    typeof closure.reason !== "string" ||
    closure.reason.trim().length === 0 ||
    typeof closure.authorizedBy !== "string" ||
    closure.authorizedBy.length === 0 ||
    closure.authorizedBy !== data.authorizedByUid ||
    !canonicalIso(closure.recordedAt)
  ) {
    return unverifiableAudit();
  }
  return {
    present: true,
    kind: "exceptional",
    closure: {
      closureId: guard.terminalEvidenceRef,
      subjectUid,
      authorizedBy: closure.authorizedBy,
      reason: closure.reason.trim(),
      recordedAt: closure.recordedAt,
    },
  };
}

/**
 * Reason code for a completed guard whose terminal reference disagrees with
 * the finalization audit, or null when the audit is compatible with it.
 *
 * A terminal reference equal to the activation receipt is a normal closure and
 * keeps the legacy no-audit path; any other terminal reference is a closure
 * claim that only a verified exceptional audit can support.
 */
function terminalEvidenceConflict(input: {
  kind: FinalizationEvidenceKind;
  terminalRefIsActivationReceipt: boolean;
}): string | null {
  if (input.terminalRefIsActivationReceipt) {
    return input.kind === "normal" || input.kind === "absent"
      ? null
      : "TERMINAL_EVIDENCE_CONTRADICTION";
  }
  if (input.kind === "exceptional") return null;
  if (input.kind === "absent") return "EXCEPTIONAL_CLOSURE_EVIDENCE_MISSING";
  if (input.kind === "normal") return "TERMINAL_EVIDENCE_CONTRADICTION";
  return "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID";
}

function terminalEvidenceMessage(code: string): string {
  if (code === "EXCEPTIONAL_CLOSURE_EVIDENCE_MISSING") {
    return "The guard terminal reference is a closure that has no finalization audit.";
  }
  if (code === "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID") {
    return "The finalization audit for the guard terminal reference is not verifiable.";
  }
  if (code === "TERMINAL_EVIDENCE_CONTRADICTION") {
    return "The finalization audit contradicts the reference stored on the completed guard.";
  }
  return "The completed guard has no terminal evidence reference.";
}

function reason(
  code: string,
  subjectUid: string | null,
  message: string,
): HandoverReviewReason {
  return { code, subjectUid, message };
}

export async function buildHandoverReviewProjection(input: {
  read: SnapshotReader;
  documentId: string;
  nowIso: string;
  caseRecord: HandoverReviewCaseRecord | null;
  decisions?: HandoverReviewDecisionRecord[];
}): Promise<HandoverReviewProjection> {
  const { read, documentId, nowIso } = input;
  const db = getAdminFirestore();
  const {
    equalHandoversV2,
    handoverReservationGuards,
    handoverReportsV2,
    shifts,
  } = getOperationalCollections();

  const aggregateSnapshot = await read(equalHandoversV2.doc(documentId));
  if (!aggregateSnapshot.exists) {
    throw new HandoverReviewServiceError(
      "REVIEW_HANDOVER_NOT_FOUND",
      "The handover was not found.",
      404,
    );
  }

  let aggregate: EqualHandoverAggregate;
  try {
    aggregate = assertEqualHandoverAggregate(aggregateSnapshot.data());
  } catch {
    throw new HandoverReviewServiceError(
      "REVIEW_HANDOVER_UNREADABLE",
      "The handover record is not readable without administrative review.",
      409,
    );
  }
  if (createEqualHandoverDocumentId(aggregate.identity.outgoingShiftId) !== documentId) {
    throw new HandoverReviewServiceError(
      "REVIEW_HANDOVER_UNREADABLE",
      "The handover document identity does not match its shift.",
      409,
    );
  }

  const identity = aggregate.identity;
  const outgoingShiftId = identity.outgoingShiftId;
  const incomingShiftId = identity.incomingShiftId;
  const reservedIncoming = identity.incomingTechnicianIds;
  const activationReceiptId = createIncomingAcceptanceActivationReceiptId(documentId);
  const guardDocumentId = createHandoverReservationGuardDocumentId(outgoingShiftId);
  const caseId = createHandoverReviewCaseId(documentId);

  const applications = reservedIncoming.map((technicianUid) => ({
    technicianUid,
    identity: incomingApplicationIdentity(aggregate.reservation.handoverId, technicianUid),
  }));

  const [
    guardSnapshot,
    activationSnapshot,
    outgoingShiftSnapshot,
    incomingShiftSnapshot,
    reportSnapshot,
    ...applicationSnapshots
  ] = await Promise.all([
    read(handoverReservationGuards.doc(guardDocumentId)),
    read(db.collection("audit_logs").doc(activationReceiptId)),
    read(shifts.doc(outgoingShiftId)),
    read(shifts.doc(incomingShiftId)),
    aggregate.reportBinding === null
      ? Promise.resolve(null as unknown as DocumentSnapshot)
      : read(handoverReportsV2.doc(aggregate.reportBinding.id)),
    ...applications.map((entry) =>
      read(
        db
          .collection("incoming_acceptance_applications_v1")
          .doc(entry.identity.receiptId),
      ),
    ),
    ...applications.map((entry) =>
      read(db.collection("shift_members").doc(`${incomingShiftId}_${entry.technicianUid}`)),
    ),
    ...applications.map((entry) =>
      read(db.collection("shift_attendance").doc(`${incomingShiftId}_${entry.technicianUid}`)),
    ),
    ...applications.map((entry) =>
      read(db.collection("audit_logs").doc(entry.identity.auditId)),
    ),
  ]);

  const receiptSnapshots = applicationSnapshots.slice(0, applications.length) as DocumentSnapshot[];
  const membershipSnapshots = applicationSnapshots.slice(
    applications.length,
    applications.length * 2,
  ) as DocumentSnapshot[];
  const attendanceSnapshots = applicationSnapshots.slice(
    applications.length * 2,
    applications.length * 3,
  ) as DocumentSnapshot[];
  const auditSnapshots = applicationSnapshots.slice(
    applications.length * 3,
  ) as DocumentSnapshot[];

  const participantNames = await readParticipantNames(read, [
    ...identity.outgoingTechnicianIds,
    ...reservedIncoming,
  ]);

  let guard: HandoverReservationGuard | null = null;
  let guardReadable = true;
  if (guardSnapshot.exists) {
    try {
      guard = assertHandoverReservationGuard(guardSnapshot.data());
    } catch {
      guardReadable = false;
    }
  }

  const activationReceiptIdFromDocument = activationReceiptId;
  let activationReceipt: IncomingAcceptanceActivationReceipt | null = null;
  let activationMessage: string | null = null;
  if (activationSnapshot.exists) {
    try {
      assertIncomingAcceptanceActivationReceipt(activationSnapshot.data(), {
        handoverDocumentId: documentId,
        outgoingShiftId,
        incomingShiftId,
        boundReportId: aggregate.reportBinding?.id ?? "",
      });
      activationReceipt =
        activationSnapshot.data() as unknown as IncomingAcceptanceActivationReceipt;
    } catch {
      activationMessage = "The activation receipt does not match this handover.";
    }
  }

  let reportValid = false;
  let reportMessage: string | null = null;
  if (aggregate.reportBinding === null) {
    reportMessage = "The handover is not bound to a frozen report.";
  } else if (reportSnapshot === null || !reportSnapshot.exists) {
    reportMessage = "The frozen report could not be found.";
  } else {
    try {
      assertReportDocument(
        reportSnapshot,
        {
          handoverId: aggregate.reservation.handoverId,
          handoverDocumentId: documentId,
          aggregateRevision: aggregate.revision,
          snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
          report: { ...aggregate.reportBinding, aggregateRevision: aggregate.revision },
          guardRevision: guard?.guardRevision ?? 1,
          fencingEpoch: guard?.fencingEpoch ?? 0,
        },
        aggregate,
      );
      reportValid = true;
    } catch {
      reportMessage = "The frozen report no longer matches the committed handover binding.";
    }
  }

  const readSets: ApplicationReadSet[] = applications.map((entry, index) => {
    let receiptRecord: IncomingAcceptanceApplicationReceipt | null = null;
    let readError: string | null = null;
    if (receiptSnapshots[index].exists) {
      try {
        receiptRecord = readPersistedReceipt(receiptSnapshots[index].data());
        if (receiptRecord.technicianUid !== entry.technicianUid) {
          receiptRecord = null;
          readError = "The application receipt belongs to another technician.";
        }
      } catch (error) {
        readError =
          error instanceof AtomicAcceptanceServiceError
            ? "The application commit marker is unresolved."
            : "The application receipt is malformed.";
      }
    }
    return {
      technicianUid: entry.technicianUid,
      receipt: receiptSnapshots[index],
      membership: membershipSnapshots[index],
      attendance: attendanceSnapshots[index],
      audit: auditSnapshots[index],
      evidence: null,
      operation: null,
      receiptRecord,
      readError,
    };
  });

  await Promise.all(
    readSets.map(async (readSet) => {
      if (readSet.receiptRecord === null) return;
      const [evidence, operation] = await Promise.all([
        read(db.collection("attendance_evidence_v2").doc(readSet.receiptRecord.evidenceId)),
        read(
          db
            .collection("attendance_evidence_operations_v2")
            .doc(readSet.receiptRecord.evidenceOperationId),
        ),
      ]);
      readSet.evidence = evidence;
      readSet.operation = operation;
    }),
  );

  const incomingShift = incomingShiftSnapshot.exists
    ? (incomingShiftSnapshot.data() as Record<string, unknown>)
    : null;
  const outgoingShift = outgoingShiftSnapshot.exists
    ? (outgoingShiftSnapshot.data() as Record<string, unknown>)
    : null;

  const applicationProjections: HandoverReviewApplicationProjection[] = [];
  const reviewReasons: HandoverReviewReason[] = [];

  applications.forEach((entry, index) => {
    const position = getEqualHandoverPositions(identity).find(
      (item) => item.side === "incoming" && item.technicianUid === entry.technicianUid,
    )?.position ?? "incoming_tech_a";
    const readSet = readSets[index];
    const receipt = readSet.receiptRecord;
    const evidencePresent = readSet.evidence?.exists === true;
    const operationData = readSet.operation?.data() as
      | { status?: unknown; interruptedFinalization?: unknown }
      | undefined;
    const operationFinalized = operationData?.status === "finalized";
    const declaredNotYetIn = aggregate.absences.some(
      (item) =>
        item.technicianUid === entry.technicianUid && item.absenceType === "not_yet_in",
    );

    let verificationStatus: HandoverReviewVerificationStatus;
    let verificationCode: string | null = null;
    let verificationMessage: string | null = null;

    if (receipt === null) {
      const artifactsPresent =
        readSet.receipt.exists ||
        evidencePresent ||
        readSet.operation?.exists === true ||
        readSet.membership.exists ||
        readSet.attendance.exists ||
        readSet.audit.exists;
      if (artifactsPresent) {
        verificationStatus = HANDOVER_REVIEW_VERIFICATION_STATUSES.INCONSISTENT;
        verificationCode = "APPLICATION_ARTIFACT_WITHOUT_RECEIPT";
        verificationMessage =
          readSet.readError ?? "Acceptance artifacts exist without a personal receipt.";
      } else {
        verificationStatus = HANDOVER_REVIEW_VERIFICATION_STATUSES.NOT_APPLIED;
        verificationMessage = "No acceptance record exists for this technician.";
      }
    } else if (activationReceipt === null) {
      verificationStatus = HANDOVER_REVIEW_VERIFICATION_STATUSES.INCONSISTENT;
      verificationCode = "ACTIVATION_RECEIPT_MISSING";
      verificationMessage = "A personal receipt exists without a valid activation receipt.";
    } else {
      try {
        verifyIncomingAcceptanceApplication({
          aggregate,
          handoverDocumentId: documentId,
          technicianUid: entry.technicianUid,
          expectedReceiptId: entry.identity.receiptId,
          activationReceipt,
          incomingShift: incomingShift as { id: string; status: string; actualStart: string | null } | null,
          snapshots: {
            receipt: readSet.receipt,
            evidence: readSet.evidence as DocumentSnapshot,
            operation: readSet.operation as DocumentSnapshot,
            membership: readSet.membership,
            attendance: readSet.attendance,
            audit: readSet.audit,
          },
          allowHistoricalDeparture: true,
        });
        verificationStatus = HANDOVER_REVIEW_VERIFICATION_STATUSES.VALIDATED;
        verificationMessage = "Receipt, evidence, participation and audit all validate.";
      } catch (error) {
        const mapped = mapVerificationFailure(error);
        verificationStatus = mapped.status;
        verificationCode = mapped.code;
        verificationMessage = mapped.message;
      }
    }

    if (
      verificationStatus !== HANDOVER_REVIEW_VERIFICATION_STATUSES.VALIDATED &&
      verificationStatus !== HANDOVER_REVIEW_VERIFICATION_STATUSES.NOT_APPLIED
    ) {
      reviewReasons.push(
        reason(
          `APPLICATION_${verificationStatus.toUpperCase()}`,
          entry.technicianUid,
          verificationMessage ?? "The application could not be validated.",
        ),
      );
    }

    applicationProjections.push({
      position,
      technicianUid: entry.technicianUid,
      fullName: participantNames.get(entry.technicianUid) ?? null,
      receiptPresent: receipt !== null,
      receiptId: receipt?.id ?? null,
      receiptHash: receipt?.receiptHash ?? null,
      outcome: receipt?.outcome ?? null,
      operationalAppliedAt: receipt?.operationalAppliedAt ?? null,
      verificationStatus,
      verificationCode,
      verificationMessage,
      evidencePresent,
      operationFinalized,
      membershipPresent: readSet.membership.exists,
      attendancePresent: readSet.attendance.exists,
      applicationAuditPresent: readSet.audit.exists,
      declaredNotYetIn,
    });
  });

  const guardApplications = readSets.map((readSet) => ({
    technicianUid: readSet.technicianUid,
    receipt: readSet.receiptRecord,
    evidencePresent: readSet.evidence?.exists === true,
    operationFinalized:
      (readSet.operation?.data() as { status?: unknown } | undefined)?.status === "finalized",
    membershipPresent: readSet.membership.exists,
    attendancePresent: readSet.attendance.exists,
    declaredNotYetIn: aggregate.absences.some(
      (item) =>
        item.technicianUid === readSet.technicianUid && item.absenceType === "not_yet_in",
    ),
  }));

  const completedTerminalRef =
    guard?.ownerLifecycleState === "completed" ? guard?.terminalEvidenceRef ?? null : null;
  const finalization = await readFinalizationEvidence({
    read,
    auditRef:
      completedTerminalRef === null
        ? null
        : db
            .collection("audit_logs")
            .doc(createGuardFinalizationAuditId(documentId, completedTerminalRef)),
    handoverDocumentId: documentId,
    guard,
    reservedIncomingTechnicianUids: reservedIncoming,
  });

  const guardClassification = classifyIncomingAcceptanceGuardLifecycle({
    handoverDocumentId: documentId,
    aggregateLifecycleStatus: aggregate.lifecycleStatus,
    scheduledStart: identity.scheduledStart,
    scheduledEnd: identity.scheduledEnd,
    nowIso,
    guard,
    activationReceiptId: activationReceipt?.id ?? null,
    activationReceiptHash: activationReceipt?.receiptHash ?? null,
    activationActorUid: activationReceipt?.actorUid ?? null,
    applications: guardApplications,
    exceptionalClosure: finalization.closure,
  });

  const validatedCount = applicationProjections.filter(
    (item) => item.verificationStatus === HANDOVER_REVIEW_VERIFICATION_STATUSES.VALIDATED,
  ).length;
  const invalidApplication = applicationProjections.some(
    (item) =>
      item.verificationStatus !== HANDOVER_REVIEW_VERIFICATION_STATUSES.VALIDATED &&
      item.verificationStatus !== HANDOVER_REVIEW_VERIFICATION_STATUSES.NOT_APPLIED,
  );
  const allNotApplied = applicationProjections.every(
    (item) => item.verificationStatus === HANDOVER_REVIEW_VERIFICATION_STATUSES.NOT_APPLIED,
  );

  let classification: HandoverReviewClassification;
  // Set when a completed guard's terminal evidence cannot support its own
  // lifecycle label, so the guard lifecycle diagnostics stay consistent with
  // the review classification instead of reporting a disproven finalization.
  let terminalEvidenceCode: string | null = null;

  if (
    aggregate.lifecycleStatus === "cancelled" ||
    aggregate.lifecycleStatus === "superseded"
  ) {
    classification = HANDOVER_REVIEW_CLASSIFICATIONS.NOT_REVIEWABLE;
  } else if (aggregate.lifecycleStatus === "collecting_confirmations") {
    classification = HANDOVER_REVIEW_CLASSIFICATIONS.NOT_ACTIVATED;
  } else if (aggregate.lifecycleStatus === "awaiting_incoming_acceptance") {
    classification = allNotApplied
      ? HANDOVER_REVIEW_CLASSIFICATIONS.NOT_ACTIVATED
      : HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
    if (!allNotApplied) {
      reviewReasons.push(
        reason(
          "RECEIPT_BEFORE_ACTIVATION",
          null,
          "Acceptance records exist before the v2 handover completed activation.",
        ),
      );
    }
  } else if (aggregate.lifecycleStatus === "completed") {
    if (guard === null) {
      classification = HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
      reviewReasons.push(
        reason(
          "GUARD_MISSING",
          null,
          guardReadable
            ? "The reservation guard is missing."
            : "The reservation guard could not be read.",
        ),
      );
    } else if (guard.ownerLifecycleState === "cancelled") {
      classification = HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
      reviewReasons.push(
        reason("GUARD_CANCELLED", null, "The reservation guard was cancelled."),
      );
    } else if (guard.ownerLifecycleState === "completed") {
      const terminalRef = guard.terminalEvidenceRef ?? null;
      terminalEvidenceCode =
        terminalRef === null
          ? "TERMINAL_REFERENCE_MISSING"
          : terminalEvidenceConflict({
              kind: finalization.kind,
              terminalRefIsActivationReceipt: terminalRef === activationReceiptIdFromDocument,
            });
      if (terminalEvidenceCode !== null) {
        classification = HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
        reviewReasons.push(
          reason(
            terminalEvidenceCode,
            null,
            terminalEvidenceMessage(terminalEvidenceCode),
          ),
        );
      } else if (terminalRef === activationReceiptIdFromDocument) {
        classification =
          invalidApplication || activationReceipt === null || !reportValid
            ? HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED
            : validatedCount === 2
              ? HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_VALID
              : HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
        if (classification === HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED) {
          if (activationReceipt === null) {
            reviewReasons.push(
              reason(
                "ACTIVATION_RECEIPT_INVALID",
                null,
                activationMessage ?? "The activation receipt is missing or invalid.",
              ),
            );
          }
          if (!reportValid) {
            reviewReasons.push(
              reason(
                "REPORT_BINDING_CONFLICT",
                null,
                reportMessage ?? "The frozen report binding is not valid.",
              ),
            );
          }
          if (validatedCount !== 2 && !invalidApplication) {
            reviewReasons.push(
              reason(
                "PERSONAL_RECEIPT_INCOMPLETE",
                null,
                "The guard was finalized without two validated personal receipts.",
              ),
            );
          }
        }
      } else {
        const subject = applicationProjections.find(
          (item) => item.verificationStatus !== HANDOVER_REVIEW_VERIFICATION_STATUSES.VALIDATED,
        );
        const subjectReadSet = readSets.find(
          (item) => item.technicianUid === subject?.technicianUid,
        );
        const subjectAbsent =
          subject !== undefined &&
          subject.verificationStatus === HANDOVER_REVIEW_VERIFICATION_STATUSES.NOT_APPLIED &&
          subject.declaredNotYetIn &&
          subjectReadSet !== undefined &&
          !subjectReadSet.receipt.exists &&
          !subjectReadSet.membership.exists &&
          !subjectReadSet.attendance.exists &&
          !subjectReadSet.audit.exists &&
          subjectReadSet.evidence?.exists !== true &&
          subjectReadSet.operation?.exists !== true;
        classification =
          validatedCount === 1 && subjectAbsent && activationReceipt !== null && reportValid
            ? HANDOVER_REVIEW_CLASSIFICATIONS.COMPLETED_EXCEPTIONAL
            : HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
        if (classification === HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED) {
          reviewReasons.push(
            reason(
              "EXCEPTIONAL_CLOSURE_UNPROVEN",
              subject?.technicianUid ?? null,
              "The exceptional guard closure is not backed by a valid absence and clean personal outcomes.",
            ),
          );
        }
      }
    } else if (invalidApplication) {
      classification = HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
    } else {
      switch (guardClassification.state) {
        case "eligible_for_normal_closure":
          classification = HANDOVER_REVIEW_CLASSIFICATIONS.ELIGIBLE_FOR_NORMAL_CLOSURE;
          break;
        case "joining_window_expired":
          classification = HANDOVER_REVIEW_CLASSIFICATIONS.JOINING_WINDOW_EXPIRED;
          reviewReasons.push(
            reason(
              "JOIN_WINDOW_CLOSED",
              null,
              "The incoming joining window closed before both technicians applied.",
            ),
          );
          for (const uid of guardClassification.missingTechnicianUids) {
            reviewReasons.push(
              reason(
                "PERSONAL_ACCEPTANCE_MISSING",
                uid,
                "The reserved technician has no validated personal acceptance.",
              ),
            );
          }
          break;
        case "awaiting_partner_acceptance":
          classification = HANDOVER_REVIEW_CLASSIFICATIONS.AWAITING_PARTNER_ACCEPTANCE;
          break;
        case "inconsistent_review_required":
          classification = HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
          reviewReasons.push(
            reason(
              guardClassification.reason,
              null,
              "The guard lifecycle is inconsistent with the handover evidence.",
            ),
          );
          break;
        default:
          classification = HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
          reviewReasons.push(
            reason(
              guardClassification.reason,
              null,
              "The guard lifecycle cannot be proven from the persisted evidence.",
            ),
          );
          break;
      }
    }

    if (!reportValid && classification !== HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED) {
      classification = HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
      reviewReasons.push(
        reason(
          "REPORT_BINDING_CONFLICT",
          null,
          reportMessage ?? "The frozen report binding is not valid.",
        ),
      );
    }
    if (
      activationReceipt === null &&
      !allNotApplied &&
      classification !== HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED
    ) {
      classification = HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED;
      reviewReasons.push(
        reason(
          "ACTIVATION_RECEIPT_INVALID",
          null,
          activationMessage ?? "The activation receipt is missing or invalid.",
        ),
      );
    }
  } else {
    classification = HANDOVER_REVIEW_CLASSIFICATIONS.NOT_REVIEWABLE;
  }

  if (
    classification === HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED &&
    reviewReasons.length === 0
  ) {
    reviewReasons.push(
      reason(
        "REVIEW_INCONSISTENCY",
        null,
        "The persisted evidence is internally inconsistent and requires review.",
      ),
    );
  }

  const dedupedReasons = dedupeReviewReasons(reviewReasons);

  const finalizationAuditPresent = finalization.present;

  const participants = getEqualHandoverPositions(identity).map((item) => ({
    position: item.position,
    side: item.side,
    technicianUid: item.technicianUid,
    fullName: participantNames.get(item.technicianUid) ?? null,
  }));

  const caseStatus =
    input.caseRecord?.status ?? HANDOVER_REVIEW_CASE_STATUSES.OPEN;
  const caseRevision = input.caseRecord?.caseRevision ?? 0;

  const evidenceFingerprint = computeHandoverReviewFingerprint({
    handoverDocumentId: documentId,
    aggregateRevision: aggregate.revision,
    aggregateLifecycleStatus: aggregate.lifecycleStatus,
    guard:
      guard === null
        ? null
        : {
            id: guard.id,
            ownerLifecycleState: guard.ownerLifecycleState,
            guardRevision: guard.guardRevision,
            fencingEpoch: guard.fencingEpoch,
            terminalEvidenceRef: guard.terminalEvidenceRef ?? null,
          },
    activation: {
      receiptId: activationReceipt?.id ?? null,
      receiptHash: activationReceipt?.receiptHash ?? null,
      valid: activationReceipt !== null,
    },
    report: {
      reportId: aggregate.reportBinding?.id ?? null,
      digest: aggregate.reportBinding?.digest ?? null,
      valid: reportValid,
    },
    applications: applicationProjections.map((item) => ({
      technicianUid: item.technicianUid,
      receiptId: item.receiptId,
      receiptHash: item.receiptHash,
      outcome: item.outcome,
      operationalAppliedAt: item.operationalAppliedAt,
      verificationStatus: item.verificationStatus,
      verificationCode: item.verificationCode,
      evidencePresent: item.evidencePresent,
      operationFinalized: item.operationFinalized,
      membershipPresent: item.membershipPresent,
      attendancePresent: item.attendancePresent,
      applicationAuditPresent: item.applicationAuditPresent,
      declaredNotYetIn: item.declaredNotYetIn,
    })),
    classification,
    reviewReasonCodes: dedupedReasons.map((item) => item.code),
  });

  return {
    caseId,
    handoverDocumentId: documentId,
    handoverId: aggregate.reservation.handoverId,
    outgoingShiftId,
    incomingShiftId,
    shiftType: identity.shiftType,
    scheduledStart: identity.scheduledStart,
    scheduledEnd: identity.scheduledEnd,
    aggregateRevision: aggregate.revision,
    aggregateLifecycleStatus: aggregate.lifecycleStatus,
    aggregateUpdatedAt: aggregate.updatedAt,
    guardLifecycleState:
      terminalEvidenceCode === null
        ? guardClassification.state
        : "inconsistent_review_required",
    guardLifecycleReason: terminalEvidenceCode ?? guardClassification.reason,
    report: {
      present: reportSnapshot !== null && reportSnapshot.exists,
      valid: reportValid,
      reportId: aggregate.reportBinding?.id ?? null,
      digest: aggregate.reportBinding?.digest ?? null,
      evidenceSnapshotHash: aggregate.reportBinding?.evidenceSnapshotHash ?? null,
      message: reportMessage,
    },
    guard:
      guard === null
        ? null
        : {
            id: guard.id,
            ownerHandoverDocumentId: guard.ownerHandoverDocumentId,
            protocolOwner: guard.protocolOwner,
            ownerLifecycleState: guard.ownerLifecycleState,
            guardRevision: guard.guardRevision,
            fencingEpoch: guard.fencingEpoch,
            terminalEvidenceRef: guard.terminalEvidenceRef ?? null,
            reservedAt: guard.reservedAt,
            finalizationAuditPresent,
          },
    activation: {
      receiptId: activationReceiptIdFromDocument,
      present: activationSnapshot.exists,
      valid: activationReceipt !== null,
      receiptHash: activationReceipt?.receiptHash ?? null,
      actorUid: activationReceipt?.actorUid ?? null,
      activatedAt: activationReceipt?.activatedAt ?? null,
      boundReportId: activationReceipt?.boundReportId ?? null,
      message: activationMessage,
    },
    participants,
    applications: applicationProjections,
    absences: aggregate.absences.map((item) => ({
      technicianUid: item.technicianUid,
      absenceType: item.absenceType,
      reason: item.reason,
      recordedBy: item.recordedBy,
      recordedAt: item.recordedAt,
    })),
    shifts: {
      outgoing: {
        shiftId: outgoingShiftId,
        status: stringOrNull(outgoingShift?.status),
        actualStart: stringOrNull(outgoingShift?.actualStart),
        actualEnd: stringOrNull(outgoingShift?.actualEnd),
      },
      incoming: {
        shiftId: incomingShiftId,
        status: stringOrNull(incomingShift?.status),
        actualStart: stringOrNull(incomingShift?.actualStart),
        actualEnd: stringOrNull(incomingShift?.actualEnd),
      },
    },
    classification,
    reviewReasons: dedupedReasons,
    requiresReview: requiresHandoverReview({
      classification,
      caseStatus,
    }),
    evidenceFingerprint,
    generatedAt: nowIso,
    caseStatus,
    caseRevision,
    caseRecord: input.caseRecord,
    allowedDecisions: allowedReviewDecisions({ caseStatus, classification }),
    decisions: input.decisions ?? [],
  };
}

async function readCaseByDocumentId(
  read: SnapshotReader,
  documentId: string,
): Promise<HandoverReviewCaseRecord | null> {
  const db = getAdminFirestore();
  const caseId = createHandoverReviewCaseId(documentId);
  const snapshot = await read(
    db.collection(HANDOVER_REVIEW_CASE_COLLECTION).doc(caseId),
  );
  if (!snapshot.exists) return null;
  const record = readCaseRecord(caseId, snapshot.data());
  if (record === null) {
    throw new HandoverReviewServiceError(
      "REVIEW_CASE_UNREADABLE",
      "The administrative review case record is unreadable.",
      409,
    );
  }
  return record;
}

async function readDecisionHistory(
  documentId: string,
): Promise<HandoverReviewDecisionRecord[]> {
  const db = getAdminFirestore();
  const caseId = createHandoverReviewCaseId(documentId);
  const snapshot = await db
    .collection(HANDOVER_REVIEW_DECISION_COLLECTION)
    .where("caseId", "==", caseId)
    .get();
  const decisions: HandoverReviewDecisionRecord[] = [];
  for (const document of snapshot.docs) {
    const record = readDecisionRecord(document.id, document.data());
    if (record !== null) decisions.push(record);
  }
  return decisions.sort((left, right) =>
    left.recordedAt === right.recordedAt
      ? left.id.localeCompare(right.id)
      : left.recordedAt.localeCompare(right.recordedAt),
  );
}

export async function readHandoverReviewCase(input: {
  handoverDocumentId: string;
  nowIso: string;
}): Promise<HandoverReviewProjection> {
  const read = documentReader();
  const caseRecord = await readCaseByDocumentId(read, input.handoverDocumentId);
  const decisions = await readDecisionHistory(input.handoverDocumentId);
  return buildHandoverReviewProjection({
    read,
    documentId: input.handoverDocumentId,
    nowIso: input.nowIso,
    caseRecord,
    decisions,
  });
}

export async function listHandoverReviewQueue(input: {
  nowIso: string;
}): Promise<HandoverReviewQueueItem[]> {
  const read = documentReader();
  const { equalHandoversV2 } = getOperationalCollections();
  const snapshot = await equalHandoversV2
    .where("lifecycleStatus", "in", ["awaiting_incoming_acceptance", "completed"])
    .limit(HANDOVER_REVIEW_QUEUE_LIMIT * 2)
    .get();

  const items: HandoverReviewQueueItem[] = [];
  for (const document of snapshot.docs) {
    try {
      const caseRecord = await readCaseByDocumentId(read, document.id);
      const projection = await buildHandoverReviewProjection({
        read,
        documentId: document.id,
        nowIso: input.nowIso,
        caseRecord,
      });
      if (!projection.requiresReview && projection.aggregateLifecycleStatus !== "completed") {
        continue;
      }
      items.push({
        caseId: projection.caseId,
        handoverDocumentId: projection.handoverDocumentId,
        outgoingShiftId: projection.outgoingShiftId,
        incomingShiftId: projection.incomingShiftId,
        shiftType: projection.shiftType,
        scheduledStart: projection.scheduledStart,
        scheduledEnd: projection.scheduledEnd,
        aggregateLifecycleStatus: projection.aggregateLifecycleStatus,
        guardLifecycleState: projection.guardLifecycleState,
        guardLifecycleReason: projection.guardLifecycleReason,
        classification: projection.classification,
        reviewReasons: projection.reviewReasons,
        participants: projection.participants,
        caseStatus: projection.caseStatus,
        caseRevision: projection.caseRevision,
        evidenceFingerprint: projection.evidenceFingerprint,
        updatedAt:
          projection.caseRecord?.updatedAt ?? projection.aggregateUpdatedAt,
      });
    } catch (error) {
      if (error instanceof HandoverReviewServiceError && error.status === 404) continue;
      // An unreadable handover is reported through its own detail lookup; a
      // single unreadable record must not hide the rest of the queue.
      console.error("Handover review queue item skipped:", {
        handoverDocumentId: document.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  const rank: Record<string, number> = {
    [HANDOVER_REVIEW_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED]: 0,
    [HANDOVER_REVIEW_CLASSIFICATIONS.JOINING_WINDOW_EXPIRED]: 1,
  };
  return items
    .sort((left, right) => {
      const leftRank = left.caseStatus === HANDOVER_REVIEW_CASE_STATUSES.CLOSED
        ? 3
        : rank[left.classification] ?? 2;
      const rightRank = right.caseStatus === HANDOVER_REVIEW_CASE_STATUSES.CLOSED
        ? 3
        : rank[right.classification] ?? 2;
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (left.scheduledEnd !== right.scheduledEnd) {
        return left.scheduledEnd.localeCompare(right.scheduledEnd);
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, HANDOVER_REVIEW_QUEUE_LIMIT);
}

function assertLiveAdminProfile(data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HandoverReviewServiceError(
      "REVIEW_UNAUTHORIZED",
      "Only an active administrator can review handovers.",
      403,
    );
  }
  const profile = data as Record<string, unknown>;
  if (
    profile.role !== "admin" ||
    profile.status !== "active" ||
    profile.statusOperation != null ||
    profile.mustChangePassword !== false
  ) {
    throw new HandoverReviewServiceError(
      "REVIEW_UNAUTHORIZED",
      "Only an active administrator can review handovers.",
      403,
    );
  }
}

export async function recordHandoverReviewDecision(input: {
  handoverDocumentId: string;
  actorUid: string;
  body: unknown;
  nowIso: string;
}): Promise<HandoverReviewDecisionResult> {
  const intent: HandoverReviewDecisionIntent = parseHandoverReviewDecisionBody(input.body);
  const db = getAdminFirestore();
  const caseId = createHandoverReviewCaseId(input.handoverDocumentId);
  const decisionId = createHandoverReviewDecisionId(
    caseId,
    intent.idempotencyKey,
  );
  const auditId = createHandoverReviewAuditId(decisionId);

  return db.runTransaction(async (transaction) => {
    const read = transactionReader(transaction);

    const actorSnapshot = await read(db.collection("users").doc(input.actorUid));
    assertLiveAdminProfile(actorSnapshot.data());

    const caseRef = db.collection(HANDOVER_REVIEW_CASE_COLLECTION).doc(caseId);
    const decisionRef = db
      .collection(HANDOVER_REVIEW_DECISION_COLLECTION)
      .doc(decisionId);
    const auditRef = db.collection("audit_logs").doc(auditId);

    const [caseSnapshot, decisionSnapshot] = await Promise.all([
      read(caseRef),
      read(decisionRef),
    ]);

    let caseRecord: HandoverReviewCaseRecord | null = null;
    if (caseSnapshot.exists) {
      caseRecord = readCaseRecord(caseId, caseSnapshot.data());
      if (caseRecord === null) {
        throw new HandoverReviewServiceError(
          "REVIEW_CASE_UNREADABLE",
          "The administrative review case record is unreadable.",
          409,
        );
      }
    }

    const projection = await buildHandoverReviewProjection({
      read,
      documentId: input.handoverDocumentId,
      nowIso: input.nowIso,
      caseRecord,
    });

    if (decisionSnapshot.exists) {
      const stored = readDecisionRecord(decisionId, decisionSnapshot.data());
      if (
        stored === null ||
        stored.actorUid !== input.actorUid ||
        stored.requestHash !== intent.requestHash
      ) {
        throw new HandoverReviewServiceError(
          "REVIEW_IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used for a different review decision.",
          409,
        );
      }
      return {
        replayed: true,
        decision: stored,
        auditId,
      };
    }

    if (projection.caseRevision !== intent.expectedCaseRevision) {
      throw new HandoverReviewServiceError(
        "REVIEW_DECISION_STALE",
        "The review case changed since it was inspected. Refresh and review again.",
        409,
      );
    }
    if (projection.evidenceFingerprint !== intent.expectedFingerprint) {
      throw new HandoverReviewServiceError(
        "REVIEW_DECISION_STALE",
        "The handover evidence changed since it was inspected. Refresh and review again.",
        409,
      );
    }

    const caseStatusBefore = projection.caseStatus;
    const outcome = evaluateHandoverReviewDecision({
      intent,
      caseStatus: caseStatusBefore,
      classification: projection.classification,
      allowed: projection.allowedDecisions,
    });
    const caseRevisionAfter = projection.caseRevision + 1;
    const decisionRecord: HandoverReviewDecisionRecord = {
      schema: HANDOVER_REVIEW_DECISION_SCHEMA,
      id: decisionId,
      caseId,
      handoverDocumentId: input.handoverDocumentId,
      outgoingShiftId: projection.outgoingShiftId,
      incomingShiftId: projection.incomingShiftId,
      decisionType: intent.decisionType,
      actorUid: input.actorUid,
      actorRole: "admin",
      reason: intent.reason,
      finding: intent.finding,
      resolutionSummary: intent.resolutionSummary,
      escalationTarget: intent.escalationTarget,
      expectedCaseRevision: intent.expectedCaseRevision,
      caseRevisionAfter,
      caseStatusBefore,
      caseStatusAfter: outcome.statusAfter,
      evidenceFingerprint: projection.evidenceFingerprint,
      classification: projection.classification,
      reviewReasonCodes: projection.reviewReasons.map((item) => item.code),
      requestHash: intent.requestHash,
      idempotencyKey: intent.idempotencyKey,
      recordedAt: input.nowIso,
    };

    const caseMaterial = {
      schema: HANDOVER_REVIEW_CASE_SCHEMA,
      id: caseId,
      handoverDocumentId: input.handoverDocumentId,
      outgoingShiftId: projection.outgoingShiftId,
      incomingShiftId: projection.incomingShiftId,
      status: outcome.statusAfter,
      caseRevision: caseRevisionAfter,
      classificationAtLastDecision: projection.classification,
      fingerprintAtLastDecision: projection.evidenceFingerprint,
      lastDecisionId: decisionId,
      decisionCount: (caseRecord?.decisionCount ?? 0) + 1,
      resolution: outcome.resolution,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (caseRecord === null) {
      transaction.create(caseRef, {
        ...caseMaterial,
        createdBy: input.actorUid,
        createdAt: FieldValue.serverTimestamp(),
      });
    } else {
      transaction.update(caseRef, caseMaterial);
    }

    transaction.create(decisionRef, {
      ...decisionRecord,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.create(auditRef, {
      action: `HANDOVER_REVIEW_${intent.decisionType.toUpperCase()}`,
      actorUid: input.actorUid,
      actorRole: "admin",
      targetHandoverDocumentId: input.handoverDocumentId,
      caseId,
      decisionId,
      decisionType: intent.decisionType,
      reason: intent.reason,
      finding: intent.finding,
      resolutionSummary: intent.resolutionSummary,
      escalationTarget: intent.escalationTarget,
      classification: projection.classification,
      evidenceFingerprint: projection.evidenceFingerprint,
      caseStatusBefore,
      caseStatusAfter: outcome.statusAfter,
      caseRevisionAfter,
      createdAt: FieldValue.serverTimestamp(),
      details:
        "Administrator recorded a handover review decision; no operational evidence was changed.",
    });

    return {
      replayed: false,
      decision: decisionRecord,
      auditId,
    };
  }).then(async (committed) => ({
    ...committed,
    projection: await readHandoverReviewCase({
      handoverDocumentId: input.handoverDocumentId,
      nowIso: input.nowIso,
    }),
  }));
}

// ===========================================================================
// Phase 8C.2a — append-only historical adjudication.
// ===========================================================================

function adjudicationMaterial(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function readAdjudicationRecord(
  id: string,
  data: unknown,
): HandoverReviewAdjudicationRecord | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.schema !== HANDOVER_REVIEW_ADJUDICATION_SCHEMA || value.id !== id) return null;
  if (
    value.status !== HANDOVER_REVIEW_ADJUDICATION_STATUS ||
    value.operationalEffect !== HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT ||
    value.actorRole !== "admin"
  ) {
    return null;
  }
  const strings = [
    "caseId",
    "handoverDocumentId",
    "outgoingShiftId",
    "incomingShiftId",
    "originalDecisionId",
    "originalDecisionType",
    "originalDecisionActorUid",
    "originalDecisionRecordedAt",
    "originalDecisionFingerprint",
    "originalDecisionClassification",
    "originalCaseStatus",
    "currentClassification",
    "currentEvidenceDigest",
    "actorUid",
    "finding",
    "requestHash",
    "idempotencyKey",
    "auditId",
    "adjudicatedAt",
  ];
  for (const key of strings) {
    if (typeof value[key] !== "string") return null;
  }
  if (
    !Number.isSafeInteger(value.originalCaseRevision) ||
    !Array.isArray(value.contradictionReasonCodes) ||
    !Array.isArray(value.evidenceReferences)
  ) {
    return null;
  }
  return {
    schema: HANDOVER_REVIEW_ADJUDICATION_SCHEMA,
    id,
    caseId: value.caseId as string,
    handoverDocumentId: value.handoverDocumentId as string,
    outgoingShiftId: value.outgoingShiftId as string,
    incomingShiftId: value.incomingShiftId as string,
    originalDecisionId: value.originalDecisionId as string,
    originalDecisionType: value.originalDecisionType as HandoverReviewDecisionType,
    originalDecisionActorUid: value.originalDecisionActorUid as string,
    originalDecisionRecordedAt: value.originalDecisionRecordedAt as string,
    originalDecisionFingerprint: value.originalDecisionFingerprint as string,
    originalDecisionClassification:
      value.originalDecisionClassification as HandoverReviewClassification,
    originalCaseRevision: value.originalCaseRevision as number,
    originalCaseStatus: value.originalCaseStatus as HandoverReviewCaseStatus,
    currentClassification: value.currentClassification as HandoverReviewClassification,
    currentEvidenceDigest: value.currentEvidenceDigest as string,
    contradictionReasonCodes: (value.contradictionReasonCodes as unknown[]).filter(
      (item): item is string => typeof item === "string",
    ),
    evidenceReferences: (value.evidenceReferences as unknown[])
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const entry = item as Record<string, unknown>;
        if (
          typeof entry.code !== "string" ||
          typeof entry.message !== "string" ||
          !Array.isArray(entry.references)
        ) {
          return null;
        }
        return {
          code: entry.code,
          subjectUid: typeof entry.subjectUid === "string" ? entry.subjectUid : null,
          message: entry.message,
          references: entry.references.filter(
            (reference): reference is string => typeof reference === "string",
          ),
        } satisfies HandoverReviewAdjudicationEvidenceReference;
      })
      .filter((item): item is HandoverReviewAdjudicationEvidenceReference => item !== null),
    actorUid: value.actorUid as string,
    actorRole: "admin",
    finding: value.finding as string,
    requestHash: value.requestHash as string,
    idempotencyKey: value.idempotencyKey as string,
    status: HANDOVER_REVIEW_ADJUDICATION_STATUS,
    operationalEffect: HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT,
    auditId: value.auditId as string,
    adjudicatedAt: value.adjudicatedAt as string,
  };
}

/**
 * The document paths an administrator can inspect for each server-derived
 * contradiction. These are references to already-authoritative evidence, not
 * new claims: every id is derived from the live projection.
 */
function buildAdjudicationEvidenceReferences(
  projection: HandoverReviewProjection,
): HandoverReviewAdjudicationEvidenceReference[] {
  const handover = `equal_handovers_v2/${projection.handoverDocumentId}`;
  const guard =
    projection.guard === null ? [] : [`handover_reservation_guards/${projection.guard.id}`];
  const terminal =
    projection.guard?.terminalEvidenceRef === null ||
    projection.guard?.terminalEvidenceRef === undefined
      ? []
      : [
          `audit_logs/${createGuardFinalizationAuditId(
            projection.handoverDocumentId,
            projection.guard.terminalEvidenceRef,
          )}`,
        ];
  const activation = [`audit_logs/${projection.activation.receiptId}`];
  const report =
    projection.report.reportId === null
      ? []
      : [`handover_reports_v2/${projection.report.reportId}`];

  const application = (technicianUid: string | null): string[] => {
    if (technicianUid === null) return [];
    const identity = incomingApplicationIdentity(projection.handoverId, technicianUid);
    return [
      `incoming_acceptance_applications_v1/${identity.receiptId}`,
      `attendance_evidence_v2/${identity.evidenceId}`,
      `attendance_evidence_operations_v2/${identity.operationId}`,
      `shift_members/${projection.incomingShiftId}_${technicianUid}`,
      `shift_attendance/${projection.incomingShiftId}_${technicianUid}`,
      `audit_logs/${identity.auditId}`,
    ];
  };

  return projection.reviewReasons.map((item) => {
    const subject = application(item.subjectUid);
    let references: string[];
    switch (item.code) {
      case "ACTIVATION_RECEIPT_MISSING":
      case "ACTIVATION_RECEIPT_INVALID":
      case "RECEIPT_BEFORE_ACTIVATION":
        references = [...activation, ...guard, handover];
        break;
      case "REPORT_BINDING_CONFLICT":
        references = [...report, ...activation, handover];
        break;
      case "GUARD_MISSING":
      case "GUARD_CANCELLED":
      case "TERMINAL_REFERENCE_MISSING":
        references = [...guard, ...activation, handover];
        break;
      case "TERMINAL_EVIDENCE_CONTRADICTION":
      case "EXCEPTIONAL_CLOSURE_EVIDENCE_MISSING":
      case "EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID":
      case "EXCEPTIONAL_CLOSURE_UNPROVEN":
        references = [...terminal, ...guard, ...activation, handover];
        break;
      case "PERSONAL_RECEIPT_INCOMPLETE":
      case "PERSONAL_ACCEPTANCE_MISSING":
      case "JOIN_WINDOW_CLOSED":
        references = [...subject, ...guard, ...activation, handover];
        break;
      default:
        references = subject.length > 0 ? subject : [...guard, ...activation, handover];
        break;
    }
    return {
      code: item.code,
      subjectUid: item.subjectUid,
      message: item.message,
      references: [...new Set(references)].slice(0, 8),
    };
  });
}

function adjudicationEligibilityPayload(input: {
  projection: HandoverReviewProjection;
  assessment: ReturnType<typeof evaluateHandoverAdjudicationEligibility>;
  existingAdjudicationIds: string[];
}): HandoverReviewAdjudicationEligibility {
  const { projection, assessment } = input;
  const acknowledged = assessment.acknowledgedDecision;
  return {
    handoverDocumentId: projection.handoverDocumentId,
    caseId: projection.caseId,
    caseStatus: projection.caseStatus,
    eligible: assessment.eligible,
    ineligibleCode: assessment.code,
    message: assessment.message,
    acknowledgedDecision: acknowledged,
    previousClassification: acknowledged?.classification ?? null,
    previousEvidenceDigest: acknowledged?.evidenceFingerprint ?? null,
    currentClassification: projection.classification,
    currentEvidenceDigest: projection.evidenceFingerprint,
    currentReviewReasonCodes: projection.reviewReasons.map((item) => item.code),
    contradictionReasonCodes: assessment.eligible
      ? projection.reviewReasons.map((item) => item.code)
      : [],
    evidenceReferences: assessment.eligible
      ? buildAdjudicationEvidenceReferences(projection)
      : [],
    existingAdjudicationIds: input.existingAdjudicationIds,
    generatedAt: projection.generatedAt,
  };
}

async function readAdjudicationHistory(
  caseId: string,
): Promise<HandoverReviewAdjudicationRecord[]> {
  const db = getAdminFirestore();
  const snapshot = await db
    .collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION)
    .where("caseId", "==", caseId)
    .get();
  const records: HandoverReviewAdjudicationRecord[] = [];
  for (const document of snapshot.docs) {
    const record = readAdjudicationRecord(document.id, document.data());
    if (record !== null) records.push(record);
  }
  return records.sort((left, right) =>
    left.adjudicatedAt === right.adjudicatedAt
      ? left.id.localeCompare(right.id)
      : left.adjudicatedAt.localeCompare(right.adjudicatedAt),
  );
}

/**
 * Read-only eligibility proof plus the immutable adjudication ledger for one
 * historical review case. Nothing here writes; the administrator sees the same
 * server-derived contradiction the create path will re-derive in its own
 * transaction.
 */
export async function readHandoverAdjudicationEligibility(input: {
  handoverDocumentId: string;
  nowIso: string;
}): Promise<{
  eligibility: HandoverReviewAdjudicationEligibility;
  adjudications: HandoverReviewAdjudicationRecord[];
  projection: HandoverReviewProjection;
}> {
  const read = documentReader();
  const caseRecord = await readCaseByDocumentId(read, input.handoverDocumentId);
  const caseId = createHandoverReviewCaseId(input.handoverDocumentId);
  const [decisions, adjudications] = await Promise.all([
    readDecisionHistory(input.handoverDocumentId),
    readAdjudicationHistory(caseId),
  ]);
  const projection = await buildHandoverReviewProjection({
    read,
    documentId: input.handoverDocumentId,
    nowIso: input.nowIso,
    caseRecord,
    decisions,
  });
  const assessment = evaluateHandoverAdjudicationEligibility({
    caseRecord,
    decisions,
    currentClassification: projection.classification,
    currentEvidenceDigest: projection.evidenceFingerprint,
    currentReviewReasonCodes: projection.reviewReasons.map((item) => item.code),
    currentCaseRevision: projection.caseRevision,
  });
  return {
    eligibility: adjudicationEligibilityPayload({
      projection,
      assessment,
      existingAdjudicationIds: adjudications.map((item) => item.id),
    }),
    adjudications,
    projection,
  };
}

export async function listHandoverAdjudications(input: {
  handoverDocumentId: string;
}): Promise<HandoverReviewAdjudicationRecord[]> {
  return readAdjudicationHistory(createHandoverReviewCaseId(input.handoverDocumentId));
}

export interface HandoverReviewAdjudicationResult {
  replayed: boolean;
  adjudication: HandoverReviewAdjudicationRecord;
  auditId: string;
  eligibility: HandoverReviewAdjudicationEligibility;
  projection: HandoverReviewProjection;
}

/**
 * Record one append-only historical adjudication.
 *
 * One transaction reads the original case, the decision that closed it, the
 * administrator's live authority, any existing adjudication and audit identity,
 * and a freshly recomputed projection, before it creates anything. Every
 * historical and operational field of the resulting record is server-derived:
 * the request contributes only the decision it names, the fingerprint it
 * inspected, an idempotency identity and the administrator's own words. The
 * transaction creates exactly two documents and updates or deletes nothing.
 */
export async function recordHandoverReviewAdjudication(input: {
  handoverDocumentId: string;
  actorUid: string;
  body: unknown;
  nowIso: string;
}): Promise<HandoverReviewAdjudicationResult> {
  const intent = parseHandoverReviewAdjudicationBody(input.body);
  const db = getAdminFirestore();
  const caseId = createHandoverReviewCaseId(input.handoverDocumentId);
  // The digest claimed by the request is re-derived inside the transaction and
  // compared before any write, so this identity is content-derived from
  // authoritative evidence rather than from anything the client asserts.
  const adjudicationId = createHandoverReviewAdjudicationId({
    caseId,
    originalDecisionId: intent.originalDecisionId,
    currentEvidenceDigest: intent.expectedFingerprint,
  });
  const auditId = createHandoverReviewAdjudicationAuditId(adjudicationId);
  const adjudicationRef = db
    .collection(HANDOVER_REVIEW_ADJUDICATION_COLLECTION)
    .doc(adjudicationId);
  const auditRef = db.collection("audit_logs").doc(auditId);

  const reload = async (): Promise<{
    eligibility: HandoverReviewAdjudicationEligibility;
    projection: HandoverReviewProjection;
  }> => {
    const fresh = await readHandoverAdjudicationEligibility({
      handoverDocumentId: input.handoverDocumentId,
      nowIso: input.nowIso,
    });
    return { eligibility: fresh.eligibility, projection: fresh.projection };
  };

  let committed: { replayed: boolean; adjudication: HandoverReviewAdjudicationRecord };
  try {
    committed = await db.runTransaction(async (transaction) => {
      const read = transactionReader(transaction);

      const actorSnapshot = await read(db.collection("users").doc(input.actorUid));
      assertLiveAdminProfile(actorSnapshot.data());

      const caseSnapshot = await read(
        db.collection(HANDOVER_REVIEW_CASE_COLLECTION).doc(caseId),
      );
      let caseRecord: HandoverReviewCaseRecord | null = null;
      if (caseSnapshot.exists) {
        caseRecord = readCaseRecord(caseId, caseSnapshot.data());
        if (caseRecord === null) {
          throw new HandoverReviewServiceError(
            "REVIEW_CASE_UNREADABLE",
            "The administrative review case record is unreadable.",
            409,
          );
        }
      }

      const lastDecisionId = caseRecord?.lastDecisionId ?? null;
      const decisionRef = (id: string) =>
        db.collection(HANDOVER_REVIEW_DECISION_COLLECTION).doc(id);
      const [closingSnapshot, claimedSnapshot, adjudicationSnapshot, auditSnapshot] =
        await Promise.all([
          lastDecisionId === null
            ? Promise.resolve(null as DocumentSnapshot | null)
            : read(decisionRef(lastDecisionId)),
          intent.originalDecisionId === lastDecisionId
            ? Promise.resolve(null as DocumentSnapshot | null)
            : read(decisionRef(intent.originalDecisionId)),
          read(adjudicationRef),
          read(auditRef),
        ]);

      // The case names the decision that closed it. A request that names any
      // other document cannot choose what gets adjudicated.
      if (intent.originalDecisionId !== lastDecisionId) {
        const claimed =
          claimedSnapshot !== null && claimedSnapshot.exists
            ? readDecisionRecord(intent.originalDecisionId, claimedSnapshot.data())
            : null;
        if (claimed === null || claimed.caseId !== caseId) {
          throw new HandoverAdjudicationError(
            "ADJUDICATION_DECISION_NOT_FOUND",
            "The original review decision was not found in this review case.",
            404,
          );
        }
        throw new HandoverAdjudicationError(
          "ADJUDICATION_NOT_ELIGIBLE",
          "Only the decision that closed this review case can be adjudicated.",
          409,
          HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.NO_ACKNOWLEDGEMENT,
        );
      }

      const closingDecision =
        closingSnapshot === null || !closingSnapshot.exists
          ? null
          : readDecisionRecord(lastDecisionId as string, closingSnapshot.data());
      const decisions: HandoverReviewDecisionRecord[] =
        closingDecision === null ? [] : [closingDecision];

      const projection = await buildHandoverReviewProjection({
        read,
        documentId: input.handoverDocumentId,
        nowIso: input.nowIso,
        caseRecord,
        decisions,
      });

      if (adjudicationSnapshot.exists) {
        const stored = readAdjudicationRecord(
          adjudicationId,
          adjudicationSnapshot.data(),
        );
        if (stored === null) {
          throw new HandoverAdjudicationError(
            "ADJUDICATION_OUTCOME_UNVERIFIED",
            "An adjudication with this identity exists but cannot be read.",
            503,
          );
        }
        if (stored.actorUid === input.actorUid && stored.requestHash === intent.requestHash) {
          return { replayed: true, adjudication: stored };
        }
        if (stored.actorUid === input.actorUid && stored.finding === intent.finding) {
          throw new HandoverAdjudicationError(
            "ADJUDICATION_ALREADY_RECORDED",
            `This contradiction is already recorded as ${stored.id}.`,
            409,
          );
        }
        throw new HandoverAdjudicationError(
          "ADJUDICATION_IDEMPOTENCY_CONFLICT",
          "This evidence already carries a different adjudication. Review the existing finding instead.",
          409,
        );
      }
      if (auditSnapshot.exists) {
        // The adjudication is gone but its audit is not: the previous attempt
        // has an unknown outcome, so this one refuses to guess.
        throw new HandoverAdjudicationError(
          "ADJUDICATION_OUTCOME_UNVERIFIED",
          "A prior adjudication attempt for this evidence has an unverified outcome.",
          503,
        );
      }

      if (projection.caseRevision !== intent.expectedCaseRevision) {
        throw new HandoverAdjudicationError(
          "ADJUDICATION_STALE",
          "The review case changed since it was inspected. Refresh and review again.",
          409,
        );
      }
      if (projection.evidenceFingerprint !== intent.expectedFingerprint) {
        throw new HandoverAdjudicationError(
          "ADJUDICATION_STALE",
          "The handover evidence changed since it was inspected. Refresh and review again.",
          409,
        );
      }

      const assessment = evaluateHandoverAdjudicationEligibility({
        caseRecord,
        decisions,
        currentClassification: projection.classification,
        currentEvidenceDigest: projection.evidenceFingerprint,
        currentReviewReasonCodes: projection.reviewReasons.map((item) => item.code),
        currentCaseRevision: projection.caseRevision,
      });
      if (!assessment.eligible) {
        adjudicationIneligible(assessment);
      }
      const acknowledged = assessment.acknowledgedDecision;
      if (acknowledged === null || acknowledged.id !== intent.originalDecisionId) {
        throw new HandoverAdjudicationError(
          "ADJUDICATION_NOT_ELIGIBLE",
          "The acknowledged decision could not be linked to this review case.",
          409,
          HANDOVER_REVIEW_ADJUDICATION_INELIGIBLE.HISTORY_MISMATCH,
        );
      }

      const contradictionReasonCodes = projection.reviewReasons.map((item) => item.code);
      const record: HandoverReviewAdjudicationRecord = {
        schema: HANDOVER_REVIEW_ADJUDICATION_SCHEMA,
        id: adjudicationId,
        caseId,
        handoverDocumentId: input.handoverDocumentId,
        outgoingShiftId: projection.outgoingShiftId,
        incomingShiftId: projection.incomingShiftId,
        originalDecisionId: acknowledged.id,
        originalDecisionType: acknowledged.decisionType,
        originalDecisionActorUid: acknowledged.actorUid,
        originalDecisionRecordedAt: acknowledged.recordedAt,
        originalDecisionFingerprint: acknowledged.evidenceFingerprint,
        originalDecisionClassification: acknowledged.classification,
        originalCaseRevision: acknowledged.caseRevisionAfter,
        originalCaseStatus: acknowledged.caseStatusAfter,
        currentClassification: projection.classification,
        currentEvidenceDigest: projection.evidenceFingerprint,
        contradictionReasonCodes,
        evidenceReferences: buildAdjudicationEvidenceReferences(projection),
        actorUid: input.actorUid,
        actorRole: "admin",
        finding: intent.finding,
        requestHash: intent.requestHash,
        idempotencyKey: intent.idempotencyKey,
        status: HANDOVER_REVIEW_ADJUDICATION_STATUS,
        operationalEffect: HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT,
        auditId,
        adjudicatedAt: input.nowIso,
      };

      // Create-only writes. The review case, its decisions and every
      // operational document are read but never touched.
      transaction.create(adjudicationRef, adjudicationMaterial({ ...record }));
      transaction.create(
        auditRef,
        adjudicationMaterial({
          action: "HANDOVER_REVIEW_ADJUDICATED",
          actorUid: input.actorUid,
          actorRole: "admin",
          targetHandoverDocumentId: input.handoverDocumentId,
          caseId,
          decisionId: acknowledged.id,
          adjudicationId,
          finding: intent.finding,
          originalDecisionClassification: acknowledged.classification,
          originalDecisionFingerprint: acknowledged.evidenceFingerprint,
          currentClassification: projection.classification,
          currentEvidenceDigest: projection.evidenceFingerprint,
          contradictionReasonCodes,
          status: HANDOVER_REVIEW_ADJUDICATION_STATUS,
          operationalEffect: HANDOVER_REVIEW_ADJUDICATION_OPERATIONAL_EFFECT,
          details:
            "Administrator recorded an append-only historical adjudication finding; no operational evidence, review case or review decision was changed.",
        }),
      );

      return { replayed: false, adjudication: record };
    });
  } catch (error) {
    if (
      error instanceof HandoverAdjudicationError ||
      error instanceof HandoverReviewServiceError ||
      error instanceof HandoverReviewInputError
    ) {
      throw error;
    }
    // The transaction could not be confirmed. Verify the deterministic identity
    // before answering; never report a failure that committed and never report
    // a success that did not.
    const snapshot = await adjudicationRef.get().catch(() => null);
    const stored =
      snapshot !== null && snapshot.exists
        ? readAdjudicationRecord(adjudicationId, snapshot.data())
        : null;
    if (
      stored !== null &&
      stored.actorUid === input.actorUid &&
      stored.requestHash === intent.requestHash
    ) {
      const reloaded = await reload();
      return {
        replayed: true,
        adjudication: stored,
        auditId,
        ...reloaded,
      };
    }
    throw new HandoverAdjudicationError(
      "ADJUDICATION_OUTCOME_UNVERIFIED",
      "The adjudication outcome could not be confirmed. Refresh and verify before recording again.",
      503,
    );
  }

  // Nothing is reported as successful until the created document has been read
  // back and agrees with the request it answers.
  const verifiedSnapshot = await adjudicationRef.get().catch(() => null);
  const verified =
    verifiedSnapshot !== null && verifiedSnapshot.exists
      ? readAdjudicationRecord(adjudicationId, verifiedSnapshot.data())
      : null;
  if (
    verified === null ||
    verified.requestHash !== committed.adjudication.requestHash ||
    verified.actorUid !== committed.adjudication.actorUid
  ) {
    throw new HandoverAdjudicationError(
      "ADJUDICATION_OUTCOME_UNVERIFIED",
      "The adjudication was committed but could not be verified. Refresh and verify before recording again.",
      503,
    );
  }
  const reloaded = await reload();
  return {
    replayed: committed.replayed,
    adjudication: verified,
    auditId,
    ...reloaded,
  };
}
