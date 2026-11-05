// 09M-R3B.2 Phase 4A — read-only incoming acceptance reconciliation.
//
// Answers one question for one personally authenticated technician: is my
// acceptance applied and provable from the authoritative records? It reads the
// deterministic receipt, evidence, finalized operation, membership, attendance,
// application audit, activation receipt, guard and aggregate inside one
// read-only transaction. It never writes, never returns a success because an
// evidence document exists, and never reports a definitive failure when the
// commit marker is unresolved.
//
// There is no public status endpoint yet; Phase 5 owns HTTP integration.

import "server-only";

import type { AttendanceEvidence } from "@/types/attendance-evidence";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import {
  INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS,
  type IncomingAcceptanceApplicationReceipt,
  type IncomingAcceptanceIncomingShiftRecord,
  type IncomingAcceptanceLegacyClassification,
  type IncomingAcceptanceLegacyState,
  type IncomingAcceptanceOutcome,
} from "@/types/incoming-acceptance-application";
import { AssignmentOperationError } from "./assignment-transaction";
import { getOperationalCollections } from "./collections";
import {
  assertIncomingAcceptanceActivationReceipt,
  classifyIncomingAcceptanceLegacyState,
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
import { readReservationGuardState } from "./handover-reservation-guard";
import {
  authorizeTechnicianProfile,
  readV2Aggregate,
  requireV2GuardBinding,
} from "./equal-handover-report-firestore";
import {
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
} from "./equal-technician-handover-domain";
import { readAttendanceEvidenceSnapshot } from "./attendance-evidence-firestore-state";

export const INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES = {
  APPLIED_VALIDATED: "APPLIED_VALIDATED",
  NOT_APPLIED: "NOT_APPLIED",
  EVIDENCE_ONLY: "EVIDENCE_ONLY",
  COMMIT_UNVERIFIABLE: "COMMIT_UNVERIFIABLE",
  BINDING_CONFLICT: "BINDING_CONFLICT",
  GUARD_CONFLICT: "GUARD_CONFLICT",
  INCONSISTENT_HISTORY: "INCONSISTENT_HISTORY",
  ADMIN_REVIEW_REQUIRED: "ADMIN_REVIEW_REQUIRED",
} as const;

export type IncomingAcceptanceReconciliationStatus =
  (typeof INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES)[keyof typeof INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES];

export type ReconciliationErrorCode =
  | "RECONCILIATION_UNAUTHORIZED"
  | "RECONCILIATION_NOT_FOUND"
  | "RECONCILIATION_UNAVAILABLE";

export class IncomingAcceptanceReconciliationError extends Error {
  public readonly code: ReconciliationErrorCode;
  public readonly status: number;

  constructor(code: ReconciliationErrorCode, message: string, status: number) {
    super(message);
    this.name = "IncomingAcceptanceReconciliationError";
    this.code = code;
    this.status = status;
  }
}

export interface ReconcileIncomingAcceptanceInput {
  outgoingShiftId: string;
  /** Server-derived authenticated technician; never a request body UID. */
  technicianUid: string;
}

export interface IncomingAcceptanceReconciliationResult {
  readOnly: true;
  status: IncomingAcceptanceReconciliationStatus;
  reason: string;
  technicianUid: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  aggregateLifecycleStatus: string;
  applied: boolean;
  /** A retry by this technician would replay, not create a new application. */
  retryWouldReplay: boolean;
  requiresAdministrativeReview: boolean;
  outcome: IncomingAcceptanceOutcome | null;
  receiptId: string | null;
  receiptHash: string | null;
  operationalAppliedAt: string | null;
  activationReceiptId: string | null;
  activationReceiptHash: string | null;
  partnerTechnicianUid: string;
  partnerApplied: boolean;
  guardLifecycleState: HandoverReservationGuard["ownerLifecycleState"] | null;
  guardTerminalEvidenceRef: string | null;
  evidencePresent: boolean;
  operationFinalized: boolean;
  membershipPresent: boolean;
  attendancePresent: boolean;
  applicationAuditPresent: boolean;
  legacyClassification: IncomingAcceptanceLegacyClassification | null;
}

function fail(code: ReconciliationErrorCode, message: string, status: number): never {
  throw new IncomingAcceptanceReconciliationError(code, message, status);
}

function receiptIdFor(handoverId: string, technicianUid: string): string {
  return createIncomingAcceptanceApplicationIdentity({
    handoverId,
    technicianUid,
    kind: "incoming_clock_in",
  }).receiptId;
}

function auditIdFor(handoverId: string, technicianUid: string): string {
  return createIncomingAcceptanceApplicationIdentity({
    handoverId,
    technicianUid,
    kind: "incoming_clock_in",
  }).auditId;
}

function baseResult(input: {
  status: IncomingAcceptanceReconciliationStatus;
  reason: string;
  technicianUid: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  aggregateLifecycleStatus: string;
  partnerTechnicianUid: string;
  partnerApplied: boolean;
  guard: HandoverReservationGuard | null;
  activationReceipt: IncomingAcceptanceActivationReceipt | null;
}): IncomingAcceptanceReconciliationResult {
  return {
    readOnly: true,
    status: input.status,
    reason: input.reason,
    technicianUid: input.technicianUid,
    handoverDocumentId: input.handoverDocumentId,
    outgoingShiftId: input.outgoingShiftId,
    incomingShiftId: input.incomingShiftId,
    aggregateLifecycleStatus: input.aggregateLifecycleStatus,
    applied: input.status === INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.APPLIED_VALIDATED,
    retryWouldReplay:
      input.status === INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.APPLIED_VALIDATED,
    requiresAdministrativeReview:
      input.status === INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.ADMIN_REVIEW_REQUIRED ||
      input.status === INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY ||
      input.status === INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.BINDING_CONFLICT ||
      input.status === INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.GUARD_CONFLICT,
    outcome: null,
    receiptId: null,
    receiptHash: null,
    operationalAppliedAt: null,
    activationReceiptId: input.activationReceipt?.id ?? null,
    activationReceiptHash: input.activationReceipt?.receiptHash ?? null,
    partnerTechnicianUid: input.partnerTechnicianUid,
    partnerApplied: input.partnerApplied,
    guardLifecycleState: input.guard?.ownerLifecycleState ?? null,
    guardTerminalEvidenceRef: input.guard?.terminalEvidenceRef ?? null,
    evidencePresent: false,
    operationFinalized: false,
    membershipPresent: false,
    attendancePresent: false,
    applicationAuditPresent: false,
    legacyClassification: null,
  };
}

function legacyStatus(
  classification: IncomingAcceptanceLegacyClassification,
): { status: IncomingAcceptanceReconciliationStatus; reason: string } {
  switch (classification) {
    case INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS.NATIVE_APPLIED:
      return {
        status: INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.APPLIED_VALIDATED,
        reason: "NATIVE_RECEIPT_VALIDATED",
      };
    case INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS.NOT_APPLIED:
      return {
        status: INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.NOT_APPLIED,
        reason: "NO_APPLICATION_RECORD",
      };
    case INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS.LEGACY_APPLIED_UNATTESTED_V1:
      return {
        status: INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.ADMIN_REVIEW_REQUIRED,
        reason: "LEGACY_APPLIED_WITHOUT_PERSONAL_RECEIPT",
      };
    case INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS.LEGACY_UNAPPLIED_AUTHENTICATED_ATTEMPT:
      return {
        status: INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.EVIDENCE_ONLY,
        reason: "EVIDENCE_WITHOUT_OPERATIONAL_APPLICATION",
      };
    case INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS.LEGACY_PENDING_INTENT:
      return {
        status: INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.COMMIT_UNVERIFIABLE,
        reason: "PENDING_OPERATION_WITHOUT_EVIDENCE",
      };
    case INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS.LEGACY_ACK_INTERRUPTED:
      return {
        status: INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.COMMIT_UNVERIFIABLE,
        reason: "INTERRUPTED_FINALIZATION",
      };
    case INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS.LEGACY_ABORTED_INTENT:
      return {
        status: INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.NOT_APPLIED,
        reason: "ABORTED_OPERATION",
      };
    case INCOMING_ACCEPTANCE_LEGACY_CLASSIFICATIONS.INCONSISTENT_REVIEW_REQUIRED:
      return {
        status: INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY,
        reason: "CONTRADICTORY_RECORDS",
      };
  }
}

export async function reconcileIncomingAcceptance(
  input: ReconcileIncomingAcceptanceInput,
): Promise<IncomingAcceptanceReconciliationResult> {
  const {
    db,
    equalHandoversV2,
    shiftMembers,
    shiftAttendance,
    attendanceEvidenceV2,
    attendanceEvidenceOperationsV2,
    handoverReportsV2,
  } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);

  try {
    return await db.runTransaction<IncomingAcceptanceReconciliationResult>(async (transaction) => {
      const [profileSnapshot, aggregateSnapshot, guardState] = await Promise.all([
        transaction.get(db.collection("users").doc(input.technicianUid)),
        transaction.get(equalHandoversV2.doc(documentId)),
        readReservationGuardState(transaction, input.outgoingShiftId),
      ]);
      if (!aggregateSnapshot.exists) {
        fail("RECONCILIATION_NOT_FOUND", "The equal handover reservation was not found.", 404);
      }
      const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
      const identity = aggregate.identity;
      const incomingId = identity.incomingShiftId;

      const profile = profileSnapshot.data() as Record<string, unknown> | undefined;
      try {
        authorizeTechnicianProfile(profile, input.technicianUid);
      } catch {
        fail(
          "RECONCILIATION_UNAUTHORIZED",
          "Only a live reserved incoming technician can reconcile this acceptance.",
          403,
        );
      }
      if (!identity.incomingTechnicianIds.includes(input.technicianUid)) {
        fail(
          "RECONCILIATION_UNAUTHORIZED",
          "Only a reserved incoming technician can reconcile this acceptance.",
          403,
        );
      }
      const partnerTechnicianUid = identity.incomingTechnicianIds.find(
        (uid) => uid !== input.technicianUid,
      ) as string;

      let guard: HandoverReservationGuard | null = null;
      let guardConflict: string | null = null;
      try {
        guard = requireV2GuardBinding(
          guardState.guardSnapshot.exists,
          guardState.guardSnapshot.data(),
          documentId,
          aggregate,
        );
        if (guard.ownerLifecycleState === "cancelled") {
          guardConflict = "The reservation guard was cancelled.";
        }
      } catch (error) {
        if (error instanceof AssignmentOperationError) {
          guardConflict = error.message;
        } else {
          throw error;
        }
      }

      const activationReceiptId = createIncomingAcceptanceActivationReceiptId(documentId);
      const reportId = aggregate.reportBinding?.id ?? null;
      const [
        activationSnapshot,
        incomingSnapshot,
        reportSnapshot,
      ] = await Promise.all([
        transaction.get(db.collection("audit_logs").doc(activationReceiptId)),
        transaction.get(db.collection("shifts").doc(incomingId)),
        reportId === null
          ? Promise.resolve(null)
          : transaction.get(handoverReportsV2.doc(reportId)),
      ]);
      const incomingShift = incomingSnapshot.exists
        ? (incomingSnapshot.data() as IncomingAcceptanceIncomingShiftRecord)
        : null;
      let activationReceipt: IncomingAcceptanceActivationReceipt | null = null;
      if (activationSnapshot.exists) {
        try {
          assertIncomingAcceptanceActivationReceipt(activationSnapshot.data(), {
            handoverDocumentId: documentId,
            outgoingShiftId: input.outgoingShiftId,
            incomingShiftId: incomingId,
            boundReportId: reportId ?? "",
          });
          activationReceipt =
            activationSnapshot.data() as unknown as IncomingAcceptanceActivationReceipt;
        } catch {
          activationReceipt = null;
        }
      }

      const slots = (["incoming_clock_in", "incoming_late_acceptance"] as const).map((kind) => ({
        kind,
        identity: createIncomingAcceptanceApplicationIdentity({
          handoverId: aggregate.reservation.handoverId,
          technicianUid: input.technicianUid,
          kind,
        }),
      }));
      const receiptIds = [
        receiptIdFor(aggregate.reservation.handoverId, input.technicianUid),
        receiptIdFor(aggregate.reservation.handoverId, partnerTechnicianUid),
      ];
      const [
        receiptSnapshot,
        partnerReceiptSnapshot,
        membershipSnapshot,
        attendanceSnapshot,
        auditSnapshot,
        slotEvidenceSnapshots,
        slotOperationSnapshots,
      ] = await Promise.all([
        transaction.get(db.collection("incoming_acceptance_applications_v1").doc(receiptIds[0])),
        transaction.get(db.collection("incoming_acceptance_applications_v1").doc(receiptIds[1])),
        transaction.get(shiftMembers.doc(`${incomingId}_${input.technicianUid}`)),
        transaction.get(shiftAttendance.doc(`${incomingId}_${input.technicianUid}`)),
        transaction.get(
          db.collection("audit_logs").doc(
            auditIdFor(aggregate.reservation.handoverId, input.technicianUid),
          ),
        ),
        Promise.all(slots.map((slot) =>
          transaction.get(attendanceEvidenceV2.doc(slot.identity.evidenceId)),
        )),
        Promise.all(slots.map((slot) =>
          transaction.get(attendanceEvidenceOperationsV2.doc(slot.identity.operationId)),
        )),
      ]);

      const partnerApplied = partnerReceiptSnapshot.exists;
      const base = (status: IncomingAcceptanceReconciliationStatus, reason: string) =>
        baseResult({
          status,
          reason,
          technicianUid: input.technicianUid,
          handoverDocumentId: documentId,
          outgoingShiftId: input.outgoingShiftId,
          incomingShiftId: incomingId,
          aggregateLifecycleStatus: aggregate.lifecycleStatus,
          partnerTechnicianUid,
          partnerApplied,
          guard,
          activationReceipt,
        });

      // ---- native receipt path -------------------------------------------
      if (receiptSnapshot.exists) {
        let receipt: IncomingAcceptanceApplicationReceipt;
        try {
          receipt = readPersistedReceipt(receiptSnapshot.data());
        } catch (error) {
          if (error instanceof AtomicAcceptanceServiceError) {
            return {
              ...base(
                INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.COMMIT_UNVERIFIABLE,
                "COMMIT_MARKER_UNRESOLVED",
              ),
              receiptId: receiptIds[0],
            };
          }
          return {
            ...base(
              INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY,
              "MALFORMED_APPLICATION_RECEIPT",
            ),
            receiptId: receiptIds[0],
          };
        }

        if (activationReceipt === null) {
          return {
            ...base(
              INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY,
              "ACTIVATION_RECEIPT_MISSING",
            ),
            receiptId: receipt.id,
          };
        }
        if (aggregate.lifecycleStatus !== "completed") {
          return {
            ...base(
              INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY,
              "APPLICATION_RECEIPT_WITHOUT_ACTIVATION",
            ),
            receiptId: receipt.id,
          };
        }

        const slotIndex = slots.findIndex(
          (slot) => slot.identity.evidenceId === receipt.evidenceId,
        );
        if (slotIndex === -1) {
          return {
            ...base(
              INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY,
              "RECEIPT_EVIDENCE_SLOT_UNKNOWN",
            ),
            receiptId: receipt.id,
          };
        }
        const evidenceSnapshot = slotEvidenceSnapshots[slotIndex];
        const operationSnapshot = slotOperationSnapshots[slotIndex];

        let verified: IncomingAcceptanceApplicationReceipt;
        try {
          verified = verifyIncomingAcceptanceApplication({
            aggregate,
            handoverDocumentId: documentId,
            technicianUid: input.technicianUid,
            expectedReceiptId: receiptIds[0],
            activationReceipt,
            incomingShift,
            snapshots: {
              receipt: receiptSnapshot,
              evidence: evidenceSnapshot,
              operation: operationSnapshot,
              membership: membershipSnapshot,
              attendance: attendanceSnapshot,
              audit: auditSnapshot,
            },
            allowHistoricalDeparture: true,
          });
        } catch (error) {
          if (!(error instanceof IncomingAcceptanceVerificationError)) throw error;
          const status =
            error.code === "UNRESOLVED_COMMIT"
              ? INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.COMMIT_UNVERIFIABLE
              : error.code === "BINDING_CONFLICT"
                ? INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.BINDING_CONFLICT
                : INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY;
          return {
            ...base(
              status,
              error.code === "UNRESOLVED_COMMIT"
                ? "COMMIT_MARKER_UNRESOLVED"
                : error.message,
            ),
            receiptId: receipt.id,
            receiptHash: receipt.receiptHash,
          };
        }

        // The guard is part of the same proof: a missing or foreign guard means
        // the application cannot be reconciled without administrator review.
        if (guardConflict !== null || guard === null) {
          return {
            ...base(
              INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.GUARD_CONFLICT,
              "GUARD_BINDING_INCONSISTENT",
            ),
            receiptId: verified.id,
            receiptHash: verified.receiptHash,
            outcome: verified.outcome,
            operationalAppliedAt: verified.operationalAppliedAt,
          };
        }
        if (guard.ownerLifecycleState === "active" &&
            (verified.appliedGuardBinding.guardRevision !== guard.guardRevision ||
              verified.appliedGuardBinding.fencingEpoch !== guard.fencingEpoch)) {
          return {
            ...base(
              INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.GUARD_CONFLICT,
              "GUARD_REVISION_CHANGED_SINCE_APPLICATION",
            ),
            receiptId: verified.id,
            receiptHash: verified.receiptHash,
            outcome: verified.outcome,
            operationalAppliedAt: verified.operationalAppliedAt,
          };
        }

        // The frozen report binding is immutable evidence of what was reviewed.
        if (aggregate.reportBinding === null) {
          return {
            ...base(
              INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.BINDING_CONFLICT,
              "FROZEN_REPORT_BINDING_MISSING",
            ),
            receiptId: verified.id,
            receiptHash: verified.receiptHash,
            outcome: verified.outcome,
            operationalAppliedAt: verified.operationalAppliedAt,
          };
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
          return {
            ...base(
              INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.BINDING_CONFLICT,
              "FROZEN_REPORT_BINDING_CHANGED",
            ),
            receiptId: verified.id,
            receiptHash: verified.receiptHash,
            outcome: verified.outcome,
            operationalAppliedAt: verified.operationalAppliedAt,
          };
        }

        // Two first activations would mean two technicians both claimed the
        // activation; that is contradictory history, not a valid application.
        if (partnerApplied) {
          try {
            const partner = readPersistedReceipt(partnerReceiptSnapshot.data());
            if (partner.outcome === verified.outcome) {
              return {
                ...base(
                  INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY,
                  "DUPLICATE_APPLICATION_OUTCOME",
                ),
                receiptId: verified.id,
                receiptHash: verified.receiptHash,
                outcome: verified.outcome,
                operationalAppliedAt: verified.operationalAppliedAt,
              };
            }
          } catch {
            // An unreadable partner receipt does not invalidate this receipt.
          }
        }

        return {
          ...base(
            INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.APPLIED_VALIDATED,
            "RECEIPT_EVIDENCE_PARTICIPATION_AUDIT_VALIDATED",
          ),
          outcome: verified.outcome,
          receiptId: verified.id,
          receiptHash: verified.receiptHash,
          operationalAppliedAt: verified.operationalAppliedAt,
          evidencePresent: true,
          operationFinalized: true,
          membershipPresent: true,
          attendancePresent: true,
          applicationAuditPresent: true,
        };
      }

      // ---- no native receipt: classify the historical state --------------
      const presentEvidence = slotEvidenceSnapshots.filter((snapshot) => snapshot.exists);
      if (presentEvidence.length > 1) {
        return base(
          INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY,
          "MULTIPLE_EVIDENCE_SLOTS",
        );
      }
      // A per-person application audit without its receipt is contradictory in
      // every protocol version; the receipt is written in the same commit.
      if (auditSnapshot.exists) {
        return base(
          INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY,
          "APPLICATION_AUDIT_WITHOUT_RECEIPT",
        );
      }
      // The v2 aggregate completes at activation, before the partner joins, so
      // a reserved technician with no application artifact at all has simply
      // not applied. This must not be read as contradictory legacy history.
      if (
        presentEvidence.length === 0 &&
        slotOperationSnapshots.every((snapshot) => !snapshot.exists) &&
        !membershipSnapshot.exists &&
        !attendanceSnapshot.exists
      ) {
        return base(
          INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.NOT_APPLIED,
          "NO_APPLICATION_RECORD",
        );
      }
      const slotIndex = slotEvidenceSnapshots.findIndex((snapshot) => snapshot.exists);
      let evidenceDoc: AttendanceEvidence | null = null;
      try {
        evidenceDoc = slotIndex === -1
          ? null
          : readAttendanceEvidenceSnapshot(slotEvidenceSnapshots[slotIndex]);
      } catch {
        return base(
          INCOMING_ACCEPTANCE_RECONCILIATION_STATUSES.INCONSISTENT_HISTORY,
          "MALFORMED_EVIDENCE_RECORD",
        );
      }
      const operationData = slotIndex === -1
        ? undefined
        : (slotOperationSnapshots[slotIndex].data() as
            | { status?: unknown; interruptedFinalization?: unknown }
            | undefined);

      const legacyState: IncomingAcceptanceLegacyState = {
        aggregateLifecycleStatus: aggregate.lifecycleStatus,
        activationReceiptPresent: activationSnapshot.exists,
        activationReceiptConsistent: activationReceipt !== null,
        membershipPresent: membershipSnapshot.exists,
        attendancePresent: attendanceSnapshot.exists,
        evidence: evidenceDoc === null
          ? null
          : {
              present: true,
              finalized: operationData?.status === "finalized",
              interruptedFinalization: operationData?.interruptedFinalization === true,
            },
        operation: slotIndex === -1
          ? null
          : {
              present: true,
              status: typeof operationData?.status === "string" ? operationData.status : "unknown",
            },
        nativeReceipt: null,
      };
      const classified = classifyIncomingAcceptanceLegacyState(legacyState);
      const mapped = legacyStatus(classified.classification);

      return {
        ...base(mapped.status, mapped.reason),
        evidencePresent: evidenceDoc !== null,
        operationFinalized: operationData?.status === "finalized",
        membershipPresent: membershipSnapshot.exists,
        attendancePresent: attendanceSnapshot.exists,
        applicationAuditPresent: auditSnapshot.exists,
        legacyClassification: classified.classification,
      };
    });
  } catch (error) {
    if (error instanceof IncomingAcceptanceReconciliationError) throw error;
    // An unreadable store is never a definitive "not applied" answer.
    throw new IncomingAcceptanceReconciliationError(
      "RECONCILIATION_UNAVAILABLE",
      "Acceptance status cannot be verified right now. Refresh status before retrying.",
      503,
    );
  }
}
