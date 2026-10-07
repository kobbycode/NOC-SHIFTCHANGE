import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const project = "demo-shiftchange-handover-work-disposition";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !["127.0.0.1:8088", "localhost:8088"].includes(host) ||
    ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]
      .some((key) => process.env[key] !== project)) throw new Error("Refusing to run outside the isolated local demo emulator.");
const { FieldValue } = await import("firebase-admin/firestore");
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { initializeFormalHandover: initialize } = await import("../src/lib/operations/formal-handover.ts");
const { persistFormalHandoverResolution: resolve } = await import("../src/lib/operations/formal-handover-resolution.ts");
const { persistFormalHandoverConfirmation: confirm } = await import("../src/lib/operations/formal-handover-confirmation.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { NextShiftAuthorizationDomainError } = await import("../src/lib/operations/next-shift-authorization-domain.ts");
const { HandoverDomainError, createHandoverSnapshot, assertHandoverAggregate, reviseHandoverSnapshot, createHandover, recordHandoverAbsence, recordHandoverException } =
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
  for (const collection of ["handovers", "handover_task_dispositions", "technician_schedules", "audit_logs", "operational_shift_control", "shifts", "shift_members", "shift_attendance", "task_assignments", "next_shift_authorizations", "tasks", "users", "technician_pairs", "technician_pair_memberships"]) {
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
  const dispositions = (await db.collection("handover_task_dispositions").get()).docs.map(document => document.data());
  return createHandoverWorkSnapshot({ outgoingShiftId: f.outgoing, tasks, assignments, dispositions });
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
// Existing outgoing attendance is preserved; incoming attendance remains absent.
async function noTransfer(f, aggregate) {
  assert.deepEqual(await data("operational_shift_control", "global"), f.control);
  assert.deepEqual(await data("shifts", f.outgoing), f.shift);
  assert.equal(await data("shifts", aggregate.identity.incomingShiftId), undefined);
  assert.equal((await db.collection("shift_members").where("shiftId", "==", aggregate.identity.incomingShiftId).get()).size, 0);
  assert.equal((await db.collection("shift_attendance").where("shiftId", "==", aggregate.identity.incomingShiftId).get()).size, 0);
}

const { persistFormalHandoverWorkDisposition: classify } = await import("../src/lib/operations/formal-handover-work-disposition.ts");
const { createHandoverWorkDispositionDocumentId } = await import("../src/lib/operations/handover-work-disposition-domain.ts");
const { resolveHandoverWorkReadiness } = await import("../src/lib/operations/handover-work-snapshot.ts");
const { completeShift } = await import("../src/lib/operations/complete-shift.ts");
const { replaceFormalHandoverReservation: replace, cancelFormalHandoverReservation: cancel } = await import("../src/lib/operations/formal-handover.ts");

test("repository rules deny direct client disposition writes", async () => {
  await fixture();
  const response = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents/handover_task_dispositions/client-forbidden`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: { forged: { booleanValue: true } } }),
  });
  assert.equal(response.status, 403);
  assert.equal(await data("handover_task_dispositions", "client-forbidden"), undefined);
});
const reason = "Reviewed operational handover work";
const request = (f, task, result, extra = {}) => ({ outgoingShiftId: f.outgoing, taskId: task.id, actorUid: f.actor,
  operation: "classify", disposition: "carry_forward", reason, ...bound(result), ...extra });
const dispositionId = (f, task) => createHandoverWorkDispositionDocumentId({ outgoingShiftId: f.outgoing, handoverDocumentId: `handover_${f.outgoing}`, taskId: task.id });
async function current(f) {
  const aggregate = assertHandoverAggregate(await data("handovers", `handover_${f.outgoing}`));
  return { aggregate, snapshotHash: createHandoverSnapshot(aggregate).snapshotHash, handoverDocumentId: `handover_${f.outgoing}` };
}
async function workInput(f) {
  const tasks = (await db.collection("tasks").where("shiftId", "==", f.outgoing).get()).docs.map(document => document.data());
  const assignments = (await db.collection("task_assignments").get()).docs.map(document => document.data());
  const dispositions = (await db.collection("handover_task_dispositions").get()).docs.map(document => document.data());
  return { outgoingShiftId: f.outgoing, tasks, assignments, dispositions };
}
async function allowedOnly(before, collections) {
  const after = await state(); for (const collection of collections) { delete before[collection]; delete after[collection]; }
  assert.deepEqual(after, before);
}
async function assertClassified(f, task, expectedRevision) {
  const record = await data("handover_task_dispositions", dispositionId(f, task));
  const result = await current(f);
  assert.equal(result.aggregate.revision, expectedRevision); assert.equal(result.aggregate.reservation.revision, expectedRevision);
  assert.equal(result.aggregate.workSnapshot.schema, "handover-work-v2");
  assert.deepEqual(result.aggregate.workSnapshot, await work(f)); assert.deepEqual(result.aggregate.confirmations, []);
  assert.equal(record.classifiedBy, f.actor); assert.equal(record.recordedRevision, expectedRevision);
  assert.equal(record.classifierRole, f.role); assert.equal(record.reason, reason); assert.ok(Number.isFinite(Date.parse(record.classifiedAt)));
  return result;
}
for (const role of ["admin", "supervisor"]) for (const value of ["carry_forward", "resolve_before_transfer"]) test(`${role} persists ${value} with only approved writes`, async () => {
  const f = await fixture("handover_pending", role); const task = await seedTask(f); const result = await initialize(f.input);
  await confirm(input(f, result)); const before = await state();
  const outcome = await classify(request(f, task, result, { disposition: value })); assert.equal(outcome.status, "CLASSIFIED");
  const next = await assertClassified(f, task, 2); assert.equal((await data("handover_task_dispositions", dispositionId(f, task))).disposition, value);
  assert.notEqual(next.snapshotHash, result.snapshotHash); await allowedOnly(before, ["handovers", "handover_task_dispositions", "audit_logs"]);
  assert.equal((await audits("SHIFT_HANDOVER_WORK_DISPOSITION_CREATED")).length, 1); await noTransfer(f, next.aggregate);
});
test("exact retry and already-clear preserve all state and updateTime", async () => {
  const { f, task, result } = await prepared(); await classify(request(f, task, result)); const next = await current(f);
  const before = await state(); const document = await ref("handovers", next.handoverDocumentId).get();
  assert.equal((await classify(request(f, task, next))).status, "ALREADY_CLASSIFIED"); assert.deepEqual(await state(), before);
  assert.equal(compareUpdateTimes(document.updateTime, (await ref("handovers", next.handoverDocumentId).get()).updateTime), 0);
  const cleared = { ...request(f, task, next), operation: "clear" }; delete cleared.disposition;
  assert.equal((await classify(cleared)).status, "CLEARED"); const again = await current(f); const noRecord = await state();
  assert.equal((await classify({ ...cleared, ...bound(again) })).status, "ALREADY_UNCLASSIFIED"); assert.deepEqual(await state(), noRecord);
  assert.equal(await data("handover_task_dispositions", dispositionId(f, task)), undefined);
  const audit = (await audits("SHIFT_HANDOVER_WORK_DISPOSITION_CLEARED"))[0]; assert.equal(audit.oldDisposition.classifiedBy, f.actor); assert.equal(audit.newDisposition, null);
  assert.equal(resolveHandoverWorkReadiness(await workInput(f)).ready, false);
});
for (const change of [{ disposition: "resolve_before_transfer" }, { reason: "Materially different reviewed reason" }, { actorUid: "other-manager" }]) test(`material change ${JSON.stringify(change)} clears confirmations once`, async () => {
  const { f, task, result } = await prepared(); await classify(request(f, task, result)); const next = await current(f); await confirm(input(f, next));
  await ref("users", "other-manager").set({ role: "admin", status: "active", statusOperation: null, mustChangePassword: false });
  assert.equal((await classify(request(f, task, next, change))).status, "CLASSIFIED"); const after = await current(f);
  assert.equal(after.aggregate.revision, 3); assert.deepEqual(after.aggregate.confirmations, []);
  assert.equal((await audits("SHIFT_HANDOVER_WORK_DISPOSITION_CHANGED")).length, 1);
});
test("both classification directions and clear preserve absence/exception provenance and C", async () => {
  const { f, task, result } = await prepared(); let aggregate = reviseHandoverSnapshot(result.aggregate, { revision: 1, snapshotHash: result.snapshotHash,
    recordedAt: new Date().toISOString(), workSnapshot: result.aggregate.workSnapshot, temporaryAuthorization: { authorizationId: "temporary-auth", technicianUid: "temporary-c" } });
  aggregate = recordHandoverAbsence(aggregate, { revision: aggregate.revision, snapshotHash: createHandoverSnapshot(aggregate).snapshotHash,
    recordedAt: new Date().toISOString(), actor: { uid: f.actor, authority: "manager" }, technicianUid: f.out[0], reason });
  aggregate = recordHandoverException(aggregate, { revision: aggregate.revision, snapshotHash: createHandoverSnapshot(aggregate).snapshotHash,
    recordedAt: new Date().toISOString(), actor: { uid: f.actor, authority: "manager" }, technicianUid: f.incoming[0], reason, category: "unavailable" });
  await ref("handovers", result.handoverDocumentId).set(aggregate); const historical = structuredClone(aggregate);
  for (const value of ["resolve_before_transfer", "carry_forward"]) await classify(request(f, task, await current(f), { disposition: value }));
  const clear = { ...request(f, task, await current(f)), operation: "clear" }; delete clear.disposition; await classify(clear);
  const next = (await current(f)).aggregate;
  for (const key of ["absences", "exceptions"]) assert.deepEqual(next[key].map(record => { const copy = { ...record }; delete copy.revision; return copy; }), historical[key].map(record => { const copy = { ...record }; delete copy.revision; return copy; }));
  assert.deepEqual(next.temporaryAuthorization, historical.temporaryAuthorization);
  assert.deepEqual({ ...next.reservation, revision: historical.revision }, historical.reservation);
});
for (const extra of [{ expectedRevision: 9 }, { expectedSnapshotHash: "0".repeat(64) }]) test(`stale binding ${JSON.stringify(extra)} cannot bypass drift/no-op`, async () => {
  const { f, task, result } = await prepared(); await ref("tasks", task.id).update({ description: "Drift" });
  await rejectsAtomically(() => classify(request(f, task, result, extra)), AssignmentOperationError, 409, "Stale or closed handover. Review it before classifying work.");
});
for (const [name, change] of [["technician", { role: "technician" }], ["temporary C", { role: "technician" }], ["blocked", { status: "blocked" }],
  ["pending operation", { statusOperation: { id: "pending" } }], ["missing operation flag", { statusOperation: FieldValue.delete() }],
  ["password", { mustChangePassword: true }], ["missing password flag", { mustChangePassword: FieldValue.delete() }]]) test(`actor ${name} rejected atomically`, async () => {
  const { f, task, result } = await prepared(); await ref("users", f.actor).update(change);
  await rejectsAtomically(() => classify(request(f, task, result)), AssignmentOperationError, 403, "Your account is not authorized to classify handover work.");
});

const corruptionMessage = "Malformed authoritative handover disposition; administrator review required.";
const invalidRecords = [
  ...Object.entries({ id: "wrong", outgoingShiftId: "wrong", handoverDocumentId: "wrong", taskId: "wrong", schema: "future", disposition: "unclassified",
    classifierRole: "technician", classifiedBy: "", classifiedAt: "invalid", reason: "short", recordedRevision: 0,
    reviewedSnapshotHash: "A".repeat(64), classifiedTaskWorkHash: "bad" }).map(([field, value]) => [field, value]),
  ...["classifiedBy", "classifierRole", "classifiedAt", "recordedRevision", "reviewedSnapshotHash", "classifiedTaskWorkHash"].map(field => [`missing ${field}`, FieldValue.delete(), field]),
];
for (const [name, value, field = name] of invalidRecords) test(`corrupt record ${name} fails intended domain branch atomically`, async () => {
  const { f, task, result } = await prepared(); await classify(request(f, task, result)); const next = await current(f);
  await ref("handover_task_dispositions", dispositionId(f, task)).update({ [field]: value });
  await rejectsAtomically(() => classify(request(f, task, next)), HandoverDomainError, 409, corruptionMessage);
});
for (const kind of ["duplicate physical document", "missing task", "relinked task", "future provenance", "assignment corruption", "unknown snapshot schema"]) {
  test(`corruption ${kind} fails atomically`, async () => {
    const { f, task, assignment, result } = await prepared(); await classify(request(f, task, result)); const next = await current(f);
    let Class = AssignmentOperationError, message;
    if (kind === "duplicate physical document") {
      await ref("handover_task_dispositions", "duplicate").set(await data("handover_task_dispositions", dispositionId(f, task)));
      message = "Inconsistent authoritative disposition identity; administrator review required.";
    }
    if (kind === "missing task") { await ref("tasks", task.id).delete(); message = "Disposition task is missing or relinked; administrator review required."; }
    if (kind === "relinked task") { await ref("tasks", task.id).update({ shiftId: "other" }); message = "Disposition task is missing or relinked; administrator review required."; }
    if (kind === "future provenance") {
      await ref("handover_task_dispositions", dispositionId(f, task)).update({ recordedRevision: 100 });
      message = "Inconsistent authoritative disposition provenance; administrator review required.";
    }
    if (kind === "assignment corruption") { await ref("task_assignments", assignment.id).update({ transferredTo: "bad" }); Class = HandoverDomainError; message = "Malformed authoritative handover work."; }
    if (kind === "unknown snapshot schema") {
      await ref("handovers", next.handoverDocumentId).update({ "workSnapshot.schema": "handover-work-v3" });
      Class = HandoverDomainError; message = "Unsupported handover work snapshot schema.";
    }
    await rejectsAtomically(() => classify(request(f, task, next)), Class, 409, message);
  });
}
for (const status of ["completed", "cancelled"]) test(`terminal ${status} cannot be classified or cleared as active work`, async () => {
  const f = await fixture(); const task = await seedTask(f, status); const result = await initialize(f.input);
  for (const operation of ["classify", "clear"]) {
    const value = request(f, task, result, { operation }); if (operation === "clear") delete value.disposition;
    await rejectsAtomically(() => classify(value), AssignmentOperationError, 409, "Terminal tasks cannot receive handover disposition mutations.");
  }
});
for (const kind of ["missing", "wrong shift"]) test(`invalid target ${kind} rejected atomically`, async () => {
  const { f, result } = await prepared(); const task = { id: "other-task" };
  if (kind === "wrong shift") await seedTask(f, "open", task.id).then(value => ref("tasks", value.id).update({ shiftId: "other" }));
  await rejectsAtomically(() => classify(request(f, task, result)), AssignmentOperationError, kind === "missing" ? 404 : 409,
    kind === "missing" ? "The selected task was not found." : "The task does not belong to the outgoing handover.");
});
for (const action of ["return", "complete", "cancel"]) test(`work ${action} drift preserves evidence and suppresses requested operation`, async () => {
  const { f, task, result } = await prepared(); await classify(request(f, task, result)); const next = await current(f); await confirm(input(f, next));
  const oldRecord = await data("handover_task_dispositions", dispositionId(f, task));
  await transitionTask({ taskId: task.id, actorUid: f.actor, action, reason }); const before = await state();
  const outcome = await classify(request(f, task, next)); assert.equal(outcome.status, "REVIEW_REQUIRED");
  const revised = await current(f); assert.equal(revised.aggregate.revision, 3); assert.deepEqual(revised.aggregate.confirmations, []);
  assert.deepEqual(await data("handover_task_dispositions", dispositionId(f, task)), oldRecord);
  await allowedOnly(before, ["handovers", "audit_logs"]);
  const readiness = resolveHandoverWorkReadiness(await workInput(f));
  if (action === "return") {
    assert.equal(readiness.ready, false); assert.equal(readiness.blockers[0].reason, "stale_disposition");
    assert.equal((await classify(request(f, task, revised))).status, "CLASSIFIED");
    assert.equal(resolveHandoverWorkReadiness(await workInput(f)).ready, true);
  } else assert.equal(readiness.ready, true);
});
async function legacy(f, task) {
  const result = await current(f); const value = await workInput(f);
  const canonical = x => Array.isArray(x) ? x.map(canonical) : x !== null && typeof x === "object"
    ? Object.fromEntries(Object.keys(x).sort().map(key => [key, canonical(x[key])])) : x;
  const projectedTask = Object.fromEntries(["id", "shiftId", "title", "description", "status", "priority", "sectionId", "updatedAt"].map(key => [key, task[key]]));
  const projectedAssignments = value.assignments.map(record => { const copy = { ...record }; delete copy.assignedBy; return copy; });
  const digest = createHash("sha256").update(JSON.stringify(canonical({ schema: "handover-work-v1", outgoingShiftId: f.outgoing, tasks: [projectedTask], assignments: projectedAssignments }))).digest("hex");
  let aggregate = createHandover({ identity: result.aggregate.identity, workSnapshot: { id: f.outgoing, version: digest },
    reservedAt: result.aggregate.createdAt, reservedBy: f.actor, temporaryAuthorization: { authorizationId: "temporary-c", technicianUid: "temporary-c" } });
  aggregate = recordHandoverAbsence(aggregate, { revision: aggregate.revision, snapshotHash: createHandoverSnapshot(aggregate).snapshotHash,
    recordedAt: new Date().toISOString(), technicianUid: f.out[0], actor: { uid: f.actor, authority: "manager" }, reason });
  aggregate = recordHandoverException(aggregate, { revision: aggregate.revision, snapshotHash: createHandoverSnapshot(aggregate).snapshotHash,
    recordedAt: new Date().toISOString(), technicianUid: f.incoming[0], actor: { uid: f.actor, authority: "manager" }, reason, category: "unavailable" });
  const { confirmHandoverParticipant } = await import("../src/lib/operations/handover-domain.ts");
  aggregate = confirmHandoverParticipant(aggregate, { revision: aggregate.revision, snapshotHash: createHandoverSnapshot(aggregate).snapshotHash,
    recordedAt: new Date().toISOString(), actorUid: f.out[1], technicianUid: f.out[1] });
  await ref("handovers", result.handoverDocumentId).set(aggregate); return current(f);
}
for (const operation of ["classify", "clear", "confirmation", "resolution"]) test(`legacy ${operation} reconciles only, preserves provenance/reservation/C`, async () => {
  const { f, task } = await prepared(); const previous = await legacy(f, task); const before = await state();
  const value = request(f, task, previous);
  if (operation === "clear") { value.operation = "clear"; delete value.disposition; }
  const outcome = operation === "confirmation" ? await confirm(input(f, previous, f.incoming[1])) : operation === "resolution" ?
    await resolve({ outgoingShiftId: f.outgoing, actorUid: f.actor, actorRole: f.role, technicianUid: f.incoming[1], operation: "absence", reason, ...bound(previous) }) : await classify(value);
  assert.equal(outcome.status, "REVIEW_REQUIRED"); const next = await current(f);
  assert.equal(next.aggregate.revision, previous.aggregate.revision + 1); assert.deepEqual(next.aggregate.confirmations, []);
  assert.equal(next.aggregate.workSnapshot.schema, "handover-work-v2");
  for (const key of ["absences", "exceptions"]) assert.deepEqual(next.aggregate[key].map(record => { const copy = { ...record }; delete copy.revision; return copy; }), previous.aggregate[key].map(record => { const copy = { ...record }; delete copy.revision; return copy; }));
  assert.deepEqual({ ...next.aggregate.reservation, revision: previous.aggregate.revision }, previous.aggregate.reservation);
  assert.deepEqual(next.aggregate.temporaryAuthorization, previous.aggregate.temporaryAuthorization);
  await allowedOnly(before, ["handovers", "audit_logs"]); assert.equal((await audits("SHIFT_HANDOVER_SNAPSHOT_REVISED")).length, 1);
  if (operation === "classify") assert.equal((await classify(request(f, task, next))).status, "CLASSIFIED");
});
for (const status of ["cancelled", "superseded", "completed"]) test(`closed legacy ${status} stays historical`, async () => {
  const { f, task } = await prepared(); const result = await legacy(f, task);
  await ref("handovers", result.handoverDocumentId).update({ lifecycleStatus: status });
  await rejectsAtomically(() => classify(request(f, task, result)), AssignmentOperationError, 409, "Stale or closed handover. Review it before classifying work.");
});
test("replacement keeps outgoing classification but resets all participant evidence; cancellation closes it", async () => {
  const { f, task, result } = await prepared(); await classify(request(f, task, result)); const next = await current(f); await confirm(input(f, next));
  const record = await data("handover_task_dispositions", dispositionId(f, task));
  const replaced = await replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(next) });
  assert.deepEqual(replaced.aggregate.confirmations, []); assert.deepEqual(replaced.aggregate.absences, []); assert.deepEqual(replaced.aggregate.exceptions, []);
  assert.deepEqual(await data("handover_task_dispositions", dispositionId(f, task)), record);
  assert.deepEqual(replaced.aggregate.workSnapshot, await work(f));
  await rejectsAtomically(() => classify(request(f, task, next)), AssignmentOperationError, 409, "Stale or closed handover. Review it before classifying work.");
  await cancel({ ...f.input, ...bound(replaced) });
  await rejectsAtomically(() => classify(request(f, task, replaced)), AssignmentOperationError, 409, "Stale or closed handover. Review it before classifying work.");
});
test("ordinary completeShift still rejects unfinished carry work", async () => {
  const { f, task, result } = await prepared(); await classify(request(f, task, result));
  await ref("shifts", f.outgoing).update({ handoverStartedAt: at });
  await rejectsAtomically(() => completeShift({ shiftId: f.outgoing, actorUid: f.actor }), AssignmentOperationError, 409,
    "The shift has unfinished tasks. Complete or resolve these tasks before completing the handover.");
});

function exactConflict(entry, message) {
  assert.equal(entry.status, "rejected"); assert.ok(entry.reason instanceof AssignmentOperationError);
  assert.equal(entry.reason.status, 409); assert.equal(entry.reason.message, message);
}
for (const same of [false, true]) test(`genuine overlapping ${same ? "same decision" : "conflicting managers"} classification`, { timeout: 60000 }, async t => {
  const { f, task, result } = await prepared(); await ref("users", "other-manager").set({ role: "supervisor", status: "active", statusOperation: null, mustChangePassword: false });
  const outcomes = await contend(t, ref("handovers", result.handoverDocumentId),
    () => classify(request(f, task, result)), () => classify(request(f, task, result, same ? {} : { actorUid: "other-manager", disposition: "resolve_before_transfer" })));
  assert.equal(outcomes.filter(entry => entry.status === "fulfilled").length, 1);
  exactConflict(outcomes.find(entry => entry.status === "rejected"), "Stale or closed handover. Review it before classifying work.");
  const next = await current(f); assert.equal(next.aggregate.revision, 2);
  assert.equal((await audits("SHIFT_HANDOVER_WORK_DISPOSITION_CREATED")).length, 1);
  const record = await data("handover_task_dispositions", dispositionId(f, task)); const before = await state();
  assert.equal((await classify(request(f, task, next, { actorUid: record.classifiedBy, disposition: record.disposition }))).status, "ALREADY_CLASSIFIED");
  assert.deepEqual(await state(), before);
});
for (const action of ["return", "complete", "cancel"]) {
  test(`genuine overlapping classification/${action}`, { timeout: 60000 }, async t => {
    const { f, task, result } = await prepared();
    const [lifecycle, classification] = await contend(t, ref("tasks", task.id),
      () => transitionTask({ taskId: task.id, actorUid: f.actor, action, reason }), () => classify(request(f, task, result)), "tasks");
    assert.equal(lifecycle.status, "fulfilled"); assert.equal(classification.status, "fulfilled");
    assert.ok(["CLASSIFIED", "REVIEW_REQUIRED"].includes(classification.value.status));
    const record = await data("handover_task_dispositions", dispositionId(f, task));
    if (classification.value.status === "REVIEW_REQUIRED") assert.equal(record, undefined);
    else {
      assert.ok(record); const next = await current(f);
      assert.equal((await confirm(input(f, next, f.incoming[0]))).status, "REVIEW_REQUIRED");
    }
    assert.deepEqual((await current(f)).aggregate.confirmations, []);
    const readiness = resolveHandoverWorkReadiness(await workInput(f));
    assert.equal(readiness.ready, action !== "return");
    if (action === "return") assert.ok(["unclassified", "stale_disposition"].includes(readiness.blockers[0].reason));
  });
  for (const first of ["classification", "lifecycle"]) test(`${first}-first serialization with ${action}`, async () => {
    const { f, task, result } = await prepared(); const lifecycle = () => transitionTask({ taskId: task.id, actorUid: f.actor, action, reason });
    if (first === "classification") { await classify(request(f, task, result)); await lifecycle();
      const next = await current(f); assert.equal((await classify(request(f, task, next))).status, "REVIEW_REQUIRED");
      assert.ok(await data("handover_task_dispositions", dispositionId(f, task)));
    } else { await lifecycle(); assert.equal((await classify(request(f, task, result))).status, "REVIEW_REQUIRED");
      assert.equal(await data("handover_task_dispositions", dispositionId(f, task)), undefined);
    }
    if (action !== "return") { const binding = await current(f); await rejectsAtomically(() => classify(request(f, task, binding)), AssignmentOperationError, 409, "Terminal tasks cannot receive handover disposition mutations."); }
  });
}
for (const other of ["confirmation", "resolution"]) {
  test(`genuine overlapping classification/${other}`, { timeout: 60000 }, async t => {
    const { f, task, result } = await prepared();
    const operation = () => other === "confirmation" ? confirm(input(f, result, f.incoming[0])) : resolve({ outgoingShiftId: f.outgoing,
      actorUid: f.actor, actorRole: f.role, technicianUid: f.incoming[0], operation: "absence", reason, ...bound(result) });
    const outcomes = await contend(t, ref("handovers", result.handoverDocumentId), () => classify(request(f, task, result)), operation);
    const next = await current(f); assert.equal(next.aggregate.revision, 2);
    if (outcomes[0].status === "fulfilled") {
      assert.equal(outcomes[0].value.status, "CLASSIFIED"); assert.deepEqual(next.aggregate.confirmations, []);
      if (outcomes[1].status === "rejected") exactConflict(outcomes[1], other === "confirmation" ?
        "Stale or closed handover. Review it before confirming." : "Stale or closed handover. Review it before resolving.");
      else { assert.equal(other, "confirmation"); assert.equal(outcomes[1].value.status, "CONFIRMED"); }
    } else {
      assert.equal(other, "resolution"); exactConflict(outcomes[0], "Stale or closed handover. Review it before classifying work.");
      assert.equal(outcomes[1].status, "fulfilled"); assert.equal(next.aggregate.absences.length, 1);
      await classify(request(f, task, next)); const classified = await current(f);
      assert.equal(classified.aggregate.absences[0].recordedRevision, 2); assert.equal(classified.aggregate.absences[0].revision, 3);
    }
  });
  for (const first of ["classification", other]) test(`${first}-first ordering with ${other}`, async () => {
    const { f, task, result } = await prepared();
    const operation = binding => other === "confirmation" ? confirm(input(f, binding, f.incoming[0])) : resolve({ outgoingShiftId: f.outgoing,
      actorUid: f.actor, actorRole: f.role, technicianUid: f.incoming[0], operation: "absence", reason, ...bound(binding) });
    if (first === "classification") {
      await classify(request(f, task, result)); await rejectsAtomically(() => operation(result), AssignmentOperationError, 409,
        other === "confirmation" ? "Stale or closed handover. Review it before confirming." : "Stale or closed handover. Review it before resolving.");
      await operation(await current(f));
    } else {
      await operation(result);
      if (other === "resolution") {
        await rejectsAtomically(() => classify(request(f, task, result)), AssignmentOperationError, 409, "Stale or closed handover. Review it before classifying work.");
        const resolved = await current(f); await classify(request(f, task, resolved)); const next = await current(f);
        assert.equal(next.aggregate.absences[0].recordedAt, resolved.aggregate.absences[0].recordedAt);
        assert.equal(next.aggregate.absences[0].recordedRevision, resolved.aggregate.absences[0].recordedRevision);
      } else { await classify(request(f, task, result)); assert.deepEqual((await current(f)).aggregate.confirmations, []); }
    }
  });
}

// Force both commit orders while the second canonical transaction already owns
// an untouched first SDK read that the winning operation does not mutate.
// Subsequent reads are deferred until release; native
// snapshot consistency/retry remains responsible for the first commit's changes.
async function orderedOverlap(t, firstRead, first, second) {
  const acquired = deferred(), release = deferred(); const original = db.runTransaction;
  const context = new AsyncLocalStorage(); let held = false;
  db.runTransaction = function(callback, options) {
    return original.call(db, async transaction => {
      if (context.getStore() === "second") {
        const get = transaction.get.bind(transaction);
        transaction.get = function(target, ...args) {
          if (!held && target.path === firstRead.path) {
            held = true;
            return get(target, ...args).then(async snapshot => { assert.equal(snapshot.exists, true); acquired.resolve(); await release.promise; return snapshot; });
          }
          return release.promise.then(() => get(target, ...args));
        };
      }
      return callback(transaction);
    }, options);
  };
  const abort = () => { acquired.resolve(); release.resolve(); }; t.signal.addEventListener("abort", abort, { once: true });
  const pending = context.run("second", second); const settled = Promise.allSettled([pending]);
  try { await acquired.promise; const firstResult = await context.run("first", first); release.resolve(); return [firstResult, (await settled)[0]]; }
  finally { release.resolve(); acquired.resolve(); db.runTransaction = original; t.signal.removeEventListener("abort", abort); await settled; }
}
for (const action of ["return", "complete", "cancel"]) for (const first of ["classification", "lifecycle"]) {
  test(`genuine ordered open transactions ${first}-first/${action}`, { timeout: 60000 }, async t => {
    const { f, task, result } = await prepared(); const other = "other-manager";
    await ref("users", other).set({ role: "admin", status: "active", mustChangePassword: false, statusOperation: null });
    const lifecycle = actorUid => transitionTask({ taskId: task.id, actorUid, action, reason });
    const classification = actorUid => classify(request(f, task, result, { actorUid }));
    const [winning, waiting] = first === "classification" ? await orderedOverlap(t, ref("tasks", task.id), () => classification(f.actor), () => lifecycle(other)) :
      await orderedOverlap(t, ref("users", other), () => lifecycle(f.actor), () => classification(other));
    assert.equal(waiting.status, "fulfilled");
    if (first === "classification") {
      assert.equal(winning.status, "CLASSIFIED"); assert.ok(await data("handover_task_dispositions", dispositionId(f, task)));
      assert.equal((await classify(request(f, task, await current(f)))).status, "REVIEW_REQUIRED");
    } else { assert.equal(waiting.value.status, "REVIEW_REQUIRED"); assert.equal(await data("handover_task_dispositions", dispositionId(f, task)), undefined); }
    assert.equal(resolveHandoverWorkReadiness(await workInput(f)).ready, action !== "return");
  });
}
for (const kind of ["confirmation", "resolution"]) for (const first of ["classification", kind]) {
  test(`genuine ordered open transactions ${first}-first/${kind}`, { timeout: 60000 }, async t => {
    const { f, task, result } = await prepared(); const other = "other-manager";
    await ref("users", other).set({ role: "admin", status: "active", mustChangePassword: false, statusOperation: null });
    const classification = actorUid => classify(request(f, task, result, { actorUid }));
    const operation = actorUid => kind === "confirmation" ? confirm(input(f, result, actorUid)) : resolve({ outgoingShiftId: f.outgoing,
      actorUid, actorRole: "admin", operation: "absence", technicianUid: f.incoming[0], reason, ...bound(result) });
    if (first === "classification") {
      const actorUid = kind === "confirmation" ? f.incoming[0] : other;
      const [winning, waiting] = await orderedOverlap(t, ref("users", actorUid), () => classification(f.actor), () => operation(actorUid));
      assert.equal(winning.status, "CLASSIFIED"); exactConflict(waiting, kind === "confirmation" ?
        "Stale or closed handover. Review it before confirming." : "Stale or closed handover. Review it before resolving.");
    } else {
      const actorUid = kind === "confirmation" ? f.incoming[0] : f.actor;
      const [winning, waiting] = await orderedOverlap(t, ref("users", other), () => operation(actorUid), () => classification(other));
      assert.ok(["CONFIRMED", "RESOLVED"].includes(winning.status));
      if (kind === "confirmation") { assert.equal(waiting.status, "fulfilled"); assert.deepEqual((await current(f)).aggregate.confirmations, []); }
      else { exactConflict(waiting, "Stale or closed handover. Review it before classifying work.");
        const resolved = await current(f); await classify(request(f, task, resolved)); const next = await current(f);
        assert.equal(next.aggregate.absences[0].recordedRevision, resolved.aggregate.absences[0].recordedRevision);
        assert.equal(next.aggregate.absences[0].recordedAt, resolved.aggregate.absences[0].recordedAt);
      }
    }
  });
}
