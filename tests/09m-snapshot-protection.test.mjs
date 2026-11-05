import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MILESTONES, PROJECT, SHIFT, MANIFEST, inspectSnapshot, verifySnapshot, selectSnapshot, saveSnapshot, inspectMilestones } from "../scripts/snapshots/09m-snapshots.mjs";
import { documentsFor, writeExport, logRecords } from "./helpers/snapshot-fixtures.mjs";
import { readLogRecords } from "../scripts/snapshots/firestore-export.mjs";

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shiftchange-09m-r1-"));
  t.after(async () => {
    // Only this test's exact mkdtemp directory can be removed.
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith("shiftchange-09m-r1-"));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}
const save = (snapshotRoot, checkpoint, docs = documentsFor(checkpoint)) => saveSnapshot({ snapshotRoot, checkpoint, exportTo: directory => writeExport(directory, docs) });

for (const checkpoint of MILESTONES) test(`offline relationships verify ${checkpoint}`, async t => {
  const dir = await workspace(t), exported = path.join(dir, "export");
  await writeExport(exported, documentsFor(checkpoint));
  const inspection = await inspectSnapshot(exported);
  assert.equal(inspection.state.highestVerifiedMilestone, checkpoint, JSON.stringify(inspection.state.milestones));
});

test("save creates a verified immutable manifest before publishing LATEST", async t => {
  const dir = await workspace(t), result = await save(dir, MILESTONES[4]);
  const verified = await verifySnapshot(result.directory);
  assert.equal(verified.manifestStatus, "verified");
  assert.equal(verified.inspection.state.documents.preparation.status, "complete");
  assert.ok(verified.inspection.state.preparation.digest);
  const selected = await selectSnapshot(dir, { checkpoint: MILESTONES[4] });
  assert.equal(selected.actualCheckpoint, MILESTONES[4]);
  const original = await fs.readFile(path.join(result.directory, MANIFEST));
  await save(dir, MILESTONES[0]);
  assert.deepEqual(await fs.readFile(path.join(result.directory, MANIFEST)), original);
});

for (const [name, change, expected] of [
  ["missing reservation", docs => docs.delete(`equal_handovers_v2/handover_v2_${SHIFT}`), "missing"],
  ["incomplete reservation", docs => docs.set(`equal_handovers_v2/handover_v2_${SHIFT}`, { schema: "equal-handover-v2" }), "incomplete"],
  ["missing preparation", docs => { for (const key of docs.keys()) if (key.startsWith("handover_report_preparations_v2/")) docs.delete(key); }, "missing"],
  ["incomplete preparation", docs => { for (const [key, data] of docs) if (key.startsWith("handover_report_preparations_v2/")) data.preparationRevision = 0; }, "incomplete"],
  ["foreign preparation shift", docs => { for (const [key, data] of docs) if (key.startsWith("handover_report_preparations_v2/")) data.outgoingShiftId = "foreign"; }, "incomplete"],
  ["preparation digest mismatch", docs => { for (const [key, data] of docs) if (key.startsWith("handover_report_preparations_v2/")) data.contentDigest = "f".repeat(64); }, "incomplete"],
]) test(`${name} cannot be published as a prepared checkpoint`, async t => {
  const dir = await workspace(t); await save(dir, MILESTONES[0]);
  const previous = await fs.readFile(path.join(dir, "LATEST.json"));
  const docs = documentsFor(); change(docs);
  await assert.rejects(() => save(dir, MILESTONES[4], docs), /intended checkpoint/);
  assert.deepEqual(await fs.readFile(path.join(dir, "LATEST.json")), previous);
  const inspected = inspectMilestones({ docs, authUids: ["out-a", "out-b", "in-a", "in-b", "supervisor", "admin"] });
  assert.equal(inspected.documents[name.includes("reservation") ? "reservation" : "preparation"].status, expected);
});

test("incorrect project identity is rejected from actual export records", async t => {
  const dir = await workspace(t); await writeExport(path.join(dir, "foreign"), documentsFor(), "demo-another-project");
  await assert.rejects(() => inspectSnapshot(path.join(dir, "foreign")), /different Firebase project/);
  await assert.rejects(() => inspectSnapshot(path.join(dir, "foreign"), { projectId: "production" }), /Only the 09M/);
});

test("incorrect shift identity cannot satisfy even the base checkpoint", async t => {
  const dir = await workspace(t), target = path.join(dir, "foreign");
  await writeExport(target, documentsFor(MILESTONES[4], "another-shift"));
  const result = await inspectSnapshot(target);
  assert.equal(result.state.documents.shift.status, "missing");
  assert.equal(result.state.highestVerifiedMilestone, null);
});

for (const relative of ["firebase-export-metadata.json", "auth_export/accounts.json", "firestore_export/firestore_export.overall_export_metadata", "firestore_export/all_namespaces/all_kinds/output-0"]) test(`incomplete export: ${relative}`, async t => {
  const dir = await workspace(t), target = path.join(dir, "incomplete"); await writeExport(target);
  await fs.unlink(path.join(target, relative));
  await assert.rejects(() => inspectSnapshot(target));
});

test("corrupt document log fails CRC verification", async t => {
  const dir = await workspace(t), target = path.join(dir, "corrupt"); await writeExport(target);
  const file = path.join(target, "firestore_export/all_namespaces/all_kinds/output-0");
  const bytes = await fs.readFile(file); bytes[20] ^= 1; await fs.writeFile(file, bytes);
  await assert.rejects(() => inspectSnapshot(target), /checksum/);
});

test("manifest modification and an added export file are detected", async t => {
  const dir = await workspace(t), result = await save(dir, MILESTONES[4]);
  const file = path.join(result.directory, MANIFEST), original = await fs.readFile(file);
  const manifest = JSON.parse(original); manifest.inspection.authAccountCount++;
  await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(() => verifySnapshot(result.directory), /does not match/);
  await fs.writeFile(file, original); await fs.writeFile(path.join(result.directory, "unexpected"), "unverified");
  await assert.rejects(() => verifySnapshot(result.directory), /does not match/);
});

test("export failure preserves previous pointer and all prior snapshot files", async t => {
  const dir = await workspace(t), result = await save(dir, MILESTONES[0]);
  const previous = await fs.readFile(path.join(dir, "LATEST.json")), manifest = await fs.readFile(path.join(result.directory, MANIFEST));
  await assert.rejects(() => saveSnapshot({ snapshotRoot: dir, checkpoint: MILESTONES[4], exportTo: async target => { await fs.mkdir(target); throw new Error("simulated export interruption"); } }), /simulated export/);
  assert.deepEqual(await fs.readFile(path.join(dir, "LATEST.json")), previous);
  assert.deepEqual(await fs.readFile(path.join(result.directory, MANIFEST)), manifest);
});

test("exact checkpoint selection refuses both earlier and later checkpoints", async t => {
  const dir = await workspace(t); await save(dir, MILESTONES[4]);
  await assert.rejects(() => selectSnapshot(dir, { checkpoint: MILESTONES[5] }), /Checkpoint mismatch/);
  await assert.rejects(() => selectSnapshot(dir, { checkpoint: MILESTONES[0] }), /Checkpoint mismatch/);
  await assert.rejects(() => selectSnapshot(dir, { checkpoint: MILESTONES[5], allowCheckpointMismatch: true }), /recovery reason/);
  const result = await selectSnapshot(dir, { checkpoint: MILESTONES[5], allowCheckpointMismatch: true, recoveryReason: "Inspect earlier preparation without representing it as frozen" });
  assert.equal(result.actualCheckpoint, MILESTONES[4]); assert.equal(result.recoveryOverride, true);
});

test("legacy snapshots remain untouched and require explicit restore recovery", async t => {
  const dir = await workspace(t), target = path.join(dir, "legacy"); await writeExport(target, documentsFor(MILESTONES[2]));
  await fs.writeFile(path.join(dir, "LATEST.json"), JSON.stringify({ projectId: PROJECT, shiftId: SHIFT, snapshot: "legacy", verified: true }));
  assert.equal((await verifySnapshot(target)).manifestStatus, "legacy_missing");
  await assert.rejects(() => selectSnapshot(dir, { checkpoint: MILESTONES[2] }), /Legacy snapshot/);
  const result = await selectSnapshot(dir, { checkpoint: MILESTONES[2], allowLegacy: true, recoveryReason: "Owner approves structurally inspected historical export" });
  assert.equal(result.integrity, "unanchored");
  await assert.rejects(() => fs.access(path.join(target, MANIFEST)), { code: "ENOENT" });
});

test("pointer project, shift, path traversal, and manifest hash mismatches fail closed", async t => {
  const dir = await workspace(t), result = await save(dir, MILESTONES[0]);
  for (const override of [{ projectId: "production" }, { shiftId: "wrong" }, { snapshot: "../outside" }, { manifestSha256: "0".repeat(64) }]) {
    await fs.writeFile(path.join(dir, "LATEST.json"), JSON.stringify({ ...result.pointer, ...override }));
    await assert.rejects(() => selectSnapshot(dir, { checkpoint: MILESTONES[0], allowLegacy: true, allowCheckpointMismatch: true, recoveryReason: "Overrides cannot weaken project and integrity checks" }));
  }
});

test("concurrent saves cannot publish through a second writer", async t => {
  const dir = await workspace(t); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const first = saveSnapshot({ snapshotRoot: dir, checkpoint: MILESTONES[0], exportTo: async target => { entered(); await gate; await writeExport(target, documentsFor(MILESTONES[0])); } });
  await ready;
  await assert.rejects(() => save(dir, MILESTONES[0]), { code: "EEXIST" });
  release(); await first;
});

test("fragmented records round-trip and truncated fragments fail closed", () => {
  const payload = Buffer.alloc(90000, 99), bytes = logRecords([payload]);
  assert.deepEqual(readLogRecords(bytes), [payload]);
  assert.throws(() => readLogRecords(bytes.subarray(0, bytes.length - 1)), /Truncated/);
});

test("an existing manifest in a fresh export is never overwritten", async t => {
  const dir = await workspace(t); await save(dir, MILESTONES[0]);
  const previous = await fs.readFile(path.join(dir, "LATEST.json"));
  await assert.rejects(() => saveSnapshot({ snapshotRoot: dir, checkpoint: MILESTONES[4], exportTo: async target => {
    await writeExport(target); await fs.writeFile(path.join(target, MANIFEST), "existing manifest");
  } }), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(path.join(dir, "LATEST.json")), previous);
});

test("inconsistent guard, stale review, and changed receipts cannot advance milestones", () => {
  const authUids = ["out-a", "out-b", "in-a", "in-b", "supervisor", "admin"];
  for (const [checkpoint, mutate] of [
    [MILESTONES[3], docs => { for (const [key, value] of docs) if (key.startsWith("handover_reservation_guards/")) value.ownerHandoverDocumentId = "handover_v2_foreign"; }],
    [MILESTONES[4], docs => { for (const [key, value] of docs) if (key.startsWith("handover_report_preparations_v2/")) value.aggregateSnapshotHash = "0".repeat(64); }],
    [MILESTONES[7], docs => { docs.get("audit_logs/commit").receiptHash = "0".repeat(64); }],
    [MILESTONES[8], docs => { docs.delete("shift_members/incoming_in-a"); }],
  ]) {
    const docs = documentsFor(checkpoint); mutate(docs);
    assert.notEqual(inspectMilestones({ docs, authUids }).highestVerifiedMilestone, checkpoint);
  }
});

test("finalized personal evidence alone is not an activation checkpoint", () => {
  const docs = documentsFor(MILESTONES[8]);
  docs.delete("audit_logs/activation");
  const state = inspectMilestones({ docs, authUids: ["out-a", "out-b", "in-a", "in-b", "supervisor", "admin"] });
  assert.equal(state.milestones.incoming_acceptance_activated.status, "not_verified");
});

test("recovery cannot downgrade a managed snapshot with a deleted manifest into legacy", async t => {
  const dir = await workspace(t), result = await save(dir, MILESTONES[0]);
  await fs.unlink(path.join(result.directory, MANIFEST));
  await assert.rejects(() => selectSnapshot(dir, { checkpoint: MILESTONES[0], allowLegacy: true, recoveryReason: "An override must not hide a managed manifest deletion" }), /Managed snapshot manifest/);
});

test("unchecked manifest fields and a mismatched creation time are rejected", async t => {
  const dir = await workspace(t), result = await save(dir, MILESTONES[0]);
  const file = path.join(result.directory, MANIFEST), original = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...original, verifiedByOperator: true }));
  await assert.rejects(() => verifySnapshot(result.directory), /unchecked manifest fields/);
  await fs.writeFile(file, JSON.stringify({ ...original, createdAt: "2020-01-01T00:00:00.000Z" }));
  await assert.rejects(() => verifySnapshot(result.directory), /creation time/);
});
