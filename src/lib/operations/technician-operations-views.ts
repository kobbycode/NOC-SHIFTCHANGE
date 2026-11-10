import "server-only";

import type { AppUser } from "@/types/auth";

import type { ShiftOperationEvent } from "@/types/shift-operations";

import { getShiftOperations } from "./shift-operations";

type IncidentEvent = Extract<ShiftOperationEvent, { kind: "incident" }>;
type OutsideBroadcastEvent = Extract<ShiftOperationEvent, { kind: "outside_broadcast" }>;
type NoObEvent = Extract<ShiftOperationEvent, { kind: "no_ob" }>;

export interface StationRecordRow {
  name: string;
  status: string | null;
  occurredAt: string | null;
  authorName: string | null;
  remarks: string;
}

export interface TechnicianSectionsRecordView {
  stations: StationRecordRow[];
  incidents: {
    title: string;
    severity: string;
    status: string;
    location: string;
    actionTaken: string;
    occurredAt: string;
    authorName: string;
  }[];
  outsideBroadcasts: {
    title: string;
    location: string;
    runningStatus: string;
    status: string;
    actionTaken: string;
    occurredAt: string;
    authorName: string;
  }[];
  noOb: {
    occurredAt: string;
    remarks: string;
    authorName: string;
  } | null;
  counts: {
    broadcastVerified: number;
    broadcastTotal: number;
    incidents: number;
    outsideBroadcasts: number;
    noOb: number;
  };
  missingStations: string[];
  outsideBroadcastCompleteness: string;
  recordsRecorded: number;
  updatedAt: string | null;
}

export interface TechnicianEquipmentView {
  stations: {
    name: string;
    status: string | null;
    occurredAt: string | null;
    authorName: string | null;
  }[];
  locations: {
    name: string;
    section: "Fault / activity" | "Outside broadcast";
    title: string;
    status: string;
    actionTaken: string;
    occurredAt: string;
    authorName: string;
  }[];
  counts: {
    verifiedStations: number;
    totalStations: number;
    locations: number;
  };
}

function newestFirst<T extends { occurredAt: string; createdAt: string; id: string }>(
  events: T[],
): T[] {
  return [...events].sort(
    (a, b) =>
      b.occurredAt.localeCompare(a.occurredAt) ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.id.localeCompare(a.id),
  );
}

function isVerified(status: string | null): boolean {
  return status === "on_air" || status === "off_air" || status === "degraded";
}

export async function getTechnicianSectionsRecord(
  actor: AppUser,
  shiftId: string,
): Promise<TechnicianSectionsRecordView> {
  const view = await getShiftOperations(actor, shiftId);

  const stations: StationRecordRow[] = view.broadcast.map((row) => {
    const observation = row.observation;

    return {
      name: row.stationName,
      status: observation?.kind === "broadcast" ? observation.status : null,
      occurredAt: observation?.occurredAt ?? null,
      authorName: observation?.authorName ?? null,
      remarks: observation?.kind === "broadcast" ? observation.remarks : "",
    };
  });

  const incidents = newestFirst(
    view.latest.filter((event): event is IncidentEvent => event.kind === "incident"),
  );
  const outsideBroadcasts = newestFirst(
    view.latest.filter(
      (event): event is OutsideBroadcastEvent => event.kind === "outside_broadcast",
    ),
  );
  const noOb = newestFirst(
    view.latest.filter((event): event is NoObEvent => event.kind === "no_ob"),
  )[0];

  const updatedAt =
    view.events.length === 0
      ? null
      : view.events
          .map((event) => event.createdAt)
          .reduce((latest, value) => (value.localeCompare(latest) > 0 ? value : latest));

  return {
    stations,
    incidents: incidents.map((event) => ({
      title: event.title,
      severity: event.severity,
      status: event.status,
      location: event.location,
      actionTaken: event.actionTaken,
      occurredAt: event.occurredAt,
      authorName: event.authorName,
    })),
    outsideBroadcasts: outsideBroadcasts.map((event) => ({
      title: event.title,
      location: event.location,
      runningStatus: event.runningStatus,
      status: event.status,
      actionTaken: event.actionTaken,
      occurredAt: event.occurredAt,
      authorName: event.authorName,
    })),
    noOb: noOb
      ? {
          occurredAt: noOb.occurredAt,
          remarks: noOb.remarks,
          authorName: noOb.authorName,
        }
      : null,
    counts: {
      broadcastVerified: view.broadcast.filter((row) =>
        row.observation?.kind === "broadcast"
          ? isVerified(row.observation.status)
          : false,
      ).length,
      broadcastTotal: view.broadcast.length,
      incidents: incidents.length,
      outsideBroadcasts: outsideBroadcasts.length,
      noOb: noOb ? 1 : 0,
    },
    missingStations: view.completeness.broadcastMissing,
    outsideBroadcastCompleteness: view.completeness.outsideBroadcast,
    recordsRecorded: view.latest.length,
    updatedAt,
  };
}

export async function getTechnicianEquipmentView(
  actor: AppUser,
  shiftId: string,
): Promise<TechnicianEquipmentView> {
  const view = await getShiftOperations(actor, shiftId);

  const stations = view.broadcast.map((row) => ({
    name: row.stationName,
    status: row.observation?.kind === "broadcast" ? row.observation.status : null,
    occurredAt: row.observation?.occurredAt ?? null,
    authorName: row.observation?.authorName ?? null,
  }));

  const byLocation = new Map<
    string,
    TechnicianEquipmentView["locations"][number] & { createdAt: string }
  >();

  for (const event of view.latest) {
    if (event.kind !== "incident" && event.kind !== "outside_broadcast") continue;

    const name = event.location.trim();

    if (!name) continue;

    const key = name.toLowerCase();
    const existing = byLocation.get(key);

    if (
      existing &&
      (existing.occurredAt.localeCompare(event.occurredAt) > 0 ||
        (existing.occurredAt === event.occurredAt &&
          existing.createdAt.localeCompare(event.createdAt) > 0))
    ) {
      continue;
    }

    byLocation.set(key, {
      name,
      section: event.kind === "incident" ? "Fault / activity" : "Outside broadcast",
      title: event.title,
      status: event.status,
      actionTaken: event.actionTaken,
      occurredAt: event.occurredAt,
      authorName: event.authorName,
      createdAt: event.createdAt,
    });
  }

  const locations = [...byLocation.values()]
    .map((row) => ({
      name: row.name,
      section: row.section,
      title: row.title,
      status: row.status,
      actionTaken: row.actionTaken,
      occurredAt: row.occurredAt,
      authorName: row.authorName,
    }))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return {
    stations,
    locations,
    counts: {
      verifiedStations: stations.filter((station) => isVerified(station.status)).length,
      totalStations: stations.length,
      locations: locations.length,
    },
  };
}
