import "server-only";
import type { Transaction } from "firebase-admin/firestore";
import type { AppUser } from "@/types/auth";
import type { HandoverAggregate } from "@/types/handover";
import type { HandoverReportContent, HandoverReportView } from "@/types/handover-report";
import type { Task,TaskAssignment } from "@/types/task";
import type { Shift } from "@/types/shift";
import { getOperationalCollections } from "./collections";
import { assertHandoverAggregate,createHandoverDocumentId,createHandoverSnapshot,resolveHandoverParticipants } from "./handover-domain";
import { createFormalHandoverTransferReceiptId } from "./handover-transfer-domain";
import { readAttendanceRecord } from "./attendance-read-domain";
import { assembleShiftOperations,operationIdentifier,ShiftOperationsError } from "./shift-operations-domain";
import { readOperationStations,readShiftOperationEvents,requireOperationsScope } from "./shift-operations";
import { readAuthoritativeHandoverWorkState } from "./formal-handover";
import { createHandoverWorkSnapshot,resolveHandoverWorkReadiness } from "./handover-work-snapshot";

export async function requireReportReader(transaction:Transaction,actor:AppUser,shiftId:string,aggregate:HandoverAggregate|null){
  const {db}=getOperationalCollections();operationIdentifier(actor.uid);
  const profile=(await transaction.get(db.collection("users").doc(actor.uid))).data();
  if(!profile||profile.role!==actor.role||profile.status!=="active"||profile.mustChangePassword!==false||profile.statusOperation!=null)throw new ShiftOperationsError("Your account cannot access this report.",403);
  if(["admin","supervisor"].includes(profile.role))return;
  if(actor.role!=="technician")throw new ShiftOperationsError("Report access denied.",403);
  if(aggregate&&[...aggregate.identity.outgoingPrimaryTechnicianIds,...aggregate.identity.incomingPrimaryTechnicianIds].includes(actor.uid))return;
  await requireOperationsScope(transaction,actor,shiftId,false);
}

export async function readHandoverReportContent(transaction:Transaction,shiftId:string,aggregate:HandoverAggregate|null):Promise<HandoverReportContent>{
  const {db,shifts,shiftAttendance}=getOperationalCollections();
  const shiftDoc=await transaction.get(shifts.doc(shiftId)),shift=shiftDoc.data() as Shift|undefined;
  if(!shift||shift.id!==shiftId||shift.primaryTechnicianIds.length!==2)throw new ShiftOperationsError("Authoritative shift information is unavailable.",409);
  const incomingIds=aggregate?.identity.incomingPrimaryTechnicianIds??[];
  const people=new Map<string,string|null>();
  for(const uid of [...shift.primaryTechnicianIds,...incomingIds]){
    const profile=(await transaction.get(db.collection("users").doc(uid))).data();
    people.set(uid,typeof profile?.fullName==="string"&&profile.fullName.trim()?profile.fullName:null);
  }
  const attendance=[];
  for(const uid of shift.primaryTechnicianIds){
    const doc=await transaction.get(shiftAttendance.doc(`${shiftId}_${uid}`));
    const evidence=doc.exists?readAttendanceRecord(doc.id,doc.data()):null;
    attendance.push({uid,name:people.get(uid)??null,evidence,reportingTime:evidence?.recordedAt??null,
      hoursWorked:evidence?.clockIn&&evidence.clockOut?(Date.parse(evidence.clockOut)-Date.parse(evidence.clockIn))/3600000:null,lateReason:null});
  }
  const stations=await readOperationStations(transaction),events=await readShiftOperationEvents(transaction,shiftId);
  const operations=assembleShiftOperations(shiftId,false,stations,events);
  const work=await readAuthoritativeHandoverWorkState(transaction,shiftId);
  const workSnapshot=createHandoverWorkSnapshot(work),readiness=resolveHandoverWorkReadiness(work);
  const pendingTasks=(work.tasks as Task[]).filter(task=>!["completed","cancelled"].includes(task.status)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(task=>{
    const disposition=work.dispositions.find(item=>item.taskId===task.id);
    return {id:task.id,title:task.title,priority:task.priority,status:task.status,
      assignments:(work.assignments as TaskAssignment[]).filter(item=>item.taskId===task.id).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(item=>({id:item.id,technicianUid:item.technicianId,responsibility:item.responsibility,acceptance:item.acceptanceStatus,responsibilityStatus:item.responsibilityStatus??"active"})),
      disposition:disposition?.disposition??"unclassified",reason:disposition?.reason??null,
      carryForwardEligible:disposition?.disposition==="carry_forward"&&!readiness.blockers.some(item=>item.taskId===task.id)};
  });
  const blockers=operations.completeness.broadcastMissing.map(name=>`Missing verified broadcast observation: ${name}`);
  if(["missing","conflicting"].includes(operations.completeness.outsideBroadcast))blockers.push(`Outside broadcast information is ${operations.completeness.outsideBroadcast}.`);
  for(const item of readiness.blockers)blockers.push(`Pending task ${item.taskId}: ${item.reason.replaceAll("_"," ")}`);
  const warnings=[];
  if(operations.latest.every(item=>item.kind!=="incident"))warnings.push("No fault or technical activity records were submitted. This is not a declaration of no faults.");
  for(const row of attendance){if(!row.evidence)warnings.push(`Attendance missing: ${row.name??row.uid}`);if(row.hoursWorked===null)warnings.push(`Hours worked cannot be determined: ${row.name??row.uid}`);}
  if([...people.values()].some(name=>name===null))warnings.push("One or more staff names are missing from authoritative account profiles.");
  if(!aggregate)warnings.push("Incoming permanent pair has not been reserved.");
  return {schema:"handover-report-v1",staff:{shiftId,shiftDate:shift.scheduledStart.slice(0,10),shiftType:shift.shiftType,
    scheduledStart:shift.scheduledStart,scheduledEnd:shift.scheduledEnd,actualStart:shift.actualStart,
    engineeringLocation:typeof shiftDoc.data()?.engineeringLocation==="string"?shiftDoc.data()!.engineeringLocation:null,
    outgoing:shift.primaryTechnicianIds.map(uid=>({uid,name:people.get(uid)??null})),incoming:incomingIds.map(uid=>({uid,name:people.get(uid)??null})),
    incomingShiftId:aggregate?.reservation.reservedIncomingShiftId??null,handoverStartedAt:typeof shiftDoc.data()?.handoverStartedAt==="string"?shiftDoc.data()!.handoverStartedAt:null},
    attendance,operations,pendingTasks,workSnapshot,completeness:{blockers,warnings}};
}

export async function getHandoverReport(actor:AppUser,shiftId:string):Promise<HandoverReportView>{
  operationIdentifier(shiftId);const {db,handovers}=getOperationalCollections();
  return db.runTransaction(async transaction=>{
    const doc=await transaction.get(handovers.doc(createHandoverDocumentId(shiftId))),aggregate=doc.exists?assertHandoverAggregate(doc.data()):null;
    await requireReportReader(transaction,actor,shiftId,aggregate);
    const content=await readHandoverReportContent(transaction,shiftId,aggregate);
    const receipt=aggregate?.lifecycleStatus==="completed"?(await transaction.get(db.collection("audit_logs").doc(createFormalHandoverTransferReceiptId(doc.id)))).data()??null:null;
    return {content,handover:aggregate,participants:aggregate?resolveHandoverParticipants(aggregate):[],snapshotHash:aggregate?createHandoverSnapshot(aggregate).snapshotHash:null,receipt,frozen:false};
  });
}
