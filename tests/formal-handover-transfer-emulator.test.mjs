import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { fixtureRecords, modules } from "./formal-handover-transfer-fixtures.mjs";
const project = "demo-shiftchange-handover-transfer", host = process.env.FIRESTORE_EMULATOR_HOST;
if (!["127.0.0.1:8088", "localhost:8088"].includes(host) ||
    ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(key => process.env[key] !== project)) {
  throw new Error("Refusing to run outside the isolated local transfer emulator.");
}
const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { persistFormalHandoverTransfer: transfer } = await import("../src/lib/operations/formal-handover-transfer.ts");
const { HandoverTransferError, createFormalHandoverTransferReceiptId, createHandoverTaskTransferDocumentId } = await import("../src/lib/operations/handover-transfer-domain.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const { HandoverDomainError, createHandoverSnapshot, confirmHandoverParticipant } = await import("../src/lib/operations/handover-domain.ts");
const { completeShift } = await import("../src/lib/operations/complete-shift.ts");
const { transitionTask } = await import("../src/lib/operations/task-lifecycle.ts");
const { createHandoverWorkSnapshot } = await import("../src/lib/operations/handover-work-snapshot.ts");
const db = getAdminFirestore(), ref = path => db.doc(path), data = async path => (await ref(path).get()).data();
const collections = ["users", "technician_pairs", "technician_pair_memberships", "shifts", "shift_members", "shift_attendance",
  "technician_schedules", "operational_shift_control", "handovers", "tasks", "task_assignments", "handover_task_dispositions",
  "handover_task_transfers", "next_shift_authorizations", "audit_logs"];
async function fixture(options) {
  const cleared = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(cleared.status, 200);
  const f = structuredClone(fixtureRecords(modules(), options));
  let batch = db.batch(), count = 0;
  for (const [path, value] of f.records) {
    batch.set(ref(path), value); count++;
    if (count === 300) { await batch.commit(); batch = db.batch(); count = 0; }
  }
  if (count) await batch.commit();
  return f;
}
async function state() {
  const result = {};
  for (const name of collections) result[name] = (await db.collection(name).get()).docs.map(doc => [doc.id, doc.data()]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return result;
}
async function rejectsAtomically(operation, ErrorType, message, code) {
  const before = await state();
  await assert.rejects(operation, error => { assert.ok(error instanceof ErrorType, `${error.constructor.name}: ${error.message}`);
    assert.equal(error.status, 409); if (message) assert.equal(error.message, message); if (code) assert.equal(error.code, code);
    for (const sibling of [AssignmentOperationError, HandoverDomainError, HandoverTransferError]) if (sibling !== ErrorType) assert.equal(error instanceof sibling, false);
    return true; });
  assert.deepEqual(await state(), before);
}
async function verify(f, result) {
  assert.equal(result.status, "TRANSFERRED");
  assert.equal((await data("shifts/outgoing")).status, "completed");
  assert.equal((await data("shifts/outgoing")).handoverStartedAt, f.shift.handoverStartedAt);
  const incoming = await data("shifts/incoming"), control = await data("operational_shift_control/global");
  assert.equal(incoming.status, "active"); assert.equal(incoming.previousShiftId, "outgoing"); assert.equal(incoming.handoverDocumentId, "handover_outgoing");
  assert.equal(control.shiftId, "incoming"); assert.equal(control.generation, 2); assert.equal(control.slotToken, f.aggregate.identity.successorSlotToken);
  assert.equal(control.previousSlotToken, f.aggregate.identity.outgoingSlotToken);
  assert.equal((await data("handovers/handover_outgoing")).lifecycleStatus, "completed");
  for (const uid of f.out) { assert.ok((await data(`shift_members/outgoing_${uid}`)).leftAt); assert.equal((await data(`technician_schedules/${uid}`)).entries.length, 0); }
  for (const uid of f.incoming) { assert.equal((await data(`shift_members/incoming_${uid}`)).leftAt, null); assert.equal((await data(`technician_schedules/${uid}`)).entries[0].status, "active"); }
  const attendances = (await db.collection("shift_attendance").where("shiftId", "==", "incoming").get()).docs.map(doc => doc.data().technicianId).sort();
  assert.deepEqual(attendances, result.receipt.incomingAttendanceTechnicianIds);
  for (const task of f.tasks.filter(task => !["completed", "cancelled"].includes(task.status))) {
    const after = await data(`tasks/${task.id}`); assert.equal(after.shiftId, "incoming"); assert.equal(after.status, task.status);
    const assignment = await data(`task_assignments/${task.id}_out-a`); assert.equal(assignment.releaseMode, "handover_transfer");
    assert.equal(assignment.transferredTo, null); assert.equal(assignment.acceptanceStatus, "pending");
    const history = await data(`handover_task_transfers/${createHandoverTaskTransferDocumentId("handover_outgoing", task.id)}`);
    assert.deepEqual(history.taskBeforeTransfer, task); assert.deepEqual(history.assignmentEvidence, f.assignments.filter(a => a.taskId === task.id));
  }
  assert.equal((await db.collection("task_assignments").get()).size, f.assignments.length);
  assert.deepEqual(await data(`audit_logs/${result.receipt.id}`), result.receipt);
  assert.equal((await db.collection("audit_logs").where("action", "==", "SHIFT_HANDOVER_TRANSFERRED").get()).size, 1);
}
for (const a of ["confirmed", "absent", "exception"]) for (const b of ["confirmed", "absent", "exception"]) test(`native atomic incoming resolution ${a}/${b}`, async () => {
  const f = await fixture({ incomingStates: [a, b] });
  if (a === "confirmed" || b === "confirmed") await verify(f, await transfer(f.input));
  else await rejectsAtomically(() => transfer(f.input), HandoverTransferError, "At least one reserved incoming permanent technician must self-confirm before transfer.");
});
for (const c of ["joined", "unjoined"]) test(`native outgoing C ${c} completes without continuation`, async () => {
  const f = await fixture({ c }); await verify(f, await transfer(f.input));
  assert.equal((await db.collection("next_shift_authorizations").get()).docs[0].data().status, "completed");
  assert.equal(await data("shift_members/incoming_c"), undefined); assert.equal(await data("shift_attendance/incoming_c"), undefined);
  if (c === "joined") { assert.ok((await data("shift_members/outgoing_c")).leftAt); assert.equal((await data("technician_schedules/c")).entries.length, 0); }
});
test("native exact replay remains read-only after subsequent operational activity", async () => {
  const f = await fixture(), first = await transfer(f.input), before = await state();
  const replay = await transfer(f.input); assert.equal(replay.status, "ALREADY_TRANSFERRED"); assert.deepEqual(replay.receipt, first.receipt); assert.deepEqual(await state(), before);
  await ref("tasks/task-0").update({ status: "completed" }); await ref("operational_shift_control/global").update({ generation: 5 });
  const later = await state(); assert.equal((await transfer(f.input)).status, "ALREADY_TRANSFERRED"); assert.deepEqual(await state(), later);
});
for (const corruption of ["missing", "revision", "control", "attendance", "time"]) test(`native replay rejects ${corruption} receipt`, async () => {
  const f = await fixture(), result = await transfer(f.input), target = ref(`audit_logs/${result.receipt.id}`);
  if (corruption === "missing") await target.delete();
  if (corruption === "revision") await target.update({ finalRevision: 99 });
  if (corruption === "control") await target.update({ "operationalControlAfter.generation": 99 });
  if (corruption === "attendance") await target.update({ incomingAttendanceTechnicianIds: [] });
  if (corruption === "time") await target.update({ transferredAt: f.at });
  await rejectsAtomically(() => transfer(f.input), HandoverTransferError);
});
test("native work drift reconciles only, then fresh classification and confirmations permit transfer", async () => {
  const f = await fixture(); await ref("tasks/task-0").update({ description: "Genuine drift" });
  const result = await transfer(f.input); assert.equal(result.status, "REVIEW_REQUIRED");
  let aggregate = await data("handovers/handover_outgoing"); assert.equal(aggregate.confirmations.length, 0);
  assert.deepEqual(await data("operational_shift_control/global"), f.control); assert.equal(await data("shifts/incoming"), undefined);
  assert.equal((await db.collection("handover_task_transfers").get()).size, 0);
  // Reclassification occurs through the established persistence boundary.
  const { persistFormalHandoverWorkDisposition } = await import("../src/lib/operations/formal-handover-work-disposition.ts");
  await persistFormalHandoverWorkDisposition({ outgoingShiftId: "outgoing", taskId: "task-0", actorUid: "manager", operation: "classify",
    disposition: "carry_forward", reason: "Freshly reviewed changed content", expectedRevision: aggregate.revision,
    expectedSnapshotHash: createHandoverSnapshot(aggregate).snapshotHash });
  aggregate = await data("handovers/handover_outgoing");
  for (const uid of [...f.out, ...f.incoming]) aggregate = confirmHandoverParticipant(aggregate, { revision: aggregate.revision,
    snapshotHash: createHandoverSnapshot(aggregate).snapshotHash, recordedAt: aggregate.updatedAt, actorUid: uid, technicianUid: uid });
  await ref("handovers/handover_outgoing").set(aggregate);
  const input = { ...f.input, expectedRevision: aggregate.revision, expectedSnapshotHash: createHandoverSnapshot(aggregate).snapshotHash };
  const freshTask = await data("tasks/task-0"); f.tasks = [freshTask];
  await verify(f, await transfer(input));
});
for (const scenario of ["resolve", "unclassified", "stale"]) test(`native ${scenario} unfinished disposition blocks`, async () => {
  const f = await fixture({ disposition: scenario === "resolve" ? "resolve_before_transfer" : "carry_forward" });
  if (scenario === "unclassified") await ref(`handover_task_dispositions/${f.dispositions[0].id}`).delete();
  if (scenario === "stale") await ref("tasks/task-0").update({ description: "stale" });
  if (scenario !== "resolve") {
    const aggregate = await data("handovers/handover_outgoing"), tasks = [await data("tasks/task-0")];
    aggregate.workSnapshot = createHandoverWorkSnapshot({ outgoingShiftId: "outgoing", tasks, assignments: f.assignments,
      dispositions: scenario === "unclassified" ? [] : f.dispositions });
    aggregate.confirmations = [];
    for (const uid of [...f.out, ...f.incoming]) aggregate.confirmations.push({ position: uid === "out-a" ? "outgoing_primary_a" : uid === "out-b" ? "outgoing_primary_b" : uid === "in-a" ? "incoming_primary_a" : "incoming_primary_b",
      technicianUid: uid, revision: aggregate.revision, confirmedAt: aggregate.updatedAt, snapshotHash: createHandoverSnapshot({ ...aggregate, confirmations: [] }).snapshotHash });
    await ref("handovers/handover_outgoing").set(aggregate); f.input.expectedSnapshotHash = createHandoverSnapshot(aggregate).snapshotHash;
  }
  await rejectsAtomically(() => transfer(f.input), HandoverDomainError, "Unfinished handover work is not ready for transfer.");
});
test("native terminal resolved work and valid history remain outgoing", async () => {
  const f = await fixture({ taskStatus: "completed" }); await transfer(f.input);
  assert.deepEqual(await data("tasks/task-0"), f.tasks[0]); assert.deepEqual(await data("task_assignments/task-0_out-a"), f.assignments[0]);
});
test("native resolve-before-transfer disposition survives terminal resolution and stays outgoing", async () => {
  const f = await fixture({ disposition: "resolve_before_transfer" });
  await transitionTask({ taskId: "task-0", actorUid: "manager", action: "cancel", reason: "Work resolved before final transfer" });
  const terminal = await data("tasks/task-0"), assignment = await data("task_assignments/task-0_out-a");
  assert.equal((await transfer(f.input)).status, "REVIEW_REQUIRED");
  let aggregate = await data("handovers/handover_outgoing");
  for (const uid of [...f.out, ...f.incoming]) aggregate = confirmHandoverParticipant(aggregate, { revision: aggregate.revision,
    snapshotHash: createHandoverSnapshot(aggregate).snapshotHash, recordedAt: aggregate.updatedAt, actorUid: uid, technicianUid: uid });
  await ref("handovers/handover_outgoing").set(aggregate);
  const result = await transfer({ ...f.input, expectedRevision: aggregate.revision, expectedSnapshotHash: createHandoverSnapshot(aggregate).snapshotHash });
  assert.equal(result.status, "TRANSFERRED"); assert.deepEqual(await data("tasks/task-0"), terminal);
  assert.deepEqual(await data("task_assignments/task-0_out-a"), assignment);
  assert.equal((await data(`handover_task_dispositions/${f.dispositions[0].id}`)).disposition, "resolve_before_transfer");
  assert.deepEqual(result.receipt.taskTransferIds, []);
});
for (const corruption of ["acceptance", "release"]) test(`native terminal history rejects ${corruption}`, async () => {
  const f = await fixture({ taskStatus: "completed" });
  await ref("task_assignments/task-0_out-a").update(corruption === "acceptance" ? { acceptanceStatus: "bad" } : { releaseMode: "handover_transfer" });
  await rejectsAtomically(() => transfer(f.input), corruption === "acceptance" ? HandoverTransferError : AssignmentOperationError);
});
for (const scenario of ["history", "receipt", "incoming C", "incoming member", "incoming attendance", "capacity", "write count", "pair membership", "account cleanup"]) test(`native rejection ${scenario} is atomic`, async () => {
  const f = await fixture({ count: scenario === "write count" ? 145 : 1 });
  if (scenario === "history") await ref(`handover_task_transfers/${createHandoverTaskTransferDocumentId("handover_outgoing", "task-0")}`).set({ immutable: true });
  if (scenario === "receipt") await ref(`audit_logs/${createFormalHandoverTransferReceiptId("handover_outgoing")}`).set({ immutable: true });
  if (scenario === "incoming C") await ref("next_shift_authorizations/unsupported").set({ shiftId: "incoming" });
  if (scenario === "incoming member") await ref("shift_members/incoming_in-a").set({ shiftId: "wrong" });
  if (scenario === "incoming attendance") await ref("shift_attendance/incoming_in-a").set({ shiftId: "wrong" });
  if (scenario === "capacity") await ref("tasks/task-0").update({ extraEvidence: "界".repeat(270000) });
  if (scenario === "pair membership") await ref("technician_pair_memberships/in-a").update({ pairId: "wrong" });
  if (scenario === "account cleanup") await ref("users/in-b").update({ statusOperation: { action: "block" } });
  await rejectsAtomically(() => transfer(f.input), HandoverTransferError, undefined,
    ["capacity", "write count"].includes(scenario) ? "TRANSFER_CAPACITY_EXCEEDED" : undefined);
});
test("ordinary completion has no collecting bypass; ordinary no-handover behavior remains", async () => {
  const f = await fixture({ count: 0 });
  await rejectsAtomically(() => completeShift({ shiftId: "outgoing", actorUid: "manager" }), AssignmentOperationError,
    "Complete the collecting formal handover through the atomic transfer boundary.");
  await ref("handovers/handover_outgoing").delete();
  for (const uid of f.incoming) await ref(`technician_schedules/${uid}`).update({ entries: [] });
  assert.equal((await completeShift({ shiftId: "outgoing", actorUid: "manager" })).status, "completed");
  assert.equal((await data("operational_shift_control/global")).generation, 2);
});
test("repository rules forbid direct client transfer history writes", async () => {
  await fixture({ count: 0 });
  const response = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents/handover_task_transfers/forged`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { forged: { booleanValue: true } } }) });
  assert.equal(response.status, 403); assert.equal(await data("handover_task_transfers/forged"), undefined);
});

test("native near-capacity Unicode evidence persists fully without truncation", async () => {
  const f = await fixture(); const value = "界".repeat(240000);
  await ref("tasks/task-0").update({ extraEvidence: value }); f.tasks[0].extraEvidence = value;
  const result = await transfer(f.input); await verify(f, result);
  const evidence = await data(`handover_task_transfers/${result.receipt.taskTransferIds[0]}`);
  assert.equal(evidence.taskBeforeTransfer.extraEvidence, value);
  const { estimateTransferDocumentBytes } = await import("../src/lib/operations/handover-transfer-domain.ts");
  const bytes = estimateTransferDocumentBytes(`handover_task_transfers/${evidence.id}`, evidence);
  assert.ok(bytes > 700000 && bytes <= 786432);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function contend(t, sharedPath, operationA, operationB) {
  const both = deferred(), release = deferred(), context = new AsyncLocalStorage(), seen = new Set();
  const original = db.runTransaction; const attempts = { A: 0, B: 0 };
  db.runTransaction = function(callback, options) {
    const operation = context.getStore();
    return original.call(db, async tx => {
      attempts[operation]++; const get = tx.get.bind(tx);
      tx.get = function(target, ...args) {
        const pending = get(target, ...args);
        if (target.path === sharedPath) {
          seen.add(operation); if (seen.size === 2) both.resolve();
          return pending.then(async snapshot => { await release.promise; return snapshot; });
        }
        return pending;
      };
      return callback(tx);
    }, options);
  };
  const abort = () => { both.resolve(); release.resolve(); }; t.signal.addEventListener("abort", abort, { once: true });
  let settled;
  try {
    settled = Promise.allSettled([context.run("A", operationA), context.run("B", operationB)]);
    await both.promise; assert.equal(seen.size, 2, "both genuine native transactions issued authoritative shared-document reads while held");
    release.resolve(); return { outcomes: await settled, attempts };
  } finally { release.resolve(); db.runTransaction = original; t.signal.removeEventListener("abort", abort); if (settled) await settled; }
}
test("genuine competing transfers advance ownership once and replay the loser", { timeout: 60000 }, async t => {
  const f = await fixture(); const { outcomes } = await contend(t, "handovers/handover_outgoing", () => transfer(f.input), () => transfer(f.input));
  assert.ok(outcomes.every(result => result.status === "fulfilled"));
  assert.deepEqual(outcomes.map(result => result.value.status).sort(), ["ALREADY_TRANSFERRED", "TRANSFERRED"]);
  await verify(f, outcomes.find(result => result.value.status === "TRANSFERRED").value);
});
test("genuine ordinary completion versus formal transfer cannot double-advance", { timeout: 60000 }, async t => {
  const f = await fixture({ count: 0 }); const { outcomes } = await contend(t, "handovers/handover_outgoing",
    () => completeShift({ shiftId: "outgoing", actorUid: "manager" }), () => transfer(f.input));
  assert.equal(outcomes[0].status, "rejected"); assert.ok(outcomes[0].reason instanceof AssignmentOperationError);
  assert.equal(outcomes[0].reason.status, 409); assert.equal(outcomes[1].status, "fulfilled");
  assert.equal((await data("operational_shift_control/global")).generation, 2);
});
test("genuine manager task cancellation versus transfer revalidates shared task state", { timeout: 60000 }, async t => {
  const f = await fixture(); const { outcomes } = await contend(t, "shifts/outgoing", () => transfer(f.input),
    () => transitionTask({ taskId: "task-0", actorUid: "manager", action: "cancel", reason: "Resolved concurrent outgoing work" }));
  assert.equal(outcomes[0].status, "fulfilled");
  const transferResult = outcomes[0].value, task = await data("tasks/task-0");
  if (transferResult.status === "REVIEW_REQUIRED") {
    assert.equal(task.status, "cancelled"); assert.equal(task.shiftId, "outgoing"); assert.equal(await data("shifts/incoming"), undefined);
    assert.equal((await data("operational_shift_control/global")).generation, 1);
  } else {
    assert.equal(transferResult.status, "TRANSFERRED"); assert.equal(task.shiftId, "incoming");
    assert.equal((await data("operational_shift_control/global")).generation, 2);
  }
});

const { persistFormalHandoverConfirmation } = await import("../src/lib/operations/formal-handover-confirmation.ts");
const { persistFormalHandoverResolution } = await import("../src/lib/operations/formal-handover-resolution.ts");
const { persistFormalHandoverWorkDisposition } = await import("../src/lib/operations/formal-handover-work-disposition.ts");
const { cancelFormalHandoverReservation, replaceFormalHandoverReservation } = await import("../src/lib/operations/formal-handover.ts");
const { createTaskAssignment } = await import("../src/lib/operations/create-task-assignment.ts");
const { createTask } = await import("../src/lib/operations/create-task.ts");
const { requireSafeAccountBlocking, AccountOperationalError } = await import("../src/lib/accounts/account-status-eligibility.ts");

for (const operation of ["confirmation", "absence", "exception", "resolution clear", "disposition create", "disposition change", "disposition clear", "handover cancellation", "reservation replacement"]) {
  test(`genuine transfer versus ${operation}`, { timeout: 60000 }, async t => {
    const f = await fixture({ incomingStates: operation === "resolution clear" ? ["confirmed", "absent"] : ["confirmed", "confirmed"],
      disposition: operation === "disposition create" ? "unclassified" : "carry_forward" });
    const binding = { expectedRevision: f.input.expectedRevision, expectedSnapshotHash: f.input.expectedSnapshotHash };
    const base = { outgoingShiftId: "outgoing", actorUid: "manager", actorRole: "admin", ...binding };
    let competitor;
    if (operation === "confirmation") competitor = () => persistFormalHandoverConfirmation({ outgoingShiftId: "outgoing", actorUid: "out-a", ...binding });
    if (["absence", "exception", "resolution clear"].includes(operation)) competitor = () => persistFormalHandoverResolution({ ...base, technicianUid: "in-b",
      ...(operation === "resolution clear" ? { operation: "clear" } : operation === "absence" ? { operation: "absence", reason: "Concurrent absence resolution" } :
        { operation: "exception", category: "unavailable", reason: "Concurrent exception resolution" }) });
    if (operation.startsWith("disposition")) competitor = () => persistFormalHandoverWorkDisposition({ outgoingShiftId: "outgoing", actorUid: "manager", taskId: "task-0", ...binding,
      reason: "Concurrent handover work classification", ...(operation === "disposition clear" ? { operation: "clear" } : { operation: "classify", disposition: operation === "disposition change" ? "resolve_before_transfer" : "carry_forward" }) });
    if (operation === "handover cancellation") competitor = () => cancelFormalHandoverReservation({ outgoingShiftId: "outgoing", actorUid: "manager", expectedRole: "admin", ...binding });
    if (operation === "reservation replacement") competitor = () => replaceFormalHandoverReservation({ outgoingShiftId: "outgoing", actorUid: "manager", expectedRole: "admin", ...binding,
      incomingPermanentPairId: "in-pair", shiftType: "morning", scheduledStart: f.aggregate.identity.scheduledStart, scheduledEnd: f.aggregate.identity.scheduledEnd });
    const { outcomes } = await contend(t, "handovers/handover_outgoing", () => transfer(f.input), competitor);
    const aggregate = await data("handovers/handover_outgoing"), control = await data("operational_shift_control/global");
    const receiptCount = (await db.collection("audit_logs").where("action", "==", "SHIFT_HANDOVER_TRANSFERRED").get()).size;
    if (aggregate.lifecycleStatus === "completed") {
      assert.equal(control.shiftId, "incoming"); assert.equal(control.generation, 2); assert.equal(receiptCount, 1);
      assert.equal(outcomes[0].status, "fulfilled"); assert.equal(outcomes[0].value.status, "TRANSFERRED");
    } else {
      assert.equal(control.shiftId, "outgoing"); assert.equal(control.generation, 1); assert.equal(receiptCount, 0);
      assert.equal(await data("shifts/incoming"), undefined); assert.equal((await db.collection("handover_task_transfers").get()).size, 0);
    }
    for (const result of outcomes.filter(result => result.status === "rejected")) {
      assert.ok(result.reason instanceof AssignmentOperationError || result.reason instanceof HandoverDomainError || result.reason instanceof HandoverTransferError,
        `${result.reason.constructor.name}: ${result.reason.message}`);
      assert.equal(result.reason.status, 409);
    }
  });
}
for (const action of ["return", "complete"]) test(`genuine transfer versus manager task ${action}`, { timeout: 60000 }, async t => {
  const f = await fixture({ taskStatus: "pending_verification" });
  const { outcomes } = await contend(t, "shifts/outgoing", () => transfer(f.input),
    () => transitionTask({ taskId: "task-0", actorUid: "manager", action, reason: "Concurrent reviewed task resolution" }));
  assert.equal(outcomes[0].status, "fulfilled");
  const result = outcomes[0].value, task = await data("tasks/task-0");
  if (result.status === "REVIEW_REQUIRED") {
    assert.equal((await data("operational_shift_control/global")).generation, 1); assert.equal(task.shiftId, "outgoing");
    assert.equal(await data("shifts/incoming"), undefined); assert.equal((await db.collection("handover_task_transfers").get()).size, 0);
  } else { assert.equal(result.status, "TRANSFERRED"); assert.equal(task.shiftId, "incoming"); assert.equal((await data("operational_shift_control/global")).generation, 2); }
  if (outcomes[1].status === "rejected") { assert.ok(outcomes[1].reason instanceof AssignmentOperationError); assert.equal(outcomes[1].reason.status, 409); }
});
test("genuine account blocking gate versus transfer preserves reserved account safety", { timeout: 60000 }, async t => {
  const f = await fixture();
  // This is the canonical account-status route's authoritative blocking gate
  // in a genuine native transaction. Auth account mutation is unreachable when
  // this gate rejects, so this proof needs no external Auth emulator.
  const block = () => db.runTransaction(async tx => {
    const profile = (await tx.get(ref("users/in-b"))).data(); assert.equal(profile.status, "active");
    await requireSafeAccountBlocking(tx, "in-b");
    tx.update(ref("users/in-b"), { statusOperation: { id: "blocking", action: "block" } });
  });
  const { outcomes } = await contend(t, "users/in-b", () => transfer(f.input), block);
  assert.equal(outcomes[0].status, "fulfilled"); assert.equal(outcomes[0].value.status, "TRANSFERRED");
  assert.equal(outcomes[1].status, "rejected"); assert.ok(outcomes[1].reason instanceof AccountOperationalError); assert.equal(outcomes[1].reason.status, 409);
  assert.equal((await data("users/in-b")).statusOperation, null); assert.equal((await data("operational_shift_control/global")).generation, 2);
});
test("genuine schedule metadata mutation is preserved across transfer retry", { timeout: 60000 }, async t => {
  const f = await fixture(); const mutate = () => db.runTransaction(async tx => {
    const schedule = (await tx.get(ref("technician_schedules/in-a"))).data();
    tx.update(ref("technician_schedules/in-a"), { ...schedule, concurrentMetadata: "preserved" });
  });
  const { outcomes } = await contend(t, "technician_schedules/in-a", () => transfer(f.input), mutate);
  assert.ok(outcomes.every(result => result.status === "fulfilled"));
  const schedule = await data("technician_schedules/in-a"); assert.equal(schedule.concurrentMetadata, "preserved"); assert.equal(schedule.entries[0].status, "active");
});
test("genuine outgoing C authorization mutation cannot be lost during completion", { timeout: 60000 }, async t => {
  const f = await fixture({ c: "unjoined" });
  const path = [...f.records.keys()].find(path => path.startsWith("next_shift_authorizations/"));
  const mutate = () => db.runTransaction(async tx => {
    const authorization = (await tx.get(ref(path))).data();
    // A concurrent completion timestamp refresh cannot overwrite the lifecycle
    // after transfer: the native transaction retries and retains the new status.
    tx.update(ref(path), { updatedAt: new Date(Math.max(Date.now(), Date.parse(authorization.updatedAt))).toISOString() });
  });
  const { outcomes } = await contend(t, path, () => transfer(f.input), mutate);
  assert.ok(outcomes.every(result => result.status === "fulfilled")); assert.equal((await data(path)).status, "completed");
  assert.equal((await data("operational_shift_control/global")).generation, 2);
});
for (const operation of ["assignment writer", "task writer"]) test(`genuine transfer versus ${operation} honors outgoing writer barriers`, { timeout: 60000 }, async t => {
  const f = await fixture();
  const competitor = operation === "assignment writer" ? () => createTaskAssignment({ taskId: "task-0", technicianUid: "in-a", responsibility: "support", assignedBy: "manager" }) :
    () => createTask({ title: "Concurrent outgoing creation", description: "Cannot bypass handover barrier", priority: "medium", sectionId: null, shiftId: "outgoing", createdBy: "manager" });
  const { outcomes } = await contend(t, "shifts/outgoing", () => transfer(f.input), competitor);
  assert.equal(outcomes[0].status, "fulfilled"); assert.equal(outcomes[0].value.status, "TRANSFERRED");
  if (outcomes[1].status === "rejected") { assert.ok(outcomes[1].reason instanceof AssignmentOperationError); assert.equal(outcomes[1].reason.status, 409); }
  else { assert.equal(operation, "assignment writer"); assert.equal(outcomes[1].value.technicianId, "in-a"); assert.equal((await data("tasks/task-0")).shiftId, "incoming"); }
  assert.equal((await db.collection("tasks").where("shiftId", "==", "outgoing").get()).size, 0);
  assert.equal((await db.collection("audit_logs").where("action", "==", "SHIFT_HANDOVER_TRANSFERRED").get()).size, 1);
});
