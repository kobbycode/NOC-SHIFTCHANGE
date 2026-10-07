import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function modules(overrides = {}) {
  const cache = {};
  function load(path) {
    if (Object.hasOwn(overrides, path)) return overrides[path];
    if (cache[path]) return cache[path];
    const exports = {}; cache[path] = exports;
    const source = readFileSync(new URL(`../src/${path}.ts`, import.meta.url), "utf8");
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, structuredClone, TextEncoder, Date, require(name) {
        if (name === "server-only") return {};
        if (name === "node:crypto") return { createHash };
        if (name === "firebase-admin/firestore") return { FieldValue: { serverTimestamp: () => "server-time" } };
        if (name.startsWith("@/")) return load(name.slice(2));
        if (name.startsWith("./")) return load(path.slice(0, path.lastIndexOf("/") + 1) + name.slice(2));
        throw new Error(`Unexpected dependency ${name}`);
      } });
    return exports;
  }
  return load;
}
const load = modules(), identity = load("lib/operations/assignment-identity"), domain = load("lib/operations/assignment-generation-domain");
const at = "2020-01-01T00:00:00.000Z";
const later = "2020-01-01T00:01:00.000Z";
function assignment(generation = 1, change = {}) {
  return { id: identity.getTaskAssignmentInstanceId("task", "tech", generation), taskId: "task", technicianId: "tech", generation,
    responsibility: "lead", acceptanceStatus: "pending", acceptedAt: null, rejectedAt: null, rejectionReason: null,
    assignedAt: at, responsibilityStatus: "active", releasedAt: null, releasedBy: null, transferredTo: null, ...change };
}
function released(generation = 1, change = {}) {
  return assignment(generation, { responsibilityStatus: "released", releaseMode: "reassignment", releasedAt: at,
    releasedBy: "manager", transferredTo: "other", ...change });
}
const history = records => domain.validateTaskAssignmentHistory("task", records.map(data => ({ id: data.id, data })));
function corrupt(operation) { assert.throws(operation, error => error instanceof domain.AssignmentGenerationError); }
test("legacy missing generation resolves to one with unchanged ID", () => {
  const old = assignment(); delete old.generation;
  assert.equal(identity.resolveTaskAssignmentGeneration(undefined), 1);
  assert.equal(history([old])[0].generation, undefined);
  assert.equal(identity.getTaskAssignmentInstanceId("task", "tech", 1), identity.getTaskAssignmentId("task", "tech"));
});
for (const generation of [1, 2, 3, Number.MAX_SAFE_INTEGER]) test(`valid generation ${generation} remains detached`, () => {
  const original = assignment(generation); const result = history([original]); result[0].responsibility = "support";
  assert.equal(original.responsibility, "lead"); assert.equal(result[0].generation, generation);
});
for (const generation of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null, undefined]) test(`reject explicit invalid generation ${String(generation)}`, () => {
  corrupt(() => history([assignment(1, { generation })]));
});
for (const scope of [["a_b", "c"], ["a", "b_c"], ["task_2", "tech"], ["task", "tech_2"], ["assignment", "generation-2"], ["界_🌍", "t_é"]]) {
  test(`generated identity independently binds ${JSON.stringify(scope)}`, () => {
    const expected = "assignment-" + createHash("sha256").update(JSON.stringify(["shiftchange-task-assignment-instance-v1", ...scope, 2]), "utf8").digest("hex");
    const id = identity.getTaskAssignmentInstanceId(...scope, 2); assert.equal(id, expected);
    assert.equal(id, identity.getTaskAssignmentInstanceId(...scope, 2)); assert.equal(id.includes("_"), false);
    assert.notEqual(id, identity.getTaskAssignmentInstanceId(...scope, 1)); assert.notEqual(id, identity.getTaskAssignmentInstanceId(...scope, 3));
  });
}
test("underscore and generation suffix adversaries cannot collide in generated namespace", () => {
  const scopes = [["a_b", "c"], ["a", "b_c"], ["a", "b_c_2"], ["a_b_c", "2"]];
  assert.equal(new Set(scopes.flatMap(scope => [2, 3].map(g => identity.getTaskAssignmentInstanceId(...scope, g)))).size, 8);
});
for (const change of [{ id: "wrong" }, { taskId: "other" }, { technicianId: "other" }, { technicianId: "bad/id" }, { generation: 2 }]) test(`identity rejects ${JSON.stringify(change)}`, () => corrupt(() => history([assignment(1, change)])));
test("physical document identity mismatch fails", () => corrupt(() => domain.validateTaskAssignmentHistory("task", [{ id: "wrong", data: assignment() }])));
test("duplicate generation fails", () => corrupt(() => history([released(), released()])));
test("duplicate active pair across generations fails", () => corrupt(() => history([assignment(), assignment(2)])));
for (const maximum of [1, 2, 3]) test(`next generation derives maximum ${maximum} from unordered history`, () => {
  const records = Array.from({ length: maximum }, (_, i) => released(i + 1)).reverse();
  assert.equal(domain.nextTaskAssignmentGeneration(history(records), "tech"), maximum + 1);
});
test("empty history starts at one; active history and overflow fail", () => {
  assert.equal(domain.nextTaskAssignmentGeneration([], "tech"), 1);
  corrupt(() => domain.nextTaskAssignmentGeneration(history([assignment()]), "tech"));
  corrupt(() => domain.nextTaskAssignmentGeneration(history([released(Number.MAX_SAFE_INTEGER)]), "tech"));
});
for (const mode of [undefined, "reassignment", "handover_transfer"]) test(`valid release ${mode ?? "legacy"}`, () => {
  const record = released(); if (mode === undefined) delete record.releaseMode; else record.releaseMode = mode;
  if (mode === "handover_transfer") record.transferredTo = null;
  assert.equal(history([record])[0].responsibilityStatus, "released");
});
for (const change of [{ transferredTo: null }, { transferredTo: "tech" }, { releaseMode: "future" }, { releaseMode: null },
  { releaseMode: "handover_transfer", transferredTo: "other" }, { releasedAt: null }, { releasedBy: null }]) {
  test(`released metadata rejected ${JSON.stringify(change)}`, () => corrupt(() => history([released(1, change)])));
}
for (const change of [{ releaseMode: "reassignment" }, { releaseMode: "handover_transfer" }, { releaseMode: null }, { releasedAt: at },
  { releasedBy: "manager" }, { transferredTo: "other" }]) test(`active release metadata rejected ${JSON.stringify(change)}`, () => corrupt(() => history([assignment(1, change)])));
for (const acceptanceStatus of ["pending", "accepted", "rejected"]) test(`handover release patch preserves ${acceptanceStatus} evidence and generation`, () => {
  const original = assignment(2, { acceptanceStatus, acceptedAt: acceptanceStatus === "accepted" ? at : null,
    rejectedAt: acceptanceStatus === "rejected" ? at : null, rejectionReason: acceptanceStatus === "rejected" ? "Unavailable" : null });
  const before = structuredClone(original); const patch = domain.createHandoverAssignmentRelease(original, later, "manager");
  assert.deepEqual(original, before);
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), { responsibilityStatus: "released", releaseMode: "handover_transfer", releasedAt: later, releasedBy: "manager", transferredTo: null });
  const result = history([{ ...original, ...patch }])[0];
  for (const key of ["id", "taskId", "technicianId", "generation", "responsibility", "assignedAt", "acceptanceStatus", "acceptedAt", "rejectedAt", "rejectionReason"]) assert.equal(result[key], original[key]);
});
test("foundation rejects already released and invalid authoritative operation evidence", () => {
  corrupt(() => domain.createHandoverAssignmentRelease(released(), later, "manager"));
  corrupt(() => domain.createHandoverAssignmentRelease(assignment(), "invalid", "manager"));
  corrupt(() => domain.createHandoverAssignmentRelease(assignment(), later, ""));
});

function store() {
  const records = new Map(), calls = [];
  let sequence = 0;
  const doc = (collection, id = `event-${++sequence}`) => ({ id, path: `${collection}/${id}`, get: async () => snapshot(`${collection}/${id}`) });
  const snapshot = path => ({ id: path.slice(path.indexOf("/") + 1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  const query = (collection, filters = []) => ({ collection, filters, where: (field, op, value) => query(collection, [...filters, [field, op, value]]),
    get: async () => ({ docs: [...records.keys()].filter(path => path.startsWith(collection + "/") && filters.every(([field, , value]) => records.get(path)[field] === value)).map(snapshot) }) });
  const collection = name => ({ ...query(name), doc: id => doc(name, id) });
  const db = { collection, runTransaction: async callback => {
    let wrote = false; const writes = [];
    const tx = { get: async target => { assert.equal(wrote, false, "all helper reads precede writes"); calls.push(["read", target.path ?? target.collection]); return target.path ? snapshot(target.path) : target.get(); } };
    for (const method of ["create", "update", "set", "delete"]) tx[method] = (target, value) => { wrote = true; writes.push([method, target.path, value]); };
    const result = await callback(tx);
    for (const [method, path, value] of writes) {
      if (method === "create") assert.equal(records.has(path), false, "historical documents never overwritten");
      if (method === "delete") records.delete(path); else records.set(path, structuredClone(method === "update" ? { ...records.get(path), ...value } : value));
      calls.push([method, path]);
    }
    return result;
  } };
  const mapping = { tasks: "tasks", shifts: "shifts", taskAssignments: "task_assignments", taskAssignmentHistory: "task_assignment_history", shiftMembers: "shift_members", technicianSchedules: "technician_schedules", handoverTaskDispositions: "handover_task_dispositions", handovers: "handovers" };
  const load = modules({ "lib/firebase/admin": { getAdminFirestore: () => db }, "lib/operations/collections": { getOperationalCollections: () => Object.fromEntries(Object.entries(mapping).map(([key, name]) => [key, collection(name)])) } });
  const create = load("lib/operations/create-task-assignment").createTaskAssignment;
  const reassign = load("lib/operations/reassign-task").reassignTask;
  const respond = load("lib/operations/respond-to-task-assignment").respondToTaskAssignment;
  const transition = load("lib/operations/task-lifecycle").transitionTask;
  const list = load("lib/operations/list-tasks").listTasks;
  const ErrorType = load("lib/operations/assignment-transaction").AssignmentOperationError;
  records.set("tasks/task", { id: "task", status: "open", shiftId: null, createdAt: at });
  for (const [uid, role] of [["manager", "admin"], ["tech", "technician"], ["other", "technician"]]) records.set(`users/${uid}`, { uid, role, status: "active", statusOperation: null, mustChangePassword: false });
  const reader = load("lib/operations/formal-handover").readAuthoritativeHandoverWorkState;
  const readWork = () => db.runTransaction(tx => reader(tx, "outgoing"));
  return { records, calls, create, reassign, respond, transition, list, ErrorType, readWork };
}
const createRequest = (technicianUid = "tech") => ({ taskId: "task", technicianUid, responsibility: "lead", assignedBy: "manager" });
const response = (record, action = "accept") => ({ taskId: "task", assignmentId: record.id, technicianUid: "tech", action, rejectionReason: "Unavailable for this task" });
const reassignRequest = (record, replacementTechnicianUid = "other") => ({ taskId: "task", assignmentId: record.id, originalTechnicianUid: "tech", replacementTechnicianUid, performedBy: "manager", reason: "Reviewed operational replacement" });
async function rejectsAtomically(f, operation, status = 409) {
  const before = structuredClone([...f.records]);
  await assert.rejects(operation, error => { assert.ok(error instanceof f.ErrorType); assert.equal(error.status, status); return true; });
  assert.deepEqual([...f.records], before);
}
test("first create is generation one and active duplicate rejected atomically", async () => {
  const f = store(), created = await f.create(createRequest()); assert.equal(created.generation, 1); assert.equal(created.id, "task_tech");
  await rejectsAtomically(f, () => f.create(createRequest()));
});
for (const acceptanceStatus of ["accepted", "rejected", "pending"]) test(`released ${acceptanceStatus} history permits fresh generations two and three`, async () => {
  const f = store(), old = released(1, { acceptanceStatus, acceptedAt: acceptanceStatus === "accepted" ? at : null,
    rejectedAt: acceptanceStatus === "rejected" ? at : null, rejectionReason: acceptanceStatus === "rejected" ? "Unavailable" : null });
  f.records.set(`task_assignments/${old.id}`, old);
  const second = await f.create(createRequest()); assert.equal(second.generation, 2); assert.equal(second.acceptanceStatus, "pending");
  for (const key of ["acceptedAt", "rejectedAt", "rejectionReason", "releasedAt", "releasedBy", "transferredTo"]) assert.equal(second[key], null);
  assert.equal(Object.hasOwn(second, "releaseMode"), false); assert.deepEqual(f.records.get(`task_assignments/${old.id}`), old);
  await f.reassign(reassignRequest(second)); const releasedSecond = structuredClone(f.records.get(`task_assignments/${second.id}`));
  const third = await f.create(createRequest()); assert.equal(third.generation, 3); assert.equal(third.acceptanceStatus, "pending");
  assert.equal(new Set([old.id, second.id, third.id]).size, 3); assert.deepEqual(f.records.get(`task_assignments/${second.id}`), releasedSecond);
});
for (const generation of [1, 2, 3]) for (const action of ["accept", "reject"]) test(`generation ${generation} can ${action} exactly once`, async () => {
  const f = store(), record = assignment(generation); f.records.set(`task_assignments/${record.id}`, record);
  const result = await f.respond(response(record, action)); assert.equal(result.generation, generation); assert.equal(result.acceptanceStatus, action === "accept" ? "accepted" : "rejected");
  await rejectsAtomically(f, () => f.respond(response(record, action)));
});
for (const scenario of ["released", "handover released", "wrong technician", "wrong task", "wrong instance", "malformed generation"]) test(`response rejects ${scenario} atomically`, async () => {
  const f = store(); let record = assignment(2), input = response(record), status = 409;
  if (scenario === "released") record = released(2);
  if (scenario === "handover released") record = released(2, { releaseMode: "handover_transfer", transferredTo: null });
  if (scenario === "wrong technician") input.technicianUid = "other";
  if (scenario === "wrong task") input.taskId = "other-task";
  if (scenario === "wrong instance") { input.assignmentId = "missing"; status = 404; }
  if (scenario === "malformed generation") record.generation = 0;
  f.records.set(`task_assignments/${record.id}`, record); await rejectsAtomically(f, () => f.respond(input), status);
});
test("reassign exact generation two to historical replacement produces pending generation three", async () => {
  const f = store(), original = assignment(2, { acceptanceStatus: "accepted", acceptedAt: at });
  f.records.set(`task_assignments/${original.id}`, original);
  for (const generation of [1, 2]) { const old = released(generation, { technicianId: "other", id: identity.getTaskAssignmentInstanceId("task", "other", generation), transferredTo: "tech" }); f.records.set(`task_assignments/${old.id}`, old); }
  const before = structuredClone([...f.records].filter(([path]) => path.includes("task_assignments/task_other") || path.includes(identity.getTaskAssignmentInstanceId("task", "other", 2))));
  const outcome = await f.reassign(reassignRequest(original)); assert.equal(outcome.previousAssignmentId, original.id);
  assert.equal(outcome.replacementAssignment.generation, 3); assert.equal(outcome.replacementAssignment.acceptanceStatus, "pending");
  const old = f.records.get(`task_assignments/${original.id}`); assert.equal(old.releaseMode, "reassignment"); assert.equal(old.transferredTo, "other"); assert.equal(old.acceptedAt, at);
  for (const [path, record] of before) assert.deepEqual(f.records.get(path), record);
});
for (const scenario of ["active replacement", "released original", "wrong instance", "same technician"]) test(`reassign ${scenario} rejected atomically`, async () => {
  const f = store(), record = scenario === "released original" ? released(2) : assignment(2); f.records.set(`task_assignments/${record.id}`, record);
  const input = reassignRequest(record); let status = 409;
  if (scenario === "active replacement") { const other = assignment(1, { technicianId: "other", id: "task_other" }); f.records.set(`task_assignments/${other.id}`, other); }
  if (scenario === "wrong instance") { input.assignmentId = "missing"; status = 404; }
  if (scenario === "same technician") { input.replacementTechnicianUid = "tech"; status = 400; }
  await rejectsAtomically(f, () => f.reassign(input), status);
});
for (const accepted of [false, true]) test(`historical accepted generation does not authorize active ${accepted ? "accepted" : "pending"} generation`, async () => {
  const f = store(), old = released(1, { acceptanceStatus: "accepted", acceptedAt: at }), current = assignment(2, accepted ? { acceptanceStatus: "accepted", acceptedAt: at } : {});
  f.records.set(`task_assignments/${old.id}`, old); f.records.set(`task_assignments/${current.id}`, current);
  const input = { taskId: "task", actorUid: "tech", action: "start" };
  if (!accepted) await rejectsAtomically(f, () => f.transition(input), 403);
  else { assert.equal((await f.transition(input)).status, "in_progress"); assert.equal((await f.transition({ ...input, action: "submit" })).status, "pending_verification"); }
});
for (const mode of [undefined, "reassignment", "handover_transfer"]) test(`lifecycle and listing recognize ${mode ?? "legacy"} history and preserve all manager generations`, async () => {
  const f = store(), old = released(1, { acceptanceStatus: "accepted", acceptedAt: at }); if (mode === undefined) delete old.releaseMode; else old.releaseMode = mode;
  if (mode === "handover_transfer") old.transferredTo = null;
  f.records.set(`task_assignments/${old.id}`, old);
  assert.equal((await f.list({ uid: "tech", role: "technician" })).total, 0);
  const current = assignment(2, { acceptanceStatus: "accepted", acceptedAt: at }); f.records.set(`task_assignments/${current.id}`, current);
  assert.equal((await f.list({ uid: "tech", role: "technician" })).tasks[0].assignments.length, 1);
  assert.equal((await f.list({ uid: "manager", role: "admin" })).tasks[0].assignments.length, 2);
  assert.equal((await f.transition({ taskId: "task", actorUid: "tech", action: "start" })).status, "in_progress");
});
for (const scenario of ["duplicate active pair", "duplicate lead", "malformed release"]) test(`lifecycle ${scenario} fails closed`, async () => {
  const f = store(), current = assignment(2, { acceptanceStatus: "accepted", acceptedAt: at }); f.records.set(`task_assignments/${current.id}`, current);
  const other = scenario === "duplicate lead" ? assignment(1, { technicianId: "other", id: "task_other" }) : scenario === "duplicate active pair" ? assignment(1) : released(1, { transferredTo: null });
  f.records.set(`task_assignments/${other.id}`, other); await rejectsAtomically(f, () => f.transition({ taskId: "task", actorUid: "tech", action: "start" }));
});
for (const change of [{ status: "blocked" }, { statusOperation: { id: "pending" } }, { mustChangePassword: true }, { role: "viewer" }]) {
  test(`generation two preserves account safeguard ${JSON.stringify(change)}`, async () => {
    const f = store(), old = released(); f.records.set(`task_assignments/${old.id}`, old); f.records.set("users/tech", { ...f.records.get("users/tech"), ...change });
    await rejectsAtomically(f, () => f.create(createRequest()));
  });
}
for (const status of ["handover_pending", "completed"]) test(`generation two ordinary create/reassign still blocked in ${status}`, async () => {
  const f = store(), old = released(); f.records.set(`task_assignments/${old.id}`, old); f.records.get("tasks/task").shiftId = "shift";
  f.records.set("shifts/shift", { status }); await rejectsAtomically(f, () => f.create(createRequest()));
  f.records.set(`task_assignments/${old.id}`, assignment()); await rejectsAtomically(f, () => f.reassign(reassignRequest(assignment())));
});
test("blocked original technician recovery remains allowed", async () => {
  const f = store(), original = assignment(2); f.records.set(`task_assignments/${original.id}`, original); f.records.get("users/tech").status = "blocked";
  assert.equal((await f.reassign(reassignRequest(original))).replacementAssignment.acceptanceStatus, "pending");
});
test("legacy cross-pair underscore document collision fails atomically without overwrite", async () => {
  const f = store();
  const existingId = identity.getTaskAssignmentId("a_b", "c");
  const requestedId = identity.getTaskAssignmentId("a", "b_c");
  assert.equal(existingId, "a_b_c"); assert.equal(requestedId, "a_b_c"); assert.equal(existingId, requestedId);
  const existing = { id: "a_b_c", taskId: "a_b", technicianId: "c", responsibility: "lead", assignedAt: at,
    acceptanceStatus: "pending", acceptedAt: null, rejectedAt: null, rejectionReason: null,
    responsibilityStatus: "active", releasedAt: null, releasedBy: null, transferredTo: null };
  const requested = { ...existing, taskId: "a", technicianId: "b_c" };
  assert.equal(domain.validateTaskAssignmentHistory("a_b", [{ id: existingId, data: existing }]).length, 1);
  assert.equal(domain.validateTaskAssignmentHistory("a", [{ id: requestedId, data: requested }]).length, 1);
  for (const id of ["a_b", "a"]) f.records.set(`tasks/${id}`, { id, status: "open", shiftId: null, createdAt: at });
  for (const uid of ["c", "b_c"]) f.records.set(`users/${uid}`, { uid, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  f.records.set("task_assignments/a_b_c", existing);
  const before = structuredClone([...f.records]);
  await assert.rejects(() => f.create({ taskId: "a", technicianUid: "b_c", responsibility: "lead", assignedBy: "manager" }), error => {
    assert.ok(error instanceof f.ErrorType); assert.equal(error.status, 409);
    assert.equal(error.message, "Assignment instance identity is already occupied; administrator review required."); return true;
  });
  assert.deepEqual([...f.records], before);
  assert.equal([...f.records.values()].some(record => record.taskId === "a" && record.technicianId === "b_c"), false);
  assert.equal(f.calls.some(([method]) => method !== "read"), false);
});

const work = load("lib/operations/handover-work-snapshot");
const dispositions = load("lib/operations/handover-work-disposition-domain");
const workTask = { id: "task", shiftId: "outgoing", title: "Inspect pump", description: "Pending work", status: "open", priority: "medium", sectionId: null, updatedAt: at };
const workInput = record => ({ outgoingShiftId: "outgoing", tasks: [workTask], assignments: [record], dispositions: [] });
for (const status of ["completed", "cancelled"]) test(`authoritative ${status} assignment rejects malformed release evidence`, async () => {
  const f = store(); f.records.set("tasks/task", { ...workTask, status });
  const record = { id: "task_tech", taskId: "task", technicianId: "tech", responsibility: "lead", assignedAt: at,
    acceptanceStatus: "pending", acceptedAt: null, rejectedAt: null, rejectionReason: null,
    responsibilityStatus: "released", releaseMode: "handover_transfer", releasedAt: null, releasedBy: null, transferredTo: "other" };
  domain.assertAssignmentGenerationIdentity("task_tech", record, "task");
  f.records.set("task_assignments/task_tech", record); const before = structuredClone([...f.records]);
  await assert.rejects(() => f.readWork(), error => {
    assert.ok(error instanceof f.ErrorType); assert.equal(error.status, 409);
    assert.equal(error.message, "Inconsistent authoritative assignment release evidence."); return true;
  });
  assert.deepEqual([...f.records], before); assert.equal(f.calls.some(([method]) => method !== "read"), false);
});
test("authoritative valid terminal histories remain excluded from frozen v2 work digest", async () => {
  const f = store();
  for (const [id, status] of [["completed-task", "completed"], ["cancelled-task", "cancelled"]]) {
    f.records.set(`tasks/${id}`, { ...workTask, id, status });
    f.records.set(`task_assignments/${id}_tech`, { id: `${id}_tech`, taskId: id, technicianId: "tech", responsibility: "lead", assignedAt: at,
      acceptanceStatus: "pending", acceptedAt: null, rejectedAt: null, rejectionReason: null,
      responsibilityStatus: "released", releaseMode: "handover_transfer", releasedAt: at, releasedBy: "manager", transferredTo: null });
  }
  const before = structuredClone([...f.records]); const state = await f.readWork();
  assert.equal(state.tasks.length, 2); assert.equal(state.assignments.length, 2);
  const snapshot = work.createHandoverWorkSnapshot(state);
  assert.equal(snapshot.schema, "handover-work-v2");
  assert.equal(snapshot.version, "a767b97c3214a9ad244f4c794e3330eb5755d39650f262da373c3264bc6534e7");
  assert.deepEqual([...f.records], before); assert.equal(f.calls.some(([method]) => method !== "read"), false);
});

test("explicit generation one and reassignment mode preserve the historical v2 digest", () => {
  const legacy = assignment(); delete legacy.generation;
  assert.equal(work.createHandoverWorkSnapshot(workInput(legacy)).version, work.createHandoverWorkSnapshot(workInput(assignment())).version);
  const oldRelease = released(); delete oldRelease.generation; delete oldRelease.releaseMode;
  assert.equal(work.createHandoverWorkSnapshot(workInput(oldRelease)).version, work.createHandoverWorkSnapshot(workInput(released())).version);
  assert.equal(work.createHandoverWorkSnapshot(workInput(legacy)).schema, "handover-work-v2");
});
for (const change of ["generation", "response", "reassignment", "handover release"]) test(`${change} changes v2 task-work evidence and leaves classification stale`, () => {
  const original = assignment(); const input = workInput(original);
  const hash = work.createHandoverTaskWorkHash({ ...input, taskId: "task" });
  const scope = { outgoingShiftId: "outgoing", handoverDocumentId: "handover_outgoing", taskId: "task" };
  const evidence = { ...scope, id: dispositions.createHandoverWorkDispositionDocumentId(scope), schema: "handover-task-disposition-v1", disposition: "carry_forward",
    classifiedBy: "manager", classifierRole: "admin", classifiedAt: at, reason: "Reviewed operational work", recordedRevision: 1, reviewedSnapshotHash: "a".repeat(64), classifiedTaskWorkHash: hash };
  const next = change === "generation" ? assignment(2) : change === "response" ? assignment(1, { acceptanceStatus: "accepted", acceptedAt: later }) :
    change === "reassignment" ? released() : { ...original, ...domain.createHandoverAssignmentRelease(original, later, "manager") };
  const value = { ...workInput(next), dispositions: [evidence] }; const before = structuredClone(evidence);
  assert.notEqual(work.createHandoverTaskWorkHash({ ...value, taskId: "task" }), hash);
  assert.notEqual(work.createHandoverWorkSnapshot(value).version, work.createHandoverWorkSnapshot({ ...input, dispositions: [evidence] }).version);
  assert.equal(work.resolveHandoverWorkReadiness(value).blockers[0].reason, "stale_disposition"); assert.deepEqual(evidence, before);
});
test("explicit generated snapshot identity corruption fails closed", () => {
  assert.throws(() => work.createHandoverWorkSnapshot(workInput(assignment(2, { id: "wrong" }))));
});

for (const role of ["primary", "additional"]) test(`fresh generation preserves ${role} shift membership and schedule eligibility`, async () => {
  const f = store(), old = released(); f.records.set(`task_assignments/${old.id}`, old); f.records.get("tasks/task").shiftId = "shift";
  f.records.set("shifts/shift", { id: "shift", status: "active", primaryTechnicianIds: role === "primary" ? ["tech", "other"] : ["a", "b"], scheduledStart: at, scheduledEnd: later });
  f.records.set("shift_members/member", { shiftId: "shift", technicianId: "tech", role, leftAt: null });
  f.records.set("technician_schedules/tech", { technicianUid: "tech", entries: [{ shiftId: "shift", status: "active", scheduledStart: at, scheduledEnd: later }] });
  assert.equal((await f.create(createRequest())).generation, 2);
});
for (const action of ["return", "complete", "cancel"]) test(`ordinary manager ${action} remains valid with generated assignment history`, async () => {
  const f = store(); f.records.get("tasks/task").status = "pending_verification";
  f.records.set("task_assignments/task_tech", released()); const current = assignment(2); f.records.set(`task_assignments/${current.id}`, current);
  assert.equal((await f.transition({ taskId: "task", actorUid: "manager", action, reason: "Reviewed operational resolution" })).status,
    action === "return" ? "in_progress" : action === "complete" ? "completed" : "cancelled");
});
function reassignRoute(f) {
  const source = readFileSync(new URL("../src/app/(dashboard)/api/operations/tasks/[taskId]/assignments/[assignmentId]/reassign/route.ts", import.meta.url), "utf8");
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, console: { error: () => {} }, require(name) {
      if (name === "server-only") return {};
      if (name === "next/server") return { NextResponse: { json: (body, init) => ({ body, status: init.status }) } };
      if (name.endsWith("/session")) return { getCurrentUser: async () => ({ uid: "manager", role: "admin", mustChangePassword: false }) };
      if (name.endsWith("/assignment-transaction")) return { AssignmentOperationError: f.ErrorType };
      if (name.endsWith("/reassign-task")) return { reassignTask: f.reassign };
      throw new Error(`Unexpected route dependency ${name}`);
    } });
  return (id, original = "tech") => exports.POST({ json: async () => ({ originalTechnicianUid: original, replacementTechnicianUid: "other", reason: "Reviewed operational replacement" }) },
    { params: Promise.resolve({ taskId: "task", assignmentId: id }) });
}
test("reassign route preserves generation two path ID into authoritative service", async () => {
  const f = store(), current = assignment(2); f.records.set(`task_assignments/${current.id}`, current);
  const response = await reassignRoute(f)(current.id); assert.equal(response.status, 200); assert.equal(response.body.previousAssignmentId, current.id);
});
test("reassign route owner mismatch reaches authoritative owner validation with three distinct technicians", async () => {
  const f = store(), current = assignment(2);
  assert.equal(new Set(["tech", "third", "other"]).size, 3);
  f.records.set("users/third", { uid: "third", role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  f.records.set(`task_assignments/${current.id}`, current); f.records.set("task_assignments/task_tech", released());
  assert.equal(current.id, identity.getTaskAssignmentInstanceId("task", "tech", 2));
  const before = structuredClone([...f.records]);
  await assert.rejects(() => f.reassign({ taskId: "task", assignmentId: current.id, originalTechnicianUid: "third",
    replacementTechnicianUid: "other", performedBy: "manager", reason: "Reviewed operational replacement" }), error => {
    assert.ok(error instanceof f.ErrorType); assert.equal(error.status, 409);
    assert.equal(error.message, "The original assignment requires administrator review."); return true;
  });
  const result = await reassignRoute(f)(current.id, "third");
  assert.equal(result.status, 409); assert.equal(result.body.error, "The original assignment requires administrator review.");
  assert.deepEqual([...f.records], before); assert.equal(f.records.has("task_assignments/task_other"), false);
  assert.equal(f.calls.some(([method]) => method !== "read"), false);
});
test("reassign route rejects released historical instance independently", async () => {
  const f = store(); f.records.set("task_assignments/task_tech", released());
  const before = structuredClone([...f.records]);
  assert.equal((await reassignRoute(f)("task_tech")).status, 409); assert.deepEqual([...f.records], before);
});

for (const active of [false, true]) test(`assignment form ${active ? "blocks current responsibility" : "permits released generation history"} in option and submit`, async () => {
  const source = readFileSync(new URL("../src/components/tasks/task-assignment-form.tsx", import.meta.url), "utf8");
  const exports = {}, submitted = [];
  let stateIndex = 0;
  const element = (type, props) => ({ type, props });
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require(name) {
      if (name === "react/jsx-runtime") return { jsx: element, jsxs: element, Fragment: "fragment" };
      if (name === "react") return { useEffect: () => {}, useRef: () => ({ current: false }),
        useState: initial => { const index = stateIndex++; return [index === 0 ? [{ uid: "tech", fullName: "Technician" }] : index === 1 ? "tech" : index === 3 ? false : initial, () => {}]; } };
      if (name === "lucide-react") return {};
      if (name.endsWith("/task-api")) return { assignOperationalTask: async (...args) => submitted.push(args), getEligibleTechnicians: async () => ({}), TaskApiError: class extends Error {} };
      throw new Error(`Unexpected form dependency ${name}`);
    } });
  const tree = exports.TaskAssignmentForm({ item: { task: { id: "task", status: "open" }, assignments: [active ? assignment(2) : released()] }, onAssignmentCreated: async () => {} });
  function elements(value) {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!value || typeof value !== "object") return [];
    return [value, ...elements(value.props?.children)];
  }
  const nodes = elements(tree); const option = nodes.find(node => node.type === "option" && node.props.value === "tech");
  assert.equal(option.props.disabled, active);
  await nodes.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(submitted.length, active ? 0 : 1);
});
