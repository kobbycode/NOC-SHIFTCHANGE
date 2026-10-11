import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";

export function modules(db, mutations = {}) {
  const cache = {};
  function load(path) {
    if (cache[path]) return cache[path];
    if (path === "lib/firebase/admin") return { getAdminFirestore: () => db };
    const exports = {}; cache[path] = exports;
    let source = readFileSync(new URL(`../src/${path}.ts`, import.meta.url), "utf8");
    if (mutations[path]) source = mutations[path](source);
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, Object, Buffer, structuredClone, TextEncoder, Date, require(name) {
        if (name === "server-only") return {};
        if (name === "node:crypto") return { createHash, randomUUID };
        if (name === "firebase-admin/firestore") return { FieldValue: { serverTimestamp: () => "server-time" } };
        if (name.startsWith("@/")) return load(name.slice(2));
        if (name.startsWith("./")) return load(path.slice(0, path.lastIndexOf("/") + 1) + name.slice(2));
        throw new Error(`Unexpected dependency ${name}`);
      } });
    return exports;
  }
  return load;
}

export function store(mutations = {}) {
  const records = new Map(), calls = []; let sequence = 0;
  const snapshot = path => ({ id: path.slice(path.indexOf("/") + 1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  const doc = path => ({ path, id: path.slice(path.indexOf("/") + 1) });
  const query = (name, filters = []) => ({ collection: name, filters, where: (field, op, value) => query(name, [...filters, [field, op, value]]) });
  const collection = name => ({ ...query(name), doc: id => doc(`${name}/${id ?? `event-${++sequence}`}`) });
  const db = { collection, doc, runTransaction: async callback => {
    let wrote = false; const writes = [];
    const tx = { get: async target => {
      assert.equal(wrote, false, "no reads after any queued writes"); calls.push(["read", target.path ?? target.collection]);
      if (target.path) return snapshot(target.path);
      const docs = [...records.keys()].filter(path => path.startsWith(target.collection + "/") &&
        target.filters.every(([key, , value]) => records.get(path)[key] === value)).map(snapshot);
      return { docs, empty: docs.length === 0, size: docs.length };
    } };
    for (const operation of ["create", "update", "set", "delete"]) tx[operation] = (ref, data) => { wrote = true; writes.push([operation, ref.path, data]); };
    const result = await callback(tx);
    for (const [operation, path] of writes) {
      if (operation === "create") assert.equal(records.has(path), false, "immutable history is create-only");
      if (operation === "update") assert.equal(records.has(path), true);
    }
    for (const [operation, path, data] of writes) {
      records.set(path, structuredClone(operation === "update" ? { ...records.get(path), ...data } : data)); calls.push([operation, path]);
    }
    return result;
  } };
  const load = modules(db, mutations);
  return { records, calls, db, load, transfer: load("lib/operations/formal-handover-transfer").persistFormalHandoverTransfer };
}

export function fixtureRecords(load, { incomingStates = ["confirmed", "confirmed"], taskStatus = "open", count = 1,
  disposition = "carry_forward", role = "admin", c = null, legacy = false } = {}) {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const start = new Date(Date.now() - 60_000).toISOString(), end = new Date(Date.now() + 8 * 3600_000).toISOString();
  const outStart = new Date(Date.now() - 8 * 3600_000).toISOString(), outEnd = start;
  const token = "a0000000-0000-4000-8000-000000000001", successor = "a0000000-0000-4000-8000-000000000002";
  const hd = load("lib/operations/handover-domain"), ws = load("lib/operations/handover-work-snapshot"), wd = load("lib/operations/handover-work-disposition-domain");
  const controlDomain = load("lib/operations/operational-shift-control-state");
  const records = new Map();
  const out = ["out-a", "out-b"], incoming = ["in-a", "in-b"], actor = "manager";
  for (const [uid, userRole] of [[actor, role], ...[...out, ...incoming, "c"].map(uid => [uid, "technician"])]) records.set(`users/${uid}`, {
    uid, role: userRole, status: "active", statusOperation: null, mustChangePassword: false });
  for (const [pairId, ids] of [["out-pair", out], ["in-pair", incoming]]) {
    records.set(`technician_pairs/${pairId}`, { id: pairId, technicianIds: ids, status: "active", createdBy: actor,
      createdAt: at, updatedAt: at, deactivatedAt: null, deactivatedBy: null });
    for (const uid of ids) records.set(`technician_pair_memberships/${uid}`, { technicianUid: uid, pairId, createdAt: at, updatedAt: at });
  }
  const shift = { id: "outgoing", status: "handover_pending", permanentPairId: "out-pair", primaryTechnicianIds: out,
    operationalSlotToken: token, shiftType: "morning", scheduledStart: outStart, scheduledEnd: outEnd, actualStart: outStart,
    actualEnd: null, handoverStartedAt: at, createdBy: actor, createdAt: outStart, updatedAt: at };
  records.set("shifts/outgoing", shift);
  let control = controlDomain.consumeOperationalShiftSlot(controlDomain.createPendingOperationalShiftControl(token, 1, outStart), "outgoing", outStart);
  control = controlDomain.transitionOperationalShiftControl(control, "outgoing", "scheduled", "active", outStart);
  control = controlDomain.transitionOperationalShiftControl(control, "outgoing", "active", "handover_pending", at);
  records.set("operational_shift_control/global", control);
  for (const uid of out) {
    records.set(`shift_members/outgoing_${uid}`, { id: `outgoing_${uid}`, shiftId: "outgoing", technicianId: uid, role: "primary", joinedAt: outStart, leftAt: null });
    records.set(`technician_schedules/${uid}`, { technicianUid: uid, entries: [{ shiftId: "outgoing", scheduledStart: outStart, scheduledEnd: outEnd, status: "handover_pending" }], updatedAt: at, metadata: "preserve" });
  }
  for (const uid of incoming) records.set(`technician_schedules/${uid}`, { technicianUid: uid,
    entries: [{ shiftId: "incoming", scheduledStart: start, scheduledEnd: end, status: "scheduled", metadata: "entry" }], updatedAt: at, metadata: "preserve" });
  const tasks = [], assignments = [], dispositions = [];
  const workInput = { outgoingShiftId: "outgoing", tasks, assignments, dispositions };
  for (let index = 0; index < count; index++) {
    const id = `task-${index}`;
    const task = { id, shiftId: "outgoing", title: "Carry work", description: "Full evidence", priority: "medium", sectionId: null,
      status: taskStatus, createdBy: actor, createdAt: at, updatedAt: at };
    tasks.push(task); records.set(`tasks/${id}`, task);
    const assignment = { id: `${id}_out-a`, taskId: id, technicianId: "out-a", responsibility: "lead", responsibilityStatus: "active",
      acceptanceStatus: "pending", assignedBy: actor, assignedAt: at, acceptedAt: null, rejectedAt: null, rejectionReason: null,
      releasedAt: null, releasedBy: null, transferredTo: null };
    assignments.push(assignment); records.set(`task_assignments/${assignment.id}`, assignment);
  }
  const initialHash = ws.createHandoverWorkSnapshot(workInput).version;
  if (disposition !== "unclassified" && !["completed", "cancelled"].includes(taskStatus)) for (const task of tasks) {
    const record = { id: wd.createHandoverWorkDispositionDocumentId({ outgoingShiftId: "outgoing", handoverDocumentId: "handover_outgoing", taskId: task.id }),
      schema: "handover-task-disposition-v1", outgoingShiftId: "outgoing", handoverDocumentId: "handover_outgoing", taskId: task.id,
      disposition, reason: "Reviewed outgoing work", classifiedBy: actor, classifierRole: role, classifiedAt: at, recordedRevision: 1,
      reviewedSnapshotHash: initialHash, classifiedTaskWorkHash: ws.createHandoverTaskWorkHash({ ...workInput, taskId: task.id }) };
    dispositions.push(record); records.set(`handover_task_dispositions/${record.id}`, record);
  }
  let aggregate = hd.createHandover({ identity: { outgoingShiftId: "outgoing", outgoingPermanentPairId: "out-pair",
    outgoingPrimaryTechnicianIds: out, outgoingSlotToken: token, outgoingGeneration: 1, incomingShiftId: "incoming",
    incomingPermanentPairId: "in-pair", incomingPrimaryTechnicianIds: incoming, successorSlotToken: successor, successorGeneration: 2,
    shiftType: "morning", scheduledStart: start, scheduledEnd: end }, workSnapshot: legacy ? { id: "outgoing", version: initialHash } : ws.createHandoverWorkSnapshot(workInput),
    reservedAt: at, reservedBy: actor });
  const context = () => ({ revision: aggregate.revision, snapshotHash: hd.createHandoverSnapshot(aggregate).snapshotHash, recordedAt: at });
  for (const uid of out) aggregate = hd.confirmHandoverParticipant(aggregate, { ...context(), actorUid: uid, technicianUid: uid });
  for (const [index, uid] of incoming.entries()) {
    const state = incomingStates[index];
    if (state === "confirmed") aggregate = hd.confirmHandoverParticipant(aggregate, { ...context(), actorUid: uid, technicianUid: uid });
    if (state === "absent") aggregate = hd.recordHandoverAbsence(aggregate, { ...context(), technicianUid: uid, actor: { uid: actor, authority: "manager" }, reason: "Not arrived for handover" });
    if (state === "exception") aggregate = hd.recordHandoverException(aggregate, { ...context(), technicianUid: uid, actor: { uid: actor, authority: "manager" }, category: "unavailable", reason: "Cannot confirm this handover" });
  }
  // Resolution mutations advance review and clear prior confirmations. Confirm
  // all unresolved required signers only after the final resolution revision.
  for (const uid of [...out, ...incoming.filter((_, index) => incomingStates[index] === "confirmed")]) {
    aggregate = hd.confirmHandoverParticipant(aggregate, { ...context(), actorUid: uid, technicianUid: uid });
  }
  if (c) {
    const authDomain = load("lib/operations/next-shift-authorization-domain");
    const id = authDomain.createNextShiftAuthorizationDocumentId("out-pair", 1, token);
    records.set(`next_shift_authorizations/${id}`, { id, slotToken: token, slotGeneration: 1, permanentPairId: "out-pair",
      authorizedTechnicianUid: "c", status: "consumed", shiftId: "outgoing", consumedAt: outStart, completedAt: null, expiredAt: null,
      createdBy: actor, createdAt: outStart, updatedAt: outStart });
    if (c === "joined") {
      records.set("shift_members/outgoing_c", { id: "outgoing_c", shiftId: "outgoing", technicianId: "c", role: "additional", joinedAt: outStart, leftAt: null });
      records.set("shift_attendance/outgoing_c", load("lib/operations/shift-join-domain").createShiftAttendanceRecord({ shiftId: "outgoing", technicianUid: "c", participationAuthority: "temporary_authorized", authorizationId: id, recordedAt: outStart }));
      records.set("technician_schedules/c", { technicianUid: "c", entries: [{ shiftId: "outgoing", scheduledStart: outStart, scheduledEnd: outEnd, status: "handover_pending" }], updatedAt: at });
    }
  }
  records.set("handovers/handover_outgoing", aggregate);
  return { records, aggregate, tasks, assignments, dispositions, control, shift, out, incoming, at,
    input: { outgoingShiftId: "outgoing", actorUid: actor, actorRole: role, expectedRevision: aggregate.revision,
      expectedSnapshotHash: hd.createHandoverSnapshot(aggregate).snapshotHash } };
}
export function prepared(options, mutations) {
  const f = store(mutations), fixture = structuredClone(fixtureRecords(f.load, options));
  for (const [path, record] of fixture.records) f.records.set(path, structuredClone(record));
  return { ...fixture, ...f };
}
export async function rejectsAtomically(f, operation, ErrorType, message, status = 409, code) {
  const before = structuredClone([...f.records]);
  await assert.rejects(operation, error => { assert.ok(error instanceof ErrorType, `${error.constructor.name}: ${error.message}`);
    assert.equal(error.status, status); if (message) assert.equal(error.message, message); if (code) assert.equal(error.code, code); return true; });
  assert.deepEqual(structuredClone([...f.records]), before);
}
