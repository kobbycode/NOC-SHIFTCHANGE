import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const project = "demo-shiftchange-handover-confirmation";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !["127.0.0.1:8088", "localhost:8088"].includes(host) ||
    ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]
      .some((key) => process.env[key] !== project)) throw new Error("Refusing to run outside the isolated local demo emulator.");
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { initializeFormalHandover: initialize, replaceFormalHandoverReservation: replace,
  cancelFormalHandoverReservation: cancel } = await import("../src/lib/operations/formal-handover.ts");
const { persistFormalHandoverConfirmation: confirm } = await import("../src/lib/operations/formal-handover-confirmation.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { NextShiftAuthorizationDomainError } = await import("../src/lib/operations/next-shift-authorization-domain.ts");
const { HandoverDomainError, createHandoverSnapshot, assertHandoverAggregate, reviseHandoverSnapshot, recordHandoverAbsence, recordHandoverException } =
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
for (const [side, index, position] of [["out", 0, "outgoing_primary_a"], ["out", 1, "outgoing_primary_b"],
  ["incoming", 0, "incoming_primary_a"], ["incoming", 1, "incoming_primary_b"]]) {
  test(`${position} persists self-derived confirmation with exactly aggregate/audit writes`, async () => {
    const { f, result } = await prepared(); const before = await forbiddenState();
    const outcome = await confirm(input(f, result, f[side][index]));
    assert.equal(outcome.status, "CONFIRMED"); assert.equal(outcome.confirmation.position, position);
    assert.equal(outcome.confirmation.technicianUid, f[side][index]); assert.equal(outcome.confirmation.revision, 1);
    assert.equal(outcome.confirmation.snapshotHash, result.snapshotHash);
    assert.deepEqual(await forbiddenState(), before); await noTransfer(f, result.aggregate);
    const aggregate = assertHandoverAggregate(await data("handovers", result.handoverDocumentId));
    assert.equal(aggregate.confirmations.length, 1); assert.equal(createHandoverSnapshot(aggregate).snapshotHash, result.snapshotHash);
    const events = await audits("SHIFT_HANDOVER_TECHNICIAN_CONFIRMED"); assert.equal(events.length, 1);
    const audit = events[0]; assert.equal(audit.actorUid, f[side][index]); assert.equal(audit.technicianUid, audit.actorUid);
    assert.equal(audit.position, position); assert.equal(audit.side, side === "out" ? "outgoing" : "incoming");
    assert.equal(audit.confirmedAt, outcome.confirmation.confirmedAt); assert.ok(audit.createdAt.toDate());
    assert.doesNotMatch(JSON.stringify(audit), /password|refreshToken|idToken|sessionCookie/);
  });
}
test("valid duplicate has zero writes and preserves original timestamp/audit", async () => {
  const { f, result } = await prepared(); const first = await confirm(input(f, result));
  const before = await state(); const snapshot = await ref("handovers", result.handoverDocumentId).get();
  const again = await confirm(input(f, result)); assert.equal(again.status, "ALREADY_CONFIRMED");
  assert.deepEqual(again.confirmation, first.confirmation); assert.deepEqual(await state(), before);
  assert.equal(compareUpdateTimes(snapshot.updateTime, (await ref("handovers", result.handoverDocumentId).get()).updateTime), 0);
});
for (const kind of ["nonparticipant", "temporary C"]) test(`${kind} cannot sign`, async () => {
  const { f, result } = await prepared(); const uid = "outsider";
  await ref("users", uid).set({ role: "technician", status: "active", mustChangePassword: false, statusOperation: null });
  await ref("technician_schedules", uid).set({ technicianUid: uid, entries: kind === "temporary C" ? [{
    shiftId: f.outgoing, status: "handover_pending", scheduledStart: f.shift.scheduledStart, scheduledEnd: f.shift.scheduledEnd,
  }] : [], updatedAt: at });
  if (kind === "temporary C") await ref("shift_members", "additional-c").set({ id: "additional-c", shiftId: f.outgoing,
    technicianId: uid, role: "additional", joinedAt: at, leftAt: null });
  await rejectsAtomically(() => confirm(input(f, result, uid)), AssignmentOperationError, 403,
    "Only a permanent handover participant can confirm for self.");
});
test("additional membership cannot impersonate an incoming permanent signer", async () => {
  const { f, result } = await prepared();
  await ref("shift_members", "conflicting-additional").set({ id: "conflicting-additional", shiftId: f.outgoing,
    technicianId: f.incoming[0], role: "additional", joinedAt: at, leftAt: null });
  await rejectsAtomically(() => confirm(input(f, result, f.incoming[0])), AssignmentOperationError, 403,
    "An additional technician cannot occupy a permanent handover signer position.");
});
test("legitimate additional C remains untouched while permanent participant confirms", async () => {
  const { f, result } = await prepared();
  await ref("shift_members", "additional-c").set({ id: "additional-c", shiftId: f.outgoing,
    technicianId: "temporary-c", role: "additional", joinedAt: at, leftAt: null });
  const before = await forbiddenState();
  assert.equal((await confirm(input(f, result))).status, "CONFIRMED");
  assert.deepEqual(await forbiddenState(), before); await noTransfer(f, result.aggregate);
});
const corruptions = [
  ["missing actor", ({ f }) => ref("users", f.out[0]).delete(), 403],
  ...["admin", "supervisor"].map((role) => [`actor role ${role}`, ({ f }) => ref("users", f.out[0]).update({ role }), 403]),
  ...["blocked", "inactive", "revoked"].map((status) => [`actor ${status}`, ({ f }) => ref("users", f.out[0]).update({ status }), 403]),
  ["actor password change", ({ f }) => ref("users", f.out[0]).update({ mustChangePassword: true }), 403],
  ["actor pending operation", ({ f }) => ref("users", f.out[0]).update({ statusOperation: { id: "pending" } }), 403],
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
  ["outgoing primary as additional", ({ f }) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).update({ role: "additional" }), 403],
  ["bad member identity", ({ f }) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).update({ id: "other" }), 409],
  ["bad joinedAt", ({ f }) => ref("shift_members", `${f.outgoing}_${f.out[0]}`).update({ joinedAt: "bad" }), 409],
  ["incoming already materialized", ({ result }) => ref("shifts", result.aggregate.identity.incomingShiftId).set({ id: "unexpected" }), 409],
  ["malformed task", ({ task }) => ref("tasks", task.id).update({ title: "" }), 409],
  ["wrong task document identity", ({ task }) => ref("tasks", task.id).update({ id: "other" }), 409],
  ["wrong assignment identity", ({ assignment }) => ref("task_assignments", assignment.id).update({ id: "other" }), 409],
];
function corruptionContract(name) {
  const messages = {
    "missing actor": "The selected technician account was not found.",
    "actor password change": "This technician must complete their initial password change before receiving assignments.",
    "actor pending operation": "An account-management operation is in progress for this technician.",
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
  if (name.startsWith("closed ")) return [AssignmentOperationError, "Stale or closed handover. Review it before confirming."];
  if (name.startsWith("actor role ")) return [AssignmentOperationError, "Only technician accounts can receive technician assignments."];
  if (["actor blocked", "actor inactive", "actor revoked"].includes(name)) return [AssignmentOperationError, "This technician account is not active."];
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
  await rejectsAtomically(() => confirm(input(context.f, context.result)), ErrorType, status, message);
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
      malformed: [400, "Invalid confirmation identifier."],
      overlap: [409, "This technician is already assigned to another shift during the selected time period."],
      "active conflict": [409, "This technician has an active shift or an unfinished handover."],
    };
    await rejectsAtomically(() => confirm(input(f, result)), AssignmentOperationError, ...contracts[kind]);
  });
}
for (const override of [{ expectedRevision: 2 }, { expectedSnapshotHash: "0".repeat(64) }]) test(`stale client binding ${JSON.stringify(override)} makes no writes`, async () => {
  const { f, task, result } = await prepared(); await ref("tasks", task.id).update({ description: "Drift" });
  await rejectsAtomically(() => confirm({ ...input(f, result), ...override }), AssignmentOperationError, 409,
    "Stale or closed handover. Review it before confirming.");
});
for (const kind of ["absence", "exception"]) test(`existing ${kind} blocks unchanged-work confirmation`, async () => {
  const { f, result } = await prepared();
  const context = { revision: 1, snapshotHash: result.snapshotHash, recordedAt: new Date().toISOString(),
    technicianUid: f.out[0], actor: { uid: f.actor, authority: "manager" }, reason: "Synthetic supervisor resolution" };
  const aggregate = kind === "absence" ? recordHandoverAbsence(result.aggregate, context) :
    recordHandoverException(result.aggregate, { ...context, category: "unavailable" });
  await ref("handovers", result.handoverDocumentId).set(aggregate);
  const binding = { aggregate, snapshotHash: createHandoverSnapshot(aggregate).snapshotHash };
  await rejectsAtomically(() => confirm(input(f, binding)), HandoverDomainError, 409, "Conflicting participant resolution.");
});
test("work revision commits, clears all confirmations, preserves temporary C, and requires explicit retry", async () => {
  const { f, task, result } = await prepared();
  let aggregate = reviseHandoverSnapshot(result.aggregate, { revision: 1, snapshotHash: result.snapshotHash,
    recordedAt: new Date().toISOString(), workSnapshot: result.aggregate.workSnapshot,
    temporaryAuthorization: { authorizationId: "future-c", technicianUid: "temporary-c" } });
  await ref("handovers", result.handoverDocumentId).set(aggregate);
  let binding = { aggregate, snapshotHash: createHandoverSnapshot(aggregate).snapshotHash };
  await confirm(input(f, binding, f.out[0])); await confirm(input(f, binding, f.incoming[0]));
  await transitionTask({ taskId: task.id, actorUid: f.actor, action: "return", reason: "Manager changes reviewed work" });
  const before = await forbiddenState();
  const outcome = await confirm(input(f, binding, f.out[1])); assert.equal(outcome.status, "REVIEW_REQUIRED");
  assert.equal(outcome.handover.revision, 3); assert.notEqual(outcome.handover.snapshotHash, binding.snapshotHash);
  aggregate = assertHandoverAggregate(await data("handovers", result.handoverDocumentId));
  assert.deepEqual(aggregate.confirmations, []); assert.deepEqual(aggregate.temporaryAuthorization, binding.aggregate.temporaryAuthorization);
  assert.deepEqual(aggregate.workSnapshot, await work(f)); assert.deepEqual(await forbiddenState(), before);
  assert.equal((await audits("SHIFT_HANDOVER_TECHNICIAN_CONFIRMED")).length, 2);
  const revisions = await audits("SHIFT_HANDOVER_SNAPSHOT_REVISED"); assert.equal(revisions.length, 1);
  assert.equal(revisions[0].previousRevision, 2); assert.equal(revisions[0].newRevision, 3);
  assert.equal(revisions[0].newSnapshotHash, outcome.handover.snapshotHash);
  assert.doesNotMatch(JSON.stringify(revisions), /password|refreshToken|idToken/);
  await rejectsAtomically(() => confirm(input(f, binding, f.out[1])), AssignmentOperationError, 409,
    "Stale or closed handover. Review it before confirming.");
  binding = { aggregate, snapshotHash: outcome.handover.snapshotHash };
  assert.equal((await confirm(input(f, binding, f.out[1]))).status, "CONFIRMED");
  await noTransfer(f, aggregate);
});
test("terminal task assignment identity still validated through shared reader", async () => {
  const { f, result } = await prepared(); const terminal = await seedTask(f, "completed", "terminal-task");
  const assignment = await seedAssignment(f, terminal); await ref("task_assignments", assignment.id).update({ id: "forged" });
  await rejectsAtomically(() => confirm(input(f, result)), AssignmentOperationError, 409, "Inconsistent authoritative assignment identity.");
});
for (const same of [true, false]) test(`genuine overlapping ${same ? "same" : "different"} technician confirmations`, { timeout: 60000 }, async (t) => {
  const { f, result } = await prepared(); const before = await forbiddenState();
  const outcomes = await contend(t, ref("handovers", result.handoverDocumentId),
    () => confirm(input(f, result)), () => confirm(input(f, result, same ? f.out[0] : f.incoming[0])));
  assert.ok(outcomes.every((entry) => entry.status === "fulfilled"));
  const aggregate = assertHandoverAggregate(await data("handovers", result.handoverDocumentId));
  assert.equal(aggregate.confirmations.length, same ? 1 : 2); assert.equal(aggregate.revision, 1);
  assert.equal(createHandoverSnapshot(aggregate).snapshotHash, result.snapshotHash);
  assert.equal((await audits("SHIFT_HANDOVER_TECHNICIAN_CONFIRMED")).length, same ? 1 : 2);
  if (same) assert.deepEqual(outcomes.map((entry) => entry.value.status).sort(), ["ALREADY_CONFIRMED", "CONFIRMED"]);
  assert.deepEqual(await forbiddenState(), before); await noTransfer(f, aggregate);
});
for (const action of ["return", "complete", "cancel"]) {
  test(`genuine lifecycle/confirmation contention: ${action}`, { timeout: 60000 }, async (t) => {
    const { f, task, result } = await prepared();
    const [lifecycle, confirmation] = await contend(t, ref("tasks", task.id),
      () => transitionTask({ taskId: task.id, actorUid: f.actor, action, reason: "Concurrent manager resolution" }),
      () => confirm(input(f, result)), "tasks");
    assert.equal(lifecycle.status, "fulfilled"); assert.equal(confirmation.status, "fulfilled");
    const taskSnapshot = await ref("tasks", task.id).get(); const handoverSnapshot = await ref("handovers", result.handoverDocumentId).get();
    const aggregate = assertHandoverAggregate(handoverSnapshot.data());
    const order = compareUpdateTimes(taskSnapshot.updateTime, handoverSnapshot.updateTime); assert.notEqual(order, 0);
    if (order < 0) {
      assert.equal(confirmation.value.status, "REVIEW_REQUIRED"); assert.deepEqual(aggregate.confirmations, []);
      assert.deepEqual(aggregate.workSnapshot, await work(f)); assert.equal(aggregate.revision, 2);
    } else {
      assert.equal(confirmation.value.status, "CONFIRMED"); assert.deepEqual(aggregate.workSnapshot, result.aggregate.workSnapshot);
      const next = await confirm(input(f, result, f.out[1])); assert.equal(next.status, "REVIEW_REQUIRED");
      assert.deepEqual((await data("handovers", result.handoverDocumentId)).confirmations, []);
    }
    t.diagnostic(`${action}: ${order < 0 ? "lifecycle first, revised without confirmation" : "confirmation first, next mutation revises"}; genuine overlapping SDK reads`);
  });
  for (const first of ["lifecycle", "confirmation"]) test(`${first}-first serialization: ${action}`, async () => {
    const { f, task, result } = await prepared();
    const lifecycle = () => transitionTask({ taskId: task.id, actorUid: f.actor, action, reason: "Ordered manager resolution" });
    if (first === "lifecycle") {
      await lifecycle(); const outcome = await confirm(input(f, result)); assert.equal(outcome.status, "REVIEW_REQUIRED");
      assert.deepEqual((await data("handovers", result.handoverDocumentId)).confirmations, []);
    } else {
      assert.equal((await confirm(input(f, result))).status, "CONFIRMED"); await lifecycle();
      assert.equal((await data("handovers", result.handoverDocumentId)).confirmations.length, 1);
      assert.equal((await confirm(input(f, result, f.out[1]))).status, "REVIEW_REQUIRED");
      assert.deepEqual((await data("handovers", result.handoverDocumentId)).confirmations, []);
    }
  });
}
test("replacement invalidates prior confirmation identity without weakening A7.5", async () => {
  const { f, result } = await prepared(); await confirm(input(f, result));
  const replaced = await replace({ ...f.input, incomingPermanentPairId: f.newPair, ...bound(result) });
  assert.notEqual(replaced.aggregate.identity.incomingShiftId, result.aggregate.identity.incomingShiftId);
  assert.notEqual(replaced.aggregate.identity.successorSlotToken, result.aggregate.identity.successorSlotToken);
  assert.deepEqual(replaced.aggregate.confirmations, []);
  await rejectsAtomically(() => confirm(input(f, result)), AssignmentOperationError, 409,
    "Stale or closed handover. Review it before confirming.");
  assert.equal((await confirm(input(f, replaced, f.replacement[0]))).status, "CONFIRMED");
  await cancel({ ...f.input, ...bound(replaced) });
  await rejectsAtomically(() => confirm(input(f, replaced)), AssignmentOperationError, 409,
    "Stale or closed handover. Review it before confirming.");
});

for (const action of ["return", "complete", "cancel"]) {
  test(`genuine lifecycle-first overlap with an already-reading confirmation: ${action}`, { timeout: 60000 }, async (t) => {
    const { f, task, result } = await prepared();
    const acquired = deferred(), release = deferred();
    const original = db.runTransaction;
    const operationContext = new AsyncLocalStorage();
    let held = false, confirmationAttempts = 0;
    db.runTransaction = function(callback, options) {
      const operation = operationContext.getStore();
      return original.call(db, async (transaction) => {
        if (operation === "confirmation") {
          confirmationAttempts++;
          const get = transaction.get.bind(transaction);
          transaction.get = function(target, ...args) {
            const read = get(target, ...args);
            if (!held && target.path === ref("users", f.incoming[0]).path) {
              held = true;
              return read.then(async (snapshot) => {
                // The confirmation has started REAL authoritative reads and
                // retains their untouched snapshots while the manager commits.
                // Use an incoming actor: lifecycle writes cannot require this
                // actor's profile lock. Native SDK snapshot consistency/retries
                // remain responsible for observing the changed task content.
                assert.equal(snapshot.exists, true);
                acquired.resolve(); await release.promise; return snapshot;
              });
            }
            return read;
          };
        }
        return callback(transaction);
      }, options);
    };
    const abort = () => { acquired.resolve(); release.resolve(); };
    t.signal.addEventListener("abort", abort, { once: true });
    const pending = operationContext.run("confirmation", () => confirm(input(f, result, f.incoming[0])));
    const settled = Promise.allSettled([pending]);
    let lifecycleSnapshot;
    try {
      await acquired.promise;
      await operationContext.run("lifecycle", () => transitionTask({ taskId: task.id, actorUid: f.actor,
        action, reason: "Manager commits during the open confirmation transaction" }));
      lifecycleSnapshot = await ref("tasks", task.id).get();
      release.resolve();
      const [entry] = await settled;
      assert.equal(entry.status, "fulfilled"); assert.equal(entry.value.status, "REVIEW_REQUIRED");
      const handoverSnapshot = await ref("handovers", result.handoverDocumentId).get();
      const aggregate = assertHandoverAggregate(handoverSnapshot.data());
      assert.ok(compareUpdateTimes(lifecycleSnapshot.updateTime, handoverSnapshot.updateTime) < 0);
      assert.equal(aggregate.revision, 2); assert.deepEqual(aggregate.confirmations, []);
      assert.deepEqual(aggregate.workSnapshot, await work(f));
      assert.equal((await audits("SHIFT_HANDOVER_SNAPSHOT_REVISED")).length, 1);
      assert.equal((await audits("SHIFT_HANDOVER_TECHNICIAN_CONFIRMED")).length, 0);
      t.diagnostic(`${action}: lifecycle committed during the open authoritative confirmation read; ${confirmationAttempts} native SDK attempts`);
    } finally {
      release.resolve(); acquired.resolve(); db.runTransaction = original;
      t.signal.removeEventListener("abort", abort); await settled;
    }
  });
}
