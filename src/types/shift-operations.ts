export const DEFAULT_BROADCAST_STATIONS = [
  { id: "joy-fm", name: "Joy FM" },
  { id: "adom-fm", name: "Adom FM" },
  { id: "asempa-fm", name: "Asempa FM" },
  { id: "hitz-fm", name: "Hitz FM" },
] as const;

export type BroadcastStatus = "on_air" | "off_air" | "degraded" | "not_verified";
export type IncidentStatus = "open" | "investigating" | "monitoring" | "resolved";
export type Severity = "low" | "medium" | "high" | "critical";
export type OperationDetails =
  | { kind: "broadcast"; stationId: string; stationName: string; status: BroadcastStatus; occurredAt: string; remarks: string }
  | { kind: "incident"; category: "fault" | "technical_activity"; title: string; description: string; occurredAt: string;
      location: string; actionTaken: string; status: IncidentStatus; severity: Severity; linkedTaskId: string | null }
  | { kind: "outside_broadcast"; title: string; location: string; occurredAt: string; runningStatus: "planned" | "running" | "ended" | "cancelled";
      technicalIssues: string; actionTaken: string; status: IncidentStatus; remarks: string; linkedTaskId: string | null }
  | { kind: "no_ob"; occurredAt: string; remarks: string };

export type ShiftOperationEvent = OperationDetails & {
  id: string; recordId: string; shiftId: string; revision: number;
  authorUid: string; authorName: string; originalReporterUid: string; originalReporterName: string;
  createdAt: string; provenance: "authenticated_technician";
};

export interface ShiftOperationsView {
  shiftId: string;
  writable: boolean;
  stations: { id: string; name: string }[];
  events: ShiftOperationEvent[];
  latest: ShiftOperationEvent[];
  broadcast: { stationId: string; stationName: string; observation: ShiftOperationEvent | null }[];
  completeness: { broadcastMissing: string[]; outsideBroadcast: "recorded" | "declared_none" | "missing" | "conflicting" };
}
