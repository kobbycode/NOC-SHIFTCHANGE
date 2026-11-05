// TECH-HO-RECOVERY-09L — asynchronous outbox delivery worker.
//
// This is the trusted backend process. It drains due outbox rows and pushes via
// a PushTransport. Every FCM/transport call happens OUTSIDE a Firestore
// transaction; only short state-transition transactions touch the outbox. A
// delivery failure only updates the outbox row — it can never roll back or block
// the business event that created it.
//
// Delivery is at-least-once (a re-claim after a crash may re-send), which is
// acceptable because retries only re-send pushes and never mutate workflow
// state, so no duplicate business action can occur.
import "server-only";
import { getOperationalCollections } from "@/lib/operations/collections";
import { attemptDocumentId, resolveNotificationRoute } from "./notification-domain";
import { deactivateByToken, listActiveDevicesForUid } from "./device-registry";
import type { PushTransport } from "./push-transport";
import type {
  DeliveryAttemptRecord,
  NotificationRecord,
  OutboxRecord,
  PushTransportOutcome,
} from "@/types/notification";

const LEASE_MS = 60_000;
const BASE_BACKOFF_MS = 30_000;

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function backoffMs(attemptCount: number): number {
  // Exponential with a cap; deterministic so tests can assert nextAttemptAt.
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attemptCount - 1), 15 * 60_000);
}

export interface DeliverSummary {
  outboxId: string;
  skipped: boolean;
  status: OutboxStatus | null;
  attempts: number;
}

type OutboxStatus = OutboxRecord["status"];

async function recordAttempt(
  entry: OutboxRecord,
  deviceRef: string,
  outcome: PushTransportOutcome,
  providerMessageId: string | null,
  errorClass: string | null,
  transportName: PushTransport["name"],
  now: string,
): Promise<void> {
  const { db } = getOperationalCollections();
  const record: DeliveryAttemptRecord = {
    schema: "notification-delivery-attempt-v1",
    outboxId: entry.idempotencyKey,
    notificationId: entry.notificationId,
    recipientUid: entry.recipientUid,
    deviceRef,
    transport: transportName,
    outcome,
    providerMessageId,
    errorClass,
    attemptedAt: now,
  };
  // The attempt number alone is not unique: a worker that dies after sending
  // but before finalizing leaves attemptCount unchanged, so the reclaiming
  // worker re-uses the same number for a genuinely separate send. Folding the
  // wall-clock attempt time into the id keeps every actual send auditable.
  await db
    .collection("notification_delivery_attempts")
    .doc(attemptDocumentId(entry.idempotencyKey, deviceRef, entry.attemptCount + 1, now))
    .set(record);
}

// Delivers a single outbox entry. Returns skipped:true when the entry is not
// due, already terminal, or currently leased by another worker.
export async function deliverOutboxEntry(
  outboxId: string,
  options: { now: string; transport: PushTransport },
): Promise<DeliverSummary> {
  const { now, transport } = options;
  const { db, notificationOutbox, notifications } = getOperationalCollections();

  const claimed = await db.runTransaction(async (transaction) => {
    const ref = notificationOutbox.doc(outboxId);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const entry = snapshot.data() as OutboxRecord;
    if (entry.status === "delivered" || entry.status === "dead" || entry.status === "no_device") return null;
    if (entry.status === "leased" && entry.leaseUntil && Date.parse(entry.leaseUntil) > Date.parse(now)) return null;
    if (entry.status === "retry" && Date.parse(entry.nextAttemptAt) > Date.parse(now)) return null;
    transaction.set(ref, { ...entry, status: "leased", leaseUntil: addMs(now, LEASE_MS), updatedAt: now });
    return entry;
  });

  if (!claimed) return { outboxId, skipped: true, status: null, attempts: 0 };

  const notificationSnapshot = await notifications.doc(claimed.notificationId).get();
  const notification = notificationSnapshot.exists ? (notificationSnapshot.data() as NotificationRecord) : null;
  const route = notification ? resolveNotificationRoute(notification) : "";
  const devices = await listActiveDevicesForUid(claimed.recipientUid);

  let accepted = 0;
  let invalid = 0;
  let retryable = 0;
  let lastOutcome: PushTransportOutcome | null = null;
  let lastError: string | null = null;

  for (const device of devices) {
    const result = await transport.send({
      token: device.token,
      title: notification?.title ?? "Notification",
      deepLinkRoute: route,
      notificationId: claimed.notificationId,
    });
    await recordAttempt(claimed, device.tokenHash, result.outcome, result.providerMessageId, result.errorClass, transport.name, now);
    lastOutcome = result.outcome;
    lastError = result.errorClass;
    if (result.outcome === "accepted") accepted += 1;
    else if (result.outcome === "invalid_token") {
      invalid += 1;
      await deactivateByToken(device.token, now); // invalid-token cleanup
    } else if (result.outcome === "failed_retryable") retryable += 1;
  }

  const newAttemptCount = claimed.attemptCount + 1;
  let status: OutboxStatus;
  let deliveredAt: string | null = null;
  let nextAttemptAt = claimed.nextAttemptAt;

  if (accepted > 0) {
    status = "delivered";
    deliveredAt = now;
  } else if (devices.length === 0) {
    status = "no_device"; // nothing to deliver; NOT a failure of the business event
  } else if (retryable > 0) {
    status = newAttemptCount >= claimed.maxAttempts ? "dead" : "retry";
    nextAttemptAt = addMs(now, backoffMs(newAttemptCount));
  } else if (invalid > 0) {
    status = "no_device"; // every device token was cleaned up
  } else {
    status = newAttemptCount >= claimed.maxAttempts ? "dead" : "retry";
    nextAttemptAt = addMs(now, backoffMs(newAttemptCount));
  }

  await db.runTransaction(async (transaction) => {
    const ref = notificationOutbox.doc(outboxId);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const current = snapshot.data() as OutboxRecord;
    transaction.set(ref, {
      ...current,
      status,
      attemptCount: newAttemptCount,
      nextAttemptAt,
      leaseUntil: null,
      lastOutcome,
      lastError,
      deliveredAt,
      updatedAt: now,
    });
  });

  return { outboxId, skipped: false, status, attempts: newAttemptCount };
}

export interface DrainSummary {
  processed: number;
  delivered: number;
  retry: number;
  dead: number;
  noDevice: number;
  skipped: number;
}

// Drains all outbox entries due at `now`. Expired `leased` rows are included so
// the sweep reclaims work orphaned by an interrupted worker; the claim
// transaction still skips any row whose lease has not yet expired. The
// scheduler (Cloud Functions trigger, or a test harness) owns the cadence;
// this is one pass.
export async function drainDueOutbox(
  options: { now: string; transport: PushTransport; limit?: number },
): Promise<DrainSummary> {
  const { now, transport, limit = 50 } = options;
  const { notificationOutbox } = getOperationalCollections();
  const snapshot = await notificationOutbox
    .where("status", "in", ["pending", "retry", "leased"])
    .where("nextAttemptAt", "<=", now)
    .limit(limit)
    .get();

  const summary: DrainSummary = { processed: 0, delivered: 0, retry: 0, dead: 0, noDevice: 0, skipped: 0 };
  for (const doc of snapshot.docs) {
    const result = await deliverOutboxEntry(doc.id, { now, transport });
    summary.processed += 1;
    if (result.skipped) summary.skipped += 1;
    else if (result.status === "delivered") summary.delivered += 1;
    else if (result.status === "retry") summary.retry += 1;
    else if (result.status === "dead") summary.dead += 1;
    else if (result.status === "no_device") summary.noDevice += 1;
  }
  return summary;
}
