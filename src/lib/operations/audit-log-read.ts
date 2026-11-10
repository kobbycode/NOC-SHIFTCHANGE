import "server-only";

import type { AppUser } from "@/types/auth";

import { getOperationalCollections } from "./collections";

import { requireReadProfile } from "./read-guard";

const MAX_RECORDS = 1_000;
const PAGE_SIZE = 25;
const MAX_TEXT = 240;

const ACTION_LABELS: Record<string, string> = {
  USER_CREATED: "User account created",
  USER_BLOCKED: "User account blocked",
  USER_UNBLOCKED: "User account unblocked",
  PASSWORD_CHANGED: "Password changed",
  SHIFT_CREATED: "Shift scheduled",
  SHIFT_STARTED: "Shift started",
  SHIFT_COMPLETED: "Shift completed",
  SHIFT_TECHNICIAN_JOINED: "Technician joined shift",
  SHIFT_HANDOVER_STARTED: "Handover started",
  SHIFT_HANDOVER_SNAPSHOT_REVISED: "Handover work snapshot revised",
  SHIFT_HANDOVER_TECHNICIAN_CONFIRMED: "Handover technically confirmed",
  SHIFT_HANDOVER_TRANSFERRED: "Handover transferred",
  SHIFT_OPERATION_RECORDED: "Operational record saved",
  TASK_CREATED: "Task created",
  TASK_ASSIGNED: "Task assigned",
  TECHNICIAN_PAIR_CREATED: "Technician pair created",
  NEXT_SHIFT_AUTHORIZATION_CREATED: "Incoming authorization created",
  NEXT_SHIFT_AUTHORIZATION_CONSUMED: "Incoming authorization consumed",
  EQUAL_HANDOVER_REPORT_PREPARED_V2: "Handover report prepared",
  EQUAL_HANDOVER_REPORT_FROZEN_V2: "Handover report frozen",
  EQUAL_HANDOVER_CONFIRMED_V2: "Handover participant confirmed",
  EQUAL_HANDOVER_ABSENCE_RECORDED_V2: "Handover absence recorded",
  EQUAL_HANDOVER_ABSENCE_CLEARED_V2: "Handover absence cleared",
  EQUAL_HANDOVER_OUTGOING_COMMITTED_V2: "Handover committed by outgoing team",
  EQUAL_SHIFT_ACTIVATED_INCOMING_V2: "Incoming shift activated",
  HANDOVER_SESSION_ISSUED_V2: "Incoming session issued",
  HANDOVER_REVIEW_ADJUDICATED: "Handover review adjudicated",
  HANDOVER_RECOVERY_APPROVAL_REQUESTED: "Recovery approval requested",
  HANDOVER_RECOVERY_APPROVAL_COUNTERSIGNED: "Recovery approval countersigned",
  HANDOVER_RECOVERY_APPROVAL_REISSUED: "Recovery approval reissued",
  HANDOVER_RECOVERY_APPROVAL_VOIDED: "Recovery approval voided",
  HANDOVER_RECOVERY_APPROVAL_V2_REQUESTED: "Recovery approval requested",
  HANDOVER_RECOVERY_APPROVAL_V2_COUNTERSIGNED: "Recovery approval countersigned",
  HANDOVER_RECOVERY_APPROVAL_V2_REISSUED: "Recovery approval reissued",
  HANDOVER_RECOVERY_APPROVAL_V2_VOIDED: "Recovery approval voided",
};

const TIMESTAMP_FIELDS = [
  "serverRecordedAt",
  "recordedAt",
  "createdAt",
  "issuedAt",
  "frozenAt",
  "transferredAt",
  "executedAt",
  "updatedAt",
] as const;

export interface AuditLogEntry {
  documentId: string;
  action: string;
  actionLabel: string;
  actorUid: string | null;
  actorName: string;
  target: string | null;
  details: { label: string; value: string }[];
  timestamp: string | null;
}

export interface AuditLogView {
  entries: AuditLogEntry[];
  page: number;
  pageCount: number;
  total: number;
  actions: { value: string; label: string; count: number }[];
  actors: { uid: string; name: string; count: number }[];
  filters: { action: string | null; actorUid: string | null };
  recordsScanned: number;
  recordsSkipped: number;
  truncated: boolean;
  latestTimestamp: string | null;
}

export interface AuditLogOptions {
  action?: string | null;
  actorUid?: string | null;
  page: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readIso(value: unknown): string | null {
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);

    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (!isRecord(value)) return null;

  if (typeof value.toDate === "function") {
    try {
      const date = (value.toDate as () => unknown)();

      if (date instanceof Date && Number.isFinite(date.getTime())) {
        return date.toISOString();
      }
    } catch {
      return null;
    }
  }

  if (typeof value.seconds === "number") {
    const nanoseconds = typeof value.nanoseconds === "number" ? value.nanoseconds : 0;
    const milliseconds = value.seconds * 1_000 + Math.floor(nanoseconds / 1_000_000);

    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }

  return null;
}

function readTimestamp(data: Record<string, unknown>): string | null {
  for (const field of TIMESTAMP_FIELDS) {
    const value = readIso(data[field]);

    if (value !== null) return value;
  }

  return null;
}

function labelForAction(action: string): string {
  const known = ACTION_LABELS[action];

  if (known) return known;

  const text = action.replaceAll("_", " ").toLowerCase().trim();

  return text ? text[0]!.toUpperCase() + text.slice(1) : action;
}

function contextRows(data: Record<string, unknown>): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];

  function push(label: string, value: unknown) {
    if (typeof value !== "string") return;

    const text = value.trim();

    if (text) rows.push({ label, value: text.slice(0, MAX_TEXT) });
  }

  push("Details", data.details);
  push("Reason", data.reason);

  const previous = typeof data.previousStatus === "string" ? data.previousStatus.replaceAll("_", " ") : null;
  const next = typeof data.newStatus === "string" ? data.newStatus.replaceAll("_", " ") : null;

  if (previous && next) rows.push({ label: "Shift status", value: `${previous} → ${next}` });
  else if (next) rows.push({ label: "New status", value: next });
  else if (previous) rows.push({ label: "Previous status", value: previous });

  if (typeof data.targetRole === "string" && data.targetRole.trim()) {
    rows.push({ label: "Target role", value: data.targetRole.trim() });
  }

  if (typeof data.outcome === "string" && data.outcome.trim()) {
    rows.push({ label: "Outcome", value: data.outcome.trim() });
  }

  return rows.slice(0, 3);
}

async function readUserNames(
  db: ReturnType<typeof getOperationalCollections>["db"],
  uids: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(uids.filter((uid) => typeof uid === "string" && uid.trim()))];

  for (let index = 0; index < unique.length; index += 100) {
    const references = unique
      .slice(index, index + 100)
      .map((uid) => db.collection("users").doc(uid));
    const snapshots = await db.getAll(...references);

    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;

      const name = snapshot.data()?.fullName;

      if (typeof name === "string" && name.trim()) names.set(snapshot.id, name.trim());
    }
  }

  return names;
}

export async function listAuditLogs(
  actor: AppUser,
  options: AuditLogOptions,
): Promise<AuditLogView> {
  await requireReadProfile(actor, ["admin"]);

  const { db } = getOperationalCollections();

  // Audit documents are written with different timestamp and receipt fields.
  // A single orderBy would silently hide records missing that field, so the
  // newest usable 1,000 records are read and ordered in memory instead.
  const snapshot = await db.collection("audit_logs").limit(MAX_RECORDS + 1).get();
  const truncated = snapshot.docs.length > MAX_RECORDS;
  const documents = snapshot.docs.slice(0, MAX_RECORDS);

  const rawEntries: {
    documentId: string;
    action: string;
    actorUid: string | null;
    targetUid: string | null;
    targetEmail: string | null;
    targetTechnicianUid: string | null;
    targetLabelFallback: string | null;
    details: { label: string; value: string }[];
    timestamp: string | null;
  }[] = [];

  let recordsSkipped = 0;

  for (const document of documents) {
    const data = document.data();
    const action = typeof data.action === "string" && data.action.trim() ? data.action.trim() : null;

    // Internal receipts without an action are evidence records, not audit
    // actions, and are excluded from this viewer.
    if (!action) {
      recordsSkipped += 1;
      continue;
    }

    const actorUid =
      typeof data.actorUid === "string" && data.actorUid.trim()
        ? data.actorUid.trim()
        : typeof data.consoleActorUid === "string" && data.consoleActorUid.trim()
          ? data.consoleActorUid.trim()
          : typeof data.assignedBy === "string" && data.assignedBy.trim()
            ? data.assignedBy.trim()
            : null;

    const targetUid =
      typeof data.targetUid === "string" && data.targetUid.trim()
        ? data.targetUid.trim()
        : null;

    const targetTechnicianUid =
      typeof data.technicianUid === "string" && data.technicianUid.trim()
        ? data.technicianUid.trim()
        : typeof data.acceptingTechnicianUid === "string" && data.acceptingTechnicianUid.trim()
          ? data.acceptingTechnicianUid.trim()
          : null;

    const targetLabelFallback =
      typeof data.targetEmail === "string" && data.targetEmail.trim()
        ? data.targetEmail.trim()
        : typeof data.targetTechnicianPairId === "string"
          ? "Technician pair"
          : typeof data.targetShiftId === "string" || typeof data.shiftId === "string"
            ? "Shift record"
            : null;

    rawEntries.push({
      documentId: document.id,
      action,
      actorUid,
      targetUid,
      targetEmail: typeof data.targetEmail === "string" ? data.targetEmail.trim() : null,
      targetTechnicianUid,
      targetLabelFallback,
      details: contextRows(data),
      timestamp: readTimestamp(data),
    });
  }

  const uids = rawEntries.flatMap((entry) =>
    [entry.actorUid, entry.targetUid, entry.targetTechnicianUid].filter(
      (uid): uid is string => uid !== null,
    ),
  );
  const names = await readUserNames(db, uids);

  const entries: AuditLogEntry[] = rawEntries
    .map((entry) => {
      const target =
        (entry.targetUid ? names.get(entry.targetUid) : null) ??
        (entry.targetTechnicianUid ? names.get(entry.targetTechnicianUid) : null) ??
        entry.targetLabelFallback ??
        entry.targetEmail ??
        null;

      return {
        documentId: entry.documentId,
        action: entry.action,
        actionLabel: labelForAction(entry.action),
        actorUid: entry.actorUid,
        actorName: entry.actorUid ? (names.get(entry.actorUid) ?? "Account unavailable") : "System",
        target,
        details: entry.details,
        timestamp: entry.timestamp,
      };
    })
    .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));

  const actionCounts = new Map<string, number>();
  const actorCounts = new Map<string, number>();

  for (const entry of entries) {
    actionCounts.set(entry.action, (actionCounts.get(entry.action) ?? 0) + 1);

    if (entry.actorUid) actorCounts.set(entry.actorUid, (actorCounts.get(entry.actorUid) ?? 0) + 1);
  }

  const actionFilter = options.action && options.action.trim() ? options.action.trim() : null;
  const actorFilter = options.actorUid && options.actorUid.trim() ? options.actorUid.trim() : null;

  const filtered = entries.filter(
    (entry) =>
      (actionFilter === null || entry.action === actionFilter) &&
      (actorFilter === null || entry.actorUid === actorFilter),
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(options.page) || 1), pageCount);

  return {
    entries: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    page,
    pageCount,
    total: filtered.length,
    actions: [...actionCounts.entries()]
      .map(([value, count]) => ({ value, label: labelForAction(value), count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    actors: [...actorCounts.entries()]
      .map(([uid, count]) => ({ uid, name: names.get(uid) ?? "Account unavailable", count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    filters: { action: actionFilter, actorUid: actorFilter },
    recordsScanned: documents.length,
    recordsSkipped,
    truncated,
    latestTimestamp: entries[0]?.timestamp ?? null,
  };
}
