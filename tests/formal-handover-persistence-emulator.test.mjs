import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const project = "demo-shiftchange-handover";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !["127.0.0.1:8088", "localhost:8088"].includes(host) ||
    ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]
      .some((key) => process.env[key] !== project)) throw new Error("Refusing to run outside the isolated local demo emulator.");
const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status));
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { initializeFormalHandover: initialize, replaceFormalHandoverReservation: replace,
  cancelFormalHandoverReservation: cancel } = await import("../src/lib/operations/formal-handover.ts");
const { assertHandoverAggregate, confirmHandoverParticipant } = await import("../src/lib/operations/handover-domain.ts");
const { createHandoverWorkSnapshot } = await import("../src/lib/operations/handover-work-snapshot.ts");
const { createPendingOperationalShiftControl, consumeOperationalShiftSlot, transitionOperationalShiftControl } =
  await import("../src/lib/operations/operational-shift-control-state.ts");
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const { createTask } = await import("../src/lib/operations/create-task.ts");
const { createTaskAssignment } = await import("../src/lib/operations/create-task-assignment.ts");
const { reassignTask } = await import("../src/lib/operations/reassign-task.ts");
const { respondToTaskAssignment } = await import("../src/lib/operations/respond-to-task-assignment.ts");
const { transitionTask } = await import("../src/lib/operations/task-lifecycle.ts");
const { requireSafeAccountBlocking, AccountOperationalError } = await import("../src/lib/accounts/account-status-eligibility.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { deactivateTechnicianPair } = await import("../src/lib/operations/deactivate-technician-pair.ts");
const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);
const at = "2020-01-01T00:00:00.000Z";
const start = "2030-01-01T06:00:00.000Z";
const end = "2030-01-01T14:00:00.000Z";
const unrelated = { shiftId: "unrelated", scheduledStart: "2030-01-03T06:00:00.000Z", scheduledEnd: "2030-01-03T14:00:00.000Z", status: "scheduled" };
let sequence = 0;
async function fixture(status = "handover_pending", role = "admin") {
  const cleared = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(cleared.status, 200);
  const prefix = `f${++sequence}`;
  const f = { actor: `${prefix}-manager`, outgoing: `${prefix}-outgoing`, outPair: `${prefix}-outpair`,
    inPair: `${prefix}-inpair`, newPair: `${prefix}-newpair`, out: [`${prefix}-outa`, `${prefix}-outb`],
    incoming: [`${prefix}-ina`, `${prefix}-inb`], replacement: [`${prefix}-newa`, `${prefix}-newb`], token: randomUUID(), role };
  f.input = { outgoingShiftId: f.outgoing, actorUid: f.actor, expectedRole: role,
    incomingPermanentPairId: f.inPair, shiftType: "morning", scheduledStart: start, scheduledEnd: end };
  const batch = db.batch();
  for (const [uid, userRole] of [[f.actor, role], ...[...f.out, ...f.incoming, ...f.replacement].map((uid) => [uid, "technician"])]) {
    batch.set(ref("users", uid), { uid, role: userRole, status: "active", statusOperation: null, mustChangePassword: false });
  }
  for (const [id, ids] of [[f.outPair, f.out], [f.inPair, f.incoming], [f.newPair, f.replacement]]) {
    batch.set(ref("technician_pairs", id), { id, technicianIds: ids, status: "active", createdBy: f.actor,
      createdAt: at, updatedAt: at, deactivatedAt: null, deactivatedBy: null });
    for (const uid of ids) batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: id, createdAt: at, updatedAt: at });
  }
  f.shift = { id: f.outgoing, status, permanentPairId: f.outPair, primaryTechnicianIds: f.out,
    operationalSlotToken: f.token, shiftType: "morning", scheduledStart: "2020-01-01T06:00:00.000Z",
    scheduledEnd: "2020-01-01T14:00:00.000Z", actualStart: at, actualEnd: null,
    createdBy: f.actor, createdAt: at, updatedAt: at };
  batch.set(ref("shifts", f.outgoing), f.shift);
  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(f.token, 1, at), f.outgoing, at);
  control = transitionOperationalShiftControl(control, f.outgoing, "scheduled", "active", at);
  if (status === "handover_pending") control = transitionOperationalShiftControl(control, f.outgoing, "active", status, at);
  batch.set(ref("operational_shift_control", "global"), control);
  f.control = control;
  for (const uid of f.out) {
    const id = `${f.outgoing}_${uid}`;
    batch.set(ref("shift_members", id), { id, shiftId: f.outgoing, technicianId: uid, role: "primary", joinedAt: at, leftAt: null });
    batch.set(ref("technician_schedules", uid), { technicianUid: uid, entries: [{ shiftId: f.outgoing,
      scheduledStart: f.shift.scheduledStart, scheduledEnd: f.shift.scheduledEnd, status }], updatedAt: at });
  }
  for (const uid of [...f.incoming, ...f.replacement]) batch.set(ref("technician_schedules", uid), {
    technicianUid: uid, entries: [unrelated], updatedAt: at, preservedMetadata: "keep",
  });
  await batch.commit();
  return f;
}
function bound(result) { return { expectedRevision: result.aggregate.revision, expectedSnapshotHash: result.snapshotHash }; }
async function data(collection, id) { return (await ref(collection, id).get()).data(); }
async function state() {
  const result = {};
  for (const collection of ["handovers", "technician_schedules", "audit_logs", "operational_shift_control", "shifts", "shift_members", "shift_attendance", "task_assignments", "next_shift_authorizations"]) {
    const documents = await db.collection(collection).get();
    result[collection] = documents.docs.map((document) => ({ id: document.id, data: document.data() })).sort((a, b) => a.id.localeCompare(b.id));
  }
  return result;
}
async function rejectsAtomically(operation) {
  const before = await state();
  await assert.rejects(operation);
  assert.deepEqual(await state(), before);
}
async function work(f) {
  const tasks = (await db.collection("tasks").where("shiftId", "==", f.outgoing).get()).docs.map((document) => document.data());
  const assignments = [];
  for (const task of tasks) assignments.push(...(await db.collection("task_assignments").where("taskId", "==", task.id).get()).docs.map((document) => document.data()));
  return createHandoverWorkSnapshot({ outgoingShiftId: f.outgoing, tasks, assignments });
}
async function seedTask(f, status = "open", id = `${f.outgoing}-task`) {
  const task = { id, shiftId: f.outgoing, title: "Authoritative work", description: "Pending work", priority: "medium",
    sectionId: null, status, createdBy: f.actor, createdAt: at, updatedAt: at };
  await ref("tasks", id).set(task);
  return task;
}
async function seedAssignment(f, task, uid = f.out[0], extra = {}) {
  const id = `${task.id}_${uid}`;
  const assignment = { id, taskId: task.id, technicianId: uid, responsibility: "lead", responsibilityStatus: "active",
    acceptanceStatus: "pending", assignedBy: f.actor, assignedAt: at, acceptedAt: null, rejectedAt: null,
    rejectionReason: null, releasedAt: null, releasedBy: null, transferredTo: null, ...extra };
  await ref("task_assignments", id).set(assignment);
  return assignment;
}
async function unchangedOwnershipAndTargets(f, aggregate) {
  assert.deepEqual(await data("operational_shift_control", "global"), f.control);
  assert.deepEqual(await data("shifts", f.outgoing), f.shift);
  assert.equal(await data("shifts", aggregate.identity.incomingShiftId), undefined);
  assert.equal((await db.collection("shift_members").where("shiftId", "==", aggregate.identity.incomingShiftId).get()).size, 0);
  assert.equal((await db.collection("shift_attendance").get()).size, 0);
  assert.equal((await db.collection("next_shift_authorizations").get()).size, 0);
}

for (const role of ["admin", "supervisor"]) test(`${role} initializes one valid schedule-only aggregate with immutable audit`, async () => {
  const f = await fixture("handover_pending", role);
  const task = await seedTask(f);
  const assignment = await seedAssignment(f, task);
  const terminal = await seedTask(f, "completed", `${f.outgoing}-terminal`);
  // Even terminal-task assignment document identity is checked by persistence.
  await seedAssignment(f, terminal);
  const result = await initialize(f.input);
  assert.equal(result.handoverDocumentId, `handover_${f.outgoing}`);
  assert.notEqual(result.handoverDocumentId, result.aggregate.reservation.handoverId);
  assert.deepEqual(assertHandoverAggregate(await data("handovers", result.handoverDocumentId)), result.aggregate);
  assert.deepEqual(result.aggregate.workSnapshot, await work(f));
  assert.deepEqual(result.aggregate.confirmations, []); assert.deepEqual(result.aggregate.absences, []); assert.deepEqual(result.aggregate.exceptions, []);
  assert.equal(result.aggregate.temporaryAuthorization, null);
  assert.equal(result.aggregate.identity.successorGeneration, 2);
  assert.notEqual(result.aggregate.identity.successorSlotToken, f.token);
  for (const uid of f.incoming) {
    const schedule = await data("technician_schedules", uid);
    assert.equal(schedule.preservedMetadata, "keep");
    assert.deepEqual(schedule.entries, [unrelated, { shiftId: result.aggregate.identity.incomingShiftId, scheduledStart: start, scheduledEnd: end, status: "scheduled" }]);
  }
  assert.deepEqual(await data("task_assignments", assignment.id), assignment);
  await unchangedOwnershipAndTargets(f, result.aggregate);
  const audit = (await db.collection("audit_logs").get()).docs[0].data();
  assert.equal(audit.action, "SHIFT_HANDOVER_RESERVATION_CREATED"); assert.equal(audit.actorUid, f.actor);
  assert.equal(audit.outgoingShiftId, f.outgoing); assert.equal(audit.handoverDocumentId, result.handoverDocumentId);
  assert.deepEqual(audit.reservation, result.aggregate.reservation); assert.equal(audit.snapshotHash, result.snapshotHash);
  assert.equal(audit.revision, 1); assert.ok(audit.createdAt.toDate());
});

const failures = [
  ["technician actor", (f) => ref("users", f.actor).update({ role: "technician" })],
  ["role differs from authenticated role", (f) => ref("users", f.actor).update({ role: "supervisor" })],
  ["missing actor", (f) => ref("users", f.actor).delete()],
  ...["inactive", "blocked", "revoked"].map((status) => [`actor ${status}`, (f) => ref("users", f.actor).update({ status })]),
  ["actor operation pending", (f) => ref("users", f.actor).update({ statusOperation: { id: "pending" } })],
  ["actor password change required", (f) => ref("users", f.actor).update({ mustChangePassword: true })],
  ["missing outgoing Shift", (f) => ref("shifts", f.outgoing).delete()],
  ...["scheduled", "active", "completed"].map((status) => [`outgoing ${status}`, (f) => ref("shifts", f.outgoing).update({ status })]),
  ["wrong outgoing ID", (f) => ref("shifts", f.outgoing).update({ id: "different" })],
  ["invalid actualStart", (f) => ref("shifts", f.outgoing).update({ actualStart: "bad" })],
  ["actualEnd exists", (f) => ref("shifts", f.outgoing).update({ actualEnd: at })],
  ["invalid outgoing range", (f) => ref("shifts", f.outgoing).update({ scheduledEnd: at })],
  ["missing control", () => ref("operational_shift_control", "global").delete()],
  ["malformed control", () => ref("operational_shift_control", "global").update({ unexpected: true })],
  ["wrong control Shift", () => ref("operational_shift_control", "global").update({ shiftId: "another" })],
  ["wrong token", () => ref("operational_shift_control", "global").update({ slotToken: randomUUID() })],
  ["unsafe generation", () => ref("operational_shift_control", "global").update({ generation: Number.MAX_SAFE_INTEGER + 1 })],
  ["successor generation overflow", () => ref("operational_shift_control", "global").update({ generation: Number.MAX_SAFE_INTEGER,
    previousSlotToken: randomUUID(), advancedAt: at })],
  ["nonconsumed control", () => ref("operational_shift_control", "global").update({ slotStatus: "pending", shiftId: null, shiftStatus: null, consumedAt: null })],
  ["missing incoming pair", (f) => ref("technician_pairs", f.inPair).delete()],
  ["inactive incoming pair", (f) => ref("technician_pairs", f.inPair).update({ status: "inactive" })],
  ["malformed incoming pair", (f) => ref("technician_pairs", f.inPair).update({ id: "wrong" })],
  ["duplicate incoming UID", (f) => ref("technician_pairs", f.inPair).update({ technicianIds: [f.incoming[0], f.incoming[0]] })],
  ["incoming membership mismatch", (f) => ref("technician_pair_memberships", f.incoming[0]).update({ pairId: f.outPair })],
  ["missing incoming membership", (f) => ref("technician_pair_memberships", f.incoming[1]).delete()],
  ["wrong incoming membership UID", (f) => ref("technician_pair_memberships", f.incoming[1]).update({ technicianUid: "wrong" })],
  ["incoming blocked", (f) => ref("users", f.incoming[0]).update({ status: "blocked" })],
  ["incoming role invalid", (f) => ref("users", f.incoming[1]).update({ role: "admin" })],
  ["incoming missing", (f) => ref("users", f.incoming[1]).delete()],
  ["incoming account operation", (f) => ref("users", f.incoming[0]).update({ statusOperation: "pending" })],
  ["incoming password change", (f) => ref("users", f.incoming[0]).update({ mustChangePassword: true })],
  ...[0, 1].map((index) => [`incoming schedule ${index} conflict`, (f) => ref("technician_schedules", f.incoming[index]).update({
    entries: [unrelated, { shiftId: "conflict", scheduledStart: start, scheduledEnd: end, status: "scheduled" }] })]),
  ["malformed schedule", (f) => ref("technician_schedules", f.incoming[0]).update({ entries: [{}] })],
  ["missing outgoing pair", (f) => ref("technician_pairs", f.outPair).delete()],
  ["wrong outgoing primary identity", (f) => ref("shifts", f.outgoing).update({ primaryTechnicianIds: f.incoming })],
  ["missing outgoing primary member", (f) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).delete()],
  ["departed outgoing primary", (f) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).update({ leftAt: at })],
  ["additional cannot replace primary", (f) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).update({ role: "additional" })],
  ["malformed task identity", async (f) => { const task = await seedTask(f); await ref("tasks", task.id).update({ id: "wrong" }); }],
  ["malformed work task", async (f) => { const task = await seedTask(f); await ref("tasks", task.id).update({ status: "wrong" }); }],
  ["malformed terminal task", async (f) => { const task = await seedTask(f, "completed"); await ref("tasks", task.id).update({ title: "" }); }],
  ["malformed assignment identity", async (f) => { const task = await seedTask(f); const assignment = await seedAssignment(f, task); await ref("task_assignments", assignment.id).update({ id: "wrong" }); }],
  ["malformed terminal assignment identity", async (f) => { const task = await seedTask(f, "completed"); const assignment = await seedAssignment(f, task); await ref("task_assignments", assignment.id).update({ id: "wrong" }); }],
  ["malformed assignment evidence", async (f) => { const task = await seedTask(f); const assignment = await seedAssignment(f, task); await ref("task_assignments", assignment.id).update({ acceptanceStatus: "accepted" }); }],
];
for (const [name, mutate] of failures) test(`initialization fails atomically: ${name}`, async () => {
  const f = await fixture(); await mutate(f); await rejectsAtomically(() => initialize(f.input));
});
test("additional C is excluded from permanent signers and untouched", async () => {
  const f = await fixture(); const id = `${f.outgoing}_additional`;
  const member = { id, shiftId: f.outgoing, technicianId: "temporary-c", role: "additional", joinedAt: at, leftAt: null };
  await ref("shift_members", id).set(member);
  const result = await initialize(f.input);
  assert.deepEqual(result.aggregate.identity.outgoingPrimaryTechnicianIds, f.out);
  assert.deepEqual(await data("shift_members", id), member);
});
test("missing schedule documents can be created without materializing a Shift", async () => {
  const f = await fixture(); for (const uid of f.incoming) await ref("technician_schedules", uid).delete();
  const result = await initialize(f.input);
  for (const uid of f.incoming) assert.equal((await data("technician_schedules", uid)).entries.length, 1);
  await unchangedOwnershipAndTargets(f, result.aggregate);
});
test("concurrent initializations have exactly one winner and one reservation per technician", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([initialize(f.input), initialize(f.input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await db.collection("handovers").get()).size, 1);
  for (const uid of f.incoming) assert.equal((await data("technician_schedules", uid)).entries.length, 2);
});
for (const status of ["collecting_confirmations", "cancelled", "superseded", "completed"]) test(`existing ${status} stable document prevents initialization`, async () => {
  const f = await fixture(); const result = await initialize(f.input);
  await ref("handovers", result.handoverDocumentId).update({ lifecycleStatus: status });
  await rejectsAtomically(() => initialize(f.input));
});

test("replacement renews reserved Shift ID, recomputes work, moves schedules and records superseded evidence", async () => {
  const f = await fixture(); const task = await seedTask(f); await seedAssignment(f, task);
  const first = await initialize(f.input);
  const confirmed = confirmHandoverParticipant(first.aggregate, { revision: 1, snapshotHash: first.snapshotHash,
    actorUid: f.out[0], technicianUid: f.out[0], recordedAt: new Date().toISOString() });
  await ref("handovers", first.handoverDocumentId).set(confirmed);
  await ref("tasks", task.id).update({ description: "Current work differs", updatedAt: new Date().toISOString() });
  const result = await replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(first) });
  assert.equal(result.handoverDocumentId, first.handoverDocumentId);
  assert.equal((await db.collection("handovers").get()).size, 1);
  assert.notEqual(result.aggregate.identity.incomingShiftId, first.aggregate.identity.incomingShiftId);
  assert.equal(result.aggregate.identity.successorGeneration, first.aggregate.identity.successorGeneration);
  await unchangedOwnershipAndTargets(f, first.aggregate);
  assert.equal(result.aggregate.revision, 2);
  assert.notEqual(result.aggregate.reservation.handoverId, first.aggregate.reservation.handoverId);
  assert.notEqual(result.snapshotHash, first.snapshotHash);
  assert.notEqual(result.aggregate.identity.successorSlotToken, first.aggregate.identity.successorSlotToken);
  assert.deepEqual(result.aggregate.retiredSuccessorSlotTokens, [first.aggregate.identity.successorSlotToken]);
  assert.deepEqual(result.aggregate.confirmations, []);
  assert.deepEqual(result.aggregate.workSnapshot, await work(f));
  assert.notDeepEqual(result.aggregate.workSnapshot, first.aggregate.workSnapshot);
  for (const uid of f.incoming) assert.deepEqual((await data("technician_schedules", uid)).entries, [unrelated]);
  for (const uid of f.replacement) assert.deepEqual((await data("technician_schedules", uid)).entries,
    [unrelated, { shiftId: result.aggregate.identity.incomingShiftId, scheduledStart: start, scheduledEnd: end, status: "scheduled" }]);
  const audits = (await db.collection("audit_logs").get()).docs.map((doc) => doc.data());
  assert.equal(audits.length, 2);
  const audit = audits.find((event) => event.action === "SHIFT_HANDOVER_RESERVATION_REPLACED");
  assert.deepEqual(audit.previousReservation, first.aggregate.reservation);
  assert.equal(audit.previousSnapshotHash, first.snapshotHash);
  assert.deepEqual(audit.supersededAggregate.confirmations, confirmed.confirmations);
  assert.equal(audit.supersededAggregate.lifecycleStatus, "superseded");
  assert.deepEqual(audit.reservation, result.aggregate.reservation);
  await unchangedOwnershipAndTargets(f, result.aggregate);
});
test("same-pair time replacement removes self-conflict and preserves unrelated schedule metadata", async () => {
  const f = await fixture(); const first = await initialize(f.input);
  const result = await replace({ ...f.input, scheduledStart: "2030-01-01T07:00:00.000Z", ...bound(first) });
  for (const uid of f.incoming) {
    const schedule = await data("technician_schedules", uid);
    assert.equal(schedule.entries.length, 2); assert.deepEqual(schedule.entries[0], unrelated);
    assert.equal(schedule.entries[1].scheduledStart, "2030-01-01T07:00:00.000Z");
    assert.equal(schedule.entries[1].shiftId, result.aggregate.identity.incomingShiftId);
    assert.equal(schedule.entries.some((entry) => entry.shiftId === first.aggregate.identity.incomingShiftId), false);
    assert.equal(schedule.preservedMetadata, "keep");
  }
  assert.notEqual(result.aggregate.identity.incomingShiftId, first.aggregate.identity.incomingShiftId);
  assert.notEqual(result.aggregate.identity.successorSlotToken, first.aggregate.identity.successorSlotToken);
  assert.equal(result.aggregate.identity.successorGeneration, first.aggregate.identity.successorGeneration);
});
test("same-pair same-time replacement still renews both identities and clears evidence", async () => {
  const f = await fixture(); const first = await initialize(f.input);
  const confirmed = confirmHandoverParticipant(first.aggregate, { revision: 1, snapshotHash: first.snapshotHash,
    actorUid: f.out[0], technicianUid: f.out[0], recordedAt: new Date().toISOString() });
  await ref("handovers", first.handoverDocumentId).set(confirmed);
  const changed = await replace({ ...f.input, ...bound(first) });
  assert.notEqual(changed.aggregate.identity.incomingShiftId, first.aggregate.identity.incomingShiftId);
  assert.notEqual(changed.aggregate.identity.successorSlotToken, first.aggregate.identity.successorSlotToken);
  assert.notEqual(changed.aggregate.reservation.handoverId, first.aggregate.reservation.handoverId);
  assert.equal(changed.aggregate.identity.successorGeneration, first.aggregate.identity.successorGeneration);
  assert.equal(changed.aggregate.revision, 2);
  assert.deepEqual(changed.aggregate.workSnapshot, first.aggregate.workSnapshot);
  assert.deepEqual(changed.aggregate.confirmations, []);
  assert.equal(changed.handoverDocumentId, first.handoverDocumentId);
  assert.equal((await db.collection("handovers").get()).size, 1);
  for (const uid of f.incoming) {
    const schedule = await data("technician_schedules", uid);
    assert.deepEqual(schedule.entries, [unrelated, { shiftId: changed.aggregate.identity.incomingShiftId,
      scheduledStart: start, scheduledEnd: end, status: "scheduled" }]);
    assert.equal(schedule.preservedMetadata, "keep");
  }
  await unchangedOwnershipAndTargets(f, first.aggregate);
  await unchangedOwnershipAndTargets(f, changed.aggregate);
});
test("two replacements reserve three distinct identities under one stable document", async (t) => {
  const f = await fixture(); const first = await initialize(f.input);
  const second = await replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(first) });
  const third = await replace({ ...f.input, ...bound(second) });
  const chain = [first, second, third];
  assert.equal(new Set(chain.map((item) => item.aggregate.identity.incomingShiftId)).size, 3);
  assert.equal(new Set(chain.map((item) => item.aggregate.identity.successorSlotToken)).size, 3);
  assert.equal(new Set(chain.map((item) => item.aggregate.reservation.handoverId)).size, 3);
  assert.equal(new Set(chain.map((item) => item.handoverDocumentId)).size, 1);
  assert.deepEqual(chain.map((item) => item.aggregate.identity.successorGeneration), [2, 2, 2]);
  assert.deepEqual(chain.map((item) => item.aggregate.revision), [1, 2, 3]);
  assert.equal((await db.collection("handovers").get()).size, 1);
  for (const item of chain) await unchangedOwnershipAndTargets(f, item.aggregate);
  for (const uid of f.replacement) assert.deepEqual((await data("technician_schedules", uid)).entries, [unrelated]);
  for (const uid of f.incoming) assert.deepEqual((await data("technician_schedules", uid)).entries,
    [unrelated, { shiftId: third.aggregate.identity.incomingShiftId, scheduledStart: start, scheduledEnd: end, status: "scheduled" }]);
  const audits = (await db.collection("audit_logs").get()).docs.map((document) => document.data());
  assert.equal(audits.length, 3);
  for (const [previous, current] of [[first, second], [second, third]]) {
    const audit = audits.find((event) => event.revision === current.aggregate.revision);
    assert.deepEqual(audit.previousReservation, previous.aggregate.reservation);
    assert.deepEqual(audit.reservation, current.aggregate.reservation);
  }
  t.diagnostic(JSON.stringify({ stableDocument: first.handoverDocumentId, reservations: chain.map((item) => ({
    id: item.aggregate.identity.incomingShiftId, token: item.aggregate.identity.successorSlotToken, generation: item.aggregate.identity.successorGeneration })) }));
});
test("cancellation after replacement removes the current ID and preserves unrelated schedules", async () => {
  const f = await fixture(); const first = await initialize(f.input);
  const changed = await replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(first) });
  const closed = await cancel({ ...f.input, ...bound(changed) });
  assert.equal(closed.aggregate.lifecycleStatus, "cancelled");
  assert.equal(closed.aggregate.identity.incomingShiftId, changed.aggregate.identity.incomingShiftId);
  for (const uid of [...f.incoming, ...f.replacement]) assert.deepEqual((await data("technician_schedules", uid)).entries, [unrelated]);
  await unchangedOwnershipAndTargets(f, first.aggregate);
  await unchangedOwnershipAndTargets(f, changed.aggregate);
  const audit = (await db.collection("audit_logs").get()).docs.map((document) => document.data())
    .find((event) => event.action === "SHIFT_HANDOVER_RESERVATION_CANCELLED");
  assert.deepEqual(audit.reservation, changed.aggregate.reservation);
});
test("overlapping different pairs fail closed under exclusive permanent pair membership", async () => {
  const f = await fixture(); const first = await initialize(f.input);
  await ref("technician_pairs", f.newPair).update({ technicianIds: [f.incoming[0], f.replacement[1]] });
  // Change both authoritative pair records to retain a consistent old membership
  // is impossible with one permanent pair membership per technician. Fail closed.
  await rejectsAtomically(() => replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(first) }));
});
for (const [name, mutate, override] of [
  ["stale revision", async () => {}, { expectedRevision: 2 }],
  ["stale snapshot", async () => {}, { expectedSnapshotHash: "0".repeat(64) }],
  ["changed outgoing token", (f) => ref("shifts", f.outgoing).update({ operationalSlotToken: randomUUID() }), {}],
  ["changed outgoing generation", () => ref("operational_shift_control", "global").update({ generation: 2, previousSlotToken: randomUUID(), advancedAt: at }), {}],
  ["wrong control owner", () => ref("operational_shift_control", "global").update({ shiftId: "another" }), {}],
  ["incoming conflict", (f) => ref("technician_schedules", f.replacement[1]).update({ entries: [unrelated, { ...unrelated, shiftId: "conflict", scheduledStart: start, scheduledEnd: end }] }), {}],
  ["old reservation missing", (f) => ref("technician_schedules", f.incoming[0]).update({ entries: [unrelated] }), {}],
  ["old reservation wrong times", async (f) => { const schedule = await data("technician_schedules", f.incoming[1]); schedule.entries[1].scheduledEnd = "2030-01-01T13:00:00.000Z"; await ref("technician_schedules", f.incoming[1]).set(schedule); }, {}],
  ["new account ineligible", (f) => ref("users", f.replacement[0]).update({ status: "blocked" }), {}],
]) test(`replacement fails atomically: ${name}`, async () => {
  const f = await fixture(); const first = await initialize(f.input); await mutate(f);
  await rejectsAtomically(() => replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(first), ...override }));
});

for (const role of ["admin", "supervisor"]) test(`${role} cancels, releases exactly both schedules, retains terminal aggregate and all audits`, async () => {
  const f = await fixture("handover_pending", role); const first = await initialize(f.input);
  const result = await cancel({ ...f.input, ...bound(first) });
  assert.equal(result.aggregate.lifecycleStatus, "cancelled");
  assert.deepEqual(await data("handovers", first.handoverDocumentId), result.aggregate);
  for (const uid of f.incoming) assert.deepEqual((await data("technician_schedules", uid)).entries, [unrelated]);
  const audits = (await db.collection("audit_logs").get()).docs.map((doc) => doc.data());
  assert.equal(audits.length, 2);
  const audit = audits.find((event) => event.action === "SHIFT_HANDOVER_RESERVATION_CANCELLED");
  assert.equal(audit.actorUid, f.actor); assert.equal(audit.snapshotHash, first.snapshotHash);
  assert.deepEqual(audit.reservation, first.aggregate.reservation);
  await unchangedOwnershipAndTargets(f, result.aggregate);
  await rejectsAtomically(() => initialize(f.input));
  await rejectsAtomically(() => replace({ ...f.input, ...bound(first) }));
});
for (const [name, mutate, override] of [
  ["technician actor", (f) => ref("users", f.actor).update({ role: "technician" }), {}],
  ["stale revision", async () => {}, { expectedRevision: 3 }],
  ["stale snapshot", async () => {}, { expectedSnapshotHash: "0".repeat(64) }],
  ["missing schedule entry", (f) => ref("technician_schedules", f.incoming[0]).update({ entries: [unrelated] }), {}],
  ["duplicate schedule entry", async (f) => { const schedule = await data("technician_schedules", f.incoming[1]); schedule.entries.push(schedule.entries[1]); await ref("technician_schedules", f.incoming[1]).set(schedule); }, {}],
  ["wrong schedule status", async (f) => { const schedule = await data("technician_schedules", f.incoming[1]); schedule.entries[1].status = "active"; await ref("technician_schedules", f.incoming[1]).set(schedule); }, {}],
  ["changed outgoing control", () => ref("operational_shift_control", "global").update({ slotToken: randomUUID() }), {}],
]) test(`cancellation fails atomically: ${name}`, async () => {
  const f = await fixture(); const first = await initialize(f.input); await mutate(f);
  await rejectsAtomically(() => cancel({ ...f.input, ...bound(first), ...override }));
});
test("cancellation records changed current work without silently rewriting the reviewed snapshot", async () => {
  const f = await fixture(); const task = await seedTask(f); const first = await initialize(f.input);
  await transitionTask({ taskId: task.id, actorUid: f.actor, action: "cancel", reason: "Work no longer required" });
  const current = await work(f);
  const result = await cancel({ ...f.input, ...bound(first) });
  assert.deepEqual(result.aggregate.workSnapshot, first.aggregate.workSnapshot);
  const audit = (await db.collection("audit_logs").get()).docs.map((doc) => doc.data()).find((event) => event.action === "SHIFT_HANDOVER_RESERVATION_CANCELLED");
  assert.deepEqual(audit.observedWorkSnapshot, current);
  assert.notDeepEqual(audit.observedWorkSnapshot, audit.workSnapshot);
});
const dutyMessage = "This technician has a scheduled or active shift, or an unfinished handover. Complete or reassign these duties before blocking the account.";
const corruptMessage = "The technician's operational records require administrator review.";
const accountSafe = (uid) => db.runTransaction((transaction) => requireSafeAccountBlocking(transaction, uid));
async function accountRejects(uid, message = corruptMessage) {
  const before = await state();
  await assert.rejects(() => accountSafe(uid), (error) =>
    error instanceof AccountOperationalError && error.status === 409 && error.message === message);
  assert.deepEqual(await state(), before, "account validation has no operational side effects");
}
async function accountFixture() {
  const f = await fixture();
  // No unrelated orphan or other duty may mask the reserved-Shift decision.
  for (const uid of [...f.incoming, ...f.replacement]) {
    await ref("technician_schedules", uid).update({ entries: [] });
  }
  const result = await initialize(f.input);
  return { f, result, uid: f.incoming[0], entry: {
    shiftId: result.aggregate.reservation.reservedIncomingShiftId,
    scheduledStart: start, scheduledEnd: end, status: "scheduled",
  } };
}
for (const index of [0, 1]) test(`live reserved incoming technician ${index} receives exact normal duty protection`, async () => {
  const { f, result } = await accountFixture();
  assert.equal(await data("shifts", result.aggregate.identity.incomingShiftId), undefined);
  assert.equal((await data("technician_schedules", f.incoming[index])).entries.length, 1);
  await accountRejects(f.incoming[index], dutyMessage);
});
const accountCorruptions = [
  ["orphan", ({ result }) => ref("handovers", result.handoverDocumentId).delete()],
  ["wrong incoming participant", async ({ f, entry }) => {
    await ref("technician_schedules", f.replacement[0]).update({ entries: [entry] });
    return f.replacement[0];
  }],
  ["wrong reserved Shift", ({ uid, entry }) => ref("technician_schedules", uid).update({ entries: [{ ...entry, shiftId: "different-future" }] })],
  ["wrong start", ({ uid, entry }) => ref("technician_schedules", uid).update({ entries: [{ ...entry, scheduledStart: "2030-01-01T07:00:00.000Z" }] })],
  ["wrong end", ({ uid, entry }) => ref("technician_schedules", uid).update({ entries: [{ ...entry, scheduledEnd: "2030-01-01T15:00:00.000Z" }] })],
  ...["active", "handover_pending"].map((status) => [`missing Shift ${status} schedule`, ({ uid, entry }) =>
    ref("technician_schedules", uid).update({ entries: [{ ...entry, status }] })]),
  ...["cancelled", "superseded", "completed"].map((lifecycleStatus) => [`terminal ${lifecycleStatus}`, ({ result }) =>
    ref("handovers", result.handoverDocumentId).update({ lifecycleStatus })]),
  ["malformed aggregate", ({ result }) => ref("handovers", result.handoverDocumentId).update({ revision: 0 })],
  ["invalid reservation fingerprint", ({ result }) => ref("handovers", result.handoverDocumentId).update({ "reservation.handoverId": "forged" })],
  ["wrong stable document ID", async ({ result }) => {
    await ref("handovers", "wrong-stable-id").set(result.aggregate);
    await ref("handovers", result.handoverDocumentId).delete();
  }],
  ["ambiguous live backing", ({ result }) => ref("handovers", "duplicate-claim").set(result.aggregate)],
  ["ambiguous terminal backing", ({ result }) => ref("handovers", "duplicate-claim").set({ ...result.aggregate, lifecycleStatus: "cancelled" })],
  ["missing Shift also referenced by active membership", ({ uid, entry }) => ref("shift_members", `future_${uid}`).set({
    id: `future_${uid}`, technicianId: uid, shiftId: entry.shiftId, role: "primary", joinedAt: at, leftAt: null,
  })],
];
for (const [name, mutate] of accountCorruptions) test(`account safety fails closed with exact corruption result: ${name}`, async () => {
  const context = await accountFixture();
  const alternateUid = await mutate(context);
  await accountRejects(typeof alternateUid === "string" ? alternateUid : context.uid);
});
test("real replacement releases both old incoming accounts and protects both new accounts", async () => {
  const { f, result } = await accountFixture();
  for (const uid of f.incoming) await accountRejects(uid, dutyMessage);
  const changed = await replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(result) });
  assert.notEqual(changed.aggregate.identity.incomingShiftId, result.aggregate.identity.incomingShiftId);
  for (const uid of f.incoming) {
    assert.deepEqual((await data("technician_schedules", uid)).entries, []);
    await accountSafe(uid);
  }
  for (const uid of f.replacement) {
    assert.equal((await data("technician_schedules", uid)).entries[0].shiftId, changed.aggregate.identity.incomingShiftId);
    await accountRejects(uid, dutyMessage);
  }
});
test("same-pair account protection follows the fresh ID and cancellation releases it", async () => {
  const { f, result } = await accountFixture();
  const changed = await replace({ ...f.input, ...bound(result) });
  assert.notEqual(changed.aggregate.identity.incomingShiftId, result.aggregate.identity.incomingShiftId);
  for (const uid of f.incoming) {
    assert.deepEqual((await data("technician_schedules", uid)).entries, [{
      shiftId: changed.aggregate.identity.incomingShiftId, scheduledStart: start, scheduledEnd: end, status: "scheduled" }]);
    await accountRejects(uid, dutyMessage);
  }
  await cancel({ ...f.input, ...bound(changed) });
  for (const uid of f.incoming) {
    assert.deepEqual((await data("technician_schedules", uid)).entries, []);
    await accountSafe(uid);
  }
});
test("real cancellation releases both incoming accounts when no other duty exists", async () => {
  const { f, result } = await accountFixture();
  for (const uid of f.incoming) await accountRejects(uid, dutyMessage);
  await cancel({ ...f.input, ...bound(result) });
  for (const uid of f.incoming) {
    assert.deepEqual((await data("technician_schedules", uid)).entries, []);
    await accountSafe(uid);
  }
});
for (const status of ["scheduled", "active", "handover_pending"]) test(`A6 real ${status} Shift still protects account`, async () => {
  const { uid, entry } = await accountFixture();
  await ref("shifts", entry.shiftId).set({ id: entry.shiftId, status, primaryTechnicianIds: [uid] });
  await accountRejects(uid, dutyMessage);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function contend(t, sharedRef, operationA, operationB, queryCollection) {
  const acquired = deferred(); const release = deferred(); const bothReading = deferred();
  const original = db.runTransaction;
  const seen = new Set();
  const operationContext = new AsyncLocalStorage();
  // A real emulator transaction owns the shared document read until both
  // canonical transactions have issued their competing authoritative reads.
  // Instrumentation observes genuine SDK calls; it never changes snapshots,
  // aborts a transaction, or modifies a canonical callback's business result.
  const gate = original.call(db, async (transaction) => {
    assert.equal((await transaction.get(sharedRef)).exists, true);
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  db.runTransaction = function(callback, options) {
    const operation = operationContext.getStore();
    return original.call(db, async (transaction) => {
      const get = transaction.get.bind(transaction);
      transaction.get = function(target, ...args) {
        const pendingRead = get(target, ...args);
        if (target.path === sharedRef.path ||
            (queryCollection && target._queryOptions?.collectionId === queryCollection)) {
          assert.ok(operation === "A" || operation === "B");
          seen.add(operation);
          if (seen.size >= 2) bothReading.resolve();
          // Keep each canonical callback in its real shared-read phase until
          // both operations have issued reads, even if emulator read locks are
          // compatible. Return the untouched SDK snapshot after gate release.
          return pendingRead.then(async (snapshot) => {
            await release.promise;
            return snapshot;
          });
        }
        return pendingRead;
      };
      return callback(transaction);
    }, options);
  };
  const abort = () => { release.resolve(); bothReading.resolve(); };
  t.signal.addEventListener("abort", abort, { once: true });
  let operations;
  try {
    operations = [operationContext.run("A", operationA), operationContext.run("B", operationB)];
    // Attach rejection handlers immediately while the acquisition latch waits.
    const settled = Promise.allSettled(operations);
    await bothReading.promise;
    assert.ok(seen.has("A") && seen.has("B"), "both canonical transactions overlap in their shared-document read phases while the gate is held");
    release.resolve();
    await gate;
    return await settled;
  } finally {
    release.resolve();
    db.runTransaction = original;
    t.signal.removeEventListener("abort", abort);
    await gate;
    if (operations) await Promise.allSettled(operations);
  }
}
function compareUpdateTimes(left, right) {
  assert.ok(left && right, "Firestore updateTime metadata must exist");
  return left.seconds === right.seconds ? Math.sign(left.nanoseconds - right.nanoseconds) : Math.sign(left.seconds - right.seconds);
}
for (const kind of ["create task", "create assignment", "reassign", "respond"]) {
  test(`genuine shared-Shift contention: ${kind} vs beginShiftHandover`, { timeout: 60000 }, async (t) => {
    const f = await fixture("active");
    const task = kind === "create task" ? null : await seedTask(f);
    const assignment = ["reassign", "respond"].includes(kind) ? await seedAssignment(f, task) : null;
    const writer = () => kind === "create task" ? createTask({ title: "Concurrent task", description: "Work", priority: "medium", sectionId: null, shiftId: f.outgoing, createdBy: f.actor }) :
      kind === "create assignment" ? createTaskAssignment({ taskId: task.id, technicianUid: f.out[0], responsibility: "lead", assignedBy: f.actor }) :
      kind === "reassign" ? reassignTask({ taskId: task.id, assignmentId: assignment.id, originalTechnicianUid: f.out[0], replacementTechnicianUid: f.out[1], performedBy: f.actor, reason: "Concurrent replacement" }) :
      respondToTaskAssignment({ taskId: task.id, assignmentId: assignment.id, technicianUid: f.out[0], action: "accept" });
    const [written, barrier] = await contend(t, ref("shifts", f.outgoing), writer,
      () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.actor }));
    assert.equal(barrier.status, "fulfilled");
    const shiftSnapshot = await ref("shifts", f.outgoing).get();
    assert.equal(shiftSnapshot.data().status, "handover_pending");
    const tasks = await db.collection("tasks").where("shiftId", "==", f.outgoing).get();
    const assignments = await db.collection("task_assignments").get();
    if (written.status === "fulfilled") {
      const changed = kind === "create task" ? tasks.docs[0] : kind === "create assignment" ? assignments.docs[0] :
        await ref(kind === "respond" ? "task_assignments" : "tasks", kind === "respond" ? assignment.id : task.id).get();
      assert.ok(compareUpdateTimes(changed.updateTime, shiftSnapshot.updateTime) < 0,
        "a successful writer must commit before the handover barrier");
      if (kind === "create task") assert.equal(tasks.size, 1);
      if (kind === "create assignment") assert.equal(assignments.size, 1);
      if (kind === "respond") assert.equal(changed.data().acceptanceStatus, "accepted");
      if (kind === "reassign") {
        const old = await ref("task_assignments", assignment.id).get();
        const replacement = await ref("task_assignments", `${task.id}_${f.out[1]}`).get();
        assert.equal(old.data().responsibilityStatus, "released");
        assert.equal(old.data().transferredTo, f.out[1]);
        assert.equal(replacement.data().responsibilityStatus, "active");
        assert.equal(assignments.size, 2);
        assert.equal(compareUpdateTimes(old.updateTime, replacement.updateTime), 0, "reassignment is atomic");
        assert.equal(compareUpdateTimes(changed.updateTime, old.updateTime), 0);
      }
    } else {
      assert.ok(written.reason instanceof AssignmentOperationError);
      assert.equal(written.reason.status, 409);
      assert.match(written.reason.message, /handover/i);
      if (kind === "create task") assert.equal(tasks.size, 0);
      if (kind === "create assignment") assert.equal(assignments.size, 0);
      if (kind === "respond") assert.deepEqual(await data("task_assignments", assignment.id), assignment);
      if (kind === "reassign") {
        assert.deepEqual(await data("task_assignments", assignment.id), assignment);
        assert.equal(await data("task_assignments", `${task.id}_${f.out[1]}`), undefined);
        assert.deepEqual(await data("tasks", task.id), task);
      }
    }
    const handover = await initialize(f.input);
    assert.deepEqual(handover.aggregate.workSnapshot, await work(f), "later snapshot includes exactly the committed work lineage");
    t.diagnostic(`${kind}: ${written.status === "fulfilled" ? "writer then barrier" : "barrier then writer rejection"}; two shared-read transactions observed`);
  });
}
for (const action of ["return", "complete", "cancel"]) {
  test(`genuine shared-task contention: ${action} vs initialization`, { timeout: 60000 }, async (t) => {
    const f = await fixture(); const task = await seedTask(f, "pending_verification");
    await seedAssignment(f, task);
    const before = await work(f);
    const [lifecycle, initialization] = await contend(t, ref("tasks", task.id),
      () => transitionTask({ taskId: task.id, actorUid: f.actor, action, reason: "Concurrent manager resolution" }),
      () => initialize(f.input), "tasks");
    assert.equal(lifecycle.status, "fulfilled");
    assert.equal(initialization.status, "fulfilled");
    const current = await work(f);
    assert.notDeepEqual(current, before, "the authoritative lifecycle mutation changes the digest");
    const taskSnapshot = await ref("tasks", task.id).get();
    assert.equal(taskSnapshot.data().status, { return: "in_progress", complete: "completed", cancel: "cancelled" }[action]);
    assert.notEqual(taskSnapshot.data().updatedAt, task.updatedAt);
    const handoverSnapshot = await ref("handovers", initialization.value.handoverDocumentId).get();
    const persisted = assertHandoverAggregate(handoverSnapshot.data()).workSnapshot;
    const order = compareUpdateTimes(taskSnapshot.updateTime, handoverSnapshot.updateTime);
    assert.notEqual(order, 0, "distinct document commit metadata establishes serialization order");
    if (order < 0) assert.deepEqual(persisted, current, "lifecycle first forbids a stale successful initialization digest");
    else {
      assert.deepEqual(persisted, before, "initialization first persists its correct pre-lifecycle digest");
      assert.notDeepEqual(current, persisted, "later manager mutation legitimately makes the reviewed digest stale");
    }
    t.diagnostic(`${action}: ${order < 0 ? "lifecycle then initialization; current digest" : "initialization then lifecycle; legitimate later staleness"}; Firestore updateTime ordering`);
  });
}
test("A6 active ShiftMember still protects account without schedule or primary reference", async () => {
  const f = await fixture(); const uid = f.replacement[0];
  await ref("technician_schedules", uid).update({ entries: [] });
  await ref("shift_members", "additional-duty").set({ technicianId: uid, shiftId: f.outgoing, leftAt: null });
  await accountRejects(uid, dutyMessage);
});
test("A6 missing Shift from active membership remains corrupt without schedule", async () => {
  const f = await fixture(); const uid = f.replacement[0];
  await ref("technician_schedules", uid).update({ entries: [] });
  await ref("shift_members", "orphan-member").set({ technicianId: uid, shiftId: "orphan", leftAt: null });
  await accountRejects(uid);
});
test("A6 primary-Shift provenance cannot legitimize a missing point read: defensive snapshot contract", async () => {
  const { uid, entry } = await accountFixture();
  const shiftRef = ref("shifts", entry.shiftId);
  await shiftRef.set({ id: entry.shiftId, status: "scheduled", primaryTechnicianIds: [uid] });
  const primarySnapshot = await db.collection("shifts").where("primaryTechnicianIds", "array-contains", uid).get();
  assert.equal(primarySnapshot.size, 1);
  await shiftRef.delete();
  // A consistent Firestore transaction cannot naturally return an existing
  // primary-query document and a missing point read of that same document.
  // Exercise this defensive provenance contract with a captured REAL SDK query
  // snapshot and real missing point read. This is not a concurrency claim.
  await assert.rejects(() => db.runTransaction((transaction) => requireSafeAccountBlocking({
    get(target, ...args) {
      return target._queryOptions?.collectionId === "shifts" ? Promise.resolve(primarySnapshot) : transaction.get(target, ...args);
    },
  }, uid)), (error) => error instanceof AccountOperationalError && error.status === 409 && error.message === corruptMessage);
});
test("A6 unfinished task responsibility still protects account", async () => {
  const f = await fixture(); const uid = f.replacement[0];
  await ref("technician_schedules", uid).update({ entries: [] });
  const task = await seedTask(f); await seedAssignment(f, task, uid);
  await accountRejects(uid, "This technician has unfinished task assignments. Complete or reassign these tasks before blocking the account.");
});
test("real pair deactivation entry point preserves reservation guard and succeeds after cancellation", async () => {
  const { f, result } = await accountFixture();
  await assert.rejects(() => deactivateTechnicianPair({ pairId: f.inPair }, { uid: f.actor }),
    (error) => error instanceof AssignmentOperationError && error.status === 409 &&
      error.message === "This technician pair cannot be deactivated while either technician has a scheduled or active shift, an unfinished handover, or active responsibility for an unfinished task. Complete or reassign those duties first.");
  assert.equal((await data("technician_pairs", f.inPair)).status, "active");
  await cancel({ ...f.input, ...bound(result) });
  await deactivateTechnicianPair({ pairId: f.inPair }, { uid: f.actor });
  assert.equal((await data("technician_pairs", f.inPair)).status, "inactive");
});

for (const kind of ["create task", "create assignment", "reassign", "respond"]) {
  for (const first of ["writer", "barrier"]) test(`serial-order regression: ${kind} vs handover barrier: ${first} commits first`, async () => {
    const f = await fixture("active");
    const task = kind === "create task" ? null : await seedTask(f);
    const assignment = ["reassign", "respond"].includes(kind) ? await seedAssignment(f, task) : null;
    const writer = () => kind === "create task" ? createTask({ title: "New linked task", description: "Work", priority: "medium", sectionId: null, shiftId: f.outgoing, createdBy: f.actor }) :
      kind === "create assignment" ? createTaskAssignment({ taskId: task.id, technicianUid: f.out[0], responsibility: "lead", assignedBy: f.actor }) :
      kind === "reassign" ? reassignTask({ taskId: task.id, assignmentId: assignment.id, originalTechnicianUid: f.out[0], replacementTechnicianUid: f.out[1], performedBy: f.actor, reason: "Replacement needed" }) :
      respondToTaskAssignment({ taskId: task.id, assignmentId: assignment.id, technicianUid: f.out[0], action: "accept" });
    const barrier = () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.actor });
    if (first === "writer") { await writer(); await barrier(); }
    else { await barrier(); await assert.rejects(writer); }
    const result = await initialize(f.input);
    assert.deepEqual(result.aggregate.workSnapshot, await work(f));
    if (kind === "create task") assert.equal((await db.collection("tasks").get()).size, first === "writer" ? 1 : 0);
    if (kind === "create assignment") assert.equal((await db.collection("task_assignments").get()).size, first === "writer" ? 1 : 0);
    if (kind === "respond") assert.equal((await data("task_assignments", assignment.id)).acceptanceStatus, first === "writer" ? "accepted" : "pending");
    if (kind === "reassign") assert.equal((await data("task_assignments", assignment.id)).responsibilityStatus, first === "writer" ? "released" : "active");
  });
}
for (const action of ["return", "complete", "cancel"]) {
  for (const first of ["lifecycle", "initialization"]) test(`serial-order regression: ${action} vs initialization: ${first} commits first`, async () => {
    const f = await fixture(); const task = await seedTask(f, "pending_verification");
    const before = await work(f);
    const lifecycle = () => transitionTask({ taskId: task.id, actorUid: f.actor, action, reason: "Manager resolution needed" });
    let result;
    if (first === "lifecycle") { await lifecycle(); result = await initialize(f.input); assert.deepEqual(result.aggregate.workSnapshot, await work(f)); }
    else { result = await initialize(f.input); assert.deepEqual(result.aggregate.workSnapshot, before); await lifecycle(); }
  });
}
test("forced server rollback exercises abort/retry handling, never stale persistence", async () => {
  const f = await fixture(); const task = await seedTask(f, "pending_verification");
  const stale = await work(f);
  const original = db.runTransaction;
  let intervened = false;
  let attempts = 0;
  // Test-only server abort releases pessimistic locks AFTER all real reads and
  // queued writes, but preserves the SDK's old transaction ID. The manager can
  // then commit before that stale attempt reaches commit. The actual emulator
  // must reject that commit; the SDK must retry/re-read or fail safely.
  // No production hook, fabricated snapshots, sleeps, or bypass flag.
  db.runTransaction = function(callback, options) {
    db.runTransaction = original;
    return original.call(db, async (transaction) => {
      attempts++;
      const result = await callback(transaction);
      if (!intervened) {
        assert.deepEqual(result.aggregate.workSnapshot, stale);
        const transactionId = await transaction._transactionIdPromise;
        assert.ok(transactionId);
        await db.request("rollback", { database: db.formattedName, transaction: transactionId }, "handover-test-abort");
        await transitionTask({ taskId: task.id, actorUid: f.actor, action: "return", reason: "Concurrent manager return" });
        intervened = true;
      }
      return result;
    }, options);
  };
  let result;
  try { result = await initialize(f.input); } catch { /* Safe conflict failure is permitted. */ }
  finally { db.runTransaction = original; }
  assert.equal(intervened, true, "the manager committed after the actual task transaction read");
  assert.equal((await data("tasks", task.id)).status, "in_progress");
  const current = await work(f);
  assert.notDeepEqual(current, stale);
  if (result) { assert.ok(attempts > 1); assert.deepEqual(result.aggregate.workSnapshot, current); }
  else assert.equal((await db.collection("handovers").get()).size, 0);
});
test("replacement server abort retries with one proposed Shift ID and successor token", async () => {
  const f = await fixture(); const first = await initialize(f.input);
  const before = await state(); const original = db.runTransaction; const attempts = [];
  let aborted = false;
  db.runTransaction = function(callback, options) {
    db.runTransaction = original;
    return original.call(db, async (transaction) => {
      const result = await callback(transaction);
      attempts.push({ id: result.aggregate.identity.incomingShiftId, token: result.aggregate.identity.successorSlotToken });
      if (!aborted) {
        const transactionId = await transaction._transactionIdPromise;
        assert.ok(transactionId);
        await db.request("rollback", { database: db.formattedName, transaction: transactionId }, "handover-replacement-test-abort");
        aborted = true;
        assert.deepEqual(await state(), before, "aborted attempt leaves old reservation and schedules intact");
      }
      return result;
    }, options);
  };
  let result;
  try { result = await replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(first) }); }
  finally { db.runTransaction = original; }
  assert.equal(aborted, true); assert.ok(attempts.length > 1, "SDK retried the server-aborted replacement");
  assert.equal(new Set(attempts.map((item) => item.id)).size, 1);
  assert.equal(new Set(attempts.map((item) => item.token)).size, 1);
  assert.notEqual(result.aggregate.identity.incomingShiftId, first.aggregate.identity.incomingShiftId);
  assert.notEqual(result.aggregate.identity.successorSlotToken, first.aggregate.identity.successorSlotToken);
  for (const uid of f.incoming) assert.deepEqual((await data("technician_schedules", uid)).entries, [unrelated]);
  for (const uid of f.replacement) assert.equal((await data("technician_schedules", uid)).entries[1].shiftId, attempts[0].id);
  assert.equal((await db.collection("audit_logs").get()).size, 2);
  await unchangedOwnershipAndTargets(f, first.aggregate);
  await unchangedOwnershipAndTargets(f, result.aggregate);
});
for (const collision of ["equal old identity", "materialized proposed identity", "materialized old identity"]) {
  test(`replacement collision fails atomically: ${collision}`, async () => {
    const f = await fixture(); const first = await initialize(f.input);
    const proposedId = collision === "equal old identity" ? first.aggregate.identity.incomingShiftId : "replacement-collision-id";
    if (collision !== "equal old identity") await ref("shifts", collision === "materialized old identity"
      ? first.aggregate.identity.incomingShiftId : proposedId).set({ id: "collision" });
    const original = db.collection;
    // Test-only allocator control; transaction reads remain real SDK reads.
    db.collection = function(path) {
      const collection = original.call(db, path);
      if (path === "shifts") {
        const doc = collection.doc;
        collection.doc = function(id) { return doc.call(collection, id ?? proposedId); };
      }
      return collection;
    };
    try {
      await rejectsAtomically(() => replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(first) }));
    } finally { db.collection = original; }
  });
}
test("explicit repository rules deny direct client mutation of every operational collection", async () => {
  for (const collection of ["handovers", "shifts", "shift_members", "shift_attendance", "tasks", "task_assignments", "technician_schedules", "operational_shift_control", "next_shift_authorizations"]) {
    const response = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents/${collection}/client-forbidden`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { forged: { booleanValue: true } } }),
    });
    assert.equal(response.status, 403, collection);
    assert.equal(await data(collection, "client-forbidden"), undefined);
  }
});
