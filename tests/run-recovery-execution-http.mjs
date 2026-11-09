/**
 * Phase 8C.5 harness for the recovery-execution HTTP boundary suite.
 *
 * Runs INSIDE `firebase emulators:exec` (started by
 * tests/run-handover-recovery-execution-http.ps1), so it sees only the disposable
 * Firestore/Auth emulators of the registered tuple "demo-admin-review-8b"
 * (Firestore 8980 / Auth 10099). Reusing that tuple is deliberate: it is already
 * on the closed reauthentication allowlist, so this phase leaves the allowlist
 * byte-identical.
 *
 * It starts two real Next.js dev servers over the same source tree:
 *
 *   - http://127.0.0.1:3198  V2 on + HANDOVER_RECOVERY_EXECUTION_ENABLED=true
 *   - http://127.0.0.1:3199  V2 on + HANDOVER_RECOVERY_EXECUTION_ENABLED=false
 *
 * so the second gate is proved to default off even where the handover family is
 * reachable. Each server owns a distinct NEXT_DIST_DIR; the normal ".next" used
 * by the UAT applications is never touched. No protected project, port or
 * persisted snapshot is contacted.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = "demo-admin-review-8b";
const portOn = 3198;
const portOff = 3199;
const originOn = `http://127.0.0.1:${portOn}`;
const originOff = `http://127.0.0.1:${portOff}`;

for (const key of ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
  assert.equal(process.env[key], project, `${key} must be the registered disposable HTTP project.`);
}
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8980");
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:10099");
assert.equal(process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS, "true");

const nextBin = join(repoRoot, "node_modules", "next", "dist", "bin", "next");
assert.ok(existsSync(nextBin), "The local Next.js CLI is required.");

const logs = { on: [], off: [] };
const logFiles = {
  on: ".demo/recovery-execution-http-on.log",
  off: ".demo/recovery-execution-http-off.log",
};
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
  if (extraEnv.HANDOVER_V2_DEV !== "true") {
    env.HANDOVER_V2_DEV = "false";
  }
  if (extraEnv.HANDOVER_RECOVERY_EXECUTION_ENABLED !== "true") {
    env.HANDOVER_RECOVERY_EXECUTION_ENABLED = "false";
  }
  console.log(
    `[launch] ${label}: http://127.0.0.1:${port} distDir=${distDir} ` +
      `HANDOVER_V2_DEV=${env.HANDOVER_V2_DEV} ` +
      `HANDOVER_RECOVERY_EXECUTION_ENABLED=${env.HANDOVER_RECOVERY_EXECUTION_ENABLED} ` +
      `APP_ORIGIN=${env.APP_ORIGIN} log=${logFiles[label]}`,
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

const EXECUTION_ROUTES = [
  ["POST", "/api/admin/recovery-approvals-v2/hrv2_probe/execute", {}],
  ["GET", "/api/admin/recovery-approvals-v2/hrv2_probe/execute", undefined],
];

// Prove the gate direction before any test runs. With both gates on, each route
// is reachable (401 without a session); with the execution gate off, both 404
// even though the surrounding Version 2 family is on.
async function assertGateDirection(origin, expected, label) {
  for (const [method, path, body] of EXECUTION_ROUTES) {
    const observed = await probe(origin, method, path, body);
    if (observed.status !== expected) {
      throw new Error(
        `[next-${label}] expected ${method} ${path} to answer ${expected} at ${origin} but got ` +
          `${observed.status}: ${observed.body}. Full log: ${logFiles[label]}`,
      );
    }
  }
  console.log(`[gate] ${label}: both execution route probes answered ${expected} as expected.`);
}

let exitCode = 1;
try {
  await assertOriginFree(originOn, "execution-on");
  await assertOriginFree(originOff, "execution-off");

  for (const distDir of [".next-recovery-execution-http-on", ".next-recovery-execution-http-off"]) {
    rmSync(join(repoRoot, distDir), { recursive: true, force: true });
  }

  const on = launch("on", portOn, ".next-recovery-execution-http-on", {
    HANDOVER_V2_DEV: "true",
    HANDOVER_RECOVERY_EXECUTION_ENABLED: "true",
    APP_ORIGIN: originOn,
  });
  console.log(`Waiting for execution-enabled application at ${originOn} ...`);
  await waitFor("on", () => routeReady(originOn), 420_000, on);

  const off = launch("off", portOff, ".next-recovery-execution-http-off", {
    APP_ORIGIN: originOff,
    HANDOVER_V2_DEV: "true",
    HANDOVER_RECOVERY_EXECUTION_ENABLED: "false",
  });
  console.log(`Waiting for execution-disabled application at ${originOff} ...`);
  await waitFor("off", () => routeReady(originOff), 420_000, off);

  await assertGateDirection(originOn, 401, "on");
  await assertGateDirection(originOff, 404, "off");
  console.log("[warm] execute and read-back compiled on both servers.");

  exitCode = await new Promise((settled) => {
    const pattern = process.env.RECOVERY_EXECUTION_HTTP_TEST_PATTERN;
    // `emulators:exec` swallows a child's inherited stdio on this platform, so
    // the suite's TAP stream is mirrored into a file that survives the run.
    const testLog = createWriteStream(join(repoRoot, ".demo/recovery-execution-http-tests.log"), { flags: "w" });
    const test = spawn(
      process.execPath,
      [
        "--import", "tsx",
        "--test", "--test-concurrency=1", "--test-timeout=900000",
        ...(pattern ? ["--test-name-pattern", pattern] : []),
        "tests/recovery-execution-http-emulator.test.mjs",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HANDOVER_V2_DEV: "true",
          NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
          RECOVERY_EXECUTION_HTTP_EMULATOR: "true",
          RECOVERY_EXECUTION_HTTP_ORIGIN: originOn,
          RECOVERY_EXECUTION_HTTP_ORIGIN_DISABLED: originOff,
          // The suite imports server-only modules directly for seeding.
          NODE_OPTIONS: "--conditions=react-server",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const mirror = (chunk) => {
      process.stdout.write(chunk);
      testLog.write(chunk);
    };
    test.stdout.on("data", mirror);
    test.stderr.on("data", mirror);
    children.push(test);
    test.on("exit", (code) => {
      testLog.end();
      settled(code ?? 1);
    });
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  stopAll();
  // Flush the mirrored server logs before exiting; `process.exit` would cut them.
  await Promise.all(
    Object.values(logStreams).map((stream) => new Promise((settled) => stream.end(settled))),
  );
}

process.exit(exitCode);
