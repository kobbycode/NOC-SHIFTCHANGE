import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const project = "demo-shiftchange-handover-resolution";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !["127.0.0.1:8088", "localhost:8088"].includes(host) ||
    ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]
      .some((key) => process.env[key] !== project)) throw new Error("Refusing to run outside the isolated local demo emulator.");
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { initializeFormalHandover: initialize } = await import("../src/lib/operations/formal-handover.ts");
const { persistFormalHandoverResolution: resolve } = await import("../src/lib/operations/formal-handover-resolution.ts");
const { persistFormalHandoverConfirmation: confirm } = await import("../src/lib/operations/formal-handover-confirmation.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { NextShiftAuthorizationDomainError } = await import("../src/lib/operations/next-shift-authorization-domain.ts");
const { HandoverDomainError, createHandoverSnapshot, assertHandoverAggregate, reviseHandoverSnapshot } =
  await import("../src/lib/operations/handover-domain.ts");
const { createHandoverWorkSnapshot } = await import("../src/lib/operations/handover-work-snapshot.ts");
const { createPendingOperationalShiftControl, consumeOperationalShiftSlot, transitionOperationalShiftControl } =
  await import("../src/lib/operations/operational-shift-control-state.ts");
const { transitionTask } = await import("../src/lib/operations/task-lifecycle.ts");
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
  for (const collection of ["handovers", "technician_schedules", "audit_logs", "operational_shift_control", "shifts", "shift_members", "shift_attendance", "task_assignments", "next_shift_authorizations", "tasks", "users", "technician_pairs", "technician_pair_memberships"]) {
    const documents = await db.collection(collection).get();
    result[collection] = documents.docs.map((document) => ({ id: document.id, data: document.data() })).sort((a, b) => a.id.localeCompare(b.id));
  }
  return result;
}
// Application errors expose class/status/public message, without a reason code.
// Require all three so an unrelated SDK or fixture failure cannot pass.
async function rejectsAtomically(operation, ErrorType, status, message) {
  const before = await state();
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof ErrorType);
    for (const sibling of [AssignmentOperationError, HandoverDomainError, NextShiftAuthorizationDomainError]) {
      if (sibling !== ErrorType) assert.equal(error instanceof sibling, false);
    }
    assert.equal(error.status, status);
    assert.equal(error.message, message);
    return true;
  });
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

async function prepared() {
  const f = await fixture();
  const task = await seedTask(f, "pending_verification");
  const assignment = await seedAssignment(f, task);
  const result = await initialize(f.input);
  await ref("shift_attendance", "existing-outgoing").set({ shiftId: f.outgoing, technicianId: f.out[0], status: "present" });
  return { f, task, assignment, result };
}
const input = (f, result, actorUid = f.out[0]) => ({ outgoingShiftId: f.outgoing, actorUid, ...bound(result) });
async function audits(action) { return (await db.collection("audit_logs").where("action", "==", action).get()).docs.map((entry) => entry.data()); }
async function forbiddenState() {
  const snapshot = await state(); delete snapshot.handovers; delete snapshot.audit_logs; return snapshot;
}
// Existing outgoing attendance is preserved; incoming attendance remains absent.
async function noTransfer(f, aggregate) {
  assert.deepEqual(await data("operational_shift_control", "global"), f.control);
  assert.deepEqual(await data("shifts", f.outgoing), f.shift);
  assert.equal(await data("shifts", aggregate.identity.incomingShiftId), undefined);
  assert.equal((await db.collection("shift_members").where("shiftId", "==", aggregate.identity.incomingShiftId).get()).size, 0);
  assert.equal((await db.collection("shift_attendance").where("shiftId", "==", aggregate.identity.incomingShiftId).get()).size, 0);
}

const resolutionInput = (f, result, operation = "absence", technicianUid = f.out[0], overrides = {}) => ({
  outgoingShiftId: f.outgoing, actorUid: f.actor, actorRole: f.role, technicianUid, operation, ...bound(result),
  ...(operation === "clear" ? {} : { reason: "Supervisor reviewed absence" }),
  ...(operation === "exception" ? { category: "unavailable" } : {}), ...overrides,
});
async function current(result) {
  const aggregate = assertHandoverAggregate(await data("handovers", result.handoverDocumentId));
  return { ...result, aggregate, snapshotHash: createHandoverSnapshot(aggregate).snapshotHash };
}
const actionFor = (operation) => operation === "absence" ? "SHIFT_HANDOVER_ABSENCE_RECORDED" :
  operation === "exception" ? "SHIFT_HANDOVER_EXCEPTION_RECORDED" : "SHIFT_HANDOVER_RESOLUTION_CLEARED";

for (const role of ["admin", "supervisor"]) for (const operation of ["absence", "exception"])
  for (const [side, index, position] of [["out", 0, "outgoing_primary_a"], ["out", 1, "outgoing_primary_b"],
    ["incoming", 0, "incoming_primary_a"], ["incoming", 1, "incoming_primary_b"]]) {
    test(`${role} ${operation} derives ${position} and writes aggregate/audit only`, async () => {
      const { f, result } = await prepared();
      f.role = role; await ref("users", f.actor).update({ role });
      await confirm(input(f, result, f[side][index]));
      await confirm(input(f, result, f[side === "out" ? "incoming" : "out"][0]));
      const before = await forbiddenState();
      const outcome = await resolve(resolutionInput(f, result, operation, f[side][index]));
      assert.equal(outcome.status, "RESOLVED"); assert.equal(outcome.handover.revision, 2);
      assert.notEqual(outcome.handover.snapshotHash, result.snapshotHash);
      const { aggregate } = await current(result); assert.deepEqual(aggregate.confirmations, []);
      assert.equal(aggregate.reservation.revision, 2);
      const evidence = operation === "absence" ? aggregate.absences[0] : aggregate.exceptions[0];
      assert.equal(evidence.position, position); assert.equal(evidence.technicianUid, f[side][index]);
      assert.equal(evidence.recordedRevision, 2); assert.equal(evidence.revision, 2);
      assert.equal(operation === "absence" ? evidence.recordedBy : evidence.supervisorUid, f.actor);
      assert.equal(evidence.reason, "Supervisor reviewed absence"); assert.ok(Number.isFinite(Date.parse(evidence.recordedAt)));
      const events = await audits(actionFor(operation)); assert.equal(events.length, 1);
      const audit = events[0]; assert.equal(audit.actorRole, role); assert.equal(audit.authority, role === "admin" ? "manager" : "supervisor");
      assert.equal(audit.actorUid, f.actor); assert.equal(audit.technicianUid, evidence.technicianUid); assert.equal(audit.position, position);
      assert.equal(audit.handoverDocumentId, result.handoverDocumentId); assert.equal(audit.outgoingShiftId, f.outgoing);
      assert.equal(audit.previousRevision, 1); assert.equal(audit.newRevision, 2);
      assert.equal(audit.previousSnapshotHash, result.snapshotHash); assert.equal(audit.newSnapshotHash, outcome.handover.snapshotHash);
      assert.equal(audit.recordedAt, evidence.recordedAt); assert.ok(audit.createdAt.toDate());
      if (operation === "exception") assert.equal(audit.category, "unavailable");
      assert.doesNotMatch(JSON.stringify(audit), /password|refreshToken|idToken|sessionCookie/);
      assert.deepEqual(await forbiddenState(), before); await noTransfer(f, aggregate);
    });
  }
for (const operation of ["absence", "exception", "clear"]) test(`${operation} idempotency performs no writes`, async () => {
  const { f, result } = await prepared();
  await resolve(resolutionInput(f, result, operation)); const reviewed = await current(result);
  const before = await state(); const snapshot = await ref("handovers", result.handoverDocumentId).get();
  assert.equal((await resolve(resolutionInput(f, reviewed, operation))).status, "ALREADY_RESOLVED");
  assert.deepEqual(await state(), before);
  assert.equal(compareUpdateTimes(snapshot.updateTime, (await ref("handovers", result.handoverDocumentId).get()).updateTime), 0);
});
for (const original of ["absence", "exception"]) test(`clear ${original}, preserve other provenance and permit explicit conversion`, async () => {
  const { f, result } = await prepared();
  await resolve(resolutionInput(f, result, original)); let reviewed = await current(result);
  await resolve(resolutionInput(f, reviewed, "exception", f.incoming[0])); reviewed = await current(result);
  const carried = reviewed.aggregate.exceptions.find((entry) => entry.technicianUid === f.incoming[0]);
  await confirm(input(f, reviewed, f.out[1]));
  const before = await forbiddenState();
  assert.equal((await resolve(resolutionInput(f, reviewed, "clear"))).status, "RESOLVED");
  reviewed = await current(result); assert.equal(reviewed.aggregate.revision, 4);
  assert.deepEqual(reviewed.aggregate.confirmations, []); assert.equal(reviewed.aggregate.absences.length, 0);
  assert.deepEqual(reviewed.aggregate.exceptions, [{ ...carried, revision: 4 }]);
  const events = await audits(actionFor("clear")); assert.equal(events.length, 1);
  assert.equal(events[0].position, "outgoing_primary_a"); assert.equal(events[0].previousRevision, 3); assert.equal(events[0].newRevision, 4);
  assert.equal(Object.hasOwn(events[0], "reason"), false); assert.equal(Object.hasOwn(events[0], "category"), false);
  assert.deepEqual(await forbiddenState(), before);
  assert.equal((await resolve(resolutionInput(f, reviewed, original === "absence" ? "exception" : "absence"))).status, "RESOLVED");
});
for (const original of ["absence", "exception"]) test(`conflicting ${original} requires explicit clear atomically`, async () => {
  const { f, result } = await prepared(); await resolve(resolutionInput(f, result, original)); const reviewed = await current(result);
  await rejectsAtomically(() => resolve(resolutionInput(f, reviewed, original === "absence" ? "exception" : "absence")),
    HandoverDomainError, 409, original === "absence" ? "Conflicting absence; clear it explicitly first." :
      "Conflicting supervisor exception; clear it explicitly first.");
});
for (const kind of ["unrelated", "temporary C", "replacement", "former member"]) test(`${kind} cannot receive resolution`, async () => {
  const { f, result } = await prepared(); let uid = kind === "replacement" ? f.replacement[0] : "outsider";
  if (kind === "temporary C" || kind === "former member") await ref("shift_members", "extra").set({ id: "extra", shiftId: f.outgoing,
    technicianId: uid, role: "additional", joinedAt: at, leftAt: kind === "former member" ? at : null });
  await rejectsAtomically(() => resolve(resolutionInput(f, result, "absence", uid)), AssignmentOperationError, 403,
    "Only a permanent handover participant can receive a resolution.");
});
for (const operation of ["absence", "exception", "clear"]) test(`${operation} work drift withholds requested change and preserves provenance`, async () => {
  const { f, task, result } = await prepared();
  let aggregate = reviseHandoverSnapshot(result.aggregate, { revision: 1, snapshotHash: result.snapshotHash,
    recordedAt: new Date().toISOString(), workSnapshot: result.aggregate.workSnapshot,
    temporaryAuthorization: { authorizationId: "future-c", technicianUid: "temporary-c" } });
  await ref("handovers", result.handoverDocumentId).set(aggregate);
  let reviewed = await current(result);
  await resolve(resolutionInput(f, reviewed, "absence")); reviewed = await current(result);
  await resolve(resolutionInput(f, reviewed, "exception", f.incoming[0])); reviewed = await current(result);
  await confirm(input(f, reviewed, f.out[1]));
  await transitionTask({ taskId: task.id, actorUid: f.actor, action: "return", reason: "Changed work" });
  const before = await forbiddenState(); const old = reviewed.aggregate;
  const target = operation === "clear" ? f.out[0] : f.incoming[1];
  const outcome = await resolve(resolutionInput(f, reviewed, operation, target));
  assert.equal(outcome.status, "REVIEW_REQUIRED"); assert.equal(outcome.handover.revision, old.revision + 1);
  aggregate = (await current(result)).aggregate; assert.deepEqual(aggregate.confirmations, []);
  assert.deepEqual(aggregate.absences, old.absences.map((entry) => ({ ...entry, revision: aggregate.revision })));
  assert.deepEqual(aggregate.exceptions, old.exceptions.map((entry) => ({ ...entry, revision: aggregate.revision })));
  assert.deepEqual(aggregate.temporaryAuthorization, old.temporaryAuthorization);
  assert.deepEqual(aggregate.reservation, { ...old.reservation, revision: aggregate.revision });
  assert.deepEqual(aggregate.workSnapshot, await work(f)); assert.deepEqual(await forbiddenState(), before);
  const events = await audits("SHIFT_HANDOVER_SNAPSHOT_REVISED"); assert.equal(events.length, 1);
  assert.deepEqual(events[0].previousWorkSnapshot, old.workSnapshot); assert.deepEqual(events[0].newWorkSnapshot, aggregate.workSnapshot);
  assert.equal(events[0].newSnapshotHash, outcome.handover.snapshotHash);
  await rejectsAtomically(() => resolve(resolutionInput(f, reviewed, operation, target)), AssignmentOperationError, 409,
    "Stale or closed handover. Review it before resolving.");
  reviewed = await current(result); assert.equal((await resolve(resolutionInput(f, reviewed, operation, target))).status, "RESOLVED");
});
for (const operation of ["absence", "exception", "clear"]) test(`work drift before ${operation} no-op still revises`, async () => {
  const { f, task, result } = await prepared(); await resolve(resolutionInput(f, result, operation)); const reviewed = await current(result);
  await ref("tasks", task.id).update({ description: "Changed reviewed work" });
  const before = await forbiddenState(); const outcome = await resolve(resolutionInput(f, reviewed, operation));
  assert.equal(outcome.status, "REVIEW_REQUIRED"); assert.equal(outcome.handover.revision, reviewed.aggregate.revision + 1);
  assert.equal((await audits("SHIFT_HANDOVER_SNAPSHOT_REVISED")).length, 1); assert.deepEqual(await forbiddenState(), before);
});
test("terminal task assignment identity remains authoritative", async () => {
  const { f, result } = await prepared(); const terminal = await seedTask(f, "completed", "terminal-task");
  const assignment = await seedAssignment(f, terminal); await ref("task_assignments", assignment.id).update({ id: "forged" });
  await rejectsAtomically(() => resolve(resolutionInput(f, result)), AssignmentOperationError, 409, "Inconsistent authoritative assignment identity.");
});
for (const category of ["emergency", "operational_constraint"]) test(`exception category ${category} persists exactly`, async () => {
  const { f, result } = await prepared(); await resolve(resolutionInput(f, result, "exception", f.out[0], { category }));
  assert.equal((await current(result)).aggregate.exceptions[0].category, category);
  assert.equal((await audits(actionFor("exception")))[0].category, category);
});
for (const operation of ["absence", "exception"]) test(`${operation} changed reason advances provenance once`, async () => {
  const { f, result } = await prepared(); await resolve(resolutionInput(f, result, operation)); const reviewed = await current(result);
  await resolve(resolutionInput(f, reviewed, operation, f.out[0], { reason: "Corrected explanation" }));
  const aggregate = (await current(result)).aggregate; const evidence = operation === "absence" ? aggregate.absences[0] : aggregate.exceptions[0];
  assert.equal(aggregate.revision, 3); assert.equal(evidence.recordedRevision, 3); assert.equal(evidence.reason, "Corrected explanation");
  assert.equal((await audits(actionFor(operation))).length, 2);
});
const corruptions = [
  ["missing actor", ({ f }) => ref("users", f.actor).delete(), 403],
  ...["technician", "supervisor"].map((role) => [`actor role ${role}`, ({ f }) => ref("users", f.actor).update({ role }), 403]),
  ...["blocked", "inactive", "revoked"].map((status) => [`actor ${status}`, ({ f }) => ref("users", f.actor).update({ status }), 403]),
  ["actor password change", ({ f }) => ref("users", f.actor).update({ mustChangePassword: true }), 403],
  ["actor pending operation", ({ f }) => ref("users", f.actor).update({ statusOperation: { id: "pending" } }), 403],
  ["missing handover", ({ result }) => ref("handovers", result.handoverDocumentId).delete(), 404],
  ["malformed handover", ({ result }) => ref("handovers", result.handoverDocumentId).update({ revision: 0 }), 400],
  ...["completed", "cancelled", "superseded"].map((lifecycleStatus) => [`closed ${lifecycleStatus}`, ({ result }) => ref("handovers", result.handoverDocumentId).update({ lifecycleStatus }), 409]),
  ["missing outgoing shift", ({ f }) => ref("shifts", f.outgoing).delete(), 409],
  ...["active", "completed", "scheduled"].map((status) => [`outgoing ${status}`, ({ f }) => ref("shifts", f.outgoing).update({ status }), 409]),
  ["outgoing actualEnd", ({ f }) => ref("shifts", f.outgoing).update({ actualEnd: at }), 409],
  ["outgoing actualStart", ({ f }) => ref("shifts", f.outgoing).update({ actualStart: "invalid" }), 409],
  ["outgoing identity", ({ f }) => ref("shifts", f.outgoing).update({ id: "other" }), 409],
  ["outgoing pair", ({ f }) => ref("shifts", f.outgoing).update({ permanentPairId: f.inPair }), 409],
  ["outgoing primary order", ({ f }) => ref("shifts", f.outgoing).update({ primaryTechnicianIds: [...f.out].reverse() }), 409],
  ["missing control", () => ref("operational_shift_control", "global").delete(), 409],
  ["wrong control owner", () => ref("operational_shift_control", "global").update({ shiftId: "other" }), 409],
  ["wrong control token", () => ref("operational_shift_control", "global").update({ slotToken: randomUUID() }), 409],
  ["wrong control generation", () => ref("operational_shift_control", "global").update({ generation: 2, previousSlotToken: randomUUID(), advancedAt: at }), 409],
  ["wrong control status", () => ref("operational_shift_control", "global").update({ shiftStatus: "active" }), 409],
  ["control pending", () => ref("operational_shift_control", "global").update({ slotStatus: "pending", shiftId: null, shiftStatus: null, consumedAt: null }), 409],
  ...["outPair", "inPair"].flatMap((side) => [
    [`missing ${side}`, ({ f }) => ref("technician_pairs", f[side]).delete(), 409],
    [`inactive ${side}`, ({ f }) => ref("technician_pairs", f[side]).update({ status: "inactive" }), 409],
    [`ordered ${side} drift`, ({ f }) => ref("technician_pairs", f[side]).update({ technicianIds: [...f[side === "outPair" ? "out" : "incoming"]].reverse() }), 409],
  ]),
  ...["out", "incoming"].flatMap((side) => [
    [`missing ${side} pair membership`, ({ f }) => ref("technician_pair_memberships", f[side][0]).delete(), 409],
    [`wrong ${side} pair membership`, ({ f }) => ref("technician_pair_memberships", f[side][0]).update({ pairId: "other" }), 409],
    [`wrong ${side} membership UID`, ({ f }) => ref("technician_pair_memberships", f[side][0]).update({ technicianUid: "other" }), 409],
    [`bad ${side} membership timestamp`, ({ f }) => ref("technician_pair_memberships", f[side][0]).update({ createdAt: "bad" }), 409],
    [`reversed ${side} membership timestamp`, ({ f }) => ref("technician_pair_memberships", f[side][0]).update({ updatedAt: "2019-01-01T00:00:00.000Z" }), 409],
  ]),
  ["missing outgoing primary member", ({ f }) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).delete(), 409],
  ["departed outgoing primary", ({ f }) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).update({ leftAt: at }), 409],
  ["outgoing primary as additional", ({ f }) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).update({ role: "additional" }), 409],
  ["bad member identity", ({ f }) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).update({ id: "other" }), 409],
  ["bad joinedAt", ({ f }) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).update({ joinedAt: "bad" }), 409],
  ["incoming already materialized", ({ result }) => ref("shifts", result.aggregate.identity.incomingShiftId).set({ id: "unexpected" }), 409],
  ["malformed task", ({ task }) => ref("tasks", task.id).update({ title: "" }), 409],
  ["wrong task document identity", ({ task }) => ref("tasks", task.id).update({ id: "other" }), 409],
  ["wrong assignment identity", ({ assignment }) => ref("task_assignments", assignment.id).update({ id: "other" }), 409],
];
function corruptionContract(name) {
  const messages = {
    "missing actor": "Your account is not authorized to resolve handover participants.",
    "actor password change": "Your account is not authorized to resolve handover participants.",
    "actor pending operation": "Your account is not authorized to resolve handover participants.",
    "missing handover": "The formal handover was not found.",
    "missing outgoing primary member": "Outgoing primary memberships changed.",
    "departed outgoing primary": "Outgoing primary memberships changed.",
    "outgoing primary as additional": "An additional technician cannot occupy a permanent handover signer position.",
    "bad member identity": "Invalid outgoing Shift membership.",
    "bad joinedAt": "Invalid outgoing Shift membership.",
    "incoming already materialized": "The reserved incoming Shift already exists.",
    "wrong task document identity": "Inconsistent authoritative task identity.",
    "wrong assignment identity": "Inconsistent authoritative assignment identity.",
  };
  if (name === "malformed handover") return [HandoverDomainError, "Invalid revision."];
  if (name === "malformed task") return [HandoverDomainError, "Malformed authoritative handover work."];
  if (/^(missing|inactive) (outPair|inPair)$/.test(name)) return [NextShiftAuthorizationDomainError,
    "The selected permanent technician pair is inactive, corrupt, or requires administrator review."];
  if (/^ordered (outPair|inPair) drift$/.test(name)) return [AssignmentOperationError, "The permanent pair binding changed."];
  if (name.includes("pair membership") || /^wrong .* membership UID$/.test(name) ||
      /^(bad|reversed) .* membership timestamp$/.test(name)) return [AssignmentOperationError, "The permanent pair membership is inconsistent."];
  if (name.startsWith("closed ")) return [AssignmentOperationError, "Stale or closed handover. Review it before resolving."];
  if (name.startsWith("actor role ")) return [AssignmentOperationError, "Your account is not authorized to resolve handover participants."];
  if (["actor blocked", "actor inactive", "actor revoked"].includes(name)) return [AssignmentOperationError, "Your account is not authorized to resolve handover participants."];
  if (name.includes("control")) return [AssignmentOperationError, "The outgoing Shift no longer owns valid handover control."];
  if (name === "missing outgoing shift" || name.startsWith("outgoing ") && !Object.hasOwn(messages, name)) {
    return [AssignmentOperationError, "The outgoing handover Shift changed."];
  }
  assert.ok(Object.hasOwn(messages, name), `Missing explicit rejection contract for ${name}`);
  return [AssignmentOperationError, messages[name]];
}
for (const [name, mutate, status] of corruptions) test(`fails atomically: ${name}`, async () => {
  const context = await prepared(); await mutate(context);
  const [ErrorType, message] = corruptionContract(name);
  await rejectsAtomically(() => resolve(resolutionInput(context.f, context.result)), ErrorType, status, message);
});
for (const side of ["out", "incoming"]) for (const kind of ["missing", "duplicate", "wrong status", "wrong time", "wrong ID", "malformed", "overlap", "active conflict"]) {
  test(`${side} schedule ${kind} fails atomically`, async () => {
    const { f, result } = await prepared(); const uid = f[side][0]; const schedule = await data("technician_schedules", uid);
    const targetIndex = side === "out" ? 0 : 1; const target = schedule.entries[targetIndex];
    if (kind === "missing") await ref("technician_schedules", uid).delete();
    else {
      if (kind === "duplicate") schedule.entries.push(target);
      if (kind === "wrong status") schedule.entries[targetIndex] = { ...target, status: side === "out" ? "active" : "handover_pending" };
      if (kind === "wrong time") schedule.entries[targetIndex] = { ...target, scheduledEnd: "2031-01-01T00:00:00.000Z" };
      if (kind === "wrong ID") schedule.entries[targetIndex] = { ...target, shiftId: "other" };
      if (kind === "malformed") schedule.entries.push({});
      if (kind === "overlap") schedule.entries.push({ ...target, shiftId: "conflicting", status: "scheduled" });
      if (kind === "active conflict") schedule.entries.push({ ...unrelated, shiftId: "active-conflict", status: "active" });
      await ref("technician_schedules", uid).set(schedule);
    }
    const contracts = {
      missing: [409, "Missing technician schedule."],
      duplicate: [409, "Invalid schedule entry."],
      "wrong status": [409, "The handover schedule binding changed."],
      "wrong time": [409, "The handover schedule binding changed."],
      "wrong ID": [409, "The handover schedule binding changed."],
      malformed: [400, "Invalid resolution identifier."],
      overlap: [409, "This technician is already assigned to another shift during the selected time period."],
      "active conflict": [409, "This technician has an active shift or an unfinished handover."],
    };
    await rejectsAtomically(() => resolve(resolutionInput(f, result)), AssignmentOperationError, ...contracts[kind]);
  });
}
for (const override of [{ expectedRevision: 2 }, { expectedSnapshotHash: "0".repeat(64) }]) test(`stale client binding ${JSON.stringify(override)} makes no writes`, async () => {
  const { f, task, result } = await prepared(); await ref("tasks", task.id).update({ description: "Drift" });
  await rejectsAtomically(() => resolve({ ...resolutionInput(f, result), ...override }), AssignmentOperationError, 409,
    "Stale or closed handover. Review it before resolving.");
});

function staleResolution(error) {
  assert.ok(error instanceof AssignmentOperationError);
  assert.equal(error instanceof HandoverDomainError, false); assert.equal(error instanceof NextShiftAuthorizationDomainError, false);
  assert.equal(error.status, 409); assert.equal(error.message, "Stale or closed handover. Review it before resolving.");
}
for (const pair of [["absence", "absence"], ["exception", "exception"], ["absence", "exception"]])
  test(`genuine overlapping ${pair.join(" vs ")} has one revision and one audit`, { timeout: 60000 }, async (t) => {
    const { f, result } = await prepared(); const before = await forbiddenState();
    const outcomes = await contend(t, ref("handovers", result.handoverDocumentId),
      () => resolve(resolutionInput(f, result, pair[0])), () => resolve(resolutionInput(f, result, pair[1])));
    assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
    for (const entry of outcomes) {
      if (entry.status === "rejected") staleResolution(entry.reason);
      else assert.equal(entry.value.status, "RESOLVED");
    }
    const { aggregate } = await current(result); assert.equal(aggregate.revision, 2);
    assert.equal(aggregate.absences.length + aggregate.exceptions.length, 1);
    const events = [...await audits(actionFor("absence")), ...await audits(actionFor("exception"))]; assert.equal(events.length, 1);
    assert.deepEqual(await forbiddenState(), before); await noTransfer(f, aggregate);
  });
test("genuine resolution and confirmation overlap cannot lose confirmations or resolution", { timeout: 60000 }, async (t) => {
  const { f, result } = await prepared(); const before = await forbiddenState();
  const [resolution, confirmation] = await contend(t, ref("handovers", result.handoverDocumentId),
    () => resolve(resolutionInput(f, result)), () => confirm(input(f, result, f.incoming[0])));
  assert.equal(resolution.status, "fulfilled"); assert.equal(resolution.value.status, "RESOLVED");
  if (confirmation.status === "rejected") {
    assert.ok(confirmation.reason instanceof AssignmentOperationError); assert.equal(confirmation.reason.status, 409);
    assert.equal(confirmation.reason.message, "Stale or closed handover. Review it before confirming.");
  } else assert.equal(confirmation.value.status, "CONFIRMED");
  const { aggregate } = await current(result); assert.equal(aggregate.revision, 2); assert.deepEqual(aggregate.confirmations, []);
  assert.equal(aggregate.absences.length, 1); assert.deepEqual(await forbiddenState(), before);
});
for (const first of ["resolution", "confirmation"]) test(`${first}-first serialization invalidates stale confirmations`, async () => {
  const { f, result } = await prepared();
  if (first === "resolution") {
    await confirm(input(f, result, f.out[1])); await resolve(resolutionInput(f, result));
    await rejectsAtomically(() => confirm(input(f, result, f.incoming[0])), AssignmentOperationError, 409,
      "Stale or closed handover. Review it before confirming.");
  } else {
    await confirm(input(f, result, f.incoming[0])); const reviewed = await current(result);
    assert.equal(reviewed.aggregate.confirmations.length, 1); await resolve(resolutionInput(f, reviewed));
  }
  const { aggregate } = await current(result); assert.equal(aggregate.revision, 2); assert.deepEqual(aggregate.confirmations, []);
  assert.equal(aggregate.absences.length, 1); assert.equal((await audits(actionFor("absence"))).length, 1);
});
for (const action of ["return", "complete", "cancel"]) {
  test(`genuine lifecycle/resolution contention ${action}`, { timeout: 60000 }, async (t) => {
    const { f, task, result } = await prepared();
    const [lifecycle, resolution] = await contend(t, ref("tasks", task.id),
      () => transitionTask({ taskId: task.id, actorUid: f.actor, action, reason: "Concurrent lifecycle" }),
      () => resolve(resolutionInput(f, result)), "tasks");
    assert.equal(lifecycle.status, "fulfilled"); assert.equal(resolution.status, "fulfilled");
    const taskSnapshot = await ref("tasks", task.id).get(); const aggregateSnapshot = await ref("handovers", result.handoverDocumentId).get();
    const order = compareUpdateTimes(taskSnapshot.updateTime, aggregateSnapshot.updateTime); assert.notEqual(order, 0);
    let reviewed = await current(result);
    if (order < 0) {
      assert.equal(resolution.value.status, "REVIEW_REQUIRED"); assert.deepEqual(reviewed.aggregate.absences, []);
      assert.deepEqual(reviewed.aggregate.workSnapshot, await work(f)); assert.equal(reviewed.aggregate.revision, 2);
      assert.equal((await audits(actionFor("absence"))).length, 0);
    } else {
      assert.equal(resolution.value.status, "RESOLVED"); assert.equal(reviewed.aggregate.absences.length, 1);
      const evidence = reviewed.aggregate.absences[0];
      assert.equal((await resolve(resolutionInput(f, reviewed))).status, "REVIEW_REQUIRED"); reviewed = await current(result);
      assert.deepEqual(reviewed.aggregate.absences, [{ ...evidence, revision: 3 }]);
    }
    t.diagnostic(`Real SDK overlap: ${order < 0 ? "work first; request withheld" : "resolution first; next request reconciles"}`);
  });
  for (const first of ["work", "resolution"]) test(`${first}-first lifecycle ordering ${action}`, async () => {
    const { f, task, result } = await prepared();
    const lifecycle = () => transitionTask({ taskId: task.id, actorUid: f.actor, action, reason: "Ordered lifecycle" });
    if (first === "work") {
      await lifecycle(); assert.equal((await resolve(resolutionInput(f, result))).status, "REVIEW_REQUIRED");
      assert.deepEqual((await current(result)).aggregate.absences, []);
    } else {
      await resolve(resolutionInput(f, result)); const reviewed = await current(result); const evidence = reviewed.aggregate.absences[0];
      await lifecycle(); assert.equal((await resolve(resolutionInput(f, reviewed))).status, "REVIEW_REQUIRED");
      assert.deepEqual((await current(result)).aggregate.absences, [{ ...evidence, revision: 3 }]);
    }
    assert.deepEqual((await current(result)).aggregate.workSnapshot, await work(f));
    assert.equal((await audits("SHIFT_HANDOVER_SNAPSHOT_REVISED")).length, 1);
  });
}

// Hold a real authoritative actor read before invoking the untouched production
// callback. The other real service commits while this SDK transaction is open;
// no business snapshots, aborts, retries, or production hooks are fabricated.
async function commitDuringOpenRead(t, actorRef, openOperation, committingOperation) {
  const original = db.runTransaction; const context = new AsyncLocalStorage();
  const acquired = deferred(), release = deferred(); let held = false;
  db.runTransaction = function(callback, options) {
    const operation = context.getStore();
    return original.call(db, async (transaction) => {
      if (operation === "held" && !held) {
        held = true; assert.equal((await transaction.get(actorRef)).exists, true);
        acquired.resolve(); await release.promise;
      }
      return callback(transaction);
    }, options);
  };
  const abort = () => { acquired.resolve(); release.resolve(); };
  t.signal.addEventListener("abort", abort, { once: true });
  const pending = context.run("held", openOperation); const settled = Promise.allSettled([pending]);
  try {
    await acquired.promise;
    const committed = await context.run("committing", committingOperation);
    release.resolve(); const [entry] = await settled;
    return { committed, entry };
  } finally {
    release.resolve(); acquired.resolve(); db.runTransaction = original;
    t.signal.removeEventListener("abort", abort); await settled;
  }
}
for (const first of ["resolution", "confirmation"]) test(`genuine forced ${first}-first overlap`, { timeout: 60000 }, async (t) => {
  const { f, result } = await prepared();
  const { entry } = first === "resolution" ? await commitDuringOpenRead(t, ref("users", f.incoming[0]),
    () => confirm(input(f, result, f.incoming[0])), () => resolve(resolutionInput(f, result))) :
    await commitDuringOpenRead(t, ref("users", f.actor), () => resolve(resolutionInput(f, result)),
      () => confirm(input(f, result, f.incoming[0])));
  if (first === "resolution") {
    assert.equal(entry.status, "rejected"); assert.ok(entry.reason instanceof AssignmentOperationError);
    assert.equal(entry.reason.status, 409); assert.equal(entry.reason.message, "Stale or closed handover. Review it before confirming.");
    assert.equal((await audits("SHIFT_HANDOVER_TECHNICIAN_CONFIRMED")).length, 0);
  } else {
    assert.equal(entry.status, "fulfilled"); assert.equal(entry.value.status, "RESOLVED");
    assert.equal((await audits("SHIFT_HANDOVER_TECHNICIAN_CONFIRMED")).length, 1);
  }
  const { aggregate } = await current(result); assert.equal(aggregate.revision, 2); assert.deepEqual(aggregate.confirmations, []);
  assert.equal(aggregate.absences.length, 1); assert.equal((await audits(actionFor("absence"))).length, 1);
});
for (const action of ["return", "complete", "cancel"]) test(`genuine forced work-first overlap ${action}`, { timeout: 60000 }, async (t) => {
  const { f, task, result } = await prepared();
  const supervisor = "independent-supervisor";
  await ref("users", supervisor).set({ uid: supervisor, role: "supervisor", status: "active", statusOperation: null, mustChangePassword: false });
  const { entry } = await commitDuringOpenRead(t, ref("users", supervisor),
    () => resolve(resolutionInput(f, result, "absence", f.out[0], { actorUid: supervisor, actorRole: "supervisor" })),
    () => transitionTask({ taskId: task.id, actorUid: f.actor, action, reason: "Commit during open resolution transaction" }));
  assert.equal(entry.status, "fulfilled"); assert.equal(entry.value.status, "REVIEW_REQUIRED");
  const taskSnapshot = await ref("tasks", task.id).get(); const handoverSnapshot = await ref("handovers", result.handoverDocumentId).get();
  assert.ok(compareUpdateTimes(taskSnapshot.updateTime, handoverSnapshot.updateTime) < 0);
  const aggregate = assertHandoverAggregate(handoverSnapshot.data());
  assert.equal(aggregate.revision, 2); assert.deepEqual(aggregate.absences, []); assert.deepEqual(aggregate.workSnapshot, await work(f));
  assert.equal((await audits(actionFor("absence"))).length, 0); assert.equal((await audits("SHIFT_HANDOVER_SNAPSHOT_REVISED")).length, 1);
});
for (const patch of [{ mustChangePassword: null }, { mustChangePassword: true }, { role: "technician" }])
  test(`authoritative manager profile ${JSON.stringify(patch)} rejected atomically`, async () => {
    const { f, result } = await prepared(); await ref("users", f.actor).update(patch);
    await rejectsAtomically(() => resolve(resolutionInput(f, result)), AssignmentOperationError, 403,
      "Your account is not authorized to resolve handover participants.");
  });
for (const operation of ["absence", "exception", "clear"]) test(`trusted ${operation} service rejects evidence overrides atomically`, async () => {
  const { f, result } = await prepared();
  await rejectsAtomically(() => resolve(resolutionInput(f, result, operation, f.out[0], { recordedAt: at })), AssignmentOperationError, 400,
    "Missing or unsupported resolution fields.");
});
