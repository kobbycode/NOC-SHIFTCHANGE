import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Match existing pure-domain tests: transpile the TypeScript, allow only its
// built-in dependency, and execute without Next/Firebase or a browser.
const source = await readFile(new URL("../src/lib/operations/handover-domain.ts", import.meta.url), "utf8");
const loaded = { exports: {} };
runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports: loaded.exports, structuredClone, TextEncoder,
  require(specifier) {
    if (specifier === "node:crypto") return { createHash };
    throw new Error(`Unexpected pure-domain import: ${specifier}`);
  },
});
const domain = loaded.exports;
const at = "2026-10-04T06:00:00.000Z";
const later = "2026-10-04T06:01:00.000Z";
const first = "a0000000-0000-4000-8000-000000000001";
const second = "a0000000-0000-4000-8000-000000000002";
const third = "a0000000-0000-4000-8000-000000000003";
const actor = { uid: "supervisor-one", authority: "supervisor" };
const uids = ["out-a", "out-b", "in-a", "in-b"];
function identity(overrides = {}) {
  return {
    outgoingShiftId: "outgoing-shift", outgoingPermanentPairId: "outgoing-pair",
    outgoingPrimaryTechnicianIds: ["out-a", "out-b"], outgoingSlotToken: first, outgoingGeneration: 3,
    incomingShiftId: "incoming-shift", incomingPermanentPairId: "incoming-pair",
    incomingPrimaryTechnicianIds: ["in-a", "in-b"], successorSlotToken: second, successorGeneration: 4,
    shiftType: "morning", scheduledStart: at, scheduledEnd: "2026-10-04T14:00:00.000Z", ...overrides,
  };
}
function aggregate(overrides = {}) {
  return domain.createHandover({ identity: identity(), workSnapshot: { id: "outgoing-shift", version: createHash("sha256").update("work-one").digest("hex") },
    reservedAt: at, reservedBy: "manager-one", ...overrides });
}
function context(state, overrides = {}) {
  return { revision: state.revision, snapshotHash: domain.createHandoverSnapshot(state).snapshotHash,
    recordedAt: later, ...overrides };
}
function confirm(state, uid, overrides = {}) {
  return domain.confirmHandoverParticipant(state, { ...context(state), actorUid: uid, technicianUid: uid, ...overrides });
}
function absent(state, uid = "in-b", overrides = {}) {
  return domain.recordHandoverAbsence(state, { ...context(state), technicianUid: uid, actor,
    reason: "Not arrived for this shift", ...overrides });
}
function exception(state, uid = "out-b", overrides = {}) {
  return domain.recordHandoverException(state, { ...context(state), technicianUid: uid, actor,
    category: "operational_constraint", reason: "Present but unable to confirm", ...overrides });
}
function ready(state, overrides = {}) {
  return domain.assertHandoverReadyForTransfer(state, { ...context(state), ...overrides });
}
function confirmRemaining(state) {
  for (const participant of domain.resolveHandoverParticipants(state)) {
    if (participant.state === "awaiting_confirmation") state = confirm(state, participant.technicianUid);
  }
  return state;
}
function revise(state, overrides = {}) {
  return domain.reviseHandoverSnapshot(state, { ...context(state), workSnapshot: { id: "outgoing-shift", version: createHash("sha256").update("work-two").digest("hex") },
    temporaryAuthorization: state.temporaryAuthorization, ...overrides });
}

for (const id of ["Shift-ABC", "é", "e\u0301", "中文-shift"]) test(`stable document identity preserves exact ${id}`, () => {
  assert.equal(domain.createHandoverDocumentId(id), `handover_${id}`);
  assert.equal(domain.createHandoverDocumentId(id), domain.createHandoverDocumentId(id));
});
for (const id of ["", " ", " leading", "trailing ", "a/b", ".", "..", null, 12, "x".repeat(513), "界".repeat(498)]) {
  test(`stable document identity rejects malformed or overlong ${String(id).slice(0, 20)}`, () => {
    assert.throws(() => domain.createHandoverDocumentId(id));
  });
}
test("stable document identity measures prefixed UTF-8 bytes exactly", () => {
  const accepted = "界".repeat(497);
  assert.equal(new TextEncoder().encode(domain.createHandoverDocumentId(accepted)).length, 1500);
  assert.throws(() => domain.createHandoverDocumentId(accepted + "x"));
  assert.notEqual(domain.createHandoverDocumentId("é"), domain.createHandoverDocumentId("e\u0301"));
});
for (const [label, change] of [
  ["pair", { incomingPermanentPairId: "pair-other" }],
  ["incoming shift", { incomingShiftId: "shift-other" }],
  ["token", { successorSlotToken: third }],
  ["schedule", { scheduledEnd: "2026-10-04T15:00:00.000Z" }],
]) test(`stable document identity ignores changed ${label} while reservation fingerprint changes`, () => {
  const before = identity(), after = identity(change);
  assert.equal(domain.createHandoverDocumentId(before.outgoingShiftId), domain.createHandoverDocumentId(after.outgoingShiftId));
  assert.notEqual(domain.createHandoverId(before), domain.createHandoverId(after));
});
test("work revision and reservation replacement preserve stable document location", () => {
  const state = aggregate(), next = revise(state);
  const replaced = domain.replaceHandoverReservation(next, { ...context(next), actor,
    identity: identity({ successorSlotToken: third, incomingShiftId: "new-incoming" }),
    workSnapshot: next.workSnapshot, temporaryAuthorization: null }).replacement;
  assert.equal(domain.createHandoverDocumentId(state.identity.outgoingShiftId), domain.createHandoverDocumentId(replaced.identity.outgoingShiftId));
  assert.notEqual(state.reservation.handoverId, replaced.reservation.handoverId);
  assert.equal(state.reservation.handoverId, next.reservation.handoverId);
});
for (const version of [1, "1", "", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), " " + "a".repeat(64), null]) {
  test(`work version rejects invalid ${String(version).slice(0, 12)}`, () => {
    assert.throws(() => aggregate({ workSnapshot: { id: "outgoing-shift", version } }));
  });
}
test("work scope is bound at creation, persisted validation, snapshot and revision", () => {
  const state = aggregate();
  const wrong = { ...state.workSnapshot, id: "another-shift" };
  assert.throws(() => aggregate({ workSnapshot: wrong }), /scope/);
  assert.throws(() => domain.assertHandoverAggregate({ ...state, workSnapshot: wrong }), /scope/);
  assert.throws(() => domain.createHandoverSnapshot({ ...state, workSnapshot: wrong }), /scope/);
  assert.throws(() => revise(state, { workSnapshot: wrong }), /scope/);
});
for (const [from, to] of [["f", "0"], ["0", "f"]]) test(`work digest equality permits ${from} to ${to} without ordering`, () => {
  const state = confirmRemaining(aggregate({ workSnapshot: { id: "outgoing-shift", version: from.repeat(64) } }));
  const next = revise(state, { workSnapshot: { id: "outgoing-shift", version: to.repeat(64) } });
  assert.equal(next.revision, state.revision + 1);
  assert.equal(next.workSnapshot.version, to.repeat(64));
  assert.notEqual(domain.createHandoverSnapshot(state).snapshotHash, domain.createHandoverSnapshot(next).snapshotHash);
  for (const participant of domain.resolveHandoverParticipants(next)) assert.equal(participant.state, "awaiting_confirmation");
});
for (const uid of uids) test(`work digest invalidates confirmation for ${uid}`, () => {
  const state = confirmRemaining(aggregate());
  assert.ok(state.confirmations.some(c => c.technicianUid === uid));
  const next = revise(state);
  assert.ok(!next.confirmations.some(c => c.technicianUid === uid));
  assert.throws(() => confirm(next, uid, context(state)), /Stale handover revision/);
});
test("work digest revision preserves absence and exception provenance", () => {
  const state = exception(absent(aggregate()));
  const next = revise(state);
  for (const field of ["absences", "exceptions"]) {
    assert.equal(next[field][0].revision, state.revision + 1);
    assert.deepEqual({ ...next[field][0], revision: state[field][0].revision }, state[field][0]);
  }
});
const invalidIdentities = [
  ["outgoing shift ID", { outgoingShiftId: "bad/id" }],
  ["incoming reserved shift ID", { incomingShiftId: ".." }],
  ["outgoing pair ID", { outgoingPermanentPairId: "" }],
  ["incoming pair ID", { incomingPermanentPairId: "bad/id" }],
  ["outgoing duplicate", { outgoingPrimaryTechnicianIds: ["out-a", "out-a"] }],
  ["incoming duplicate", { incomingPrimaryTechnicianIds: ["in-a", "in-a"] }],
  ["cross-side duplicate", { incomingPrimaryTechnicianIds: ["out-a", "in-b"] }],
  ["outgoing token", { outgoingSlotToken: "not-uuid" }],
  ["successor token", { successorSlotToken: "not-uuid" }],
  ["reused outgoing token", { successorSlotToken: first }],
  ["case-only reused token", { successorSlotToken: first.toUpperCase() }],
  ["skipped generation", { successorGeneration: 5 }],
  ["unchanged generation", { successorGeneration: 3 }],
  ["zero generation", { outgoingGeneration: 0, successorGeneration: 1 }],
  ["unsafe generation", { outgoingGeneration: Number.MAX_SAFE_INTEGER, successorGeneration: Number.MAX_SAFE_INTEGER + 1 }],
  ["backwards schedule", { scheduledEnd: "2026-10-04T05:00:00.000Z" }],
  ["zero-length schedule", { scheduledEnd: at }],
  ["noncanonical schedule", { scheduledStart: "2026-10-04T06:00:00Z" }],
  ["invalid shift type", { shiftType: "afternoon" }],
  ["same incoming shift", { incomingShiftId: "outgoing-shift" }],
  ["one outgoing member", { outgoingPrimaryTechnicianIds: ["out-a"] }],
  ["three incoming members", { incomingPrimaryTechnicianIds: ["in-a", "in-b", "C"] }],
  ["empty UID", { incomingPrimaryTechnicianIds: ["", "in-b"] }],
  ["overlong UID", { incomingPrimaryTechnicianIds: ["x".repeat(129), "in-b"] }],
  ["sparse pair", { incomingPrimaryTechnicianIds: ["in-a", ,] }],
];
for (const [label, overrides] of invalidIdentities) test(`identity rejects ${label}`, () => {
  assert.throws(() => domain.createHandoverIdentity(identity(overrides)), domain.HandoverDomainError);
});
test("valid identity has four independent positions and a deterministic handover ID", () => {
  const state = aggregate();
  assert.equal(state.revision, 1);
  assert.equal(domain.resolveHandoverParticipants(state).length, 4);
  assert.deepEqual(structuredClone(domain.resolveHandoverParticipants(state).map(p => p.technicianUid)), uids);
  assert.equal(domain.createHandoverId(identity()), state.reservation.handoverId);
  assert.equal(domain.createHandoverId(identity()), domain.createHandoverId(identity()));
});
test("identity factory normalizes UUID spelling without mutating input", () => {
  const value = identity({ outgoingSlotToken: first.toUpperCase() });
  const original = structuredClone(value);
  assert.equal(domain.createHandoverIdentity(value).outgoingSlotToken, first);
  assert.deepEqual(value, original);
});
for (const field of ["reservedIncomingShiftId", "outgoingShiftId", "incomingPermanentPairId", "incomingPrimaryTechnicianIds",
  "shiftType", "scheduledStart", "scheduledEnd", "outgoingSlotToken", "outgoingGeneration", "successorSlotToken",
  "expectedSuccessorGeneration", "revision", "handoverId", "reservedAt", "reservedBy"]) {
  test(`reservation rejects mismatched or malformed ${field}`, () => {
    const state = aggregate();
    const reservation = { ...state.reservation, [field]: field === "revision" ? 2 : field === "reservedBy" ? "" : "invalid" };
    assert.throws(() => domain.assertHandoverReservation(reservation, state.identity, state.revision));
  });
}
test("reservation binds exact pair order", () => {
  const state = aggregate();
  state.reservation.incomingPrimaryTechnicianIds.reverse();
  assert.throws(() => domain.assertHandoverAggregate(state), /reservation/);
});
test("equivalent object insertion and evidence order produce the same snapshot", () => {
  let state = absent(aggregate(), "in-b");
  state = absent(state, "out-b");
  const other = structuredClone(state);
  other.identity = Object.fromEntries(Object.entries(other.identity).reverse());
  other.reservation = Object.fromEntries(Object.entries(other.reservation).reverse());
  other.absences.reverse();
  assert.equal(domain.createHandoverSnapshot(state).snapshotHash, domain.createHandoverSnapshot(other).snapshotHash);
});
for (const [label, overrides] of [
  ["incoming pair", { incomingPermanentPairId: "new-pair" }],
  ["outgoing pair", { outgoingPermanentPairId: "new-out-pair" }],
  ["incoming technician", { incomingPrimaryTechnicianIds: ["new-in-a", "in-b"] }],
  ["outgoing technician", { outgoingPrimaryTechnicianIds: ["new-out-a", "out-b"] }],
  ["successor token", { successorSlotToken: third }],
  ["incoming reservation shift", { incomingShiftId: "new-shift" }],
  ["schedule", { scheduledEnd: "2026-10-04T15:00:00.000Z" }],
  ["outgoing lineage", { outgoingGeneration: 4, successorGeneration: 5 }],
]) test(`new reservation with changed ${label} produces a different snapshot and no carried evidence`, () => {
  const before = confirmRemaining(aggregate());
  const after = aggregate({ identity: identity(overrides) });
  assert.notEqual(domain.createHandoverSnapshot(before).snapshotHash, domain.createHandoverSnapshot(after).snapshotHash);
  assert.equal(after.confirmations.length, 0);
  assert.throws(() => ready(after), /Incomplete/);
});
test("work change increments revision, invalidates all confirmations and leaves input untouched", () => {
  const state = confirmRemaining(aggregate());
  const original = structuredClone(state);
  const next = revise(state);
  assert.equal(next.revision, 2);
  assert.equal(next.reservation.revision, 2);
  assert.equal(next.confirmations.length, 0);
  assert.notEqual(domain.createHandoverSnapshot(state).snapshotHash, domain.createHandoverSnapshot(next).snapshotHash);
  assert.deepEqual(state, original);
  assert.throws(() => ready(next), /Incomplete/);
  assert.doesNotThrow(() => ready(confirmRemaining(next)));
});
test("unrelated update metadata preserves snapshot and confirmations", () => {
  const state = confirmRemaining(aggregate());
  const next = { ...state, updatedAt: "2026-10-04T06:02:00.000Z" };
  assert.equal(domain.createHandoverSnapshot(state).snapshotHash, domain.createHandoverSnapshot(next).snapshotHash);
  assert.deepEqual(ready(next).confirmations, state.confirmations);
});
test("equivalent work update is deterministic no-op", () => {
  const state = confirmRemaining(aggregate());
  assert.deepEqual(revise(state, { workSnapshot: state.workSnapshot }), state);
});
test("different work content can return to a previously reviewed digest", () => {
  const state = revise(aggregate());
  const next = revise(state, { workSnapshot: { id: "outgoing-shift", version: createHash("sha256").update("work-one").digest("hex") } }); assert.equal(next.revision, state.revision + 1); assert.equal(next.confirmations.length, 0);
});
for (const uid of uids) test(`${uid} self-confirms at its authoritative position without input mutation`, () => {
  const state = aggregate();
  const original = structuredClone(state);
  const next = confirm(state, uid);
  assert.deepEqual(state, original);
  assert.equal(next.confirmations[0].technicianUid, uid);
  assert.equal(next.confirmations[0].confirmedAt, later);
  assert.equal(domain.resolveHandoverParticipants(next).find(p => p.technicianUid === uid).state, "confirmed");
});
for (const [label, overrides] of [
  ["partner actor", { actorUid: "out-b" }], ["non-participant", { actorUid: "C", technicianUid: "C" }],
  ["stale revision", { revision: 0 }], ["stale snapshot", { snapshotHash: "0".repeat(64) }],
  ["invalid timestamp", { recordedAt: "invalid" }], ["noncanonical timestamp", { recordedAt: "2026-10-04T06:01:00Z" }],
  ["backdated timestamp", { recordedAt: "2026-10-04T05:59:00.000Z" }],
]) test(`confirmation rejects ${label}`, () => assert.throws(() => confirm(aggregate(), "out-a", overrides)));
test("absent participant cannot confirm", () => assert.throws(() => confirm(absent(aggregate()), "in-b"), /Conflicting/));
test("exception participant cannot confirm", () => assert.throws(() => confirm(exception(aggregate()), "out-b"), /Conflicting/));
test("duplicate confirmation preserves original evidence and unrelated confirmations", () => {
  const state = confirm(confirm(aggregate(), "out-a"), "out-b");
  assert.deepEqual(confirm(state, "out-a", { recordedAt: "2026-10-04T06:02:00.000Z" }), state);
});
test("confirming a second participant does not alter the snapshot", () => {
  const state = confirm(aggregate(), "out-a");
  const next = confirm(state, "out-b");
  assert.equal(domain.createHandoverSnapshot(next).snapshotHash, domain.createHandoverSnapshot(state).snapshotHash);
  assert.deepEqual(next.confirmations[0], state.confirmations[0]);
});
for (const uid of ["out-b", "in-b"]) test(`${uid} absence is an explicit supervisor resolution, without confirmation or attendance`, () => {
  const state = aggregate();
  const original = structuredClone(state);
  const next = absent(state, uid);
  assert.deepEqual(state, original);
  assert.equal(next.confirmations.length, 0);
  assert.equal(next.absences[0].technicianUid, uid);
  assert.equal(next.absences[0].recordedBy, actor.uid);
  assert.equal(next.absences[0].revision, 2);
  assert.equal(domain.resolveHandoverParticipants(next).find(p => p.technicianUid === uid).state, "absent");
  assert.equal("attendance" in next, false);
  assert.equal("onDuty" in next.absences[0], false);
});
test("absence invalidates affected and unrelated confirmations conservatively", () => {
  const state = confirmRemaining(aggregate());
  const next = absent(state, "in-b");
  assert.equal(next.confirmations.length, 0);
  assert.equal(state.confirmations.length, 4);
  assert.notEqual(domain.createHandoverSnapshot(next).snapshotHash, domain.createHandoverSnapshot(state).snapshotHash);
});
for (const [label, overrides] of [
  ["non-participant", { technicianUid: "C" }], ["stale revision", { revision: 0 }],
  ["stale snapshot", { snapshotHash: "0".repeat(64) }], ["missing supervisor", { actor: { uid: "", authority: "supervisor" } }],
  ["unauthorized actor", { actor: { uid: "technician", authority: "technician" } }],
  ["missing reason", { reason: undefined }], ["whitespace reason", { reason: "  " }], ["malformed timestamp", { recordedAt: "invalid" }],
]) test(`absence rejects ${label}`, () => assert.throws(() => absent(aggregate(), "in-b", overrides)));
test("duplicate absence is no-op at current revision; stale replay fails", () => {
  const state = aggregate();
  const next = absent(state);
  assert.deepEqual(absent(next), next);
  assert.throws(() => absent(next, "in-b", context(state)), /Stale handover revision/);
});
test("changed absence reason advances revision and preserves separate resolutions", () => {
  let state = absent(aggregate(), "out-b");
  state = absent(state, "in-b");
  const firstResolution = state.absences.find(a => a.technicianUid === "out-b");
  const next = absent(state, "in-b", { reason: "Verified legitimate absence" });
  assert.equal(next.revision, state.revision + 1);
  const carried = next.absences.find(a => a.technicianUid === "out-b");
  assert.equal(carried.reason, firstResolution.reason);
  assert.equal(carried.recordedRevision, firstResolution.recordedRevision);
  assert.equal(carried.revision, next.revision);
});
test("valid exception replaces prior confirmation and records independent supervisor evidence", () => {
  const state = confirmRemaining(aggregate());
  const next = exception(state);
  assert.equal(next.confirmations.length, 0);
  assert.equal(next.exceptions[0].supervisorUid, actor.uid);
  assert.equal(domain.resolveHandoverParticipants(next).find(p => p.technicianUid === "out-b").state, "supervisor_exception");
  assert.equal("attendance" in next, false);
});
for (const [label, overrides] of [
  ["missing reason", { reason: undefined }], ["whitespace reason", { reason: " \t " }],
  ["missing category", { category: undefined }], ["unknown category", { category: "silent_override" }],
  ["non-participant", { technicianUid: "C" }], ["stale revision", { revision: 0 }],
  ["missing supervisor", { actor: { uid: "", authority: "supervisor" } }],
  ["unauthorized actor", { actor: { uid: "technician", authority: "technician" } }],
  ["stale snapshot", { snapshotHash: "0".repeat(64) }], ["invalid timestamp", { recordedAt: "bad" }],
]) test(`exception rejects ${label}`, () => assert.throws(() => exception(aggregate(), "out-b", overrides)));
test("separate exceptions retain distinct reasons and original audit revisions", () => {
  let state = exception(aggregate(), "out-a", { reason: "Reason A" });
  state = exception(state, "out-b", { reason: "Reason B" });
  assert.deepEqual(state.exceptions.map(e => e.reason), ["Reason A", "Reason B"]);
  assert.deepEqual(state.exceptions.map(e => e.recordedRevision), [2, 3]);
  assert.ok(state.exceptions.every(e => e.revision === state.revision));
  assert.equal(state.confirmations.length, 0);
});
test("duplicate exception is idempotent; changed category/reason advances revision", () => {
  const state = exception(aggregate());
  assert.deepEqual(exception(state), state);
  const next = exception(state, "out-b", { category: "emergency", reason: "New reason" });
  assert.equal(next.revision, state.revision + 1);
  assert.equal(next.exceptions[0].reason, "New reason");
});
test("absence and exception cannot implicitly replace each other", () => {
  assert.throws(() => exception(absent(aggregate(), "out-b")), /Conflicting absence/);
  assert.throws(() => absent(exception(aggregate()), "out-b"), /Conflicting supervisor exception/);
});
for (const resolution of [absent, exception]) test(`removing ${resolution.name} increments revision and invalidates reviewed confirmations`, () => {
  let state = resolution(aggregate(), "out-b");
  state = confirmRemaining(state);
  const next = domain.clearHandoverResolution(state, { ...context(state), technicianUid: "out-b", actor });
  assert.equal(next.revision, state.revision + 1);
  assert.equal(next.confirmations.length, 0);
  assert.equal(next.absences.length + next.exceptions.length, 0);
  assert.throws(() => ready(next), /Incomplete/);
  assert.doesNotThrow(() => ready(confirmRemaining(next)));
});
test("clear resolution requires supervisor and current context; empty clear is no-op", () => {
  const state = aggregate();
  assert.deepEqual(domain.clearHandoverResolution(state, { ...context(state), technicianUid: "out-b", actor }), state);
  assert.throws(() => domain.clearHandoverResolution(state, { ...context(state), technicianUid: "out-b", actor: { uid: "x", authority: "technician" } }));
  assert.throws(() => domain.clearHandoverResolution(state, { ...context(state), revision: 0, technicianUid: "out-b", actor }));
});
test("four self-confirmations are ready without changing operational or attendance state", () => {
  const state = confirmRemaining(aggregate());
  assert.deepEqual(ready(state), state);
  assert.equal("control" in state, false);
  assert.equal("attendance" in state, false);
});
test("one missing required confirmation is not ready", () => {
  let state = aggregate();
  for (const uid of uids.slice(0, 3)) state = confirm(state, uid);
  assert.throws(() => ready(state), /Incomplete/);
});
for (const uid of ["out-b", "in-b"]) test(`legitimately absent ${uid} satisfies readiness without a fake signature`, () => {
  const state = confirmRemaining(absent(aggregate(), uid));
  assert.doesNotThrow(() => ready(state));
  assert.equal(state.confirmations.length, 3);
  assert.ok(!state.confirmations.some(c => c.technicianUid === uid));
});
test("one incoming acceptance with absent partner is ready", () => {
  const state = confirmRemaining(absent(aggregate(), "in-b"));
  ready(state);
  assert.deepEqual(state.confirmations.filter(c => c.position.startsWith("incoming")).map(c => c.technicianUid), ["in-a"]);
});
test("explicit supervisor exception satisfies readiness without technician acceptance", () => {
  const state = confirmRemaining(exception(aggregate()));
  ready(state);
  assert.equal(state.confirmations.length, 3);
  assert.equal(state.exceptions.length, 1);
});
for (const [label, mutate] of [
  ["duplicate confirmations", s => s.confirmations.push({ ...s.confirmations[0] })],
  ["contradictory absence", s => s.absences.push({ position: s.confirmations[0].position, technicianUid: s.confirmations[0].technicianUid,
    recordedAt: later, recordedBy: actor.uid, reason: "Absent", revision: s.revision, recordedRevision: s.revision })],
  ["stale confirmation revision", s => s.confirmations[0].revision--],
  ["stale confirmation snapshot", s => s.confirmations[0].snapshotHash = "0".repeat(64)],
  ["wrong aggregate revision", s => s.revision++],
  ["invalid reservation", s => s.reservation.reservedIncomingShiftId = "other"],
  ["wrong participant position", s => s.confirmations[0].position = "incoming_primary_a"],
  ["temporary signer", s => s.confirmations[0].technicianUid = "C"],
  ["unreviewed work change", s => s.workSnapshot.version = createHash("sha256").update("unreviewed-work").digest("hex")],
]) test(`readiness rejects ${label}`, () => {
  const state = confirmRemaining(aggregate());
  mutate(state);
  assert.throws(() => ready(state));
});
test("readiness rejects caller's stale revision and snapshot", () => {
  const state = confirmRemaining(aggregate());
  assert.throws(() => ready(state, { revision: 0 }), /Stale handover revision/);
  assert.throws(() => ready(state, { snapshotHash: "0".repeat(64) }), /Stale handover snapshot/);
});
for (const status of ["completed", "cancelled", "superseded"]) test(`${status} lifecycle rejects all inappropriate mutations and transfer readiness`, () => {
  const state = confirmRemaining(aggregate());
  state.lifecycleStatus = status;
  assert.throws(() => confirm(state, "out-a"), /lifecycle/);
  assert.throws(() => absent(state), /lifecycle/);
  assert.throws(() => exception(state), /lifecycle/);
  assert.throws(() => revise(state), /lifecycle/);
  assert.throws(() => ready(state), /lifecycle/);
});
test("temporary C snapshot is authorization-bound and never a fifth signer", () => {
  const base = aggregate();
  const state = aggregate({ temporaryAuthorization: { authorizationId: "authorization-C", technicianUid: "C" } });
  assert.notEqual(domain.createHandoverSnapshot(base).snapshotHash, domain.createHandoverSnapshot(state).snapshotHash);
  assert.equal(domain.resolveHandoverParticipants(state).length, 4);
  assert.throws(() => confirm(state, "C"), /Unauthorized/);
  assert.doesNotThrow(() => ready(confirmRemaining(state)));
});
test("temporary authorization changes invalidate confirmations; permanent C identity is rejected", () => {
  const state = confirmRemaining(aggregate());
  const next = revise(state, { workSnapshot: state.workSnapshot, temporaryAuthorization: { authorizationId: "C-auth", technicianUid: "C" } });
  assert.equal(next.confirmations.length, 0);
  assert.equal(next.revision, 2);
  assert.throws(() => revise(state, { temporaryAuthorization: { authorizationId: "bad", technicianUid: "in-a" } }), /permanent/);
});
test("superseding ends old reservation mutations; a fresh successor creates a different aggregate", () => {
  const old = confirmRemaining(aggregate());
  const closed = domain.closeHandover(old, { ...context(old), actor, status: "superseded" });
  assert.throws(() => ready(closed), /lifecycle/);
  const next = aggregate({ identity: identity({ successorSlotToken: third }) });
  assert.notEqual(next.reservation.handoverId, old.reservation.handoverId);
  assert.equal(next.confirmations.length, 0);
  assert.equal(old.lifecycleStatus, "collecting_confirmations");
});
for (const [label, mutate] of [
  ["unsupported secret", s => s.password = "never-store"],
  ["unsupported confirmation credential", s => s.confirmations[0].idToken = "never-store"],
  ["malformed confirmation timestamp", s => s.confirmations[0].confirmedAt = "invalid"],
  ["future confirmation timestamp", s => s.confirmations[0].confirmedAt = "2026-10-05T00:00:00.000Z"],
  ["non-array confirmations", s => s.confirmations = null],
  ["unknown lifecycle", s => s.lifecycleStatus = "ready_for_transfer"],
]) test(`aggregate fails closed on ${label}`, () => {
  const state = confirmRemaining(aggregate()); mutate(state);
  assert.throws(() => domain.assertHandoverAggregate(state));
});
for (const resolution of [absent, exception]) test(`${resolution.name} records reject stale binding and forged audit revision`, () => {
  const state = resolution(aggregate(), "out-b");
  const field = resolution === absent ? "absences" : "exceptions";
  const stale = structuredClone(state); stale[field][0].revision--;
  assert.throws(() => domain.assertHandoverAggregate(stale), /revision/);
  const future = structuredClone(state); future[field][0].recordedRevision++;
  assert.throws(() => domain.assertHandoverAggregate(future), /revision/);
});
test("snapshot and resolved participants return detached copies", () => {
  const state = confirmRemaining(aggregate());
  const original = structuredClone(state);
  const snapshot = domain.createHandoverSnapshot(state);
  snapshot.identity.incomingPrimaryTechnicianIds[0] = "changed";
  const participants = domain.resolveHandoverParticipants(state);
  participants[0].confirmation.technicianUid = "changed";
  assert.deepEqual(state, original);
});


for (const [label, overrides] of [
  ["incoming pair", { incomingPermanentPairId: "replacement-pair" }],
  ["incoming technician", { incomingPrimaryTechnicianIds: ["replacement-in-a", "in-b"] }],
  ["outgoing pair", { outgoingPermanentPairId: "replacement-out-pair" }],
  ["outgoing technician", { outgoingPrimaryTechnicianIds: ["replacement-out-a", "out-b"] }],
  ["incoming shift", { incomingShiftId: "replacement-shift" }],
  ["schedule", { scheduledEnd: "2026-10-04T16:00:00.000Z" }],
]) test(`explicit ${label} replacement retires old evidence and uses a fresh successor`, () => {
  const state = confirmRemaining(absent(aggregate(), "in-b"));
  const original = structuredClone(state);
  const result = domain.replaceHandoverReservation(state, {
    ...context(state), actor, identity: identity({ ...overrides, successorSlotToken: third }),
    workSnapshot: state.workSnapshot, temporaryAuthorization: null,
  });
  assert.deepEqual(state, original);
  assert.equal(result.superseded.lifecycleStatus, "superseded");
  assert.equal(result.replacement.revision, state.revision + 1);
  assert.equal(result.replacement.confirmations.length, 0);
  assert.equal(result.replacement.absences.length, 0);
  assert.equal(result.replacement.exceptions.length, 0);
  assert.notEqual(result.replacement.reservation.handoverId, state.reservation.handoverId);
  assert.throws(() => ready(result.superseded), /lifecycle/);
  assert.throws(() => confirm(result.replacement, "out-a", context(state)), /Stale handover revision/);
  assert.doesNotThrow(() => ready(confirmRemaining(result.replacement)));
});
for (const [label, overrides] of [
  ["same successor token", {}],
  ["case-only same successor token", { successorSlotToken: second.toUpperCase() }],
  ["wrong outgoing shift", { successorSlotToken: third, outgoingShiftId: "different" }],
  ["wrong outgoing generation", { successorSlotToken: third, outgoingGeneration: 4, successorGeneration: 5 }],
]) test(`reservation replacement rejects ${label}`, () => {
  const state = aggregate();
  assert.throws(() => domain.replaceHandoverReservation(state, {
    ...context(state), actor, identity: identity(overrides), workSnapshot: state.workSnapshot, temporaryAuthorization: null,
  }));
});
test("replacement rejects stale context, unauthorized authority, and terminal lifecycle", () => {
  const state = aggregate();
  const input = { ...context(state), actor, identity: identity({ successorSlotToken: third }), workSnapshot: state.workSnapshot, temporaryAuthorization: null };
  assert.throws(() => domain.replaceHandoverReservation(state, { ...input, revision: 0 }));
  assert.throws(() => domain.replaceHandoverReservation(state, { ...input, actor: { uid: "C", authority: "technician" } }));
  const cancelled = domain.closeHandover(state, { ...context(state), actor, status: "cancelled" });
  assert.throws(() => domain.replaceHandoverReservation(cancelled, input), /lifecycle/);
});
test("all mutation results are detached from nested input identity and evidence", () => {
  const state = absent(aggregate());
  const original = structuredClone(state);
  const next = confirm(state, "out-a");
  next.identity.incomingPrimaryTechnicianIds[0] = "changed";
  next.absences[0].reason = "changed";
  assert.deepEqual(state, original);
});

test("successive replacements cannot recycle any retired successor token", () => {
  const fourth = "a0000000-0000-4000-8000-000000000004";
  let state = aggregate();
  const replace = (current, successorSlotToken) => domain.replaceHandoverReservation(current, {
    ...context(current), actor, identity: identity({ successorSlotToken }),
    workSnapshot: current.workSnapshot, temporaryAuthorization: null,
  }).replacement;
  state = replace(state, third);
  state = replace(state, fourth);
  assert.deepEqual(state.retiredSuccessorSlotTokens, [second, third]);
  assert.throws(() => replace(state, second), /fresh successor/);
  assert.throws(() => replace(state, third), /fresh successor/);
  assert.doesNotThrow(() => ready(confirmRemaining(state)));
});
test("malformed or contradictory retired reservation lineage fails closed", () => {
  const state = aggregate();
  for (const tokens of [["bad"], [second], [first], [third, third], [third], null]) {
    assert.throws(() => domain.assertHandoverAggregate({ ...state, retiredSuccessorSlotTokens: tokens }));
  }
});
