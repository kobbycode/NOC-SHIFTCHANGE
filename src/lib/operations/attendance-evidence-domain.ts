import { createHash } from "node:crypto";
import {
  ATTENDANCE_AUTHENTICATION_METHODS,
  ATTENDANCE_CLOCK_IN_EVIDENCE_KINDS,
  ATTENDANCE_EVIDENCE_KINDS,
  ATTENDANCE_EVIDENCE_SCHEMA,
  ATTENDANCE_OPERATION_STATUSES,
  ATTENDANCE_PERSONALLY_AUTHENTICATED_METHODS,
  type AttendanceAuthenticationMethod,
  type AttendanceEvidence,
  type AttendanceEvidenceKind,
  type AttendanceEvidenceRequest,
  type AttendanceOperation,
  type AttendanceOperationStatus,
  type AttendanceTrustedAuthentication,
} from "@/types/attendance-evidence";
import type {
  HandoverReservationGuard,
  HandoverProtocolOwner,
} from "@/types/handover-reservation-guard";
import type {
  EqualHandoverIdentity,
  EqualHandoverReservation,
} from "@/types/equal-technician-handover";
import {
  assertEqualHandoverReservation,
  createEqualHandoverDocumentId,
  createEqualHandoverIdentity,
  evaluateIncomingAttendanceLateness,
  evaluateIncomingClockIn,
  evaluateLateIncomingAcceptance,
  evaluateOutgoingDeparture,
  getEqualHandoverPositions,
  resolveUnresolvedAttendancePolicies,
} from "./equal-technician-handover-domain";

export {
  evaluateIncomingAttendanceLateness,
  evaluateIncomingClockIn,
  evaluateLateIncomingAcceptance,
  evaluateOutgoingDeparture,
  resolveUnresolvedAttendancePolicies,
};

export {
  ATTENDANCE_AUTHENTICATION_METHODS,
  ATTENDANCE_CLOCK_IN_EVIDENCE_KINDS,
  ATTENDANCE_EVIDENCE_KINDS,
  ATTENDANCE_EVIDENCE_SCHEMA,
  ATTENDANCE_OPERATION_STATUSES,
  ATTENDANCE_PERSONALLY_AUTHENTICATED_METHODS,
};

export class AttendanceEvidenceDomainError extends Error {
  public readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "AttendanceEvidenceDomainError";
    this.status = status;
  }
}

function fail(message: string, status = 409): never {
  throw new AttendanceEvidenceDomainError(message, status);
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Malformed attendance evidence state.", 400);
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(result, key))
  ) {
    fail("Malformed attendance evidence state: missing or unsupported fields.", 400);
  }
  return result;
}

function identifier(value: unknown, label: string, max = 512): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > max ||
    value.includes("/") ||
    value === "." ||
    value === ".."
  ) {
    fail(`Invalid ${label}.`, 400);
  }
}

function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`Invalid ${label}.`, 400);
  }
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`Invalid ${label}.`, 400);
  }
}

function timestamp(value: unknown, label = "timestamp"): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`Invalid canonical ${label}.`, 400);
  }
}

function nullableIdentifier(value: unknown, label: string, max: number): void {
  if (value !== null) {
    identifier(value, label, max);
  }
}

function nullableTimestamp(value: unknown, label: string): asserts value is string | null {
  if (value !== null) {
    timestamp(value, label);
  }
}

function reason(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("A non-empty reason is required.", 400);
  }
  return value.trim();
}

function nullableReason(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return reason(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export const ALL_ATTENDANCE_EVIDENCE_KINDS: readonly AttendanceEvidenceKind[] = [
  ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
  ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE,
  ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT,
  ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION,
];

const authenticationMethods: readonly AttendanceAuthenticationMethod[] = [
  ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_CONFIRMATION,
  ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_ACCEPTANCE,
  ATTENDANCE_AUTHENTICATION_METHODS.SERVER_ISSUED_PERSONAL_CLOCK_OUT,
  ATTENDANCE_AUTHENTICATION_METHODS.COLLEAGUE_ATTESTATION,
];

// Only these evidence kinds establish a clock-in, and only through a trusted
// personal confirmation/acceptance coordinator. Login, page opening, shift
// reservation, report preparation and report freeze are not attendance
// events and produce no evidence here.
const allowedKindMethods: Record<AttendanceEvidenceKind, readonly AttendanceAuthenticationMethod[]> = {
  [ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN]: [
    ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_CONFIRMATION,
  ],
  [ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE]: [
    ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_ACCEPTANCE,
  ],
  [ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT]: [
    ATTENDANCE_AUTHENTICATION_METHODS.SERVER_ISSUED_PERSONAL_CLOCK_OUT,
  ],
  [ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION]: [
    ATTENDANCE_AUTHENTICATION_METHODS.COLLEAGUE_ATTESTATION,
  ],
};

export const ATTENDANCE_LATENESS_GRACE_MS = 5 * 60 * 1000;

export function isAttendanceClockInEvidenceKind(kind: AttendanceEvidenceKind): boolean {
  return ATTENDANCE_CLOCK_IN_EVIDENCE_KINDS.includes(kind);
}

export function isPersonallyAuthenticatedMethod(
  method: AttendanceAuthenticationMethod,
): boolean {
  return ATTENDANCE_PERSONALLY_AUTHENTICATED_METHODS.includes(method);
}

export function attendanceEvidenceSlotId(input: {
  handoverId: string;
  technicianUid: string;
  kind: AttendanceEvidenceKind;
}): string {
  identifier(input.handoverId, "handover ID");
  identifier(input.technicianUid, "technician UID", 128);
  if (!ALL_ATTENDANCE_EVIDENCE_KINDS.includes(input.kind)) {
    fail("Unknown attendance evidence kind.", 400);
  }
  return `att2_slot_${digest({ handoverId: input.handoverId, technicianUid: input.technicianUid, kind: input.kind })}`;
}

export function attendanceOperationId(eventId: string): string {
  identifier(eventId, "event ID");
  return `att2_op_${digest(eventId)}`;
}

export function attendanceEvidenceId(slotId: string): string {
  identifier(slotId, "slot ID");
  return `att2_ev_${slotId.slice("att2_slot_".length)}`;
}

const requestFields = [
  "schema",
  "handoverId",
  "handoverDocumentId",
  "eventId",
  "position",
  "technicianUid",
  "kind",
  "scheduledStart",
  "scheduledEnd",
  "reportedDepartureTime",
  "attestedByUid",
  "attestationReason",
  "lateReason",
  "handoverRevision",
  "snapshotHash",
  "expectedGuardRevision",
  "expectedFencingEpoch",
] as const;

export function assertAttendanceEvidenceRequest(value: unknown): AttendanceEvidenceRequest {
  const data = record(value, requestFields);

  if (data.schema !== ATTENDANCE_EVIDENCE_SCHEMA) {
    fail("Attendance evidence request must use the attendance-evidence-v2 schema.", 400);
  }
  identifier(data.handoverId, "handover ID");
  identifier(data.handoverDocumentId, "handover document ID");
  identifier(data.eventId, "event ID");
  identifier(data.position, "handover position", 64);
  identifier(data.technicianUid, "technician UID", 128);
  if (!ALL_ATTENDANCE_EVIDENCE_KINDS.includes(data.kind as AttendanceEvidenceKind)) {
    fail("Unknown attendance evidence kind.", 400);
  }
  timestamp(data.scheduledStart, "scheduled start");
  timestamp(data.scheduledEnd, "scheduled end");
  if (Date.parse(data.scheduledEnd) <= Date.parse(data.scheduledStart)) {
    fail("Invalid scheduled range.", 400);
  }
  nullableTimestamp(data.reportedDepartureTime, "reported departure time");
  nullableIdentifier(data.attestedByUid, "attesting colleague UID", 128);
  nullableReason(data.attestationReason);
  nullableReason(data.lateReason);
  positive(data.handoverRevision, "handover revision");
  if (typeof data.snapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(data.snapshotHash)) {
    fail("Invalid snapshot hash.", 400);
  }
  nonNegativeInteger(data.expectedGuardRevision, "expected guard revision");
  nonNegativeInteger(data.expectedFencingEpoch, "expected fencing epoch");

  const kind = data.kind as AttendanceEvidenceKind;

  const isClockIn = isAttendanceClockInEvidenceKind(kind);
  if (isClockIn) {
    if (data.reportedDepartureTime !== null) {
      fail("Clock-in evidence cannot carry a reported departure time.", 400);
    }
    if (data.attestedByUid !== null) {
      fail("Clock-in evidence cannot be attested by a colleague.", 400);
    }
  }

  if (kind === ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN) {
    if (data.lateReason !== null && data.attestedByUid !== null) {
      fail("Clock-in evidence cannot be attested by a colleague.", 400);
    }
  } else if (kind === ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE) {
    if (data.lateReason === null) {
      fail("A late personal acceptance requires a meaningful late reason.", 400);
    }
    reason(data.lateReason);
  } else if (data.lateReason !== null) {
    fail("Outgoing evidence cannot carry an incoming late reason.", 400);
  }

  if (kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION) {
    if (data.attestedByUid === null) {
      fail("Colleague-attested departure requires the reporting colleague UID.", 400);
    }
    if (data.attestedByUid === data.technicianUid) {
      fail("A technician cannot colleague-attest their own departure.", 400);
    }
    if (data.reportedDepartureTime === null) {
      fail("Colleague-attested departure requires the reported actual departure time.", 400);
    }
    if (data.attestationReason === null) {
      fail("Colleague-attested departure requires a meaningful reason.", 400);
    }
    reason(data.attestationReason);
  } else if (
    data.attestedByUid !== null ||
    data.attestationReason !== null ||
    data.reportedDepartureTime !== null
  ) {
    fail("Personal attendance evidence cannot carry colleague attestation data.", 400);
  }

  // Reported departure times are colleague-supplied data, but a value outside
  // the shift window can never become attendance, so it is rejected here —
  // before any operation is persisted.
  if (data.reportedDepartureTime !== null) {
    assertReportedDepartureWindow(
      data.reportedDepartureTime,
      data.scheduledStart,
      data.scheduledEnd,
    );
  }

  return structuredClone(data) as unknown as AttendanceEvidenceRequest;
}

export function attendanceEvidenceRequestDigest(
  request: AttendanceEvidenceRequest,
): string {
  return digest(assertAttendanceEvidenceRequest(request));
}

// ---------------------------------------------------------------------------
// Guard / reservation ownership
// ---------------------------------------------------------------------------

export interface AttendanceGuardExpectations {
  protocolOwner: HandoverProtocolOwner;
  ownerHandoverDocumentId: string;
  outgoingSlotToken: string;
  outgoingGeneration: number;
  successorSlotToken: string;
  successorGeneration: number;
  reservationId: string;
  reservedIncomingShiftId: string;
  outgoingShiftId: string;
  expectedGuardRevision: number;
  expectedFencingEpoch: number;
}

export function attendanceGuardExpectations(
  reservation: EqualHandoverReservation,
): AttendanceGuardExpectations {
  return {
    protocolOwner: "v2",
    // The guard is owned by the handover's Firestore document ID
    // (handover_v2_<outgoingShiftId>), which is distinct from the digest
    // identity ID carried in `reservation.handoverId`.
    ownerHandoverDocumentId: createEqualHandoverDocumentId(reservation.outgoingShiftId),
    outgoingSlotToken: reservation.outgoingSlotToken,
    outgoingGeneration: reservation.outgoingGeneration,
    successorSlotToken: reservation.successorSlotToken,
    successorGeneration: reservation.expectedSuccessorGeneration,
    reservationId: reservation.handoverId,
    reservedIncomingShiftId: reservation.reservedIncomingShiftId,
    outgoingShiftId: reservation.outgoingShiftId,
    expectedGuardRevision: reservation.revision,
    expectedFencingEpoch: reservation.revision,
  };
}

// Any guard ownership inconsistency fails closed: an absent guard, a guard
// owned by another protocol or handover, a retired/cancelled/completed guard,
// a replaced reservation (superseded tokens/generations), or a moved
// revision/epoch all block evidence creation.
export function assertAttendanceGuardOwnership(
  guard: HandoverReservationGuard | null,
  expectations: AttendanceGuardExpectations,
): asserts guard is HandoverReservationGuard {
  if (guard === null) {
    fail("Attendance evidence requires an active reservation guard.", 409);
  }
  if (guard.protocolOwner !== expectations.protocolOwner) {
    fail("Attendance evidence guard is owned by a different handover protocol.", 409);
  }
  if (guard.ownerHandoverDocumentId !== expectations.ownerHandoverDocumentId) {
    fail("Attendance evidence guard belongs to a different handover.", 409);
  }
  if (guard.outgoingShiftId !== expectations.outgoingShiftId) {
    fail("Attendance evidence guard belongs to a different outgoing shift.", 409);
  }
  if (guard.ownerLifecycleState !== "active") {
    fail(`Attendance evidence guard is ${guard.ownerLifecycleState}; evidence creation is blocked.`, 409);
  }
  if (guard.guardRevision !== expectations.expectedGuardRevision) {
    fail("Attendance evidence was requested against a stale guard revision.", 409);
  }
  if (guard.fencingEpoch !== expectations.expectedFencingEpoch) {
    fail("Attendance evidence was requested against a stale fencing epoch.", 409);
  }
  if (
    guard.outgoingSlotToken.toLowerCase() !== expectations.outgoingSlotToken.toLowerCase() ||
    guard.outgoingGeneration !== expectations.outgoingGeneration
  ) {
    fail("Attendance evidence guard outgoing slot lineage is inconsistent.", 409);
  }
  if (
    guard.successorSlotToken.toLowerCase() !== expectations.successorSlotToken.toLowerCase() ||
    guard.successorGeneration !== expectations.successorGeneration
  ) {
    fail("Attendance evidence guard successor slot lineage is inconsistent.", 409);
  }
  if (
    guard.reservationId !== expectations.reservationId ||
    guard.reservedIncomingShiftId !== expectations.reservedIncomingShiftId
  ) {
    fail("Attendance evidence guard reservation binding is inconsistent.", 409);
  }
  if (
    guard.retiredSuccessorSlotTokens.map((value) => value.toLowerCase()).includes(
      expectations.successorSlotToken.toLowerCase(),
    )
  ) {
    fail("Attendance evidence guard successor slot token is retired.", 409);
  }
}

// Request-level binding used before a reservation is available: the guard
// must exist, be owned by the v2 protocol and this exact handover, be active,
// and still carry the revision/epoch the request was prepared against.
export function assertAttendanceRequestGuardBinding(
  guard: HandoverReservationGuard | null,
  request: AttendanceEvidenceRequest,
): asserts guard is HandoverReservationGuard {
  if (guard === null) {
    fail("Attendance evidence requires an active reservation guard.", 409);
  }
  if (guard.protocolOwner !== "v2") {
    fail("Attendance evidence guard is owned by a different handover protocol.", 409);
  }
  if (guard.ownerHandoverDocumentId !== request.handoverDocumentId) {
    fail("Attendance evidence guard belongs to a different handover.", 409);
  }
  if (guard.reservationId !== request.handoverId) {
    fail("Attendance evidence guard is bound to a different reservation.", 409);
  }
  if (guard.ownerLifecycleState !== "active") {
    fail(`Attendance evidence guard is ${guard.ownerLifecycleState}; evidence creation is blocked.`, 409);
  }
  if (guard.guardRevision !== request.expectedGuardRevision) {
    fail("Attendance evidence was requested against a stale guard revision.", 409);
  }
  if (guard.fencingEpoch !== request.expectedFencingEpoch) {
    fail("Attendance evidence was requested against a stale fencing epoch.", 409);
  }
}

// ---------------------------------------------------------------------------
// Operation state machine (pending -> finalized | aborted)
// ---------------------------------------------------------------------------

const operationFields = [
  "schema",
  "id",
  "slotId",
  "status",
  "request",
  "requestDigest",
  "evidenceId",
  "interruptedFinalization",
  "requestedAt",
  "finalizedAt",
  "abortedAt",
  "abortReason",
] as const;

export function createPendingAttendanceOperation(
  request: AttendanceEvidenceRequest,
): AttendanceOperation {
  const valid = assertAttendanceEvidenceRequest(request);
  const slotId = attendanceEvidenceSlotId({
    handoverId: valid.handoverId,
    technicianUid: valid.technicianUid,
    kind: valid.kind,
  });
  const operation: AttendanceOperation = {
    schema: ATTENDANCE_EVIDENCE_SCHEMA,
    id: attendanceOperationId(valid.eventId),
    slotId,
    status: ATTENDANCE_OPERATION_STATUSES.PENDING,
    request: valid,
    requestDigest: attendanceEvidenceRequestDigest(valid),
    evidenceId: attendanceEvidenceId(slotId),
    interruptedFinalization: false,
    requestedAt: null,
    finalizedAt: null,
    abortedAt: null,
    abortReason: null,
  };
  return assertAttendanceOperation(operation);
}

export function assertAttendanceOperation(value: unknown): AttendanceOperation {
  const data = record(value, operationFields);
  if (data.schema !== ATTENDANCE_EVIDENCE_SCHEMA) {
    fail("Attendance operation must use the attendance-evidence-v2 schema.", 400);
  }
  identifier(data.id, "operation ID");
  identifier(data.slotId, "slot ID");
  identifier(data.evidenceId, "evidence ID");
  if (
    !Object.values(ATTENDANCE_OPERATION_STATUSES).includes(
      data.status as AttendanceOperationStatus,
    )
  ) {
    fail("Unknown attendance operation status.", 400);
  }
  if (typeof data.interruptedFinalization !== "boolean") {
    fail("Invalid attendance operation interrupted-finalization flag.", 400);
  }
  const request = assertAttendanceEvidenceRequest(data.request);
  if (data.requestDigest !== attendanceEvidenceRequestDigest(request)) {
    fail("Attendance operation request digest is inconsistent.", 400);
  }
  const expectedSlotId = attendanceEvidenceSlotId({
    handoverId: request.handoverId,
    technicianUid: request.technicianUid,
    kind: request.kind,
  });
  if (data.slotId !== expectedSlotId || data.evidenceId !== attendanceEvidenceId(expectedSlotId)) {
    fail("Attendance operation slot binding is inconsistent.", 400);
  }
  if (data.id !== attendanceOperationId(request.eventId)) {
    fail("Attendance operation identity is inconsistent with its event ID.", 400);
  }
  nullableTimestamp(data.requestedAt, "requestedAt");
  nullableTimestamp(data.finalizedAt, "finalizedAt");  nullableTimestamp(data.abortedAt, "abortedAt");
  if (data.abortReason !== null) {
    nullableReason(data.abortReason);
  }

  switch (data.status) {
    case ATTENDANCE_OPERATION_STATUSES.PENDING:
      if (data.finalizedAt !== null || data.abortedAt !== null || data.abortReason !== null) {
        fail("A pending attendance operation cannot carry finalization or abort results.", 400);
      }
      break;
    case ATTENDANCE_OPERATION_STATUSES.FINALIZED:
      if (data.abortedAt !== null || data.abortReason !== null) {
        fail("A finalized attendance operation cannot carry abort results.", 400);
      }
      if (data.finalizedAt === null && !data.interruptedFinalization) {
        fail("A finalized attendance operation requires a finalized server time or the interrupted-recovery flag.", 400);
      }
      break;
    case ATTENDANCE_OPERATION_STATUSES.ABORTED:
      if (data.finalizedAt !== null) {
        fail("An aborted attendance operation cannot carry a finalized time.", 400);
      }
      if (data.abortedAt === null || data.abortReason === null) {
        fail("An aborted attendance operation requires an abort time and reason.", 400);
      }
      break;
  }

  return structuredClone(data) as unknown as AttendanceOperation;
}

export function attendanceOperationCountsAsAttendance(operation: AttendanceOperation): boolean {
  return operation.status === ATTENDANCE_OPERATION_STATUSES.FINALIZED;
}

// Marks the committed-finalization-but-unacknowledged state so a retry can
// resume and recover the authoritative stored result instead of assuming.
export function markAttendanceOperationFinalizationInterrupted(
  operation: AttendanceOperation,
): AttendanceOperation {
  const valid = assertAttendanceOperation(operation);
  if (valid.status !== ATTENDANCE_OPERATION_STATUSES.FINALIZED) {
    fail("Only a finalized attendance operation can carry the interrupted-recovery flag.", 400);
  }
  return assertAttendanceOperation({ ...valid, interruptedFinalization: true });
}

// ---------------------------------------------------------------------------
// Evidence construction from server time
// ---------------------------------------------------------------------------

export function buildAttendanceEvidence(input: {
  operation: AttendanceOperation;
  // Authoritative Firestore server clock; never a caller-supplied timestamp.
  serverTime: string;
  guard: HandoverReservationGuard;
  reservation: EqualHandoverReservation;
  identity: EqualHandoverIdentity;
  // Server-verified identity of who actually authenticated. Only a trusted
  // confirmation/acceptance coordinator may supply this.
  trustedAuthentication: AttendanceTrustedAuthentication;
}): AttendanceEvidence {
  const operation = assertAttendanceOperation(input.operation);
  timestamp(input.serverTime, "server time");
  if (operation.status !== ATTENDANCE_OPERATION_STATUSES.PENDING) {
    fail("Only a pending attendance operation can produce evidence.", 400);
  }
  if (operation.requestedAt !== null && Date.parse(input.serverTime) < Date.parse(operation.requestedAt)) {
    fail("Server finalization time cannot precede the operation request time.", 400);
  }

  const request = operation.request;

  // The aggregate must describe the same handover the request was bound to;
  // a stale handover identity fails closed. The aggregate's own reservation
  // is re-derived from the live revision, so replaced reservations (new
  // handover generation) cannot authenticate evidence for an old request.
  const validIdentity = createEqualHandoverIdentity(input.identity);
  const validReservation = assertEqualHandoverReservation(
    input.reservation,
    validIdentity,
    input.reservation.revision,
  );
  if (validReservation.handoverId !== request.handoverId) {
    fail("Attendance evidence handover identity is inconsistent with its reservation.", 400);
  }
  if (
    request.handoverDocumentId !==
    createEqualHandoverDocumentId(validIdentity.outgoingShiftId)
  ) {
    fail("Attendance evidence handover document binding is inconsistent.", 400);
  }
  if (validReservation.revision !== request.handoverRevision) {
    fail("Attendance evidence request revision differs from the current handover reservation revision.", 409);
  }
  if (
    request.scheduledStart !== validIdentity.scheduledStart ||
    request.scheduledEnd !== validIdentity.scheduledEnd
  ) {
    fail("Attendance evidence scheduled window diverges from the handover identity.", 400);
  }

  const positionEntry = getEqualHandoverPositions(validIdentity).find(
    (entry) => entry.position === request.position,
  );
  if (!positionEntry || positionEntry.technicianUid !== request.technicianUid) {
    fail("Attendance evidence participant identity is inconsistent with the handover.", 400);
  }
  const isClockIn = isAttendanceClockInEvidenceKind(request.kind);
  const expectedSide = isClockIn ? "incoming" : "outgoing";
  if (positionEntry.side !== expectedSide) {
    fail("Attendance evidence kind does not match the participant side.", 400);
  }

  assertAttendanceGuardOwnership(input.guard, {
    ...attendanceGuardExpectations(validReservation),
    expectedGuardRevision: request.expectedGuardRevision,
    expectedFencingEpoch: request.expectedFencingEpoch,
  });
  if (input.guard.reservationId !== request.handoverId) {
    fail("Attendance evidence guard is bound to a different reservation.", 409);
  }
  if (
    input.guard.outgoingShiftId !== validIdentity.outgoingShiftId ||
    input.guard.reservedIncomingShiftId !== validIdentity.incomingShiftId
  ) {
    fail("Attendance evidence guard shift lineage is inconsistent with the handover identity.", 409);
  }

  // The authentication event must be supplied by a trusted server-side
  // coordinator that has personally verified the technician (for example by
  // successful password re-authentication). Requests cannot carry their own
  // authentication method, and a colleague attestation authenticates only
  // the reporting colleague.
  const authentication = input.trustedAuthentication;
  identifier(authentication.verifiedTechnicianUid, "verified technician UID", 128);
  const method = authentication.method;
  if (!authenticationMethods.includes(method)) {
    fail("Unknown attendance authentication method.", 403);
  }
  if (!allowedKindMethods[request.kind].includes(method)) {
    fail(`Authentication method ${method} cannot finalize evidence kind ${request.kind}.`, 403);
  }
  const personallyAuthenticated = isPersonallyAuthenticatedMethod(method);
  if (personallyAuthenticated && authentication.verifiedTechnicianUid !== request.technicianUid) {
    fail("Personally authenticated evidence requires the subject technician's own verified authentication.", 403);
  }
  if (!personallyAuthenticated && authentication.verifiedTechnicianUid === request.technicianUid) {
    fail("A technician cannot colleague-attest their own departure.", 403);
  }
  if (!personallyAuthenticated && authentication.verifiedTechnicianUid !== request.attestedByUid) {
    fail("Colleague-attested evidence must be authenticated by the reporting colleague.", 403);
  }
  if (personallyAuthenticated && request.attestedByUid !== null) {
    fail("Personally authenticated evidence cannot carry an attesting colleague.", 400);
  }

  // eventTime is always the authoritative server time of the trusted
  // authentication event. For a colleague attestation that is the attesting
  // colleague's verified server time; it is never treated as the absent
  // technician's personal attendance.
  const eventTime = input.serverTime;

  if (isClockIn) {
    // Server-timing lateness gate: scheduled start plus exactly five minutes
    // is on time; anything later is late and requires a meaningful reason.
    const diffMs = Date.parse(eventTime) - Date.parse(request.scheduledStart);
    if (diffMs > ATTENDANCE_LATENESS_GRACE_MS) {
      if (request.lateReason === null) {
        fail(
          "Server confirmation time is more than five minutes after scheduled start; a meaningful late reason is required.",
          400,
        );
      }
      reason(request.lateReason);
    }
  }

  const clockOut = (() => {
    if (request.kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT) {
      return eventTime;
    }
    if (request.kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION) {
      return request.reportedDepartureTime as string;
    }
    return null;
  })();

  const evidence: AttendanceEvidence = {
    schema: ATTENDANCE_EVIDENCE_SCHEMA,
    id: operation.evidenceId,
    slotId: operation.slotId,
    operationId: operation.id,
    eventId: request.eventId,
    handoverId: request.handoverId,
    handoverDocumentId: request.handoverDocumentId,
    outgoingShiftId: input.guard.outgoingShiftId,
    incomingShiftId: input.guard.reservedIncomingShiftId,
    position: request.position,
    technicianUid: request.technicianUid,
    kind: request.kind,
    scheduledStart: request.scheduledStart,
    scheduledEnd: request.scheduledEnd,
    eventTime,
    clockIn: isClockIn ? eventTime : null,
    clockOut,
    reportedDepartureTime: request.reportedDepartureTime,
    attestedByUid: request.attestedByUid,
    attestationReason: request.attestationReason,
    authenticationMethod: method,
    personallyAuthenticated,
    lateReason: request.lateReason,
    handoverRevision: request.handoverRevision,
    snapshotHash: request.snapshotHash,
    guardRevision: input.guard.guardRevision,
    fencingEpoch: input.guard.fencingEpoch,
    finalizedAt: eventTime,
    createdAt: eventTime,
  };

  return assertAttendanceEvidence(evidence);
}

function assertReportedDepartureWindow(
  reportedDepartureTime: string,
  scheduledStart: string,
  scheduledEnd: string,
): void {
  const departure = Date.parse(reportedDepartureTime);
  if (departure < Date.parse(scheduledStart) - 12 * 60 * 60 * 1000 || departure > Date.parse(scheduledEnd)) {
    fail("Reported departure time must fall within the outgoing shift window (scheduled start minus 12 hours through scheduled end).", 400);
  }
}

// ---------------------------------------------------------------------------
// Evidence read-back validation
// ---------------------------------------------------------------------------

const evidenceFields = [
  "schema",
  "id",
  "slotId",
  "operationId",
  "eventId",
  "handoverId",
  "handoverDocumentId",
  "outgoingShiftId",
  "incomingShiftId",
  "position",
  "technicianUid",
  "kind",
  "scheduledStart",
  "scheduledEnd",
  "eventTime",
  "clockIn",
  "clockOut",
  "reportedDepartureTime",
  "attestedByUid",
  "attestationReason",
  "authenticationMethod",
  "personallyAuthenticated",
  "lateReason",
  "handoverRevision",
  "snapshotHash",
  "guardRevision",
  "fencingEpoch",
  "finalizedAt",
  "createdAt",
] as const;

export function assertAttendanceEvidence(value: unknown): AttendanceEvidence {
  const data = record(value, evidenceFields);
  if (data.schema !== ATTENDANCE_EVIDENCE_SCHEMA) {
    fail("Attendance evidence must use the attendance-evidence-v2 schema.", 400);
  }
  identifier(data.id, "evidence ID");
  identifier(data.slotId, "slot ID");
  identifier(data.operationId, "operation ID");
  identifier(data.eventId, "event ID");
  identifier(data.handoverId, "handover ID");
  identifier(data.handoverDocumentId, "handover document ID");
  identifier(data.outgoingShiftId, "outgoing shift ID");
  identifier(data.incomingShiftId, "incoming shift ID");
  identifier(data.position, "handover position", 64);
  identifier(data.technicianUid, "technician UID", 128);
  if (!ALL_ATTENDANCE_EVIDENCE_KINDS.includes(data.kind as AttendanceEvidenceKind)) {
    fail("Unknown attendance evidence kind.", 400);
  }
  timestamp(data.scheduledStart, "scheduled start");
  timestamp(data.scheduledEnd, "scheduled end");
  nullableTimestamp(data.eventTime, "event time");
  nullableTimestamp(data.clockIn, "clock-in");
  nullableTimestamp(data.clockOut, "clock-out");
  nullableTimestamp(data.reportedDepartureTime, "reported departure time");
  nullableIdentifier(data.attestedByUid, "attesting colleague UID", 128);
  nullableReason(data.attestationReason);
  if (!authenticationMethods.includes(data.authenticationMethod as AttendanceAuthenticationMethod)) {
    fail("Unknown attendance authentication method.", 400);
  }
  if (typeof data.personallyAuthenticated !== "boolean") {
    fail("Invalid personally-authenticated flag.", 400);
  }
  nullableReason(data.lateReason);
  positive(data.handoverRevision, "handover revision");
  if (typeof data.snapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(data.snapshotHash)) {
    fail("Invalid snapshot hash.", 400);
  }
  nonNegativeInteger(data.guardRevision, "guard revision");
  nonNegativeInteger(data.fencingEpoch, "fencing epoch");
  timestamp(data.finalizedAt, "finalizedAt");
  timestamp(data.createdAt, "createdAt");
  if (data.createdAt !== data.finalizedAt) {
    fail("Immutable attendance evidence cannot separate creation from finalization time.", 400);
  }

  const kind = data.kind as AttendanceEvidenceKind;
  const method = data.authenticationMethod as AttendanceAuthenticationMethod;
  if (!allowedKindMethods[kind].includes(method)) {
    fail(`Authentication method ${method} is invalid for evidence kind ${kind}.`, 400);
  }
  if (data.personallyAuthenticated !== isPersonallyAuthenticatedMethod(method)) {
    fail("Personally-authenticated flag must match the authentication method.", 400);
  }
  if (!data.personallyAuthenticated && data.attestedByUid === null) {
    fail("Colleague-attested evidence must preserve the reporting colleague UID.", 400);
  }
  if (data.personallyAuthenticated && data.attestedByUid !== null) {
    fail("Personally authenticated evidence cannot carry an attesting colleague.", 400);
  }

  if (isAttendanceClockInEvidenceKind(kind)) {
    if (data.clockIn === null || data.eventTime === null) {
      fail("Clock-in evidence requires a server clock-in and event time.", 400);
    }
    if (data.clockOut !== null) {
      fail("Clock-in evidence cannot carry a clock-out.", 400);
    }
  } else if (data.clockIn !== null) {
    fail("Outgoing attendance evidence must never fabricate a clock-in.", 400);
  }

  if (kind === ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE) {
    if (data.lateReason === null) {
      fail("Late acceptance evidence requires the late reason.", 400);
    }
  } else if (kind !== ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN && data.lateReason !== null) {
    fail("Outgoing evidence cannot carry an incoming late reason.", 400);
  }

  if (kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION) {
    if (data.clockOut === null || data.reportedDepartureTime === null) {
      fail("Colleague-attested departure requires the reported departure time as its clock-out.", 400);
    }
    if (data.attestationReason === null) {
      fail("Colleague-attested departure requires the attestation reason.", 400);
    }
    if (data.eventTime === null) {
      fail("Colleague-attested departure requires the attester's server authentication time.", 400);
    }
  } else if (
    data.attestedByUid !== null ||
    data.attestationReason !== null ||
    data.reportedDepartureTime !== null
  ) {
    fail("Personal attendance evidence cannot carry colleague attestation data.", 400);
  }

  if (
    data.clockIn !== null &&
    data.clockOut !== null &&
    Date.parse(data.clockOut) < Date.parse(data.clockIn)
  ) {
    fail("Attendance clock-out cannot precede clock-in.", 400);
  }
  if (Date.parse(data.scheduledEnd) <= Date.parse(data.scheduledStart)) {
    fail("Invalid scheduled range.", 400);
  }
  const expectedSlotId = attendanceEvidenceSlotId({
    handoverId: data.handoverId,
    technicianUid: data.technicianUid,
    kind,
  });
  if (data.slotId !== expectedSlotId || data.id !== attendanceEvidenceId(expectedSlotId)) {
    fail("Attendance evidence slot binding is inconsistent.", 400);
  }

  return structuredClone(data) as unknown as AttendanceEvidence;
}

export function attendanceEvidenceCountsAsClockIn(evidence: AttendanceEvidence): boolean {
  return (
    isAttendanceClockInEvidenceKind(evidence.kind) &&
    evidence.personallyAuthenticated &&
    evidence.clockIn !== null
  );
}

// ---------------------------------------------------------------------------
// Conflicting evidence: fail closed, stay auditable
// ---------------------------------------------------------------------------

export type AttendanceEvidenceConflictType =
  | "duplicate_same_request"
  | "slot_occupied"
  | "clock_in_reset"
  | "personal_clock_out_overwrite"
  | "attested_after_personal_clock_out"
  | "conflicting_pending_operation";

export function classifyAttendanceEvidenceConflict(input: {
  existing: AttendanceEvidence;
  incomingKind: AttendanceEvidenceKind;
  incomingTechnicianUid: string;
  incomingEventTime: string | null;
  incomingOperationId: string;
}): AttendanceEvidenceConflictType | null {
  const { existing } = input;
  if (existing.technicianUid !== input.incomingTechnicianUid) {
    return "slot_occupied";
  }
  if (existing.operationId === input.incomingOperationId) {
    return null;
  }
  if (
    attendanceEvidenceCountsAsClockIn(existing) &&
    isAttendanceClockInEvidenceKind(input.incomingKind)
  ) {
    return "clock_in_reset";
  }
  if (
    existing.kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT &&
    input.incomingKind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION
  ) {
    return "personal_clock_out_overwrite";
  }
  if (
    existing.kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION &&
    input.incomingKind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT
  ) {
    return "attested_after_personal_clock_out";
  }
  if (existing.kind === input.incomingKind) {
    return "slot_occupied";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Absence rules
// ---------------------------------------------------------------------------

// A `not_yet_in` declaration for an incoming technician is a handover
// absence, not a personal confirmation. It produces no clock-in evidence, no
// signature, and no invented authentication event. Late personal acceptance
// (INCOMING_LATE_ACCEPTANCE via PERSONAL_PASSWORD_ACCEPTANCE) remains the
// preserved future path for that technician.
export function absentIncomingAttendanceRule(input: {
  absenceType: string;
  side: "incoming" | "outgoing";
}): {
  createsClockInEvidence: false;
  producesAttendanceEvidence: false;
  personalConfirmationEstablished: false;
  futurePath: string;
} {
  if (input.side !== "incoming") {
    fail("Missing incoming technician rule evaluated for a non-incoming side.", 400);
  }
  if (input.absenceType !== "not_yet_in") {
    fail("Incoming technicians can only be declared not_yet_in.", 400);
  }
  return {
    createsClockInEvidence: false,
    producesAttendanceEvidence: false,
    personalConfirmationEstablished: false,
    futurePath: "A previously declared not_yet_in technician must personally authenticate (server password acceptance) before late attendance is finalized.",
  };
}

// ---------------------------------------------------------------------------
// Worked duration
// ---------------------------------------------------------------------------

export interface AttendanceWorkedDuration {
  status: "computed" | "insufficient_evidence";
  workedMs: number | null;
  breakDeductionApplied: false;
  payableHours: "policy_unresolved";
}

// Worked duration is determined only when valid clock-in and clock-out
// evidence exists. A full scheduled shift is never assumed and breaks are
// never deducted automatically.
export function computeAttendanceWorkedDuration(input: {
  clockIn: string | null;
  clockOut: string | null;
}): AttendanceWorkedDuration {
  nullableTimestamp(input.clockIn, "clock-in");
  nullableTimestamp(input.clockOut, "clock-out");
  if (input.clockIn === null || input.clockOut === null) {
    return {
      status: "insufficient_evidence",
      workedMs: null,
      breakDeductionApplied: false,
      payableHours: "policy_unresolved",
    };
  }
  const workedMs = Date.parse(input.clockOut) - Date.parse(input.clockIn);
  if (workedMs < 0) {
    return {
      status: "insufficient_evidence",
      workedMs: null,
      breakDeductionApplied: false,
      payableHours: "policy_unresolved",
    };
  }
  return {
    status: "computed",
    workedMs,
    breakDeductionApplied: false,
    payableHours: "policy_unresolved",
  };
}

// ---------------------------------------------------------------------------
// Idempotent retry resolution
// ---------------------------------------------------------------------------

export type AttendanceOperationRetryOutcome =
  | { kind: "fresh" }
  | { kind: "idempotent_replay" }
  | { kind: "conflicting_retry"; existingRequestDigest: string };

export function resolveAttendanceOperationRetry(input: {
  existing: AttendanceOperation | null;
  incomingRequestDigest: string;
}): AttendanceOperationRetryOutcome {
  if (input.existing === null) {
    return { kind: "fresh" };
  }
  if (input.existing.requestDigest === input.incomingRequestDigest) {
    return { kind: "idempotent_replay" };
  }
  return {
    kind: "conflicting_retry",
    existingRequestDigest: input.existing.requestDigest,
  };
}
