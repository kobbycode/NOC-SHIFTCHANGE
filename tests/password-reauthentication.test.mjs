import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const helperSource = await readFile(new URL("../src/lib/auth/password-reauthentication.ts", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../src/app/(auth)/api/auth/change-password/route.ts", import.meta.url), "utf8");
const expectedUid = "technician-A";
const email = "authoritative@example.test";
const password = "  secret-current-password  ";
const idToken = "secret-id-token";
const refreshToken = "secret-refresh-token";
const validInput = () => ({ expectedUid, email, password });
const credentialResponse = () => ({ localId: expectedUid, email, idToken, refreshToken, expiresIn: "3600" });
const response = (status = 200, body = credentialResponse()) => ({
  ok: status >= 200 && status < 300, status, async json() { return body; },
});
function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function loadHelper(options = {}) {
  const apiKey = Object.hasOwn(options, "apiKey") ? options.apiKey : "synthetic-test-key";
  const fetch = options.fetch ?? (async () => response());
  const loaded = { exports: {} };
  const imports = [];
  runInNewContext(compile(helperSource), {
    exports: loaded.exports, process: { env: { NEXT_PUBLIC_FIREBASE_API_KEY: apiKey } }, fetch,
    require(specifier) {
      imports.push(specifier);
      if (specifier === "server-only") return {};
      throw new Error(`Unexpected authentication dependency: ${specifier}`);
    },
  });
  return { ...loaded.exports, imports };
}
const helper = loadHelper();
async function rejected(input = validInput(), deps = {}, code = "INVALID_INPUT", status = 400, boundary = helper) {
  await assert.rejects(() => boundary.reauthenticatePassword(input, deps), (error) => {
    assert.ok(error instanceof boundary.PasswordReauthenticationError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}
function errorDetails(error) {
  return JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(error).map(key => [key, error[key]])));
}

test("matching localId succeeds with only the expected UID and does not mutate input", async () => {
  const input = validInput();
  const original = structuredClone(input);
  const result = await helper.reauthenticatePassword(input);
  assert.deepEqual(structuredClone(result), { uid: expectedUid });
  assert.deepEqual(input, original);
  assert.equal("idToken" in result, false);
  assert.equal("refreshToken" in result, false);
  assert.equal("expiresIn" in result, false);
  assert.equal("password" in result, false);
  assert.equal("email" in result, false);
});
test("request uses Identity Toolkit POST JSON no-store, encoded key and exact transient password", async () => {
  const calls = [];
  const apiKey = "key with spaces&?/#=unicode-é";
  await helper.reauthenticatePassword(validInput(), {
    apiKey,
    fetch: async (...args) => { calls.push(args); return response(); },
  });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + encodeURIComponent(apiKey));
  assert.equal(new URL(url).searchParams.get("key"), apiKey);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.cache, "no-store");
  assert.deepEqual(JSON.parse(init.body), { email, password, returnSecureToken: true });
});
test("production defaults use existing environment API key and global server fetch", async () => {
  const calls = [];
  const boundary = loadHelper({ apiKey: "environment-key", fetch: async (...args) => { calls.push(args); return response(); } });
  await boundary.reauthenticatePassword(validInput());
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0][0]).searchParams.get("key"), "environment-key");
  assert.deepEqual(boundary.imports, ["server-only"]);
});
for (const transient of ["x", "   ", "\t\n", "existing-password", "é🔒", "x".repeat(200)]) {
  test(`existing password of length ${transient.length} passes unchanged without new-password policy`, async () => {
    let captured;
    await helper.reauthenticatePassword({ ...validInput(), password: transient }, {
      fetch: async (_, init) => { captured = JSON.parse(init.body).password; return response(); },
    });
    assert.equal(captured, transient);
  });
}
for (const [label, input] of [
  ["empty UID", { ...validInput(), expectedUid: "" }],
  ["whitespace UID", { ...validInput(), expectedUid: "  " }],
  ["noncanonical UID", { ...validInput(), expectedUid: " technician-A " }],
  ["non-string UID", { ...validInput(), expectedUid: 123 }],
  ["empty email", { ...validInput(), email: "" }],
  ["whitespace email", { ...validInput(), email: "  " }],
  ["non-string email", { ...validInput(), email: null }],
  ["empty password", { ...validInput(), password: "" }],
  ["non-string password", { ...validInput(), password: 123 }],
  ["missing password", { expectedUid, email }],
  ["null input", null],
]) test(`${label} fails before a network request`, async () => {
  let calls = 0;
  await rejected(input, { fetch: async () => { calls++; return response(); } });
  assert.equal(calls, 0);
});
for (const apiKey of ["", "   "]) test(`unavailable injected API key ${JSON.stringify(apiKey)} fails closed before fetch`, async () => {
  let calls = 0;
  await rejected(validInput(), { apiKey, fetch: async () => { calls++; return response(); } }, "CONFIGURATION_UNAVAILABLE", 503);
  assert.equal(calls, 0);
});
test("missing environment configuration fails closed before fetch", async () => {
  let calls = 0;
  const missing = loadHelper({ apiKey: undefined, fetch: async () => { calls++; return response(); } });
  await rejected(validInput(), {}, "CONFIGURATION_UNAVAILABLE", 503, missing);
  assert.equal(calls, 0);
});
for (const [status, code, mappedStatus, message] of [
  [400, "CREDENTIAL_REJECTED", 400, "Current password is incorrect or authentication was rejected."],
  [401, "CREDENTIAL_REJECTED", 400, "Current password is incorrect or authentication was rejected."],
  [403, "SERVICE_UNAVAILABLE", 503, "Unable to verify your password. Please try again later."],
  [404, "SERVICE_UNAVAILABLE", 503, "Unable to verify your password. Please try again later."],
  [429, "SERVICE_UNAVAILABLE", 503, "Unable to verify your password. Please try again later."],
  [500, "SERVICE_UNAVAILABLE", 503, "Unable to verify your password. Please try again later."],
  [503, "SERVICE_UNAVAILABLE", 503, "Unable to verify your password. Please try again later."],
]) test(`HTTP ${status} is classified safely without reading or exposing the upstream body`, async () => {
  let bodyReads = 0;
  const fetch = async () => ({ ok: false, status, async json() { bodyReads++; return { password, idToken, refreshToken }; } });
  await assert.rejects(() => helper.reauthenticatePassword(validInput(), { fetch }), error => {
    assert.equal(error.code, code);
    assert.equal(error.status, mappedStatus);
    assert.equal(error.message, message);
    assert.ok(!errorDetails(error).includes(password));
    assert.ok(!errorDetails(error).includes(idToken));
    assert.ok(!errorDetails(error).includes(refreshToken));
    assert.equal("cause" in error, false);
    return true;
  });
  assert.equal(bodyReads, 0);
});
test("network exceptions are sanitized without retaining credentials or raw causes", async () => {
  await assert.rejects(() => helper.reauthenticatePassword(validInput(), {
    fetch: async () => { throw new Error(`${password} ${idToken} ${refreshToken}`); },
  }), error => {
    assert.equal(error.code, "SERVICE_UNAVAILABLE");
    assert.equal(error.status, 503);
    for (const secret of [password, idToken, refreshToken]) assert.ok(!errorDetails(error).includes(secret));
    assert.equal("cause" in error, false);
    return true;
  });
});
test("malformed JSON fails closed without leaking the parse exception", async () => {
  await rejected(validInput(), { fetch: async () => ({ ok: true, status: 200, async json() { throw new Error(password); } }) }, "SERVICE_UNAVAILABLE", 503);
});
for (const [label, body] of [
  ["null", null], ["array", [{ localId: expectedUid }]], ["string", expectedUid], ["number", 123],
  ["missing localId", { idToken, refreshToken }], ["non-string localId", { localId: 123, idToken }],
  ["empty localId", { localId: "", refreshToken }],
  ["inherited localId", Object.create({ localId: expectedUid })],
]) test(`malformed successful response (${label}) is never authentication success`, async () => {
  await rejected(validInput(), { fetch: async () => response(200, body) }, "SERVICE_UNAVAILABLE", 503);
});
for (const localId of ["technician-B", " technician-A", "technician-A ", "Technician-A"]) {
  test(`non-matching localId ${JSON.stringify(localId)} rejects exact identity binding`, async () => {
    await assert.rejects(() => helper.reauthenticatePassword(validInput(), {
      fetch: async () => response(200, { localId, idToken, refreshToken, password }),
    }), error => {
      assert.equal(error.code, "IDENTITY_MISMATCH");
      assert.equal(error.status, 403);
      assert.equal(error.message, "Account verification failed.");
      for (const secret of [password, idToken, refreshToken, localId]) assert.ok(!errorDetails(error).includes(secret));
      return true;
    });
  });
}

// Architectural checks inspect TypeScript nodes rather than relying on layout.
const routeAst = ts.createSourceFile("route.ts", routeSource, ts.ScriptTarget.Latest, true);
function nodes(root) {
  const found = [];
  const visit = node => { found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}
test("change-password imports and invokes the shared server boundary and has no duplicate fetch", () => {
  const all = nodes(routeAst);
  const boundaryImport = all.find(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === "@/lib/auth/password-reauthentication");
  assert.ok(boundaryImport);
  assert.ok(nodes(boundaryImport).some(node => ts.isImportSpecifier(node) && node.name.text === "reauthenticatePassword"));
  assert.equal(all.filter(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "reauthenticatePassword").length, 1);
  assert.ok(!all.some(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch"));
  assert.ok(!all.some(node => ts.isStringLiteral(node) && node.text.includes("accounts:signInWithPassword")));
});

// Execute the route with isolated mocks: no Next server, Firebase mutation,
// network call, real cookies, or real credentials participate in these tests.
function routeFixture(overrides = {}) {
  const events = [];
  const writes = [];
  const logs = [];
  const session = overrides.session === undefined ? { uid: expectedUid, email } : overrides.session;
  let authReads = 0;
  const auth = {
    async getUser(uid) {
      events.push(`auth-read-${++authReads}`);
      assert.equal(uid, expectedUid);
      return authReads === 1
        ? { uid, email, disabled: false, ...overrides.authUser }
        : { uid, email, disabled: false, ...overrides.latestAuthUser };
    },
    async updateUser(uid, data) { events.push("password-update"); writes.push({ kind: "auth", uid, ...data }); },
    async revokeRefreshTokens(uid) { events.push("revoke"); assert.equal(uid, expectedUid); },
  };
  const firestore = {
    collection(name) {
      return { doc(uid) {
        return { collection: name, uid, async get() {
          events.push("profile-recheck");
          return { exists: overrides.profileExists ?? true, data: () => ({ status: overrides.profileStatus ?? "active" }) };
        } };
      } };
    },
    batch() {
      return {
        update(ref, data) { events.push("profile-update"); writes.push({ kind: "profile", ref, data }); },
        set(ref, data) { events.push("audit"); writes.push({ kind: "audit", ref, data }); },
        async commit() { events.push("commit"); },
      };
    },
  };
  const reauthCalls = [];
  const loaded = { exports: {} };
  runInNewContext(compile(routeSource), {
    exports: loaded.exports,
    process: { env: { NEXT_PUBLIC_FIREBASE_API_KEY: overrides.apiKey ?? "synthetic-route-key", NODE_ENV: "production" } },
    console: { error(...args) { logs.push(args); } },
    require(specifier) {
      if (specifier === "next/server") return { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } };
      if (specifier === "next/headers") return { cookies: async () => ({ set(...args) { events.push("clear-session"); writes.push({ kind: "cookie", args }); } }) };
      if (specifier === "@/lib/firebase/admin") return { getAdminAuth: () => auth, getAdminFirestore: () => firestore };
      if (specifier === "@/lib/auth/session") return { getCurrentUser: async () => { events.push("session"); return session; }, SESSION_COOKIE: "__session" };
      if (specifier === "@/lib/auth/password-reauthentication") return {
        PasswordReauthenticationError: helper.PasswordReauthenticationError,
        async reauthenticatePassword(input, dependencies) {
          events.push("reauthenticate"); reauthCalls.push(structuredClone(input));
          return helper.reauthenticatePassword(input, {
            ...dependencies, fetch: overrides.fetch ?? (async () => response()),
          });
        },
      };
      throw new Error(`Unexpected route dependency: ${specifier}`);
    },
  });
  return {
    events, writes, logs, reauthCalls,
    run(bodyOverrides = {}, requestOverrides = {}) {
      return loaded.exports.POST({
        headers: { get: () => overrides.origin ?? "https://app.example.test" },
        nextUrl: { origin: "https://app.example.test" },
        async json() { return { currentPassword: password, newPassword: "New-password-123!", confirmPassword: "New-password-123!", ...bodyOverrides }; },
        ...requestOverrides,
      });
    },
  };
}
test("change-password preserves reauthentication, both account checks, mutation, audit, revocation and session clearing order", async () => {
  const fixture = routeFixture();
  const result = await fixture.run();
  assert.equal(result.status, 200);
  assert.deepEqual(structuredClone(result.body), { success: true, message: "Password changed successfully. Please sign in again." });
  assert.deepEqual(fixture.events, ["session", "auth-read-1", "reauthenticate", "profile-recheck", "auth-read-2",
    "password-update", "revoke", "profile-update", "audit", "commit", "clear-session"]);
  assert.deepEqual(fixture.reauthCalls, [validInput()]);
  assert.equal(fixture.writes.find(w => w.kind === "auth").password, "New-password-123!");
  const profile = fixture.writes.find(w => w.kind === "profile");
  assert.equal(profile.data.mustChangePassword, false);
  assert.equal(new Date(profile.data.passwordChangedAt).toISOString(), profile.data.passwordChangedAt);
  const audit = fixture.writes.find(w => w.kind === "audit");
  assert.equal(audit.data.action, "PASSWORD_CHANGED");
  assert.equal(audit.data.actorUid, expectedUid);
  assert.equal(audit.data.targetUid, expectedUid);
  assert.equal(audit.data.createdAt, profile.data.passwordChangedAt);
  const cookie = fixture.writes.find(w => w.kind === "cookie");
  assert.deepEqual(structuredClone(cookie.args), ["__session", "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 }]);
  for (const secret of [password, idToken, refreshToken]) assert.ok(!JSON.stringify(fixture.writes).includes(secret));
});
for (const [label, overrides, status, message] of [
  ["origin", { origin: "https://other.example.test" }, 403, "Invalid request origin."],
  ["expired session", { session: null }, 401, "Your session has expired. Please sign in again."],
  ["configuration", { apiKey: "" }, 503, "Password changes are temporarily unavailable."],
  ["disabled Auth account", { authUser: { disabled: true } }, 403, "This account cannot change its password."],
  ["missing Auth email", { authUser: { email: null } }, 403, "This account cannot change its password."],
  ["different account email", { authUser: { email: "other@example.test" } }, 403, "This account cannot change its password."],
]) test(`route preserves ${label} guard before reauthentication and writes`, async () => {
  const fixture = routeFixture(overrides);
  const result = await fixture.run();
  assert.equal(result.status, status);
  assert.equal(result.body.error, message);
  assert.equal(fixture.reauthCalls.length, 0);
  assert.equal(fixture.writes.length, 0);
});
for (const [label, overrides] of [
  ["missing profile", { profileExists: false }], ["blocked profile", { profileStatus: "blocked" }],
  ["newly disabled Auth account", { latestAuthUser: { disabled: true } }],
  ["changed authoritative email", { latestAuthUser: { email: "changed@example.test" } }],
]) test(`route post-reauth recheck rejects ${label} without mutation`, async () => {
  const fixture = routeFixture(overrides);
  const result = await fixture.run();
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "This account is no longer active.");
  assert.deepEqual(fixture.events, ["session", "auth-read-1", "reauthenticate", "profile-recheck", "auth-read-2"]);
  assert.equal(fixture.writes.length, 0);
});
for (const [label, body, message] of [
  ["missing current password", { currentPassword: "" }, "All password fields are required."],
  ["short new password", { newPassword: "x".repeat(11) }, "Your new password must contain between 12 and 128 characters."],
  ["overlong new password", { newPassword: "x".repeat(129) }, "Your new password must contain between 12 and 128 characters."],
  ["confirmation mismatch", { confirmPassword: "different" }, "The new passwords do not match."],
  ["unchanged password", { newPassword: password, confirmPassword: password }, "Choose a password different from your current password."],
]) test(`route preserves ${label} validation`, async () => {
  const fixture = routeFixture();
  const result = await fixture.run(body);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, message);
  assert.equal(fixture.reauthCalls.length, 0);
  assert.equal(fixture.writes.length, 0);
});
for (const length of [12, 128]) test(`new-password boundary length ${length} remains accepted`, async () => {
  const fixture = routeFixture();
  const newPassword = "n".repeat(length);
  const result = await fixture.run({ newPassword, confirmPassword: newPassword });
  assert.equal(result.status, 200);
  assert.equal(fixture.writes.find(w => w.kind === "auth").password, newPassword);
});
for (const [label, fetch, status, message] of [
  ["credential rejection", async () => response(400), 400, "Current password is incorrect or authentication was rejected."],
  ["401 rejection", async () => response(401), 400, "Current password is incorrect or authentication was rejected."],
  ["UID mismatch", async () => response(200, { localId: "technician-B", idToken }), 403, "Account verification failed."],
  ["upstream failure", async () => response(500), 503, "Unable to verify your password. Please try again later."],
  ["network exception", async () => { throw new Error(password); }, 503, "Unable to verify your password. Please try again later."],
  ["malformed response", async () => response(200, null), 503, "Unable to verify your password. Please try again later."],
]) test(`route maps ${label} safely and stops before account recheck or mutation`, async () => {
  const fixture = routeFixture({ fetch });
  const result = await fixture.run();
  assert.equal(result.status, status);
  assert.equal(result.body.error, message);
  assert.deepEqual(fixture.events, ["session", "auth-read-1", "reauthenticate"]);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.logs.length, 0);
  assert.ok(!JSON.stringify(result).includes(password));
  assert.ok(!JSON.stringify(result).includes(idToken));
});


test("expected identity is captured before await and cannot change during the credential request", async () => {
  const input = validInput();
  const result = await helper.reauthenticatePassword(input, {
    fetch: async (_, init) => {
      assert.deepEqual(JSON.parse(init.body), { email, password, returnSecureToken: true });
      // Simulate an external caller changing its own object while fetch awaits.
      input.expectedUid = "technician-B";
      input.email = "different@example.test";
      input.password = "different-password";
      return response();
    },
  });
  assert.deepEqual(structuredClone(result), { uid: expectedUid });
});
