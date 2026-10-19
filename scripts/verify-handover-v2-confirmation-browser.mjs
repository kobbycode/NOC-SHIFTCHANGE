/**
 * TECH-HO-RECOVERY-06 §12 — real browser verification of authenticated v2
 * participant confirmations and authoritative handover readiness.
 *
 * Run via: tests/run-handover-v2-confirmation-browser.ps1
 *
 * What this proves: a real Chromium (Edge channel) browser signs each reserved
 * technician in through the production login flow against the synthetic Auth
 * emulator, walks into the dedicated v2 page, and confirms for self through the
 * real /handover/v2/confirmation route with a real session cookie — proving the
 * missing-confirmation blocker clears and derived readiness becomes ready only
 * when the authoritative evidence supports it. It shows a supported colleague
 * absence satisfying the four-person obligation (three personal confirmations
 * plus one documented absence), proves that a new frozen report version never
 * inherits prior confirmations, and proves that readiness is never presented as
 * a completed handover or a transfer authorization. Prohibited actions (an
 * outsider confirming, a supervisor confirming, and a client trying to name a
 * technician in the body) are attempted from the browser and denied. Every
 * step is asserted against final Firestore documents and audit evidence, not
 * only API return values. The workflow stops at confirmation/readiness: no
 * incoming shift is created, attendance is never finalized, and no handover is
 * transferred.
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
const port = Number(process.env.HO06_BROWSER_PORT ?? 3102);
const origin = `http://127.0.0.1:${port}`;
const browserChannel = process.env.HO06_BROWSER_CHANNEL ?? "msedge";

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
const accountsPath = join(repoRoot, ".demo", "handover-v2-confirmation-browser-accounts.json");
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
const password = () => `HO06-${randomBytes(18).toString("base64url")}!`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let emulatorProcess = null;
let appProcess = null;
const emulatorLog = [];
const appLog = [];
const browserErrors = [];
// Chrome logs "Failed to load resource" for every deliberate non-2xx probe in
// step 6. Those are expected network outcomes, not uncaught application errors;
// they are counted, asserted against the probe list and recorded in evidence.
const resourceStatusErrors = [];
let deniedProbeWindow = 0;
let deliberateProbes = 0;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = join(repoRoot, ".demo", `handover-v2-confirmation-browser-verification-${stamp}.json`);
const screenshotPath = join(repoRoot, ".demo", `handover-v2-confirmation-browser-verification-${stamp}.png`);

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
    if (/favicon\.ico/i.test(text)) return;
    // Any deliberate denied probe inside the window is an asserted evidence
    // network outcome (401/403/400), not an uncaught application error.
    if (deniedProbeWindow > 0 && /Failed to load resource/.test(text) && /(400|401|403|404)/.test(text)) {
      resourceStatusErrors.push(text);
      return;
    }
    browserErrors.push(`console: ${text}`);
  });
}

async function signIn(page, account) {
  await page.goto(`${origin}/login`, { waitUntil: "networkidle", timeout: 180_000 });
  await page.locator("#email").fill(account.email);
  await page.locator("#password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(technician|supervisor)(\/|$)/, { timeout: 180_000 });
  const landedOn = new URL(page.url()).pathname;
  assert.ok(landedOn.startsWith(account.home), `Expected ${account.home}, landed on ${landedOn}.`);
  return landedOn;
}

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

async function openV2Page(context, account, shiftId) {
  const page = await context.newPage();
  attachErrorCapture(page);
  await signIn(page, account);
  await page.goto(`${origin}/technician/handovers/v2/${shiftId}`, { waitUntil: "networkidle", timeout: 180_000 });
  await page.getByRole("heading", { name: "Equal-technician handover report (v2)" }).waitFor({ timeout: 180_000 });
  return page;
}

async function confirmForSelf(page) {
  const button = page.getByRole("button", { name: "Confirm this handover for myself" });
  await button.waitFor({ timeout: 60_000 });
  assert.ok(await button.isEnabled(), "The self-confirmation control must be enabled for an authorized participant.");
  await button.click();
  await page.getByText("Your personal confirmation has been recorded.").waitFor({ timeout: 180_000 });
}

// A real browser fetch issued inside the denied-probe window so its expected
// non-2xx network result is classified as asserted evidence, not an error.
async function probePost(page, shiftId, suffix, body) {
  deniedProbeWindow += 1;
  deliberateProbes += 1;
  try {
    return await page.evaluate(async ([id, path, payload]) => {
      const response = await fetch(`/api/operations/shifts/${encodeURIComponent(id)}/handover/v2${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: response.status, noStore: response.headers.get("cache-control"), body: await response.json().catch(() => null) };
    }, [shiftId, suffix, body]);
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
// §12 steps 1-7
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
  const steps = [];
  const record = (index, name, detail) => steps.push({ step: index, name, ...detail });
  let page = null;

  try {
    // 1 — outgoing technician A signs in, reviews and freezes the report so
    //     the confirmation obligation is live against an immutable version.
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const preFreeze = await pageText(page);
    assert.match(preFreeze, /collecting confirmations/);
    assert.ok(preFreeze.includes("No preparation exists yet"), "Fresh reservation must invite the first preparation.");
    const formsA = page.locator("section", { hasText: "Outgoing technician actions" }).locator("form");
    await formsA.nth(0).locator('input[name="reason"]').fill("Reviewed shift evidence for the confirmation browser run");
    await formsA.nth(0).getByRole("button", { name: "Prepare consolidated report" }).click();
    await page.getByText("Consolidated report prepared for review.").waitFor({ timeout: 180_000 });
    await formsA.nth(2).locator('input[name="reason"]').fill("Both outgoing technicians reviewed the consolidated evidence");
    await formsA.nth(2).getByRole("button", { name: "Review complete — freeze report" }).click();
    await page.getByText("Report frozen. It is now immutable.").waitFor({ timeout: 180_000 });
    await page.getByRole("heading", { name: "Frozen report content (immutable)" }).waitFor({ timeout: 60_000 });
    const v1ReportId = (await ref("equal_handovers_v2", createEqualHandoverDocumentId(seeded.shiftId)).get()).data().reportBinding.id;
    const v1Immutable = canonical(await ref("handover_reports_v2", v1ReportId).get());
    record(1, "outgoing technician A froze the first immutable report", { shiftId: seeded.shiftId, reportId: v1ReportId });

    // 2 — before any confirmation, derived readiness blocks with a typed
    //     missing-confirmation reason and is never labelled as transferable.
    const notReady = await pageText(page);
    assert.match(notReady, /Readiness: not ready/);
    assert.match(notReady, /missing confirmation/);
    assert.match(notReady, /Confirmed 0 of 4/);
    assert.ok(notReady.includes("Readiness is derived from authoritative evidence and is not a completed handover or a transfer authorization."),
      "Readiness must never be presented as a completed handover or transfer authorization.");
    assert.match(notReady, /state: awaiting confirmation/);
    record(2, "missing-confirmation blocker shown before any personal confirmation", { readiness: "not ready", reason: "missing_confirmation" });

    // 3 — outgoing technician A confirms for self; it persists across reload.
    await confirmForSelf(page);
    await page.getByText("Confirmed 1 of 4").waitFor({ timeout: 60_000 });
    const afterConfirm = await pageText(page);
    assert.match(afterConfirm, /Confirmed 1 of 4/);
    assert.match(afterConfirm, /Your personally confirmed|state: confirmed/);
    await page.reload({ waitUntil: "networkidle", timeout: 180_000 });
    await page.getByRole("heading", { name: "Equal-technician handover report (v2)" }).waitFor({ timeout: 180_000 });
    const reloaded = await pageText(page);
    assert.match(reloaded, /Confirmed 1 of 4/, "A reload must re-read the confirmation from Firestore, not browser state.");
    assert.ok(!(await page.getByRole("button", { name: "Confirm this handover for myself" }).count()),
      "A persisted self-confirmation must not offer a duplicate confirmation control.");
    record(3, "outgoing technician A self-confirmation persisted across reload", { confirmedCount: 1 });

    // 4 — the remaining three participants each confirm for self; derived
    //     readiness becomes ready only on the authoritative four-person path.
    await signOut(page);
    await page.close();
    for (const key of ["outgoingB", "incomingA", "incomingB"]) {
      page = await openV2Page(context, seeded.accounts[key], seeded.shiftId);
      await confirmForSelf(page);
      await signOut(page);
      await page.close();
    }
    // Re-open as an outgoing technician to read the shared final readiness.
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const readyText = await pageText(page);
    assert.match(readyText, /Readiness: all confirmations and permitted exceptions satisfied/);
    assert.match(readyText, /Confirmed 4 of 4/);
    assert.ok(!readyText.includes("missing confirmation"), "The four-person obligation is satisfied once all confirm.");
    const authoritativeReady = await page.evaluate(async (id) => {
      const response = await fetch(`/api/operations/shifts/${encodeURIComponent(id)}/handover/v2/readiness`, { headers: { Accept: "application/json" } });
      return { status: response.status, json: await response.json() };
    }, seeded.shiftId);
    assert.equal(authoritativeReady.status, 200);
    assert.equal(authoritativeReady.json.readiness.ready, true);
    assert.equal(authoritativeReady.json.readiness.transferAuthorized, false,
      "Readiness must never itself authorize a transfer.");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    record(4, "four personal confirmations satisfy derived readiness", {
      confirmedCount: 4, readiness: "ready", transferAuthorized: false,
    });

    // 5 — a new frozen version must never inherit the prior confirmations.
    //     Change authoritative work evidence, then re-prepare and freeze.
    await seedCompletedTask(seeded.shiftId, seeded.uids.outgoingA);
    await page.reload({ waitUntil: "networkidle", timeout: 180_000 });
    await page.getByRole("heading", { name: "Equal-technician handover report (v2)" }).waitFor({ timeout: 180_000 });
    assert.match(await pageText(page), /The authoritative sources changed since the last preparation/);
    const supersedeForms = page.locator("section", { hasText: "Outgoing technician actions" }).locator("form");
    await supersedeForms.nth(0).getByRole("button", { name: "Prepare consolidated report" }).click();
    await page.getByText("Report re-prepared for review.").waitFor({ timeout: 180_000 });
    await supersedeForms.nth(2).locator('input[name="reason"]').fill("Freeze after a post-freeze work record");
    await supersedeForms.nth(2).locator('input[name="correctionNote"]').fill("A task was closed after the first freeze; the report is corrected and re-frozen.");
    await supersedeForms.nth(2).getByRole("button", { name: "Review complete — freeze report" }).click();
    await page.getByText("Corrected report frozen as a new immutable version.").waitFor({ timeout: 180_000 });
    await page.getByText("(version 2").waitFor({ timeout: 60_000 });
    const superseded = await pageText(page);
    assert.match(superseded, /Readiness: not ready/, "A corrected version must reopen the confirmation obligation.");
    assert.match(superseded, /Confirmed 0 of 4/, "The new version inherits none of the prior personal confirmations.");
    assert.match(superseded, /missing confirmation/);
    record(5, "a new frozen version invalidates prior confirmations", { readiness: "not ready", confirmedCount: 0 });

    // 6 — supported absence path: a colleague declares one incoming technician
    //     absent; three personal confirmations plus the exception satisfy the
    //     four-person obligation, and the absent participant is never asked to
    //     confirm for self.
    const absenceForms = page.locator("section", { hasText: "Outgoing technician actions" }).locator("form");
    await absenceForms.nth(1).locator('select[name="subject"]').selectOption({ value: seeded.uids.incomingB });
    await absenceForms.nth(1).locator('input[name="reason"]').fill("Has not arrived at the engineering suite");
    await absenceForms.nth(1).getByRole("button", { name: "Declare absence" }).click();
    await page.getByText("Absence declaration recorded. Re-prepare the report to include it.").waitFor({ timeout: 180_000 });
    await absenceForms.nth(0).getByRole("button", { name: "Prepare consolidated report" }).click();
    await page.getByText("Report re-prepared for review.").waitFor({ timeout: 180_000 });
    await absenceForms.nth(2).locator('input[name="reason"]').fill("Freeze with a documented arrival absence");
    await absenceForms.nth(2).locator('input[name="correctionNote"]').fill("One incoming technician has not arrived; recorded as a supported absence.");
    await absenceForms.nth(2).getByRole("button", { name: "Review complete — freeze report" }).click();
    await page.getByText("Corrected report frozen as a new immutable version.").waitFor({ timeout: 180_000 });
    await page.getByText("(version 3").waitFor({ timeout: 60_000 });
    // The absent participant's own view must show the exception, not a
    // confirmation control — an absence is not a personal confirmation.
    await signOut(page);
    await page.close();
    page = await openV2Page(context, seeded.accounts.incomingB, seeded.shiftId);
    const absentSelf = await pageText(page);
    assert.match(absentSelf, /an absence is not a personal confirmation/);
    assert.ok(!(await page.getByRole("button", { name: "Confirm this handover for myself" }).count()),
      "An absent participant must never be offered a confirmation control.");
    await signOut(page);
    await page.close();
    for (const key of ["outgoingA", "outgoingB", "incomingA"]) {
      page = await openV2Page(context, seeded.accounts[key], seeded.shiftId);
      await confirmForSelf(page);
      await signOut(page);
      await page.close();
    }
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const exceptionReady = await pageText(page);
    assert.match(exceptionReady, /Readiness: all confirmations and permitted exceptions satisfied/);
    assert.match(exceptionReady, /Confirmed 3 of 4 · absences 1 of 1 supported/);
    record(6, "three confirmations plus one supported absence satisfy derived readiness", {
      confirmedCount: 3, absenceCount: 1, readiness: "ready",
    });
    assert.equal(canonical(await ref("handover_reports_v2", v1ReportId).get()), v1Immutable,
      "A later superseding version must never rewrite the earlier frozen report.");

    // 7 — prohibited actions are denied from the browser.
    await signOut(page);
    await page.close();
    page = await context.newPage();
    attachErrorCapture(page);
    await signIn(page, seeded.accounts.outsider);
    const outsiderStamp = await bindingFor(seeded.shiftId);
    const outsiderDenial = await probePost(page, seeded.shiftId, "/confirmation", {
      expectedRevision: outsiderStamp.expectedRevision, expectedSnapshotHash: outsiderStamp.expectedSnapshotHash });
    assert.equal(outsiderDenial.status, 403, `An outsider must not confirm: ${JSON.stringify(outsiderDenial.body)}`);
    await signOut(page);
    await page.close();
    page = await context.newPage();
    attachErrorCapture(page);
    await signIn(page, seeded.accounts.supervisor);
    const supervisorStamp = await bindingFor(seeded.shiftId);
    const supervisorDenial = await probePost(page, seeded.shiftId, "/confirmation", {
      expectedRevision: supervisorStamp.expectedRevision, expectedSnapshotHash: supervisorStamp.expectedSnapshotHash });
    assert.equal(supervisorDenial.status, 403, `A supervisor must not confirm: ${JSON.stringify(supervisorDenial.body)}`);
    await signOut(page);
    await page.close();
    // A client cannot name a technician in the body: the self-only parser rejects
    // the extra field and the actor stays session-derived.
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const forgedStamp = await bindingFor(seeded.shiftId);
    const forged = await probePost(page, seeded.shiftId, "/confirmation", {
      expectedRevision: forgedStamp.expectedRevision, expectedSnapshotHash: forgedStamp.expectedSnapshotHash,
      technicianUid: seeded.uids.incomingA });
    assert.equal(forged.status, 400, `A proxy body field must be rejected: ${JSON.stringify(forged.body)}`);
    assert.equal(forged.noStore, "no-store", "A denied confirmation response must not be cacheable.");
    record(7, "outsider, supervisor and proxy-body confirmations are denied", {
      outsider: outsiderDenial.status, supervisor: supervisorDenial.status, forged: forged.status,
    });

    // --- final authoritative state, not merely API return values -----------
    const authoritative = await verifyFinalState({ ...seeded, browserVersion });
    assert.deepEqual(authoritative.browserErrors, [], "The browser must report no uncaught errors.");
    assert.equal(authoritative.confirmationAudits, 7, "Four first-round confirmations plus three exception-round confirmations.");
    assert.equal(deliberateProbes, 3, "Three deliberate denied probes are expected.");
    assert.equal(resourceStatusErrors.length, deliberateProbes,
      `Only the deliberate denied probes may log resource errors: ${JSON.stringify(resourceStatusErrors)}`);

    await browser.close();

    await writeFile(evidencePath, JSON.stringify({
      verifiedAt: new Date().toISOString(),
      browser: { channel: browserChannel, version: authoritative.browserVersion },
      project, origin,
      shiftId: seeded.shiftId,
      reservationFingerprint: seeded.fingerprint,
      deniedProbeConsoleResourceErrors: resourceStatusErrors,
      steps,
      authoritative,
      accountsFile: ".demo/handover-v2-confirmation-browser-accounts.json",
      screenshot: ".demo/" + basename(screenshotPath),
    }, null, 2), { flag: "wx", mode: 0o600 });

    console.log(`PASS: ${steps.length} confirmation browser steps verified against ${project}; readiness reached without any transfer.`);
    console.log(`Evidence: ${evidencePath}`);
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser.isConnected()) await browser.close();
    await killTree(appProcess, "next dev");
    await killTree(emulatorProcess, "firebase emulators");
  }
}

async function bindingFor(shiftId) {
  const state = await readEqualHandoverReservation(shiftId);
  return { expectedRevision: state.aggregate.revision, expectedSnapshotHash: state.snapshotHash };
}

async function seedCompletedTask(shiftId, managerUid) {
  const id = `${shiftId}-closed-after-freeze`;
  await ref("tasks", id).set({
    id, shiftId, title: "Closed after the first freeze", description: "Post-freeze work record",
    priority: "medium", sectionId: null, status: "completed", createdBy: managerUid,
    createdAt: historical, updatedAt: historical,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Seeding — the production writers build every precondition.
// ---------------------------------------------------------------------------

async function seed() {
  const prefix = `ho06b${randomBytes(3).toString("hex")}`;
  const uids = {
    outgoingA: `${prefix}-outa`, outgoingB: `${prefix}-outb`,
    incomingA: `${prefix}-ina`, incomingB: `${prefix}-inb`,
    outsider: `${prefix}-outsider`, supervisor: `${prefix}-sup`,
  };
  const names = {
    outgoingA: `${prefix} Outgoing Alpha`, outgoingB: `${prefix} Outgoing Beta`,
    incomingA: `${prefix} Incoming Alpha`, incomingB: `${prefix} Incoming Beta`,
    outsider: `${prefix} Unrelated Technician`, supervisor: `${prefix} Shift Supervisor`,
  };
  const accounts = {};
  const passwords = {};
  for (const key of Object.keys(uids)) {
    const role = key === "supervisor" ? "supervisor" : "technician";
    const email = `${prefix}-${key}@handover-v2-confirmation-browser.invalid`;
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
      engineeringLocation: key === "supervisor" || key === "outsider" ? null : "Accra Engineering Suite",
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
  batch.set(ref("technician_schedules", uids.outsider), { technicianUid: uids.outsider, entries: [], updatedAt: historical });
  await batch.commit();

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
    shiftType: "morning", scheduledStart, scheduledEnd, idempotencyKey: `ho06-browser-${randomUUID()}`,
  });

  const reservation = await readEqualHandoverReservation(shiftId);
  const fingerprint = reservation.aggregate.reservation.handoverId;
  return {
    prefix, shiftId, uids, names, accounts, fingerprint,
    reservedIncomingShiftId: reservation.aggregate.reservation.reservedIncomingShiftId,
    baseline: {
      control: await collectionSnapshot("operational_shift_control"),
      schedules: await collectionSnapshot("technician_schedules"),
      attendanceV2: await collectionSnapshot("attendance_evidence_v2"),
      attendanceOps: await collectionSnapshot("attendance_evidence_operations_v2"),
      transfers: await collectionSnapshot("handover_task_transfers"),
      v1Handovers: await collectionSnapshot("handovers"),
      shifts: await collectionSnapshot("shifts"),
    },
  };
}

async function verifyFinalState({ shiftId, uids, fingerprint, baseline, browserVersion }) {
  const reports = await db.collection("handover_reports_v2").get();
  assert.equal(reports.size, 3, "Three immutable report versions must exist (initial, superseded, absence-corrected).");
  const byId = new Map(reports.docs.map((doc) => [doc.id, doc.data()]));
  const idForVersion = new Map(reports.docs.map((doc) => [doc.data().version, doc.id]));
  assert.deepEqual([...byId.values()].map((report) => report.version).sort((a, b) => a - b), [1, 2, 3]);
  const v1Id = idForVersion.get(1);
  const v3Id = idForVersion.get(3);

  const aggregate = (await ref("equal_handovers_v2", createEqualHandoverDocumentId(shiftId)).get()).data();
  assert.ok(aggregate, "The v2 aggregate must exist.");
  assert.equal(aggregate.lifecycleStatus, "collecting_confirmations",
    "Confirmation and readiness must never complete the handover lifecycle.");
  assert.equal(aggregate.reportBinding.id, v3Id, "The reservation must bind the newest corrected version.");
  assert.equal(aggregate.confirmations.length, 3, "Only the three present participants hold live confirmations on the newest version.");
  assert.deepEqual(aggregate.confirmations.map((c) => c.position).sort(), ["incoming_tech_a", "outgoing_tech_a", "outgoing_tech_b"]);
  assert.ok(!aggregate.confirmations.some((c) => c.position === "incoming_tech_b"),
    "The absent participant must never hold a personal confirmation.");
  assert.equal(aggregate.absences.length, 1);
  assert.equal(aggregate.absences[0].position, "incoming_tech_b");
  assert.equal(aggregate.absences[0].absenceType, "not_yet_in");
  assert.equal(aggregate.absences[0].technicianUid, uids.incomingB);
  assert.ok(aggregate.confirmations.every((c) => c.reportBinding.id === v3Id),
    "Every live confirmation must bind the exact current frozen report version.");
  // The first round of four confirmations is preserved as immutable history
  // against the superseded version 1 binding; a later version never inherits.
  assert.ok(aggregate.historicalConfirmations.length >= 4,
    "Superseded confirmations must be preserved as immutable history.");
  assert.ok(aggregate.historicalConfirmations.every((c) => c.reportBinding.id === v1Id),
    "First-round history must point at the superseded version 1 binding.");

  const audits = (await db.collection("audit_logs").get()).docs.map((doc) => doc.data());
  const countOf = (action) => audits.filter((audit) => audit.action === action).length;
  const confirmationAudits = audits.filter((audit) => audit.action === "EQUAL_HANDOVER_CONFIRMED_V2");
  const ids = confirmationAudits.map((audit) => audit.id);
  assert.equal(ids.length, new Set(ids).size, "Confirmation audit events must never be duplicated.");
  for (const audit of confirmationAudits) {
    assert.equal(audit.protocol, "equal-handover-v2");
    assert.equal(audit.reservationId, fingerprint);
    assert.ok([uids.outgoingA, uids.outgoingB, uids.incomingA, uids.incomingB].includes(audit.actorUid),
      `Unexpected confirmation actor: ${audit.actorUid}`);
    assert.ok(!JSON.stringify(audit).match(/password|token|authorization/i), "Audit must never carry credential material.");
  }
  assert.deepEqual({
    confirmed: countOf("EQUAL_HANDOVER_CONFIRMED_V2"),
    absenceRecorded: countOf("EQUAL_HANDOVER_ABSENCE_RECORDED_V2"),
    frozen: countOf("EQUAL_HANDOVER_REPORT_FROZEN_V2"),
  }, { confirmed: 7, absenceRecorded: 1, frozen: 3 });

  // Boundary proofs: confirmation/readiness never transfer, finalize or create.
  assert.equal(await collectionSnapshot("handover_task_transfers"), baseline.transfers,
    "No task may be transferred by confirmations.");
  assert.equal(await collectionSnapshot("attendance_evidence_v2"), baseline.attendanceV2,
    "Confirmations must not finalize attendance evidence.");
  assert.equal(await collectionSnapshot("attendance_evidence_operations_v2"), baseline.attendanceOps);
  assert.equal(await collectionSnapshot("operational_shift_control"), baseline.control,
    "Confirmations must not advance operational shift control.");
  assert.equal(await collectionSnapshot("technician_schedules"), baseline.schedules,
    "Confirmations must not move any technician schedule.");
  assert.equal(await collectionSnapshot("handovers"), baseline.v1Handovers, "V1 handover aggregates must be untouched.");
  const shiftsAfter = JSON.parse(await collectionSnapshot("shifts"));
  assert.equal(shiftsAfter.length, JSON.parse(baseline.shifts).length, "No incoming shift may be created.");

  return {
    browserErrors,
    browserVersion,
    confirmationAudits: countOf("EQUAL_HANDOVER_CONFIRMED_V2"),
    reportVersions: [...byId.values()].map((report) => report.version).sort((a, b) => a - b),
    liveConfirmations: aggregate.confirmations.length,
    historicalConfirmations: aggregate.historicalConfirmations.length,
    absences: aggregate.absences.length,
    lifecycleStatus: aggregate.lifecycleStatus,
  };
}

try {
  await main();
} catch (failure) {
  console.error("CONFIRMATION BROWSER VERIFICATION FAILED:", failure);
  if (emulatorLog.length) console.error(`emulator log tail:\n${emulatorLog.join("").slice(-2500)}`);
  if (appLog.length) console.error(`application log tail:\n${appLog.join("").slice(-2500)}`);
  process.exitCode = 1;
} finally {
  await killTree(appProcess, "next dev");
  await killTree(emulatorProcess, "firebase emulators");
  await db.terminate().catch(() => {});
}
