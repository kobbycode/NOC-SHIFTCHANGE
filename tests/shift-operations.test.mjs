import test from "node:test";
import assert from "node:assert/strict";
import { modules, prepared } from "./formal-handover-transfer-fixtures.mjs";
const load=modules(),domain=load("lib/operations/shift-operations-domain"),stations=load("types/shift-operations").DEFAULT_BROADCAST_STATIONS;
const now="2026-10-11T12:00:00.000Z";
const details={kind:"broadcast",stationId:"joy-fm",status:"on_air",occurredAt:now,remarks:"Checked studio output"};
test("missing station checks remain explicitly unverified",()=>{
 const view=domain.assembleShiftOperations("shift",true,stations,[]);assert.equal(view.completeness.broadcastMissing.length,4);assert.ok(view.broadcast.every(row=>row.observation===null));assert.equal(view.completeness.outsideBroadcast,"missing");
});
for(const mutation of [{stationId:"unknown"},{status:"normal"},{authorUid:"spoofed"},{occurredAt:"2027-01-01T00:00:00.000Z"},{occurredAt:"invalid"}])test(`reject malformed observation ${JSON.stringify(mutation)}`,()=>assert.throws(()=>domain.parseOperation({...details,...mutation},stations,now)));
test("latest check follows observation time, retaining both authors",()=>{
 const make=(id,occurredAt,createdAt)=>({...details,id,recordId:id,shiftId:"shift",revision:1,authorUid:id,authorName:id,originalReporterUid:id,originalReporterName:id,createdAt,occurredAt,provenance:"authenticated_technician"});
 const later=make("a",now,now),backfill=make("b","2026-10-11T11:00:00.000Z","2026-10-11T12:01:00.000Z");
 const view=domain.assembleShiftOperations("shift",true,stations,[backfill,later]);assert.equal(view.broadcast[0].observation.id,"a");assert.equal(view.events.length,2);
});
test("history gaps and duplicate events fail closed",()=>{
 const event={...details,id:"a",recordId:"a",shiftId:"shift",revision:2,authorUid:"a",authorName:"A",originalReporterUid:"a",originalReporterName:"A",createdAt:now};
 assert.throws(()=>domain.assembleShiftOperations("shift",true,stations,[event]));assert.throws(()=>domain.assembleShiftOperations("shift",true,stations,[{...event,revision:1},{...event,revision:1}]));
});
test("transaction rejects unknown input fields before writes",async()=>{
 const f=prepared();await assert.rejects(()=>f.load("lib/operations/shift-operations").recordShiftOperation({uid:"out-a"},"outgoing",{details,actorUid:"spoofed"}));assert.ok(f.calls.every(([method])=>method==="read"));
});
