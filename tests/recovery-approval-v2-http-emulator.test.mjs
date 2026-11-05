/**
 * Phase 8C.4B §5 — real-HTTP verification of the Version 2 dual-approval
 * route family.
 *
 * Runs INSIDE tests/run-recovery-approval-v2-http.mjs (which runs inside
 * `firebase emulators:exec`), so it talks to two real Next.js servers over the
 * disposable Firestore/Auth emulators of the registered tuple
 * "demo-admin-review-8b":
 *
 *   - RECOVERY_APPROVAL_V2_HTTP_ORIGIN          HANDOVER_V2_DEV=true   (3196)
 *   - RECOVERY_APPROVAL_V2_HTTP_ORIGIN_DISABLED HANDOVER_V2_DEV=false  (3197)
 *
 * What is proved here, over HTTP and through the real password seam, that the
 * service-level suite cannot:
 *   - the feature gate hides the whole family when it is off;
 *   - session identity cannot be claimed from a request body — the actor is the
 *     session subject, always;
 *   - role, disabled-account and mandatory-password-change enforcement before any
 *     Firestore read;
 *   - same-origin protection on every mutating route;
 *   - the real password is verified, and a rejected password writes nothing;
 *   - malformed payloads, unknown ids and stale revisions produce the documented
 *     status/code contract;
 *   - every response — success and failure alike — reports
 *     `recoveryExecutionEligible: false`, the approval binds the live classifier
 *     digest, and no operational collection is ever written;
 *   - no execution endpoint exists anywhere on this surface;
 *   - the Version 1 approval collection is never read, migrated or rewritten.
 *
 * The routes take their clock from the server process, so this suite cannot
 * inject one the way the service-level suite does. Instead the fixture world is
 * GENERATED with its own clock already in the past, by more than the activation
 * window, so by the time a real request arrives the window has genuinely closed.
 * Every hash in that world is still produced by the production writers, exactly
 * as a real stalled handover would carry them; nothing is hand-written and no
 * assertion is time-relative.
 *
 * Nothing in this file can execute a recovery: it only requests, reads,
 * countersigns, voids and reissues Version 2 intents.
 */
import assert from "node:assert/strict";
import test from "node:test";

const ORIGIN = process.env.RECOVERY_APPROVAL_V2_HTTP_ORIGIN;
const ORIGIN_DISABLED = process.env.RECOVERY_APPROVAL_V2_HTTP_ORIGIN_DISABLED;
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
  process.env.RECOVERY_APPROVAL_V2_HTTP_EMULATOR !== "true"
) {
  throw new Error(
    "Refusing to run Version 2 approval HTTP tests outside the isolated HTTP emulator stack.",
  );
}
if (process.env.HANDOVER_V2_ATOMIC_ACCEPTANCE) {
  throw new Error("The Version 2 HTTP suite must not inherit the atomic acceptance flag.");
}

const firestoreProbe = await fetch(
  `http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents`,
);
assert.ok([200, 403, 404].includes(firestoreProbe.status), `Firestore probe failed: ${firestoreProbe.status}`);
const authProbe = await fetch(`http://${authHost}/`, { signal: AbortSignal.timeout(60_000) });
assert.ok(authProbe.status < 500, `Auth emulator probe failed: ${authProbe.status}`);

const { Timestamp } = await import("firebase-admin/firestore");
const { readdirSync, readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { getAdminFirestore, getAdminAuth } = await import("../src/lib/firebase/admin/index.ts");
const { acceptanceFixture } = await import("./helpers/acceptance-integrity-fixtures.mjs");
const eligibility = await import("../src/lib/operations/handover-recovery-eligibility-firestore.ts");
const { HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION } = await import(
  "../src/types/handover-recovery-approval-v2.ts"
);
const { HANDOVER_RECOVERY_APPROVAL_V2_INTENT_MAX_AGE_MS } = await import(
  "../src/lib/operations/handover-recovery-approval-v2-domain.ts"
);
const { HANDOVER_RECOVERY_APPROVAL_COLLECTION } = await import(
  "../src/types/handover-recovery-approval.ts"
);

const db = getAdminFirestore();
const auth = getAdminAuth();

const REASON = "Recover the stalled outgoing handover after review.";
const VOID_REASON = "The evidence moved; this intent is withdrawn.";
const PASSWORD = "R8c4b-v2-http-Pass!";
const WRONG_PASSWORD = "R8c4b-v2-http-wrong-Pass!";
const HANDOVER_DOCUMENT_ID = "handover_v2_outgoing";
const AGGREGATE_PATH = `equal_handovers_v2/${HANDOVER_DOCUMENT_ID}`;
const LEGACY_PATH = "handovers/handover_outgoing";
const V1_PLANT_PATH = `${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/v1-plant-http`;
const APPROVALS = "/api/admin/recovery-approvals-v2";

const USERS = {
  sup1: { role: "supervisor" },
  sup2: { role: "supervisor" },
  adm1: { role: "admin" },
  adm2: { role: "admin" },
  admoff: { role: "admin" },
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

// Only the two Version 2 collections may ever move, and the Version 1 planted
// document must never appear in the delta.
function assertV2OnlyWrites(changed) {
  for (const path of changed) {
    assert.ok(
      path.startsWith(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/`) ||
        path.startsWith("audit_logs/handover_recovery_approval_v2_"),
      `a Version 2 approval route wrote outside its own two collections: ${path}`,
    );
  }
}

async function readDoc(path) {
  const snapshot = await db.doc(path).get();
  return snapshot.exists ? snapshot.data() : null;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

// The fixture's incoming shift is scheduled one minute before its own clock, and
// the activation window closes an hour after it. Generating the world with its
// clock this far in the past means the real server clock — which no route here
// can inject — finds the window genuinely closed, with an hour of slack for the
// suite to run.
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
// A v2-native reservation world must not carry a competing legacy record.
seedRecords.delete(LEGACY_PATH);
const baseAggregate = seedRecords.get(AGGREGATE_PATH);
assert.ok(
  Date.parse(baseAggregate.identity.scheduledStart) + 3_600_000 < Date.now(),
  "the backdated fixture world still has an open activation window on the real clock",
);

async function clearDatabase() {
  const cleared = await fetch(
    `http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200, "The disposable emulator database could not be cleared.");
}

const cookies = new Map();

async function ensureAuthUser(name) {
  const email = `${name}@recovery-v2-http.demo`;
  try {
    await auth.getUser(name);
  } catch {
    await auth.createUser({ uid: name, email, password: PASSWORD, displayName: name });
  }
  // Auth accounts outlive a Firestore wipe, so each run re-asserts the persona
  // instead of assuming a freshly created one.
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
        email: `${name}@recovery-v2-http.demo`,
        fullName: name,
        role: spec.role,
        status: "active",
        statusOperation: null,
        mustChangePassword: spec.mustChangePassword === true,
      }),
    );
  }
  await db.doc(V1_PLANT_PATH).set(
    toFirestore({ schema: "handover-recovery-approval-v1", planted: "never read by version 2" }),
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function signIn(name, origin = ORIGIN) {
  const email = `${name}@recovery-v2-http.demo`;
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
    // Non-JSON answers (a framework 404 page, for instance) are reported raw.
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
const nextKey = () => `http-request-${++keySequence}`;

function requestBody(overrides = {}) {
  return {
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    reason: REASON,
    idempotencyKey: overrides.idempotencyKey ?? nextKey(),
    password: overrides.password ?? PASSWORD,
    ...("extra" in overrides ? { extra: overrides.extra } : {}),
    ...("handoverDocumentId" in overrides ? { handoverDocumentId: overrides.handoverDocumentId } : {}),
    ...("reason" in overrides && overrides.reason !== undefined ? { reason: overrides.reason } : {}),
    ...(overrides.password === null ? { password: WRONG_PASSWORD } : {}),
  };
}

async function createApproval(name = "sup1", overrides = {}) {
  const response = await post(APPROVALS, requestBody(overrides), { name });
  assert.equal(response.status, 201, `request failed: ${response.text.slice(0, 400)}`);
  assert.equal(response.json.replayed, false);
  return response.json.approval;
}

// ---------------------------------------------------------------------------
// 1. The gate, the session and the actor
// ---------------------------------------------------------------------------

test("01 the disabled gate hides the whole version 2 family", async () => {
  await writeWorld();
  const paths = [
    ["GET", `${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`],
    ["POST", APPROVALS],
    ["GET", `${APPROVALS}/hrv2_anything`],
    ["POST", `${APPROVALS}/hrv2_anything/approvals`],
    ["POST", `${APPROVALS}/hrv2_anything/void`],
    ["POST", `${APPROVALS}/hrv2_anything/reissue`],
  ];
  for (const [method, path] of paths) {
    const response = await call(ORIGIN_DISABLED, method, path, {
      body: method === "POST" ? {} : undefined,
    });
    assert.equal(response.status, 404, `${method} ${path} answered while the gate was off`);
  }
  // The same requests reach the route handlers once the gate is on.
  const reachable = await call(ORIGIN, "GET", `${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`);
  assert.equal(reachable.status, 401, "the enabled family is not reachable");
});

test("02 no session means no read and no write, and nothing is written", async () => {
  await writeWorld();
  const before = await storeFingerprint();
  await expectHttp(
    () => call(ORIGIN, "GET", `${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`),
    401,
  );
  await expectHttp(() => call(ORIGIN, "POST", APPROVALS, { body: requestBody() }), 401);
  await expectHttp(
    () => call(ORIGIN, "POST", `${APPROVALS}/hrv2_anything/approvals`, { body: {} }),
    401,
  );
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "an anonymous call wrote");
});

test("03 the actor is the session subject, never a claimed uid", async () => {
  await writeWorld();
  const before = await storeFingerprint();
  // A body that tries to name a different actor carries an unsupported field:
  // the parser refuses it before any read, and the session subject is the only
  // actor the service ever sees.
  const forged = await post(
    APPROVALS,
    { ...requestBody(), actorUid: "adm1" },
    { name: "sup1" },
  );
  assert.equal(forged.status, 400, `a forged actor was accepted: ${forged.text.slice(0, 300)}`);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "a forged actor wrote");

  const created = await createApproval("sup1");
  assert.equal(created.approval.requestedBy, "sup1", "the record names someone other than the session");
  assert.equal(created.approval.approvals[0].actorUid, "sup1");
  assert.equal(created.approval.approvals[0].actorRole, "supervisor");
});

test("04 role, a mandatory password change and a disabled account are refused", async () => {
  await writeWorld();
  const before = await storeFingerprint();

  // A technician holds a perfectly valid session and still has no approval
  // authority: the refusal is a 403, not a missing session.
  await expectHttp(() => post(APPROVALS, requestBody(), { name: "tech1" }), 403);
  await expectHttp(
    () => get(`${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`, { name: "tech1" }),
    403,
  );
  // An administrator mid mandatory password change is refused the same way.
  await expectHttp(() => post(APPROVALS, requestBody(), { name: "pwadm" }), 403);

  // Disabling the Auth account after the session was issued stops the session
  // itself from resolving.
  await cookieFor("admoff");
  await auth.updateUser("admoff", { disabled: true });
  try {
    await expectHttp(
      () => call(ORIGIN, "GET", `${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`, {
        name: "admoff",
      }),
      401,
    );
  } finally {
    await auth.updateUser("admoff", { disabled: false });
  }

  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "a refused actor wrote");
});

test("05 mutating routes require the same origin", async () => {
  await writeWorld();
  const before = await storeFingerprint();
  const response = await call(ORIGIN, "POST", APPROVALS, {
    body: requestBody(),
    name: "sup1",
    crossOrigin: "http://evil.example",
  });
  assert.equal(response.status, 403, `a cross-origin request was accepted: ${response.text.slice(0, 200)}`);
  assert.match(response.json.error, /origin/i);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "a cross-origin request wrote");

  // A read carries no side effect, so it needs no origin header at all.
  const read = await get(`${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`, { name: "sup1" });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.approvals, []);
});

// ---------------------------------------------------------------------------
// 2. The password seam
// ---------------------------------------------------------------------------

test("06 a rejected password is refused before anything is written", async () => {
  await writeWorld();
  const before = await storeFingerprint();
  const response = await post(APPROVALS, requestBody({ password: null }), { name: "sup1" });
  // The password seam decides credential validity and reports it as its own
  // documented refusal — the route never invents an approval-state code for it.
  assert.equal(response.status, 400, `a wrong password was accepted: ${response.text.slice(0, 300)}`);
  assert.equal(response.json.success, false);
  assert.equal(response.json.code, "CREDENTIAL_REJECTED");
  assert.equal(response.json.recoveryExecutionEligible, false);
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "a rejected password wrote");
  assert.ok(!response.text.includes(PASSWORD), "the response body echoed the credential");
  assert.ok(!response.text.includes(WRONG_PASSWORD), "the response body echoed the credential");
});

test("07 a malformed payload is refused with the documented contract", async () => {
  await writeWorld();
  const before = await storeFingerprint();
  const refusals = [];

  // Missing field.
  const missing = await post(APPROVALS, { handoverDocumentId: HANDOVER_DOCUMENT_ID }, { name: "sup1" });
  assert.equal(missing.status, 400, missing.text.slice(0, 200));
  refusals.push(missing);
  // Unsupported field.
  const extra = await post(APPROVALS, requestBody({ extra: "x" }), { name: "sup1" });
  assert.equal(extra.status, 400, extra.text.slice(0, 200));
  refusals.push(extra);
  // A malformed handover id in the BODY is a validation refusal: the grammar
  // rejects it before any read is attempted, so there is no code to report.
  for (const value of ["not_a_handover_document", "handover_v2_", ""]) {
    const response = await post(
      APPROVALS,
      requestBody({ handoverDocumentId: value }),
      { name: "sup1" },
    );
    assert.equal(response.status, 400, `${value || "empty"}: ${response.text.slice(0, 200)}`);
    assert.equal(response.json.error, "Invalid handover document.");
    assert.equal(response.json.code, undefined, "a body validation refusal carried a code");
    refusals.push(response);
  }
  // The same grammar reached as a QUERY parameter is answered as a not-found,
  // because a read surface has no payload to validate: it can only refuse to
  // name a handover it will not look up.
  for (const value of ["not_a_handover_document", "handover_v2_"]) {
    const listed = await get(`${APPROVALS}?handoverDocumentId=${encodeURIComponent(value)}`, {
      name: "adm1",
    });
    assert.equal(listed.status, 404, `${value}: ${listed.text.slice(0, 200)}`);
    assert.equal(listed.json.code, "RECOVERY_APPROVAL_V2_HANDOVER_NOT_FOUND");
    refusals.push(listed);
  }
  // A handover that is well-formed but absent is an eligibility refusal, not a 404.
  const absent = await post(
    APPROVALS,
    requestBody({ handoverDocumentId: "handover_v2_does_not_exist" }),
    { name: "sup1" },
  );
  assert.equal(absent.status, 409, absent.text.slice(0, 300));
  assert.equal(absent.json.code, "RECOVERY_APPROVAL_V2_NOT_ELIGIBLE");
  assert.match(absent.json.error, /No equal-handover v2 aggregate exists/);
  refusals.push(absent);
  // Unparseable JSON.
  const unparsable = await call(ORIGIN, "POST", APPROVALS, {
    name: "sup1",
    rawBody: "{not json",
  });
  assert.equal(unparsable.status, 400, unparsable.text.slice(0, 200));
  refusals.push(unparsable);

  for (const response of refusals) {
    assert.equal(response.json.success, false);
    assert.equal(response.json.recoveryExecutionEligible, false, "a failure response claimed executability");
    assert.ok(!response.text.includes("Pass!"), "a refusal echoed a credential");
  }
  assert.deepEqual(touchedPaths(before, await storeFingerprint()), [], "a malformed payload wrote");
});

// ---------------------------------------------------------------------------
// 3. The happy path, bound to the live classifier
// ---------------------------------------------------------------------------

test("08 an approval binds the digest the live classifier produces over HTTP", async () => {
  await writeWorld();
  const reading = await eligibility.evaluateHandoverRecoveryEligibility({
    handoverDocumentId: HANDOVER_DOCUMENT_ID,
    actorUid: "sup1",
    now: new Date(),
  });
  assert.equal(
    reading.result.classification,
    "eligible_for_abandonment_review",
    `the seeded world is not eligible under the real clock: ${JSON.stringify(reading.result.refusals)}`,
  );

  const created = await createApproval("sup1");
  assert.equal(created.effectiveStatus, "awaiting_second_approval");
  assert.equal(created.approval.recoveryExecutionEligible, false);
  assert.equal(created.approval.nonExecutableReason.length > 0, true);
  assert.equal(created.approval.binding.evidence.evidenceDigest, reading.result.evidenceDigest.value);
  assert.equal(created.approval.binding.evidence.classification, reading.result.classification);
  assert.equal(created.approval.binding.evidence.evidenceDigestSchemaVersion, 2);

  // The read surface agrees with the write surface.
  const listed = await get(`${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`, { name: "adm1" });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.approvals.length, 1);
  assert.equal(listed.json.approvals[0].approval.id, created.approval.id);
  const single = await get(`${APPROVALS}/${created.approval.id}`, { name: "adm1" });
  assert.equal(single.status, 200);
  assert.equal(single.json.approval.approval.id, created.approval.id);
  assert.equal(single.json.recoveryExecutionEligible, false);
});

test("09 the complementary role completes the intent over HTTP", async () => {
  await writeWorld();
  const created = await createApproval("sup1");
  const approvalId = created.approval.id;

  const signed = await post(
    `${APPROVALS}/${approvalId}/approvals`,
    { expectedRevision: 1, password: PASSWORD },
    { name: "adm1" },
  );
  assert.equal(signed.status, 200, signed.text.slice(0, 400));
  assert.equal(signed.json.approval.effectiveStatus, "fully_approved");
  assert.equal(signed.json.approval.approval.approvals.length, 2);
  assert.equal(signed.json.approval.approval.recoveryExecutionEligible, false);
  assert.equal(signed.json.recoveryExecutionEligible, false);

  // The first signature is preserved verbatim. `createApproval` returns the
  // response view, so the signed record is one level below it.
  assert.deepEqual(
    signed.json.approval.approval.approvals[0],
    created.approval.approvals[0],
    "the second signature rewrote the first",
  );
  assert.notEqual(
    signed.json.approval.approval.approvals[1].proofFingerprint,
    created.approval.approvals[0].proofFingerprint,
  );
});

test("10 a fully approved intent is still not executable and wrote nothing operational", async () => {
  await writeWorld();
  const before = await storeFingerprint();
  const created = await createApproval("sup1");
  const signed = await post(
    `${APPROVALS}/${created.approval.id}/approvals`,
    { expectedRevision: 1, password: PASSWORD },
    { name: "adm1" },
  );
  assert.equal(signed.status, 200, signed.text.slice(0, 400));

  const changed = touchedPaths(before, await storeFingerprint());
  assertV2OnlyWrites(changed);
  assert.ok(
    changed.some((path) => path.startsWith(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/`)),
    "the approval was not written",
  );
  assert.ok(
    changed.some((path) => path.startsWith("audit_logs/handover_recovery_approval_v2_")),
    "no audit row was written",
  );
  assert.ok(
    !changed.includes(AGGREGATE_PATH),
    "an approval activated or abandoned the handover aggregate",
  );
  assert.ok(!changed.some((path) => path.startsWith("shifts/")), "an approval wrote a shift");
  assert.ok(
    !changed.some((path) => path.startsWith(`${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/`)),
    "a version 2 route wrote the version 1 collection",
  );

  const stored = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${created.approval.id}`);
  assert.equal(stored.recoveryExecutionEligible, false);
  assert.equal(stored.status, "fully_approved");
});

// ---------------------------------------------------------------------------
// 4. Idempotency, conflicts and staleness over HTTP
// ---------------------------------------------------------------------------

test("11 one intent has one identity: concurrent copies, replays and collisions", async () => {
  await writeWorld();
  // Two concurrent copies of a brand-new request: whatever the emulator's
  // transaction retry decides to report, the store may hold one identity only.
  const raced = await Promise.all([
    post(APPROVALS, requestBody(), { name: "sup1" }),
    post(APPROVALS, requestBody(), { name: "sup1" }),
  ]);
  for (const response of raced) {
    assert.ok(
      [200, 201, 503].includes(response.status),
      `a concurrent request answered ${response.status}: ${response.text.slice(0, 300)}`,
    );
  }
  assert.ok(
    raced.filter((response) => response.status === 201).length <= 1,
    "concurrent identical requests fabricated two approvals",
  );
  const racedIds = new Set(
    raced.filter((response) => response.json?.approval).map((r) => r.json.approval.approval.id),
  );
  assert.ok(racedIds.size <= 1, `a concurrent request forked: ${[...racedIds]}`);
  const racedDoc = await db
    .collection(HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION)
    .where("handoverDocumentId", "==", HANDOVER_DOCUMENT_ID)
    .get();
  assert.equal(racedDoc.size, 1, "concurrency produced more than one approval document");
  assert.equal(racedDoc.docs[0].data().approvals.length, 1, "concurrency signed twice");
  const approvalId = racedDoc.docs[0].id;

  // The same person asking again for the same intent replays: one document, the
  // original audit row, no second signature.
  const replay = await post(APPROVALS, requestBody(), { name: "sup1" });
  assert.equal(replay.status, 200, replay.text.slice(0, 300));
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.approval.approval.id, approvalId);
  assert.equal(replay.json.audit.state, "replayed");
  assert.equal(replay.json.approval.approval.revision, 1);

  // The intent identity is the evidence, not the requester, so another
  // supervisor who asks for the same unchanged intent collides instead of forking.
  const secondSupervisor = await post(APPROVALS, requestBody(), { name: "sup2" });
  assert.equal(secondSupervisor.status, 409, secondSupervisor.text.slice(0, 300));
  assert.equal(secondSupervisor.json.code, "RECOVERY_APPROVAL_V2_REQUEST_CONFLICT");

  // A different reason from the original requester is the same collision.
  const conflict = await post(APPROVALS, requestBody({ reason: VOID_REASON }), { name: "sup1" });
  assert.equal(conflict.status, 409, conflict.text.slice(0, 300));
  assert.equal(conflict.json.code, "RECOVERY_APPROVAL_V2_REQUEST_CONFLICT");

  const listed = await get(`${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`, { name: "sup1" });
  assert.equal(listed.json.approvals.length, 1, "one intent per distinct evidence binding");
  assert.equal(listed.json.approvals[0].approval.id, approvalId);
  assert.equal(
    listed.json.approvals[0].approval.approvals.length,
    1,
    "a replayed or conflicting request added a signature",
  );
});

test("12 a stale revision and a wrong role are refused without a signature", async () => {
  await writeWorld();
  const before = await storeFingerprint();
  const created = await createApproval("sup1");
  const approvalId = created.approval.id;

  // The same person cannot sign twice.
  const twice = await post(
    `${APPROVALS}/${approvalId}/approvals`,
    { expectedRevision: 1, password: PASSWORD },
    { name: "sup1" },
  );
  assert.equal(twice.status, 409, twice.text.slice(0, 300));
  assert.equal(twice.json.code, "RECOVERY_APPROVAL_V2_DUPLICATE_ACTOR");

  // The same role cannot complete the pair.
  const sameRole = await post(
    `${APPROVALS}/${approvalId}/approvals`,
    { expectedRevision: 1, password: PASSWORD },
    { name: "sup2" },
  );
  assert.equal(sameRole.status, 409, sameRole.text.slice(0, 300));
  assert.equal(sameRole.json.code, "RECOVERY_APPROVAL_V2_ROLE_CONFLICT");

  // A stale revision is refused.
  const stale = await post(
    `${APPROVALS}/${approvalId}/approvals`,
    { expectedRevision: 7, password: PASSWORD },
    { name: "adm1" },
  );
  assert.equal(stale.status, 409, stale.text.slice(0, 300));
  assert.equal(stale.json.code, "RECOVERY_APPROVAL_V2_STALE");

  const stored = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.equal(stored.approvals.length, 1, "a refused countersignature still signed");
  assert.equal(stored.status, "awaiting_second_approval");
  assertV2OnlyWrites(touchedPaths(before, await storeFingerprint()));
});

// ---------------------------------------------------------------------------
// 5. Void, reissue and read-time expiry
// ---------------------------------------------------------------------------

test("13 only a signer may void, and voiding is terminal", async () => {
  await writeWorld();
  const created = await createApproval("sup1");
  const approvalId = created.approval.id;

  // A live approver who never signed this intent cannot void it.
  const stranger = await post(
    `${APPROVALS}/${approvalId}/void`,
    { reason: VOID_REASON, idempotencyKey: nextKey(), password: PASSWORD },
    { name: "adm2" },
  );
  assert.equal(stranger.status, 403, stranger.text.slice(0, 300));
  assert.equal(stranger.json.code, "RECOVERY_APPROVAL_V2_ROLE_FORBIDDEN");

  const voidKey = nextKey();
  const voided = await post(
    `${APPROVALS}/${approvalId}/void`,
    { reason: VOID_REASON, idempotencyKey: voidKey, password: PASSWORD },
    { name: "sup1" },
  );
  assert.equal(voided.status, 200, voided.text.slice(0, 400));
  assert.equal(voided.json.approval.effectiveStatus, "voided");
  assert.equal(voided.json.recoveryExecutionEligible, false);

  // A signed intent can no longer be countersigned.
  const afterVoid = await post(
    `${APPROVALS}/${approvalId}/approvals`,
    { expectedRevision: 1, password: PASSWORD },
    { name: "adm1" },
  );
  assert.equal(afterVoid.status, 409, afterVoid.text.slice(0, 300));
  assert.equal(afterVoid.json.code, "RECOVERY_APPROVAL_V2_ALREADY_VOIDED");

  // The same void request replays; a fresh one collides with the tombstone.
  // Neither can move the record again.
  const sameVoid = await post(
    `${APPROVALS}/${approvalId}/void`,
    { reason: VOID_REASON, idempotencyKey: voidKey, password: PASSWORD },
    { name: "sup1" },
  );
  assert.equal(sameVoid.status, 200, sameVoid.text.slice(0, 300));
  assert.equal(sameVoid.json.replayed, true);
  assert.equal(sameVoid.json.audit.state, "replayed");

  const reVoid = await post(
    `${APPROVALS}/${approvalId}/void`,
    { reason: VOID_REASON, idempotencyKey: nextKey(), password: PASSWORD },
    { name: "sup1" },
  );
  assert.equal(reVoid.status, 409, `a fresh void on a voided intent: ${reVoid.text.slice(0, 200)}`);
  assert.equal(reVoid.json.code, "RECOVERY_APPROVAL_V2_ALREADY_VOIDED");
  assert.equal(reVoid.json.replayed, undefined);

  const stored = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.equal(stored.status, "voided");
  assert.equal(stored.voidedBy, "sup1");
  assert.equal(stored.approvals.length, 1, "a void added or removed a signature");
});

test("14 reissue mints a new identity from a voided intent", async () => {
  await writeWorld();
  const created = await createApproval("sup1");
  const approvalId = created.approval.id;

  // Only a voided intent may be reissued.
  const early = await post(
    `${APPROVALS}/${approvalId}/reissue`,
    { reason: VOID_REASON, idempotencyKey: nextKey(), password: PASSWORD },
    { name: "sup1" },
  );
  assert.equal(early.status, 409, early.text.slice(0, 300));
  assert.equal(early.json.code, "RECOVERY_APPROVAL_V2_NOT_VOIDED");

  await post(
    `${APPROVALS}/${approvalId}/void`,
    { reason: VOID_REASON, idempotencyKey: nextKey(), password: PASSWORD },
    { name: "sup1" },
  );
  const reissued = await post(
    `${APPROVALS}/${approvalId}/reissue`,
    { reason: REASON, idempotencyKey: nextKey(), password: PASSWORD },
    { name: "adm1" },
  );
  assert.equal(reissued.status, 201, reissued.text.slice(0, 400));
  const fresh = reissued.json.approval;
  assert.notEqual(fresh.approval.id, approvalId);
  assert.equal(fresh.approval.replacesApprovalId, approvalId);
  assert.equal(fresh.approval.requestedBy, "adm1");
  assert.equal(fresh.approval.approvals[0].actorRole, "admin");
  assert.equal(reissued.json.recoveryExecutionEligible, false);

  // The original is preserved as a tombstone and points at its replacement.
  const original = await readDoc(`${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`);
  assert.equal(original.status, "voided");
  assert.equal(original.reissuedAsApprovalId, fresh.approval.id);
});

test("15 expiry is derived at read time, with no write and no scheduler", async () => {
  await writeWorld();
  const created = await createApproval("sup1");
  const approvalId = created.approval.id;
  const path = `${HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION}/${approvalId}`;
  const before = await storeFingerprint();

  // Let the intent lifetime pass. Moving `expiresAt` alone would break the
  // record's canonical lifetime, so both ends of the window shift together —
  // the only way an intent legitimately ages.
  const ageMs = HANDOVER_RECOVERY_APPROVAL_V2_INTENT_MAX_AGE_MS + 60_000;
  const requestedAt = new Date(Date.parse(created.approval.requestedAt) - ageMs).toISOString();
  const expiresAt = new Date(Date.parse(created.approval.expiresAt) - ageMs).toISOString();
  await db.doc(path).update({ requestedAt, expiresAt });

  const read = await get(`${APPROVALS}/${approvalId}`, { name: "adm1" });
  assert.equal(read.status, 200);
  assert.equal(read.json.approval.effectiveStatus, "expired");
  assert.equal(read.json.approval.recoveryExecutionEligible, false);
  // The stored status is untouched: expiry is a read-time conclusion.
  const stored = await readDoc(path);
  assert.equal(stored.status, "awaiting_second_approval");
  assert.equal(stored.approvals.length, 1);

  // The list surface reaches the same conclusion as the read surface.
  const listed = await get(`${APPROVALS}?handoverDocumentId=${HANDOVER_DOCUMENT_ID}`, { name: "adm1" });
  assert.equal(listed.json.approvals[0].effectiveStatus, "expired");

  // An expired intent can no longer be signed.
  const sign = await post(
    `${APPROVALS}/${approvalId}/approvals`,
    { expectedRevision: 1, password: PASSWORD },
    { name: "adm1" },
  );
  assert.equal(sign.status, 409, sign.text.slice(0, 300));
  assert.equal(sign.json.code, "RECOVERY_APPROVAL_V2_EXPIRED");

  const after = await readDoc(path);
  assert.equal(after.approvals.length, 1, "an expired intent gained a signature");
  assert.equal(after.expiresAt, expiresAt, "a read rewrote the expiry");
  assert.equal(
    Date.parse(after.expiresAt) - Date.parse(after.requestedAt),
    HANDOVER_RECOVERY_APPROVAL_V2_INTENT_MAX_AGE_MS,
    "the aged intent lost its canonical lifetime",
  );
  assert.deepEqual(
    touchedPaths(before, await storeFingerprint()).filter((item) => item !== path),
    [],
    "deriving expiry wrote somewhere besides the test edit",
  );
});

// ---------------------------------------------------------------------------
// 6. There is no execution surface, and Version 1 stays separate
// ---------------------------------------------------------------------------

test("16 no execution endpoint exists on the version 2 surface", async () => {
  await writeWorld();
  const created = await createApproval("sup1");
  await post(
    `${APPROVALS}/${created.approval.id}/approvals`,
    { expectedRevision: 1, password: PASSWORD },
    { name: "adm1" },
  );
  const before = await storeFingerprint();

  // Under `next dev` a request to a path with no route file renders the
  // application's 404 document, which this offline sandbox cannot style; an
  // invented URL therefore proves nothing here. The Version 2 surface IS this
  // route tree — no route file, no endpoint — so the tree is enumerated and
  // compared with the five members this milestone defines.
  const routeRoot = fileURLToPath(
    new URL("../src/app/(dashboard)/api/admin/recovery-approvals-v2", import.meta.url),
  );
  const routeFiles = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (entry.isDirectory()) walk(`${directory}/${entry.name}`, `${prefix}${entry.name}/`);
      else routeFiles.push(`${prefix}${entry.name}`);
    }
  };
  walk(routeRoot, "");
  assert.deepEqual(
    routeFiles,
    [
      "[approvalId]/approvals/route.ts",
      "[approvalId]/reissue/route.ts",
      "[approvalId]/route.ts",
      "[approvalId]/void/route.ts",
      "route.ts",
    ],
    "the version 2 route family is no longer exactly request, read, countersign, void and reissue",
  );

  // The only methods this family answers with are reads and the four intent
  // operations; nothing is exported that could carry an execution.
  const handlers = new Set();
  for (const file of routeFiles) {
    const source = readFileSync(`${routeRoot}/${file}`, "utf8");
    for (const match of source.matchAll(/^export async function ([A-Z][A-Z]*)\(/gm)) {
      handlers.add(match[1]);
    }
  }
  assert.deepEqual(
    [...handlers].sort(),
    ["GET", "POST"],
    `the version 2 family answers with ${[...handlers].sort().join(", ")}`,
  );

  // Every one of the five real paths rejects the verbs it does not implement,
  // and none of them ever becomes a write.
  const probes = [
    ["PUT", APPROVALS],
    ["DELETE", APPROVALS],
    ["POST", `${APPROVALS}/${created.approval.id}`],
    ["DELETE", `${APPROVALS}/${created.approval.id}`],
    ["GET", `${APPROVALS}/${created.approval.id}/approvals`],
    ["DELETE", `${APPROVALS}/${created.approval.id}/approvals`],
    ["GET", `${APPROVALS}/${created.approval.id}/void`],
    ["DELETE", `${APPROVALS}/${created.approval.id}/void`],
    ["GET", `${APPROVALS}/${created.approval.id}/reissue`],
    ["DELETE", `${APPROVALS}/${created.approval.id}/reissue`],
  ];
  for (const [method, path] of probes) {
    // fetch refuses a body on GET/HEAD, so the read-shaped probes carry only the
    // session cookie — which is exactly what a caller would send.
    const response = await call(ORIGIN, method, path, {
      name: "sup1",
      ...(method === "GET"
        ? {}
        : { body: { reason: REASON, idempotencyKey: nextKey(), password: PASSWORD } }),
    });
    assert.ok(
      response.status === 405 || response.status === 404,
      `${method} ${path} answered ${response.status}: ${response.text.slice(0, 200)}`,
    );
    assert.ok(!response.text.includes("Pass!"), `${method} ${path} echoed a credential`);
  }

  // Even a fully approved intent reports non-executable through the read surface.
  const read = await get(`${APPROVALS}/${created.approval.id}`, { name: "sup1" });
  assert.equal(read.json.approval.approval.recoveryExecutionEligible, false);
  assert.equal(read.json.recoveryExecutionEligible, false);

  assert.deepEqual(
    touchedPaths(before, await storeFingerprint()),
    [],
    "a rejected method on the version 2 surface wrote",
  );
});

test("17 version 1 approvals are never read, migrated or rewritten", async () => {
  await writeWorld();
  const planted = await readDoc(V1_PLANT_PATH);
  const created = await createApproval("sup1");
  await post(
    `${APPROVALS}/${created.approval.id}/approvals`,
    { expectedRevision: 1, password: PASSWORD },
    { name: "adm1" },
  );
  await post(
    `${APPROVALS}/${created.approval.id}/void`,
    { reason: VOID_REASON, idempotencyKey: nextKey(), password: PASSWORD },
    { name: "sup1" },
  );

  assert.deepEqual(await readDoc(V1_PLANT_PATH), planted, "a version 2 route rewrote version 1 history");
  const v1Docs = await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION).get();
  assert.equal(v1Docs.size, 1, "a version 2 route wrote into the version 1 collection");
  const v2Docs = await db.collection(HANDOVER_RECOVERY_APPROVAL_V2_COLLECTION).get();
  assert.equal(v2Docs.size, 1);
  for (const document of v2Docs.docs) {
    assert.equal(document.data().schema, "handover-recovery-approval-v2");
    assert.equal(document.data().recoveryExecutionEligible, false);
  }
});
