import { createHash } from "node:crypto";
import type {
  AcquireGuardInput,
  CancelGuardInput,
  CompleteGuardInput,
  HandoverProtocolOwner,
  HandoverReservationGuard,
  ReacquireGuardInput,
  ReplaceGuardInput,
} from "@/types/handover-reservation-guard";
import type { HandoverAggregate } from "@/types/handover";

export const HANDOVER_RESERVATION_GUARD_SCHEMA = "handover-reservation-guard-v1" as const;

export const HANDOVER_PROTOCOL_OWNERS = {
  V1: "v1",
  V2: "v2",
} as const;

export const GUARD_LIFECYCLE_STATES = {
  ACTIVE: "active",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
} as const;

export class HandoverReservationGuardError extends Error {
  public readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "HandoverReservationGuardError";
    this.status = status;
  }
}

function fail(message: string, status = 409): never {
  throw new HandoverReservationGuardError(message, status);
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Malformed reservation guard state.");
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(result, key))
  ) {
    fail("Malformed reservation guard state: missing or unsupported fields.");
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


export function createHandoverReservationGuardDocumentId(outgoingShiftId: string): string {
  identifier(outgoingShiftId, "outgoing shift ID");
  if (!/^[a-zA-Z0-9_-]+$/.test(outgoingShiftId) || outgoingShiftId.length > 128) {
    const hash = createHash("sha256").update(outgoingShiftId).digest("hex").slice(0, 32);
    return `guard_${hash}`;
  }
  return `guard_${outgoingShiftId}`;
}

const guardFields = [
  "id",
  "schema",
  "outgoingShiftId",
  "protocolOwner",
  "ownerHandoverDocumentId",
  "ownerLifecycleState",
  "guardRevision",
  "fencingEpoch",
  "outgoingSlotToken",
  "outgoingGeneration",
  "successorSlotToken",
  "successorGeneration",
  "reservationId",
  "reservedIncomingShiftId",
  "reservedAt",
  "reservedBy",
  "retiredSuccessorSlotTokens",
  "terminalEvidenceRef",
  "createdAt",
  "updatedAt",
] as const;

export function assertHandoverReservationGuard(value: unknown): HandoverReservationGuard {
  const data = record(value, guardFields);
  if (data.schema !== HANDOVER_RESERVATION_GUARD_SCHEMA) {
    fail("Unsupported reservation guard schema.");
  }
  identifier(data.id, "guard ID");
  identifier(data.outgoingShiftId, "outgoing shift ID");
  const expectedId = createHandoverReservationGuardDocumentId(data.outgoingShiftId as string);
  if (data.id !== expectedId) {
    fail("Guard ID does not match outgoing shift ID.");
  }

  if (
    data.protocolOwner !== HANDOVER_PROTOCOL_OWNERS.V1 &&
    data.protocolOwner !== HANDOVER_PROTOCOL_OWNERS.V2
  ) {
    fail("Invalid protocol owner.");
  }

  identifier(data.ownerHandoverDocumentId, "owner handover document ID");

  if (
    data.ownerLifecycleState !== GUARD_LIFECYCLE_STATES.ACTIVE &&
    data.ownerLifecycleState !== GUARD_LIFECYCLE_STATES.CANCELLED &&
    data.ownerLifecycleState !== GUARD_LIFECYCLE_STATES.COMPLETED
  ) {
    fail("Invalid guard lifecycle state.");
  }

  positive(data.guardRevision, "guard revision");
  positive(data.fencingEpoch, "fencing epoch");

  token(data.outgoingSlotToken);
  token(data.successorSlotToken);
  positive(data.outgoingGeneration, "outgoing generation");
  positive(data.successorGeneration, "successor generation");

  if (data.successorGeneration !== (data.outgoingGeneration as number) + 1) {
    fail("Invalid successor generation in reservation guard.");
  }
  if (
    (data.outgoingSlotToken as string).toLowerCase() ===
    (data.successorSlotToken as string).toLowerCase()
  ) {
    fail("Successor token cannot match outgoing slot token.");
  }

  identifier(data.reservationId, "reservation ID");
  identifier(data.reservedIncomingShiftId, "reserved incoming shift ID");
  timestamp(data.reservedAt);
  identifier(data.reservedBy, "reservedBy UID", 128);

  if (!Array.isArray(data.retiredSuccessorSlotTokens)) {
    fail("Malformed retired successor slot tokens.");
  }
  const retired = new Set<string>();
  for (const retiredToken of data.retiredSuccessorSlotTokens) {
    token(retiredToken);
    const normalized = retiredToken.toLowerCase();
    if (
      retired.has(normalized) ||
      normalized === (data.outgoingSlotToken as string).toLowerCase() ||
      normalized === (data.successorSlotToken as string).toLowerCase()
    ) {
      fail("Reused or malformed retired successor token in guard.");
    }
    retired.add(normalized);
  }

  if (data.terminalEvidenceRef !== null && data.terminalEvidenceRef !== undefined) {
    identifier(data.terminalEvidenceRef, "terminal evidence reference");
  }

  timestamp(data.createdAt);
  timestamp(data.updatedAt);
  if (Date.parse(data.updatedAt as string) < Date.parse(data.createdAt as string)) {
    fail("Contradictory reservation guard timestamps.");
  }

  return structuredClone({
    id: data.id as string,
    schema: HANDOVER_RESERVATION_GUARD_SCHEMA,
    outgoingShiftId: data.outgoingShiftId as string,
    protocolOwner: data.protocolOwner as HandoverProtocolOwner,
    ownerHandoverDocumentId: data.ownerHandoverDocumentId as string,
    ownerLifecycleState: data.ownerLifecycleState as HandoverReservationGuard["ownerLifecycleState"],
    guardRevision: data.guardRevision as number,
    fencingEpoch: data.fencingEpoch as number,
    outgoingSlotToken: (data.outgoingSlotToken as string).toLowerCase(),
    outgoingGeneration: data.outgoingGeneration as number,
    successorSlotToken: (data.successorSlotToken as string).toLowerCase(),
    successorGeneration: data.successorGeneration as number,
    reservationId: data.reservationId as string,
    reservedIncomingShiftId: data.reservedIncomingShiftId as string,
    reservedAt: data.reservedAt as string,
    reservedBy: data.reservedBy as string,
    retiredSuccessorSlotTokens: [...retired],
    terminalEvidenceRef: (data.terminalEvidenceRef as string) ?? null,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  });
}

export function createInitialReservationGuard(input: AcquireGuardInput): HandoverReservationGuard {
  identifier(input.outgoingShiftId, "outgoing shift ID");
  if (
    input.protocolOwner !== HANDOVER_PROTOCOL_OWNERS.V1 &&
    input.protocolOwner !== HANDOVER_PROTOCOL_OWNERS.V2
  ) {
    fail("Invalid protocol owner.");
  }
  identifier(input.ownerHandoverDocumentId, "owner handover document ID");
  token(input.outgoingSlotToken);
  token(input.successorSlotToken);
  positive(input.outgoingGeneration, "outgoing generation");
  positive(input.successorGeneration, "successor generation");

  if (input.successorGeneration !== input.outgoingGeneration + 1) {
    fail("Successor generation must be outgoing generation + 1.");
  }
  if (input.successorSlotToken.toLowerCase() === input.outgoingSlotToken.toLowerCase()) {
    fail("Successor slot token cannot equal outgoing slot token.");
  }

  identifier(input.reservationId, "reservation ID");
  identifier(input.reservedIncomingShiftId, "reserved incoming shift ID");
  timestamp(input.reservedAt);
  identifier(input.reservedBy, "reservedBy UID", 128);

  const documentId = createHandoverReservationGuardDocumentId(input.outgoingShiftId);

  return assertHandoverReservationGuard({
    id: documentId,
    schema: HANDOVER_RESERVATION_GUARD_SCHEMA,
    outgoingShiftId: input.outgoingShiftId,
    protocolOwner: input.protocolOwner,
    ownerHandoverDocumentId: input.ownerHandoverDocumentId,
    ownerLifecycleState: GUARD_LIFECYCLE_STATES.ACTIVE,
    guardRevision: 1,
    fencingEpoch: 1,
    outgoingSlotToken: input.outgoingSlotToken.toLowerCase(),
    outgoingGeneration: input.outgoingGeneration,
    successorSlotToken: input.successorSlotToken.toLowerCase(),
    successorGeneration: input.successorGeneration,
    reservationId: input.reservationId,
    reservedIncomingShiftId: input.reservedIncomingShiftId,
    reservedAt: input.reservedAt,
    reservedBy: input.reservedBy,
    retiredSuccessorSlotTokens: [],
    terminalEvidenceRef: null,
    createdAt: input.reservedAt,
    updatedAt: input.reservedAt,
  });
}

export function assertSameOwnerRetry(
  existing: HandoverReservationGuard,
  input: AcquireGuardInput,
): HandoverReservationGuard {
  const guard = assertHandoverReservationGuard(existing);

  if (guard.ownerLifecycleState !== GUARD_LIFECYCLE_STATES.ACTIVE) {
    fail("The reservation guard is in a terminal state (" + guard.ownerLifecycleState + ").");
  }

  if (guard.protocolOwner !== input.protocolOwner) {
    fail(
      `The outgoing shift reservation is owned by protocol ${guard.protocolOwner}. Acquisition by protocol ${input.protocolOwner} is rejected.`,
      409,
    );
  }

  if (
    guard.outgoingShiftId !== input.outgoingShiftId ||
    guard.ownerHandoverDocumentId !== input.ownerHandoverDocumentId ||
    guard.outgoingSlotToken !== input.outgoingSlotToken.toLowerCase() ||
    guard.outgoingGeneration !== input.outgoingGeneration ||
    guard.successorSlotToken !== input.successorSlotToken.toLowerCase() ||
    guard.successorGeneration !== input.successorGeneration ||
    guard.reservationId !== input.reservationId ||
    guard.reservedIncomingShiftId !== input.reservedIncomingShiftId
  ) {
    fail("A conflicting active reservation guard already exists for this outgoing shift.");
  }

  return structuredClone(guard);
}

export function transitionGuardForReplacement(
  existing: HandoverReservationGuard,
  input: ReplaceGuardInput,
): HandoverReservationGuard {
  const guard = assertHandoverReservationGuard(existing);

  if (guard.ownerLifecycleState !== GUARD_LIFECYCLE_STATES.ACTIVE) {
    fail("Cannot replace a non-active reservation guard (state: " + guard.ownerLifecycleState + ").");
  }

  if (guard.protocolOwner !== input.protocolOwner) {
    fail(
      `Cannot replace reservation guard owned by protocol ${guard.protocolOwner} with protocol ${input.protocolOwner}.`,
      409,
    );
  }

  if (input.expectedGuardRevision !== guard.guardRevision) {
    fail(`Stale guard revision: expected ${input.expectedGuardRevision}, found ${guard.guardRevision}.`);
  }
  if (input.expectedFencingEpoch !== guard.fencingEpoch) {
    fail(`Stale guard fencing epoch: expected ${input.expectedFencingEpoch}, found ${guard.fencingEpoch}.`);
  }

  if (
    input.outgoingShiftId !== guard.outgoingShiftId ||
    input.outgoingSlotToken.toLowerCase() !== guard.outgoingSlotToken ||
    input.outgoingGeneration !== guard.outgoingGeneration
  ) {
    fail("Replacement must retain the current outgoing operational lineage.");
  }

  if (input.successorGeneration !== guard.outgoingGeneration + 1) {
    fail("Invalid replacement successor generation.");
  }

  const nextSuccessor = input.successorSlotToken.toLowerCase();
  token(nextSuccessor);
  if (
    nextSuccessor === guard.successorSlotToken ||
    nextSuccessor === guard.outgoingSlotToken ||
    guard.retiredSuccessorSlotTokens.includes(nextSuccessor)
  ) {
    fail("Replacement requires a fresh, unretired successor token.");
  }

  identifier(input.reservationId, "replacement reservation ID");
  identifier(input.reservedIncomingShiftId, "replacement reserved incoming shift ID");
  timestamp(input.recordedAt);
  identifier(input.actorUid, "actor UID", 128);

  const nextRevision = guard.guardRevision + 1;
  const nextEpoch = guard.fencingEpoch + 1;
  const retiredSuccessorSlotTokens = [...guard.retiredSuccessorSlotTokens, guard.successorSlotToken];

  return assertHandoverReservationGuard({
    ...guard,
    guardRevision: nextRevision,
    fencingEpoch: nextEpoch,
    successorSlotToken: nextSuccessor,
    successorGeneration: input.successorGeneration,
    reservationId: input.reservationId,
    reservedIncomingShiftId: input.reservedIncomingShiftId,
    reservedAt: input.recordedAt,
    reservedBy: input.actorUid,
    retiredSuccessorSlotTokens,
    updatedAt: input.recordedAt,
  });
}

export function transitionGuardForCancellation(
  existing: HandoverReservationGuard,
  input: CancelGuardInput,
): HandoverReservationGuard {
  const guard = assertHandoverReservationGuard(existing);

  if (guard.ownerLifecycleState !== GUARD_LIFECYCLE_STATES.ACTIVE) {
    fail("Cannot cancel a non-active reservation guard (state: " + guard.ownerLifecycleState + ").");
  }

  if (guard.protocolOwner !== input.protocolOwner) {
    fail(
      `Cannot cancel reservation guard owned by protocol ${guard.protocolOwner} with protocol ${input.protocolOwner}.`,
      409,
    );
  }

  if (input.expectedGuardRevision !== guard.guardRevision) {
    fail(`Stale guard revision: expected ${input.expectedGuardRevision}, found ${guard.guardRevision}.`);
  }
  if (input.expectedFencingEpoch !== guard.fencingEpoch) {
    fail(`Stale guard fencing epoch: expected ${input.expectedFencingEpoch}, found ${guard.fencingEpoch}.`);
  }

  timestamp(input.recordedAt);
  identifier(input.actorUid, "actor UID", 128);
  if (input.terminalEvidenceRef) {
    identifier(input.terminalEvidenceRef, "terminal evidence reference");
  }

  return assertHandoverReservationGuard({
    ...guard,
    ownerLifecycleState: GUARD_LIFECYCLE_STATES.CANCELLED,
    guardRevision: guard.guardRevision + 1,
    terminalEvidenceRef: input.terminalEvidenceRef ?? null,
    updatedAt: input.recordedAt,
  });
}

export function transitionGuardForCompletion(
  existing: HandoverReservationGuard,
  input: CompleteGuardInput,
): HandoverReservationGuard {
  const guard = assertHandoverReservationGuard(existing);

  // Idempotent replay
  if (guard.ownerLifecycleState === GUARD_LIFECYCLE_STATES.COMPLETED) {
    if (guard.terminalEvidenceRef === input.receiptId) {
      return structuredClone(guard);
    }
    fail("Handover reservation guard is already completed with a different receipt.");
  }

  if (guard.ownerLifecycleState !== GUARD_LIFECYCLE_STATES.ACTIVE) {
    fail("Cannot complete a non-active reservation guard (state: " + guard.ownerLifecycleState + ").");
  }

  if (guard.protocolOwner !== input.protocolOwner) {
    fail(
      `Cannot complete reservation guard owned by protocol ${guard.protocolOwner} with protocol ${input.protocolOwner}.`,
      409,
    );
  }

  if (input.expectedGuardRevision !== undefined && input.expectedGuardRevision !== guard.guardRevision) {
    fail(`Stale guard revision: expected ${input.expectedGuardRevision}, found ${guard.guardRevision}.`);
  }
  if (input.expectedFencingEpoch !== undefined && input.expectedFencingEpoch !== guard.fencingEpoch) {
    fail(`Stale guard fencing epoch: expected ${input.expectedFencingEpoch}, found ${guard.fencingEpoch}.`);
  }

  if (
    input.outgoingShiftId !== guard.outgoingShiftId ||
    input.outgoingSlotToken.toLowerCase() !== guard.outgoingSlotToken ||
    input.outgoingGeneration !== guard.outgoingGeneration ||
    input.successorSlotToken.toLowerCase() !== guard.successorSlotToken ||
    input.successorGeneration !== guard.successorGeneration
  ) {
    fail("Transfer completion lineage does not match active reservation guard.");
  }

  identifier(input.receiptId, "transfer receipt ID");
  timestamp(input.recordedAt);
  identifier(input.actorUid, "actor UID", 128);

  return assertHandoverReservationGuard({
    ...guard,
    ownerLifecycleState: GUARD_LIFECYCLE_STATES.COMPLETED,
    guardRevision: guard.guardRevision + 1,
    terminalEvidenceRef: input.receiptId,
    updatedAt: input.recordedAt,
  });
}

export function adoptGuardlessLegacyReservation(
  legacy: HandoverAggregate,
  receiptId?: string | null,
): HandoverReservationGuard {
  const documentId = createHandoverReservationGuardDocumentId(legacy.identity.outgoingShiftId);
  const isCompleted = legacy.lifecycleStatus === "completed";
  const isCancelled = legacy.lifecycleStatus === "cancelled";

  let lifecycleState: HandoverReservationGuard["ownerLifecycleState"] = GUARD_LIFECYCLE_STATES.ACTIVE;
  if (isCompleted) {
    lifecycleState = GUARD_LIFECYCLE_STATES.COMPLETED;
    if (!receiptId) {
      fail("Completed legacy handover adoption requires transfer receipt ID.");
    }
  } else if (isCancelled) {
    lifecycleState = GUARD_LIFECYCLE_STATES.CANCELLED;
  }

  return assertHandoverReservationGuard({
    id: documentId,
    schema: HANDOVER_RESERVATION_GUARD_SCHEMA,
    outgoingShiftId: legacy.identity.outgoingShiftId,
    protocolOwner: HANDOVER_PROTOCOL_OWNERS.V1,
    ownerHandoverDocumentId: `handover_${legacy.identity.outgoingShiftId}`,
    ownerLifecycleState: lifecycleState,
    guardRevision: 1,
    fencingEpoch: 1,
    outgoingSlotToken: legacy.identity.outgoingSlotToken.toLowerCase(),
    outgoingGeneration: legacy.identity.outgoingGeneration,
    successorSlotToken: legacy.identity.successorSlotToken.toLowerCase(),
    successorGeneration: legacy.identity.successorGeneration,
    reservationId: legacy.reservation.handoverId,
    reservedIncomingShiftId: legacy.reservation.reservedIncomingShiftId,
    reservedAt: legacy.reservation.reservedAt,
    reservedBy: legacy.reservation.reservedBy,
    retiredSuccessorSlotTokens: [...legacy.retiredSuccessorSlotTokens],
    terminalEvidenceRef: receiptId ?? null,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// Cancelled-v1 → v2 re-reservation transition (TECH-HO-RECOVERY-04 §7).
//
// A cancelled v1 reservation is terminal for v1 forever. The only permitted
// forward move is a narrowly scoped, fully audited hand-off: the exact
// cancelled guard state is copied verbatim into the immutable history
// collection, and the live guard document is replaced — inside the same
// transaction — by a fresh v2-owned successor that advances the fencing
// epoch and carries a deterministic pointer to the archived evidence. Any
// stale v1 writer still holding the predecessor revision is rejected.
// Completed guards never transition, in either direction.
// ---------------------------------------------------------------------------

export function createReservationGuardArchiveDocumentId(guard: HandoverReservationGuard): string {
  const valid = assertHandoverReservationGuard(guard);
  return `guard_archive_${valid.fencingEpoch}_${digest(canonical(valid))}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
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

export interface CancelledGuardArchive {
  archived: HandoverReservationGuard;
  archiveDocumentId: string;
  archivedAt: string;
}

export function archiveCancelledReservationGuard(
  existing: HandoverReservationGuard,
  archivedAt: string,
): CancelledGuardArchive {
  const guard = assertHandoverReservationGuard(existing);
  if (guard.ownerLifecycleState !== GUARD_LIFECYCLE_STATES.CANCELLED) {
    fail("Only a cancelled reservation guard can be archived for re-reservation.");
  }
  timestamp(archivedAt);
  if (Date.parse(archivedAt) < Date.parse(guard.updatedAt)) {
    fail("The reservation guard archival timestamp is stale.");
  }
  const archived = structuredClone(guard);
  return { archived, archiveDocumentId: createReservationGuardArchiveDocumentId(archived), archivedAt };
}

export function transitionCancelledGuardForEqualReacquisition(
  archive: CancelledGuardArchive,
  input: ReacquireGuardInput,
): HandoverReservationGuard {
  const guard = assertHandoverReservationGuard(archive.archived);
  if (
    guard.protocolOwner !== HANDOVER_PROTOCOL_OWNERS.V1 &&
    guard.protocolOwner !== HANDOVER_PROTOCOL_OWNERS.V2
  ) {
    fail("Only a cancelled v1 or v2 reservation guard can transition to a v2 successor.");
  }
  if (input.protocolOwner !== HANDOVER_PROTOCOL_OWNERS.V2) {
    fail("Only protocol v2 may reacquire an archived reservation guard.");
  }
  const expectedRevision = guard.protocolOwner === HANDOVER_PROTOCOL_OWNERS.V1
    ? guard.guardRevision + 1
    : guard.guardRevision;
  if (
    input.expectedGuardRevision !== expectedRevision ||
    input.expectedFencingEpoch !== guard.fencingEpoch
  ) {
    fail("Stale guard revision or fencing epoch for reservation reacquisition.");
  }
  if (
    input.outgoingShiftId !== guard.outgoingShiftId ||
    input.outgoingSlotToken.toLowerCase() !== guard.outgoingSlotToken ||
    input.outgoingGeneration !== guard.outgoingGeneration
  ) {
    fail("Re-reservation must retain the current outgoing operational lineage.");
  }
  if (input.successorGeneration !== guard.outgoingGeneration + 1) {
    fail("Invalid re-reservation successor generation.");
  }
  const nextSuccessor = input.successorSlotToken.toLowerCase();
  token(nextSuccessor);
  if (
    nextSuccessor === guard.successorSlotToken ||
    nextSuccessor === guard.outgoingSlotToken ||
    guard.retiredSuccessorSlotTokens.includes(nextSuccessor)
  ) {
    fail("Re-reservation requires a fresh, unretired successor token.");
  }
  identifier(input.reservationId, "re-reservation ID");
  identifier(input.reservedIncomingShiftId, "re-reserved incoming shift ID");
  timestamp(input.reservedAt);
  if (input.reservedAt !== archive.archivedAt) {
    fail("The re-reservation timestamp must match the archived reservation evidence.");
  }
  identifier(input.reservedBy, "reservedBy UID", 128);

  return assertHandoverReservationGuard({
    ...guard,
    protocolOwner: HANDOVER_PROTOCOL_OWNERS.V2,
    ownerHandoverDocumentId: input.ownerHandoverDocumentId,
    ownerLifecycleState: GUARD_LIFECYCLE_STATES.ACTIVE,
    guardRevision: guard.guardRevision + 2,
    fencingEpoch: guard.fencingEpoch + 1,
    successorSlotToken: nextSuccessor,
    successorGeneration: input.successorGeneration,
    reservationId: input.reservationId,
    reservedIncomingShiftId: input.reservedIncomingShiftId,
    reservedAt: input.reservedAt,
    reservedBy: input.reservedBy,
    retiredSuccessorSlotTokens: [...guard.retiredSuccessorSlotTokens, guard.successorSlotToken],
    terminalEvidenceRef: archive.archiveDocumentId,
    createdAt: input.reservedAt,
    updatedAt: input.reservedAt,
  });
}
