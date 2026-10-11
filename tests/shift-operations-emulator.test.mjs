import test from "node:test";
import assert from "node:assert/strict";
import { fixtureRecords, modules } from "./formal-handover-transfer-fixtures.mjs";
const project="demo-shiftchange-handover-transfer",host=process.env.FIRESTORE_EMULATOR_HOST;
if(host!=="127.0.0.1:8088" || ["FIREBASE_PROJECT_ID","NEXT_PUBLIC_FIREBASE_PROJECT_ID","GCLOUD_PROJECT","GOOGLE_CLOUD_PROJECT"].some(key=>process.env[key]!==project))throw new Error("Refusing non-demo emulator execution.");
const {getAdminFirestore}=await import("../src/lib/firebase/admin/index.ts");
const {recordShiftOperation:save,getShiftOperations:read}=await import("../src/lib/operations/shift-operations.ts");
const {getHandoverReport:report}=await import("../src/lib/operations/handover-report.ts");
const {getHandoverWorkspace:workspace}=await import("../src/lib/operations/handover-workspace.ts");
const {getDashboardOverview:overview}=await import("../src/lib/operations/dashboard-overview.ts");
const {freezeHandoverReport:freeze}=await import("../src/lib/operations/freeze-handover-report.ts");
const {persistFormalHandoverConfirmation:confirm}=await import("../src/lib/operations/formal-handover-confirmation.ts");
const {persistFormalHandoverTransfer:transfer}=await import("../src/lib/operations/formal-handover-transfer.ts");
const {createHandoverSnapshot:snapshot,assertHandoverAggregate}=await import("../src/lib/operations/handover-domain.ts");
const db=getAdminFirestore();
const actor=uid=>({uid,role:"technician",status:"active",mustChangePassword:false,fullName:uid,email:`${uid}@demo.invalid`});
async function fixture({temporary=false}={}){
 const clear=await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,{method:"DELETE"});assert.equal(clear.status,200);
 const load=modules(),f=fixtureRecords(load,temporary?{c:"joined"}:{});
 f.shift.status="active";delete f.shift.handoverStartedAt;f.records.set("shifts/outgoing",f.shift);
 f.records.get("operational_shift_control/global").shiftStatus="active";
 f.records.delete("handovers/handover_outgoing");
 for(const [path,record] of f.records){if(path.startsWith("users/"))record.fullName=record.uid;if(path.startsWith("technician_schedules/"))for(const entry of record.entries)if(entry.shiftId==="outgoing")entry.status="active";}
 for(const uid of f.out)f.records.set(`shift_attendance/outgoing_${uid}`,load("lib/operations/shift-join-domain").createShiftAttendanceRecord({shiftId:"outgoing",technicianUid:uid,participationAuthority:"primary",authorizationId:null,recordedAt:f.shift.actualStart}));
 const batch=db.batch();for(const [path,record]of f.records)batch.set(db.doc(path),record);await batch.commit();return f;
}
const observation=(stationId="joy-fm",status="on_air")=>({kind:"broadcast",stationId,status,occurredAt:new Date().toISOString(),remarks:"Verified actual audio"});
const incident=()=>({kind:"incident",category:"fault",title:"Studio codec degraded",description:"Intermittent link drops",occurredAt:new Date().toISOString(),location:"Joy FM codec",actionTaken:"Checked cables",status:"investigating",severity:"high",linkedTaskId:"task-0"});
const ob=()=>({kind:"outside_broadcast",title:"Community event",location:"Accra",occurredAt:new Date().toISOString(),runningStatus:"running",technicalIssues:"Backup uplink required",actionTaken:"Backup enabled",status:"monitoring",remarks:"Producer notified",linkedTaskId:null});
async function events(){return (await db.collection("shift_operation_events").get()).docs.map(doc=>doc.data());}
test("both permanent technicians contribute; missing observations are unverified",async()=>{await fixture();await save(actor("out-a"),"outgoing",{details:observation()});await save(actor("out-b"),"outgoing",{details:ob()});const view=await read(actor("out-a"),"outgoing");assert.equal(view.events.length,2);assert.equal(view.completeness.broadcastMissing.length,3);assert.equal(view.completeness.outsideBroadcast,"recorded");assert.deepEqual(new Set(view.events.map(event=>event.authorUid)),new Set(["out-a","out-b"]));});
for(const status of ["blocked","revoked"])test(`${status} account is denied without operational writes`,async()=>{await fixture();await db.doc("users/out-a").update({status});await assert.rejects(()=>save(actor("out-a"),"outgoing",{details:observation()}));assert.equal((await events()).length,0);});
test("unrelated technician and other shift access are denied",async()=>{await fixture();await assert.rejects(()=>save(actor("in-a"),"outgoing",{details:observation()}));await assert.rejects(()=>save(actor("out-a"),"incoming",{details:observation()}));assert.equal((await events()).length,0);});
test("missing attendance and departed membership are denied",async()=>{await fixture();await db.doc("shift_attendance/outgoing_out-a").delete();await assert.rejects(()=>save(actor("out-a"),"outgoing",{details:observation()}));await db.doc("shift_members/outgoing_out-b").update({leftAt:new Date().toISOString()});await assert.rejects(()=>save(actor("out-b"),"outgoing",{details:observation()}));assert.equal((await events()).length,0);});
test("append-only incident actions retain original reporter and reject stale revisions",async()=>{await fixture();const original=await save(actor("out-a"),"outgoing",{details:incident()});const next=await save(actor("out-b"),"outgoing",{recordId:original.recordId,expectedRevision:1,details:{...incident(),occurredAt:original.occurredAt,actionTaken:"Replaced patch lead",status:"monitoring"}});assert.equal(next.originalReporterUid,"out-a");assert.equal(next.authorUid,"out-b");assert.equal(next.revision,2);assert.equal((await db.doc(`shift_operation_events/${original.id}`).get()).data().actionTaken,"Checked cables");await assert.rejects(()=>save(actor("out-a"),"outgoing",{recordId:original.recordId,expectedRevision:1,details:incident()}));assert.equal((await events()).length,2);});
test("real concurrent actions allow one reviewed revision to win",async()=>{await fixture();const original=await save(actor("out-a"),"outgoing",{details:incident()});const result=await Promise.allSettled(["out-a","out-b"].map(uid=>save(actor(uid),"outgoing",{recordId:original.recordId,expectedRevision:1,details:{...incident(),occurredAt:original.occurredAt,actionTaken:`Action by ${uid}`}})));assert.equal(result.filter(item=>item.status==="fulfilled").length,1);assert.equal(result.filter(item=>item.status==="rejected").length,1);const view=await read(actor("out-b"),"outgoing");assert.equal(view.latest.length,1);assert.equal(view.events.length,2);});
test("no-OB declaration differs from missing information",async()=>{await fixture();assert.equal((await read(actor("out-a"),"outgoing")).completeness.outsideBroadcast,"missing");await save(actor("out-b"),"outgoing",{details:{kind:"no_ob",occurredAt:new Date().toISOString(),remarks:"No outside broadcasts during this shift"}});assert.equal((await read(actor("out-a"),"outgoing")).completeness.outsideBroadcast,"declared_none");});
test("handover status locks all operation writes",async()=>{await fixture();await db.doc("shifts/outgoing").update({status:"handover_pending"});await assert.rejects(()=>save(actor("out-a"),"outgoing",{details:observation()}));assert.equal((await events()).length,0);});
test("temporary technician retains temporary authority and requires consumed authorization",async()=>{await fixture({temporary:true});await save(actor("c"),"outgoing",{details:observation()});assert.equal((await db.doc("shift_members/outgoing_c").get()).data().role,"additional");const auth=(await db.collection("next_shift_authorizations").get()).docs[0];await auth.ref.update({status:"revoked"});await assert.rejects(()=>save(actor("c"),"outgoing",{details:observation()}));assert.equal((await events()).length,1);});
test("task links must belong to the authoritative shift",async()=>{await fixture();await db.doc("tasks/task-0").update({shiftId:"incoming"});await assert.rejects(()=>save(actor("out-a"),"outgoing",{details:incident()}));assert.equal((await events()).length,0);});
test("station configuration controls accepted observations",async()=>{await fixture();await db.doc("broadcast_stations/extra").set({id:"extra",name:"New station",enabled:true});await save(actor("out-a"),"outgoing",{details:observation("extra")});await assert.rejects(()=>save(actor("out-a"),"outgoing",{details:observation("joy-fm")}));assert.equal((await read(actor("out-a"),"outgoing")).stations.length,1);});
test("direct unauthenticated client writes remain denied by real rules",async()=>{await fixture();const result=await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents/shift_operation_events/client-spoof`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({fields:{shiftId:{stringValue:"outgoing"}}})});assert.equal(result.status,403);assert.equal((await events()).length,0);});
test("consolidated report includes both authors, missing information and real attendance",async()=>{const f=await fixture();for(const disposition of f.dispositions)await db.doc(`handover_task_dispositions/${disposition.id}`).delete();await save(actor("out-a"),"outgoing",{details:observation()});const original=await save(actor("out-a"),"outgoing",{details:incident()});await save(actor("out-b"),"outgoing",{recordId:original.recordId,expectedRevision:1,details:{...incident(),occurredAt:original.occurredAt,actionTaken:"Checked backup",status:"monitoring"}});await save(actor("out-b"),"outgoing",{details:ob()});const result=await report(actor("out-a"),"outgoing");assert.equal(result.content.operations.events.length,4);assert.equal(result.content.operations.latest.filter(event=>event.kind==="incident").length,1);assert.equal(result.content.attendance.length,2);assert.ok(result.content.attendance.every(row=>row.reportingTime&&row.evidence.clockIn===null&&row.hoursWorked===null));assert.equal(result.content.pendingTasks[0].id,"task-0");assert.equal(result.content.pendingTasks[0].disposition,"unclassified");assert.equal(result.content.completeness.blockers.filter(item=>item.startsWith("Missing verified")).length,3);assert.equal(result.frozen,false);});
test("reserved incoming participants can review; unrelated and blocked users cannot",async()=>{const f=await fixture();await assert.rejects(()=>report(actor("in-a"),"outgoing"));await db.doc("handovers/handover_outgoing").set(f.aggregate);const result=await report(actor("in-a"),"outgoing");assert.equal(result.content.staff.incoming.length,2);assert.equal(result.content.staff.incomingShiftId,"incoming");await assert.rejects(()=>report(actor("c"),"outgoing"));await db.doc("users/in-a").update({status:"blocked"});await assert.rejects(()=>report(actor("in-a"),"outgoing"));});
test("report source ordering is stable and reads do not mutate work or assignments",async()=>{const f=await fixture();await db.doc("handovers/handover_outgoing").set(f.aggregate);const before=(await db.doc("task_assignments/task-0_out-a").get()).data();const first=await report(actor("out-a"),"outgoing"),second=await report(actor("out-b"),"outgoing");assert.deepEqual(first.content,second.content);assert.deepEqual((await db.doc("task_assignments/task-0_out-a").get()).data(),before);assert.equal(first.content.workSnapshot.schema,"handover-work-v2");});
const manager={...actor("manager"),role:"admin"};
async function preparedReport({complete=true}={}){
 const f=await fixture();
 if(complete){for(const station of ["joy-fm","adom-fm","asempa-fm","hitz-fm"])await save(actor("out-a"),"outgoing",{details:observation(station)});await save(actor("out-b"),"outgoing",{details:ob()});await save(actor("out-a"),"outgoing",{details:incident()});}
 const aggregate={...f.aggregate,confirmations:[],reportBinding:null};
 const batch=db.batch();batch.set(db.doc("handovers/handover_outgoing"),aggregate);batch.update(db.doc("shifts/outgoing"),{status:"handover_pending",handoverStartedAt:f.at});batch.update(db.doc("operational_shift_control/global"),{shiftStatus:"handover_pending"});
 for(const uid of f.out){const schedule=(await db.doc(`technician_schedules/${uid}`).get()).data();schedule.entries[0].status="handover_pending";batch.set(db.doc(`technician_schedules/${uid}`),schedule);}await batch.commit();return f;
}
async function reviewed(){const aggregate=assertHandoverAggregate((await db.doc("handovers/handover_outgoing").get()).data());return {aggregate,expectedRevision:aggregate.revision,expectedSnapshotHash:snapshot(aggregate).snapshotHash};}
async function freezeCurrent(extra={}){const {expectedRevision,expectedSnapshotHash}=await reviewed();return freeze(manager,"outgoing",{expectedRevision,expectedSnapshotHash,reason:"Reviewed outgoing report",...extra});}
async function confirmCurrent(uid){const {expectedRevision,expectedSnapshotHash}=await reviewed();return confirm({outgoingShiftId:"outgoing",actorUid:uid,expectedRevision,expectedSnapshotHash});}
async function transferCurrent(){const {expectedRevision,expectedSnapshotHash}=await reviewed();return transfer({outgoingShiftId:"outgoing",actorUid:"manager",actorRole:"admin",expectedRevision,expectedSnapshotHash});}
test("new handovers cannot confirm before a complete report freeze",async()=>{await preparedReport({complete:false});await assert.rejects(()=>confirmCurrent("out-a"),/Freeze and review/);await assert.rejects(()=>freezeCurrent(),/incomplete/);assert.equal((await db.collection("handover_reports").get()).size,0);});
test("frozen report binds all four confirmations and atomic transfer; completed report survives task movement and replay",async()=>{
 await preparedReport();const binding=await freezeCurrent();assert.equal(binding.reportBinding.schema,"handover-report-v1");
 for(const uid of ["out-a","out-b","in-a","in-b"])assert.equal((await confirmCurrent(uid)).status,"CONFIRMED");
 const before=await report(actor("in-a"),"outgoing"),result=await transferCurrent();assert.equal(result.status,"TRANSFERRED");
 const completed=await report(actor("out-a"),"outgoing");assert.equal(completed.frozen,true);assert.deepEqual(completed.content,before.content);assert.equal(completed.content.pendingTasks[0].id,"task-0");assert.equal((await db.doc("tasks/task-0").get()).data().shiftId,"incoming");assert.equal((await db.collection("task_assignments").get()).size,1);
 const updates=await Promise.all(["handovers/handover_outgoing","operational_shift_control/global","shifts/incoming","shifts/outgoing"].map(async path=>(await db.doc(path).get()).updateTime.toMillis()));
 assert.equal((await transferCurrent()).status,"ALREADY_TRANSFERRED");assert.deepEqual(await Promise.all(["handovers/handover_outgoing","operational_shift_control/global","shifts/incoming","shifts/outgoing"].map(async path=>(await db.doc(path).get()).updateTime.toMillis())),updates);
});
test("explicit report correction preserves original snapshot and invalidates real confirmation",async()=>{
 await preparedReport();const original=await freezeCurrent();await confirmCurrent("out-a");const stale=await reviewed();const revised=await freezeCurrent({reason:"Correct codec location wording",correctionNote:"The affected codec is the backup studio codec; original entry retained for audit."});
 assert.notEqual(revised.reportBinding.digest,original.reportBinding.digest);const {aggregate}=await reviewed();assert.equal(aggregate.confirmations.length,0);assert.equal((await db.doc(`handover_reports/${original.reportBinding.id}`).get()).exists,true);
 await assert.rejects(()=>confirm({outgoingShiftId:"outgoing",actorUid:"in-a",expectedRevision:stale.expectedRevision,expectedSnapshotHash:stale.expectedSnapshotHash}));await confirmCurrent("out-a");assert.equal((await report(actor("in-a"),"outgoing")).content.corrections.length,1);
});
test("changed report sources reject actual confirmation and transfer until explicit revision",async()=>{
 await preparedReport();await freezeCurrent();const source=(await db.collection("shift_operation_events").where("kind","==","broadcast").get()).docs[0];const original=source.data();await source.ref.update({remarks:"Changed authoritative observation"});
 await assert.rejects(()=>confirmCurrent("out-a"),/sources changed/);assert.equal((await reviewed()).aggregate.confirmations.length,0);await source.ref.set(original);
 for(const uid of ["out-a","out-b","in-a","in-b"])await confirmCurrent(uid);await source.ref.update({remarks:"Changed after all four confirmations"});await assert.rejects(()=>transferCurrent(),/sources changed/);assert.equal((await db.doc("shifts/outgoing").get()).data().status,"handover_pending");assert.equal((await db.doc("shifts/incoming").get()).exists,false);
 await freezeCurrent({reason:"Review changed authoritative source"});assert.equal((await reviewed()).aggregate.confirmations.length,0);
});
test("concurrent freeze and confirmation never leave old report confirmation on new revision",async()=>{
 await preparedReport();await freezeCurrent();const old=await reviewed();await Promise.allSettled([confirm({outgoingShiftId:"outgoing",actorUid:"out-a",expectedRevision:old.expectedRevision,expectedSnapshotHash:old.expectedSnapshotHash}),freeze(manager,"outgoing",{expectedRevision:old.expectedRevision,expectedSnapshotHash:old.expectedSnapshotHash,reason:"Controlled concurrent revision",correctionNote:"Checked additional backup path."})]);
 const current=await reviewed();assert.ok(current.aggregate.revision>old.aggregate.revision);assert.equal(current.aggregate.confirmations.length,0);
});
test("tampered frozen evidence fails closed without confirmations or transfer",async()=>{await preparedReport();const binding=await freezeCurrent();await db.doc(`handover_reports/${binding.reportBinding.id}`).update({"content.staff.shiftType":"night"});await assert.rejects(()=>confirmCurrent("out-a"),/inconsistent/);assert.equal((await reviewed()).aggregate.confirmations.length,0);});
test("report document capacity failure is atomic and never truncates evidence",async()=>{
 await preparedReport();const base=(await events()).find(event=>event.kind==="broadcast"),batch=db.batch();for(let i=0;i<170;i++){const id=`capacity-${i}`;batch.create(db.doc(`shift_operation_events/${id}`),{...base,id,recordId:id,remarks:"界".repeat(5000)});}await batch.commit();
 const old=await reviewed();await assert.rejects(()=>freezeCurrent(),/capacity/);assert.equal((await db.collection("handover_reports").get()).size,0);assert.equal((await reviewed()).expectedSnapshotHash,old.expectedSnapshotHash);assert.equal((await events()).length,176);
});
test("handover lists expose incoming and outgoing reports only to their permanent participants",async()=>{
 await preparedReport();
 for(const uid of ["out-a","out-b","in-a","in-b"]){const view=await workspace(actor(uid));assert.equal(view.reports.length,1);assert.equal(view.reports[0].shiftId,"outgoing");assert.equal(view.pairs.length,0);assert.equal(view.availableShifts.length,0);}
 await db.doc("users/unrelated").set({uid:"unrelated",role:"technician",status:"active",mustChangePassword:false});
 assert.equal((await workspace(actor("unrelated"))).reports.length,0);
 await db.doc("users/in-a").update({status:"blocked"});await assert.rejects(()=>workspace(actor("in-a")));
});
test("supervisor handover list provides authoritative active pair choices and pending shifts",async()=>{
 await fixture();const manager={...actor("manager"),role:"supervisor"};
 await db.doc("users/manager").set({...manager,statusOperation:null});
 await db.doc("shifts/outgoing").update({status:"handover_pending"});
 const view=await workspace(manager);assert.equal(view.reports.length,0);assert.equal(view.availableShifts.length,1);assert.equal(view.availableShifts[0].id,"outgoing");assert.ok(view.pairs.length>=2);assert.ok(view.pairs.every(pair=>pair.label.includes(" + ")));
});
test("dashboard summaries use authoritative ownership and actual attendance, and enforce manager access",async()=>{
 const f=await fixture();const manager={...actor("manager"),role:"supervisor"};await db.doc("users/manager").set({...manager,statusOperation:null});
 const summary=await overview(manager);assert.equal(summary.techniciansOnDuty,2);assert.equal(summary.openTasks,f.tasks.length);assert.equal(summary.pendingHandovers,0);assert.match(summary.currentShift,/active/);assert.equal(summary.totalUsers,null);
 await assert.rejects(()=>overview(actor("out-a")));
 await db.doc("users/manager").update({role:"admin"});const adminSummary=await overview({...manager,role:"admin"});assert.equal(adminSummary.totalUsers,(await db.collection("users").get()).size);assert.equal(adminSummary.stations,4);
 await db.doc("operational_shift_control/global").update({shiftId:"missing"});await assert.rejects(()=>overview({...manager,role:"admin"}),/inconsistent/);
});
test.after(async()=>{await db.terminate();});
