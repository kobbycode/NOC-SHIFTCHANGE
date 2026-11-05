// TECH-HO-RECOVERY-09L — technician notification inbox service (server-only).
//
// Every function is scoped to the authenticated technician's OWN uid. Marking a
// notification read or actioned is UI metadata ONLY; it never confirms a
// handover, accepts a task, or records attendance. Those remain owned by the
// 09F/09G/09J/09K services.
import "server-only";
import { getOperationalCollections } from "@/lib/operations/collections";
import { ShiftOperationsError } from "@/lib/operations/shift-operations-domain";
import { notificationsEnabled as notificationsEnabledFlag } from "./notification-outbox";
import { resolveNotificationRoute } from "./notification-domain";
import type { NotificationRecord, NotificationState } from "@/types/notification";

export interface InboxItem {
  id: string;
  eventKind: NotificationRecord["eventKind"];
  title: string;
  state: NotificationState;
  createdAt: string;
  readAt: string | null;
  actionedAt: string | null;
  outgoingShiftId: string | null;
  taskId: string | null;
  route: string;
}

function toInboxItem(id: string, record: NotificationRecord): InboxItem {
  return {
    id,
    eventKind: record.eventKind,
    title: record.title,
    state: record.state,
    createdAt: record.createdAt,
    readAt: record.readAt,
    actionedAt: record.actionedAt,
    outgoingShiftId: record.outgoingShiftId,
    taskId: record.taskId,
    route: resolveNotificationRoute(record),
  };
}

export async function listInbox(uid: string, limit = 50): Promise<InboxItem[]> {
  const { notifications } = getOperationalCollections();
  const snapshot = await notifications
    .where("recipientUid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snapshot.docs.map((doc) => toInboxItem(doc.id, doc.data() as NotificationRecord));
}

export async function unreadCount(uid: string): Promise<number> {
  const { notifications } = getOperationalCollections();
  const snapshot = await notifications
    .where("recipientUid", "==", uid)
    .where("state", "==", "unread")
    .get();
  return snapshot.size;
}

// Loads one notification the technician is allowed to see. Used by the deep-link
// route to confirm ownership before showing protected content.
export async function getOwnNotification(uid: string, notificationId: string): Promise<InboxItem | null> {
  const { notifications } = getOperationalCollections();
  const snapshot = await notifications.doc(notificationId).get();
  if (!snapshot.exists) return null;
  const record = snapshot.data() as NotificationRecord;
  if (record.recipientUid !== uid) {
    throw new ShiftOperationsError("This notification is not available to your account.", 403);
  }
  return toInboxItem(snapshot.id, record);
}

// Marking read is idempotent and only ever touches this technician's own row.
export async function markNotificationRead(uid: string, notificationId: string, now: string): Promise<void> {
  const { db, notifications } = getOperationalCollections();
  await db.runTransaction(async (transaction) => {
    const ref = notifications.doc(notificationId);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const record = snapshot.data() as NotificationRecord;
    if (record.recipientUid !== uid) {
      throw new ShiftOperationsError("This notification is not available to your account.", 403);
    }
    if (record.state === "unread") {
      transaction.set(ref, { ...record, state: "read", readAt: now });
    }
  });
}

// Records that the technician completed the associated business action. This is
// called BEST-EFFORT by the action routes AFTER the authoritative action has
// already succeeded and committed; it never participates in the business
// transaction and its failure cannot affect the action.
export async function markNotificationActioned(uid: string, notificationId: string, now: string): Promise<void> {
  const { db, notifications } = getOperationalCollections();
  await db.runTransaction(async (transaction) => {
    const ref = notifications.doc(notificationId);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const record = snapshot.data() as NotificationRecord;
    if (record.recipientUid !== uid) return;
    if (record.actionedAt == null) {
      transaction.set(ref, { ...record, state: "actioned", actionedAt: now, readAt: record.readAt ?? now });
    }
  });
}

// Best-effort "actioned" reconciliation driven by an authoritative business
// action. A technician performing a real confirmation/acceptance marks their OWN
// matching, still-pending notifications actioned. It queries only by the caller's
// uid, so it can never touch another technician's records, and it is advisory UI
// metadata — the workflow state itself is owned entirely by the business service.
export interface ActionedReference {
  eventKinds: NotificationRecord["eventKind"][];
  outgoingShiftId?: string | null;
  taskId?: string | null;
}

export async function markActionedByReference(uid: string, reference: ActionedReference, now: string): Promise<void> {
  if (!notificationsEnabledFlag()) return;
  const { notifications } = getOperationalCollections();
  for (const eventKind of reference.eventKinds) {
    const base = notifications
      .where("recipientUid", "==", uid)
      .where("eventKind", "==", eventKind)
      .where("state", "in", ["unread", "read"]);
    const scoped = reference.taskId != null
      ? base.where("taskId", "==", reference.taskId)
      : reference.outgoingShiftId != null
        ? base.where("outgoingShiftId", "==", reference.outgoingShiftId)
        : base;
    const snapshot = await scoped.get();
    for (const doc of snapshot.docs) {
      const record = doc.data() as NotificationRecord;
      if (record.recipientUid !== uid) continue;
      await doc.ref.set({ ...record, state: "actioned", actionedAt: now, readAt: record.readAt ?? now }, { merge: false });
    }
  }
}
