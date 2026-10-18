import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/app/(dashboard)/api/admin/users/route.ts", import.meta.url), "utf8");
function fixture(overrides = {}) {
  const writes = [], authCalls = [], provisioningCalls = [], loaded = { exports: {} };
  const session = overrides.session === undefined
    ? { uid: "administrator", role: "admin", mustChangePassword: false }
    : overrides.session;
  const adminProfile = "adminProfile" in overrides
    ? overrides.adminProfile
    : {
      status: "active",
      role: "admin",
      mustChangePassword: false,
    };
  const adminAccount = overrides.adminAccount ?? { disabled: false };
  let listReads = 0;
  const auth = {
    getUser: async () => adminAccount,
    createUser: async input => { authCalls.push(input); provisioningCalls.push("createUser"); return { uid: "new-account" }; },
    setCustomUserClaims: async () => { provisioningCalls.push("setCustomUserClaims"); },
    updateUser: async () => { provisioningCalls.push("updateUser"); },
    deleteUser: async () => { provisioningCalls.push("deleteUser"); },
  };
  const db = {
    collection(name) {
      return {
        doc(id = "audit") {
          return {
            path: `${name}/${id}`,
            id,
            get: async () => ({
              exists: adminProfile !== null,
              data: () => adminProfile ?? undefined,
            }),
          };
        },
        get: async () => {
          listReads += 1;
          return {
            docs: (overrides.listedUsers ?? []).map(user => ({
              id: user.uid,
              data: () => user,
            })),
          };
        },
      };
    },
    batch() {
      return {
        create(ref, data) { writes.push({ path: ref.path, data }); },
        commit: async () => {},
      };
    },
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: loaded.exports, console: { error() {} },
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } };
      if (name === "firebase-admin/firestore") return { FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" } };
      if (name.endsWith("/firebase/admin")) return { getAdminAuth: () => auth, getAdminFirestore: () => db };
      if (name.endsWith("/auth/session")) return { getCurrentUser: async () => session };
      if (name.endsWith("/types/auth")) return { isUserRole: role => ["admin", "supervisor", "technician"].includes(role) };
      if (name.endsWith("/errors/messages")) return { getErrorMessage: key => key, getFirebaseErrorMessage: () => "error" };
      throw new Error(name);
    },
  });
  const request = (role, origin = "https://demo.test") => ({
    headers: { get: () => origin },
    nextUrl: { origin: "https://demo.test" },
    json: async () => ({ fullName: "Demo Technician", email: "demo@example.test", password: "synthetic-initial-password", role }),
  });
  return {
    writes,
    authCalls,
    provisioningCalls,
    get listReads() { return listReads; },
    async create(role, origin = "https://demo.test") {
      return loaded.exports.POST(request(role, origin));
    },
    async list() {
      return loaded.exports.GET();
    },
  };
}
for (const role of ["technician", "supervisor", "admin"]) test(`administrator provisions ${role} with explicit inactive cleanup state and mandatory password change`, async () => {
  const f = fixture(), result = await f.create(role); assert.equal(result.status, 201);
  const profile = f.writes.find(write => write.path === "users/new-account").data;
  assert.equal(Object.hasOwn(profile, "statusOperation"), true); assert.equal(profile.statusOperation, null);
  assert.equal(profile.mustChangePassword, true); assert.equal(profile.status, "active"); assert.equal(profile.createdBy, "administrator"); assert.equal(profile.role, role);
  assert.equal(f.authCalls[0].disabled, true);
  assert.ok(!JSON.stringify({ writes: f.writes, response: result }).includes("synthetic-initial-password"));
});
test("unverified request origin cannot provision an account or profile", async () => {
  const f = fixture(); assert.equal((await f.create("technician", "https://other.test")).status, 403); assert.equal(f.writes.length, 0); assert.equal(f.authCalls.length, 0);
});
test("GET does not list users for an administrator who must change their password", async () => {
  const f = fixture({ session: { uid: "administrator", role: "admin", mustChangePassword: true } });
  const result = await f.list();
  assert.equal(result.status, 403);
  assert.equal(f.listReads, 0);
  assert.equal(f.writes.length, 0);
});
test("POST does not provision an account for an administrator who must change their password", async () => {
  const f = fixture({ session: { uid: "administrator", role: "admin", mustChangePassword: true } });
  const result = await f.create("technician");
  assert.equal(result.status, 403);
  assert.equal(f.provisioningCalls.length, 0);
  assert.equal(f.writes.length, 0);
});
test("POST rejects the fresh administrator profile if password change is still required", async () => {
  const f = fixture({ adminProfile: { status: "active", role: "admin", mustChangePassword: true } });
  const result = await f.create("technician");
  assert.equal(result.status, 403);
  assert.equal(f.provisioningCalls.length, 0);
  assert.equal(f.writes.length, 0);
});
// A session minted while the account was unrestricted must not outrank the profile.
for (const [label, adminProfile] of [
  ["blocked", { status: "blocked", role: "admin", mustChangePassword: false }],
  ["revoked", { status: "revoked", role: "admin", mustChangePassword: false }],
  ["carrying a pending account-status operation", { status: "active", role: "admin", mustChangePassword: false, statusOperation: "BLOCK_REQUESTED" }],
  ["no longer an administrator", { status: "active", role: "supervisor", mustChangePassword: false }],
  ["missing", null],
]) {
  test(`POST rejects a fresh administrator profile that is ${label} before any provisioning call`, async () => {
    const f = fixture({ adminProfile });
    assert.equal((await f.create("technician")).status, 403);
    assert.equal(f.provisioningCalls.length, 0);
    assert.equal(f.authCalls.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.listReads, 0);
  });
}
test("POST rejects a disabled Firebase administrator account before provisioning", async () => {
  const f = fixture({ adminAccount: { disabled: true } });
  assert.equal((await f.create("technician")).status, 403);
  assert.equal(f.provisioningCalls.length, 0);
  assert.equal(f.writes.length, 0);
});
test("POST keeps rejecting a mandatory-password-change administrator after a valid body", async () => {
  const f = fixture({ session: { uid: "administrator", role: "admin", mustChangePassword: true } });
  const result = await f.create("admin");
  assert.equal(result.status, 403);
  assert.equal(f.provisioningCalls.length, 0);
  assert.equal(f.writes.length, 0);
});
test("GET lists users for an authorized administrator after the password-change flag is cleared", async () => {
  const f = fixture({
    listedUsers: [{
      uid: "technician-1",
      fullName: "Alex Technician",
      email: "alex@example.test",
      role: "technician",
      status: "active",
    }],
  });
  const result = await f.list();
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1);
  assert.equal(result.body.users[0].uid, "technician-1");
  assert.equal(f.listReads, 1);
});
for (const [label, session, status] of [
  ["non-administrator", { uid: "supervisor", role: "supervisor", mustChangePassword: false }, 403],
  ["technician", { uid: "technician", role: "technician", mustChangePassword: false }, 403],
  ["unauthenticated", null, 401],
]) {
  test(`GET denies ${label}`, async () => {
    const f = fixture({ session });
    assert.equal((await f.list()).status, status);
    assert.equal(f.listReads, 0);
    assert.equal(f.writes.length, 0);
  });
  test(`POST denies ${label} without provisioning`, async () => {
    const f = fixture({ session });
    assert.equal((await f.create("technician")).status, status);
    assert.equal(f.provisioningCalls.length, 0);
    assert.equal(f.writes.length, 0);
  });
}
