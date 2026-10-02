import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const statuses = {
  PRESENT: "present",
  ABSENT: "absent",
  LATE: "late",
  EXCUSED: "excused",
  ON_LEAVE: "on_leave",
  NOT_YET_ARRIVED: "not_yet_arrived",
};

const authorities = {
  PRIMARY: "primary",
  TEMPORARY_AUTHORIZED:
    "temporary_authorized",
};

const source = await readFile(
  new URL(
    "../src/lib/operations/attendance-read-domain.ts",
    import.meta.url,
  ),
  "utf8",
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
    },
  ).outputText;

const loaded = {
  exports: {},
};

runInNewContext(
  javascript,
  {
    exports: loaded.exports,

    require(specifier) {
      if (
        specifier ===
        "@/types/attendance"
      ) {
        return {
          ATTENDANCE_STATUSES:
            statuses,

          ATTENDANCE_PARTICIPATION_AUTHORITIES:
            authorities,
        };
      }

      throw new Error(
        `Unexpected import: ${specifier}`,
      );
    },
  },
);

const domain = loaded.exports;

const shiftId =
  "synthetic-shift";

const technicianId =
  "synthetic-technician";

const documentId =
  `${shiftId}_${technicianId}`;

const recordedAt =
  "2026-10-01T08:00:00.000Z";

function validAttendance() {
  return {
    id: documentId,
    shiftId,
    technicianId,
    status: "present",
    participationAuthority:
      "primary",
    authorizationId: null,
    clockIn: null,
    clockOut: null,
    isProvisional: false,
    recordedAt,
    updatedAt: recordedAt,
  };
}

test(
  "accepts valid primary attendance",
  () => {
    const result =
      domain.readAttendanceRecord(
        documentId,
        validAttendance(),
      );

    assert.equal(
      result.id,
      documentId,
    );

    assert.equal(
      result.status,
      "present",
    );
  },
);

test(
  "accepts valid temporary attendance",
  () => {
    const attendance =
      validAttendance();

    attendance.participationAuthority =
      "temporary_authorized";

    attendance.authorizationId =
      "next-shift-auth-synthetic";

    const result =
      domain.readAttendanceRecord(
        documentId,
        attendance,
      );

    assert.equal(
      result.participationAuthority,
      "temporary_authorized",
    );
  },
);

test(
  "rejects stored id mismatch",
  () => {
    const attendance =
      validAttendance();

    attendance.id =
      "wrong-id";

    assert.throws(
      () =>
        domain.readAttendanceRecord(
          documentId,
          attendance,
        ),
      /identity is inconsistent/i,
    );
  },
);

test(
  "rejects non-deterministic document identity",
  () => {
    const attendance =
      validAttendance();

    const wrongId =
      "another-document";

    attendance.id =
      wrongId;

    assert.throws(
      () =>
        domain.readAttendanceRecord(
          wrongId,
          attendance,
        ),
      /identity is inconsistent/i,
    );
  },
);

test(
  "rejects invalid status",
  () => {
    const attendance =
      validAttendance();

    attendance.status =
      "unknown";

    assert.throws(
      () =>
        domain.readAttendanceRecord(
          documentId,
          attendance,
        ),
      /invalid status/i,
    );
  },
);

test(
  "rejects primary attendance with temporary authorization",
  () => {
    const attendance =
      validAttendance();

    attendance.authorizationId =
      "next-shift-auth-synthetic";

    assert.throws(
      () =>
        domain.readAttendanceRecord(
          documentId,
          attendance,
        ),
      /primary attendance cannot reference/i,
    );
  },
);

test(
  "rejects temporary attendance without authorization",
  () => {
    const attendance =
      validAttendance();

    attendance.participationAuthority =
      "temporary_authorized";

    assert.throws(
      () =>
        domain.readAttendanceRecord(
          documentId,
          attendance,
        ),
      /temporary attendance requires/i,
    );
  },
);

test(
  "rejects non-canonical timestamps",
  () => {
    const attendance =
      validAttendance();

    attendance.recordedAt =
      "2026-10-01T08:00:00Z";

    assert.throws(
      () =>
        domain.readAttendanceRecord(
          documentId,
          attendance,
        ),
      /invalid timing/i,
    );
  },
);

test(
  "rejects update before recorded time",
  () => {
    const attendance =
      validAttendance();

    attendance.updatedAt =
      "2026-10-01T07:59:59.000Z";

    assert.throws(
      () =>
        domain.readAttendanceRecord(
          documentId,
          attendance,
        ),
      /update time cannot precede/i,
    );
  },
);

test(
  "rejects clock-out before clock-in",
  () => {
    const attendance =
      validAttendance();

    attendance.clockIn =
      "2026-10-01T08:05:00.000Z";

    attendance.clockOut =
      "2026-10-01T08:04:59.000Z";

    assert.throws(
      () =>
        domain.readAttendanceRecord(
          documentId,
          attendance,
        ),
      /clock-out cannot precede/i,
    );
  },
);