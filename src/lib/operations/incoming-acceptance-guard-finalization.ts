// 09M-R3B.2 Phase 4A — receipt-backed guard finalization.
//
// A separate, idempotent transaction that completes the v2 reservation guard
// only when the persisted, personally authenticated applications prove it — or
// when an operator-authorized absence closure proves that the partner can no
// longer join. Activation alone is never sufficient.
//
// Nothing here is wired into a route, a UI or the production acceptance path.
// The legacy finalizer remains untouched; this service is stricter and is only
// reachable from tests until a later phase integrates it.

import "server-only";

import { createHash } from "node:crypto";
import { FieldValue, type DocumentSnapshot } from "firebase-admin/firestore";
import type { EqualHandoverAggregate } from "@/types/equal-technician-handover";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import type {
  IncomingAcceptanceApplicationReceipt,
  IncomingAcceptanceExceptionalClosure,
  IncomingAcceptanceGuardApplicationState,
  IncomingAcceptanceIncomingShiftRecord,
} from "@/types/incoming-acceptance-application";
import { AssignmentOperationError } from "./assignment-transaction";
import { getOperationalCollections } from "./collections";
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
  type AtomicAcceptanceCommitState,
} from "./incoming-acceptance-application-firestore";
import { classifyIncomingAcceptanceGuardLifecycle, type IncomingAcceptanceGuardLifecycleState } from "./incoming-acceptance-guard-lifecycle";
import {
  IncomingAcceptanceVerificationError,
  verifyIncomingAcceptanceApplication,
} from "./incoming-acceptance-receipt-verification";
import { completeReservationGuard, readReservationGuardState } from "./handover-reservation-guard";
import { createHandoverReservationGuardDocumentId } from "./handover-reservation-guard-domain";
import {
  authorizeTechnicianProfile,
  readV2Aggregate,
  requireV2GuardBinding,
} from "./equal-handover-report-firestore";
import {
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
} from "./equal-technician-handover-domain";

export const GUARD_FINALIZATION_AUDIT_SCHEMA = "equal-handover-guard-finalization-audit-v1";
export const GUARD_FINALIZATION_AUDIT_ACTION = "EQUAL_HANDOVER_GUARD_FINALIZED_V1";
export const GUARD_CLOSURE_AUDIT_ACTION = "EQUAL_HANDOVER_GUARD_EXCEPTIONAL_CLOSURE_V1";

export type GuardFinalizationMode = "normal_closure" | "exceptional_closure";

export type GuardFinalizationErrorCode =
  | "GUARD_FINALIZATION_NOT_ELIGIBLE"
  | "GUARD_FINALIZATION_UNAUTHORIZED"
  | "GUARD_FINALIZATION_CONFLICT"
  | "GUARD_FINALIZATION_INCONSISTENT"
  | "GUARD_FINALIZATION_UNVERIFIABLE"
  | "GUARD_FINALIZATION_OUTCOME_UNKNOWN";

export class GuardFinalizationError extends Error {
  public readonly code: GuardFinalizationErrorCode;
  public readonly status: number;
  public readonly commitState: AtomicAcceptanceCommitState;
  public readonly lifecycleState: IncomingAcceptanceGuardLifecycleState | null;

  constructor(
    code: GuardFinalizationErrorCode,
    message: string,
    status: number,
    commitState: AtomicAcceptanceCommitState,
    lifecycleState: IncomingAcceptanceGuardLifecycleState | null = null,
  ) {
    super(message);
    this.name = "GuardFinalizationError";
    this.code = code;
    this.status = status;
    this.commitState = commitState;
    this.lifecycleState = lifecycleState;
  }
}

export interface ExceptionalClosureRequest {
  closureId: string;
  subjectUid: string;
  reason: string;
  recordedAt: string;
}

export interface FinalizeIncomingAcceptanceGuardInput {
  outgoingShiftId: string;
  /** Server-derived actor; never a request-body UID. */
  actorUid: string;
  /** Server-derived request clock. */
  nowIso: string;
  exceptionalClosure?: ExceptionalClosureRequest | null;
}

export interface FinalizedApplicationSummary {
  technicianUid: string;
  receiptId: string;
  receiptHash: string;
  outcome: string;
  operationalAppliedAt: string;
}

export interface FinalizeIncomingAcceptanceGuardResult {
  status: "FINALIZED" | "ALREADY_FINALIZED";
  replayed: boolean;
  mode: GuardFinalizationMode;
  commitState: "committed_validated";
  /**
   * `legacy_guard_only` marks a guard the untouched legacy finalizer completed
   * before Phase 4A existed: matching terminal reference, no Phase 4A audit.
   */
  provenance: "phase4a_audited" | "legacy_guard_only";
  outgoingShiftId: string;
  handoverDocumentId: string;
  incomingShiftId: string;
  guardId: string;
  guardRevision: number;
  terminalEvidenceRef: string;
  lifecycleState: "completed";
  activationReceiptId: string;
  activationReceiptHash: string;
  applications: FinalizedApplicationSummary[];
  closure: (IncomingAcceptanceExceptionalClosure & { absenceReason: string }) | null;
  auditId: string;
  auditState: "created" | "existing";
}

function fail(
  code: GuardFinalizationErrorCode,
  message: string,
  status: number,
  commitState: AtomicAcceptanceCommitState,
  lifecycleState: IncomingAcceptanceGuardLifecycleState | null = null,
): never {
  throw new GuardFinalizationError(code, message, status, commitState, lifecycleState);
}

function documentRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "GUARD_FINALIZATION_INCONSISTENT",
      `Malformed ${label}; administrator review required.`,
      409,
      "not_committed",
    );
  }
  return value as Record<string, unknown>;
}

function isTimestampValue(value: unknown): boolean {
  const record = value as { toDate?: unknown; seconds?: unknown; nanoseconds?: unknown } | null;
  return (
    record !== null &&
    typeof record === "object" &&
    typeof record.toDate === "function" &&
    Number.isSafeInteger(record.seconds) &&
    Number.isSafeInteger(record.nanoseconds)
  );
}

function canonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isSupervisorProfile(profile: Record<string, unknown> | undefined): boolean {
  return (
    !!profile &&
    profile.role === "supervisor" &&
    profile.status === "active" &&
    profile.statusOperation == null &&
    profile.mustChangePassword === false
  );
}

/**
 * Deterministic audit identity. The terminal evidence reference makes a guard
 * finalization unique per handover and closure, so a retried request converges
 * on the same audit document instead of appending history.
 */
export function createGuardFinalizationAuditId(
  handoverDocumentId: string,
  terminalEvidenceRef: string,
): string {
  return `guard_finalization_v1_${createHash("sha256")
    .update(JSON.stringify({ handoverDocumentId, terminalEvidenceRef }))
    .digest("hex")
    .slice(0, 40)}`;
}

function applicationIdentity(handoverId: string, technicianUid: string) {
  // The receipt identity is kind-independent; evidence/operation IDs are not.
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
}

function applicationState(
  readSet: ApplicationReadSet,
  aggregate: EqualHandoverAggregate,
  receipt: IncomingAcceptanceApplicationReceipt | null,
): IncomingAcceptanceGuardApplicationState {
  return {
    technicianUid: readSet.technicianUid,
    receipt,
    evidencePresent: readSet.evidence?.exists === true,
    operationFinalized:
      readSet.operation?.exists === true &&
      (readSet.operation.data() as { status?: unknown } | undefined)?.status === "finalized",
    membershipPresent: readSet.membership.exists,
    attendancePresent: readSet.attendance.exists,
    declaredNotYetIn: aggregate.absences.some(
      (item) => item.technicianUid === readSet.technicianUid && item.absenceType === "not_yet_in",
    ),
  };
}

// 09M-R3B.2 Phase 6 — read-only guard lifecycle classification for the
// acceptance status endpoint. It performs the same authoritative reads as the
// finalization transaction but never writes; an unreadable guard binding,
// receipt or activation evidence yields no classification rather than a guess.
export interface IncomingAcceptanceGuardLifecycleRead {
  state: IncomingAcceptanceGuardLifecycleState;
  reason: string;
  missingTechnicianUids: string[];
}

export async function readIncomingAcceptanceGuardLifecycle(input: {
  outgoingShiftId: string;
  technicianUid: string;
  nowIso: string;
}): Promise<IncomingAcceptanceGuardLifecycleRead | null> {
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  const {
    db,
    equalHandoversV2,
    shiftMembers,
    shiftAttendance,
    attendanceEvidenceV2,
    attendanceEvidenceOperationsV2,
  } = getOperationalCollections();
  try {
    return await db.runTransaction(async (transaction) => {
      const [aggregateSnapshot, guardState] = await Promise.all([
        transaction.get(equalHandoversV2.doc(documentId)),
        readReservationGuardState(transaction, input.outgoingShiftId),
      ]);
      if (!aggregateSnapshot.exists) return null;
      const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
      const identity = aggregate.identity;
      if (!identity.incomingTechnicianIds.includes(input.technicianUid)) return null;
      let guard: HandoverReservationGuard;
      try {
        guard = requireV2GuardBinding(
          guardState.guardSnapshot.exists,
          guardState.guardSnapshot.data(),
          documentId,
          aggregate,
        );
      } catch {
        return null;
      }

      const activationReceiptId = createIncomingAcceptanceActivationReceiptId(documentId);
      // A completed guard is terminal. Its terminal evidence is either the
      // activation receipt (normal closure) or an authorized supervisor closure
      // id (exceptional closure); the classifier needs the closure input to
      // prove the latter, so the read view recognizes terminality from the
      // guard document itself instead of reporting a false inconsistency.
      if (guard.ownerLifecycleState === "completed") {
        return {
          state: "guard_finalized",
          reason: guard.terminalEvidenceRef === activationReceiptId ? "GUARD_FINALIZED" : "GUARD_FINALIZED_EXCEPTIONAL",
          missingTechnicianUids: [],
        };
      }
      const activationSnapshot = await transaction.get(
        db.collection("audit_logs").doc(activationReceiptId),
      );
      let activationReceipt: IncomingAcceptanceActivationReceipt | null = null;
      if (activationSnapshot.exists) {
        try {
          assertIncomingAcceptanceActivationReceipt(activationSnapshot.data(), {
            handoverDocumentId: documentId,
            outgoingShiftId: input.outgoingShiftId,
            incomingShiftId: identity.incomingShiftId,
            boundReportId: aggregate.reportBinding?.id ?? "",
          });
          activationReceipt = activationSnapshot.data() as unknown as IncomingAcceptanceActivationReceipt;
        } catch {
          activationReceipt = null;
        }
      }

      const reserved = identity.incomingTechnicianIds;
      const receiptIds = reserved.map(
        (uid) => applicationIdentity(aggregate.reservation.handoverId, uid).receiptId,
      );
      const [receiptSnapshots, membershipSnapshots, attendanceSnapshots, auditSnapshots] =
        await Promise.all([
          Promise.all(receiptIds.map((id) =>
            transaction.get(db.collection("incoming_acceptance_applications_v1").doc(id)),
          )),
          Promise.all(reserved.map((uid) =>
            transaction.get(shiftMembers.doc(`${identity.incomingShiftId}_${uid}`)),
          )),
          Promise.all(reserved.map((uid) =>
            transaction.get(shiftAttendance.doc(`${identity.incomingShiftId}_${uid}`)),
          )),
          Promise.all(reserved.map((uid) =>
            transaction.get(
              db.collection("audit_logs").doc(
                applicationIdentity(aggregate.reservation.handoverId, uid).auditId,
              ),
            ),
          )),
        ]);

      const readSets: ApplicationReadSet[] = reserved.map((uid, index) => ({
        technicianUid: uid,
        receipt: receiptSnapshots[index] as DocumentSnapshot,
        membership: membershipSnapshots[index] as DocumentSnapshot,
        attendance: attendanceSnapshots[index] as DocumentSnapshot,
        audit: auditSnapshots[index] as DocumentSnapshot,
        evidence: null,
        operation: null,
      }));
      const hydrated = new Map<string, IncomingAcceptanceApplicationReceipt>();
      for (const readSet of readSets) {
        if (!readSet.receipt.exists) continue;
        const receipt = readPersistedReceipt(readSet.receipt.data());
        if (receipt.technicianUid !== readSet.technicianUid) return null;
        hydrated.set(readSet.technicianUid, receipt);
      }
      await Promise.all(readSets.map(async (readSet) => {
        const receipt = hydrated.get(readSet.technicianUid);
        if (receipt === undefined) return;
        const [evidence, operation] = await Promise.all([
          transaction.get(attendanceEvidenceV2.doc(receipt.evidenceId)),
          transaction.get(attendanceEvidenceOperationsV2.doc(receipt.evidenceOperationId)),
        ]);
        readSet.evidence = evidence;
        readSet.operation = operation;
      }));

      const applications = readSets.map((readSet) =>
        applicationState(readSet, aggregate, hydrated.get(readSet.technicianUid) ?? null),
      );
      const classification = classifyIncomingAcceptanceGuardLifecycle({
        handoverDocumentId: documentId,
        aggregateLifecycleStatus: aggregate.lifecycleStatus,
        scheduledStart: identity.scheduledStart,
        scheduledEnd: identity.scheduledEnd,
        nowIso: input.nowIso,
        guard,
        activationReceiptId: activationReceipt?.id ?? null,
        activationReceiptHash: activationReceipt?.receiptHash ?? null,
        activationActorUid: activationReceipt?.actorUid ?? null,
        applications,
        exceptionalClosure: null,
      });
      return {
        state: classification.state,
        reason: classification.reason,
        missingTechnicianUids: classification.missingTechnicianUids,
      };
    });
  } catch {
    return null;
  }
}

function verifyPresentApplications(input: {
  aggregate: EqualHandoverAggregate;
  handoverDocumentId: string;
  activationReceipt: IncomingAcceptanceActivationReceipt;
  incomingShift: IncomingAcceptanceIncomingShiftRecord | null;
  guard: HandoverReservationGuard;
  readSets: ApplicationReadSet[];
  hydrated: Map<string, IncomingAcceptanceApplicationReceipt>;
}): FinalizedApplicationSummary[] {
  const summaries: FinalizedApplicationSummary[] = [];
  for (const readSet of input.readSets) {
    if (!readSet.receipt.exists) continue;
    const receipt = input.hydrated.get(readSet.technicianUid);
    if (receipt === undefined) {
      fail(
        "GUARD_FINALIZATION_INCONSISTENT",
        "An application receipt could not be hydrated; administrator review required.",
        409,
        "not_committed",
      );
    }
    if (receipt.appliedGuardBinding.guardRevision !== input.guard.guardRevision ||
        receipt.appliedGuardBinding.fencingEpoch !== input.guard.fencingEpoch) {
      fail(
        "GUARD_FINALIZATION_CONFLICT",
        "The application was bound to a different reservation guard revision.",
        409,
        "not_committed",
      );
    }
    try {
      verifyIncomingAcceptanceApplication({
        aggregate: input.aggregate,
        handoverDocumentId: input.handoverDocumentId,
        technicianUid: readSet.technicianUid,
        expectedReceiptId: applicationIdentity(
          input.aggregate.reservation.handoverId,
          readSet.technicianUid,
        ).receiptId,
        activationReceipt: input.activationReceipt,
        incomingShift: input.incomingShift,
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
    } catch (error) {
      if (error instanceof IncomingAcceptanceVerificationError) {
        fail(
          error.code === "BINDING_CONFLICT"
            ? "GUARD_FINALIZATION_CONFLICT"
            : "GUARD_FINALIZATION_INCONSISTENT",
          error.message,
          409,
          "not_committed",
        );
      }
      throw error;
    }
    summaries.push({
      technicianUid: receipt.technicianUid,
      receiptId: receipt.id,
      receiptHash: receipt.receiptHash,
      outcome: receipt.outcome,
      operationalAppliedAt: receipt.operationalAppliedAt,
    });
  }
  return summaries;
}

interface FinalizationAuditMaterial {
  id: string;
  schema: typeof GUARD_FINALIZATION_AUDIT_SCHEMA;
  action: string;
  mode: GuardFinalizationMode;
  handoverDocumentId: string;
  reservationId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  guardId: string;
  guardRevisionBefore: number;
  guardRevisionAfter: number;
  fencingEpoch: number;
  terminalEvidenceRef: string;
  activationReceiptId: string;
  activationReceiptHash: string;
  activationActorUid: string;
  activatedAt: string;
  technicianUids: string[];
  applications: FinalizedApplicationSummary[];
  closure: (IncomingAcceptanceExceptionalClosure & { absenceReason: string }) | null;
  authorizedByUid: string;
  recordedAt: string;
}

function auditMaterial(input: {
  mode: GuardFinalizationMode;
  aggregate: EqualHandoverAggregate;
  handoverDocumentId: string;
  guard: HandoverReservationGuard;
  terminalEvidenceRef: string;
  activationReceipt: IncomingAcceptanceActivationReceipt;
  applications: FinalizedApplicationSummary[];
  closure: (IncomingAcceptanceExceptionalClosure & { absenceReason: string }) | null;
  actorUid: string;
  nowIso: string;
}): FinalizationAuditMaterial {
  return {
    id: createGuardFinalizationAuditId(input.handoverDocumentId, input.terminalEvidenceRef),
    schema: GUARD_FINALIZATION_AUDIT_SCHEMA,
    action:
      input.mode === "exceptional_closure"
        ? GUARD_CLOSURE_AUDIT_ACTION
        : GUARD_FINALIZATION_AUDIT_ACTION,
    mode: input.mode,
    handoverDocumentId: input.handoverDocumentId,
    reservationId: input.aggregate.reservation.handoverId,
    outgoingShiftId: input.aggregate.identity.outgoingShiftId,
    incomingShiftId: input.aggregate.identity.incomingShiftId,
    guardId: input.guard.id,
    guardRevisionBefore: input.guard.guardRevision,
    guardRevisionAfter: input.guard.guardRevision + 1,
    fencingEpoch: input.guard.fencingEpoch,
    terminalEvidenceRef: input.terminalEvidenceRef,
    activationReceiptId: input.activationReceipt.id,
    activationReceiptHash: input.activationReceipt.receiptHash,
    activationActorUid: input.activationReceipt.actorUid,
    activatedAt: input.activationReceipt.activatedAt,
    technicianUids: [...input.aggregate.identity.incomingTechnicianIds],
    applications: input.applications,
    closure: input.closure,
    authorizedByUid: input.actorUid,
    recordedAt: input.nowIso,
  };
}

function replayResult(input: {
  mode: GuardFinalizationMode;
  guard: HandoverReservationGuard;
  documentId: string;
  outgoingShiftId: string;
  incomingId: string;
  terminalEvidenceRef: string;
  activationReceiptId: string;
  activationReceipt: IncomingAcceptanceActivationReceipt;
  auditId: string;
  auditExists: boolean;
}): FinalizeIncomingAcceptanceGuardResult {
  return {
    status: "ALREADY_FINALIZED",
    replayed: true,
    mode: input.mode,
    commitState: "committed_validated",
    provenance: input.auditExists ? "phase4a_audited" : "legacy_guard_only",
    outgoingShiftId: input.outgoingShiftId,
    handoverDocumentId: input.documentId,
    incomingShiftId: input.incomingId,
    guardId: input.guard.id,
    guardRevision: input.guard.guardRevision,
    terminalEvidenceRef: input.terminalEvidenceRef,
    lifecycleState: "completed",
    activationReceiptId: input.activationReceiptId,
    activationReceiptHash: input.activationReceipt.receiptHash,
    applications: [],
    closure: null,
    auditId: input.auditId,
    auditState: "existing",
  };
}

export async function finalizeIncomingAcceptanceGuardAtomically(
  input: FinalizeIncomingAcceptanceGuardInput,
): Promise<FinalizeIncomingAcceptanceGuardResult> {
  if (typeof input.outgoingShiftId !== "string" || input.outgoingShiftId.length === 0 ||
      typeof input.actorUid !== "string" || input.actorUid.length === 0 ||
      !canonicalTimestamp(input.nowIso)) {
    fail(
      "GUARD_FINALIZATION_NOT_ELIGIBLE",
      "Guard finalization requires a shift, an actor and a canonical server clock.",
      400,
      "not_committed",
    );
  }
  const mode: GuardFinalizationMode =
    input.exceptionalClosure ? "exceptional_closure" : "normal_closure";
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  const { db, equalHandoversV2, shiftMembers, shiftAttendance,
    attendanceEvidenceV2, attendanceEvidenceOperationsV2, handoverReportsV2 } =
    getOperationalCollections();

  const result = await db.runTransaction<FinalizeIncomingAcceptanceGuardResult>(async (transaction) => {
    // ---------------------------------------------------------------------
    // Read phase — every authoritative read completes before the first write.
    // ---------------------------------------------------------------------
    const [profileSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      transaction.get(db.collection("users").doc(input.actorUid)),
      transaction.get(equalHandoversV2.doc(documentId)),
      readReservationGuardState(transaction, input.outgoingShiftId),
    ]);
    if (!aggregateSnapshot.exists) {
      fail(
        "GUARD_FINALIZATION_NOT_ELIGIBLE",
        "The equal handover reservation was not found.",
        404,
        "not_committed",
      );
    }
    const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
    const identity = aggregate.identity;
    const incomingId = identity.incomingShiftId;

    let guard: HandoverReservationGuard;
    try {
      guard = requireV2GuardBinding(
        guardState.guardSnapshot.exists,
        guardState.guardSnapshot.data(),
        documentId,
        aggregate,
      );
    } catch (error) {
      if (error instanceof AssignmentOperationError) {
        fail("GUARD_FINALIZATION_INCONSISTENT", error.message, 409, "not_committed");
      }
      throw error;
    }

    const activationReceiptId = createIncomingAcceptanceActivationReceiptId(documentId);
    const [activationSnapshot, incomingSnapshot] = await Promise.all([
      transaction.get(db.collection("audit_logs").doc(activationReceiptId)),
      transaction.get(db.collection("shifts").doc(incomingId)),
    ]);
    const incomingShift = incomingSnapshot.exists
      ? (incomingSnapshot.data() as IncomingAcceptanceIncomingShiftRecord)
      : null;

    const reportId = aggregate.reportBinding?.id ?? null;
    const reportSnapshot = reportId === null
      ? null
      : await transaction.get(handoverReportsV2.doc(reportId));

    let activationReceipt: IncomingAcceptanceActivationReceipt | null = null;
    if (activationSnapshot.exists) {
      try {
        assertIncomingAcceptanceActivationReceipt(activationSnapshot.data(), {
          handoverDocumentId: documentId,
          outgoingShiftId: input.outgoingShiftId,
          incomingShiftId: incomingId,
          boundReportId: reportId ?? "",
        });
        activationReceipt = activationSnapshot.data() as unknown as IncomingAcceptanceActivationReceipt;
      } catch {
        activationReceipt = null;
      }
    }

    // ---- authority ------------------------------------------------------
    const profile = profileSnapshot.data() as Record<string, unknown> | undefined;
    const reservedIncoming = identity.incomingTechnicianIds;
    if (mode === "normal_closure") {
      try {
        authorizeTechnicianProfile(profile, input.actorUid);
      } catch {
        fail(
          "GUARD_FINALIZATION_UNAUTHORIZED",
          "Only a live reserved incoming technician may finalize this guard.",
          403,
          "not_committed",
        );
      }
      if (!reservedIncoming.includes(input.actorUid)) {
        fail(
          "GUARD_FINALIZATION_UNAUTHORIZED",
          "Only a reserved incoming technician may finalize this guard.",
          403,
          "not_committed",
        );
      }
    } else {
      if (!isSupervisorProfile(profile)) {
        fail(
          "GUARD_FINALIZATION_UNAUTHORIZED",
          "Only a live supervisor may authorize an exceptional closure.",
          403,
          "not_committed",
        );
      }
      if (reservedIncoming.includes(input.actorUid)) {
        fail(
          "GUARD_FINALIZATION_UNAUTHORIZED",
          "A participating technician cannot authorize their own exception closure.",
          403,
          "not_committed",
        );
      }
    }

    const closureRequest = input.exceptionalClosure ?? null;
    if (closureRequest !== null &&
        (!reservedIncoming.includes(closureRequest.subjectUid) ||
          closureRequest.subjectUid === input.actorUid)) {
      fail(
        "GUARD_FINALIZATION_NOT_ELIGIBLE",
        "The closure subject must be the other reserved incoming technician.",
        409,
        "not_committed",
      );
    }

    // ---- deterministic subject receipts ---------------------------------
    const receiptIds = reservedIncoming.map(
      (uid) => applicationIdentity(aggregate.reservation.handoverId, uid).receiptId,
    );
    const [receiptSnapshots, membershipSnapshots, attendanceSnapshots, auditSnapshots] =
      await Promise.all([
        Promise.all(receiptIds.map((id) =>
          transaction.get(db.collection("incoming_acceptance_applications_v1").doc(id)),
        )),
        Promise.all(reservedIncoming.map((uid) =>
          transaction.get(shiftMembers.doc(`${incomingId}_${uid}`)),
        )),
        Promise.all(reservedIncoming.map((uid) =>
          transaction.get(shiftAttendance.doc(`${incomingId}_${uid}`)),
        )),
        Promise.all(reservedIncoming.map((uid) =>
          transaction.get(
            db.collection("audit_logs").doc(
              applicationIdentity(aggregate.reservation.handoverId, uid).auditId,
            ),
          ),
        )),
      ]);

    const readSets: ApplicationReadSet[] = reservedIncoming.map((uid, index) => ({
      technicianUid: uid,
      receipt: receiptSnapshots[index] as DocumentSnapshot,
      membership: membershipSnapshots[index] as DocumentSnapshot,
      attendance: attendanceSnapshots[index] as DocumentSnapshot,
      audit: auditSnapshots[index] as DocumentSnapshot,
      evidence: null,
      operation: null,
    }));

    const hydrated = new Map<string, IncomingAcceptanceApplicationReceipt>();
    for (const readSet of readSets) {
      if (!readSet.receipt.exists) continue;
      let receipt: IncomingAcceptanceApplicationReceipt;
      try {
        receipt = readPersistedReceipt(readSet.receipt.data());
      } catch (error) {
        if (error instanceof AtomicAcceptanceServiceError) {
          fail(
            "GUARD_FINALIZATION_UNVERIFIABLE",
            "An application receipt is not yet verifiable; refresh acceptance status before finalizing.",
            503,
            "not_committed",
          );
        }
        fail(
          "GUARD_FINALIZATION_INCONSISTENT",
          "A stored application receipt is malformed; administrator review required.",
          409,
          "not_committed",
        );
      }
      if (receipt.technicianUid !== readSet.technicianUid) {
        fail(
          "GUARD_FINALIZATION_INCONSISTENT",
          "A stored application receipt belongs to a different technician.",
          409,
          "not_committed",
        );
      }
      hydrated.set(readSet.technicianUid, receipt);
    }

    // Evidence is keyed by the slot the original application used, so it is
    // only readable through the receipt it produced.
    await Promise.all(
      readSets.map(async (readSet) => {
        const receipt = hydrated.get(readSet.technicianUid);
        if (receipt === undefined) return;
        const [evidence, operation] = await Promise.all([
          transaction.get(attendanceEvidenceV2.doc(receipt.evidenceId)),
          transaction.get(attendanceEvidenceOperationsV2.doc(receipt.evidenceOperationId)),
        ]);
        readSet.evidence = evidence;
        readSet.operation = operation;
      }),
    );

    const applications = readSets.map((readSet) =>
      applicationState(readSet, aggregate, hydrated.get(readSet.technicianUid) ?? null),
    );

    // ---- replay fast path ----------------------------------------------
    if (guard.ownerLifecycleState === "completed") {
      const expectedTerminal = mode === "exceptional_closure"
        ? closureRequest!.closureId
        : activationReceiptId;
      if (guard.terminalEvidenceRef !== expectedTerminal) {
        fail(
          "GUARD_FINALIZATION_CONFLICT",
          "The reservation guard is already completed against a different terminal reference.",
          409,
          "not_committed",
          "guard_finalized",
        );
      }
      if (activationReceipt === null) {
        fail(
          "GUARD_FINALIZATION_INCONSISTENT",
          "The completed guard has no valid activation receipt; administrator review required.",
          409,
          "not_committed",
          "guard_finalized",
        );
      }
      const auditId = createGuardFinalizationAuditId(documentId, expectedTerminal);
      const auditSnapshot = await transaction.get(db.collection("audit_logs").doc(auditId));
      if (auditSnapshot.exists && !isTimestampValue(
        documentRecord(auditSnapshot.data(), "guard finalization audit").createdAt,
      )) {
        fail(
          "GUARD_FINALIZATION_INCONSISTENT",
          "The existing guard finalization audit has no resolved commit marker.",
          409,
          "not_committed",
          "guard_finalized",
        );
      }
      if (!auditSnapshot.exists && mode === "exceptional_closure") {
        fail(
          "GUARD_FINALIZATION_INCONSISTENT",
          "The completed exception closure has no authorization audit; administrator review required.",
          409,
          "not_committed",
          "guard_finalized",
        );
      }
      return replayResult({
        mode,
        guard,
        documentId,
        outgoingShiftId: input.outgoingShiftId,
        incomingId,
        terminalEvidenceRef: expectedTerminal,
        activationReceiptId,
        activationReceipt,
        auditId,
        auditExists: auditSnapshot.exists,
      });
    }

    // ---- lifecycle classification --------------------------------------
    const classification = classifyIncomingAcceptanceGuardLifecycle({
      handoverDocumentId: documentId,
      aggregateLifecycleStatus: aggregate.lifecycleStatus,
      scheduledStart: identity.scheduledStart,
      scheduledEnd: identity.scheduledEnd,
      nowIso: input.nowIso,
      guard,
      activationReceiptId: activationReceipt?.id ?? null,
      activationReceiptHash: activationReceipt?.receiptHash ?? null,
      activationActorUid: activationReceipt?.actorUid ?? null,
      applications,
      exceptionalClosure: closureRequest === null
        ? null
        : {
            closureId: closureRequest.closureId,
            subjectUid: closureRequest.subjectUid,
            authorizedBy: input.actorUid,
            reason: closureRequest.reason,
            recordedAt: closureRequest.recordedAt,
          },
    });

    if (classification.state !== "eligible_for_normal_closure" &&
        classification.state !== "exceptional_closure_authorized") {
      fail(
        "GUARD_FINALIZATION_NOT_ELIGIBLE",
        `The guard is not eligible for finalization (${classification.reason}).`,
        409,
        "not_committed",
        classification.state,
      );
    }
    if (activationReceipt === null) {
      fail(
        "GUARD_FINALIZATION_INCONSISTENT",
        "The activation receipt is missing; the guard cannot be finalized.",
        409,
        "not_committed",
        classification.state,
      );
    }

    // The frozen report and the live aggregate binding are re-proven before the
    // guard becomes terminal, exactly as the acceptance service does.
    if (aggregate.reportBinding === null) {
      fail(
        "GUARD_FINALIZATION_INCONSISTENT",
        "The handover aggregate is not bound to a frozen report.",
        409,
        "not_committed",
      );
    }
    try {
      assertReportDocument(
        reportSnapshot,
        {
          handoverId: aggregate.reservation.handoverId,
          handoverDocumentId: documentId,
          aggregateRevision: aggregate.revision,
          snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
          report: { ...aggregate.reportBinding, aggregateRevision: aggregate.revision },
          guardRevision: guard.guardRevision,
          fencingEpoch: guard.fencingEpoch,
        },
        aggregate,
      );
    } catch {
      fail(
        "GUARD_FINALIZATION_CONFLICT",
        "The frozen report no longer matches the reviewed handover binding.",
        409,
        "not_committed",
      );
    }

    const applicationsSummary = verifyPresentApplications({
      aggregate,
      handoverDocumentId: documentId,
      activationReceipt,
      incomingShift,
      guard,
      readSets,
      hydrated,
    });

    // ---- exceptional closure evidence ----------------------------------
    let closure: (IncomingAcceptanceExceptionalClosure & { absenceReason: string }) | null = null;
    if (mode === "exceptional_closure") {
      const request = closureRequest!;
      const absence = aggregate.absences.find(
        (item) =>
          item.technicianUid === request.subjectUid && item.absenceType === "not_yet_in",
      );
      const reason = typeof request.reason === "string" ? request.reason.trim() : "";
      if (
        absence === undefined ||
        absence.reason.trim().length === 0 ||
        reason.length === 0 ||
        !canonicalTimestamp(request.recordedAt) ||
        Date.parse(request.recordedAt) < Date.parse(activationReceipt.activatedAt) ||
        Date.parse(request.recordedAt) > Date.parse(input.nowIso)
      ) {
        fail(
          "GUARD_FINALIZATION_NOT_ELIGIBLE",
          "The exception closure is not backed by an authoritative absence and reason.",
          409,
          "not_committed",
          classification.state,
        );
      }

      // The absent technician must have no application artifacts at all. A
      // closure never synthesizes attendance, membership, evidence or a
      // personal receipt.
      const subject = readSets.find((item) => item.technicianUid === request.subjectUid)!;
      if (subject.receipt.exists || subject.audit.exists ||
          subject.membership.exists || subject.attendance.exists) {
        fail(
          "GUARD_FINALIZATION_INCONSISTENT",
          "The closure subject already has participation or application records; administrator review required.",
          409,
          "not_committed",
        );
      }
      const subjectSlots = (["incoming_clock_in", "incoming_late_acceptance"] as const).map((kind) =>
        createIncomingAcceptanceApplicationIdentity({
          handoverId: aggregate.reservation.handoverId,
          technicianUid: request.subjectUid,
          kind,
        }),
      );
      const subjectEvidence = await Promise.all(
        subjectSlots.flatMap((slot) => [
          transaction.get(attendanceEvidenceV2.doc(slot.evidenceId)),
          transaction.get(attendanceEvidenceOperationsV2.doc(slot.operationId)),
        ]),
      );
      if (subjectEvidence.some((snapshot) => snapshot.exists)) {
        fail(
          "GUARD_FINALIZATION_INCONSISTENT",
          "The closure subject has attendance evidence without a personal application; administrator review required.",
          409,
          "not_committed",
        );
      }

      closure = {
        closureId: request.closureId,
        subjectUid: request.subjectUid,
        authorizedBy: input.actorUid,
        reason,
        recordedAt: request.recordedAt,
        absenceReason: absence.reason.trim(),
      };
    }

    const terminalEvidenceRef =
      mode === "exceptional_closure" ? closureRequest!.closureId : activationReceiptId;
    const material = auditMaterial({
      mode,
      aggregate,
      handoverDocumentId: documentId,
      guard,
      terminalEvidenceRef,
      activationReceipt,
      applications: applicationsSummary,
      closure,
      actorUid: input.actorUid,
      nowIso: input.nowIso,
    });

    const auditRef = db.collection("audit_logs").doc(material.id);
    const existingAudit = await transaction.get(auditRef);
    if (existingAudit.exists) {
      // An active guard cannot carry a finalization audit: the two records
      // would contradict each other.
      fail(
        "GUARD_FINALIZATION_INCONSISTENT",
        "A guard finalization audit exists while the guard is still active.",
        409,
        "not_committed",
      );
    }

    // ---- writes ---------------------------------------------------------
    await completeReservationGuard(
      transaction,
      {
        outgoingShiftId: input.outgoingShiftId,
        protocolOwner: "v2",
        expectedGuardRevision: guard.guardRevision,
        expectedFencingEpoch: guard.fencingEpoch,
        receiptId: terminalEvidenceRef,
        outgoingSlotToken: identity.outgoingSlotToken,
        outgoingGeneration: identity.outgoingGeneration,
        successorSlotToken: identity.successorSlotToken,
        successorGeneration: identity.successorGeneration,
        recordedAt: input.nowIso,
        actorUid: input.actorUid,
      },
      guardState,
    );
    transaction.create(auditRef, { ...material, createdAt: FieldValue.serverTimestamp() });

    return {
      status: "FINALIZED" as const,
      replayed: false,
      mode,
      commitState: "committed_validated" as const,
      provenance: "phase4a_audited" as const,
      outgoingShiftId: input.outgoingShiftId,
      handoverDocumentId: documentId,
      incomingShiftId: incomingId,
      guardId: guard.id,
      guardRevision: guard.guardRevision + 1,
      terminalEvidenceRef,
      lifecycleState: "completed" as const,
      activationReceiptId,
      activationReceiptHash: activationReceipt.receiptHash,
      applications: applicationsSummary,
      closure,
      auditId: material.id,
      auditState: "created" as const,
    };
  });

  if (!result.replayed) {
    await assertCommitted(result, input.outgoingShiftId);
  }
  return result;
}

async function assertCommitted(
  result: FinalizeIncomingAcceptanceGuardResult,
  outgoingShiftId: string,
): Promise<void> {
  const { db } = getOperationalCollections();
  let guardSnapshot: DocumentSnapshot;
  let auditSnapshot: DocumentSnapshot;
  try {
    [guardSnapshot, auditSnapshot] = await Promise.all([
      db
        .collection("handover_reservation_guards")
        .doc(createHandoverReservationGuardDocumentId(outgoingShiftId))
        .get(),
      db.collection("audit_logs").doc(result.auditId).get(),
    ]);
  } catch {
    fail(
      "GUARD_FINALIZATION_OUTCOME_UNKNOWN",
      "The guard finalization commit could not be read back. Refresh guard status before retrying.",
      503,
      "committed_unreadable",
    );
  }
  const guard = guardSnapshot.exists
    ? documentRecord(guardSnapshot.data(), "reservation guard")
    : null;
  if (
    guard === null ||
    guard.ownerLifecycleState !== "completed" ||
    guard.terminalEvidenceRef !== result.terminalEvidenceRef ||
    guard.guardRevision !== result.guardRevision
  ) {
    fail(
      "GUARD_FINALIZATION_OUTCOME_UNKNOWN",
      "The guard finalization commit contradicts its read-back; administrator review is required before retrying.",
      503,
      "committed_inconsistent",
    );
  }
  if (!auditSnapshot.exists) {
    fail(
      "GUARD_FINALIZATION_OUTCOME_UNKNOWN",
      "The guard finalization audit could not be read back. Refresh guard status before retrying.",
      503,
      "committed_unreadable",
    );
  }
  if (!isTimestampValue(documentRecord(auditSnapshot.data(), "guard finalization audit").createdAt)) {
    fail(
      "GUARD_FINALIZATION_OUTCOME_UNKNOWN",
      "The guard finalization commit is not yet durable. Refresh guard status before retrying.",
      503,
      "committed_unresolved",
    );
  }
}
