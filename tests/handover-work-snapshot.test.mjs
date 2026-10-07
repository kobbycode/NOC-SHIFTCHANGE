import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const domainSource = await readFile(new URL("../src/lib/operations/handover-domain.ts", import.meta.url), "utf8");
const source = await readFile(new URL("../src/lib/operations/handover-work-snapshot.ts", import.meta.url), "utf8");
function load(sourceText, dependencies = {}) {
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(sourceText, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports: loaded.exports, structuredClone, TextEncoder,
    require(name) {
      if (name === "node:crypto") return { createHash };
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected pure dependency: ${name}`);
    } });
  return loaded.exports;
}
const domain = load(domainSource);
const dispositionDomain = load(await readFile(new URL("../src/lib/operations/handover-work-disposition-domain.ts", import.meta.url), "utf8"), { "./handover-domain": domain });
const identity = load(await readFile(new URL("../src/lib/operations/assignment-identity.ts", import.meta.url), "utf8"));
const assignmentDomain = load(await readFile(new URL("../src/lib/operations/assignment-generation-domain.ts", import.meta.url), "utf8"), { "./assignment-identity": identity });
const { createHandoverWorkSnapshot: snapshot } = load(source, { "./handover-domain": domain, "./handover-work-disposition-domain": dispositionDomain, "./assignment-generation-domain": assignmentDomain });
const at = "2026-10-04T06:00:00.000Z", later = "2026-10-04T06:01:00.000Z";
function task(overrides = {}) { return { id: "task-a", shiftId: "outgoing", title: "Inspect pump",
  description: "Check operating pressure", status: "open", priority: "medium", sectionId: null,
  updatedAt: at, createdBy: "manager", createdAt: at, ...overrides }; }
function assignment(overrides = {}) { return { id: "assignment-a", taskId: "task-a", technicianId: "tech-a",
  responsibility: "lead", responsibilityStatus: "active", acceptanceStatus: "pending", assignedAt: at,
  acceptedAt: null, rejectedAt: null, rejectionReason: null, releasedAt: null, releasedBy: null,
  transferredTo: null, ...overrides }; }
function input(overrides = {}) { return { outgoingShiftId: "outgoing", tasks: [task()], assignments: [assignment()], ...overrides }; }
function digest(overrides = {}) { return snapshot(input(overrides)).version; }
const empty = () => digest({ tasks: [], assignments: [] });
function accepted(overrides = {}) { return assignment({ acceptanceStatus: "accepted", acceptedAt: at, ...overrides }); }
function rejected(overrides = {}) { return assignment({ acceptanceStatus: "rejected", rejectedAt: at, rejectionReason: "Unavailable", ...overrides }); }
function released(overrides = {}) { return assignment({ responsibilityStatus: "released", releasedAt: at,
  releasedBy: "manager", transferredTo: "tech-b", ...overrides }); }

test("empty snapshot matches independent schema-marked UTF-8 SHA-256 vector", () => {
  const canonical = '{"outgoingShiftId":"outgoing","schema":"handover-work-v2","tasks":[]}';
  assert.equal(empty(), createHash("sha256").update(canonical, "utf8").digest("hex"));
  assert.equal(empty(), empty());
  assert.match(empty(), /^[0-9a-f]{64}$/);
  assert.equal(snapshot(input()).id, "outgoing");
  assert.notEqual(empty(), snapshot({ outgoingShiftId: "another", tasks: [], assignments: [] }).version);
});
test("array and object insertion order do not affect digest", () => {
  const value = input({ tasks: [task(), task({ id: "task-b" })],
    assignments: [assignment(), assignment({ id: "assignment-b", taskId: "task-b" })] });
  const reverseKeys = x => Object.fromEntries(Object.entries(x).reverse());
  const other = { ...value, tasks: value.tasks.toReversed().map(reverseKeys), assignments: value.assignments.toReversed().map(reverseKeys) };
  assert.equal(snapshot(value).version, snapshot(other).version);
});
test("caller arrays and nested records remain unchanged and output is detached", () => {
  const value = input(), before = structuredClone(value);
  const result = snapshot(value); result.version = "modified";
  assert.deepEqual(value, before);
  assert.notEqual(snapshot(value).version, result.version);
});
for (const status of ["open", "in_progress", "pending_verification"]) test(`${status} task is included`, () => {
  assert.notEqual(digest({ tasks: [task({ status })] }), empty());
});
for (const change of [{ status: "completed" }, { status: "cancelled" }, { shiftId: null }, { shiftId: "another" }]) {
  test(`excluded task ${JSON.stringify(change)} and assignments do not enter digest`, () => {
    assert.equal(digest({ tasks: [task(change)] }), empty());
  });
}
test("irrelevant malformed object content is ignored without contaminating digest", () => {
  const value = input(); value.tasks.push({ shiftId: "another", status: "bad" });
  value.assignments.push({ taskId: "unknown", acceptanceStatus: "bad" });
  assert.equal(snapshot(value).version, digest());
});
for (const [field, value] of Object.entries({ id: "bad/id", title: " ", description: 1, priority: "invalid",
  status: "invalid", sectionId: "bad/id", updatedAt: "not-a-date" })) {
  test(`malformed outgoing task ${field} fails closed`, () => assert.throws(() => digest({ tasks: [task({ [field]: value })] })));
}
test("malformed terminal outgoing task also fails closed", () => assert.throws(() => digest({ tasks: [task({ status: "completed", title: null })] })));
test("duplicate outgoing task IDs fail closed", () => assert.throws(() => digest({ tasks: [task(), task()] })));
for (const [field, value] of Object.entries({ id: "new-task", title: "Different title", description: "Different work",
  status: "in_progress", priority: "high", sectionId: "section-a", updatedAt: later })) {
  test(`task ${field} changes content digest`, () => assert.notEqual(digest({ tasks: [task({ [field]: value })] }), digest()));
}
for (const status of ["completed", "cancelled"]) test(`unfinished to ${status} changes digest`, () => {
  assert.notEqual(digest({ tasks: [task({ status })] }), digest());
});
for (const field of ["createdBy", "createdAt", "auditMetadata", "lastLifecycleAt"]) test(`task ${field} excluded`, () => {
  assert.equal(digest({ tasks: [task({ [field]: "changed" })] }), digest());
});
test("terminal historical metadata cannot change outstanding digest", () => {
  const terminal = task({ status: "completed" });
  assert.equal(digest({ tasks: [terminal] }), digest({ tasks: [{ ...terminal, title: "History edited", updatedAt: later, createdBy: "other" }] }));
});
test("UTF-8 content is preserved without Unicode normalization", () => {
  assert.notEqual(digest({ tasks: [task({ title: "é" })] }), digest({ tasks: [task({ title: "e\u0301" })] }));
});
test("active and released assignments both enter unfinished-work digest", () => {
  assert.notEqual(digest(), digest({ assignments: [] }));
  assert.notEqual(digest({ assignments: [released()] }), digest({ assignments: [] }));
  assert.notEqual(digest({ assignments: [released()] }), digest());
});
test("legacy missing responsibility and release fields normalize identically", () => {
  const legacy = assignment();
  for (const key of ["responsibilityStatus", "releasedAt", "releasedBy", "transferredTo"]) delete legacy[key];
  assert.equal(digest({ assignments: [legacy] }), digest());
});
test("explicit null responsibility status is not a legacy omission", () => assert.throws(() => digest({ assignments: [assignment({ responsibilityStatus: null })] })));
test("duplicate included assignment IDs fail closed", () => assert.throws(() => digest({ assignments: [assignment(), assignment()] })));
for (const [field, value] of Object.entries({ id: "bad/id", technicianId: "", responsibility: "other", responsibilityStatus: "other",
  acceptanceStatus: "other", assignedAt: "", acceptedAt: at, rejectedAt: at, rejectionReason: "wrong",
  releasedAt: at, releasedBy: "manager", transferredTo: "tech-b" })) {
  test(`invalid active/pending assignment ${field} rejected`, () => assert.throws(() => digest({ assignments: [assignment({ [field]: value })] })));
}
for (const [field, value] of Object.entries({ releasedAt: null, releasedBy: "", transferredTo: "tech-a" })) {
  test(`invalid released evidence ${field} rejected`, () => assert.throws(() => digest({ assignments: [released({ [field]: value })] })));
}
for (const field of ["releasedAt", "releasedBy", "transferredTo"]) test(`released evidence cannot omit ${field}`, () => {
  const value = released(); delete value[field];
  assert.throws(() => digest({ assignments: [value] }));
});
for (const factory of [assignment, accepted, rejected]) test(`consistent ${factory().acceptanceStatus} acceptance accepted`, () => {
  assert.match(digest({ assignments: [factory()] }), /^[0-9a-f]{64}$/);
});
for (const [label, value] of [
  ["accepted missing timestamp", accepted({ acceptedAt: null })],
  ["accepted conflicting rejection", accepted({ rejectedAt: at })],
  ["rejected missing timestamp", rejected({ rejectedAt: null })],
  ["rejected conflicting acceptance", rejected({ acceptedAt: at })],
  ["rejected blank reason", rejected({ rejectionReason: " " })],
  ["pending missing evidence", { ...assignment(), acceptedAt: undefined }],
]) test(label, () => assert.throws(() => digest({ assignments: [value] })));
for (const [field, value, factory] of [
  ["id", "assignment-b", assignment], ["technicianId", "tech-c", assignment],
  ["responsibility", "support", assignment], ["assignedAt", later, assignment],
  ["acceptedAt", later, accepted], ["rejectedAt", later, rejected],
  ["rejectionReason", "Different reason", rejected], ["releasedAt", later, released],
  ["releasedBy", "other-manager", released], ["transferredTo", "tech-c", released],
]) test(`assignment ${field} affects digest`, () => {
  assert.notEqual(digest({ assignments: [factory({ [field]: value })] }), digest({ assignments: [factory()] }));
});
test("acceptance state changes digest without changing caller acceptance", () => {
  const value = accepted(), before = structuredClone(value);
  assert.notEqual(digest({ assignments: [value] }), digest());
  assert.deepEqual(value, before);
});
test("assignment addition and removal change digest", () => {
  assert.notEqual(digest({ assignments: [assignment(), assignment({ id: "assignment-b", technicianId: "tech-b", responsibility: "support" })] }), digest());
  assert.notEqual(digest({ assignments: [] }), digest());
});
for (const value of [null, [], "bad"]) test(`non-object task ${JSON.stringify(value)} fails closed`, () => assert.throws(() => digest({ tasks: [value] })));
for (const value of [null, [], "bad"]) test(`non-object assignment ${JSON.stringify(value)} fails closed`, () => assert.throws(() => digest({ assignments: [value] })));
for (const outgoingShiftId of ["", "a/b", " leading", ".", "..", "a".repeat(513)]) test(`invalid scope ${outgoingShiftId.slice(0, 10)}`, () => {
  assert.throws(() => snapshot(input({ outgoingShiftId })));
});
test("snapshot scope does not apply persistence document byte limits", () => {
  const id = "界".repeat(512);
  assert.equal(snapshot({ outgoingShiftId: id, tasks: [], assignments: [] }).id, id);
});
test("canonical projected content matches an independent full-content vector", () => {
  const projectedTask = { id: "task-a", shiftId: "outgoing", title: "Inspect pump", description: "Check operating pressure",
    status: "open", priority: "medium", sectionId: null, updatedAt: at };
  const payload = { schema: "handover-work-v2", outgoingShiftId: "outgoing", tasks: [{ task: projectedTask, assignments: [assignment()], disposition: null }] };
  const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
  assert.equal(digest(), createHash("sha256").update(JSON.stringify(sortKeys(payload)), "utf8").digest("hex"));
});
