import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const EXPECTED_PROJECT_ID = "demo-shiftchange-ge";
const EXPECTED_PORT = "8088";

function failSafety(message: string): never {
  throw new Error(
    `EMULATOR SAFETY CHECK FAILED: ${message}`
  );
}

const emulatorHost =
  process.env.FIRESTORE_EMULATOR_HOST;

if (!emulatorHost) {
  failSafety(
    "FIRESTORE_EMULATOR_HOST is missing. Refusing to run."
  );
}

if (emulatorHost.includes("://")) {
  failSafety(
    "FIRESTORE_EMULATOR_HOST must not contain a protocol."
  );
}

const emulatorUrl =
  new URL(`http://${emulatorHost}`);

if (
  !["127.0.0.1", "localhost"].includes(
    emulatorUrl.hostname
  ) ||
  emulatorUrl.port !== EXPECTED_PORT
) {
  failSafety(
    `Expected local Firestore emulator on port ${EXPECTED_PORT}; received ${emulatorHost}.`
  );
}

for (const [name, value] of [
  ["FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID],
  [
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  ],
  ["GCLOUD_PROJECT", process.env.GCLOUD_PROJECT],
  [
    "GOOGLE_CLOUD_PROJECT",
    process.env.GOOGLE_CLOUD_PROJECT,
  ],
] as const) {
  if (value !== EXPECTED_PROJECT_ID) {
    failSafety(
      `${name} must equal ${EXPECTED_PROJECT_ID}; received ${String(value)}.`
    );
  }
}

if (!EXPECTED_PROJECT_ID.startsWith("demo-")) {
  failSafety(
    "The test project must use Firebase's demo- prefix."
  );
}

/*
 * Positively prove that the configured Firestore emulator is
 * responding before importing any application Firebase module.
 */
const probeResponse = await fetch(
  `http://${emulatorHost}/v1/projects/${EXPECTED_PROJECT_ID}/databases/(default)/documents`
);

if (
  probeResponse.status !== 200 &&
  probeResponse.status !== 404
) {
  failSafety(
    `Firestore emulator probe returned HTTP ${probeResponse.status}.`
  );
}

const {
  getAdminFirestore,
} = await import(
  "../src/lib/firebase/admin/index"
);

const {
  joinShift,
} = await import(
  "../src/lib/operations/join-shift"
);

const {
  beginShiftHandover,
} = await import(
  "../src/lib/operations/begin-shift-handover"
);

const {
  completeShift,
} = await import(
  "../src/lib/operations/complete-shift"
);

const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import(
  "../src/lib/operations/operational-shift-control-state"
);

const {
  buildPendingNextShiftAuthorization,
  createNextShiftAuthorizationDocumentId,
} = await import(
  "../src/lib/operations/next-shift-authorization-domain"
);

const db = getAdminFirestore();

let fixtureCounter = 0;

const timestamp =
  "2026-10-01T06:00:00.000Z";
const startedAt =
  "2026-10-01T06:05:00.000Z";
const scheduledStart =
  "2026-10-01T06:00:00.000Z";
const scheduledEnd =
  "2026-10-01T14:00:00.000Z";

function eligibleProfile(
  uid: string,
  fullName: string
) {
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

async function seedActiveFixture(options?: {
  cScheduleEntries?: Array<{
    shiftId: string;
    scheduledStart: string;
    scheduledEnd: string;
    status: "scheduled" | "active" | "handover_pending";
  }>;
  authorizationOverrides?: Record<string, unknown>;
  includeAuthorization?: boolean;
}) {
  fixtureCounter += 1;

  const suffix =
    `${Date.now()}-${fixtureCounter}`;

  const shiftId =
    `ge-shift-${suffix}`;
  const pairId =
    `ge-pair-${suffix}`;

  const technicianA =
    `ge-a-${suffix}`;
  const technicianB =
    `ge-b-${suffix}`;
  const technicianC =
    `ge-c-${suffix}`;

  const managerUid =
    `ge-manager-${suffix}`;

  const slotToken = randomUUID();
  const previousSlotToken = randomUUID();
  const generation = 1000 + fixtureCounter;

  const pair = {
    id: pairId,
    technicianIds: [
      technicianA,
      technicianB,
    ],
    status: "active",
    createdBy: managerUid,
    createdAt: timestamp,
    updatedAt: timestamp,
    deactivatedAt: null,
    deactivatedBy: null,
  };

  const firstPairMembership = {
    technicianUid: technicianA,
    pairId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const secondPairMembership = {
    technicianUid: technicianB,
    pairId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const pendingControl =
    createPendingOperationalShiftControl(
      slotToken,
      generation,
      timestamp,
      previousSlotToken,
      timestamp
    );

  const consumedControl =
    transitionOperationalShiftControl(
      consumeOperationalShiftSlot(
        pendingControl,
        shiftId,
        timestamp
      ),
      shiftId,
      "scheduled",
      "active",
      startedAt
    );

  const shift = {
    id: shiftId,
    shiftType: "morning",
    status: "active",
    scheduledStart,
    scheduledEnd,
    actualStart: startedAt,
    actualEnd: null,
    permanentPairId: pairId,
    operationalSlotToken: slotToken,
    primaryTechnicianIds: [
      technicianA,
      technicianB,
    ],
    createdBy: managerUid,
    createdAt: timestamp,
    updatedAt: startedAt,
  };

  const primaryMember = (
    technicianUid: string
  ) => ({
    id: `${shiftId}_${technicianUid}`,
    shiftId,
    technicianId: technicianUid,
    role: "primary",
    joinedAt: timestamp,
    leftAt: null,
  });

  const activeSchedule = (
    technicianUid: string
  ) => ({
    technicianUid,
    entries: [
      {
        shiftId,
        scheduledStart,
        scheduledEnd,
        status: "active",
      },
    ],
    updatedAt: startedAt,
  });

  const pendingAuthorization =
    buildPendingNextShiftAuthorization({
      control: pendingControl,
      pair,
      permanentPairId: pairId,
      authorizedTechnicianUid:
        technicianC,
      technicianEligibility: {
        eligible: true,
        message: null,
      },
      createdBy: managerUid,
      createdAt: timestamp,
    });

  const authorizationId =
    createNextShiftAuthorizationDocumentId(
      pairId,
      generation,
      slotToken
    );

  const authorization = {
    ...pendingAuthorization,
    id: authorizationId,
    status: "consumed",
    shiftId,
    consumedAt: timestamp,
    completedAt: null,
    expiredAt: null,
    updatedAt: timestamp,
    ...(options?.authorizationOverrides ?? {}),
  };

  const batch = db.batch();

  batch.set(
    db.collection("users").doc(technicianA),
    eligibleProfile(
      technicianA,
      "Synthetic Primary A"
    )
  );

  batch.set(
    db.collection("users").doc(technicianB),
    eligibleProfile(
      technicianB,
      "Synthetic Primary B"
    )
  );

  batch.set(
    db.collection("users").doc(technicianC),
    eligibleProfile(
      technicianC,
      "Synthetic Temporary C"
    )
  );

  batch.set(
    db.collection("technician_pairs").doc(pairId),
    pair
  );

  batch.set(
    db.collection(
      "technician_pair_memberships"
    ).doc(technicianA),
    firstPairMembership
  );

  batch.set(
    db.collection(
      "technician_pair_memberships"
    ).doc(technicianB),
    secondPairMembership
  );

  batch.set(
    db.collection("shifts").doc(shiftId),
    shift
  );

  batch.set(
    db.collection("shift_members").doc(
      `${shiftId}_${technicianA}`
    ),
    primaryMember(technicianA)
  );

  batch.set(
    db.collection("shift_members").doc(
      `${shiftId}_${technicianB}`
    ),
    primaryMember(technicianB)
  );

  batch.set(
    db.collection("technician_schedules").doc(
      technicianA
    ),
    activeSchedule(technicianA)
  );

  batch.set(
    db.collection("technician_schedules").doc(
      technicianB
    ),
    activeSchedule(technicianB)
  );

  if (options?.cScheduleEntries) {
    batch.set(
      db.collection("technician_schedules").doc(
        technicianC
      ),
      {
        technicianUid: technicianC,
        entries: options.cScheduleEntries,
        updatedAt: timestamp,
      }
    );
  }

  batch.set(
    db.collection(
      "operational_shift_control"
    ).doc("global"),
    consumedControl
  );

  if (
    options?.includeAuthorization !== false
  ) {
    batch.set(
      db.collection(
        "next_shift_authorizations"
      ).doc(authorizationId),
      authorization
    );
  }

  await batch.commit();

  return {
    shiftId,
    pairId,
    technicianA,
    technicianB,
    technicianC,
    managerUid,
    slotToken,
    generation,
    authorizationId,
    authorization,
    shift,
  };
}

async function attendanceFor(
  shiftId: string,
  technicianUid: string
) {
  return db
    .collection("shift_attendance")
    .doc(`${shiftId}_${technicianUid}`)
    .get();
}

async function memberFor(
  shiftId: string,
  technicianUid: string
) {
  return db
    .collection("shift_members")
    .doc(`${shiftId}_${technicianUid}`)
    .get();
}

async function joinedAuditCount(
  shiftId: string,
  technicianUid: string
) {
  const snapshot = await db
    .collection("audit_logs")
    .where("shiftId", "==", shiftId)
    .get();

  return snapshot.docs.filter((doc) => {
    const data = doc.data();

    return (
      data.action ===
        "SHIFT_TECHNICIAN_JOINED" &&
      data.technicianUid === technicianUid
    );
  }).length;
}

function isStatusError(
  expectedStatus: number
) {
  return (error: unknown) => {
    const value = error as {
      status?: unknown;
    };

    return (
      value &&
      value.status === expectedStatus
    );
  };
}


test(
  "primary A join commits one authoritative attendance record without changing roster authority",
  async () => {
    const fixture =
      await seedActiveFixture();

    const memberBefore =
      await memberFor(
        fixture.shiftId,
        fixture.technicianA
      );

    const scheduleBefore = await db
      .collection("technician_schedules")
      .doc(fixture.technicianA)
      .get();

    const attendance = await joinShift({
      shiftId: fixture.shiftId,
      actorUid: fixture.technicianA,
    });

    assert.equal(
      attendance.participationAuthority,
      "primary"
    );
    assert.equal(
      attendance.authorizationId,
      null
    );

    const attendanceSnapshot =
      await attendanceFor(
        fixture.shiftId,
        fixture.technicianA
      );

    assert.equal(
      attendanceSnapshot.exists,
      true
    );
    assert.equal(
      attendanceSnapshot.data()
        ?.status,
      "present"
    );

    const memberAfter =
      await memberFor(
        fixture.shiftId,
        fixture.technicianA
      );

    const scheduleAfter = await db
      .collection("technician_schedules")
      .doc(fixture.technicianA)
      .get();

    assert.deepEqual(
      memberAfter.data(),
      memberBefore.data()
    );

    assert.deepEqual(
      scheduleAfter.data(),
      scheduleBefore.data()
    );

    assert.equal(
      await joinedAuditCount(
        fixture.shiftId,
        fixture.technicianA
      ),
      1
    );
  }
);


test(
  "authorized temporary C join atomically creates attendance, ADDITIONAL membership, and active schedule",
  async () => {
    const fixture =
      await seedActiveFixture();

    const attendance = await joinShift({
      shiftId: fixture.shiftId,
      actorUid: fixture.technicianC,
    });

    assert.equal(
      attendance.participationAuthority,
      "temporary_authorized"
    );
    assert.equal(
      attendance.authorizationId,
      fixture.authorizationId
    );

    const [
      attendanceSnapshot,
      memberSnapshot,
      scheduleSnapshot,
      authorizationSnapshot,
      shiftSnapshot,
      pairA,
      pairB,
      cProfile,
    ] = await Promise.all([
      attendanceFor(
        fixture.shiftId,
        fixture.technicianC
      ),
      memberFor(
        fixture.shiftId,
        fixture.technicianC
      ),
      db
        .collection("technician_schedules")
        .doc(fixture.technicianC)
        .get(),
      db
        .collection(
          "next_shift_authorizations"
        )
        .doc(fixture.authorizationId)
        .get(),
      db
        .collection("shifts")
        .doc(fixture.shiftId)
        .get(),
      db
        .collection(
          "technician_pair_memberships"
        )
        .doc(fixture.technicianA)
        .get(),
      db
        .collection(
          "technician_pair_memberships"
        )
        .doc(fixture.technicianB)
        .get(),
      db
        .collection("users")
        .doc(fixture.technicianC)
        .get(),
    ]);

    assert.equal(
      attendanceSnapshot.exists,
      true
    );

    assert.equal(
      memberSnapshot.exists,
      true
    );
    assert.equal(
      memberSnapshot.data()?.role,
      "additional"
    );

    const cEntries =
      scheduleSnapshot.data()?.entries;

    assert.ok(
      Array.isArray(cEntries)
    );
    assert.equal(
      cEntries.length,
      1
    );
    assert.equal(
      cEntries[0].shiftId,
      fixture.shiftId
    );
    assert.equal(
      cEntries[0].status,
      "active"
    );

    assert.equal(
      authorizationSnapshot.data()?.status,
      "consumed"
    );
    assert.equal(
      authorizationSnapshot.data()?.shiftId,
      fixture.shiftId
    );
    assert.equal(
      authorizationSnapshot.data()?.completedAt,
      null
    );
    assert.equal(
      authorizationSnapshot.data()?.expiredAt,
      null
    );

    assert.deepEqual(
      shiftSnapshot.data()?.primaryTechnicianIds,
      [
        fixture.technicianA,
        fixture.technicianB,
      ]
    );

    assert.equal(
      pairA.data()?.pairId,
      fixture.pairId
    );
    assert.equal(
      pairB.data()?.pairId,
      fixture.pairId
    );

    assert.ok(
      cProfile.data()
        ?.lastAssignmentActivityAt
    );

    assert.equal(
      await joinedAuditCount(
        fixture.shiftId,
        fixture.technicianC
      ),
      1
    );
  }
);


test(
  "sequential duplicate join is rejected and cannot create duplicate attendance or audit",
  async () => {
    const fixture =
      await seedActiveFixture();

    await joinShift({
      shiftId: fixture.shiftId,
      actorUid: fixture.technicianA,
    });

    await assert.rejects(
      () =>
        joinShift({
          shiftId: fixture.shiftId,
          actorUid: fixture.technicianA,
        }),
      isStatusError(409)
    );

    assert.equal(
      (
        await attendanceFor(
          fixture.shiftId,
          fixture.technicianA
        )
      ).exists,
      true
    );

    assert.equal(
      await joinedAuditCount(
        fixture.shiftId,
        fixture.technicianA
      ),
      1
    );
  }
);


test(
  "concurrent duplicate join allows exactly one transaction to commit",
  {
    timeout: 60000,
  },
  async () => {
    const fixture =
      await seedActiveFixture();

    const results =
      await Promise.allSettled([
        joinShift({
          shiftId: fixture.shiftId,
          actorUid: fixture.technicianA,
        }),
        joinShift({
          shiftId: fixture.shiftId,
          actorUid: fixture.technicianA,
        }),
      ]);

    const fulfilled =
      results.filter(
        (result) =>
          result.status === "fulfilled"
      );

    const rejected =
      results.filter(
        (result) =>
          result.status === "rejected"
      );

    assert.equal(
      fulfilled.length,
      1
    );
    assert.equal(
      rejected.length,
      1
    );

    const rejectedReason =
      (
        rejected[0] as PromiseRejectedResult
      ).reason as {
        status?: unknown;
      };

    assert.equal(
      rejectedReason.status,
      409
    );

    assert.equal(
      (
        await attendanceFor(
          fixture.shiftId,
          fixture.technicianA
        )
      ).exists,
      true
    );

    assert.equal(
      await joinedAuditCount(
        fixture.shiftId,
        fixture.technicianA
      ),
      1
    );
  }
);


test(
  "temporary C schedule conflict rejects atomically with no attendance or membership",
  async () => {
    const fixture =
      await seedActiveFixture({
        cScheduleEntries: [
          {
            shiftId:
              `other-${randomUUID()}`,
            scheduledStart,
            scheduledEnd,
            status: "scheduled",
          },
        ],
      });

    await assert.rejects(
      () =>
        joinShift({
          shiftId: fixture.shiftId,
          actorUid: fixture.technicianC,
        }),
      isStatusError(409)
    );

    assert.equal(
      (
        await attendanceFor(
          fixture.shiftId,
          fixture.technicianC
        )
      ).exists,
      false
    );

    assert.equal(
      (
        await memberFor(
          fixture.shiftId,
          fixture.technicianC
        )
      ).exists,
      false
    );

    const authorizationSnapshot =
      await db
        .collection(
          "next_shift_authorizations"
        )
        .doc(fixture.authorizationId)
        .get();

    assert.equal(
      authorizationSnapshot.data()?.status,
      "consumed"
    );

    assert.equal(
      await joinedAuditCount(
        fixture.shiftId,
        fixture.technicianC
      ),
      0
    );
  }
);


test(
  "changed lifecycle rejects join with no partial participation state",
  async () => {
    const fixture =
      await seedActiveFixture();

    await Promise.all([
      db
        .collection("shifts")
        .doc(fixture.shiftId)
        .update({
          status: "handover_pending",
          updatedAt:
            "2026-10-01T07:00:00.000Z",
        }),
      db
        .collection(
          "operational_shift_control"
        )
        .doc("global")
        .update({
          shiftStatus:
            "handover_pending",
          updatedAt:
            "2026-10-01T07:00:00.000Z",
        }),
    ]);

    await assert.rejects(
      () =>
        joinShift({
          shiftId: fixture.shiftId,
          actorUid: fixture.technicianC,
        }),
      (error: unknown) => {
        const value = error as {
          status?: unknown;
        };

        return (
          value.status === 409 ||
          value.status === 403
        );
      }
    );

    assert.equal(
      (
        await attendanceFor(
          fixture.shiftId,
          fixture.technicianC
        )
      ).exists,
      false
    );

    assert.equal(
      (
        await memberFor(
          fixture.shiftId,
          fixture.technicianC
        )
      ).exists,
      false
    );

    assert.equal(
      await joinedAuditCount(
        fixture.shiftId,
        fixture.technicianC
      ),
      0
    );
  }
);


test(
  "invalid temporary authorization rejects atomically",
  async () => {
    const fixture =
      await seedActiveFixture({
        authorizationOverrides: {
          authorizedTechnicianUid:
            `wrong-${randomUUID()}`,
        },
      });

    await assert.rejects(
      () =>
        joinShift({
          shiftId: fixture.shiftId,
          actorUid: fixture.technicianC,
        }),
      isStatusError(403)
    );

    assert.equal(
      (
        await attendanceFor(
          fixture.shiftId,
          fixture.technicianC
        )
      ).exists,
      false
    );

    assert.equal(
      (
        await memberFor(
          fixture.shiftId,
          fixture.technicianC
        )
      ).exists,
      false
    );

    assert.equal(
      await joinedAuditCount(
        fixture.shiftId,
        fixture.technicianC
      ),
      0
    );
  }
);


test(
  "missing temporary authorization rejects with no participation writes",
  async () => {
    const fixture =
      await seedActiveFixture({
        includeAuthorization: false,
      });

    await assert.rejects(
      () =>
        joinShift({
          shiftId: fixture.shiftId,
          actorUid: fixture.technicianC,
        }),
      isStatusError(403)
    );

    assert.equal(
      (
        await attendanceFor(
          fixture.shiftId,
          fixture.technicianC
        )
      ).exists,
      false
    );

    assert.equal(
      (
        await memberFor(
          fixture.shiftId,
          fixture.technicianC
        )
      ).exists,
      false
    );
  }
);
/* ============================================================
 * G-F.2C - HANDOVER + COMPLETION FIRESTORE EMULATOR TESTS
 * ============================================================ */

async function gfDoc(collection: string, id: string) {
  const snap = await db.collection(collection).doc(id).get();
  return snap.exists
    ? (snap.data() as Record<string, unknown>)
    : null;
}

async function gfManager(uid: string) {
  await db.collection("users").doc(uid).set({
    uid,
    fullName: "Synthetic G-F.2C Supervisor",
    email: `${uid}@example.invalid`,
    role: "supervisor",
    status: "active",
    mustChangePassword: false,
    statusOperation: null,
  });
}

async function gfMember(
  shiftId: string,
  uid: string
) {
  return gfDoc(
    "shift_members",
    `${shiftId}_${uid}`
  );
}

async function gfAttendance(
  shiftId: string,
  uid: string
) {
  return gfDoc(
    "shift_attendance",
    `${shiftId}_${uid}`
  );
}

async function gfSchedule(uid: string) {
  return gfDoc(
    "technician_schedules",
    uid
  );
}

function gfEntries(
  schedule: Record<string, unknown> | null,
  shiftId: string
) {
  assert.ok(
    schedule &&
    Array.isArray(schedule.entries)
  );

  return schedule.entries.filter(
    (
      entry
    ): entry is Record<string, unknown> =>
      Boolean(
        entry &&
        typeof entry === "object" &&
        (
          entry as Record<string, unknown>
        ).shiftId === shiftId
      )
  );
}

async function gfAuditCount(
  shiftId: string,
  action: string
) {
  const snap = await db
    .collection("audit_logs")
    .where("shiftId", "==", shiftId)
    .get();

  return snap.docs.filter(
    (doc) =>
      doc.data().action === action
  ).length;
}

async function gfState(
  f: Awaited<
    ReturnType<typeof seedActiveFixture>
  >
) {
  return {
    shift:
      await gfDoc(
        "shifts",
        f.shiftId
      ),

    control:
      await gfDoc(
        "operational_shift_control",
        "global"
      ),

    memberA:
      await gfMember(
        f.shiftId,
        f.technicianA
      ),

    memberB:
      await gfMember(
        f.shiftId,
        f.technicianB
      ),

    memberC:
      await gfMember(
        f.shiftId,
        f.technicianC
      ),

    scheduleA:
      await gfSchedule(
        f.technicianA
      ),

    scheduleB:
      await gfSchedule(
        f.technicianB
      ),

    scheduleC:
      await gfSchedule(
        f.technicianC
      ),

    authorization:
      await gfDoc(
        "next_shift_authorizations",
        f.authorizationId
      ),

    attendanceC:
      await gfAttendance(
        f.shiftId,
        f.technicianC
      ),
  };
}

test(
  "G-F.2C A B C lifecycle finalizes atomically without mutating attendance or permanent pair authority",
  async () => {
    const f =
      await seedActiveFixture();

    await gfManager(
      f.managerUid
    );

    const pairBefore =
      await gfDoc(
        "technician_pairs",
        f.pairId
      );

    const reservationABefore =
      await gfDoc(
        "technician_pair_memberships",
        f.technicianA
      );

    const reservationBBefore =
      await gfDoc(
        "technician_pair_memberships",
        f.technicianB
      );

    const joined =
      await joinShift({
        shiftId: f.shiftId,
        actorUid: f.technicianC,
      });

    assert.equal(
      joined.participationAuthority,
      "temporary_authorized"
    );

    assert.equal(
      joined.authorizationId,
      f.authorizationId
    );

    const attendanceBefore =
      await gfAttendance(
        f.shiftId,
        f.technicianC
      );

    const authorizationBefore =
      await gfDoc(
        "next_shift_authorizations",
        f.authorizationId
      );

    const handover =
      await beginShiftHandover({
        shiftId: f.shiftId,
        actorUid: f.managerUid,
      });

    assert.equal(
      handover.status,
      "handover_pending"
    );

    const handoverControl =
      await gfDoc(
        "operational_shift_control",
        "global"
      );

    assert.equal(
      handoverControl?.slotStatus,
      "consumed"
    );

    assert.equal(
      handoverControl?.shiftStatus,
      "handover_pending"
    );

    assert.equal(
      handoverControl?.slotToken,
      f.slotToken
    );

    assert.equal(
      handoverControl?.generation,
      f.generation
    );

    for (
      const uid of [
        f.technicianA,
        f.technicianB,
        f.technicianC,
      ]
    ) {
      const entries =
        gfEntries(
          await gfSchedule(uid),
          f.shiftId
        );

      assert.equal(
        entries.length,
        1
      );

      assert.equal(
        entries[0].status,
        "handover_pending"
      );
    }

    assert.deepEqual(
      await gfAttendance(
        f.shiftId,
        f.technicianC
      ),
      attendanceBefore
    );

    assert.deepEqual(
      await gfDoc(
        "next_shift_authorizations",
        f.authorizationId
      ),
      authorizationBefore
    );

    assert.equal(
      (
        await gfMember(
          f.shiftId,
          f.technicianC
        )
      )?.leftAt,
      null
    );

    const completed =
      await completeShift({
        shiftId: f.shiftId,
        actorUid: f.managerUid,
      });

    const shift =
      await gfDoc(
        "shifts",
        f.shiftId
      );

    const control =
      await gfDoc(
        "operational_shift_control",
        "global"
      );

    const authorization =
      await gfDoc(
        "next_shift_authorizations",
        f.authorizationId
      );

    assert.equal(
      completed.status,
      "completed"
    );

    assert.equal(
      shift?.status,
      "completed"
    );

    assert.equal(
      shift?.actualEnd,
      completed.actualEnd
    );

    assert.equal(
      shift?.completedBy,
      f.managerUid
    );

    assert.equal(
      control?.slotStatus,
      "pending"
    );

    assert.equal(
      control?.generation,
      f.generation + 1
    );

    assert.equal(
      control?.previousSlotToken,
      f.slotToken
    );

    assert.notEqual(
      control?.slotToken,
      f.slotToken
    );

    assert.equal(
      authorization?.status,
      "completed"
    );

    assert.equal(
      authorization?.completedAt,
      completed.actualEnd
    );

    assert.equal(
      authorization?.expiredAt,
      null
    );

    for (
      const [uid, role] of [
        [
          f.technicianA,
          "primary",
        ],
        [
          f.technicianB,
          "primary",
        ],
        [
          f.technicianC,
          "additional",
        ],
      ] as const
    ) {
      const member =
        await gfMember(
          f.shiftId,
          uid
        );

      assert.equal(
        member?.role,
        role
      );

      assert.equal(
        member?.leftAt,
        completed.actualEnd
      );

      assert.equal(
        gfEntries(
          await gfSchedule(uid),
          f.shiftId
        ).length,
        0
      );
    }

    assert.deepEqual(
      await gfAttendance(
        f.shiftId,
        f.technicianC
      ),
      attendanceBefore
    );

    assert.deepEqual(
      await gfDoc(
        "technician_pairs",
        f.pairId
      ),
      pairBefore
    );

    assert.deepEqual(
      await gfDoc(
        "technician_pair_memberships",
        f.technicianA
      ),
      reservationABefore
    );

    assert.deepEqual(
      await gfDoc(
        "technician_pair_memberships",
        f.technicianB
      ),
      reservationBBefore
    );

    assert.equal(
      await gfAuditCount(
        f.shiftId,
        "SHIFT_HANDOVER_STARTED"
      ),
      1
    );

    assert.equal(
      await gfAuditCount(
        f.shiftId,
        "SHIFT_COMPLETED"
      ),
      1
    );
  }
);

test(
  "G-F.2C ordinary A B completion works without authorization or fabricated attendance",
  async () => {
    const f =
      await seedActiveFixture({
        includeAuthorization:
          false,
      });

    await gfManager(
      f.managerUid
    );

    await beginShiftHandover({
      shiftId: f.shiftId,
      actorUid: f.managerUid,
    });

    const completed =
      await completeShift({
        shiftId: f.shiftId,
        actorUid: f.managerUid,
      });

    for (
      const uid of [
        f.technicianA,
        f.technicianB,
        f.technicianC,
      ]
    ) {
      assert.equal(
        await gfAttendance(
          f.shiftId,
          uid
        ),
        null
      );
    }

    assert.equal(
      await gfMember(
        f.shiftId,
        f.technicianC
      ),
      null
    );

    assert.equal(
      await gfSchedule(
        f.technicianC
      ),
      null
    );

    assert.equal(
      await gfDoc(
        "next_shift_authorizations",
        f.authorizationId
      ),
      null
    );

    for (
      const uid of [
        f.technicianA,
        f.technicianB,
      ]
    ) {
      assert.equal(
        (
          await gfMember(
            f.shiftId,
            uid
          )
        )?.leftAt,
        completed.actualEnd
      );

      assert.equal(
        gfEntries(
          await gfSchedule(uid),
          f.shiftId
        ).length,
        0
      );
    }

    const control =
      await gfDoc(
        "operational_shift_control",
        "global"
      );

    assert.equal(
      control?.slotStatus,
      "pending"
    );

    assert.equal(
      control?.generation,
      f.generation + 1
    );
  }
);

test(
  "G-F.2C consumed authorization completes when C never joins without creating C participation",
  async () => {
    const f =
      await seedActiveFixture();

    await gfManager(
      f.managerUid
    );

    await beginShiftHandover({
      shiftId: f.shiftId,
      actorUid: f.managerUid,
    });

    const completed =
      await completeShift({
        shiftId: f.shiftId,
        actorUid: f.managerUid,
      });

    const authorization =
      await gfDoc(
        "next_shift_authorizations",
        f.authorizationId
      );

    assert.equal(
      authorization?.status,
      "completed"
    );

    assert.equal(
      authorization?.completedAt,
      completed.actualEnd
    );

    assert.equal(
      authorization?.expiredAt,
      null
    );

    assert.equal(
      await gfMember(
        f.shiftId,
        f.technicianC
      ),
      null
    );

    assert.equal(
      await gfAttendance(
        f.shiftId,
        f.technicianC
      ),
      null
    );

    assert.equal(
      await gfSchedule(
        f.technicianC
      ),
      null
    );
  }
);

test(
  "G-F.2C malformed temporary attendance aborts completion atomically",
  async () => {
    const f =
      await seedActiveFixture();

    await gfManager(
      f.managerUid
    );

    await joinShift({
      shiftId: f.shiftId,
      actorUid: f.technicianC,
    });

    await beginShiftHandover({
      shiftId: f.shiftId,
      actorUid: f.managerUid,
    });

    await db
      .collection(
        "shift_attendance"
      )
      .doc(
        `${f.shiftId}_${f.technicianC}`
      )
      .update({
        authorizationId:
          "gf2c-wrong-authorization",
      });

    const before =
      await gfState(f);

    await assert.rejects(
      () =>
        completeShift({
          shiftId: f.shiftId,
          actorUid: f.managerUid,
        }),
      isStatusError(409)
    );

    const after =
      await gfState(f);

    assert.deepEqual(
      after,
      before
    );

    assert.equal(
      after.shift?.status,
      "handover_pending"
    );

    assert.equal(
      after.control?.shiftStatus,
      "handover_pending"
    );

    assert.equal(
      after.authorization?.status,
      "consumed"
    );

    assert.equal(
      after.memberA?.leftAt,
      null
    );

    assert.equal(
      after.memberB?.leftAt,
      null
    );

    assert.equal(
      after.memberC?.leftAt,
      null
    );

    assert.equal(
      await gfAuditCount(
        f.shiftId,
        "SHIFT_COMPLETED"
      ),
      0
    );
  }
);

test(
  "G-F.2C handover rejects malformed persisted membership identity without partial writes",
  async () => {
    const f =
      await seedActiveFixture({
        includeAuthorization:
          false,
      });

    await gfManager(
      f.managerUid
    );

    await db
      .collection(
        "shift_members"
      )
      .doc(
        `${f.shiftId}_${f.technicianA}`
      )
      .update({
        id:
          "gf2c-corrupt-member-id",
      });

    const before = {
      shift:
        await gfDoc(
          "shifts",
          f.shiftId
        ),

      control:
        await gfDoc(
          "operational_shift_control",
          "global"
        ),

      scheduleA:
        await gfSchedule(
          f.technicianA
        ),

      scheduleB:
        await gfSchedule(
          f.technicianB
        ),
    };

    await assert.rejects(
      () =>
        beginShiftHandover({
          shiftId: f.shiftId,
          actorUid: f.managerUid,
        }),
      isStatusError(409)
    );

    assert.deepEqual(
      await gfDoc(
        "shifts",
        f.shiftId
      ),
      before.shift
    );

    assert.deepEqual(
      await gfDoc(
        "operational_shift_control",
        "global"
      ),
      before.control
    );

    assert.deepEqual(
      await gfSchedule(
        f.technicianA
      ),
      before.scheduleA
    );

    assert.deepEqual(
      await gfSchedule(
        f.technicianB
      ),
      before.scheduleB
    );

    assert.equal(
      await gfAuditCount(
        f.shiftId,
        "SHIFT_HANDOVER_STARTED"
      ),
      0
    );
  }
);

test(
  "G-F.2C concurrent completion commits exactly once and advances the slot exactly once",
  async () => {
    const f =
      await seedActiveFixture({
        includeAuthorization:
          false,
      });

    await gfManager(
      f.managerUid
    );

    await beginShiftHandover({
      shiftId: f.shiftId,
      actorUid: f.managerUid,
    });

    const results =
      await Promise.allSettled([
        completeShift({
          shiftId: f.shiftId,
          actorUid: f.managerUid,
        }),

        completeShift({
          shiftId: f.shiftId,
          actorUid: f.managerUid,
        }),
      ]);

    assert.equal(
      results.filter(
        (result) =>
          result.status ===
          "fulfilled"
      ).length,
      1
    );

    assert.equal(
      results.filter(
        (result) =>
          result.status ===
          "rejected"
      ).length,
      1
    );

    const rejection =
      results.find(
        (result) =>
          result.status ===
          "rejected"
      );

    assert.ok(
      rejection &&
      rejection.status ===
        "rejected"
    );

    assert.equal(
      (
        rejection.reason as {
          status?: unknown;
        }
      ).status,
      409
    );

    const shift =
      await gfDoc(
        "shifts",
        f.shiftId
      );

    const control =
      await gfDoc(
        "operational_shift_control",
        "global"
      );

    assert.equal(
      shift?.status,
      "completed"
    );

    assert.equal(
      control?.slotStatus,
      "pending"
    );

    assert.equal(
      control?.generation,
      f.generation + 1
    );

    assert.equal(
      control?.previousSlotToken,
      f.slotToken
    );

    assert.notEqual(
      control?.slotToken,
      f.slotToken
    );

    assert.equal(
      await gfAuditCount(
        f.shiftId,
        "SHIFT_COMPLETED"
      ),
      1
    );

    for (
      const uid of [
        f.technicianA,
        f.technicianB,
      ]
    ) {
      assert.equal(
        (
          await gfMember(
            f.shiftId,
            uid
          )
        )?.leftAt,
        shift?.actualEnd
      );

      assert.equal(
        gfEntries(
          await gfSchedule(uid),
          f.shiftId
        ).length,
        0
      );
    }
  }
);