/**
 * TECH-HO-RECOVERY-05 §15 — real browser verification of the equal-technician
 * v2 handover report workflow.
 *
 * Run via: tests/run-handover-v2-report-browser.ps1
 *
 * What this proves: a real Chromium (Edge channel) browser signs in through the
 * production login flow against the synthetic Auth emulator, walks the actual
 * /technician/handovers workspace into the dedicated v2 report page, and drives
 * prepare → declare absence → re-prepare → freeze through the real v2 API routes
 * with a real session cookie. A second outgoing technician then clears the
 * declaration, prepares a new revision and freezes a corrected version, proving
 * equal review authority. Prohibited incoming and supervisor mutations are
 * attempted from the browser and denied. Every step is asserted against final
 * Firestore documents and audit evidence, not only API return values.
 *
 * Safety: refuses to run outside the synthetic "demo-shiftchange-v2" emulator
 * project, refuses a busy port, refuses an account file that already exists,
 * starts a fresh (never imported or exported) emulator database, and enables
 * the development gate only inside the spawned application child process.
 * Nothing here touches production configuration; no password is ever logged.
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
const port = Number(process.env.HO05_BROWSER_PORT ?? 3101);
const origin = `http://127.0.0.1:${port}`;
const browserChannel = process.env.HO05_BROWSER_CHANNEL ?? "msedge";

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
const accountsPath = join(repoRoot, ".demo", "handover-v2-browser-accounts.json");
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
const { createEqualHandoverPreparationDocumentId } = await import("../src/lib/operations/equal-handover-report-domain.ts");
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
const scheduledStart = "2030-01-01T06:00:00.000Z";
const scheduledEnd = "2030-01-01T14:00:00.000Z";
const password = () => `HO05-${randomBytes(18).toString("base64url")}!`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let emulatorProcess = null;
let appProcess = null;
const emulatorLog = [];
const appLog = [];
const browserErrors = [];
// Chrome logs "Failed to load resource" for every deliberate non-2xx probe in
// step 11. Those are expected network outcomes, not uncaught application
// errors; they are counted, asserted against the probe list and recorded.
const resourceStatusErrors = [];
let deniedProbeWindow = 0;
let expectedDenials = 0;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = join(repoRoot, ".demo", `handover-v2-browser-verification-${stamp}.json`);
const screenshotPath = join(repoRoot, ".demo", `handover-v2-browser-verification-${stamp}.png`);

async function killTree(child, label) {
  if (!child || child.exitCode !== null) return;
  try {
    await runCli("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  } catch (failure) {
    console.warn(`teardown: ${label} (pid ${child.pid}) ${failure.message}`);
  }
}

async function waitFor(label, probe, timeoutMs, watch) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    if (watch.exitCode !== null) {
      throw new Error(`${label} exited early (code ${watch.exitCode}):\n${emulatorLog.concat(appLog).join("").slice(-2500)}`);
    }
    try {
      if (await probe()) return;
    } catch (failure) {
      last = `${failure.message}${failure.cause ? ` (${failure.cause})` : ""}`;
    }
    await sleep(1000);
  }
  throw new Error(`${label} was not ready in time: ${last}`);
}

function attachErrorCapture(page) {
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // The browser always requests /favicon.ico; that resource 404 is not an
    // application error and is reported in the evidence file instead.
    if (/favicon\.ico/i.test(text)) return;
    // Chrome logs a resource error for the deliberate denied mutations issued
    // inside prohibitedPost(); those network results are asserted evidence.
    if (deniedProbeWindow > 0 && /Failed to load resource/.test(text) && /403/.test(text)) {
      resourceStatusErrors.push(text);
      return;
    }
    browserErrors.push(`console: ${text}`);
  });
}

async function signIn(page, account) {  await page.goto(`${origin}/login`, { waitUntil: "networkidle", timeout: 180_000 });
  await page.locator("#email").fill(account.email);
  await page.locator("#password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(technician|supervisor|admin)(\/|$)/, { timeout: 180_000 });
  const landedOn = new URL(page.url()).pathname;
  assert.ok(landedOn.startsWith(account.home), `Expected ${account.home}, landed on ${landedOn}.`);
  return landedOn;
}

// The operational event log and the preparation revision history render inside
// collapsed <details>, so a real reader must open them before their evidence
// can be asserted from the rendered page.
async function pageText(page) {
  const closed = page.locator("details:not([open]) > summary");
  for (let guard = 0; guard < 6; guard += 1) {
    if ((await closed.count()) === 0) break;
    await closed.first().click({ timeout: 15_000 });
  }
  return page.locator("main").innerText();
}

async function signOut(page) {
  const cleared = await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).ok);
  assert.equal(cleared, true, "Signing out must clear the app session.");
}

async function prohibitedPost(page, shiftId, suffix, body) {
  deniedProbeWindow += 1;
  try {
    const result = await page.evaluate(async ([id, path, payload]) => {
      const response = await fetch(`/api/operations/shifts/${encodeURIComponent(id)}/handover/v2${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }, [shiftId, suffix, body]);
    if (result.status === 403) expectedDenials += 1;
    return result;
  } finally {
    deniedProbeWindow -= 1;
  }
}

function canonical(snapshot) {
  const data = snapshot.exists ? snapshot.data() : null;
  return JSON.stringify(data, (key, value) => (value && typeof value.toDate === "function" ? { __ts: value.toISOString() } : value));
}

async function collectionSnapshot(name) {
  const snapshot = await db.collection(name).get();
  return JSON.stringify(snapshot.docs.map((doc) => [doc.id, doc.data()]).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------------------
// §15 steps 1-11
// ---------------------------------------------------------------------------

async function main() {
  // --- synthetic emulators, fresh database, demo project only ---------------
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
    // The Firestore emulator answers this REST path with 403/404 depending on
    // rules and collection shape; any of those responses proves it is serving.
    const firestore = await fetch(`http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents`);
    const authProbe = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=demo-browser-key`, { method: "GET" });
    return [200, 403, 404].includes(firestore.status) && authProbe.status < 500;
  }, 240_000, emulatorProcess);

  const seeded = await seed();

  // --- application server with the development gate enabled ----------------
  appProcess = spawn(process.execPath, [
    join(repoRoot, "node_modules", "next", "dist", "bin", "next"),
    "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port),
  ], {
    cwd: repoRoot,
    env: (() => {
      const env = { ...process.env, HANDOVER_V2_DEV: "true" };
      delete env.NODE_OPTIONS;
      return env;
    })(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  appProcess.stdout.on("data", (chunk) => appLog.push(chunk.toString()));
  appProcess.stderr.on("data", (chunk) => appLog.push(chunk.toString()));
  await waitFor("Next dev server", async () => (await fetch(`${origin}/login`)).ok, 300_000, appProcess);

  const browser = await chromium.launch({ channel: browserChannel, headless: true });
  const browserVersion = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const steps = [];
  const record = (index, name, detail) => steps.push({ step: index, name, ...detail });

  try {
    // 1 — sign in as outgoing technician A through the real login page.
    let page = await context.newPage();
    attachErrorCapture(page);
    const landingA = await signIn(page, seeded.accounts.outgoingA);
    record(1, "signed in as outgoing technician A", { email: seeded.accounts.outgoingA.email, landedOn: landingA });

    // 2 — reach the v2 report page through the technician workspace link.
    await page.goto(`${origin}/technician/handovers`, { waitUntil: "networkidle", timeout: 180_000 });
    await page.getByRole("heading", { name: "Equal-technician handovers (v2 preview)" }).waitFor({ timeout: 60_000 });
    await page.getByRole("link", { name: new RegExp(`^${seeded.shiftId} →`) }).click();
    await page.getByRole("heading", { name: "Equal-technician handover report (v2)" }).waitFor({ timeout: 180_000 });
    assert.equal(new URL(page.url()).pathname, `/technician/handovers/v2/${seeded.shiftId}`);
    record(2, "opened the v2 handover page", { path: new URL(page.url()).pathname });

    // 3 — the reservation and the authoritative report are loaded.
    const loaded = await pageText(page);
    for (const expected of [
      seeded.shiftId, seeded.reservedIncomingShiftId,
      seeded.names.outgoingA, seeded.names.outgoingB, seeded.names.incomingA, seeded.names.incomingB,
      "Joy FM", "Adom FM", "Asempa FM", "Hitz FM", "on_air", "Outside: Outside van feed",
      "Blockers (0)", "Live consolidated evidence", "No preparation exists yet", "Accra Engineering Suite",
    ]) {
      assert.ok(loaded.includes(expected), `The loaded report must show ${expected}.`);
    }
    assert.match(loaded, /collecting confirmations/);
    assert.match(loaded, /Guard r\d+ \/ epoch \d+/);
    assert.match(loaded, /Africa\/Accra/);
    record(3, "reservation and authoritative report loaded", {
      outgoingShiftId: seeded.shiftId,
      reservedIncomingShiftId: seeded.reservedIncomingShiftId,
      lifecycle: "collecting_confirmations",
      broadcastObservations: 4,
      blockersVisibleOnPage: 0,
    });

    // 4 — prepare the consolidated report.
    const formsA = page.locator("section", { hasText: "Outgoing technician actions" }).locator("form");
    await formsA.nth(0).locator('input[name="reason"]').fill("Reviewed shift evidence for the browser verification run");
    await formsA.nth(0).getByRole("button", { name: "Prepare consolidated report" }).click();
    await page.getByText("Consolidated report prepared for review.").waitFor({ timeout: 180_000 });
    await page.getByText("Preparation revision 1").waitFor({ timeout: 60_000 });
    record(4, "outgoing technician A prepared the report", { preparationRevision: 1 });

    // 5 — record the missing incoming colleague declaration.
    await formsA.nth(1).locator('select[name="subject"]').selectOption({ value: seeded.uids.incomingA });
    await formsA.nth(1).locator('input[name="reason"]').fill("Has not arrived at the engineering suite");
    await formsA.nth(1).getByRole("button", { name: "Declare absence" }).click();
    await page.getByText("Absence declaration recorded. Re-prepare the report to include it.").waitFor({ timeout: 180_000 });
    // The success notice appears before the refreshed server state, so wait for
    // the state-derived evidence rather than reading it too early.
    await page.getByText("Declared: not yet in").waitFor({ timeout: 60_000 });
    await page.getByText("The authoritative sources changed since the last preparation.").waitFor({ timeout: 60_000 });
    const afterAbsence = await pageText(page);
    assert.ok(afterAbsence.includes("Declared: not yet in"), "The declared absence type must render.");
    assert.ok(afterAbsence.includes("not yet in · " + seeded.uids.incomingA),
      "The declaration must name the colleague it concerns.");
    record(5, "missing incoming declaration recorded", { subject: seeded.uids.incomingA, absenceType: "not_yet_in", preparationDrifted: true });

    // 6 — re-prepare and inspect the updated revision.
    await formsA.nth(0).getByRole("button", { name: "Prepare consolidated report" }).click();
    await page.getByText("Report re-prepared for review.").waitFor({ timeout: 180_000 });
    await page.getByText("Preparation revision 2").waitFor({ timeout: 60_000 });
    const refreshed = await pageText(page);
    assert.ok(!refreshed.includes("The authoritative sources changed since the last preparation."),
      "The refreshed preparation must no longer be drifted.");
    assert.match(refreshed, /Revision history \(2\)/);
    assert.ok(refreshed.includes("not yet in"), "The refreshed report must carry the declaration.");
    record(6, "report re-prepared after the declaration", { preparationRevision: 2, blockers: 0 });

    // 7 — freeze the reviewed report.
    await formsA.nth(2).locator('input[name="reason"]').fill("Both outgoing technicians reviewed the consolidated evidence");
    await formsA.nth(2).getByRole("button", { name: "Review complete — freeze report" }).click();
    await page.getByText("Report frozen. It is now immutable.").waitFor({ timeout: 180_000 });
    await page.getByRole("heading", { name: "Frozen report content (immutable)" }).waitFor({ timeout: 60_000 });
    const frozenText = await pageText(page);
    const firstReportId = frozenText.match(/Frozen report\s+(\S+)\s+\(version 1/)[1];
    assert.match(firstReportId, /^report_v2_/);
    assert.ok(frozenText.includes("Freeze binding"), "The freeze binding evidence must render.");
    record(7, "first immutable freeze", { reportId: firstReportId, version: 1 });

    // 8 — reload the page.
    await page.reload({ waitUntil: "networkidle", timeout: 180_000 });
    await page.getByRole("heading", { name: "Equal-technician handover report (v2)" }).waitFor({ timeout: 180_000 });

    // 9 — the frozen report and its version are still present.
    const reloaded = await pageText(page);
    assert.ok(reloaded.includes(`Frozen report ${firstReportId} (version 1`),
      "A reload must re-read the frozen report from Firestore, not browser state.");
    assert.match(reloaded, /digest\s+\S+/);
    record(9, "frozen report survived a reload", { reportId: firstReportId, version: 1 });

    // 10 — outgoing technician B holds equal review authority.
    const firstReportBefore = canonical(await ref("handover_reports_v2", firstReportId).get());
    await signOut(page);
    await page.close();
    page = await context.newPage();
    attachErrorCapture(page);
    const landingB = await signIn(page, seeded.accounts.outgoingB);
    await page.goto(`${origin}/technician/handovers`, { waitUntil: "networkidle", timeout: 180_000 });
    await page.getByRole("link", { name: new RegExp(`^${seeded.shiftId} →`) }).click();
    await page.getByRole("heading", { name: "Equal-technician handover report (v2)" }).waitFor({ timeout: 180_000 });
    const asB = await pageText(page);
    assert.ok(asB.includes("Outgoing technician actions"), "The second outgoing technician must hold review actions.");
    assert.ok(asB.includes(`Frozen report ${firstReportId} (version 1`), "The frozen report is shared evidence.");
    const formsB = page.locator("section", { hasText: "Outgoing technician actions" }).locator("form");
    assert.ok(await formsB.nth(2).getByRole("button", { name: "Review complete — freeze report" }).isEnabled(),
      "Either outgoing technician may freeze the shared report.");
    await page.getByRole("button", { name: "Clear declaration" }).click();
    await page.getByText("Absence declaration cleared. Re-prepare the report to include the change.").waitFor({ timeout: 180_000 });
    await page.getByText("The authoritative sources changed since the last preparation.").waitFor({ timeout: 60_000 });
    assert.ok(!(await pageText(page)).includes("Declared: not yet in"),
      "The withdrawn declaration must disappear from the live evidence.");
    await formsB.nth(0).locator('input[name="reason"]').fill("Second outgoing technician review after the declaration was cleared");
    await formsB.nth(0).getByRole("button", { name: "Prepare consolidated report" }).click();
    await page.getByText("Report re-prepared for review.").waitFor({ timeout: 180_000 });
    await page.getByText("Preparation revision 3").waitFor({ timeout: 60_000 });
    await formsB.nth(2).locator('input[name="reason"]').fill("Corrected after the second outgoing review");
    await formsB.nth(2).locator('input[name="correctionNote"]').fill("The incoming colleague reached the suite; the declaration was withdrawn.");
    await formsB.nth(2).getByRole("button", { name: "Review complete — freeze report" }).click();
    await page.getByText("Corrected report frozen as a new immutable version.").waitFor({ timeout: 180_000 });
    await page.getByText("(version 2").waitFor({ timeout: 60_000 });
    const corrected = await pageText(page);
    const secondReportId = corrected.match(/Frozen report\s+(\S+)\s+\(version 2/)[1];
    assert.match(secondReportId, /^report_v2_/);
    assert.notEqual(secondReportId, firstReportId);
    assert.ok(corrected.includes("supersedes " + firstReportId), "The new version must name what it supersedes.");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    record(10, "equal review authority for outgoing technician B", {
      landedOn: landingB,
      clearedDeclaration: seeded.uids.incomingA,
      preparedRevision: 3,
      correctedReportId: secondReportId,
      correctedVersion: 2,
    });
    assert.equal(canonical(await ref("handover_reports_v2", firstReportId).get()), firstReportBefore,
      "The earlier frozen report must remain byte-identical.");

    // 11 — prohibited incoming and supervisor mutations are denied.
    await signOut(page);
    await page.close();
    page = await context.newPage();
    attachErrorCapture(page);
    await signIn(page, seeded.accounts.incomingA);
    await page.goto(`${origin}/technician/handovers/v2/${seeded.shiftId}`, { waitUntil: "networkidle", timeout: 180_000 });
    const incomingText = await pageText(page);
    assert.ok(incomingText.includes("Your report view is read-only, but you can confirm this handover for yourself"),
      "An incoming technician sees a read-only review with self-confirmation, not outgoing review authority.");
    assert.ok(!incomingText.includes("Outgoing technician actions"));
    const incomingDenial = await prohibitedPost(page, seeded.shiftId, "/report", { reason: "prohibited incoming preparation" });
    assert.equal(incomingDenial.status, 403, `Incoming preparation must be denied: ${JSON.stringify(incomingDenial.body)}`);
    record(11, "incoming technician denied", { endpoint: "POST /handover/v2/report", status: incomingDenial.status, error: incomingDenial.body?.error });

    await signOut(page);
    await page.close();
    page = await context.newPage();
    attachErrorCapture(page);
    await signIn(page, seeded.accounts.supervisor);
    await page.goto(`${origin}/technician/handovers/v2/${seeded.shiftId}`, { waitUntil: "networkidle", timeout: 180_000 });
    assert.ok(!new URL(page.url()).pathname.startsWith("/technician"),
      `A supervisor must not reach the technician report workflow, got ${new URL(page.url()).pathname}.`);
    await page.goto(`${origin}/supervisor/handovers`, { waitUntil: "networkidle", timeout: 180_000 });
    const prepareDenial = await prohibitedPost(page, seeded.shiftId, "/report", { reason: "prohibited supervisor preparation" });
    assert.equal(prepareDenial.status, 403, `Supervisor preparation must be denied: ${JSON.stringify(prepareDenial.body)}`);
    const freezeDenial = await prohibitedPost(page, seeded.shiftId, "/report/freeze", {
      expectedRevision: 99, expectedSnapshotHash: "0".repeat(64), expectedGuardRevision: 1, expectedFencingEpoch: 1,
      preparationRevision: 3, contentDigest: "0".repeat(64), evidenceSnapshotHash: "0".repeat(64),
      workSnapshotVersion: "x", reason: "prohibited supervisor freeze", correctionNote: null,
    });
    assert.equal(freezeDenial.status, 403, `Supervisor freeze must be denied: ${JSON.stringify(freezeDenial.body)}`);
    record(11, "supervisor denied", {
      prepareStatus: prepareDenial.status, prepareError: prepareDenial.body?.error,
      freezeStatus: freezeDenial.status, freezeError: freezeDenial.body?.error,
    });

    // --- final authoritative state, not merely API return values -----------
    const authoritative = await verifyFinalState({ ...seeded, firstReportId, secondReportId, browserVersion });
    assert.deepEqual(authoritative.browserErrors, [], "The browser must report no uncaught errors.");
    assert.equal(expectedDenials, 3, "Each prohibited mutation must be denied with 403.");
    assert.equal(resourceStatusErrors.length, 3,
      `Only the three deliberate denials may log resource errors: ${JSON.stringify(resourceStatusErrors)}`);

    await browser.close();

    await writeFile(evidencePath, JSON.stringify({
      verifiedAt: new Date().toISOString(),
      browser: { channel: browserChannel, version: authoritative.browserVersion },
      project, origin,
      shiftId: seeded.shiftId,
      reservationFingerprint: seeded.fingerprint,
      preparationDocumentId: seeded.preparationId,
      reports: [firstReportId, secondReportId],
      deniedProbeConsoleResourceErrors: resourceStatusErrors,
      steps,
      authoritative,
      accountsFile: ".demo/handover-v2-browser-accounts.json",
      screenshot: ".demo/" + basename(screenshotPath),
    }, null, 2), { flag: "wx", mode: 0o600 });

    console.log(`PASS: ${steps.length} browser steps verified against ${project}; reports ${firstReportId} (v1) and ${secondReportId} (v2).`);
    console.log(`Evidence: ${evidencePath}`);
  } finally {
    if (browser.isConnected()) await browser.close();
    await killTree(appProcess, "next dev");
    await killTree(emulatorProcess, "firebase emulators");
  }
}

// ---------------------------------------------------------------------------
// Seeding — the production writers build every precondition.
// ---------------------------------------------------------------------------

async function seed() {
  const prefix = `ho05b${randomBytes(3).toString("hex")}`;
  const uids = {
    outgoingA: `${prefix}-outa`, outgoingB: `${prefix}-outb`,
    incomingA: `${prefix}-ina`, incomingB: `${prefix}-inb`, supervisor: `${prefix}-sup`,
  };
  const names = {
    outgoingA: `${prefix} Outgoing Alpha`, outgoingB: `${prefix} Outgoing Beta`,
    incomingA: `${prefix} Incoming Alpha`, incomingB: `${prefix} Incoming Beta`,
    supervisor: `${prefix} Shift Supervisor`,
  };
  const accounts = {};
  const passwords = {};
  for (const key of Object.keys(uids)) {
    const role = key === "supervisor" ? "supervisor" : "technician";
    const email = `${prefix}-${key}@handover-v2-browser.invalid`;
    passwords[key] = password();
    const created = await auth.createUser({ uid: uids[key], email, password: passwords[key], displayName: names[key] });
    await auth.setCustomUserClaims(created.uid, { role });
    assert.equal(created.uid, uids[key], "The synthetic Auth emulator must honour the provisioned uid.");
    accounts[key] = { email, password: passwords[key], role, home: role === "supervisor" ? "/supervisor" : "/technician" };
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
      uid: uids[key], fullName: names[key], email: accounts[key].email,
      role: key === "supervisor" ? "supervisor" : "technician",
      engineeringLocation: key === "supervisor" ? null : "Accra Engineering Suite",
      status: "active", statusOperation: null, mustChangePassword: false,
      createdBy: "isolated-browser-verification", createdAt: historical,
    });
  }
  for (const [id, ids] of [[outPair, [uids.outgoingA, uids.outgoingB]], [inPair, [uids.incomingA, uids.incomingB]]]) {
    batch.set(ref("technician_pairs", id), {
      id, technicianIds: ids, status: "active", createdBy: uids.supervisor,
      createdAt: historical, updatedAt: historical, deactivatedAt: null, deactivatedBy: null,
    });
    for (const uid of ids) {
      batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: id, createdAt: historical, updatedAt: historical });
    }
  }
  batch.set(ref("shifts", shiftId), {
    id: shiftId, status: "active", permanentPairId: outPair, primaryTechnicianIds: [uids.outgoingA, uids.outgoingB],
    operationalSlotToken: token, shiftType: "morning", scheduledStart, scheduledEnd,
    actualStart: historical, actualEnd: null, engineeringLocation: "Accra Engineering Suite",
    createdBy: uids.supervisor, createdAt: historical, updatedAt: historical,
  });
  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(token, 1, historical), shiftId, historical);
  control = transitionOperationalShiftControl(control, shiftId, "scheduled", "active", historical);
  batch.set(ref("operational_shift_control", "global"), control);
  for (const uid of [uids.outgoingA, uids.outgoingB]) {
    const memberId = `${shiftId}_${uid}`;
    batch.set(ref("shift_members", memberId), { id: memberId, shiftId, technicianId: uid, role: "primary", joinedAt: historical, leftAt: null });
    batch.set(ref("shift_attendance", memberId), {
      id: memberId, shiftId, technicianId: uid, status: "present", participationAuthority: "primary",
      authorizationId: null, clockIn: historical, clockOut: null, isProvisional: false,
      recordedAt: historical, updatedAt: historical,
    });
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid, entries: [{ shiftId, scheduledStart, scheduledEnd, status: "active" }], updatedAt: historical,
    });
  }
  for (const uid of [uids.incomingA, uids.incomingB]) {
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: "unrelated-shift", scheduledStart: "2030-01-03T06:00:00.000Z", scheduledEnd: "2030-01-03T14:00:00.000Z", status: "scheduled" }],
      updatedAt: historical,
    });
  }
  await batch.commit();

  // Real operational records, written by the production operations writer while
  // the shift is still active — the handover-pending barrier is part of the
  // production contract.
  const actor = { uid: uids.outgoingA, role: "technician" };
  const at = (minute) => `2020-01-01T0${minute}:00:00.000Z`;
  for (const [index, stationId] of ["joy-fm", "adom-fm", "asempa-fm", "hitz-fm"].entries()) {
    await recordShiftOperation(actor, shiftId, { details: { kind: "broadcast", occurredAt: at(1 + index), stationId, status: "on_air", remarks: "" } });
  }
  await recordShiftOperation(actor, shiftId, { details: {
    kind: "outside_broadcast", occurredAt: at(5), title: "Outside van feed", location: "Accra mall",
    runningStatus: "ended", technicalIssues: "None", actionTaken: "Monitored handoff.", status: "resolved",
    remarks: "", linkedTaskId: null,
  } });

  await beginShiftHandover({ shiftId, actorUid: uids.outgoingA, authority: "equal-technician" });
  await initializeEqualHandoverReservation({
    outgoingShiftId: shiftId, actorUid: uids.outgoingA, incomingPermanentPairId: inPair,
    shiftType: "morning", scheduledStart, scheduledEnd, idempotencyKey: `ho05-browser-${randomUUID()}`,
  });

  const reservation = await readEqualHandoverReservation(shiftId);
  const fingerprint = reservation.aggregate.reservation.handoverId;
  return {
    prefix, shiftId, uids, names, accounts,
    reservedIncomingShiftId: reservation.aggregate.reservation.reservedIncomingShiftId,
    fingerprint,
    preparationId: createEqualHandoverPreparationDocumentId(fingerprint),
    baseline: {
      control: await collectionSnapshot("operational_shift_control"),
      schedules: await collectionSnapshot("technician_schedules"),
      tasks: await collectionSnapshot("tasks"),
      attendanceV2: await collectionSnapshot("attendance_evidence_v2"),
      attendanceOps: await collectionSnapshot("attendance_evidence_operations_v2"),
      transfers: await collectionSnapshot("handover_task_transfers"),
      v1Handovers: await collectionSnapshot("handovers"),
    },
  };
}

async function verifyFinalState({ shiftId, uids, names, fingerprint, preparationId, firstReportId, secondReportId, baseline, browserVersion }) {
  const reports = await db.collection("handover_reports_v2").get();
  const byId = new Map(reports.docs.map((doc) => [doc.id, doc.data()]));
  assert.equal(reports.size, 2, "Exactly two immutable reports must exist.");
  const first = byId.get(firstReportId);
  const second = byId.get(secondReportId);
  assert.ok(first && second, "Both frozen reports must be stored documents.");
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(second.supersedesReportId, firstReportId);
  assert.equal(first.schema, "handover-report-v2");
  assert.equal(first.content.schema, "equal-handover-report-v2");
  assert.equal(first.content.staff.shiftId, shiftId);
  assert.equal(first.content.completeness.blockers.length, 0, "A blocker-free review must be what froze.");
  assert.equal(second.content.completeness.blockers.length, 0);
  assert.equal(first.content.absences.length, 1);
  assert.equal(first.content.absences[0].absenceType, "not_yet_in");
  assert.equal(first.content.absences[0].technicianUid, uids.incomingA);
  assert.ok(first.content.attendance.some((row) => row.uid === uids.incomingA && row.absenceDeclared === "not_yet_in"),
    "The first frozen version must carry the declaration.");
  assert.equal(second.content.absences.length, 0, "The corrected version must reflect the withdrawal.");
  assert.ok(second.content.attendance.some((row) => row.uid === uids.incomingA && row.clockIn === null && row.clockOut === null),
    "Missing attendance must remain missing, never synthesized.");
  assert.notEqual(first.digest, second.digest);
  assert.equal(first.frozenBy, uids.outgoingA);
  assert.equal(second.frozenBy, uids.outgoingB);
  assert.ok(second.correctionNote?.length > 0, "A later version must record its correction note.");
  assert.equal(first.correctionNote, null);
  assert.equal(second.evidenceSnapshotHash.length, 64);
  for (const key of ["outgoingA", "outgoingB", "incomingA", "incomingB"]) {
    assert.ok(JSON.stringify(second.content.participants).includes(names[key]),
      `${names[key]} must be frozen as a named participant.`);
    assert.ok(JSON.stringify(first.content.participants).includes(names[key]),
      `${names[key]} must be named in the first version too.`);
  }
  assert.ok(!JSON.stringify(second.content.participants).includes(names.supervisor),
    "A supervisor is never a participant of the reserved pair.");

  const aggregate = (await ref("equal_handovers_v2", createEqualHandoverDocumentId(shiftId)).get()).data();
  assert.equal(aggregate.reportBinding.id, secondReportId, "The reservation must bind the latest immutable version.");
  assert.equal(aggregate.reportBinding.preparationRevision, 3);
  assert.equal(aggregate.reportBinding.digest, second.digest);
  assert.equal(aggregate.reportBinding.reservationId, fingerprint);
  assert.equal(aggregate.lifecycleStatus, "collecting_confirmations", "A freeze must not confirm or transfer the shift.");
  assert.deepEqual(aggregate.absences, [], "The withdrawn declaration must be gone from the aggregate.");

  const preparation = (await ref("handover_report_preparations_v2", preparationId).get()).data();
  assert.equal(preparation.id, `preparation_${fingerprint}`);
  assert.equal(preparation.reservationId, fingerprint);
  assert.equal(preparation.preparationRevision, 3);
  assert.equal(preparation.revisionHistory.length, 3);
  assert.deepEqual(preparation.revisionHistory.map((entry) => entry.preparedBy),
    [uids.outgoingA, uids.outgoingA, uids.outgoingB], "Both outgoing technicians must share one revision chain.");
  assert.equal(preparation.aggregateRevision, second.aggregateRevision,
    "The frozen version must record the reservation revision it was reviewed against.");

  const audits = (await db.collection("audit_logs").get()).docs.map((doc) => doc.data());
  const countOf = (action) => audits.filter((audit) => audit.action === action).length;
  assert.deepEqual({
    prepared: countOf("EQUAL_HANDOVER_REPORT_PREPARED_V2"),
    absenceRecorded: countOf("EQUAL_HANDOVER_ABSENCE_RECORDED_V2"),
    absenceCleared: countOf("EQUAL_HANDOVER_ABSENCE_CLEARED_V2"),
    frozen: countOf("EQUAL_HANDOVER_REPORT_FROZEN_V2"),
  }, { prepared: 3, absenceRecorded: 1, absenceCleared: 1, frozen: 2 },
    `Unexpected v2 report audit evidence: ${JSON.stringify(audits.map((audit) => audit.action))}`);
  const ids = audits.map((audit) => audit.id);
  assert.equal(ids.length, new Set(ids).size, "Audit evidence must never be duplicated.");
  const reportActions = new Set([
    "EQUAL_HANDOVER_REPORT_PREPARED_V2",
    "EQUAL_HANDOVER_ABSENCE_RECORDED_V2",
    "EQUAL_HANDOVER_ABSENCE_CLEARED_V2",
    "EQUAL_HANDOVER_REPORT_FROZEN_V2",
  ]);
  for (const audit of audits.filter((audit) => reportActions.has(audit.action))) {
    assert.equal(audit.protocol, "equal-handover-v2");
    assert.ok([uids.outgoingA, uids.outgoingB].includes(audit.actorUid), `Unexpected v2 report actor: ${audit.actorUid}`);
    assert.equal(audit.reservationId, fingerprint);
  }
  const cleared = audits.find((audit) => audit.action === "EQUAL_HANDOVER_ABSENCE_CLEARED_V2");
  assert.equal(cleared.clearedDeclaration.technicianUid, uids.incomingA,
    "The cleared declaration must be preserved verbatim in immutable audit history.");

  const shifts = await db.collection("shifts").get();
  const outgoing = shifts.docs.find((doc) => doc.id === shiftId).data();
  assert.equal(outgoing.status, "handover_pending", "A freeze must not advance operational shift control.");
  assert.equal(outgoing.actualEnd, null);

  const untouched = {
    shiftDocuments: shifts.size,
    incomingShiftsCreated: shifts.size - 1,
    attendanceV2Unchanged: await collectionSnapshot("attendance_evidence_v2") === baseline.attendanceV2,
    attendanceOperationsUnchanged: await collectionSnapshot("attendance_evidence_operations_v2") === baseline.attendanceOps,
    shiftControlUnchanged: await collectionSnapshot("operational_shift_control") === baseline.control,
    schedulesUnchanged: await collectionSnapshot("technician_schedules") === baseline.schedules,
    tasksUnchanged: await collectionSnapshot("tasks") === baseline.tasks,
    taskTransfersUnchanged: await collectionSnapshot("handover_task_transfers") === baseline.transfers,
    v1HandoversUnchanged: await collectionSnapshot("handovers") === baseline.v1Handovers,
  };
  assert.equal(untouched.incomingShiftsCreated, 0, "A freeze must not create the incoming shift.");
  assert.equal(untouched.attendanceV2Unchanged, true, "A freeze must not finalize attendance evidence.");
  assert.equal(untouched.shiftControlUnchanged, true, "A freeze must not change operational shift control.");
  assert.equal(untouched.schedulesUnchanged, true, "A freeze must not move any technician schedule.");
  assert.equal(untouched.tasksUnchanged, true, "A freeze must not alter task work.");
  assert.equal(untouched.taskTransfersUnchanged, true, "A freeze must not transfer tasks.");
  assert.equal(untouched.v1HandoversUnchanged, true, "The v1 handover aggregates must be untouched.");

  const events = await db.collection("shift_operation_events").get();
  assert.equal(events.size, 5, "The frozen report must draw on the five real operational records.");

  return {
    browserErrors,
    browserVersion,
    reports: reports.size,
    auditCounts: {
      prepared: countOf("EQUAL_HANDOVER_REPORT_PREPARED_V2"),
      absenceRecorded: countOf("EQUAL_HANDOVER_ABSENCE_RECORDED_V2"),
      absenceCleared: countOf("EQUAL_HANDOVER_ABSENCE_CLEARED_V2"),
      frozen: countOf("EQUAL_HANDOVER_REPORT_FROZEN_V2"),
    },
    digests: { first: first.digest, second: second.digest },
    preparationRevision: preparation.preparationRevision,
    untouched,
  };
}

try {
  await main();
} catch (failure) {
  console.error("BROWSER VERIFICATION FAILED:", failure);
  if (emulatorLog.length) console.error(`emulator log tail:\n${emulatorLog.join("").slice(-2500)}`);
  if (appLog.length) console.error(`application log tail:\n${appLog.join("").slice(-2500)}`);
  process.exitCode = 1;
} finally {
  await killTree(appProcess, "next dev");
  await killTree(emulatorProcess, "firebase emulators");
  await db.terminate().catch(() => {});
}
