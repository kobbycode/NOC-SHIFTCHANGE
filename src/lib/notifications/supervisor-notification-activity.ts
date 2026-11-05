// TECH-HO-RECOVERY-09L — supervisor read-only notification ACTIVITY.
//
// This is a pure read over the DURABLE notification + outbox + delivery-attempt
// records. It never mutates and, critically, never invents a receipt:
//   - "delivered" here means the push transport ADMITTED the message. It is NOT
//     proof the technician viewed anything (no delivery/view receipt is claimed).
//   - "openedAt" is the technician's own advisory read metadata, not a business
//     action.
//   - "actionedAt" is written by the authoritative confirmation/acceptance/task
//     reconciliation, so it tracks a GENUINE business action, not a notification
//     tap.
// When the subsystem is disabled every caller receives available:false and the UI
// shows an honest "not recorded" state rather than an empty-but-implying-ready one.
import "server-only";
import { getOperationalCollections } from "@/lib/operations/collections";
import { notificationsEnabled } from "./notification-outbox";
import type { DeliveryAttemptRecord, NotificationRecord, OutboxRecord } from "@/types/notification";

export type SupervisorNotificationRow = {
  recipientUid: string;
  eventKind: string;
  deliveryStatus: OutboxRecord["status"] | null;
  transportAccepted: boolean; // outbox delivered => transport admitted (NOT a view receipt)
  attemptCount: number;
  lastErrorClass: string | null;
  openedAt: string | null; // advisory read metadata
  actionedAt: string | null; // genuine business action reconciliation
};

export type SupervisorNotificationActivity = {
  available: boolean;
  rows: SupervisorNotificationRow[];
  summary: {
    created: number;
    queued: number;
    delivered: number;
    failed: number;
    noDevice: number;
    opened: number;
    actioned: number;
  };
};

const EMPTY: SupervisorNotificationActivity = {
  available: false,
  rows: [],
  summary: { created: 0, queued: 0, delivered: 0, failed: 0, noDevice: 0, opened: 0, actioned: 0 },
};

export async function readSupervisorNotificationActivity(outgoingShiftId: string): Promise<SupervisorNotificationActivity> {
  if (!notificationsEnabled()) return EMPTY;
  const { notifications, notificationOutbox, notificationDeliveryAttempts } = getOperationalCollections();

  const notificationSnapshot = await notifications
    .where("outgoingShiftId", "==", outgoingShiftId)
    .limit(100)
    .get();

  const rows: SupervisorNotificationRow[] = [];
  for (const doc of notificationSnapshot.docs) {
    const record = doc.data() as NotificationRecord;
    const outboxSnapshot = await notificationOutbox.where("notificationId", "==", doc.id).limit(1).get();
    const outbox = outboxSnapshot.docs.length ? (outboxSnapshot.docs[0].data() as OutboxRecord) : null;
    let attemptCount = 0;
    if (outbox) {
      const attemptsSnapshot = await notificationDeliveryAttempts.where("outboxId", "==", outbox.idempotencyKey).get();
      attemptCount = attemptsSnapshot.docs.reduce((total, attemptDoc) => {
        const attempt = attemptDoc.data() as DeliveryAttemptRecord;
        return total + (attempt.transport ? 1 : 0);
      }, 0);
    }
    rows.push({
      recipientUid: record.recipientUid,
      eventKind: record.eventKind,
      deliveryStatus: outbox ? outbox.status : null,
      transportAccepted: outbox ? outbox.status === "delivered" : false,
      attemptCount,
      lastErrorClass: outbox?.lastError ?? null,
      openedAt: record.readAt,
      actionedAt: record.actionedAt,
    });
  }

  const summary = rows.reduce(
    (aggregate, row) => {
      aggregate.created += 1;
      if (row.deliveryStatus === "pending" || row.deliveryStatus === "retry" || row.deliveryStatus === "leased") aggregate.queued += 1;
      else if (row.deliveryStatus === "delivered") aggregate.delivered += 1;
      else if (row.deliveryStatus === "dead") aggregate.failed += 1;
      else if (row.deliveryStatus === "no_device") aggregate.noDevice += 1;
      if (row.openedAt) aggregate.opened += 1;
      if (row.actionedAt) aggregate.actioned += 1;
      return aggregate;
    },
    { created: 0, queued: 0, delivered: 0, failed: 0, noDevice: 0, opened: 0, actioned: 0 },
  );

  return { available: true, rows, summary };
}
