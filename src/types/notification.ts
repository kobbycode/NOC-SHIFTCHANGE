// TECH-HO-RECOVERY-09L — durable, UID-scoped notification domain.
//
// A notification is an OBSERVABILITY artifact only. It is never authoritative
// workflow state: creating, delivering, or opening a notification must never be
// interpreted as a handover confirmation, an incoming acceptance, task
// acceptance, or attendance. Those remain governed by the 09F/09G/09J/09K
// services. Push transport is best-effort; the durable record is the Firestore
// notification + outbox, not FCM.

export const NOTIFICATION_EVENT_KINDS = {
  HANDOVER_RESERVATION_UPCOMING: "handover_reservation_upcoming",
  HANDOVER_INITIATED: "handover_initiated",
  OUTGOING_CONFIRMATION_REQUIRED: "outgoing_confirmation_required",
  INCOMING_ACCEPTANCE_REQUIRED: "incoming_acceptance_required",
  HANDOVER_ABSENCE_RECORDED: "handover_absence_recorded",
  HANDOVER_COMPLETED: "handover_completed",
  TASK_ASSIGNED: "task_assigned",
  TASK_REASSIGNED: "task_reassigned",
  TASK_TRANSFER_OUTSTANDING: "task_transfer_outstanding",
} as const;

export type NotificationEventKind =
  (typeof NOTIFICATION_EVENT_KINDS)[keyof typeof NOTIFICATION_EVENT_KINDS];

// The business surface a notification points at. Kept as a closed allowlist so
// a deep link can never be forged into an arbitrary or unauthenticated target.
export const NOTIFICATION_TARGETS = {
  HANDOVER_V2: "handover_v2",
  TECHNICIAN_TASKS: "technician_tasks",
} as const;

export type NotificationTarget =
  (typeof NOTIFICATION_TARGETS)[keyof typeof NOTIFICATION_TARGETS];

// Per-recipient lifecycle. `created` is authoritative (persisted intent);
// `read`/`actioned` are advisory UI metadata and MUST NOT be treated as a
// business action.
export const NOTIFICATION_STATES = {
  UNREAD: "unread",
  READ: "read",
  ACTIONED: "actioned",
} as const;

export type NotificationState =
  (typeof NOTIFICATION_STATES)[keyof typeof NOTIFICATION_STATES];

// Outbox delivery lifecycle (transport concern, separate from read/action).
export const OUTBOX_STATUSES = {
  PENDING: "pending",
  LEASED: "leased",
  DELIVERED: "delivered",
  RETRY: "retry",
  DEAD: "dead",
  NO_DEVICE: "no_device",
} as const;

export type OutboxStatus =
  (typeof OUTBOX_STATUSES)[keyof typeof OUTBOX_STATUSES];

export const PUSH_TRANSPORT_OUTCOMES = {
  ACCEPTED: "accepted",
  FAILED_RETRYABLE: "failed_retryable",
  INVALID_TOKEN: "invalid_token",
  UNSUPPORTED: "unsupported",
} as const;

export type PushTransportOutcome =
  (typeof PUSH_TRANSPORT_OUTCOMES)[keyof typeof PUSH_TRANSPORT_OUTCOMES];

// A safe, non-sensitive deep-link descriptor. It carries only opaque ids; the
// receiving route re-checks authentication and authorization before showing any
// protected content.
export interface NotificationDeepLink {
  target: NotificationTarget;
  // Relative, allowlisted in-app path fragment (never a token or secret).
  params: Record<string, string>;
}

// The pure, transport-agnostic intent produced from an authoritative business
// event before it is written transactionally. One intent becomes one
// notification + one outbox row per recipient.
export interface NotificationIntent {
  // Deterministic, stable across retries: `${eventKind}:${eventId}:${recipientUid}`.
  idempotencyKey: string;
  eventKind: NotificationEventKind;
  recipientUid: string;
  // Opaque business references used for the deep link and supervisor join.
  outgoingShiftId: string | null;
  incomingShiftId: string | null;
  taskId: string | null;
  handoverId: string | null;
  // Short, non-sensitive display title. Message bodies are intentionally NOT
  // persisted here and NEVER placed in an unauthenticated push payload.
  title: string;
  deepLink: NotificationDeepLink;
  createdAt: string;
}

export interface NotificationRecord {
  schema: "notification-v1";
  idempotencyKey: string;
  eventKind: NotificationEventKind;
  recipientUid: string;
  outgoingShiftId: string | null;
  incomingShiftId: string | null;
  taskId: string | null;
  handoverId: string | null;
  title: string;
  deepLink: NotificationDeepLink;
  state: NotificationState;
  createdAt: string;
  readAt: string | null;
  actionedAt: string | null;
}

export interface OutboxRecord {
  schema: "notification-outbox-v1";
  idempotencyKey: string;
  notificationId: string;
  recipientUid: string;
  eventKind: NotificationEventKind;
  status: OutboxStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  lastOutcome: PushTransportOutcome | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryAttemptRecord {
  schema: "notification-delivery-attempt-v1";
  outboxId: string;
  notificationId: string;
  recipientUid: string;
  // A one-way, non-reversible device reference (never the raw token).
  deviceRef: string;
  transport: "mock" | "fcm";
  outcome: PushTransportOutcome;
  providerMessageId: string | null;
  errorClass: string | null;
  attemptedAt: string;
}

// A registered push device, bound to exactly one authenticated technician.
// The FCM registration token is a revocable device address, not a service
// credential. It is stored ONLY in this admin-only collection (client reads are
// denied by Firestore rules) and is never written to client-accessible logs.
export interface DeviceRegistration {
  schema: "device-registration-v1";
  uid: string;
  // Stable per browser installation (opaque client-generated id). Used so a
  // shared-device account switch deactivates the previous uid's binding.
  installationId: string;
  // The FCM registration token, required for delivery. Server/admin only.
  token: string;
  // A stable one-way hash used as the non-sensitive device reference in
  // delivery-attempt audits and dedup.
  tokenHash: string;
  // Truncated, non-sensitive token fingerprint for operator debugging only.
  tokenFingerprint: string;
  platform: string;
  active: boolean;
  registeredAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  deactivationReason: string | null;
}
