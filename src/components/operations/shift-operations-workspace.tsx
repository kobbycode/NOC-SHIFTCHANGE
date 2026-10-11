"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import type { ShiftOperationEvent, ShiftOperationsView } from "@/types/shift-operations";

const tabs=["Broadcast checks","Faults and activities","Outside broadcasts","My tasks","Shift report preview"] as const;
type Tab=typeof tabs[number];
const inputClass="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100";
const buttonClass="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50";
function localTime(iso:string){const date=new Date(iso);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function timestamp(value:string){return new Date(value).toLocaleString();}
function label(value:string){return value.replaceAll("_"," ");}

export function ShiftOperationsWorkspace({initial}:{initial:ShiftOperationsView}) {
  const [view,setView]=useState(initial),[tab,setTab]=useState<Tab>(tabs[0]),[editing,setEditing]=useState<ShiftOperationEvent|null>(null);
  const [saving,setSaving]=useState(false),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null),[formVersion,setFormVersion]=useState(0);
  async function reload(){const response=await fetch(`/api/operations/shifts/${encodeURIComponent(view.shiftId)}/records`,{cache:"no-store"});const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error??"Unable to retrieve records.");setView(data.operations);}
  async function refresh(){setSaving(true);setError(null);try{await reload();}catch(error){setError(error instanceof Error?error.message:"Unable to refresh.");}finally{setSaving(false);}}
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=event.currentTarget,fields=Object.fromEntries(new FormData(form));
    const details:Record<string,unknown>={...fields,occurredAt:editing?.occurredAt??new Date(String(fields.occurredAt)).toISOString()};
    if("linkedTaskId" in details && details.linkedTaskId === "")details.linkedTaskId=null;
    setSaving(true);setError(null);setMessage(null);
    try{
      const response=await fetch(`/api/operations/shifts/${encodeURIComponent(view.shiftId)}/records`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({details,recordId:editing?.recordId??null,expectedRevision:editing?.revision??null})});
      const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error??"Unable to save.");
      setEditing(null);setFormVersion(version=>version+1);setMessage("Record saved with your authorship and audit history.");await reload();
    }catch(error){setError(error instanceof Error?error.message:"Unable to save.");}finally{setSaving(false);}
  }
  function switchTab(next:Tab){setTab(next);setEditing(null);setError(null);setMessage(null);setFormVersion(version=>version+1);}
  const kind=tab===tabs[0]?"broadcast":tab===tabs[1]?"incident":"outside_broadcast";
  const value=(key:string,fallback="")=>editing&&key in editing?String((editing as unknown as Record<string,unknown>)[key]??fallback):fallback;
  const field=(name:string,title:string,required=false,type="text",fallback="")=><label className="block text-sm font-medium">{title}<input className={inputClass} name={name} type={type} required={required} maxLength={name==="title"?200:5000} defaultValue={value(name,fallback)} /></label>;
  const area=(name:string,title:string,required=false)=><label className="block text-sm font-medium">{title}<textarea className={inputClass} name={name} required={required} maxLength={5000} rows={3} defaultValue={value(name)} /></label>;
  const select=(name:string,title:string,options:string[],fallback:string)=><label className="block text-sm font-medium">{title}<select className={inputClass} name={name} defaultValue={value(name,fallback)}>{options.map(option=><option key={option} value={option}>{label(option)}</option>)}</select></label>;
  const records=view.latest.filter(event=>event.kind===kind || (kind==="outside_broadcast"&&event.kind==="no_ob"));
  return <section className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-bold">Shift Operations</h1><p className="mt-1 text-sm text-slate-500">Shared shift records · Individual authorship · {view.events.length} history events</p></div><button className={buttonClass} onClick={refresh} disabled={saving}>Refresh records</button></div>
    {!view.writable&&<p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">Record entry is locked because handover has begun. Review the shared records below.</p>}
    <nav aria-label="Shift operations sections" className="flex flex-wrap gap-2">{tabs.map(item=><button key={item} aria-pressed={tab===item} onClick={()=>switchTab(item)} className={`rounded-lg border px-3 py-2 text-sm ${tab===item?"border-blue-600 bg-blue-600 text-white":"border-slate-300"}`}>{item}</button>)}</nav>
    {error&&<p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">{error}</p>}{message&&<p role="status" className="rounded-lg border border-green-300 bg-green-50 p-4 text-green-800">{message}</p>}
    {tab===tabs[3]?<div className="rounded-xl border p-6"><h2 className="text-lg font-semibold">My tasks</h2><p className="my-3">Use the existing task workspace for assignment responses, work updates, and completion.</p><Link className="text-blue-600 underline" href="/technician/tasks">Open my assigned tasks</Link></div>:tab===tabs[4]?<div className="space-y-4 rounded-xl border p-6"><h2 className="text-lg font-semibold">Shift report preview</h2><p>Broadcast checks outstanding: {view.completeness.broadcastMissing.join(", ")||"None"}</p><p>Outside broadcasts: {label(view.completeness.outsideBroadcast)}</p><p>{view.latest.filter(item=>item.kind==="incident").length} faults and activities recorded by the shift team.</p><Link className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-white" href={`/technician/handovers/${encodeURIComponent(view.shiftId)}`}>Open consolidated handover report</Link></div>:<>
      {tab===tabs[0]&&<div className="grid gap-3 sm:grid-cols-2">{view.broadcast.map(row=><article className="rounded-xl border p-4" key={row.stationId}><h2 className="font-semibold">{row.stationName}</h2><p className={`mt-2 ${!row.observation?"text-amber-700":""}`}>{row.observation?.kind==="broadcast"?label(row.observation.status):"Not verified — no observation"}</p>{row.observation&&<p className="mt-2 text-xs text-slate-500">{timestamp(row.observation.occurredAt)} · {row.observation.authorName}</p>}</article>)}</div>}
      {view.writable&&<form key={`${tab}-${formVersion}-${editing?.id??"new"}`} onSubmit={save} className="space-y-4 rounded-xl border bg-white p-5 dark:bg-slate-950">
        <h2 className="text-lg font-semibold">{editing?`Add chronological update · revision ${editing.revision}`:`New ${label(kind)}`}</h2><input type="hidden" name="kind" value={kind}/>
        <div className="grid gap-4 sm:grid-cols-2">
          {kind==="broadcast"?<label className="block text-sm font-medium">Station<select className={inputClass} name="stationId">{view.stations.map(station=><option key={station.id} value={station.id}>{station.name}</option>)}</select></label>:field("title",kind==="incident"?"Title":"Event name",true)}
          <label className="block text-sm font-medium">{kind==="broadcast"?"Observation time":kind==="incident"?"Original detection/report time":"Event start time"}<input className={inputClass} type="datetime-local" name="occurredAt" required readOnly={!!editing} defaultValue={localTime(editing?.occurredAt??new Date().toISOString())}/></label>
          {kind==="broadcast"?select("status","On-air status",["not_verified","on_air","off_air","degraded"],"not_verified"):<>{kind==="incident"?select("category","Category",["fault","technical_activity"],"fault"):select("runningStatus","Running status",["planned","running","ended","cancelled"],"running")}{field("location","Station / equipment / location",kind==="outside_broadcast")}{select("status","Current status",["open","investigating","monitoring","resolved"],"open")}{kind==="incident"&&select("severity","Severity",["low","medium","high","critical"],"medium")}{field("linkedTaskId","Linked task ID (optional)")}</>}
        </div>
        {kind==="incident"&&area("description","Description",true)}{kind!=="broadcast"&&area("actionTaken","Action taken / update")}{kind==="outside_broadcast"&&area("technicalIssues","Technical issues")}{kind!=="incident"&&area("remarks","Remarks")}
        <div className="flex gap-3"><button className={buttonClass} disabled={saving}>{saving?"Saving…":"Save record"}</button>{editing&&<button type="button" className="rounded-lg border px-4 py-2" onClick={()=>setEditing(null)}>Cancel update</button>}</div>
      </form>}
      {kind==="outside_broadcast"&&view.writable&&<form onSubmit={save} className="space-y-3 rounded-xl border p-5"><h2 className="font-semibold">Explicit no-activity declaration</h2><p className="text-sm text-slate-500">Use only when there were no outside broadcasts. Missing records are never treated as no activity.</p><input type="hidden" name="kind" value="no_ob"/><input type="hidden" name="occurredAt" value={new Date().toISOString()}/><input type="hidden" name="remarks" value="No outside broadcasts during this shift"/><button disabled={saving||!!editing} className="rounded-lg border px-4 py-2">No outside broadcasts during this shift</button></form>}
      <div className="space-y-4"><h2 className="text-lg font-semibold">Shared records</h2>{records.length===0&&<p>No records submitted yet. This section is missing information.</p>}{records.map(record=><article key={record.recordId} className="space-y-3 rounded-xl border p-5"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{"title" in record?record.title:record.kind==="broadcast"?record.stationName:"No outside broadcasts declared"}</h3>{"status" in record&&<span className="rounded-full border px-3 py-1 text-xs">{label(record.status)}</span>}</div><p className="text-sm">{"description" in record?record.description:"remarks" in record?record.remarks:""}</p>{"actionTaken" in record&&<p className="text-sm">Action: {record.actionTaken||"No action recorded"}</p>}{"linkedTaskId" in record&&record.linkedTaskId&&<p className="text-sm">Linked task: {record.linkedTaskId}</p>}<p className="text-xs text-slate-500">Original reporter: {record.originalReporterName} · {timestamp(record.occurredAt)} · Updated by {record.authorName} at {timestamp(record.createdAt)}</p><details><summary className="cursor-pointer text-sm text-blue-600">View immutable history</summary><ol className="mt-3 space-y-2">{view.events.filter(event=>event.recordId===record.recordId).sort((a,b)=>a.revision-b.revision).map(event=><li key={event.id} className="rounded-lg border p-3 text-sm">Revision {event.revision} · {event.authorName} · {timestamp(event.createdAt)}<p>{"actionTaken" in event?event.actionTaken:"remarks" in event?event.remarks:""}</p>{"status" in event&&<p>Status: {label(event.status)}</p>}</li>)}</ol></details>{view.writable&&["incident","outside_broadcast"].includes(record.kind)&&<button className="rounded-lg border px-3 py-2 text-sm" onClick={()=>{setEditing(record);setError(null);setMessage(null);}}>Add action / update</button>}</article>)}</div>
    </>}
  </section>;
}
