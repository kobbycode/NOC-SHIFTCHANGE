import { createHash } from "node:crypto";
import type {
  HandoverAbsence, HandoverAggregate, HandoverConfirmation, HandoverIdentity,
  HandoverParticipant, HandoverReservation, HandoverSnapshot,
  HandoverSupervisorActor, HandoverSupervisorException,
  HandoverTemporaryAuthorization, HandoverWorkSnapshot, SupervisorExceptionCategory,
} from "@/types/handover";

export class HandoverDomainError extends Error {
  public readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "HandoverDomainError";
    this.status = status;
  }
}

function fail(message: string, status = 409): never {
  throw new HandoverDomainError(message, status);
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Malformed handover state.");
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(result, key))) {
    fail("Malformed handover state: missing or unsupported fields.");
  }
  return result;
}

function identifier(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value ||
      value.length > max || value.includes("/") || value === "." || value === "..") {
    fail(`Invalid ${label}.`, 400);
  }
}

function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`Invalid ${label}.`, 400);
}

function timestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail("Invalid canonical timestamp.", 400);
}

function token(value: unknown): asserts value is string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail("Invalid handover slot token.", 400);
  }
}

function reason(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail("A non-empty reason is required.", 400);
  return value.trim();
}

// Recursive sorted keys, with ordered pair positions and sorted evidence records.
// No arbitrary object insertion order or locale-dependent collation participates.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

const identityFields = [
  "outgoingShiftId", "outgoingPermanentPairId", "outgoingPrimaryTechnicianIds",
  "outgoingSlotToken", "outgoingGeneration", "incomingShiftId", "incomingPermanentPairId",
  "incomingPrimaryTechnicianIds", "successorSlotToken", "successorGeneration",
  "shiftType", "scheduledStart", "scheduledEnd",
] as const;

export function createHandoverIdentity(value: unknown): HandoverIdentity {
  const data = record(value, identityFields);
  for (const field of ["outgoingShiftId", "incomingShiftId", "outgoingPermanentPairId", "incomingPermanentPairId"]) {
    identifier(data[field], field);
  }
  if (data.outgoingShiftId === data.incomingShiftId) fail("Incoming and outgoing shifts must differ.");
  for (const field of ["outgoingPrimaryTechnicianIds", "incomingPrimaryTechnicianIds"]) {
    const pair = data[field];
    if (!Array.isArray(pair) || pair.length !== 2) fail("Each permanent pair requires exactly two technicians.");
    for (const uid of pair) identifier(uid, "technician UID", 128);
    if (pair[0] === pair[1]) fail("Duplicate permanent participant identity.");
  }
  const outgoing = data.outgoingPrimaryTechnicianIds as [string, string];
  const incoming = data.incomingPrimaryTechnicianIds as [string, string];
  if (new Set([...outgoing, ...incoming]).size !== 4) fail("Cross-side duplicate participant identity.");
  token(data.outgoingSlotToken);
  token(data.successorSlotToken);
  positive(data.outgoingGeneration, "outgoing generation");
  positive(data.successorGeneration, "successor generation");
  if (data.successorGeneration !== data.outgoingGeneration + 1 ||
      data.outgoingSlotToken.toLowerCase() === data.successorSlotToken.toLowerCase()) {
    fail("Invalid successor lineage.");
  }
  timestamp(data.scheduledStart);
  timestamp(data.scheduledEnd);
  if (Date.parse(data.scheduledEnd) <= Date.parse(data.scheduledStart)) fail("Invalid scheduled range.");
  if (data.shiftType !== "morning" && data.shiftType !== "night") fail("Invalid shift type.", 400);
  return {
    ...data, outgoingPrimaryTechnicianIds: [...outgoing], incomingPrimaryTechnicianIds: [...incoming],
    outgoingSlotToken: data.outgoingSlotToken.toLowerCase(), successorSlotToken: data.successorSlotToken.toLowerCase(),
  } as unknown as HandoverIdentity;
}

// Stable persistence location: future initialization must read/create this exact
// location transactionally, and replacement must update the same document.
export function createHandoverDocumentId(outgoingShiftId: string): string {
  identifier(outgoingShiftId, "outgoing shift ID");
  const documentId = `handover_${outgoingShiftId}`;
  if (new TextEncoder().encode(documentId).byteLength > 1500) {
    fail("Handover document ID exceeds 1500 UTF-8 bytes.", 400);
  }
  return documentId;
}

// Reservation identity fingerprint, NOT the stable persistence document ID.
export function createHandoverId(identity: HandoverIdentity): string {
  return `handover_${digest(createHandoverIdentity(identity))}`;
}

function reservationFor(identity: HandoverIdentity, revision: number, reservedAt: string, reservedBy: string): HandoverReservation {
  return {
    handoverId: createHandoverId(identity), reservedIncomingShiftId: identity.incomingShiftId,
    outgoingShiftId: identity.outgoingShiftId, incomingPermanentPairId: identity.incomingPermanentPairId,
    incomingPrimaryTechnicianIds: [...identity.incomingPrimaryTechnicianIds], shiftType: identity.shiftType,
    scheduledStart: identity.scheduledStart, scheduledEnd: identity.scheduledEnd,
    outgoingSlotToken: identity.outgoingSlotToken, outgoingGeneration: identity.outgoingGeneration,
    successorSlotToken: identity.successorSlotToken, expectedSuccessorGeneration: identity.successorGeneration,
    revision, reservedAt, reservedBy,
  };
}

export function assertHandoverReservation(value: unknown, identity: HandoverIdentity, revision: number): HandoverReservation {
  const validIdentity = createHandoverIdentity(identity);
  positive(revision, "revision");
  const data = record(value, Object.keys(reservationFor(validIdentity, revision, "", "")));
  timestamp(data.reservedAt);
  identifier(data.reservedBy, "reservation actor UID", 128);
  const expected = reservationFor(validIdentity, revision, data.reservedAt, data.reservedBy);
  if (canonical(data) !== canonical(expected)) fail("Invalid incoming reservation binding.");
  return expected;
}

function work(value: unknown): HandoverWorkSnapshot {
  const hasSchema = value !== null && typeof value === "object" && Object.hasOwn(value, "schema");
  const data = record(value, hasSchema ? ["schema", "id", "version"] : ["id", "version"]);
  if (hasSchema && data.schema !== "handover-work-v1" && data.schema !== "handover-work-v2") {
    fail("Unsupported handover work snapshot schema.");
  }
  identifier(data.id, "work snapshot ID");
  if (typeof data.version !== "string" || !/^[0-9a-f]{64}$/.test(data.version)) {
    fail("Invalid work snapshot digest.", 400);
  }
  // Preserve legacy shape: normalizing it would invalidate historical hashes.
  return { ...(hasSchema ? { schema: data.schema as HandoverWorkSnapshot["schema"] } : {}),
    id: data.id, version: data.version };
}

function temporary(value: unknown, identity: HandoverIdentity): HandoverTemporaryAuthorization | null {
  if (value === null) return null;
  const data = record(value, ["authorizationId", "technicianUid"]);
  identifier(data.authorizationId, "temporary authorization ID");
  identifier(data.technicianUid, "temporary technician UID", 128);
  if ([...identity.outgoingPrimaryTechnicianIds, ...identity.incomingPrimaryTechnicianIds].includes(data.technicianUid)) {
    fail("Temporary C cannot occupy a permanent participant position.");
  }
  return { authorizationId: data.authorizationId, technicianUid: data.technicianUid };
}

function participantIdentities(identity: HandoverIdentity) {
  return [
    { position: "outgoing_primary_a", side: "outgoing", technicianUid: identity.outgoingPrimaryTechnicianIds[0] },
    { position: "outgoing_primary_b", side: "outgoing", technicianUid: identity.outgoingPrimaryTechnicianIds[1] },
    { position: "incoming_primary_a", side: "incoming", technicianUid: identity.incomingPrimaryTechnicianIds[0] },
    { position: "incoming_primary_b", side: "incoming", technicianUid: identity.incomingPrimaryTechnicianIds[1] },
  ] as const;
}

function snapshotOf(aggregate: HandoverAggregate): HandoverSnapshot {
  const sorted = <T extends { position: string }>(items: T[]) =>
    [...items].sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : 0);
  const data = {
    identity: aggregate.identity, reservation: aggregate.reservation, revision: aggregate.revision,
    workSnapshot: aggregate.workSnapshot, temporaryAuthorization: aggregate.temporaryAuthorization,
    absences: sorted(aggregate.absences), exceptions: sorted(aggregate.exceptions),
  };
  // Confirmations are excluded to avoid circularity. Lifecycle/update metadata
  // are excluded: they cannot change what was reviewed.
  return structuredClone({ ...data, snapshotHash: digest(data) });
}

export function assertHandoverAggregate(value: unknown): HandoverAggregate {
  const data = record(value, ["identity", "reservation", "workSnapshot", "temporaryAuthorization",
    "confirmations", "absences", "exceptions", "revision", "lifecycleStatus", "createdAt", "updatedAt", "retiredSuccessorSlotTokens"]);
  const identity = createHandoverIdentity(data.identity);
  // Aggregates store canonical token spelling; factories normalize external identity.
  if (canonical(identity) !== canonical(data.identity)) fail("Non-canonical handover identity.");
  positive(data.revision, "revision");
  const reservation = assertHandoverReservation(data.reservation, identity, data.revision);
  if (!Array.isArray(data.retiredSuccessorSlotTokens)) fail("Malformed retired reservation lineage.");
  const retired = new Set<string>();
  for (const retiredToken of data.retiredSuccessorSlotTokens) {
    token(retiredToken);
    if (retiredToken !== retiredToken.toLowerCase() || retired.has(retiredToken) ||
        retiredToken === identity.outgoingSlotToken || retiredToken === identity.successorSlotToken) {
      fail("Reused or malformed retired successor token.");
    }
    retired.add(retiredToken);
  }
  if (retired.size >= data.revision) fail("Contradictory retired reservation revision.");
  const workSnapshot = work(data.workSnapshot);
  if (workSnapshot.id !== identity.outgoingShiftId) fail("Work snapshot scope must match outgoing shift.");
  const temporaryAuthorization = temporary(data.temporaryAuthorization, identity);
  timestamp(data.createdAt);
  timestamp(data.updatedAt);
  if (Date.parse(data.updatedAt) < Date.parse(data.createdAt) ||
      Date.parse(reservation.reservedAt) < Date.parse(data.createdAt) ||
      Date.parse(reservation.reservedAt) > Date.parse(data.updatedAt)) fail("Contradictory handover timestamps.");
  if (!["collecting_confirmations", "completed", "cancelled", "superseded"].includes(data.lifecycleStatus as string)) {
    fail("Invalid handover lifecycle.");
  }
  const occupied = new Set<string>();
  const positions = participantIdentities(identity);
  for (const [field, fields] of [
    ["confirmations", ["position", "technicianUid", "revision", "snapshotHash", "confirmedAt"]],
    ["absences", ["position", "technicianUid", "revision", "recordedRevision", "recordedAt", "recordedBy", "reason"]],
    ["exceptions", ["position", "technicianUid", "revision", "recordedRevision", "recordedAt", "supervisorUid", "category", "reason"]],
  ] as const) {
    const items = data[field];
    if (!Array.isArray(items)) fail("Malformed participant evidence.");
    for (const item of items) {
      const evidence = record(item, fields);
      const participant = positions.find((position) => position.position === evidence.position && position.technicianUid === evidence.technicianUid);
      if (!participant) fail("Unauthorized permanent participant evidence.", 403);
      if (occupied.has(participant.position)) fail("Contradictory participant resolution.");
      occupied.add(participant.position);
      if (evidence.revision !== data.revision) fail("Stale evidence revision.");
      const recordedAt = field === "confirmations" ? evidence.confirmedAt : evidence.recordedAt;
      timestamp(recordedAt);
      if (Date.parse(recordedAt) < Date.parse(data.createdAt) || Date.parse(recordedAt) > Date.parse(data.updatedAt)) {
        fail("Contradictory evidence timestamp.");
      }
      if (field === "confirmations") {
        if (typeof evidence.snapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(evidence.snapshotHash)) fail("Invalid confirmation snapshot.");
      } else {
        identifier(field === "absences" ? evidence.recordedBy : evidence.supervisorUid, "supervisor UID", 128);
        if (reason(evidence.reason) !== evidence.reason) fail("Non-canonical resolution reason.");
        positive(evidence.recordedRevision, "recorded revision");
        if (evidence.recordedRevision > data.revision) fail("Invalid resolution revision.");
        if (field === "exceptions" && !["unavailable", "emergency", "operational_constraint"].includes(evidence.category as string)) {
          fail("Invalid supervisor exception category.", 400);
        }
      }
    }
  }
  const aggregate = {
    ...data, identity, reservation, workSnapshot, temporaryAuthorization,
  } as unknown as HandoverAggregate;
  const hash = snapshotOf(aggregate).snapshotHash;
  if (aggregate.confirmations.some((confirmation) => confirmation.snapshotHash !== hash)) fail("Stale confirmation snapshot.");
  return structuredClone(aggregate);
}

export function createHandover(input: {
  identity: HandoverIdentity; workSnapshot: HandoverWorkSnapshot;
  temporaryAuthorization?: HandoverTemporaryAuthorization | null; reservedAt: string; reservedBy: string;
}): HandoverAggregate {
  const identity = createHandoverIdentity(input.identity);
  timestamp(input.reservedAt);
  identifier(input.reservedBy, "reservation actor UID", 128);
  return assertHandoverAggregate({
    identity, reservation: reservationFor(identity, 1, input.reservedAt, input.reservedBy),
    workSnapshot: work(input.workSnapshot), temporaryAuthorization: temporary(input.temporaryAuthorization ?? null, identity),
    confirmations: [], absences: [], exceptions: [], retiredSuccessorSlotTokens: [], revision: 1,
    lifecycleStatus: "collecting_confirmations", createdAt: input.reservedAt, updatedAt: input.reservedAt,
  });
}

export function createHandoverSnapshot(value: HandoverAggregate): HandoverSnapshot {
  return snapshotOf(assertHandoverAggregate(value));
}

export function resolveHandoverParticipants(value: HandoverAggregate): HandoverParticipant[] {
  const aggregate = assertHandoverAggregate(value);
  return participantIdentities(aggregate.identity).map((participant): HandoverParticipant => {
    const confirmation = aggregate.confirmations.find((item) => item.position === participant.position);
    const absence = aggregate.absences.find((item) => item.position === participant.position);
    const exception = aggregate.exceptions.find((item) => item.position === participant.position);
    if (confirmation) return { ...participant, state: "confirmed", confirmation };
    if (absence) return { ...participant, state: "absent", absence };
    if (exception) return { ...participant, state: "supervisor_exception", exception };
    return { ...participant, state: "awaiting_confirmation" };
  });
}

interface MutationContext {
  revision: number;
  snapshotHash: string;
  recordedAt: string;
}

function mutation(value: HandoverAggregate, context: MutationContext): HandoverAggregate {
  const aggregate = assertHandoverAggregate(value);
  if (aggregate.lifecycleStatus !== "collecting_confirmations") fail("Handover lifecycle does not permit mutation.");
  if (context.revision !== aggregate.revision) fail("Stale handover revision.");
  if (context.snapshotHash !== snapshotOf(aggregate).snapshotHash) fail("Stale handover snapshot.");
  timestamp(context.recordedAt);
  if (Date.parse(context.recordedAt) < Date.parse(aggregate.updatedAt)) fail("Stale mutation timestamp.");
  return aggregate;
}

function participantFor(aggregate: HandoverAggregate, uid: string) {
  const participant = participantIdentities(aggregate.identity).find((item) => item.technicianUid === uid);
  if (!participant) fail("Unauthorized handover participant.", 403);
  return participant;
}

function supervisor(actor: HandoverSupervisorActor): void {
  const data = record(actor, ["uid", "authority"]);
  identifier(data.uid, "supervisor UID", 128);
  if (data.authority !== "supervisor" && data.authority !== "manager") fail("Supervisor authority required.", 403);
}

// Future attendance is permitted only for actually present incoming technicians
// whose own authenticated acceptance declares them on duty. Pair membership,
// absence, exception and temporary C never fabricate that declaration here.
export function confirmHandoverParticipant(value: HandoverAggregate, input: MutationContext & {
  actorUid: string; technicianUid: string;
}): HandoverAggregate {
  const aggregate = mutation(value, input);
  const participant = participantFor(aggregate, input.technicianUid);
  if (input.actorUid !== participant.technicianUid) fail("A technician must confirm for self.", 403);
  if (aggregate.absences.some((item) => item.position === participant.position) ||
      aggregate.exceptions.some((item) => item.position === participant.position)) fail("Conflicting participant resolution.");
  if (aggregate.confirmations.some((item) => item.position === participant.position)) return aggregate;
  const confirmation: HandoverConfirmation = {
    position: participant.position, technicianUid: participant.technicianUid,
    revision: aggregate.revision, snapshotHash: input.snapshotHash, confirmedAt: input.recordedAt,
  };
  return assertHandoverAggregate({ ...aggregate, confirmations: [...aggregate.confirmations, confirmation], updatedAt: input.recordedAt });
}

// Every reviewed authoritative change invalidates ALL confirmations. Other
// supervisor resolutions carry forward explicitly; their original audit revision
// and timestamp remain intact. Confirmation additions do not change the snapshot.
function revise(aggregate: HandoverAggregate, recordedAt: string): HandoverAggregate {
  const revision = aggregate.revision + 1;
  positive(revision, "revision");
  return {
    ...aggregate, revision, reservation: { ...aggregate.reservation, revision }, confirmations: [],
    absences: aggregate.absences.map((item) => ({ ...item, revision })),
    exceptions: aggregate.exceptions.map((item) => ({ ...item, revision })), updatedAt: recordedAt,
  };
}

export function recordHandoverAbsence(value: HandoverAggregate, input: MutationContext & {
  technicianUid: string; actor: HandoverSupervisorActor; reason: string;
}): HandoverAggregate {
  const aggregate = mutation(value, input);
  supervisor(input.actor);
  const participant = participantFor(aggregate, input.technicianUid);
  const absenceReason = reason(input.reason);
  if (aggregate.exceptions.some((item) => item.position === participant.position)) fail("Conflicting supervisor exception; clear it explicitly first.");
  const existing = aggregate.absences.find((item) => item.position === participant.position);
  if (existing?.recordedBy === input.actor.uid && existing.reason === absenceReason) return aggregate;
  const next = revise(aggregate, input.recordedAt);
  const absence: HandoverAbsence = {
    position: participant.position, technicianUid: participant.technicianUid,
    recordedBy: input.actor.uid, reason: absenceReason, revision: next.revision,
    recordedRevision: next.revision, recordedAt: input.recordedAt,
  };
  next.absences = [...next.absences.filter((item) => item.position !== participant.position), absence];
  return assertHandoverAggregate(next);
}

export function recordHandoverException(value: HandoverAggregate, input: MutationContext & {
  technicianUid: string; actor: HandoverSupervisorActor; category: SupervisorExceptionCategory; reason: string;
}): HandoverAggregate {
  const aggregate = mutation(value, input);
  supervisor(input.actor);
  const participant = participantFor(aggregate, input.technicianUid);
  const exceptionReason = reason(input.reason);
  if (!["unavailable", "emergency", "operational_constraint"].includes(input.category)) fail("Invalid supervisor exception category.", 400);
  if (aggregate.absences.some((item) => item.position === participant.position)) fail("Conflicting absence; clear it explicitly first.");
  const existing = aggregate.exceptions.find((item) => item.position === participant.position);
  if (existing?.supervisorUid === input.actor.uid && existing.reason === exceptionReason && existing.category === input.category) return aggregate;
  const next = revise(aggregate, input.recordedAt);
  const exception: HandoverSupervisorException = {
    position: participant.position, technicianUid: participant.technicianUid,
    supervisorUid: input.actor.uid, category: input.category, reason: exceptionReason,
    revision: next.revision, recordedRevision: next.revision, recordedAt: input.recordedAt,
  };
  next.exceptions = [...next.exceptions.filter((item) => item.position !== participant.position), exception];
  return assertHandoverAggregate(next);
}

export function clearHandoverResolution(value: HandoverAggregate, input: MutationContext & {
  technicianUid: string; actor: HandoverSupervisorActor;
}): HandoverAggregate {
  const aggregate = mutation(value, input);
  supervisor(input.actor);
  const participant = participantFor(aggregate, input.technicianUid);
  if (!aggregate.absences.some((item) => item.position === participant.position) &&
      !aggregate.exceptions.some((item) => item.position === participant.position)) return aggregate;
  const next = revise(aggregate, input.recordedAt);
  next.absences = next.absences.filter((item) => item.position !== participant.position);
  next.exceptions = next.exceptions.filter((item) => item.position !== participant.position);
  return assertHandoverAggregate(next);
}

// Identity/reservation are immutable within this aggregate. Changed pair,
// schedule or lineage requires superseding it and creating a fresh reservation.
// The future allocator must guarantee globally fresh successor UUIDs; this pure
// aggregate prevents reuse throughout its carried replacement lineage. Across
// independently created aggregates, global uniqueness belongs to the allocator.
export function reviseHandoverSnapshot(value: HandoverAggregate, input: MutationContext & {
  workSnapshot: HandoverWorkSnapshot; temporaryAuthorization: HandoverTemporaryAuthorization | null;
}): HandoverAggregate {
  const aggregate = mutation(value, input);
  const nextWork = work(input.workSnapshot);
  const nextTemporary = temporary(input.temporaryAuthorization, aggregate.identity);
  if (canonical(nextWork) === canonical(aggregate.workSnapshot) &&
      canonical(nextTemporary) === canonical(aggregate.temporaryAuthorization)) return aggregate;
  if (nextWork.id !== aggregate.identity.outgoingShiftId) fail("Work snapshot scope must match outgoing shift.");
  return assertHandoverAggregate({ ...revise(aggregate, input.recordedAt), workSnapshot: nextWork, temporaryAuthorization: nextTemporary });
}

export function assertHandoverReadyForTransfer(value: HandoverAggregate, expected: {
  revision: number; snapshotHash: string;
}): HandoverAggregate {
  const aggregate = assertHandoverAggregate(value);
  if (aggregate.lifecycleStatus !== "collecting_confirmations") fail("Handover lifecycle does not permit transfer.");
  if (expected.revision !== aggregate.revision) fail("Stale handover revision.");
  if (expected.snapshotHash !== snapshotOf(aggregate).snapshotHash) fail("Stale handover snapshot.");
  if (resolveHandoverParticipants(aggregate).some((participant) => participant.state === "awaiting_confirmation")) {
    fail("Incomplete handover: every permanent participant requires a resolution.");
  }
  return aggregate;
}

export function closeHandover(value: HandoverAggregate, input: MutationContext & {
  actor: HandoverSupervisorActor; status: "cancelled" | "superseded";
}): HandoverAggregate {
  const aggregate = mutation(value, input);
  supervisor(input.actor);
  if (input.status !== "cancelled" && input.status !== "superseded") fail("Invalid terminal lifecycle.");
  return assertHandoverAggregate({ ...aggregate, lifecycleStatus: input.status, updatedAt: input.recordedAt });
}


// Replacement explicitly retires the old aggregate and starts fresh evidence at
// the next revision. It never silently edits the reserved successor in place.
export function replaceHandoverReservation(value: HandoverAggregate, input: MutationContext & {
  actor: HandoverSupervisorActor; identity: HandoverIdentity;
  workSnapshot: HandoverWorkSnapshot; temporaryAuthorization: HandoverTemporaryAuthorization | null;
}): { superseded: HandoverAggregate; replacement: HandoverAggregate } {
  const aggregate = mutation(value, input);
  supervisor(input.actor);
  const identity = createHandoverIdentity(input.identity);
  if (identity.successorSlotToken === aggregate.identity.successorSlotToken ||
      aggregate.retiredSuccessorSlotTokens.includes(identity.successorSlotToken)) {
    fail("Replacement reservation requires a fresh successor token.");
  }
  if (identity.outgoingShiftId !== aggregate.identity.outgoingShiftId ||
      identity.outgoingSlotToken !== aggregate.identity.outgoingSlotToken ||
      identity.outgoingGeneration !== aggregate.identity.outgoingGeneration) {
    fail("Replacement must retain the current outgoing operational lineage.");
  }
  const revision = aggregate.revision + 1;
  positive(revision, "revision");
  const created = createHandover({
    identity, workSnapshot: input.workSnapshot, temporaryAuthorization: input.temporaryAuthorization,
    reservedAt: input.recordedAt, reservedBy: input.actor.uid,
  });
  const replacement = assertHandoverAggregate({
    ...created, revision, reservation: { ...created.reservation, revision },
    retiredSuccessorSlotTokens: [...aggregate.retiredSuccessorSlotTokens, aggregate.identity.successorSlotToken],
  });
  const superseded = assertHandoverAggregate({
    ...aggregate, lifecycleStatus: "superseded", updatedAt: input.recordedAt,
  });
  return { superseded, replacement };
}
