import "server-only";
import { FieldValue, type Transaction, type DocumentData } from "firebase-admin/firestore";
import type { FormalHandoverTransferPlan, FormalHandoverTransferReceipt, FormalHandoverTransferResult,
  HandoverTaskTransferEvidence } from "@/types/handover-transfer";
import type { TechnicianScheduleEntry } from "@/types/technician-schedule";
import { getOperationalCollections, GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID } from "./collections";
import { AssignmentOperationError } from "./assignment-transaction";
import { assertHandoverAggregate, assertHandoverReadyForTransfer, completeHandoverTransfer, createHandoverDocumentId,
  createHandoverSnapshot, reviseHandoverSnapshot } from "./handover-domain";
import { readAuthoritativeHandoverWorkState } from "./formal-handover";
import { assertFormalTransferWorkReady, createHandoverWorkSnapshot } from "./handover-work-snapshot";
import { assertAssignmentRelease, createHandoverAssignmentRelease, validateTaskAssignmentHistory } from "./assignment-generation-domain";
import { assertFormalHandoverTransferCapacity, assertFormalHandoverTransferReceipt, assertIncomingHandoverActivation,
  createFormalHandoverTransferReceipt, createFormalHandoverTransferReceiptId, createHandoverTaskTransferDocumentId, HandoverTransferError, ordinalCompare } from "./handover-transfer-domain";
import { assertOperationalShiftControl, assertShiftOwnsOperationalSlot, transferOperationalShiftControl } from "./operational-shift-control-state";
import { assertNextShiftAuthorization, completeConsumedNextShiftAuthorization, createNextShiftAuthorizationDocumentId,
  readActivePermanentPairTechnicianIds } from "./next-shift-authorization-domain";
import { finalizeCurrentShiftMemberships, validateShiftCompletionAttendance } from "./shift-completion-domain";
import { createShiftAttendanceRecord } from "./shift-join-domain";
import { assertShiftActivationWindow } from "./shift-activation-window";
import { assertNoScheduleConflict, parseShiftTimeRange } from "./shift-overlap";

export interface FormalHandoverTransferBinding { expectedRevision: number; expectedSnapshotHash: string }
export interface FormalHandoverTransferInput extends FormalHandoverTransferBinding {
  outgoingShiftId: string; actorUid: string; actorRole: "admin" | "supervisor";
}
function fail(message: string): never { throw new HandoverTransferError(message); }
function identifier(value: unknown, max = 512): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > max ||
      value.includes("/") || value === "." || value === "..") throw new AssignmentOperationError("Invalid transfer identifier.", 400);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function authoritativeIdentifier(value: unknown, max = 512): asserts value is string {
  try { identifier(value, max); } catch { fail("Invalid authoritative transfer identity."); }
}
export function parseFormalHandoverTransferRequest(value: unknown): FormalHandoverTransferBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentOperationError("Invalid transfer request.", 400);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 2 || !Object.hasOwn(data, "expectedRevision") || !Object.hasOwn(data, "expectedSnapshotHash") ||
      !Number.isSafeInteger(data.expectedRevision) || Number(data.expectedRevision) < 1 ||
      typeof data.expectedSnapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(data.expectedSnapshotHash)) {
    throw new AssignmentOperationError("Provide only the reviewed revision and snapshot hash.", 400);
  }
  return { expectedRevision: Number(data.expectedRevision), expectedSnapshotHash: data.expectedSnapshotHash };
}

async function validatePair(transaction: Transaction, pairId: string, expected: [string, string]) {
  const { technicianPairs, technicianPairMemberships } = getOperationalCollections();
  const ids = readActivePermanentPairTechnicianIds((await transaction.get(technicianPairs.doc(pairId))).data(), pairId);
  if (ids.some((uid, i) => uid !== expected[i])) fail("The permanent pair binding changed.");
  for (const uid of ids) {
    const member = (await transaction.get(technicianPairMemberships.doc(uid))).data();
    if (!member || member.technicianUid !== uid || member.pairId !== pairId || !timestamp(member.createdAt) ||
        !timestamp(member.updatedAt) || member.updatedAt < member.createdAt) fail("Invalid permanent pair membership.");
  }
}

function schedule(value: DocumentData | undefined, uid: string, target: TechnicianScheduleEntry | null): TechnicianScheduleEntry[] {
  if (!value || value.technicianUid !== uid || !Array.isArray(value.entries)) fail("Missing or invalid technician schedule.");
  const ids = new Set<string>();
  const entries = value.entries as TechnicianScheduleEntry[];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("Invalid schedule entry.");
    authoritativeIdentifier(entry.shiftId);
    if (ids.has(entry.shiftId) || !["scheduled", "active", "handover_pending"].includes(entry.status) ||
        !timestamp(entry.scheduledStart) || !timestamp(entry.scheduledEnd)) fail("Invalid schedule entry.");
    parseShiftTimeRange(entry.scheduledStart, entry.scheduledEnd); ids.add(entry.shiftId);
  }
  if (target) {
    const found = entries.filter(entry => entry.shiftId === target.shiftId);
    if (found.length !== 1 || found[0].status !== target.status || found[0].scheduledStart !== target.scheduledStart ||
        found[0].scheduledEnd !== target.scheduledEnd) fail("The handover schedule binding changed.");
    assertNoScheduleConflict(target.scheduledStart, target.scheduledEnd, entries.filter(entry => entry.shiftId !== target.shiftId));
  }
  return entries;
}

async function readAuthorization(transaction: Transaction, shiftId: string, pairId: string, generation: number, slotToken: string) {
  const { nextShiftAuthorizations } = getOperationalCollections();
  const id = createNextShiftAuthorizationDocumentId(pairId, generation, slotToken);
  const [point, bySlot, byShift] = await Promise.all([
    transaction.get(nextShiftAuthorizations.doc(id)),
    transaction.get(nextShiftAuthorizations.where("slotToken", "==", slotToken).where("slotGeneration", "==", generation)),
    transaction.get(nextShiftAuthorizations.where("shiftId", "==", shiftId)),
  ]);
  const documents = new Map([...bySlot.docs, ...byShift.docs, ...(point.exists ? [point] : [])].map(doc => [doc.id, doc]));
  if (documents.size > 1) fail("Duplicate temporary authorization; administrator review required.");
  const document = [...documents.values()][0];
  if (!document) return null;
  const record = assertNextShiftAuthorization(document.data());
  if (document.id !== id || record.id !== id || record.slotToken !== slotToken || record.slotGeneration !== generation ||
      record.permanentPairId !== pairId || record.shiftId !== shiftId || record.status !== "consumed") {
    fail("Temporary authorization does not match the outgoing ownership lineage.");
  }
  return record;
}

export async function persistFormalHandoverTransfer(input: FormalHandoverTransferInput): Promise<FormalHandoverTransferResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AssignmentOperationError("Invalid transfer input.", 400);
  const { outgoingShiftId, actorUid, actorRole, ...request } = input;
  identifier(actorUid, 128);
  const binding = parseFormalHandoverTransferRequest(request);
  const documentId = createHandoverDocumentId(outgoingShiftId);
  if (actorRole !== "admin" && actorRole !== "supervisor") throw new AssignmentOperationError("Manager authority required.", 403);
  const { db, handovers, shifts, shiftMembers, shiftAttendance, technicianSchedules, operationalShiftControl,
    handoverTaskTransfers, nextShiftAuthorizations } = getOperationalCollections();
  const receiptId = createFormalHandoverTransferReceiptId(documentId);
  const receiptRef = db.collection("audit_logs").doc(receiptId);
  const handoverRef = handovers.doc(documentId);
  return db.runTransaction(async (transaction): Promise<FormalHandoverTransferResult> => {
    const [actorSnapshot, handoverSnapshot] = await Promise.all([
      transaction.get(db.collection("users").doc(actorUid)), transaction.get(handoverRef),
    ]);
    const actor = actorSnapshot.data();
    if (!actor || actor.role !== actorRole || actor.status !== "active" || actor.statusOperation !== null || actor.mustChangePassword !== false) {
      throw new AssignmentOperationError("Your account is not authorized to transfer this handover.", 403);
    }
    if (!handoverSnapshot.exists) throw new AssignmentOperationError("The formal handover was not found.", 404);
    const aggregate = assertHandoverAggregate(handoverSnapshot.data());
    const finalHash = createHandoverSnapshot(aggregate).snapshotHash;
    if (aggregate.identity.outgoingShiftId !== outgoingShiftId || aggregate.revision !== binding.expectedRevision || finalHash !== binding.expectedSnapshotHash) {
      fail("Stale handover. Review the current revision before transfer.");
    }
    const receiptSnapshot = await transaction.get(receiptRef);
    if (aggregate.lifecycleStatus === "completed") {
      return { status: "ALREADY_TRANSFERRED", receipt: assertFormalHandoverTransferReceipt(receiptSnapshot.data(), aggregate, documentId) };
    }
    if (aggregate.lifecycleStatus !== "collecting_confirmations") fail("The handover is closed.");
    if (receiptSnapshot.exists) fail("Transfer receipt already exists for a collecting handover.");
    const identity = aggregate.identity;
    const incomingId = aggregate.reservation.reservedIncomingShiftId;
    const [outSnapshot, incomingSnapshot, controlSnapshot] = await Promise.all([
      transaction.get(shifts.doc(outgoingShiftId)), transaction.get(shifts.doc(incomingId)),
      transaction.get(operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID)),
    ]);
    const outgoing = outSnapshot.data();
    if (!outgoing || outgoing.id !== outgoingShiftId || outgoing.status !== "handover_pending" || outgoing.actualEnd !== null ||
        !timestamp(outgoing.actualStart) || !timestamp(outgoing.handoverStartedAt) || outgoing.handoverStartedAt < outgoing.actualStart ||
        !timestamp(outgoing.scheduledStart) || !timestamp(outgoing.scheduledEnd) || outgoing.permanentPairId !== identity.outgoingPermanentPairId ||
        !Array.isArray(outgoing.primaryTechnicianIds) || outgoing.primaryTechnicianIds.length !== 2 ||
        outgoing.primaryTechnicianIds.some((uid, i) => uid !== identity.outgoingPrimaryTechnicianIds[i])) fail("Invalid outgoing handover Shift.");
    parseShiftTimeRange(outgoing.scheduledStart, outgoing.scheduledEnd);
    if (incomingSnapshot.exists) fail("The reserved incoming Shift already exists.");
    let control;
    try {
      control = assertOperationalShiftControl(controlSnapshot.data());
      assertShiftOwnsOperationalSlot(control, outgoingShiftId, outgoing.operationalSlotToken, "handover_pending");
      if (control.generation !== identity.outgoingGeneration || control.slotToken.toLowerCase() !== identity.outgoingSlotToken) fail("Invalid outgoing control lineage.");
    } catch { fail("The outgoing Shift no longer owns valid operational control."); }
    await validatePair(transaction, identity.outgoingPermanentPairId, identity.outgoingPrimaryTechnicianIds);
    await validatePair(transaction, identity.incomingPermanentPairId, identity.incomingPrimaryTechnicianIds);
    const [memberDocs, incomingMembers, attendanceDocs, incomingAttendance] = await Promise.all([
      transaction.get(shiftMembers.where("shiftId", "==", outgoingShiftId)), transaction.get(shiftMembers.where("shiftId", "==", incomingId)),
      transaction.get(shiftAttendance.where("shiftId", "==", outgoingShiftId)), transaction.get(shiftAttendance.where("shiftId", "==", incomingId)),
    ]);
    if (!incomingMembers.empty || !incomingAttendance.empty) fail("Reserved incoming membership or attendance already exists.");
    const currentMembers = [];
    for (const doc of memberDocs.docs) {
      const member = doc.data();
      authoritativeIdentifier(member.technicianId, 128);
      if (member.id !== doc.id || doc.id !== `${outgoingShiftId}_${member.technicianId}` || member.shiftId !== outgoingShiftId ||
          !["primary", "additional"].includes(member.role) || !timestamp(member.joinedAt) ||
          (member.leftAt !== null && (!timestamp(member.leftAt) || member.leftAt < member.joinedAt))) fail("Invalid outgoing membership.");
      if (member.leftAt === null) currentMembers.push(member);
    }
    for (const doc of attendanceDocs.docs) {
      const attendance = doc.data();
      if (attendance.id !== doc.id || doc.id !== `${outgoingShiftId}_${attendance.technicianId}`) fail("Invalid outgoing attendance identity.");
    }
    for (const uid of identity.incomingPrimaryTechnicianIds) {
      if ((await transaction.get(shiftMembers.doc(`${incomingId}_${uid}`))).exists ||
          (await transaction.get(shiftAttendance.doc(`${incomingId}_${uid}`))).exists) fail("Reserved incoming evidence location already exists.");
    }
    const schedules = new Map<string, DocumentData>();
    const requiredUsers = new Set([...identity.outgoingPrimaryTechnicianIds, ...identity.incomingPrimaryTechnicianIds,
      ...currentMembers.map(member => member.technicianId as string)]);
    const users = new Map<string, DocumentData>([[actorUid, actor]]);
    for (const uid of requiredUsers) {
      const profile = (await transaction.get(db.collection("users").doc(uid))).data();
      if (!profile || profile.role !== "technician" || profile.status !== "active" || profile.statusOperation !== null || profile.mustChangePassword !== false) {
        fail("A permanent or current additional technician is no longer eligible.");
      }
      users.set(uid, profile);
      const value = (await transaction.get(technicianSchedules.doc(uid))).data();
      const incoming = identity.incomingPrimaryTechnicianIds.includes(uid);
      schedule(value, uid, { shiftId: incoming ? incomingId : outgoingShiftId,
        status: incoming ? "scheduled" : "handover_pending", scheduledStart: incoming ? identity.scheduledStart : outgoing.scheduledStart,
        scheduledEnd: incoming ? identity.scheduledEnd : outgoing.scheduledEnd });
      schedules.set(uid, value!);
    }
    const authorization = await readAuthorization(transaction, outgoingShiftId, identity.outgoingPermanentPairId, identity.outgoingGeneration, identity.outgoingSlotToken);
    // Incoming C architecture is deliberately unsupported, including malformed
    // records discoverable through either reserved lineage or Shift identity.
    const incomingAuthId = createNextShiftAuthorizationDocumentId(identity.incomingPermanentPairId,
      identity.successorGeneration, identity.successorSlotToken);
    const incomingAuthBySlot = await transaction.get(nextShiftAuthorizations.where("slotToken", "==", identity.successorSlotToken)
      .where("slotGeneration", "==", identity.successorGeneration));
    const incomingAuthByShift = await transaction.get(nextShiftAuthorizations.where("shiftId", "==", incomingId));
    const incomingAuthPoint = await transaction.get(nextShiftAuthorizations.doc(incomingAuthId));
    if (aggregate.temporaryAuthorization !== null || incomingAuthPoint.exists || !incomingAuthBySlot.empty || !incomingAuthByShift.empty) {
      fail("Incoming temporary authorization is unsupported at this transfer boundary.");
    }
    const work = await readAuthoritativeHandoverWorkState(transaction, outgoingShiftId);
    for (const task of work.tasks as DocumentData[]) {
      try { validateTaskAssignmentHistory(task.id, (work.assignments as DocumentData[]).filter(a => a.taskId === task.id).map(a => ({ id: a.id, data: a }))); }
      catch { fail("Malformed authoritative assignment history; administrator review required."); }
    }
    const activeAssignments = (work.assignments as DocumentData[]).filter(a => assertAssignmentRelease(a) === "active");
    for (const uid of new Set(activeAssignments.map(a => a.technicianId as string))) {
      if (users.has(uid)) continue;
      const profile = (await transaction.get(db.collection("users").doc(uid))).data();
      if (!profile || profile.role !== "technician" || profile.statusOperation !== null) fail("Assignment owner is missing or undergoing account cleanup.");
      users.set(uid, profile);
    }
    const carried = (work.tasks as DocumentData[]).filter(task => !["completed", "cancelled"].includes(task.status)).sort((a, b) => ordinalCompare(a.id, b.id));
    for (const task of carried) {
      if ((await transaction.get(handoverTaskTransfers.doc(createHandoverTaskTransferDocumentId(documentId, task.id)))).exists) {
        fail("Immutable task transfer evidence already exists.");
      }
    }
    const now = new Date(Math.max(Date.now(), ...[aggregate.updatedAt, outgoing.actualStart, outgoing.handoverStartedAt, control.updatedAt,
      ...currentMembers.map(member => member.joinedAt), ...(authorization ? [authorization.updatedAt] : [])].map(Date.parse))).toISOString();
    const observedWork = createHandoverWorkSnapshot(work);
    if (aggregate.workSnapshot.schema !== "handover-work-v2" || aggregate.workSnapshot.id !== observedWork.id || aggregate.workSnapshot.version !== observedWork.version) {
      const revised = reviseHandoverSnapshot(aggregate, { revision: aggregate.revision, snapshotHash: finalHash,
        recordedAt: now, workSnapshot: observedWork, temporaryAuthorization: aggregate.temporaryAuthorization });
      const hash = createHandoverSnapshot(revised).snapshotHash;
      const auditRef = db.collection("audit_logs").doc();
      // The only non-transfer mutation outcome. All transaction reads are done.
      transaction.set(handoverRef, revised);
      transaction.create(auditRef, { id: auditRef.id, action: "SHIFT_HANDOVER_SNAPSHOT_REVISED", actorUid, actorRole, outgoingShiftId,
        handoverDocumentId: documentId, previousRevision: aggregate.revision, newRevision: revised.revision,
        previousSnapshotHash: finalHash, newSnapshotHash: hash, previousWorkSnapshot: aggregate.workSnapshot,
        newWorkSnapshot: observedWork, recordedAt: now, createdAt: FieldValue.serverTimestamp() });
      return { status: "REVIEW_REQUIRED", handover: { revision: revised.revision, snapshotHash: hash } };
    }
    assertFormalTransferWorkReady(work, aggregate.workSnapshot);
    assertHandoverReadyForTransfer(aggregate, { revision: binding.expectedRevision, snapshotHash: binding.expectedSnapshotHash });
    const attendanceUids = assertIncomingHandoverActivation(aggregate);
    assertShiftActivationWindow(identity.scheduledStart, identity.scheduledEnd, new Date(now));
    validateShiftCompletionAttendance({ shiftId: outgoingShiftId, primaryTechnicianIds: identity.outgoingPrimaryTechnicianIds,
      completedAt: now, members: currentMembers, attendances: attendanceDocs.docs.map(doc => doc.data()), authorization });
    if (authorization && [...identity.outgoingPrimaryTechnicianIds, ...identity.incomingPrimaryTechnicianIds].includes(authorization.authorizedTechnicianUid)) {
      fail("Temporary authorization cannot occupy a permanent participant position.");
    }
    const after = transferOperationalShiftControl({ currentControl: control, outgoingShiftId, outgoingSlotToken: identity.outgoingSlotToken,
      outgoingGeneration: identity.outgoingGeneration, incomingShiftId: incomingId, successorSlotToken: identity.successorSlotToken,
      successorGeneration: identity.successorGeneration, transferTimestamp: now });
    const completed = completeHandoverTransfer(aggregate, { revision: aggregate.revision, snapshotHash: finalHash, recordedAt: now,
      actor: { uid: actorUid, authority: actorRole === "admin" ? "manager" : "supervisor" } });
    const plan: FormalHandoverTransferPlan = { writes: [] };
    function add(path: string, operation: "create" | "update" | "set", data: object, before?: DocumentData) {
      const patch = data as Record<string, unknown>;
      plan.writes.push({ path, operation, data: patch, document: before ? { ...before, ...patch } : patch });
    }
    add(`shifts/${outgoingShiftId}`, "update", { status: "completed", actualEnd: now, completedBy: actorUid,
      completedAt: FieldValue.serverTimestamp(), updatedAt: now }, outgoing);
    add(`shifts/${incomingId}`, "create", { id: incomingId, operationalSlotToken: identity.successorSlotToken,
      permanentPairId: identity.incomingPermanentPairId, shiftType: identity.shiftType, status: "active",
      scheduledStart: identity.scheduledStart, scheduledEnd: identity.scheduledEnd, actualStart: now, actualEnd: null,
      primaryTechnicianIds: identity.incomingPrimaryTechnicianIds, createdBy: actorUid, createdAt: now, updatedAt: now,
      startedBy: actorUid, startedAt: FieldValue.serverTimestamp(), previousShiftId: outgoingShiftId,
      previousOperationalSlotToken: identity.outgoingSlotToken, operationalGeneration: identity.successorGeneration, handoverDocumentId: documentId });
    for (const member of finalizeCurrentShiftMemberships({ shiftId: outgoingShiftId, completedAt: now, members: currentMembers })) {
      add(`shift_members/${member.id}`, "update", { leftAt: now }, currentMembers.find(previous => previous.id === member.id));
    }
    for (const uid of identity.incomingPrimaryTechnicianIds) add(`shift_members/${incomingId}_${uid}`, "create",
      { id: `${incomingId}_${uid}`, shiftId: incomingId, technicianId: uid, role: "primary", joinedAt: now, leftAt: null });
    for (const [uid, value] of schedules) {
      const incoming = identity.incomingPrimaryTechnicianIds.includes(uid);
      add(`technician_schedules/${uid}`, "update", { entries: incoming ? value.entries.map((entry: TechnicianScheduleEntry) =>
        entry.shiftId === incomingId ? { ...entry, status: "active" } : entry) : value.entries.filter((entry: TechnicianScheduleEntry) => entry.shiftId !== outgoingShiftId), updatedAt: now }, value);
    }
    add(`operational_shift_control/${GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID}`, "set", after);
    add(`handovers/${documentId}`, "set", completed);
    for (const uid of attendanceUids) add(`shift_attendance/${incomingId}_${uid}`, "create", createShiftAttendanceRecord({ shiftId: incomingId,
      technicianUid: uid, participationAuthority: "primary", authorizationId: null, recordedAt: now }));
    const releasedIds: string[] = [];
    const historyIds: string[] = [];
    // Membership/schedule mutations participate in the same account-operation
    // activity markers as ordinary activation and completion.
    const assignmentActivity = new Set<string>(requiredUsers);
    for (const task of carried) {
      const assignments = (work.assignments as DocumentData[]).filter(a => a.taskId === task.id).sort((a, b) => ordinalCompare(a.id, b.id));
      const released = assignments.filter(a => assertAssignmentRelease(a) === "active");
      const ids = released.map(a => a.id as string).sort(ordinalCompare);
      releasedIds.push(...ids);
      for (const assignment of released) {
        const patch = createHandoverAssignmentRelease(assignment as Parameters<typeof createHandoverAssignmentRelease>[0], now, actorUid);
        add(`task_assignments/${assignment.id}`, "update", patch, assignment);
        assignmentActivity.add(assignment.technicianId);
      }
      const id = createHandoverTaskTransferDocumentId(documentId, task.id);
      const disposition = work.dispositions.find(record => record.taskId === task.id)!;
      const evidence: HandoverTaskTransferEvidence = { id, schema: "handover-task-transfer-v1", taskId: task.id,
        outgoingShiftId, incomingShiftId: incomingId, handoverDocumentId: documentId, finalRevision: aggregate.revision,
        finalSnapshotHash: finalHash, workSnapshot: aggregate.workSnapshot, taskBeforeTransfer: task, disposition,
        assignmentEvidence: assignments, releasedAssignmentIds: ids, actorUid, actorRole, transferredAt: now,
        operationalControlBefore: control, operationalControlAfter: after };
      add(`handover_task_transfers/${id}`, "create", evidence); historyIds.push(id);
      add(`tasks/${task.id}`, "update", { shiftId: incomingId, updatedAt: now }, task);
    }
    for (const uid of new Set([actorUid, ...assignmentActivity])) {
      add(`users/${uid}`, "update", { ...(uid === actorUid ? { lastOperationalActivityAt: FieldValue.serverTimestamp() } : {}),
        ...(assignmentActivity.has(uid) ? { lastAssignmentActivityAt: FieldValue.serverTimestamp() } : {}) }, users.get(uid));
    }
    if (authorization) add(`next_shift_authorizations/${authorization.id}`, "update", completeConsumedNextShiftAuthorization({
      authorization, shiftId: outgoingShiftId, slotToken: identity.outgoingSlotToken, slotGeneration: identity.outgoingGeneration,
      permanentPairId: identity.outgoingPermanentPairId, completedAt: now }), authorization);
    const receipt: FormalHandoverTransferReceipt = createFormalHandoverTransferReceipt({ id: receiptId, schema: "formal-handover-transfer-v1", action: "SHIFT_HANDOVER_TRANSFERRED", outcome: "TRANSFERRED",
      handoverDocumentId: documentId, outgoingShiftId, incomingShiftId: incomingId, finalRevision: aggregate.revision, finalSnapshotHash: finalHash,
      actorUid, actorRole, transferredAt: now, reservation: aggregate.reservation, incomingAttendanceTechnicianIds: attendanceUids,
      taskTransferIds: historyIds.sort(ordinalCompare), releasedAssignmentIds: releasedIds.sort(ordinalCompare),
      operationalControlBefore: control, operationalControlAfter: after });
    assertFormalHandoverTransferReceipt(receipt, completed, documentId);
    add(`audit_logs/${receiptId}`, "create", receipt);
    plan.writes.sort((a, b) => ordinalCompare(a.path, b.path));
    assertFormalHandoverTransferCapacity(plan);
    // Final execution phase: one bounded plan, no helper writes or further reads.
    for (const write of plan.writes) {
      const ref = db.doc(write.path);
      if (write.operation === "create") transaction.create(ref, write.data);
      else if (write.operation === "update") transaction.update(ref, write.data);
      else transaction.set(ref, write.data);
    }
    return { status: "TRANSFERRED", receipt };
  });
}
