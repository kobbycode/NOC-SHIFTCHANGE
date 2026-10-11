import type { OperationDetails, ShiftOperationEvent, ShiftOperationsView } from "@/types/shift-operations";

export class ShiftOperationsError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "ShiftOperationsError"; }
}
function compare(a:string,b:string){return a<b?-1:a>b?1:0;}
export function operationIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 512 || value.includes("/") || value === "." || value === "..") throw new ShiftOperationsError("Invalid operational record identifier.");
}
function text(value: unknown, name: string, required = false, limit = 5000): string {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim())) throw new ShiftOperationsError(`Provide valid ${name}.`);
  return value.trim();
}
function choice<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ShiftOperationsError(`Select valid ${name}.`);
  return value as T;
}
export function parseOperation(value: unknown, stations: readonly { id: string; name: string }[], now: string): OperationDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShiftOperationsError("Provide operational record details.");
  const data = value as Record<string, unknown>;
  const occurredAt = text(data.occurredAt, "observation/report time", true, 32);
  if (!Number.isFinite(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt || Date.parse(occurredAt) > Date.parse(now) + 60000) {
    throw new ShiftOperationsError("Provide a valid UTC time that is not in the future.");
  }
  const kind = choice(data.kind, ["broadcast", "incident", "outside_broadcast", "no_ob"], "record category");
  const fields: Record<typeof kind, string[]> = {
    broadcast: ["stationId", "status", "remarks"], incident: ["category", "title", "description", "location", "actionTaken", "status", "severity", "linkedTaskId"],
    outside_broadcast: ["title", "location", "runningStatus", "technicalIssues", "actionTaken", "status", "remarks", "linkedTaskId"], no_ob: ["remarks"],
  };
  if (Object.keys(data).some(key => !["kind", "occurredAt", ...fields[kind]].includes(key))) throw new ShiftOperationsError("Unsupported operational record fields.");
  if (kind === "broadcast") {
    const station = stations.find(item => item.id === data.stationId);
    if (!station) throw new ShiftOperationsError("Select a configured station.");
    return { kind, occurredAt, stationId: station.id, stationName: station.name,
      status: choice(data.status, ["on_air", "off_air", "degraded", "not_verified"], "broadcast status"), remarks: text(data.remarks, "remarks") };
  }
  if (kind === "no_ob") return { kind, occurredAt, remarks: text(data.remarks, "remarks") };
  const linkedTaskId = data.linkedTaskId === null || data.linkedTaskId === "" ? null : data.linkedTaskId;
  if (linkedTaskId !== null) operationIdentifier(linkedTaskId);
  const common = { occurredAt, title: text(data.title, "title", true, 200), location: text(data.location, "station/equipment/location", kind === "outside_broadcast", 500),
    actionTaken: text(data.actionTaken, "action taken"), status: choice(data.status, ["open", "investigating", "monitoring", "resolved"], "current status"), linkedTaskId };
  if (kind === "incident") return { ...common, kind, category: choice(data.category, ["fault", "technical_activity"], "incident category"),
    description: text(data.description, "description", true), severity: choice(data.severity, ["low", "medium", "high", "critical"], "severity") };
  return { ...common, kind, runningStatus: choice(data.runningStatus, ["planned", "running", "ended", "cancelled"], "running status"),
    technicalIssues: text(data.technicalIssues, "technical issues"), remarks: text(data.remarks, "remarks") };
}

export function assembleShiftOperations(shiftId: string, writable: boolean, stations: { id: string; name: string }[], input: ShiftOperationEvent[]): ShiftOperationsView {
  const events = [...input].sort((a,b) => compare(a.createdAt,b.createdAt) || compare(a.id,b.id));
  const groups = new Map<string, ShiftOperationEvent[]>();
  const identities = new Set<string>();
  for (const event of events) {
    if (event.shiftId !== shiftId || identities.has(event.id) || !Number.isSafeInteger(event.revision) || event.revision < 1) throw new ShiftOperationsError("Operational history identity is inconsistent.", 409);
    identities.add(event.id);
    for(const value of [event.id,event.recordId,event.authorUid,event.originalReporterUid])operationIdentifier(value);
    if(!event.authorName?.trim()||!event.originalReporterName?.trim()||event.provenance!=="authenticated_technician"||
      !Number.isFinite(Date.parse(event.createdAt))||new Date(event.createdAt).toISOString()!==event.createdAt||
      !Number.isFinite(Date.parse(event.occurredAt))||new Date(event.occurredAt).toISOString()!==event.occurredAt) {
      throw new ShiftOperationsError("Operational provenance is incomplete.",409);
    }
    const group = groups.get(event.recordId) ?? []; group.push(event); groups.set(event.recordId, group);
  }
  const latest = [...groups.values()].map(group => {
    group.sort((a,b) => a.revision-b.revision);
    if(group[0].originalReporterUid!==group[0].authorUid||group[0].originalReporterName!==group[0].authorName)throw new ShiftOperationsError("Original reporter provenance is inconsistent.",409);
    for (const [i,event] of group.entries()) if (event.revision !== i+1 || event.kind !== group[0].kind ||
      event.originalReporterUid !== group[0].originalReporterUid || event.originalReporterName !== group[0].originalReporterName) {
      throw new ShiftOperationsError("Operational event history is incomplete or inconsistent.", 409);
    }
    return group[group.length-1];
  }).sort((a,b) => compare(a.occurredAt,b.occurredAt) || compare(a.recordId,b.recordId));
  const broadcast = stations.map(station => ({stationId: station.id, stationName: station.name,
    observation: events.filter(event => event.kind === "broadcast" && event.stationId === station.id)
      .sort((a,b) => compare(b.occurredAt,a.occurredAt) || compare(b.createdAt,a.createdAt) || compare(b.id,a.id))[0] ?? null }));
  const hasOb = latest.some(event => event.kind === "outside_broadcast"), hasNone = latest.some(event => event.kind === "no_ob");
  return { shiftId, writable, stations, events, latest, broadcast, completeness: {
    broadcastMissing: broadcast.filter(row => !row.observation || row.observation.kind !== "broadcast" || row.observation.status === "not_verified").map(row => row.stationName),
    outsideBroadcast: hasOb && hasNone ? "conflicting" : hasOb ? "recorded" : hasNone ? "declared_none" : "missing",
  }};
}
