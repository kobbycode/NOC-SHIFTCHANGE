import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  runInNewContext,
} from "node:vm";
import ts from "typescript";

import {
  advanceExpiredScheduledOperationalShiftControl,
  assertOperationalShiftControl,
  consumeOperationalShiftSlot,
  createPendingOperationalShiftControl,
  transitionOperationalShiftControl,
} from "../src/lib/operations/operational-shift-control-state.ts";

class TestAssignmentOperationError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const SHIFT_STATUSES = {
  SCHEDULED: "scheduled",
  ACTIVE: "active",
  HANDOVER_PENDING: "handover_pending",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

const AUTH_STATUSES = {
  PENDING: "pending",
  CONSUMED: "consumed",
  COMPLETED: "completed",
  EXPIRED: "expired",
};

function parseShiftTimeRange(
  scheduledStart,
  scheduledEnd
) {
  const start =
    Date.parse(scheduledStart);

  const end =
    Date.parse(scheduledEnd);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end
  ) {
    throw new TestAssignmentOperationError(
      "The shift has an invalid start or end time.",
      409
    );
  }

  return {
    start,
    end,
  };
}

async function loadTsModule(
  relativeUrl,
  requireModule
) {
  const source = await readFile(
    new URL(relativeUrl, import.meta.url),
    "utf8"
  );

  const javascript =
    ts.transpileModule(
      source,
      {
        compilerOptions: {
          module:
            ts.ModuleKind.CommonJS,
          target:
            ts.ScriptTarget.ES2022,
        },
      }
    ).outputText;

  const loaded = {
    exports: {},
  };

  runInNewContext(
    javascript,
    {
      exports: loaded.exports,
      module: loaded,
      require: requireModule,
    }
  );

  return loaded.exports;
}

const activationModule =
  await loadTsModule(
    "../src/lib/operations/shift-activation-window.ts",
    (specifier) => {
      if (specifier === "server-only") {
        return {};
      }

      if (
        specifier ===
        "./assignment-transaction"
      ) {
        return {
          AssignmentOperationError:
            TestAssignmentOperationError,
        };
      }

      if (
        specifier ===
        "./shift-overlap"
      ) {
        return {
          parseShiftTimeRange,
        };
      }

      throw new Error(
        `Unexpected activation import: ${specifier}`
      );
    }
  );

const transitionModule =
  await loadTsModule(
    "../src/lib/operations/shift-transition.ts",
    (specifier) => {
      if (specifier === "server-only") {
        return {};
      }

      if (
        specifier ===
        "@/types/shift"
      ) {
        return {
          SHIFT_STATUSES,
        };
      }

      if (
        specifier ===
        "./assignment-transaction"
      ) {
        return {
          AssignmentOperationError:
            TestAssignmentOperationError,
        };
      }

      throw new Error(
        `Unexpected transition import: ${specifier}`
      );
    }
  );

const overlapModule =
  await loadTsModule(
    "../src/lib/operations/shift-overlap.ts",
    (specifier) => {
      if (specifier === "server-only") {
        return {};
      }

      if (
        specifier ===
        "@/types/shift"
      ) {
        return {
          SHIFT_STATUSES,
        };
      }

      if (
        specifier ===
        "./assignment-transaction"
      ) {
        return {
          AssignmentOperationError:
            TestAssignmentOperationError,
        };
      }

      throw new Error(
        `Unexpected overlap import: ${specifier}`
      );
    }
  );

const authorizationModule =
  await loadTsModule(
    "../src/lib/operations/next-shift-authorization-domain.ts",
    (specifier) => {
      if (
        specifier ===
        "node:crypto"
      ) {
        return {
          createHash,
        };
      }

      if (
        specifier ===
        "./operational-shift-control-state"
      ) {
        return {
          assertOperationalShiftControl,
        };
      }

      if (
        specifier ===
        "@/types/next-shift-authorization"
      ) {
        return {
          NEXT_SHIFT_AUTHORIZATION_STATUSES:
            AUTH_STATUSES,
        };
      }

      throw new Error(
        `Unexpected authorization import: ${specifier}`
      );
    }
  );

const revocationModule =
  await loadTsModule(
    "../src/lib/accounts/revocation-eligibility.ts",
    (specifier) => {
      throw new Error(
        `Unexpected revocation import: ${specifier}`
      );
    }
  );

const {
  assertShiftActivationWindowExpired,
} = activationModule;

const {
  assertValidShiftTransition,
  isShiftStatus,
} = transitionModule;

const {
  assertNoOverlappingShifts,
} = overlapModule;

const {
  assertNextShiftAuthorization,
  buildPendingNextShiftAuthorization,
  expireConsumedNextShiftAuthorization,
} = authorizationModule;

const {
  evaluateRevocationEligibility,
} = revocationModule;

const firstToken =
  "d1000000-0000-4000-8000-000000000001";

const secondToken =
  "d1000000-0000-4000-8000-000000000002";

const previousToken =
  "d1000000-0000-4000-8000-000000000003";

const createdAt =
  "2026-10-02T05:00:00.000Z";

const consumedAt =
  "2026-10-02T05:30:00.000Z";

const recoveryAt =
  "2026-10-02T08:00:00.000Z";

const shiftId =
  "expired-scheduled-shift";

const pairId =
  "recovery-pair";

function pendingControl() {
  return createPendingOperationalShiftControl(
    firstToken,
    3,
    createdAt,
    previousToken,
    createdAt
  );
}

function scheduledControl() {
  return consumeOperationalShiftSlot(
    pendingControl(),
    shiftId,
    consumedAt
  );
}

const pair = {
  id: pairId,

  technicianIds: [
    "primary-a",
    "primary-b",
  ],

  status: "active",

  createdBy: "supervisor-1",

  createdAt,
  updatedAt: createdAt,

  deactivatedAt: null,
  deactivatedBy: null,
};

function consumedAuthorization(
  overrides = {}
) {
  const pending =
    buildPendingNextShiftAuthorization({
      control: pendingControl(),

      pair,

      permanentPairId:
        pairId,

      authorizedTechnicianUid:
        "temporary-c",

      technicianEligibility: {
        eligible: true,
        message: null,
      },

      createdBy:
        "supervisor-1",

      createdAt,
    });

  return assertNextShiftAuthorization({
    ...pending,

    status:
      AUTH_STATUSES.CONSUMED,

    shiftId,

    consumedAt,

    completedAt: null,
    expiredAt: null,

    updatedAt:
      consumedAt,

    ...overrides,
  });
}

function expireAuthorization(
  overrides = {}
) {
  return expireConsumedNextShiftAuthorization({
    authorization:
      overrides.authorization ??
      consumedAuthorization(),

    shiftId:
      overrides.shiftId ??
      shiftId,

    slotToken:
      overrides.slotToken ??
      firstToken,

    slotGeneration:
      overrides.slotGeneration ??
      3,

    permanentPairId:
      overrides.permanentPairId ??
      pairId,

    expiredAt:
      overrides.expiredAt ??
      recoveryAt,
  });
}

/*
 * Activation expiry.
 */

test(
  "activation recovery rejects the latest still-valid start boundary",
  () => {
    assert.throws(
      () =>
        assertShiftActivationWindowExpired(
          "2026-10-02T06:00:00.000Z",
          "2026-10-02T14:00:00.000Z",
          new Date(
            "2026-10-02T07:00:00.000Z"
          )
        ),
      /has not expired/
    );
  }
);

test(
  "activation recovery becomes available one millisecond after the latest valid start",
  () => {
    assert.doesNotThrow(
      () =>
        assertShiftActivationWindowExpired(
          "2026-10-02T06:00:00.000Z",
          "2026-10-02T14:00:00.000Z",
          new Date(
            "2026-10-02T07:00:00.001Z"
          )
        )
    );
  }
);

test(
  "short shifts use scheduled end as the activation-expiry boundary",
  () => {
    assert.throws(
      () =>
        assertShiftActivationWindowExpired(
          "2026-10-02T06:00:00.000Z",
          "2026-10-02T06:30:00.000Z",
          new Date(
            "2026-10-02T06:30:00.000Z"
          )
        ),
      /has not expired/
    );

    assert.doesNotThrow(
      () =>
        assertShiftActivationWindowExpired(
          "2026-10-02T06:00:00.000Z",
          "2026-10-02T06:30:00.000Z",
          new Date(
            "2026-10-02T06:30:00.001Z"
          )
        )
    );
  }
);

test(
  "activation recovery rejects an invalid recovery clock",
  () => {
    assert.throws(
      () =>
        assertShiftActivationWindowExpired(
          "2026-10-02T06:00:00.000Z",
          "2026-10-02T14:00:00.000Z",
          new Date("invalid")
        ),
      /recovery time is invalid/
    );
  }
);

/*
 * Global slot recovery.
 */

test(
  "scheduled recovery advances to a new pending generation and preserves lineage",
  () => {
    const before =
      scheduledControl();

    const next =
      advanceExpiredScheduledOperationalShiftControl(
        before,
        shiftId,
        secondToken,
        recoveryAt
      );

    assert.equal(
      next.slotStatus,
      "pending"
    );

    assert.equal(
      next.generation,
      4
    );

    assert.equal(
      next.slotToken,
      secondToken
    );

    assert.equal(
      next.previousSlotToken,
      firstToken
    );

    assert.equal(
      next.shiftId,
      null
    );

    assert.equal(
      next.shiftStatus,
      null
    );

    assert.equal(
      next.advancedAt,
      recoveryAt
    );

    /*
     * Pure helper: input remains unchanged.
     */
    assert.equal(
      before.slotStatus,
      "consumed"
    );

    assert.equal(
      before.shiftId,
      shiftId
    );
  }
);

test(
  "scheduled recovery rejects the wrong occupant and token reuse",
  () => {
    assert.throws(
      () =>
        advanceExpiredScheduledOperationalShiftControl(
          scheduledControl(),
          "another-shift",
          secondToken,
          recoveryAt
        ),
      /Only the current expired scheduled shift/
    );

    assert.throws(
      () =>
        advanceExpiredScheduledOperationalShiftControl(
          scheduledControl(),
          shiftId,
          firstToken,
          recoveryAt
        ),
      /cannot be reused/
    );
  }
);

test(
  "scheduled recovery rejects active or handover occupants",
  () => {
    const active =
      transitionOperationalShiftControl(
        scheduledControl(),
        shiftId,
        "scheduled",
        "active",
        "2026-10-02T06:00:00.000Z"
      );

    const handover =
      transitionOperationalShiftControl(
        active,
        shiftId,
        "active",
        "handover_pending",
        "2026-10-02T07:00:00.000Z"
      );

    for (
      const control of [
        active,
        handover,
      ]
    ) {
      assert.throws(
        () =>
          advanceExpiredScheduledOperationalShiftControl(
            control,
            shiftId,
            secondToken,
            recoveryAt
          ),
        /Only the current expired scheduled shift/
      );
    }
  }
);

test(
  "scheduled recovery rejects stale advancement time",
  () => {
    assert.throws(
      () =>
        advanceExpiredScheduledOperationalShiftControl(
          scheduledControl(),
          shiftId,
          secondToken,
          "2026-10-02T05:29:59.999Z"
        ),
      /timestamp is stale/
    );
  }
);

/*
 * Temporary authorization expiry.
 */

test(
  "consumed temporary authorization expires with exact terminal metadata",
  () => {
    const before =
      consumedAuthorization();

    const expired =
      expireAuthorization({
        authorization: before,
      });

    assert.equal(
      expired.status,
      "expired"
    );

    assert.equal(
      expired.expiredAt,
      recoveryAt
    );

    assert.equal(
      expired.updatedAt,
      recoveryAt
    );

    assert.equal(
      expired.completedAt,
      null
    );

    assert.equal(
      expired.shiftId,
      shiftId
    );

    assert.equal(
      expired.consumedAt,
      consumedAt
    );

    for (
      const field of [
        "id",
        "slotToken",
        "slotGeneration",
        "permanentPairId",
        "authorizedTechnicianUid",
        "createdAt",
        "createdBy",
      ]
    ) {
      assert.equal(
        expired[field],
        before[field],
        `${field} changed during expiry`
      );
    }
  }
);

test(
  "authorization expiry does not mutate its input",
  () => {
    const before =
      consumedAuthorization();

    const snapshot =
      structuredClone(before);

    const expired =
      expireAuthorization({
        authorization: before,
      });

    assert.deepEqual(
      structuredClone(before),
      snapshot
    );

    assert.notEqual(
      expired,
      before
    );
  }
);

test(
  "authorization expiry rejects mismatched recovery authority",
  () => {
    const cases = [
      {
        shiftId:
          "wrong-shift",
      },
      {
        slotToken:
          secondToken,
      },
      {
        slotGeneration:
          4,
      },
      {
        permanentPairId:
          "wrong-pair",
      },
    ];

    for (
      const overrides of cases
    ) {
      assert.throws(
        () =>
          expireAuthorization(
            overrides
          ),
        /does not match the expired scheduled shift/
      );
    }
  }
);

test(
  "authorization expiry accepts only consumed state",
  () => {
    const consumed =
      consumedAuthorization();

    const pending = {
      ...consumed,

      status:
        "pending",

      shiftId:
        null,

      consumedAt:
        null,

      updatedAt:
        createdAt,
    };

    const alreadyExpired =
      expireAuthorization();

    for (
      const authorization of [
        pending,
        alreadyExpired,
      ]
    ) {
      assert.throws(
        () =>
          expireAuthorization({
            authorization,
          }),
        /cannot be expired|does not match the expired scheduled shift/
      );
    }
  }
);

test(
  "authorization expiry rejects timestamps before consumption or latest update",
  () => {
    assert.throws(
      () =>
        expireAuthorization({
          expiredAt:
            "2026-10-02T05:29:59.999Z",
        }),
      /timestamp is inconsistent/
    );

    const updated =
      consumedAuthorization({
        updatedAt:
          "2026-10-02T06:30:00.000Z",
      });

    assert.throws(
      () =>
        expireAuthorization({
          authorization:
            updated,

          expiredAt:
            "2026-10-02T06:29:59.999Z",
        }),
      /timestamp is inconsistent/
    );
  }
);

/*
 * Cancelled lifecycle boundary.
 */

test(
  "cancelled is recognized but generic scheduled to cancelled remains forbidden",
  () => {
    assert.equal(
      isShiftStatus("cancelled"),
      true
    );

    assert.throws(
      () =>
        assertValidShiftTransition(
          "scheduled",
          "cancelled"
        ),
      /not permitted/
    );

    assert.throws(
      () =>
        assertValidShiftTransition(
          "cancelled",
          "active"
        ),
      /not permitted/
    );
  }
);

function shift(
  overrides = {}
) {
  return {
    id:
      "target-shift",

    operationalSlotToken:
      firstToken,

    permanentPairId:
      pairId,

    shiftType:
      "morning",

    status:
      "scheduled",

    scheduledStart:
      "2026-10-03T06:00:00.000Z",

    scheduledEnd:
      "2026-10-03T14:00:00.000Z",

    actualStart:
      null,

    actualEnd:
      null,

    primaryTechnicianIds: [
      "primary-a",
      "primary-b",
    ],

    createdBy:
      "supervisor-1",

    createdAt,

    updatedAt:
      createdAt,

    ...overrides,
  };
}

test(
  "cancelled historical shifts no longer block overlap checks",
  () => {
    const target =
      shift();

    const cancelled =
      shift({
        id:
          "cancelled-history",

        status:
          "cancelled",
      });

    assert.doesNotThrow(
      () =>
        assertNoOverlappingShifts(
          target,
          [cancelled]
        )
    );

    /*
     * Control case: an overlapping scheduled
     * shift still blocks the assignment.
     */
    assert.throws(
      () =>
        assertNoOverlappingShifts(
          target,
          [
            shift({
              id:
                "still-scheduled",
            }),
          ]
        ),
      /already assigned/
    );
  }
);

test(
  "cancelled historical shifts are recognized as non-blocking for revocation eligibility",
  () => {
    const result =
      evaluateRevocationEligibility({
        actorUid:
          "admin-1",

        actorRole:
          "admin",

        originalAdminUid:
          "admin-1",

        targetUid:
          "primary-a",

        targetRole:
          "technician",

        targetStatus:
          "active",

        hasPendingAccountOperation:
          false,

        shifts: [
          {
            id:
              "cancelled-history",

            status:
              "cancelled",

            technicianIds: [
              "primary-a",
              "primary-b",
            ],
          },
        ],

        unfinishedTasks:
          [],

        eligiblePartnerIds:
          [],
      });

    assert.equal(
      result.eligible,
      true
    );

    assert.deepEqual(
      structuredClone(
        result.errors
      ),
      []
    );
  }
);
