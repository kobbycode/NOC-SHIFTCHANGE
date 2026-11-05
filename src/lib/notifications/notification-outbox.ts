// TECH-HO-RECOVERY-09L — transactional notification outbox.
//
// The durable INTENT is written atomically with the business event (the caller's
// Firestore transaction), but no FCM call ever happens here. A separate worker
// drains the outbox asynchronously, so a failed push can never roll back or
// block a valid handover or task operation.
//
// Enqueue is gated by NOTIFICATIONS_ENABLED. When unset (the default), these
// helpers are inert, so the existing 09F/09G/09J/09K suites and the UAT data
// are byte-for-byte unaffected.
import "server-only";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { OPERATIONAL_COLLECTIONS } from "@/lib/operations/collections";
import {
  notificationDocumentId,
  outboxDocumentId,
} from "./notification-domain";
import type {
  NotificationIntent,
  NotificationRecord,
  OutboxRecord,
} from "@/types/notification";

export const OUTBOX_MAX_ATTEMPTS = 5;

export function notificationsEnabled(): boolean {
  // Fail closed when no ambient environment exists (e.g. the vm-sandboxed mock
  // suites): no env means the subsystem is inert, exactly the shipped default.
  return typeof process !== "undefined" && process.env.NOTIFICATIONS_ENABLED === "true";
}

function toRecord(intent: NotificationIntent): NotificationRecord {
  return {
    schema: "notification-v1",
    idempotencyKey: intent.idempotencyKey,
    eventKind: intent.eventKind,
    recipientUid: intent.recipientUid,
    outgoingShiftId: intent.outgoingShiftId,
    incomingShiftId: intent.incomingShiftId,
    taskId: intent.taskId,
    handoverId: intent.handoverId,
    title: intent.title,
    deepLink: intent.deepLink,
    state: "unread",
    createdAt: intent.createdAt,
    readAt: null,
    actionedAt: null,
  };
}

function toOutbox(intent: NotificationIntent, notificationId: string): OutboxRecord {
  return {
    schema: "notification-outbox-v1",
    idempotencyKey: intent.idempotencyKey,
    notificationId,
    recipientUid: intent.recipientUid,
    eventKind: intent.eventKind,
    status: "pending",
    attemptCount: 0,
    maxAttempts: OUTBOX_MAX_ATTEMPTS,
    nextAttemptAt: intent.createdAt,
    leaseUntil: null,
    lastOutcome: null,
    lastError: null,
    deliveredAt: null,
    createdAt: intent.createdAt,
    updatedAt: intent.createdAt,
  };
}

// Writes the notification + outbox rows inside the CALLER's transaction. This
// performs only `set` operations (idempotent by deterministic doc id) and never
// a `get`, so it cannot disturb the read-before-write ordering the business
// transactions rely on. Safe to call with an empty intent list.
export function writeOutboxEntries(
  transaction: Transaction,
  db: Firestore,
  intents: NotificationIntent[],
): void {
  for (const intent of intents) {
    const notificationId = notificationDocumentId(intent.idempotencyKey);
    const outboxId = outboxDocumentId(intent.idempotencyKey);
    transaction.set(
      db.collection(OPERATIONAL_COLLECTIONS.NOTIFICATIONS).doc(notificationId),
      toRecord(intent),
    );
    transaction.set(
      db.collection(OPERATIONAL_COLLECTIONS.NOTIFICATION_OUTBOX).doc(outboxId),
      toOutbox(intent, notificationId),
    );
  }
}
