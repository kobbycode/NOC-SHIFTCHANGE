import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import type { HandoverAggregate, HandoverIdentity } from "@/types/handover";
import type { TechnicianSchedule, TechnicianScheduleEntry } from "@/types/technician-schedule";
import { getOperationalCollections, GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID } from "./collections";
import { AssignmentOperationError, markAssignmentActivity, requireEligibleTechnician } from "./assignment-transaction";
import { assertHandoverAggregate, closeHandover, createHandover, createHandoverDocumentId,
  createHandoverIdentity, createHandoverSnapshot, replaceHandoverReservation } from "./handover-domain";
import { createHandoverWorkSnapshot } from "./handover-work-snapshot";
import { assertOperationalShiftControl, assertShiftOwnsOperationalSlot } from "./operational-shift-control-state";
import { readActivePermanentPairTechnicianIds } from "./next-shift-authorization-domain";
import { prepareTechnicianSchedule } from "./prepare-technician-schedule";
import { parseShiftTimeRange } from "./shift-overlap";

export interface FormalHandoverSelection {
  incomingPermanentPairId: string;
  shiftType: "morning" | "night";
  scheduledStart: string;
  scheduledEnd: string;
}
export interface FormalHandoverBinding {
  expectedRevision: number;
  expectedSnapshotHash: string;
}
export interface FormalHandoverActor {
  outgoingShiftId: string;
  actorUid: string;
  expectedRole: "admin" | "supervisor";
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
function selection(data: Record<string, unknown>): FormalHandoverSelection {
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
function binding(data: Record<string, unknown>): FormalHandoverBinding {
  if (!Number.isSafeInteger(data.expectedRevision) || (data.expectedRevision as number) < 1 ||
      typeof data.expectedSnapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(data.expectedSnapshotHash)) {
    fail("Invalid reservation revision or snapshot hash.", 400);
  }
  return { expectedRevision: data.expectedRevision as number, expectedSnapshotHash: data.expectedSnapshotHash };
}
const selectionFields = ["incomingPermanentPairId", "shiftType", "scheduledStart", "scheduledEnd"];
const bindingFields = ["expectedRevision", "expectedSnapshotHash"];
export function parseFormalHandoverRequest(value: unknown, operation: "initialize"): FormalHandoverSelection;
export function parseFormalHandoverRequest(value: unknown, operation: "replace"): FormalHandoverSelection & FormalHandoverBinding;
export function parseFormalHandoverRequest(value: unknown, operation: "cancel"): FormalHandoverBinding;
export function parseFormalHandoverRequest(value: unknown, operation: "initialize" | "replace" | "cancel") {
  const data = exactBody(value, operation === "cancel" ? bindingFields :
    operation === "replace" ? [...selectionFields, ...bindingFields] : selectionFields);
  if (operation === "cancel") return binding(data);
  const selected = selection(data);
  return operation === "replace" ? { ...selected, ...binding(data) } : selected;
}

async function readPair(transaction: Transaction, pairId: string) {
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

async function readWork(transaction: Transaction, outgoingShiftId: string) {
  const { tasks, taskAssignments } = getOperationalCollections();
  // The handover_pending Shift prevents query-membership additions. Reading ALL
  // tasks (including terminal tasks) also protects manager lifecycle resolution.
  const taskDocuments = await transaction.get(tasks.where("shiftId", "==", outgoingShiftId));
  const taskData: unknown[] = [];
  const assignments: unknown[] = [];
  for (const document of taskDocuments.docs) {
    const task = document.data();
    if (task.id !== document.id || task.shiftId !== outgoingShiftId) fail("Inconsistent authoritative task identity.");
    taskData.push(task);
    const assignmentDocuments = await transaction.get(taskAssignments.where("taskId", "==", document.id));
    for (const assignmentDocument of assignmentDocuments.docs) {
      const assignment = assignmentDocument.data();
      if (assignment.id !== assignmentDocument.id || assignment.taskId !== document.id) {
        fail("Inconsistent authoritative assignment identity.");
      }
      assignments.push(assignment);
    }
  }
  return createHandoverWorkSnapshot({ outgoingShiftId, tasks: taskData, assignments });
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

type Operation = "initialize" | "replace" | "cancel";
async function persist(operation: Operation, input: FormalHandoverActor,
  selected?: FormalHandoverSelection, expected?: FormalHandoverBinding) {
  identifier(input.actorUid, 128);
  const documentId = createHandoverDocumentId(input.outgoingShiftId);
  if (input.expectedRole !== "admin" && input.expectedRole !== "supervisor") fail("Manager authority required.", 403);
  // Establish proposal identities once, outside the callback: retries reuse them.
  const collections = getOperationalCollections();
  const { db, handovers, shifts, shiftMembers, operationalShiftControl, technicianSchedules } = collections;
  const proposedIncomingId = operation === "cancel" ? undefined : shifts.doc().id;
  const proposedToken = operation === "cancel" ? undefined : randomUUID();
  const handoverRef = handovers.doc(documentId);
  const actorRef = db.collection("users").doc(input.actorUid);
  const auditRef = db.collection("audit_logs").doc();

  return db.runTransaction(async (transaction) => {
    const [actorSnapshot, shiftSnapshot, controlSnapshot, handoverSnapshot] = await Promise.all([
      transaction.get(actorRef), transaction.get(shifts.doc(input.outgoingShiftId)),
      transaction.get(operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID)), transaction.get(handoverRef),
    ]);
    const actor = actorSnapshot.data();
    if (!actor || actor.status !== "active" || actor.statusOperation != null || actor.mustChangePassword === true ||
        actor.role !== input.expectedRole) fail("Your account is not authorized to manage handover reservations.", 403);
    if (operation === "initialize" && handoverSnapshot.exists) fail("A formal handover already exists for this shift.");
    if (operation !== "initialize" && !handoverSnapshot.exists) fail("The formal handover was not found.", 404);
    const previous = handoverSnapshot.exists ? assertHandoverAggregate(handoverSnapshot.data()) : null;
    if (previous && (previous.identity.outgoingShiftId !== input.outgoingShiftId ||
        previous.lifecycleStatus !== "collecting_confirmations" || previous.revision !== expected?.expectedRevision ||
        createHandoverSnapshot(previous).snapshotHash !== expected.expectedSnapshotHash)) fail("Stale or closed handover reservation.");
    const shift = shiftSnapshot.data();
    if (!shift) fail("The outgoing shift was not found.", 404);
    if (shift.id !== input.outgoingShiftId || shift.status !== "handover_pending" || shift.actualEnd !== null ||
        typeof shift.actualStart !== "string" || !Number.isFinite(Date.parse(shift.actualStart)) ||
        typeof shift.scheduledStart !== "string" || typeof shift.scheduledEnd !== "string") fail("Invalid outgoing handover shift.");
    parseShiftTimeRange(shift.scheduledStart, shift.scheduledEnd);
    let control;
    try {
      control = assertOperationalShiftControl(controlSnapshot.data());
      assertShiftOwnsOperationalSlot(control, input.outgoingShiftId, shift.operationalSlotToken, "handover_pending");
    } catch { fail("The outgoing shift does not own valid operational control."); }
    identifier(shift.permanentPairId);
    const outgoingIds = await readPair(transaction, shift.permanentPairId);
    if (!Array.isArray(shift.primaryTechnicianIds) || shift.primaryTechnicianIds.length !== 2 ||
        !outgoingIds.every((uid) => shift.primaryTechnicianIds.includes(uid))) fail("Outgoing permanent identities are inconsistent.");
    const members = await transaction.get(shiftMembers.where("shiftId", "==", input.outgoingShiftId));
    const primary: string[] = [];
    const current = new Set<string>();
    for (const document of members.docs) {
      const member = document.data();
      identifier(member.technicianId, 128);
      if (member.id !== document.id || member.shiftId !== input.outgoingShiftId ||
          !["primary", "additional"].includes(member.role) || (member.leftAt !== null &&
            (typeof member.leftAt !== "string" || !Number.isFinite(Date.parse(member.leftAt))))) fail("Invalid outgoing membership.");
      if (member.leftAt === null) {
        if (current.has(member.technicianId)) fail("Duplicate outgoing membership.");
        current.add(member.technicianId);
        if (member.role === "primary") primary.push(member.technicianId);
      }
    }
    if (primary.length !== 2 || !outgoingIds.every((uid) => primary.includes(uid))) fail("Outgoing primary memberships are inconsistent.");
    const orderedOutgoingIds = shift.primaryTechnicianIds as [string, string];
    if (previous && (previous.identity.outgoingPermanentPairId !== shift.permanentPairId ||
        previous.identity.outgoingSlotToken !== control.slotToken.toLowerCase() || previous.identity.outgoingGeneration !== control.generation ||
        previous.identity.outgoingPrimaryTechnicianIds.some((uid, index) => uid !== orderedOutgoingIds[index]))) {
      fail("Outgoing reservation lineage changed.");
    }

    const oldReservedIncomingShiftId = previous?.reservation.reservedIncomingShiftId;
    const incomingShiftId = operation === "cancel" ? oldReservedIncomingShiftId! : proposedIncomingId!;
    if (operation === "replace" && incomingShiftId === oldReservedIncomingShiftId) {
      fail("Replacement requires a new reserved incoming Shift identity.");
    }
    if (operation === "replace" && (await transaction.get(shifts.doc(oldReservedIncomingShiftId!))).exists) {
      fail("The reserved incoming Shift already exists.");
    }
    if ((await transaction.get(shifts.doc(incomingShiftId))).exists) fail("The reserved incoming Shift already exists.");
    // Old accounts are read for cleanup coordination, but need not be eligible
    // to release a reservation. New selected accounts must be eligible.
    if (previous) {
      const oldIds = await readPair(transaction, previous.identity.incomingPermanentPairId);
      if (!oldIds.every((uid) => previous.identity.incomingPrimaryTechnicianIds.includes(uid))) fail("Old incoming pair changed.");
      for (const uid of oldIds) await transaction.get(db.collection("users").doc(uid));
    }
    const incomingIds: string[] = selected ? await readPair(transaction, selected.incomingPermanentPairId) : [];
    for (const uid of incomingIds) await requireEligibleTechnician(transaction, uid);
    const workSnapshot = await readWork(transaction, input.outgoingShiftId);
    const now = new Date().toISOString();
    const supervisor = { uid: input.actorUid, authority: input.expectedRole === "admin" ? "manager" as const : "supervisor" as const };
    const context = { revision: expected?.expectedRevision ?? 1, snapshotHash: expected?.expectedSnapshotHash ?? "",
      recordedAt: now, actor: supervisor };
    let aggregate: HandoverAggregate;
    let superseded: HandoverAggregate | null = null;
    if (operation === "cancel") {
      aggregate = closeHandover(previous!, { ...context, status: "cancelled" });
    } else {
      const identity: HandoverIdentity = createHandoverIdentity({
        outgoingShiftId: input.outgoingShiftId, outgoingPermanentPairId: shift.permanentPairId,
        outgoingPrimaryTechnicianIds: orderedOutgoingIds, outgoingSlotToken: control.slotToken,
        outgoingGeneration: control.generation, incomingShiftId, ...selected,
        incomingPrimaryTechnicianIds: incomingIds, successorSlotToken: proposedToken, successorGeneration: control.generation + 1,
      });
      if (previous) {
        const result = replaceHandoverReservation(previous, { ...context, identity, workSnapshot, temporaryAuthorization: null });
        aggregate = result.replacement;
        superseded = result.superseded;
      } else aggregate = createHandover({ identity, workSnapshot, reservedAt: now, reservedBy: input.actorUid });
    }
    aggregate = assertHandoverAggregate(aggregate);
    const affected = new Set([...(previous?.identity.incomingPrimaryTechnicianIds ?? []), ...incomingIds]);
    const schedules = new Map<string, TechnicianSchedule>();
    for (const uid of affected) {
      const snapshot = await transaction.get(technicianSchedules.doc(uid));
      let data = snapshot.data();
      if (snapshot.exists) scheduleEntries(data, uid);
      if (previous?.identity.incomingPrimaryTechnicianIds.includes(uid)) {
        const entries = scheduleEntries(data, uid);
        const matches = entries.filter((entry) => entry.shiftId === oldReservedIncomingShiftId);
        if (matches.length !== 1 || matches[0].status !== "scheduled" ||
            matches[0].scheduledStart !== previous.reservation.scheduledStart || matches[0].scheduledEnd !== previous.reservation.scheduledEnd) {
          fail("The old incoming schedule reservation is inconsistent.");
        }
        data = { ...data, entries: entries.filter((entry) => entry.shiftId !== oldReservedIncomingShiftId), updatedAt: now };
      }
      const prepared = incomingIds.includes(uid) ? prepareTechnicianSchedule({
        shiftId: incomingShiftId, technicianUid: uid, scheduledStart: selected!.scheduledStart,
        scheduledEnd: selected!.scheduledEnd, updatedAt: now, scheduleExists: snapshot.exists, scheduleData: data,
      }) : data as TechnicianSchedule;
      schedules.set(uid, prepared);
    }
    // All reads/derivation are complete. Never write Shift/control/work/roster/attendance.
    if (operation === "initialize") transaction.create(handoverRef, aggregate);
    else transaction.set(handoverRef, aggregate);
    for (const [uid, schedule] of schedules) transaction.set(technicianSchedules.doc(uid), schedule);
    for (const uid of incomingIds) markAssignmentActivity(transaction, uid);
    transaction.update(actorRef, { lastOperationalActivityAt: FieldValue.serverTimestamp() });
    const snapshotHash = createHandoverSnapshot(aggregate).snapshotHash;
    transaction.create(auditRef, {
      id: auditRef.id, action: operation === "initialize" ? "SHIFT_HANDOVER_RESERVATION_CREATED" :
        operation === "replace" ? "SHIFT_HANDOVER_RESERVATION_REPLACED" : "SHIFT_HANDOVER_RESERVATION_CANCELLED",
      actorUid: input.actorUid, outgoingShiftId: input.outgoingShiftId, handoverDocumentId: documentId,
      reservation: aggregate.reservation, revision: aggregate.revision, snapshotHash,
      workSnapshot: aggregate.workSnapshot, observedWorkSnapshot: workSnapshot,
      previousSnapshotHash: previous ? createHandoverSnapshot(previous).snapshotHash : null,
      previousReservation: previous?.reservation ?? null,
      // Full superseded evidence preserves confirmations/resolutions before replacement.
      supersededAggregate: superseded, lifecycleStatus: aggregate.lifecycleStatus,
      recordedAt: now, createdAt: FieldValue.serverTimestamp(),
    });
    return { handoverDocumentId: documentId, aggregate, snapshotHash };
  });
}

export async function initializeFormalHandover(input: FormalHandoverActor & FormalHandoverSelection) {
  const selected = selection(input as unknown as Record<string, unknown>);
  return persist("initialize", input, selected);
}
export async function replaceFormalHandoverReservation(input: FormalHandoverActor & FormalHandoverSelection & FormalHandoverBinding) {
  const selected = selection(input as unknown as Record<string, unknown>);
  const expected = binding(input as unknown as Record<string, unknown>);
  return persist("replace", input, selected, expected);
}
export async function cancelFormalHandoverReservation(input: FormalHandoverActor & FormalHandoverBinding) {
  return persist("cancel", input, undefined, binding(input as unknown as Record<string, unknown>));
}
