/**
 * TECH-HO-RECOVERY-09M.1 — V2 handover-begin completeness preflight.
 *
 * Run via: tests/run-handover-v2-preflight-emulator.ps1
 *
 * Safety invariant: all tests use project "demo-shiftchange-handover-v2" on
 * port 8097 with synthetic accounts only. The suite refuses to run against any
 * other project or a non-emulator host.
 *
 * Contract under test: a v2 (equal-technician) handover begin is a hard
 * rejection while mandatory operational evidence is incomplete — a verified
 * broadcast observation for every enabled station and a non-conflicting
 * outside-broadcast position — using exactly the rules that block report
 * freezing. Authorization precedes the preflight, the V1 manager path is
 * untouched, and a rejected begin mutates nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest } from "next/server";

const project = "demo-shiftchange-handover-v2";
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (
  !host ||
  !["127.0.0.1:8097", "localhost:8097"].includes(host) ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run v2 preflight emulator tests outside the isolated demo emulator.");
}
if (process.env.HANDOVER_V2_DEV) {
  throw new Error("The v2 preflight suite sets its own dev flag per route test; the environment must start clean.");
}
const probe = await fetch(`http://${host}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);

const { getAdminFirestore } = await import("../src/lib/firebase/admin/index.ts");
const { beginShiftHandover } = await import("../src/lib/operations/begin-shift-handover.ts");
const { joinShift } = await import("../src/lib/operations/join-shift.ts");
const { recordShiftOperation } = await import("../src/lib/operations/shift-operations.ts");
const { AssignmentOperationError } = await import("../src/lib/operations/assignment-transaction.ts");
const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state.ts");
const {
  OperationalEvidenceIncompleteError,
  HANDOVER_OPERATIONAL_EVIDENCE_INCOMPLETE,
  missingHandoverEvidenceRequirements,
} = await import("../src/lib/operations/handover-begin-preflight.ts");

const db = getAdminFirestore();
const ref = (collection, id) => db.collection(collection).doc(id);

const historical = "2020-01-01T00:00:00.000Z";
const scheduledStart = "2030-01-01T06:00:00.000Z";
const scheduledEnd = "2030-01-01T14:00:00.000Z";
let seq = 0;
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearDb() {
  const cleared = await fetch(
    `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200);
}

const STATIONS = [
  ["joy-fm", "Joy FM"],
  ["adom-fm", "Adom FM"],
  ["asempa-fm", "Asempa FM"],
  ["hitz-fm", "Hitz FM"],
];
const missingStation = (name) => `Missing verified broadcast observation: ${name}`;
const OB_MISSING = "Outside broadcast information is missing.";
const OB_CONFLICT = "Outside broadcast information is conflicting.";
const ALL_STATIONS_MISSING = STATIONS.map(([, name]) => missingStation(name));

async function makeActiveShiftFixture() {
  const prefix = `v2p${++seq}`;
  const f = {
    manager: `${prefix}-manager`,
    outgoing: `${prefix}-outgoing`,
    outPair: `${prefix}-outpair`,
    out: [`${prefix}-outa`, `${prefix}-outb`],
    unrelated: `${prefix}-unrelated`,
    token: randomUUID(),
  };
  const batch = db.batch();
  batch.set(ref("users", f.manager), { uid: f.manager, fullName: `${prefix} Max Manager`, role: "supervisor", status: "active", statusOperation: null, mustChangePassword: false });
  for (const uid of f.out) {
    batch.set(ref("users", uid), { uid, fullName: `${prefix} ${uid}`, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  }
  batch.set(ref("users", f.unrelated), { uid: f.unrelated, fullName: `${prefix} Un`, role: "technician", status: "active", statusOperation: null, mustChangePassword: false });
  batch.set(ref("technician_pairs", f.outPair), {
    id: f.outPair, technicianIds: f.out, status: "active", createdBy: f.manager,
    createdAt: historical, updatedAt: historical, deactivatedAt: null, deactivatedBy: null,
  });
  for (const uid of f.out) {
    batch.set(ref("technician_pair_memberships", uid), { technicianUid: uid, pairId: f.outPair, createdAt: historical, updatedAt: historical });
  }
  batch.set(ref("shifts", f.outgoing), {
    id: f.outgoing, status: "active", permanentPairId: f.outPair, primaryTechnicianIds: f.out,
    operationalSlotToken: f.token, shiftType: "morning", scheduledStart, scheduledEnd,
    actualStart: historical, actualEnd: null, createdBy: f.manager, createdAt: historical, updatedAt: historical,
  });
  let control = consumeOperationalShiftSlot(createPendingOperationalShiftControl(f.token, 1, historical), f.outgoing, historical);
  control = transitionOperationalShiftControl(control, f.outgoing, "scheduled", "active", historical);
  batch.set(ref("operational_shift_control", "global"), control);
  for (const uid of f.out) {
    const memberId = `${f.outgoing}_${uid}`;
    batch.set(ref("shift_members", memberId), {
      id: memberId, shiftId: f.outgoing, technicianId: uid, role: "primary", joinedAt: historical, leftAt: null,
    });
    batch.set(ref("technician_schedules", uid), {
      technicianUid: uid,
      entries: [{ shiftId: f.outgoing, scheduledStart, scheduledEnd, status: "active" }],
      updatedAt: historical,
    });
  }
  await batch.commit();
  return f;
}

async function joinOutgoing(f, uid) {
  return joinShift({ shiftId: f.outgoing, actorUid: uid });
}

/*
 * Evidence seeding. `direct: true` writes production-shaped event and head
 * documents (the established fixture pattern), keeping fixtures free of
 * operational-writer session and audit noise. Tests that must exercise the
 * real record workflow call recordShiftOperation instead.
 */
function buildEvidenceEvents(f, { stations = STATIONS.map(([id]) => id), status = "on_air", outside = "report" } = {}) {
  const at = (hour) => `2020-01-01T0${hour}:00:00.000Z`;
  const author = { authorUid: f.out[0], authorName: "Ada Out-A", originalReporterUid: f.out[0], originalReporterName: "Ada Out-A", provenance: "authenticated_technician" };
  const common = (kind, index) => ({
    id: `${f.outgoing}-pf-${kind}-${index}`, recordId: `${f.outgoing}-pf-${kind}-${index}`,
    shiftId: f.outgoing, revision: 1, ...author, createdAt: at(1),
  });
  const events = stations.map((stationId, index) => {
    const stationName = STATIONS.find(([id]) => id === stationId)[1];
    return { ...common("broadcast", index), kind: "broadcast", occurredAt: at(1 + index), stationId, stationName, status, remarks: "" };
  });
  if (outside === "report" || outside === "both") {
    events.push({ ...common("ob", 0), kind: "outside_broadcast", occurredAt: at(5),
      title: "Outside van feed", location: "Accra mall", runningStatus: "ended",
      technicalIssues: "None", actionTaken: "Monitored handoff.", status: "resolved", remarks: "", linkedTaskId: null });
  }
  if (outside === "declaration" || outside === "both") {
    events.push({ ...common("noob", 0), kind: "no_ob", occurredAt: at(6), remarks: "No outside broadcast took place." });
  }
  return events;
}

async function seedEvidence(f, options = {}) {
  const events = buildEvidenceEvents(f, options);
  const batch = db.batch();
  for (const event of events) {
    batch.set(ref("shift_operation_events", event.id), event);
    batch.set(ref("shift_operation_heads", event.recordId), event);
  }
  await batch.commit();
  return events;
}

async function collectionState(name) {
  const snap = await db.collection(name).get();
  return snap.docs
    .map((doc) => [doc.id, JSON.parse(JSON.stringify(doc.data() ?? null))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function stateSnapshot() {
  return {
    shifts: await collectionState("shifts"),
    control: await collectionState("operational_shift_control"),
    schedules: await collectionState("technician_schedules"),
    members: await collectionState("shift_members"),
    attendance: await collectionState("shift_attendance"),
    audits: await collectionState("audit_logs"),
    equalHandoversV2: await collectionState("equal_handovers_v2"),
    guards: await collectionState("handover_reservation_guards"),
    events: await collectionState("shift_operation_events"),
    heads: await collectionState("shift_operation_heads"),
  };
}

async function beginAudits() {
  const snap = await db.collection("audit_logs").where("action", "==", "SHIFT_HANDOVER_STARTED").get();
  return snap.docs;
}

const asPreflight = (expectedMissing) => (error) => {
  assert.ok(error instanceof OperationalEvidenceIncompleteError, `${error.constructor.name}: ${error.message}`);
  assert.equal(error.status, 409);
  assert.equal(error.code, HANDOVER_OPERATIONAL_EVIDENCE_INCOMPLETE);
  if (expectedMissing) assert.deepEqual([...error.missingRequirements], expectedMissing);
  return true;
};

// ---------------------------------------------------------------------------
// Domain: the mandatory set equals the report-freeze evidence rules, and
// display warnings never become begin requirements.
// ---------------------------------------------------------------------------

const stationList = STATIONS.map(([id, name]) => ({ id, name }));
const domainEvent = (shiftId, id, extra) => ({
  id, recordId: id, shiftId, revision: 1,
  authorUid: "tech-a", authorName: "Ada A", originalReporterUid: "tech-a", originalReporterName: "Ada A",
  createdAt: "2020-01-01T01:00:00.000Z", occurredAt: "2020-01-01T01:00:00.000Z",
  provenance: "authenticated_technician", ...extra,
});

test("A0. Domain: empty history lists every station plus the outside-broadcast requirement", () => {
  assert.deepEqual(missingHandoverEvidenceRequirements("s1", stationList, []), [...ALL_STATIONS_MISSING, OB_MISSING]);
});

test("A1. Domain: not_verified never verifies a station; off_air and degraded are observations", () => {
  const missing = missingHandoverEvidenceRequirements("s1", stationList, [
    domainEvent("s1", "r1", { kind: "broadcast", stationId: "joy-fm", stationName: "Joy FM", status: "not_verified", remarks: "" }),
    domainEvent("s1", "r2", { kind: "broadcast", stationId: "adom-fm", stationName: "Adom FM", status: "off_air", remarks: "" }),
    domainEvent("s1", "r3", { kind: "broadcast", stationId: "asempa-fm", stationName: "Asempa FM", status: "degraded", remarks: "" }),
    domainEvent("s1", "r4", { kind: "no_ob", remarks: "None." }),
  ]);
  assert.deepEqual(missing, [missingStation("Joy FM"), missingStation("Hitz FM")]);
});

test("A2. Domain: recorded, declared-none, missing and conflicting outside-broadcast positions follow the freeze semantics", () => {
  const ob = domainEvent("s1", "ob", { kind: "outside_broadcast", occurredAt: "2020-01-01T02:00:00.000Z",
    title: "Van", location: "Mall", runningStatus: "ended", technicalIssues: "None", actionTaken: "None", status: "resolved", remarks: "", linkedTaskId: null });
  const none = domainEvent("s1", "noob", { kind: "no_ob", occurredAt: "2020-01-01T03:00:00.000Z", remarks: "None." });
  const broadcasts = STATIONS.map(([stationId, stationName], index) =>
    domainEvent("s1", `b${index}`, { kind: "broadcast", stationId, stationName, status: "on_air", remarks: "" }));
  assert.deepEqual(missingHandoverEvidenceRequirements("s1", stationList, [...broadcasts]), [OB_MISSING]);
  assert.deepEqual(missingHandoverEvidenceRequirements("s1", stationList, [...broadcasts, ob]), []);
  assert.deepEqual(missingHandoverEvidenceRequirements("s1", stationList, [...broadcasts, none]), []);
  assert.deepEqual(missingHandoverEvidenceRequirements("s1", stationList, [...broadcasts, ob, none]), [OB_CONFLICT]);
});

// ---------------------------------------------------------------------------
// Emulator: begin-time enforcement, precedence and atomicity.
// ---------------------------------------------------------------------------

test("B. No evidence: hard 409 listing all five mandatory requirements; nothing mutates", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await joinOutgoing(f, f.out[0]);
  const before = await stateSnapshot();

  await assert.rejects(
    () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" }),
    asPreflight([...ALL_STATIONS_MISSING, OB_MISSING]),
  );

  assert.deepEqual(await stateSnapshot(), before, "a rejected preflight must not commit any write");
  const shift = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(shift.status, "active");
  assert.equal((await beginAudits()).length, 0);
});

test("C. Partial stations: exactly the unobserved stations are listed", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await joinOutgoing(f, f.out[0]);
  await seedEvidence(f, { stations: ["joy-fm", "adom-fm", "asempa-fm"], outside: "none" });
  const before = await stateSnapshot();

  await assert.rejects(
    () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" }),
    asPreflight([missingStation("Hitz FM"), OB_MISSING]),
  );
  assert.deepEqual(await stateSnapshot(), before);
});

test("D. A not_verified observation is no evidence; records through the real writer satisfy the preflight", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await joinOutgoing(f, f.out[0]);
  const actor = { uid: f.out[0], role: "technician" };
  const base = Date.now() - 120_000;
  const iso = (offsetSeconds) => new Date(base + offsetSeconds * 1000).toISOString();

  for (const [index, [stationId]] of STATIONS.entries()) {
    await recordShiftOperation(actor, f.outgoing, { details: {
      kind: "broadcast", occurredAt: iso(index * 10), stationId, status: "not_verified", remarks: "",
    } });
  }
  await recordShiftOperation(actor, f.outgoing, { details: {
    kind: "outside_broadcast", occurredAt: iso(50), title: "Outside van feed", location: "Accra mall",
    runningStatus: "ended", technicalIssues: "None", actionTaken: "Monitored handoff.", status: "resolved", remarks: "", linkedTaskId: null,
  } });

  await assert.rejects(
    () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" }),
    asPreflight(ALL_STATIONS_MISSING),
  );

  await recordShiftOperation(actor, f.outgoing, { details: {
    kind: "broadcast", occurredAt: iso(60), stationId: "joy-fm", status: "on_air", remarks: "",
  } });
  await assert.rejects(
    () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" }),
    asPreflight(ALL_STATIONS_MISSING.slice(1)),
  );
  assert.equal((await ref("shifts", f.outgoing).get()).data().status, "active");
  assert.equal((await beginAudits()).length, 0);

  for (const [index, [stationId]] of STATIONS.slice(1).entries()) {
    await recordShiftOperation(actor, f.outgoing, { details: {
      kind: "broadcast", occurredAt: iso(70 + index * 10), stationId, status: "on_air", remarks: "",
    } });
  }
  const result = await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  assert.equal(result.status, "handover_pending");
  assert.equal((await beginAudits()).length, 1);
});

test("E. Complete stations without any outside-broadcast position: the single OB requirement blocks", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await joinOutgoing(f, f.out[0]);
  await seedEvidence(f, { outside: "none" });
  const before = await stateSnapshot();
  await assert.rejects(
    () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" }),
    asPreflight([OB_MISSING]),
  );
  assert.deepEqual(await stateSnapshot(), before);
});

test("F. An explicit authenticated no-OB declaration is valid evidence; warnings never block", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await joinOutgoing(f, f.out[0]);
  await seedEvidence(f, { outside: "declaration" });
  const result = await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  assert.equal(result.status, "handover_pending");
  assert.equal((await ref("shifts", f.outgoing).get()).data().status, "handover_pending");
});

test("G. Conflicting outside-broadcast evidence fails closed", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await joinOutgoing(f, f.out[0]);
  await seedEvidence(f, { outside: "both" });
  await assert.rejects(
    () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" }),
    asPreflight([OB_CONFLICT]),
  );
  assert.equal((await ref("shifts", f.outgoing).get()).data().status, "active");
});

test("H. Complete evidence begins exactly once; a repeated begin never double-transitions", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await joinOutgoing(f, f.out[0]);
  await joinOutgoing(f, f.out[1]);
  await seedEvidence(f, {});

  const first = await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  assert.equal(first.status, "handover_pending");
  assert.equal((await ref("shifts", f.outgoing).get()).data().handoverStartedBy, f.out[0]);

  await assert.rejects(
    () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[1], authority: "equal-technician" }),
    (error) => error instanceof AssignmentOperationError && error.status === 409,
  );
  const shift = (await ref("shifts", f.outgoing).get()).data();
  assert.equal(shift.status, "handover_pending");
  assert.equal(shift.handoverStartedBy, f.out[0]);
  assert.equal((await beginAudits()).length, 1);
});

test("I. Authorization keeps exact precedence; the V1 manager path is unchanged by the v2 preflight", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();

  // A foreign technician is refused by the pair check, never by the preflight.
  await assert.rejects(
    () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.unrelated, authority: "equal-technician" }),
    (error) => error instanceof AssignmentOperationError && error.status === 403,
  );
  // An unjoined pair technician is refused by the join check before evidence.
  await assert.rejects(
    () => beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" }),
    (error) => error instanceof AssignmentOperationError && error.status === 403 && /join this shift/i.test(error.message),
  );
  assert.equal((await ref("shifts", f.outgoing).get()).data().status, "active");
  assert.equal((await beginAudits()).length, 0);

  // The historical v1 manager begin performs the identical transition without
  // the v2 preflight — this suite proves the v2 gate, never a new bypass.
  const managerResult = await beginShiftHandover({ shiftId: f.outgoing, actorUid: f.manager, authority: "manager" });
  assert.equal(managerResult.status, "handover_pending");
});

test("J. Evidence changing mid-flight cannot commit over: the outcome is always consistent", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await joinOutgoing(f, f.out[0]);
  const events = await seedEvidence(f, {});

  const beginPromise = beginShiftHandover({ shiftId: f.outgoing, actorUid: f.out[0], authority: "equal-technician" });
  const deletePromise = (async () => {
    await sleep(2);
    // Delete one read evidence event and one head: the begin transaction read
    // them, so Firestore must abort and rerun against the changed state.
    await ref("shift_operation_events", events[0].id).delete();
    await ref("shift_operation_heads", events[0].recordId).delete();
  })();

  let outcome;
  try {
    outcome = { ok: true, value: await beginPromise };
  } catch (error) {
    outcome = { ok: false, error };
  }
  await deletePromise;

  const shift = (await ref("shifts", f.outgoing).get()).data();
  const audits = await beginAudits();
  if (outcome.ok) {
    assert.equal(shift.status, "handover_pending");
    assert.equal(audits.length, 1);
  } else {
    assert.ok(
      outcome.error instanceof OperationalEvidenceIncompleteError || outcome.error instanceof AssignmentOperationError,
      `${outcome.error.constructor.name}: ${outcome.error.message}`,
    );
    assert.equal(shift.status, "active", "a refused begin leaves the shift active and fully editable");
    assert.equal(audits.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Route surface (real route module, session boundary stubbed only)
// ---------------------------------------------------------------------------

let routeSessionUser = null;

function jsonResponse(body, options = {}) {
  const headers = new Map(Object.entries(options.headers ?? {}));
  return {
    status: options.status ?? 200,
    body,
    headers: { get: (name) => headers.get(name) ?? null },
    json: async () => body,
  };
}

async function loadRouteModule(file) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const specifiers = [...new Set(source.match(/"@\/[^"]+"/g)?.map((literal) => literal.slice(1, -1)) ?? [])];
  const preloadedDeps = new Map();
  for (const name of specifiers) {
    if (name === "@/lib/auth/session") continue;
    const base = `../src/${name.slice(2)}`;
    const candidates = [`${base}.ts`, `${base}/index.ts`];
    const hit = candidates.find((candidate) => existsSync(new URL(candidate, import.meta.url)));
    if (!hit) throw new Error(`Unresolvable v2 route dependency: ${name}`);
    preloadedDeps.set(name, await import(new URL(hit, import.meta.url).href));
  }
  const moduleExports = {};
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: moduleExports,
      process,
      console: { error(...args) { void args; } },
      require(name) {
        if (name === "server-only") return {};
        if (name === "next/server") return { NextRequest, NextResponse: { json: jsonResponse } };
        if (name === "@/lib/auth/session") return { getCurrentUser: async () => routeSessionUser };
        if (preloadedDeps.has(name)) return preloadedDeps.get(name);
        throw new Error(`Unexpected v2 route dependency: ${name}`);
      },
    },
  );
  return moduleExports;
}

const beginRoute = await loadRouteModule(
  "../src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/begin/route.ts",
);

test("K. Route contract: 409 JSON carries code + missingRequirements with no-store and zero mutation; it succeeds once evidence exists", async () => {
  await clearDb();
  const f = await makeActiveShiftFixture();
  await joinOutgoing(f, f.out[0]);
  process.env.HANDOVER_V2_DEV = "true";
  routeSessionUser = { uid: f.out[0], role: "technician", mustChangePassword: false };
  const url = `http://localhost:3000/api/operations/shifts/${f.outgoing}/handover/v2/begin`;
  try {
    const before = await stateSnapshot();
    const rejected = await beginRoute.POST(
      new NextRequest(url, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }),
      { params: Promise.resolve({ shiftId: f.outgoing }) },
    );
    assert.equal(rejected.status, 409);
    assert.equal(rejected.headers.get("Cache-Control"), "no-store");
    const body = await rejected.json();
    assert.equal(body.success, false);
    assert.equal(body.code, HANDOVER_OPERATIONAL_EVIDENCE_INCOMPLETE);
    assert.deepEqual(body.missingRequirements, [...ALL_STATIONS_MISSING, OB_MISSING]);
    assert.ok(typeof body.error === "string" && body.error.length > 0);
    assert.deepEqual(await stateSnapshot(), before, "the route rejection is a pure refusal: the existing contract and zero side effects hold together");

    await seedEvidence(f, {});
    const accepted = await beginRoute.POST(
      new NextRequest(url, { method: "POST", headers: { origin: "http://localhost:3000" }, body: "{}" }),
      { params: Promise.resolve({ shiftId: f.outgoing }) },
    );
    assert.equal(accepted.status, 200);
    const okBody = await accepted.json();
    assert.equal(okBody.success, true);
    assert.equal((await ref("shifts", f.outgoing).get()).data().status, "handover_pending");
  } finally {
    routeSessionUser = null;
    delete process.env.HANDOVER_V2_DEV;
  }
});
