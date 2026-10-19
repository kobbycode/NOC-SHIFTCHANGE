import "server-only";

import { createHash } from "node:crypto";
import { FieldValue, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import type {
  EqualHandoverAggregate,
  EqualHandoverIdentity,
} from "@/types/equal-technician-handover";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import type {
  TechnicianSchedule,
  TechnicianScheduleEntry,
} from "@/types/technician-schedule";
import { GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID, getOperationalCollections } from "./collections";
import { AssignmentOperationError, markAssignmentActivity, requireEligibleTechnician } from "./assignment-transaction";
import { assertHandoverAggregate } from "./handover-domain";
import { assertOperationalShiftControl, assertShiftOwnsOperationalSlot } from "./operational-shift-control-state";
import { readActivePermanentPairTechnicianIds } from "./next-shift-authorization-domain";
import { parseShiftTimeRange } from "./shift-overlap";
import { prepareTechnicianSchedule } from "./prepare-technician-schedule";
import {
  assertHandoverReservationGuard,
  createHandoverReservationGuardDocumentId,
} from "./handover-reservation-guard-domain";
import {
  cancelReservationGuard,
  readReservationGuardState,
  replaceReservationGuard,
  resolveOrAcquireReservationGuard,
  type ReservationGuardTransactionState,
} from "./handover-reservation-guard";
import {
  closeEqualHandover,
  createEqualHandover,
  createEqualHandoverDocumentId,
  createEqualHandoverId,
  createEqualHandoverIdentity,
  createEqualHandoverSnapshot,
  replaceEqualHandoverReservation,
  assertEqualHandoverAggregate,
  EqualHandoverDomainError,
} from "./equal-technician-handover-domain";

export { EqualHandoverDomainError };

// ---------------------------------------------------------------------------
// AUTHORIZATION BOUNDARY — read before wiring any caller.
//
// Server-only production writer for equal-technician v2 handover
// reservations. The actor is authorized strictly against the authoritative
// Firestore profile inside each transaction: only an active technician who
// belongs to the outgoing shift's active permanent pair (and its current
// primary roster) may initialize, replace, or cancel a v2 reservation, and
// either outgoing technician may act — there is no primary/secondary
// authority distinction. Routes must pass the UID decoded from the verified
// session cookie; a request-body actor UID is never consulted. Nothing here
// creates or activates the incoming Shift, freezes reports, records
// confirmations, completes transfers, or writes attendance evidence.
// ---------------------------------------------------------------------------

export interface EqualReservationSelection {
  incomingPermanentPairId: string;
  shiftType: "morning" | "night";
  scheduledStart: string;
  scheduledEnd: string;
}
export interface EqualReservationBinding {
  expectedRevision: number;
  expectedSnapshotHash: string;
}
export interface EqualReservationActor {
  outgoingShiftId: string;
  actorUid: string;
}
export interface EqualHandoverReservationResult {
  handoverDocumentId: string;
  aggregate: EqualHandoverAggregate;
  snapshotHash: string;
  guard: HandoverReservationGuard;
  replayed: boolean;
}

function fail(message: string, status = 409): never {
  throw new AssignmentOperationError(message, status);
}

function identifier(value: unknown, max = 512): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > max ||
      value.includes("/") || value === "." || value === "..") fail("Invalid reservation identifier.", 400);
}

function exactBody(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid reservation request.", 400);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(data, key))) {
    fail("Missing or unsupported reservation fields.", 400);
  }
  return data;
}

function parseSelection(data: Record<string, unknown>): EqualReservationSelection {
  identifier(data.incomingPermanentPairId);
  if (data.shiftType !== "morning" && data.shiftType !== "night") fail("Invalid shift type.", 400);
  for (const value of [data.scheduledStart, data.scheduledEnd]) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
      fail("Provide canonical UTC reservation times.", 400);
    }
  }
  const start = data.scheduledStart as string;
  const end = data.scheduledEnd as string;
  if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 24 * 60 * 60 * 1000) {
    fail("Invalid reservation time range (maximum 24 hours).", 400);
  }
  return { incomingPermanentPairId: data.incomingPermanentPairId, shiftType: data.shiftType,
    scheduledStart: start, scheduledEnd: end };
}

function parseBinding(data: Record<string, unknown>): EqualReservationBinding {
  if (!Number.isSafeInteger(data.expectedRevision) || (data.expectedRevision as number) < 1 ||
      typeof data.expectedSnapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(data.expectedSnapshotHash)) {
    fail("Invalid reservation revision or snapshot hash.", 400);
  }
  return { expectedRevision: data.expectedRevision as number, expectedSnapshotHash: data.expectedSnapshotHash };
}

function parseReason(data: Record<string, unknown>): string {
  if (typeof data.reason !== "string" || !data.reason.trim() || data.reason.length > 2000) {
    fail("A non-empty cancellation reason is required.", 400);
  }
  return data.reason.trim();
}

// A caller-supplied idempotency key pins one intended reservation to one
// deterministic proposal: an identical retry resolves to the identical
// reservation fingerprint, incoming shift identity and successor token.
// A new key after a cancellation expresses a genuinely new reservation.
function parseIdempotencyKey(data: Record<string, unknown>): string {
  const value = data.idempotencyKey;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    fail("Invalid reservation idempotency key.", 400);
  }
  return value;
}

const selectionFields = ["incomingPermanentPairId", "shiftType", "scheduledStart", "scheduledEnd"];
const bindingFields = ["expectedRevision", "expectedSnapshotHash"];

export function parseEqualHandoverRequest(
  value: unknown, operation: "initialize",
): EqualReservationSelection & { idempotencyKey: string };
export function parseEqualHandoverRequest(
  value: unknown, operation: "replace",
): EqualReservationSelection & EqualReservationBinding;
export function parseEqualHandoverRequest(
  value: unknown, operation: "cancel",
): EqualReservationBinding & { reason: string };
export function parseEqualHandoverRequest(value: unknown, operation: "initialize" | "replace" | "cancel") {
  if (operation === "initialize") {
    const data = exactBody(value, [...selectionFields, "idempotencyKey"]);
    return { ...parseSelection(data), idempotencyKey: parseIdempotencyKey(data) };
  }
  if (operation === "replace") {
    const data = exactBody(value, [...selectionFields, ...bindingFields]);
    return { ...parseSelection(data), ...parseBinding(data) };
  }
  const data = exactBody(value, [...bindingFields, "reason"]);
  return { ...parseBinding(data), reason: parseReason(data) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deriveToken(material: string): string {
  const bytes = Buffer.from(createHash("sha256").update(material).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface ProposalContext {
  outgoingShiftId: string;
  permanentPairId: string;
  outgoingTechnicianIds: readonly string[];
  slotToken: string;
  generation: number;
}

interface Proposal {
  identity: EqualHandoverIdentity;
  incomingShiftId: string;
  reservationId: string;
}

function buildProposal(
  context: ProposalContext,
  selected: EqualReservationSelection,
  incomingIds: readonly string[],
  kind: "initial" | "replace",
  bindingMaterial: string,
): Proposal {
  const material = canonical({
    namespace: `equal-handover-v2-${kind}`,
    binding: bindingMaterial,
    outgoingShiftId: context.outgoingShiftId,
    outgoingPermanentPairId: context.permanentPairId,
    outgoingTechnicianIds: [...context.outgoingTechnicianIds],
    outgoingSlotToken: context.slotToken.toLowerCase(),
    outgoingGeneration: context.generation,
    incomingPermanentPairId: selected.incomingPermanentPairId,
    incomingTechnicianIds: [...incomingIds],
    shiftType: selected.shiftType,
    scheduledStart: selected.scheduledStart,
    scheduledEnd: selected.scheduledEnd,
  });
  const digest = createHash("sha256").update(material).digest("hex");
  const identity = createEqualHandoverIdentity({
    schema: "equal-handover-v2",
    outgoingShiftId: context.outgoingShiftId,
    outgoingPermanentPairId: context.permanentPairId,
    outgoingTechnicianIds: [context.outgoingTechnicianIds[0]!, context.outgoingTechnicianIds[1]!],
    outgoingSlotToken: context.slotToken,
    outgoingGeneration: context.generation,
    incomingShiftId: `shift_v2c_${digest.slice(0, 40)}`,
    incomingPermanentPairId: selected.incomingPermanentPairId,
    incomingTechnicianIds: [incomingIds[0]!, incomingIds[1]!],
    successorSlotToken: deriveToken(`token|${digest}`),
    successorGeneration: context.generation + 1,
    shiftType: selected.shiftType,
    scheduledStart: selected.scheduledStart,
    scheduledEnd: selected.scheduledEnd,
  });
  return { identity, incomingShiftId: identity.incomingShiftId, reservationId: createEqualHandoverId(identity) };
}

async function readPair(transaction: Transaction, pairId: string): Promise<[string, string]> {
  identifier(pairId);
  const { technicianPairs, technicianPairMemberships } = getOperationalCollections();
  const pair = await transaction.get(technicianPairs.doc(pairId));
  if (!pair.exists) fail("The permanent pair was not found.", 404);
  const ids = readActivePermanentPairTechnicianIds(pair.data(), pairId);
  for (const uid of ids) {
    const member = await transaction.get(technicianPairMemberships.doc(uid));
    if (!member.exists || member.data()?.technicianUid !== uid || member.data()?.pairId !== pairId) {
      fail("Permanent pair membership is inconsistent.");
    }
  }
  return ids;
}

function scheduleEntries(data: unknown, uid: string): TechnicianScheduleEntry[] {
  const schedule = data as TechnicianSchedule | undefined;
  if (!schedule || schedule.technicianUid !== uid || !Array.isArray(schedule.entries)) fail("Invalid reservation schedule.");
  const ids = new Set<string>();
  for (const entry of schedule.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("Invalid schedule entry.");
    identifier(entry.shiftId);
    if (ids.has(entry.shiftId) || !["scheduled", "active", "handover_pending"].includes(entry.status) ||
        typeof entry.scheduledStart !== "string" || typeof entry.scheduledEnd !== "string") fail("Invalid schedule entry.");
    parseShiftTimeRange(entry.scheduledStart, entry.scheduledEnd);
    ids.add(entry.shiftId);
  }
  return schedule.entries;
}

export function readEqualHandoverAggregate(value: unknown, outgoingShiftId: string): EqualHandoverAggregate {
  identifier(outgoingShiftId);
  const aggregate = assertEqualHandoverAggregate(value);
  if (aggregate.identity.outgoingShiftId !== outgoingShiftId) {
    fail("Equal handover aggregate identity does not match the requested shift.");
  }
  return aggregate;
}

function requireGuardSnapshot(state: ReservationGuardTransactionState, documentId: string): HandoverReservationGuard {
  if (!state.guardSnapshot.exists) {
    fail("The reservation guard evidence for this v2 reservation is missing; administrator review required.");
  }
  const guard = assertHandoverReservationGuard(state.guardSnapshot.data());
  if (guard.protocolOwner !== "v2" || guard.ownerHandoverDocumentId !== documentId) {
    fail(`The outgoing shift reservation is owned by protocol ${guard.protocolOwner}.`, 409);
  }
  return guard;
}

type Operation = "initialize" | "replace" | "cancel";

async function persist(
  operation: Operation,
  input: EqualReservationActor,
  selected?: EqualReservationSelection & { idempotencyKey?: string },
  expected?: EqualReservationBinding,
  reason?: string,
): Promise<EqualHandoverReservationResult> {
  identifier(input.actorUid, 128);
  identifier(input.outgoingShiftId);
  if (operation !== "initialize" && !expected) fail("Reservation binding evidence is required.", 400);

  const { db, shifts, shiftMembers, operationalShiftControl, technicianSchedules, equalHandoversV2 } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  const aggregateRef = equalHandoversV2.doc(documentId);
  const actorRef = db.collection("users").doc(input.actorUid);

  return db.runTransaction(async (transaction) => {
    // Steps 1-3: every Firestore read for this operation happens before the
    // first buffered write, which is taken only after full validation.
    const [actorSnapshot, shiftSnapshot, controlSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      transaction.get(actorRef), transaction.get(shifts.doc(input.outgoingShiftId)),
      transaction.get(operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID)),
      transaction.get(aggregateRef), readReservationGuardState(transaction, input.outgoingShiftId),
    ]);

    // Step 4: validate every precondition.
    const actor = actorSnapshot.data();
    if (!actor || actor.status !== "active" || actor.statusOperation != null ||
        actor.mustChangePassword === true || actor.role !== "technician") {
      fail("Your account is not authorized to manage equal handover reservations.", 403);
    }

    const shift = shiftSnapshot.data();
    if (!shift) fail("The outgoing shift was not found.", 404);
    if (shift.id !== input.outgoingShiftId || shift.status !== "handover_pending" || shift.actualEnd !== null ||
        typeof shift.actualStart !== "string" || !Number.isFinite(Date.parse(shift.actualStart)) ||
        typeof shift.scheduledStart !== "string" || typeof shift.scheduledEnd !== "string") {
      fail("The outgoing shift has not started a valid handover. Begin the handover before reserving.");
    }
    parseShiftTimeRange(shift.scheduledStart, shift.scheduledEnd);
    let control;
    try {
      control = assertOperationalShiftControl(controlSnapshot.data());
      assertShiftOwnsOperationalSlot(control, input.outgoingShiftId, shift.operationalSlotToken, "handover_pending");
    } catch { fail("The outgoing shift does not own valid operational control."); }

    identifier(shift.permanentPairId);
    const outgoingIds = await readPair(transaction, shift.permanentPairId);
    if (!Array.isArray(shift.primaryTechnicianIds) || shift.primaryTechnicianIds.length !== 2 ||
        !outgoingIds.every((uid) => shift.primaryTechnicianIds.includes(uid))) {
      fail("Outgoing permanent identities are inconsistent.");
    }
    if (!outgoingIds.includes(input.actorUid)) {
      fail("Only an outgoing permanent-pair technician may act on this handover.", 403);
    }
    const members = await transaction.get(shiftMembers.where("shiftId", "==", input.outgoingShiftId));
    const current = new Set<string>();
    const primary: string[] = [];
    for (const document of members.docs) {
      const member = document.data();
      identifier(member.technicianId, 128);
      if (member.id !== document.id || member.shiftId !== input.outgoingShiftId ||
          !["primary", "additional"].includes(member.role) ||
          (member.leftAt !== null && (typeof member.leftAt !== "string" || !Number.isFinite(Date.parse(member.leftAt))))) {
        fail("Invalid outgoing membership.");
      }
      if (member.leftAt === null) {
        if (current.has(member.technicianId)) fail("Duplicate outgoing membership.");
        current.add(member.technicianId);
        if (member.role === "primary") primary.push(member.technicianId);
      }
    }
    if (primary.length !== 2 || !outgoingIds.every((uid) => primary.includes(uid))) {
      fail("Outgoing primary memberships are inconsistent.");
    }

    // Legacy v1 evidence gates (§7): cancelled v1 without guard evidence or
    // any live/completed legacy aggregate blocks v2 until administrator review.
    let legacyAggregate = null;
    if (guardState.legacySnapshot.exists) {
      legacyAggregate = assertHandoverAggregate(guardState.legacySnapshot.data());
      if (!guardState.guardSnapshot.exists || legacyAggregate.lifecycleStatus !== "cancelled") {
        fail("A legacy v1 handover reservation exists for this outgoing shift; administrator review required.");
      }
    }

    const stored = aggregateSnapshot.exists
      ? readEqualHandoverAggregate(aggregateSnapshot.data(), input.outgoingShiftId)
      : null;
    const currentGuard = operation === "initialize" ? null
      : requireGuardSnapshot(guardState, documentId);
    if (operation === "initialize") {
      // A live revision-1 reservation remains eligible for idempotent replay
      // (validated in Step 5); anything else is an existing owner. A cancelled
      // reservation may be superseded by a fresh one through the guarded
      // successor transition, with its evidence preserved in the audit trail.
      if (stored && (stored.revision !== 1 || (stored.lifecycleStatus !== "collecting_confirmations" &&
          stored.lifecycleStatus !== "cancelled"))) {
        fail("An equal handover reservation already exists for this shift.");
      }
    } else {
      if (!stored) fail("The equal handover reservation was not found.", 404);
      if (stored.lifecycleStatus !== "collecting_confirmations" ||
          stored.revision !== expected!.expectedRevision ||
          createEqualHandoverSnapshot(stored).snapshotHash !== expected!.expectedSnapshotHash) {
        fail("Stale or closed equal handover reservation.");
      }
      if (currentGuard!.reservationId !== stored.reservation.handoverId ||
          currentGuard!.reservedIncomingShiftId !== stored.reservation.reservedIncomingShiftId) {
        fail("The reservation guard is no longer bound to the current reservation.");
      }
    }

    const now = new Date().toISOString();

    let incomingIds: readonly string[] = [];
    let proposal: Proposal | null = null;
    if (selected) {
      incomingIds = await readPair(transaction, selected.incomingPermanentPairId);
      if (incomingIds[0] === outgoingIds[0] && incomingIds[1] === outgoingIds[1]) {
        fail("The incoming pair must differ from the outgoing pair.");
      }
      for (const uid of incomingIds) await requireEligibleTechnician(transaction, uid);

      if (operation === "initialize") {
        proposal = buildProposal(
          { outgoingShiftId: input.outgoingShiftId, permanentPairId: shift.permanentPairId,
            outgoingTechnicianIds: outgoingIds, slotToken: control.slotToken, generation: control.generation },
          selected, incomingIds, "initial", selected.idempotencyKey!);
      } else {
        if (stored!.identity.outgoingPermanentPairId !== shift.permanentPairId ||
            stored!.identity.outgoingSlotToken.toLowerCase() !== control.slotToken.toLowerCase() ||
            stored!.identity.outgoingGeneration !== control.generation ||
            !outgoingIds.every((uid, index) => uid === stored!.identity.outgoingTechnicianIds[index])) {
          fail("Outgoing reservation lineage changed.");
        }
        // §9: report freezing is not implemented in this milestone. A
        // replacement must never silently carry or rebind frozen-report or
        // confirmation evidence, so any such evidence fails closed.
        if (stored!.reportBinding !== null || stored!.confirmations.length > 0) {
          fail("Unexpected report or confirmation evidence on the reservation; administrator review required.");
        }
        const previousGuard = currentGuard!;
        proposal = buildProposal(
          { outgoingShiftId: input.outgoingShiftId, permanentPairId: stored!.identity.outgoingPermanentPairId,
            outgoingTechnicianIds: stored!.identity.outgoingTechnicianIds,
            slotToken: stored!.identity.outgoingSlotToken, generation: stored!.identity.outgoingGeneration },
          selected, incomingIds, "replace",
          canonical({ binding: expected, previousReservationId: stored!.reservation.handoverId,
            guardRevision: previousGuard.guardRevision, fencingEpoch: previousGuard.fencingEpoch }));
      }
    }

    // Step 4b: every remaining read for this operation is taken here, before
    // the first buffered write in Step 5. Firestore transactions reject reads
    // issued after a write.
    const releaseIds = operation === "initialize" ? [] : [...stored!.identity.incomingTechnicianIds];
    const reserveIds = operation === "cancel" || !selected ? [] : [...incomingIds];
    const scheduleSnapshots = new Map<string, DocumentSnapshot>();
    for (const uid of new Set([...releaseIds, ...reserveIds])) {
      scheduleSnapshots.set(uid, await transaction.get(technicianSchedules.doc(uid)));
    }
    const [reservedIncomingSnapshot, proposedIncomingSnapshot] = await Promise.all([
      operation === "replace" ? transaction.get(shifts.doc(stored!.reservation.reservedIncomingShiftId))
        : Promise.resolve(null),
      proposal ? transaction.get(shifts.doc(proposal.incomingShiftId)) : Promise.resolve(null),
    ]);

    // Step 5: resolve guard ownership and derive the new aggregate state.
    const reservationOf = (identity: EqualHandoverIdentity, reservationId: string) => ({
      outgoingShiftId: identity.outgoingShiftId,
      protocolOwner: "v2" as const,
      ownerHandoverDocumentId: documentId,
      outgoingSlotToken: identity.outgoingSlotToken,
      outgoingGeneration: identity.outgoingGeneration,
      successorSlotToken: identity.successorSlotToken,
      successorGeneration: identity.successorGeneration,
      reservationId,
      reservedIncomingShiftId: identity.incomingShiftId,
    });

    let aggregate: EqualHandoverAggregate;
    let superseded: EqualHandoverAggregate | null = null;
    let guard: HandoverReservationGuard;
    let replayed = false;

    if (operation === "initialize") {
      const fresh = createEqualHandover({ identity: proposal!.identity, reservedAt: now, reservedBy: input.actorUid });
      const cancellable = stored && stored.revision === 1 && stored.lifecycleStatus === "cancelled"
        ? assertHandoverReservationGuard(guardState.guardSnapshot.data()) : null;
      if (stored && !cancellable) {
        // Idempotent replay (§11): the whole identity — including the
        // successor token and incoming Shift id — is derived deterministically
        // from the binding material (the idempotency key for initialize). An
        // identical retry therefore reconstructs the stored identity exactly.
        // A racing loser or a conflicting retry carries a different key, so
        // its identity differs and fails closed here instead of silently
        // adopting the winner's reservation.
        if (canonical(stored.identity) !== canonical(proposal!.identity) ||
            stored.reservation.handoverId !== createEqualHandoverId(stored.identity)) {
          fail("An equal handover reservation already exists for this shift.");
        }
        const resolved = await resolveOrAcquireReservationGuard(transaction, {
          ...reservationOf(stored.identity, stored.reservation.handoverId),
          reservedAt: stored.reservation.reservedAt,
          reservedBy: stored.reservation.reservedBy,
        }, guardState);
        guard = resolved.guard;
        aggregate = stored;
        replayed = true;
      } else {
        const resolved = await resolveOrAcquireReservationGuard(transaction, {
          ...reservationOf(fresh.identity, fresh.reservation.handoverId),
          reservedAt: now, reservedBy: input.actorUid,
        }, guardState);
        guard = resolved.guard;
        aggregate = fresh;
      }
    } else if (operation === "replace") {
      const result = replaceEqualHandoverReservation(stored!, {
        revision: expected!.expectedRevision, snapshotHash: expected!.expectedSnapshotHash,
        recordedAt: now, actorUid: input.actorUid, identity: proposal!.identity,
      });
      superseded = result.superseded;
      aggregate = result.replacement;
      guard = await replaceReservationGuard(transaction, {
        outgoingShiftId: input.outgoingShiftId, protocolOwner: "v2",
        expectedGuardRevision: currentGuard!.guardRevision,
        expectedFencingEpoch: currentGuard!.fencingEpoch,
        outgoingSlotToken: aggregate.identity.outgoingSlotToken,
        outgoingGeneration: aggregate.identity.outgoingGeneration,
        successorSlotToken: aggregate.identity.successorSlotToken,
        successorGeneration: aggregate.identity.successorGeneration,
        reservationId: aggregate.reservation.handoverId,
        reservedIncomingShiftId: aggregate.reservation.reservedIncomingShiftId,
        recordedAt: now, actorUid: input.actorUid,
      }, guardState);
    } else {
      aggregate = closeEqualHandover(stored!, {
        revision: expected!.expectedRevision, snapshotHash: expected!.expectedSnapshotHash,
        recordedAt: now, actorUid: input.actorUid, status: "cancelled",
      });
      const auditId = equalHandoverAuditId(documentId, aggregate);
      guard = await cancelReservationGuard(transaction, {
        outgoingShiftId: input.outgoingShiftId, protocolOwner: "v2",
        expectedGuardRevision: currentGuard!.guardRevision,
        expectedFencingEpoch: currentGuard!.fencingEpoch,
        terminalEvidenceRef: auditId, recordedAt: now, actorUid: input.actorUid,
      }, guardState);
    }

    // Step 6: release superseded/cancelled incoming schedules and reserve the
    // newly selected incoming pair using only the Step 4b snapshots. A
    // reservation never creates or activates the incoming Shift document.
    // An idempotent replay performs no schedule work: its stored entries are
    // the authoritative reservation it is replaying.
    if (!replayed) {
      if (operation === "replace" && reservedIncomingSnapshot!.exists) {
        fail("The reserved incoming Shift already exists.");
      }
      if (proposal && proposedIncomingSnapshot!.exists) {
        fail("The reserved incoming Shift already exists.");
      }
    }
    const schedules = new Map<string, TechnicianSchedule>();
    if (!replayed) for (const uid of new Set([...releaseIds, ...reserveIds])) {
      const snapshot = scheduleSnapshots.get(uid)!;
      let data = snapshot.data();
      if (snapshot.exists) scheduleEntries(data, uid);
      if (releaseIds.includes(uid)) {
        const entries = scheduleEntries(data, uid);
        const matches = entries.filter((entry) => entry.shiftId === stored!.reservation.reservedIncomingShiftId);
        if (matches.length !== 1 || matches[0].status !== "scheduled" ||
            matches[0].scheduledStart !== stored!.reservation.scheduledStart ||
            matches[0].scheduledEnd !== stored!.reservation.scheduledEnd) {
          fail("The old incoming schedule reservation is inconsistent.");
        }
        data = { ...data, entries: entries.filter((entry) => entry.shiftId !== stored!.reservation.reservedIncomingShiftId), updatedAt: now };
      }
      schedules.set(uid, reserveIds.includes(uid)
        ? prepareTechnicianSchedule({ shiftId: proposal!.incomingShiftId, technicianUid: uid,
            scheduledStart: selected!.scheduledStart, scheduledEnd: selected!.scheduledEnd,
            updatedAt: now, scheduleExists: snapshot.exists, scheduleData: data })
        : data as TechnicianSchedule);
    }

    // Step 7: writes. A losing race discards every buffered write below, so
    // no schedules or successful audit records survive a lost reservation.
    if (!replayed) {
      if (operation === "initialize" && !stored) transaction.create(aggregateRef, aggregate);
      else transaction.set(aggregateRef, aggregate);
      for (const [uid, schedule] of schedules) transaction.set(technicianSchedules.doc(uid), schedule);
      for (const uid of reserveIds) markAssignmentActivity(transaction, uid);
      transaction.update(actorRef, { lastOperationalActivityAt: FieldValue.serverTimestamp() });
      const auditId = equalHandoverAuditId(documentId, aggregate);
      const auditRef = db.collection("audit_logs").doc(auditId);
      transaction.create(auditRef, {
        id: auditId,
        action: operation === "initialize" ? "EQUAL_SHIFT_HANDOVER_RESERVATION_CREATED_V2"
          : operation === "replace" ? "EQUAL_SHIFT_HANDOVER_RESERVATION_REPLACED_V2"
            : "EQUAL_SHIFT_HANDOVER_RESERVATION_CANCELLED_V2",
        protocol: "equal-handover-v2",
        actorUid: input.actorUid,
        outgoingShiftId: input.outgoingShiftId,
        handoverDocumentId: documentId,
        reservation: aggregate.reservation,
        revision: aggregate.revision,
        snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
        guard: { guardRevision: guard.guardRevision, fencingEpoch: guard.fencingEpoch, protocolOwner: guard.protocolOwner },
        previousReservation: operation === "initialize" ? null : stored!.reservation,
        previousSnapshotHash: operation === "initialize" ? null : createEqualHandoverSnapshot(stored!).snapshotHash,
        supersededAggregate: superseded,
        cancelledAggregate: operation === "cancel" ? aggregate : null,
        cancellationReason: operation === "cancel" ? (reason ?? null) : null,
        lifecycleStatus: aggregate.lifecycleStatus,
        recordedAt: now,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      handoverDocumentId: documentId,
      aggregate,
      snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
      guard,
      replayed,
    };
  });
}

function equalHandoverAuditId(documentId: string, aggregate: EqualHandoverAggregate): string {
  // The lifecycle status is part of the material so a close of the same
  // reservation at the same revision never reuses the creation audit id.
  return `audit_${documentId}_${aggregate.revision}_${createHash("sha256")
    .update(canonical({ documentId, reservationId: aggregate.reservation.handoverId, revision: aggregate.revision, lifecycleStatus: aggregate.lifecycleStatus }))
    .digest("hex").slice(0, 40)}`;
}

export async function initializeEqualHandoverReservation(
  input: EqualReservationActor & EqualReservationSelection & { idempotencyKey: string },
): Promise<EqualHandoverReservationResult> {
  const data = input as unknown as Record<string, unknown>;
  const selected = parseSelection(data);
  const idempotencyKey = parseIdempotencyKey(data);
  return persist("initialize", input, { ...selected, idempotencyKey });
}

export async function replaceEqualHandoverReservationForTechnicians(
  input: EqualReservationActor & EqualReservationSelection & EqualReservationBinding,
): Promise<EqualHandoverReservationResult> {
  const data = input as unknown as Record<string, unknown>;
  return persist("replace", input, parseSelection(data), parseBinding(data));
}

export async function cancelEqualHandoverReservationForTechnicians(
  input: EqualReservationActor & EqualReservationBinding & { reason: string },
): Promise<EqualHandoverReservationResult> {
  const data = input as unknown as Record<string, unknown>;
  const binding = parseBinding(data);
  return persist("cancel", input, undefined, binding, parseReason(data));
}

export async function readEqualHandoverReservation(
  outgoingShiftId: string,
): Promise<{ aggregate: EqualHandoverAggregate; snapshotHash: string; guard: HandoverReservationGuard | null } | null> {
  identifier(outgoingShiftId);
  const { equalHandoversV2, handoverReservationGuards } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(outgoingShiftId);
  const [aggregateSnapshot, guardSnapshot] = await Promise.all([
    equalHandoversV2.doc(documentId).get(),
    handoverReservationGuards.doc(createHandoverReservationGuardDocumentId(outgoingShiftId)).get(),
  ]);
  if (!aggregateSnapshot.exists) return null;
  const aggregate = readEqualHandoverAggregate(aggregateSnapshot.data(), outgoingShiftId);
  return {
    aggregate,
    snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
    guard: guardSnapshot.exists ? assertHandoverReservationGuard(guardSnapshot.data()) : null,
  };
}
