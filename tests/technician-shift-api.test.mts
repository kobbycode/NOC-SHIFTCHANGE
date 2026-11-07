import assert from "node:assert/strict";
import test from "node:test";

import {
  ShiftApiError,
  getTechnicianCurrentShift,
  joinShift,
  startShift,
} from "../src/lib/shifts/shift-api";

const SHIFT_ID =
  "shift-technician-client-test";

const TECHNICIAN_ID =
  "technician-client-test";

const STARTED_AT =
  "2026-10-02T06:00:00.000Z";

const RECORDED_AT =
  "2026-10-02T06:05:00.000Z";

const SCHEDULED_START =
  "2026-10-02T06:00:00.000Z";

const SCHEDULED_END =
  "2026-10-02T14:00:00.000Z";

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "content-type":
          "application/json",
      },
    },
  );
}

async function withFetch(
  replacement: typeof fetch,
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch =
    globalThis.fetch;

  globalThis.fetch =
    replacement;

  try {
    await action();
  } finally {
    globalThis.fetch =
      originalFetch;
  }
}

function isShiftApiError(
  expectedStatus: number,
  expectedMessage?: string,
) {
  return (
    error: unknown,
  ): boolean => {
    if (
      !(error instanceof ShiftApiError)
    ) {
      return false;
    }

    if (
      error.status !==
      expectedStatus
    ) {
      return false;
    }

    return (
      expectedMessage === undefined ||
      error.message ===
        expectedMessage
    );
  };
}

function validAttendance(
  overrides:
    Record<string, unknown> = {},
) {
  return {
    id:
      `${SHIFT_ID}_${TECHNICIAN_ID}`,
    shiftId: SHIFT_ID,
    technicianId: TECHNICIAN_ID,
    status: "present",
    participationAuthority:
      "primary",
    authorizationId: null,
    clockIn: null,
    clockOut: null,
    isProvisional: false,
    recordedAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
    ...overrides,
  };
}

function validCurrentShift(
  overrides:
    Record<string, unknown> = {},
) {
  return {
    id: SHIFT_ID,
    shiftType: "morning",
    status: "active",
    scheduledStart:
      SCHEDULED_START,
    scheduledEnd:
      SCHEDULED_END,
    actualStart: STARTED_AT,
    actualEnd: null,
    participationAuthority:
      "primary",
    authorizationId: null,
    attendance: null,
    joinedAt: null,
    firstShiftBootstrapAvailable: false,
    canStart: false,
    canJoin: true,
    ...overrides,
  };
}

function writableWriteAuthority(
  overrides:
    Record<string, unknown> = {},
) {
  return {
    mayWrite: true,
    governed: true,
    basis:
      "personal_handover_acceptance",
    denial: null,
    message:
      "This technician accepted the handover with their own password.",
    activeShiftId: SHIFT_ID,
    personallyAcceptedShiftId:
      SHIFT_ID,
    ...overrides,
  };
}

function readOnlyWriteAuthority(
  overrides:
    Record<string, unknown> = {},
) {
  return {
    mayWrite: false,
    governed: true,
    basis: null,
    denial:
      "participation_without_acceptance",
    message:
      "Accept the handover with your own password to make changes; this view is read-only.",
    activeShiftId: SHIFT_ID,
    personallyAcceptedShiftId:
      null,
    ...overrides,
  };
}

function scheduledReadOnlyAuthority() {
  return readOnlyWriteAuthority({
    denial: "shift_not_running",
    message:
      "This shift no longer accepts changes, so operational data is read-only.",
  });
}

test(
  "retrieves no current technician shift using the narrow GET endpoint",
  { concurrency: false },
  async () => {
    let calls = 0;

    await withFetch(
      async (
        input,
        init,
      ) => {
        calls += 1;

        assert.equal(
          input,
          "/api/operations/technician/current-shift",
        );

        assert.equal(
          init?.method,
          "GET",
        );

        assert.equal(
          init?.credentials,
          "same-origin",
        );

        assert.equal(
          init?.cache,
          "no-store",
        );

        return jsonResponse({
          success: true,
          currentShift: null,
          writeAuthority:
            readOnlyWriteAuthority({
              denial:
                "no_active_shift",
              message:
                "No shift is currently running, so operational data is read-only.",
              activeShiftId: null,
            }),
        });
      },
      async () => {
        const snapshot =
          await getTechnicianCurrentShift();

        assert.equal(
          snapshot.currentShift,
          null,
        );

        assert.equal(
          snapshot.writeAuthority
            .mayWrite,
          false,
        );

        assert.equal(
          snapshot.writeAuthority
            .denial,
          "no_active_shift",
        );
      },
    );

    assert.equal(
      calls,
      1,
    );
  },
);

test(
  "accepts a scheduled primary assignment after the first shift without start or join authority",
  { concurrency: false },
  async () => {
    const currentShift =
      validCurrentShift({
        status: "scheduled",
        actualStart: null,
        canJoin: false,
      });

    const writeAuthority =
      scheduledReadOnlyAuthority();

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift,
          writeAuthority,
        }),
      async () => {
        assert.deepEqual(
          await getTechnicianCurrentShift(),
          {
            currentShift,
            writeAuthority,
          },
        );
      },
    );
  },
);

test(
  "accepts a scheduled first-ever bootstrap assignment with start authority",
  { concurrency: false },
  async () => {
    const currentShift =
      validCurrentShift({
        status: "scheduled",
        actualStart: null,
        firstShiftBootstrapAvailable: true,
        canStart: true,
        canJoin: false,
      });

    const writeAuthority =
      scheduledReadOnlyAuthority();

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift,
          writeAuthority,
        }),
      async () => {
        assert.deepEqual(
          await getTechnicianCurrentShift(),
          {
            currentShift,
            writeAuthority,
          },
        );
      },
    );
  },
);

test(
  "accepts a scheduled temporary authorization with structural start authority",
  { concurrency: false },
  async () => {
    const currentShift =
      validCurrentShift({
        status: "scheduled",
        actualStart: null,
        participationAuthority:
          "temporary_authorized",
        authorizationId:
          "next-shift-auth-client-test",
        firstShiftBootstrapAvailable: true,
        canStart: true,
        canJoin: false,
      });

    const writeAuthority =
      scheduledReadOnlyAuthority();

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift,
          writeAuthority,
        }),
      async () => {
        assert.deepEqual(
          await getTechnicianCurrentShift(),
          {
            currentShift,
            writeAuthority,
          },
        );
      },
    );
  },
);

test(
  "rejects start authority that contradicts the activation ledger",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift({
              status: "scheduled",
              actualStart: null,
              firstShiftBootstrapAvailable: false,
              canStart: true,
              canJoin: false,
            }),
          writeAuthority:
            scheduledReadOnlyAuthority(),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects a current-shift response without the bootstrap field",
  { concurrency: false },
  async () => {
    const {
      firstShiftBootstrapAvailable,
      ...withoutBootstrap
    } = validCurrentShift({
      status: "scheduled",
      actualStart: null,
      canJoin: false,
    });

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift: withoutBootstrap,
          writeAuthority:
            scheduledReadOnlyAuthority(),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects bootstrap availability for an already activated shift",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift({
              firstShiftBootstrapAvailable: true,
              canStart: false,
            }),
          writeAuthority:
            writableWriteAuthority(),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "accepts authoritative joined attendance and joinedAt for an active primary technician",
  { concurrency: false },
  async () => {
    const attendance =
      validAttendance();

    const currentShift =
      validCurrentShift({
        attendance,
        joinedAt:
          RECORDED_AT,
        canJoin: false,
      });

    const writeAuthority =
      writableWriteAuthority();

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift,
          writeAuthority,
        }),
      async () => {
        assert.deepEqual(
          await getTechnicianCurrentShift(),
          {
            currentShift,
            writeAuthority,
          },
        );
      },
    );
  },
);

test(
  "rejects inconsistent current-shift action flags",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift({
              canJoin: false,
            }),
          writeAuthority:
            writableWriteAuthority(),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects a non-present shift-attendance record in current-shift state",
  { concurrency: false },
  async () => {
    const attendance =
      validAttendance({
        status: "absent",
      });

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift({
              attendance,
              joinedAt:
                RECORDED_AT,
              canJoin: false,
            }),
          writeAuthority:
            writableWriteAuthority(),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(200),
        );
      },
    );
  },
);

test(
  "rejects a current-shift response without the write-authority projection",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift(),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects writable authority that also carries a denial",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift(),
          writeAuthority:
            writableWriteAuthority({
              denial:
                "participation_without_acceptance",
            }),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects read-only authority that still claims a write basis",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift(),
          writeAuthority:
            readOnlyWriteAuthority({
              basis:
                "founding_shift_participant",
            }),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects a non-governed authority projection for a technician endpoint",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift(),
          writeAuthority:
            writableWriteAuthority({
              governed: false,
              basis:
                "role_not_governed",
              personallyAcceptedShiftId:
                null,
            }),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects personal acceptance evidence for a different shift",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift(),
          writeAuthority:
            writableWriteAuthority({
              personallyAcceptedShiftId:
                "another-shift",
            }),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects founding authority that claims a personal acceptance",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift:
            validCurrentShift(),
          writeAuthority:
            writableWriteAuthority({
              basis:
                "founding_shift_participant",
            }),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects an active-shift denial without an active shift identity",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          currentShift: null,
          writeAuthority:
            readOnlyWriteAuthority({
              activeShiftId: null,
            }),
        }),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            200,
            "The technician current-shift response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "preserves authoritative current-shift API errors",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse(
          {
            success: false,
            error:
              "Only technicians can view their current shift.",
          },
          403,
        ),
      async () => {
        await assert.rejects(
          () =>
            getTechnicianCurrentShift(),
          isShiftApiError(
            403,
            "Only technicians can view their current shift.",
          ),
        );
      },
    );
  },
);

test(
  "starts a shift using POST without creating client attendance state",
  { concurrency: false },
  async () => {
    await withFetch(
      async (
        input,
        init,
      ) => {
        assert.equal(
          input,
          `/api/operations/shifts/${SHIFT_ID}/start`,
        );

        assert.equal(
          init?.method,
          "POST",
        );

        assert.equal(
          init?.credentials,
          "same-origin",
        );

        assert.equal(
          init?.cache,
          "no-store",
        );

        assert.equal(
          init?.body,
          undefined,
        );

        return jsonResponse({
          success: true,
          message:
            "Shift started successfully.",
          shift: {
            id: SHIFT_ID,
            status: "active",
            actualStart:
              STARTED_AT,
          },
        });
      },
      async () => {
        assert.deepEqual(
          await startShift(
            SHIFT_ID,
          ),
          {
            shiftId:
              SHIFT_ID,
            status: "active",
            actualStart:
              STARTED_AT,
          },
        );
      },
    );
  },
);

test(
  "rejects invalid start shift identifiers before fetch",
  { concurrency: false },
  async () => {
    let calls = 0;

    await withFetch(
      async () => {
        calls += 1;

        throw new Error(
          "fetch must not run",
        );
      },
      async () => {
        for (
          const shiftId of [
            "",
            "   ",
            ".",
            "..",
            "bad/id",
          ]
        ) {
          await assert.rejects(
            () =>
              startShift(
                shiftId,
              ),
            isShiftApiError(
              400,
              "Please provide a valid shift identifier.",
            ),
          );
        }
      },
    );

    assert.equal(
      calls,
      0,
    );
  },
);

test(
  "preserves authoritative start errors",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse(
          {
            success: false,
            error:
              "The shift cannot be started yet.",
          },
          409,
        ),
      async () => {
        await assert.rejects(
          () =>
            startShift(
              SHIFT_ID,
            ),
          isShiftApiError(
            409,
            "The shift cannot be started yet.",
          ),
        );
      },
    );
  },
);

test(
  "rejects a malformed successful start response",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          message:
            "Shift started successfully.",
          shift: {
            id:
              "wrong-shift",
            status:
              "active",
            actualStart:
              STARTED_AT,
          },
        }),
      async () => {
        await assert.rejects(
          () =>
            startShift(
              SHIFT_ID,
            ),
          isShiftApiError(
            200,
            "The shift-start response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "joins an active shift using POST with coarse location evidence and returns authoritative attendance summary",
  { concurrency: false },
  async () => {
    const attendance = {
      id:
        `${SHIFT_ID}_${TECHNICIAN_ID}`,
      shiftId: SHIFT_ID,
      technicianId:
        TECHNICIAN_ID,
      status: "present",
      participationAuthority:
        "primary",
      recordedAt:
        RECORDED_AT,
    };

    await withFetch(
      async (
        input,
        init,
      ) => {
        assert.equal(
          input,
          `/api/operations/shifts/${SHIFT_ID}/join`,
        );

        assert.equal(
          init?.method,
          "POST",
        );

        assert.equal(
          init?.credentials,
          "same-origin",
        );

        assert.equal(
          init?.cache,
          "no-store",
        );

        assert.deepEqual(
          init?.headers,
          {
            "Content-Type":
              "application/json",
          },
        );

        // Node has no browser geolocation, so the client must still send the
        // explicit not-captured state rather than omitting the evidence.
        const body =
          JSON.parse(
            String(init?.body),
          ) as {
            locationEvidence?: {
              state?: string;
              source?: string;
              reason?: string;
            };
          };

        assert.equal(
          body.locationEvidence
            ?.state,
          "not_captured",
        );

        assert.equal(
          body.locationEvidence
            ?.source,
          "browser_geolocation",
        );

        return jsonResponse(
          {
            success: true,
            message:
              "Shift joined successfully.",
            attendance,
          },
          201,
        );
      },
      async () => {
        assert.deepEqual(
          await joinShift(
            SHIFT_ID,
          ),
          attendance,
        );
      },
    );
  },
);

test(
  "rejects invalid join shift identifiers before fetch",
  { concurrency: false },
  async () => {
    let calls = 0;

    await withFetch(
      async () => {
        calls += 1;

        throw new Error(
          "fetch must not run",
        );
      },
      async () => {
        for (
          const shiftId of [
            "",
            "   ",
            ".",
            "..",
            "bad/id",
          ]
        ) {
          await assert.rejects(
            () =>
              joinShift(
                shiftId,
              ),
            isShiftApiError(
              400,
              "Please provide a valid shift identifier.",
            ),
          );
        }
      },
    );

    assert.equal(
      calls,
      0,
    );
  },
);

test(
  "preserves authoritative join errors",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse(
          {
            success: false,
            error:
              "You have already joined this shift.",
          },
          409,
        ),
      async () => {
        await assert.rejects(
          () =>
            joinShift(
              SHIFT_ID,
            ),
          isShiftApiError(
            409,
            "You have already joined this shift.",
          ),
        );
      },
    );
  },
);

test(
  "rejects a non-present successful join response",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse(
          {
            success: true,
            message:
              "Shift joined successfully.",
            attendance: {
              id:
                `${SHIFT_ID}_${TECHNICIAN_ID}`,
              shiftId:
                SHIFT_ID,
              technicianId:
                TECHNICIAN_ID,
              status:
                "absent",
              participationAuthority:
                "primary",
              recordedAt:
                RECORDED_AT,
            },
          },
          201,
        ),
      async () => {
        await assert.rejects(
          () =>
            joinShift(
              SHIFT_ID,
            ),
          isShiftApiError(
            201,
            "The shift-join response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects a non-deterministic successful join attendance identity",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse(
          {
            success: true,
            message:
              "Shift joined successfully.",
            attendance: {
              id:
                "wrong-attendance-id",
              shiftId:
                SHIFT_ID,
              technicianId:
                TECHNICIAN_ID,
              status:
                "present",
              participationAuthority:
                "primary",
              recordedAt:
                RECORDED_AT,
            },
          },
          201,
        ),
      async () => {
        await assert.rejects(
          () =>
            joinShift(
              SHIFT_ID,
            ),
          isShiftApiError(
            201,
          ),
        );
      },
    );
  },
);
