/**
 * Phase 8C.5 — real-HTTP verification of the recovery-execution boundary.
 *
 * Runs INSIDE tests/run-recovery-execution-http.mjs (which runs inside
 * `firebase emulators:exec`), so it talks to two real Next.js servers over the
 * disposable Firestore/Auth emulators of the registered tuple
 * "demo-admin-review-8b":
 *
 *   - RECOVERY_EXECUTION_HTTP_ORIGIN          V2 on + execution gate on  (3198)
 *   - RECOVERY_EXECUTION_HTTP_ORIGIN_DISABLED V2 on + execution gate off (3199)
 *
 * What is proved here, over HTTP, that the service-level suite cannot:
 *   - the execution gate is a second, independent gate: the surrounding Version
 *     2 family answers while both execution endpoints 404;
 *   - the actor is the session subject and only a live administrator executes;
 *   - same-origin protects the mutating route before anything is read;
 *   - the payload carries no authority — unknown fields, missing reason, a
 *     malformed id and an unknown approval all produce the documented contract;
 *   - a fully approved intent executes once and the same response never claims
 *     execution authority; the read-back and the replay agree with the audit row;
 *   - intent that is not fully approved, and evidence that moves after approval,
 *     are refused over HTTP with nothing written;
 *   - no personal evidence, no user document and no attendance row is touched.
 *
 * The routes take their clock from the server process, so the fixture world is
 * generated with its clock in the past by more than the activation window; by the
 * time a real request arrives the window has genuinely closed.
 */
import assert from "node:assert/strict";
import test from "node:test";

const ORIGIN = process.env.RECOVERY_EXECUTION_HTTP_ORIGIN;
const ORIGIN_DISABLED = process.env.RECOVERY_EXECUTION_HTTP_ORIGIN_DISABLED;
const project = "demo-admin-review-8b";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (
  !ORIGIN ||
  !ORIGIN_DISABLED ||
  firestoreHost !== "127.0.0.1:8980" ||
  authHost !== "127.0.0.1:10099" ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  ) ||
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS !== "true" ||
  process.env.HANDOVER_V2_DEV !== "true" ||
  process.env.RECOVERY_EXECUTION_HTTP_EMULATOR !== "true"
) {
  throw new Error(
    "Refusing to run recovery execution HTTP tests outside the isolated HTTP emulator stack.",
  );
}
if (process.env.HANDOVER_V2_ATOMIC_ACCEPTANCE) {
  throw new Error("The recovery execution HTTP suite must not inherit the atomic acceptance flag.");
}

const firestoreProbe = await fetch(
  `http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents`,
);
assert.ok([200, 403, 404].includes(firestoreProbe.status), `Firestore probe failed: ${firestoreProbe.status}`);
const authProbe = await fetch(`http://${authHost}/`, { signal: AbortSignal.timeout(60_000) });
assert.ok(authProbe.status < 500, `Auth emulator probe failed: ${authProbe.status}`);

const { Timestamp } = await import("firebase-admin/firestore");
const { getAdminFirestore, getAdminAuth } = await import("../src/lib/firebase/admin/index.ts");
const { acceptanceFixture } = await import("./helpers/acceptance-integrity-fixtures.mjs");
const adminReviewDomain = await import("../src/lib/operations/handover-admin-review-domain.ts");
const abandonment = await import("../src/lib/operations/handover-recovery-abandonment-domain.ts");
const { HANDOVER_REVIEW_CASE_SCHEMA, HANDOVER_REVIEW_CASE_STATUSES } = await import(
  "../src/types/handover-admin-review.ts"
);

const db = getAdminFirestore();
const auth = getAdminAuth();

const REASON = "Recover the stalled outgoing handover after review.";
const PASSWORD = "R8c5-exec-http-Pass!";
const HANDOVER_DOCUMENT_ID = "handover_v2_outgoing";
const AGGREGATE_PATH = `equal_handovers_v2/${HANDOVER_DOCUMENT_ID}`;
const LEGACY_PATH = "handovers/handover_outgoing";
const APPROVALS = "/api/admin/recovery-approvals-v2";
const EXECUTE = (approvalId) => `${APPROVALS}/${approvalId}/execute`;

const USERS = {
  sup1: { role: "supervisor" },
  adm1: { role: "admin" },
  adm2: { role: "admin" },
  admoff: { role: "admin", profile: { status: "suspended" } },
  tech1: { role: "technician" },
  pwadm: { role: "admin", mustChangePassword: true },
};

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function toFirestore(value) {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "object" &&
    Number.isSafeInteger(value.seconds) &&
    Number.isSafeInteger(value.nanoseconds)
  ) {
    return new Timestamp(value.seconds, value.nanoseconds);
  }
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isSafeInteger(value._seconds) &&
    Number.isSafeInteger(value._nanoseconds)
  ) {
    return new Timestamp(value._seconds, value._nanoseconds);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toFirestore);
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toFirestore(item);
    }
    return result;
  }
  return value;
}

function stamp(value) {
  return value ? `${value.seconds}/${value.nanoseconds}` : "none";
}

async function storeFingerprint() {
  const out = [];
  for (const collection of await db.listCollections()) {
    const snapshot = await db.collection(collection.id).get();
    for (const doc of snapshot.docs) {
      out.push(`${doc.ref.path}|${stamp(doc.createTime)}|${stamp(doc.updateTime)}`);
    }
  }
  out.sort();
  return out;
}

function touchedPaths(before, after) {
  const left = new Map(before.map((line) => [line.split("|")[0], line]));
  const changed = [];
  for (const line of after) {
    const path = line.split("|")[0];
    if (left.get(path) !== line) changed.push(path);
  }
  for (const path of left.keys()) {
    if (!after.some((line) => line.split("|")[0] === path)) changed.push(path);
  }
  return Array.from(new Set(changed)).sort();
}

async function readDoc(path) {
  const snapshot = await db.doc(path).get();
  return snapshot.exists ? snapshot.data() : null;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

const WORLD_AGE_MS = 2 * 3_600_000;

function withBackdatedClock(ageMs, generate) {
  const RealDate = Date;
  class BackdatedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() - ageMs]));
    }
    static now() {
      return RealDate.now() - ageMs;
    }
  }
  globalThis.Date = BackdatedDate;
  try {
    return generate();
  } finally {
    globalThis.Date = RealDate;
  }
}

const frozenWorld = await withBackdatedClock(WORLD_AGE_MS, () => acceptanceFixture());
const seedRecords = new Map(frozenWorld.records);
assert.ok(seedRecords.get(AGGREGATE_PATH), "The fixture writes no equal-handover v2 aggregate.");
seedRecords.delete(LEGACY_PATH);
const baseAggregate = seedRecords.get(AGGREGATE_PATH);
assert.ok(
  Date.parse(baseAggregate.identity.scheduledStart) + 3_600_000 < Date.now(),
  "the backdated fixture world still has an open activation window on the real clock",
);
const OUTGOING_SHIFT_ID = baseAggregate.identity.outgoingShiftId;

async function clearDatabase() {
  const cleared = await fetch(
    `http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200, "The disposable emulator database could not be cleared.");
}

const cookies = new Map();

async function ensureAuthUser(name) {
  const email = `${name}@recovery-exec-http.demo`;
  try {
    await auth.getUser(name);
  } catch {
    await auth.createUser({ uid: name, email, password: PASSWORD, displayName: name });
  }
  await auth.setCustomUserClaims(name, { role: USERS[name].role });
  await auth.updateUser(name, { disabled: false, password: PASSWORD });
}

async function writeWorld() {
  await clearDatabase();
  cookies.clear();
  let batch = db.batch();
  let queued = 0;
  for (const [path, value] of seedRecords) {
    batch.set(db.doc(path), toFirestore(structuredClone(value)));
    queued += 1;
    if (queued === 400) {
      await batch.commit();
      batch = db.batch();
      queued = 0;
    }
  }
  if (queued > 0) await batch.commit();

  const viewer = structuredClone((await readDoc("users/manager")) ?? {});
  assert.ok(viewer.role, "The seeded world has no actor user document to clone.");

  for (const [name, spec] of Object.entries(USERS)) {
    await ensureAuthUser(name);
    await db.doc(`users/${name}`).set(
      toFirestore({
        ...viewer,
        uid: name,
        id: name,
        email: `${name}@recovery-exec-http.demo`,
        fullName: name,
        role: spec.role,
        status: "active",
        statusOperation: null,
        mustChangePassword: spec.mustChangePassword === true,
        ...(spec.profile ?? {}),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function signIn(name, origin = ORIGIN) {
  const email = `${name}@recovery-exec-http.demo`;
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "local";
  const signedIn = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  const payload = await signedIn.json();
  assert.ok(signedIn.ok, `Sign in for ${name} failed: ${JSON.stringify(payload)}`);

  const session = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ idToken: payload.idToken }),
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(session.status, 200, `Session exchange for ${name} failed: ${await session.text()}`);
  const cookie = session.headers
    .getSetCookie()
    .map((value) => value.split(";")[0].trim())
    .find((value) => value.startsWith("__session="));
  assert.ok(cookie, `No session cookie for ${name}.`);
  cookies.set(`${origin}|${name}`, cookie);
  return cookie;
}

async function cookieFor(name, origin = ORIGIN) {
  const key = `${origin}|${name}`;
  if (!cookies.has(key)) await signIn(name, origin);
  return cookies.get(key);
}

async function call(origin, method, path, { name, body, crossOrigin, rawBody } = {}) {
  const headers = {};
  if (name) headers.Cookie = await cookieFor(name, origin);
  if (body !== undefined || rawBody !== undefined) headers["Content-Type"] = "application/json";
  if (crossOrigin !== undefined) headers.Origin = crossOrigin;
  else if (body !== undefined || rawBody !== undefined) headers.Origin = origin;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON answers are reported raw.
  }
  return { status: response.status, json, text };
}

const get = (path, options) => call(ORIGIN, "GET", path, options);
const post = (path, body, options = {}) => call(ORIGIN, "POST", path, { ...options, body });

async function expectHttp(operation, status, code) {
  const response = await operation();
  assert.equal(
    response.status,
    status,
    `expected ${status}, got ${response.status}: ${response.text.slice(0, 300)}`,
  );
  if (code !== undefined) {
    assert.equal(response.json?.code, code, `body code mismatch: ${response.text.slice(0, 300)}`);
  }
  return response;
}

let keySequence = 0;

function requestBody() {
  return {
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    reason: REASON,
    idempotencyKey: `http-exec-request-${++keySequence}`,
    password: PASSWORD,
  };
}

function executionBody(extra = {}) {
  return {
    reason: REASON,
    idempotencyKey: `http-exec-run-${++keySequence}`,
    ...extra,
  };
}

async function createApproval() {
  const response = await post(APPROVALS, requestBody(), { name: "sup1" });
  assert.equal(response.status, 201, `request failed: ${response.text.slice(0, 400)}`);
  const record = response.json?.approval?.approval;
  assert.ok(record?.id, `request returned no approval id: ${response.text.slice(0, 400)}`);
  return record;
}

async function countersign(approvalId) {
  const response = await post(
    `${APPROVALS}/${approvalId}/approvals`,
    { expectedRevision: 1, password: PASSWORD },
    { name: "adm1" },
  );
  assert.equal(response.status, 200, `countersign failed: ${response.text.slice(0, 400)}`);
  const record = response.json?.approval?.approval;
  assert.ok(record?.id, `countersign returned no approval: ${response.text.slice(0, 400)}`);
  return record;
}

async function fullyApproved() {
  const first = await createApproval();
  return countersign(first.id);
}

// ---------------------------------------------------------------------------
// 1. The gate and the actor
// ---------------------------------------------------------------------------

test("01 the execution gate hides both endpoints while the version 2 family answers", async () => {
  await writeWorld();
  for (const [method, body] of [["POST", {}], ["GET", undefined]]) {
    const disabled = await call(ORIGIN_DISABLED, method, EXECUTE("handover_recovery_approval_v2_probe"), {
      body,
    });
    assert.equal(disabled.status, 404, `${method} execute answered while the execution gate was off`);
  }
  // The surrounding family is reachable on both servers; only execution is gated.
  const familyOff = await call(ORIGIN_DISABLED, "GET", `${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`);
  assert.equal(familyOff.status, 401);
  const familyOn = await get(`${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`);
  assert.equal(familyOn.status, 401);
  const executionOn = await get(EXECUTE("handover_recovery_approval_v2_probe"));
  assert.equal(executionOn.status, 401);
});

test("02 only a live administrator executes; no session writes nothing", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const before = await storeFingerprint();

  await expectHttp(() => post(EXECUTE(approval.id), executionBody()), 401);
  await expectHttp(() => get(EXECUTE(approval.id)), 401);
  await expectHttp(() => post(EXECUTE(approval.id), executionBody(), { name: "sup1" }), 403);
  await expectHttp(() => get(EXECUTE(approval.id), { name: "sup1" }), 403);
  await expectHttp(() => post(EXECUTE(approval.id), executionBody(), { name: "tech1" }), 403);
  await expectHttp(() => post(EXECUTE(approval.id), executionBody(), { name: "pwadm" }), 403);

  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "an unauthorized call wrote");
});

test("03 a session whose profile was suspended is refused and writes nothing", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  // A session minted while the profile was active must not survive suspension.
  // The HTTP boundary refuses at session resolution (401) before the executor;
  // the in-transaction actor re-read is covered by the service-level suite.
  await db.doc("users/admoff").update({ status: "active" });
  await cookieFor("admoff");
  await db.doc("users/admoff").update({ status: "suspended" });
  const before = await storeFingerprint();
  await expectHttp(() => post(EXECUTE(approval.id), executionBody(), { name: "admoff" }), 401);
  await expectHttp(() => get(EXECUTE(approval.id), { name: "admoff" }), 401);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

test("04 the mutating route requires the application origin", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const before = await storeFingerprint();
  await expectHttp(
    () =>
      post(EXECUTE(approval.id), executionBody(), {
        name: "adm1",
        crossOrigin: "https://attacker.example",
      }),
    403,
  );
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "a cross-origin call wrote");
});

// ---------------------------------------------------------------------------
// 2. The payload contract
// ---------------------------------------------------------------------------

test("05 the payload carries no authority and every malformed shape is rejected", async () => {
  await writeWorld();
  const approval = await fullyApproved();
  const before = await storeFingerprint();

  await expectHttp(
    () => post(EXECUTE(approval.id), executionBody({ actorUid: "adm2" }), { name: "adm1" }),
    400,
  );
  await expectHttp(
    () => post(EXECUTE(approval.id), executionBody({ handoverDocumentId: HANDOVER_DOCUMENT_ID }), { name: "adm1" }),
    400,
  );
  await expectHttp(() => post(EXECUTE(approval.id), executionBody({ reason: undefined }), { name: "adm1" }), 400);
  await expectHttp(
    () => post(EXECUTE(approval.id), undefined, { name: "adm1", rawBody: "not json" }),
    400,
  );
  await expectHttp(() => post(EXECUTE("not-an-approval-id"), executionBody(), { name: "adm1" }), 400);
  await expectHttp(
    () =>
      post(EXECUTE("handover_recovery_approval_v2_missing"), executionBody(), { name: "adm1" }),
    404,
    abandonment.HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
  );

  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "a malformed payload wrote");
});

test("06 an intent that is not fully approved cannot execute", async () => {
  await writeWorld();
  const first = await createApproval();
  const before = await storeFingerprint();
  await expectHttp(
    () => post(EXECUTE(first.id), executionBody(), { name: "adm1" }),
    409,
    abandonment.HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_INVALID,
  );
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});

// ---------------------------------------------------------------------------
// 3. The commit over HTTP
// ---------------------------------------------------------------------------

test("07 an approved intent executes once, the read-back agrees, and the replay writes nothing", async () => {
  await writeWorld();
  const approval = await fullyApproved();

  const before = await storeFingerprint();
  const committed = await expectHttp(
    () => post(EXECUTE(approval.id), executionBody(), { name: "adm1" }),
    200,
  );
  assert.equal(committed.json.success, true);
  assert.equal(committed.json.status, "committed");
  assert.equal(committed.json.recoveryExecutionEligible, false);
  assert.equal(committed.json.execution.approvalId, approval.id);
  assert.equal(committed.json.execution.executedBy, "adm1");
  assert.equal(
    committed.json.execution.auditId,
    abandonment.createHandoverAbandonmentAuditId(approval.id),
  );

  const changed = touchedPaths(before, await storeFingerprint());
  assert.ok(changed.length > 0);
  for (const path of changed) {
    assert.equal(path.startsWith("users/"), false, `a user document was written: ${path}`);
    assert.equal(path.startsWith("shift_attendance/"), false, `attendance was written: ${path}`);
    assert.equal(path.startsWith("attendance_evidence"), false, `personal evidence was written: ${path}`);
  }
  const shift = await readDoc(`shifts/${OUTGOING_SHIFT_ID}`);
  assert.equal(shift.status, "cancelled");
  assert.equal(shift.actualEnd, null);
  assert.equal(shift.cancelledBy, "adm1");

  const applied = await expectHttp(() => get(EXECUTE(approval.id), { name: "adm1" }), 200);
  assert.equal(applied.json.success, true);
  assert.equal(applied.json.execution.applied, true);
  assert.equal(applied.json.execution.executedBy, "adm1");
  assert.equal(applied.json.recoveryExecutionEligible, false);

  const replayBefore = await storeFingerprint();
  const replay = await expectHttp(
    () => post(EXECUTE(approval.id), executionBody(), { name: "adm2" }),
    200,
  );
  assert.equal(replay.json.status, "already_applied");
  assert.equal(replay.json.execution.auditId, committed.json.execution.auditId);
  assert.equal(replay.json.execution.executedBy, "adm1");
  assert.deepEqual(touchedPaths(replayBefore, await storeFingerprint()), []);
});

test("08 evidence that moves after approval is refused over HTTP with nothing written", async () => {
  await writeWorld();
  const approval = await fullyApproved();

  await db
    .doc(`handover_review_cases_v1/${adminReviewDomain.createHandoverReviewCaseId(HANDOVER_DOCUMENT_ID)}`)
    .set(
      toFirestore({
        schema: HANDOVER_REVIEW_CASE_SCHEMA,
        id: adminReviewDomain.createHandoverReviewCaseId(HANDOVER_DOCUMENT_ID),
        handoverDocumentId: HANDOVER_DOCUMENT_ID,
        status: HANDOVER_REVIEW_CASE_STATUSES.OPEN,
        caseRevision: 1,
        fingerprintAtLastDecision: "d".repeat(64),
      }),
    );

  const before = await storeFingerprint();
  await expectHttp(
    () => post(EXECUTE(approval.id), executionBody(), { name: "adm1" }),
    409,
    abandonment.HANDOVER_RECOVERY_ABANDONMENT_REFUSALS.APPROVAL_STALE,
  );
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), []);
});
