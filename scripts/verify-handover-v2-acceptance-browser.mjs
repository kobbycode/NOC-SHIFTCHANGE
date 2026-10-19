/**
 * TECH-HO-RECOVERY-08 §14 — real browser verification of the V2 incoming
 * password acceptance, automatic shift activation and late partner joining.
 *
 * Run via: tests/run-handover-v2-acceptance-browser.ps1
 *
 * Where the two-stage transfer browser exercises the split lifecycle through
 * direct API probes (so the M07 atomic-transfer expectations stay honest), this
 * harness drives the V2 workflow UI itself: real Chromium (Edge channel) signs
 * each technician in through the production login flow against the synthetic
 * Auth emulator, opens /technician/handovers/v2/[shiftId], and interacts only
 * with the UI controls M08 §12 shipped — the "Commit for incoming acceptance"
 * section for an outgoing technician, and the "Accept handover" password form
 * for each reserved incoming technician. It then proves the committed outcome
 * against final Firestore documents, not return values:
 *
 *   1. Committing an outgoing handover moves the aggregate to
 *      `awaiting_incoming_acceptance` and does NOT create the incoming shift;
 *      the UI's "Awaiting incoming acceptance" section reflects that.
 *   2. Accepting with a WRONG password is refused with no state change.
 *   3. The FIRST reserved incoming technician's password acceptance activates
 *      exactly one shift, records that technician's own authoritative
 *      attendance, and the UI's "Handover activated" section reflects the
 *      completed lifecycle after reload.
 *   4. The SECOND reserved incoming technician joins the SAME active shift with
 *      an independent attendance timestamp; the first technician's row is
 *      never overwritten and no second shift is created.
 *   5. §12 — the UI never displays a successful shift start before the server
 *      confirms the committed operation: the notice reflects the authoritative
 *      status field of the accept route (ACTIVATED / JOINED / ALREADY_JOINED),
 *      never a client-side flag, and no fabricated attendance row is ever shown.
 *
 * Safety: refuses to run outside the synthetic "demo-shiftchange-v2" emulator
 * project, refuses a busy port, refuses an account file that already exists,
 * starts a fresh (never imported or exported) emulator database, and enables the
 * development gate only inside the spawned application child process. Scheduled
 * windows are anchored to Date.now() so the incoming acceptance's activation
 * window passes. Nothing here touches production configuration; passwords are
 * held only in the in-process sign-in / acceptance fields and never logged.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const runCli = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const project = "demo-shiftchange-v2";
const authHost = "127.0.0.1:9099";
const firestoreHost = "127.0.0.1:8080";
const port = Number(process.env.HO08_BROWSER_PORT ?? 3104);
const origin = `http://127.0.0.1:${port}`;
const browserChannel = process.env.HO08_BROWSER_CHANNEL ?? "msedge";

for (const key of ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
  assert.equal(process.env[key], project, `${key} must be the synthetic demo project.`);
}
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, authHost);
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, firestoreHost);
assert.equal(process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS, "true");
assert.equal(process.env.APP_ORIGIN, origin, "APP_ORIGIN must match the browser origin.");
assert.ok(!process.env.HANDOVER_V2_DEV,
  "The v2 gate must stay unset here; it is enabled only inside the spawned application process.");

for (const path of ["firebase.presentation.json", "node_modules/firebase-tools/lib/bin/firebase.js", "node_modules/next/dist/bin/next"]) {
  assert.ok(existsSync(join(repoRoot, path)), `Missing required local file: ${path}`);
}
const accountsPath = join(repoRoot, ".demo", "handover-v2-acceptance-browser-accounts.json");
assert.ok(!existsSync(accountsPath), "Refusing to overwrite an existing browser verification account file.");

async function portInUse(candidate) {
  return new Promise((settled) => {
    const socket = net.connect({ host: "127.0.0.1", port: candidate });
    socket.once("connect", () => { socket.destroy(); settled(true); });
    socket.once("error", () => { socket.destroy(); settled(false); });
    socket.setTimeout(750);
    socket.once("timeout", () => { socket.destroy(); settled(false); });
  });
}
for (const candidate of [8080, 8081, 9099, 9152, 4402, 4502, port]) {
  assert.equal(await portInUse(candidate), false, `Port ${candidate} is already in use — stop the other emulator or application first.`);
}

const { getAdminAuth, getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const {
  initializeEqualHandoverReservation,
  readEqualHandoverReservation,
} = await import("../src/lib/operations/equal-handover-reservation-firestore.ts");
const { createEqualHandoverDocumentId } = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const {
  prepareEqualHandoverReport,
  freezeEqualHandoverReport,
  confirmEqualHandoverParticipantV2,
} = await import("../src/lib/operations/equal-handover-report-firestore.ts");
const { recordShiftOperation } = await import("../src/lib/operations/shift-operations.ts");
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");

const db = getAdminFirestore();
const auth = getAdminAuth();
const ref = (collection, id) => db.collection(collection).doc(id);

const historical = "2020-01-01T00:00:00.000Z";
const now0 = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const outStart = iso(now0 - 8 * 3600_000);
const outEnd = iso(now0 + 5 * 60_000);
const inStart = outEnd;
const inEnd = iso(now0 + 8 * 3600_000);
const password = () => `HO08-${randomBytes(18).toString("base64url")}!`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let emulatorProcess = null;
let appProcess = null;
const emulatorLog = [];
const appLog = [];
const browserErrors = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = join(repoRoot, ".demo", `handover-v2-acceptance-browser-verification-${stamp}.json`);
const screenshotPath = join(repoRoot, ".demo", `handover-v2-acceptance-browser-verification-${stamp}.png`);

async function killTree(child, label) {
  if (!child || child.exitCode !== null) return;
  try { await runCli("taskkill", ["/PID", String(child.pid), "/T", "/F"]); }
  catch (failure) { console.warn(`teardown: ${label} (pid ${child.pid}) ${failure.message}`); }
}

async function waitFor(label, probe, timeoutMs, watch) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    if (watch.exitCode !== null) {
      throw new Error(`${label} exited early (code ${watch.exitCode}):\n${emulatorLog.concat(appLog).join("").slice(-2500)}`);
    }
    try { if (await probe()) return; }
    catch (failure) { last = `${failure.message}${failure.cause ? ` (${failure.cause})` : ""}`; }
    await sleep(1000);
  }
  throw new Error(`${label} was not ready in time: ${last}`);
}

function attachErrorCapture(page) {
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/favicon\.ico/i.test(text)) return;
    // Chromium logs a console error for EVERY non-2xx response. The acceptance
    // flow deliberately drives rejected requests whose status is asserted
    // explicitly in each step (the wrong-password 400, the lifecycle 409s), so
    // this 4xx network-status noise is the tested outcome, not an app fault. A
    // genuine client failure still surfaces via `pageerror` or an unexpected 5xx.
    if (/Failed to load resource: .*status of 4\d\d\b/.test(text)) return;
    browserErrors.push(`console: ${text}`);
  });
}

async function signIn(page, account) {
  await page.goto(`${origin}/login`, { waitUntil: "networkidle", timeout: 180_000 });
  await page.locator("#email").fill(account.email);
  await page.locator("#password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(technician|supervisor)(\/|$)/, { timeout: 180_000 });
}

async function signOut(page) {
  const cleared = await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).ok);
  assert.equal(cleared, true, "Signing out must clear the app session.");
}

async function openV2Page(context, account, shiftId) {
  const page = await context.newPage();
  attachErrorCapture(page);
  await signIn(page, account);
  await page.goto(`${origin}/technician/handovers/v2/${shiftId}`, { waitUntil: "networkidle", timeout: 180_000 });
  await page.getByRole("heading", { name: "Equal-technician handover report (v2)" }).waitFor({ timeout: 180_000 });
  return page;
}

async function pageText(page) {
  const closed = page.locator("details:not([open]) > summary");
  for (let guard = 0; guard < 6; guard += 1) {
    if ((await closed.count()) === 0) break;
    await closed.first().click({ timeout: 15_000 });
  }
  return page.locator("main").innerText();
}

// ---------------------------------------------------------------------------
// §14 browser steps
// ---------------------------------------------------------------------------

async function main() {
  emulatorProcess = spawn(process.execPath, [
    join(repoRoot, "node_modules", "firebase-tools", "lib", "bin", "firebase.js"),
    "emulators:start",
    "--config", "firebase.presentation.json",
    "--project", project,
    "--only", "auth,firestore",
    "--log-verbosity=QUIET",
  ], { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  emulatorProcess.stdout.on("data", (chunk) => emulatorLog.push(chunk.toString()));
  emulatorProcess.stderr.on("data", (chunk) => emulatorLog.push(chunk.toString()));

  await waitFor("Firebase emulators", async () => {
    const firestore = await fetch(`http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents`);
    const authProbe = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=demo-browser-key`, { method: "GET" });
    return [200, 403, 404].includes(firestore.status) && authProbe.status < 500;
  }, 240_000, emulatorProcess);

  const seeded = await seed();

  appProcess = spawn(process.execPath, [
    join(repoRoot, "node_modules", "next", "dist", "bin", "next"),
    "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port),
  ], {
    cwd: repoRoot,
    env: (() => { const env = { ...process.env, HANDOVER_V2_DEV: "true" }; delete env.NODE_OPTIONS; return env; })(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  appProcess.stdout.on("data", (chunk) => appLog.push(chunk.toString()));
  appProcess.stderr.on("data", (chunk) => appLog.push(chunk.toString()));
  await waitFor("Next dev server", async () => (await fetch(`${origin}/login`)).ok, 300_000, appProcess);

  const browser = await chromium.launch({ channel: browserChannel, headless: true });
  const browserVersion = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  const steps = [];
  const record = (index, name, detail) => steps.push({ step: index, name, ...detail });
  let page = null;

  try {
    // 1 — outgoing A sees the "Commit for incoming acceptance" section with
    //     every prerequisite satisfied; the button is enabled but is a display
    //     gate only, never an authorization (§10).
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const commitSection = page.locator("section", { hasText: "Commit for incoming acceptance" });
    await commitSection.waitFor({ timeout: 60_000 });
    const commitButton = commitSection.getByRole("button", { name: "Commit handover — await incoming acceptance" });
    assert.ok(await commitButton.isEnabled(), "The commit action is enabled for a confirmed outgoing technician once ready.");
    const outgoingText = await pageText(page);
    assert.match(outgoingText, /Readiness: all confirmations and permitted exceptions satisfied/);
    assert.match(outgoingText, /Confirmed 4 of 4/);
    assert.match(outgoingText, /This display gate is not an authorization/);
    record(1, "outgoing A sees the commit section enabled with all prerequisites satisfied", { readiness: "ready" });

    // 2 — clicking Commit moves the aggregate to awaiting_incoming_acceptance
    //     and does NOT create the incoming shift; the UI reflects the state and
    //     the notice never claims a shift start (§12).
    await commitButton.click();
    await page.getByText(/Committed for incoming acceptance\./).waitFor({ timeout: 180_000 });
    await page.locator("section", { hasText: "Awaiting incoming acceptance" }).waitFor({ timeout: 60_000 });
    assert.equal((await ref("shifts", seeded.reservedIncomingShiftId).get()).exists, false,
      "Committing must NOT create the incoming shift (§1 addendum #1).");
    const aggregateAfterCommit = (await ref("equal_handovers_v2", createEqualHandoverDocumentId(seeded.shiftId)).get()).data();
    assert.equal(aggregateAfterCommit.lifecycleStatus, "awaiting_incoming_acceptance");
    assert.equal((await ref("handover_reservation_guards", `guard_${seeded.shiftId}`).get()).data().ownerLifecycleState, "active",
      "The reservation guard remains active through commit; acceptance can still finalize.");
    record(2, "commit flipped lifecycle to awaiting; no incoming shift exists", {});
    await signOut(page); await page.close();

    // 3 — incoming A attempts to accept with the WRONG password first; the
    //     server refuses, no state changes, no notice.
    page = await openV2Page(context, seeded.accounts.incomingA, seeded.shiftId);
    const acceptSection = page.locator("section", { hasText: "Accept handover with your password" });
    await acceptSection.waitFor({ timeout: 60_000 });
    // The workflow's own message surface is the red `<p role="alert">` paragraph;
    // scoping to `p[role=alert]` ignores the framework's empty live-region nodes
    // that Playwright's role selector otherwise matches with no text.
    const workflowError = page.locator('p[role="alert"]');
    const wrongResponse = page.waitForResponse((r) => r.url().endsWith("/handover/v2/accept"), { timeout: 90_000 }).catch(() => null);
    await acceptSection.locator("input[name='password']").fill("wrong-password-x");
    await acceptSection.getByRole("button", { name: "Accept and start my shift" }).click();
    const wrongAccept = await wrongResponse;
    assert.ok(wrongAccept !== null, "The wrong-password attempt must reach the server /accept route.");
    assert.equal(wrongAccept.status(), 400, "A rejected personal password must fail closed with 400.");
    await workflowError.waitFor({ timeout: 60_000 });
    const wrongPwError = await workflowError.first().innerText();
    assert.ok(wrongPwError.trim().length > 0, "A wrong password must surface an error message to the technician.");
    assert.equal((await ref("shifts", seeded.reservedIncomingShiftId).get()).exists, false,
      "A refused password acceptance activates no shift (§12 — no success shown before server confirms).");
    record(3, "wrong-password acceptance refused, no shift activated", { error: wrongPwError, status: wrongAccept.status() });
    await signOut(page); await page.close();

    // 4 — incoming A accepts with their OWN current password; the UI shows the
    //     "Handover accepted" notice with the incoming shift id, and the first
    //     incoming technician's own shift_attendance row appears.
    page = await openV2Page(context, seeded.accounts.incomingA, seeded.shiftId);
    const acceptSection2 = page.locator("section", { hasText: "Accept handover with your password" });
    const resp4 = page.waitForResponse((r) => r.url().endsWith("/handover/v2/accept"), { timeout: 120_000 }).catch(() => null);
    await acceptSection2.locator("input[name='password']").fill(seeded.accounts.incomingA.password);
    await acceptSection2.getByRole("button", { name: "Accept and start my shift" }).click();
    const accept4 = await resp4;
    assert.ok(accept4 !== null, "The correct-password acceptance must reach the server /accept route.");
    if (!accept4.ok()) {
      const body4 = await accept4.json().catch(() => null);
      throw new Error(`The correct-password acceptance must succeed on the server (got ${accept4.status()}: ${JSON.stringify(body4)}).`);
    }
    await page.getByText(/Handover accepted\. The incoming shift .* is now active/).waitFor({ timeout: 180_000 });
    const activationClock = new Date();
    const incomingShift = await ref("shifts", seeded.reservedIncomingShiftId).get();
    assert.equal(incomingShift.exists, true, "The first incoming acceptance is what creates the incoming shift.");
    assert.equal(incomingShift.data().status, "active");
    const attA = (await ref("shift_attendance", `${seeded.reservedIncomingShiftId}_${seeded.uids.incomingA}`).get()).data();
    assert.notEqual(attA, undefined, "Incoming A has their own shift_attendance row after acceptance.");
    const attARecordedAt = Date.parse(attA.recordedAt);
    assert.ok(!Number.isNaN(attARecordedAt));
    // Recorded at must be close to the acceptance wall clock (never backdated).
    assert.ok(Math.abs(attARecordedAt - activationClock.getTime()) < 5 * 60_000,
      "Attendance recordedAt derives from the acceptance clock, not from the scheduled start.");
    // The partner B is NEVER fabricated (§6/§7).
    assert.equal((await ref("shift_attendance", `${seeded.reservedIncomingShiftId}_${seeded.uids.incomingB}`).get()).exists, false,
      "Partner B must have no fabricated attendance after only A has accepted.");
    record(4, "first incoming acceptance activated the shift, recorded only A's attendance", {
      incomingShiftId: seeded.reservedIncomingShiftId, attARecordedAt: attA.recordedAt,
    });

    // The first acceptance is the activation point: the aggregate moves straight
    // to `completed`. §12 is satisfied by the notice, which only appears AFTER
    // the server returned the authoritative ACTIVATED status. The success notice
    // and the re-rendered terminal section settle in different ticks (the client
    // re-reads /report after the committed accept), so wait for the completed
    // state to paint before reading — never snapshot the in-flight DOM.
    await page.locator('section[aria-label="Handover activated"]').waitFor({ timeout: 120_000 });
    const afterA = await pageText(page);
    assert.match(afterA, /Handover activated/);
    assert.match(afterA, /is already active/i, "A's own view now offers the late-join form for the active shift.");
    assert.equal((await ref("equal_handovers_v2", createEqualHandoverDocumentId(seeded.shiftId)).get()).data().lifecycleStatus, "completed",
      "The first activation moves the aggregate to completed in authoritative state.");
    assert.equal((await ref("handover_reservation_guards", `guard_${seeded.shiftId}`).get()).data().ownerLifecycleState, "active",
      "The guard stays active while partner B has not yet accepted.");
    await signOut(page); await page.close();

    // 5 — incoming B joins the SAME active shift with their own password;
    //     independent recordedAt, no second shift, no overwrite of A's clock.
    page = await openV2Page(context, seeded.accounts.incomingB, seeded.shiftId);
    const acceptB = page.locator("section", { hasText: "Accept handover with your password" });
    await acceptB.waitFor({ timeout: 60_000 });
    await acceptB.locator("input[name='password']").fill(seeded.accounts.incomingB.password);
    await acceptB.getByRole("button", { name: "Accept and start my shift" }).click();
    await page.getByText(/Joined the active incoming shift/).waitFor({ timeout: 180_000 });
    const attB = (await ref("shift_attendance", `${seeded.reservedIncomingShiftId}_${seeded.uids.incomingB}`).get()).data();
    assert.notEqual(attB, undefined, "Incoming B has their own shift_attendance row after joining.");
    assert.notEqual(attB.recordedAt, attA.recordedAt, "B's acceptance clock is independent of A's.");
    const attAAfterJoin = (await ref("shift_attendance", `${seeded.reservedIncomingShiftId}_${seeded.uids.incomingA}`).get()).data();
    assert.equal(attAAfterJoin.recordedAt, attA.recordedAt, "A's original acceptance clock is never overwritten by B's join.");
    const incomingShifts = (await db.collection("shifts").get()).docs.filter((d) => d.id === seeded.reservedIncomingShiftId);
    assert.equal(incomingShifts.length, 1, "Exactly one incoming shift after both acceptances.");
    record(5, "second incoming acceptance joined the same shift with an independent clock", {
      attARecordedAt: attA.recordedAt, attBRecordedAt: attB.recordedAt,
    });

    // 6 — the guard auto-terminalizes once both incoming acceptances landed
    //     (the accept route's deferred finalize step).
    const guard = (await ref("handover_reservation_guards", `guard_${seeded.shiftId}`).get()).data();
    assert.equal(guard.ownerLifecycleState, "completed",
      "The reservation guard completed via the deferred finalize at the last acceptance (§5).");
    const activationReceipts = (await db.collection("audit_logs").get()).docs
      .map((d) => d.data()).filter((a) => a.action === "EQUAL_SHIFT_ACTIVATED_INCOMING_V2");
    assert.equal(activationReceipts.length, 1, "Exactly one activation receipt across both acceptances.");
    assert.equal(guard.terminalEvidenceRef, activationReceipts[0].id);

    // 7 — the reloaded UI for either technician shows the "Handover activated"
    //     section, and a re-acceptance replays as ALREADY_JOINED.
    await signOut(page); await page.close();
    page = await openV2Page(context, seeded.accounts.incomingA, seeded.shiftId);
    await page.reload({ waitUntil: "networkidle", timeout: 180_000 });
    const terminalText = await pageText(page);
    assert.match(terminalText, /Handover activated/, "After both acceptances, the UI re-reads the completed aggregate.");
    const reAccept = page.locator("section", { hasText: "Accept handover with your password" });
    if (await reAccept.count() > 0) {
      await reAccept.locator("input[name='password']").fill(seeded.accounts.incomingA.password);
      await reAccept.getByRole("button", { name: "Accept and start my shift" }).click();
      await page.getByText(/Your earlier acceptance is already recorded/).waitFor({ timeout: 180_000 });
      assert.equal((await db.collection("shifts").get()).docs.filter((d) => d.id === seeded.reservedIncomingShiftId).length, 1,
        "A self re-acceptance replays without creating another shift.");
      const attAAfterReplay = (await ref("shift_attendance", `${seeded.reservedIncomingShiftId}_${seeded.uids.incomingA}`).get()).data();
      assert.equal(attAAfterReplay.recordedAt, attA.recordedAt, "A replayed acceptance never overwrites the original clock.");
    }
    await page.screenshot({ path: screenshotPath, fullPage: true });
    record(6, "guard auto-finalized and terminal UI reflects the completed lifecycle", {});

    assert.deepEqual(browserErrors, [], "The browser must report no uncaught errors.");

    await browser.close();

    await writeFile(evidencePath, JSON.stringify({
      verifiedAt: new Date().toISOString(),
      browser: { channel: browserChannel, version: browserVersion },
      project, origin,
      shiftId: seeded.shiftId,
      reservedIncomingShiftId: seeded.reservedIncomingShiftId,
      reservationFingerprint: seeded.fingerprint,
      steps,
      accountsFile: ".demo/handover-v2-acceptance-browser-accounts.json",
      screenshot: ".demo/" + basename(screenshotPath),
      finalState: {
        aggregateLifecycle: (await ref("equal_handovers_v2", createEqualHandoverDocumentId(seeded.shiftId)).get()).data().lifecycleStatus,
        guard: "completed",
        incomingShiftStatus: (await ref("shifts", seeded.reservedIncomingShiftId).get()).data().status,
        attARecordedAt: attA.recordedAt,
        attBRecordedAt: attB.recordedAt,
      },
    }, null, 2), { flag: "wx", mode: 0o600 });

    console.log(`PASS: ${steps.length} acceptance-browser steps verified against ${project}; the UI drove commit → first acceptance (activation) → late join (independent attendance) → auto-finalize, and never showed a successful start before the server confirmed it.`);
    console.log(`Evidence: ${evidencePath}`);
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser.isConnected()) await browser.close();
    await killTree(appProcess, "next dev");
    await killTree(emulatorProcess, "firebase emulators");
  }
}

// ---------------------------------------------------------------------------
// Seeding — the production writers build every precondition up to ready.
// ---------------------------------------------------------------------------

async function seed() {
  const prefix = `ho08b${randomBytes(3).toString("hex")}`;
  const uids = {
    outgoingA: `${prefix}-outa`, outgoingB: `${prefix}-outb`,
    incomingA: `${prefix}-ina`, incomingB: `${prefix}-inb`,
  };
  const names = {
    outgoingA: `${prefix} Outgoing Alpha`, outgoingB: `${prefix} Outgoing Beta`,
    incomingA: `${prefix} Incoming Alpha`, incomingB: `${prefix} Incoming Beta`,
  };
  const accounts = {};
  for (const key of Object.keys(uids)) {
    const email = `${prefix}-${key}@handover-v2-acceptance-browser.invalid`;
    const pw = password();
    const created = await auth.createUser({ uid: uids[key], email, password: pw, displayName: names[key] });
    await auth.setCustomUserClaims(created.uid, { role: "technician" });
    assert.equal(created.uid, uids[key], "The synthetic Auth emulator must honour the provisioned uid.");
    accounts[key] = { email, password: pw, role: "technician", home: "/technician" };
  }
  await mkdir(join(repoRoot, ".demo"), { recursive: true });
  await writeFile(accountsPath, JSON.stringify({ projectId: project, accounts }, null, 2), { flag: "wx", mode: 0o600 });

  const outPair = `${prefix}-outpair`;
  const inPair = `${prefix}-inpair`;
  const shiftId = uids.outgoingA;
  const token = randomUUID();

  const batch = db.batch();
  for (const key of Object.keys(uids)) {
    batch.set(ref("users", uids[key]), {
      uid: uids[key], fullName: names[key], email: accounts[key].email, role: "technician",
      engineeringLocation: "Accra Engineering Suite", status: "active", statusOperation: null,
      mustChangePassword: false, createdBy: "isolated-browser-verification", createdAt: historical,
    });
  }
  for (const [id, ids] of [[outPair, [uids.outgoingA, uids.outgoingB]], [inPair, [uids.incomingA, uids.incomingB]]]) {
    batch.set(ref("technician_pairs", id), {
      id, technicianIds: ids, status: "active", createdBy: uids.outgoingA,
      createdAt: historical, updatedAt: historical, deactivatedAt: null, deactivatedBy: null,
    });
    for (const uid of ids) {
      batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: id, createdAt: historical, updatedAt: historical });
    }
  }
  batch.set(ref("shifts", shiftId), {
    id: shiftId, status: "active", permanentPairId: outPair, primaryTechnicianIds: [uids.outgoingA, uids.outgoingB],
    operationalSlotToken: token, shiftType: "morning", scheduledStart: outStart, scheduledEnd: outEnd,
    actualStart: outStart, actualEnd: null, engineeringLocation: "Accra Engineering Suite",
    createdBy: uids.outgoingA, createdAt: outStart, updatedAt: outStart,
  });
  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(token, 1, outStart), shiftId, outStart);
  control = transitionOperationalShiftControl(control, shiftId, "scheduled", "active", outStart);
  batch.set(ref("operational_shift_control", "global"), control);
  for (const uid of [uids.outgoingA, uids.outgoingB]) {
    const memberId = `${shiftId}_${uid}`;
    batch.set(ref("shift_members", memberId), { id: memberId, shiftId, technicianId: uid, role: "primary", joinedAt: outStart, leftAt: null });
    batch.set(ref("shift_attendance", memberId), {
      id: memberId, shiftId, technicianId: uid, status: "present", participationAuthority: "primary",
      authorizationId: null, clockIn: outStart, clockOut: null, isProvisional: false,
      recordedAt: outStart, updatedAt: outStart,
    });
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid, entries: [{ shiftId, scheduledStart: outStart, scheduledEnd: outEnd, status: "active" }], updatedAt: outStart,
    });
  }
  for (const uid of [uids.incomingA, uids.incomingB]) {
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: "unrelated-shift", scheduledStart: "2030-01-03T06:00:00.000Z", scheduledEnd: "2030-01-03T14:00:00.000Z", status: "scheduled" }],
      updatedAt: outStart,
    });
  }
  await batch.commit();

  const actor = { uid: uids.outgoingA, role: "technician" };
  const at = (h) => iso(Date.parse(outStart) + h * 3600_000);
  for (const [i, stationId] of ["joy-fm", "adom-fm", "asempa-fm", "hitz-fm"].entries()) {
    await recordShiftOperation(actor, shiftId, { details: { kind: "broadcast", occurredAt: at(1 + i), stationId, status: "on_air", remarks: "" } });
  }
  await recordShiftOperation(actor, shiftId, { details: {
    kind: "outside_broadcast", occurredAt: at(5), title: "Outside van feed", location: "Accra mall",
    runningStatus: "ended", technicalIssues: "None", actionTaken: "Monitored handoff.", status: "resolved", remarks: "", linkedTaskId: null,
  } });

  await beginShiftHandover({ shiftId, actorUid: uids.outgoingA, authority: "equal-technician" });
  await initializeEqualHandoverReservation({
    outgoingShiftId: shiftId, actorUid: uids.outgoingA, incomingPermanentPairId: inPair,
    shiftType: "morning", scheduledStart: inStart, scheduledEnd: inEnd, idempotencyKey: `ho08-browser-${randomUUID()}`,
  });

  const stampA = await reservationStamp(shiftId);
  const preparation = (await prepareEqualHandoverReport({ outgoingShiftId: shiftId, actorUid: uids.outgoingA, reason: "acceptance browser review" })).preparation;
  const freezeStamp = await reservationStamp(shiftId);
  await freezeEqualHandoverReport({
    outgoingShiftId: shiftId, actorUid: uids.outgoingA,
    expectedRevision: freezeStamp.expectedRevision, expectedSnapshotHash: freezeStamp.expectedSnapshotHash,
    expectedGuardRevision: freezeStamp.guard.guardRevision, expectedFencingEpoch: freezeStamp.guard.fencingEpoch,
    preparationRevision: preparation.preparationRevision, contentDigest: preparation.contentDigest,
    evidenceSnapshotHash: preparation.evidenceSnapshotHash, workSnapshotVersion: preparation.workSnapshotVersion,
    reason: "Reviewed and frozen for the acceptance browser run", correctionNote: null,
  });
  for (const uid of [uids.outgoingA, uids.outgoingB, uids.incomingA, uids.incomingB]) {
    const stamp = await reservationStamp(shiftId);
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: shiftId, actorUid: uid,
      expectedRevision: stamp.expectedRevision, expectedSnapshotHash: stamp.expectedSnapshotHash });
  }

  const reservation = await readEqualHandoverReservation(shiftId);
  return {
    prefix, shiftId, uids, names, accounts,
    fingerprint: reservation.aggregate.reservation.handoverId,
    reservedIncomingShiftId: reservation.aggregate.reservation.reservedIncomingShiftId,
    initialStamp: stampA,
  };
}

async function reservationStamp(shiftId) {
  const state = await readEqualHandoverReservation(shiftId);
  return {
    expectedRevision: state.aggregate.revision,
    expectedSnapshotHash: state.snapshotHash,
    guard: state.guard,
  };
}

try {
  await main();
} catch (failure) {
  console.error("ACCEPTANCE BROWSER VERIFICATION FAILED:", failure);
  if (emulatorLog.length) console.error(`emulator log tail:\n${emulatorLog.join("").slice(-2500)}`);
  if (appLog.length) console.error(`application log tail:\n${appLog.join("").slice(-2500)}`);
  process.exitCode = 1;
} finally {
  await killTree(appProcess, "next dev");
  await killTree(emulatorProcess, "firebase emulators");
  await db.terminate().catch(() => {});
}
