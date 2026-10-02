import assert from "node:assert/strict";
import test from "node:test";

import {
  AttendanceApiError,
  getShiftAttendance,
} from "../src/lib/attendance/attendance-api";

const SHIFT_ID =
  "shift-attendance-client-test";

const TECHNICIAN_ID =
  "technician-attendance-client-test";

const ATTENDANCE_ID =
  `${SHIFT_ID}_${TECHNICIAN_ID}`;

const RECORDED_AT =
  "2026-10-02T06:10:00.000Z";

function validAttendance() {
  return {
    id: ATTENDANCE_ID,
    shiftId: SHIFT_ID,
    technicianId: TECHNICIAN_ID,
    technicianName:
      "Synthetic Technician",
    status: "present",
    participationAuthority:
      "primary",
    authorizationId: null,
    clockIn: null,
    clockOut: null,
    isProvisional: false,
    recordedAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
  };
}

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

function isAttendanceApiError(
  expectedStatus: number,
  expectedMessage?: string,
) {
  return (
    error: unknown,
  ): boolean => {
    if (
      !(error instanceof
        AttendanceApiError)
    ) {
      return false;
    }

    if (
      error.status !==
      expectedStatus
    ) {
      return false;
    }

    if (
      expectedMessage !==
        undefined &&
      error.message !==
        expectedMessage
    ) {
      return false;
    }

    return true;
  };
}

test(
  "retrieves valid authoritative attendance using GET and no-store",
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
          `/api/operations/shifts/${SHIFT_ID}/attendance`,
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
          attendance: [
            validAttendance(),
          ],
          total: 1,
        });
      },
      async () => {
        const result =
          await getShiftAttendance(
            SHIFT_ID,
          );

        assert.equal(
          result.total,
          1,
        );

        assert.deepEqual(
          result.attendance,
          [
            validAttendance(),
          ],
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
  "rejects invalid shift identifiers before fetch",
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
              getShiftAttendance(
                shiftId,
              ),
            isAttendanceApiError(
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
  "preserves authoritative API error status and message",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse(
          {
            success: false,
            error:
              "You are not authorized to retrieve attendance.",
          },
          403,
        ),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            403,
            "You are not authorized to retrieve attendance.",
          ),
        );
      },
    );
  },
);

test(
  "rejects a non-JSON server response",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        new Response(
          "<html>unexpected</html>",
          {
            status: 500,
            headers: {
              "content-type":
                "text/html",
            },
          },
        ),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            500,
            "The server returned an unexpected response.",
          ),
        );
      },
    );
  },
);

test(
  "rejects invalid JSON",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        new Response(
          "{not-valid-json",
          {
            status: 500,
            headers: {
              "content-type":
                "application/json",
            },
          },
        ),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            500,
            "The server returned invalid JSON.",
          ),
        );
      },
    );
  },
);

test(
  "rejects attendance total mismatch",
  { concurrency: false },
  async () => {
    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          attendance: [
            validAttendance(),
          ],
          total: 2,
        }),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            200,
            "The attendance retrieval response is invalid.",
          ),
        );
      },
    );
  },
);

test(
  "rejects attendance for a different shift",
  { concurrency: false },
  async () => {
    const attendance = {
      ...validAttendance(),
      id:
        "other-shift_" +
        TECHNICIAN_ID,
      shiftId:
        "other-shift",
    };

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          attendance: [
            attendance,
          ],
          total: 1,
        }),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            200,
          ),
        );
      },
    );
  },
);

test(
  "rejects non-deterministic attendance identity",
  { concurrency: false },
  async () => {
    const attendance = {
      ...validAttendance(),
      id: "wrong-id",
    };

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          attendance: [
            attendance,
          ],
          total: 1,
        }),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            200,
          ),
        );
      },
    );
  },
);

test(
  "rejects invalid primary authorization linkage",
  { concurrency: false },
  async () => {
    const attendance = {
      ...validAttendance(),
      authorizationId:
        "unexpected-auth",
    };

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          attendance: [
            attendance,
          ],
          total: 1,
        }),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            200,
          ),
        );
      },
    );
  },
);

test(
  "rejects temporary attendance without authorization",
  { concurrency: false },
  async () => {
    const attendance = {
      ...validAttendance(),
      participationAuthority:
        "temporary_authorized",
      authorizationId: null,
    };

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          attendance: [
            attendance,
          ],
          total: 1,
        }),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            200,
          ),
        );
      },
    );
  },
);

test(
  "rejects non-canonical attendance timestamps",
  { concurrency: false },
  async () => {
    const attendance = {
      ...validAttendance(),
      recordedAt:
        "2026-10-02T06:10:00Z",
      updatedAt:
        "2026-10-02T06:10:00Z",
    };

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          attendance: [
            attendance,
          ],
          total: 1,
        }),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            200,
          ),
        );
      },
    );
  },
);

test(
  "rejects clock-out earlier than clock-in",
  { concurrency: false },
  async () => {
    const attendance = {
      ...validAttendance(),
      clockIn:
        "2026-10-02T07:00:00.000Z",
      clockOut:
        "2026-10-02T06:59:59.999Z",
    };

    await withFetch(
      async () =>
        jsonResponse({
          success: true,
          attendance: [
            attendance,
          ],
          total: 1,
        }),
      async () => {
        await assert.rejects(
          () =>
            getShiftAttendance(
              SHIFT_ID,
            ),
          isAttendanceApiError(
            200,
          ),
        );
      },
    );
  },
);