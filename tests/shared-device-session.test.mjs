// TECH-HO-RECOVERY-09J Phase 2/3 — shared-device session security.
//
// These tests lock the guarantees that make one-device/two-technician use safe
// WITHOUT introducing a new session model:
//   * the server session is bound to the freshly authenticated UID, and identity
//     is re-derived from the token payload + live Firestore profile on every
//     request (no cross-technician leakage through the shared cookie);
//   * disabled / revoked / status-changed / role-mismatched accounts fail closed;
//   * the mandatory-password-change gate stays effective;
//   * a routine logout clears ONLY this browser's cookie and performs no
//     account-wide revocation, so unrelated devices are untouched.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const sessionSource = await readFile(
  new URL("../src/lib/auth/session.ts", import.meta.url),
  "utf8",
);
// The ONE session policy shared with the login route and the handover
// acceptance; loaded for real so a drift in the constant is caught here.
const sessionCookieSource = await readFile(
  new URL("../src/lib/auth/session-cookie.ts", import.meta.url),
  "utf8",
);

function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const VALID_ROLES = ["technician", "supervisor", "admin"];
const isUserRole = (role) => VALID_ROLES.includes(role);

const cookieJar = { value: undefined };
const redirects = [];

function loadSession({ verifySessionCookie, getUser, getProfile }) {
  const adminAuth = { verifySessionCookie, getUser };
  const adminDb = {
    collection(name) {
      assert.equal(name, "users");
      return { doc(uid) { return { get: async () => getProfile(uid) }; } };
    },
  };
  const loaded = { exports: {} };
  runInNewContext(compile(sessionSource), {
    exports: loaded.exports,
    structuredClone,
    require(specifier) {
      if (specifier === "server-only") return {};
      if (specifier === "next/headers") {
        return { cookies: async () => ({ get: (n) => (n === "__session" && cookieJar.value !== undefined ? { value: cookieJar.value } : undefined) }) };
      }
      if (specifier === "next/navigation") {
        return { redirect: (to) => { redirects.push(to); throw new Error(`REDIRECT:${to}`); } };
      }
      if (specifier === "@/lib/firebase/admin") {
        return { getAdminAuth: () => adminAuth, getAdminFirestore: () => adminDb };
      }
      if (specifier === "@/types/auth") return { isUserRole };
      if (specifier === "./session-cookie") {
        const policy = { exports: {} };
        runInNewContext(compile(sessionCookieSource), {
          exports: policy.exports,
          process: { env: { NODE_ENV: "test" } },
          require: (dependency) => {
            if (dependency === "server-only") return {};
            throw new Error(`Unexpected session policy dependency: ${dependency}`);
          },
        });
        return policy.exports;
      }
      throw new Error(`Unexpected session dependency: ${specifier}`);
    },
  });
  return loaded.exports;
}

const activeProfile = { fullName: "Tech A", email: "a@example.test", role: "technician", status: "active", statusOperation: null, mustChangePassword: false };
const tokenFor = (uid, role = "technician") => ({ uid, role });
const verifyOk = (uid, role) => async () => tokenFor(uid, role);
const snapshot = (profile) => async () => ({ exists: true, data: () => ({ ...profile }) });

function withCookie(value, action) {
  const previous = cookieJar.value;
  cookieJar.value = value;
  redirects.length = 0;
  return Promise.resolve(action()).finally(() => { cookieJar.value = previous; });
}

const fresh = () => loadSession({ verifySessionCookie: verifyOk("tech-A"), getUser: async () => ({ disabled: false, email: "a@example.test" }), getProfile: snapshot(activeProfile) });

test("no session cookie returns null (a fresh device profile is unauthenticated)", async () => {
  await withCookie(undefined, async () => {
    assert.equal(await fresh().getCurrentUser(), null);
  });
});

test("a valid session returns exactly the UID carried in the verified token", async () => {
  const user = await withCookie("cookie-A", () => fresh().getCurrentUser());
  assert.equal(user.uid, "tech-A");
  assert.equal(user.role, "technician");
  assert.equal(user.status, "active");
});

test("the server session is bound to the newly authenticated UID — never another technician", async () => {
  // Token says tech-B; the verified payload drives the profile lookup, so the
  // session can only ever resolve to the just-authenticated uid.
  let lookedUpUid = null;
  const mod = loadSession({
    verifySessionCookie: verifyOk("tech-B"),
    getUser: async () => ({ disabled: false, email: "b@example.test" }),
    getProfile: async (uid) => { lookedUpUid = uid; return { exists: true, data: () => ({ ...activeProfile }) }; },
  });
  const user = await withCookie("cookie-B", () => mod.getCurrentUser());
  assert.equal(lookedUpUid, "tech-B");
  assert.equal(user.uid, "tech-B");
});

test("a token/profile role mismatch fails closed", async () => {
  const mod = loadSession({
    verifySessionCookie: async () => ({ uid: "tech-A", role: "admin" }),
    getUser: async () => ({ disabled: false, email: "a@example.test" }),
    getProfile: snapshot(activeProfile),
  });
  assert.equal(await withCookie("cookie-A", () => mod.getCurrentUser()), null);
});

test("disabled auth accounts fail closed", async () => {
  const mod = loadSession({ verifySessionCookie: verifyOk("tech-A"), getUser: async () => ({ disabled: true }), getProfile: snapshot(activeProfile) });
  assert.equal(await withCookie("cookie-A", () => mod.getCurrentUser()), null);
});

test("non-active profile status and pending status operations fail closed", async () => {
  for (const profile of [
    { ...activeProfile, status: "suspended" },
    { ...activeProfile, status: "active", statusOperation: { kind: "revocation" } },
  ]) {
    const mod = loadSession({
      verifySessionCookie: verifyOk("tech-A"),
      getUser: async () => ({ disabled: false, email: "a@example.test" }),
      getProfile: snapshot(profile),
    });
    assert.equal(await withCookie("cookie-A", () => mod.getCurrentUser()), null, JSON.stringify(profile));
  }
});

test("a missing Firestore profile fails closed", async () => {
  const mod = loadSession({ verifySessionCookie: verifyOk("tech-A"), getUser: async () => ({ disabled: false }), getProfile: async () => ({ exists: false }) });
  assert.equal(await withCookie("cookie-A", () => mod.getCurrentUser()), null);
});

test("mandatory password change stays effective in the resolved user", async () => {
  const mod = loadSession({
    verifySessionCookie: verifyOk("tech-A"),
    getUser: async () => ({ disabled: false, email: "a@example.test" }),
    getProfile: snapshot({ ...activeProfile, mustChangePassword: true }),
  });
  const user = await withCookie("cookie-A", () => mod.getCurrentUser());
  assert.equal(user.mustChangePassword, true);
});

test("requireUser redirects: unauthenticated -> /login, forced change -> /change-password, wrong role -> /unauthorized, allowed role passes", async () => {
  const noCookieMod = fresh();
  await assert.rejects(withCookie(undefined, () => noCookieMod.requireUser()), /REDIRECT:\/login/);
  assert.deepEqual(redirects, ["/login"]);

  const forcedChangeMod = loadSession({
    verifySessionCookie: verifyOk("tech-A"),
    getUser: async () => ({ disabled: false, email: "a@example.test" }),
    getProfile: snapshot({ ...activeProfile, mustChangePassword: true }),
  });
  await assert.rejects(withCookie("cookie-A", () => forcedChangeMod.requireUser(["technician"])), /REDIRECT:\/change-password/);
  assert.deepEqual(redirects, ["/change-password"]);

  const allowed = await withCookie("cookie-A", () => fresh().requireUser(["technician"]));
  assert.equal(allowed.uid, "tech-A");

  await assert.rejects(withCookie("cookie-A", () => fresh().requireUser(["supervisor"])), /REDIRECT:\/unauthorized/);
  assert.deepEqual(redirects, ["/unauthorized"]);
});

// --- Routine logout must NOT revoke the account globally ---------------------

const logoutSource = await readFile(new URL("../src/app/(auth)/api/auth/logout/route.ts", import.meta.url), "utf8");

test("logout clears only the session cookie and performs no account-wide revocation", async () => {
  assert.match(logoutSource, /name:\s*SESSION_COOKIE/);
  assert.match(logoutSource, /maxAge:\s*0/);
  // These would revoke every device for the user — forbidden as a routine logout.
  for (const forbidden of ["revokeRefreshTokens", "revokeSessions", "revokeSessionCookies"]) {
    assert.doesNotMatch(logoutSource, new RegExp(forbidden), `logout must not call ${forbidden}`);
  }
  // Logout identifies no target user server-side; it cannot act on another uid.
  assert.doesNotMatch(logoutSource, /getCurrentUser|verifySessionCookie/, "logout should not depend on the presented session");
});

// --- Shared-device client session hygiene ------------------------------------

const loginPageSource = await readFile(new URL("../src/app/login/page.tsx", import.meta.url), "utf8");

test("the login page destroys the browser Firebase session on every outcome, so no residual session can auto-restore the previous technician", async () => {
  const signInAt = loginPageSource.indexOf("signInWithEmailAndPassword");
  const successSignOut = loginPageSource.indexOf("await signOut(auth)", signInAt);
  assert.ok(signInAt >= 0, "login page signs in through the Firebase client SDK");
  assert.ok(successSignOut >= 0, "the client Firebase session is signed out after the cookie is issued");
  // The sign-out runs before navigation/refresh, so the dashboard never has a
  // live client session that a second technician could inherit.
  const replaceAt = loginPageSource.indexOf("router.replace", successSignOut);
  assert.ok(successSignOut < replaceAt, "sign-out precedes dashboard navigation");
  assert.match(loginPageSource, /catch[^]*signOut\(auth\)/, "the failure branch also clears any partial client session");
});
