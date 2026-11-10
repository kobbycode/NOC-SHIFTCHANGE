import "server-only";

import type { AppUser } from "@/types/auth";

import { getOperationalCollections } from "./collections";

import { requireReadProfile } from "./read-guard";

export interface HandoverReportRow {
  reportId: string;
  outgoingShiftId: string;
  version: number;
  shiftLabel: string;
  shiftDate: string | null;
  scheduledStart: string | null;
  frozenAt: string;
  frozenBy: string;
  reason: string | null;
  correctionNote: string | null;
  outgoingTeam: string[];
  incomingTeam: string[];
  verifiedStations: number;
  stationCount: number;
  missingStations: string[];
  pendingTasks: number;
  absences: number;
  warnings: number;
  blockers: number;
  recordsRecorded: number;
}

export interface HandoverReportRegisterView {
  reports: HandoverReportRow[];
  totals: {
    reports: number;
    shifts: number;
    corrections: number;
    withWarnings: number;
    latestFrozenAt: string | null;
  };
  recordsSkipped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function humanize(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";

  const text = value.replaceAll("_", " ").trim();

  return text[0]!.toUpperCase() + text.slice(1);
}

function readTeam(
  participants: unknown[],
  side: "outgoing" | "incoming",
  names: Map<string, string>,
): string[] {
  return participants
    .filter(isRecord)
    .filter((participant) => participant.side === side)
    .sort((a, b) =>
      String(a.position ?? "").localeCompare(String(b.position ?? "")),
    )
    .map((participant) => {
      if (typeof participant.name === "string" && participant.name.trim()) {
        return participant.name.trim();
      }

      const uid = typeof participant.uid === "string" ? participant.uid : "";
      const resolved = names.get(uid);

      return resolved ?? "Account unavailable";
    });
}

async function readUserNames(
  db: ReturnType<typeof getOperationalCollections>["db"],
  uids: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(uids.filter((uid) => typeof uid === "string" && uid.trim()))];

  for (let index = 0; index < unique.length; index += 100) {
    const snapshots = await db.getAll(
      ...unique.slice(index, index + 100).map((uid) => db.collection("users").doc(uid)),
    );

    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;

      const name = snapshot.data()?.fullName;

      if (typeof name === "string" && name.trim()) names.set(snapshot.id, name.trim());
    }
  }

  return names;
}

export async function getHandoverReportRegister(
  actor: AppUser,
): Promise<HandoverReportRegisterView> {
  await requireReadProfile(actor, ["admin", "supervisor"]);

  const { db, handoverReportsV2 } = getOperationalCollections();
  const snapshot = await handoverReportsV2.get();

  const pending: {
    reportId: string;
    outgoingShiftId: string;
    version: number;
    shiftLabel: string;
    shiftDate: string | null;
    scheduledStart: string | null;
    frozenAt: string;
    frozenBy: string;
    reason: string | null;
    correctionNote: string | null;
    participants: unknown[];
    absences: number;
    verifiedStations: number;
    stationCount: number;
    missingStations: string[];
    pendingTasks: number;
    warnings: number;
    blockers: number;
    recordsRecorded: number;
  }[] = [];

  let recordsSkipped = 0;

  for (const document of snapshot.docs) {
    const data = document.data();
    const content = data.content;

    if (
      !isIso(data.frozenAt) ||
      typeof data.outgoingShiftId !== "string" ||
      !data.outgoingShiftId.trim() ||
      !Number.isSafeInteger(data.version) ||
      data.version < 1 ||
      !isRecord(content)
    ) {
      recordsSkipped += 1;
      continue;
    }

    const staff = isRecord(content.staff) ? content.staff : {};
    const operations = isRecord(content.operations) ? content.operations : {};
    const completeness = isRecord(content.completeness) ? content.completeness : {};
    const broadcast = Array.isArray(operations.broadcast) ? operations.broadcast : [];
    const latest = Array.isArray(operations.latest) ? operations.latest : [];
    const pendingTasks = Array.isArray(content.pendingTasks) ? content.pendingTasks : [];
    const warnings = Array.isArray(completeness.warnings) ? completeness.warnings : [];
    const blockers = Array.isArray(completeness.blockers) ? completeness.blockers : [];
    const missingStations = Array.isArray(completeness.broadcastMissing)
      ? completeness.broadcastMissing.filter(
          (name): name is string => typeof name === "string" && Boolean(name.trim()),
        )
      : [];

    const verifiedStations = broadcast.filter((row) => {
      if (!isRecord(row) || !isRecord(row.observation)) return false;

      const status = row.observation.status;

      return status === "on_air" || status === "off_air" || status === "degraded";
    }).length;

    pending.push({
      reportId: document.id,
      outgoingShiftId: data.outgoingShiftId.trim(),
      version: data.version,
      shiftLabel: humanize(staff.shiftType) ? `${humanize(staff.shiftType)} shift` : "Shift report",
      shiftDate: isIso(staff.shiftDate) ? (staff.shiftDate as string) : null,
      scheduledStart: isIso(staff.scheduledStart) ? (staff.scheduledStart as string) : null,
      frozenAt: data.frozenAt as string,
      frozenBy: typeof data.frozenBy === "string" ? data.frozenBy : "",
      reason: typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : null,
      correctionNote:
        typeof data.correctionNote === "string" && data.correctionNote.trim()
          ? data.correctionNote.trim()
          : null,
      participants: Array.isArray(data.participants) ? data.participants : [],
      absences: Array.isArray(data.absences) ? data.absences.length : 0,
      verifiedStations,
      stationCount: broadcast.length,
      missingStations,
      pendingTasks: pendingTasks.length,
      warnings: warnings.length,
      blockers: blockers.length,
      recordsRecorded: latest.length,
    });
  }

  const names = await readUserNames(
    db,
    pending.flatMap((report) => [
      report.frozenBy,
      ...report.participants
        .filter(isRecord)
        .map((participant) => (typeof participant.uid === "string" ? participant.uid : "")),
    ]),
  );

  const reports: HandoverReportRow[] = pending
    .map((report) => ({
      reportId: report.reportId,
      outgoingShiftId: report.outgoingShiftId,
      version: report.version,
      shiftLabel: report.shiftLabel,
      shiftDate: report.shiftDate,
      scheduledStart: report.scheduledStart,
      frozenAt: report.frozenAt,
      frozenBy: names.get(report.frozenBy) ?? "Account unavailable",
      reason: report.reason,
      correctionNote: report.correctionNote,
      outgoingTeam: readTeam(report.participants, "outgoing", names),
      incomingTeam: readTeam(report.participants, "incoming", names),
      verifiedStations: report.verifiedStations,
      stationCount: report.stationCount,
      missingStations: report.missingStations,
      pendingTasks: report.pendingTasks,
      absences: report.absences,
      warnings: report.warnings,
      blockers: report.blockers,
      recordsRecorded: report.recordsRecorded,
    }))
    .sort((a, b) => b.frozenAt.localeCompare(a.frozenAt));

  return {
    reports,
    totals: {
      reports: reports.length,
      shifts: new Set(reports.map((report) => report.outgoingShiftId)).size,
      corrections: reports.filter((report) => report.version > 1).length,
      withWarnings: reports.filter((report) => report.warnings > 0).length,
      latestFrozenAt: reports[0]?.frozenAt ?? null,
    },
    recordsSkipped,
  };
}
