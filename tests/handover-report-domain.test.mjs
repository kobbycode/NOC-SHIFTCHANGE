import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/operations/handover-report-domain.ts", import.meta.url), "utf8");
const loaded = { exports: {} };
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: loaded.exports, structuredClone,
  require(name) { if (name === "node:crypto") return { createHash }; throw new Error(name); },
});
const { canonicalReport, digestHandoverReport, assertFrozenHandoverReport } = loaded.exports;

test("report hashes are deterministic across object key order and retain Unicode evidence", () => {
  assert.equal(digestHandoverReport({ b: ["界", 1], a: "é" }), digestHandoverReport({ a: "é", b: ["界", 1] }));
  assert.notEqual(digestHandoverReport({ a: [1, 2] }), digestHandoverReport({ a: [2, 1] }));
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, Symbol("invalid")]) assert.throws(() => canonicalReport({ value }));
});
test("frozen evidence is detached and rejects changed content, shift or binding", () => {
  const content = { schema: "handover-report-v1", staff: { shiftId: "outgoing" }, evidence: "Original fault" };
  const binding = { schema: "handover-report-v1", id: "report_00000000-0000-4000-8000-000000000001", digest: digestHandoverReport(content) };
  const frozen = { ...binding, outgoingShiftId: "outgoing", content, frozenBy: "supervisor", frozenAt: "2026-10-11T10:00:00.000Z", reason: "Reviewed", reviewedRevision: 2 };
  const result = assertFrozenHandoverReport(frozen, binding, "outgoing");
  result.content.evidence = "Changed";
  assert.equal(frozen.content.evidence, "Original fault");
  assert.throws(() => assertFrozenHandoverReport(result, binding, "outgoing"));
  assert.throws(() => assertFrozenHandoverReport(frozen, binding, "another-shift"));
  assert.throws(() => assertFrozenHandoverReport(frozen, { ...binding, digest: "0".repeat(64) }, "outgoing"));
});
