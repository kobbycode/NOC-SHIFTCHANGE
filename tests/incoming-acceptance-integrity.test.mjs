import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceFixture } from "./helpers/acceptance-integrity-fixtures.mjs";

// Characterization tests: assertions document present behavior, including defects.
const completed = { operations: 1, evidence: 1, incomingAttendance: 1, incomingMembers: 1, activationReceipts: 1, active: "active" };
const none = { operations: 0, evidence: 0, incomingAttendance: 0, incomingMembers: 0, activationReceipts: 0, active: null };
const evidenceOnly = { ...none, operations: 1, evidence: 1 };
const clone = value => JSON.parse(JSON.stringify(value));

test("first acceptance, repeated personal acceptance, second join and final guard replay are idempotent", async () => {
  const f = await acceptanceFixture();
  const first = await f.post(); assert.equal(first.status, 200); assert.equal(first.body.status, "ACTIVATED");
  assert.deepEqual(f.summary(), completed);
  const stored = clone(f.entries("attendance_evidence_v2"));
  const count = f.writes.length;
  assert.equal((await f.post()).body.status, "ALREADY_JOINED");
  assert.equal(f.writes.length, count);
  assert.deepEqual(clone(f.entries("attendance_evidence_v2")), stored);
  f.advance(2000);
  const second = await f.post("in-b"); assert.equal(second.body.status, "JOINED"); assert.equal(second.body.guardFinalized, true);
  assert.deepEqual(f.summary(), { ...completed, operations: 2, evidence: 2, incomingAttendance: 2, incomingMembers: 2 });
  const last = f.writes.length;
  assert.equal((await f.post("in-b")).body.replayed, true); assert.equal(f.writes.length, last);
  assert.deepEqual(f.authCalls, ["in-a", "in-a", "in-b", "in-b"], "every HTTP retry personally authenticates");
});
for (const phase of ["beforeContext", "afterPassword", "beforeBegin"]) test(`interruption ${phase} leaves no attendance operation or activation`, async () => {
  const f = await acceptanceFixture(); f.failOnce(phase);
  assert.notEqual((await f.post()).status, 200); assert.deepEqual(f.summary(), none);
  assert.equal((await f.post()).status, 200); assert.deepEqual(f.summary(), completed);
});
test("wrong password blocks all persistence, including on a replay of an accepted shift", async () => {
  const f = await acceptanceFixture();
  f.hooks.password = () => { throw new f.PasswordReauthenticationError("Synthetic invalid password"); };
  assert.equal((await f.post()).status, 403); assert.deepEqual(f.summary(), none);
  delete f.hooks.password; assert.equal((await f.post()).status, 200);
  const before = clone([...f.records]);
  f.hooks.password = () => { throw new f.PasswordReauthenticationError("Synthetic invalid password"); };
  assert.equal((await f.post()).status, 403); assert.deepEqual(clone([...f.records]), before);
});
for (const phase of ["afterBegin", "beforeFinalize"]) test(`interruption ${phase} leaves only a pending operation that can retry with fresh authentication`, async () => {
  const f = await acceptanceFixture(); f.failOnce(phase);
  assert.notEqual((await f.post()).status, 200);
  assert.deepEqual(f.summary(), { ...none, operations: 1 });
  assert.equal(f.entries("attendance_evidence_operations_v2")[0][1].status, "pending");
  assert.equal((await f.post()).status, 200); assert.deepEqual(f.summary(), completed);
});
test("failure before the evidence transaction commit rolls back evidence and finalization together", async () => {
  const f = await acceptanceFixture();
  f.hooks.beforeCommit = writes => { if (writes.some(w => w.path.startsWith("attendance_evidence_v2/"))) { delete f.hooks.beforeCommit; throw new Error("Injected evidence commit failure"); } };
  assert.equal((await f.post()).status, 500);
  assert.deepEqual(f.summary(), { ...none, operations: 1 });
  assert.equal(f.entries("attendance_evidence_operations_v2")[0][1].status, "pending");
  assert.equal((await f.post()).status, 200); assert.deepEqual(f.summary(), completed);
});
for (const phase of ["afterFinalize", "beforeActivate"]) test(`DEFECT: interruption ${phase} leaves finalized clock-in without an incoming shift`, async () => {
  const f = await acceptanceFixture(); f.failOnce(phase);
  assert.equal((await f.post()).status, 500); assert.deepEqual(f.summary(), evidenceOnly);
  const saved = clone(f.entries("attendance_evidence_v2"));
  const eventTime = f.entries("attendance_evidence_v2")[0][1].eventTime.toDate().toISOString();
  f.advance(30000);
  const retry = await f.post(); assert.equal(retry.status, 200);
  assert.deepEqual(clone(f.entries("attendance_evidence_v2")), saved, "finalized evidence is immutable on retry");
  assert.notEqual(f.records.get("shift_attendance/incoming_in-a").recordedAt, eventTime, "retry activation uses a later independently captured time");
  assert.deepEqual(f.authCalls, ["in-a", "in-a"]);
});
test("evidence commit acknowledgement loss is recoverable but resume alone never activates", async () => {
  const f = await acceptanceFixture();
  f.hooks.afterCommit = writes => { if (writes.some(w => w.path.startsWith("attendance_evidence_v2/"))) { delete f.hooks.afterCommit; throw new Error("Injected evidence commit acknowledgement loss"); } };
  assert.equal((await f.post()).status, 500); assert.deepEqual(f.summary(), evidenceOnly);
  const [operationId, operation] = f.entries("attendance_evidence_operations_v2")[0];
  assert.equal(operation.interruptedFinalization, true);
  await f.evidence.resumeAttendanceEvidenceOperation(operationId.split("/")[1]);
  assert.deepEqual(f.summary(), evidenceOnly);
  assert.equal(f.entries("attendance_evidence_operations_v2")[0][1].interruptedFinalization, false);
  assert.equal((await f.post()).status, 200);
});
test("acknowledgement write failure preserves evidence and is recoverable through a newly authenticated retry", async () => {
  const f = await acceptanceFixture(); f.failOnce("ackWrite");
  assert.equal((await f.post()).status, 500); assert.deepEqual(f.summary(), evidenceOnly);
  assert.equal(f.entries("attendance_evidence_operations_v2")[0][1].interruptedFinalization, true);
  assert.equal((await f.post()).status, 200); assert.deepEqual(f.summary(), completed);
});
test("activation transaction failure leaves no partial shift writes but cannot roll back previously finalized evidence", async () => {
  const f = await acceptanceFixture();
  f.hooks.beforeCommit = writes => { if (writes.some(w => w.path === "shifts/incoming")) { delete f.hooks.beforeCommit; throw new Error("Injected activation commit failure"); } };
  assert.equal((await f.post()).status, 500); assert.deepEqual(f.summary(), evidenceOnly);
  assert.equal(f.records.get("shifts/outgoing").status, "handover_pending");
  assert.equal(f.records.get("operational_shift_control/global").shiftId, "outgoing");
  assert.equal((await f.post()).status, 200); assert.deepEqual(f.summary(), completed);
});
for (const boundary of ["afterCommit", "afterActivate", "response"]) test(`successful activation followed by ${boundary} loss replays without duplicates`, async () => {
  const f = await acceptanceFixture();
  if (boundary === "afterCommit") f.hooks.afterCommit = writes => { if (writes.some(w => w.path === "shifts/incoming")) { delete f.hooks.afterCommit; throw new Error("Injected activation acknowledgement loss"); } };
  else if (boundary === "response") f.responseFailure = true;
  else f.failOnce(boundary);
  assert.equal((await f.post()).status, 500); assert.deepEqual(f.summary(), completed);
  const evidence = clone(f.entries("attendance_evidence_v2"));
  assert.equal((await f.post()).body.status, "ALREADY_JOINED");
  assert.deepEqual(f.summary(), completed); assert.deepEqual(clone(f.entries("attendance_evidence_v2")), evidence);
  assert.equal(f.authCalls.length, 2);
});
test("DEFECT: join failure leaves second technician finalized evidence without their attendance; retry converges", async () => {
  const f = await acceptanceFixture(); assert.equal((await f.post()).status, 200);
  f.advance(1000);
  f.hooks.beforeCommit = writes => { if (writes.some(w => w.path === "shift_members/incoming_in-b")) { delete f.hooks.beforeCommit; throw new Error("Injected join failure"); } };
  assert.equal((await f.post("in-b")).status, 500);
  assert.deepEqual(f.summary(), { ...completed, operations: 2, evidence: 2 });
  assert.equal(f.records.get("handover_reservation_guards/guard_outgoing").ownerLifecycleState, "active");
  f.advance(1000); assert.equal((await f.post("in-b")).status, 200);
  assert.deepEqual(f.summary(), { ...completed, operations: 2, evidence: 2, incomingAttendance: 2, incomingMembers: 2 });
});
test("simultaneous incoming HTTP requests converge to one activation and one join under optimistic retries", async () => {
  const f = await acceptanceFixture(); const binding = f.binding();
  const results = await Promise.all([f.post("in-a", binding), f.post("in-b", binding)]);
  assert.deepEqual(results.map(r => r.body.status).sort(), ["ACTIVATED", "JOINED"]);
  assert.deepEqual(f.summary(), { ...completed, operations: 2, evidence: 2, incomingAttendance: 2, incomingMembers: 2 });
  assert.ok(f.retries > 0);
});
test("simultaneous retries by the same technician produce one evidence slot and one membership", async () => {
  const f = await acceptanceFixture(), binding = f.binding();
  const results = await Promise.all([f.post("in-a", binding), f.post("in-a", binding)]);
  assert.deepEqual(results.map(r => r.body.status).sort(), ["ACTIVATED", "ALREADY_JOINED"]);
  assert.deepEqual(f.summary(), completed); assert.equal(f.authCalls.length, 2);
});
test("DEFECT: second technician authenticating earlier but joining later can retain a clock-in preceding activation", async () => {
  const f = await acceptanceFixture();
  let unblock, waiting;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const arrived = new Promise(resolve => { waiting = resolve; });
  f.hooks.beforeActivate = async args => { if (args[0].actorUid === "in-b") { waiting(); await blocked; } };
  const second = f.post("in-b"); await arrived;
  f.advance(10000); assert.equal((await f.post("in-a")).body.status, "ACTIVATED");
  unblock(); assert.equal((await second).status, 409);
  assert.deepEqual(f.summary(), { ...completed, operations: 2, evidence: 2 });
  delete f.hooks.beforeActivate;
  f.advance(1000); assert.equal((await f.post("in-b")).body.status, "JOINED");
  const entry = f.entries("attendance_evidence_v2").find(([, d]) => d.technicianUid === "in-b")[1];
  assert.ok(entry.clockIn.toDate().toISOString() < f.records.get("shifts/incoming").actualStart);
});
test("DEFECT: changed guard binding after finalized evidence causes a deterministic operation digest conflict on retry", async () => {
  const f = await acceptanceFixture();
  f.hooks.beforeActivate = () => { delete f.hooks.beforeActivate; f.records.get("handover_reservation_guards/guard_outgoing").guardRevision++; };
  assert.equal((await f.post()).status, 409); assert.deepEqual(f.summary(), evidenceOnly);
  const retry = await f.post();
  assert.equal(retry.status, 409); assert.match(retry.body.error, /different attendance operation already exists/);
  assert.deepEqual(f.summary(), evidenceOnly);
});
test("stale reviewed binding is rejected before password verification or any write", async () => {
  const f = await acceptanceFixture();
  assert.equal((await f.post("in-a", { ...f.binding(), expectedSnapshotHash: "0".repeat(64) })).status, 409);
  assert.equal(f.authCalls.length, 0); assert.deepEqual(f.summary(), none);
});
test("DEFECT: an ordinary confirmed incoming technician beyond five minutes cannot submit a late reason through this route", async () => {
  const f = await acceptanceFixture(); f.advance(6 * 60000);
  const result = await f.post(); assert.equal(result.status, 400); assert.match(result.body.error, /late reason is required/);
  assert.deepEqual(f.summary(), { ...none, operations: 1 });
  assert.equal((await f.post("in-a", f.binding(), { lateReason: "Synthetic delay" })).status, 400);
});
test("DEFECT: operational attendance existence alone short-circuits evidence, membership and attendance validation on replay", async () => {
  const f = await acceptanceFixture(); assert.equal((await f.post()).status, 200);
  f.records.set("shift_attendance/incoming_in-b", { malformed: true });
  const result = await f.post("in-b"); assert.equal(result.status, 200); assert.equal(result.body.status, "ALREADY_JOINED");
  assert.equal(f.records.has("shift_members/incoming_in-b"), false);
  assert.equal(f.entries("attendance_evidence_v2").some(([, d]) => d.technicianUid === "in-b"), false);
});
test("guard finalization failure does not fail a committed second join and can be retried", async () => {
  const f = await acceptanceFixture(); assert.equal((await f.post()).status, 200);
  f.failOnce("beforeGuardFinalize");
  const result = await f.post("in-b"); assert.equal(result.status, 200); assert.equal(result.body.guardFinalized, false);
  assert.equal(f.records.get("handover_reservation_guards/guard_outgoing").ownerLifecycleState, "active");
  assert.equal((await f.post("in-b")).body.guardFinalized, true);
});
test("lost second-acceptance response needs refreshed guard binding before an otherwise idempotent retry", async () => {
  const f = await acceptanceFixture(); assert.equal((await f.post()).status, 200);
  const reviewed = f.binding(); f.responseFailure = true;
  assert.equal((await f.post("in-b", reviewed)).status, 500);
  assert.equal(f.records.get("handover_reservation_guards/guard_outgoing").ownerLifecycleState, "completed");
  const authCount = f.authCalls.length;
  const retry = await f.post("in-b", reviewed); assert.equal(retry.status, 409);
  assert.match(retry.body.error, /guard changed/); assert.equal(f.authCalls.length, authCount);
  assert.equal((await f.post("in-b")).body.status, "ALREADY_JOINED");
});
test("profile eligibility loss after evidence finalization leaves evidence but blocks activation and retries", async () => {
  const f = await acceptanceFixture();
  f.hooks.afterFinalize = () => { delete f.hooks.afterFinalize; f.records.get("users/in-a").status = "disabled"; };
  assert.equal((await f.post()).status, 403); assert.deepEqual(f.summary(), evidenceOnly);
  assert.equal((await f.post()).status, 403); assert.deepEqual(f.summary(), evidenceOnly);
});
test("internal activation primitive can succeed without attendance-evidence finalization; HTTP order is its only coupling", async () => {
  const f = await acceptanceFixture();
  const result = await f.api.acceptEqualHandoverIncomingV2({ outgoingShiftId: "outgoing", actorUid: "in-a", serverAuthenticationTime: f.iso(), ...f.binding() });
  assert.equal(result.status, "ACTIVATED");
  assert.deepEqual(f.summary(), { ...completed, operations: 0, evidence: 0 });
  assert.equal(f.authCalls.length, 0, "server-only primitive is not an independent password boundary");
});
test("coordinator evidence time is recaptured after begin and activation receipt reuses it rather than the later application time", async () => {
  const f = await acceptanceFixture(); let passwordVerifiedAt;
  f.hooks.afterPassword = () => { passwordVerifiedAt = f.iso(); f.advance(5000); };
  f.hooks.afterBegin = () => f.advance(5000);
  f.hooks.beforeActivate = () => f.advance(10000);
  const result = await f.post(); assert.equal(result.status, 200);
  const eventAt = f.entries("attendance_evidence_v2")[0][1].eventTime.toDate().toISOString();
  assert.ok(eventAt > passwordVerifiedAt);
  assert.equal(result.body.receipt.activatedAt, eventAt);
  assert.equal(f.records.get("shift_attendance/incoming_in-a").recordedAt, eventAt);
  assert.ok(f.iso() > result.body.receipt.activatedAt);
});
test("pending operation cannot be activated by resume and cannot silently adopt a changed request binding", async () => {
  const f = await acceptanceFixture(); f.failOnce("beforeFinalize");
  assert.equal((await f.post()).status, 500);
  const id = f.entries("attendance_evidence_operations_v2")[0][1].id;
  await assert.rejects(() => f.evidence.resumeAttendanceEvidenceOperation(id), /still pending/);
  f.records.get("handover_reservation_guards/guard_outgoing").guardRevision++;
  const retry = await f.post(); assert.equal(retry.status, 409); assert.match(retry.body.error, /different attendance operation/);
  assert.deepEqual(f.summary(), { ...none, operations: 1 });
});
