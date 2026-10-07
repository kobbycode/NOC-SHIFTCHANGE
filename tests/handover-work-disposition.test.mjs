import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const sources = Object.fromEntries(await Promise.all(["assignment-identity", "assignment-generation-domain", "handover-domain", "handover-work-disposition-domain", "handover-work-snapshot"]
  .map(async name => [name, await readFile(new URL(`../src/lib/operations/${name}.ts`, import.meta.url), "utf8")])));
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const exports = {};
  runInNewContext(ts.transpileModule(sources[name], { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, structuredClone, TextEncoder, require(specifier) {
      if (specifier === "node:crypto") return { createHash };
      return load(specifier.slice(2));
    } });
  return modules[name] = exports;
}
const domain = load("handover-domain"), disposition = load("handover-work-disposition-domain"), work = load("handover-work-snapshot");
const at = "2020-01-01T00:00:00.000Z";
const scope = { outgoingShiftId: "outgoing", handoverDocumentId: "handover_outgoing", taskId: "task-a" };
const task = { id: "task-a", shiftId: "outgoing", title: "Inspect pump", description: "Check pressure", priority: "medium",
  status: "pending_verification", sectionId: null, updatedAt: at };
const assignment = { id: "assignment-a", taskId: task.id, technicianId: "tech-a", responsibility: "lead", responsibilityStatus: "active",
  acceptanceStatus: "pending", assignedAt: at, acceptedAt: null, rejectedAt: null, rejectionReason: null,
  releasedAt: null, releasedBy: null, transferredTo: null };
const input = (changes = {}) => ({ outgoingShiftId: "outgoing", tasks: [task], assignments: [assignment], dispositions: [], ...changes });
const record = (changes = {}) => ({ ...scope, id: disposition.createHandoverWorkDispositionDocumentId(scope), schema: "handover-task-disposition-v1",
  disposition: "carry_forward", classifiedBy: "manager", classifierRole: "admin", classifiedAt: at, reason: "Reviewed operational reason",
  recordedRevision: 2, reviewedSnapshotHash: "a".repeat(64), classifiedTaskWorkHash: work.createHandoverTaskWorkHash({ ...input(), taskId: task.id }), ...changes });
const corruption = "Malformed authoritative handover disposition; administrator review required.";
function rejects(operation, message = corruption) {
  assert.throws(operation, error => { assert.ok(error instanceof domain.HandoverDomainError); assert.equal(error.status, 409); assert.equal(error.message, message); return true; });
}
function independentHash(value) {
  const sorted = x => Array.isArray(x) ? x.map(sorted) : x !== null && typeof x === "object"
    ? Object.fromEntries(Object.keys(x).sort().map(key => [key, sorted(x[key])])) : x;
  return createHash("sha256").update(JSON.stringify(sorted(value)), "utf8").digest("hex");
}
test("stable identity matches independent vector and binds all immutable scope", () => {
  assert.equal(disposition.createHandoverWorkDispositionDocumentId(scope), `disposition_${independentHash({ schema: "handover-task-disposition-v1", ...scope })}`);
  assert.notEqual(disposition.createHandoverWorkDispositionDocumentId(scope), disposition.createHandoverWorkDispositionDocumentId({ ...scope, taskId: "task-b" }));
  assert.notEqual(disposition.createHandoverWorkDispositionDocumentId(scope), disposition.createHandoverWorkDispositionDocumentId({ ...scope, outgoingShiftId: "other", handoverDocumentId: "handover_other" }));
  assert.equal(disposition.createHandoverWorkDispositionDocumentId(record({ disposition: "resolve_before_transfer", reason: "Changed review reason" })), record().id);
});
for (const field of ["outgoingShiftId", "taskId"]) for (const value of ["", " leading", ".", "..", "a/b", "x".repeat(513)]) {
  test(`identity rejects ${field} ${value.slice(0, 12)}`, () => rejects(() => disposition.createHandoverWorkDispositionDocumentId({ ...scope, [field]: value })));
}
test("identity rejects mutable reservation fingerprint", () => rejects(() => disposition.createHandoverWorkDispositionDocumentId({ ...scope, handoverDocumentId: "handover_fingerprint" })));
for (const [field, value] of Object.entries({ id: "wrong", schema: "future", disposition: "unclassified", classifiedBy: "", classifierRole: "technician",
  classifiedAt: "invalid", reason: "short", recordedRevision: 0, reviewedSnapshotHash: "A".repeat(64), classifiedTaskWorkHash: "bad" })) {
  test(`record rejects corrupt ${field}`, () => rejects(() => disposition.assertHandoverWorkDisposition(record({ [field]: value }))));
}
for (const field of Object.keys(record())) test(`record requires ${field}`, () => {
  const value = record(); delete value[field]; rejects(() => disposition.assertHandoverWorkDisposition(value));
});
test("record rejects extra fields and noncanonical reason", () => {
  rejects(() => disposition.assertHandoverWorkDisposition(record({ actorUid: "forged" })));
  rejects(() => disposition.assertHandoverWorkDisposition(record({ reason: " Reviewed operational reason " })));
});
for (const value of ["carry_forward", "resolve_before_transfer"]) test(`valid ${value} record is detached`, () => {
  const old = record({ disposition: value }); const result = disposition.assertHandoverWorkDisposition(old);
  assert.equal(result.disposition, value); result.reason = "mutated"; assert.equal(old.reason, "Reviewed operational reason");
});
test("task-work digest matches independent vector and excludes disposition", () => {
  const hash = work.createHandoverTaskWorkHash({ ...input(), taskId: task.id });
  assert.equal(hash, independentHash({ schema: "handover-task-work-v1", outgoingShiftId: "outgoing", task, assignments: [assignment] }));
  assert.equal(hash, work.createHandoverTaskWorkHash({ ...input({ dispositions: [record()] }), taskId: task.id }));
});
for (const [field, value] of Object.entries({ title: "Different title", description: "Other work", priority: "critical", status: "in_progress", sectionId: "section-a", updatedAt: "2020-01-01T00:01:00.000Z" })) {
  test(`task-work binding changes with ${field}`, () => assert.notEqual(work.createHandoverTaskWorkHash({ ...input({ tasks: [{ ...task, [field]: value }] }), taskId: task.id }), record().classifiedTaskWorkHash));
}
for (const change of [{ id: "assignment-b" }, { technicianId: "tech-b" }, { responsibility: "support" }, { assignedAt: "later" },
  { acceptanceStatus: "accepted", acceptedAt: at }, { responsibilityStatus: "released", releasedAt: at, releasedBy: "manager", transferredTo: "tech-b" }]) {
  test(`task-work binding changes with assignment ${JSON.stringify(change)}`, () => assert.notEqual(work.createHandoverTaskWorkHash({ ...input({ assignments: [{ ...assignment, ...change }] }), taskId: task.id }), record().classifiedTaskWorkHash));
}
test("v2 independent null vector and canonical query ordering", () => {
  assert.equal(work.createHandoverWorkSnapshot(input()).version, independentHash({ schema: "handover-work-v2", outgoingShiftId: "outgoing", tasks: [{ task, assignments: [assignment], disposition: null }] }));
  const value = input({ tasks: [task, { ...task, id: "task-b" }], assignments: [assignment, { ...assignment, id: "assignment-b", taskId: "task-b" }] });
  assert.equal(work.createHandoverWorkSnapshot(value).version, work.createHandoverWorkSnapshot({ ...value, tasks: value.tasks.toReversed(), assignments: value.assignments.toReversed() }).version);
  assert.equal(work.createHandoverWorkSnapshot(value).schema, "handover-work-v2");
});
for (const change of [{ disposition: "resolve_before_transfer" }, { reason: "Different reviewed reason" }, { classifiedBy: "other-manager" },
  { classifierRole: "supervisor" }, { classifiedAt: "2020-01-01T00:01:00.000Z" }]) {
  test(`confirmation-visible policy ${JSON.stringify(change)} changes digest`, () => assert.notEqual(work.createHandoverWorkSnapshot(input({ dispositions: [record(change)] })).version,
    work.createHandoverWorkSnapshot(input({ dispositions: [record()] })).version));
}
test("historical revision/hash excluded without self-referential hashing", () => {
  assert.equal(work.createHandoverWorkSnapshot(input({ dispositions: [record()] })).version,
    work.createHandoverWorkSnapshot(input({ dispositions: [record({ recordedRevision: 3, reviewedSnapshotHash: "b".repeat(64) })] })).version);
});
for (const status of ["completed", "cancelled"]) test(`terminal ${status} retains evidence without digest/readiness contribution`, () => {
  const value = input({ tasks: [{ ...task, status }], dispositions: [record()] });
  assert.equal(work.createHandoverWorkSnapshot(value).version, work.createHandoverWorkSnapshot(input({ tasks: [], assignments: [] })).version);
  assert.equal(work.resolveHandoverWorkReadiness(value).ready, true);
  rejects(() => work.createHandoverWorkSnapshot({ ...value, dispositions: [record({ id: "wrong" })] }));
});
for (const [label, records, reason] of [["missing", [], "unclassified"], ["resolve", [record({ disposition: "resolve_before_transfer" })], "resolve_before_transfer"],
  ["stale", [record({ classifiedTaskWorkHash: "b".repeat(64) })], "stale_disposition"]]) test(`${label} work blocks readiness`, () => {
  const value = input({ dispositions: records }); const result = work.resolveHandoverWorkReadiness(value);
  assert.equal(result.ready, false); assert.equal(result.blockers[0].reason, reason);
  rejects(() => work.assertFormalTransferWorkReady(value, result.workSnapshot), "Unfinished handover work is not ready for transfer.");
});
test("current carry permission requires current explicit v2 snapshot", () => {
  const value = input({ dispositions: [record()] }); const snapshot = work.createHandoverWorkSnapshot(value);
  assert.equal(work.assertFormalTransferWorkReady(value, snapshot).ready, true);
  for (const expected of [{ id: snapshot.id, version: snapshot.version }, { ...snapshot, version: "0".repeat(64) }]) {
    rejects(() => work.assertFormalTransferWorkReady(value, expected), "Review the current v2 handover work snapshot.");
  }
});
test("duplicate, missing-task and wrong-shift disposition fail closed", () => {
  rejects(() => work.createHandoverWorkSnapshot(input({ dispositions: [record(), record()] })), "Malformed authoritative handover work.");
  rejects(() => work.createHandoverWorkSnapshot(input({ tasks: [], dispositions: [record()] })), "Malformed authoritative handover work.");
  rejects(() => work.createHandoverWorkSnapshot({ ...input(), outgoingShiftId: "other", dispositions: [record()] }), "Malformed authoritative handover work.");
});
test("pure classification exact retry preserves original evidence; changes are material", () => {
  const old = record(); const value = { ...old }; delete value.id; delete value.schema;
  const result = disposition.classifyHandoverWork(old, { ...value, recordedRevision: 9, classifiedAt: "2020-01-01T00:01:00.000Z" });
  assert.equal(result.changed, false); assert.equal(result.record.classifiedAt, at);
  for (const change of [{ reason: "Different review reason" }, { classifiedBy: "other" }, { classifiedTaskWorkHash: "b".repeat(64) }, { disposition: "resolve_before_transfer" }]) {
    assert.equal(disposition.classifyHandoverWork(old, { ...value, ...change }).changed, true);
  }
  assert.equal(disposition.clearHandoverWorkDisposition(old, "Reviewed clear reason").changed, true);
  assert.equal(disposition.clearHandoverWorkDisposition(null, "Reviewed clear reason").changed, false);
});

const identity = { outgoingShiftId: "outgoing", outgoingPermanentPairId: "out-pair", outgoingPrimaryTechnicianIds: ["out-a", "out-b"],
  outgoingSlotToken: "a0000000-0000-4000-8000-000000000001", outgoingGeneration: 1, incomingShiftId: "incoming",
  incomingPermanentPairId: "in-pair", incomingPrimaryTechnicianIds: ["in-a", "in-b"], successorSlotToken: "a0000000-0000-4000-8000-000000000002",
  successorGeneration: 2, shiftType: "morning", scheduledStart: at, scheduledEnd: "2020-01-01T08:00:00.000Z" };
for (const snapshot of [{ id: "outgoing", version: "a".repeat(64) }, { schema: "handover-work-v1", id: "outgoing", version: "a".repeat(64) }, work.createHandoverWorkSnapshot(input())]) {
  test(`strict ${snapshot.schema ?? "legacy"} recognition preserves stored shape`, () => {
    const aggregate = domain.createHandover({ identity, workSnapshot: snapshot, reservedAt: at, reservedBy: "manager" });
    assert.equal(JSON.stringify(aggregate.workSnapshot), JSON.stringify(snapshot));
  });
}
for (const snapshot of [{ id: "outgoing", version: "a".repeat(64), extra: true }, { schema: undefined, id: "outgoing", version: "a".repeat(64) },
  { schema: "handover-work-v3", id: "outgoing", version: "a".repeat(64) }]) test(`unsupported snapshot ${JSON.stringify(snapshot)}`, () => {
  assert.throws(() => domain.createHandover({ identity, workSnapshot: snapshot, reservedAt: at, reservedBy: "manager" }), error => {
    assert.ok(error instanceof domain.HandoverDomainError); assert.equal(error.status, 409);
    assert.equal(error.message, Object.hasOwn(snapshot, "extra") ? "Malformed handover state: missing or unsupported fields." : "Unsupported handover work snapshot schema."); return true;
  });
});
