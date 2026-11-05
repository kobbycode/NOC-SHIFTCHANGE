// TECH-HO-RECOVERY-09K — static guarantees for supervisor v2 visibility.
// These run without Firestore and pin the read-only contract that the emulator
// suite exercises dynamically: the supervisor service can only READ, no
// mutation endpoint exists, and the presentation carries no client mutations.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const SERVICE = "../src/lib/operations/supervisor-handover-v2.ts";
const serviceSource = read(SERVICE);

const MUTATION_FNS = [
  "freezeEqualHandoverReport", "prepareEqualHandoverReport", "confirmEqualHandoverParticipantV2",
  "recordEqualHandoverAbsenceV2", "clearEqualHandoverAbsenceV2", "commitEqualHandoverOutgoingV2",
  "acceptEqualHandoverIncomingV2", "finalizeEqualHandoverReservationV2", "initializeEqualHandoverReservation",
  "beginShiftHandover", "cancelEqualHandoverReservationForTechnicians",
];

test("supervisor service imports only the authoritative read, never a v2 mutation writer", () => {
  assert.match(serviceSource, /readEqualHandoverReportState/);
  assert.match(serviceSource, /import "server-only"/);
  for (const fn of MUTATION_FNS) {
    assert.equal(
      serviceSource.includes(fn),
      false,
      `supervisor service must not reference mutation writer ${fn}`,
    );
  }
});

test("supervisor service exports only list/detail read functions", () => {
  const exports = [...serviceSource.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(exports.sort(), ["getSupervisorV2HandoverDetail", "getSupervisorV2HandoverList"]);
});

test("supervisor service enforces a live supervisor profile before any read", () => {
  assert.match(serviceSource, /requireSupervisorProfile/);
  assert.match(serviceSource, /profile\.role === "supervisor"/);
});

function walk(dir, acc = []) {
  for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
    const rel = `${dir}${dir.endsWith("/") ? "" : "/"}${entry.name}`;
    if (entry.isDirectory()) walk(rel, acc);
    else acc.push(rel);
  }
  return acc;
}

test("no supervisor v2 route handler exists — the interface is server-page reads only", () => {
  const files = walk("../src/app/(dashboard)/supervisor/handovers/v2");
  assert.equal(files.length >= 1, true);
  for (const file of files) {
    const name = file.split("/").pop();
    assert.equal(name, "page.tsx", `only server page components may exist, found ${name}`);
    const source = read(file);
    assert.equal(/export (async )?function (POST|PUT|PATCH|DELETE)/.test(source), false, `${file} must not export a mutation handler`);
  }
});

test("supervisor list/detail pages gate on the v2 development flag", () => {
  for (const file of [
    "../src/app/(dashboard)/supervisor/handovers/v2/page.tsx",
    "../src/app/(dashboard)/supervisor/handovers/v2/[shiftId]/page.tsx",
  ]) {
    assert.match(read(file), /process\.env\.HANDOVER_V2_DEV !== "true"/);
  }
});

test("read-only presentation components have no client mutation affordance", () => {
  for (const file of [
    "../src/components/operations/supervisor-handover-v2-detail.tsx",
    "../src/components/operations/supervisor-handover-v2-list.tsx",
  ]) {
    const source = read(file);
    assert.equal(source.includes('"use client"'), false, `${file} must stay a server component`);
    assert.equal(/\bfetch\(/.test(source), false, `${file} must not issue fetch/mutation calls`);
    assert.equal(/<form|onSubmit|useState|onClick/.test(source), false, `${file} must not render a mutation affordance`);
  }
});

test("the shared manager workspace contract is untouched (v2Reports stays empty for managers)", () => {
  const workspace = read("../src/lib/operations/handover-workspace.ts");
  assert.match(workspace, /v2WorkspaceEnabled\(\) && !manager/);
});
