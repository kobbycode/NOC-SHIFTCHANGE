/**
 * TECH-HO-RECOVERY-07 §12 — real browser verification of the atomic v2 FINAL
 * TRANSFER.
 *
 * Run via: tests/run-handover-v2-transfer-browser.ps1
 *
 * What this proves: a real Chromium (Edge channel) browser signs an outgoing
 * reserved technician in through the production login flow against the synthetic
 * Auth emulator, walks into the dedicated v2 page, sees the "Final transfer"
 * prerequisite checklist satisfied and the action enabled — but explicitly
 * told it is only a display gate, not an authorization (§10) — and completes the
 * handover through the real /handover/v2/transfer route with a real session
 * cookie. The suite then proves the committed outcome against final Firestore
 * documents, not API return values: the incoming shift is created and active,
 * the outgoing shift is completed, the reservation guard is completed with the
 * transfer receipt as terminal evidence, and a durable receipt exists. It also
 * proves the transfer's own authorization: a supervisor, an unrelated
 * technician and a client-forged body are denied from the browser, and a second
 * technician's later attempt replays the committed transfer as an idempotent
 * 200 rather than transferring twice. Boundary invariants: attendance and the
 * V1 lifecycle are byte-unchanged and no second incoming shift or receipt is
 * ever created.
 *
 * Safety: refuses to run outside the synthetic "demo-shiftchange-v2" emulator
 * project, refuses a busy port, refuses an account file that already exists,
 * starts a fresh (never imported or exported) emulator database, and enables the
 * development gate only inside the spawned application child process. Scheduled
 * windows are anchored to Date.now() so the transfer's activation window passes.
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
const port = Number(process.env.HO07_BROWSER_PORT ?? 3103);
const origin = `http://127.0.0.1:${port}`;
const browserChannel = process.env.HO07_BROWSER_CHANNEL ?? "msedge";

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
const accountsPath = join(repoRoot, ".demo", "handover-v2-transfer-browser-accounts.json");
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
const { createEqualHandoverDocumentId, createEqualHandoverSnapshot } = await import("../src/lib/operations/equal-technician-handover-domain.ts");
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
const password = () => `HO07-${randomBytes(18).toString("base64url")}!`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let emulatorProcess = null;
let appProcess = null;
const emulatorLog = [];
const appLog = [];
const browserErrors = [];
const resourceStatusErrors = [];
let deniedProbeWindow = 0;
let deliberateProbes = 0;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = join(repoRoot, ".demo", `handover-v2-transfer-browser-verification-${stamp}.json`);
const screenshotPath = join(repoRoot, ".demo", `handover-v2-transfer-browser-verification-${stamp}.png`);

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

async function probePost(page, shiftId, body) {
  deniedProbeWindow += 1;
  deliberateProbes += 1;
  try {
    return await page.evaluate(async ([id, payload]) => {
      const response = await fetch(`/api/operations/shifts/${encodeURIComponent(id)}/handover/v2/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: response.status, noStore: response.headers.get("cache-control"), body: await response.json().catch(() => null) };
    }, [shiftId, body]);
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

async function reservationStamp() {
  const state = await readEqualHandoverReservation(shiftRef.id);
  return {
    expectedRevision: state.aggregate.revision,
    expectedSnapshotHash: state.snapshotHash,
    guard: state.guard,
    aggregate: state.aggregate,
  };
}

// The shift id is generated inside seed(); this mutable holder lets the stamp
// helper read the same reservation the browser later transfers.
const shiftRef = { id: null };

// ---------------------------------------------------------------------------
// §12 browser steps
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
  shiftRef.id = seeded.shiftId;

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  const steps = [];
  const record = (index, name, detail) => steps.push({ step: index, name, ...detail });
  let page = null;

  try {
    // 1 — outgoing technician A sees the Final transfer checklist fully
    //     satisfied and the action enabled, but told it is only a display gate.
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const beforeTransfer = await pageText(page);
    assert.match(beforeTransfer, /Readiness: all confirmations and permitted exceptions satisfied/);
    assert.match(beforeTransfer, /Confirmed 4 of 4/);
    const transferSection = page.locator("section", { hasText: "Final transfer" });
    await transferSection.waitFor({ timeout: 60_000 });
    assert.ok((await transferSection.innerText()).includes("Consolidated report frozen"), "Frozen-report prerequisite shown.");
    assert.ok((await transferSection.innerText()).includes("You have personally confirmed this handover"), "Self-confirmation prerequisite shown.");
    assert.ok((await transferSection.innerText()).includes("No report completeness blockers"), "No-blocker prerequisite shown.");
    const transferButton = transferSection.getByRole("button", { name: "Complete handover and transfer shift" });
    assert.ok(await transferButton.isEnabled(), "The transfer action is enabled for a confirmed outgoing technician once ready.");
    assert.ok(beforeTransfer.includes("This display gate is not an authorization"), "§10: the enable state must be labelled a display gate, never an authorization.");
    record(1, "final transfer checklist satisfied and action enabled as a display gate", { readiness: "ready", enabled: true });

    // 2 — prohibited initiators are denied by the route, straight from the
    //     browser, with the same reviewed evidence A would carry.
    const stampForTransfer = await reservationStamp();
    const reviewed = {
      expectedRevision: stampForTransfer.expectedRevision,
      expectedSnapshotHash: stampForTransfer.expectedSnapshotHash,
      expectedGuardRevision: stampForTransfer.guard.guardRevision,
      expectedFencingEpoch: stampForTransfer.guard.fencingEpoch,
    };
    await signOut(page);
    await page.close();
    page = await context.newPage();
    attachErrorCapture(page);
    await signIn(page, seeded.accounts.supervisor);
    const supervisorDenial = await probePost(page, seeded.shiftId, reviewed);
    assert.equal(supervisorDenial.status, 403, `A supervisor must not transfer: ${JSON.stringify(supervisorDenial.body)}`);
    await signOut(page);
    await page.close();
    page = await context.newPage();
    attachErrorCapture(page);
    await signIn(page, seeded.accounts.outsider);
    const outsiderDenial = await probePost(page, seeded.shiftId, reviewed);
    assert.equal(outsiderDenial.status, 403, `An outsider must not transfer: ${JSON.stringify(outsiderDenial.body)}`);
    await signOut(page);
    await page.close();
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const forged = await probePost(page, seeded.shiftId, { ...reviewed, actorUid: seeded.uids.incomingA, transferredAt: new Date().toISOString() });
    assert.equal(forged.status, 400, `A client-forged body must be rejected: ${JSON.stringify(forged.body)}`);
    assert.equal(forged.noStore, "no-store", "A denied transfer response must not be cacheable.");
    record(2, "supervisor, outsider and forged-body transfer attempts are denied", {
      supervisor: supervisorDenial.status, outsider: outsiderDenial.status, forged: forged.status,
    });

    // 3 — an incoming technician is told the final transfer is not theirs, and
    //     is offered no enabled transfer control.
    await signOut(page);
    await page.close();
    page = await openV2Page(context, seeded.accounts.incomingA, seeded.shiftId);
    const incomingText = await pageText(page);
    assert.ok(incomingText.includes("Completing the final transfer is reserved for an outgoing technician"),
      "An incoming technician is told the transfer is not theirs.");
    assert.equal((await page.locator("section", { hasText: "Final transfer" }).count()), 0, "No Final transfer control for an incoming technician.");
    record(3, "incoming technician sees no transfer control", { sections: 0 });
    await signOut(page);
    await page.close();

    // 4 — outgoing technician A completes the handover through the real route.
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const readyButton = page.locator("section", { hasText: "Final transfer" }).getByRole("button", { name: "Complete handover and transfer shift" });
    await readyButton.waitFor({ timeout: 60_000 });
    assert.ok(await readyButton.isEnabled());
    await readyButton.click();
    await page.getByText("Handover transferred. The incoming shift is now active.").waitFor({ timeout: 180_000 });
    await page.getByRole("heading", { name: "Handover transferred" }).waitFor({ timeout: 60_000 });
    const transferred = await pageText(page);
    assert.match(transferred, /outgoing shift .* is closed and the incoming shift .* is active/);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    record(4, "outgoing technician A transferred the handover through the browser", { lifecycle: "completed" });

    // 5 — a reload persists the terminal state; a second technician's attempt
    //     replays the committed transfer as a 200 rather than transferring twice.
    await page.reload({ waitUntil: "networkidle", timeout: 180_000 });
    await page.getByRole("heading", { name: "Handover transferred" }).waitFor({ timeout: 60_000 });
    assert.match(await pageText(page), /Revision/, "The reloaded report re-reads the completed aggregate from Firestore.");
    await signOut(page);
    await page.close();
    page = await openV2Page(context, seeded.accounts.outgoingB, seeded.shiftId);
    const replayStamp = await reservationStamp();
    const replay = await probePost(page, seeded.shiftId, {
      expectedRevision: replayStamp.expectedRevision, expectedSnapshotHash: replayStamp.expectedSnapshotHash,
      expectedGuardRevision: replayStamp.guard.guardRevision, expectedFencingEpoch: replayStamp.guard.fencingEpoch,
    });
    assert.equal(replay.status, 200, `A replay of the committed transfer returns 200: ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.status, "ALREADY_TRANSFERRED");
    record(5, "a second outgoing technician replays the committed transfer", { status: replay.body.status, replayed: replay.body.replayed });

    // --- final authoritative state, not merely API return values -----------
    const authoritative = await verifyFinalState({ ...seeded, browserVersion, shiftId: seeded.shiftId });
    assert.deepEqual(authoritative.browserErrors, [], "The browser must report no uncaught errors.");
    assert.equal(authoritative.transferReceipts, 1, "Exactly one transfer receipt across the browser flow and replay.");
    assert.equal(deliberateProbes, 4, "Three denied probes plus one replay are expected.");
    // The three non-2xx denials (supervisor, outsider, forged body) each make
    // Chrome log a "Failed to load resource" console error, which the error
    // capture classifies as asserted probe evidence. The replay probe returns a
    // 200 success, so it produces no such resource error — exactly three are
    // expected, and no uncaught page error may hide among them.
    assert.equal(resourceStatusErrors.length, 3,
      `Only the three denied 4xx probes may log resource errors: ${JSON.stringify(resourceStatusErrors)}`);

    await browser.close();

    await writeFile(evidencePath, JSON.stringify({
      verifiedAt: new Date().toISOString(),
      browser: { channel: browserChannel, version: authoritative.browserVersion },
      project, origin,
      shiftId: seeded.shiftId,
      reservedIncomingShiftId: seeded.reservedIncomingShiftId,
      reservationFingerprint: seeded.fingerprint,
      deniedProbeConsoleResourceErrors: resourceStatusErrors,
      steps,
      authoritative,
      accountsFile: ".demo/handover-v2-transfer-browser-accounts.json",
      screenshot: ".demo/" + basename(screenshotPath),
    }, null, 2), { flag: "wx", mode: 0o600 });

    console.log(`PASS: ${steps.length} transfer browser steps verified against ${project}; the handover completed atomically with attendance and V1 untouched.`);
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
  const prefix = `ho07b${randomBytes(3).toString("hex")}`;
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
    const email = `${prefix}-${key}@handover-v2-transfer-browser.invalid`;
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
    operationalSlotToken: token, shiftType: "morning", scheduledStart: outStart, scheduledEnd: outEnd,
    actualStart: outStart, actualEnd: null, engineeringLocation: "Accra Engineering Suite",
    createdBy: uids.supervisor, createdAt: outStart, updatedAt: outStart,
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
  batch.set(ref("technician_schedules", uids.outsider), { technicianUid: uids.outsider, entries: [], updatedAt: outStart });
  await batch.commit();

  const actor = { uid: uids.outgoingA, role: "technician" };
  const at = (hoursAfterStart) => iso(Date.parse(outStart) + hoursAfterStart * 3600_000);
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
    shiftType: "morning", scheduledStart: inStart, scheduledEnd: inEnd, idempotencyKey: `ho07-browser-${randomUUID()}`,
  });

  // Production writers drive the review to a frozen, fully confirmed report so
  // the browser starts at the authoritative transfer decision point.
  shiftRef.id = shiftId;
  const binding = await reservationStamp();
  const preparation = (await prepareEqualHandoverReport({ outgoingShiftId: shiftId, actorUid: uids.outgoingA, reason: "browser transfer review" })).preparation;
  const freezeBinding = await reservationStamp();
  await freezeEqualHandoverReport({
    outgoingShiftId: shiftId, actorUid: uids.outgoingA,
    expectedRevision: freezeBinding.expectedRevision, expectedSnapshotHash: freezeBinding.expectedSnapshotHash,
    expectedGuardRevision: freezeBinding.guard.guardRevision, expectedFencingEpoch: freezeBinding.guard.fencingEpoch,
    preparationRevision: preparation.preparationRevision, contentDigest: preparation.contentDigest,
    evidenceSnapshotHash: preparation.evidenceSnapshotHash, workSnapshotVersion: preparation.workSnapshotVersion,
    reason: "Reviewed and frozen for the transfer browser run", correctionNote: null,
  });
  for (const uid of [uids.outgoingA, uids.outgoingB, uids.incomingA, uids.incomingB]) {
    const stamp = await reservationStamp();
    await confirmEqualHandoverParticipantV2({ outgoingShiftId: shiftId, actorUid: uid,
      expectedRevision: stamp.expectedRevision, expectedSnapshotHash: stamp.expectedSnapshotHash });
  }

  const reservation = await readEqualHandoverReservation(shiftId);
  return {
    prefix, shiftId, uids, names, accounts,
    fingerprint: reservation.aggregate.reservation.handoverId,
    reservedIncomingShiftId: reservation.aggregate.reservation.reservedIncomingShiftId,
    firstRoundStamp: binding,
    baseline: {
      attendanceLegacy: await collectionSnapshot("shift_attendance"),
      attendanceV2: await collectionSnapshot("attendance_evidence_v2"),
      transfers: await collectionSnapshot("handover_task_transfers"),
      v1Handovers: await collectionSnapshot("handovers"),
      report: canonical(await ref("handover_reports_v2", reservation.aggregate.reportBinding.id).get()),
    },
  };
}

async function verifyFinalState({ shiftId, uids, reservedIncomingShiftId, baseline, browserVersion }) {
  const documentId = createEqualHandoverDocumentId(shiftId);
  const aggregate = (await ref("equal_handovers_v2", documentId).get()).data();
  assert.equal(aggregate.lifecycleStatus, "completed", "The browser transfer completed the lifecycle.");

  const outgoing = (await ref("shifts", shiftId).get()).data();
  assert.equal(outgoing.status, "completed");
  assert.equal(typeof outgoing.actualEnd, "string");
  const incoming = await ref("shifts", reservedIncomingShiftId).get();
  assert.equal(incoming.exists, true, "The reserved incoming shift was created by the browser transfer.");
  assert.equal(incoming.data().status, "active");
  assert.deepEqual(incoming.data().primaryTechnicianIds, [uids.incomingA, uids.incomingB]);

  const guard = (await ref("handover_reservation_guards", `guard_${shiftId}`).get()).data();
  assert.equal(guard.ownerLifecycleState, "completed", "The reservation guard completed with the transfer.");

  const audits = (await db.collection("audit_logs").get()).docs.map((doc) => doc.data());
  const receipts = audits.filter((audit) => audit.action === "EQUAL_SHIFT_HANDOVER_TRANSFERRED_V2");
  assert.equal(receipts.length, 1, "Exactly one transfer receipt persisted across the flow and the replay.");
  assert.equal(guard.terminalEvidenceRef, receipts[0].id, "The guard pins the committed transfer receipt.");
  assert.equal(receipts[0].incomingShiftId, reservedIncomingShiftId);
  assert.equal(receipts[0].actorRole, "technician");

  // Boundary proofs: attendance, task transfers and V1 remain byte-unchanged.
  assert.equal(await collectionSnapshot("shift_attendance"), baseline.attendanceLegacy, "Transfer must not finalize attendance.");
  assert.equal(await collectionSnapshot("attendance_evidence_v2"), baseline.attendanceV2, "Transfer must not synthesize attendance evidence.");
  assert.equal(await collectionSnapshot("handover_task_transfers"), baseline.transfers, "No task may be transferred.");
  assert.equal(await collectionSnapshot("handovers"), baseline.v1Handovers, "V1 handover aggregates must be untouched.");
  assert.equal(canonical(await ref("handover_reports_v2", aggregate.reportBinding.id).get()), baseline.report, "The frozen report is immutable across the transfer.");

  return {
    browserErrors,
    browserVersion,
    transferReceipts: receipts.length,
    lifecycleStatus: aggregate.lifecycleStatus,
    snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
  };
}

try {
  await main();
} catch (failure) {
  console.error("TRANSFER BROWSER VERIFICATION FAILED:", failure);
  if (emulatorLog.length) console.error(`emulator log tail:\n${emulatorLog.join("").slice(-2500)}`);
  if (appLog.length) console.error(`application log tail:\n${appLog.join("").slice(-2500)}`);
  process.exitCode = 1;
} finally {
  await killTree(appProcess, "next dev");
  await killTree(emulatorProcess, "firebase emulators");
  await db.terminate().catch(() => {});
}
