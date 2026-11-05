/**
 * Phase 8C.3 — §7/§8 real-HTTP verification of the read-only recovery
 * eligibility endpoint.
 *
 * Runs INSIDE tests/run-recovery-eligibility-http.mjs (which runs inside
 * `firebase emulators:exec`), so it talks to two real Next.js servers over the
 * disposable Firestore/Auth emulators of project "demo-admin-review-8b":
 *
 *   - RECOVERY_ELIGIBILITY_HTTP_ORIGIN           HANDOVER_V2_DEV=true
 *   - RECOVERY_ELIGIBILITY_HTTP_ORIGIN_DISABLED  HANDOVER_V2_DEV=false
 *
 * The seeded world is a real committed v2 handover produced by the production
 * prepare/freeze/confirm/commit services against the emulator. The suite proves
 * over authenticated HTTP that:
 *   - identity comes from the session, never from the request;
 *   - live role, account status, claim and password-change checks hold;
 *   - malformed identifiers are refused and unknown ones classify safely;
 *   - the eligible world returns a deterministic, viewer-independent digest;
 *   - a safety-relevant evidence change changes the digest;
 *   - no read writes any operational document;
 *   - the response is never executable and never cached.
 *
 * The endpoint is GET-only. No recovery, cancellation, guard, slot, roster,
 * attendance or acceptance write exists in this suite.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const ORIGIN = process.env.RECOVERY_ELIGIBILITY_HTTP_ORIGIN;
const ORIGIN_DISABLED = process.env.RECOVERY_ELIGIBILITY_HTTP_ORIGIN_DISABLED;
const project = "demo-admin-review-8b";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (
  !ORIGIN ||
  !ORIGIN_DISABLED ||
  firestoreHost !== "127.0.0.1:8982" ||
  authHost !== "127.0.0.1:10101" ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  ) ||
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS !== "true" ||
  process.env.HANDOVER_V2_DEV !== "true"
) {
  throw new Error("Refusing to run recovery eligibility HTTP tests outside the isolated HTTP emulator stack.");
}

const emulatorProbe = await fetch(`http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(emulatorProbe.status), `Emulator probe failed: ${emulatorProbe.status}`);
const authProbe = await fetch(`http://${authHost}/`, { signal: AbortSignal.timeout(60_000) });
assert.ok(authProbe.status < 500, `Auth emulator probe failed: ${authProbe.status}`);

const { getAdminFirestore, getAdminAuth } = await import("../src/lib/firebase/admin/index.ts");
const handoverDomain = await import("../src/lib/operations/handover-domain.ts");
const workSnapshotDomain = await import("../src/lib/operations/handover-work-snapshot.ts");
const dispositionDomain = await import("../src/lib/operations/handover-work-disposition-domain.ts");
const controlStateDomain = await import("../src/lib/operations/operational-shift-control-state.ts");
const equalDomain = await import("../src/lib/operations/equal-technician-handover-domain.ts");
const guardDomain = await import("../src/lib/operations/handover-reservation-guard-domain.ts");
const shiftJoinDomain = await import("../src/lib/operations/shift-join-domain.ts");
const reportFirestore = await import("../src/lib/operations/equal-handover-report-firestore.ts");
const { DEFAULT_BROADCAST_STATIONS } = await import("../src/types/shift-operations.ts");
const { fixtureRecords } = await import("./formal-handover-transfer-fixtures.mjs");
const {
  HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS,
  HANDOVER_RECOVERY_ELIGIBILITY_DETAILS,
} = await import("../src/types/handover-recovery-eligibility.ts");

const CLASSIFICATION = HANDOVER_RECOVERY_ELIGIBILITY_CLASSIFICATIONS;
const DETAIL = HANDOVER_RECOVERY_ELIGIBILITY_DETAILS;

const db = getAdminFirestore();
const auth = getAdminAuth();

const OUT_ID = "outgoing";
const IN_ID = "incoming";
const HANDOVER_DOCUMENT_ID = equalDomain.createEqualHandoverDocumentId(OUT_ID);

const USERS = {
  "sup-1": { role: "supervisor", password: "R8c3e-sup-1-Pass!", fullName: "Supervisor One" },
  "sup-2": { role: "supervisor", password: "R8c3e-sup-2-Pass!", fullName: "Supervisor Two" },
  "adm-1": { role: "admin", password: "R8c3e-adm-1-Pass!", fullName: "Admin One" },
  "adm-off": { role: "admin", password: "R8c3e-adm-off-Pass!", fullName: "Disabled Admin" },
  "tech-1": { role: "technician", password: "R8c3e-tech-1-Pass!", fullName: "Technician One" },
  "pw-admin": {
    role: "admin",
    password: "R8c3e-pw-admin-Pass!",
    fullName: "Password Admin",
    mustChangePassword: true,
  },
};

const ELIGIBILITY_PATH = (documentId) =>
  `/api/admin/recovery-eligibility?handoverDocumentId=${encodeURIComponent(documentId)}`;

// ---------------------------------------------------------------------------
// Disposable stack preparation
// ---------------------------------------------------------------------------

function emailFor(uid) {
  return `${uid}@recovery-eligibility-http.test`;
}

async function ensureAuthUsers() {
  for (const [uid, user] of Object.entries(USERS)) {
    try {
      await auth.getUser(uid);
    } catch {
      await auth.createUser({ uid, email: emailFor(uid), password: user.password, emailVerified: true });
    }
    await auth.setCustomUserClaims(uid, { role: user.role });
    await auth.updateUser(uid, { disabled: false, password: user.password });
  }
}

async function clearDatabase() {
  const cleared = await fetch(
    `http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200, "The isolated emulator database could not be cleared.");
}

async function seedAccounts() {
  const batch = db.batch();
  for (const [uid, user] of Object.entries(USERS)) {
    batch.set(db.doc(`users/${uid}`), {
      uid,
      fullName: user.fullName,
      email: emailFor(uid),
      role: user.role,
      status: "active",
      statusOperation: null,
      mustChangePassword: user.mustChangePassword === true,
    });
  }
  await batch.commit();
}

// fixtureRecords reads these modules synchronously through its `load` seam.
const FIXTURE_MODULES = {
  "lib/operations/handover-domain": handoverDomain,
  "lib/operations/handover-work-snapshot": workSnapshotDomain,
  "lib/operations/handover-work-disposition-domain": dispositionDomain,
  "lib/operations/operational-shift-control-state": controlStateDomain,
};

function loadFixtureModule(path) {
  const fixtureModule = FIXTURE_MODULES[path];
  if (!fixtureModule) throw new Error(`Unexpected fixture dependency ${path}`);
  return fixtureModule;
}

// The fixture takes its schedule from the wall clock. Evaluating the world two
// hours in the fixture's past closes the 60-minute activation window without
// touching production time handling.
function buildBaseWorld() {
  const realNow = Date.now;
  const fixtureNow = realNow() - 2 * 60 * 60_000;
  Date.now = () => fixtureNow;
  try {
    return fixtureRecords(loadFixtureModule, { count: 0 });
  } finally {
    Date.now = realNow;
  }
}

async function binding() {
  const [aggregateSnapshot, guardSnapshot] = await Promise.all([
    db.doc(`equal_handovers_v2/${HANDOVER_DOCUMENT_ID}`).get(),
    db.doc(`handover_reservation_guards/${guardDomain.createHandoverReservationGuardDocumentId(OUT_ID)}`).get(),
  ]);
  assert.ok(aggregateSnapshot.exists, "The seeded handover aggregate is missing.");
  assert.ok(guardSnapshot.exists, "The seeded reservation guard is missing.");
  const aggregate = aggregateSnapshot.data();
  const guard = guardSnapshot.data();
  return {
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: equalDomain.createEqualHandoverSnapshot(aggregate).snapshotHash,
    expectedGuardRevision: guard.guardRevision,
    expectedFencingEpoch: guard.fencingEpoch,
  };
}

// Seed a real committed v2 handover with the production domain and services:
// nothing about the eligible state is fabricated by the test.
async function seedCommittedWorld() {
  const base = buildBaseWorld();
  for (const uid of [...base.out, ...base.incoming]) {
    base.records.get(`users/${uid}`).fullName = uid;
  }

  let batch = db.batch();
  for (const [path, record] of base.records) {
    // The base fixture also emits a v1 `handovers/handover_*` aggregate, which
    // has no v1 lifecycle state past `collecting_confirmations`. This world is
    // v2-only, so the legacy record is not replayed: a lingering legacy
    // reservation is exactly the ambiguity the classifier refuses.
    if (path === `handovers/handover_${OUT_ID}`) continue;
    batch.set(db.doc(path), record);
  }
  await batch.commit();

  const identity = {
    ...base.aggregate.identity,
    schema: "equal-handover-v2",
    outgoingTechnicianIds: [...base.out],
    incomingTechnicianIds: [...base.incoming],
  };
  delete identity.outgoingPrimaryTechnicianIds;
  delete identity.incomingPrimaryTechnicianIds;

  const aggregate = equalDomain.createEqualHandover({
    identity,
    reservedAt: base.at,
    reservedBy: "out-a",
  });
  const guard = guardDomain.createInitialReservationGuard({
    outgoingShiftId: OUT_ID,
    protocolOwner: "v2",
    ownerHandoverDocumentId: HANDOVER_DOCUMENT_ID,
    outgoingSlotToken: identity.outgoingSlotToken,
    outgoingGeneration: identity.outgoingGeneration,
    successorSlotToken: identity.successorSlotToken,
    successorGeneration: identity.successorGeneration,
    reservationId: aggregate.reservation.handoverId,
    reservedIncomingShiftId: IN_ID,
    reservedAt: base.at,
    reservedBy: "out-a",
  });

  batch = db.batch();
  batch.set(db.doc(`equal_handovers_v2/${HANDOVER_DOCUMENT_ID}`), aggregate);
  batch.set(db.doc(`handover_reservation_guards/${guard.id}`), guard);
  for (const uid of base.out) {
    const attendance = shiftJoinDomain.createShiftAttendanceRecord({
      shiftId: OUT_ID,
      technicianUid: uid,
      participationAuthority: "primary",
      authorizationId: null,
      recordedAt: base.at,
    });
    batch.set(db.doc(`shift_attendance/outgoing_${uid}`), attendance);
  }
  for (const [index, station] of DEFAULT_BROADCAST_STATIONS.entries()) {
    const id = `broadcast-${index}`;
    batch.set(db.doc(`shift_operation_events/${id}`), {
      id,
      recordId: id,
      shiftId: OUT_ID,
      revision: 1,
      kind: "broadcast",
      stationId: station.id,
      stationName: station.name,
      status: "on_air",
      occurredAt: base.at,
      remarks: "Synthetic HTTP observation",
      authorUid: "out-a",
      authorName: "Alpha",
      originalReporterUid: "out-a",
      originalReporterName: "Alpha",
      createdAt: base.at,
      provenance: "authenticated_technician",
    });
  }
  batch.set(db.doc("shift_operation_events/no-ob"), {
    id: "no-ob",
    recordId: "no-ob",
    shiftId: OUT_ID,
    revision: 1,
    kind: "no_ob",
    occurredAt: base.at,
    remarks: "Synthetic no OB",
    authorUid: "out-a",
    authorName: "Alpha",
    originalReporterUid: "out-a",
    originalReporterName: "Alpha",
    createdAt: base.at,
    provenance: "authenticated_technician",
  });
  await batch.commit();

  const preparation = (
    await reportFirestore.prepareEqualHandoverReport({
      outgoingShiftId: OUT_ID,
      actorUid: "out-a",
      reason: null,
    })
  ).preparation;
  await reportFirestore.freezeEqualHandoverReport({
    outgoingShiftId: OUT_ID,
    actorUid: "out-a",
    ...(await binding()),
    preparationRevision: preparation.preparationRevision,
    contentDigest: preparation.contentDigest,
    evidenceSnapshotHash: preparation.evidenceSnapshotHash,
    workSnapshotVersion: preparation.workSnapshotVersion,
    reason: "Synthetic eligibility fixture",
    correctionNote: null,
  });
  for (const uid of [...base.out, ...base.incoming]) {
    await reportFirestore.confirmEqualHandoverParticipantV2({
      outgoingShiftId: OUT_ID,
      actorUid: uid,
      ...(await binding()),
    });
  }
  const committed = await reportFirestore.commitEqualHandoverOutgoingV2({
    outgoingShiftId: OUT_ID,
    actorUid: "out-a",
    ...(await binding()),
  });
  assert.equal(committed.aggregate.lifecycleStatus, "awaiting_incoming_acceptance");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const capturedResponses = [];

async function call(method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  let payload;
  if (options.rawBody !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = options.rawBody;
  }
  const response = await fetch(`${options.base ?? ORIGIN}${path}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(180_000),
    redirect: "manual",
  });
  const text = await response.text();
  capturedResponses.push(text);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // The V2-disabled server and unsupported-method responses need not be JSON.
  }
  return { status: response.status, text, json, headers: response.headers };
}

function assertNoStore(response, label) {
  assert.match(
    String(response.headers.get("cache-control") ?? ""),
    /no-store/,
    `${label} eligibility responses must never be cached`,
  );
}

function assertNonExecutable(value, where = "response") {
  if (Array.isArray(value)) {
    assert.ok(Array.isArray(value), `${where} must be a plain array`);
    for (let index = 0; index < value.length; index += 1) {
      assertNonExecutable(value[index], `${where}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "recoveryExecutionEligible") {
        assert.equal(item, false, `${where}.recoveryExecutionEligible must stay false`);
      }
      if (key === "executionAuthorized") {
        assert.equal(item, false, `${where}.executionAuthorized must stay false`);
      }
      if (key === "executionAuthority") {
        assert.equal(item, "none", `${where}.executionAuthority must stay "none"`);
      }
      if (key === "readModel") {
        assert.fail(`${where} must not expose the internal read model`);
      }
      assertNonExecutable(item, `${where}.${key}`);
    }
  }
}

const FORBIDDEN_KEYS = [
  "password",
  "idtoken",
  "refreshtoken",
  "accesstoken",
  "cookie",
  "cookies",
  "authorization",
  "credential",
  "credentials",
  "secret",
  "apikey",
  "api_key",
];

function assertNoCredentialKeys(value, location) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialKeys(item, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(
        !FORBIDDEN_KEYS.includes(key.toLowerCase()),
        `credential field ${location}.${key} must never be returned`,
      );
      assertNoCredentialKeys(item, `${location}.${key}`);
    }
  }
}

function assertSuccessShape(response) {
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${response.text.slice(0, 300)}`);
  assertNoStore(response, "successful");
  assert.equal(response.json?.success, true);
  assert.equal(response.json?.recoveryExecutionEligible, false);
  assert.deepEqual(Object.keys(response.json).sort(), ["eligibility", "recoveryExecutionEligible", "success"]);
  assert.deepEqual(
    Object.keys(response.json.eligibility).sort(),
    [
      "classification",
      "concurrencyNotice",
      "evaluatedAt",
      "evidenceDigest",
      "executionAuthorized",
      "executionAuthority",
      "handoverDocumentId",
      "incomingShiftId",
      "outgoingShiftId",
      "readModelStability",
      "reason",
      "references",
      "refusals",
      "schema",
      "schemaVersion",
    ].sort(),
  );
  assertNonExecutable(response.json);
  assertNoCredentialKeys(response.json, "response");
  return response.json.eligibility;
}

function assertFailure(response, status, code = null) {
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${response.text.slice(0, 300)}`);
  assertNoStore(response, `${status}`);
  assert.equal(response.json?.success, false);
  assert.equal(response.json?.recoveryExecutionEligible, false);
  if (code !== null) assert.equal(response.json?.code, code);
  assertNonExecutable(response.json);
  assertNoCredentialKeys(response.json, "response");
}

const sessionCache = new Map();

async function sessionFor(uid) {
  if (sessionCache.has(uid)) return sessionCache.get(uid);
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "synthetic-recovery-eligibility-http-key",
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailFor(uid), password: USERS[uid].password, returnSecureToken: true }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  assert.equal(response.status, 200, `Auth emulator sign-in failed for ${uid}`);
  const { idToken } = await response.json();
  assert.ok(idToken, `No ID token issued for ${uid}`);
  const login = await fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ idToken }),
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(login.status, 200, `Session login failed for ${uid}`);
  const session = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith("__session="));
  assert.ok(session, `No session cookie issued for ${uid}`);
  sessionCache.set(uid, session);
  return session;
}

// ---------------------------------------------------------------------------
// Zero-write proof
// ---------------------------------------------------------------------------

const FINGERPRINT_COLLECTIONS = [
  "audit_logs",
  "equal_handovers_v2",
  "handover_report_preparations_v2",
  "handover_reports_v2",
  "handover_reservation_guard_history",
  "handover_reservation_guards",
  "handover_review_cases_v1",
  "handover_review_decisions_v1",
  "handover_reviews_v1",
  "handover_task_dispositions",
  "handovers",
  "incoming_acceptance_applications_v1",
  "next_shift_authorizations",
  "notification_outbox",
  "notifications",
  "operational_shift_control",
  "shift_attendance",
  "shift_joins",
  "shift_members",
  "shift_operation_events",
  "shifts",
  "task_assignments",
  "tasks",
  "technician_pair_memberships",
  "technician_pairs",
  "technician_schedules",
  "users",
  "attendance_evidence_v2",
  "attendance_evidence_operations_v2",
];

async function operationalFingerprint() {
  const parts = [];
  for (const collection of FINGERPRINT_COLLECTIONS) {
    const snapshot = await db.collection(collection).get();
    for (const document of snapshot.docs) {
      parts.push(`${document.ref.path}=${JSON.stringify(document.data())}`);
    }
  }
  return createHash("sha256").update(parts.sort().join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Prepare the isolated stack and the committed world
// ---------------------------------------------------------------------------

await clearDatabase();
await ensureAuthUsers();
await seedAccounts();
await seedCommittedWorld();

const supSession = await sessionFor("sup-1");
const adminSession = await sessionFor("adm-1");

// ---------------------------------------------------------------------------
// 1. Boundary: unauthenticated access
// ---------------------------------------------------------------------------

test("01 the endpoint refuses an unauthenticated caller with 401", async () => {
  for (const path of [ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), ELIGIBILITY_PATH("handover_v2_missing"), "/api/admin/recovery-eligibility"]) {
    const response = await call("GET", path);
    assertFailure(response, 401);
  }
});

test("02 identity cannot be claimed from the request body, query or headers", async () => {
  // GET may not carry a body, so the claim attempts travel where a caller could
  // actually put them: query parameters and spoofed identity headers.
  const response = await call(
    "GET",
    `${ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID)}&actorUid=adm-1&role=admin&uid=adm-1`,
    {
      headers: {
        "x-actor-uid": "adm-1",
        "x-user-role": "admin",
        "x-forwarded-user": "adm-1",
      },
    },
  );
  assertFailure(response, 401);
});

test("03 the route is GET-only", async () => {
  const response = await call("POST", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), {
    headers: { Origin: ORIGIN },
    rawBody: JSON.stringify({ handoverDocumentId: HANDOVER_DOCUMENT_ID, actorUid: "adm-1" }),
    cookie: supSession,
  });
  assert.equal(response.status, 405, `expected 405, got ${response.status}: ${response.text.slice(0, 200)}`);
  assert.equal(response.json, null, "an unsupported method must not return an eligibility payload");
});

// ---------------------------------------------------------------------------
// 2. Live identity, role and account authority
// ---------------------------------------------------------------------------

test("04 a technician session is refused with 403", async () => {
  const response = await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), {
    cookie: await sessionFor("tech-1"),
  });
  assertFailure(response, 403);
});

test("05 a mandatory password change blocks eligibility with 403", async () => {
  const response = await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), {
    cookie: await sessionFor("pw-admin"),
  });
  assertFailure(response, 403);
});

test("06 a disabled Auth account loses an existing session (401)", async () => {
  const cookie = await sessionFor("adm-off");
  await auth.updateUser("adm-off", { disabled: true });
  try {
    const response = await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), { cookie });
    assertFailure(response, 401);
  } finally {
    await auth.updateUser("adm-off", { disabled: false });
  }
});

test("07 a suspended profile loses an existing session (401)", async () => {
  const cookie = await sessionFor("sup-2");
  await db.doc("users/sup-2").update({ status: "suspended" });
  try {
    const response = await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), { cookie });
    assertFailure(response, 401);
  } finally {
    await db.doc("users/sup-2").update({ status: "active" });
  }
});

test("08 a live profile role that no longer matches the session is refused (401)", async () => {
  await db.doc("users/sup-1").update({ role: "technician" });
  try {
    const response = await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), { cookie: supSession });
    assertFailure(response, 401);
  } finally {
    await db.doc("users/sup-1").update({ role: "supervisor" });
  }
});

// ---------------------------------------------------------------------------
// 3. Input boundary
// ---------------------------------------------------------------------------

test("09 malformed handover identifiers are refused with 400", async () => {
  for (const value of ["", "handover_", "handover_v2_", "handover_v2_ bad", "handover_v2_a/b", "handover_v3_outgoing"]) {
    const response = await call("GET", ELIGIBILITY_PATH(value), { cookie: supSession });
    assertFailure(response, 400, "ELIGIBILITY_INVALID_HANDOVER");
  }
});

test("10 a well-formed but unknown handover classifies as handover_not_applicable", async () => {
  const response = await call("GET", ELIGIBILITY_PATH("handover_v2_unknown_shift"), { cookie: supSession });
  const result = assertSuccessShape(response);
  assert.equal(result.classification, CLASSIFICATION.HANDOVER_NOT_APPLICABLE);
  assert.equal(result.handoverDocumentId, "handover_v2_unknown_shift");
  assert.equal(result.outgoingShiftId, "unknown_shift");
  assert.ok(
    result.refusals.some(
      (entry) =>
        entry.code === CLASSIFICATION.HANDOVER_NOT_APPLICABLE && entry.detail === DETAIL.HANDOVER_NOT_FOUND,
    ),
  );
});

// ---------------------------------------------------------------------------
// 4. The authoritative eligible classification
// ---------------------------------------------------------------------------

let eligibleDigest = null;

test("11 the committed zero-acceptance world is eligible for abandonment review", async () => {
  const response = await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), { cookie: supSession });
  const result = assertSuccessShape(response);
  assert.equal(result.schema, "handover-recovery-eligibility-v1");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.classification, CLASSIFICATION.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
  assert.equal(result.readModelStability, "point_in_time_transaction");
  assert.match(result.concurrencyNotice, /not an execution authorization/);
  assert.equal(result.refusals.length, 0);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.executionAuthority, "none");
  assert.equal(result.handoverDocumentId, HANDOVER_DOCUMENT_ID);
  assert.equal(result.outgoingShiftId, OUT_ID);
  assert.equal(result.incomingShiftId, IN_ID);
  assert.equal(result.evidenceDigest.schema, "handover-recovery-eligibility-evidence");
  assert.equal(result.evidenceDigest.schemaVersion, 1);
  assert.equal(result.evidenceDigest.algorithm, "sha256");
  assert.match(result.evidenceDigest.value, /^[0-9a-f]{64}$/);
  assert.equal(result.references.guardId, "guard_outgoing");
  assert.ok(result.references.commitReceiptId.startsWith("handover-commit-v2-"));
  assert.ok(result.references.activationReceiptId.startsWith("handover-activation-v2-"));
  assert.equal(result.references.applicationReceiptIds.length, 2);
  assert.equal(result.references.slotGeneration, 1);
  assert.ok(Date.parse(result.references.latestActivationAt) < Date.parse(result.evaluatedAt));
  eligibleDigest = result.evidenceDigest.value;
});

test("12 the digest is repeatable and independent of the viewer", async () => {
  const again = assertSuccessShape(
    await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), { cookie: supSession }),
  );
  const asAdmin = assertSuccessShape(
    await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), { cookie: adminSession }),
  );
  assert.equal(again.classification, CLASSIFICATION.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
  assert.equal(again.evidenceDigest.value, eligibleDigest);
  assert.equal(asAdmin.classification, CLASSIFICATION.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
  assert.equal(asAdmin.evidenceDigest.value, eligibleDigest);
  assert.notEqual(again.evaluatedAt, undefined);
  assert.notEqual(asAdmin.evaluatedAt, undefined);
});

test("13 a client cannot supply or override the classification or digest", async () => {
  const tampered = await call(
    "GET",
    `${ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID)}&classification=acceptance_exists&evidenceDigest=${"0".repeat(
      64,
    )}&executionAuthorized=true&actorUid=adm-1`,
    { cookie: supSession },
  );
  const result = assertSuccessShape(tampered);
  assert.equal(result.classification, CLASSIFICATION.ELIGIBLE_FOR_ABANDONMENT_REVIEW);
  assert.equal(result.evidenceDigest.value, eligibleDigest);
  assert.equal(result.executionAuthorized, false);
});

test("14 reading eligibility writes no operational document", async () => {
  const before = await operationalFingerprint();
  for (const path of [
    ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID),
    ELIGIBILITY_PATH("handover_v2_unknown_shift"),
    ELIGIBILITY_PATH("handover_v2_ bad"),
    "/api/admin/recovery-eligibility",
  ]) {
    await call("GET", path, { cookie: adminSession });
  }
  const after = await operationalFingerprint();
  assert.equal(after, before, "the read-only endpoint must not write any operational document");
});

// ---------------------------------------------------------------------------
// 5. A safety-relevant evidence change changes the digest
// ---------------------------------------------------------------------------

test("15 an activated incoming shift changes classification and digest", async () => {
  await db.doc(`shifts/${IN_ID}`).set({ id: IN_ID, status: "active" });
  const response = await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), { cookie: supSession });
  const result = assertSuccessShape(response);
  assert.equal(result.classification, CLASSIFICATION.ACCEPTANCE_EXISTS);
  assert.ok(
    result.refusals.some(
      (entry) =>
        entry.code === CLASSIFICATION.ACCEPTANCE_EXISTS && entry.detail === DETAIL.INCOMING_SHIFT_ACTIVATED,
    ),
  );
  assert.notEqual(result.evidenceDigest.value, eligibleDigest);
});

// ---------------------------------------------------------------------------
// 6. Gate direction and response hygiene
// ---------------------------------------------------------------------------

test("16 the endpoint is hidden while the V2 gate is off (404)", async () => {
  const response = await call("GET", ELIGIBILITY_PATH(HANDOVER_DOCUMENT_ID), {
    base: ORIGIN_DISABLED,
    cookie: supSession,
  });
  assertFailure(response, 404);
});

test("17 every captured body is free of credential keys and non-executable", () => {
  assert.ok(capturedResponses.length >= 15, "the suite must have captured every response");
  for (const [index, text] of capturedResponses.entries()) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    assertNoCredentialKeys(parsed, `captured[${index}]`);
    assertNonExecutable(parsed, `captured[${index}]`);
  }
});
