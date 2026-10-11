import "server-only";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import type { AppUser } from "@/types/auth";
import type { FrozenHandoverReport } from "@/types/handover-report";
import type { FormalHandoverTransferPlan } from "@/types/handover-transfer";
import { getOperationalCollections } from "./collections";
import { assertHandoverAggregate,createHandoverDocumentId,createHandoverSnapshot,reviseHandoverReportSnapshot } from "./handover-domain";
import { readHandoverReportContent,requireReportReader } from "./handover-report";
import { digestHandoverReport } from "./handover-report-domain";
import { ShiftOperationsError,operationIdentifier } from "./shift-operations-domain";
import { estimateTransferDocumentBytes,assertFormalHandoverTransferCapacity } from "./handover-transfer-domain";

export async function freezeHandoverReport(actor:AppUser,shiftId:string,body:unknown){
  operationIdentifier(shiftId);
  if(actor.role!=="admin"&&actor.role!=="supervisor")throw new ShiftOperationsError("Only supervisors can freeze or revise a report.",403);
  if(!body||typeof body!=="object"||Array.isArray(body))throw new ShiftOperationsError("Provide the reviewed report revision.");
  const data=body as Record<string,unknown>;
  if(Object.keys(data).some(key=>!["expectedRevision","expectedSnapshotHash","reason","correctionNote"].includes(key))||!Number.isSafeInteger(data.expectedRevision)||
    typeof data.expectedSnapshotHash!=="string"||!/^[0-9a-f]{64}$/.test(data.expectedSnapshotHash)||typeof data.reason!=="string"||!data.reason.trim()||data.reason.length>2000||
    (data.correctionNote!==undefined&&(typeof data.correctionNote!=="string"||!data.correctionNote.trim()||data.correctionNote.length>5000)))throw new ShiftOperationsError("Provide a reviewed revision, snapshot hash, and reason. Corrections require a non-empty note.");
  const {db,handovers,shifts}=getOperationalCollections(),handoverRef=handovers.doc(createHandoverDocumentId(shiftId));
  const id=`report_${randomUUID()}`,reportRef=db.collection("handover_reports").doc(id),auditRef=db.collection("audit_logs").doc();
  return db.runTransaction(async transaction=>{
    const doc=await transaction.get(handoverRef),aggregate=assertHandoverAggregate(doc.data());
    await requireReportReader(transaction,actor,shiftId,aggregate);
    const shift=(await transaction.get(shifts.doc(shiftId))).data();
    if(shift?.id!==shiftId||shift.status!=="handover_pending"||aggregate.lifecycleStatus!=="collecting_confirmations"||aggregate.identity.outgoingShiftId!==shiftId||
      aggregate.revision!==data.expectedRevision||createHandoverSnapshot(aggregate).snapshotHash!==data.expectedSnapshotHash)throw new ShiftOperationsError("Stale or closed handover. Reload before freezing the report.",409);
    const content=await readHandoverReportContent(transaction,shiftId,aggregate);
    if(content.completeness.blockers.length)throw new ShiftOperationsError(`Report is incomplete: ${content.completeness.blockers.join("; ")}`,409);
    const now=new Date(Math.max(Date.now(),Date.parse(aggregate.updatedAt))).toISOString();
    const correction=data.correctionNote?{id:randomUUID(),note:(data.correctionNote as string).trim(),recordedBy:actor.uid,recordedAt:now}:null;
    if(correction){content.corrections.push(correction);content.corrections.sort((a,b)=>a.recordedAt<b.recordedAt?-1:a.recordedAt>b.recordedAt?1:a.id<b.id?-1:a.id>b.id?1:0);}
    const digest=digestHandoverReport(content),revised=reviseHandoverReportSnapshot(aggregate,{revision:aggregate.revision,snapshotHash:data.expectedSnapshotHash as string,recordedAt:now,workSnapshot:content.workSnapshot,reportBinding:{schema:"handover-report-v1",id,digest}});
    const frozen:FrozenHandoverReport={id,schema:"handover-report-v1",outgoingShiftId:shiftId,digest,content,frozenBy:actor.uid,frozenAt:now,reason:(data.reason as string).trim(),reviewedRevision:revised.revision};
    const audit={id:auditRef.id,action:"SHIFT_HANDOVER_REPORT_FROZEN",outgoingShiftId:shiftId,actorUid:actor.uid,previousRevision:aggregate.revision,newRevision:revised.revision,
      previousAggregate:aggregate,reportBinding:revised.reportBinding,reason:frozen.reason,recordedAt:now,serverRecordedAt:FieldValue.serverTimestamp()};
    // The immutable report has an independent document budget; it never inflates
    // the atomic transfer write plan with a duplicate mutable operational store.
    if(estimateTransferDocumentBytes(reportRef.path,frozen)>786432)throw new ShiftOperationsError("Report exceeds the safe document capacity. Request administrator review; evidence will not be truncated.",409);
    const actorRef=db.collection("users").doc(actor.uid),actorDoc=await transaction.get(actorRef),actorPatch={lastOperationalActivityAt:FieldValue.serverTimestamp()};
    const writes:FormalHandoverTransferPlan["writes"]=[{path:reportRef.path,operation:"create",data:{...frozen},document:{...frozen}},{path:handoverRef.path,operation:"set",data:{...revised},document:{...revised}},{path:auditRef.path,operation:"create",data:audit,document:audit},{path:actorRef.path,operation:"update",data:actorPatch,document:{...actorDoc.data(),...actorPatch}}];
    if(correction){const record={...correction,outgoingShiftId:shiftId};writes.push({path:db.collection("handover_report_corrections").doc(correction.id).path,operation:"create",data:record,document:record});}
    assertFormalHandoverTransferCapacity({writes});
    transaction.create(reportRef,frozen);transaction.set(handoverRef,revised);transaction.create(auditRef,audit);
    if(correction)transaction.create(db.collection("handover_report_corrections").doc(correction.id),{...correction,outgoingShiftId:shiftId});
    transaction.update(actorRef,actorPatch);
    return {revision:revised.revision,snapshotHash:createHandoverSnapshot(revised).snapshotHash,reportBinding:revised.reportBinding};
  });
}
