import { createHash } from "node:crypto";
import type { HandoverReportBinding,HandoverReportContent,FrozenHandoverReport } from "@/types/handover-report";
export function canonicalReport(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonicalReport).join(",")}]`;
  if(value!==null&&typeof value==="object")return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalReport((value as Record<string,unknown>)[key])}`).join(",")}}`;
  if(value===undefined||typeof value==="function"||typeof value==="symbol"||typeof value==="bigint"||(typeof value==="number"&&!Number.isFinite(value)))throw new Error("Unsupported report evidence.");
  return JSON.stringify(value);
}
export function digestHandoverReport(content:HandoverReportContent){return createHash("sha256").update(canonicalReport(content),"utf8").digest("hex");}
export function assertReportBinding(value:unknown):HandoverReportBinding {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Malformed report binding.");
  const data=value as HandoverReportBinding;
  if(Object.keys(data).length!==3||data.schema!=="handover-report-v1"||typeof data.id!=="string"||!/^report_[0-9a-f-]{36}$/.test(data.id)||typeof data.digest!=="string"||!/^[0-9a-f]{64}$/.test(data.digest))throw new Error("Malformed report binding.");
  return {...data};
}
export function assertFrozenHandoverReport(value:unknown,binding:HandoverReportBinding,shiftId:string):FrozenHandoverReport {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Frozen report is missing.");
  const data=value as FrozenHandoverReport;
  if(data.id!==binding.id||data.schema!==binding.schema||data.outgoingShiftId!==shiftId||data.digest!==binding.digest||
    data.content?.schema!=="handover-report-v1"||data.content.staff.shiftId!==shiftId||digestHandoverReport(data.content)!==binding.digest||
    !data.frozenBy||!data.reason?.trim()||!Number.isSafeInteger(data.reviewedRevision)||data.reviewedRevision<1||
    typeof data.frozenAt!=="string"||!Number.isFinite(Date.parse(data.frozenAt))||new Date(data.frozenAt).toISOString()!==data.frozenAt)throw new Error("Frozen report evidence or digest is inconsistent.");
  return structuredClone(data);
}
