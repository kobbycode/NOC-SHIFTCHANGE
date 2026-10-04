import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import test from "node:test";

const routePath =
  "src/app/(dashboard)/api/operations/shifts/[shiftId]/recover-expired/route.ts";

const source =
  readFileSync(
    routePath,
    "utf8"
  );

test(
  "recovery API is POST-only application code with no request-body authority",
  () => {
    assert.match(
      source,
      /export async function POST/
    );

    assert.doesNotMatch(
      source,
      /export async function (GET|PUT|PATCH|DELETE)/
    );

    assert.doesNotMatch(
      source,
      /request\.json\s*\(/
    );
  }
);

test(
  "recovery API authenticates the current session",
  () => {
    assert.match(
      source,
      /getCurrentUser/
    );

    assert.match(
      source,
      /if\s*\(\s*!actor\s*\)/
    );

    assert.match(
      source,
      /401/
    );
  }
);

test(
  "recovery API grants exceptional recovery authority only to administrators",
  () => {
    assert.match(
      source,
      /actor\.role\s*!==\s*"admin"/
    );

    assert.match(
      source,
      /actor\.mustChangePassword/
    );

    assert.doesNotMatch(
      source,
      /actor\.role\s*===\s*"supervisor"/
    );
  }
);

test(
  "recovery API derives actor identity from the authenticated session",
  () => {
    assert.match(
      source,
      /recoverExpiredScheduledShift/
    );

    assert.match(
      source,
      /actorUid:\s*actor\.uid/
    );

    assert.doesNotMatch(
      source,
      /actorUid:\s*(body|input|request)/
    );
  }
);

test(
  "recovery API returns cancelledAt rather than fabricating actualEnd",
  () => {
    assert.match(
      source,
      /cancelledAt:\s*result\.cancelledAt/
    );

    assert.doesNotMatch(
      source,
      /actualEnd:\s*result/
    );
  }
);

test(
  "recovery API preserves authoritative operational error status",
  () => {
    assert.match(
      source,
      /AssignmentOperationError/
    );

    assert.match(
      source,
      /error\.message/
    );

    assert.match(
      source,
      /error\.status/
    );
  }
);
