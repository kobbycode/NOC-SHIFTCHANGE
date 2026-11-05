/*
 * TECH-HO-RECOVERY-09L — pure notification domain unit tests (no emulator).
 * Run: node --experimental-strip-types --import tsx --test tests/notification-domain.test.mjs
 *
 * Covers: deterministic idempotency keys + document ids, recipient de-dup and
 * filtering, per-event title/target routing, safe deep-link resolution, token
 * hashing, and the mock transport's accepted / retryable / invalid / unsupported
 * branches.
 */
import assert from "node:assert/strict";
import test from "node:test";

const domain = await import("../src/lib/notifications/notification-domain.ts");
const { MockPushTransport } = await import("../src/lib/notifications/push-transport.ts");

const {
  buildNotificationIntents,
  computeIdempotencyKey,
  notificationDocumentId,
  outboxDocumentId,
  resolveNotificationRoute,
  tokenHash,
  tokenFingerprint,
} = domain;

test("idempotency key and document ids are deterministic and stable", () => {
  const key = computeIdempotencyKey("task_assigned", "evt-1", "uid-a");
  assert.equal(key, "task_assigned:evt-1:uid-a");
  assert.equal(notificationDocumentId(key), notificationDocumentId(key));
  assert.equal(outboxDocumentId(key), outboxDocumentId(key));
  assert.notEqual(notificationDocumentId(key), outboxDocumentId(key));
  assert.match(notificationDocumentId(key), /^[0-9a-f]{64}$/);
});

test("buildNotificationIntents de-dupes and drops blank recipients", () => {
  const intents = buildNotificationIntents({
    eventKind: "handover_reservation_upcoming",
    eventId: "h-1:3",
    recipientUids: ["a", "a", "b", "", "  ", "c"],
    refs: { outgoingShiftId: "out-1", incomingShiftId: "in-1", handoverId: "h-1" },
    createdAt: "2026-10-21T00:00:00.000Z",
  });
  assert.deepEqual(intents.map((i) => i.recipientUid).sort(), ["a", "b", "c"]);
  for (const intent of intents) {
    assert.equal(intent.eventKind, "handover_reservation_upcoming");
    assert.equal(intent.title, "Upcoming handover scheduled");
    assert.equal(intent.deepLink.target, "handover_v2");
    assert.equal(intent.deepLink.params.outgoingShiftId, "out-1");
  }
});

test("task events route to the technician task surface", () => {
  const [intent] = buildNotificationIntents({
    eventKind: "task_assigned",
    eventId: "hist-9",
    recipientUids: ["tech-1"],
    refs: { taskId: "task-9" },
    createdAt: "2026-10-21T00:00:00.000Z",
  });
  assert.equal(intent.deepLink.target, "technician_tasks");
  assert.equal(resolveNotificationRoute(intent), "/technician/tasks");
});

test("handover deep link resolves to a safe relative route; unknown falls back", () => {
  const [intent] = buildNotificationIntents({
    eventKind: "handover_completed",
    eventId: "h-2:9",
    recipientUids: ["t"],
    refs: { outgoingShiftId: "shift/with space" },
    createdAt: "2026-10-21T00:00:00.000Z",
  });
  assert.equal(resolveNotificationRoute(intent), "/technician/handovers/v2/shift%2Fwith%20space");
  assert.equal(resolveNotificationRoute({ deepLink: { target: "handover_v2", params: {} } }), "/technician");
});

// 09L.2 regression: every handover-scoped event kind must navigate to the V2
// technician workflow (/technician/handovers/v2/<id>), for every recipient role.
// The buggy resolver produced the V1 page for all of them.
test("all handover event kinds navigate to the V2 interface for every recipient", () => {
  const handoverKinds = [
    "handover_reservation_upcoming",
    "handover_initiated",
    "outgoing_confirmation_required",
    "incoming_acceptance_required",
    "handover_absence_recorded",
    "handover_completed",
    "task_transfer_outstanding",
  ];
  for (const eventKind of handoverKinds) {
    const intents = buildNotificationIntents({
      eventKind,
      eventId: `${eventKind}:evt-1`,
      // Outgoing + incoming participants and a shared task-transfer recipient.
      recipientUids: ["out-a", "out-b", "in-a", "in-b"],
      refs: {
        outgoingShiftId: "fkZeaajmeBkLxtPjghS3",
        incomingShiftId: "in-shift-1",
        handoverId: "h-1",
        ...(eventKind === "task_transfer_outstanding" ? { taskId: "task-1" } : {}),
      },
      createdAt: "2026-10-22T00:00:00.000Z",
    });
    assert.equal(intents.length, 4, eventKind);
    for (const intent of intents) {
      assert.equal(intent.deepLink.target, "handover_v2", eventKind);
      assert.equal(
        resolveNotificationRoute(intent),
        "/technician/handovers/v2/fkZeaajmeBkLxtPjghS3",
        `${eventKind} for ${intent.recipientUid}`,
      );
    }
  }
});

test("task events still route to the task surface, not a handover page", () => {
  for (const eventKind of ["task_assigned", "task_reassigned"]) {
    const [intent] = buildNotificationIntents({
      eventKind,
      eventId: `${eventKind}:hist-9`,
      recipientUids: ["tech-1"],
      refs: { taskId: "task-9", outgoingShiftId: "shift-9" },
      createdAt: "2026-10-22T00:00:00.000Z",
    });
    assert.equal(intent.deepLink.target, "technician_tasks");
    assert.equal(resolveNotificationRoute(intent), "/technician/tasks");
  }
});

test("an unknown stored target falls back to the neutral route, never a handover URL", () => {
  assert.equal(
    resolveNotificationRoute({ deepLink: { target: "handover_v1_ghost", params: { outgoingShiftId: "s-1" } } }),
    "/technician",
  );
});

test("token hash is one-way and fingerprint is a short prefix", () => {
  const hash = tokenHash("some-fcm-token");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(tokenFingerprint("some-fcm-token"), hash.slice(0, 8));
});

test("mock transport drives every delivery branch", async () => {
  const transport = new MockPushTransport();
  const base = { title: "T", deepLinkRoute: "/technician/tasks", notificationId: "n" };
  assert.equal((await transport.send({ ...base, token: "good" })).outcome, "accepted");
  assert.equal((await transport.send({ ...base, token: "fail:x" })).outcome, "failed_retryable");
  assert.equal((await transport.send({ ...base, token: "invalid:x" })).outcome, "invalid_token");
  assert.equal((await transport.send({ ...base, token: "unsupported" })).outcome, "unsupported");
  assert.equal(transport.sends.length, 4);
});
