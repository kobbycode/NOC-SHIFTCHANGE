// TECH-HO-RECOVERY-09L — pure notification domain. No Firestore, no I/O, so it
// is fully unit-testable and importable by both the transactional enqueue
// helper and the asynchronous delivery worker.
//
// This module assembles transport-agnostic intents from an authoritative
// business event. It NEVER reads or writes workflow state and NEVER infers a
// confirmation/acceptance/attendance from a notification.
import { createHash } from "node:crypto";
import {
  NOTIFICATION_EVENT_KINDS,
  NOTIFICATION_TARGETS,
  type NotificationEventKind,
  type NotificationIntent,
} from "@/types/notification";

export type NotificationEventInput = {
  eventKind: NotificationEventKind;
  // A deterministic business event id, e.g. `${handoverId}:${revision}` for a
  // reservation, the task-assignment history doc id, or the transfer doc id.
  eventId: string;
  // Recipients resolved by the CALLING hook from data it authoritatively holds
  // (aggregate identity, assignment assignee, successor roster). The domain
  // never guesses recipients.
  recipientUids: string[];
  refs: {
    outgoingShiftId?: string | null;
    incomingShiftId?: string | null;
    taskId?: string | null;
    handoverId?: string | null;
  };
  createdAt: string;
};

const TITLES: Record<NotificationEventKind, string> = {
  [NOTIFICATION_EVENT_KINDS.HANDOVER_RESERVATION_UPCOMING]: "Upcoming handover scheduled",
  [NOTIFICATION_EVENT_KINDS.HANDOVER_INITIATED]: "Handover started for your shift",
  [NOTIFICATION_EVENT_KINDS.OUTGOING_CONFIRMATION_REQUIRED]: "Handover confirmation needed",
  [NOTIFICATION_EVENT_KINDS.INCOMING_ACCEPTANCE_REQUIRED]: "Incoming handover acceptance needed",
  [NOTIFICATION_EVENT_KINDS.HANDOVER_ABSENCE_RECORDED]: "Documented absence recorded",
  [NOTIFICATION_EVENT_KINDS.HANDOVER_COMPLETED]: "Handover completed",
  [NOTIFICATION_EVENT_KINDS.TASK_ASSIGNED]: "You have a new task to acknowledge",
  [NOTIFICATION_EVENT_KINDS.TASK_REASSIGNED]: "A task was assigned to you",
  [NOTIFICATION_EVENT_KINDS.TASK_TRANSFER_OUTSTANDING]: "Outstanding task transferred to your shift",
};

const HANDOVER_KINDS = new Set<string>([
  NOTIFICATION_EVENT_KINDS.HANDOVER_RESERVATION_UPCOMING,
  NOTIFICATION_EVENT_KINDS.HANDOVER_INITIATED,
  NOTIFICATION_EVENT_KINDS.OUTGOING_CONFIRMATION_REQUIRED,
  NOTIFICATION_EVENT_KINDS.INCOMING_ACCEPTANCE_REQUIRED,
  NOTIFICATION_EVENT_KINDS.HANDOVER_ABSENCE_RECORDED,
  NOTIFICATION_EVENT_KINDS.HANDOVER_COMPLETED,
  NOTIFICATION_EVENT_KINDS.TASK_TRANSFER_OUTSTANDING,
]);

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Deterministic, retry-stable key. Colons are safe in Firestore field values;
// the derived document ids are hashed so no forbidden character reaches a path.
export function computeIdempotencyKey(eventKind: string, eventId: string, recipientUid: string): string {
  return `${eventKind}:${eventId}:${recipientUid}`;
}

// Fixed-length, collision-resistant Firestore document id derived from the
// idempotency key. Deterministic so a re-enqueue overwrites (dedupes) rather
// than duplicating.
export function documentIdForKey(idempotencyKey: string): string {
  return hashHex(idempotencyKey);
}

export function notificationDocumentId(idempotencyKey: string): string {
  return documentIdForKey(`notification:${idempotencyKey}`);
}

export function outboxDocumentId(idempotencyKey: string): string {
  return documentIdForKey(`outbox:${idempotencyKey}`);
}

// Includes the attempt time so two real sends under one attempt number (a
// worker interrupted after sending, then reclaimed) each leave an audit row.
export function attemptDocumentId(outboxId: string, deviceRef: string, attempt: number, attemptedAt: string): string {
  return documentIdForKey(`attempt:${outboxId}:${deviceRef}:${attempt}:${attemptedAt}`);
}

// One-way device reference. The raw FCM token is never persisted or logged.
export function tokenHash(token: string): string {
  return hashHex(token);
}

export function tokenFingerprint(token: string): string {
  return hashHex(token).slice(0, 8);
}

function isHandoverKind(eventKind: NotificationEventKind): boolean {
  return HANDOVER_KINDS.has(eventKind);
}

// Assembles one intent per recipient. Empty/blank recipients are dropped so a
// partially-populated roster can never enqueue a notification to "".
export function buildNotificationIntents(input: NotificationEventInput): NotificationIntent[] {
  const recipients = [...new Set(
    (input.recipientUids ?? []).filter((uid) => typeof uid === "string" && uid.trim() === uid && uid.length > 0),
  )];
  const outgoingShiftId = input.refs.outgoingShiftId ?? null;
  const incomingShiftId = input.refs.incomingShiftId ?? null;
  const taskId = input.refs.taskId ?? null;
  const handoverId = input.refs.handoverId ?? null;

  const target = isHandoverKind(input.eventKind)
    ? NOTIFICATION_TARGETS.HANDOVER_V2
    : NOTIFICATION_TARGETS.TECHNICIAN_TASKS;

  const deepLinkParams: Record<string, string> = {};
  if (outgoingShiftId) deepLinkParams.outgoingShiftId = outgoingShiftId;
  if (taskId) deepLinkParams.taskId = taskId;

  return recipients.map((recipientUid) => ({
    idempotencyKey: computeIdempotencyKey(input.eventKind, input.eventId, recipientUid),
    eventKind: input.eventKind,
    recipientUid,
    outgoingShiftId,
    incomingShiftId,
    taskId,
    handoverId,
    title: TITLES[input.eventKind],
    deepLink: { target, params: deepLinkParams },
    createdAt: input.createdAt,
  }));
}

// Centralized, version-aware handover destination builder. The stored deep-link
// target is itself versioned (handover_v2), so the route MUST carry the same
// version segment: a V2 handover notification belongs on the V2 technician
// workflow (/technician/handovers/v2/<id>), never the V1 report page. A future
// genuine V1 target maps to the unversioned route here; nothing rewrites V1.
const HANDOVER_TARGET_VERSION: Record<string, "v1" | "v2"> = {
  [NOTIFICATION_TARGETS.HANDOVER_V2]: "v2",
};

function handoverDestination(version: "v1" | "v2", shiftId: string): string {
  const segment = version === "v2" ? "/technician/handovers/v2/" : "/technician/handovers/";
  return `${segment}${encodeURIComponent(shiftId)}`;
}

// Resolves a stored deep link to a safe, relative in-app route. Unknown targets
// or missing required ids resolve to the neutral inbox route so a stored value
// can never produce an arbitrary or unauthenticated destination. The route is
// only a navigation hint; the target page re-checks auth/authz itself. The
// route is derived at read/delivery time from {target, params} and is never
// persisted, so fixing a mapping repairs every existing record at once.
export function resolveNotificationRoute(intent: {
  deepLink: NotificationIntent["deepLink"];
}): string {
  const { target, params } = intent.deepLink;
  if (params.outgoingShiftId) {
    const version = HANDOVER_TARGET_VERSION[target];
    if (version) return handoverDestination(version, params.outgoingShiftId);
  }
  if (target === NOTIFICATION_TARGETS.TECHNICIAN_TASKS) {
    return "/technician/tasks";
  }
  return "/technician";
}
