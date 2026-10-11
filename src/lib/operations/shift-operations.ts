import "server-only";
import { randomUUID } from "node:crypto";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import type { AppUser } from "@/types/auth";
import { DEFAULT_BROADCAST_STATIONS, type ShiftOperationEvent } from "@/types/shift-operations";
import { getOperationalCollections } from "./collections";
import { evaluateAssignmentEligibility } from "./assignment-eligibility";
import { requireEligibleAssignmentShift } from "./assignment-shift-eligibility";
import { assertOperationalShiftControl, assertShiftOwnsOperationalSlot } from "./operational-shift-control-state";
import { createNextShiftAuthorizationDocumentId, readActivePermanentPairTechnicianIds } from "./next-shift-authorization-domain";
import { resolveTechnicianCurrentShift } from "./technician-current-shift-domain";
import { assembleShiftOperations, operationIdentifier, parseOperation, ShiftOperationsError } from "./shift-operations-domain";

export async function readOperationStations(transaction: Transaction) {
  const { db } = getOperationalCollections();
  const result = await transaction.get(db.collection("broadcast_stations"));
  if (result.empty) return DEFAULT_BROADCAST_STATIONS.map(item => ({...item}));
  const stations = result.docs.map(doc => {
    const item = doc.data(); operationIdentifier(doc.id);
    if (item.id !== doc.id || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 || typeof item.enabled !== "boolean") {
      throw new ShiftOperationsError("Station configuration requires administrator review.", 409);
    }
    return { id: doc.id, name: item.name, enabled: item.enabled };
  }).filter(item => item.enabled).map(({id,name}) => ({id,name})).sort((a,b) => a.id.localeCompare(b.id));
  if (stations.length === 0 || stations.length > 30) throw new ShiftOperationsError("Configure between 1 and 30 broadcast stations.",409);
  return stations;
}

export async function requireOperationsScope(transaction: Transaction, actor: AppUser, shiftId: string, write: boolean) {
  operationIdentifier(shiftId); operationIdentifier(actor.uid);
  const { db, shifts, operationalShiftControl, technicianPairs, technicianPairMemberships, nextShiftAuthorizations, shiftAttendance } = getOperationalCollections();
  const [profileDoc, shiftDoc] = await Promise.all([transaction.get(db.collection("users").doc(actor.uid)), transaction.get(shifts.doc(shiftId))]);
  const profile = profileDoc.data(), shift = shiftDoc.data();
  if (!profileDoc.exists || !profile || profile.role !== actor.role || profile.status !== "active" || profile.mustChangePassword !== false || profile.statusOperation != null) {
    throw new ShiftOperationsError("Your account is not eligible to access shift operations.",403);
  }
  if (!shiftDoc.exists || !shift || shift.id !== shiftId) throw new ShiftOperationsError("The shift was not found.",404);
  if (!write && ["admin", "supervisor"].includes(profile.role)) return { shift, profile };
  if (!evaluateAssignmentEligibility(profile).eligible || profile.role !== "technician") throw new ShiftOperationsError("Only current technicians may record shift operations.",403);
  if (write && shift.status !== "active") throw new ShiftOperationsError("Records are locked once handover begins. Only an active shift accepts records.",409);
  const controlDoc = await transaction.get(operationalShiftControl.doc("global"));
  const control = assertOperationalShiftControl(controlDoc.data());
  try { assertShiftOwnsOperationalSlot(control,shiftId,shift.operationalSlotToken,shift.status); }
  catch { throw new ShiftOperationsError("The selected shift is not the current operational shift.",403); }
  if (control.shiftId !== shiftId) throw new ShiftOperationsError("You cannot access an unrelated shift.",403);
  const pairDoc = await transaction.get(technicianPairs.doc(shift.permanentPairId));
  const ids = readActivePermanentPairTechnicianIds(pairDoc.data(),shift.permanentPairId);
  const authorizationId = createNextShiftAuthorizationDocumentId(shift.permanentPairId,control.generation,control.slotToken);
  const [first,second,authorization,attendance] = await Promise.all([
    transaction.get(technicianPairMemberships.doc(ids[0])), transaction.get(technicianPairMemberships.doc(ids[1])),
    transaction.get(nextShiftAuthorizations.doc(authorizationId)), transaction.get(shiftAttendance.doc(`${shiftId}_${actor.uid}`)),
  ]);
  const current = resolveTechnicianCurrentShift({technicianUid: actor.uid, control, shift, permanentPair: pairDoc.data(),
    pairMemberships: [first.data() ?? null, second.data() ?? null], authorizationDocumentId: authorization.exists ? authorization.id : null,
    authorization: authorization.data() ?? null, attendanceDocumentId: attendance.exists ? attendance.id : null, attendance: attendance.data() ?? null });
  if (!current || current.id !== shiftId || !current.joinedAt || !current.attendance || current.attendance.clockOut !== null) {
    throw new ShiftOperationsError("Join your current shift before recording operations.",403);
  }
  // Reuse the existing scheduling and current membership checks. Handover reads
  // are permitted by the current-shift resolver, but all writes require active.
  if (write) await requireEligibleAssignmentShift(transaction,shiftId,actor.uid);
  return { shift, profile };
}

export async function readShiftOperationEvents(transaction: Transaction, shiftId: string) {
  const { db } = getOperationalCollections();
  const documents = await transaction.get(db.collection("shift_operation_events").where("shiftId","==",shiftId));
  return documents.docs.map(doc => {
    const event = doc.data() as ShiftOperationEvent;
    if (event.id !== doc.id || event.shiftId !== shiftId || event.provenance !== "authenticated_technician") throw new ShiftOperationsError("Operational provenance requires administrator review.",409);
    return event;
  });
}

export async function getShiftOperations(actor: AppUser, shiftId: string) {
  const {db}=getOperationalCollections();
  return db.runTransaction(async transaction => {
    const {shift}=await requireOperationsScope(transaction,actor,shiftId,false);
    const stations=await readOperationStations(transaction), events=await readShiftOperationEvents(transaction,shiftId);
    return assembleShiftOperations(shiftId,actor.role === "technician" && shift.status === "active",stations,events);
  });
}

export async function recordShiftOperation(actor: AppUser, shiftId: string, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ShiftOperationsError("Provide record details.");
  const data=body as Record<string,unknown>;
  if (Object.keys(data).some(key=>!["details","recordId","expectedRevision"].includes(key))) throw new ShiftOperationsError("Unsupported request fields.");
  const updating=data.recordId !== null && data.recordId !== undefined;
  if (updating) operationIdentifier(data.recordId);
  if (updating && (!Number.isSafeInteger(data.expectedRevision) || (data.expectedRevision as number)<1)) throw new ShiftOperationsError("Provide the record revision you reviewed.");
  if (!updating && data.expectedRevision != null) throw new ShiftOperationsError("A new record does not have a reviewed revision.");
  const {db,shifts,tasks}=getOperationalCollections(), recordId=updating ? data.recordId as string : randomUUID(), eventId=randomUUID();
  const headRef=db.collection("shift_operation_heads").doc(recordId), eventRef=db.collection("shift_operation_events").doc(eventId);
  return db.runTransaction(async transaction => {
    const {shift,profile}=await requireOperationsScope(transaction,actor,shiftId,true);
    const now=new Date().toISOString(),stations=await readOperationStations(transaction);
    const details=parseOperation(data.details,stations,now);
    if (Date.parse(details.occurredAt)<Date.parse(shift.actualStart)) throw new ShiftOperationsError("The observation/report time must be within this shift.");
    const previousDoc=await transaction.get(headRef),previous=previousDoc.data() as ShiftOperationEvent|undefined;
    if (updating) {
      if (!previousDoc.exists || !previous || previous.recordId !== recordId || previous.shiftId !== shiftId) throw new ShiftOperationsError("This record does not belong to the current shift.",403);
      if (previous.revision !== data.expectedRevision) throw new ShiftOperationsError("Another technician updated this record. Reload and review their action before saving.",409);
      if (!["incident","outside_broadcast"].includes(details.kind) || details.kind !== previous.kind) throw new ShiftOperationsError("Only incidents and outside broadcasts accept chronological updates.");
      if (details.occurredAt !== previous.occurredAt) throw new ShiftOperationsError("Updates must retain the original report/start time.");
    } else if (previousDoc.exists) throw new ShiftOperationsError("Record identity collision. Retry saving.",409);
    if ("linkedTaskId" in details && details.linkedTaskId) {
      const linked=await transaction.get(tasks.doc(details.linkedTaskId));
      if (!linked.exists || linked.data()?.id !== linked.id || linked.data()?.shiftId !== shiftId) throw new ShiftOperationsError("Link an existing task from this shift.");
    }
    // Shift and account reads serialize against handover and account blocking.
    // All reads above precede every write; immutable events preserve authorship.
    const event:ShiftOperationEvent={...details,id:eventId,recordId,shiftId,revision:(previous?.revision ?? 0)+1,
      authorUid:actor.uid,authorName:profile.fullName,originalReporterUid:previous?.originalReporterUid ?? actor.uid,
      originalReporterName:previous?.originalReporterName ?? profile.fullName,createdAt:now,provenance:"authenticated_technician"};
    transaction.create(eventRef,event);
    transaction.set(headRef,event);
    transaction.update(shifts.doc(shiftId),{operationsUpdatedAt:FieldValue.serverTimestamp()});
    transaction.update(db.collection("users").doc(actor.uid),{lastOperationsActivityAt:FieldValue.serverTimestamp()});
    transaction.create(db.collection("audit_logs").doc(eventId),{id:eventId,action:"SHIFT_OPERATION_RECORDED",actorUid:actor.uid,shiftId,recordId,eventId,revision:event.revision,recordedAt:now,serverRecordedAt:FieldValue.serverTimestamp()});
    return event;
  });
}
