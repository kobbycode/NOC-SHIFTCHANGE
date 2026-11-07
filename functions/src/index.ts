// TECH-HO-RECOVERY-09L — Cloud Functions (2nd gen) notification delivery backend.
//
// This is the trusted asynchronous process that drains the transactional outbox
// written by the Next.js app. It performs EVERY push call OUTSIDE a Firestore
// transaction (the app never calls FCM inline) and only ever mutates outbox rows
// and delivery-attempt records — it can never roll back or block a handover or
// task operation.
//
// Deployment is DEFERRED for this milestone: no cloud resources are created and
// no real push is sent until the owner provisions a staging project. Locally the
// Firebase emulator has no Cloud Messaging, so real delivery is UNVERIFIED here.
//
// Two triggers, both gated by NOTIFICATIONS_ENABLED at runtime:
//   deliverOutboxEntry  — Firestore onDocumentCreated, low-latency first attempt.
//   drainNotificationOutbox — scheduled sweep for retries / missed leases.
//
// Runtime configuration (set via Firebase, NOT committed):
//   NOTIFICATIONS_ENABLED=true, NOTIFICATIONS_TRANSPORT=fcm (staging/prod only).
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";

// Cloud Functions already has Application Default Credentials and sets
// GCLOUD_PROJECT; the admin bootstrap reads FIREBASE_PROJECT_ID, so bridge it.
process.env.FIREBASE_PROJECT_ID ??= process.env.GCLOUD_PROJECT ?? "";

// Imported lazily so a trigger that is disabled does not load the admin SDK.
async function loadWorker() {
  const [{ drainDueOutbox, deliverOutboxEntry }, { resolvePushTransport }, { notificationsEnabled }] = await Promise.all([
    import("@/lib/notifications/outbox-worker"),
    import("@/lib/notifications/transport-factory"),
    import("@/lib/notifications/notification-outbox"),
  ]);
  return { drainDueOutbox, deliverOutboxEntry, resolvePushTransport, notificationsEnabled };
}

// Fast path: attempt delivery the moment a due outbox row is written.
export const deliverOutboxEntry = onDocumentCreated("notification_outbox/{outboxId}", async (event) => {
  const worker = await loadWorker();
  if (!worker.notificationsEnabled()) return;
  const now = new Date().toISOString();
  await worker.deliverOutboxEntry(event.params.outboxId, { now, transport: worker.resolvePushTransport() });
});

// Backstop: every few minutes re-attempt pending/retry rows and reclaim leases
// orphaned by a crash. At-least-once; duplicates only re-send a push, never a
// business action.
export const drainNotificationOutbox = onSchedule("every 5 minutes", async () => {
  const worker = await loadWorker();
  if (!worker.notificationsEnabled()) return;
  const now = new Date().toISOString();
  await worker.drainDueOutbox({ now, transport: worker.resolvePushTransport(), limit: 100 });
});
