import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
} from "firebase-admin/firestore";
import type {
  AttendanceEvidence,
  AttendanceEvidenceRequest,
  AttendanceOperation,
  AttendanceTrustedAuthentication,
} from "@/types/attendance-evidence";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import type {
  EqualHandoverIdentity,
  EqualHandoverReservation,
} from "@/types/equal-technician-handover";
import { getOperationalCollections } from "./collections";
import { readReservationGuardState } from "./handover-reservation-guard";
import { assertHandoverReservationGuard } from "./handover-reservation-guard-domain";
import { assertEqualHandoverAggregate } from "./equal-technician-handover-domain";
import {
  ALL_ATTENDANCE_EVIDENCE_KINDS,
  assertAttendanceEvidence,
  assertAttendanceEvidenceRequest,
  assertAttendanceGuardOwnership,
  assertAttendanceOperation,
  assertAttendanceRequestGuardBinding,
  attendanceEvidenceId,
  attendanceEvidenceRequestDigest,
  attendanceEvidenceSlotId,
  attendanceGuardExpectations,
  attendanceOperationId,
  buildAttendanceEvidence,
  createPendingAttendanceOperation,
  AttendanceEvidenceDomainError,
} from "./attendance-evidence-domain";

export { AttendanceEvidenceDomainError };

// ---------------------------------------------------------------------------
// AUTHORIZATION BOUNDARY — read before wiring any caller.
//
// These primitives are server-only and intentionally unexposed. They do NOT
// verify passwords or sessions themselves. `finalizeAttendanceEvidenceOperation`
// may only be invoked by the future trusted confirmation/acceptance
// coordinator AFTER it has verified a personal password-authenticated event
// (for colleague attestations: the reporting colleague's own verified
// session). A pending operation is never attendance, and nothing here may be
// surfaced through a public endpoint that lets callers finalize attendance
// without that verified personal authentication event.
// ---------------------------------------------------------------------------

export interface BeginAttendanceEvidenceInput {
  request: AttendanceEvidenceRequest;
}

export interface BeginAttendanceEvidenceResult {
  outcome: "created" | "idempotent_replay";
  operation: AttendanceOperation;
}

export interface FinalizeAttendanceEvidenceInput {
  operationId: string;
  identity: EqualHandoverIdentity;
  reservation: EqualHandoverReservation;
  trustedAuthentication: AttendanceTrustedAuthentication;
  // Server clock captured by the trusted coordinator at the moment it
  // verified the personal authentication event. All event times persist as
  // Firestore Timestamp values, keeping retries deterministic and the
  // original clock-in immutable.
  serverAuthenticationTime: string;
}

export interface FinalizeAttendanceEvidenceResult {
  operation: AttendanceOperation;
  evidence: AttendanceEvidence;
  // True when the finalize committed but the acknowledgement record could
  // not yet be read back; call resumeAttendanceEvidenceOperation to recover
  // the authoritative stored state.
  needsResume: boolean;
}

const EVIDENCE_TIME_FIELDS = [
  "eventTime",
  "clockIn",
  "clockOut",
  "finalizedAt",
  "createdAt",
] as const;

const OPERATION_TIME_FIELDS = ["requestedAt", "finalizedAt", "abortedAt"] as const;

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function toIso(value: unknown): string | null {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function hydrateFields(data: DocumentData, fields: readonly string[]): DocumentData {
  const hydrated: DocumentData = { ...data };
  for (const field of fields) {
    hydrated[field] = toIso(data[field]);
  }
  return hydrated;
}

function readOperationSnapshot(snapshot: DocumentSnapshot): AttendanceOperation | null {
  if (!snapshot.exists) {
    return null;
  }
  return assertAttendanceOperation(
    hydrateFields(snapshot.data() as DocumentData, OPERATION_TIME_FIELDS),
  );
}

function readEvidenceSnapshot(snapshot: DocumentSnapshot): AttendanceEvidence | null {
  if (!snapshot.exists) {
    return null;
  }
  return assertAttendanceEvidence(
    hydrateFields(snapshot.data() as DocumentData, EVIDENCE_TIME_FIELDS),
  );
}

function readGuardSnapshot(snapshot: DocumentSnapshot): HandoverReservationGuard | null {
  if (!snapshot.exists) {
    return null;
  }
  return assertHandoverReservationGuard(
    hydrateFields(snapshot.data() as DocumentData, ["createdAt", "updatedAt", "reservedAt"]),
  );
}

// Firestore keeps unresolved server-timestamp sentinels as null on read.
// eventTime/finalizedAt/createdAt are non-null on every evidence kind by
// domain contract, so a null there means the write is not yet resolvable.
function evidenceTimestampsResolved(data: DocumentData): boolean {
  return (
    toIso(data.eventTime) !== null &&
    toIso(data.finalizedAt) !== null &&
    toIso(data.createdAt) !== null
  );
}

function toStoredTimestamp(value: string | null): unknown {
  return value === null ? null : Timestamp.fromDate(new Date(value));
}

function persistEvidence(evidence: AttendanceEvidence): DocumentData {
  return {
    ...evidence,
    eventTime: toStoredTimestamp(evidence.eventTime),
    clockIn: toStoredTimestamp(evidence.clockIn),
    clockOut: toStoredTimestamp(evidence.clockOut),
    finalizedAt: toStoredTimestamp(evidence.finalizedAt),
    createdAt: toStoredTimestamp(evidence.createdAt),
  };
}

function persistOperation(operation: AttendanceOperation): DocumentData {
  return {
    ...operation,
    requestedAt: toStoredTimestamp(operation.requestedAt),
    finalizedAt: toStoredTimestamp(operation.finalizedAt),
    abortedAt: toStoredTimestamp(operation.abortedAt),
  };
}

function outgoingShiftIdFromHandoverDocument(handoverDocumentId: string): string {
  const prefix = "handover_v2_";
  if (!handoverDocumentId.startsWith(prefix) || handoverDocumentId.length === prefix.length) {
    throw new AttendanceEvidenceDomainError(
      "Attendance evidence requires a v2 equal-handover document binding.",
      400,
    );
  }
  return handoverDocumentId.slice(prefix.length);
}

async function transactionalGetAll(
  transaction: { get(ref: DocumentReference): Promise<DocumentSnapshot> },
  refs: DocumentReference[],
): Promise<DocumentSnapshot[]> {
  return Promise.all(refs.map((ref) => transaction.get(ref)));
}

function otherKindEvidenceRefs(
  handoverId: string,
  technicianUid: string,
  kind: string,
): DocumentReference[] {
  const { attendanceEvidenceV2 } = getOperationalCollections();
  return ALL_ATTENDANCE_EVIDENCE_KINDS.filter((item) => item !== kind).map(
    (item) => attendanceEvidenceV2.doc(
      attendanceEvidenceId(attendanceEvidenceSlotId({ handoverId, technicianUid, kind: item })),
    ),
  );
}

// Conflicting evidence for the same technician and handover must fail closed
// and remain auditable: a personal clock-out and a colleague-attested
// departure cannot coexist, and an attested departure may never replace a
// prior personal clock-out.
function assertNoCrossKindConflict(
  snapshots: DocumentSnapshot[],
  incomingKind: string,
  technicianUid: string,
): void {
  for (const snapshot of snapshots) {
    if (!snapshot.exists) {
      continue;
    }
    const other = readEvidenceSnapshot(snapshot);
    if (other === null || other.technicianUid !== technicianUid) {
      continue;
    }
    const personal = "outgoing_personal_clock_out";
    const attested = "outgoing_absent_departure_attestation";
    const pair = `${incomingKind}|${other.kind}`;
    if (
      pair === `${personal}|${attested}` ||
      pair === `${attested}|${personal}`
    ) {
      throw new AttendanceEvidenceDomainError(
        `Conflicting attendance evidence already exists (${other.kind} for ${other.technicianUid}); fail closed and remain auditable.`,
        409,
      );
    }
  }
}

export async function beginAttendanceEvidenceOperation(
  input: BeginAttendanceEvidenceInput,
): Promise<BeginAttendanceEvidenceResult> {
  const request = assertAttendanceEvidenceRequest(input.request);
  const { db, attendanceEvidenceV2, attendanceEvidenceOperationsV2 } = getOperationalCollections();
  const outgoingShiftId = outgoingShiftIdFromHandoverDocument(request.handoverDocumentId);

  const operationId = attendanceOperationId(request.eventId);
  try {
    return await db.runTransaction(async (transaction) => {
      const operationRef = attendanceEvidenceOperationsV2.doc(operationId);
      const existingOperation = readOperationSnapshot(await transaction.get(operationRef));
      if (existingOperation !== null) {
        if (existingOperation.requestDigest !== attendanceEvidenceRequestDigest(request)) {
          throw new AttendanceEvidenceDomainError(
            "A different attendance operation already exists for this event ID; the retry conflicts and the stored operation is preserved unchanged.",
            409,
          );
        }
        return { outcome: "idempotent_replay" as const, operation: existingOperation };
      }

      const slotId = attendanceEvidenceSlotId({
        handoverId: request.handoverId,
        technicianUid: request.technicianUid,
        kind: request.kind,
      });
      const [slotSnapshot, ...otherKindSnapshots] = await transactionalGetAll(transaction, [
        attendanceEvidenceV2.doc(attendanceEvidenceId(slotId)),
        ...otherKindEvidenceRefs(request.handoverId, request.technicianUid, request.kind),
      ]);
      if (slotSnapshot.exists) {
        throw new AttendanceEvidenceDomainError(
          "Attendance evidence already exists for this slot; duplicate operations are rejected.",
          409,
        );
      }
      assertNoCrossKindConflict(otherKindSnapshots, request.kind, request.technicianUid);

      const guardState = await readReservationGuardState(transaction, outgoingShiftId);
      assertAttendanceRequestGuardBinding(readGuardSnapshot(guardState.guardSnapshot), request);

      const operation = createPendingAttendanceOperation(request);
      // requestedAt is stamped with the Firestore-acknowledged clock of this
      // server process at request acceptance; it is audit metadata, while all
      // event times come from the trusted coordinator's server authentication
      // time and are immutable once written.
      transaction.create(operationRef, persistOperation({
        ...operation,
        requestedAt: new Date().toISOString(),
      }));
      return { outcome: "created" as const, operation };
    });
  } catch (error) {
    // Concurrent identical begin: the other transaction created the
    // operation; converge onto the stored authoritative record.
    if (isAlreadyExistsError(error)) {
      const operation = readOperationSnapshot(
        await attendanceEvidenceOperationsV2.doc(operationId).get(),
      );
      if (
        operation !== null &&
        operation.requestDigest === attendanceEvidenceRequestDigest(request)
      ) {
        return { outcome: "idempotent_replay", operation };
      }
    }
    throw error;
  }
}

export async function finalizeAttendanceEvidenceOperation(
  input: FinalizeAttendanceEvidenceInput,
): Promise<FinalizeAttendanceEvidenceResult> {
  if (!isCanonicalTimestamp(input.serverAuthenticationTime)) {
    throw new AttendanceEvidenceDomainError("Invalid canonical server authentication time.", 400);
  }
  const { db, attendanceEvidenceV2, attendanceEvidenceOperationsV2, handovers } =
    getOperationalCollections();

  await db.runTransaction(async (transaction) => {
    const operationRef = attendanceEvidenceOperationsV2.doc(input.operationId);
    const operation = readOperationSnapshot(await transaction.get(operationRef));
    if (operation === null) {
      throw new AttendanceEvidenceDomainError("Attendance operation not found.", 404);
    }
    if (operation.status === "aborted") {
      throw new AttendanceEvidenceDomainError(
        `Attendance operation was aborted: ${operation.abortReason ?? "unknown"}`,
        409,
      );
    }
    if (operation.status === "finalized") {
      // Terminal already: never re-time and never overwrite. The read-back
      // step returns the authoritative stored state.
      return;
    }

    const request = operation.request;
    const outgoingShiftId = outgoingShiftIdFromHandoverDocument(request.handoverDocumentId);
    const evidenceRef = attendanceEvidenceV2.doc(operation.evidenceId);
    const evidenceSnapshot = await transaction.get(evidenceRef);
    const guardState = await readReservationGuardState(transaction, outgoingShiftId);
    const otherKindSnapshots = await transactionalGetAll(
      transaction,
      otherKindEvidenceRefs(request.handoverId, request.technicianUid, request.kind),
    );

    assertNoCrossKindConflict(otherKindSnapshots, request.kind, request.technicianUid);

    const guard = readGuardSnapshot(guardState.guardSnapshot);
    assertAttendanceGuardOwnership(guard, {
      ...attendanceGuardExpectations(input.reservation),
      expectedGuardRevision: request.expectedGuardRevision,
      expectedFencingEpoch: request.expectedFencingEpoch,
    });

    // The live handover document must still carry the exact identity the
    // coordinator supplies; a superseded/cancelled handover or a stale
    // handover identity blocks finalization.
    const handoverSnapshot = await transaction.get(handovers.doc(request.handoverDocumentId));
    if (!handoverSnapshot.exists) {
      throw new AttendanceEvidenceDomainError(
        "The v2 handover document is missing; refusing to finalize attendance evidence.",
        409,
      );
    }
    const aggregate = assertEqualHandoverAggregate(handoverSnapshot.data());
    if (aggregate.lifecycleStatus === "cancelled" || aggregate.lifecycleStatus === "superseded") {
      throw new AttendanceEvidenceDomainError(
        `Handover is ${aggregate.lifecycleStatus}; attendance finalization is blocked.`,
        409,
      );
    }
    if (
      !isCanonicalTimestamp(input.serverAuthenticationTime) ||
      canonicalJson(aggregate.identity) !== canonicalJson(input.identity)
    ) {
      throw new AttendanceEvidenceDomainError(
        "Attendance evidence coordinator identity is stale for the stored handover aggregate.",
        409,
      );
    }

    if (evidenceSnapshot.exists) {
      const stored = readEvidenceSnapshot(evidenceSnapshot);
      if (stored !== null && stored.operationId !== operation.id) {
        // A different event already produced evidence for this slot. The
        // original event is authoritative: reject the duplicate instead of
        // re-timing or overwriting it, and leave both records auditable.
        throw new AttendanceEvidenceDomainError(
          `Duplicate attendance evidence blocked for ${request.kind} (${stored.operationId} already finalized this slot); the original event is preserved.`,
          409,
        );
      }
      // A prior finalize committed but its acknowledgement was interrupted.
      // The stored evidence is authoritative; the read-back step completes
      // the operation record. Never re-time or overwrite the event here.
      return;
    }

    const evidence = buildAttendanceEvidence({
      operation,
      serverTime: input.serverAuthenticationTime,
      guard,
      reservation: input.reservation,
      identity: input.identity,
      trustedAuthentication: input.trustedAuthentication,
    });

    transaction.create(evidenceRef, persistEvidence(evidence));
    transaction.set(operationRef, persistOperation(assertAttendanceOperation({
      ...operation,
      status: "finalized",
      interruptedFinalization: true,
      finalizedAt: evidence.finalizedAt,
    })));
  });

  try {
    const recovered = await completeFinalizationAcknowledgement(input.operationId);
    return { ...recovered, needsResume: false };
  } catch (error) {
    if (
      error instanceof AttendanceEvidenceDomainError &&
      error.message.includes("resumeAttendanceEvidenceOperation")
    ) {
      const stored = await readStoredAttendanceEvidence(input.operationId);
      return { operation: stored.operation, evidence: stored.evidence, needsResume: true };
    }
    throw error;
  }
}

// Recovery entry point for an operation interrupted between transaction
// commit and acknowledgement. Idempotent; returns the authoritative stored
// state once the evidence is resolvable, and clears the interrupted flag.
export async function resumeAttendanceEvidenceOperation(
  operationId: string,
): Promise<FinalizeAttendanceEvidenceResult> {
  const result = await completeFinalizationAcknowledgement(operationId);
  return { ...result, needsResume: false };
}

// Coordinator-side controlled abort of a pending operation (for example a
// failed password check). Terminal; pending work is never presented as
// attendance, and the abort record remains auditable.
export async function abortAttendanceEvidenceOperation(
  operationId: string,
  abortReason: string,
): Promise<AttendanceOperation> {
  if (typeof abortReason !== "string" || !abortReason.trim()) {
    throw new AttendanceEvidenceDomainError("An abort requires a meaningful reason.", 400);
  }
  const { db, attendanceEvidenceOperationsV2 } = getOperationalCollections();
  const operationRef = attendanceEvidenceOperationsV2.doc(operationId);
  return db.runTransaction(async (transaction) => {
    const operation = readOperationSnapshot(await transaction.get(operationRef));
    if (operation === null) {
      throw new AttendanceEvidenceDomainError("Attendance operation not found.", 404);
    }
    if (operation.status !== "pending") {
      throw new AttendanceEvidenceDomainError(
        `Only pending attendance operations can be aborted (current status: ${operation.status}).`,
        409,
      );
    }
    const aborted = assertAttendanceOperation({
      ...operation,
      status: "aborted",
      abortedAt: new Date().toISOString(),
      abortReason: abortReason.trim(),
    });
    transaction.set(operationRef, persistOperation(aborted));
    return aborted;
  });
}

// Authoritative stored state for one (handover, technician, kind) slot.
// Evidence is only ever returned from finalized operations; a pending
// operation is reported with its status and is never presented as attendance.
export async function readAttendanceEvidenceState(input: {
  handoverId: string;
  technicianUid: string;
  kind: AttendanceEvidenceRequest["kind"];
}): Promise<{ operation: AttendanceOperation | null; evidence: AttendanceEvidence | null }> {
  const { attendanceEvidenceV2, attendanceEvidenceOperationsV2 } = getOperationalCollections();
  const slotId = attendanceEvidenceSlotId(input);
  const evidence = readEvidenceSnapshot(
    await attendanceEvidenceV2.doc(attendanceEvidenceId(slotId)).get(),
  );
  if (evidence === null) {
    return { operation: null, evidence: null };
  }
  const operation = readOperationSnapshot(
    await attendanceEvidenceOperationsV2.doc(evidence.operationId).get(),
  );
  return { operation, evidence };
}

async function completeFinalizationAcknowledgement(
  operationId: string,
): Promise<{ operation: AttendanceOperation; evidence: AttendanceEvidence }> {
  const { attendanceEvidenceV2, attendanceEvidenceOperationsV2 } = getOperationalCollections();
  const operationRef = attendanceEvidenceOperationsV2.doc(operationId);
  const operation = readOperationSnapshot(await operationRef.get());
  if (operation === null) {
    throw new AttendanceEvidenceDomainError("Attendance operation not found.", 404);
  }
  if (operation.status === "aborted") {
    throw new AttendanceEvidenceDomainError(
      `Attendance operation was aborted: ${operation.abortReason ?? "unknown"}`,
      409,
    );
  }
  if (operation.status === "pending") {
    throw new AttendanceEvidenceDomainError(
      "Attendance operation is still pending; finalization requires the trusted confirmation/acceptance coordinator.",
      409,
    );
  }
  const evidenceSnapshot = await attendanceEvidenceV2.doc(operation.evidenceId).get();
  if (!evidenceSnapshot.exists) {
    throw new AttendanceEvidenceDomainError(
      "Finalized attendance operation is missing its evidence document; refusing to guess state.",
      409,
    );
  }
  const hydrated = hydrateFields(evidenceSnapshot.data() as DocumentData, EVIDENCE_TIME_FIELDS);
  if (!evidenceTimestampsResolved(hydrated)) {
    throw new AttendanceEvidenceDomainError(
      "Attendance evidence server clock is not yet resolvable; retry resumeAttendanceEvidenceOperation.",
      409,
    );
  }
  const evidence = assertAttendanceEvidence(hydrated);
  if (operation.interruptedFinalization) {
    const recovered = assertAttendanceOperation({
      ...operation,
      interruptedFinalization: false,
      finalizedAt: evidence.finalizedAt,
    });
    await operationRef.set(persistOperation(recovered));
    return { operation: recovered, evidence };
  }
  return { operation, evidence };
}

async function readStoredAttendanceEvidence(operationId: string): Promise<{
  operation: AttendanceOperation;
  evidence: AttendanceEvidence;
}> {
  const { attendanceEvidenceV2, attendanceEvidenceOperationsV2 } = getOperationalCollections();
  const operation = readOperationSnapshot(
    await attendanceEvidenceOperationsV2.doc(operationId).get(),
  );
  if (operation === null) {
    throw new AttendanceEvidenceDomainError("Attendance operation not found.", 404);
  }
  const evidence = readEvidenceSnapshot(
    await attendanceEvidenceV2.doc(operation.evidenceId).get(),
  );
  if (evidence === null) {
    throw new AttendanceEvidenceDomainError(
      "Finalized attendance operation is missing its evidence document.",
      409,
    );
  }
  return { operation, evidence };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === 6
  );
}
