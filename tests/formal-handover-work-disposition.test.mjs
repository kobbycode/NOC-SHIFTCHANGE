import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const service = await readFile(new URL("../src/lib/operations/formal-handover-work-disposition.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/work/[taskId]/disposition/route.ts", import.meta.url), "utf8");
async function productionErrorConstructor(modulePath, name) {
  const source = await readFile(new URL(modulePath, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements.filter(statement => ts.isClassDeclaration(statement) && statement.name?.text === name);
  assert.equal(declarations.length, 1);
  return compile(declarations[0].getText(parsed), dependency => { throw new Error(`Unexpected error-class dependency ${dependency}`); })[name];
}
const AssignmentOperationError = await productionErrorConstructor("../src/lib/operations/assignment-transaction.ts", "AssignmentOperationError");
const HandoverDomainError = await productionErrorConstructor("../src/lib/operations/handover-domain.ts", "HandoverDomainError");
const NextShiftAuthorizationDomainError = await productionErrorConstructor("../src/lib/operations/next-shift-authorization-domain.ts", "NextShiftAuthorizationDomainError");
const classes = [AssignmentOperationError, HandoverDomainError, NextShiftAuthorizationDomainError];
function exact(error, Class, status, message) {
  for (const sibling of classes) assert.equal(error instanceof sibling, sibling === Class);
  assert.equal(error.status, status); assert.equal(error.message, message);
}
function compile(source, require, extra = {}) {
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require, ...extra }); return exports;
}
const parse = compile(service, name => name.endsWith("/assignment-transaction") ? { AssignmentOperationError } : {}).parseFormalHandoverWorkDispositionRequest;
const body = (operation = "classify") => ({ operation, reason: "  Reviewed operational reason  ", expectedRevision: 1, expectedSnapshotHash: "a".repeat(64),
  ...(operation === "classify" ? { disposition: "carry_forward" } : {}) });
function fixture(options = {}) {
  const calls = [], logs = [];
  const actor = Object.hasOwn(options, "actor") ? options.actor : { uid: "trusted", role: "admin", mustChangePassword: false };
  const exports = compile(route, name => {
    if (name === "server-only") return {};
    if (name === "next/server") return { NextResponse: { json: (body, init) => ({ body, ...init }) } };
    if (name.endsWith("/session")) return { getCurrentUser: async () => actor };
    if (name.endsWith("/formal-handover-work-disposition")) return { parseFormalHandoverWorkDispositionRequest: parse,
      persistFormalHandoverWorkDisposition: async input => { calls.push(input); if (options.error) throw options.error;
        return options.outcome ?? { status: "CLASSIFIED", handover: { revision: 2, snapshotHash: "b".repeat(64) } }; } };
    if (name.endsWith("/assignment-transaction")) return { AssignmentOperationError };
    if (name.endsWith("/next-shift-authorization-domain")) return { NextShiftAuthorizationDomainError };
    if (name.endsWith("/handover-domain")) return { HandoverDomainError, createHandoverDocumentId: id => {
      if (!id || id.includes("/") || id.trim() !== id || [".", ".."].includes(id) || id.length > 512) {
        const error = new HandoverDomainError("Invalid outgoing shift ID.", 400); exact(error, HandoverDomainError, 400, error.message); throw error;
      } return `handover_${id}`;
    } };
    if (name.endsWith("/handover-work-disposition-domain")) return { createHandoverWorkDispositionDocumentId: input => {
      if (!input.taskId || input.taskId.includes("/") || input.taskId.trim() !== input.taskId || [".", ".."].includes(input.taskId) || input.taskId.length > 512) {
        const error = new HandoverDomainError("Malformed authoritative handover disposition; administrator review required."); exact(error, HandoverDomainError, 409, error.message); throw error;
      } return "deterministic-id";
    } };
    throw new Error(`Unexpected dependency ${name}`);
  }, { process: { env: options.env ?? {} }, console: { error: (...args) => logs.push(args) } });
  return { calls, logs, run: (value = body(), origin = "https://example.test", shiftId = "outgoing", taskId = "task", badJson = false) => exports.POST({
    nextUrl: { origin: "https://example.test" }, headers: { get: () => origin }, json: async () => { if (badJson) throw new Error("bad json"); return value; },
  }, { params: Promise.resolve({ shiftId, taskId }) }) };
}
function failure(result, status, message) {
  assert.equal(result.status, status); assert.deepEqual(JSON.parse(JSON.stringify(result.body)), { success: false, error: message });
  assert.equal(result.headers["Cache-Control"], "no-store");
}
for (const role of ["admin", "supervisor"]) for (const operation of ["classify", "clear"]) test(`${role} ${operation} projects only reviewed input and trusted UID`, async () => {
  const f = fixture({ actor: { uid: "trusted", role, mustChangePassword: false } }); const result = await f.run(body(operation));
  assert.equal(result.status, 200); assert.equal(result.body.success, true); assert.equal(result.headers["Cache-Control"], "no-store");
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [{ ...body(operation), reason: "Reviewed operational reason", outgoingShiftId: "outgoing", taskId: "task", actorUid: "trusted" }]);
});
const invalid = [
  ...[null, [], 1, "bad"].map(value => ["non-object", value, "Invalid disposition request."]),
  ...[undefined, "change", "CLASSIFY"].map(operation => ["operation", { ...body(), operation }, "Invalid disposition operation."]),
  ...["actorUid", "actorRole", "classifierRole", "classifiedAt", "recordedRevision", "reviewedSnapshotHash", "classifiedTaskWorkHash", "password"].map(field =>
    [field, { ...body(), [field]: "forged" }, "Missing or unsupported disposition fields."]),
  ...["reason", "expectedRevision", "expectedSnapshotHash", "disposition"].map(field => {
    const value = body(); delete value[field]; return [`missing ${field}`, value, "Missing or unsupported disposition fields."];
  }),
  ...["", "short", " ", "x".repeat(1001), null, 1].map(reason => ["reason", { ...body(), reason }, "Provide a disposition reason between 10 and 1000 characters."]),
  ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map(expectedRevision => ["revision", { ...body(), expectedRevision }, "Invalid handover revision or snapshot hash."]),
  ...[null, "A".repeat(64), "a".repeat(63), "g".repeat(64)].map(expectedSnapshotHash => ["hash", { ...body(), expectedSnapshotHash }, "Invalid handover revision or snapshot hash."]),
  ...["unclassified", "CARRY_FORWARD", null, 1].map(disposition => ["value", { ...body(), disposition }, "Invalid work disposition."]),
  ["clear value", { ...body("clear"), disposition: "carry_forward" }, "Missing or unsupported disposition fields."],
];
for (const [name, value, message] of invalid) test(`strict parser/route rejects ${name} ${JSON.stringify(value)}`, async () => {
  assert.throws(() => parse(value), error => { exact(error, AssignmentOperationError, 400, message); return true; });
  const f = fixture(); failure(await f.run(value), 400, message); assert.equal(f.calls.length, 0);
});
for (const [actor, status, message] of [[null, 401, "Authentication is required."],
  ...["technician", "viewer"].map(role => [{ role, mustChangePassword: false }, 403, "Only eligible supervisors or admins can classify handover work."]),
  ...[true, undefined].map(mustChangePassword => [{ role: "admin", mustChangePassword }, 403, "Only eligible supervisors or admins can classify handover work."])]) {
  test(`session rejected ${JSON.stringify(actor)}`, async () => { const f = fixture({ actor }); failure(await f.run(), status, message); assert.equal(f.calls.length, 0); });
}
for (const origin of [null, "https://evil.test", "https://example.test/"]) test(`origin ${origin} rejected`, async () => {
  const f = fixture(); failure(await f.run(body(), origin), 403, "Invalid request origin."); assert.equal(f.calls.length, 0);
});
test("configured origin and invalid JSON fail before persistence", async () => {
  const f = fixture({ env: { APP_ORIGIN: "https://configured.test" } }); failure(await f.run(), 403, "Invalid request origin."); assert.equal(f.calls.length, 0);
  const g = fixture(); failure(await g.run(body(), undefined, undefined, undefined, true), 400, "Invalid disposition JSON."); assert.equal(g.calls.length, 0);
});
for (const value of ["", " leading", ".", "..", "a/b", "x".repeat(513)]) test(`path task validation ${value.slice(0, 12)}`, async () => {
  const f = fixture(); failure(await f.run(body(), undefined, undefined, value), 409, "Malformed authoritative handover disposition; administrator review required."); assert.equal(f.calls.length, 0);
});
for (const scenario of [
  { name: "AssignmentOperationError", createInjectedError: () => new AssignmentOperationError("Actor no longer eligible.", 403),
    ExpectedClass: AssignmentOperationError, expectedStatus: 403, expectedMessage: "Actor no longer eligible." },
  { name: "HandoverDomainError", createInjectedError: () => new HandoverDomainError("Disposition requires review.", 409),
    ExpectedClass: HandoverDomainError, expectedStatus: 409, expectedMessage: "Disposition requires review." },
  { name: "NextShiftAuthorizationDomainError", createInjectedError: () => new NextShiftAuthorizationDomainError("Permanent pair is invalid.", 409),
    ExpectedClass: NextShiftAuthorizationDomainError, expectedStatus: 409, expectedMessage: "Permanent pair is invalid." },
]) test(`mapped ${scenario.name} has independently fixed class/status/message`, async () => {
  assert.notEqual(AssignmentOperationError, HandoverDomainError);
  assert.notEqual(AssignmentOperationError, NextShiftAuthorizationDomainError);
  assert.notEqual(HandoverDomainError, NextShiftAuthorizationDomainError);
  const error = scenario.createInjectedError();
  exact(error, scenario.ExpectedClass, scenario.expectedStatus, scenario.expectedMessage);
  failure(await fixture({ error }).run(), scenario.expectedStatus, scenario.expectedMessage);
});
test("unknown error uses safe generic 500 without raw credential payload", async () => {
  const f = fixture({ error: new Error("secret password token cookie") }); failure(await f.run(), 500, "Unable to update handover work disposition. Please try again.");
  assert.deepEqual(JSON.parse(JSON.stringify(f.logs)), [["Formal handover work disposition failed."]]);
});
for (const status of ["ALREADY_CLASSIFIED", "ALREADY_UNCLASSIFIED", "CLEARED"]) test(`explicit outcome ${status}`, async () => {
  const f = fixture({ outcome: { status, handover: { revision: 2, snapshotHash: "b".repeat(64) } } });
  const result = await f.run(); assert.equal(result.status, 200); assert.equal(result.body.status, status);
});
test("committed reconciliation produces 409 with new binding", async () => {
  const handover = { revision: 2, snapshotHash: "b".repeat(64) };
  const result = await fixture({ outcome: { status: "REVIEW_REQUIRED", handover } }).run();
  assert.equal(result.status, 409); assert.equal(result.body.success, false);
  assert.equal(result.body.error, "Handover work changed. Review the updated handover before classifying.");
  assert.deepEqual(result.body.handover, handover); assert.equal(result.headers["Cache-Control"], "no-store");
});
test("persistence recomputes before no-op; only disposition, aggregate and audit writes", () => {
  assert.ok(service.indexOf("const observedWork") < service.indexOf('status: classified ? "ALREADY_CLASSIFIED"'));
  const targets = [...service.matchAll(/transaction\.(set|create|update|delete)\((\w+)/g)].map(match => match[2]);
  assert.deepEqual(targets, ["handoverRef", "auditRef", "dispositionRef", "dispositionRef", "handoverRef", "auditRef"]);
  assert.doesNotMatch(service + route, /reauthenticatePassword|transferOperationalShiftControl|markAssignmentActivity|setTimeout|sleep\(/);
});
