import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const routeSource = await readFile(new URL("../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/confirmation/route.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../src/lib/operations/formal-handover-confirmation.ts", import.meta.url), "utf8");
const reservationSource = await readFile(new URL("../src/lib/operations/formal-handover.ts", import.meta.url), "utf8");
// Match production constructor signatures and public fields without importing
// server-only persistence dependencies into this isolated route fixture.
class MockPasswordReauthenticationError extends Error {
  constructor(code) {
    const failures = {
      INVALID_INPUT: [400, "Invalid password verification input."],
      CONFIGURATION_UNAVAILABLE: [503, "Password changes are temporarily unavailable."],
      CREDENTIAL_REJECTED: [400, "Current password is incorrect or authentication was rejected."],
      IDENTITY_MISMATCH: [403, "Account verification failed."],
      SERVICE_UNAVAILABLE: [503, "Unable to verify your password. Please try again later."],
    };
    const [status, message] = failures[code];
    super(message); this.name = "PasswordReauthenticationError"; this.code = code; this.status = status;
  }
}
class MockAssignmentOperationError extends Error {
  constructor(message, status) { super(message); this.name = "AssignmentOperationError"; this.status = status; }
}
class MockHandoverDomainError extends Error {
  constructor(message, status = 409) { super(message); this.name = "HandoverDomainError"; this.status = status; }
}
class MockNextShiftAuthorizationDomainError extends Error {
  constructor(message, status = 409) { super(message); this.name = "NextShiftAuthorizationDomainError"; this.status = status; }
}
const errorExports = {
  PasswordReauthenticationError: MockPasswordReauthenticationError,
  AssignmentOperationError: MockAssignmentOperationError,
  HandoverDomainError: MockHandoverDomainError,
  NextShiftAuthorizationDomainError: MockNextShiftAuthorizationDomainError,
};
function assertExactInjectedErrorClass(error, ExpectedClass) {
  assert.ok(error instanceof ExpectedClass, `injected error must be ${ExpectedClass.name}`);
  for (const SiblingClass of Object.values(errorExports)) {
    if (SiblingClass !== ExpectedClass) assert.equal(error instanceof SiblingClass, false);
  }
}
const body = () => ({ password: "  synthetic credential  ", expectedRevision: 1, expectedSnapshotHash: "a".repeat(64) });
function fixture(options = {}) {
  const calls = [], logs = [];
  const actor = Object.hasOwn(options, "actor") ? options.actor : { uid: "actor", email: "actor@example.test", role: "technician", mustChangePassword: false };
  const account = { uid: "actor", email: "actor@example.test", disabled: false, ...options.account };
  const confirmation = { technicianUid: "actor", position: "incoming_primary_a", revision: 1, snapshotHash: "a".repeat(64), confirmedAt: "2030-01-01T00:00:00.000Z" };
  const outcome = options.outcome ?? { status: "CONFIRMED", confirmation, handover: { revision: 1, snapshotHash: "a".repeat(64) } };
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: loaded.exports, process: { env: options.env ?? {} }, console: { error: (...args) => logs.push(args) },
    require(name) {
      if (name === "server-only") return {};
      if (name === "next/server") return { NextResponse: { json: (body, init) => ({ body, ...init }) } };
      if (name.endsWith("/session")) return { getCurrentUser: async () => actor };
      if (name.endsWith("/admin")) return { getAdminAuth: () => ({ getUser: async (uid) => {
        calls.push(["auth", uid]); if (options.authError) throw options.authError;
        return calls.filter(([kind]) => kind === "auth").length === 1 ? account : { ...account, ...options.recheck };
      } }) };
      if (name.endsWith("/password-reauthentication")) return { PasswordReauthenticationError: errorExports.PasswordReauthenticationError,
        reauthenticatePassword: async (input) => { calls.push(["reauth", input]); if (options.reauthError) throw options.reauthError; return { uid: "actor" }; } };
      if (name.endsWith("/formal-handover-confirmation")) return { persistFormalHandoverConfirmation: async (input) => {
        calls.push(["persist", input]); if (options.persistError) throw options.persistError; return outcome;
      } };
      if (name.endsWith("/handover-domain")) return { HandoverDomainError: errorExports.HandoverDomainError, createHandoverDocumentId(id) {
        if (typeof id !== "string" || !id || id.trim() !== id || id.includes("/") || [".", ".."].includes(id) || id.length > 512) {
          const injectedError = new MockHandoverDomainError("Invalid shift.", 400);
          assertExactInjectedErrorClass(injectedError, MockHandoverDomainError);
          throw injectedError;
        }
        return `handover_${id}`;
      } };
      if (name.endsWith("/assignment-transaction")) return { AssignmentOperationError: errorExports.AssignmentOperationError };
      if (name.endsWith("/next-shift-authorization-domain")) return { NextShiftAuthorizationDomainError: errorExports.NextShiftAuthorizationDomainError };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const run = async (value = body(), origin = "https://example.test", shiftId = "outgoing", malformed = false) => {
    const result = await loaded.exports.POST({
    nextUrl: { origin: "https://example.test" }, headers: { get: () => origin }, json: async () => {
      if (malformed) throw new Error("Invalid JSON"); return value;
    },
    }, { params: Promise.resolve({ shiftId }) });
    if (result.status >= 400) {
      assert.equal(result.body.success, false);
      assert.equal(typeof result.body.error, "string");
      assert.ok(result.body.error.length > 0);
      assert.equal(Object.hasOwn(result.body, "confirmation"), false);
      assert.equal(result.headers["Cache-Control"], "no-store");
    }
    return result;
  };
  return { run, calls, logs };
}
test("route error fixture preserves production error-class distinctions", () => {
  const entries = Object.entries(errorExports);
  const instances = [new MockPasswordReauthenticationError("CREDENTIAL_REJECTED"),
    new MockAssignmentOperationError("Assignment conflict.", 409), new MockHandoverDomainError("Handover conflict."),
    new MockNextShiftAuthorizationDomainError("Authorization conflict.")];
  for (let i = 0; i < entries.length; i++) {
    assert.equal(instances[i].name, entries[i][0]);
    for (let j = 0; j < entries.length; j++) {
      assert.equal(instances[i] instanceof entries[j][1], i === j);
      if (i < j) assert.notEqual(entries[i][1], entries[j][1]);
    }
  }
  assert.equal(instances[0].code, "CREDENTIAL_REJECTED");
  assert.equal(instances[0].status, 400);
  assert.equal(instances[0].message, "Current password is incorrect or authentication was rejected.");
});
for (const [name, actor, status] of [["unauthenticated", null, 401], ["admin", { role: "admin" }, 403],
  ["supervisor", { role: "supervisor" }, 403], ["initial password", { role: "technician", mustChangePassword: true }, 403]]) {
  test(`route rejects ${name}`, async () => { const f = fixture({ actor }); assert.equal((await f.run()).status, status); assert.equal(f.calls.length, 0); });
}
for (const origin of [null, "https://attacker.test"]) test(`route rejects origin ${origin}`, async () => {
  const f = fixture(); assert.equal((await f.run(body(), origin)).status, 403); assert.equal(f.calls.length, 0);
});
test("configured origin enforced", async () => { const f = fixture({ env: { APP_ORIGIN: "https://configured.test" } }); assert.equal((await f.run()).status, 403); assert.equal(f.calls.length, 0); });
for (const shift of ["", " space", "../shift", ".", "..", "a".repeat(513)]) test(`invalid route shift ${shift.length}`, async () => {
  const f = fixture(); assert.equal((await f.run(body(), undefined, shift)).status, 400); assert.equal(f.calls.length, 0);
});
for (const value of [null, [], "bad", {}, ...["password", "expectedRevision", "expectedSnapshotHash"].map((key) => {
  const value = body(); delete value[key]; return value;
}), ...["actorUid", "technicianUid", "position", "side", "confirmedAt", "extra"].map((key) => ({ ...body(), [key]: "forged" })),
...["", null, 123].map((password) => ({ ...body(), password })),
...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, null].map((expectedRevision) => ({ ...body(), expectedRevision })),
...["A".repeat(64), "a".repeat(63), "g".repeat(64), null].map((expectedSnapshotHash) => ({ ...body(), expectedSnapshotHash }))]) {
  test(`exact body rejects ${JSON.stringify(value)}`, async () => { const f = fixture(); assert.equal((await f.run(value)).status, 400); assert.equal(f.calls.length, 0); });
}
test("malformed JSON rejected", async () => { const f = fixture(); assert.equal((await f.run(body(), undefined, undefined, true)).status, 400); assert.equal(f.calls.length, 0); });
for (const password of ["  synthetic credential  ", " ", "x", "é\u0301"]) test(`password passed verbatim (${JSON.stringify(password)})`, async () => {
  const f = fixture(); const result = await f.run({ ...body(), password });
  assert.equal(result.status, 200); assert.deepEqual(f.calls.map(([kind]) => kind), ["auth", "reauth", "auth", "persist"]);
  assert.equal(f.calls[1][1].password, password); assert.equal(f.calls[1][1].expectedUid, "actor");
  assert.equal(f.calls[1][1].email, "actor@example.test");
  assert.deepEqual(Object.keys(f.calls[3][1]).sort(), ["actorUid", "expectedRevision", "expectedSnapshotHash", "outgoingShiftId"]);
  assert.equal(f.calls[3][1].actorUid, "actor"); assert.equal(f.calls[3][1].outgoingShiftId, "outgoing");
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(JSON.stringify(result).includes('"password"'), false); assert.deepEqual(f.logs, []);
});
for (const [name, code, status, message] of [
  ["wrong password", "CREDENTIAL_REJECTED", 400, "Current password is incorrect or authentication was rejected."],
  ["UID mismatch", "IDENTITY_MISMATCH", 403, "Account verification failed."],
  ["unavailable", "SERVICE_UNAVAILABLE", 503, "Unable to verify your password. Please try again later."],
]) {
  const reauthError = new MockPasswordReauthenticationError(code);
  test(`${name} prevents persistence`, async () => {
    assertExactInjectedErrorClass(reauthError, MockPasswordReauthenticationError);
    const f = fixture({ reauthError }); const result = await f.run();
    assert.equal(reauthError.code, code); assert.equal(result.status, status); assert.equal(result.body.error, message);
    assert.deepEqual(f.calls.map(([kind]) => kind), ["auth", "reauth"]);
    assert.equal(JSON.stringify(result).includes(body().password), false);
    assert.equal(f.calls.filter(([kind]) => kind === "persist").length, 0); assert.deepEqual(f.logs, []); });
}
for (const account of [{ disabled: true }, { email: undefined }, { uid: "other" }, { email: "other@example.test" }]) {
  test(`invalid Auth account ${JSON.stringify(account)}`, async () => { const f = fixture({ account }); assert.equal((await f.run()).status, 403); assert.equal(f.calls.length, 1); });
}
for (const recheck of [{ disabled: true }, { email: "changed@example.test" }, { email: undefined }, { uid: "other" }]) {
  test(`post-reauth Auth drift ${JSON.stringify(recheck)}`, async () => { const f = fixture({ recheck }); assert.equal((await f.run()).status, 403); assert.equal(f.calls.length, 3); });
}
test("missing Auth account maps to safe 403", async () => { const f = fixture({ authError: { code: "auth/user-not-found" } }); assert.equal((await f.run()).status, 403); assert.equal(f.calls.filter(([kind]) => kind === "persist").length, 0); });
test("unknown upstream failure does not leak credentials into response/logs", async () => {
  const marker = body().password; const f = fixture({ reauthError: new Error(marker) }); const result = await f.run();
  assert.equal(result.status, 500); assert.equal(JSON.stringify([result, f.logs]).includes(marker), false); assert.equal(f.calls.some(([kind]) => kind === "persist"), false);
  assert.equal(result.body.error, "Unable to confirm handover. Please try again.");
  assert.deepEqual(f.logs, [["Formal handover confirmation failed."]]);
});
test("typed transaction conflict retained", async () => {
  const injectedError = new MockAssignmentOperationError("Stale handover.", 409);
  assertExactInjectedErrorClass(injectedError, MockAssignmentOperationError);
  const f = fixture({ persistError: injectedError });
  const result = await f.run(); assert.equal(result.status, 409); assert.equal(result.body.error, "Stale handover.");
  assert.deepEqual(f.calls.map(([kind]) => kind), ["auth", "reauth", "auth", "persist"]);
  assert.equal(f.calls.filter(([kind]) => kind === "persist").length, 1); assert.deepEqual(f.logs, []);
});
test("MockHandoverDomainError retains its mapped persistence response", async () => {
  const injectedError = new MockHandoverDomainError("Conflicting participant resolution.");
  assertExactInjectedErrorClass(injectedError, MockHandoverDomainError);
  const f = fixture({ persistError: injectedError }); const result = await f.run();
  assert.equal(result.status, 409); assert.equal(result.body.error, "Conflicting participant resolution.");
  assert.deepEqual(f.calls.map(([kind]) => kind), ["auth", "reauth", "auth", "persist"]);
  assert.equal(f.calls.filter(([kind]) => kind === "persist").length, 1); assert.deepEqual(f.logs, []);
});
test("MockNextShiftAuthorizationDomainError retains its mapped persistence response", async () => {
  const injectedError = new MockNextShiftAuthorizationDomainError("The permanent pair requires review.");
  assertExactInjectedErrorClass(injectedError, MockNextShiftAuthorizationDomainError);
  const f = fixture({ persistError: injectedError }); const result = await f.run();
  assert.equal(result.status, 409); assert.equal(result.body.error, "The permanent pair requires review.");
  assert.deepEqual(f.calls.map(([kind]) => kind), ["auth", "reauth", "auth", "persist"]);
  assert.equal(f.calls.filter(([kind]) => kind === "persist").length, 1); assert.deepEqual(f.logs, []);
});
test("committed work revision becomes review-required response", async () => {
  const f = fixture({ outcome: { status: "REVIEW_REQUIRED", handover: { revision: 2, snapshotHash: "b".repeat(64) } } });
  const result = await f.run(); assert.equal(result.status, 409); assert.equal(result.body.success, false); assert.equal(result.body.handover.revision, 2);
  assert.equal(result.body.handover.snapshotHash, "b".repeat(64)); assert.equal(Object.hasOwn(result.body, "confirmation"), false);
});
test("idempotent outcome returns success", async () => {
  const f = fixture({ outcome: { status: "ALREADY_CONFIRMED", confirmation: { technicianUid: "actor" }, handover: { revision: 1, snapshotHash: "a".repeat(64) } } });
  const result = await f.run(); assert.equal(result.status, 200); assert.equal(result.body.alreadyConfirmed, true);
});
test("route reuses A7.4 boundary without a competing Identity Toolkit request", () => {
  assert.match(routeSource, /await reauthenticatePassword\(/); assert.doesNotMatch(routeSource, /identitytoolkit|signInWithPassword|fetch\(/);
});
test("persistence input has only trusted identity and reviewed binding", () => {
  assert.doesNotMatch(serviceSource, /password|refreshToken|idToken|sessionCookie/i);
  assert.match(serviceSource, /evaluateAssignmentEligibility\(actorSnapshot.data\(\)\)/);
  assert.doesNotMatch(serviceSource, /requireEligibleTechnician/);
});
test("shared work reader preserves all-task query and per-task assignment reads", () => {
  assert.match(serviceSource, /readAuthoritativeHandoverWorkSnapshot\(transaction, outgoingShiftId\)/);
  assert.match(reservationSource, /export async function readAuthoritativeHandoverWorkSnapshot/);
  const reader = reservationSource.slice(reservationSource.indexOf("export async function readAuthoritative"), reservationSource.indexOf("function scheduleEntries"));
  assert.match(reader, /tasks.where\("shiftId", "==", outgoingShiftId\)/); assert.match(reader, /taskAssignments.where\("taskId", "==", document.id\)/);
  assert.doesNotMatch(reader, /where\("status"/);
});
test("only aggregate and audit writes exist; later-stage persistence absent", () => {
  const writes = [...serviceSource.matchAll(/transaction\.(set|create|update|delete)\((\w+)/g)].map((match) => match[2]);
  assert.deepEqual(writes, ["handoverRef", "auditRef", "handoverRef", "auditRef"]);
  assert.doesNotMatch(serviceSource, /recordHandoverAbsence|recordHandoverException|transferOperationalShiftControl|markAssignmentActivity/);
  assert.match(serviceSource, /return \{ status: "REVIEW_REQUIRED"/);
});
