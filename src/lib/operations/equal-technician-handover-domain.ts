import { createHash } from "node:crypto";
import { assertEqualHandoverReportV2Binding } from "./equal-handover-report-domain";
import type { EqualHandoverReportV2Binding } from "@/types/handover-report-v2";
import {
  ATTENDANCE_CLOCK_OUT_PROVENANCE,
  EQUAL_ABSENCE_TYPES,
  EQUAL_HANDOVER_LIFECYCLE_STATUSES,
  EQUAL_HANDOVER_PARTICIPANT_STATES,
  EQUAL_HANDOVER_POSITIONS,
  EQUAL_HANDOVER_SIDES,
  UNRESOLVED_POLICY,
  type EqualAbsenceType,
  type EqualHandoverAbsence,
  type EqualHandoverAggregate,
  type EqualHandoverConfirmation,
  type EqualHandoverHistoricalConfirmation,
  type EqualHandoverIdentity,
  type EqualHandoverParticipant,
  type EqualHandoverPosition,
  type EqualHandoverReservation,
  type EqualHandoverSnapshot,
  type IncomingClockInEvaluation,
  type LateIncomingAcceptanceEvaluation,
  type OutgoingDepartureEvaluation,
  type UnresolvedPolicy,
} from "@/types/equal-technician-handover";

export {
  ATTENDANCE_CLOCK_OUT_PROVENANCE,
  EQUAL_ABSENCE_TYPES,
  EQUAL_HANDOVER_LIFECYCLE_STATUSES,
  EQUAL_HANDOVER_PARTICIPANT_STATES,
  EQUAL_HANDOVER_POSITIONS,
  EQUAL_HANDOVER_SIDES,
  UNRESOLVED_POLICY,
};

export class EqualHandoverDomainError extends Error {
  public readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "EqualHandoverDomainError";
    this.status = status;
  }
}

function fail(message: string, status = 409): never {
  throw new EqualHandoverDomainError(message, status);
}

export function assertReportBinding(value: unknown): EqualHandoverReportV2Binding {
  // §3 migration: the v2 aggregate binds only genuine `handover-report-v2`
  // evidence (report_v2_ document, reservation fingerprint, preparation
  // revision, evidence snapshot hash, work snapshot version, fencing epoch).
  // A legacy v1 binding is rejected rather than relabeled.
  return assertEqualHandoverReportV2Binding(value);
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Malformed handover state.");
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(result, key))
  ) {
    fail("Malformed handover state: missing or unsupported fields.");
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

function timestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail("Invalid canonical timestamp.", 400);
  }
}

function token(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    fail("Invalid handover slot token.", 400);
  }
}

function reason(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("A non-empty reason is required.", 400);
  }
  return value.trim();
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

const identityFields = [
  "schema",
  "outgoingShiftId",
  "outgoingPermanentPairId",
  "outgoingTechnicianIds",
  "outgoingSlotToken",
  "outgoingGeneration",
  "incomingShiftId",
  "incomingPermanentPairId",
  "incomingTechnicianIds",
  "successorSlotToken",
  "successorGeneration",
  "shiftType",
  "scheduledStart",
  "scheduledEnd",
] as const;

export function createEqualHandoverIdentity(value: unknown): EqualHandoverIdentity {
  const data = record(value, identityFields);
  if (data.schema !== "equal-handover-v2") {
    fail("Invalid equal handover schema: must be equal-handover-v2.");
  }
  for (const field of [
    "outgoingShiftId",
    "incomingShiftId",
    "outgoingPermanentPairId",
    "incomingPermanentPairId",
  ]) {
    identifier(data[field], field);
  }
  if (data.outgoingShiftId === data.incomingShiftId) {
    fail("Incoming and outgoing shifts must differ.");
  }
  for (const field of ["outgoingTechnicianIds", "incomingTechnicianIds"]) {
    const pair = data[field];
    if (!Array.isArray(pair) || pair.length !== 2) {
      fail("Each permanent pair requires exactly two technicians.");
    }
    for (const uid of pair) {
      identifier(uid, "technician UID", 128);
    }
    if (pair[0] === pair[1]) {
      fail("Duplicate permanent participant identity.");
    }
  }
  const outgoing = data.outgoingTechnicianIds as [string, string];
  const incoming = data.incomingTechnicianIds as [string, string];
  if (new Set([...outgoing, ...incoming]).size !== 4) {
    fail("Cross-side duplicate participant identity: all 4 technicians must be distinct.");
  }
  token(data.outgoingSlotToken);
  token(data.successorSlotToken);
  positive(data.outgoingGeneration, "outgoing generation");
  positive(data.successorGeneration, "successor generation");
  if (
    data.successorGeneration !== data.outgoingGeneration + 1 ||
    data.outgoingSlotToken.toLowerCase() === data.successorSlotToken.toLowerCase()
  ) {
    fail("Invalid successor lineage.");
  }
  timestamp(data.scheduledStart);
  timestamp(data.scheduledEnd);
  if (Date.parse(data.scheduledEnd) <= Date.parse(data.scheduledStart)) {
    fail("Invalid scheduled range.");
  }
  if (data.shiftType !== "morning" && data.shiftType !== "night") {
    fail("Invalid shift type.", 400);
  }
  return {
    ...data,
    schema: "equal-handover-v2",
    outgoingTechnicianIds: [...outgoing],
    incomingTechnicianIds: [...incoming],
    outgoingSlotToken: data.outgoingSlotToken.toLowerCase(),
    successorSlotToken: data.successorSlotToken.toLowerCase(),
  } as EqualHandoverIdentity;
}

export function createEqualHandoverDocumentId(outgoingShiftId: string): string {
  identifier(outgoingShiftId, "outgoing shift ID");
  const documentId = `handover_v2_${outgoingShiftId}`;
  if (new TextEncoder().encode(documentId).byteLength > 1500) {
    fail("Equal handover document ID exceeds 1500 UTF-8 bytes.", 400);
  }
  return documentId;
}

export function createEqualHandoverId(identity: EqualHandoverIdentity): string {
  return `handover_v2_${digest(createEqualHandoverIdentity(identity))}`;
}

function reservationFor(
  identity: EqualHandoverIdentity,
  revision: number,
  reservedAt: string,
  reservedBy: string,
): EqualHandoverReservation {
  return {
    handoverId: createEqualHandoverId(identity),
    reservedIncomingShiftId: identity.incomingShiftId,
    outgoingShiftId: identity.outgoingShiftId,
    incomingPermanentPairId: identity.incomingPermanentPairId,
    incomingTechnicianIds: [...identity.incomingTechnicianIds],
    shiftType: identity.shiftType,
    scheduledStart: identity.scheduledStart,
    scheduledEnd: identity.scheduledEnd,
    outgoingSlotToken: identity.outgoingSlotToken,
    outgoingGeneration: identity.outgoingGeneration,
    successorSlotToken: identity.successorSlotToken,
    expectedSuccessorGeneration: identity.successorGeneration,
    revision,
    reservedAt,
    reservedBy,
  };
}

export function assertEqualHandoverReservation(
  value: unknown,
  identity: EqualHandoverIdentity,
  revision: number,
): EqualHandoverReservation {
  const validIdentity = createEqualHandoverIdentity(identity);
  positive(revision, "revision");
  const data = record(value, Object.keys(reservationFor(validIdentity, revision, "", "")));
  timestamp(data.reservedAt);
  identifier(data.reservedBy, "reservation actor UID", 128);
  const expected = reservationFor(validIdentity, revision, data.reservedAt, data.reservedBy);
  if (canonical(data) !== canonical(expected)) {
    fail("Invalid incoming reservation binding.");
  }
  return expected;
}

export function getEqualHandoverPositions(identity: EqualHandoverIdentity): readonly {
  position: EqualHandoverPosition;
  side: "outgoing" | "incoming";
  technicianUid: string;
}[] {
  return [
    {
      position: EQUAL_HANDOVER_POSITIONS.OUTGOING_TECH_A,
      side: EQUAL_HANDOVER_SIDES.OUTGOING,
      technicianUid: identity.outgoingTechnicianIds[0],
    },
    {
      position: EQUAL_HANDOVER_POSITIONS.OUTGOING_TECH_B,
      side: EQUAL_HANDOVER_SIDES.OUTGOING,
      technicianUid: identity.outgoingTechnicianIds[1],
    },
    {
      position: EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_A,
      side: EQUAL_HANDOVER_SIDES.INCOMING,
      technicianUid: identity.incomingTechnicianIds[0],
    },
    {
      position: EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_B,
      side: EQUAL_HANDOVER_SIDES.INCOMING,
      technicianUid: identity.incomingTechnicianIds[1],
    },
  ] as const;
}

export function createEqualHandoverSnapshot(aggregate: EqualHandoverAggregate): EqualHandoverSnapshot {
  const sortedAbsences = [...aggregate.absences].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
  );
  const data = {
    schema: "equal-handover-v2" as const,
    identity: aggregate.identity,
    reservation: aggregate.reservation,
    reportBinding: aggregate.reportBinding,
    absences: sortedAbsences,
    revision: aggregate.revision,
  };
  return structuredClone({
    ...data,
    snapshotHash: digest(data),
  });
}

export function resolveEqualHandoverParticipants(
  aggregate: EqualHandoverAggregate,
): EqualHandoverParticipant[] {
  const valid = assertEqualHandoverAggregate(aggregate);
  return getEqualHandoverPositions(valid.identity).map((item): EqualHandoverParticipant => {
    const confirmation = valid.confirmations.find((c) => c.position === item.position);
    const absence = valid.absences.find((a) => a.position === item.position);
    if (confirmation) {
      return {
        position: item.position,
        side: item.side,
        technicianUid: item.technicianUid,
        state: "confirmed",
        confirmation,
      };
    }
    if (absence) {
      return {
        position: item.position,
        side: item.side,
        technicianUid: item.technicianUid,
        state: "absent",
        absence,
      };
    }
    return {
      position: item.position,
      side: item.side,
      technicianUid: item.technicianUid,
      state: "awaiting_confirmation",
    };
  });
}

const aggregateFields = [
  "schema",
  "identity",
  "reservation",
  "reportBinding",
  "confirmations",
  "historicalConfirmations",
  "absences",
  "retiredSuccessorSlotTokens",
  "revision",
  "lifecycleStatus",
  "createdAt",
  "updatedAt",
] as const;

export function assertEqualHandoverAggregate(value: unknown): EqualHandoverAggregate {
  const data = record(value, aggregateFields);
  if (data.schema !== "equal-handover-v2") {
    fail("Invalid equal handover schema: must be equal-handover-v2.");
  }
  const identity = createEqualHandoverIdentity(data.identity);
  if (canonical(identity) !== canonical(data.identity)) {
    fail("Non-canonical equal handover identity.");
  }
  positive(data.revision, "revision");
  const reservation = assertEqualHandoverReservation(data.reservation, identity, data.revision);

  let reportBinding: EqualHandoverReportV2Binding | null = null;
  if (data.reportBinding !== null) {
    try {
      reportBinding = assertReportBinding(data.reportBinding);
    } catch {
      fail("Malformed report binding in equal handover aggregate.");
    }
  }

  if (!Array.isArray(data.retiredSuccessorSlotTokens)) {
    fail("Malformed retired reservation lineage.");
  }
  const retired = new Set<string>();
  for (const retiredToken of data.retiredSuccessorSlotTokens) {
    token(retiredToken);
    if (
      retiredToken !== retiredToken.toLowerCase() ||
      retired.has(retiredToken) ||
      retiredToken === identity.outgoingSlotToken ||
      retiredToken === identity.successorSlotToken
    ) {
      fail("Reused or malformed retired successor token.");
    }
    retired.add(retiredToken);
  }
  if (retired.size >= data.revision) {
    fail("Contradictory retired reservation revision.");
  }

  timestamp(data.createdAt);
  timestamp(data.updatedAt);
  if (
    Date.parse(data.updatedAt) < Date.parse(data.createdAt) ||
    Date.parse(reservation.reservedAt) < Date.parse(data.createdAt) ||
    Date.parse(reservation.reservedAt) > Date.parse(data.updatedAt)
  ) {
    fail("Contradictory handover timestamps.");
  }

  if (
    !["collecting_confirmations", "awaiting_incoming_acceptance", "completed", "cancelled", "superseded"].includes(
      data.lifecycleStatus as string,
    )
  ) {
    fail("Invalid equal handover lifecycle.");
  }

  const positions = getEqualHandoverPositions(identity);
  const occupiedPositions = new Set<string>();

  // Validate confirmations
  if (!Array.isArray(data.confirmations)) {
    fail("Malformed participant confirmations.");
  }
  for (const item of data.confirmations) {
    const confirmation = record(item, [
      "position",
      "technicianUid",
      "revision",
      "reportBinding",
      "snapshotHash",
      "confirmedAt",
    ]);
    const participant = positions.find(
      (p) => p.position === confirmation.position && p.technicianUid === confirmation.technicianUid,
    );
    if (!participant) {
      fail("Unauthorized participant confirmation.", 403);
    }
    if (occupiedPositions.has(participant.position)) {
      fail("Contradictory participant resolution: multiple evidence for same position.");
    }
    occupiedPositions.add(participant.position);
    if (confirmation.revision !== data.revision) {
      fail("Stale confirmation revision.");
    }
    timestamp(confirmation.confirmedAt);
    if (
      Date.parse(confirmation.confirmedAt) < Date.parse(data.createdAt) ||
      Date.parse(confirmation.confirmedAt) > Date.parse(data.updatedAt)
    ) {
      fail("Contradictory confirmation timestamp.");
    }
    if (
      typeof confirmation.snapshotHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(confirmation.snapshotHash)
    ) {
      fail("Invalid confirmation snapshot hash.");
    }
    if (!reportBinding || canonical(confirmation.reportBinding) !== canonical(reportBinding)) {
      fail("Confirmation report binding does not match current report binding.");
    }
  }

  // Validate historical confirmations
  if (!Array.isArray(data.historicalConfirmations)) {
    fail("Malformed historical confirmations.");
  }
  for (const item of data.historicalConfirmations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail("Malformed historical confirmation entry.");
    }
  }

  // Validate absences
  if (!Array.isArray(data.absences)) {
    fail("Malformed participant absences.");
  }
  for (const item of data.absences) {
    const absence = record(item, [
      "position",
      "technicianUid",
      "absenceType",
      "reportedDepartureTime",
      "recordedBy",
      "attestedByUid",
      "reason",
      "recordedRevision",
      "revision",
      "recordedAt",
    ]);
    const participant = positions.find(
      (p) => p.position === absence.position && p.technicianUid === absence.technicianUid,
    );
    if (!participant) {
      fail("Unauthorized participant absence.", 403);
    }
    if (occupiedPositions.has(participant.position)) {
      fail("Contradictory participant resolution: position already confirmed or resolved.");
    }
    occupiedPositions.add(participant.position);
    if (absence.revision !== data.revision) {
      fail("Stale absence revision.");
    }
    positive(absence.recordedRevision, "recorded absence revision");
    if (absence.recordedRevision > data.revision) {
      fail("Invalid absence recorded revision.");
    }
    timestamp(absence.recordedAt);
    if (
      Date.parse(absence.recordedAt) < Date.parse(data.createdAt) ||
      Date.parse(absence.recordedAt) > Date.parse(data.updatedAt)
    ) {
      fail("Contradictory absence timestamp.");
    }
    identifier(absence.recordedBy, "recordedBy UID", 128);
    if (absence.attestedByUid !== null && absence.attestedByUid !== undefined) {
      identifier(absence.attestedByUid, "attestedBy UID", 128);
    }
    if (reason(absence.reason) !== absence.reason) {
      fail("Non-canonical absence reason.");
    }
    // Validate absence type matching participant side
    if (participant.side === EQUAL_HANDOVER_SIDES.INCOMING) {
      if (absence.absenceType !== EQUAL_ABSENCE_TYPES.NOT_YET_IN) {
        fail("Incoming participant absence type must be not_yet_in.");
      }
    } else if (participant.side === EQUAL_HANDOVER_SIDES.OUTGOING) {
      if (absence.absenceType !== EQUAL_ABSENCE_TYPES.ABSENT_LEFT_OFFICE) {
        fail("Outgoing participant absence type must be absent_left_office.");
      }
      if (!absence.reportedDepartureTime) {
        fail("Outgoing participant absence requires reportedDepartureTime.");
      }
      timestamp(absence.reportedDepartureTime);
    } else {
      fail("Invalid participant side for absence.");
    }
  }

  const aggregate = {
    ...data,
    schema: "equal-handover-v2",
    identity,
    reservation,
    reportBinding,
    confirmations: data.confirmations as EqualHandoverConfirmation[],
    historicalConfirmations: data.historicalConfirmations as EqualHandoverHistoricalConfirmation[],
    absences: data.absences as EqualHandoverAbsence[],
  } as EqualHandoverAggregate;

  const currentSnapshotHash = createEqualHandoverSnapshot(aggregate).snapshotHash;
  for (const c of aggregate.confirmations) {
    if (c.snapshotHash !== currentSnapshotHash) {
      fail("Stale confirmation snapshot hash.");
    }
  }

  return structuredClone(aggregate);
}

export function createEqualHandover(input: {
  identity: EqualHandoverIdentity;
  reportBinding?: EqualHandoverReportV2Binding | null;
  reservedAt: string;
  reservedBy: string;
}): EqualHandoverAggregate {
  const identity = createEqualHandoverIdentity(input.identity);
  timestamp(input.reservedAt);
  identifier(input.reservedBy, "reservation actor UID", 128);
  const initialReportBinding = input.reportBinding ? assertReportBinding(input.reportBinding) : null;
  return assertEqualHandoverAggregate({
    schema: "equal-handover-v2",
    identity,
    reservation: reservationFor(identity, 1, input.reservedAt, input.reservedBy),
    reportBinding: initialReportBinding,
    confirmations: [],
    historicalConfirmations: [],
    absences: [],
    retiredSuccessorSlotTokens: [],
    revision: 1,
    lifecycleStatus: "collecting_confirmations",
    createdAt: input.reservedAt,
    updatedAt: input.reservedAt,
  });
}

interface MutationContext {
  revision: number;
  snapshotHash: string;
  recordedAt: string;
}

function mutation(value: EqualHandoverAggregate, context: MutationContext): EqualHandoverAggregate {
  const aggregate = assertEqualHandoverAggregate(value);
  if (aggregate.lifecycleStatus !== "collecting_confirmations") {
    fail("Handover lifecycle does not permit mutation.");
  }
  if (context.revision !== aggregate.revision) {
    fail("Stale handover revision.");
  }
  if (context.snapshotHash !== createEqualHandoverSnapshot(aggregate).snapshotHash) {
    fail("Stale handover snapshot.");
  }
  timestamp(context.recordedAt);
  if (Date.parse(context.recordedAt) < Date.parse(aggregate.updatedAt)) {
    fail("Stale mutation timestamp.");
  }
  return aggregate;
}

function participantFor(aggregate: EqualHandoverAggregate, uid: string) {
  const participant = getEqualHandoverPositions(aggregate.identity).find(
    (item) => item.technicianUid === uid,
  );
  if (!participant) {
    fail("Unauthorized handover participant.", 403);
  }
  return participant;
}

function revise(
  aggregate: EqualHandoverAggregate,
  recordedAt: string,
  invalidationReason: string,
): EqualHandoverAggregate {
  const revision = aggregate.revision + 1;
  positive(revision, "revision");
  const newlyHistorical: EqualHandoverHistoricalConfirmation[] = aggregate.confirmations.map((c) => ({
    ...c,
    invalidatedAt: recordedAt,
    invalidationReason,
  }));
  return {
    ...aggregate,
    revision,
    reservation: { ...aggregate.reservation, revision },
    confirmations: [],
    historicalConfirmations: [...aggregate.historicalConfirmations, ...newlyHistorical],
    absences: aggregate.absences.map((item) => ({ ...item, revision })),
    updatedAt: recordedAt,
  };
}

export function reviseEqualHandoverReport(
  value: EqualHandoverAggregate,
  input: MutationContext & {
    reportBinding: EqualHandoverReportV2Binding;
  },
): EqualHandoverAggregate {
  const aggregate = mutation(value, input);
  const binding = assertReportBinding(input.reportBinding);
  if (
    aggregate.reportBinding &&
    canonical(aggregate.reportBinding) === canonical(binding)
  ) {
    return aggregate;
  }
  const next = revise(aggregate, input.recordedAt, "report_revised");
  next.reportBinding = binding;
  return assertEqualHandoverAggregate(next);
}

export function confirmEqualHandoverParticipant(
  value: EqualHandoverAggregate,
  input: MutationContext & {
    actorUid: string;
    technicianUid: string;
  },
): EqualHandoverAggregate {
  const aggregate = mutation(value, input);
  if (aggregate.reportBinding === null) {
    fail("Freeze and review the consolidated report before confirmation.");
  }
  const participant = participantFor(aggregate, input.technicianUid);
  if (input.actorUid !== participant.technicianUid) {
    fail("A technician must confirm for self.", 403);
  }
  if (aggregate.absences.some((item) => item.position === participant.position)) {
    fail("Conflicting participant resolution: participant is recorded absent.");
  }
  if (aggregate.confirmations.some((item) => item.position === participant.position)) {
    return aggregate;
  }
  const confirmation: EqualHandoverConfirmation = {
    position: participant.position,
    technicianUid: participant.technicianUid,
    revision: aggregate.revision,
    reportBinding: aggregate.reportBinding,
    snapshotHash: input.snapshotHash,
    confirmedAt: input.recordedAt,
  };
  return assertEqualHandoverAggregate({
    ...aggregate,
    confirmations: [...aggregate.confirmations, confirmation],
    updatedAt: input.recordedAt,
  });
}

export function recordEqualHandoverAbsence(
  value: EqualHandoverAggregate,
  input: MutationContext & {
    actorUid: string;
    technicianUid: string;
    absenceType: EqualAbsenceType;
    reason: string;
    reportedDepartureTime?: string | null;
    attestedByUid?: string | null;
  },
): EqualHandoverAggregate {
  const aggregate = mutation(value, input);
  identifier(input.actorUid, "recording actor UID", 128);
  const participant = participantFor(aggregate, input.technicianUid);
  const absenceReason = reason(input.reason);

  if (participant.side === EQUAL_HANDOVER_SIDES.INCOMING) {
    if (input.absenceType !== EQUAL_ABSENCE_TYPES.NOT_YET_IN) {
      fail("Incoming participant absence type must be not_yet_in.", 400);
    }
  } else if (participant.side === EQUAL_HANDOVER_SIDES.OUTGOING) {
    if (input.absenceType !== EQUAL_ABSENCE_TYPES.ABSENT_LEFT_OFFICE) {
      fail("Outgoing participant absence type must be absent_left_office.", 400);
    }
    if (!input.reportedDepartureTime) {
      fail("Outgoing participant absence requires reported departure time.", 400);
    }
    timestamp(input.reportedDepartureTime);
  }

  const existing = aggregate.absences.find((item) => item.position === participant.position);
  if (
    existing &&
    existing.absenceType === input.absenceType &&
    existing.reason === absenceReason &&
    existing.reportedDepartureTime === (input.reportedDepartureTime ?? null) &&
    existing.attestedByUid === (input.attestedByUid ?? null)
  ) {
    return aggregate;
  }

  const next = revise(aggregate, input.recordedAt, "absence_recorded");
  const departureTime =
    participant.side === EQUAL_HANDOVER_SIDES.OUTGOING
      ? (input.reportedDepartureTime ?? null)
      : null;

  const absence: EqualHandoverAbsence = {
    position: participant.position,
    technicianUid: participant.technicianUid,
    absenceType: input.absenceType,
    reportedDepartureTime: departureTime,
    recordedBy: input.actorUid,
    attestedByUid: input.attestedByUid ?? null,
    reason: absenceReason,
    recordedRevision: next.revision,
    revision: next.revision,
    recordedAt: input.recordedAt,
  };

  next.absences = [
    ...next.absences.filter((item) => item.position !== participant.position),
    absence,
  ];
  return assertEqualHandoverAggregate(next);
}

export function clearEqualHandoverAbsence(
  value: EqualHandoverAggregate,
  input: MutationContext & {
    actorUid: string;
    technicianUid: string;
  },
): EqualHandoverAggregate {
  const aggregate = mutation(value, input);
  identifier(input.actorUid, "clearing actor UID", 128);
  const participant = participantFor(aggregate, input.technicianUid);
  if (!aggregate.absences.some((item) => item.position === participant.position)) {
    return aggregate;
  }
  const next = revise(aggregate, input.recordedAt, "absence_cleared");
  next.absences = next.absences.filter((item) => item.position !== participant.position);
  return assertEqualHandoverAggregate(next);
}

export function assertEqualHandoverReadyForTransfer(
  value: unknown,
  expected: {
    revision: number;
    snapshotHash: string;
  },
): EqualHandoverAggregate {
  const aggregate = assertEqualHandoverAggregate(value);
  if (aggregate.lifecycleStatus !== "collecting_confirmations") {
    fail("Handover lifecycle does not permit transfer.");
  }
  if (aggregate.reportBinding === null) {
    fail("Freeze and review the consolidated report before transfer.");
  }
  if (expected.revision !== aggregate.revision) {
    fail("Stale handover revision.");
  }
  if (expected.snapshotHash !== createEqualHandoverSnapshot(aggregate).snapshotHash) {
    fail("Stale handover snapshot.");
  }

  const participants = resolveEqualHandoverParticipants(aggregate);
  const awaiting = participants.filter((p) => p.state === "awaiting_confirmation");
  if (awaiting.length > 0) {
    fail("Incomplete handover: every participant requires confirmation or a valid absence resolution.");
  }

  const confirmedCount = aggregate.confirmations.length;
  const absenceCount = aggregate.absences.length;

  // Case 1: All 4 confirmed
  if (confirmedCount === 4 && absenceCount === 0) {
    return aggregate;
  }

  // Case 2: Exactly 3 confirmed and exactly 1 valid supported absence
  if (confirmedCount === 3 && absenceCount === 1) {
    const singleAbsence = aggregate.absences[0];
    const participant = participants.find((p) => p.position === singleAbsence.position);
    if (!participant) {
      fail("Contradictory absence participant.");
    }
    if (participant.side === EQUAL_HANDOVER_SIDES.INCOMING) {
      if (singleAbsence.absenceType !== EQUAL_ABSENCE_TYPES.NOT_YET_IN) {
        fail("Unsupported absence combination: missing incoming technician requires not_yet_in declaration.");
      }
    } else if (participant.side === EQUAL_HANDOVER_SIDES.OUTGOING) {
      if (
        singleAbsence.absenceType !== EQUAL_ABSENCE_TYPES.ABSENT_LEFT_OFFICE ||
        !singleAbsence.reportedDepartureTime
      ) {
        fail("Unsupported absence combination: missing outgoing technician requires absent_left_office declaration with departure time.");
      }
    }
    return aggregate;
  }

  // Unsupported absence combinations
  if (absenceCount > 1) {
    fail(`Unsupported absence combination: multiple absences are blocked (found ${absenceCount}).`);
  }

  fail("Unsupported confirmation and absence combination.");
}

export function completeEqualHandoverTransfer(
  value: EqualHandoverAggregate,
  input: MutationContext & {
    actorUid: string;
  },
): EqualHandoverAggregate {
  const aggregate = mutation(value, input);
  identifier(input.actorUid, "transferring actor UID", 128);
  assertEqualHandoverReadyForTransfer(aggregate, input);
  return assertEqualHandoverAggregate({
    ...aggregate,
    lifecycleStatus: "completed",
    updatedAt: input.recordedAt,
  });
}

/**
 * Stage 1 — the outgoing side's final-transfer commitment. The reviewed report,
 * the four-person confirmation/absence obligation and the immutable frozen
 * binding are all still satisfied exactly as a transfer would require, but the
 * handover does not become complete here: it enters `awaiting_incoming_acceptance`
 * and waits for an incoming technician to accept with their own password. Only
 * `updatedAt` moves; `revision` and the reviewed snapshot are unchanged, so an
 * incoming participant's already-reviewed evidence stays valid across the commit.
 */
export function commitEqualHandoverOutgoingTransfer(
  value: EqualHandoverAggregate,
  input: MutationContext & {
    actorUid: string;
  },
): EqualHandoverAggregate {
  const aggregate = mutation(value, input);
  identifier(input.actorUid, "committing actor UID", 128);
  assertEqualHandoverReadyForTransfer(aggregate, input);
  const actor = resolveEqualHandoverParticipants(aggregate).find(
    (item) => item.technicianUid === input.actorUid,
  );
  if (!actor || actor.side !== "outgoing" || actor.state !== "confirmed") {
    fail("Only a personally confirmed outgoing technician may commit this handover.", 403);
  }
  return assertEqualHandoverAggregate({
    ...aggregate,
    lifecycleStatus: "awaiting_incoming_acceptance",
    updatedAt: input.recordedAt,
  });
}

/**
 * Stage 2 — the first authorized incoming technician's password acceptance
 * completes the handover and is the point at which the reserved incoming shift
 * is activated (by the persistence service, in the same transaction). The
 * actor must be a reserved incoming participant who has personally confirmed;
 * the terminal `completed` state then freezes the aggregate so the second
 * partner can only late-join the already-active shift, never re-open it.
 */
export function activateEqualHandoverIncomingTransfer(
  value: EqualHandoverAggregate,
  input: {
    revision: number;
    snapshotHash: string;
    recordedAt: string;
    actorUid: string;
  },
): EqualHandoverAggregate {
  const aggregate = assertEqualHandoverAggregate(value);
  identifier(input.actorUid, "accepting actor UID", 128);
  if (aggregate.lifecycleStatus !== "awaiting_incoming_acceptance") {
    fail("The handover does not permit incoming acceptance in its current lifecycle.", 409);
  }
  if (input.revision !== aggregate.revision) {
    fail("Stale handover revision.");
  }
  if (input.snapshotHash !== createEqualHandoverSnapshot(aggregate).snapshotHash) {
    fail("Stale handover snapshot.");
  }
  timestamp(input.recordedAt);
  if (Date.parse(input.recordedAt) < Date.parse(aggregate.updatedAt)) {
    fail("Stale acceptance timestamp.");
  }
  const actor = resolveEqualHandoverParticipants(aggregate).find(
    (item) => item.technicianUid === input.actorUid,
  );
  if (!actor || actor.side !== "incoming" || actor.state !== "confirmed") {
    fail("Only a personally confirmed incoming technician may accept and activate this handover.", 403);
  }
  return assertEqualHandoverAggregate({
    ...aggregate,
    lifecycleStatus: "completed",
    updatedAt: input.recordedAt,
  });
}

export function closeEqualHandover(
  value: EqualHandoverAggregate,
  input: MutationContext & {
    actorUid: string;
    status: "cancelled" | "superseded";
  },
): EqualHandoverAggregate {
  const aggregate = mutation(value, input);
  identifier(input.actorUid, "closing actor UID", 128);
  if (input.status !== "cancelled" && input.status !== "superseded") {
    fail("Invalid terminal lifecycle.");
  }
  return assertEqualHandoverAggregate({
    ...aggregate,
    lifecycleStatus: input.status,
    updatedAt: input.recordedAt,
  });
}

export function replaceEqualHandoverReservation(
  value: EqualHandoverAggregate,
  input: MutationContext & {
    actorUid: string;
    identity: EqualHandoverIdentity;
    reportBinding?: EqualHandoverReportV2Binding | null;
  },
): { superseded: EqualHandoverAggregate; replacement: EqualHandoverAggregate } {
  const aggregate = mutation(value, input);
  identifier(input.actorUid, "replacing actor UID", 128);
  const identity = createEqualHandoverIdentity(input.identity);

  if (
    identity.successorSlotToken === aggregate.identity.successorSlotToken ||
    aggregate.retiredSuccessorSlotTokens.includes(identity.successorSlotToken)
  ) {
    fail("Replacement reservation requires a fresh successor token.");
  }

  if (
    identity.outgoingShiftId !== aggregate.identity.outgoingShiftId ||
    identity.outgoingSlotToken !== aggregate.identity.outgoingSlotToken ||
    identity.outgoingGeneration !== aggregate.identity.outgoingGeneration
  ) {
    fail("Replacement must retain the current outgoing operational lineage.");
  }

  const revision = aggregate.revision + 1;
  positive(revision, "revision");

  const created = createEqualHandover({
    identity,
    reportBinding: input.reportBinding !== undefined ? input.reportBinding : aggregate.reportBinding,
    reservedAt: input.recordedAt,
    reservedBy: input.actorUid,
  });

  const replacement = assertEqualHandoverAggregate({
    ...created,
    revision,
    reservation: { ...created.reservation, revision },
    retiredSuccessorSlotTokens: [
      ...aggregate.retiredSuccessorSlotTokens,
      aggregate.identity.successorSlotToken,
    ],
  });

  const superseded = assertEqualHandoverAggregate({
    ...aggregate,
    lifecycleStatus: "superseded",
    updatedAt: input.recordedAt,
  });

  return { superseded, replacement };
}

// ============================================================================
// ATTENDANCE DOMAIN RULES & EVALUATIONS (Pure Contracts)
// ============================================================================

/**
 * Lateness calculation rule:
 * - Exactly five minutes (300,000 ms) after scheduled start is ON TIME.
 * - More than five minutes (> 300,000 ms) after scheduled start is LATE.
 */
export function evaluateIncomingAttendanceLateness(
  scheduledStart: string,
  timestampString: string,
): {
  isLate: boolean;
  latenessMinutes: number;
  lateReasonRequired: boolean;
} {
  timestamp(scheduledStart);
  timestamp(timestampString);

  const startMs = Date.parse(scheduledStart);
  const timeMs = Date.parse(timestampString);
  const diffMs = timeMs - startMs;
  const latenessMinutes = diffMs > 0 ? diffMs / 60000 : 0;

  // More than 5 minutes (300,000 ms) is late. Exactly 5 minutes is on time.
  const isLate = diffMs > 5 * 60 * 1000;

  return {
    isLate,
    latenessMinutes,
    lateReasonRequired: isLate,
  };
}

/**
 * Present incoming technician clock-in evaluation:
 * - Occurs at first successful personal authenticated handover confirmation.
 * - Reconfirmation cannot reset clock-in (idempotency rule).
 * - If late (> 5 minutes), mandatory late reason required.
 */
export function evaluateIncomingClockIn(input: {
  technicianUid: string;
  confirmedAt: string;
  scheduledStart: string;
  existingClockIn?: IncomingClockInEvaluation | null;
  lateReason?: string | null;
}): IncomingClockInEvaluation {
  identifier(input.technicianUid, "technician UID", 128);
  timestamp(input.confirmedAt);
  timestamp(input.scheduledStart);

  // If clock-in already exists, it is idempotent: reconfirmation never resets it
  if (input.existingClockIn) {
    if (input.existingClockIn.technicianUid !== input.technicianUid) {
      fail("Existing clock-in UID does not match evaluating technician UID.");
    }
    return structuredClone(input.existingClockIn);
  }

  const { isLate, latenessMinutes, lateReasonRequired } = evaluateIncomingAttendanceLateness(
    input.scheduledStart,
    input.confirmedAt,
  );

  if (isLate) {
    if (!input.lateReason || !input.lateReason.trim()) {
      fail("A non-empty late reason is required when confirming more than five minutes after scheduled start.", 400);
    }
  }

  return {
    technicianUid: input.technicianUid,
    clockInTimestamp: input.confirmedAt,
    firstConfirmedAt: input.confirmedAt,
    isLate,
    latenessMinutes,
    lateReasonRequired,
    lateReason: isLate ? input.lateReason?.trim() ?? null : null,
  };
}

/**
 * Missing incoming technician who arrives later and accepts/joins shift:
 * - Uses their own server acceptance time (acceptedAt), not the earlier handover completion time.
 */
export function evaluateLateIncomingAcceptance(input: {
  technicianUid: string;
  scheduledStart: string;
  acceptedAt: string;
  lateReason: string;
}): LateIncomingAcceptanceEvaluation {
  identifier(input.technicianUid, "technician UID", 128);
  timestamp(input.scheduledStart);
  timestamp(input.acceptedAt);
  const lateReasonText = reason(input.lateReason);

  const startMs = Date.parse(input.scheduledStart);
  const acceptedMs = Date.parse(input.acceptedAt);
  const diffMs = acceptedMs - startMs;
  const latenessMinutes = diffMs > 0 ? diffMs / 60000 : 0;

  return {
    technicianUid: input.technicianUid,
    acceptedAt: input.acceptedAt,
    clockInTimestamp: input.acceptedAt,
    isLate: true,
    latenessMinutes,
    lateReasonRequired: true,
    lateReason: lateReasonText,
  };
}

/**
 * Outgoing technician departure evaluation:
 * - Personal departure vs colleague-attested departure is explicitly distinguished.
 */
export function evaluateOutgoingDeparture(input: {
  technicianUid: string;
  departureTimestamp: string;
  isPersonal: boolean;
  attestingColleagueUid?: string | null;
  reason?: string | null;
}): OutgoingDepartureEvaluation {
  identifier(input.technicianUid, "technician UID", 128);
  timestamp(input.departureTimestamp);

  if (input.isPersonal) {
    return {
      technicianUid: input.technicianUid,
      departureTimestamp: input.departureTimestamp,
      provenance: ATTENDANCE_CLOCK_OUT_PROVENANCE.PERSONAL,
      attestedByUid: null,
      reason: input.reason?.trim() ?? null,
    };
  }

  // Colleague-attested departure
  if (!input.attestingColleagueUid) {
    fail("Colleague-attested departure requires attestingColleagueUid.", 400);
  }
  identifier(input.attestingColleagueUid, "attesting colleague UID", 128);
  if (input.attestingColleagueUid === input.technicianUid) {
    fail("A technician cannot colleague-attest their own departure.", 400);
  }
  const attestedReason = reason(input.reason);

  return {
    technicianUid: input.technicianUid,
    departureTimestamp: input.departureTimestamp,
    provenance: ATTENDANCE_CLOCK_OUT_PROVENANCE.COLLEAGUE_ATTESTED,
    attestedByUid: input.attestingColleagueUid,
    reason: attestedReason,
  };
}

/**
 * Explicit unresolved business policy outcomes:
 * Payable-hours calculation rules and attendance correction authority remain explicitly unresolved.
 */
export function resolveUnresolvedAttendancePolicies(): {
  payableHoursEvaluation: UnresolvedPolicy;
  attendanceCorrectionAuthority: UnresolvedPolicy;
} {
  return {
    payableHoursEvaluation: UNRESOLVED_POLICY,
    attendanceCorrectionAuthority: UNRESOLVED_POLICY,
  };
}
