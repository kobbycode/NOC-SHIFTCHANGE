import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const projectId = "demo-shiftchange-v2", origin = "http://localhost:3100";
if (process.env.FIREBASE_PROJECT_ID !== projectId || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== projectId || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" || process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS !== "true") throw new Error("Refusing to prepare outside the isolated presentation emulators.");
const destination = process.env.DEMO_PRESENTATION_SCENARIO;
assert.match(destination ?? "", /^\.demo\/[a-zA-Z0-9_-]+\.json$/);
assert.notEqual(destination, ".demo/presentation.json", "Choose a fresh scenario filename; the original reference is preserved.");
try { await readFile(destination); throw new Error("Scenario already exists; choose a new filename."); } catch (error) { if (error.code !== "ENOENT") throw error; }
const accounts = JSON.parse(await readFile(".demo/credentials.json", "utf8"));
assert.equal(accounts.length, 6);
assert.deepEqual(accounts.map(account => account.role), ["admin", "supervisor", "technician", "technician", "technician", "technician"]);
const previous = JSON.parse(await readFile(".demo/presentation.json", "utf8"));
assert.equal(previous.projectId, projectId);
const cookies = [];
for (const account of accounts) {
  const auth = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-presentation-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true }) });
  assert.equal(auth.status, 200, "actual password authentication");
  const { idToken } = await auth.json();
  const session = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ idToken }) });
  assert.equal(session.status, 200, "authenticated application session");
  cookies.push(session.headers.get("set-cookie").split(";")[0]);
}
async function api(index, path, body) {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookies[index] }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${result.error || response.status}`);
  return result;
}
// Normal read APIs verify the existing pairs; no direct Firestore writes or fixture rewrites.
const pairs = await api(1, "/api/operations/technician-pairs");
for (const [id, members] of [[previous.outgoingPairId, accounts.slice(2, 4)], [previous.incomingPairId, accounts.slice(4, 6)]]) {
  const pair = pairs.pairs.find(item => item.id === id);
  assert.equal(pair?.status, "active");
  assert.deepEqual([...pair.technicianIds].sort(), members.map(account => account.uid).sort());
}
const oldShift = (await api(1, "/api/operations/shifts")).shifts.find(item => item.id === previous.shiftId);
if (oldShift?.status === "scheduled" && Date.now() > Math.min(Date.parse(oldShift.scheduledStart) + 60 * 60000, Date.parse(oldShift.scheduledEnd))) {
  // Retire only the expired disposable fixture through audited application workflows.
  // The original ready/completed exports and original reference remain untouched.
  const oldReport = (await api(1, `/api/operations/shifts/${oldShift.id}/report`)).report;
  for (const task of oldReport.content.pendingTasks) await api(1, `/api/operations/tasks/${task.id}/lifecycle`, { action: "cancel", reason: "Expired local presentation fixture; preserved checkpoints retain the original evidence." });
  await api(0, `/api/operations/shifts/${oldShift.id}/recover-expired`, {});
}
const now = Date.now(), scheduledStart = new Date(now + 10 * 60000).toISOString(), scheduledEnd = new Date(now + 8 * 3600000).toISOString();
const shift = (await api(1, "/api/operations/shifts", { shiftType: "morning", permanentPairId: previous.outgoingPairId, scheduledStart, scheduledEnd })).shift;
// Persist the identifier before further API work so a partial setup remains reviewable.
const scenario = { projectId, origin, createdAt: new Date(now).toISOString(), shiftId: shift.id, outgoingPairId: previous.outgoingPairId, incomingPairId: previous.incomingPairId, scheduledStart, scheduledEnd, credentialsReference: ".demo/credentials.json" };
await writeFile(destination, JSON.stringify(scenario, null, 2), { flag: "wx" });
const task = (await api(1, "/api/operations/tasks", { title: "DEMO: replace intermittent studio codec patch lead", description: "Live demonstration: inspect the intermittent codec uplink and carry forward replacement work when appropriate.", priority: "high", shiftId: shift.id, sectionId: null })).task;
scenario.taskId = task.id;
await writeFile(destination, JSON.stringify(scenario, null, 2));
await api(1, `/api/operations/tasks/${task.id}/assignments`, { technicianUid: accounts[2].uid, responsibility: "lead" });
assert.equal((await api(1, "/api/operations/shifts")).shifts.find(item => item.id === shift.id)?.status, "scheduled");
for (const index of [2, 3]) {
  const current = await api(index, "/api/operations/technician/current-shift");
  assert.equal(current.currentShift?.id, shift.id, `${accounts[index].label} sees the assigned shift in their own workspace`);
  assert.equal(current.currentShift.status, "scheduled");
}
const report = (await api(1, `/api/operations/shifts/${shift.id}/report`)).report;
assert.equal(report.handover, null);
assert.equal(report.content.operations.events.length, 0, "live scenario has no pre-completed operational records");
assert.equal(report.content.attendance.filter(row => row.evidence !== null).length, 0, "live scenario has no reporting confirmations");
assert.equal(report.content.pendingTasks.length, 1);
assert.equal(report.content.pendingTasks[0].id, task.id);
assert.ok(!["completed", "cancelled"].includes(report.content.pendingTasks[0].status), "live scenario task remains unfinished");
assert.equal(report.content.pendingTasks[0].disposition, "unclassified");
assert.equal(report.content.pendingTasks[0].assignments.length, 1, "live scenario has one assigned lead");
console.log(`Fresh scheduled shift verified for supervisor and both outgoing technicians. No operational entries or handover created. Scenario: ${destination}. Start: ${scheduledStart}; activation deadline: ${new Date(Date.parse(scheduledStart) + 60 * 60000).toISOString()}. Existing credentials and checkpoints preserved.`);
