// Phase 3 — session issuance for the shared handover console.
//
// These tests lock the ONE session policy and the post-commit issuance step:
//   * the incoming technician's cookie is minted from their own verified
//     one-shot token, and no credential material is ever persisted or logged;
//   * the outgoing pair is revoked ONCE, on the first committed acceptance, and
//     the revocation is reported truthfully when it only partly succeeded;
//   * issuance can never un-commit an acceptance: every stage is guarded and
//     returns what actually happened instead of throwing;
//   * a replay re-mints the cookie without rewriting the issuance record;
//   * both acceptance writers use this shared step, never their own mint or
//     revocation, and the login route shares the same cookie policy.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import test from "node:test";
import ts from "typescript";

const issuanceSource = await readFile(new URL("../src/lib/operations/handover-session-issuance.ts", import.meta.url), "utf8");
const sessionCookieSource = await readFile(new URL("../src/lib/auth/session-cookie.ts", import.meta.url), "utf8");
const sessionSource = await readFile(new URL("../src/lib/auth/session.ts", import.meta.url), "utf8");
const loginSource = await readFile(new URL("../src/app/(auth)/api/auth/login/route.ts", import.meta.url), "utf8");
const legacyAcceptSource = await readFile(new URL("../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/accept/route.ts", import.meta.url), "utf8");
const atomicAcceptSource = await readFile(new URL("../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/accept/atomic/route.ts", import.meta.url), "utf8");

function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

// The real cookie policy, loaded through the same compiled path as every other
// module here so a constant change cannot silently pass this suite.
const policy = (() => {
  const loaded = { exports: {} };
  runInNewContext(compile(sessionCookieSource), {
    exports: loaded.exports,
    process: { env: { NODE_ENV: "test" } },
    require: (specifier) => {
      if (specifier === "server-only") return {};
      throw new Error(`Unexpected session policy dependency: ${specifier}`);
    },
  });
  return loaded.exports;
})();

const idToken = "secret-id-token";
const sessionCookieValue = "secret-session-cookie";
const otherSecret = "secret-refresh-token";

function loadIssuance(options = {}) {
  const events = [];
  const logs = [];
  const created = [];
  const auth = {
    async createSessionCookie(token, settings) {
      events.push({ kind: "mint", token, settings });
      if (options.mintError) throw options.mintError;
      return sessionCookieValue;
    },
    async revokeRefreshTokens(uid) {
      events.push({ kind: "revoke", uid });
      if (options.revokeError?.(uid)) throw options.revokeError(uid);
    },
  };
  const firestore = {
    collection(name) {
      assert.equal(name, "audit_logs");
      return { doc(id) {
        return { async create(data) {
          events.push({ kind: "audit", id });
          if (options.auditError) throw options.auditError;
          created.push({ id, data });
        } };
      } };
    },
  };
  const loaded = { exports: {} };
  runInNewContext(compile(issuanceSource), {
    exports: loaded.exports,
    console: { error(...args) { logs.push(args); } },
    require(specifier) {
      if (specifier === "server-only") return {};
      if (specifier === "node:crypto") return { createHash };
      if (specifier === "firebase-admin/firestore") return { FieldValue: { serverTimestamp: () => ({ serverTimestamp: true }) } };
      if (specifier === "@/lib/auth/session-cookie") return policy;
      if (specifier === "@/lib/firebase/admin") {
        return {
          getAdminAuth: () => {
            if (options.authUnavailable) throw new Error(`${idToken} ${otherSecret}`);
            return auth;
          },
          getAdminFirestore: () => firestore,
        };
      }
      throw new Error(`Unexpected issuance dependency: ${specifier}`);
    },
  });
  return { ...loaded.exports, events, logs, created };
}

const input = () => ({
  outgoingShiftId: "outgoing-shift",
  handoverDocumentId: "handover-doc",
  acceptingTechnicianUid: "incoming-a",
  consoleActorUid: "outgoing-a",
  outgoingTechnicianIds: ["outgoing-a", "outgoing-b"],
  idToken,
  firstActivation: true,
  acceptanceReceiptId: "receipt-1",
  nowIso: "2026-11-07T08:00:00.000Z",
});

const auditText = (issues) => JSON.stringify(issues.created.map((entry) => entry.data));

test("the one session policy is shared and fixed", () => {
  assert.equal(policy.SESSION_COOKIE, "__session");
  assert.equal(policy.SESSION_DURATION_MS, 5 * 24 * 60 * 60 * 1000);
  const calls = [];
  policy.applySessionCookie({ cookies: { set: (value) => calls.push(value) } }, sessionCookieValue);
  assert.deepEqual(structuredClone(calls), [{
    name: "__session",
    value: sessionCookieValue,
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 24 * 60 * 60,
  }]);
  // Secure in production, and session.ts re-exports this exact constant rather
  // than defining a second one.
  assert.match(sessionSource, /import \{ SESSION_COOKIE \} from "\.\/session-cookie"/);
  assert.match(sessionSource, /export \{ SESSION_COOKIE \}/);
  assert.doesNotMatch(sessionSource, /export const SESSION_COOKIE/);
});

test("the issuance id is deterministic, namespaced and binds the accepting technician", () => {
  const issuance = loadIssuance();
  const expected = `handover-session-v2-${createHash("sha256").update(JSON.stringify({
    namespace: "equal-handover-session-v2",
    handoverDocumentId: "handover-doc",
    acceptingTechnicianUid: "incoming-a",
  })).digest("hex")}`;
  assert.equal(issuance.handoverSessionIssuanceId("handover-doc", "incoming-a"), expected);
  assert.equal(issuance.handoverSessionIssuanceId("handover-doc", "incoming-a"), expected);
  assert.notEqual(issuance.handoverSessionIssuanceId("handover-doc", "incoming-b"), expected);
  assert.notEqual(issuance.handoverSessionIssuanceId("other-doc", "incoming-a"), expected);
  assert.ok(expected.startsWith("handover-session-v2-"));
  assert.ok(!expected.includes("incoming-a"));
  assert.ok(!expected.includes("handover-doc"));
});

test("the first activation mints first, revokes both outgoing uids once, and records the issuance", async () => {
  const issuance = loadIssuance();
  const inputValue = input();
  const result = await issuance.issueIncomingHandoverSession(inputValue);

  assert.deepEqual(issuance.events.map((event) => event.kind === "revoke" ? `revoke:${event.uid}` : event.kind), [
    "mint", "revoke:outgoing-a", "revoke:outgoing-b", "audit",
  ]);
  assert.equal(issuance.events[0].token, idToken);
  assert.deepEqual(structuredClone(issuance.events[0].settings), { expiresIn: policy.SESSION_DURATION_MS });

  assert.equal(issuance.created.length, 1);
  const record = issuance.created[0].data;
  assert.equal(issuance.created[0].id, result.issuanceId);
  assert.equal(record.action, "HANDOVER_SESSION_ISSUED_V2");
  assert.equal(record.schema, "handover-session-issuance-v2");
  assert.equal(record.protocol, "equal-handover-v2");
  assert.equal(record.handoverDocumentId, "handover-doc");
  assert.equal(record.outgoingShiftId, "outgoing-shift");
  assert.equal(record.acceptingTechnicianUid, "incoming-a");
  assert.equal(record.consoleActorUid, "outgoing-a");
  assert.deepEqual(structuredClone(record.outgoingTechnicianIds), ["outgoing-a", "outgoing-b"]);
  assert.deepEqual(structuredClone(record.revokedOutgoingTechnicianUids), ["outgoing-a", "outgoing-b"]);
  assert.equal(record.firstActivation, true);
  assert.equal(record.acceptanceReceiptId, "receipt-1");
  assert.equal(record.issuedAt, "2026-11-07T08:00:00.000Z");
  assert.deepEqual(structuredClone(record.createdAt), { serverTimestamp: true });

  assert.deepEqual(Object.keys(result).sort(), [
    "issuanceId", "issuanceRecorded", "issued", "outgoingSessionsRevoked", "replayed", "revokedOutgoingTechnicianUids", "sessionCookie",
  ]);
  assert.equal(result.issued, true);
  assert.equal(result.sessionCookie, sessionCookieValue);
  assert.equal(result.issuanceRecorded, true);
  assert.equal(result.replayed, false);
  assert.equal(result.outgoingSessionsRevoked, true);
  assert.deepEqual(structuredClone(result.revokedOutgoingTechnicianUids), ["outgoing-a", "outgoing-b"]);

  // No credential material, in any form, reaches the persisted record.
  const persisted = auditText(issuance);
  for (const secret of [idToken, sessionCookieValue, otherSecret]) assert.ok(!persisted.includes(secret), `${secret} must never be persisted`);
  assert.ok(!persisted.match(/password|authorization|refreshToken/i));
});

test("a later join revokes nothing and still signs the joining technician in", async () => {
  const issuance = loadIssuance();
  const result = await issuance.issueIncomingHandoverSession({ ...input(), acceptingTechnicianUid: "incoming-b", firstActivation: false });
  assert.deepEqual(issuance.events.map((event) => event.kind), ["mint", "audit"]);
  assert.equal(result.issued, true);
  assert.equal(result.outgoingSessionsRevoked, false);
  assert.deepEqual(structuredClone(result.revokedOutgoingTechnicianUids), []);
  assert.deepEqual(structuredClone(issuance.created[0].data.revokedOutgoingTechnicianUids), []);
  assert.equal(issuance.created[0].data.firstActivation, false);
});

test("a failed cookie mint never throws, still revokes once, and never logs the token", async () => {
  const issuance = loadIssuance({ mintError: new Error(`${idToken} ${otherSecret}`) });
  const result = await issuance.issueIncomingHandoverSession(input());
  assert.equal(result.issued, false);
  assert.equal(result.sessionCookie, null);
  assert.equal(result.outgoingSessionsRevoked, true);
  assert.equal(result.issuanceRecorded, true);
  assert.deepEqual(issuance.events.map((event) => event.kind), ["mint", "revoke", "revoke", "audit"]);
  const logged = JSON.stringify(issuance.logs);
  for (const secret of [idToken, otherSecret]) assert.ok(!logged.includes(secret));
  assert.ok(!auditText(issuance).includes(idToken));
});

test("a partly failed revocation is reported truthfully and records only what was revoked", async () => {
  const issuance = loadIssuance({ revokeError: (uid) => (uid === "outgoing-b" ? new Error(`${otherSecret}`) : null) });
  const result = await issuance.issueIncomingHandoverSession(input());
  assert.deepEqual(structuredClone(result.revokedOutgoingTechnicianUids), ["outgoing-a"]);
  assert.equal(result.outgoingSessionsRevoked, false);
  assert.equal(result.issued, true, "the newly issued session must not depend on revocation");
  assert.deepEqual(structuredClone(issuance.created[0].data.revokedOutgoingTechnicianUids), ["outgoing-a"]);
  assert.ok(!JSON.stringify(issuance.logs).includes(otherSecret));
});

test("an unavailable Auth client cannot fail an already committed acceptance", async () => {
  const issuance = loadIssuance({ authUnavailable: true });
  const result = await issuance.issueIncomingHandoverSession(input());
  assert.equal(result.issued, false);
  assert.equal(result.outgoingSessionsRevoked, false);
  assert.deepEqual(structuredClone(result.revokedOutgoingTechnicianUids), []);
  assert.equal(result.issuanceRecorded, true);
  assert.ok(issuance.logs.length >= 3);
  assert.ok(!JSON.stringify(issuance.logs).includes(idToken));
  assert.ok(!JSON.stringify(issuance.logs).includes(otherSecret));
});

test("a replay re-mints the cookie without rewriting the issuance record", async () => {
  const issuance = loadIssuance({ auditError: Object.assign(new Error("exists"), { code: 6 }) });
  const result = await issuance.issueIncomingHandoverSession(input());
  assert.equal(result.issued, true);
  assert.equal(result.issuanceRecorded, true);
  assert.equal(result.replayed, true);
  assert.equal(issuance.created.length, 0);
  assert.deepEqual(issuance.logs, []);
});

test("an unrecorded issuance is reported as such and still signs the technician in", async () => {
  const issuance = loadIssuance({ auditError: Object.assign(new Error("unavailable"), { code: 14 }) });
  const result = await issuance.issueIncomingHandoverSession(input());
  assert.equal(result.issued, true);
  assert.equal(result.issuanceRecorded, false);
  assert.equal(result.replayed, false);
  assert.deepEqual(issuance.logs, [["Handover acceptance committed but its session issuance record could not be written."]]);
});

test("the caller's outgoing roster is copied, never mutated or aliased", async () => {
  const issuance = loadIssuance();
  const inputValue = input();
  const roster = inputValue.outgoingTechnicianIds;
  await issuance.issueIncomingHandoverSession(inputValue);
  assert.deepEqual(inputValue.outgoingTechnicianIds, ["outgoing-a", "outgoing-b"]);
  assert.notEqual(issuance.created[0].data.outgoingTechnicianIds, roster);
  assert.notEqual(issuance.created[0].data.revokedOutgoingTechnicianUids, roster);
});

// --- Architectural checks: one mint, one revocation, one session policy ------

const routeAst = (name, source) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
function nodes(root) {
  const found = [];
  const visit = (node) => { found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}
function importsFrom(root, module) {
  return nodes(root).filter((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module);
}
function callsNamed(root, name) {
  return nodes(root).filter((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name);
}
function literalTexts(root) {
  return nodes(root).filter((node) => ts.isStringLiteral(node)).map((node) => node.text);
}

for (const [label, source, fileName] of [
  ["legacy", legacyAcceptSource, "legacy-accept.ts"],
  ["atomic", atomicAcceptSource, "atomic-accept.ts"],
]) test(`the ${label} acceptance writer uses the shared issuance step and mints/revokes nothing itself`, () => {
  const ast = routeAst(fileName, source);
  const issuanceImport = importsFrom(ast, "@/lib/operations/handover-session-issuance");
  assert.equal(issuanceImport.length, 1);
  assert.ok(nodes(issuanceImport[0]).some((node) => ts.isImportSpecifier(node) && node.name.text === "issueIncomingHandoverSession"));
  assert.equal(callsNamed(ast, "issueIncomingHandoverSession").length, 1);
  const cookieImport = importsFrom(ast, "@/lib/auth/session-cookie");
  assert.equal(cookieImport.length, 1);
  assert.ok(nodes(cookieImport[0]).some((node) => ts.isImportSpecifier(node) && node.name.text === "applySessionCookie"));
  assert.equal(callsNamed(ast, "applySessionCookie").length, 1);
  for (const forbidden of ["createSessionCookie", "revokeRefreshTokens", "reauthenticatePassword"]) {
    assert.equal(callsNamed(ast, forbidden).length, 0, `${label} acceptance must not call ${forbidden} directly`);
  }
  assert.ok(!literalTexts(ast).some((text) => text.includes("__session")), "the cookie name comes only from the shared policy");
});

test("the login route shares the same cookie policy instead of its own duration or cookie block", () => {
  const ast = routeAst("login.ts", loginSource);
  const importDecl = importsFrom(ast, "@/lib/auth/session-cookie");
  assert.equal(importDecl.length, 1);
  const imported = nodes(importDecl[0]).filter((node) => ts.isImportSpecifier(node)).map((node) => node.name.text);
  assert.deepEqual(imported.sort(), ["SESSION_DURATION_MS", "applySessionCookie"]);
  assert.equal(callsNamed(ast, "applySessionCookie").length, 1);
  assert.doesNotMatch(loginSource, /cookies\.set\(/, "the login route must not hand-roll a second cookie block");
  assert.doesNotMatch(loginSource, /5 \* 24 \* 60 \* 60/, "the login route must not define a second duration");
});