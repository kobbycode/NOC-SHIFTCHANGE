/**
 * Phase 8C.3 — §2 real-HTTP verification of the five existing 8C.2b approval
 * route families (List, Create, Read, Countersign, Void, Reissue).
 *
 * Runs INSIDE tests/run-recovery-approval-http.mjs (which runs inside
 * `firebase emulators:exec`), so it talks to two real Next.js servers over the
 * disposable Firestore/Auth emulators of project "demo-admin-review-8b":
 *
 *   - RECOVERY_APPROVAL_HTTP_ORIGIN           HANDOVER_V2_DEV=true
 *   - RECOVERY_APPROVAL_HTTP_ORIGIN_DISABLED  HANDOVER_V2_DEV unset
 *
 * It proves, over authenticated HTTP rather than through service seams:
 *   - session identity cannot be claimed from a request body;
 *   - role, disabled-account and mandatory-password-change enforcement;
 *   - same-origin protection on every mutating route;
 *   - malformed payload, stale-binding, expiry and response contracts;
 *   - every Version 1 approval record and audit row stays non-executable;
 *   - replay and concurrency cannot fabricate a second state;
 *   - no operational collection is written by any route.
 *
 * No operational recovery route or executable approval exists anywhere in this
 * suite: it only creates, reads, countersigns, voids and reissues V1 intents.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const ORIGIN = process.env.RECOVERY_APPROVAL_HTTP_ORIGIN;
const ORIGIN_DISABLED = process.env.RECOVERY_APPROVAL_HTTP_ORIGIN_DISABLED;
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
  process.env.HANDOVER_V2_DEV !== "true"
) {
  throw new Error("Refusing to run recovery approval HTTP tests outside the isolated HTTP emulator stack.");
}

const emulatorProbe = await fetch(`http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents`);
assert.ok([200, 403, 404].includes(emulatorProbe.status), `Emulator probe failed: ${emulatorProbe.status}`);
const authProbe = await fetch(`http://${authHost}/`, { signal: AbortSignal.timeout(60_000) });
assert.ok(authProbe.status < 500, `Auth emulator probe failed: ${authProbe.status}`);

const { getAdminFirestore, getAdminAuth } = await import("../src/lib/firebase/admin/index.ts");
const { createEqualHandover, createEqualHandoverDocumentId } = await import(
  "../src/lib/operations/equal-technician-handover-domain.ts"
);
const { createInitialReservationGuard } = await import(
  "../src/lib/operations/handover-reservation-guard-domain.ts"
);
const { createHandoverReviewCaseId } = await import(
  "../src/lib/operations/handover-admin-review-domain.ts"
);
const {
  HANDOVER_RECOVERY_APPROVAL_COLLECTION,
  HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
} = await import("../src/types/handover-recovery-approval.ts");

const db = getAdminFirestore();
const auth = getAdminAuth();

const AT = "2026-11-01T09:00:00.000Z";
const END = "2026-11-01T17:00:00.000Z";
const REASON = "Recover the stalled outgoing handover after review.";
const VOID_REASON = "The handover state moved before the second approval.";

const USERS = {
  "sup-1": { role: "supervisor", password: "R8c3-sup-1-Pass!", fullName: "Supervisor One" },
  "sup-2": { role: "supervisor", password: "R8c3-sup-2-Pass!", fullName: "Supervisor Two" },
  "adm-1": { role: "admin", password: "R8c3-adm-1-Pass!", fullName: "Admin One" },
  "adm-2": { role: "admin", password: "R8c3-adm-2-Pass!", fullName: "Admin Two" },
  "tech-1": { role: "technician", password: "R8c3-tech-1-Pass!", fullName: "Technician One" },
  "pw-admin": {
    role: "admin",
    password: "R8c3-pw-admin-Pass!",
    fullName: "Password Admin",
    mustChangePassword: true,
  },
};

const OPERATIONAL_COLLECTIONS = [
  "users",
  "handovers",
  "equal_handovers_v2",
  "handover_reservation_guards",
  "handover_reservation_guard_history",
  "handover_review_cases_v1",
  "handover_review_decisions_v1",
  "handover_reviews_v1",
  "handover_reports_v2",
  "handover_report_preparations_v2",
  "incoming_acceptance_applications_v1",
  "attendance_evidence_v2",
  "attendance_evidence_operations_v2",
  "shift_members",
  "shift_attendance",
  "shifts",
  "shift_joins",
  "operational_shift_control",
  "technician_schedules",
  "technician_pairs",
  "technician_pair_memberships",
  "notifications",
  "notification_outbox",
];

const LIST_PATH = (documentId) => `/api/admin/recovery-approvals?handoverDocumentId=${encodeURIComponent(documentId)}`;
const COLLECTION_PATH = "/api/admin/recovery-approvals";
const READ_PATH = (approvalId) => `/api/admin/recovery-approvals/${encodeURIComponent(approvalId)}`;
const COUNTERSIGN_PATH = (approvalId) =>
  `/api/admin/recovery-approvals/${encodeURIComponent(approvalId)}/approvals`;
const VOID_PATH = (approvalId) => `/api/admin/recovery-approvals/${encodeURIComponent(approvalId)}/void`;
const REISSUE_PATH = (approvalId) => `/api/admin/recovery-approvals/${encodeURIComponent(approvalId)}/reissue`;

const PROBE_APPROVAL_ID = "handover_recovery_approval_v1_probe";

function emailFor(uid) {
  return `${uid}@recovery-http.test`;
}

function uuid(seed) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Disposable stack preparation
// ---------------------------------------------------------------------------

async function ensureAuthUsers() {
  for (const [uid, user] of Object.entries(USERS)) {
    try {
      await auth.getUser(uid);
    } catch {
      await auth.createUser({ uid, email: emailFor(uid), password: user.password, emailVerified: true });
    }
    await auth.setCustomUserClaims(uid, { role: user.role });
    await auth.updateUser(uid, { disabled: false });
  }
}

async function clearDatabase() {
  const cleared = await fetch(
    `http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200, "The isolated emulator database could not be cleared.");
}

async function seedUsers() {
  let batch = db.batch();
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

const sessionCache = new Map();

async function sessionFor(uid) {
  if (sessionCache.has(uid)) return sessionCache.get(uid);
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "synthetic-recovery-approval-http-key",
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

let handoverSequence = 0;

async function seedHandover() {
  const key = `h${String(++handoverSequence).padStart(3, "0")}`;
  const outgoingShiftId = `outgoing_${key}`;
  const incomingShiftId = `incoming_${key}`;
  const identity = {
    schema: "equal-handover-v2",
    outgoingShiftId,
    outgoingPermanentPairId: `pair_out_${key}`,
    outgoingTechnicianIds: [`tech_out_a_${key}`, `tech_out_b_${key}`],
    outgoingSlotToken: uuid(`outgoing:${key}`),
    outgoingGeneration: 1,
    incomingShiftId,
    incomingPermanentPairId: `pair_in_${key}`,
    incomingTechnicianIds: [`tech_in_a_${key}`, `tech_in_b_${key}`],
    successorSlotToken: uuid(`successor:${key}`),
    successorGeneration: 2,
    shiftType: "morning",
    scheduledStart: AT,
    scheduledEnd: END,
  };
  const aggregate = createEqualHandover({ identity, reservedAt: AT, reservedBy: "sup-1" });
  const handoverDocumentId = createEqualHandoverDocumentId(outgoingShiftId);
  const guard = createInitialReservationGuard({
    outgoingShiftId,
    protocolOwner: "v2",
    ownerHandoverDocumentId: handoverDocumentId,
    outgoingSlotToken: identity.outgoingSlotToken,
    outgoingGeneration: identity.outgoingGeneration,
    successorSlotToken: identity.successorSlotToken,
    successorGeneration: identity.successorGeneration,
    reservationId: uuid(`reservation:${key}`),
    reservedIncomingShiftId: incomingShiftId,
    reservedAt: AT,
    reservedBy: "sup-1",
  });

  await db.doc(`equal_handovers_v2/${handoverDocumentId}`).set(aggregate);
  await db.doc(`handover_reservation_guards/${guard.id}`).set(guard);

  return { key, outgoingShiftId, incomingShiftId, handoverDocumentId };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const capturedResponses = [];

async function call(method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (!("origin" in options)) headers.Origin = ORIGIN;
  else if (options.origin !== null) headers.Origin = options.origin;
  if (options.cookie) headers.Cookie = options.cookie;

  let payload;
  if (options.rawBody !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = options.rawBody;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(options.body);
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
    // Non-JSON bodies are only expected from the V2-disabled server (404 page).
  }
  return { status: response.status, text, json, headers: response.headers };
}

function assertNonExecutable(value, where = "response") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNonExecutable(item, `${where}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "recoveryExecutionEligible") {
        assert.equal(item, false, `${where}.recoveryExecutionEligible must stay false`);
      }
      assertNonExecutable(item, `${where}.${key}`);
    }
  }
}

function assertNoStore(response) {
  assert.match(
    String(response.headers.get("cache-control") ?? ""),
    /no-store/,
    "approval responses must never be cached",
  );
}

function assertFailureStatus(response, status) {
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${response.text.slice(0, 200)}`);
  assert.equal(response.json?.success, false);
  assert.equal(response.json?.recoveryExecutionEligible, false);
  assertNonExecutable(response.json);
}

async function approvalIdsFor(handoverDocumentId) {
  const snapshot = await db
    .collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION)
    .where("handoverDocumentId", "==", handoverDocumentId)
    .get();
  return snapshot.docs.map((document) => document.id);
}

async function auditRowsFor(approvalId) {
  const snapshot = await db.collection("audit_logs").where("approvalId", "==", approvalId).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

async function operationalFingerprint() {
  const parts = [];
  for (const collection of OPERATIONAL_COLLECTIONS) {
    const snapshot = await db.collection(collection).get();
    for (const document of snapshot.docs) {
      parts.push(`${document.ref.path}=${JSON.stringify(document.data())}`);
    }
  }
  return createHash("sha256").update(parts.sort().join("\n")).digest("hex");
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
        `credential field ${location}.${key} must never be returned or stored`,
      );
      assertNoCredentialKeys(item, `${location}.${key}`);
    }
  }
}

function createBody(world, overrides = {}) {
  return {
    handoverDocumentId: world.handoverDocumentId,
    reason: REASON,
    idempotencyKey: `create_${world.key}`,
    password: USERS["sup-1"].password,
    ...overrides,
  };
}

async function createApproval(world, actor = "sup-1", overrides = {}) {
  const response = await call("POST", COLLECTION_PATH, {
    cookie: await sessionFor(actor),
    body: createBody(world, { password: USERS[actor].password, ...overrides }),
  });
  return response;
}

// ---------------------------------------------------------------------------
// 1. Boundary: unauthenticated access and routing
// ---------------------------------------------------------------------------

test("01 every route family refuses an unauthenticated caller with 401", async () => {
  await clearDatabase();
  await ensureAuthUsers();
  await seedUsers();

  const probes = [
    ["GET", LIST_PATH("handover_v2_probe")],
    ["GET", READ_PATH(PROBE_APPROVAL_ID)],
    ["POST", COLLECTION_PATH, {}],
    ["POST", COUNTERSIGN_PATH(PROBE_APPROVAL_ID), {}],
    ["POST", VOID_PATH(PROBE_APPROVAL_ID), {}],
    ["POST", REISSUE_PATH(PROBE_APPROVAL_ID), {}],
  ];
  for (const [method, path, body] of probes) {
    const response = await call(method, path, { body });
    assertFailureStatus(response, 401);
    assertNoStore(response);
  }
});

test("02 a technician session is refused on every route family with 403", async () => {
  const cookie = await sessionFor("tech-1");
  const world = await seedHandover();
  const probes = [
    ["GET", LIST_PATH(world.handoverDocumentId)],
    ["GET", READ_PATH(PROBE_APPROVAL_ID)],
    ["POST", COLLECTION_PATH, createBody(world, { password: USERS["tech-1"].password })],
    ["POST", COUNTERSIGN_PATH(PROBE_APPROVAL_ID), { expectedRevision: 1, password: USERS["tech-1"].password }],
    ["POST", VOID_PATH(PROBE_APPROVAL_ID), { reason: VOID_REASON, idempotencyKey: "void_tech_1", password: USERS["tech-1"].password }],
    ["POST", REISSUE_PATH(PROBE_APPROVAL_ID), { reason: REASON, idempotencyKey: "reissue_tech_1", password: USERS["tech-1"].password }],
  ];
  for (const [method, path, body] of probes) {
    assertFailureStatus(await call(method, path, { cookie, body }), 403);
  }
  assert.equal((await approvalIdsFor(world.handoverDocumentId)).length, 0);
});

test("03 an account that must change its password is refused with 403", async () => {
  const cookie = await sessionFor("pw-admin");
  assertFailureStatus(await call("GET", LIST_PATH("handover_v2_probe"), { cookie }), 403);
  const world = await seedHandover();
  assertFailureStatus(
    await call("POST", COLLECTION_PATH, {
      cookie,
      body: createBody(world, { password: USERS["pw-admin"].password }),
    }),
    403,
  );
  assert.equal((await approvalIdsFor(world.handoverDocumentId)).length, 0);
});

test("04 a disabled or suspended account loses every route immediately", async () => {
  const cookie = await sessionFor("adm-2");
  const world = await seedHandover();

  const healthy = await call("GET", LIST_PATH(world.handoverDocumentId), { cookie });
  assert.equal(healthy.status, 200);

  await auth.updateUser("adm-2", { disabled: true });
  try {
    assertFailureStatus(await call("GET", LIST_PATH(world.handoverDocumentId), { cookie }), 401);
    assertFailureStatus(
      await call("POST", COLLECTION_PATH, {
        cookie,
        body: createBody(world, { password: USERS["adm-2"].password }),
      }),
      401,
    );
    assert.equal((await approvalIdsFor(world.handoverDocumentId)).length, 0);
  } finally {
    await auth.updateUser("adm-2", { disabled: false });
  }

  assert.equal((await call("GET", LIST_PATH(world.handoverDocumentId), { cookie })).status, 200);

  await db.doc("users/adm-2").update({ status: "suspended" });
  try {
    assertFailureStatus(await call("GET", LIST_PATH(world.handoverDocumentId), { cookie }), 401);
  } finally {
    await db.doc("users/adm-2").update({ status: "active", statusOperation: null });
  }

  assert.equal((await call("GET", LIST_PATH(world.handoverDocumentId), { cookie })).status, 200);
});

// ---------------------------------------------------------------------------
// 2. Same-origin and payload validation
// ---------------------------------------------------------------------------

test("05 every mutating route refuses a foreign, missing or null origin", async () => {
  const cookie = await sessionFor("sup-1");
  const world = await seedHandover();
  const before = await operationalFingerprint();

  for (const origin of ["http://evil.example", null, "null"]) {
    assertFailureStatus(
      await call("POST", COLLECTION_PATH, { cookie, body: createBody(world), origin }),
      403,
    );
  }
  assert.equal((await approvalIdsFor(world.handoverDocumentId)).length, 0);
  assert.equal(await operationalFingerprint(), before);

  // The same body with the correct origin is authorized and reaches password
  // verification, proving the origin gate is the only thing that refused above.
  const wrongPassword = await call("POST", COLLECTION_PATH, {
    cookie,
    body: createBody(world, { password: "definitely-not-the-password" }),
  });
  assertFailureStatus(wrongPassword, 400);
  assert.equal(wrongPassword.json.code, "CREDENTIAL_REJECTED");
});

test("06 malformed payloads and identities are refused with 400", async () => {
  const cookie = await sessionFor("sup-1");
  const world = await seedHandover();
  const before = await operationalFingerprint();

  const attempts = [
    ["POST", COLLECTION_PATH, { cookie, rawBody: "{" }],
    ["POST", COLLECTION_PATH, { cookie, body: [] }],
    ["POST", COLLECTION_PATH, { cookie, body: { ...createBody(world), extra: true } }],
    ["POST", COLLECTION_PATH, { cookie, body: { handoverDocumentId: world.handoverDocumentId, reason: REASON, idempotencyKey: "create_x1_x2" } }],
    ["POST", COLLECTION_PATH, { cookie, body: createBody(world, { reason: "short" }) }],
    ["POST", COLLECTION_PATH, { cookie, body: createBody(world, { idempotencyKey: "bad key" }) }],
    ["POST", COLLECTION_PATH, { cookie, body: createBody(world, { handoverDocumentId: "not-a-handover" }) }],
    ["POST", COLLECTION_PATH, { cookie, body: createBody(world, { password: 1234 }) }],
    ["GET", READ_PATH("not-an-approval"), { cookie }],
    ["GET", "/api/admin/recovery-approvals", { cookie }],
    ["GET", "/api/admin/recovery-approvals?handoverDocumentId=bad", { cookie }],
    ["POST", COUNTERSIGN_PATH(PROBE_APPROVAL_ID), { cookie, body: { expectedRevision: "1", password: "x" } }],
    ["POST", COUNTERSIGN_PATH(PROBE_APPROVAL_ID), { cookie, body: { expectedRevision: 0, password: "x" } }],
    ["POST", VOID_PATH(PROBE_APPROVAL_ID), { cookie, body: { reason: "short", idempotencyKey: "void_x1", password: "x" } }],
    ["POST", REISSUE_PATH(PROBE_APPROVAL_ID), { cookie, body: { reason: REASON, idempotencyKey: "re_x1", password: "x", extra: 1 } }],
    ["POST", REISSUE_PATH(PROBE_APPROVAL_ID), { cookie, rawBody: "[1,2,3]" }],
  ];
  for (const [method, path, options] of attempts) {
    assertFailureStatus(await call(method, path, options), 400);
  }
  assert.equal((await approvalIdsFor(world.handoverDocumentId)).length, 0);
  assert.equal(await operationalFingerprint(), before);
});

// ---------------------------------------------------------------------------
// 3. Create: contract, replay, ordering
// ---------------------------------------------------------------------------

test("07 the requester records exactly one non-executable approval and one audit", async () => {
  const world = await seedHandover();
  const before = await operationalFingerprint();
  const response = await createApproval(world);

  assert.equal(response.status, 201, response.text.slice(0, 300));
  assert.equal(response.json.success, true);
  assert.equal(response.json.replayed, false);
  assert.equal(response.json.audit.state, "recorded");
  assert.equal(response.json.recoveryExecutionEligible, false);
  assertNoStore(response);
  assertNonExecutable(response.json);

  const view = response.json.approval;
  assert.equal(view.recoveryExecutionEligible, false);
  assert.equal(view.effectiveStatus, "awaiting_second_approval");
  assert.equal(view.approvalCount, 1);
  assert.equal(view.requiredSecondRole, "admin");
  const record = view.approval;
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.action, "abandon_stalled_handover");
  assert.equal(record.handoverDocumentId, world.handoverDocumentId);
  assert.equal(record.outgoingShiftId, world.outgoingShiftId);
  assert.equal(record.incomingShiftId, world.incomingShiftId);
  assert.equal(record.requestedBy, "sup-1");
  assert.equal(record.status, "awaiting_second_approval");
  assert.equal(record.revision, 1);
  assert.equal(record.approvals.length, 1);
  assert.equal(record.approvals[0].actorUid, "sup-1");
  assert.equal(record.approvals[0].actorRole, "supervisor");
  assert.equal(record.recoveryExecutionEligible, false);
  assert.equal(record.nonExecutableReason, HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON);

  const ids = await approvalIdsFor(world.handoverDocumentId);
  assert.deepEqual(ids, [record.id]);
  const audits = await auditRowsFor(record.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "HANDOVER_RECOVERY_APPROVAL_REQUESTED");
  assert.equal(audits[0].recoveryExecutionEligible, false);
  assert.equal(audits[0].actorUid, "sup-1");

  // Nothing operational changed: the only new documents are the approval intent
  // and its audit row.
  assert.equal(await operationalFingerprint(), before);
});

test("08 an identical repeat is a write-free replay of the same intent", async () => {
  const world = await seedHandover();
  const first = await createApproval(world);
  assert.equal(first.status, 201);
  const approvalId = first.json.approval.approval.id;
  const before = await operationalFingerprint();

  const replay = await createApproval(world);
  assert.equal(replay.status, 200, replay.text.slice(0, 300));
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.audit.state, "replayed");
  assert.equal(replay.json.approval.approval.id, approvalId);
  assert.equal(replay.json.recoveryExecutionEligible, false);

  assert.deepEqual(await approvalIdsFor(world.handoverDocumentId), [approvalId]);
  assert.equal((await auditRowsFor(approvalId)).length, 1);
  assert.equal(await operationalFingerprint(), before);
});

// ---------------------------------------------------------------------------
// 4. List and Read: authenticated, read-only
// ---------------------------------------------------------------------------

test("09 List returns only this handover's intents, sorted, read-only", async () => {
  const world = await seedHandover();
  const other = await seedHandover();
  const first = await createApproval(world);
  assert.equal(first.status, 201);

  // A second person cannot fork the same intent (test 19), so the second
  // intent for this handover is produced by a genuine binding change.
  await db.doc(`handover_review_cases_v1/${createHandoverReviewCaseId(world.handoverDocumentId)}`).set({
    schema: "handover-admin-review-case-v1",
    id: createHandoverReviewCaseId(world.handoverDocumentId),
    handoverDocumentId: world.handoverDocumentId,
    status: "open",
    caseRevision: 1,
    fingerprintAtLastDecision: "b".repeat(64),
    openedAt: AT,
    updatedAt: AT,
  });
  const second = await createApproval(world, "sup-2");
  assert.equal(second.status, 201, second.text.slice(0, 300));

  const before = await operationalFingerprint();
  const cookie = await sessionFor("adm-1");
  const listed = await call("GET", LIST_PATH(world.handoverDocumentId), { cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.success, true);
  assert.equal(listed.json.recoveryExecutionEligible, false);
  assertNoStore(listed);
  assertNonExecutable(listed.json);

  const ids = listed.json.approvals.map((view) => view.approval.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes(first.json.approval.approval.id));
  assert.ok(ids.includes(second.json.approval.approval.id));
  const expectedOrder = [...listed.json.approvals]
    .sort((left, right) =>
      left.approval.requestedAt === right.approval.requestedAt
        ? left.approval.id.localeCompare(right.approval.id)
        : left.approval.requestedAt.localeCompare(right.approval.requestedAt),
    )
    .map((view) => view.approval.id);
  assert.deepEqual(ids, expectedOrder);
  assert.equal((await call("GET", LIST_PATH(other.handoverDocumentId), { cookie })).json.approvals.length, 0);
  assert.equal((await call("GET", LIST_PATH("handover_v2_unknown"), { cookie })).json.approvals.length, 0);
  assert.equal(await operationalFingerprint(), before);
  assert.equal((await auditRowsFor(first.json.approval.approval.id)).length, 1);
  assert.equal((await auditRowsFor(second.json.approval.approval.id)).length, 1);
});

test("10 Read returns one view, 404 for a missing id and 400 for an invalid id", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;
  const cookie = await sessionFor("sup-1");
  const before = await operationalFingerprint();

  const read = await call("GET", READ_PATH(approvalId), { cookie });
  assert.equal(read.status, 200);
  assert.equal(read.json.approval.approval.id, approvalId);
  assert.equal(read.json.approval.effectiveStatus, "awaiting_second_approval");
  assert.equal(read.json.recoveryExecutionEligible, false);
  assertNoStore(read);

  assertFailureStatus(await call("GET", READ_PATH("handover_recovery_approval_v1_missing"), { cookie }), 404);
  assertFailureStatus(await call("GET", READ_PATH("not-an-approval"), { cookie }), 400);
  assert.equal(await operationalFingerprint(), before);
});

// ---------------------------------------------------------------------------
// 5. Countersign
// ---------------------------------------------------------------------------

test("11 the complementary role completes the pair; every other second signature is refused", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;
  const firstSignature = created.json.approval.approval.approvals[0];

  const duplicate = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: await sessionFor("sup-1"),
    body: { expectedRevision: 1, password: USERS["sup-1"].password },
  });
  assertFailureStatus(duplicate, 409);
  assert.equal(duplicate.json.code, "RECOVERY_APPROVAL_DUPLICATE_ACTOR");

  const wrongRole = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: await sessionFor("sup-2"),
    body: { expectedRevision: 1, password: USERS["sup-2"].password },
  });
  assertFailureStatus(wrongRole, 409);
  assert.equal(wrongRole.json.code, "RECOVERY_APPROVAL_ROLE_CONFLICT");

  const staleRevision = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { expectedRevision: 2, password: USERS["adm-1"].password },
  });
  assertFailureStatus(staleRevision, 409);
  assert.equal(staleRevision.json.code, "RECOVERY_APPROVAL_STALE");

  const before = await operationalFingerprint();
  const countersigned = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { expectedRevision: 1, password: USERS["adm-1"].password },
  });
  assert.equal(countersigned.status, 200, countersigned.text.slice(0, 300));
  assert.equal(countersigned.json.success, true);
  assert.equal(countersigned.json.replayed, false);
  assert.equal(countersigned.json.recoveryExecutionEligible, false);
  assertNoStore(countersigned);

  const view = countersigned.json.approval;
  assert.equal(view.effectiveStatus, "fully_approved");
  assert.equal(view.approvalCount, 2);
  assert.equal(view.requiredSecondRole, null);
  assert.equal(view.approval.status, "fully_approved");
  assert.equal(view.approval.revision, 2);
  assert.deepEqual(view.approval.approvals[0], firstSignature);
  assert.equal(view.approval.approvals[1].actorUid, "adm-1");
  assert.equal(view.approval.approvals[1].actorRole, "admin");
  assert.equal(view.approval.recoveryExecutionEligible, false);

  assert.equal((await auditRowsFor(approvalId)).length, 2);
  assert.equal(await operationalFingerprint(), before);
});

test("12 a repeated countersignature by the same person is a write-free replay", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;
  const adminCookie = await sessionFor("adm-1");
  const first = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: adminCookie,
    body: { expectedRevision: 1, password: USERS["adm-1"].password },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.replayed, false);

  const before = await operationalFingerprint();
  const replay = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: adminCookie,
    body: { expectedRevision: 2, password: USERS["adm-1"].password },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.recoveryExecutionEligible, false);
  assert.deepEqual(replay.json.approval.approval.approvals, first.json.approval.approval.approvals);
  assert.equal((await auditRowsFor(approvalId)).length, 2);
  assert.equal(await operationalFingerprint(), before);
});

test("13 Read projects the completed pair without making it executable", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;
  await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { expectedRevision: 1, password: USERS["adm-1"].password },
  });

  const read = await call("GET", READ_PATH(approvalId), { cookie: await sessionFor("sup-2") });
  assert.equal(read.status, 200);
  assert.equal(read.json.approval.approvalCount, 2);
  assert.equal(read.json.approval.effectiveStatus, "fully_approved");
  assert.equal(read.json.approval.requiredSecondRole, null);
  assert.equal(read.json.approval.recoveryExecutionEligible, false);
  assert.equal(read.json.approval.approval.recoveryExecutionEligible, false);
  assert.equal(
    read.json.approval.approval.nonExecutableReason,
    HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON,
  );
});

test("14 a moved binding refuses the second signature instead of rebinding", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;
  const reviewCase = {
    schema: "handover-admin-review-case-v1",
    id: createHandoverReviewCaseId(world.handoverDocumentId),
    handoverDocumentId: world.handoverDocumentId,
    status: "open",
    caseRevision: 1,
    fingerprintAtLastDecision: "a".repeat(64),
    openedAt: AT,
    updatedAt: AT,
  };
  await db.doc(`handover_review_cases_v1/${reviewCase.id}`).set(reviewCase);

  const stale = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { expectedRevision: 1, password: USERS["adm-1"].password },
  });
  assertFailureStatus(stale, 409);
  assert.equal(stale.json.code, "RECOVERY_APPROVAL_STALE");
  assert.equal((await db.doc(`${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/${approvalId}`).get()).data().status, "awaiting_second_approval");
  assert.equal((await auditRowsFor(approvalId)).length, 1);

  const voided = await call("POST", VOID_PATH(approvalId), {
    cookie: await sessionFor("sup-1"),
    body: { reason: VOID_REASON, idempotencyKey: `void_moved_${world.key}`, password: USERS["sup-1"].password },
  });
  assert.equal(voided.status, 200);

  const reissued = await call("POST", REISSUE_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { reason: REASON, idempotencyKey: `reissue_moved_${world.key}`, password: USERS["adm-1"].password },
  });
  assert.equal(reissued.status, 201, reissued.text.slice(0, 300));
  assert.equal(reissued.json.approval.approval.binding.reviewCaseStatus, "open");
  assert.equal(reissued.json.approval.approval.binding.reviewCaseRevision, 1);
  assert.notEqual(
    reissued.json.approval.approval.intentFingerprint,
    created.json.approval.approval.intentFingerprint,
  );
  assert.equal(reissued.json.recoveryExecutionEligible, false);
});

test("15 an expired intent is displayed as expired and refuses countersignature", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;

  const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const recently = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.doc(`${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/${approvalId}`).update({
    requestedAt: longAgo,
    createdAt: longAgo,
    expiresAt: recently,
    updatedAt: longAgo,
  });

  const read = await call("GET", READ_PATH(approvalId), { cookie: await sessionFor("sup-1") });
  assert.equal(read.status, 200);
  assert.equal(read.json.approval.effectiveStatus, "expired");
  assert.equal(read.json.approval.recoveryExecutionEligible, false);

  const expired = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { expectedRevision: 1, password: USERS["adm-1"].password },
  });
  assertFailureStatus(expired, 409);
  assert.equal(expired.json.code, "RECOVERY_APPROVAL_EXPIRED");

  // Voiding stays available to an approver as a terminal act, and reissue
  // mints a fresh, live identity rather than resurrecting the expired one.
  const voided = await call("POST", VOID_PATH(approvalId), {
    cookie: await sessionFor("sup-1"),
    body: { reason: VOID_REASON, idempotencyKey: `void_expired_${world.key}`, password: USERS["sup-1"].password },
  });
  assert.equal(voided.status, 200);
  assert.equal(voided.json.approval.effectiveStatus, "voided");

  const reissued = await call("POST", REISSUE_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { reason: REASON, idempotencyKey: `reissue_expired_${world.key}`, password: USERS["adm-1"].password },
  });
  assert.equal(reissued.status, 201);
  assert.notEqual(reissued.json.approval.approval.id, approvalId);
  assert.equal(reissued.json.approval.effectiveStatus, "awaiting_second_approval");
  assert.equal(reissued.json.approval.approval.replacesApprovalId, approvalId);
});

// ---------------------------------------------------------------------------
// 6. Void and Reissue
// ---------------------------------------------------------------------------

test("16 only a person who signed may void, once, and the intent stays terminal", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;

  for (const actor of ["adm-2", "sup-2"]) {
    const refused = await call("POST", VOID_PATH(approvalId), {
      cookie: await sessionFor(actor),
      body: { reason: VOID_REASON, idempotencyKey: `void_by_${actor}_${world.key}`, password: USERS[actor].password },
    });
    assertFailureStatus(refused, 403);
    assert.equal(refused.json.code, "RECOVERY_APPROVAL_ROLE_FORBIDDEN");
  }

  const before = await operationalFingerprint();
  const voidKey = `void_once_${world.key}`;
  const voided = await call("POST", VOID_PATH(approvalId), {
    cookie: await sessionFor("sup-1"),
    body: { reason: VOID_REASON, idempotencyKey: voidKey, password: USERS["sup-1"].password },
  });
  assert.equal(voided.status, 200, voided.text.slice(0, 300));
  assert.equal(voided.json.replayed, false);
  assert.equal(voided.json.approval.effectiveStatus, "voided");
  assert.equal(voided.json.approval.approval.voidedBy, "sup-1");
  assert.equal(voided.json.recoveryExecutionEligible, false);

  const replay = await call("POST", VOID_PATH(approvalId), {
    cookie: await sessionFor("sup-1"),
    body: { reason: VOID_REASON, idempotencyKey: voidKey, password: USERS["sup-1"].password },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);

  const secondVoid = await call("POST", VOID_PATH(approvalId), {
    cookie: await sessionFor("sup-1"),
    body: { reason: VOID_REASON, idempotencyKey: `void_twice_${world.key}`, password: USERS["sup-1"].password },
  });
  assertFailureStatus(secondVoid, 409);
  assert.equal(secondVoid.json.code, "RECOVERY_APPROVAL_ALREADY_VOIDED");

  const lateCountersign = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { expectedRevision: 1, password: USERS["adm-1"].password },
  });
  assertFailureStatus(lateCountersign, 409);
  assert.equal(lateCountersign.json.code, "RECOVERY_APPROVAL_ALREADY_VOIDED");

  const repeatRequest = await createApproval(world);
  assertFailureStatus(repeatRequest, 409);
  assert.equal(repeatRequest.json.code, "RECOVERY_APPROVAL_ALREADY_VOIDED");

  assert.equal(await operationalFingerprint(), before);
  // Requested and voided only: the replay, the second void, the refused
  // countersignature and the repeated request each wrote nothing.
  assert.equal((await auditRowsFor(approvalId)).length, 2);
});

test("17 reissue requires a voided original, preserves it and never rewrites it", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;

  const premature = await call("POST", REISSUE_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { reason: REASON, idempotencyKey: `reissue_premature_${world.key}`, password: USERS["adm-1"].password },
  });
  assertFailureStatus(premature, 409);
  assert.equal(premature.json.code, "RECOVERY_APPROVAL_NOT_VOIDED");

  const voided = await call("POST", VOID_PATH(approvalId), {
    cookie: await sessionFor("sup-1"),
    body: { reason: VOID_REASON, idempotencyKey: `void_for_reissue_${world.key}`, password: USERS["sup-1"].password },
  });
  assert.equal(voided.status, 200);

  const key = `reissue_once_${world.key}`;
  const reissued = await call("POST", REISSUE_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { reason: REASON, idempotencyKey: key, password: USERS["adm-1"].password },
  });
  assert.equal(reissued.status, 201, reissued.text.slice(0, 300));
  const newId = reissued.json.approval.approval.id;
  assert.notEqual(newId, approvalId);
  assert.equal(reissued.json.approval.approval.replacesApprovalId, approvalId);
  assert.equal(reissued.json.approval.approval.revision, 1);
  assert.equal(reissued.json.approval.approval.recoveryExecutionEligible, false);

  const original = (await db.doc(`${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/${approvalId}`).get()).data();
  assert.equal(original.status, "voided");
  assert.equal(original.reissuedAsApprovalId, newId);
  assert.equal(original.approvals.length, 1);

  const replay = await call("POST", REISSUE_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { reason: REASON, idempotencyKey: key, password: USERS["adm-1"].password },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.approval.approval.id, newId);

  const secondReissue = await call("POST", REISSUE_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { reason: REASON, idempotencyKey: `reissue_second_${world.key}`, password: USERS["adm-1"].password },
  });
  assertFailureStatus(secondReissue, 409);
  assert.equal(secondReissue.json.code, "RECOVERY_APPROVAL_ALREADY_REISSUED");
});

// ---------------------------------------------------------------------------
// 7. Identity binding and request conflicts
// ---------------------------------------------------------------------------

test("18 the authenticated session, never the body, decides who is acting", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;
  const sup1Cookie = await sessionFor("sup-1");

  const mismatchedPassword = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: sup1Cookie,
    body: { expectedRevision: 1, password: USERS["adm-1"].password },
  });
  assertFailureStatus(mismatchedPassword, 400);
  assert.equal(mismatchedPassword.json.code, "CREDENTIAL_REJECTED");

  const claimedActor = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: sup1Cookie,
    body: { expectedRevision: 1, password: USERS["sup-1"].password, actorUid: "adm-1", actorRole: "admin" },
  });
  assertFailureStatus(claimedActor, 400);

  const claimedRequester = await call("POST", COLLECTION_PATH, {
    cookie: await sessionFor("adm-1"),
    body: { ...createBody(world), requestedBy: "someone-else" },
  });
  assertFailureStatus(claimedRequester, 400);

  const stored = (await db.doc(`${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/${approvalId}`).get()).data();
  assert.deepEqual(stored.approvals.map((signature) => signature.actorUid), ["sup-1"]);
  assert.equal(stored.status, "awaiting_second_approval");
});

test("19 a second person cannot overwrite or fork the existing intent", async () => {
  const world = await seedHandover();
  const first = await createApproval(world);
  assert.equal(first.status, 201);
  const before = await operationalFingerprint();

  const conflict = await call("POST", COLLECTION_PATH, {
    cookie: await sessionFor("sup-2"),
    body: createBody(world, { reason: `${REASON} (second reviewer)`, idempotencyKey: `create_conflict_${world.key}`, password: USERS["sup-2"].password }),
  });
  assertFailureStatus(conflict, 409);
  assert.equal(conflict.json.code, "RECOVERY_APPROVAL_REQUEST_CONFLICT");
  assert.deepEqual(await approvalIdsFor(world.handoverDocumentId), [first.json.approval.approval.id]);
  assert.equal(await operationalFingerprint(), before);
});

// ---------------------------------------------------------------------------
// 8. Concurrency
// ---------------------------------------------------------------------------

test("20 concurrent identical creates yield one intent and one audit", async () => {
  const world = await seedHandover();
  const cookie = await sessionFor("sup-1");
  const body = createBody(world);
  const [left, right] = await Promise.all([
    call("POST", COLLECTION_PATH, { cookie, body }),
    call("POST", COLLECTION_PATH, { cookie, body }),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.deepEqual(statuses, [200, 201], `${left.text.slice(0, 200)} | ${right.text.slice(0, 200)}`);
  const ids = new Set([left.json.approval?.approval?.id, right.json.approval?.approval?.id]);
  assert.equal(ids.size, 1);
  const storedIds = await approvalIdsFor(world.handoverDocumentId);
  assert.equal(storedIds.length, 1);
  assert.equal((await auditRowsFor(storedIds[0])).length, 1);
});

test("21 concurrent countersignatures produce exactly one completed pair", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;
  const [adm1, adm2] = await Promise.all([
    sessionFor("adm-1"),
    sessionFor("adm-2"),
  ]);
  const [left, right] = await Promise.all([
    call("POST", COUNTERSIGN_PATH(approvalId), {
      cookie: adm1,
      body: { expectedRevision: 1, password: USERS["adm-1"].password },
    }),
    call("POST", COUNTERSIGN_PATH(approvalId), {
      cookie: adm2,
      body: { expectedRevision: 1, password: USERS["adm-2"].password },
    }),
  ]);
  const successes = [left, right].filter((response) => response.status === 200);
  const refusals = [left, right].filter((response) => response.status === 409);
  assert.equal(successes.length, 1, `${left.status}/${right.status}: ${left.text.slice(0, 120)} | ${right.text.slice(0, 120)}`);
  assert.equal(refusals.length, 1);

  const stored = (await db.doc(`${HANDOVER_RECOVERY_APPROVAL_COLLECTION}/${approvalId}`).get()).data();
  assert.equal(stored.revision, 2);
  assert.equal(stored.status, "fully_approved");
  assert.equal(stored.approvals.length, 2);
  assert.equal(new Set(stored.approvals.map((signature) => signature.actorUid)).size, 2);
  assert.equal((await auditRowsFor(approvalId)).length, 2);
  assert.equal(stored.recoveryExecutionEligible, false);
});

// ---------------------------------------------------------------------------
// 9. Non-executability, credential hygiene and read-only proof
// ---------------------------------------------------------------------------

test("22 no request, record or audit can ever acquire execution authority", async () => {
  const world = await seedHandover();

  const executableRequest = await call("POST", COLLECTION_PATH, {
    cookie: await sessionFor("sup-1"),
    body: { ...createBody(world), recoveryExecutionEligible: true },
  });
  assertFailureStatus(executableRequest, 400);

  const executableAction = await call("POST", COLLECTION_PATH, {
    cookie: await sessionFor("sup-1"),
    body: { ...createBody(world), action: "abandon_stalled_handover" },
  });
  assertFailureStatus(executableAction, 400);

  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;
  const executableCountersign = await call("POST", COUNTERSIGN_PATH(approvalId), {
    cookie: await sessionFor("adm-1"),
    body: { expectedRevision: 1, password: USERS["adm-1"].password, recoveryExecutionEligible: true },
  });
  assertFailureStatus(executableCountersign, 400);

  const executableReissue = await call("POST", REISSUE_PATH(approvalId), {
    cookie: await sessionFor("sup-1"),
    body: { reason: REASON, idempotencyKey: `re_exec_${world.key}`, password: USERS["sup-1"].password, recoveryExecutionEligible: true },
  });
  assertFailureStatus(executableReissue, 400);

  const approvals = await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION).get();
  assert.ok(approvals.size > 0);
  for (const document of approvals.docs) {
    const record = document.data();
    assert.equal(record.recoveryExecutionEligible, false, `${document.id} must remain non-executable`);
    assert.equal(record.nonExecutableReason, HANDOVER_RECOVERY_APPROVAL_V1_NON_EXECUTABLE_REASON);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.action, "abandon_stalled_handover");
  }
  const audits = await db.collection("audit_logs").get();
  for (const document of audits.docs) {
    assert.equal(document.data().recoveryExecutionEligible, false, `${document.id} must stay non-executable`);
  }
});

test("23 read-only route families never write", async () => {
  const world = await seedHandover();
  const created = await createApproval(world);
  const approvalId = created.json.approval.approval.id;
  const adminCookie = await sessionFor("adm-1");
  const techCookie = await sessionFor("tech-1");

  const fingerprint = await operationalFingerprint();
  const approvalsBefore = (await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION).get()).size;
  const auditsBefore = (await db.collection("audit_logs").get()).size;

  await call("GET", LIST_PATH(world.handoverDocumentId), { cookie: adminCookie });
  await call("GET", READ_PATH(approvalId), { cookie: adminCookie });
  await call("GET", LIST_PATH(world.handoverDocumentId), { cookie: techCookie });
  await call("GET", READ_PATH("handover_recovery_approval_v1_missing"), { cookie: adminCookie });
  await call("GET", READ_PATH("not-an-approval"), { cookie: adminCookie });
  await call("POST", COLLECTION_PATH, { cookie: adminCookie, body: { ...createBody(world), extra: 1 } });

  assert.equal(await operationalFingerprint(), fingerprint);
  assert.equal((await db.collection(HANDOVER_RECOVERY_APPROVAL_COLLECTION).get()).size, approvalsBefore);
  assert.equal((await db.collection("audit_logs").get()).size, auditsBefore);
});

test("24 no password or token ever appears in a response or stored record", async () => {
  for (const text of capturedResponses) {
    for (const user of Object.values(USERS)) {
      assert.ok(!text.includes(user.password), "a password was returned to the caller");
    }
    for (const marker of ["idToken", "refreshToken", "accessToken", "__session"]) {
      assert.ok(!text.includes(marker), `credential material (${marker}) was returned to the caller`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    assertNoCredentialKeys(parsed, "response");
  }

  for (const collection of [HANDOVER_RECOVERY_APPROVAL_COLLECTION, "audit_logs"]) {
    const snapshot = await db.collection(collection).get();
    for (const document of snapshot.docs) {
      assertNoCredentialKeys(document.data(), `${collection}/${document.id}`);
      const serialized = JSON.stringify(document.data());
      for (const user of Object.values(USERS)) {
        assert.ok(!serialized.includes(user.password), `password stored in ${collection}/${document.id}`);
      }
    }
  }
});

test("25 a V2-disabled application never exposes the approval surface", async () => {
  const cookie = await sessionFor("sup-1");
  const world = await seedHandover();
  const before = await operationalFingerprint();
  const probes = [
    ["GET", LIST_PATH(world.handoverDocumentId)],
    ["GET", READ_PATH(PROBE_APPROVAL_ID)],
    ["POST", COLLECTION_PATH, {}],
    ["POST", COUNTERSIGN_PATH(PROBE_APPROVAL_ID), {}],
    ["POST", VOID_PATH(PROBE_APPROVAL_ID), {}],
    ["POST", REISSUE_PATH(PROBE_APPROVAL_ID), {}],
  ];
  for (const [method, path, body] of probes) {
    const anonymous = await call(method, path, { base: ORIGIN_DISABLED, body });
    assert.equal(anonymous.status, 404, `${method} ${path} must be hidden when the V2 flag is off`);
    const authenticated = await call(method, path, { base: ORIGIN_DISABLED, body, cookie });
    assert.equal(authenticated.status, 404, `${method} ${path} must hide even for an authorized caller`);
  }
  assert.equal((await approvalIdsFor(world.handoverDocumentId)).length, 0);
  assert.equal(await operationalFingerprint(), before);
});
