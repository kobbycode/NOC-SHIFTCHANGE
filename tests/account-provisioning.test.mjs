import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/app/(dashboard)/api/admin/users/route.ts", import.meta.url), "utf8");
function fixture() {
  const writes = [], authCalls = [], loaded = { exports: {} };
  const auth = { getUser: async () => ({ disabled: false }), createUser: async input => { authCalls.push(input); return { uid: "new-account" }; }, setCustomUserClaims: async () => {}, updateUser: async () => {}, deleteUser: async () => {} };
  const db = { collection(name) { return { doc(id = "audit") { return { path: `${name}/${id}`, id, get: async () => ({ exists: true, data: () => ({ status: "active", role: "admin" }) }) }; } }; }, batch() { return { create(ref, data) { writes.push({ path: ref.path, data }); }, commit: async () => {} }; } };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: loaded.exports, console: { error() {} },
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, ...options }) } };
      if (name === "firebase-admin/firestore") return { FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" } };
      if (name.endsWith("/firebase/admin")) return { getAdminAuth: () => auth, getAdminFirestore: () => db };
      if (name.endsWith("/auth/session")) return { getCurrentUser: async () => ({ uid: "administrator", role: "admin", mustChangePassword: false }) };
      if (name.endsWith("/types/auth")) return { isUserRole: role => ["admin", "supervisor", "technician"].includes(role) };
      if (name.endsWith("/errors/messages")) return { getErrorMessage: key => key, getFirebaseErrorMessage: () => "error" };
      throw new Error(name);
    },
  });
  return { writes, authCalls, async create(role, origin = "https://demo.test") { return loaded.exports.POST({ headers: { get: () => origin }, nextUrl: { origin: "https://demo.test" }, json: async () => ({ fullName: "Demo Technician", email: "demo@example.test", password: "synthetic-initial-password", role }) }); } };
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
