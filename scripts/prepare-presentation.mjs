import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const projectId = "demo-shiftchange-v2", origin = "http://localhost:3100";
if (process.env.FIREBASE_PROJECT_ID !== projectId || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== projectId || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" || process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS !== "true") throw new Error("Refusing to prepare outside the isolated presentation emulators.");
await mkdir(".demo", { recursive: true });
try { await readFile(".demo/presentation.json"); throw new Error("Demo already prepared. Use existing local reference; no records were overwritten."); } catch (error) { if (error.code !== "ENOENT") throw error; }
const app = initializeApp({ projectId }), auth = getAuth(app), db = getFirestore(app);
const password = () => `Demo-${randomBytes(18).toString("base64url")}!`;
let credentials;
try {
  credentials = JSON.parse(await readFile(".demo/credentials.json", "utf8"));
  assert.ok(credentials.length >= 1 && credentials.length <= 6);
  assert.equal((await db.collection("users").get()).size, credentials.length);
  const profile = (await db.collection("users").doc(credentials[0].uid).get()).data();
  assert.equal(profile?.createdBy, "isolated-demo-bootstrap"); assert.equal(profile?.role, "admin");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  assert.equal((await db.collection("users").limit(1).get()).size, 0, "Refusing to overwrite existing demo accounts.");
  credentials = [{ label: "Administrator", fullName: "DEMO Administrator", email: "admin@presentation.invalid", role: "admin", password: password() }];
  const admin = await auth.createUser({ email: credentials[0].email, password: credentials[0].password, displayName: credentials[0].fullName });
  credentials[0].uid = admin.uid;
  await auth.setCustomUserClaims(admin.uid, { role: "admin" });
  await db.collection("users").doc(admin.uid).create({ uid: admin.uid, ...Object.fromEntries(["fullName", "email", "role"].map(key => [key, credentials[0][key]])), status: "active", statusOperation: null, mustChangePassword: false, createdBy: "isolated-demo-bootstrap", createdAt: new Date().toISOString() });
  await writeFile(".demo/credentials.json", JSON.stringify(credentials, null, 2), { flag: "wx", mode: 0o600 });
}
async function signIn(account) {
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-presentation-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true }) });
  if (!response.ok) throw new Error("Demo authentication failed.");
  const { idToken } = await response.json();
  const session = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ idToken }) });
  if (!session.ok) throw new Error(`Demo session failed (${session.status}).`);
  return session.headers.get("set-cookie").split(";")[0];
}
async function api(cookie, path, body) {
  const response = await fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${result.error || response.status}`);
  return result;
}
// Persist generated credentials immediately, even if a later setup step fails.
const adminCookie = await signIn(credentials[0]);
for (const [label, role, address] of [["Supervisor", "supervisor", "supervisor"], ["Outgoing Technician A", "technician", "outgoing-a"], ["Outgoing Technician B", "technician", "outgoing-b"], ["Incoming Technician A", "technician", "incoming-a"], ["Incoming Technician B", "technician", "incoming-b"]]) {
  const existing = credentials.find(account => account.label === label);
  if (existing) {
    const profile = (await db.collection("users").doc(existing.uid).get()).data();
    assert.equal(profile?.createdBy, credentials[0].uid); assert.equal(profile?.role, role); assert.equal(profile?.mustChangePassword, false);
    continue;
  }
  const account = { label, fullName: `DEMO ${label}`, email: `${address}@presentation.invalid`, role, password: password() };
  const created = await api(adminCookie, "/api/admin/users", account);
  account.uid = created.user.uid; credentials.push(account);
  assert.equal((await db.collection("users").doc(account.uid).get()).data().statusOperation, null, "administrator provisioning initializes cleanup metadata");
  await writeFile(".demo/credentials.json", JSON.stringify(credentials, null, 2), { mode: 0o600 });
  const cookie = await signIn(account), nextPassword = password();
  await api(cookie, "/api/auth/change-password", { currentPassword: account.password, newPassword: nextPassword, confirmPassword: nextPassword });
  account.password = nextPassword;
  await writeFile(".demo/credentials.json", JSON.stringify(credentials, null, 2), { mode: 0o600 });
}
const supervisorCookie = await signIn(credentials[1]);
async function pairFor(accounts) {
  const membership = (await db.collection("technician_pair_memberships").doc(accounts[0].uid).get()).data();
  if (membership) {
    const pair = (await db.collection("technician_pairs").doc(membership.pairId).get()).data();
    assert.equal(pair?.status, "active"); assert.deepEqual(pair.technicianIds, accounts.map(account => account.uid));
    return { pair };
  }
  return api(supervisorCookie, "/api/operations/technician-pairs", { technicianIds: accounts.map(account => account.uid) });
}
const outPair = await pairFor(credentials.slice(2, 4)), inPair = await pairFor(credentials.slice(4, 6));
const now = Date.now(), start = new Date(now + 5 * 60000).toISOString(), end = new Date(now + 60 * 60000).toISOString();
const createdShift = await api(supervisorCookie, "/api/operations/shifts", { shiftType: "morning", permanentPairId: outPair.pair.id, scheduledStart: start, scheduledEnd: end });
const shiftId = createdShift.shift.id;
const task = await api(supervisorCookie, "/api/operations/tasks", { title: "DEMO: replace intermittent studio codec patch lead", description: "Intermittent uplink drops. Backup path is stable; incoming shift should replace the lead and monitor primary codec.", priority: "high", shiftId, sectionId: null });
await api(supervisorCookie, `/api/operations/tasks/${task.task.id}/assignments`, { technicianUid: credentials[2].uid, responsibility: "lead" });
await writeFile(".demo/presentation.json", JSON.stringify({ projectId, origin, shiftId, taskId: task.task.id, outgoingPairId: outPair.pair.id, incomingPairId: inPair.pair.id, incomingStart: new Date(now - 60000).toISOString(), incomingEnd: new Date(now + 8 * 3600000).toISOString(), credentialsReference: ".demo/credentials.json" }, null, 2), { flag: "wx" });
console.log("Isolated demo accounts, permanent pairs, scheduled shift and carry-forward task prepared. Credentials: .demo/credentials.json. Scenario: .demo/presentation.json. No passwords or tokens logged.");
await db.terminate();
