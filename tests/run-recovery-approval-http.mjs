/**
 * Phase 8C.3 — §2 harness for the recovery-approval HTTP boundary suite.
 *
 * Runs INSIDE `firebase emulators:exec` (started by
 * tests/run-recovery-approval-http.ps1), so it sees only the disposable
 * Firestore/Auth emulators of project "demo-admin-review-8b". It starts two
 * real Next.js dev servers over the same source tree:
 *
 *   - http://127.0.0.1:3190  HANDOVER_V2_DEV=true   (routes reachable)
 *   - http://127.0.0.1:3191  HANDOVER_V2_DEV unset (routes hidden, 404)
 *
 * then executes tests/recovery-approval-http-emulator.test.mjs and always tears
 * the two process trees down. Each server owns a distinct NEXT_DIST_DIR so the
 * two builds never overwrite each other and neither touches the normal ".next".
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = "demo-admin-review-8b";
const portOn = 3190;
const portOff = 3191;
const originOn = `http://127.0.0.1:${portOn}`;
const originOff = `http://127.0.0.1:${portOff}`;

for (const key of ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
  assert.equal(process.env[key], project, `${key} must be the disposable HTTP project.`);
}
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8980");
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:10099");
assert.equal(process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS, "true");

const nextBin = join(repoRoot, "node_modules", "next", "dist", "bin", "next");
assert.ok(existsSync(nextBin), "The local Next.js CLI is required.");

const logs = { on: [], off: [] };
const logFiles = { on: ".demo/recovery-approval-http-on.log", off: ".demo/recovery-approval-http-off.log" };
const logStreams = {};
const children = [];
mkdirSync(join(repoRoot, ".demo"), { recursive: true });
for (const label of ["on", "off"]) {
  logStreams[label] = createWriteStream(join(repoRoot, logFiles[label]), { flags: "w" });
}

function launch(label, port, distDir, extraEnv) {
  const env = { ...process.env, ...extraEnv, NEXT_DIST_DIR: distDir };
  // react-server conditions are for CLI module execution, not the dev compiler.
  delete env.NODE_OPTIONS;
  // The gates-off server must not inherit the V2 flag from the ambient shell.
  if (extraEnv.HANDOVER_V2_DEV !== "true") {
    env.HANDOVER_V2_DEV = "false";
  }
  console.log(
    `[launch] ${label}: http://127.0.0.1:${port} distDir=${distDir} ` +
      `HANDOVER_V2_DEV=${env.HANDOVER_V2_DEV ?? "(unset)"} ` +
      `APP_ORIGIN=${env.APP_ORIGIN ?? "(unset)"} log=${logFiles[label]}`,
  );
  const child = spawn(
    process.execPath,
    [nextBin, "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const capture = (chunk) => {
    const text = chunk.toString();
    logs[label].push(text);
    logStreams[label].write(text);
    if (logs[label].length > 2_000) logs[label].splice(0, logs[label].length - 2_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("exit", (code) => {
    const notice = `\n[next-${label}] exited with code ${code}\n`;
    logs[label].push(notice);
    logStreams[label].write(notice);
  });
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null || child.killed) continue;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // Best effort: the harness must never mask the test result.
    }
  }
}
process.on("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopAll();
    process.exit(130);
  });
}

function tail(label, lines = 40) {
  return logs[label].join("").split("\n").slice(-lines).join("\n");
}

// A lightweight route handler proves the compiler pipeline is warm without
// compiling the heavyweight /login page. An empty login body is rejected 400.
async function routeReady(origin) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(180_000),
  });
  return response.status === 400;
}

async function waitFor(label, predicate, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.exitCode !== null) {
      throw new Error(
        `[next-${label}] exited before becoming ready. Full log: ${logFiles[label]}\n${tail(label, 80)}`,
      );
    }
    try {
      if (await predicate()) return;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `[next-${label}] did not become ready in ${timeoutMs} ms. Full log: ${logFiles[label]}\n${tail(label, 80)}`,
      );
    }
    await new Promise((settled) => setTimeout(settled, 1_000));
  }
}

// Refuse to run when something already owns one of our origins: a stale dev
// server from an interrupted run would answer the readiness probe and silently
// invert which process the suite is talking to.
async function assertOriginFree(origin, label) {
  try {
    await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(1_500),
    });
  } catch {
    return;
  }
  throw new Error(`${label} already answers at ${origin}; stop that process before rerunning the suite.`);
}

async function probe(origin, method, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await response.text();
  return { status: response.status, body: text.slice(0, 200) };
}

const PROBE_ID = "handover_recovery_approval_v1_probe";
const ROUTES = [
  ["GET", `/api/admin/recovery-approvals?handoverDocumentId=handover_v2_probe`, undefined],
  ["GET", `/api/admin/recovery-approvals/${PROBE_ID}`, undefined],
  ["POST", "/api/admin/recovery-approvals", {}],
  ["POST", `/api/admin/recovery-approvals/${PROBE_ID}/approvals`, {}],
  ["POST", `/api/admin/recovery-approvals/${PROBE_ID}/void`, {}],
  ["POST", `/api/admin/recovery-approvals/${PROBE_ID}/reissue`, {}],
];

// Prove the gate direction before any test runs. With the V2 flag on, each
// route must be reachable (401 without a session); with it off, all must 404.
async function assertGateDirection(origin, expected, label) {
  for (const [method, path, body] of ROUTES) {
    const observed = await probe(origin, method, path, body);
    if (observed.status !== expected) {
      throw new Error(
        `[next-${label}] expected ${method} ${path} to answer ${expected} at ${origin} but got ` +
          `${observed.status}: ${observed.body}. Full log: ${logFiles[label]}`,
      );
    }
  }
  console.log(`[gate] ${label}: all six route probes answered ${expected} as expected.`);
}

let exitCode = 1;
try {
  await assertOriginFree(originOn, "gates-on");
  await assertOriginFree(originOff, "gates-off");

  // Fresh build directories: nothing from an interrupted run may leak in.
  for (const distDir of [".next-recovery-approval-http-on", ".next-recovery-approval-http-off"]) {
    rmSync(join(repoRoot, distDir), { recursive: true, force: true });
  }

  const on = launch("on", portOn, ".next-recovery-approval-http-on", {
    HANDOVER_V2_DEV: "true",
    APP_ORIGIN: originOn,
  });
  console.log(`Waiting for V2-enabled application at ${originOn} ...`);
  await waitFor("on", () => routeReady(originOn), 420_000, on);

  const off = launch("off", portOff, ".next-recovery-approval-http-off", {
    APP_ORIGIN: originOff,
    // `.env.local` sets HANDOVER_V2_DEV=true, and Next only lets a real
    // process env value override it. Deleting the variable is not enough.
    HANDOVER_V2_DEV: "false",
  });
  console.log(`Waiting for V2-disabled application at ${originOff} ...`);
  await waitFor("off", () => routeReady(originOff), 420_000, off);

  await assertGateDirection(originOn, 401, "on");
  await assertGateDirection(originOff, 404, "off");
  console.log("[warm] list, read, create, countersign, void and reissue compiled on both servers.");

  exitCode = await new Promise((settled) => {
    // A pattern is only used for focused debugging runs; the validation run
    // passes no pattern and executes all scenarios.
    const pattern = process.env.RECOVERY_APPROVAL_HTTP_TEST_PATTERN;
    const test = spawn(
      process.execPath,
      [
        "--import", "tsx",
        "--test", "--test-concurrency=1",
        ...(pattern ? ["--test-name-pattern", pattern] : []),
        "tests/recovery-approval-http-emulator.test.mjs",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HANDOVER_V2_DEV: "true",
          NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
          RECOVERY_APPROVAL_HTTP_ORIGIN: originOn,
          RECOVERY_APPROVAL_HTTP_ORIGIN_DISABLED: originOff,
          // The suite imports server-only modules directly for seeding.
          NODE_OPTIONS: "--conditions=react-server",
        },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    children.push(test);
    test.on("exit", (code) => settled(code ?? 1));
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  stopAll();
  await new Promise((settled) => setTimeout(settled, 1_500));
  for (const stream of Object.values(logStreams)) stream.end();
}

if (exitCode !== 0) {
  console.error(
    `\n==== V2-enabled application log (tail, full: ${logFiles.on}) ====\n` + tail("on"),
  );
  console.error(
    `\n==== V2-disabled application log (tail, full: ${logFiles.off}) ====\n` + tail("off"),
  );
}
process.exit(exitCode);
