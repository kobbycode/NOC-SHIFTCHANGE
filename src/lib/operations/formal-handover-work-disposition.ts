import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import type { Transaction } from "firebase-admin/firestore";
import type { TechnicianScheduleEntry } from "@/types/technician-schedule";
import type { HandoverWorkDispositionValue } from "@/types/handover-work-disposition";
import { AssignmentOperationError } from "./assignment-transaction";
import { getOperationalCollections, GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID } from "./collections";
import { readAuthoritativeHandoverWorkState } from "./formal-handover";
import { assertHandoverAggregate, createHandoverDocumentId, createHandoverSnapshot, resolveHandoverParticipants, reviseHandoverSnapshot } from "./handover-domain";
import { classifyHandoverWork, clearHandoverWorkDisposition, createHandoverWorkDispositionDocumentId } from "./handover-work-disposition-domain";
import { createHandoverWorkSnapshot, createHandoverTaskWorkHash } from "./handover-work-snapshot";
import { readActivePermanentPairTechnicianIds } from "./next-shift-authorization-domain";
import { assertOperationalShiftControl, assertShiftOwnsOperationalSlot } from "./operational-shift-control-state";
import { assertNoScheduleConflict, parseShiftTimeRange } from "./shift-overlap";

type Binding = { expectedRevision: number; expectedSnapshotHash: string; reason: string };
export type FormalHandoverWorkDispositionRequest = Binding & (
  | { operation: "classify"; disposition: HandoverWorkDispositionValue }
  | { operation: "clear" }
);
export type FormalHandoverWorkDispositionInput = FormalHandoverWorkDispositionRequest & {
  outgoingShiftId: string; taskId: string; actorUid: string;
};
export interface FormalHandoverWorkDispositionOutcome {
  status: "CLASSIFIED" | "CLEARED" | "ALREADY_CLASSIFIED" | "ALREADY_UNCLASSIFIED" | "REVIEW_REQUIRED";
  handover: { revision: number; snapshotHash: string };
}

function fail(message: string, status = 409): never {
  throw new AssignmentOperationError(message, status);
}
function identifier(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > max ||
      value.includes("/") || value === "." || value === "..") fail("Invalid disposition identifier.", 400);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

async function validatePair(transaction: Transaction, pairId: string, expected: [string, string]) {
  const { technicianPairs, technicianPairMemberships } = getOperationalCollections();
  const snapshot = await transaction.get(technicianPairs.doc(pairId));
  const ids = readActivePermanentPairTechnicianIds(snapshot.data(), pairId);
  if (ids.some((uid, index) => uid !== expected[index])) fail("The permanent pair binding changed.");
  for (const uid of ids) {
    const membership = (await transaction.get(technicianPairMemberships.doc(uid))).data();
    if (!membership || membership.technicianUid !== uid || membership.pairId !== pairId ||
        !timestamp(membership.createdAt) || !timestamp(membership.updatedAt) ||
        Date.parse(membership.updatedAt) < Date.parse(membership.createdAt)) {
      fail("The permanent pair membership is inconsistent.");
    }
  }
}

function validateSchedule(value: unknown, uid: string, target: TechnicianScheduleEntry) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Missing technician schedule.");
  const schedule = value as Record<string, unknown>;
  if (schedule.technicianUid !== uid || !Array.isArray(schedule.entries)) fail("Invalid technician schedule.");
  const entries: TechnicianScheduleEntry[] = [];
  const ids = new Set<string>();
  for (const value of schedule.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid schedule entry.");
    const entry = value as TechnicianScheduleEntry;
    identifier(entry.shiftId, 512);
    if (ids.has(entry.shiftId) || !["scheduled", "active", "handover_pending"].includes(entry.status) ||
        !timestamp(entry.scheduledStart) || !timestamp(entry.scheduledEnd)) fail("Invalid schedule entry.");
    parseShiftTimeRange(entry.scheduledStart, entry.scheduledEnd);
    ids.add(entry.shiftId);
    entries.push(entry);
  }
  const matching = entries.filter((entry) => entry.shiftId === target.shiftId);
  if (matching.length !== 1 || matching[0].status !== target.status ||
      matching[0].scheduledStart !== target.scheduledStart || matching[0].scheduledEnd !== target.scheduledEnd) {
    fail("The handover schedule binding changed.");
  }
  assertNoScheduleConflict(target.scheduledStart, target.scheduledEnd,
    entries.filter((entry) => entry.shiftId !== target.shiftId));
}

export function parseFormalHandoverWorkDispositionRequest(value: unknown): FormalHandoverWorkDispositionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid disposition request.", 400);
  const data = value as Record<string, unknown>;
  if (data.operation !== "classify" && data.operation !== "clear") fail("Invalid disposition operation.", 400);
  const fields = ["operation", "reason", "expectedRevision", "expectedSnapshotHash", ...(data.operation === "classify" ? ["disposition"] : [])];
  if (Object.keys(data).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(data, key))) {
    fail("Missing or unsupported disposition fields.", 400);
  }
  if (!Number.isSafeInteger(data.expectedRevision) || (data.expectedRevision as number) < 1 ||
      typeof data.expectedSnapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(data.expectedSnapshotHash)) {
    fail("Invalid handover revision or snapshot hash.", 400);
  }
  if (typeof data.reason !== "string" || data.reason.trim().length < 10 || data.reason.trim().length > 1000) {
    fail("Provide a disposition reason between 10 and 1000 characters.", 400);
  }
  const binding = { reason: data.reason.trim(), expectedRevision: data.expectedRevision as number, expectedSnapshotHash: data.expectedSnapshotHash };
  if (data.operation === "clear") return { ...binding, operation: "clear" };
  if (data.disposition !== "carry_forward" && data.disposition !== "resolve_before_transfer") fail("Invalid work disposition.", 400);
  return { ...binding, operation: "classify", disposition: data.disposition };
}

export async function persistFormalHandoverWorkDisposition(input: FormalHandoverWorkDispositionInput): Promise<FormalHandoverWorkDispositionOutcome> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Invalid disposition input.", 400);
  const { outgoingShiftId, taskId, actorUid, ...request } = input;
  identifier(actorUid, 128); identifier(taskId, 512);
  const documentId = createHandoverDocumentId(outgoingShiftId);
  const parsed = parseFormalHandoverWorkDispositionRequest(request);
  const { db, handovers, shifts, operationalShiftControl, shiftMembers, technicianSchedules, handoverTaskDispositions, tasks } = getOperationalCollections();
  const handoverRef = handovers.doc(documentId);
  const dispositionRef = handoverTaskDispositions.doc(createHandoverWorkDispositionDocumentId({ outgoingShiftId, handoverDocumentId: documentId, taskId }));
  const auditRef = db.collection("audit_logs").doc();
  return db.runTransaction(async (transaction): Promise<FormalHandoverWorkDispositionOutcome> => {
    const [actorSnapshot, shiftSnapshot, controlSnapshot, handoverSnapshot, targetSnapshot, dispositionSnapshot] = await Promise.all([
      transaction.get(db.collection("users").doc(actorUid)), transaction.get(shifts.doc(outgoingShiftId)),
      transaction.get(operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID)), transaction.get(handoverRef),
      transaction.get(tasks.doc(taskId)), transaction.get(dispositionRef),
    ]);
    const actor = actorSnapshot.data();
    if (!actor || actor.status !== "active" || actor.statusOperation !== null || actor.mustChangePassword !== false ||
        (actor.role !== "admin" && actor.role !== "supervisor")) fail("Your account is not authorized to classify handover work.", 403);
    if (!handoverSnapshot.exists) fail("The formal handover was not found.", 404);
    const aggregate = assertHandoverAggregate(handoverSnapshot.data());
    const previousHash = createHandoverSnapshot(aggregate).snapshotHash;
    if (handoverSnapshot.id !== documentId || aggregate.identity.outgoingShiftId !== outgoingShiftId ||
        aggregate.lifecycleStatus !== "collecting_confirmations" || aggregate.revision !== parsed.expectedRevision ||
        previousHash !== parsed.expectedSnapshotHash) fail("Stale or closed handover. Review it before classifying work.");
    const participants = resolveHandoverParticipants(aggregate);
    const shift = shiftSnapshot.data();
    if (!shift || shift.id !== outgoingShiftId || shift.status !== "handover_pending" || shift.actualEnd !== null ||
        !timestamp(shift.actualStart) || !timestamp(shift.scheduledStart) || !timestamp(shift.scheduledEnd) ||
        shift.permanentPairId !== aggregate.identity.outgoingPermanentPairId ||
        !Array.isArray(shift.primaryTechnicianIds) || shift.primaryTechnicianIds.length !== 2 ||
        shift.primaryTechnicianIds.some((uid, index) => uid !== aggregate.identity.outgoingPrimaryTechnicianIds[index])) {
      fail("The outgoing handover Shift changed.");
    }
    parseShiftTimeRange(shift.scheduledStart, shift.scheduledEnd);
    try {
      const control = assertOperationalShiftControl(controlSnapshot.data());
      assertShiftOwnsOperationalSlot(control, outgoingShiftId, shift.operationalSlotToken, "handover_pending");
      if (control.slotToken.toLowerCase() !== aggregate.identity.outgoingSlotToken ||
          control.generation !== aggregate.identity.outgoingGeneration) fail("The outgoing handover lineage changed.");
    } catch { fail("The outgoing Shift no longer owns valid handover control."); }
    await validatePair(transaction, aggregate.identity.outgoingPermanentPairId, aggregate.identity.outgoingPrimaryTechnicianIds);
    await validatePair(transaction, aggregate.identity.incomingPermanentPairId, aggregate.identity.incomingPrimaryTechnicianIds);
    const members = await transaction.get(shiftMembers.where("shiftId", "==", outgoingShiftId));
    const current = new Set<string>();
    const primary: string[] = [];
    for (const document of members.docs) {
      const member = document.data();
      identifier(member.technicianId, 128);
      if (member.id !== document.id || member.shiftId !== outgoingShiftId ||
          !["primary", "additional"].includes(member.role) || !timestamp(member.joinedAt) ||
          (member.leftAt !== null && (!timestamp(member.leftAt) || Date.parse(member.leftAt) < Date.parse(member.joinedAt)))) {
        fail("Invalid outgoing Shift membership.");
      }
      if (member.leftAt === null) {
        if (current.has(member.technicianId)) fail("Duplicate outgoing Shift membership.");
        current.add(member.technicianId);
        if (member.role === "primary") primary.push(member.technicianId);
        else if (participants.some((entry) => entry.technicianUid === member.technicianId)) {
          fail("An additional technician cannot occupy a permanent handover signer position.", member.technicianId === actorUid ? 403 : 409);
        }
      }
    }
    if (primary.length !== 2 || !aggregate.identity.outgoingPrimaryTechnicianIds.every((uid) => primary.includes(uid))) {
      fail("Outgoing primary memberships changed.");
    }
    if ((await transaction.get(shifts.doc(aggregate.reservation.reservedIncomingShiftId))).exists) {
      fail("The reserved incoming Shift already exists.");
    }
    for (const entry of participants) {
      const outgoing = entry.side === "outgoing";
      validateSchedule((await transaction.get(technicianSchedules.doc(entry.technicianUid))).data(), entry.technicianUid, {
        shiftId: outgoing ? outgoingShiftId : aggregate.reservation.reservedIncomingShiftId,
        status: outgoing ? "handover_pending" : "scheduled",
        scheduledStart: outgoing ? shift.scheduledStart : aggregate.reservation.scheduledStart,
        scheduledEnd: outgoing ? shift.scheduledEnd : aggregate.reservation.scheduledEnd,
      });
    }
    const work = await readAuthoritativeHandoverWorkState(transaction, outgoingShiftId);
    const observedWork = createHandoverWorkSnapshot(work);
    const recordedAt = new Date(Math.max(Date.now(), Date.parse(aggregate.updatedAt))).toISOString();
    const audit = { id: auditRef.id, actorUid, actorRole: actor.role, outgoingShiftId, handoverDocumentId: documentId,
      taskId, previousRevision: aggregate.revision, previousSnapshotHash: previousHash,
      recordedAt, createdAt: FieldValue.serverTimestamp() };
    if (aggregate.workSnapshot.schema !== "handover-work-v2" || observedWork.version !== aggregate.workSnapshot.version) {
      const revised = reviseHandoverSnapshot(aggregate, { revision: aggregate.revision, snapshotHash: previousHash,
        recordedAt, workSnapshot: observedWork, temporaryAuthorization: aggregate.temporaryAuthorization });
      const snapshotHash = createHandoverSnapshot(revised).snapshotHash;
      transaction.set(handoverRef, revised);
      transaction.create(auditRef, { ...audit, action: "SHIFT_HANDOVER_SNAPSHOT_REVISED", newRevision: revised.revision,
        newSnapshotHash: snapshotHash, previousWorkSnapshot: aggregate.workSnapshot, newWorkSnapshot: observedWork,
        reason: "Authoritative work reconciled before disposition mutation." });
      return { status: "REVIEW_REQUIRED", handover: { revision: revised.revision, snapshotHash } };
    }
    const target = targetSnapshot.data();
    if (!targetSnapshot.exists) fail("The selected task was not found.", 404);
    if (!target || target.id !== taskId || target.shiftId !== outgoingShiftId) fail("The task does not belong to the outgoing handover.");
    if (target.status === "completed" || target.status === "cancelled") fail("Terminal tasks cannot receive handover disposition mutations.");
    const previous = work.dispositions.find((record) => record.taskId === taskId) ?? null;
    if (dispositionSnapshot.exists !== (previous !== null)) fail("Inconsistent authoritative disposition identity; administrator review required.");
    const taskWorkHash = createHandoverTaskWorkHash({ ...work, taskId });
    const classified = parsed.operation === "classify" ? classifyHandoverWork(previous, {
      outgoingShiftId, handoverDocumentId: documentId, taskId, disposition: parsed.disposition,
      classifiedBy: actorUid, classifierRole: actor.role, classifiedAt: recordedAt, reason: parsed.reason,
      recordedRevision: aggregate.revision + 1, reviewedSnapshotHash: previousHash, classifiedTaskWorkHash: taskWorkHash,
    }) : null;
    const cleared = parsed.operation === "clear" ? clearHandoverWorkDisposition(previous, parsed.reason) : null;
    if (classified?.changed === false || cleared?.changed === false) return {
      status: classified ? "ALREADY_CLASSIFIED" : "ALREADY_UNCLASSIFIED", handover: { revision: aggregate.revision, snapshotHash: previousHash },
    };
    const nextRecord = classified?.record ?? null;
    const dispositions = [...work.dispositions.filter((record) => record.taskId !== taskId), ...(nextRecord ? [nextRecord] : [])];
    const nextWork = createHandoverWorkSnapshot({ ...work, dispositions });
    const revised = reviseHandoverSnapshot(aggregate, { revision: aggregate.revision, snapshotHash: previousHash,
      recordedAt, workSnapshot: nextWork, temporaryAuthorization: aggregate.temporaryAuthorization });
    const snapshotHash = createHandoverSnapshot(revised).snapshotHash;
    // No reads follow these writes. No tasks, assignments, shifts or accounts are mutated.
    if (nextRecord) transaction.set(dispositionRef, nextRecord);
    else transaction.delete(dispositionRef);
    transaction.set(handoverRef, revised);
    transaction.create(auditRef, { ...audit, action: !nextRecord ? "SHIFT_HANDOVER_WORK_DISPOSITION_CLEARED" :
      previous ? "SHIFT_HANDOVER_WORK_DISPOSITION_CHANGED" : "SHIFT_HANDOVER_WORK_DISPOSITION_CREATED",
      oldDisposition: previous, newDisposition: nextRecord, reason: parsed.reason,
      newRevision: revised.revision, newSnapshotHash: snapshotHash,
      previousWorkSnapshot: aggregate.workSnapshot, newWorkSnapshot: nextWork });
    return { status: nextRecord ? "CLASSIFIED" : "CLEARED", handover: { revision: revised.revision, snapshotHash } };
  });
}
