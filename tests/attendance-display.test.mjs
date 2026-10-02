import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL(
    "../src/lib/attendance/attendance-display.ts",
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
          "@/types/attendance" ||
        specifier ===
          "./attendance-api-types"
      ) {
        return {};
      }

      throw new Error(
        `Unexpected import: ${specifier}`,
      );
    },
  },
);

const display = loaded.exports;

function attendance(
  technicianId,
) {
  return {
    id:
      `shift-1_${technicianId}`,
    shiftId: "shift-1",
    technicianId,
    status: "present",
    participationAuthority:
      "primary",
    authorizationId: null,
    clockIn: null,
    clockOut: null,
    isProvisional: false,
    recordedAt:
      "2026-10-01T08:00:00.000Z",
    updatedAt:
      "2026-10-01T08:00:00.000Z",
  };
}

test(
  "resolves and trims technician full name",
  () => {
    const profiles =
      new Map([
        [
          "tech-a",
          {
            fullName:
              "  Technician A  ",
          },
        ],
      ]);

    const result =
      display.addAttendanceTechnicianNames(
        [attendance("tech-a")],
        profiles,
      );

    assert.equal(
      result[0].technicianName,
      "Technician A",
    );
  },
);

test(
  "uses neutral label when profile has no usable name",
  () => {
    const profiles =
      new Map([
        [
          "tech-a",
          {
            fullName: "   ",
          },
        ],
      ]);

    const result =
      display.addAttendanceTechnicianNames(
        [attendance("tech-a")],
        profiles,
      );

    assert.equal(
      result[0].technicianName,
      "Unnamed technician",
    );
  },
);

test(
  "falls back to technician uid when profile is unavailable",
  () => {
    const result =
      display.addAttendanceTechnicianNames(
        [attendance("tech-a")],
        new Map(),
      );

    assert.equal(
      result[0].technicianName,
      "Technician tech-a",
    );
  },
);

test(
  "preserves authoritative attendance fields",
  () => {
    const original =
      attendance("tech-a");

    const result =
      display.addAttendanceTechnicianNames(
        [original],
        new Map(),
      )[0];

    assert.equal(
      result.id,
      original.id,
    );

    assert.equal(
      result.shiftId,
      original.shiftId,
    );

    assert.equal(
      result.technicianId,
      original.technicianId,
    );

    assert.equal(
      result.status,
      original.status,
    );

    assert.equal(
      result.recordedAt,
      original.recordedAt,
    );
  },
);