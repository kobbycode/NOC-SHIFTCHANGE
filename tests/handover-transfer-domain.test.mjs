import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepared, modules } from "./formal-handover-transfer-fixtures.mjs";
const d = modules()("lib/operations/handover-transfer-domain");
const normal = value => JSON.parse(JSON.stringify(value));
const write = (id, document = {}) => ({ path: `tasks/${id}`, operation: "update", data: document, document });
for (const a of ["confirmed", "absent", "exception"]) for (const b of ["confirmed", "absent", "exception"]) test(`activation invariant ${a}/${b}`, () => {
  const f = prepared({ incomingStates: [a, b], count: 0 });
  if (a !== "confirmed" && b !== "confirmed") assert.throws(() => d.assertIncomingHandoverActivation(f.aggregate), d.HandoverTransferError);
  else assert.deepEqual(normal(d.assertIncomingHandoverActivation(f.aggregate)), f.incoming.filter((_, i) => [a, b][i] === "confirmed"));
});
test("independent canonical array SHA identities and Unicode do not collide", () => {
  const handover = "handover_界", task = "task_é";
  const expected = "transfer_" + createHash("sha256").update(JSON.stringify(["handover-task-transfer-v1", handover, task])).digest("hex");
  assert.equal(d.createHandoverTaskTransferDocumentId(handover, task), expected);
  assert.equal(d.createHandoverTaskTransferDocumentId(handover, task), expected);
  assert.notEqual(expected, d.createHandoverTaskTransferDocumentId(handover, task + "x"));
  assert.notEqual(expected, d.createHandoverTaskTransferDocumentId(handover + "x", task));
  assert.equal(d.createFormalHandoverTransferReceiptId(handover), "handover-transfer-" + createHash("sha256").update(JSON.stringify(["formal-handover-transfer-v1", handover])).digest("hex"));
});
for (const [handover, task] of [["bad", "task"], ["handover_", "task"], ["handover_out", "bad/id"], ["handover_out", ".."], ["handover_out", " "]]) test(`malformed history identities ${handover}/${task}`, () => assert.throws(() => d.createHandoverTaskTransferDocumentId(handover, task)));
for (const count of [449, 450, 451]) test(`application planned write ceiling ${count}`, () => {
  const plan = { writes: Array.from({ length: count }, (_, i) => write(i)) };
  if (count <= 450) assert.equal(d.assertFormalHandoverTransferCapacity(plan).plannedWrites, count);
  else assert.throws(() => d.assertFormalHandoverTransferCapacity(plan), error => error instanceof d.HandoverTransferError && error.code === "TRANSFER_CAPACITY_EXCEEDED");
});
for (const [path, ceiling] of [["handover_task_transfers/x", 786432], ["tasks/x", 6291456]]) for (const delta of [-1, 0, 1]) test(`exact estimated capacity ${ceiling} + ${delta}`, () => {
  const overhead = d.estimateTransferDocumentBytes(path, { text: "" });
  const document = { text: "x".repeat(ceiling - overhead + delta) };
  assert.equal(d.estimateTransferDocumentBytes(path, document), ceiling + delta);
  const plan = { writes: [{ ...write("x", document), path }] };
  if (delta <= 0) d.assertFormalHandoverTransferCapacity(plan);
  else assert.throws(() => d.assertFormalHandoverTransferCapacity(plan), error => error.code === "TRANSFER_CAPACITY_EXCEEDED");
});
test("consolidation rejects duplicate paths", () => assert.throws(() => d.assertFormalHandoverTransferCapacity({ writes: [write(1), write(1)] }), d.HandoverTransferError));
test("UTF8 estimator includes multibyte field names, strings, framing and nested maps", () => {
  assert.equal(d.estimateTransferDocumentBytes("tasks/x", { name: "界🌍" }) - d.estimateTransferDocumentBytes("tasks/x", { name: "abc" }), 4);
  assert.equal(d.estimateTransferDocumentBytes("tasks/x", { 界: "" }) - d.estimateTransferDocumentBytes("tasks/x", { x: "" }), 2);
  const value = { long: { items: ["", false, null, 12, { nested: "界" }] }, time: new Date(0) };
  assert.ok(d.estimateTransferDocumentBytes("tasks/x", value) > Buffer.byteLength(JSON.stringify(value)));
});
for (const [label, value] of [["undefined", undefined], ["NaN", NaN], ["infinity", Infinity], ["bigint", 1n], ["function", () => {}], ["symbol", Symbol("x")], ["map", new Map()], ["regex", /x/], ["undefined field", { value: undefined }], ["nested array", [["nested"]]], ["invalid date", new Date(NaN)]]) test(`unsupported evidence ${label}`, () => assert.throws(() => d.estimateTransferDocumentBytes("tasks/x", value), d.HandoverTransferError));
test("cyclic evidence fails closed", () => { const value = {}; value.self = value; assert.throws(() => d.estimateTransferDocumentBytes("tasks/x", value)); });
test("supported Timestamp and serverTimestamp representations are conservatively estimated", () => {
  class Timestamp { seconds = 1; nanoseconds = 20; }
  class ServerTimestampTransform {}
  assert.ok(d.estimateTransferDocumentBytes("tasks/x", new Timestamp()) >= 24);
  assert.ok(d.estimateTransferDocumentBytes("tasks/x", new ServerTimestampTransform()) >= 24);
});
