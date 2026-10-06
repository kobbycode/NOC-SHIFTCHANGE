import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const routeSource = await readFile(new URL("../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/resolution/route.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../src/lib/operations/formal-handover-resolution.ts", import.meta.url), "utf8");
class MockAssignmentOperationError extends Error {
  constructor(message, status = 409) { super(message); this.name = "AssignmentOperationError"; this.status = status; }
}
class MockHandoverDomainError extends Error {
  constructor(message, status = 409) { super(message); this.name = "HandoverDomainError"; this.status = status; }
}
class MockNextShiftAuthorizationDomainError extends Error {
  constructor(message, status = 409) { super(message); this.name = "NextShiftAuthorizationDomainError"; this.status = status; }
}
const classes = [MockAssignmentOperationError, MockHandoverDomainError, MockNextShiftAuthorizationDomainError];
function exactError(error, ExpectedClass, status, message) {
  assert.ok(error instanceof ExpectedClass);
  for (const sibling of classes) if (sibling !== ExpectedClass) assert.equal(error instanceof sibling, false);
  assert.equal(error.status, status); assert.equal(error.message, message);
}
function compile(source, require, extras = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require, ...extras });
  return exports;
}
const parser = compile(serviceSource, (name) => {
  if (name.endsWith("/assignment-transaction")) return { AssignmentOperationError: MockAssignmentOperationError };
  return {};
}).parseFormalHandoverResolutionRequest;
const body = (operation = "absence") => ({ operation, technicianUid: "target", expectedRevision: 1, expectedSnapshotHash: "a".repeat(64),
  ...(operation === "clear" ? {} : { reason: "  Reviewed reason  " }), ...(operation === "exception" ? { category: "unavailable" } : {}) });
function fixture(options = {}) {
  const calls = [], logs = [];
  const actor = Object.hasOwn(options, "actor") ? options.actor : { uid: "manager", role: "admin", mustChangePassword: false };
  const outcome = options.outcome ?? { status: "RESOLVED", handover: { revision: 2, snapshotHash: "b".repeat(64) } };
  const route = compile(routeSource, (name) => {
    if (name === "server-only") return {};
    if (name === "next/server") return { NextResponse: { json: (body, init) => ({ body, ...init }) } };
    if (name.endsWith("/session")) return { getCurrentUser: async () => actor };
    if (name.endsWith("/formal-handover-resolution")) return { parseFormalHandoverResolutionRequest: parser,
      persistFormalHandoverResolution: async (input) => { calls.push(input); if (options.error) throw options.error; return outcome; } };
    if (name.endsWith("/assignment-transaction")) return { AssignmentOperationError: MockAssignmentOperationError };
    if (name.endsWith("/next-shift-authorization-domain")) return { NextShiftAuthorizationDomainError: MockNextShiftAuthorizationDomainError };
    if (name.endsWith("/handover-domain")) return { HandoverDomainError: MockHandoverDomainError, createHandoverDocumentId(id) {
      if (typeof id !== "string" || !id || id.trim() !== id || id.includes("/") || [".", ".."].includes(id) || id.length > 512) {
        const error = new MockHandoverDomainError("Invalid outgoing shift ID.", 400);
        exactError(error, MockHandoverDomainError, 400, "Invalid outgoing shift ID."); throw error;
      }
      return `handover_${id}`;
    } };
    throw new Error(`Unexpected dependency ${name}`);
  }, { process: { env: options.env ?? {} }, console: { error: (...args) => logs.push(args) } });
  const run = async (value = body(), origin = "https://example.test", shiftId = "outgoing", malformed = false) => route.POST({
    nextUrl: { origin: "https://example.test" }, headers: { get: () => origin }, json: async () => {
      if (malformed) throw new Error("Invalid JSON"); return value;
    },
  }, { params: Promise.resolve({ shiftId }) });
  return { run, calls, logs };
}
function failure(result, status, message) {
  assert.equal(result.status, status); assert.equal(result.body.success, false); assert.equal(result.body.error, message);
  assert.equal(result.headers["Cache-Control"], "no-store");
}
for (const role of ["admin", "supervisor"]) for (const operation of ["absence", "exception", "clear"]) test(`${role} route projects trusted ${operation} input without password auth`, async () => {
  const f = fixture({ actor: { uid: "trusted", role, mustChangePassword: false } }); const result = await f.run(body(operation));
  assert.equal(result.status, 200); assert.equal(result.body.success, true); assert.equal(result.body.alreadyResolved, false);
  assert.equal(result.headers["Cache-Control"], "no-store"); assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), { ...body(operation), ...(operation === "clear" ? {} : { reason: "Reviewed reason" }),
    outgoingShiftId: "outgoing", actorUid: "trusted", actorRole: role });
});
for (const [name, actor, status, message] of [
  ["no session", null, 401, "Authentication is required."],
  ...["technician", "viewer", "unknown"].map((role) => [role, { uid: "actor", role, mustChangePassword: false }, 403,
    "Only eligible supervisors or admins can resolve handover participants."]),
  ...[true, undefined].map((mustChangePassword) => [`mustChangePassword ${mustChangePassword}`, { uid: "actor", role: "admin", mustChangePassword }, 403,
    "Only eligible supervisors or admins can resolve handover participants."]),
]) test(`route rejects ${name} before persistence`, async () => {
  const f = fixture({ actor }); failure(await f.run(), status, message); assert.equal(f.calls.length, 0);
});
for (const origin of [null, "https://evil.test", "https://example.test/"]) test(`origin ${origin} rejected`, async () => {
  const f = fixture(); failure(await f.run(body(), origin), 403, "Invalid request origin."); assert.equal(f.calls.length, 0);
});
test("configured origin is authoritative", async () => {
  const f = fixture({ env: { APP_ORIGIN: "https://configured.test" } });
  failure(await f.run(), 403, "Invalid request origin."); assert.equal(f.calls.length, 0);
  assert.equal((await f.run(body(), "https://configured.test")).status, 200);
});
test("malformed JSON rejected", async () => {
  const f = fixture(); failure(await f.run(body(), "https://example.test", "outgoing", true), 400, "Invalid resolution JSON."); assert.equal(f.calls.length, 0);
});
const invalid = [
  ...[null, [], "text", 1].map((value) => [`non-object ${JSON.stringify(value)}`, value, "Invalid resolution request."]),
  ...[undefined, "confirm", "ABSENCE", 1].map((operation) => [`operation ${operation}`, { ...body(), operation }, "Invalid resolution operation."]),
  ...["actorUid", "actorRole", "supervisorUid", "position", "recordedAt", "recordedRevision", "revision", "snapshotHash", "password"].map((field) =>
    [`unsupported ${field}`, { ...body(), [field]: "untrusted" }, "Missing or unsupported resolution fields."]),
  ...["operation", "technicianUid", "reason", "expectedRevision", "expectedSnapshotHash"].map((field) => {
    const value = body(); delete value[field]; return [`missing ${field}`, value, field === "operation" ? "Invalid resolution operation." : "Missing or unsupported resolution fields."];
  }),
  ...["", " ", "a/b", ".", "..", "x".repeat(129), 42].map((technicianUid) => [`UID ${JSON.stringify(technicianUid)}`, { ...body(), technicianUid }, "Invalid resolution identifier."]),
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null].map((expectedRevision) => [`revision ${expectedRevision}`, { ...body(), expectedRevision }, "Invalid handover revision or snapshot hash."]),
  ...["A".repeat(64), "a".repeat(63), "z".repeat(64), null].map((expectedSnapshotHash) => [`hash ${expectedSnapshotHash}`, { ...body(), expectedSnapshotHash }, "Invalid handover revision or snapshot hash."]),
  ...["", " \t\n", null, 1].map((reason) => [`reason ${JSON.stringify(reason)}`, { ...body(), reason }, "A non-empty reason is required."]),
  ...["other", "EMERGENCY", null, 1].map((category) => [`category ${category}`, { ...body("exception"), category }, "Invalid supervisor exception category."]),
  ["exception missing category", (() => { const value = body("exception"); delete value.category; return value; })(), "Missing or unsupported resolution fields."],
  ["clear reason", { ...body("clear"), reason: "forbidden" }, "Missing or unsupported resolution fields."],
  ["clear category", { ...body("clear"), category: "unavailable" }, "Missing or unsupported resolution fields."],
  ["absence category", { ...body(), category: "unavailable" }, "Missing or unsupported resolution fields."],
];
for (const [name, value, message] of invalid) test(`strict parser and route reject ${name}`, async () => {
  assert.throws(() => parser(value), (error) => { exactError(error, MockAssignmentOperationError, 400, message); return true; });
  const f = fixture(); failure(await f.run(value), 400, message); assert.equal(f.calls.length, 0);
});
for (const shiftId of ["", " ", "a/b", ".", "..", "x".repeat(513)]) test(`invalid shift ${JSON.stringify(shiftId)} rejected before persistence`, async () => {
  const f = fixture(); failure(await f.run(body(), "https://example.test", shiftId), 400, "Invalid outgoing shift ID."); assert.equal(f.calls.length, 0);
});
test("distinct fixture classes match their own constructors", () => {
  const errors = [new MockAssignmentOperationError("assignment"), new MockHandoverDomainError("domain"), new MockNextShiftAuthorizationDomainError("pair")];
  exactError(errors[0], MockAssignmentOperationError, 409, "assignment");
  exactError(errors[1], MockHandoverDomainError, 409, "domain");
  exactError(errors[2], MockNextShiftAuthorizationDomainError, 409, "pair");
});
test("assignment error mapped with independently fixed expected class", async () => {
  const error = new MockAssignmentOperationError("Actor no longer eligible.", 403);
  exactError(error, MockAssignmentOperationError, 403, "Actor no longer eligible.");
  failure(await fixture({ error }).run(), 403, "Actor no longer eligible.");
});
test("handover error mapped with independently fixed expected class", async () => {
  const error = new MockHandoverDomainError("Conflicting absence; clear it explicitly first.");
  exactError(error, MockHandoverDomainError, 409, "Conflicting absence; clear it explicitly first.");
  failure(await fixture({ error }).run(), 409, error.message);
});
test("pair error mapped with independently fixed expected class", async () => {
  const error = new MockNextShiftAuthorizationDomainError("Permanent pair is invalid.");
  exactError(error, MockNextShiftAuthorizationDomainError, 409, "Permanent pair is invalid.");
  failure(await fixture({ error }).run(), 409, error.message);
});
test("unknown error uses safe generic response and log", async () => {
  const f = fixture({ error: new Error("secret password token cookie") });
  failure(await f.run(), 500, "Unable to resolve handover. Please try again.");
  assert.deepEqual(JSON.parse(JSON.stringify(f.logs)), [["Formal handover resolution failed."]]);
});
test("committed drift response returns review binding with 409", async () => {
  const handover = { revision: 3, snapshotHash: "c".repeat(64) }; const f = fixture({ outcome: { status: "REVIEW_REQUIRED", handover } });
  const result = await f.run(); failure(result, 409, "Handover work changed. Review the updated handover before resolving.");
  assert.deepEqual(result.body.handover, handover); assert.equal(f.calls.length, 1);
});
test("idempotent outcome explicitly returns alreadyResolved", async () => {
  const f = fixture({ outcome: { status: "ALREADY_RESOLVED", handover: { revision: 2, snapshotHash: "b".repeat(64) } } });
  const result = await f.run(); assert.equal(result.status, 200); assert.equal(result.body.alreadyResolved, true);
});
test("work reader precedes domain resolution and no-op with limited writes", () => {
  const work = serviceSource.indexOf("const observedWork = await readAuthoritativeHandoverWorkSnapshot");
  assert.ok(work > serviceSource.indexOf('previousHash !== expectedSnapshotHash'));
  assert.ok(work < serviceSource.indexOf('const resolved ='));
  assert.ok(serviceSource.indexOf('reviseHandoverSnapshot(aggregate') < serviceSource.indexOf('const resolved ='));
  assert.ok(serviceSource.indexOf('const resolved =') < serviceSource.indexOf('status: "ALREADY_RESOLVED"'));
  assert.deepEqual([...serviceSource.matchAll(/transaction\.(set|create|update|delete)\((\w+)/g)].map((match) => match[2]),
    ["handoverRef", "auditRef", "handoverRef", "auditRef"]);
  assert.doesNotMatch(routeSource + serviceSource, /reauthenticatePassword|getAdminAuth|setTimeout|sleep\(/);
  for (const operation of ["recordHandoverAbsence", "recordHandoverException", "clearHandoverResolution"]) assert.match(serviceSource, new RegExp(`${operation}\\(aggregate`));
});
