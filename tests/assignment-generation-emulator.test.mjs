import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";

const project = "demo-shiftchange-assignment-generation";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!["127.0.0.1:8088", "localhost:8088"].includes(host) ||
    ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(key => process.env[key] !== project)) {
  throw new Error("Refusing assignment generation tests outside the isolated demo emulator.");
}
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { createTaskAssignment: create } = await import("../src/lib/operations/create-task-assignment.ts");
const { reassignTask: reassign } = await import("../src/lib/operations/reassign-task.ts");
const { respondToTaskAssignment: respond } = await import("../src/lib/operations/respond-to-task-assignment.ts");
const { transitionTask: transition } = await import("../src/lib/operations/task-lifecycle.ts");
const { listTasks: list } = await import("../src/lib/operations/list-tasks.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { getTaskAssignmentInstanceId: instance } = await import("../src/lib/operations/assignment-identity.ts");
const { validateTaskAssignmentHistory } = await import("../src/lib/operations/assignment-generation-domain.ts");
const { requireSafeAccountBlocking } = await import("../src/lib/accounts/account-status-eligibility.ts");
const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);
const at = "2020-01-01T00:00:00.000Z";
const request = (uid = "tech") => ({ taskId: "task", technicianUid: uid, responsibility: "lead", assignedBy: "manager" });
const reassignment = (record, replacement = "tech") => ({ taskId: "task", assignmentId: record.id, originalTechnicianUid: record.technicianId,
  replacementTechnicianUid: replacement, performedBy: "manager", reason: "Reviewed operational replacement" });
function record(uid = "tech", generation = 1, extra = {}) {
  return { id: instance("task", uid, generation), taskId: "task", technicianId: uid, generation, responsibility: "lead", acceptanceStatus: "pending",
    acceptedAt: null, rejectedAt: null, rejectionReason: null, assignedAt: at, responsibilityStatus: "active", releasedAt: null, releasedBy: null, transferredTo: null, ...extra };
}
function history(uid = "tech", generation = 1, extra = {}) {
  return record(uid, generation, { responsibilityStatus: "released", releaseMode: "reassignment", releasedAt: at, releasedBy: "manager",
    transferredTo: uid === "other" ? "tech" : "other", acceptanceStatus: "accepted", acceptedAt: at, ...extra });
}
async function fixture(records = []) {
  const cleared = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(cleared.status, 200);
  const batch = db.batch();
  batch.set(ref("tasks", "task"), { id: "task", status: "open", shiftId: null, title: "Generation work", description: "Review work", priority: "medium", sectionId: null, createdAt: at, updatedAt: at });
  for (const [uid, role] of [["manager", "admin"], ["tech", "technician"], ["other", "technician"], ["third", "technician"]]) {
    batch.set(ref("users", uid), { uid, role, status: "active", statusOperation: null, mustChangePassword: false });
  }
  for (const assignment of records) batch.set(ref("task_assignments", assignment.id), assignment);
  await batch.commit();
}
async function state() {
  const result = {};
  for (const collection of ["tasks", "task_assignments", "task_assignment_history", "audit_logs", "users", "shifts", "shift_members", "shift_attendance", "operational_shift_control", "handovers", "handover_task_dispositions"]) {
    result[collection] = (await db.collection(collection).get()).docs.map(document => ({ id: document.id, data: document.data() })).sort((a, b) => a.id.localeCompare(b.id));
  }
  return result;
}
async function rejectsAtomically(operation, status = 409) {
  const before = await state();
  await assert.rejects(operation, error => { assert.ok(error instanceof AssignmentOperationError); assert.equal(error.status, status); return true; });
  assert.deepEqual(await state(), before);
}
async function assignments() {
  const docs = (await db.collection("task_assignments").where("taskId", "==", "task").get()).docs;
  return validateTaskAssignmentHistory("task", docs.map(document => ({ id: document.id, data: document.data() })));
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function contend(t, first, second) {
  const acquired = deferred(), release = deferred(), both = deferred();
  const original = db.runTransaction, context = new AsyncLocalStorage(), seen = new Set();
  const gate = original.call(db, async transaction => { assert.equal((await transaction.get(ref("tasks", "task"))).exists, true); acquired.resolve(); await release.promise; });
  await acquired.promise;
  db.runTransaction = function(callback, options) {
    const operation = context.getStore();
    return original.call(db, async transaction => {
      const get = transaction.get.bind(transaction);
      transaction.get = function(target, ...args) {
        const pending = get(target, ...args);
        if (target.path === "tasks/task") {
          seen.add(operation); if (seen.size === 2) both.resolve();
          return pending.then(async snapshot => { await release.promise; return snapshot; });
        }
        return pending;
      };
      return callback(transaction);
    }, options);
  };
  const abort = () => { both.resolve(); release.resolve(); }; t.signal.addEventListener("abort", abort, { once: true });
  let settled;
  try {
    settled = Promise.allSettled([context.run("first", first), context.run("second", second)]);
    await both.promise; assert.ok(seen.has("first") && seen.has("second"), "both genuine transactions overlap in task read phases");
    release.resolve(); await gate; return await settled;
  } finally { release.resolve(); db.runTransaction = original; t.signal.removeEventListener("abort", abort); await gate; if (settled) await settled; }
}
function oneWinner(outcomes) {
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find(outcome => outcome.status === "rejected"); assert.ok(rejected.reason instanceof AssignmentOperationError); assert.equal(rejected.reason.status, 409);
}
for (const maximum of [0, 1, 2]) test(`real create uses generation ${maximum + 1} and preserves historical documents`, async () => {
  const old = Array.from({ length: maximum }, (_, i) => history("tech", i + 1)); await fixture(old);
  const created = await create(request()); assert.equal(created.generation, maximum + 1); assert.equal(created.id, instance("task", "tech", maximum + 1));
  assert.equal(created.acceptanceStatus, "pending"); assert.equal(created.acceptedAt, null);
  for (const record of old) assert.deepEqual((await ref("task_assignments", record.id).get()).data(), record);
  await rejectsAtomically(() => create(request()));
  const events = (await db.collection("task_assignment_history").get()).docs.map(document => document.data());
  assert.equal(events[0].assignmentGeneration, maximum + 1); assert.equal(events[0].assignmentId, created.id);
});
for (const generation of [1, 2, 3]) for (const action of ["accept", "reject"]) test(`real generation ${generation} ${action} is isolated and one-shot`, async () => {
  const current = record("tech", generation), old = Array.from({ length: generation - 1 }, (_, i) => history("tech", i + 1)); await fixture([...old, current]);
  const input = { taskId: "task", assignmentId: current.id, technicianUid: "tech", action, rejectionReason: "Unavailable for reviewed work" };
  const outcome = await respond(input); assert.equal(outcome.generation, generation); assert.equal(outcome.acceptanceStatus, action === "accept" ? "accepted" : "rejected");
  for (const record of old) assert.deepEqual((await ref("task_assignments", record.id).get()).data(), record);
  await rejectsAtomically(() => respond(input));
});
test("real generation two reassignment creates replacement generation three and preserves acceptance", async () => {
  const original = record("other", 2, { acceptanceStatus: "accepted", acceptedAt: at }); const old = [history(), history("tech", 2)]; await fixture([...old, original]);
  const outcome = await reassign(reassignment(original)); assert.equal(outcome.replacementAssignment.generation, 3); assert.equal(outcome.replacementAssignment.acceptanceStatus, "pending");
  const released = (await ref("task_assignments", original.id).get()).data(); assert.equal(released.releaseMode, "reassignment"); assert.equal(released.transferredTo, "tech"); assert.equal(released.acceptedAt, at);
  for (const record of old) assert.deepEqual((await ref("task_assignments", record.id).get()).data(), record);
  await rejectsAtomically(() => reassign(reassignment(original)));
});
test("real pending generation cannot start from historical acceptance; new acceptance restores authority", async () => {
  const old = history(), current = record("tech", 2); await fixture([old, current]);
  await rejectsAtomically(() => transition({ taskId: "task", actorUid: "tech", action: "start" }), 403);
  await respond({ taskId: "task", assignmentId: current.id, technicianUid: "tech", action: "accept" });
  assert.equal((await transition({ taskId: "task", actorUid: "tech", action: "start" })).status, "in_progress");
  assert.equal((await transition({ taskId: "task", actorUid: "tech", action: "submit" })).status, "pending_verification");
  assert.deepEqual((await ref("task_assignments", old.id).get()).data(), old);
});
test("real listing and account blocking accept released generation histories without granting current responsibility", async () => {
  await fixture([history(), history("tech", 2, { releaseMode: "handover_transfer", transferredTo: null })]);
  assert.equal((await list({ uid: "tech", role: "technician" })).total, 0);
  assert.equal((await list({ uid: "manager", role: "admin" })).tasks[0].assignments.length, 2);
  await db.runTransaction(transaction => requireSafeAccountBlocking(transaction, "tech"));
});
for (const invalid of [0, "2", null]) test(`real malformed generation ${JSON.stringify(invalid)} blocks all mutation atomically`, async () => {
  const bad = history("tech", 1, { generation: invalid }); await fixture([bad]); await rejectsAtomically(() => create(request()));
});
test("genuine concurrent create after historical release yields only one next generation", { timeout: 60000 }, async t => {
  const old = history(); await fixture([old]); const outcomes = await contend(t, () => create(request()), () => create(request())); oneWinner(outcomes);
  const records = await assignments(); assert.equal(records.length, 2); assert.equal(records.filter(record => record.responsibilityStatus === "active").length, 1);
  assert.equal(records.find(record => record.responsibilityStatus === "active").generation, 2); assert.deepEqual((await ref("task_assignments", old.id).get()).data(), old);
  assert.equal((await db.collection("task_assignment_history").get()).size, 1);
});
test("genuine concurrent reassignment to same historical replacement has one winner", { timeout: 60000 }, async t => {
  const old = history(), first = record("other", 2, { responsibility: "support" }), second = record("third", 1, { responsibility: "support" }); await fixture([old, first, second]);
  const outcomes = await contend(t, () => reassign(reassignment(first)), () => reassign(reassignment(second))); oneWinner(outcomes);
  const records = await assignments(), target = records.filter(record => record.technicianId === "tech"); assert.equal(target.length, 2); assert.equal(target.find(record => record.responsibilityStatus === "active").generation, 2);
  assert.equal(records.filter(record => record.technicianId !== "tech" && record.responsibilityStatus === "released").length, 1);
  assert.deepEqual((await ref("task_assignments", old.id).get()).data(), old); assert.equal((await db.collection("task_assignment_history").get()).size, 1);
});
test("genuine create versus reassignment preserves generation sequence and original evidence", { timeout: 60000 }, async t => {
  const old = history(), original = record("other", 2); await fixture([old, original]);
  const outcomes = await contend(t, () => create(request()), () => reassign(reassignment(original))); oneWinner(outcomes);
  const records = await assignments(), target = records.filter(record => record.technicianId === "tech"); assert.equal(target.length, 2);
  assert.equal(target.find(record => record.responsibilityStatus === "active").generation, 2); assert.deepEqual((await ref("task_assignments", old.id).get()).data(), old);
  const existing = (await ref("task_assignments", original.id).get()).data();
  if (outcomes[0].status === "fulfilled") assert.deepEqual(existing, original); else assert.equal(existing.transferredTo, "tech");
  assert.equal((await db.collection("task_assignment_history").get()).size, 1);
});
