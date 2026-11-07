import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

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
  globals = {},
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
      ...globals,
      require(specifier) {
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
    },
  );

  return loaded.exports;
}

const serverNow =
  "2026-10-01T08:00:00.000Z";

const normalizer =
  await loadTranspiledModule(
    "../src/lib/operations/attendance-location-evidence.ts",
  );

const clientCapture =
  await loadTranspiledModule(
    "../src/lib/shifts/coarse-location.ts",
    {
      navigator: {
        geolocation: undefined,
      },
    },
  );

test(
  "a missing payload records an explicit not-captured state",
  () => {
    const evidence =
      normalizer.normalizeAttendanceLocationEvidence(
        undefined,
        serverNow,
      );

    assert.equal(
      evidence.state,
      "not_captured",
    );

    assert.equal(
      evidence.source,
      "browser_geolocation",
    );

    assert.equal(
      evidence.reason,
      "not_provided",
    );

    assert.equal(
      evidence.capturedAt,
      serverNow,
    );
  },
);

test(
  "a malformed payload degrades to not-captured instead of throwing",
  () => {
    for (const value of [
      "anything",
      42,
      [],
      { state: "captured" },
      {
        state: "captured",
        latitude: 5.6,
        longitude: -0.2,
      },
    ]) {
      const evidence =
        normalizer.normalizeAttendanceLocationEvidence(
          value,
          serverNow,
        );

      assert.equal(
        evidence.state,
        "not_captured",
        JSON.stringify(value),
      );

      assert.equal(
        evidence.reason,
        "not_provided",
      );
    }
  },
);

test(
  "a whitelisted not-captured reason is preserved",
  () => {
    const evidence =
      normalizer.normalizeAttendanceLocationEvidence(
        {
          state: "not_captured",
          source:
            "browser_geolocation",
          capturedAt:
            "2026-10-01T07:59:00.000Z",
          reason:
            "permission_denied",
        },
        serverNow,
      );

    assert.equal(
      evidence.state,
      "not_captured",
    );

    assert.equal(
      evidence.reason,
      "permission_denied",
    );

    // The browser timestamp is replaced by the trusted server clock.
    assert.equal(
      evidence.capturedAt,
      serverNow,
    );
  },
);

test(
  "an unknown not-captured reason falls back to not-provided",
  () => {
    const evidence =
      normalizer.normalizeAttendanceLocationEvidence(
        {
          state: "not_captured",
          reason: "made_up",
        },
        serverNow,
      );

    assert.equal(
      evidence.reason,
      "not_provided",
    );
  },
);

test(
  "captured evidence is recorded coarse with the server clock",
  () => {
    const evidence =
      normalizer.normalizeAttendanceLocationEvidence(
        {
          state: "captured",
          source:
            "browser_geolocation",
          capturedAt:
            "2026-10-01T07:58:00.000Z",
          latitude: 5.556789,
          longitude: -0.196789,
          accuracyMeters: 37.4,
        },
        serverNow,
      );

    assert.equal(
      evidence.state,
      "captured",
    );

    assert.equal(
      evidence.source,
      "browser_geolocation",
    );

    assert.equal(
      evidence.latitude,
      5.56,
    );

    assert.equal(
      evidence.longitude,
      -0.2,
    );

    assert.equal(
      evidence.accuracyMeters,
      100,
    );

    assert.equal(
      evidence.capturedAt,
      serverNow,
    );
  },
);

test(
  "accuracy is bucketed upward to whole 100 metre steps",
  () => {
    const evidence =
      normalizer.normalizeAttendanceLocationEvidence(
        {
          state: "captured",
          latitude: 5.6,
          longitude: -0.2,
          accuracyMeters: 240,
        },
        serverNow,
      );

    assert.equal(
      evidence.accuracyMeters,
      200,
    );
  },
);

test(
  "out-of-range coordinates are not accepted as captured",
  () => {
    for (const [latitude, longitude] of [
      [91, 0],
      [-91, 0],
      [0, 181],
      [0, -181],
    ]) {
      const evidence =
        normalizer.normalizeAttendanceLocationEvidence(
          {
            state: "captured",
            latitude,
            longitude,
            accuracyMeters: 10,
          },
          serverNow,
        );

      assert.equal(
        evidence.state,
        "not_captured",
      );

      assert.equal(
        evidence.reason,
        "not_provided",
      );
    }
  },
);

test(
  "an invalid server clock falls back to the Unix epoch",
  () => {
    const evidence =
      normalizer.normalizeAttendanceLocationEvidence(
        undefined,
        "not-a-timestamp",
      );

    assert.equal(
      evidence.capturedAt,
      new Date(0).toISOString(),
    );
  },
);

test(
  "the client records unsupported when the browser has no geolocation",
  async () => {
    const evidence =
      await clientCapture.captureCoarseLocationEvidence();

    assert.equal(
      evidence.state,
      "not_captured",
    );

    assert.equal(
      evidence.reason,
      "unsupported",
    );

    assert.equal(
      evidence.source,
      "browser_geolocation",
    );
  },
);

test(
  "the client rounds a captured fix before sending it",
  async () => {
    const capture =
      await loadTranspiledModule(
        "../src/lib/shifts/coarse-location.ts",
        {
          navigator: {
            geolocation: {
              getCurrentPosition(
                success,
                _error,
                options,
              ) {
                assert.equal(
                  options.enableHighAccuracy,
                  false,
                );

                assert.equal(
                  options.timeout,
                  3000,
                );

                assert.equal(
                  options.maximumAge,
                  300000,
                );

                success({
                  coords: {
                    latitude:
                      5.556789,
                    longitude:
                      -0.196789,
                    accuracy: 37.4,
                  },
                });
              },
            },
          },
        },
      );

    const evidence =
      await capture.captureCoarseLocationEvidence();

    assert.equal(
      evidence.state,
      "captured",
    );

    assert.equal(
      evidence.latitude,
      5.56,
    );

    assert.equal(
      evidence.longitude,
      -0.2,
    );

    assert.equal(
      evidence.accuracyMeters,
      100,
    );
  },
);

test(
  "the client maps geolocation errors to explicit reasons",
  async () => {
    for (const [code, expectedReason] of [
      [1, "permission_denied"],
      [2, "position_unavailable"],
      [3, "timeout"],
    ]) {
      const capture =
        await loadTranspiledModule(
          "../src/lib/shifts/coarse-location.ts",
          {
            navigator: {
              geolocation: {
                getCurrentPosition(
                  _success,
                  error,
                ) {
                  error({
                    code,
                    PERMISSION_DENIED: 1,
                    POSITION_UNAVAILABLE: 2,
                    TIMEOUT: 3,
                  });
                },
              },
            },
          },
        );

      const evidence =
        await capture.captureCoarseLocationEvidence();

      assert.equal(
        evidence.state,
        "not_captured",
      );

      assert.equal(
        evidence.reason,
        expectedReason,
      );
    }
  },
);

test(
  "a throwing geolocation implementation never blocks the act",
  async () => {
    const capture =
      await loadTranspiledModule(
        "../src/lib/shifts/coarse-location.ts",
        {
          navigator: {
            geolocation: {
              getCurrentPosition() {
                throw new Error(
                  "not allowed",
                );
              },
            },
          },
        },
      );

    const evidence =
      await capture.captureCoarseLocationEvidence();

    assert.equal(
      evidence.state,
      "not_captured",
    );

    assert.equal(
      evidence.reason,
      "position_unavailable",
    );
  },
);