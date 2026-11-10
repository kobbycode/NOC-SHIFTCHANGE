import "server-only";

import type { AppUser } from "@/types/auth";

import { DEFAULT_BROADCAST_STATIONS, type BroadcastStatus } from "@/types/shift-operations";

import { getOperationalCollections } from "./collections";

import { requireReadProfile } from "./read-guard";

const MAX_STATIONS = 30;

const RECORD_SECTIONS = [
  {
    key: "broadcast",
    label: "Broadcast checks",
    kind: "broadcast",
    description: "On-air verification recorded for each configured station.",
  },
  {
    key: "faults",
    label: "Faults and activities",
    kind: "incident",
    description: "Faults and technical activities recorded during shifts.",
  },
  {
    key: "outside-broadcasts",
    label: "Outside broadcasts",
    kind: "outside_broadcast",
    description: "Outside broadcast events, locations, and technical issues.",
  },
  {
    key: "no-ob",
    label: "No outside broadcast",
    kind: "no_ob",
    description: "Shifts that formally declared no outside broadcast.",
  },
] as const;

const BROADCAST_STATUSES: readonly BroadcastStatus[] = [
  "on_air",
  "off_air",
  "degraded",
  "not_verified",
];

export interface StationDirectoryRow {
  stationId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  latestStatus: BroadcastStatus | null;
  lastCheckedAt: string | null;
  lastCheckedBy: string | null;
  checks: number;
}

export interface StationDirectoryView {
  stations: StationDirectoryRow[];
  sections: {
    key: string;
    label: string;
    description: string;
    records: number | null;
  }[];
  totals: {
    total: number;
    enabled: number;
    disabled: number;
    configured: boolean;
    invalid: number;
    max: number;
    belowMinimum: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function countKind(
  db: ReturnType<typeof getOperationalCollections>["db"],
  kind: string,
): Promise<number | null> {
  try {
    const snapshot = await db
      .collection("shift_operation_events")
      .where("kind", "==", kind)
      .count()
      .get();

    return snapshot.data().count;
  } catch {
    return null;
  }
}

export async function getStationDirectory(
  actor: AppUser,
): Promise<StationDirectoryView> {
  await requireReadProfile(actor, ["admin"]);

  const { db } = getOperationalCollections();

  const [stationSnapshot, eventsSnapshot, sectionCounts] = await Promise.all([
    db.collection("broadcast_stations").get(),
    db.collection("shift_operation_events").where("kind", "==", "broadcast").get(),
    Promise.all(RECORD_SECTIONS.map((section) => countKind(db, section.kind))),
  ]);

  let invalid = 0;
  const configured = stationSnapshot.size > 0;

  const stations: StationDirectoryRow[] = configured
    ? stationSnapshot.docs.flatMap((document) => {
        const data = document.data();
        const name = typeof data.name === "string" ? data.name.trim() : "";

        if (
          data.id !== document.id ||
          !name ||
          name.length > 100 ||
          typeof data.enabled !== "boolean"
        ) {
          invalid += 1;

          return [];
        }

        return [
          {
            stationId: document.id,
            name,
            enabled: data.enabled,
            configured: true,
            latestStatus: null,
            lastCheckedAt: null,
            lastCheckedBy: null,
            checks: 0,
          },
        ];
      })
    : DEFAULT_BROADCAST_STATIONS.map((station) => ({
        stationId: station.id,
        name: station.name,
        enabled: true,
        configured: false,
        latestStatus: null,
        lastCheckedAt: null,
        lastCheckedBy: null,
        checks: 0,
      }));

  const byStation = new Map(stations.map((station) => [station.stationId, station]));
  const latestByRecord = new Map<
    string,
    {
      stationId: string;
      status: BroadcastStatus | null;
      occurredAt: string;
      createdAt: string;
      authorName: string | null;
      revision: number;
    }
  >();

  for (const document of eventsSnapshot.docs) {
    const data = document.data();

    if (
      !isRecord(data) ||
      typeof data.recordId !== "string" ||
      typeof data.stationId !== "string" ||
      !byStation.has(data.stationId) ||
      typeof data.occurredAt !== "string" ||
      typeof data.createdAt !== "string" ||
      !Number.isSafeInteger(data.revision)
    ) {
      continue;
    }

    const existing = latestByRecord.get(data.recordId);

    if (existing && existing.revision >= (data.revision as number)) continue;

    latestByRecord.set(data.recordId, {
      stationId: data.stationId,
      status:
        typeof data.status === "string" &&
        BROADCAST_STATUSES.includes(data.status as BroadcastStatus)
          ? (data.status as BroadcastStatus)
          : null,
      occurredAt: data.occurredAt,
      createdAt: data.createdAt,
      authorName:
        typeof data.authorName === "string" && data.authorName.trim()
          ? data.authorName.trim()
          : null,
      revision: data.revision as number,
    });
  }

  const latestCreatedAtByStation = new Map<string, string>();

  for (const record of latestByRecord.values()) {
    const station = byStation.get(record.stationId);

    if (!station) continue;

    station.checks += 1;

    const previousCreatedAt = latestCreatedAtByStation.get(record.stationId) ?? null;
    const isNewer =
      station.lastCheckedAt === null ||
      record.occurredAt.localeCompare(station.lastCheckedAt) > 0 ||
      (record.occurredAt === station.lastCheckedAt &&
        (previousCreatedAt === null || record.createdAt.localeCompare(previousCreatedAt) > 0));

    if (isNewer) {
      station.latestStatus = record.status;
      station.lastCheckedAt = record.occurredAt;
      station.lastCheckedBy = record.authorName;
      latestCreatedAtByStation.set(record.stationId, record.createdAt);
    }
  }

  stations.sort((a, b) => a.name.localeCompare(b.name));

  const enabled = stations.filter((station) => station.enabled).length;

  return {
    stations,
    sections: RECORD_SECTIONS.map((section, index) => ({
      key: section.key,
      label: section.label,
      description: section.description,
      records: sectionCounts[index] ?? null,
    })),
    totals: {
      total: stations.length,
      enabled,
      disabled: stations.length - enabled,
      configured,
      invalid,
      max: MAX_STATIONS,
      belowMinimum: enabled < 1 || enabled > MAX_STATIONS,
    },
  };
}
