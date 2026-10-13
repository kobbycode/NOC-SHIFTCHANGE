import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const project = "demo-shiftchange-v2", origin = "http://localhost:3100";
if (process.env.FIREBASE_PROJECT_ID !== project ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== project ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" ||
    process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" ||
    process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS !== "true") {
  throw new Error("Refusing inspection outside the isolated demo.");
}

const accounts = JSON.parse(await readFile(".demo/credentials.json", "utf8"));
const scenario = JSON.parse(await readFile(
  process.env.DEMO_PRESENTATION_SCENARIO ?? ".demo/presentation.json",
  "utf8",
));
assert.equal(scenario.projectId, project);
assert.ok(accounts.length >= 6);
const cookies = [];

for (const account of accounts) {
  const auth = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-presentation-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: account.email,
        password: account.password,
        returnSecureToken: true,
      }),
    },
  );
  assert.equal(auth.status, 200, `${account.label}: emulator password authentication`);
  const { idToken } = await auth.json();
  const session = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ idToken }),
  });
  assert.equal(session.status, 200, `${account.label}: application session`);
  cookies.push(session.headers.get("set-cookie").split(";")[0]);
}

async function api(accountIndex, path) {
  const response = await fetch(`${origin}${path}`, {
    headers: { Cookie: cookies[accountIndex] },
  });
  const result = await response.json();
  assert.equal(response.status, 200, `${accounts[accountIndex].label}: ${path}`);
  return result;
}

const managerShifts = await api(1, "/api/operations/shifts");
const shift = managerShifts.shifts.find(item => item.id === scenario.shiftId);
assert.equal(shift?.status, "scheduled", "supervisor can view the prepared shift");
const pairView = await api(1, "/api/operations/technician-pairs");
for (const [pairId, technicians] of [
  [scenario.outgoingPairId, accounts.slice(2, 4)],
  [scenario.incomingPairId, accounts.slice(4, 6)],
]) {
  const pair = pairView.pairs.find(item => item.id === pairId);
  assert.equal(pair?.status, "active");
  assert.deepEqual(
    [...pair.technicianIds].sort(),
    technicians.map(account => account.uid).sort(),
  );
}

for (const index of [2, 3]) {
  const current = await api(index, "/api/operations/technician/current-shift");
  assert.equal(current.currentShift?.id, scenario.shiftId);
  assert.equal(current.currentShift.status, "scheduled");
}

const report = (await api(1, `/api/operations/shifts/${scenario.shiftId}/report`)).report;
assert.equal(report.handover, null);
assert.equal(report.content.operations.events.length, 0);
assert.equal(report.content.attendance.filter(row => row.evidence !== null).length, 0);
assert.equal(report.content.pendingTasks.length, 1);
assert.equal(report.content.pendingTasks[0].id, scenario.taskId);
assert.ok(!["completed", "cancelled"].includes(report.content.pendingTasks[0].status));
assert.equal(report.content.pendingTasks[0].disposition, "unclassified");

const supervisorPage = await fetch(`${origin}/supervisor/shifts`, {
  headers: { Cookie: cookies[1] },
});
assert.equal(supervisorPage.status, 200);
assert.ok((await supervisorPage.text()).includes("Shift Management"));

for (const [index, account] of accounts.entries()) {
  const route = `/${account.role}`;
  const response = await fetch(`${origin}${route}`, {
    headers: { Cookie: cookies[index] },
  });
  assert.equal(response.status, 200, `${account.label}: ${route}`);
  const html = await response.text();
  const expected = account.role === "admin"
    ? ["Administration Overview", "Total users", "Broadcast stations"]
    : [account.role === "supervisor" ? "Supervisor Overview" : "Technician Overview"];
  for (const phrase of expected) {
    assert.ok(html.includes(phrase), `${account.label}: ${route} should include ${phrase}`);
  }
  assert.ok(!html.includes("Awaiting live data"), `${account.label}: ${route}`);
}

console.log(
  `PASS: supervisor, outgoing A/B, incoming pair and untouched scheduled scenario verified (${scenario.shiftId}; ${scenario.taskId}).`,
);
