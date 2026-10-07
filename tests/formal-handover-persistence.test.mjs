import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createHash } from "node:crypto";

const serviceSource = await readFile(new URL("../src/lib/operations/formal-handover.ts", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/reservation/route.ts", import.meta.url), "utf8");
class OperationError extends Error { constructor(message, status) { super(message); this.status = status; } }
const compile = (source) => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const service = { exports: {} };
runInNewContext(compile(serviceSource), { exports: service.exports, require(name) {
  if (name === "./assignment-transaction") return { AssignmentOperationError: OperationError };
  return {};
} });
const parse = service.exports.parseFormalHandoverRequest;
const selected = () => ({ incomingPermanentPairId: "incoming-pair", shiftType: "morning",
  scheduledStart: "2030-01-01T06:00:00.000Z", scheduledEnd: "2030-01-01T14:00:00.000Z" });
const bound = () => ({ expectedRevision: 1, expectedSnapshotHash: "a".repeat(64) });
for (const op of ["initialize", "replace", "cancel"]) {
  test(`parser accepts only the ${op} contract`, () => {
    const input = op === "cancel" ? bound() : op === "replace" ? { ...selected(), ...bound() } : selected();
    assert.equal(JSON.stringify(parse(input, op)), JSON.stringify(input));
  });
  for (const value of [null, [], "request", {}, { ...selected(), password: "secret" },
    { ...selected(), actorUid: "forged" }, { ...selected(), successorSlotToken: "forged" }]) {
    test(`${op} rejects malformed or unsupported body ${JSON.stringify(value)}`, () => {
      assert.throws(() => parse(value, op), (error) => error.status === 400);
    });
  }
}
for (const [field, value] of [
  ["incomingPermanentPairId", "../pair"], ["incomingPermanentPairId", " pair"], ["incomingPermanentPairId", "."],
  ["shiftType", "evening"], ["scheduledStart", "2030-01-01T06:00:00Z"], ["scheduledStart", "invalid"],
  ["scheduledEnd", "2030-01-01T05:00:00.000Z"], ["scheduledEnd", "2030-01-03T06:00:00.000Z"],
]) test(`selection rejects ${field}=${value}`, () => assert.throws(() => parse({ ...selected(), [field]: value }, "initialize")));
for (const [field, value] of [["expectedRevision", 0], ["expectedRevision", 1.5], ["expectedRevision", "1"],
  ["expectedRevision", Number.MAX_SAFE_INTEGER + 1], ["expectedSnapshotHash", "A".repeat(64)],
  ["expectedSnapshotHash", "a".repeat(63)], ["expectedSnapshotHash", null]]) {
  test(`binding rejects ${field}=${value}`, () => assert.throws(() => parse({ ...bound(), [field]: value }, "cancel")));
}

function loadRoute(actor = { uid: "session-manager", role: "admin", mustChangePassword: false }, failure) {
  const calls = [];
  const route = { exports: {} };
  const fakeService = { parseFormalHandoverRequest: parse };
  for (const name of ["initializeFormalHandover", "replaceFormalHandoverReservation", "cancelFormalHandoverReservation"]) {
    fakeService[name] = async (input) => { calls.push({ name, input }); if (failure) throw failure; return { revision: 1 }; };
  }
  runInNewContext(compile(routeSource), { exports: route.exports, process: { env: {} }, console: { error() {} },
    require(name) {
      if (name === "server-only") return {};
      if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, status: options.status }) } };
      if (name.endsWith("/session")) return { getCurrentUser: async () => actor };
      if (name.endsWith("/formal-handover")) return fakeService;
      if (name.endsWith("/assignment-transaction")) return { AssignmentOperationError: OperationError };
      if (name.endsWith("/next-shift-authorization-domain")) return { NextShiftAuthorizationDomainError: class extends Error {} };
      if (name.endsWith("/handover-domain")) return { HandoverDomainError: class extends Error {}, createHandoverDocumentId(id) {
        if (!id || id.includes("/") || id === "." || id.trim() !== id) throw new OperationError("invalid ID", 400);
        return `handover_${id}`;
      } };
      throw new Error(`Unexpected route dependency ${name}`);
    },
  });
  return { route: route.exports, calls };
}
const context = { params: Promise.resolve({ shiftId: "path-outgoing" }) };
function request(body, origin = "https://example.test", malformed = false) {
  return { nextUrl: { origin: "https://example.test" }, headers: { get: () => origin },
    json: async () => { if (malformed) throw new Error("bad JSON"); return body; } };
}
for (const [method, name, body, status] of [
  ["POST", "initializeFormalHandover", selected(), 201],
  ["PUT", "replaceFormalHandoverReservation", { ...selected(), ...bound() }, 200],
  ["DELETE", "cancelFormalHandoverReservation", bound(), 200],
]) {
  test(`${method} calls ${name} with session authority and path identity`, async () => {
    const { route, calls } = loadRoute();
    assert.equal((await route[method](request(body), context)).status, status);
    assert.equal(calls[0].name, name);
    assert.equal(calls[0].input.actorUid, "session-manager");
    assert.equal(calls[0].input.expectedRole, "admin");
    assert.equal(calls[0].input.outgoingShiftId, "path-outgoing");
  });
  for (const [actor, code] of [[null, 401], [{ uid: "tech", role: "technician" }, 403],
    [{ uid: "manager", role: "admin", mustChangePassword: true }, 403]]) {
    test(`${method} rejects unauthorized session ${JSON.stringify(actor)}`, async () => {
      const { route, calls } = loadRoute(actor);
      assert.equal((await route[method](request(body), context)).status, code);
      assert.equal(calls.length, 0);
    });
  }
  for (const origin of [null, "https://attacker.test"]) test(`${method} rejects origin ${origin}`, async () => {
    const { route, calls } = loadRoute();
    assert.equal((await route[method](request(body, origin), context)).status, 403);
    assert.equal(calls.length, 0);
  });
  test(`${method} rejects malformed JSON`, async () => {
    const { route } = loadRoute();
    assert.equal((await route[method](request(body, undefined, true), context)).status, 400);
  });
  test(`${method} rejects forged role/password/identity fields`, async () => {
    const { route, calls } = loadRoute();
    assert.equal((await route[method](request({ ...body, role: "admin", password: "secret", actorUid: "forged" }), context)).status, 400);
    assert.equal(calls.length, 0);
  });
  test(`${method} returns authoritative transaction conflict`, async () => {
    const { route } = loadRoute(undefined, new OperationError("stale reservation", 409));
    assert.equal((await route[method](request(body), context)).status, 409);
  });
}
test("supervisor is authorized and no extra endpoint exists", async () => {
  const { route, calls } = loadRoute({ uid: "supervisor", role: "supervisor" });
  assert.equal((await route.POST(request(selected()), context)).status, 201);
  assert.equal(calls[0].input.expectedRole, "supervisor");
  assert.deepEqual(Object.keys(route).sort(), ["DELETE", "POST", "PUT", "runtime"]);
});

// Exercise the production service and real pure/schedule helpers with a small
// transactional store. Retry discards the first attempt's queued writes.
const helperSources = Object.fromEntries(await Promise.all([
  "assignment-identity", "assignment-generation-domain", "handover-domain", "handover-work-disposition-domain", "handover-work-snapshot", "operational-shift-control-state",
  "shift-overlap", "prepare-technician-schedule",
].map(async (name) => [name, await readFile(new URL(`../src/lib/operations/${name}.ts`, import.meta.url), "utf8")])));
function replacementStore(proposedId = "replacement-id", collision = false) {
  const at = "2020-01-01T00:00:00.000Z";
  const outgoingToken = "a0000000-0000-4000-8000-000000000001";
  const oldToken = "a0000000-0000-4000-8000-000000000002";
  const dependencies = {}, helpers = {};
  function load(name, source) {
    const loaded = { exports: {} };
    runInNewContext(compile(source), { exports: loaded.exports, structuredClone, TextEncoder,
      require(specifier) {
        if (specifier === "server-only") return {};
        if (specifier === "node:crypto") return { createHash, randomUUID: () => { tokenAllocations++; return proposedToken; } };
        if (specifier === "@/types/shift") return { SHIFT_STATUSES: { SCHEDULED: "scheduled", ACTIVE: "active", HANDOVER_PENDING: "handover_pending" } };
        if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
        throw new Error(`Unexpected replacement dependency ${specifier}`);
      } });
    if (name) dependencies[`./${name}`] = loaded.exports;
    return loaded.exports;
  }
  dependencies["./assignment-transaction"] = { AssignmentOperationError: OperationError,
    requireEligibleTechnician: async (transaction, uid) => { await transaction.get(db.collection("users").doc(uid)); },
    markAssignmentActivity: (transaction, uid) => transaction.update(db.collection("users").doc(uid), { activity: true }) };
  for (const [name, source] of Object.entries(helperSources)) helpers[name] = load(name, source);
  const domain = helpers["handover-domain"];
  const previous = domain.createHandover({ identity: domain.createHandoverIdentity({
    outgoingShiftId: "outgoing", outgoingPermanentPairId: "out-pair", outgoingPrimaryTechnicianIds: ["out-a", "out-b"],
    outgoingSlotToken: outgoingToken, outgoingGeneration: 1, incomingShiftId: "old-id", incomingPermanentPairId: "incoming-pair",
    incomingPrimaryTechnicianIds: ["in-a", "in-b"], successorSlotToken: oldToken, successorGeneration: 2, ...selected(),
  }), workSnapshot: helpers["handover-work-snapshot"].createHandoverWorkSnapshot({ outgoingShiftId: "outgoing", tasks: [], assignments: [] }),
  reservedAt: at, reservedBy: "manager" });
  const controlDomain = helpers["operational-shift-control-state"];
  let control = controlDomain.consumeOperationalShiftSlot(controlDomain.createPendingOperationalShiftControl(outgoingToken, 1, at), "outgoing", at);
  control = controlDomain.transitionOperationalShiftControl(control, "outgoing", "scheduled", "active", at);
  control = controlDomain.transitionOperationalShiftControl(control, "outgoing", "active", "handover_pending", at);
  const records = new Map([
    ["users/manager", { status: "active", role: "admin", mustChangePassword: false }],
    ["shifts/outgoing", { id: "outgoing", status: "handover_pending", actualStart: at, actualEnd: null,
      scheduledStart: at, scheduledEnd: "2020-01-01T08:00:00.000Z", permanentPairId: "out-pair",
      primaryTechnicianIds: ["out-a", "out-b"], operationalSlotToken: outgoingToken }],
    ["operational_shift_control/global", control], ["handovers/handover_outgoing", previous],
  ]);
  const unrelated = { shiftId: "unrelated", status: "scheduled", scheduledStart: "2030-01-03T06:00:00.000Z", scheduledEnd: "2030-01-03T14:00:00.000Z" };
  for (const [pair, ids] of [["out-pair", ["out-a", "out-b"]], ["incoming-pair", ["in-a", "in-b"]]]) {
    records.set(`technician_pairs/${pair}`, { technicianIds: ids });
    for (const uid of ids) {
      records.set(`technician_pair_memberships/${uid}`, { technicianUid: uid, pairId: pair });
      records.set(`users/${uid}`, { status: "active", role: "technician" });
      if (pair === "out-pair") records.set(`shift_members/outgoing_${uid}`, { id: `outgoing_${uid}`, shiftId: "outgoing", technicianId: uid, role: "primary", leftAt: null });
      else records.set(`technician_schedules/${uid}`, { technicianUid: uid, entries: [unrelated, {
        shiftId: "old-id", status: "scheduled", scheduledStart: selected().scheduledStart, scheduledEnd: selected().scheduledEnd }], preserved: true });
    }
  }
  if (collision) records.set(`shifts/${proposedId}`, { id: proposedId });
  let idAllocations = 0, tokenAllocations = 0;
  const proposedToken = "a0000000-0000-4000-8000-000000000003";
  const attempts = [], committedWrites = [];
  const collection = (name) => ({ doc(id) {
    if (!id) { if (name === "shifts") { idAllocations++; id = proposedId; } else id = "audit-id"; }
    return { id, path: `${name}/${id}` };
  }, where(field, op, value) { return { collection: name, field, value }; } });
  const db = { collection, async runTransaction(callback) {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      const writes = [], reads = [];
      const transaction = { async get(target) {
        assert.equal(writes.length, 0, "all transaction reads precede writes"); reads.push(target.path ?? target.collection);
        const snapshot = (path, value) => ({ id: path.split("/").at(-1), exists: value !== undefined, data: () => structuredClone(value) });
        if (target.path) return snapshot(target.path, records.get(target.path));
        return { docs: [...records].filter(([path, value]) => path.startsWith(`${target.collection}/`) && value[target.field] === target.value)
          .map(([path, value]) => snapshot(path, value)) };
      }, create: (ref, value) => writes.push(["create", ref.path, structuredClone(value)]),
      set: (ref, value) => writes.push(["set", ref.path, structuredClone(value)]),
      update: (ref, value) => writes.push(["update", ref.path, structuredClone(value)]) };
      result = await callback(transaction); attempts.push({ result, reads, writes });
      if (attempt === 0) continue;
      for (const [kind, path, value] of writes) records.set(path, kind === "update" ? { ...records.get(path), ...value } : value);
      committedWrites.push(...writes);
    }
    return result;
  } };
  dependencies["./collections"] = { GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID: "global", getOperationalCollections: () => ({ db,
    ...Object.fromEntries(Object.entries({ handovers: "handovers", handoverTaskDispositions: "handover_task_dispositions", shifts: "shifts", shiftMembers: "shift_members",
      operationalShiftControl: "operational_shift_control", technicianSchedules: "technician_schedules", technicianPairs: "technician_pairs",
      technicianPairMemberships: "technician_pair_memberships", tasks: "tasks", taskAssignments: "task_assignments" }).map(([key, value]) => [key, collection(value)])) }) };
  dependencies["firebase-admin/firestore"] = { FieldValue: { serverTimestamp: () => "server-time" } };
  dependencies["./next-shift-authorization-domain"] = { readActivePermanentPairTechnicianIds: (value) => value.technicianIds };
  const production = load(null, serviceSource);
  const input = { ...selected(), outgoingShiftId: "outgoing", actorUid: "manager", expectedRole: "admin",
    expectedRevision: previous.revision, expectedSnapshotHash: domain.createHandoverSnapshot(previous).snapshotHash };
  return { records, previous, attempts, committedWrites, unrelated, run: () => production.replaceFormalHandoverReservation(input),
    allocations: () => ({ ids: idAllocations, tokens: tokenAllocations }) };
}
test("replacement uses fresh retry-stable identities and exact old/new schedule reconciliation", async () => {
  const f = replacementStore(); const result = await f.run();
  assert.equal(f.attempts.length, 2);
  assert.deepEqual(f.allocations(), { ids: 1, tokens: 1 });
  for (const attempt of f.attempts) {
    assert.equal(attempt.result.aggregate.identity.incomingShiftId, "replacement-id");
    assert.equal(attempt.result.aggregate.identity.successorSlotToken, result.aggregate.identity.successorSlotToken);
    assert.ok(attempt.reads.includes("shifts/old-id")); assert.ok(attempt.reads.includes("shifts/replacement-id"));
  }
  assert.notEqual(result.aggregate.identity.successorSlotToken, f.previous.identity.successorSlotToken);
  assert.equal(result.aggregate.identity.successorGeneration, f.previous.identity.successorGeneration);
  assert.equal(result.handoverDocumentId, "handover_outgoing");
  assert.notEqual(result.aggregate.reservation.handoverId, f.previous.reservation.handoverId);
  for (const uid of ["in-a", "in-b"]) {
    const schedule = f.records.get(`technician_schedules/${uid}`);
    assert.equal(schedule.preserved, true);
    assert.equal(JSON.stringify(schedule.entries), JSON.stringify([f.unrelated, {
      shiftId: "replacement-id", scheduledStart: selected().scheduledStart, scheduledEnd: selected().scheduledEnd, status: "scheduled" }]));
  }
  assert.equal(f.committedWrites.some(([, path]) => /^(shifts|shift_members|shift_attendance|operational_shift_control)\//.test(path)), false);
  const audit = f.records.get("audit_logs/audit-id");
  assert.equal(audit.previousReservation.reservedIncomingShiftId, "old-id");
  assert.equal(audit.reservation.reservedIncomingShiftId, "replacement-id");
});
for (const [name, id, collision] of [["equal old/new ID", "old-id", false], ["materialized proposed ID", "replacement-id", true],
  ["materialized old reservation", "replacement-id", false]]) test(`replacement rejects ${name} without writes`, async () => {
  const f = replacementStore(id, collision);
  if (name === "materialized old reservation") f.records.set("shifts/old-id", { id: "old-id" });
  const before = JSON.stringify([...f.records]);
  await assert.rejects(f.run, (error) => error.status === 409);
  assert.equal(JSON.stringify([...f.records]), before); assert.equal(f.committedWrites.length, 0);
});
