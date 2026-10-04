import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeOperationalShiftSlot,
  createPendingOperationalShiftControl,
  transitionOperationalShiftControl,
} from "../src/lib/operations/operational-shift-control-state";

import {
  createNextShiftAuthorizationDocumentId,
} from "../src/lib/operations/next-shift-authorization-domain";

import {
  resolveTechnicianCurrentShift,
} from "../src/lib/operations/technician-current-shift-domain";

const slotToken =
  "f1000000-0000-4000-8000-000000000001";

const previousSlotToken =
  "f1000000-0000-4000-8000-000000000002";

const shiftId =
  "synthetic-current-shift";

const pairId =
  "synthetic-current-pair";

const technicianA =
  "synthetic-current-a";

const technicianB =
  "synthetic-current-b";

const technicianC =
  "synthetic-current-c";

const unrelatedTechnician =
  "synthetic-current-d";

const pairCreatedAt =
  "2026-10-03T04:00:00.000Z";

const slotCreatedAt =
  "2026-10-03T05:00:00.000Z";

const authorizationCreatedAt =
  "2026-10-03T05:01:00.000Z";

const consumedAt =
  "2026-10-03T05:05:00.000Z";

const scheduledStart =
  "2026-10-03T06:00:00.000Z";

const actualStart =
  "2026-10-03T06:05:00.000Z";

const attendanceTime =
  "2026-10-03T06:10:00.000Z";

const handoverTime =
  "2026-10-03T13:55:00.000Z";

const scheduledEnd =
  "2026-10-03T14:00:00.000Z";

const pair = {
  id: pairId,
  technicianIds: [
    technicianA,
    technicianB,
  ],
  status: "active",
  createdBy: "synthetic-manager",
  createdAt: pairCreatedAt,
  updatedAt: pairCreatedAt,
  deactivatedAt: null,
  deactivatedBy: null,
};

const pairMemberships:
  [unknown, unknown] = [
    {
      technicianUid:
        technicianA,
      pairId,
      createdAt:
        pairCreatedAt,
      updatedAt:
        pairCreatedAt,
    },
    {
      technicianUid:
        technicianB,
      pairId,
      createdAt:
        pairCreatedAt,
      updatedAt:
        pairCreatedAt,
    },
  ];

function pendingControl() {
  return createPendingOperationalShiftControl(
    slotToken,
    4,
    slotCreatedAt,
    previousSlotToken,
    slotCreatedAt,
  );
}

function controlFor(
  status:
    | "scheduled"
    | "active"
    | "handover_pending",
) {
  const scheduled =
    consumeOperationalShiftSlot(
      pendingControl(),
      shiftId,
      consumedAt,
    );

  if (
    status === "scheduled"
  ) {
    return scheduled;
  }

  const active =
    transitionOperationalShiftControl(
      scheduled,
      shiftId,
      "scheduled",
      "active",
      actualStart,
    );

  if (
    status === "active"
  ) {
    return active;
  }

  return transitionOperationalShiftControl(
    active,
    shiftId,
    "active",
    "handover_pending",
    handoverTime,
  );
}

function shiftFor(
  status:
    | "scheduled"
    | "active"
    | "handover_pending",
) {
  return {
    id: shiftId,
    operationalSlotToken:
      slotToken,
    permanentPairId:
      pairId,
    shiftType: "morning",
    status,
    scheduledStart,
    scheduledEnd,
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
      "synthetic-manager",
    createdAt:
      slotCreatedAt,
    updatedAt:
      status ===
        "handover_pending"
        ? handoverTime
        : status === "active"
          ? actualStart
          : consumedAt,
  };
}

function authorization() {
  const id =
    createNextShiftAuthorizationDocumentId(
      pairId,
      4,
      slotToken,
    );

  return {
    id,
    slotToken,
    slotGeneration: 4,
    permanentPairId:
      pairId,
    authorizedTechnicianUid:
      technicianC,
    status: "consumed",
    shiftId,
    consumedAt,
    completedAt: null,
    expiredAt: null,
    createdAt:
      authorizationCreatedAt,
    createdBy:
      "synthetic-manager",
    updatedAt:
      consumedAt,
  };
}

function attendance(
  technicianUid: string,
  authority:
    | "primary"
    | "temporary_authorized",
) {
  const auth =
    authorization();

  return {
    id:
      `${shiftId}_${technicianUid}`,
    shiftId,
    technicianId:
      technicianUid,
    status: "present",
    participationAuthority:
      authority,
    authorizationId:
      authority === "primary"
        ? null
        : auth.id,
    clockIn: null,
    clockOut: null,
    isProvisional: false,
    recordedAt:
      attendanceTime,
    updatedAt:
      attendanceTime,
  };
}

function resolve(
  technicianUid: string,
  status:
    | "scheduled"
    | "active"
    | "handover_pending",
  options?: {
    includeAuthorization?: boolean;
    attendanceValue?: unknown | null;
    attendanceDocumentId?:
      string | null;
    shiftOverride?:
      Record<string, unknown>;
    pairMembershipsOverride?:
      [unknown, unknown];
    authorizationOverride?:
      unknown;
  },
) {
  const includeAuthorization =
    options?.includeAuthorization ??
    true;

  const auth =
    authorization();

  const attendanceValue =
    options?.attendanceValue ??
    null;

  const attendanceDocumentId =
    options?.attendanceDocumentId ??
    (
      attendanceValue
        ? `${shiftId}_${technicianUid}`
        : null
    );

  return resolveTechnicianCurrentShift({
    technicianUid,

    control:
      controlFor(status),

    shift: {
      ...shiftFor(status),
      ...options?.shiftOverride,
    },

    permanentPair: pair,

    pairMemberships:
      options
        ?.pairMembershipsOverride ??
      pairMemberships,

    authorizationDocumentId:
      includeAuthorization
        ? auth.id
        : null,

    authorization:
      includeAuthorization
        ? (
            options
              ?.authorizationOverride ??
            auth
          )
        : null,

    attendanceDocumentId,

    attendance:
      attendanceValue,
  });
}

test(
  "pending global slot exposes no technician shift",
  () => {
    const result =
      resolveTechnicianCurrentShift({
        technicianUid:
          technicianA,
        control:
          pendingControl(),
        shift: null,
        permanentPair: null,
        pairMemberships: null,
        authorizationDocumentId:
          null,
        authorization: null,
        attendanceDocumentId:
          null,
        attendance: null,
      });

    assert.equal(
      result,
      null,
    );
  },
);

test(
  "scheduled primary technician sees assignment without start or join authority",
  () => {
    const result =
      resolve(
        technicianA,
        "scheduled",
      );

    assert.ok(result);

    assert.equal(
      result.participationAuthority,
      "primary",
    );

    assert.equal(
      result.authorizationId,
      null,
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
      result.joinedAt,
      null,
    );
  },
);

test(
  "scheduled temporary technician sees exact consumed authorization and start authority",
  () => {
    const result =
      resolve(
        technicianC,
        "scheduled",
      );

    assert.ok(result);

    assert.equal(
      result.participationAuthority,
      "temporary_authorized",
    );

    assert.equal(
      result.authorizationId,
      authorization().id,
    );

    assert.equal(
      result.canStart,
      true,
    );

    assert.equal(
      result.canJoin,
      false,
    );
  },
);

test(
  "unrelated technician cannot discover the current shift",
  () => {
    const result =
      resolve(
        unrelatedTechnician,
        "active",
      );

    assert.equal(
      result,
      null,
    );
  },
);

test(
  "active primary technician without attendance may join",
  () => {
    const result =
      resolve(
        technicianA,
        "active",
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
  "active primary attendance disables duplicate join and exposes authoritative joined time",
  () => {
    const record =
      attendance(
        technicianA,
        "primary",
      );

    const result =
      resolve(
        technicianA,
        "active",
        {
          attendanceValue:
            record,
        },
      );

    assert.ok(result);

    assert.equal(
      result.canJoin,
      false,
    );

    assert.equal(
      result.joinedAt,
      attendanceTime,
    );

    assert.equal(
      result.attendance?.id,
      `${shiftId}_${technicianA}`,
    );
  },
);

test(
  "active temporary technician may join before attendance exists",
  () => {
    const result =
      resolve(
        technicianC,
        "active",
      );

    assert.ok(result);

    assert.equal(
      result.participationAuthority,
      "temporary_authorized",
    );

    assert.equal(
      result.canJoin,
      true,
    );

    assert.equal(
      result.joinedAt,
      null,
    );
  },
);

test(
  "active temporary attendance preserves authorization provenance and joined time",
  () => {
    const record =
      attendance(
        technicianC,
        "temporary_authorized",
      );

    const result =
      resolve(
        technicianC,
        "active",
        {
          attendanceValue:
            record,
        },
      );

    assert.ok(result);

    assert.equal(
      result.authorizationId,
      authorization().id,
    );

    assert.equal(
      result.attendance
        ?.authorizationId,
      authorization().id,
    );

    assert.equal(
      result.joinedAt,
      attendanceTime,
    );

    assert.equal(
      result.canJoin,
      false,
    );
  },
);

test(
  "handover-pending participant remains visible but cannot start or newly join",
  () => {
    const result =
      resolve(
        technicianA,
        "handover_pending",
        {
          attendanceValue:
            attendance(
              technicianA,
              "primary",
            ),
        },
      );

    assert.ok(result);

    assert.equal(
      result.status,
      "handover_pending",
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
      result.joinedAt,
      attendanceTime,
    );
  },
);

test(
  "slot identity mismatch fails closed",
  () => {
    assert.throws(
      () =>
        resolve(
          technicianA,
          "active",
          {
            shiftOverride: {
              operationalSlotToken:
                "f2000000-0000-4000-8000-000000000002",
            },
          },
        ),
      /does not match the global operational slot/i,
    );
  },
);

test(
  "permanent-pair reservation mismatch fails closed",
  () => {
    assert.throws(
      () =>
        resolve(
          technicianA,
          "active",
          {
            pairMembershipsOverride: [
              pairMemberships[0],
              {
                technicianUid:
                  technicianB,
                pairId:
                  "wrong-pair",
                createdAt:
                  pairCreatedAt,
                updatedAt:
                  pairCreatedAt,
              },
            ],
          },
        ),
      /reservations are missing or inconsistent/i,
    );
  },
);

test(
  "malformed or stale temporary authorization fails closed",
  () => {
    const auth =
      authorization();

    assert.throws(
      () =>
        resolve(
          technicianC,
          "active",
          {
            authorizationOverride: {
              ...auth,
              status:
                "pending",
            },
          },
        ),
      /authorization requires administrator review/i,
    );
  },
);

test(
  "scheduled shift rejects fabricated attendance",
  () => {
    assert.throws(
      () =>
        resolve(
          technicianA,
          "scheduled",
          {
            attendanceValue:
              attendance(
                technicianA,
                "primary",
              ),
          },
        ),
      /scheduled shift cannot already contain technician attendance/i,
    );
  },
);

test(
  "attendance authority must match current shift authority",
  () => {
    assert.throws(
      () =>
        resolve(
          technicianA,
          "active",
          {
            attendanceValue:
              attendance(
                technicianA,
                "temporary_authorized",
              ),
          },
        ),
      /does not match current shift authority/i,
    );
  },
);
