import assert from "node:assert/strict";
import test from "node:test";

const EXPECTED_PROJECT_ID =
  "demo-shiftchange-attendance";

const EXPECTED_PORT = "8088";

function failSafety(
  message: string,
): never {
  throw new Error(
    `EMULATOR SAFETY CHECK FAILED: ${message}`,
  );
}

const emulatorHost =
  process.env.FIRESTORE_EMULATOR_HOST;

if (!emulatorHost) {
  failSafety(
    "FIRESTORE_EMULATOR_HOST is missing. Refusing to run.",
  );
}

if (emulatorHost.includes("://")) {
  failSafety(
    "FIRESTORE_EMULATOR_HOST must not contain a protocol.",
  );
}

const emulatorUrl =
  new URL(
    `http://${emulatorHost}`,
  );

if (
  ![
    "127.0.0.1",
    "localhost",
  ].includes(
    emulatorUrl.hostname,
  ) ||
  emulatorUrl.port !==
    EXPECTED_PORT
) {
  failSafety(
    `Expected local Firestore emulator on port ${EXPECTED_PORT}; received ${emulatorHost}.`,
  );
}

for (const [name, value] of [
  [
    "FIREBASE_PROJECT_ID",
    process.env.FIREBASE_PROJECT_ID,
  ],
  [
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    process.env
      .NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  ],
  [
    "GCLOUD_PROJECT",
    process.env.GCLOUD_PROJECT,
  ],
  [
    "GOOGLE_CLOUD_PROJECT",
    process.env.GOOGLE_CLOUD_PROJECT,
  ],
] as const) {
  if (
    value !== EXPECTED_PROJECT_ID
  ) {
    failSafety(
      `${name} must equal ${EXPECTED_PROJECT_ID}; received ${String(value)}.`,
    );
  }
}

if (
  !EXPECTED_PROJECT_ID.startsWith(
    "demo-",
  )
) {
  failSafety(
    "The test project must use Firebase's demo- prefix.",
  );
}

/*
 * Positively prove that the configured
 * Firestore emulator responds before
 * importing application Firebase code.
 */
const probeResponse =
  await fetch(
    `http://${emulatorHost}/v1/projects/${EXPECTED_PROJECT_ID}/databases/(default)/documents`,
  );

if (
  probeResponse.status !== 200 &&
  probeResponse.status !== 404
) {
  failSafety(
    `Firestore emulator probe returned HTTP ${probeResponse.status}.`,
  );
}

const {
  getAdminFirestore,
} = await import(
  "../src/lib/firebase/admin/index"
);

const {
  listShiftAttendance,
} = await import(
  "../src/lib/operations/list-shift-attendance"
);

const db =
  getAdminFirestore();

let fixtureCounter = 0;

const recordedAtA =
  "2026-10-02T06:10:00.000Z";

const recordedAtC =
  "2026-10-02T06:20:00.000Z";

type ActorRole =
  | "admin"
  | "supervisor"
  | "technician";

type ActorStatus =
  | "active"
  | "blocked";

async function seedFixture(
  options?: {
    includeAttendance?: boolean;
    malformedAttendance?: boolean;
    includeShift?: boolean;
    actorRole?: ActorRole;
    actorStatus?: ActorStatus;
  },
) {
  fixtureCounter += 1;

  const suffix =
    `${Date.now()}-${fixtureCounter}`;

  const shiftId =
    `attendance-shift-${suffix}`;

  const actorUid =
    `attendance-actor-${suffix}`;

  const technicianA =
    `attendance-a-${suffix}`;

  const technicianC =
    `attendance-c-${suffix}`;

  const authorizationId =
    `attendance-auth-${suffix}`;

  const actorRole =
    options?.actorRole ??
    "supervisor";

  const actorStatus =
    options?.actorStatus ??
    "active";

  const actor = {
    uid: actorUid,

    fullName:
      "Synthetic Attendance Actor",

    email:
      `${actorUid}@example.invalid`,

    role: actorRole,

    status: actorStatus,

    mustChangePassword: false,
  };

  const batch = db.batch();

  batch.set(
    db
      .collection("users")
      .doc(actorUid),
    {
      ...actor,
      statusOperation: null,
    },
  );

  batch.set(
    db
      .collection("users")
      .doc(technicianA),
    {
      uid: technicianA,

      fullName:
        "  Synthetic Primary A  ",

      email:
        `${technicianA}@example.invalid`,

      role: "technician",

      status: "active",

      mustChangePassword: false,

      statusOperation: null,
    },
  );

  batch.set(
    db
      .collection("users")
      .doc(technicianC),
    {
      uid: technicianC,

      fullName:
        "Synthetic Temporary C",

      email:
        `${technicianC}@example.invalid`,

      role: "technician",

      status: "active",

      mustChangePassword: false,

      statusOperation: null,
    },
  );

  if (
    options?.includeShift !== false
  ) {
    batch.set(
      db
        .collection("shifts")
        .doc(shiftId),
      {
        id: shiftId,
        status: "active",
      },
    );
  }

  for (
    const [uid, role] of [
      [
        technicianA,
        "primary",
      ],
      [
        technicianC,
        "additional",
      ],
    ] as const
  ) {
    batch.set(
      db
        .collection(
          "shift_members",
        )
        .doc(
          `${shiftId}_${uid}`,
        ),
      {
        id:
          `${shiftId}_${uid}`,

        shiftId,

        technicianId: uid,

        role,

        joinedAt:
          "2026-10-02T06:00:00.000Z",

        leftAt: null,
      },
    );
  }

  if (
    options?.includeAttendance !==
      false
  ) {
    const primaryId =
      `${shiftId}_${technicianA}`;

    batch.set(
      db
        .collection(
          "shift_attendance",
        )
        .doc(primaryId),
      {
        id:
          options
            ?.malformedAttendance
            ? "wrong-persisted-id"
            : primaryId,

        shiftId,

        technicianId:
          technicianA,

        status: "present",

        participationAuthority:
          "primary",

        authorizationId: null,

        clockIn: null,

        clockOut: null,

        isProvisional: false,

        recordedAt:
          recordedAtA,

        updatedAt:
          recordedAtA,
      },
    );

    const temporaryId =
      `${shiftId}_${technicianC}`;

    batch.set(
      db
        .collection(
          "shift_attendance",
        )
        .doc(temporaryId),
      {
        id: temporaryId,

        shiftId,

        technicianId:
          technicianC,

        status: "present",

        participationAuthority:
          "temporary_authorized",

        authorizationId,

        clockIn: null,

        clockOut: null,

        isProvisional: false,

        recordedAt:
          recordedAtC,

        updatedAt:
          recordedAtC,
      },
    );
  }

  await batch.commit();

  return {
    actor,
    actorUid,
    shiftId,
    technicianA,
    technicianC,
    authorizationId,
  };
}

function isStatusError(
  expectedStatus: number,
) {
  return (
    error: unknown,
  ) => {
    const value =
      error as {
        status?: unknown;
      };

    return (
      Boolean(value) &&
      value.status ===
        expectedStatus
    );
  };
}

async function readFixtureState(
  fixture: Awaited<
    ReturnType<
      typeof seedFixture
    >
  >,
) {
  const refs = [
    db
      .collection("users")
      .doc(fixture.actorUid),

    db
      .collection("users")
      .doc(fixture.technicianA),

    db
      .collection("users")
      .doc(fixture.technicianC),

    db
      .collection("shifts")
      .doc(fixture.shiftId),

    db
      .collection(
        "shift_members",
      )
      .doc(
        `${fixture.shiftId}_${fixture.technicianA}`,
      ),

    db
      .collection(
        "shift_members",
      )
      .doc(
        `${fixture.shiftId}_${fixture.technicianC}`,
      ),

    db
      .collection(
        "shift_attendance",
      )
      .doc(
        `${fixture.shiftId}_${fixture.technicianA}`,
      ),

    db
      .collection(
        "shift_attendance",
      )
      .doc(
        `${fixture.shiftId}_${fixture.technicianC}`,
      ),
  ];

  const snapshots =
    await db.getAll(
      ...refs,
    );

  return snapshots.map(
    (snapshot) => ({
      path:
        snapshot.ref.path,

      exists:
        snapshot.exists,

      data:
        snapshot.exists
          ? snapshot.data()
          : null,
    }),
  );
}

test(
  "retrieves authoritative attendance with technician names in recorded order without mutating persisted state",
  async () => {
    const fixture =
      await seedFixture();

    const before =
      await readFixtureState(
        fixture,
      );

    const result =
      await listShiftAttendance(
        fixture.actor,
        fixture.shiftId,
      );

    assert.equal(
      result.total,
      2,
    );

    assert.equal(
      result.attendance.length,
      2,
    );

    assert.equal(
      result.attendance[0]
        .technicianId,
      fixture.technicianA,
    );

    assert.equal(
      result.attendance[0]
        .technicianName,
      "Synthetic Primary A",
    );

    assert.equal(
      result.attendance[0]
        .participationAuthority,
      "primary",
    );

    assert.equal(
      result.attendance[0]
        .authorizationId,
      null,
    );

    assert.equal(
      result.attendance[1]
        .technicianId,
      fixture.technicianC,
    );

    assert.equal(
      result.attendance[1]
        .technicianName,
      "Synthetic Temporary C",
    );

    assert.equal(
      result.attendance[1]
        .participationAuthority,
      "temporary_authorized",
    );

    assert.equal(
      result.attendance[1]
        .authorizationId,
      fixture.authorizationId,
    );

    const after =
      await readFixtureState(
        fixture,
      );

    assert.deepEqual(
      after,
      before,
    );
  },
);

test(
  "returns zero attendance when roster members exist but no attendance records exist",
  async () => {
    const fixture =
      await seedFixture({
        includeAttendance:
          false,
      });

    const result =
      await listShiftAttendance(
        fixture.actor,
        fixture.shiftId,
      );

    assert.equal(
      result.total,
      0,
    );

    assert.deepEqual(
      result.attendance,
      [],
    );

    const members =
      await db
        .collection(
          "shift_members",
        )
        .where(
          "shiftId",
          "==",
          fixture.shiftId,
        )
        .get();

    assert.equal(
      members.size,
      2,
    );
  },
);

test(
  "fails closed when persisted attendance identity is malformed",
  async () => {
    const fixture =
      await seedFixture({
        malformedAttendance:
          true,
      });

    await assert.rejects(
      () =>
        listShiftAttendance(
          fixture.actor,
          fixture.shiftId,
        ),
      isStatusError(409),
    );
  },
);

test(
  "rejects attendance retrieval for a missing parent shift",
  async () => {
    const fixture =
      await seedFixture({
        includeShift: false,
      });

    await assert.rejects(
      () =>
        listShiftAttendance(
          fixture.actor,
          fixture.shiftId,
        ),
      isStatusError(404),
    );
  },
);

test(
  "rejects an authenticated technician actor",
  async () => {
    const fixture =
      await seedFixture({
        actorRole:
          "technician",
      });

    await assert.rejects(
      () =>
        listShiftAttendance(
          fixture.actor,
          fixture.shiftId,
        ),
      isStatusError(403),
    );
  },
);

test(
  "rejects a blocked supervisor from authoritative Firestore state",
  async () => {
    const fixture =
      await seedFixture({
        actorStatus:
          "blocked",
      });

    await assert.rejects(
      () =>
        listShiftAttendance(
          fixture.actor,
          fixture.shiftId,
        ),
      isStatusError(403),
    );
  },
);

test(
  "rejects a session role that disagrees with authoritative Firestore role",
  async () => {
    const fixture =
      await seedFixture();

    await db
      .collection("users")
      .doc(fixture.actorUid)
      .update({
        role: "technician",
      });

    await assert.rejects(
      () =>
        listShiftAttendance(
          fixture.actor,
          fixture.shiftId,
        ),
      isStatusError(403),
    );
  },
);
test(
  "allows an authoritative active administrator to retrieve shift attendance",
  async () => {
    const fixture =
      await seedFixture({
        actorRole: "admin",
      });

    const result =
      await listShiftAttendance(
        fixture.actor,
        fixture.shiftId,
      );

    assert.equal(
      result.total,
      2,
    );

    assert.equal(
      result.attendance.length,
      2,
    );
  },
);

test(
  "uses technician uid fallback when an attendance technician profile is unavailable",
  async () => {
    const fixture =
      await seedFixture();

    await db
      .collection("users")
      .doc(
        fixture.technicianC,
      )
      .delete();

    const result =
      await listShiftAttendance(
        fixture.actor,
        fixture.shiftId,
      );

    const temporary =
      result.attendance.find(
        (record) =>
          record.technicianId ===
          fixture.technicianC,
      );

    assert.ok(temporary);

    assert.equal(
      temporary.technicianName,
      `Technician ${fixture.technicianC}`,
    );

    assert.equal(
      temporary.participationAuthority,
      "temporary_authorized",
    );

    assert.equal(
      temporary.authorizationId,
      fixture.authorizationId,
    );
  },
);