/**
 * TECH-HO-RECOVERY-07 §12, re-scoped for M08 §8 — real browser verification of
 * the equal-technician v2 TWO-STAGE FINAL HANDOVER (commit → acceptance → guard
 * finalize).
 *
 * Run via: tests/run-handover-v2-transfer-browser.ps1
 *
 * M07's single atomic /handover/v2/transfer endpoint was retired by M08
 * decision #1: an active incoming shift may never exist without an incoming
 * technician's OWN password acceptance, so the outgoing commit and the incoming
 * activation had to split. The browser harness was rewritten to the two-stage
 * lifecycle rather than deleted, so that every §11 boundary the atomic path
 * proved — client-forged authority refused, session-derived actors, non-
 * authorized roles denied, idempotent replay, V1 lifecycle untouched, the frozen
 * report immutable — is still exercised end-to-end from a real browser against
 * a real Firebase Auth emulator, using only the reviewed-evidence routes the UI
 * may call.
 *
 * What this proves: a real Chromium (Edge channel) browser, signed in through
 * the production login flow against the synthetic Auth emulator, walks the
 * outgoing technician to the "awaiting incoming acceptance" state via the real
 * /handover/v2/commit route, then has each reserved incoming technician accept
 * with their OWN current password through /handover/v2/accept, and finally
 * terminalizes the reservation guard via /handover/v2/finalize. The suite proves
 * the committed outcome against FINAL Firestore documents, not API return
 * values: the incoming shift is created and activated by the FIRST incoming
 * acceptance only (never by the commit), both incoming technicians record their
 * own attendance at their own acceptance clock, the guard is completed against
 * the activation receipt, and the aggregate lifecycle is `completed`.
 *
 * §4 authorization is proved from the browser: a supervisor, an unrelated
 * technician and a client-forged body carrying an actor or timestamp are denied
 * on every stage; an incoming technician's commit is refused; the wrong-
 * password acceptance is refused. §5 idempotency is proved: a second outgoing
 * technician's commit returns ALREADY_COMMITTED 200; a re-acceptance returns
 * ALREADY_JOINED; a second finalize returns ALREADY_FINALIZED.
 *
 * Boundary invariants preserved from M07: V1 handover documents are byte-
 * unchanged, no task transfer is created, the bound frozen report is immutable,
 * and the commit alone synthesizes neither a Shift document, a membership, an
 * attendance record nor a v2 evidence document — acceptance is the sole event
 * that can produce any of those.
 *
 * Safety: refuses to run outside the synthetic "demo-shiftchange-v2" emulator
 * project, refuses a busy port, refuses an account file that already exists,
 * starts a fresh (never imported or exported) emulator database, and enables the
 * development gate only inside the spawned application child process. Scheduled
 * windows are anchored to Date.now() so the incoming acceptance's activation
 * window passes. Nothing here touches production configuration; passwords are
 * held only in the in-process sign-in/acceptance calls and never logged.
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

// Drive a v2 route from the real browser (with the real session cookie). The
// suite probes commit / accept / finalize directly so the browser flow tests
// the API contract the UI will call, without depending on the UI's controls.
async function probePost(page, path, body) {
  deniedProbeWindow += 1;
  deliberateProbes += 1;
  try {
    return await page.evaluate(async ([p, payload]) => {
      const response = await fetch(p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: response.status, noStore: response.headers.get("cache-control"), body: await response.json().catch(() => null) };
    }, [path, body]);
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
// helper read the same reservation the browser later commits and accepts.
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
    // 1 — outgoing technician A sees the two-stage checklist fully satisfied on
    //     the real v2 page: frozen report + all four confirmations.
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const beforeCommit = await pageText(page);
    assert.match(beforeCommit, /Readiness: all confirmations and permitted exceptions satisfied/);
    assert.match(beforeCommit, /Confirmed 4 of 4/);
    record(1, "v2 page loads with readiness satisfied", { readiness: "ready" });

    // 2 — stage-1 authorization derived server-side. A supervisor, an incoming
    //     technician and a client-forged body are each denied on /commit.
    const stampForCommit = await reservationStamp();
    const reviewedCommit = {
      expectedRevision: stampForCommit.expectedRevision,
      expectedSnapshotHash: stampForCommit.expectedSnapshotHash,
      expectedGuardRevision: stampForCommit.guard.guardRevision,
      expectedFencingEpoch: stampForCommit.guard.fencingEpoch,
    };
    const commitPath = `/api/operations/shifts/${encodeURIComponent(seeded.shiftId)}/handover/v2/commit`;

    await signOut(page); await page.close();
    page = await context.newPage(); attachErrorCapture(page);
    await signIn(page, seeded.accounts.supervisor);
    const supervisorDenial = await probePost(page, commitPath, reviewedCommit);
    assert.equal(supervisorDenial.status, 403, `A supervisor must not commit: ${JSON.stringify(supervisorDenial.body)}`);

    await signOut(page); await page.close();
    page = await context.newPage(); attachErrorCapture(page);
    await signIn(page, seeded.accounts.incomingA);
    const incomingCommitDenial = await probePost(page, commitPath, reviewedCommit);
    assert.equal(incomingCommitDenial.status, 403, `An incoming technician must not commit the outgoing handover: ${JSON.stringify(incomingCommitDenial.body)}`);

    await signOut(page); await page.close();
    page = await context.newPage(); attachErrorCapture(page);
    await signIn(page, seeded.accounts.outsider);
    const outsiderDenial = await probePost(page, commitPath, reviewedCommit);
    assert.equal(outsiderDenial.status, 403, `An outsider must not commit: ${JSON.stringify(outsiderDenial.body)}`);

    await signOut(page); await page.close();
    page = await openV2Page(context, seeded.accounts.outgoingA, seeded.shiftId);
    const forged = await probePost(page, commitPath, { ...reviewedCommit, actorUid: seeded.uids.incomingA, committedAt: new Date().toISOString() });
    assert.equal(forged.status, 400, `A client-forged body must be rejected: ${JSON.stringify(forged.body)}`);
    assert.equal(forged.noStore, "no-store", "A denied commit response must not be cacheable.");
    record(2, "supervisor, incoming technician, outsider and forged-body commit attempts are denied", {
      supervisor: supervisorDenial.status, incoming: incomingCommitDenial.status, outsider: outsiderDenial.status, forged: forged.status,
    });

    // 3 — outgoing A commits through the real route; the aggregate flips to
    //     `awaiting_incoming_acceptance` and NO shift/membership/attendance is
    //     created. Committing is the outgoing action; it requires no password.
    const committed = await probePost(page, commitPath, reviewedCommit);
    assert.equal(committed.status, 200, `Fresh commit must return 200: ${JSON.stringify(committed.body)}`);
    assert.equal(committed.body.success, true);
    assert.equal(committed.body.status, "COMMITTED");
    assert.equal(committed.body.replayed, false);
    assert.equal(committed.body.reservation.aggregate.lifecycleStatus, "awaiting_incoming_acceptance");

    const afterCommitAggregate = (await ref("equal_handovers_v2", createEqualHandoverDocumentId(seeded.shiftId)).get()).data();
    assert.equal(afterCommitAggregate.lifecycleStatus, "awaiting_incoming_acceptance");
    assert.equal((await ref("shifts", seeded.reservedIncomingShiftId).get()).exists, false,
      "Stage 1 (commit) must NOT create the incoming shift (§1 addendum #1).");
    const outgoingAfterCommit = (await ref("shifts", seeded.shiftId).get()).data();
    assert.equal(outgoingAfterCommit.status, "handover_pending",
      "The outgoing shift stays handover_pending; the operational slot remains owned during acceptance (§3 reconciliation).");
    const guardAfterCommit = (await ref("handover_reservation_guards", `guard_${seeded.shiftId}`).get()).data();
    assert.equal(guardAfterCommit.ownerLifecycleState, "active", "Commit never terminalizes the reservation guard.");
    for (const uid of [seeded.uids.incomingA, seeded.uids.incomingB]) {
      assert.equal((await ref("shift_members", `${seeded.reservedIncomingShiftId}_${uid}`).get()).exists, false,
        `No fabricated incoming membership for ${uid} after commit.`);
      assert.equal((await ref("shift_attendance", `${seeded.reservedIncomingShiftId}_${uid}`).get()).exists, false,
        `No fabricated incoming attendance for ${uid} after commit.`);
    }
    record(3, "outgoing A committed the handover; lifecycle moved to awaiting with no shift or attendance churn", {});

    // 4 — a second outgoing technician's commit is an idempotent replay that
    //     returns the same receipt.
    const replayStamp = await reservationStamp();
    const replay = await probePost(page, commitPath, {
      expectedRevision: replayStamp.expectedRevision, expectedSnapshotHash: replayStamp.expectedSnapshotHash,
      expectedGuardRevision: replayStamp.guard.guardRevision, expectedFencingEpoch: replayStamp.guard.fencingEpoch,
    });
    assert.equal(replay.status, 200, `A replay of the committed handover returns 200: ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.status, "ALREADY_COMMITTED");
    assert.equal(replay.body.receipt.id, committed.body.receipt.id, "The replayed receipt id matches the first commit.");
    record(4, "outgoing A replays the committed handover idempotently", { status: replay.body.status, replayed: replay.body.replayed });

    // 5 — an acceptance without a password is refused; wrong password refused.
    await signOut(page); await page.close();
    page = await openV2Page(context, seeded.accounts.incomingA, seeded.shiftId);
    const acceptPath = `/api/operations/shifts/${encodeURIComponent(seeded.shiftId)}/handover/v2/accept`;
    const acceptStamp = await reservationStamp();
    const acceptBinding = {
      expectedRevision: acceptStamp.expectedRevision, expectedSnapshotHash: acceptStamp.expectedSnapshotHash,
      expectedGuardRevision: acceptStamp.guard.guardRevision, expectedFencingEpoch: acceptStamp.guard.fencingEpoch,
    };
    const noPw = await probePost(page, acceptPath, acceptBinding);
    assert.equal(noPw.status, 400, `An accept body without a password is refused: ${JSON.stringify(noPw.body)}`);
    const wrongPw = await probePost(page, acceptPath, { ...acceptBinding, password: "wrong-password-x" });
    // reauthenticatePassword maps a rejected credential to a fail-closed 400
    // ("Current password is incorrect or authentication was rejected.") — the
    // authoritative contract asserted by the password-reauthentication suite and
    // mirrored by the acceptance browser. A wrong password never becomes 401/403.
    assert.equal(wrongPw.status, 400, `A wrong password must fail closed with 400: ${JSON.stringify(wrongPw.body)}`);
    record(5, "acceptance requires the technician's own valid password", { noPassword: noPw.status, wrongPassword: wrongPw.status });

    // 6 — incoming A personally accepts with their own password; this is the
    //     ONLY event that activates the incoming shift.
    const acceptA = await probePost(page, acceptPath, { ...acceptBinding, password: seeded.accounts.incomingA.password });
    assert.equal(acceptA.status, 200, `Incoming A must accept: ${JSON.stringify(acceptA.body)}`);
    assert.equal(acceptA.body.success, true);
    assert.equal(acceptA.body.status, "ACTIVATED");
    await signOut(page); await page.close();

    // 7 — incoming B joins the SAME active shift with an independent timestamp.
    page = await openV2Page(context, seeded.accounts.incomingB, seeded.shiftId);
    const joinStamp = await reservationStamp();
    const acceptB = await probePost(page, acceptPath, {
      expectedRevision: joinStamp.expectedRevision, expectedSnapshotHash: joinStamp.expectedSnapshotHash,
      expectedGuardRevision: joinStamp.guard.guardRevision, expectedFencingEpoch: joinStamp.guard.fencingEpoch,
      password: seeded.accounts.incomingB.password,
    });
    assert.equal(acceptB.status, 200, `Incoming B must join: ${JSON.stringify(acceptB.body)}`);
    assert.equal(acceptB.body.status, "JOINED");

    await signOut(page); await page.close();
    page = await openV2Page(context, seeded.accounts.incomingA, seeded.shiftId);
    const selfReAccept = await probePost(page, acceptPath, {
      ...(await reservationStamp2()), password: seeded.accounts.incomingA.password,
    });
    assert.equal(selfReAccept.status, 200, `A self re-acceptance replays: ${JSON.stringify(selfReAccept.body)}`);
    assert.equal(selfReAccept.body.status, "ALREADY_JOINED");
    record(6, "incoming A activated the shift with their own password; incoming B joined the same shift", {
      activation: acceptA.body.status, join: acceptB.body.status, replay: selfReAccept.body.status,
    });

    // 8 — the accept route auto-finalizes the deferred guard once BOTH incoming
    //     technicians have personally accepted, so the terminalization is proved
    //     idempotent rather than freshly performed.
    const finalizePath = `/api/operations/shifts/${encodeURIComponent(seeded.shiftId)}/handover/v2/finalize`;
    const guardBeforeFinalize = (await ref("handover_reservation_guards", `guard_${seeded.shiftId}`).get()).data();
    assert.equal(guardBeforeFinalize.ownerLifecycleState, "completed",
      "Both acceptances auto-terminalized the reservation guard (§5 deferred finalize).");
    const fin = await probePost(page, finalizePath, {});
    assert.equal(fin.status, 200, `Finalize after both acceptances must return 200: ${JSON.stringify(fin.body)}`);
    assert.equal(fin.body.status, "ALREADY_FINALIZED");
    assert.equal(fin.body.replayed, true);
    const replayFin = await probePost(page, finalizePath, {});
    assert.equal(replayFin.body.status, "ALREADY_FINALIZED");
    record(7, "reservation guard auto-finalized at the last acceptance; explicit finalize is an idempotent replay", { first: fin.body.status, replay: replayFin.body.status });
    // Final browser shot after the whole flow.
    await page.reload({ waitUntil: "networkidle", timeout: 180_000 });
    const terminalText = await pageText(page);
    assert.match(terminalText, /Revision/, "The reloaded report re-reads the completed aggregate from Firestore.");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // --- final authoritative state, not merely API return values -----------
    const authoritative = await verifyFinalState({ ...seeded, browserVersion, shiftId: seeded.shiftId });
    assert.deepEqual(authoritative.browserErrors, [], "The browser must report no uncaught errors.");
    assert.equal(authoritative.commitReceipts, 1, "Exactly one commitment receipt across the browser flow and replay.");
    assert.equal(authoritative.activationReceipts, 1, "Exactly one activation receipt across both acceptances.");
    assert.equal(deliberateProbes, 13, "Four commit denials + commit + replay + two accept denials + accept A + accept B + self replay + finalize + finalize replay are expected.");

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

    console.log(`PASS: ${steps.length} two-stage transfer-browser steps verified against ${project}; commit → acceptance → finalize activated exactly one incoming shift with independent attendance and V1 untouched.`);
    console.log(`Evidence: ${evidencePath}`);
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser.isConnected()) await browser.close();
    await killTree(appProcess, "next dev");
    await killTree(emulatorProcess, "firebase emulators");
  }
}

async function reservationStamp2() {
  const s = await reservationStamp();
  return {
    expectedRevision: s.expectedRevision, expectedSnapshotHash: s.expectedSnapshotHash,
    expectedGuardRevision: s.guard.guardRevision, expectedFencingEpoch: s.guard.fencingEpoch,
  };
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

  shiftRef.id = shiftId;
  const binding = await reservationStamp();
  const preparation = (await prepareEqualHandoverReport({ outgoingShiftId: shiftId, actorUid: uids.outgoingA, reason: "browser two-stage review" })).preparation;
  const freezeBinding = await reservationStamp();
  await freezeEqualHandoverReport({
    outgoingShiftId: shiftId, actorUid: uids.outgoingA,
    expectedRevision: freezeBinding.expectedRevision, expectedSnapshotHash: freezeBinding.expectedSnapshotHash,
    expectedGuardRevision: freezeBinding.guard.guardRevision, expectedFencingEpoch: freezeBinding.guard.fencingEpoch,
    preparationRevision: preparation.preparationRevision, contentDigest: preparation.contentDigest,
    evidenceSnapshotHash: preparation.evidenceSnapshotHash, workSnapshotVersion: preparation.workSnapshotVersion,
    reason: "Reviewed and frozen for the two-stage browser run", correctionNote: null,
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
      transfers: await collectionSnapshot("handover_task_transfers"),
      v1Handovers: await collectionSnapshot("handovers"),
      report: canonical(await ref("handover_reports_v2", reservation.aggregate.reportBinding.id).get()),
    },
  };
}

async function verifyFinalState({ shiftId, uids, reservedIncomingShiftId, baseline, browserVersion }) {
  const documentId = createEqualHandoverDocumentId(shiftId);
  const aggregate = (await ref("equal_handovers_v2", documentId).get()).data();
  assert.equal(aggregate.lifecycleStatus, "completed", "The two-stage browser flow completed the lifecycle.");

  const outgoing = (await ref("shifts", shiftId).get()).data();
  assert.equal(outgoing.status, "completed");
  assert.equal(typeof outgoing.actualEnd, "string");

  const incoming = await ref("shifts", reservedIncomingShiftId).get();
  assert.equal(incoming.exists, true, "The incoming shift was created by the FIRST incoming acceptance, not the commit.");
  assert.equal(incoming.data().status, "active");
  assert.deepEqual(incoming.data().primaryTechnicianIds, [uids.incomingA, uids.incomingB]);
  assert.equal(typeof incoming.data().actualStart, "string");

  const guard = (await ref("handover_reservation_guards", `guard_${shiftId}`).get()).data();
  assert.equal(guard.ownerLifecycleState, "completed", "The reservation guard completed at the deferred finalize step.");

  const audits = (await db.collection("audit_logs").get()).docs.map((doc) => doc.data());
  const commitReceipts = audits.filter((a) => a.action === "EQUAL_HANDOVER_OUTGOING_COMMITTED_V2");
  const activationReceipts = audits.filter((a) => a.action === "EQUAL_SHIFT_ACTIVATED_INCOMING_V2");
  assert.equal(commitReceipts.length, 1, "Exactly one commitment receipt across the flow and the outgoing replay.");
  assert.equal(activationReceipts.length, 1, "Exactly one activation receipt across both acceptances and the self replay.");
  assert.equal(guard.terminalEvidenceRef, activationReceipts[0].id, "The guard pins the committed activation receipt.");
  assert.equal(activationReceipts[0].incomingShiftId, reservedIncomingShiftId);
  assert.equal(activationReceipts[0].actorRole, "technician");
  assert.ok([uids.incomingA, uids.incomingB].includes(activationReceipts[0].actorUid), "The activation receipt actor is one of the reserved incoming technicians.");

  // Each accepted incoming technician has their OWN shift_attendance row, with
  // independent recordedAt timestamps (the acceptance clocks). No partner is
  // fabricated, and no first technician's row is overwritten.
  const attendanceA = (await ref("shift_attendance", `${reservedIncomingShiftId}_${uids.incomingA}`).get()).data();
  const attendanceB = (await ref("shift_attendance", `${reservedIncomingShiftId}_${uids.incomingB}`).get()).data();
  assert.ok(attendanceA && attendanceB, "Both incoming technicians have their own shift_attendance row after acceptance.");
  assert.notEqual(attendanceA.recordedAt, attendanceB.recordedAt, "Acceptance clocks are independent.");

  // Boundary proofs: no task transfer, V1 untouched, frozen report immutable.
  assert.equal(await collectionSnapshot("handover_task_transfers"), baseline.transfers, "No task may be transferred.");
  assert.equal(await collectionSnapshot("handovers"), baseline.v1Handovers, "V1 handover aggregates must be untouched.");
  assert.equal(canonical(await ref("handover_reports_v2", aggregate.reportBinding.id).get()), baseline.report, "The frozen report is immutable across the two-stage flow.");

  // Passwords must never appear in the persisted audit trail or aggregate.
  const serializedAudit = JSON.stringify(audits.map((a) => ({ ...a, createdAt: undefined })));
  const serializedAggregate = JSON.stringify(aggregate);
  assert.ok(!/password|refreshToken|idToken|sessionCookie/i.test(serializedAudit), "Audit logs must not leak credentials.");
  assert.ok(!/password|refreshToken|idToken|sessionCookie/i.test(serializedAggregate), "The aggregate must not leak credentials.");

  return {
    browserErrors,
    browserVersion,
    commitReceipts: commitReceipts.length,
    activationReceipts: activationReceipts.length,
    lifecycleStatus: aggregate.lifecycleStatus,
    snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
  };
}

try {
  await main();
} catch (failure) {
  console.error("TWO-STAGE TRANSFER BROWSER VERIFICATION FAILED:", failure);
  if (emulatorLog.length) console.error(`emulator log tail:\n${emulatorLog.join("").slice(-2500)}`);
  if (appLog.length) console.error(`application log tail:\n${appLog.join("").slice(-2500)}`);
  process.exitCode = 1;
} finally {
  await killTree(appProcess, "next dev");
  await killTree(emulatorProcess, "firebase emulators");
  await db.terminate().catch(() => {});
}
