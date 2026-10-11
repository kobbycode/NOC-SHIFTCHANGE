import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const project = "demo-shiftchange-v2", origin = "http://localhost:3100";
if (process.env.FIREBASE_PROJECT_ID !== project || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== project || process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080") throw new Error("Refusing inspection outside the isolated demo.");
const accounts = JSON.parse(await readFile(".demo/credentials.json", "utf8")), scenario = JSON.parse(await readFile(".demo/presentation.json", "utf8"));
for (const index of [0, 1, 2, 4]) {
  const account = accounts[index];
  const auth = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-presentation-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true }) });
  assert.equal(auth.status, 200); const { idToken } = await auth.json();
  const session = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ idToken }) });
  assert.equal(session.status, 200); const Cookie = session.headers.get("set-cookie").split(";")[0];
  const pages = index === 0 ? [["/admin", ["Administration Overview", "Total users", "Broadcast stations"]]] : [
    [`/${account.role}`, [index === 1 ? "Supervisor Overview" : "Technician Overview"]],
    [`/${account.role}/handovers`, ["Shift handovers", scenario.shiftId]],
    [`/${account.role}/handovers/${scenario.shiftId}`, ["A. Staff information", "B. Attendance and reporting", "C. Broadcast status", "D. Faults and technical activities", "E. Outside broadcasts", "Controlled report corrections", "Transfer receipt", "Authenticated report binding", "Print / Save as PDF"]],
  ];
  for (const [path, expected] of pages) {
    const response = await fetch(origin + path, { headers: { Cookie } }); assert.equal(response.status, 200, path);
    const html = await response.text(); for (const phrase of expected) assert.ok(html.includes(phrase), `${path}: ${phrase}`);
    assert.ok(!html.includes("Awaiting live data"), path);
    console.log(`PASS: authenticated ${account.label}: ${path}`);
  }
}
console.log("Final server-rendered dashboards, scoped handover lists, report sections and printable receipts verified. Browser interaction remains a separate check.");
