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

const locationStates = {
  CAPTURED: "captured",
  NOT_CAPTURED:
    "not_captured",
};

const locationReasons = {
  PERMISSION_DENIED:
    "permission_denied",
  POSITION_UNAVAILABLE:
    "position_unavailable",
  TIMEOUT: "timeout",
  UNSUPPORTED: "unsupported",
  NOT_PROVIDED:
    "not_provided",
};

const locationSources = {
  BROWSER_GEOLOCATION:
    "browser_geolocation",
};

async function loadTranspiledModule(
  relativePath,
  requireShim,
) {
  const source = await readFile(
    new URL(
      relativePath,
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
      require: requireShim,
    },
  );

  return loaded.exports;
}

// The real server normalizer is loaded, not re-implemented here.
const locationEvidenceModule =
  await loadTranspiledModule(
    "../src/lib/operations/attendance-location-evidence.ts",
    (specifier) => {
      if (
        specifier ===
        "@/types/attendance-location"
      ) {
        return {
          ATTENDANCE_LOCATION_EVIDENCE_STATES:
            locationStates,
          ATTENDANCE_LOCATION_NOT_CAPTURED_REASONS:
            locationReasons,
          ATTENDANCE_LOCATION_SOURCES:
            locationSources,
        };
      }

      throw new Error(
        `Unexpected import: ${specifier}`,
      );
    },
  );

const domain =
  await loadTranspiledModule(
    "../src/lib/operations/attendance-read-domain.ts",
    (specifier) => {
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

      if (
        specifier ===
        "./attendance-location-evidence"
      ) {
        return locationEvidenceModule;
      }

      throw new Error(
        `Unexpected import: ${specifier}`,
      );
    },
  );

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

test(
  "omits location evidence for records written before it existed",
  () => {
    const result =
      domain.readAttendanceRecord(
        documentId,
        validAttendance(),
      );

    assert.equal(
      result.locationEvidence,
      undefined,
    );
  },
);

test(
  "normalizes captured location evidence onto the trusted read clock",
  () => {
    const attendance =
      validAttendance();

    attendance.locationEvidence = {
      state: "captured",
      source:
        "browser_geolocation",
      capturedAt:
        "2026-10-01T07:58:00.000Z",
      latitude: 5.556789,
      longitude: -0.196789,
      accuracyMeters: 37.4,
    };

    const result =
      domain.readAttendanceRecord(
        documentId,
        attendance,
      );

    assert.equal(
      result.locationEvidence
        ?.state,
      "captured",
    );

    assert.equal(
      result.locationEvidence
        ?.latitude,
      5.56,
    );

    assert.equal(
      result.locationEvidence
        ?.longitude,
      -0.2,
    );

    assert.equal(
      result.locationEvidence
        ?.accuracyMeters,
      100,
    );

    // A browser-supplied timestamp is never trusted.
    assert.equal(
      result.locationEvidence
        ?.capturedAt,
      recordedAt,
    );
  },
);

test(
  "records an explicit not-captured state for unusable location evidence",
  () => {
    const attendance =
      validAttendance();

    attendance.locationEvidence = {
      state: "captured",
      source:
        "browser_geolocation",
      capturedAt:
        "2026-10-01T07:58:00.000Z",
      latitude: 999,
      longitude: 0,
      accuracyMeters: 10,
    };

    const result =
      domain.readAttendanceRecord(
        documentId,
        attendance,
      );

    assert.equal(
      result.locationEvidence
        ?.state,
      "not_captured",
    );

    assert.equal(
      result.locationEvidence
        ?.reason,
      "not_provided",
    );

    assert.equal(
      result.locationEvidence
        ?.capturedAt,
      recordedAt,
    );
  },
);

test(
  "records a not-provided state when location evidence is explicitly null",
  () => {
    const attendance =
      validAttendance();

    attendance.locationEvidence =
      null;

    const result =
      domain.readAttendanceRecord(
        documentId,
        attendance,
      );

    assert.equal(
      result.locationEvidence
        ?.state,
      "not_captured",
    );

    assert.equal(
      result.locationEvidence
        ?.reason,
      "not_provided",
    );
  },
);