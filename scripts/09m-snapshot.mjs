#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT, SHIFT, inspectSnapshot, verifySnapshot, selectSnapshot, saveSnapshot } from "./snapshots/09m-snapshots.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2), options = {};
const switches = new Set(["allow-legacy", "allow-checkpoint-mismatch", "json"]);
const named = new Set(["directory", "snapshot-root", "checkpoint", "shift", "project", "recovery-reason"]);
for (let i = 0; i < args.length; i++) {
  assert.ok(args[i].startsWith("--"), "Use named snapshot options");
  const key = args[i].slice(2);
  assert.ok(!Object.hasOwn(options, key), `Repeated option: ${key}`);
  if (switches.has(key)) options[key] = true;
  else { assert.ok(named.has(key) && args[i + 1] && !args[i + 1].startsWith("--"), `Invalid option: ${key}`); options[key] = args[++i]; }
}
const snapshotRoot = path.resolve(options["snapshot-root"] ?? path.join(repo, ".demo/uat-09m-emulator-snapshots"));
const shiftId = options.shift ?? SHIFT;
assert.equal(options.project ?? PROJECT, PROJECT, "Only the 09M project is supported");

try {
  let result;
  if (command === "inspect" || command === "verify") {
    assert.ok(options.directory, "--directory is required");
    result = command === "inspect"
      ? await inspectSnapshot(path.resolve(options.directory), { shiftId })
      : await verifySnapshot(path.resolve(options.directory), { shiftId });
  } else if (command === "select") {
    result = await selectSnapshot(snapshotRoot, {
      checkpoint: options.checkpoint, shiftId,
      allowLegacy: options["allow-legacy"] === true,
      allowCheckpointMismatch: options["allow-checkpoint-mismatch"] === true,
      recoveryReason: options["recovery-reason"] ?? "",
    });
  } else if (command === "save") {
    assert.equal(snapshotRoot, path.resolve(repo, ".demo/uat-09m-emulator-snapshots"), "Live saves must use the protected 09M snapshot root");
    // No service calls for inspect/verify/select. Save is an explicit operation;
    // neither startup nor the regression tests call this live export endpoint.
    for (const key of ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) assert.equal(process.env[key], PROJECT, `Wrong 09M environment: ${key}`);
    assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9399");
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8380");
    const hub = "http://127.0.0.1:4405";
    const response = await fetch(hub + "/emulators", { signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, "09M hub unavailable");
    const running = await response.json();
    assert.equal(String(running.auth?.port), "9399", "Wrong Auth emulator hub tuple");
    assert.equal(String(running.firestore?.port), "8380", "Wrong Firestore emulator hub tuple");
    assert.ok(["127.0.0.1", "localhost"].includes(running.auth?.host) && ["127.0.0.1", "localhost"].includes(running.firestore?.host), "Emulator hosts must be loopback");
    result = await saveSnapshot({ snapshotRoot, checkpoint: options.checkpoint, shiftId, exportTo: async directory => {
      const exported = await fetch(hub + "/_admin/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: directory.replaceAll("\\", "/"), initiatedBy: "09m-r1-explicit-save", targets: ["auth", "firestore"] }),
        signal: AbortSignal.timeout(300000),
      });
      assert.ok(exported.ok, `Hub export failed (HTTP ${exported.status}); previous pointer retained`);
      await exported.text();
    } });
    // The persisted manifest contains no passwords, email addresses or tokens.
    result = { directory: result.directory, pointer: result.pointer };
  } else throw new Error("Expected inspect, verify, select, or save");
  console.log(JSON.stringify(result, null, options.json ? 0 : 2));
  if (command === "verify" && result.manifestStatus !== "verified") {
    console.error("Legacy export inspected, but immutable manifest verification is unavailable. No files were changed.");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`09M snapshot operation refused: ${error.message}`);
  process.exitCode = 1;
}
