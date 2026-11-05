/**
 * 09M-R3B.2 Phase 5 — harness for the isolated HTTP integration suite.
 *
 * Runs INSIDE `firebase emulators:exec` (started by
 * tests/run-atomic-acceptance-http.ps1), so it sees only the disposable
 * Firestore/Auth emulators of project "demo-atomic-acceptance-r5". It starts two
 * real Next.js dev servers over the same source tree:
 *
 *   - http://127.0.0.1:3210  HANDOVER_V2_ATOMIC_ACCEPTANCE=true   (gates on)
 *   - http://127.0.0.1:3211  HANDOVER_V2_ATOMIC_ACCEPTANCE unset (gates off)
 *
 * then executes tests/atomic-acceptance-http-emulator.test.mjs and always tears
 * the two process trees down. Each server owns a distinct NEXT_DIST_DIR so the
 * two builds never overwrite each other and neither touches the normal ".next".
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = "demo-atomic-acceptance-r5";
const portOn = 3210;
const portOff = 3211;
const originOn = `http://127.0.0.1:${portOn}`;
const originOff = `http://127.0.0.1:${portOff}`;

for (const key of ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
  assert.equal(process.env[key], project, `${key} must be the disposable HTTP project.`);
}
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8183");
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9083");
assert.equal(process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS, "true");

const nextBin = join(repoRoot, "node_modules", "next", "dist", "bin", "next");
assert.ok(existsSync(nextBin), "The local Next.js CLI is required.");

const ATOMIC_GATE = "HANDOVER_V2_ATOMIC_ACCEPTANCE";
const logs = { on: [], off: [] };
const logFiles = { on: ".demo/atomic-http-on.log", off: ".demo/atomic-http-off.log" };
const logStreams = {};
const children = [];
for (const label of ["on", "off"]) {
  logStreams[label] = createWriteStream(join(repoRoot, logFiles[label]), { flags: "w" });
}

function launch(label, port, distDir, extraEnv) {
  const env = { ...process.env, ...extraEnv, NEXT_DIST_DIR: distDir };
  // react-server conditions are for CLI module execution, not the dev compiler.
  delete env.NODE_OPTIONS;
  // The gates-off server must not inherit an atomic gate from the ambient shell.
  if (extraEnv[ATOMIC_GATE] !== "true") {
    delete env[ATOMIC_GATE];
  }
  console.log(
    `[launch] ${label}: http://127.0.0.1:${port} distDir=${distDir} ` +
      `HANDOVER_V2_DEV=${env.HANDOVER_V2_DEV ?? "(unset)"} ` +
      `${ATOMIC_GATE}=${env[ATOMIC_GATE] ?? "(unset)"} ` +
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

const ACCEPT_PATH = "/api/operations/shifts/probe-shift/handover/v2/accept/atomic";
const STATUS_PATH = "/api/operations/shifts/probe-shift/handover/v2/accept/atomic/status";
const FINALIZE_PATH = "/api/operations/shifts/probe-shift/handover/v2/guard/finalize";

// Prove the gate direction before any test runs. A gate-on server must read
// the request (401 without a session); a gate-off server must answer 404.
async function assertGateDirection(origin, expected, label) {
  const observed = await probe(origin, "POST", ACCEPT_PATH, {});
  if (observed.status !== expected) {
    throw new Error(
      `[next-${label}] expected the atomic route to answer ${expected} at ${origin} but got ` +
        `${observed.status}: ${observed.body}. Full log: ${logFiles[label]}`,
    );
  }
  console.log(`[gate] ${label}: ${origin} answered ${observed.status} as expected.`);
}

// Warm every new route once so a cold webpack compile cannot consume the
// per-scenario HTTP timeout.
async function warmRoutes(origin, gateOn) {
  const expected = gateOn ? 401 : 404;
  for (const [method, path, body] of [
    ["POST", ACCEPT_PATH, {}],
    ["GET", STATUS_PATH, undefined],
    ["POST", FINALIZE_PATH, {}],
  ]) {
    const observed = await probe(origin, method, path, body);
    if (observed.status !== expected) {
      throw new Error(
        `Warm-up of ${method} ${path} at ${origin} answered ${observed.status}, expected ${expected}: ` +
          observed.body,
      );
    }
  }
}

let exitCode = 1;
try {
  await assertOriginFree(originOn, "gates-on");
  await assertOriginFree(originOff, "gates-off");

  // Fresh build directories: nothing from an interrupted run may leak in.
  for (const distDir of [".next-atomic-http-on", ".next-atomic-http-off"]) {
    rmSync(join(repoRoot, distDir), { recursive: true, force: true });
  }

  const on = launch("on", portOn, ".next-atomic-http-on", {
    HANDOVER_V2_DEV: "true",
    HANDOVER_V2_ATOMIC_ACCEPTANCE: "true",
    APP_ORIGIN: originOn,
  });
  // Compile one server at a time: two cold webpack builds of this application
  // on one machine starve each other on the first route compile.
  console.log(`Waiting for gates-on application at ${originOn} ...`);
  await waitFor("on", () => routeReady(originOn), 420_000, on);

  const off = launch("off", portOff, ".next-atomic-http-off", {
    HANDOVER_V2_DEV: "true",
    APP_ORIGIN: originOff,
  });
  console.log(`Waiting for gates-off application at ${originOff} ...`);
  await waitFor("off", () => routeReady(originOff), 420_000, off);

  await assertGateDirection(originOn, 401, "on");
  await assertGateDirection(originOff, 404, "off");
  await warmRoutes(originOn, true);
  await warmRoutes(originOff, false);
  console.log("[warm] atomic accept, status and guard-finalize routes compiled on both servers.");

  exitCode = await new Promise((settled) => {
    // A pattern is only used for focused debugging runs; the validation run
    // passes no pattern and executes all scenarios.
    const pattern = process.env.ATOMIC_HTTP_TEST_PATTERN;
    const test = spawn(
      process.execPath,
      [
        "--import", "tsx",
        "--test", "--test-concurrency=1",
        ...(pattern ? ["--test-name-pattern", pattern] : []),
        "tests/atomic-acceptance-http-emulator.test.mjs",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HANDOVER_V2_DEV: "true",
          HANDOVER_V2_ATOMIC_ACCEPTANCE: "true",
          NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
          ATOMIC_HTTP_ORIGIN: originOn,
          ATOMIC_HTTP_ORIGIN_DISABLED: originOff,
          // The suite imports server-only modules directly for the two
          // in-process clock scenarios.
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
    `\n==== gates-on application log (tail, full: ${logFiles.on}) ====\n` + tail("on"),
  );
  console.error(
    `\n==== gates-off application log (tail, full: ${logFiles.off}) ====\n` + tail("off"),
  );
}
process.exit(exitCode);
