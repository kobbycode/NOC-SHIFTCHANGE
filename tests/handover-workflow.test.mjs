import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/components/operations/handover-workflow.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const report = () => ({ content: { staff: { shiftId: "outgoing" }, pendingTasks: [], completeness: { blockers: [] } }, handover: { revision: 4, lifecycleStatus: "collecting_confirmations", reportBinding: { id: "report-reviewed", digest: "a".repeat(64) } }, snapshotHash: "b".repeat(64), frozen: true, participants: ["out-a", "out-b", "in-a", "in-b"].map(technicianUid => ({ technicianUid, side: technicianUid.startsWith("in-") ? "incoming" : "outgoing", position: technicianUid, state: "awaiting_confirmation" })) });
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : []; }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join(" ") : tree && typeof tree === "object" ? text(tree.props?.children) : String(tree ?? ""); }
function harness({ uid = "out-a", role = "technician", initial = report(), fetchResponse } = {}) {
  let cursor = 0; const slots = [], calls = [], loaded = { exports: {} };
  const hook = create => { const index = cursor++; if (!(index in slots)) slots[index] = create(); return index; };
  const jsx = (type, props) => ({ type, props });
  runInNewContext(compiled, { exports: loaded.exports,
    FormData: class { constructor(target) { this.target = target; } get(name) { return this.target.values[name] ?? null; } },
    fetch: async (url, options) => { calls.push({ url, options }); return fetchResponse ? fetchResponse(url, options) : { ok: true, json: async () => options?.method === "POST" ? { success: true } : { success: true, report: initial } }; },
    require(name) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "react") return { useState(value) { const index = hook(() => value); return [slots[index], next => { slots[index] = next; }]; }, useRef(value) { return slots[hook(() => ({ current: value }))]; } };
      if (name === "./handover-report-view") return { HandoverReport: "report" };
      throw new Error(name);
    },
  });
  return { calls, render() { cursor = 0; return loaded.exports.HandoverWorkflow({ initialReport: initial, uid, role }); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function submit(form, values) { let reset = false; form.props.onSubmit({ preventDefault() {}, currentTarget: { values, reset() { reset = true; } } }); return reset; }
function confirmation(tree) { return nodes(tree).find(node => node.type === "form" && text(node).includes("Confirm your reviewed report")); }

test("only an awaiting permanent participant sees password confirmation for a frozen collecting report", () => {
  assert.ok(confirmation(harness().render()));
  assert.equal(confirmation(harness({ uid: "unrelated" }).render()), undefined);
  assert.equal(confirmation(harness({ role: "supervisor" }).render()), undefined);
  for (const change of [value => { value.frozen = false; }, value => { value.handover.lifecycleStatus = "completed"; }, value => { value.participants[0].state = "confirmed"; }]) {
    const initial = report(); change(initial); assert.equal(confirmation(harness({ initial }).render()), undefined);
  }
});
test("password confirmation clears the input and submits only transient password and reviewed binding; double submit is blocked", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const initial = report(); const screen = harness({ initial, fetchResponse: async (_url, options) => { if (options?.method === "POST") await gate; return { ok: true, json: async () => options?.method === "POST" ? { success: true } : { success: true, report: initial } }; } });
  const form = confirmation(screen.render());
  assert.equal(submit(form, { password: "transient-test-password" }), true);
  submit(form, { password: "transient-test-password" });
  assert.equal(screen.calls.length, 1);
  assert.equal(screen.calls[0].url, "/api/operations/shifts/outgoing/handover/confirmation");
  assert.deepEqual(JSON.parse(screen.calls[0].options.body), { expectedRevision: 4, expectedSnapshotHash: "b".repeat(64), password: "transient-test-password" });
  release(); await settle();
  assert.equal(screen.calls.length, 2); assert.equal(screen.calls[1].options.cache, "no-store");
  assert.ok(!text(screen.render()).includes("transient-test-password"));
});
test("stale confirmation refreshes authoritative report and exposes server error", async () => {
  const next = report(); next.handover.revision = 5;
  const screen = harness({ fetchResponse: async (_url, options) => options?.method === "POST" ? { ok: false, json: async () => ({ success: false, error: "Stale report. Review revision 5." }) } : { ok: true, json: async () => ({ success: true, report: next }) } });
  submit(confirmation(screen.render()), { password: "test" }); await settle();
  assert.equal(screen.calls.length, 2);
  const rendered = screen.render(); assert.ok(text(rendered).includes("Stale report. Review revision 5.")); assert.ok(text(rendered).includes("Revision  5"));
});
test("manager transfer remains disabled until all participant positions are resolved", () => {
  const initial = report(); const screen = harness({ initial, role: "supervisor" });
  const transfer = () => nodes(screen.render()).find(node => node.type === "button" && text(node).includes("Complete secure transfer"));
  assert.equal(transfer().props.disabled, true);
  initial.participants.forEach(person => { person.state = "confirmed"; }); assert.equal(transfer().props.disabled, false);
  initial.participants.filter(person => person.side === "incoming").forEach(person => { person.state = "absent"; }); assert.equal(transfer().props.disabled, true);
  initial.participants.find(person => person.side === "incoming").state = "confirmed"; assert.equal(transfer().props.disabled, false);
  initial.content.completeness.blockers.push("Missing broadcast evidence"); assert.equal(transfer().props.disabled, true);
});
