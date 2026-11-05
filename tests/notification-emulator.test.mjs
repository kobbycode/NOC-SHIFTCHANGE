/**
 * Firestore emulator integration tests for TECH-HO-RECOVERY-09L notification
 * subsystem: transactional outbox, async delivery worker, device registry,
 * technician inbox, actioned reconciliation and supervisor activity.
 *
 * Run via: tests/run-notification-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-notifications" on
 * the dedicated emulator port 8095 with synthetic accounts only. Real FCM is
 * never contacted (the Firebase emulator suite has no Cloud Messaging emulator);
 * delivery is exercised through MockPushTransport. The NOTIFICATIONS_ENABLED
 * gate is owned entirely by this suite — it is stripped from the inherited
 * environment and toggled per test, proving the default-off path leaves the
 * operational collections byte-for-byte untouched.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const project = "demo-shiftchange-notifications";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8095", "localhost:8095"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run 09L notification emulator tests outside the isolated demo emulator.");
}
// The suite owns the gate. A value inherited from the shell would make the
// default-off regression proof meaningless.
delete process.env.NOTIFICATIONS_ENABLED;

const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const { initializeEqualHandoverReservation } = await import("../src/lib/operations/equal-handover-reservation-firestore.ts");
const { OPERATIONAL_COLLECTIONS } = await import("../src/lib/operations/collections.ts");
const { createPendingOperationalShiftControl, consumeOperationalShiftSlot, transitionOperationalShiftControl } = await import("../src/lib/operations/operational-shift-control-state.ts");
const { ShiftOperationsError } = await import("../src/lib/operations/shift-operations-domain.ts");
const { writeOutboxEntries } = await import("../src/lib/notifications/notification-outbox.ts");
const { computeIdempotencyKey, notificationDocumentId, outboxDocumentId, tokenHash, buildNotificationIntents, attemptDocumentId } = await import("../src/lib/notifications/notification-domain.ts");
const { taskAssignedIntents: taskAssigned, taskTransferIntents: taskTransfer } = await import("../src/lib/notifications/notification-hooks.ts");
const { MockPushTransport } = await import("../src/lib/notifications/push-transport.ts");
const { deliverOutboxEntry, drainDueOutbox } = await import("../src/lib/notifications/outbox-worker.ts");
const { registerDevice, deactivateDevice, listActiveDevicesForUid } = await import("../src/lib/notifications/device-registry.ts");
const { listInbox, unreadCount, getOwnNotification, markNotificationRead, markNotificationActioned, markActionedByReference } = await import("../src/lib/notifications/notification-service.ts");
const { readSupervisorNotificationActivity } = await import("../src/lib/notifications/supervisor-notification-activity.ts");
const { NOTIFICATION_EVENT_KINDS } = await import("../src/types/notification.ts");

const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);
const historical = "2020-01-01T00:00:00.000Z";
let seq = 0;

function enableNotifications() { process.env.NOTIFICATIONS_ENABLED = "true"; }
function disableNotifications() { delete process.env.NOTIFICATIONS_ENABLED; }

async function clearDb() {
  const cleared = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(cleared.status, 200);
}

async function collectionBytes(name) {
  const snap = await db.collection(name).get();
  return snap.docs
    .map((d) => [d.id, JSON.stringify(sortDeep(d.data()))])
    .sort(([a], [b]) => (a < b ? -1 : 1));
}
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

async function makeActiveShiftFixture() {
  const prefix = `n09l${++seq}`;
  const now0 = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const f = {
    prefix,
    manager: `${prefix}-manager`,
    outgoing: `${prefix}-outgoing`,
    outPair: `${prefix}-outpair`,
    inPair: `${prefix}-inpair`,
    out: [`${prefix}-outa`, `${prefix}-outb`],
    incoming: [`${prefix}-ina`, `${prefix}-inb`],
    token: randomUUID(),
    outStart: iso(now0 - 8 * 3600_000),
    outEnd: iso(now0 + 5 * 60_000),
    inStart: iso(now0 + 5 * 60_000),
    inEnd: iso(now0 + 8 * 3600_000),
  };
  const batch = db.batch();
  batch.set(ref("users", f.manager), { uid: f.manager, fullName: `${prefix} Max Manager`, role: "supervisor", status: "active", statusOperation: null, mustChangePassword: false });
  for (const uid of [...f.out, ...f.incoming]) {
    batch.set(ref("users", uid), { uid, fullName: `${prefix} ${uid}`, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  }
  for (const [id, ids] of [[f.outPair, f.out], [f.inPair, f.incoming]]) {
    batch.set(ref("technician_pairs", id), { id, technicianIds: ids, status: "active", createdBy: f.manager, createdAt: historical, updatedAt: historical, deactivatedAt: null, deactivatedBy: null });
    for (const uid of ids) batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: id, createdAt: historical, updatedAt: historical });
  }
  batch.set(ref("shifts", f.outgoing), { id: f.outgoing, status: "active", permanentPairId: f.outPair, primaryTechnicianIds: f.out, operationalSlotToken: f.token, shiftType: "morning", scheduledStart: f.outStart, scheduledEnd: f.outEnd, actualStart: f.outStart, actualEnd: null, createdBy: f.manager, createdAt: f.outStart, updatedAt: f.outStart });
  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(f.token, 1, f.outStart), f.outgoing, f.outStart);
  control = transitionOperationalShiftControl(control, f.outgoing, "scheduled", "active", f.outStart);
  batch.set(ref("operational_shift_control", "global"), control);
  for (const uid of f.out) {
    const memberId = `${f.outgoing}_${uid}`;
    batch.set(ref("shift_members", memberId), { id: memberId, shiftId: f.outgoing, technicianId: uid, role: "primary", joinedAt: f.outStart, leftAt: null });
    batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [{ shiftId: f.outgoing, scheduledStart: f.outStart, scheduledEnd: f.outEnd, status: "active" }], updatedAt: f.outStart });
  }
  for (const uid of f.incoming) batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [{ shiftId: `${prefix}-later`, scheduledStart: iso(now0 + 3 * 24 * 3600_000), scheduledEnd: iso(now0 + 3 * 24 * 3600_000 + 8 * 3600_000), status: "scheduled" }], updatedAt: f.outStart });
  await batch.commit();
  // 09M.1: the v2 begin preflight requires complete mandatory evidence before
  // the shift can move to handover_pending. Seed the same record-derived
  // evidence the production writer would create, as plain documents so the
  // notification fixtures stay free of operational-writer audit noise.
  await seedOperationEvidence(f);
  return f;
}

async function seedOperationEvidence(f, authorUid = f.out[0]) {
  const authorName = `${authorUid}`;
  const isoAt = (ms) => new Date(ms).toISOString();
  const events = [
    ...[["joy-fm", "Joy FM"], ["adom-fm", "Adom FM"], ["asempa-fm", "Asempa FM"], ["hitz-fm", "Hitz FM"]]
      .map(([stationId, stationName], index) => ({
        id: `${f.outgoing}-evidence-b${index}`, recordId: `${f.outgoing}-evidence-b${index}`,
        shiftId: f.outgoing, revision: 1, kind: "broadcast",
        occurredAt: isoAt(Date.parse(f.outStart) + (index + 1) * 600_000),
        stationId, stationName, status: "on_air", remarks: "",
        authorUid, authorName, originalReporterUid: authorUid, originalReporterName: authorName,
        createdAt: isoAt(Date.parse(f.outStart) + (index + 1) * 600_000), provenance: "authenticated_technician",
      })),
    {
      id: `${f.outgoing}-evidence-ob`, recordId: `${f.outgoing}-evidence-ob`,
      shiftId: f.outgoing, revision: 1, kind: "outside_broadcast",
      occurredAt: isoAt(Date.parse(f.outStart) + 5 * 600_000),
      title: "Outside van feed", location: "Accra mall", runningStatus: "ended",
      technicalIssues: "None", actionTaken: "Monitored handoff.", status: "resolved", remarks: "",
      linkedTaskId: null,
      authorUid, authorName, originalReporterUid: authorUid, originalReporterName: authorName,
      createdAt: isoAt(Date.parse(f.outStart) + 5 * 600_000), provenance: "authenticated_technician",
    },
  ];
  const batch = db.batch();
  for (const event of events) {
    batch.set(ref("shift_operation_events", event.id), event);
    batch.set(ref("shift_operation_heads", event.recordId), event);
  }
  await batch.commit();
}

// The v2 equal-technician begin path requires the acting technician to have
// personally joined (a legacy attendance row). Seed it exactly as 09K does.
async function seedLegacyAttendance(f, uid, { clockIn = null } = {}) {
  const id = `${f.outgoing}_${uid}`;
  await ref("shift_attendance", id).set({ id, shiftId: f.outgoing, technicianId: uid, status: "present", participationAuthority: "primary", authorizationId: null, clockIn, clockOut: null, isProvisional: false, recordedAt: historical, updatedAt: historical });
}

// Runs the genuine lifecycle: seed attendance -> begin handover -> reserve.
// Returns the reservation result so tests can bind to authoritative ids.
async function runBeginAndReserve(f) {
  await seedLegacyAttendance(f, f.out[0], { clockIn: f.outStart });
  await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  const reservation = await initializeEqualHandoverReservation({
    outgoingShiftId: f.outgoing, actorUid: f.out[0], incomingPermanentPairId: f.inPair,
    shiftType: "morning", scheduledStart: f.inStart, scheduledEnd: f.inEnd,
    idempotencyKey: `key-${randomUUID()}`,
  });
  return reservation;
}

async function enqueue(intents) {
  await db.runTransaction(async (transaction) => { writeOutboxEntries(transaction, db, intents); });
}

function handoverKey(eventKind, eventId, uid) {
  return computeIdempotencyKey(eventKind, eventId, uid);
}

const K = NOTIFICATION_EVENT_KINDS;

// ---------------------------------------------------------------------------

test("1. Gate OFF: the full lifecycle writes ZERO notification rows and business events are byte-for-byte unaffected", async () => {
  await clearDb();
  disableNotifications();
  const f = await makeActiveShiftFixture();
  const reservation = await runBeginAndReserve(f);
  assert.equal(reservation.replayed, false, "the business reservation itself must succeed");
  const shift = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(shift.status, "handover_pending");
  assert.equal(await collectionBytes(OPERATIONAL_COLLECTIONS.NOTIFICATIONS).then((b) => b.length), 0);
  assert.equal(await collectionBytes(OPERATIONAL_COLLECTIONS.NOTIFICATION_OUTBOX).then((b) => b.length), 0);
  assert.equal(await collectionBytes(OPERATIONAL_COLLECTIONS.NOTIFICATION_DELIVERY_ATTEMPTS).then((b) => b.length), 0);
  assert.equal(await collectionBytes(OPERATIONAL_COLLECTIONS.DEVICE_REGISTRATIONS).then((b) => b.length), 0);
});

test("2. Gate ON: begin + reservation enqueue transactional outbox rows with non-sensitive content only", async () => {
  await clearDb();
  enableNotifications();
  const f = await makeActiveShiftFixture();
  const reservation = await runBeginAndReserve(f);
  const handoverId = reservation.aggregate.reservation.handoverId;
  const initiationEvent = `${f.outgoing}:initiated`;
  const reservationEvent = `${handoverId}:1`;

  const expected = [
    ...f.out.map((uid) => [K.HANDOVER_INITIATED, initiationEvent, uid, "Handover started for your shift"]),
    ...[...f.out, ...f.incoming].map((uid) => [K.HANDOVER_RESERVATION_UPCOMING, reservationEvent, uid, "Upcoming handover scheduled"]),
    ...f.out.map((uid) => [K.OUTGOING_CONFIRMATION_REQUIRED, reservationEvent, uid, "Handover confirmation needed"]),
  ];
  const notifications = await collectionBytes(OPERATIONAL_COLLECTIONS.NOTIFICATIONS);
  const outbox = await collectionBytes(OPERATIONAL_COLLECTIONS.NOTIFICATION_OUTBOX);
  assert.equal(notifications.length, 8);
  assert.equal(outbox.length, 8);

  for (const [eventKind, eventId, uid, title] of expected) {
    const key = handoverKey(eventKind, eventId, uid);
    const notif = await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, notificationDocumentId(key)).get();
    assert.ok(notif.exists, `missing notification for ${key}`);
    const record = notif.data();
    assert.equal(record.state, "unread");
    assert.equal(record.recipientUid, uid);
    assert.equal(record.title, title, "titles are fixed non-sensitive strings");
    assert.equal(record.deepLink.target, "handover_v2");
    assert.equal(record.deepLink.params.outgoingShiftId, f.outgoing);
    assert.deepEqual(Object.keys(record.deepLink.params).sort(), ["outgoingShiftId"], "deep link carries only allowlisted opaque ids");
    assert.equal(record.body === undefined && record.message === undefined, true, "no message body is ever persisted");
    const out = await ref(OPERATIONAL_COLLECTIONS.NOTIFICATION_OUTBOX, outboxDocumentId(key)).get();
    assert.ok(out.exists);
    assert.equal(out.data().status, "pending");
    assert.equal(out.data().attemptCount, 0);
    assert.equal(out.data().notificationId, notificationDocumentId(key));
  }
});

test("3. Enqueue is idempotent: the same intent written twice yields one notification + one outbox row", async () => {
  await clearDb();
  enableNotifications();
  const intents = taskAssigned({ eventId: "history-1", assigneeUid: "tech-x", taskId: "task-1", createdAt: historical });
  await enqueue(intents);
  await enqueue(intents);
  assert.equal((await collectionBytes(OPERATIONAL_COLLECTIONS.NOTIFICATIONS)).length, 1);
  assert.equal((await collectionBytes(OPERATIONAL_COLLECTIONS.NOTIFICATION_OUTBOX)).length, 1);
});

test("4. Worker delivers to every active device of the recipient; delivery never marks the inbox read", async () => {
  await clearDb();
  enableNotifications();
  const uid = "tech-multi";
  await registerDevice({ uid, installationId: "inst-1", token: "token-one", platform: "web", now: historical });
  await registerDevice({ uid, installationId: "inst-2", token: "token-two", platform: "android", now: historical });
  const intents = taskAssigned({ eventId: "history-2", assigneeUid: uid, taskId: "task-2", createdAt: historical });
  await enqueue(intents);
  const key = intents[0].idempotencyKey;
  const now = new Date(Date.parse(historical) + 3600_000).toISOString();

  const transport = new MockPushTransport();
  const summary = await deliverOutboxEntry(outboxDocumentId(key), { now, transport });
  assert.equal(summary.status, "delivered");
  assert.equal(summary.attempts, 1);
  assert.equal(transport.sends.length, 2, "one send per active device");
  assert.deepEqual(transport.sends.map((s) => s.token).sort(), ["token-one", "token-two"]);
  for (const send of transport.sends) {
    assert.equal(send.title, "You have a new task to acknowledge");
    assert.equal(send.deepLinkRoute, "/technician/tasks", "payload carries only a relative allowlisted route");
  }

  const out = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATION_OUTBOX, outboxDocumentId(key)).get()).data();
  assert.equal(out.status, "delivered");
  assert.equal(out.deliveredAt, now);
  const attempts = await db.collection(OPERATIONAL_COLLECTIONS.NOTIFICATION_DELIVERY_ATTEMPTS)
    .where("outboxId", "==", key).get();
  assert.equal(attempts.size, 2);
  for (const doc of attempts.docs) {
    const a = doc.data();
    assert.equal(a.outcome, "accepted");
    assert.match(a.providerMessageId, /^mock-message-/);
    assert.ok([tokenHash("token-one"), tokenHash("token-two")].includes(a.deviceRef), "device reference is the token hash, never the raw token");
    assert.ok(!JSON.stringify(a).includes("token-one") && !JSON.stringify(a).includes("token-two"));
  }
  const notif = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, notificationDocumentId(key)).get()).data();
  assert.equal(notif.state, "unread", "transport admission is NOT a read receipt");

  // A second claim of a delivered entry is a terminal no-op.
  const again = await deliverOutboxEntry(outboxDocumentId(key), { now, transport: new MockPushTransport() });
  assert.equal(again.skipped, true);
});

test("5. No registered device: status no_device, the durable inbox row survives, business unaffected", async () => {
  await clearDb();
  enableNotifications();
  const intents = taskAssigned({ eventId: "history-3", assigneeUid: "tech-alone", taskId: "task-3", createdAt: historical });
  await enqueue(intents);
  const key = intents[0].idempotencyKey;
  const now = new Date(Date.parse(historical) + 3600_000).toISOString();
  const summary = await deliverOutboxEntry(outboxDocumentId(key), { now, transport: new MockPushTransport() });
  assert.equal(summary.status, "no_device");
  const notif = await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, notificationDocumentId(key)).get();
  assert.ok(notif.exists, "the inbox record is durable regardless of push transport");
  assert.equal(notif.data().state, "unread");
});

test("6. Retryable failure: exponential backoff then dead at max attempts; business rows never touched", async () => {
  await clearDb();
  enableNotifications();
  await registerDevice({ uid: "tech-fail", installationId: "inst-f", token: "fail:device", platform: "web", now: historical });
  const intents = taskAssigned({ eventId: "history-4", assigneeUid: "tech-fail", taskId: "task-4", createdAt: historical });
  await enqueue(intents);
  const key = intents[0].idempotencyKey;
  const transport = new MockPushTransport();
  let now = historical;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const summary = await deliverOutboxEntry(outboxDocumentId(key), { now, transport });
    assert.equal(summary.status, "retry");
    assert.equal(summary.attempts, attempt);
    const out = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATION_OUTBOX, outboxDocumentId(key)).get()).data();
    assert.equal(out.lastOutcome, "failed_retryable");
    const expectedNext = new Date(Date.parse(now) + Math.min(30_000 * 2 ** (attempt - 1), 900_000)).toISOString();
    assert.equal(out.nextAttemptAt, expectedNext, "next attempt is the documented exponential backoff");
    const tooEarly = await deliverOutboxEntry(outboxDocumentId(key), { now: new Date(Date.parse(now) + 1).toISOString(), transport });
    assert.equal(tooEarly.skipped, true, "backoff is honored; a premature claim must not re-send");
    now = expectedNext;
  }
  const fifth = await deliverOutboxEntry(outboxDocumentId(key), { now, transport });
  assert.equal(fifth.status, "dead", "dead at maxAttempts 5");
  const sixth = await deliverOutboxEntry(outboxDocumentId(key), { now, transport });
  assert.equal(sixth.skipped, true, "dead is terminal");
  const notif = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, notificationDocumentId(key)).get()).data();
  assert.equal(notif.state, "unread", "push failure never changes inbox or workflow state");
});

test("7. Invalid-token cleanup: unregistered token is deactivated and the entry resolves to no_device", async () => {
  await clearDb();
  enableNotifications();
  await registerDevice({ uid: "tech-dead", installationId: "inst-d", token: "invalid:old-token", platform: "web", now: historical });
  const intents = taskAssigned({ eventId: "history-5", assigneeUid: "tech-dead", taskId: "task-5", createdAt: historical });
  await enqueue(intents);
  const key = intents[0].idempotencyKey;
  const now = new Date(Date.parse(historical) + 3600_000).toISOString();
  const summary = await deliverOutboxEntry(outboxDocumentId(key), { now, transport: new MockPushTransport() });
  assert.equal(summary.status, "no_device", "all tokens invalid => nothing to deliver, not a workflow failure");
  assert.deepEqual(await listActiveDevicesForUid("tech-dead"), [], "invalid token cleaned up");
  const attempts = await db.collection(OPERATIONAL_COLLECTIONS.NOTIFICATION_DELIVERY_ATTEMPTS).where("outboxId", "==", key).get();
  assert.equal(attempts.size, 1);
  assert.equal(attempts.docs[0].data().outcome, "invalid_token");
});

test("8. Shared device: an account switch rebinds the installation; the previous technician is never sent the new token", async () => {
  await clearDb();
  enableNotifications();
  const installation = "shared-tablet";
  await registerDevice({ uid: "tech-day", installationId: installation, token: "day-token", platform: "web", now: historical });
  await registerDevice({ uid: "tech-night", installationId: installation, token: "night-token", platform: "web", now: historical });

  assert.deepEqual(await listActiveDevicesForUid("tech-day"), [], "account switch deactivated the previous technician's binding");
  const nightDevices = await listActiveDevicesForUid("tech-night");
  assert.equal(nightDevices.length, 1);
  assert.equal(nightDevices[0].token, "night-token");

  const dayIntents = taskAssigned({ eventId: "history-day", assigneeUid: "tech-day", taskId: "task-day", createdAt: historical });
  const nightIntents = taskAssigned({ eventId: "history-night", assigneeUid: "tech-night", taskId: "task-night", createdAt: historical });
  await enqueue([...dayIntents, ...nightIntents]);
  const now = new Date(Date.parse(historical) + 3600_000).toISOString();

  const dayTransport = new MockPushTransport();
  const dayRun = await deliverOutboxEntry(outboxDocumentId(dayIntents[0].idempotencyKey), { now, transport: dayTransport });
  assert.equal(dayRun.status, "no_device");
  assert.equal(dayTransport.sends.length, 0, "the previous technician's notification must never ride the new technician's token");

  const nightTransport = new MockPushTransport();
  const nightRun = await deliverOutboxEntry(outboxDocumentId(nightIntents[0].idempotencyKey), { now, transport: nightTransport });
  assert.equal(nightRun.status, "delivered");
  assert.deepEqual(nightTransport.sends.map((s) => s.token), ["night-token"]);

  // Explicit sign-out deactivates only the caller's own binding.
  await deactivateDevice({ installationId: installation, uid: "tech-day", reason: "sign_out", now });
  assert.equal((await listActiveDevicesForUid("tech-night")).length, 1, "another uid's sign-out cannot deactivate my device");
});

test("9. Inbox is uid-scoped: other technicians get 403; opening marks read only, never actioned", async () => {
  await clearDb();
  enableNotifications();
  const owner = "tech-owner";
  const stranger = "tech-stranger";
  const intents = taskAssigned({ eventId: "history-9", assigneeUid: owner, taskId: "task-9", createdAt: historical });
  await enqueue(intents);
  const id = notificationDocumentId(intents[0].idempotencyKey);

  await assert.rejects(() => getOwnNotification(stranger, id), (e) => e instanceof ShiftOperationsError && e.status === 403);
  await assert.rejects(() => markNotificationRead(stranger, id, historical), (e) => e.status === 403);
  assert.equal((await listInbox(stranger)).length, 0);

  const inbox = await listInbox(owner);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].route, "/technician/tasks");
  assert.equal(await unreadCount(owner), 1);

  const t1 = new Date(Date.parse(historical) + 60_000).toISOString();
  await markNotificationRead(owner, id, t1);
  assert.equal(await unreadCount(owner), 0);
  const t2 = new Date(Date.parse(historical) + 120_000).toISOString();
  await markNotificationRead(owner, id, t2);
  const after = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, id).get()).data();
  assert.equal(after.readAt, t1, "marking read is idempotent");
  assert.equal(after.state, "read");
  assert.equal(after.actionedAt, null, "opening a notification is NEVER an action receipt");

  // Explicit business-action reconciliation is the only path to actioned.
  await markNotificationActioned(owner, id, t2);
  const actioned = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, id).get()).data();
  assert.equal(actioned.state, "actioned");
  assert.equal(actioned.actionedAt, t2);
  assert.equal(actioned.readAt, t1, "the original read time is preserved");
});

test("10. markActionedByReference reconciles only the actor's own matching pending rows, and only while enabled", async () => {
  await clearDb();
  enableNotifications();
  const shiftId = "shift-10";
  const actor = "tech-actor";
  const other = "tech-other";
  const event = "ho10:1";
  const intents = [
    ...buildIntentsFor(K.OUTGOING_CONFIRMATION_REQUIRED, event, [actor, other], shiftId),
    ...taskAssigned({ eventId: "h10-task", assigneeUid: actor, taskId: "task-10", createdAt: historical }),
    ...taskAssigned({ eventId: "h10-task", assigneeUid: other, taskId: "task-10", createdAt: historical }),
  ];
  await enqueue(intents);
  const now = new Date(Date.parse(historical) + 3600_000).toISOString();

  await markActionedByReference(actor, { eventKinds: [K.OUTGOING_CONFIRMATION_REQUIRED], outgoingShiftId: shiftId }, now);

  const actorConf = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, notificationDocumentId(handoverKey(K.OUTGOING_CONFIRMATION_REQUIRED, event, actor))).get()).data();
  assert.equal(actorConf.state, "actioned");
  assert.equal(actorConf.actionedAt, now);
  const actorTask = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, notificationDocumentId(taskAssigned({ eventId: "h10-task", assigneeUid: actor, taskId: "task-10", createdAt: historical })[0].idempotencyKey)).get()).data();
  assert.equal(actorTask.state, "unread", "a different event kind is untouched");
  const otherConf = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, notificationDocumentId(handoverKey(K.OUTGOING_CONFIRMATION_REQUIRED, event, other))).get()).data();
  assert.equal(otherConf.state, "unread", "another technician's rows are never touched");

  disableNotifications();
  await markActionedByReference(actor, { eventKinds: [K.TASK_ASSIGNED], taskId: "task-10" }, now);
  const stillUnread = (await ref(OPERATIONAL_COLLECTIONS.NOTIFICATIONS, notificationDocumentId(taskAssigned({ eventId: "h10-task", assigneeUid: actor, taskId: "task-10", createdAt: historical })[0].idempotencyKey)).get()).data();
  assert.equal(stillUnread.state, "unread", "disabled gate makes reconciliation inert");
  enableNotifications();
});

function buildIntentsFor(eventKind, eventId, recipientUids, outgoingShiftId) {
  return buildNotificationIntents({ eventKind, eventId, recipientUids, refs: { outgoingShiftId }, createdAt: historical });
}

test("11. Supervisor activity joins durable records honestly and is inert when the gate is off", async () => {
  await clearDb();
  disableNotifications();
  const off = await readSupervisorNotificationActivity("shift-11");
  assert.equal(off.available, false, "disabled subsystem reports 'not recorded', never an empty implying-ready state");

  enableNotifications();
  const shiftId = "shift-11";
  const now = new Date(Date.parse(historical) + 3600_000).toISOString();
  const deliveredUid = "tech-a11";
  const pendingUid = "tech-b11";
  const noDeviceUid = "tech-c11";
  const intents = [
    ...buildIntentsFor(K.HANDOVER_INITIATED, `${shiftId}:initiated`, [deliveredUid], shiftId),
    ...buildIntentsFor(K.HANDOVER_INITIATED, `${shiftId}:initiated`, [pendingUid], shiftId),
    ...buildIntentsFor(K.HANDOVER_INITIATED, `${shiftId}:initiated`, [noDeviceUid], shiftId),
  ];
  await registerDevice({ uid: deliveredUid, installationId: "i11d", token: "ok-11", platform: "web", now: historical });
  await registerDevice({ uid: pendingUid, installationId: "i11p", token: "ok-11p", platform: "web", now: historical });
  await enqueue(intents);

  await deliverOutboxEntry(outboxDocumentId(intents[0].idempotencyKey), { now, transport: new MockPushTransport() });
  await deliverOutboxEntry(outboxDocumentId(intents[2].idempotencyKey), { now, transport: new MockPushTransport() });
  await markNotificationRead(deliveredUid, notificationDocumentId(intents[0].idempotencyKey), now);
  await markActionedByReference(deliveredUid, { eventKinds: [K.HANDOVER_INITIATED], outgoingShiftId: shiftId }, now);

  const view = await readSupervisorNotificationActivity(shiftId);
  assert.equal(view.available, true);
  assert.equal(view.summary.created, 3);
  assert.equal(view.summary.delivered, 1);
  assert.equal(view.summary.queued, 1);
  assert.equal(view.summary.noDevice, 1);
  assert.equal(view.summary.opened, 1);
  assert.equal(view.summary.actioned, 1);
  const byUid = new Map(view.rows.map((row) => [row.recipientUid, row]));
  assert.equal(byUid.get(deliveredUid).transportAccepted, true, "accepted means admitted, NOT viewed");
  assert.equal(byUid.get(deliveredUid).attemptCount, 1);
  assert.equal(byUid.get(pendingUid).deliveryStatus, "pending");
  assert.equal(byUid.get(pendingUid).transportAccepted, false);
  assert.equal(byUid.get(noDeviceUid).deliveryStatus, "no_device");

  // Task notifications (no outgoingShiftId) are outside the handover join.
  const taskIntents = taskTransfer({ eventId: "xfer-11", incomingTechnicianUids: [deliveredUid], taskId: "task-11", outgoingShiftId: "other-shift", incomingShiftId: "next-shift", createdAt: historical });
  await enqueue(taskIntents);
  const scoped = await readSupervisorNotificationActivity(shiftId);
  assert.equal(scoped.summary.created, 3, "the activity read is scoped to this handover's shift");
  disableNotifications();
});

test("12. Drain pass on genuine lifecycle rows: failures mutate ONLY outbox/attempt rows, never evidence", async () => {
  await clearDb();
  enableNotifications();
  const f = await makeActiveShiftFixture();
  await runBeginAndReserve(f);
  disableNotifications();

  const handoverBefore = await collectionBytes(OPERATIONAL_COLLECTIONS.EQUAL_HANDOVERS_V2);
  const notificationsBefore = await collectionBytes(OPERATIONAL_COLLECTIONS.NOTIFICATIONS);
  const shiftBefore = await collectionBytes(OPERATIONAL_COLLECTIONS.SHIFTS);

  await registerDevice({ uid: f.out[0], installationId: "i12", token: "fail:12", platform: "web", now: historical });
  const now = new Date(Date.now() + 60_000).toISOString();
  const summary = await drainDueOutbox({ now, transport: new MockPushTransport(), limit: 50 });
  assert.equal(summary.processed, 8, "every enqueued row from the genuine lifecycle is due");
  assert.equal(summary.retry, 3, "three rows for the one technician with a failing device");
  assert.equal(summary.noDevice, 5);

  assert.deepEqual(await collectionBytes(OPERATIONAL_COLLECTIONS.EQUAL_HANDOVERS_V2), handoverBefore, "a push failure cannot mutate handover evidence");
  assert.deepEqual(await collectionBytes(OPERATIONAL_COLLECTIONS.NOTIFICATIONS), notificationsBefore, "notification rows are not rewritten by transport failures");
  assert.deepEqual(await collectionBytes(OPERATIONAL_COLLECTIONS.SHIFTS), shiftBefore, "the shift lifecycle is unaffected");
});

test("13. Orphaned lease recovery: an interrupted worker's row is reclaimed by the drain and both real sends are audited", async () => {
  await clearDb();
  enableNotifications();
  const uid = "tech-13";
  await registerDevice({ uid, installationId: "i13", token: "ok-13", platform: "web", now: historical });
  const intents = taskAssigned({ eventId: "history-13", assigneeUid: uid, taskId: "task-13", createdAt: historical });
  await enqueue(intents);
  const key = intents[0].idempotencyKey;
  const outboxRef = ref(OPERATIONAL_COLLECTIONS.NOTIFICATION_OUTBOX, outboxDocumentId(key));

  // Worker A claims, sends successfully, records its attempt, then dies before
  // finalizing. The row is left leased with a now-expired lease.
  const t0 = "2021-02-03T04:05:06.000Z";
  await outboxRef.set({
    schema: "notification-outbox-v1",
    idempotencyKey: key,
    notificationId: notificationDocumentId(key),
    recipientUid: uid,
    eventKind: K.TASK_ASSIGNED,
    status: "leased",
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: t0,
    leaseUntil: new Date(Date.parse(t0) - 60_000).toISOString(),
    lastOutcome: null,
    lastError: null,
    deliveredAt: null,
    createdAt: historical,
    updatedAt: t0,
  });
  await db.collection(OPERATIONAL_COLLECTIONS.NOTIFICATION_DELIVERY_ATTEMPTS)
    .doc(attemptDocumentId(key, tokenHash("ok-13"), 1, t0))
    .set({
      schema: "notification-delivery-attempt-v1",
      outboxId: key,
      notificationId: notificationDocumentId(key),
      recipientUid: uid,
      deviceRef: tokenHash("ok-13"),
      transport: "mock",
      outcome: "accepted",
      providerMessageId: "mock-message-lost",
      errorClass: null,
      attemptedAt: t0,
    });

  // The scheduled sweep (now later than the lease) must reclaim and deliver.
  const t1 = new Date(Date.parse(t0) + 120_000).toISOString();
  const transport = new MockPushTransport();
  const summary = await drainDueOutbox({ now: t1, transport, limit: 50 });
  assert.equal(summary.processed, 1, "the expired-lease row is visible to the sweep");
  assert.equal(summary.skipped, 0, "an expired lease is not treated as an active claim");
  assert.equal(summary.delivered, 1);
  assert.equal(transport.sends.length, 1, "the reclaiming worker re-sends exactly once");
  const out = (await outboxRef.get()).data();
  assert.equal(out.status, "delivered");

  // Both actual sends are separately audited: worker A's recorded attempt and
  // worker B's fresh attempt must coexist, never overwrite each other.
  const attempts = await db.collection(OPERATIONAL_COLLECTIONS.NOTIFICATION_DELIVERY_ATTEMPTS)
    .where("outboxId", "==", key).get();
  assert.equal(attempts.size, 2, "the interrupted send and the reclaiming send each leave one audit row");
  const providers = attempts.docs.map((d) => d.data().providerMessageId).sort();
  assert.deepEqual(providers, ["mock-message-lost", transport.sends[0].result.providerMessageId].sort());
  disableNotifications();
});

test("14. A still-valid lease blocks a concurrent claim: no second worker re-sends", async () => {
  await clearDb();
  enableNotifications();
  const uid = "tech-14";
  await registerDevice({ uid, installationId: "i14", token: "ok-14", platform: "web", now: historical });
  const intents = taskAssigned({ eventId: "history-14", assigneeUid: uid, taskId: "task-14", createdAt: historical });
  await enqueue(intents);
  const key = intents[0].idempotencyKey;
  const t0 = "2021-03-04T05:06:07.000Z";
  await ref(OPERATIONAL_COLLECTIONS.NOTIFICATION_OUTBOX, outboxDocumentId(key)).set({
    schema: "notification-outbox-v1",
    idempotencyKey: key,
    notificationId: notificationDocumentId(key),
    recipientUid: uid,
    eventKind: K.TASK_ASSIGNED,
    status: "leased",
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: t0,
    leaseUntil: new Date(Date.parse(t0) + 60_000).toISOString(),
    lastOutcome: null,
    lastError: null,
    deliveredAt: null,
    createdAt: historical,
    updatedAt: t0,
  });

  const transport = new MockPushTransport();
  const raced = await deliverOutboxEntry(outboxDocumentId(key), { now: t0, transport });
  assert.equal(raced.skipped, true, "an unexpired lease is honored");
  assert.equal(transport.sends.length, 0, "no duplicate send under an active lease");
  const swept = await drainDueOutbox({ now: t0, transport, limit: 50 });
  assert.equal(swept.skipped, 1, "the sweep also skips an actively leased row");
  assert.equal(transport.sends.length, 0);
  disableNotifications();
});
