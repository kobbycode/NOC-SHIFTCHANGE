import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = "demo-shiftchange-v2", origin = "http://localhost:3100";
if (process.env.FIREBASE_PROJECT_ID !== projectId || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080") throw new Error("Refusing non-demo validation.");
const accounts = JSON.parse(await readFile(".demo/credentials.json", "utf8")), scenario = JSON.parse(await readFile(".demo/presentation.json", "utf8"));
const db = getFirestore(initializeApp({ projectId }));
const sessions = [];
for (const account of accounts) {
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-presentation-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true }) });
  assert.equal(response.status, 200, "real emulator password sign-in"); const { idToken } = await response.json();
  const session = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ idToken }) });
  assert.equal(session.status, 200, "authenticated application session"); sessions.push(session.headers.get("set-cookie").split(";")[0]);
}
const checks = [];
function passed(name) { checks.push(name); console.log(`PASS: ${name}`); }
async function request(index, path, body, expected = 200, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(origin + path, { method, headers: { "Content-Type": "application/json", Origin: origin, Cookie: sessions[index] }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.equal(response.status, expected, `${path}: ${result.error || response.status}`); return result;
}
const base = `/api/operations/shifts/${scenario.shiftId}`;
const latest = async () => (await request(1, `${base}/report`)).report;
const binding = report => ({ expectedRevision: report.handover.revision, expectedSnapshotHash: report.snapshotHash });
const currentStatus = (await db.doc(`shifts/${scenario.shiftId}`).get()).data().status;
assert.ok(["scheduled", "active", "handover_pending"].includes(currentStatus), "validation requires a prepared shift before transfer");
let report;
if (currentStatus !== "handover_pending") {
if (currentStatus === "scheduled") await request(1, `${base}/start`, {});
for (const index of [2, 3]) {
  if (!(await db.doc(`shift_attendance/${scenario.shiftId}_${accounts[index].uid}`).get()).exists) await request(index, `${base}/join`, {}, 201);
}
passed("supervisor starts shift; both outgoing technicians join with persisted attendance");
await request(4, `${base}/report`, undefined, 403);
for (const stationId of ["joy-fm", "adom-fm", "asempa-fm", "hitz-fm"]) await request(2, `${base}/records`, { details: { kind: "broadcast", stationId, status: "on_air", occurredAt: new Date().toISOString(), remarks: "DEMO: verified studio audio and transmission path" } }, 201);
const incident = { kind: "incident", category: "fault", title: "DEMO: intermittent studio codec uplink", description: "Primary codec briefly drops audio. Backup path is stable.", occurredAt: new Date().toISOString(), location: "Joy FM studio codec rack", actionTaken: "Checked cables and selected backup path", status: "investigating", severity: "high", linkedTaskId: scenario.taskId };
const fault = (await request(2, `${base}/records`, { details: incident }, 201)).event;
await request(3, `${base}/records`, { recordId: fault.recordId, expectedRevision: 1, details: { ...incident, actionTaken: "Reseated patch lead; backup uplink stable. Replacement still required.", status: "monitoring" } }, 201);
await request(3, `${base}/records`, { details: { kind: "outside_broadcast", title: "DEMO: community event", location: "Accra event grounds", occurredAt: new Date().toISOString(), runningStatus: "running", technicalIssues: "Primary uplink intermittently drops; backup operational", actionTaken: "Enabled backup uplink and informed producer", status: "monitoring", remarks: "Continue monitoring until event closes", linkedTaskId: null } }, 201);
report = await latest(); assert.equal(report.content.operations.events.length, 7); assert.equal(report.content.operations.events.find(event => event.id === fault.id).authorUid, accounts[2].uid);
passed("both technicians persist broadcast checks, fault history, task link and outside broadcast");
await request(1, `${base}/handover`, {});
await request(2, `${base}/records`, { details: incident }, 409);
await request(1, `${base}/handover/reservation`, { incomingPermanentPairId: scenario.incomingPairId, shiftType: "morning", scheduledStart: new Date(Date.now() - 60000).toISOString(), scheduledEnd: new Date(Date.now() + 8 * 3600000).toISOString() }, 201);
} else {
  const persisted = await latest();
  assert.equal(persisted.content.attendance.filter(row => row.evidence).length, 2);
  assert.equal(persisted.content.operations.events.length, 7);
  passed("resumed persisted attendance and seven operational events from the authenticated pre-handover walkthrough");
}
report = await latest(); assert.equal(report.handover.reportBinding, null);
await request(2, `${base}/handover/confirmation`, { ...binding(report), password: accounts[2].password }, 409);
await request(1, `${base}/handover/work/${scenario.taskId}/disposition`, { ...binding(report), operation: "classify", disposition: "carry_forward", reason: "Replacement lead unavailable; stable backup path monitored by incoming shift." });
report = await latest(); assert.equal(report.content.completeness.blockers.length, 0); assert.equal(report.content.pendingTasks[0].carryForwardEligible, true);
await request(1, `${base}/report`, { ...binding(report), reason: "Reviewed both technicians' evidence and carry-forward readiness for demonstration." });
report = await latest(); assert.ok(report.frozen); assert.ok(report.handover.reportBinding.digest);
passed("report freeze binds complete evidence; work classification and pre-freeze confirmation gate verified");
await request(2, `${base}/handover/confirmation`, { ...binding(report), password: "deliberately-incorrect-demo-password" }, 400);
const stale = binding(report);
await request(1, `${base}/report`, { ...binding(report), reason: "Controlled clarification before final review", correctionNote: "DEMO clarification: backup path remains stable; primary patch lead requires replacement." });
await request(2, `${base}/handover/confirmation`, { ...stale, password: accounts[2].password }, 409);
report = await latest(); assert.equal(report.content.corrections.length, 1); assert.equal(report.handover.confirmations.length, 0);
for (const index of [2, 3, 4, 5]) {
  const reviewed = (await request(index, `${base}/report`)).report;
  assert.equal(reviewed.handover.reportBinding.digest, report.handover.reportBinding.digest);
  await request(index, `${base}/handover/confirmation`, { ...binding(report), password: accounts[index].password });
}
passed("incorrect password and stale revision rejected; all four users authenticate the same revised report");
report = await latest(); assert.equal(report.participants.filter(participant => participant.state === "confirmed").length, 4);
const taskBefore = (await db.doc(`tasks/${scenario.taskId}`).get()).data();
const outcome = await request(1, `${base}/handover/transfer`, binding(report));
assert.equal(outcome.status, "TRANSFERRED");
const replay = await request(1, `${base}/handover/transfer`, binding(report)); assert.equal(replay.status, "ALREADY_TRANSFERRED");
const outgoing = (await db.doc(`shifts/${scenario.shiftId}`).get()).data(), incoming = (await db.doc(`shifts/${report.content.staff.incomingShiftId}`).get()).data();
assert.equal(outgoing.status, "completed"); assert.equal(incoming.status, "active");
const control = (await db.doc("operational_shift_control/global").get()).data(); assert.equal(control.shiftId, incoming.id); assert.equal(control.generation, report.handover.identity.successorGeneration);
const taskAfter = (await db.doc(`tasks/${scenario.taskId}`).get()).data(); assert.equal(taskAfter.id, taskBefore.id); assert.equal(taskAfter.shiftId, incoming.id);
const assignments = (await db.collection("task_assignments").where("taskId", "==", scenario.taskId).get()).docs.map(doc => doc.data());
assert.equal(assignments.length, 1); assert.equal(assignments[0].responsibilityStatus, "released"); assert.ok(!assignments.some(assignment => [accounts[4].uid, accounts[5].uid].includes(assignment.technicianId)));
const completed = await latest(); assert.equal(completed.handover.lifecycleStatus, "completed"); assert.ok(completed.receipt); assert.equal(completed.handover.reportBinding.digest, report.handover.reportBinding.digest);
passed("atomic transfer completes outgoing, activates incoming once, retains task identity and fabricates no acceptance; replay is idempotent");
for (const [index, role] of [[1, "supervisor"], [2, "technician"], [4, "technician"]]) {
  const page = await fetch(`${origin}/${role}/handovers/${scenario.shiftId}`, { headers: { Cookie: sessions[index] } });
  assert.equal(page.status, 200); const html = await page.text(); for (const text of ["Shift Handover Report", "Transfer receipt", "Authenticated report binding", "Print / Save as PDF"]) assert.ok(html.includes(text), text);
}
passed("completed supervisor, outgoing and incoming pages render all report sections, binding and printable receipt");
await writeFile(".demo/validation.json", JSON.stringify({ validatedAt: new Date().toISOString(), projectId, checks, shiftId: scenario.shiftId, incomingShiftId: incoming.id, receiptId: completed.receipt.id, reportDigest: completed.handover.reportBinding.digest, browserVerified: false }, null, 2));
await db.terminate();
