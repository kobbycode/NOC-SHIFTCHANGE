import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const EXPECTED_PROJECT_ID =
  "demo-shiftchange-recovery";

const EXPECTED_PORT =
  "8088";

function failSafety(
  message: string
): never {
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

if (
  emulatorHost.includes("://")
) {
  failSafety(
    "FIRESTORE_EMULATOR_HOST must not contain a protocol."
  );
}

const emulatorUrl =
  new URL(
    `http://${emulatorHost}`
  );

if (
  ![
    "127.0.0.1",
    "localhost",
  ].includes(
    emulatorUrl.hostname
  ) ||
  emulatorUrl.port !==
    EXPECTED_PORT
) {
  failSafety(
    `Expected local Firestore emulator on port ${EXPECTED_PORT}; received ${emulatorHost}.`
  );
}

for (
  const [
    name,
    value,
  ] of [
    [
      "FIREBASE_PROJECT_ID",
      process.env.FIREBASE_PROJECT_ID,
    ],
    [
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    ],
    [
      "GCLOUD_PROJECT",
      process.env.GCLOUD_PROJECT,
    ],
    [
      "GOOGLE_CLOUD_PROJECT",
      process.env.GOOGLE_CLOUD_PROJECT,
    ],
  ] as const
) {
  if (
    value !==
    EXPECTED_PROJECT_ID
  ) {
    failSafety(
      `${name} must equal ${EXPECTED_PROJECT_ID}; received ${String(value)}.`
    );
  }
}

if (
  !EXPECTED_PROJECT_ID.startsWith(
    "demo-"
  )
) {
  failSafety(
    "The test project must use Firebase's demo- prefix."
  );
}

/*
 * Positively prove that the local
 * emulator is responding before any
 * application Firebase module is
 * imported.
 */

const probeResponse =
  await fetch(
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
  recoverExpiredScheduledShift,
} = await import(
  "../src/lib/operations/recover-expired-scheduled-shift"
);

const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
} = await import(
  "../src/lib/operations/operational-shift-control-state"
);

const {
  buildPendingNextShiftAuthorization,
  createNextShiftAuthorizationDocumentId,
} = await import(
  "../src/lib/operations/next-shift-authorization-domain"
);

const db =
  getAdminFirestore();

let fixtureCounter = 0;

const createdAt =
  "2020-01-01T05:00:00.000Z";

const scheduledStart =
  "2020-01-01T06:00:00.000Z";

const scheduledEnd =
  "2020-01-01T14:00:00.000Z";

const unrelatedStart =
  "2020-01-02T06:00:00.000Z";

const unrelatedEnd =
  "2020-01-02T14:00:00.000Z";

function profile(
  uid: string,
  role:
    | "admin"
    | "supervisor"
    | "technician"
) {
  return {
    uid,

    fullName:
      `Synthetic ${role} ${uid}`,

    email:
      `${uid}@example.invalid`,

    role,

    status:
      "active",

    mustChangePassword:
      false,

    statusOperation:
      null,
  };
}

interface FixtureOptions {
  includeAuthorization?: boolean;

  actorRole?:
    | "admin"
    | "supervisor";

  includeAttendance?: boolean;

  unresolvedTask?: boolean;

  corruptScheduleA?: boolean;
}

async function seedFixture(
  options: FixtureOptions = {}
) {
  fixtureCounter += 1;

  const suffix =
    `${Date.now()}-${fixtureCounter}`;

  const shiftId =
    `recovery-shift-${suffix}`;

  const pairId =
    `recovery-pair-${suffix}`;

  const technicianA =
    `recovery-a-${suffix}`;

  const technicianB =
    `recovery-b-${suffix}`;

  const technicianC =
    `recovery-c-${suffix}`;

  const actorUid =
    `recovery-actor-${suffix}`;

  const actorRole =
    options.actorRole ??
    "admin";

  const slotToken =
    randomUUID();

  const previousSlotToken =
    randomUUID();

  const generation =
    5000 +
    fixtureCounter;

  const pair = {
    id:
      pairId,

    technicianIds: [
      technicianA,
      technicianB,
    ],

    status:
      "active",

    createdBy:
      actorUid,

    createdAt,

    updatedAt:
      createdAt,

    deactivatedAt:
      null,

    deactivatedBy:
      null,
  };

  const pendingControl =
    createPendingOperationalShiftControl(
      slotToken,
      generation,
      createdAt,
      previousSlotToken,
      createdAt
    );

  const consumedControl =
    consumeOperationalShiftSlot(
      pendingControl,
      shiftId,
      createdAt
    );

  const shift = {
    id:
      shiftId,

    shiftType:
      "morning",

    status:
      "scheduled",

    scheduledStart,

    scheduledEnd,

    actualStart:
      null,

    actualEnd:
      null,

    handoverStartedAt:
      null,

    permanentPairId:
      pairId,

    operationalSlotToken:
      slotToken,

    primaryTechnicianIds: [
      technicianA,
      technicianB,
    ],

    createdBy:
      actorUid,

    createdAt,

    updatedAt:
      createdAt,
  };

  function member(
    technicianUid: string
  ) {
    return {
      id:
        `${shiftId}_${technicianUid}`,

      shiftId,

      technicianId:
        technicianUid,

      role:
        "primary",

      joinedAt:
        createdAt,

      leftAt:
        null,
    };
  }

  function schedule(
    technicianUid: string,
    corrupt = false
  ) {
    return {
      technicianUid,

      entries: [
        {
          shiftId,

          scheduledStart:
            corrupt
              ? "2020-01-01T07:00:00.000Z"
              : scheduledStart,

          scheduledEnd,

          status:
            "scheduled",
        },

        {
          shiftId:
            `unrelated-${technicianUid}`,

          scheduledStart:
            unrelatedStart,

          scheduledEnd:
            unrelatedEnd,

          status:
            "scheduled",
        },
      ],

      updatedAt:
        createdAt,
    };
  }

  const reservationA = {
    technicianUid:
      technicianA,

    pairId,

    createdAt,

    updatedAt:
      createdAt,
  };

  const reservationB = {
    technicianUid:
      technicianB,

    pairId,

    createdAt,

    updatedAt:
      createdAt,
  };

  const pendingAuthorization =
    buildPendingNextShiftAuthorization({
      control:
        pendingControl,

      pair,

      permanentPairId:
        pairId,

      authorizedTechnicianUid:
        technicianC,

      technicianEligibility: {
        eligible:
          true,

        message:
          null,
      },

      createdBy:
        actorUid,

      createdAt,
    });

  const authorizationId =
    createNextShiftAuthorizationDocumentId(
      pairId,
      generation,
      slotToken
    );

  const authorization = {
    ...pendingAuthorization,

    id:
      authorizationId,

    status:
      "consumed",

    shiftId,

    consumedAt:
      createdAt,

    completedAt:
      null,

    expiredAt:
      null,

    updatedAt:
      createdAt,
  };

  const batch =
    db.batch();

  batch.set(
    db
      .collection("users")
      .doc(actorUid),
    profile(
      actorUid,
      actorRole
    )
  );

  batch.set(
    db
      .collection("users")
      .doc(technicianA),
    profile(
      technicianA,
      "technician"
    )
  );

  batch.set(
    db
      .collection("users")
      .doc(technicianB),
    profile(
      technicianB,
      "technician"
    )
  );

  batch.set(
    db
      .collection("users")
      .doc(technicianC),
    profile(
      technicianC,
      "technician"
    )
  );

  batch.set(
    db
      .collection(
        "technician_pairs"
      )
      .doc(pairId),
    pair
  );

  batch.set(
    db
      .collection(
        "technician_pair_memberships"
      )
      .doc(technicianA),
    reservationA
  );

  batch.set(
    db
      .collection(
        "technician_pair_memberships"
      )
      .doc(technicianB),
    reservationB
  );

  batch.set(
    db
      .collection("shifts")
      .doc(shiftId),
    shift
  );

  batch.set(
    db
      .collection(
        "shift_members"
      )
      .doc(
        `${shiftId}_${technicianA}`
      ),
    member(
      technicianA
    )
  );

  batch.set(
    db
      .collection(
        "shift_members"
      )
      .doc(
        `${shiftId}_${technicianB}`
      ),
    member(
      technicianB
    )
  );

  batch.set(
    db
      .collection(
        "technician_schedules"
      )
      .doc(technicianA),
    schedule(
      technicianA,
      options.corruptScheduleA ===
        true
    )
  );

  batch.set(
    db
      .collection(
        "technician_schedules"
      )
      .doc(technicianB),
    schedule(
      technicianB
    )
  );

  batch.set(
    db
      .collection(
        "operational_shift_control"
      )
      .doc("global"),
    consumedControl
  );

  if (
    options.includeAuthorization !==
    false
  ) {
    batch.set(
      db
        .collection(
          "next_shift_authorizations"
        )
        .doc(
          authorizationId
        ),
      authorization
    );
  }

  if (
    options.includeAttendance ===
    true
  ) {
    batch.set(
      db
        .collection(
          "shift_attendance"
        )
        .doc(
          `${shiftId}_${technicianA}`
        ),
      {
        id:
          `${shiftId}_${technicianA}`,

        shiftId,

        technicianId:
          technicianA,

        status:
          "present",

        participationAuthority:
          "primary",

        authorizationId:
          null,

        isProvisional:
          false,

        clockIn:
          null,

        clockOut:
          null,

        recordedAt:
          createdAt,

        updatedAt:
          createdAt,
      }
    );
  }

  if (
    options.unresolvedTask ===
    true
  ) {
    const taskId =
      `recovery-task-${suffix}`;

    batch.set(
      db
        .collection("tasks")
        .doc(taskId),
      {
        id:
          taskId,

        shiftId,

        status:
          "open",

        title:
          "Synthetic unresolved recovery task",

        description:
          "Must block scheduled recovery.",

        priority:
          "medium",

        sectionId:
          null,

        createdBy:
          actorUid,

        createdAt,

        updatedAt:
          createdAt,
      }
    );
  }

  await batch.commit();

  return {
    shiftId,
    pairId,
    technicianA,
    technicianB,
    technicianC,
    actorUid,
    actorRole,
    slotToken,
    previousSlotToken,
    generation,
    authorizationId,
    pair,
    reservationA,
    reservationB,
  };
}

async function doc(
  collection: string,
  id: string
) {
  const snapshot =
    await db
      .collection(collection)
      .doc(id)
      .get();

  return snapshot.exists
    ? snapshot.data() as
        Record<string, unknown>
    : null;
}

async function attendanceCount(
  shiftId: string
) {
  const snapshot =
    await db
      .collection(
        "shift_attendance"
      )
      .where(
        "shiftId",
        "==",
        shiftId
      )
      .get();

  return snapshot.size;
}

async function auditCount(
  shiftId: string,
  action: string
) {
  const snapshot =
    await db
      .collection("audit_logs")
      .where(
        "shiftId",
        "==",
        shiftId
      )
      .get();

  return snapshot.docs.filter(
    (document) =>
      document.data().action ===
      action
  ).length;
}

function entriesFor(
  schedule:
    Record<string, unknown> |
    null
) {
  assert.ok(
    schedule &&
    Array.isArray(
      schedule.entries
    )
  );

  return schedule.entries as
    Array<Record<string, unknown>>;
}

function matchingEntries(
  schedule:
    Record<string, unknown> |
    null,
  shiftId: string
) {
  return entriesFor(
    schedule
  ).filter(
    (entry) =>
      entry.shiftId ===
      shiftId
  );
}

function isStatusError(
  status: number
) {
  return (
    error: unknown
  ) => {
    const value =
      error as {
        status?: unknown;
      };

    return (
      value?.status ===
      status
    );
  };
}

async function recoveryState(
  fixture:
    Awaited<
      ReturnType<
        typeof seedFixture
      >
    >
) {
  return {
    shift:
      await doc(
        "shifts",
        fixture.shiftId
      ),

    control:
      await doc(
        "operational_shift_control",
        "global"
      ),

    memberA:
      await doc(
        "shift_members",
        `${fixture.shiftId}_${fixture.technicianA}`
      ),

    memberB:
      await doc(
        "shift_members",
        `${fixture.shiftId}_${fixture.technicianB}`
      ),

    scheduleA:
      await doc(
        "technician_schedules",
        fixture.technicianA
      ),

    scheduleB:
      await doc(
        "technician_schedules",
        fixture.technicianB
      ),

    authorization:
      await doc(
        "next_shift_authorizations",
        fixture.authorizationId
      ),

    pair:
      await doc(
        "technician_pairs",
        fixture.pairId
      ),

    reservationA:
      await doc(
        "technician_pair_memberships",
        fixture.technicianA
      ),

    reservationB:
      await doc(
        "technician_pair_memberships",
        fixture.technicianB
      ),

    attendanceCount:
      await attendanceCount(
        fixture.shiftId
      ),

    auditCount:
      await auditCount(
        fixture.shiftId,
        "SHIFT_CANCELLED"
      ),
  };
}

/*
 * 1. Full successful recovery with
 * consumed temporary authorization.
 */

test(
  "expired scheduled recovery atomically cancels shift releases A B expires C authorization and advances slot",
  async () => {
    const fixture =
      await seedFixture();

    const pairBefore =
      await doc(
        "technician_pairs",
        fixture.pairId
      );

    const reservationABefore =
      await doc(
        "technician_pair_memberships",
        fixture.technicianA
      );

    const reservationBBefore =
      await doc(
        "technician_pair_memberships",
        fixture.technicianB
      );

    const result =
      await recoverExpiredScheduledShift({
        shiftId:
          fixture.shiftId,

        actorUid:
          fixture.actorUid,
      });

    assert.equal(
      result.status,
      "cancelled"
    );

    assert.ok(
      Number.isFinite(
        Date.parse(
          result.cancelledAt
        )
      )
    );

    const state =
      await recoveryState(
        fixture
      );

    assert.equal(
      state.shift?.status,
      "cancelled"
    );

    assert.equal(
      state.shift?.actualStart,
      null
    );

    assert.equal(
      state.shift?.actualEnd,
      null
    );

    assert.equal(
      state.shift?.cancelledAt,
      result.cancelledAt
    );

    assert.equal(
      state.shift?.cancelledBy,
      fixture.actorUid
    );

    assert.equal(
      state.control?.slotStatus,
      "pending"
    );

    assert.equal(
      state.control?.generation,
      fixture.generation + 1
    );

    assert.equal(
      state.control
        ?.previousSlotToken,
      fixture.slotToken
    );

    assert.notEqual(
      state.control?.slotToken,
      fixture.slotToken
    );

    assert.equal(
      state.control?.shiftId,
      null
    );

    assert.equal(
      state.control?.shiftStatus,
      null
    );

    assert.equal(
      state.memberA?.leftAt,
      result.cancelledAt
    );

    assert.equal(
      state.memberB?.leftAt,
      result.cancelledAt
    );

    assert.equal(
      matchingEntries(
        state.scheduleA,
        fixture.shiftId
      ).length,
      0
    );

    assert.equal(
      matchingEntries(
        state.scheduleB,
        fixture.shiftId
      ).length,
      0
    );

    /*
     * The unrelated schedule entries
     * survive recovery.
     */

    assert.equal(
      entriesFor(
        state.scheduleA
      ).length,
      1
    );

    assert.equal(
      entriesFor(
        state.scheduleB
      ).length,
      1
    );

    assert.equal(
      state.authorization?.status,
      "expired"
    );

    assert.equal(
      state.authorization?.shiftId,
      fixture.shiftId
    );

    assert.equal(
      state.authorization?.completedAt,
      null
    );

    assert.equal(
      state.authorization?.expiredAt,
      result.cancelledAt
    );

    /*
     * Recovery must never invent
     * participation.
     */

    assert.equal(
      state.attendanceCount,
      0
    );

    /*
     * Permanent pair authority and its
     * reservations remain untouched.
     */

    assert.deepEqual(
      state.pair,
      pairBefore
    );

    assert.deepEqual(
      state.reservationA,
      reservationABefore
    );

    assert.deepEqual(
      state.reservationB,
      reservationBBefore
    );

    assert.equal(
      state.auditCount,
      1
    );

    const userA =
      await doc(
        "users",
        fixture.technicianA
      );

    const userB =
      await doc(
        "users",
        fixture.technicianB
      );

    assert.ok(
      userA
        ?.lastAssignmentActivityAt
    );

    assert.ok(
      userB
        ?.lastAssignmentActivityAt
    );
  }
);

/*
 * 2. Ordinary A+B shift without a
 * temporary authorization.
 */

test(
  "expired scheduled recovery succeeds without temporary authorization and does not fabricate one",
  async () => {
    const fixture =
      await seedFixture({
        includeAuthorization:
          false,
      });

    const result =
      await recoverExpiredScheduledShift({
        shiftId:
          fixture.shiftId,

        actorUid:
          fixture.actorUid,
      });

    assert.equal(
      result.status,
      "cancelled"
    );

    assert.equal(
      await doc(
        "next_shift_authorizations",
        fixture.authorizationId
      ),
      null
    );

    assert.equal(
      await attendanceCount(
        fixture.shiftId
      ),
      0
    );

    assert.equal(
      (
        await doc(
          "shifts",
          fixture.shiftId
        )
      )?.actualEnd,
      null
    );

    assert.equal(
      await auditCount(
        fixture.shiftId,
        "SHIFT_CANCELLED"
      ),
      1
    );
  }
);

/*
 * 3. Attendance makes scheduled-only
 * recovery unsafe. Everything must roll
 * back.
 */

test(
  "existing attendance blocks recovery with no partial writes",
  async () => {
    const fixture =
      await seedFixture({
        includeAttendance:
          true,
      });

    const before =
      await recoveryState(
        fixture
      );

    await assert.rejects(
      () =>
        recoverExpiredScheduledShift({
          shiftId:
            fixture.shiftId,

          actorUid:
            fixture.actorUid,
        }),
      isStatusError(409)
    );

    const after =
      await recoveryState(
        fixture
      );

    assert.deepEqual(
      after,
      before
    );

    assert.equal(
      after.shift?.status,
      "scheduled"
    );

    assert.equal(
      after.control?.slotStatus,
      "consumed"
    );

    assert.equal(
      after.authorization?.status,
      "consumed"
    );

    assert.equal(
      after.auditCount,
      0
    );
  }
);

/*
 * 4. Unresolved operational work must
 * block recovery atomically.
 */

test(
  "unresolved task blocks recovery with no slot roster schedule or authorization mutation",
  async () => {
    const fixture =
      await seedFixture({
        unresolvedTask:
          true,
      });

    const before =
      await recoveryState(
        fixture
      );

    await assert.rejects(
      () =>
        recoverExpiredScheduledShift({
          shiftId:
            fixture.shiftId,

          actorUid:
            fixture.actorUid,
        }),
      isStatusError(409)
    );

    const after =
      await recoveryState(
        fixture
      );

    assert.deepEqual(
      after,
      before
    );

    assert.equal(
      after.shift?.status,
      "scheduled"
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
      after.auditCount,
      0
    );
  }
);

/*
 * 5. Exact schedule integrity is required.
 */

test(
  "mismatched primary schedule blocks recovery atomically",
  async () => {
    const fixture =
      await seedFixture({
        corruptScheduleA:
          true,
      });

    const before =
      await recoveryState(
        fixture
      );

    await assert.rejects(
      () =>
        recoverExpiredScheduledShift({
          shiftId:
            fixture.shiftId,

          actorUid:
            fixture.actorUid,
        }),
      isStatusError(409)
    );

    const after =
      await recoveryState(
        fixture
      );

    assert.deepEqual(
      after,
      before
    );

    assert.equal(
      after.auditCount,
      0
    );
  }
);

/*
 * 6. Recovery is administrator-only.
 */

test(
  "supervisor cannot use expired scheduled shift recovery",
  async () => {
    const fixture =
      await seedFixture({
        actorRole:
          "supervisor",
      });

    const before =
      await recoveryState(
        fixture
      );

    await assert.rejects(
      () =>
        recoverExpiredScheduledShift({
          shiftId:
            fixture.shiftId,

          actorUid:
            fixture.actorUid,
        }),
      isStatusError(403)
    );

    const after =
      await recoveryState(
        fixture
      );

    assert.deepEqual(
      after,
      before
    );
  }
);

/*
 * 7. Concurrent recovery must be
 * single-commit.
 */

test(
  "concurrent recovery commits exactly once and advances the slot exactly once",
  {
    timeout:
      60000,
  },
  async () => {
    const fixture =
      await seedFixture();

    const results =
      await Promise.allSettled([
        recoverExpiredScheduledShift({
          shiftId:
            fixture.shiftId,

          actorUid:
            fixture.actorUid,
        }),

        recoverExpiredScheduledShift({
          shiftId:
            fixture.shiftId,

          actorUid:
            fixture.actorUid,
        }),
      ]);

    const fulfilled =
      results.filter(
        (result) =>
          result.status ===
          "fulfilled"
      );

    const rejected =
      results.filter(
        (result) =>
          result.status ===
          "rejected"
      );

    assert.equal(
      fulfilled.length,
      1
    );

    assert.equal(
      rejected.length,
      1
    );

    assert.ok(
      rejected[0] &&
      rejected[0].status ===
        "rejected"
    );

    assert.equal(
      (
        rejected[0].reason as {
          status?: unknown;
        }
      ).status,
      409
    );

    const state =
      await recoveryState(
        fixture
      );

    assert.equal(
      state.shift?.status,
      "cancelled"
    );

    assert.equal(
      state.shift?.actualStart,
      null
    );

    assert.equal(
      state.shift?.actualEnd,
      null
    );

    assert.equal(
      state.control?.slotStatus,
      "pending"
    );

    assert.equal(
      state.control?.generation,
      fixture.generation + 1
    );

    assert.equal(
      state.control
        ?.previousSlotToken,
      fixture.slotToken
    );

    assert.equal(
      state.authorization?.status,
      "expired"
    );

    assert.equal(
      state.attendanceCount,
      0
    );

    assert.equal(
      state.auditCount,
      1
    );

    assert.equal(
      matchingEntries(
        state.scheduleA,
        fixture.shiftId
      ).length,
      0
    );

    assert.equal(
      matchingEntries(
        state.scheduleB,
        fixture.shiftId
      ).length,
      0
    );
  }
);
