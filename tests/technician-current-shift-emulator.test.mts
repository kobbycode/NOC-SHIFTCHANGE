import assert from "node:assert/strict";
import test from "node:test";

const EXPECTED_PROJECT_ID =
  "demo-shiftchange-technician-current";

const EXPECTED_PORT =
  "8088";

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

if (
  emulatorHost.includes("://")
) {
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

for (
  const [name, value] of [
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
  ] as const
) {
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
  getTechnicianCurrentShift,
} = await import(
  "../src/lib/operations/get-technician-current-shift"
);

const {
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} = await import(
  "../src/lib/operations/operational-shift-control-state"
);

const {
  createNextShiftAuthorizationDocumentId,
} = await import(
  "../src/lib/operations/next-shift-authorization-domain"
);

const db =
  getAdminFirestore();

let fixtureCounter = 0;

const slotToken =
  "f3000000-0000-4000-8000-000000000001";

const previousSlotToken =
  "f3000000-0000-4000-8000-000000000002";

const createdAt =
  "2026-10-03T04:00:00.000Z";

const consumedAt =
  "2026-10-03T05:00:00.000Z";

const scheduledStart =
  "2026-10-03T06:00:00.000Z";

const actualStart =
  "2026-10-03T06:05:00.000Z";

const joinedAt =
  "2026-10-03T06:10:00.000Z";

type FixtureStatus =
  | "pending"
  | "scheduled"
  | "active"
  | "handover_pending";

async function seedFixture(
  status: FixtureStatus,
  options?: {
    actorKind?:
      | "primary"
      | "temporary"
      | "unrelated";

    actorStatus?:
      | "active"
      | "blocked";

    persistedActorRole?:
      | "technician"
      | "supervisor";

    includeAttendance?:
      boolean;

    malformedShift?:
      boolean;
  },
) {
  fixtureCounter += 1;

  const suffix =
    `${Date.now()}-${fixtureCounter}`;

  const shiftId =
    `technician-current-shift-${suffix}`;

  const pairId =
    `technician-current-pair-${suffix}`;

  const technicianA =
    `technician-current-a-${suffix}`;

  const technicianB =
    `technician-current-b-${suffix}`;

  const technicianC =
    `technician-current-c-${suffix}`;

  const unrelated =
    `technician-current-d-${suffix}`;

  const actorKind =
    options?.actorKind ??
    "primary";

  const actorUid =
    actorKind === "primary"
      ? technicianA
      : actorKind === "temporary"
        ? technicianC
        : unrelated;

  const actor = {
    uid: actorUid,

    fullName:
      "Synthetic Technician",

    email:
      `${actorUid}@example.invalid`,

    role:
      "technician" as const,

    status:
      "active" as const,

    mustChangePassword:
      false,
  };

  const batch =
    db.batch();

  batch.set(
    db
      .collection("users")
      .doc(actorUid),
    {
      uid: actorUid,

      fullName:
        "Synthetic Technician",

      email:
        `${actorUid}@example.invalid`,

      role:
        options
          ?.persistedActorRole ??
        "technician",

      status:
        options?.actorStatus ??
        "active",

      mustChangePassword:
        false,

      statusOperation:
        null,
    },
  );

  let control =
    createPendingOperationalShiftControl(
      slotToken,
      4,
      createdAt,
      previousSlotToken,
      createdAt,
    );

  if (
    status !== "pending"
  ) {
    control =
      consumeOperationalShiftSlot(
        control,
        shiftId,
        consumedAt,
      );

    if (
      status === "active" ||
      status ===
        "handover_pending"
    ) {
      control =
        transitionOperationalShiftControl(
          control,
          shiftId,
          "scheduled",
          "active",
          actualStart,
        );
    }

    if (
      status ===
        "handover_pending"
    ) {
      control =
        transitionOperationalShiftControl(
          control,
          shiftId,
          "active",
          "handover_pending",
          "2026-10-03T13:55:00.000Z",
        );
    }
  }

  batch.set(
    db
      .collection(
        "operational_shift_control",
      )
      .doc("global"),
    control,
  );

  if (
    status !== "pending"
  ) {
    batch.set(
      db
        .collection("shifts")
        .doc(shiftId),
      {
        id: shiftId,

        operationalSlotToken:
          options?.malformedShift
            ? "not-a-uuid"
            : slotToken,

        permanentPairId:
          pairId,

        shiftType:
          "morning",

        status,

        scheduledStart,

        scheduledEnd:
          "2026-10-03T14:00:00.000Z",

        actualStart:
          status === "scheduled"
            ? null
            : actualStart,

        actualEnd: null,

        primaryTechnicianIds: [
          technicianA,
          technicianB,
        ],

        createdBy:
          "synthetic-supervisor",

        createdAt,

        updatedAt:
          status ===
            "handover_pending"
            ? "2026-10-03T13:55:00.000Z"
            : status === "active"
              ? actualStart
              : consumedAt,
      },
    );

    batch.set(
      db
        .collection(
          "technician_pairs",
        )
        .doc(pairId),
      {
        id: pairId,

        technicianIds: [
          technicianA,
          technicianB,
        ],

        status: "active",

        createdBy:
          "synthetic-supervisor",

        createdAt,

        updatedAt:
          createdAt,

        deactivatedAt: null,
        deactivatedBy: null,
      },
    );

    for (
      const technicianUid of [
        technicianA,
        technicianB,
      ]
    ) {
      batch.set(
        db
          .collection(
            "technician_pair_memberships",
          )
          .doc(technicianUid),
        {
          technicianUid,

          pairId,

          createdAt,

          updatedAt:
            createdAt,
        },
      );
    }

    const authorizationId =
      createNextShiftAuthorizationDocumentId(
        pairId,
        4,
        slotToken,
      );

    batch.set(
      db
        .collection(
          "next_shift_authorizations",
        )
        .doc(authorizationId),
      {
        id:
          authorizationId,

        slotToken,

        slotGeneration: 4,

        permanentPairId:
          pairId,

        authorizedTechnicianUid:
          technicianC,

        status:
          "consumed",

        shiftId,

        consumedAt,

        completedAt: null,
        expiredAt: null,

        createdAt,

        createdBy:
          "synthetic-supervisor",

        updatedAt:
          consumedAt,
      },
    );

    if (
      options
        ?.includeAttendance
    ) {
      const authority =
        actorKind === "temporary"
          ? "temporary_authorized"
          : "primary";

      batch.set(
        db
          .collection(
            "shift_attendance",
          )
          .doc(
            `${shiftId}_${actorUid}`,
          ),
        {
          id:
            `${shiftId}_${actorUid}`,

          shiftId,

          technicianId:
            actorUid,

          status:
            "present",

          participationAuthority:
            authority,

          authorizationId:
            authority ===
              "temporary_authorized"
              ? authorizationId
              : null,

          clockIn: null,
          clockOut: null,

          isProvisional:
            false,

          recordedAt:
            joinedAt,

          updatedAt:
            joinedAt,
        },
      );
    }
  }

  await batch.commit();

  return {
    actor,
    actorUid,
    shiftId,
    pairId,
    technicianA,
    technicianB,
    technicianC,
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

async function snapshotState() {
  const collections = [
    "users",
    "operational_shift_control",
    "shifts",
    "technician_pairs",
    "technician_pair_memberships",
    "next_shift_authorizations",
    "shift_attendance",
    "shift_members",
    "technician_schedules",
    "audit_logs",
  ];

  const state:
    Record<
      string,
      unknown[]
    > = {};

  for (
    const collectionName of
    collections
  ) {
    const snapshot =
      await db
        .collection(
          collectionName,
        )
        .get();

    state[collectionName] =
      snapshot.docs.map(
        (document) => ({
          id: document.id,
          data:
            document.data(),
        }),
      );
  }

  return state;
}

test(
  "pending global slot returns no current technician shift",
  async () => {
    const fixture =
      await seedFixture(
        "pending",
      );

    const result =
      await getTechnicianCurrentShift(
        fixture.actor,
      );

    assert.equal(
      result,
      null,
    );
  },
);

test(
  "scheduled primary technician sees assignment without start or join authority and the read is mutation-free",
  async () => {
    const fixture =
      await seedFixture(
        "scheduled",
        {
          actorKind:
            "primary",
        },
      );

    const before =
      await snapshotState();

    const result =
      await getTechnicianCurrentShift(
        fixture.actor,
      );

    const after =
      await snapshotState();

    assert.ok(result);

    assert.equal(
      result.id,
      fixture.shiftId,
    );

    assert.equal(
      result.participationAuthority,
      "primary",
    );

    assert.equal(
      result.canStart,
      false,
    );

    assert.equal(
      result.canJoin,
      false,
    );

    assert.equal(
      result.attendance,
      null,
    );

    assert.deepEqual(
      after,
      before,
    );
  },
);

test(
  "scheduled exact temporary technician sees start availability but no attendance",
  async () => {
    const fixture =
      await seedFixture(
        "scheduled",
        {
          actorKind:
            "temporary",
        },
      );

    const result =
      await getTechnicianCurrentShift(
        fixture.actor,
      );

    assert.ok(result);

    assert.equal(
      result.participationAuthority,
      "temporary_authorized",
    );

    assert.equal(
      result.canStart,
      true,
    );

    assert.equal(
      result.canJoin,
      false,
    );

    assert.equal(
      result.joinedAt,
      null,
    );
  },
);

test(
  "active primary technician without attendance may join",
  async () => {
    const fixture =
      await seedFixture(
        "active",
        {
          actorKind:
            "primary",
        },
      );

    const result =
      await getTechnicianCurrentShift(
        fixture.actor,
      );

    assert.ok(result);

    assert.equal(
      result.canStart,
      false,
    );

    assert.equal(
      result.canJoin,
      true,
    );

    assert.equal(
      result.attendance,
      null,
    );
  },
);

test(
  "active temporary technician with attendance sees joined state and authoritative joined time",
  async () => {
    const fixture =
      await seedFixture(
        "active",
        {
          actorKind:
            "temporary",

          includeAttendance:
            true,
        },
      );

    const result =
      await getTechnicianCurrentShift(
        fixture.actor,
      );

    assert.ok(result);

    assert.equal(
      result.participationAuthority,
      "temporary_authorized",
    );

    assert.equal(
      result.canJoin,
      false,
    );

    assert.equal(
      result.joinedAt,
      joinedAt,
    );

    assert.equal(
      result.attendance
        ?.status,
      "present",
    );
  },
);

test(
  "unrelated technician cannot discover the occupied current shift",
  async () => {
    const fixture =
      await seedFixture(
        "active",
        {
          actorKind:
            "unrelated",
        },
      );

    const result =
      await getTechnicianCurrentShift(
        fixture.actor,
      );

    assert.equal(
      result,
      null,
    );
  },
);

test(
  "blocked technician is rejected by authoritative Firestore state",
  async () => {
    const fixture =
      await seedFixture(
        "active",
        {
          actorStatus:
            "blocked",
        },
      );

    await assert.rejects(
      () =>
        getTechnicianCurrentShift(
          fixture.actor,
        ),
      isStatusError(403),
    );
  },
);

test(
  "session technician role mismatch is rejected by authoritative Firestore state",
  async () => {
    const fixture =
      await seedFixture(
        "active",
        {
          persistedActorRole:
            "supervisor",
        },
      );

    await assert.rejects(
      () =>
        getTechnicianCurrentShift(
          fixture.actor,
        ),
      isStatusError(403),
    );
  },
);

test(
  "malformed current shift identity fails closed",
  async () => {
    const fixture =
      await seedFixture(
        "active",
        {
          malformedShift:
            true,
        },
      );

    await assert.rejects(
      () =>
        getTechnicianCurrentShift(
          fixture.actor,
        ),
      isStatusError(409),
    );
  },
);
