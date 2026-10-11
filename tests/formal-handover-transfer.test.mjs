import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { prepared, modules, rejectsAtomically } from "./formal-handover-transfer-fixtures.mjs";
const normal = value => JSON.parse(JSON.stringify(value));
function type(f, module = "handover-transfer-domain", name = "HandoverTransferError") { return f.load(`lib/operations/${module}`)[name]; }
function refresh(f) {
  const hd = f.load("lib/operations/handover-domain"), ws = f.load("lib/operations/handover-work-snapshot");
  const aggregate = f.records.get("handovers/handover_outgoing");
  aggregate.workSnapshot = ws.createHandoverWorkSnapshot({ outgoingShiftId: "outgoing", tasks: [...f.records].filter(([path]) => path.startsWith("tasks/")).map(([,data]) => data),
    assignments: [...f.records].filter(([path]) => path.startsWith("task_assignments/")).map(([,data]) => data), dispositions: [...f.records].filter(([path]) => path.startsWith("handover_task_dispositions/")).map(([,data]) => data) });
  const confirmations = aggregate.confirmations;
  aggregate.confirmations = [];
  f.input.expectedSnapshotHash = hd.createHandoverSnapshot(aggregate).snapshotHash;
  aggregate.confirmations = confirmations;
  for (const confirmation of aggregate.confirmations) confirmation.snapshotHash = f.input.expectedSnapshotHash;
}
test("full transfer persists one atomic consolidated plan and complete evidence", async () => {
  const f = prepared(), taskBefore = structuredClone(f.tasks[0]), assignmentBefore = structuredClone(f.assignments[0]);
  const result = await f.transfer(f.input); assert.equal(result.status, "TRANSFERRED");
  assert.equal(f.records.get("shifts/outgoing").status, "completed");
  assert.equal(f.records.get("shifts/outgoing").handoverStartedAt, f.shift.handoverStartedAt);
  assert.equal(f.records.get("shifts/incoming").status, "active"); assert.equal(f.records.get("shifts/incoming").previousShiftId, "outgoing");
  for (const uid of f.out) assert.equal(f.records.get(`shift_members/outgoing_${uid}`).leftAt, result.receipt.transferredAt);
  for (const uid of f.incoming) { assert.equal(f.records.get(`shift_members/incoming_${uid}`).role, "primary"); assert.equal(f.records.get(`technician_schedules/${uid}`).entries[0].status, "active"); }
  assert.equal(f.records.get("operational_shift_control/global").generation, 2);
  assert.equal(f.records.get("operational_shift_control/global").slotToken, f.aggregate.identity.successorSlotToken);
  assert.equal(f.records.get("handovers/handover_outgoing").lifecycleStatus, "completed");
  assert.equal(f.records.get("tasks/task-0").shiftId, "incoming"); assert.equal(f.records.get("tasks/task-0").status, "open");
  assert.equal(f.records.get("task_assignments/task-0_out-a").releaseMode, "handover_transfer");
  assert.equal(f.records.get("task_assignments/task-0_out-a").transferredTo, null);
  assert.equal(f.records.get("task_assignments/task-0_out-a").acceptanceStatus, "pending");
  const evidence = f.records.get(`handover_task_transfers/${result.receipt.taskTransferIds[0]}`);
  assert.deepEqual(evidence.taskBeforeTransfer, taskBefore); assert.deepEqual(evidence.assignmentEvidence, [assignmentBefore]);
  assert.equal([...f.records.keys()].filter(path => path.startsWith("task_assignments/")).length, 1);
  const writes = f.calls.filter(([method]) => method !== "read"); assert.equal(new Set(writes.map(([,path]) => path)).size, writes.length);
  assert.equal([...f.records.keys()].filter(path => path.startsWith("audit_logs/")).length, 1);
});
for (const a of ["confirmed", "absent", "exception"]) for (const b of ["confirmed", "absent", "exception"]) test(`service incoming resolution ${a}/${b}`, async () => {
  const f = prepared({ incomingStates: [a, b] });
  if (a !== "confirmed" && b !== "confirmed") await rejectsAtomically(f, () => f.transfer(f.input), type(f), "At least one reserved incoming permanent technician must self-confirm before transfer.");
  else { const result = await f.transfer(f.input); assert.deepEqual(normal(result.receipt.incomingAttendanceTechnicianIds), f.incoming.filter((_,i) => [a,b][i] === "confirmed"));
    assert.equal([...f.records.keys()].filter(path => path.startsWith("shift_members/incoming_")).length, 2);
    assert.equal([...f.records.keys()].filter(path => path.startsWith("shift_attendance/incoming_")).length, [a,b].filter(v => v === "confirmed").length); }
});
for (const c of ["joined", "unjoined"]) test(`outgoing consumed C ${c} completes without incoming C`, async () => {
  const f = prepared({ c }); await f.transfer(f.input);
  assert.equal([...f.records].find(([path]) => path.startsWith("next_shift_authorizations/"))[1].status, "completed");
  assert.equal(f.records.has("shift_members/incoming_c"), false); assert.equal(f.records.has("shift_attendance/incoming_c"), false);
  if (c === "joined") { assert.ok(f.records.get("shift_members/outgoing_c").leftAt); assert.equal(f.records.get("technician_schedules/c").entries.length, 0); }
});
test("completed replay has zero writes and survives subsequent task/control state", async () => {
  const f = prepared(), first = await f.transfer(f.input), before = structuredClone([...f.records]); f.calls.length = 0;
  const replay = await f.transfer(f.input); assert.equal(replay.status, "ALREADY_TRANSFERRED"); assert.deepEqual(normal(replay.receipt), normal(first.receipt));
  assert.deepEqual([...f.records], before); assert.ok(f.calls.every(([method]) => method === "read"));
  f.records.get("tasks/task-0").status = "completed"; f.records.get("operational_shift_control/global").generation = 6;
  assert.equal((await f.transfer(f.input)).status, "ALREADY_TRANSFERRED");
});
for (const corruption of ["missing", "revision", "control", "attendance", "extra", "time", "history references", "released references", "actor"]) test(`corrupt completed receipt ${corruption} fails atomically`, async () => {
  const f = prepared(), first = await f.transfer(f.input), path = `audit_logs/${first.receipt.id}`, receipt = f.records.get(path);
  if (corruption === "missing") f.records.delete(path);
  if (corruption === "revision") receipt.finalRevision++;
  if (corruption === "control") receipt.operationalControlAfter.generation++;
  if (corruption === "attendance") receipt.incomingAttendanceTechnicianIds = [];
  if (corruption === "extra") receipt.extra = true;
  if (corruption === "time") receipt.transferredAt = f.at;
  if (corruption === "history references") receipt.taskTransferIds = [];
  if (corruption === "released references") receipt.releasedAssignmentIds = [];
  if (corruption === "actor") receipt.actorUid = "another-manager";
  await rejectsAtomically(f, () => f.transfer(f.input), type(f));
});
test("genuine work drift commits reconciliation only and clears confirmations", async () => {
  const f = prepared({ incomingStates: ["confirmed", "absent"] }); f.records.get("tasks/task-0").description = "Changed content";
  const outcome = await f.transfer(f.input); assert.equal(outcome.status, "REVIEW_REQUIRED");
  assert.equal(outcome.handover.revision, f.aggregate.revision + 1); assert.equal(f.records.get("handovers/handover_outgoing").confirmations.length, 0);
  assert.equal(f.records.get("handovers/handover_outgoing").absences[0].revision, outcome.handover.revision);
  assert.deepEqual(normal(f.records.get("operational_shift_control/global")), normal(f.control)); assert.equal(f.records.has("shifts/incoming"), false);
  assert.equal(f.records.get("task_assignments/task-0_out-a").responsibilityStatus, "active");
  assert.deepEqual(f.calls.filter(([method]) => method !== "read").map(([,path]) => path.split("/")[0]), ["handovers", "audit_logs"]);
});
test("legacy snapshot reconciles before transfer", async () => { const f = prepared({ legacy: true }); assert.equal((await f.transfer(f.input)).status, "REVIEW_REQUIRED"); });
test("resolve-before-transfer blocks unchanged reviewed work", async () => {
  const f = prepared({ disposition: "resolve_before_transfer" }); await rejectsAtomically(f, () => f.transfer(f.input), type(f, "handover-domain", "HandoverDomainError"), "Unfinished handover work is not ready for transfer.");
});
for (const scenario of ["unclassified", "stale"]) test(`${scenario} work blocks after current snapshot review`, async () => {
  const f = prepared(); if (scenario === "unclassified") { for (const path of f.records.keys()) if (path.startsWith("handover_task_dispositions/")) f.records.delete(path); }
  else f.records.get("tasks/task-0").description = "stale content";
  refresh(f); await rejectsAtomically(f, () => f.transfer(f.input), type(f, "handover-domain", "HandoverDomainError"));
});
for (const status of ["completed", "cancelled"]) test(`terminal ${status} work remains outgoing untouched`, async () => {
  const f = prepared({ taskStatus: status }); const before = structuredClone(f.records.get("tasks/task-0"));
  await f.transfer(f.input); assert.deepEqual(f.records.get("tasks/task-0"), before); assert.equal(f.records.get("task_assignments/task-0_out-a").responsibilityStatus, "active");
});
for (const corruption of ["acceptance", "release", "generation"]) test(`terminal ${corruption} history corruption fails closed`, async () => {
  const f = prepared({ taskStatus: "completed" }), assignment = f.records.get("task_assignments/task-0_out-a");
  if (corruption === "acceptance") assignment.acceptanceStatus = "bad";
  if (corruption === "release") assignment.releaseMode = "handover_transfer";
  if (corruption === "generation") assignment.generation = 0;
  await rejectsAtomically(f, () => f.transfer(f.input), corruption === "acceptance" ? type(f) : type(f, "assignment-transaction", "AssignmentOperationError"));
});
for (const scenario of ["actor role", "actor blocked", "password", "cleanup", "permanent blocked", "absent blocked", "pair", "membership", "schedule", "incoming Shift", "incoming member", "incoming attendance", "control", "handover time", "stale revision", "stale hash", "history collision", "receipt collision", "unsupported C", "incomplete"]) test(`atomic rejection ${scenario}`, async () => {
  const f = prepared({ incomingStates: scenario === "absent blocked" ? ["confirmed", "absent"] : scenario === "incomplete" ? ["confirmed", "awaiting"] : ["confirmed", "confirmed"] });
  let ErrorType = type(f), status = 409;
  if (scenario === "actor role") f.records.get("users/manager").role = "technician";
  if (scenario === "actor blocked") f.records.get("users/manager").status = "blocked";
  if (scenario === "password") f.records.get("users/manager").mustChangePassword = true;
  if (scenario === "cleanup") f.records.get("users/manager").statusOperation = {};
  if (["actor role", "actor blocked", "password", "cleanup"].includes(scenario)) { ErrorType = type(f, "assignment-transaction", "AssignmentOperationError"); status = 403; }
  if (scenario === "permanent blocked" || scenario === "absent blocked") f.records.get("users/in-b").status = "blocked";
  if (scenario === "pair") { f.records.get("technician_pairs/in-pair").status = "inactive"; ErrorType = type(f, "next-shift-authorization-domain", "NextShiftAuthorizationDomainError"); }
  if (scenario === "membership") f.records.get("technician_pair_memberships/in-a").pairId = "wrong";
  if (scenario === "schedule") f.records.get("technician_schedules/in-a").entries[0].status = "active";
  if (scenario === "incoming Shift") f.records.set("shifts/incoming", {});
  if (scenario === "incoming member") f.records.set("shift_members/incoming_in-a", { shiftId: "wrong" });
  if (scenario === "incoming attendance") f.records.set("shift_attendance/incoming_in-a", { shiftId: "wrong" });
  if (scenario === "control") f.records.get("operational_shift_control/global").generation++;
  if (scenario === "handover time") f.records.get("shifts/outgoing").handoverStartedAt = null;
  if (scenario === "stale revision") f.input.expectedRevision++;
  if (scenario === "stale hash") f.input.expectedSnapshotHash = "0".repeat(64);
  if (scenario === "history collision") f.records.set(`handover_task_transfers/${f.load("lib/operations/handover-transfer-domain").createHandoverTaskTransferDocumentId("handover_outgoing", "task-0")}`, { immutable: true });
  if (scenario === "receipt collision") f.records.set(`audit_logs/${f.load("lib/operations/handover-transfer-domain").createFormalHandoverTransferReceiptId("handover_outgoing")}`, {});
  if (scenario === "unsupported C") f.records.set("next_shift_authorizations/unsupported", { shiftId: "incoming" });
  if (scenario === "incomplete") ErrorType = type(f, "handover-domain", "HandoverDomainError");
  await rejectsAtomically(f, () => f.transfer(f.input), ErrorType, undefined, status);
});
test("service capacity rejects oversized full evidence without truncation or writes", async () => {
  const f = prepared(); f.records.get("tasks/task-0").extraEvidence = "界".repeat(270000);
  await rejectsAtomically(f, () => f.transfer(f.input), type(f), undefined, 409, "TRANSFER_CAPACITY_EXCEEDED"); assert.equal(f.records.get("tasks/task-0").extraEvidence.length, 270000);
});
test("ordinary completion rejects collecting formal handover atomically", async () => {
  const f = prepared({ count: 0 }); await rejectsAtomically(f, () => f.load("lib/operations/complete-shift").completeShift({ shiftId: "outgoing", actorUid: "manager" }), type(f, "assignment-transaction", "AssignmentOperationError"), "Complete the collecting formal handover through the atomic transfer boundary.");
});

test("generation history, acceptance states and ordinal full-evidence ordering survive transfer", async () => {
  const f = prepared();
  const ids = f.load("lib/operations/assignment-identity");
  const taskId = "task-0", base = f.records.get("task_assignments/task-0_out-a");
  base.responsibilityStatus = "released"; base.releaseMode = "reassignment"; base.releasedAt = f.at;
  base.releasedBy = "manager"; base.transferredTo = "out-b";
  const originalReleased = structuredClone(base);
  for (const [uid, generation, acceptanceStatus, responsibility] of [["out-a", 2, "accepted", "lead"], ["out-b", 1, "rejected", "support"], ["c", 3, "pending", "support"]]) {
    const id = ids.getTaskAssignmentInstanceId(taskId, uid, generation);
    f.records.set(`task_assignments/${id}`, { ...base, id, technicianId: uid, generation, responsibility, responsibilityStatus: "active",
      acceptanceStatus, acceptedAt: acceptanceStatus === "accepted" ? f.at : null, rejectedAt: acceptanceStatus === "rejected" ? f.at : null,
      rejectionReason: acceptanceStatus === "rejected" ? "Unavailable" : null, releasedAt: null, releasedBy: null, transferredTo: null });
    delete f.records.get(`task_assignments/${id}`).releaseMode;
  }
  refresh(f);
  // Refreshing work does not make the old disposition current: explicitly
  // reclassify the fixture against the independently recomputed task hash.
  const taskWorkHash = f.load("lib/operations/handover-work-snapshot").createHandoverTaskWorkHash({ outgoingShiftId: "outgoing", tasks: [f.records.get("tasks/task-0")],
    assignments: [...f.records].filter(([path]) => path.startsWith("task_assignments/")).map(([,record]) => record), taskId });
  [...f.records].find(([path]) => path.startsWith("handover_task_dispositions/"))[1].classifiedTaskWorkHash = taskWorkHash;
  refresh(f);
  const result = await f.transfer(f.input), history = f.records.get(`handover_task_transfers/${result.receipt.taskTransferIds[0]}`);
  assert.deepEqual(history.assignmentEvidence.map(a => a.id), history.assignmentEvidence.map(a => a.id).sort());
  assert.equal(history.assignmentEvidence.length, 4); assert.equal(history.releasedAssignmentIds.length, 3);
  assert.deepEqual(f.records.get("task_assignments/task-0_out-a"), originalReleased);
  for (const id of history.releasedAssignmentIds) { const after = f.records.get(`task_assignments/${id}`), before = history.assignmentEvidence.find(a => a.id === id);
    assert.equal(after.acceptanceStatus, before.acceptanceStatus); assert.equal(after.generation, before.generation); assert.equal(after.releaseMode, "handover_transfer"); }
});
test("aggregate capacity rejects full payload even when individual histories fit", async () => {
  const f = prepared({ count: 16 }); for (const [path, record] of f.records) if (path.startsWith("tasks/")) record.extraEvidence = "x".repeat(220000);
  await rejectsAtomically(f, () => f.transfer(f.input), type(f), undefined, 409, "TRANSFER_CAPACITY_EXCEEDED");
});

function routeFixture(injection, actor = { uid: "manager", role: "admin", mustChangePassword: false }) {
  const load = modules(); const calls = [];
  const source = readFileSync(new URL("../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/transfer/route.ts", import.meta.url), "utf8");
  const exports = {};
  const injected = typeof injection === "function" ? injection(load) : injection;
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, process: { env: {} }, console: { error() {} }, require(name) {
      if (name === "server-only") return {};
      if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, ...options }) } };
      if (name === "@/lib/auth/session") return { getCurrentUser: async () => actor };
      if (name === "@/lib/operations/formal-handover-transfer") return { parseFormalHandoverTransferRequest: load("lib/operations/formal-handover-transfer").parseFormalHandoverTransferRequest,
        persistFormalHandoverTransfer: async input => { calls.push(input); if (injected instanceof Error || injected?.name?.endsWith("Error")) throw injected; return injected ?? { status: "TRANSFERRED", receipt: {} }; } };
      if (name.startsWith("@/")) return load(name.slice(2)); throw new Error(name);
    } });
  const request = (body = { expectedRevision: 1, expectedSnapshotHash: "a".repeat(64) }, origin = "https://app.example") => ({
    nextUrl: { origin: "https://app.example" }, headers: { get: () => origin }, json: async () => { if (body instanceof Error) throw body; return body; } });
  return { post: (body, origin) => exports.POST(request(body, origin), { params: Promise.resolve({ shiftId: "outgoing" }) }), calls, load };
}
for (const [module, name, status] of [["assignment-transaction", "AssignmentOperationError", 403], ["handover-domain", "HandoverDomainError", 409], ["next-shift-authorization-domain", "NextShiftAuthorizationDomainError", 409], ["shift-completion-domain", "ShiftCompletionDomainError", 409], ["handover-transfer-domain", "HandoverTransferError", 409]]) test(`route maps independent ${name} to ${status}`, async () => {
  const f = routeFixture(load => new (load(`lib/operations/${module}`)[name])("independent fixture error", status));
  const response = await f.post(); assert.equal(response.status, status); assert.equal(response.body.error, "independent fixture error");
});
test("route capacity error preserves machine-readable conflict code", async () => {
  const f = routeFixture(load => new (load("lib/operations/handover-transfer-domain").HandoverTransferError)("Capacity", 409, "TRANSFER_CAPACITY_EXCEEDED"));
  const response = await f.post(); assert.equal(response.status, 409); assert.equal(response.body.code, "TRANSFER_CAPACITY_EXCEEDED");
});
test("route authentication, authorization, origin, parser and no-store", async () => {
  assert.equal((await routeFixture(undefined, null).post()).status, 401);
  assert.equal((await routeFixture(undefined, { uid: "tech", role: "technician", mustChangePassword: false }).post()).status, 403);
  assert.equal((await routeFixture().post(undefined, "https://other")).status, 403);
  assert.equal((await routeFixture().post(new Error("bad json"))).status, 400);
  assert.equal((await routeFixture().post({ expectedRevision: 1, expectedSnapshotHash: "a".repeat(64), incomingShiftId: "chosen" })).status, 400);
  const f = routeFixture(), response = await f.post(); assert.equal(response.status, 200); assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(normal(f.calls[0]), { outgoingShiftId: "outgoing", actorUid: "manager", actorRole: "admin", expectedRevision: 1, expectedSnapshotHash: "a".repeat(64) });
  assert.equal((await routeFixture({ status: "REVIEW_REQUIRED", handover: { revision: 2 } }).post()).status, 409);
});
