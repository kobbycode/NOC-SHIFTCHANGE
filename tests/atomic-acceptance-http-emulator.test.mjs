/**
 * 09M-R3B.2 Phase 5 — isolated HTTP integration suite for the atomic incoming
 * acceptance protocol, the read-only acceptance status endpoint and the
 * receipt-backed guard finalization route.
 *
 * The suite drives the REAL Next.js route handlers over HTTP against a real
 * Firestore emulator, a real Auth emulator and real session cookies issued by
 * the production login route. Only the protected presentation, 09D, 09L and
 * 09M stacks are never contacted: everything runs in the disposable project
 * "demo-atomic-acceptance-r5" on dedicated ports (Firestore 8183, Auth 9083).
 *
 * Run via: tests/run-atomic-acceptance-http.ps1
 *
 * Scenario coverage (25):
 *   1  auth/session enforcement           14 receipt reconciliation (unknown commit)
 *   2  origin/CSRF                        15 late-reason validation
 *   3  wrong password                     16 missing partner / guard not eligible
 *   4  wrong technician                   17 normal guard finalization (both accepted)
 *   5  disabled account                   18 authorized absence closure
 *   6  expired proof                      19 unauthorized closure
 *   7  invalid binding                    20 guard-finalization rollback
 *   8  first activation                   21 frozen-report immutability
 *   9  second join                        22 audit/outbox idempotency
 *  10  either technician first            23 feature gate disabled
 *  11  concurrent acceptance              24 no fallback to the split writer
 *  12  duplicate acceptance               25 legacy evidence-only conflict
 *  13  lost HTTP acknowledgement
 */
import assert from "node:assert/strict";
import test from "node:test";

const project = "demo-atomic-acceptance-r5";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const appOrigin = process.env.ATOMIC_HTTP_ORIGIN;
const appOriginGatedOff = process.env.ATOMIC_HTTP_ORIGIN_DISABLED;

if (
  !firestoreHost ||
  !["127.0.0.1:8183", "localhost:8183"].includes(firestoreHost) ||
  authHost !== "127.0.0.1:9083" ||
  ["FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(
    (key) => process.env[key] !== project,
  )
) {
  throw new Error("Refusing to run atomic acceptance HTTP tests outside the isolated demo emulator.");
}
if (
  process.env.HANDOVER_V2_DEV !== "true" ||
  process.env.HANDOVER_V2_ATOMIC_ACCEPTANCE !== "true" ||
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS !== "true"
) {
  throw new Error("The HTTP suite requires its dedicated feature gates on the running application.");
}
if (!appOrigin || !appOriginGatedOff) {
  throw new Error("The HTTP suite requires both application origins.");
}

const probe = await fetch(`http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents`, {
  signal: AbortSignal.timeout(60_000),
});
assert.ok([200, 403, 404].includes(probe.status), `Emulator probe failed: ${probe.status}`);
const authProbe = await fetch(`http://${authHost}/`, { signal: AbortSignal.timeout(60_000) });
assert.ok(authProbe.status < 500, `Auth emulator probe failed: ${authProbe.status}`);

const { Timestamp } = await import("firebase-admin/firestore");
const { acceptanceFixture } = await import("./helpers/acceptance-integrity-fixtures.mjs");
const { getAdminFirestore, getAdminAuth } = await import("../src/lib/firebase/admin/index.ts");
const { createEqualHandoverSnapshot, getEqualHandoverPositions } = await import(
  "../src/lib/operations/equal-technician-handover-domain.ts"
);
const { planAtomicAcceptanceEvidence, applyAtomicAcceptanceEvidencePlan } = await import(
  "../src/lib/operations/atomic-acceptance-evidence.ts"
);
const { attendanceAuthenticationMethodForKind } = await import(
  "../src/lib/operations/attendance-evidence-domain.ts"
);
const { ATTENDANCE_EVIDENCE_SCHEMA } = await import("../src/types/attendance-evidence.ts");
const { createIncomingAcceptanceApplicationIdentity } = await import(
  "../src/lib/operations/incoming-acceptance-application-domain.ts"
);
const { coordinateAtomicIncomingAcceptance } = await import(
  "../src/lib/operations/incoming-acceptance-http-coordinator.ts"
);
const { IncomingAcceptanceApplicationError } = await import(
  "../src/lib/operations/incoming-acceptance-application-domain.ts"
);

const db = getAdminFirestore();
const auth = getAdminAuth();

const OUTGOING = "outgoing";
const DOCUMENT = "handover_v2_outgoing";
const AGGREGATE = `equal_handovers_v2/${DOCUMENT}`;
const GUARD = "handover_reservation_guards/guard_outgoing";
const REPORT_COLLECTION = "handover_reports_v2";
const RECEIPTS = "incoming_acceptance_applications_v1";
const APPLICATION_AUDIT_ACTION = "INCOMING_ACCEPTANCE_APPLIED_V1";
const GUARD_AUDIT_ACTION = "EQUAL_HANDOVER_GUARD_FINALIZED_V1";
const CLOSURE_AUDIT_ACTION = "EQUAL_HANDOVER_GUARD_EXCEPTIONAL_CLOSURE_V1";

const USERS = {
  "in-a": { role: "technician", password: "R5-in-a-pass!" },
  "in-b": { role: "technician", password: "R5-in-b-pass!" },
  "out-a": { role: "technician", password: "R5-out-a-pass!" },
  "out-b": { role: "technician", password: "R5-out-b-pass!" },
  c: { role: "technician", password: "R5-c-pass!" },
  manager: { role: "admin", password: "R5-manager-pass!" },
  "sup-1": { role: "supervisor", password: "R5-sup-1-pass!" },
};

function emailFor(uid) {
  return `${uid}@atomic-r5.test`;
}

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

async function signInCookie(uid) {
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic-api-key`,
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
  const login = await fetch(`${appOrigin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: appOrigin },
    body: JSON.stringify({ idToken }),
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(login.status, 200, `Session login failed for ${uid}`);
  const cookies = login.headers.getSetCookie();
  const session = cookies.map((value) => value.split(";")[0]).find((value) => value.startsWith("__session="));
  assert.ok(session, `No session cookie issued for ${uid}`);
  return session;
}

function toFirestore(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && Number.isSafeInteger(value.seconds) && Number.isSafeInteger(value.nanoseconds)) {
    return new Timestamp(value.seconds, value.nanoseconds);
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

async function clearDatabase() {
  const cleared = await fetch(
    `http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(cleared.status, 200, "The isolated emulator database could not be cleared.");
}

async function seed(options = {}) {
  await clearDatabase();
  const base = await acceptanceFixture(options);
  let batch = db.batch();
  let count = 0;
  const writes = [...base.records];
  writes.push([
    "users/sup-1",
    {
      uid: "sup-1",
      fullName: "Supervisor One",
      email: emailFor("sup-1"),
      role: "supervisor",
      status: "active",
      statusOperation: null,
      mustChangePassword: false,
    },
  ]);
  for (const [path, value] of writes) {
    const record = structuredClone(value);
    if (path.startsWith("users/")) record.email = emailFor(path.slice("users/".length));
    batch.set(db.doc(path), toFirestore(record));
    count += 1;
    if (count === 400) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
  return base;
}

async function read(path) {
  return (await db.doc(path).get()).data();
}

async function binding() {
  const aggregate = await read(AGGREGATE);
  const guard = await read(GUARD);
  return {
    expectedRevision: aggregate.revision,
    expectedSnapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
    expectedGuardRevision: guard.guardRevision,
    expectedFencingEpoch: guard.fencingEpoch,
  };
}

function acceptPath() {
  return `/api/operations/shifts/${OUTGOING}/handover/v2/accept/atomic`;
}
function statusPath(technicianUid) {
  const base = `/api/operations/shifts/${OUTGOING}/handover/v2/accept/atomic/status`;
  return technicianUid === undefined ? base : `${base}?technicianUid=${encodeURIComponent(technicianUid)}`;
}
function guardPath() {
  return `/api/operations/shifts/${OUTGOING}/handover/v2/guard/finalize`;
}

async function api(path, options = {}) {
  const {
    method = "GET",
    cookie = null,
    body,
    origin = appOrigin,
    base = appOrigin,
    rawBody,
  } = options;
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (body !== undefined || rawBody !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
}

async function acceptAs(uid, overrides = {}) {
  // The shared console NAMES the reserved incoming technician accepting now; the
  // session cookie only authorizes the console as a participant of this pair.
  return api(acceptPath(), {
    method: "POST",
    cookie: sessions[uid],
    body: {
      ...(await binding()),
      technicianUid: uid,
      password: USERS[uid].password,
      lateReason: null,
      ...overrides,
    },
  });
}

async function count(collectionName) {
  return (await db.collection(collectionName).get()).size;
}

async function applicationAudits() {
  return (await db.collection("audit_logs").get()).docs.filter(
    (doc) => doc.data().action === APPLICATION_AUDIT_ACTION,
  ).length;
}

async function guardAudits(action = GUARD_AUDIT_ACTION) {
  return (await db.collection("audit_logs").get()).docs.filter(
    (doc) => doc.data().action === action,
  ).length;
}

async function sessionIssuances() {
  return (await db.collection("audit_logs").get()).docs
    .filter((doc) => doc.data().action === "HANDOVER_SESSION_ISSUED_V2")
    .map((doc) => doc.data());
}

async function incomingAttendance() {
  return (await db.collection("shift_attendance").get()).docs.filter(
    (doc) => doc.id.startsWith("incoming_"),
  ).length;
}

async function evidenceCounts() {
  return {
    evidence: await count("attendance_evidence_v2"),
    operations: await count("attendance_evidence_operations_v2"),
    receipts: await count(RECEIPTS),
  };
}

function assertNoAtomicWrites(counts) {
  assert.deepEqual(counts, { evidence: 0, operations: 0, receipts: 0 });
}

// The HTTP suite shares one running application; cookies are issued once.
// Login requires an authoritative profile, so seed before signing anyone in.
await ensureAuthUsers();
await seed();
const sessions = {};
for (const uid of Object.keys(USERS)) sessions[uid] = await signInCookie(uid);

// ---------------------------------------------------------------------------
// 1-7: boundary, authentication and binding enforcement
// ---------------------------------------------------------------------------

test("1. every atomic route requires an authenticated session", async () => {
  await seed();
  for (const [path, method] of [
    [acceptPath(), "POST"],
    [statusPath(), "GET"],
    [guardPath(), "POST"],
  ]) {
    const result = await api(path, { method, body: method === "POST" ? {} : undefined });
    assert.equal(result.status, 401, `${method} ${path} must reject anonymous access`);
  }
  assertNoAtomicWrites(await evidenceCounts());
});

test("2. mutations reject a foreign or missing origin before any write", async () => {
  await seed();
  const foreign = await api(acceptPath(), {
    method: "POST",
    cookie: sessions["in-a"],
    origin: "http://attacker.example",
    body: { ...(await binding()), technicianUid: "in-a", password: USERS["in-a"].password, lateReason: null },
  });
  assert.equal(foreign.status, 403);
  const missing = await api(acceptPath(), {
    method: "POST",
    cookie: sessions["in-a"],
    origin: null,
    body: { ...(await binding()), technicianUid: "in-a", password: USERS["in-a"].password, lateReason: null },
  });
  assert.equal(missing.status, 403);
  const guard = await api(guardPath(), {
    method: "POST",
    cookie: sessions["in-a"],
    origin: "http://attacker.example",
    body: {},
  });
  assert.equal(guard.status, 403);
  assertNoAtomicWrites(await evidenceCounts());
});

test("3. a wrong password is rejected without any attendance evidence", async () => {
  await seed();
  const result = await acceptAs("in-a", { password: "not-the-password" });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "CREDENTIAL_REJECTED");
  assert.equal(result.body.commitState, "not_committed");
  assertNoAtomicWrites(await evidenceCounts());
  assert.equal(await incomingAttendance(), 0);
});

test("4. a technician outside the reserved incoming roster cannot accept", async () => {
  await seed();
  const result = await acceptAs("c");
  assert.equal(result.status, 403);
  assert.equal(result.body.commitState, "not_committed");
  assertNoAtomicWrites(await evidenceCounts());
});

test("5. a disabled account loses its session and cannot accept", async () => {
  await seed();
  await auth.updateUser("in-b", { disabled: true });
  try {
    const result = await acceptAs("in-b");
    assert.equal(result.status, 401);
  } finally {
    await auth.updateUser("in-b", { disabled: false });
  }
  assertNoAtomicWrites(await evidenceCounts());
});

test("6. an expired password proof is refused before the transaction", async () => {
  await seed();
  const aggregate = await read(AGGREGATE);
  const current = await binding();
  // The proof is created with the real coordinator, but the final freshness
  // clock has moved 61 seconds past password verification.
  let isoCount = 0;
  const monotonic = [1_000, 62_000];
  const clock = {
    nowIso: () => new Date(Date.now() + isoCount++ * 1_000).toISOString(),
    monotonicMs: () => monotonic.shift(),
  };
  await assert.rejects(
    coordinateAtomicIncomingAcceptance({
      outgoingShiftId: OUTGOING,
      actor: {
        uid: "in-a",
        email: emailFor("in-a"),
        role: "technician",
        mustChangePassword: false,
      },
      reviewed: {
        ...current,
        technicianUid: "in-a",
        password: USERS["in-a"].password,
        lateReason: null,
      },
      dependencies: {
        clock,
        auth: { getUser: async (uid) => ({ uid, email: emailFor(uid), disabled: false }) },
        authenticate: async () => ({ uid: "in-a", idToken: "test-id-token" }),
      },
    }),
    (error) =>
      error instanceof IncomingAcceptanceApplicationError &&
      error.code === "AUTHENTICATION_EXPIRED" &&
      error.status === 409,
  );
  // The seeded aggregate is untouched by the refused attempt.
  assert.equal((await read(AGGREGATE)).revision, aggregate.revision);
  assertNoAtomicWrites(await evidenceCounts());
});

test("7. a stale reviewed binding is refused without any write", async () => {
  await seed();
  const current = await binding();
  const result = await acceptAs("in-a", { expectedRevision: current.expectedRevision + 1 });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "ACCEPTANCE_BINDING_CONFLICT");
  assert.equal(result.body.commitState, "not_committed");
  assert.equal(result.body.rolledBack, true);
  assertNoAtomicWrites(await evidenceCounts());
  assert.equal(await incomingAttendance(), 0);
});

// ---------------------------------------------------------------------------
// 8-13: application, replay and concurrency
// ---------------------------------------------------------------------------

test("8. the first acceptance activates the incoming shift and leaves the guard active", async () => {
  await seed();
  const result = await acceptAs("in-a");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.code, "ACCEPTANCE_APPLIED_FIRST_ACTIVATION");
  assert.equal(result.body.outcome, "first_activation");
  assert.equal(result.body.status, "APPLIED");
  assert.equal(result.body.lifecycle.partnerApplied, false);
  assert.equal(result.body.lifecycle.guardState, "pending");
  assert.equal(result.body.lifecycle.nextAction, "AWAIT_PARTNER_ACCEPTANCE");
  assert.equal(result.body.notifications.delivery, "not_claimed");
  assert.equal(result.body.notifications.outboxState, "written");

  const incoming = await read("shifts/incoming");
  assert.equal(incoming.status, "active");
  assert.equal((await read("shifts/outgoing")).status, "completed");
  assert.equal((await read("shift_attendance/incoming_in-a")).technicianId, "in-a");
  assert.equal(await read("shift_attendance/incoming_in-b"), undefined);
  assert.equal((await read(GUARD)).ownerLifecycleState, "active");
  assert.equal(await applicationAudits(), 1);
  assert.equal(await incomingAttendance(), 1);

  // Phase 3 — the committed acceptance also signs the NAMED incoming technician
  // in on this shared console and revokes the outgoing pair exactly once.
  assert.equal(result.body.session.issued, true);
  assert.equal(result.body.session.firstActivation, true);
  assert.equal(result.body.session.acceptingTechnicianUid, "in-a");
  assert.equal(result.body.session.outgoingSessionsRevoked, true);
  assert.deepEqual(result.body.session.revokedOutgoingTechnicianUids, ["out-a", "out-b"]);
  const issuance = await sessionIssuances();
  assert.equal(issuance.length, 1);
  assert.equal(issuance[0].acceptingTechnicianUid, "in-a");
  assert.equal(issuance[0].consoleActorUid, "in-a");
  assert.equal(issuance[0].firstActivation, true);
  assert.deepEqual(issuance[0].revokedOutgoingTechnicianUids, ["out-a", "out-b"]);
  assert.ok(!JSON.stringify(issuance[0]).match(/idToken|refreshToken|password|__session/i),
    "no credential material may reach the issuance record");
});

test("9. the second acceptance joins, then normal guard finalization is explicit and idempotent", async () => {
  await seed();
  const first = await acceptAs("in-a");
  assert.equal(first.body.outcome, "first_activation");
  const joined = await acceptAs("in-b");
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.code, "ACCEPTANCE_APPLIED_SUBSEQUENT_JOIN");
  assert.equal(joined.body.outcome, "subsequent_join");
  assert.equal(joined.body.lifecycle.partnerApplied, true);
  assert.equal(joined.body.lifecycle.nextAction, "GUARD_FINALIZATION_ELIGIBLE");
  // No automatic single-technician closure happened during acceptance.
  assert.equal((await read(GUARD)).ownerLifecycleState, "active");
  assert.equal(await incomingAttendance(), 2);

  // A later join signs in the joining technician but revokes nothing: the first
  // incoming technician's session must stay valid.
  assert.equal(joined.body.session.issued, true);
  assert.equal(joined.body.session.firstActivation, false);
  assert.equal(joined.body.session.acceptingTechnicianUid, "in-b");
  assert.deepEqual(joined.body.session.revokedOutgoingTechnicianUids, []);
  const joinedIssuances = await sessionIssuances();
  assert.deepEqual(joinedIssuances.map((item) => item.acceptingTechnicianUid).sort(), ["in-a", "in-b"]);

  const finalized = await api(guardPath(), { method: "POST", cookie: sessions["in-a"], body: {} });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.code, "GUARD_FINALIZED");
  assert.equal(finalized.body.mode, "normal_closure");
  assert.equal(finalized.body.provenance, "phase4a_audited");
  assert.equal(finalized.body.lifecycleState, "completed");
  assert.equal(finalized.body.applications.length, 2);
  assert.equal((await read(GUARD)).ownerLifecycleState, "completed");
  assert.equal(await guardAudits(), 1);
  assert.equal(finalized.body.notifications.state, "not_emitted");

  const replay = await api(guardPath(), { method: "POST", cookie: sessions["in-b"], body: {} });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.code, "GUARD_ALREADY_FINALIZED");
  assert.equal(replay.body.replayed, true);
  assert.equal(await guardAudits(), 1);
});

test("10. either reserved technician may be the first activator", async () => {
  await seed();
  const result = await acceptAs("in-b");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.outcome, "first_activation");
  assert.equal(result.body.technician.uid, "in-b");
  assert.equal((await read("shift_attendance/incoming_in-b")).technicianId, "in-b");
  assert.equal(await read("shift_attendance/incoming_in-a"), undefined);
  assert.equal((await read("shifts/incoming")).status, "active");
});

test("11. simultaneous acceptances converge to one activation and two personal receipts", async () => {
  await seed();
  const bindingA = await binding();
  const bindingB = await binding();
  const [a, b] = await Promise.all([
    api(acceptPath(), {
      method: "POST",
      cookie: sessions["in-a"],
      body: { ...bindingA, technicianUid: "in-a", password: USERS["in-a"].password, lateReason: null },
    }),
    api(acceptPath(), {
      method: "POST",
      cookie: sessions["in-b"],
      body: { ...bindingB, technicianUid: "in-b", password: USERS["in-b"].password, lateReason: null },
    }),
  ]);
  // The losing request either observed the activation in the coordinator
  // (ACCEPTANCE_BINDING_CONFLICT), asserted a reviewed binding the activation
  // changed (REVIEW_BINDING_CHANGED), or computed its join window before the
  // activation committed (JOIN_WINDOW_NOT_OPEN). All are non-committed and
  // converge on a fresh-binding retry; none may be reported as applied.
  const retryable = new Set([
    "ACCEPTANCE_BINDING_CONFLICT",
    "REVIEW_BINDING_CHANGED",
    "JOIN_WINDOW_NOT_OPEN",
  ]);
  for (const result of [a, b]) {
    assert.ok(
      result.status === 200 ||
        (result.status === 409 && retryable.has(result.body.code)),
      `Unexpected concurrent outcome: ${result.status} ${JSON.stringify(result.body)}`,
    );
    if (result.status === 409) {
      assert.equal(result.body.commitState, "not_committed");
      assert.equal(result.body.outcomeUnknown, false);
    }
  }
  // Any join refused because it predated activation converges on retry.
  if (b.status === 409) {
    const retry = await acceptAs("in-b");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
  }
  if (a.status === 409) {
    const retry = await acceptAs("in-a");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
  }
  assert.equal((await read("shifts/incoming")).status, "active");
  assert.equal(await incomingAttendance(), 2);
  const activationReceipts = (await db.collection("audit_logs").get()).docs.filter(
    (doc) => doc.data().action === "EQUAL_SHIFT_ACTIVATED_INCOMING_V2",
  ).length;
  assert.equal(activationReceipts, 1);
  assert.equal(await count(RECEIPTS), 2);
  assert.equal(await applicationAudits(), 2);
});

test("12. a duplicate acceptance replays the original receipt without duplicate writes", async () => {
  await seed();
  const first = await acceptAs("in-a");
  assert.equal(first.status, 200);
  const countsAfterFirst = await evidenceCounts();
  const outboxAfterFirst = await count("notification_outbox");

  const duplicate = await acceptAs("in-a");
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.code, "ACCEPTANCE_ALREADY_APPLIED");
  assert.equal(duplicate.body.replayed, true);
  assert.equal(duplicate.body.acceptance.receiptId, first.body.acceptance.receiptId);
  assert.equal(duplicate.body.acceptance.receiptHash, first.body.acceptance.receiptHash);
  assert.equal(duplicate.body.acceptance.operationalAppliedAt, first.body.acceptance.operationalAppliedAt);
  assert.deepEqual(await evidenceCounts(), countsAfterFirst);
  assert.equal(await count("notification_outbox"), outboxAfterFirst);
  assert.equal(await applicationAudits(), 1);
});

test("13. a lost HTTP acknowledgement is recoverable by replay with the original timestamps", async () => {
  await seed();
  const first = await acceptAs("in-a");
  assert.equal(first.status, 200);
  const stored = await read(`${RECEIPTS}/${first.body.acceptance.receiptId}`);
  assert.equal(stored.operationalAppliedAt, first.body.acceptance.operationalAppliedAt);
  assert.equal(stored.receiptHash, first.body.acceptance.receiptHash);

  // The client never saw the response and retries after refreshing its binding.
  const retry = await acceptAs("in-a");
  assert.equal(retry.status, 200);
  assert.equal(retry.body.code, "ACCEPTANCE_ALREADY_APPLIED");
  assert.equal(retry.body.acceptance.operationalAppliedAt, stored.operationalAppliedAt);
  assert.equal((await read(`${RECEIPTS}/${first.body.acceptance.receiptId}`)).receiptHash, stored.receiptHash);
  assert.equal(await count(RECEIPTS), 1);
});

// ---------------------------------------------------------------------------
// 14-16: ambiguous commit, late reasons and partner gating
// ---------------------------------------------------------------------------

test("14. an unresolved commit marker is reported as unverifiable, never as a rollback", async () => {
  await seed();
  const applied = await acceptAs("in-a");
  assert.equal(applied.status, 200);
  const receiptPath = `${RECEIPTS}/${applied.body.acceptance.receiptId}`;
  // Simulate a commit whose server timestamp could not be resolved on read-back.
  await db.doc(receiptPath).set({ committedAt: { seconds: 0, nanoseconds: 0 } }, { merge: true });

  const status = await api(statusPath(), { cookie: sessions["in-a"] });
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "COMMIT_UNVERIFIABLE");
  assert.equal(status.body.guidance, "REFRESH_STATUS");
  assert.equal(status.body.acceptance.applied, false);

  const retry = await acceptAs("in-a");
  assert.equal(retry.status, 503);
  assert.equal(retry.body.outcomeUnknown, true);
  assert.equal(retry.body.rolledBack, false);
  assert.notEqual(retry.body.commitState, "not_committed");
  assert.equal(await count(RECEIPTS), 1);
});

test("15. a late arrival requires and preserves the technician's own reason", async () => {
  await seed();
  const aggregate = await read(AGGREGATE);
  // 30 minutes past the scheduled start: beyond the 15-minute grace.
  const lateMs = Date.parse(aggregate.identity.scheduledStart) + 30 * 60_000;
  const coordinator = async (lateReason) => {
    let isoCount = 0;
    const clock = {
      nowIso: () => new Date(lateMs + isoCount++ * 1_000).toISOString(),
      monotonicMs: () => 5_000,
    };
    return coordinateAtomicIncomingAcceptance({
      outgoingShiftId: OUTGOING,
      actor: { uid: "in-a", email: emailFor("in-a"), role: "technician", mustChangePassword: false },
      reviewed: { ...(await binding()), technicianUid: "in-a", password: USERS["in-a"].password, lateReason },
      dependencies: {
        clock,
        auth: { getUser: async (uid) => ({ uid, email: emailFor(uid), disabled: false }) },
        authenticate: async () => ({ uid: "in-a", idToken: "test-id-token" }),
      },
    });
  };

  await assert.rejects(
    coordinator(null),
    (error) => error instanceof IncomingAcceptanceApplicationError && error.code === "LATE_REASON_REQUIRED",
  );
  await assert.rejects(
    coordinator("x".repeat(1_001)),
    (error) => error instanceof IncomingAcceptanceApplicationError && error.code === "LATE_REASON_INVALID",
  );
  assertNoAtomicWrites(await evidenceCounts());

  const applied = await coordinator("  Train delay on the northern line.  ");
  assert.equal(applied.result.status, "APPLIED");
  assert.equal(applied.receipt.lateReason, "Train delay on the northern line.");
  assert.equal(applied.receipt.lateReasonSource, "technician_supplied");
});

test("16. a single acceptance cannot finalize the guard and status reports the missing partner", async () => {
  await seed();
  const applied = await acceptAs("in-a");
  assert.equal(applied.status, 200);

  const status = await api(statusPath(), { cookie: sessions["in-a"] });
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "APPLIED_VALIDATED");
  assert.equal(status.body.partnerApplied, false);
  assert.equal(status.body.acceptance.retryWouldReplay, true);

  const premature = await api(guardPath(), { method: "POST", cookie: sessions["in-a"], body: {} });
  assert.equal(premature.status, 409);
  assert.equal(premature.body.code, "GUARD_NOT_ELIGIBLE");
  assert.equal((await read(GUARD)).ownerLifecycleState, "active");
  assert.equal(await guardAudits(), 0);
});

// ---------------------------------------------------------------------------
// 17-20: closure rules
// ---------------------------------------------------------------------------

test("17. the guard finalizes normally only after both validated receipts", async () => {
  await seed();
  assert.equal((await acceptAs("in-a")).body.outcome, "first_activation");
  assert.equal((await acceptAs("in-b")).body.outcome, "subsequent_join");
  const finalized = await api(guardPath(), { method: "POST", cookie: sessions["in-b"], body: {} });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.status, "FINALIZED");
  assert.equal(finalized.body.audit.state, "created");
  assert.equal((await read(GUARD)).ownerLifecycleState, "completed");
});

test("18. an authorized not_yet_in absence supports an exceptional closure by a supervisor", async () => {
  await seed({ absence: { actorUid: "out-a", subjectUid: "in-b" } });
  assert.equal((await acceptAs("in-a")).body.outcome, "first_activation");

  const closed = await api(guardPath(), {
    method: "POST",
    cookie: sessions["sup-1"],
    body: { closure: { closureId: "closure-in-b-001", subjectUid: "in-b", reason: "Partner never arrived; absence attested." } },
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.status, "FINALIZED");
  assert.equal(closed.body.mode, "exceptional_closure");
  assert.equal(closed.body.closure.subjectUid, "in-b");
  assert.equal(closed.body.closure.absenceReason, "Partner reported unavailable for this shift.");
  assert.equal(await incomingAttendance(), 1);
  assert.equal(await read("shift_attendance/incoming_in-b"), undefined);
  assert.equal(await read("shift_members/incoming_in-b"), undefined);
  const guard = await read(GUARD);
  assert.equal(guard.ownerLifecycleState, "completed");
  assert.equal(guard.terminalEvidenceRef, "closure-in-b-001");
  assert.equal(await guardAudits(CLOSURE_AUDIT_ACTION), 1);
});

test("19. a participating technician cannot authorize an exceptional closure", async () => {
  await seed({ absence: { actorUid: "out-b", subjectUid: "in-b" } });
  assert.equal((await acceptAs("in-a")).status, 200);

  const attempt = await api(guardPath(), {
    method: "POST",
    cookie: sessions["in-a"],
    body: { closure: { closureId: "closure-in-b-002", subjectUid: "in-b", reason: "Attempted self-authorized closure." } },
  });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.body.code, "GUARD_UNAUTHORIZED");
  assert.equal((await read(GUARD)).ownerLifecycleState, "active");
  assert.equal(await guardAudits(CLOSURE_AUDIT_ACTION), 0);
});

test("20. an unbacked closure rolls back every guard write", async () => {
  await seed();
  assert.equal((await acceptAs("in-a")).status, 200);
  const before = await read(GUARD);
  const attempt = await api(guardPath(), {
    method: "POST",
    cookie: sessions["sup-1"],
    body: { closure: { closureId: "closure-without-absence", subjectUid: "in-b", reason: "No absence on record." } },
  });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.body.code, "GUARD_NOT_ELIGIBLE");
  assert.equal(attempt.body.commitState, "not_committed");
  const after = await read(GUARD);
  assert.equal(after.ownerLifecycleState, before.ownerLifecycleState);
  assert.equal(after.guardRevision, before.guardRevision);
  assert.equal(await guardAudits(GUARD_AUDIT_ACTION), 0);
  assert.equal(await guardAudits(CLOSURE_AUDIT_ACTION), 0);
});

// ---------------------------------------------------------------------------
// 21-25: immutability, idempotency, gate and legacy boundaries
// ---------------------------------------------------------------------------

function plain(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "object" && typeof value.toDate === "function") {
    return { __timestamp: value.toDate().toISOString() };
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

test("21. the frozen report and its binding are byte-identical after acceptance and closure", async () => {
  await seed();
  const aggregate = await read(AGGREGATE);
  const reportId = aggregate.reportBinding.id;
  const before = plain(await read(`${REPORT_COLLECTION}/${reportId}`));
  const beforeBinding = plain(aggregate.reportBinding);

  assert.equal((await acceptAs("in-a")).status, 200);
  assert.equal((await acceptAs("in-b")).status, 200);
  assert.equal((await api(guardPath(), { method: "POST", cookie: sessions["in-a"], body: {} })).status, 200);

  const after = plain(await read(`${REPORT_COLLECTION}/${reportId}`));
  assert.deepEqual(after, before);
  const finalAggregate = await read(AGGREGATE);
  assert.deepEqual(plain(finalAggregate.reportBinding), beforeBinding);
});

test("22. replay and repeated finalization never duplicate audits or outbox intents", async () => {
  await seed();
  assert.equal((await acceptAs("in-a")).status, 200);
  const outbox = await count("notification_outbox");
  const notifications = await count("notifications");
  assert.equal((await acceptAs("in-a")).status, 200);
  assert.equal(await count("notification_outbox"), outbox);
  assert.equal(await count("notifications"), notifications);
  assert.equal(await applicationAudits(), 1);

  assert.equal((await acceptAs("in-b")).status, 200);
  assert.equal((await api(guardPath(), { method: "POST", cookie: sessions["in-a"], body: {} })).status, 200);
  const outboxAfterClosure = await count("notification_outbox");
  assert.equal((await api(guardPath(), { method: "POST", cookie: sessions["in-b"], body: {} })).status, 200);
  assert.equal(await count("notification_outbox"), outboxAfterClosure);
  assert.equal(await guardAudits(), 1);
});

test("23. the atomic protocol is 404 on an application where its gate is disabled", async () => {
  await seed();
  const current = await binding();
  const accept = await api(acceptPath(), {
    method: "POST",
    cookie: sessions["in-a"],
    base: appOriginGatedOff,
    origin: appOriginGatedOff,
    body: { ...current, technicianUid: "in-a", password: USERS["in-a"].password, lateReason: null },
  });
  assert.equal(accept.status, 404);
  const status = await api(statusPath(), {
    cookie: sessions["in-a"],
    base: appOriginGatedOff,
    origin: appOriginGatedOff,
  });
  assert.equal(status.status, 404);
  const guard = await api(guardPath(), {
    method: "POST",
    cookie: sessions["in-a"],
    base: appOriginGatedOff,
    origin: appOriginGatedOff,
    body: {},
  });
  assert.equal(guard.status, 404);
  assertNoAtomicWrites(await evidenceCounts());
});

test("24. a refused atomic attempt never falls back to the legacy split writer", async () => {
  await seed();
  const current = await binding();
  const refused = await acceptAs("in-a", { expectedGuardRevision: current.expectedGuardRevision + 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "ACCEPTANCE_BINDING_CONFLICT");
  assertNoAtomicWrites(await evidenceCounts());
  assert.equal(await read("shift_attendance/incoming_in-a"), undefined);
  assert.equal((await read(AGGREGATE)).lifecycleStatus, "awaiting_incoming_acceptance");
});

test("25. legacy evidence without an application is reported as evidence-only and blocks atomic acceptance", async () => {
  await seed();
  const aggregate = await read(AGGREGATE);
  const guard = await read(GUARD);
  const current = await binding();
  const appliedAt = new Date(Date.now() - 30_000).toISOString();
  const identity = createIncomingAcceptanceApplicationIdentity({
    handoverId: aggregate.reservation.handoverId,
    technicianUid: "in-a",
    kind: "incoming_clock_in",
  });
  const position = getEqualHandoverPositions(aggregate.identity)
    .find((entry) => entry.technicianUid === "in-a" && entry.side === "incoming")?.position;
  assert.ok(position);

  // The legacy split writer finalized evidence first and then lost the
  // operational application: exactly the orphan-evidence defect the atomic
  // protocol must never adopt or promote.
  const plan = planAtomicAcceptanceEvidence(
    { operation: null, slotEvidence: null, otherKindEvidence: [], guard, handover: aggregate },
    {
      request: {
        schema: ATTENDANCE_EVIDENCE_SCHEMA,
        handoverId: aggregate.reservation.handoverId,
        handoverDocumentId: DOCUMENT,
        eventId: identity.eventId,
        position,
        technicianUid: "in-a",
        kind: "incoming_clock_in",
        scheduledStart: aggregate.identity.scheduledStart,
        scheduledEnd: aggregate.identity.scheduledEnd,
        reportedDepartureTime: null,
        attestedByUid: null,
        attestationReason: null,
        lateReason: null,
        handoverRevision: aggregate.revision,
        snapshotHash: current.expectedSnapshotHash,
        expectedGuardRevision: current.expectedGuardRevision,
        expectedFencingEpoch: current.expectedFencingEpoch,
      },
      identity: aggregate.identity,
      reservation: aggregate.reservation,
      trustedAuthentication: {
        verifiedTechnicianUid: "in-a",
        method: attendanceAuthenticationMethodForKind("incoming_clock_in"),
      },
      serverAuthenticationTime: appliedAt,
    },
  );
  assert.equal(plan.mode, "create_operation_and_evidence");
  await db.runTransaction(async (transaction) => {
    applyAtomicAcceptanceEvidencePlan(transaction, plan);
  });
  // The legacy writer recorded its finalization acknowledgement but never
  // produced the operational application.
  await db.doc(`attendance_evidence_operations_v2/${plan.operationId}`).update({
    interruptedFinalization: false,
  });

  const refused = await acceptAs("in-a");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "EVIDENCE_BINDING_CONFLICT");
  assert.equal(refused.body.commitState, "not_committed");
  assert.equal(await count(RECEIPTS), 0);
  assert.equal((await read(AGGREGATE)).lifecycleStatus, "awaiting_incoming_acceptance");
  assert.equal(await read("shift_attendance/incoming_in-a"), undefined);
  assert.equal(await read("shift_members/incoming_in-a"), undefined);

  const status = await api(statusPath(), { cookie: sessions["in-a"] });
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "EVIDENCE_ONLY");
  assert.equal(status.body.guidance, "CONTACT_ADMIN");
  assert.equal(status.body.acceptance.applied, false);
  assert.equal(status.body.diagnostics.evidencePresent, true);
});

// ---------------------------------------------------------------------------
// 26-27: the legacy split writer is refused while the gate is on and remains
// reachable while it is off — the gate never silently redirects either way
// ---------------------------------------------------------------------------

function legacyAcceptPath() {
  return `/api/operations/shifts/${OUTGOING}/handover/v2/accept`;
}

test("26. the legacy acceptance writer refuses the intent when the atomic gate is on", async () => {
  await seed();
  const refused = await api(legacyAcceptPath(), {
    method: "POST",
    cookie: sessions["in-a"],
    body: {},
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "ACCEPTANCE_ATOMIC_PROTOCOL_ENABLED");
  assertNoAtomicWrites(await evidenceCounts());
  assert.equal((await read(AGGREGATE)).lifecycleStatus, "awaiting_incoming_acceptance");
  assert.equal(await read("shift_attendance/incoming_in-a"), undefined);
});

test("27. the legacy acceptance writer stays reachable, not 404, when the atomic gate is off", async () => {
  await seed();
  const reachable = await api(legacyAcceptPath(), {
    method: "POST",
    cookie: sessions["in-a"],
    base: appOriginGatedOff,
    origin: appOriginGatedOff,
    body: {},
  });
  // The gate passes, the personal session authenticates, and only the empty
  // review body is refused: the legacy path was not replaced by a 404.
  assert.equal(reachable.status, 400);
  assertNoAtomicWrites(await evidenceCounts());
  assert.equal((await read(AGGREGATE)).lifecycleStatus, "awaiting_incoming_acceptance");
});
