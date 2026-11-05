import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

/*
 * TECH-HO-RECOVERY-09F verification.
 *
 * Supervisors pair technicians and schedule shifts; only an assigned
 * technician activates the first-ever shift, and every later shift activates
 * through an incoming technician's authenticated handover acceptance.
 */

const EXPECTED_PROJECT_ID = "demo-shiftchange-first-shift";
const EXPECTED_PORT = "8088";

function failSafety(message: string): never {
  throw new Error(`EMULATOR SAFETY CHECK FAILED: ${message}`);
}

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

if (!emulatorHost) {
  failSafety("FIRESTORE_EMULATOR_HOST is missing. Refusing to run.");
}

if (emulatorHost.includes("://")) {
  failSafety("FIRESTORE_EMULATOR_HOST must not contain a protocol.");
}

const emulatorUrl = new URL(`http://${emulatorHost}`);

if (
  !["127.0.0.1", "localhost"].includes(emulatorUrl.hostname) ||
  emulatorUrl.port !== EXPECTED_PORT
) {
  failSafety(
    `Expected local Firestore emulator on port ${EXPECTED_PORT}; received ${emulatorHost}.`
  );
}

for (
  const [name, value] of [
    ["FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID],
    [
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    ],
    ["GCLOUD_PROJECT", process.env.GCLOUD_PROJECT],
    ["GOOGLE_CLOUD_PROJECT", process.env.GOOGLE_CLOUD_PROJECT],
  ] as const
) {
  if (value !== EXPECTED_PROJECT_ID) {
    failSafety(
      `${name} must equal ${EXPECTED_PROJECT_ID}; received ${String(value)}.`
    );
  }
}

if (!EXPECTED_PROJECT_ID.startsWith("demo-")) {
  failSafety("The test project must use Firebase's demo- prefix.");
}

const probeResponse = await fetch(
  `http://${emulatorHost}/v1/projects/${EXPECTED_PROJECT_ID}/databases/(default)/documents`
);

if (probeResponse.status !== 200 && probeResponse.status !== 404) {
  failSafety(`Firestore emulator probe returned HTTP ${probeResponse.status}.`);
}

const { getAdminFirestore } = await import(
  "../src/lib/firebase/admin/index"
);

const { startShift } = await import("../src/lib/operations/start-shift");
const { joinShift } = await import("../src/lib/operations/join-shift");
const { getTechnicianCurrentShift } = await import(
  "../src/lib/operations/get-technician-current-shift"
);

const {
  consumeOperationalShiftSlot,
  createPendingOperationalShiftControl,
  transitionOperationalShiftControl,
} = await import("../src/lib/operations/operational-shift-control-state");

const {
  buildPendingNextShiftAuthorization,
  createNextShiftAuthorizationDocumentId,
} = await import("../src/lib/operations/next-shift-authorization-domain");

const { FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE } = await import(
  "../src/lib/operations/first-shift-bootstrap-domain"
);

const db = getAdminFirestore();

let fixtureCounter = 0;

const MINUTE = 60_000;

function iso(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

function technicianProfile(uid: string, fullName: string) {
  return {
    uid,
    fullName,
    email: `${uid}@example.invalid`,
    role: "technician",
    status: "active",
    mustChangePassword: false,
    statusOperation: null,
  };
}

type FixtureOptions = {
  /*
   * The activation ledger is the shifts collection itself, so every fixture
   * starts from an empty one and opts into a witness record.
   */
  activatedWitness?: boolean;
  window?: "open" | "premature" | "expired";
  actorAStatus?: "active" | "blocked";
  actorAMustChangePassword?: boolean;
  includeAuthorization?: boolean;
  /*
   * Forge the grant's beneficiary after the builder runs. Supervisors cannot
   * create a substitute grant for a permanent pair member, so this models
   * stored data that the start path must never treat as authority.
   */
  grantNamesPairMember?: boolean;
};

async function resetShiftLedger() {
  const snapshot = await db.collection("shifts").get();

  if (snapshot.empty) {
    return;
  }

  const batch = db.batch();

  for (const document of snapshot.docs) {
    batch.delete(document.ref);
  }

  await batch.commit();
}

async function seedFirstShiftFixture(options: FixtureOptions = {}) {
  await resetShiftLedger();

  fixtureCounter += 1;

  const suffix = `${Date.now()}-${fixtureCounter}`;

  const shiftId = `first-shift-${suffix}`;
  const pairId = `first-shift-pair-${suffix}`;
  const technicianA = `first-shift-a-${suffix}`;
  const technicianB = `first-shift-b-${suffix}`;
  const technicianC = `first-shift-c-${suffix}`;
  const technicianD = `first-shift-d-${suffix}`;
  const supervisorUid = `first-shift-supervisor-${suffix}`;
  const adminUid = `first-shift-admin-${suffix}`;

  const slotToken = randomUUID();
  const previousSlotToken = randomUUID();
  const generation = 4_000 + fixtureCounter;

  const now = Date.now();
  const window = options.window ?? "open";

  const scheduledStart =
    window === "premature"
      ? iso(now + 180 * MINUTE)
      : window === "expired"
        ? iso(now - 180 * MINUTE)
        : iso(now - 5 * MINUTE);

  const scheduledEnd = iso(
    Date.parse(scheduledStart) + 8 * 60 * MINUTE
  );

  const createdAt = iso(now - 24 * 60 * MINUTE);

  const pair = {
    id: pairId,
    technicianIds: [technicianA, technicianB],
    status: "active",
    createdBy: supervisorUid,
    createdAt,
    updatedAt: createdAt,
    deactivatedAt: null,
    deactivatedBy: null,
  };

  const pendingControl = createPendingOperationalShiftControl(
    slotToken,
    generation,
    createdAt,
    previousSlotToken,
    createdAt
  );

  const scheduledControl = consumeOperationalShiftSlot(
    pendingControl,
    shiftId,
    createdAt
  );

  const shift = {
    id: shiftId,
    shiftType: "morning",
    status: "scheduled",
    scheduledStart,
    scheduledEnd,
    actualStart: null,
    actualEnd: null,
    permanentPairId: pairId,
    operationalSlotToken: slotToken,
    primaryTechnicianIds: [technicianA, technicianB],
    createdBy: supervisorUid,
    createdAt,
    updatedAt: createdAt,
  };

  const primaryMember = (technicianUid: string) => ({
    id: `${shiftId}_${technicianUid}`,
    shiftId,
    technicianId: technicianUid,
    role: "primary",
    joinedAt: createdAt,
    leftAt: null,
  });

  const scheduledEntry = {
    shiftId,
    scheduledStart,
    scheduledEnd,
    status: "scheduled",
  };

  const authorizationId = createNextShiftAuthorizationDocumentId(
    pairId,
    generation,
    slotToken
  );

  const authorization = {
    ...buildPendingNextShiftAuthorization({
      control: pendingControl,
      pair,
      permanentPairId: pairId,
      authorizedTechnicianUid: technicianC,
      technicianEligibility: { eligible: true, message: null },
      createdBy: supervisorUid,
      createdAt,
    }),
    id: authorizationId,
    status: "consumed",
    shiftId,
    consumedAt: createdAt,
    completedAt: null,
    expiredAt: null,
    updatedAt: createdAt,
    ...(
      options.grantNamesPairMember === true
        ? { authorizedTechnicianUid: technicianA }
        : {}
    ),
  };

  const batch = db.batch();

  batch.set(
    db.collection("users").doc(technicianA),
    {
      ...technicianProfile(technicianA, "Synthetic Pair Technician A"),
      status: options.actorAStatus ?? "active",
      mustChangePassword: options.actorAMustChangePassword === true,
    }
  );

  batch.set(
    db.collection("users").doc(technicianB),
    technicianProfile(technicianB, "Synthetic Pair Technician B")
  );

  batch.set(
    db.collection("users").doc(technicianC),
    technicianProfile(technicianC, "Synthetic Substitute Technician C")
  );

  batch.set(
    db.collection("users").doc(technicianD),
    technicianProfile(technicianD, "Synthetic Unrelated Technician D")
  );

  batch.set(db.collection("users").doc(supervisorUid), {
    uid: supervisorUid,
    fullName: "Synthetic Supervisor",
    email: `${supervisorUid}@example.invalid`,
    role: "supervisor",
    status: "active",
    mustChangePassword: false,
    statusOperation: null,
  });

  batch.set(db.collection("users").doc(adminUid), {
    uid: adminUid,
    fullName: "Synthetic Administrator",
    email: `${adminUid}@example.invalid`,
    role: "admin",
    status: "active",
    mustChangePassword: false,
    statusOperation: null,
  });

  batch.set(db.collection("technician_pairs").doc(pairId), pair);

  for (const technicianUid of [technicianA, technicianB]) {
    batch.set(
      db.collection("technician_pair_memberships").doc(technicianUid),
      {
        technicianUid,
        pairId,
        createdAt,
        updatedAt: createdAt,
      }
    );

    batch.set(
      db.collection("technician_schedules").doc(technicianUid),
      {
        technicianUid,
        entries: [scheduledEntry],
        updatedAt: createdAt,
      }
    );

    batch.set(
      db.collection("shift_members").doc(`${shiftId}_${technicianUid}`),
      primaryMember(technicianUid)
    );
  }

  batch.set(db.collection("shifts").doc(shiftId), shift);

  batch.set(
    db.collection("operational_shift_control").doc("global"),
    scheduledControl
  );

  if (options.includeAuthorization === true) {
    batch.set(
      db.collection("next_shift_authorizations").doc(authorizationId),
      authorization
    );
  }

  if (options.activatedWitness === true) {
    /*
     * A completed shift is history: shift documents are never deleted and
     * status never moves backwards, so this single record permanently closes
     * manual bootstrap.
     */
    const witnessId = `first-shift-witness-${suffix}`;

    batch.set(db.collection("shifts").doc(witnessId), {
      id: witnessId,
      shiftType: "night",
      status: "completed",
      scheduledStart: iso(now - 20 * 60 * MINUTE),
      scheduledEnd: iso(now - 12 * 60 * MINUTE),
      actualStart: iso(now - 20 * 60 * MINUTE),
      actualEnd: iso(now - 12 * 60 * MINUTE),
      permanentPairId: pairId,
      operationalSlotToken: previousSlotToken,
      primaryTechnicianIds: [technicianA, technicianB],
      createdBy: supervisorUid,
      createdAt: createdAt,
      updatedAt: iso(now - 12 * 60 * MINUTE),
    });
  }

  await batch.commit();

  return {
    shiftId,
    pairId,
    technicianA,
    technicianB,
    technicianC,
    technicianD,
    supervisorUid,
    adminUid,
    slotToken,
    generation,
    authorizationId,
    scheduledStart,
    scheduledEnd,
    actor: {
      uid: technicianA,
      fullName: "Synthetic Pair Technician A",
      email: `${technicianA}@example.invalid`,
      role: "technician" as const,
      status: "active" as const,
      mustChangePassword: false,
    },
  };
}

async function docOf(collection: string, id: string) {
  const snapshot = await db.collection(collection).doc(id).get();

  return snapshot.exists ? (snapshot.data() as Record<string, unknown>) : null;
}

async function attendanceOf(shiftId: string, technicianUid: string) {
  return docOf("shift_attendance", `${shiftId}_${technicianUid}`);
}

async function startAudits(shiftId: string) {
  const snapshot = await db
    .collection("audit_logs")
    .where("shiftId", "==", shiftId)
    .where("action", "==", "SHIFT_STARTED")
    .get();

  return snapshot.docs.map((document) => document.data());
}

function isStatusError(expectedStatus: number) {
  return (error: unknown) => {
    const value = error as { status?: unknown };

    return Boolean(value) && value.status === expectedStatus;
  };
}

test(
  "a permanent-pair technician starts the first-ever shift and no attendance is fabricated",
  async () => {
    const f = await seedFirstShiftFixture();

    const result = await startShift({
      shiftId: f.shiftId,
      actorUid: f.technicianA,
    });

    assert.equal(result.status, "active");
    assert.equal(result.shiftId, f.shiftId);

    const shift = await docOf("shifts", f.shiftId);
    const control = await docOf(
      "operational_shift_control",
      "global"
    );

    assert.equal(shift?.status, "active");
    assert.equal(shift?.actualStart, result.actualStart);
    assert.equal(shift?.actualEnd, null);
    assert.equal(shift?.startedBy, f.technicianA);

    assert.equal(control?.shiftStatus, "active");
    assert.equal(control?.slotStatus, "consumed");
    assert.equal(control?.shiftId, f.shiftId);
    assert.equal(control?.generation, f.generation);

    const audits = await startAudits(f.shiftId);

    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorUid, f.technicianA);
    assert.equal(audits[0].actorRole, "technician");
    assert.equal(
      audits[0].startAuthority,
      "permanent_pair_bootstrap"
    );
    assert.equal(audits[0].temporaryAuthorizationId, null);

    /*
     * Starting is activation, never attendance.
     */
    for (const technicianUid of [
      f.technicianA,
      f.technicianB,
      f.technicianC,
    ]) {
      assert.equal(
        await attendanceOf(f.shiftId, technicianUid),
        null
      );
    }

    assert.equal(
      (await docOf("shift_members", `${f.shiftId}_${f.technicianA}`))?.role,
      "primary"
    );
    assert.equal(
      (await docOf("shift_members", `${f.shiftId}_${f.technicianB}`))?.role,
      "primary"
    );
  }
);

test(
  "the other permanent-pair technician can start the first-ever shift with equal authority",
  async () => {
    const f = await seedFirstShiftFixture();

    const result = await startShift({
      shiftId: f.shiftId,
      actorUid: f.technicianB,
    });

    assert.equal(result.status, "active");

    const shift = await docOf("shifts", f.shiftId);

    assert.equal(shift?.startedBy, f.technicianB);

    const audits = await startAudits(f.shiftId);

    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorUid, f.technicianB);
    assert.equal(
      audits[0].startAuthority,
      "permanent_pair_bootstrap"
    );
  }
);

test(
  "concurrent bootstrap start commits exactly once and leaves one active shift",
  { timeout: 60_000 },
  async () => {
    const f = await seedFirstShiftFixture();

    const results = await Promise.allSettled([
      startShift({ shiftId: f.shiftId, actorUid: f.technicianA }),
      startShift({ shiftId: f.shiftId, actorUid: f.technicianB }),
    ]);

    const fulfilled = results.filter(
      (result) => result.status === "fulfilled"
    );
    const rejected = results.filter(
      (result) => result.status === "rejected"
    );

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const rejection = rejected[0] as PromiseRejectedResult;

    assert.equal(
      (rejection.reason as { status?: unknown }).status,
      409
    );

    const shift = await docOf("shifts", f.shiftId);
    const control = await docOf(
      "operational_shift_control",
      "global"
    );

    assert.equal(shift?.status, "active");
    assert.equal(control?.shiftStatus, "active");
    assert.equal(await startAudits(f.shiftId).then((rows) => rows.length), 1);

    const activated = await db
      .collection("shifts")
      .where("status", "==", "active")
      .get();

    assert.equal(activated.size, 1);
  }
);

test(
  "a supervisor cannot start a shift",
  async () => {
    const f = await seedFirstShiftFixture();

    await assert.rejects(
      () =>
        startShift({
          shiftId: f.shiftId,
          actorUid: f.supervisorUid,
        }),
      (error: unknown) => {
        const value = error as { status?: unknown; message?: unknown };

        assert.equal(value.status, 403);
        assert.match(String(value.message), /Only an assigned technician/);

        return true;
      }
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
    assert.equal(
      (await docOf("operational_shift_control", "global"))?.shiftStatus,
      "scheduled"
    );
    assert.equal((await startAudits(f.shiftId)).length, 0);
  }
);

test(
  "an administrator cannot start a shift",
  async () => {
    const f = await seedFirstShiftFixture();

    await assert.rejects(
      () =>
        startShift({ shiftId: f.shiftId, actorUid: f.adminUid }),
      isStatusError(403)
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
    assert.equal((await startAudits(f.shiftId)).length, 0);
  }
);

test(
  "a technician outside the scheduled pair cannot start the first-ever shift",
  async () => {
    const f = await seedFirstShiftFixture();

    await assert.rejects(
      () => startShift({ shiftId: f.shiftId, actorUid: f.technicianD }),
      (error: unknown) => {
        const value = error as { status?: unknown; message?: unknown };

        assert.equal(value.status, 403);
        assert.match(
          String(value.message),
          /not authorized to start|not eligible/i
        );

        return true;
      }
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
    assert.equal((await startAudits(f.shiftId)).length, 0);
  }
);

test(
  "a blocked technician cannot start the first-ever shift",
  async () => {
    const f = await seedFirstShiftFixture({ actorAStatus: "blocked" });

    await assert.rejects(
      () => startShift({ shiftId: f.shiftId, actorUid: f.technicianA }),
      isStatusError(403)
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
    assert.equal((await startAudits(f.shiftId)).length, 0);
  }
);

test(
  "a technician who must change their password cannot start the first-ever shift",
  async () => {
    const f = await seedFirstShiftFixture({
      actorAMustChangePassword: true,
    });

    await assert.rejects(
      () => startShift({ shiftId: f.shiftId, actorUid: f.technicianA }),
      isStatusError(403)
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
  }
);

test(
  "starting before the activation window is rejected before bootstrap authority is used",
  async () => {
    const f = await seedFirstShiftFixture({ window: "premature" });

    await assert.rejects(
      () => startShift({ shiftId: f.shiftId, actorUid: f.technicianA }),
      (error: unknown) => {
        const value = error as { status?: unknown; message?: unknown };

        assert.equal(value.status, 409);
        assert.match(
          String(value.message),
          /activation window/i
        );

        return true;
      }
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
    assert.equal((await startAudits(f.shiftId)).length, 0);
  }
);

test(
  "an expired activation window rejects the manual start",
  async () => {
    const f = await seedFirstShiftFixture({ window: "expired" });

    await assert.rejects(
      () => startShift({ shiftId: f.shiftId, actorUid: f.technicianA }),
      (error: unknown) => {
        const value = error as { status?: unknown; message?: unknown };

        assert.equal(value.status, 409);
        assert.match(String(value.message), /activation window/i);

        return true;
      }
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
  }
);

test(
  "a consumed temporary authorization may activate the first-ever shift",
  async () => {
    const f = await seedFirstShiftFixture({ includeAuthorization: true });

    const result = await startShift({
      shiftId: f.shiftId,
      actorUid: f.technicianC,
    });

    assert.equal(result.status, "active");

    const audits = await startAudits(f.shiftId);

    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorUid, f.technicianC);
    assert.equal(audits[0].startAuthority, "temporary_authorization");
    assert.equal(
      audits[0].temporaryAuthorizationId,
      f.authorizationId
    );
  }
);

test(
  "a grant naming a permanent pair member never overrides bootstrap authority",
  async () => {
    const f = await seedFirstShiftFixture({
      includeAuthorization: true,
      grantNamesPairMember: true,
    });

    const result = await startShift({
      shiftId: f.shiftId,
      actorUid: f.technicianA,
    });

    assert.equal(result.status, "active");

    const audits = await startAudits(f.shiftId);

    assert.equal(audits.length, 1);
    assert.equal(
      audits[0].startAuthority,
      "permanent_pair_bootstrap"
    );
    assert.equal(audits[0].temporaryAuthorizationId, null);
  }
);

test(
  "a technician cannot borrow a grant that names someone else",
  async () => {
    const f = await seedFirstShiftFixture({
      includeAuthorization: true,
      grantNamesPairMember: true,
    });

    await assert.rejects(
      () => startShift({ shiftId: f.shiftId, actorUid: f.technicianC }),
      (error: unknown) => {
        const value = error as { status?: unknown; message?: unknown };

        assert.equal(value.status === 403 || value.status === 409, true);
        assert.match(
          String(value.message),
          /does not permit this technician|not authorize/i
        );

        return true;
      }
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
    assert.equal((await startAudits(f.shiftId)).length, 0);
  }
);

test(
  "manual start stays closed once the activation ledger holds a completed shift",
  async () => {
    const f = await seedFirstShiftFixture({ activatedWitness: true });

    await assert.rejects(
      () => startShift({ shiftId: f.shiftId, actorUid: f.technicianA }),
      (error: unknown) => {
        const value = error as { status?: unknown; message?: unknown };

        assert.equal(value.status, 409);
        assert.equal(
          value.message,
          FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE
        );

        return true;
      }
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
    assert.equal(
      (await docOf("operational_shift_control", "global"))?.shiftStatus,
      "scheduled"
    );
    assert.equal((await startAudits(f.shiftId)).length, 0);
  }
);

test(
  "a substitute technician is also refused once any shift has been activated",
  async () => {
    const f = await seedFirstShiftFixture({
      activatedWitness: true,
      includeAuthorization: true,
    });

    await assert.rejects(
      () => startShift({ shiftId: f.shiftId, actorUid: f.technicianC }),
      (error: unknown) => {
        const value = error as { status?: unknown; message?: unknown };

        assert.equal(value.status, 409);
        assert.equal(
          value.message,
          FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE
        );

        return true;
      }
    );

    assert.equal((await docOf("shifts", f.shiftId))?.status, "scheduled");
  }
);

test(
  "the technician view offers Start Shift only while bootstrap is open",
  async () => {
    const f = await seedFirstShiftFixture();

    const beforeStart = await getTechnicianCurrentShift(f.actor);

    assert.ok(beforeStart);
    assert.equal(beforeStart.firstShiftBootstrapAvailable, true);
    assert.equal(beforeStart.canStart, true);
    assert.equal(beforeStart.canJoin, false);

    const partnerView = await getTechnicianCurrentShift({
      ...f.actor,
      uid: f.technicianB,
      fullName: "Synthetic Pair Technician B",
      email: `${f.technicianB}@example.invalid`,
    });

    assert.ok(partnerView);
    assert.equal(partnerView.canStart, true);
    assert.equal(partnerView.canJoin, false);

    await startShift({ shiftId: f.shiftId, actorUid: f.technicianA });

    const afterStart = await getTechnicianCurrentShift({
      ...f.actor,
      uid: f.technicianB,
      fullName: "Synthetic Pair Technician B",
      email: `${f.technicianB}@example.invalid`,
    });

    assert.ok(afterStart);
    assert.equal(afterStart.firstShiftBootstrapAvailable, false);
    assert.equal(afterStart.canStart, false);
    assert.equal(afterStart.canJoin, true);
    assert.equal(afterStart.attendance, null);
  }
);

test(
  "the activated shift exposes no start authority when the ledger already holds it",
  async () => {
    const f = await seedFirstShiftFixture({ activatedWitness: true });

    const view = await getTechnicianCurrentShift(f.actor);

    assert.ok(view);
    assert.equal(view.firstShiftBootstrapAvailable, false);
    assert.equal(view.canStart, false);
    assert.equal(view.canJoin, false);
  }
);

test(
  "each initiator and partner records their own attendance after a bootstrap start",
  async () => {
    const f = await seedFirstShiftFixture();

    await startShift({ shiftId: f.shiftId, actorUid: f.technicianB });

    const initiator = await joinShift({
      shiftId: f.shiftId,
      actorUid: f.technicianB,
    });

    const partner = await joinShift({
      shiftId: f.shiftId,
      actorUid: f.technicianA,
    });

    assert.equal(initiator.participationAuthority, "primary");
    assert.equal(partner.participationAuthority, "primary");
    assert.equal(initiator.authorizationId, null);
    assert.equal(partner.authorizationId, null);

    const [initiatorRecord, partnerRecord] = await Promise.all([
      attendanceOf(f.shiftId, f.technicianB),
      attendanceOf(f.shiftId, f.technicianA),
    ]);

    assert.ok(initiatorRecord);
    assert.ok(partnerRecord);
    assert.equal(initiatorRecord.technicianId, f.technicianB);
    assert.equal(partnerRecord.technicianId, f.technicianA);
    assert.equal(
      initiatorRecord.id,
      `${f.shiftId}_${f.technicianB}`
    );

    /*
     * Each technician owns their own authoritative clock-in time.
     */
    assert.equal(initiatorRecord.recordedAt, initiator.recordedAt);
    assert.equal(partnerRecord.recordedAt, partner.recordedAt);

    await assert.rejects(
      () => joinShift({ shiftId: f.shiftId, actorUid: f.technicianA }),
      isStatusError(409)
    );

    assert.deepEqual(
      await attendanceOf(f.shiftId, f.technicianA),
      partnerRecord
    );
  }
);

test(
  "a duplicate bootstrap start after activation is rejected without a second audit",
  async () => {
    const f = await seedFirstShiftFixture();

    await startShift({ shiftId: f.shiftId, actorUid: f.technicianA });

    await assert.rejects(
      () => startShift({ shiftId: f.shiftId, actorUid: f.technicianB }),
      (error: unknown) => {
        const value = error as { status?: unknown; message?: unknown };

        assert.equal(value.status, 409);
        assert.match(String(value.message), /first shift|already|transition/i);

        return true;
      }
    );

    assert.equal((await startAudits(f.shiftId)).length, 1);
  }
);
