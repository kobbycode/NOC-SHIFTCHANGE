import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

class TestAssignmentOperationError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function parseShiftTimeRange(scheduledStart, scheduledEnd) {
  const start = Date.parse(scheduledStart);
  const end = Date.parse(scheduledEnd);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new TestAssignmentOperationError(
      "The shift has an invalid start or end time.",
      409
    );
  }

  return { start, end };
}

const activationWindowSource = await readFile(
  new URL(
    "../src/lib/operations/shift-activation-window.ts",
    import.meta.url
  ),
  "utf8"
);

const activationWindowJavaScript = ts.transpileModule(
  activationWindowSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }
).outputText;

const activationWindowModule = { exports: {} };

runInNewContext(
  activationWindowJavaScript,
  {
    exports: activationWindowModule.exports,
    require(specifier) {
      if (specifier === "server-only") {
        return {};
      }

      if (specifier === "./assignment-transaction") {
        return {
          AssignmentOperationError:
            TestAssignmentOperationError,
        };
      }

      if (specifier === "./shift-overlap") {
        return { parseShiftTimeRange };
      }

      throw new Error(`Unexpected helper import: ${specifier}`);
    },
  }
);

const { assertShiftActivationWindow } =
  activationWindowModule.exports;

const scheduledStart = "2026-10-01T08:00:00.000Z";
const scheduledEnd = "2026-10-01T16:00:00.000Z";
const activationAt = (value) => new Date(value);

test("too-early activation is rejected with the established conflict", () => {
  assert.throws(
    () =>
      assertShiftActivationWindow(
        scheduledStart,
        scheduledEnd,
        activationAt("2026-10-01T07:44:59.999Z")
      ),
    (error) =>
      error instanceof TestAssignmentOperationError &&
      error.status === 409 &&
      error.message ===
        "This shift cannot be started yet. Please wait until its permitted activation window."
  );
});

test("too-late activation is rejected with the established conflict", () => {
  assert.throws(
    () =>
      assertShiftActivationWindow(
        scheduledStart,
        scheduledEnd,
        activationAt("2026-10-01T09:00:00.001Z")
      ),
    (error) =>
      error instanceof TestAssignmentOperationError &&
      error.status === 409 &&
      error.message ===
        "The permitted activation window has expired. Administrator review is required."
  );
});

test("activation after scheduled end is rejected", () => {
  assert.throws(
    () =>
      assertShiftActivationWindow(
        scheduledStart,
        scheduledEnd,
        activationAt("2026-10-01T16:00:00.001Z")
      ),
    (error) =>
      error instanceof TestAssignmentOperationError &&
      error.status === 409 &&
      error.message ===
        "The permitted activation window has expired. Administrator review is required."
  );
});

test("earliest permitted activation boundary is accepted", () => {
  assert.doesNotThrow(() =>
    assertShiftActivationWindow(
      scheduledStart,
      scheduledEnd,
      activationAt("2026-10-01T07:45:00.000Z")
    )
  );
});

test("latest permitted activation boundary is accepted", () => {
  assert.doesNotThrow(() =>
    assertShiftActivationWindow(
      scheduledStart,
      scheduledEnd,
      activationAt("2026-10-01T09:00:00.000Z")
    )
  );
});

test("a normal activation time inside the window is accepted", () => {
  assert.doesNotThrow(() =>
    assertShiftActivationWindow(
      scheduledStart,
      scheduledEnd,
      activationAt("2026-10-01T08:30:00.000Z")
    )
  );
});

test("startShift enforces activation before bootstrap and transaction writes", async () => {
  const source = await readFile(
    new URL("../src/lib/operations/start-shift.ts", import.meta.url),
    "utf8"
  );
  const activationCheck = source.match(
    /assertShiftActivationWindow\(\s*shift\.scheduledStart,\s*shift\.scheduledEnd\s*\)/
  );
  const activationCheckIndex =
    activationCheck?.index ?? -1;
  const bootstrapIndex = source.indexOf(
    "loadOrBootstrapOperationalShiftControl("
  );
  const transactionWrites = [
    ...source.matchAll(/transaction\.(?:update|create|delete|set)\s*\(/g),
  ].map((match) => match.index);

  assert.notEqual(activationCheckIndex, -1);
  assert.ok(activationCheckIndex < bootstrapIndex);
  assert.ok(transactionWrites.length > 0);
  assert.ok(
    transactionWrites.every(
      (writeIndex) => writeIndex > activationCheckIndex
    )
  );
  assert.doesNotMatch(source, /ensureOperationalShiftControl\(actorUid\)/);
});