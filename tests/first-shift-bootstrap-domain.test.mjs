import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVATED_SHIFT_STATUSES,
  FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE,
  FirstShiftBootstrapDomainError,
  assertFirstEverShiftBootstrap,
  readFirstShiftBootstrapEvidence,
} from "../src/lib/operations/first-shift-bootstrap-domain.ts";

test("an empty activation ledger keeps first-shift bootstrap open", () => {
  const evidence = readFirstShiftBootstrapEvidence(null);

  assert.deepEqual(evidence, {
    hasActivatedShift: false,
    activatedShiftId: null,
    activatedShiftStatus: null,
  });

  assert.doesNotThrow(() =>
    assertFirstEverShiftBootstrap(evidence)
  );
});

test("every activated lifecycle status closes manual bootstrap permanently", () => {
  for (const shiftStatus of ACTIVATED_SHIFT_STATUSES) {
    const evidence = readFirstShiftBootstrapEvidence({
      shiftId: `ledger-${shiftStatus}`,
      shiftStatus,
    });

    assert.equal(evidence.hasActivatedShift, true);
    assert.equal(evidence.activatedShiftStatus, shiftStatus);

    assert.throws(
      () => assertFirstEverShiftBootstrap(evidence),
      (error) => {
        assert.ok(error instanceof FirstShiftBootstrapDomainError);
        assert.equal(error.status, 409);
        assert.equal(
          error.message,
          FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE
        );

        return true;
      }
    );
  }
});

test("bootstrap is proven from activated history, never from scheduled or cancelled rows", () => {
  assert.deepEqual([...ACTIVATED_SHIFT_STATUSES], [
    "active",
    "handover_pending",
    "completed",
  ]);

  assert.equal(
    ACTIVATED_SHIFT_STATUSES.includes("scheduled"),
    false
  );
  assert.equal(
    ACTIVATED_SHIFT_STATUSES.includes("cancelled"),
    false
  );
});

test("the closure message explains the automatic activation path", () => {
  assert.match(
    FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE,
    /not the first shift/i
  );
  assert.match(
    FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE,
    /automatically/i
  );
  assert.match(
    FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE,
    /incoming technician accepts the handover/i
  );
  assert.match(
    FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE,
    /password/i
  );
});

test("an unstarted shift cancelled by expired-slot recovery does not count as history", () => {
  /*
   * Recovery may only cancel a shift that never activated, so a cancelled row
   * cannot prove that bootstrap was ever used; the ledger read is the only
   * witness and it looks at activated statuses.
   */
  assert.throws(
    () =>
      readFirstShiftBootstrapEvidence({
        shiftId: "recovered-shift",
        shiftStatus: "cancelled",
      }),
    (error) => {
      assert.ok(error instanceof FirstShiftBootstrapDomainError);
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /activation ledger is inconsistent/i
      );

      return true;
    }
  );
});

test("a malformed ledger row fails closed instead of reopening bootstrap", () => {
  const malformedRows = [
    { shiftId: "", shiftStatus: "active" },
    { shiftId: "   ", shiftStatus: "active" },
    { shiftId: " padded ", shiftStatus: "active" },
    { shiftId: "collection/document", shiftStatus: "active" },
    { shiftId: ".", shiftStatus: "active" },
    { shiftId: "..", shiftStatus: "active" },
    { shiftId: null, shiftStatus: "active" },
    { shiftId: "ledger-shift", shiftStatus: null },
    { shiftId: "ledger-shift", shiftStatus: undefined },
    { shiftId: "ledger-shift", shiftStatus: "scheduled" },
    { shiftId: "ledger-shift", shiftStatus: "ACTIVE" },
  ];

  for (const row of malformedRows) {
    assert.throws(
      () => readFirstShiftBootstrapEvidence(row),
      (error) => {
        assert.ok(error instanceof FirstShiftBootstrapDomainError);
        assert.equal(error.status, 409);
        assert.match(
          error.message,
          /activation ledger is inconsistent/i
        );

        return true;
      },
      JSON.stringify(row)
    );
  }
});

test("a caller cannot reopen bootstrap with a hand-built or unusable evidence object", () => {
  for (const evidence of [
    { hasActivatedShift: true },
    { hasActivatedShift: 1 },
    { hasActivatedShift: "false" },
    {},
    null,
    undefined,
  ]) {
    assert.throws(
      () => assertFirstEverShiftBootstrap(evidence),
      (error) => {
        assert.ok(error instanceof FirstShiftBootstrapDomainError);
        assert.equal(error.status, 409);

        return true;
      },
      JSON.stringify(evidence ?? null)
    );
  }
});
