import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceOperationalShiftControl,
  adoptOperationalShiftControl,
  assertOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
  consumeOperationalShiftSlot,
  createPendingOperationalShiftControl,
  transitionOperationalShiftControl,
} from "../src/lib/operations/operational-shift-control-state.ts";

const firstSlotToken =
  "a0000000-0000-4000-8000-000000000001";
const secondSlotToken =
  "a0000000-0000-4000-8000-000000000002";
const timestamp = "2026-09-30T12:00:00.000Z";

function pendingControl() {
  return createPendingOperationalShiftControl(
    firstSlotToken,
    1,
    timestamp
  );
}

test("initial control bootstrap is one pending slot without shift data", () => {
  const control = pendingControl();

  assert.equal(control.slotStatus, "pending");
  assert.equal(control.generation, 1);
  assert.equal(control.shiftId, null);
  assert.equal(control.shiftStatus, null);
  assert.equal(control.consumedAt, null);
  assert.equal("members" in control, false);
  assert.equal("attendance" in control, false);
  assert.equal("technicianPairMemberships" in control, false);
});

test("consumption binds the pending slot to one scheduled shift", () => {
  const consumed = consumeOperationalShiftSlot(
    pendingControl(),
    "shift-one",
    timestamp
  );

  assert.equal(consumed.slotStatus, "consumed");
  assert.equal(consumed.slotToken, firstSlotToken);
  assert.equal(consumed.shiftId, "shift-one");
  assert.equal(consumed.shiftStatus, "scheduled");
});

test("a consumed slot rejects a second shift in each occupying state", () => {
  const scheduled = consumeOperationalShiftSlot(
    pendingControl(),
    "shift-one",
    timestamp
  );
  const active = transitionOperationalShiftControl(
    scheduled,
    "shift-one",
    "scheduled",
    "active",
    timestamp
  );
  const handoverPending = transitionOperationalShiftControl(
    active,
    "shift-one",
    "active",
    "handover_pending",
    timestamp
  );

  for (const control of [scheduled, active, handoverPending]) {
    assert.throws(
      () =>
        consumeOperationalShiftSlot(
          control,
          "shift-two",
          timestamp
        ),
      /already been consumed/
    );
  }
});

test("completion advances to a distinct pending slot and retains lineage", () => {
  const handoverPending = transitionOperationalShiftControl(
    transitionOperationalShiftControl(
      consumeOperationalShiftSlot(
        pendingControl(),
        "shift-one",
        timestamp
      ),
      "shift-one",
      "scheduled",
      "active",
      timestamp
    ),
    "shift-one",
    "active",
    "handover_pending",
    timestamp
  );

  const next = advanceOperationalShiftControl(
    handoverPending,
    "shift-one",
    secondSlotToken,
    "2026-09-30T13:00:00.000Z"
  );

  assert.equal(next.slotStatus, "pending");
  assert.equal(next.generation, 2);
  assert.equal(next.slotToken, secondSlotToken);
  assert.notEqual(next.slotToken, firstSlotToken);
  assert.equal(next.previousSlotToken, firstSlotToken);
  assert.equal(next.shiftId, null);
});

test("the advanced slot can be consumed but the old slot cannot be reused", () => {
  const firstConsumed = consumeOperationalShiftSlot(
    pendingControl(),
    "shift-one",
    timestamp
  );
  const handoverPending = transitionOperationalShiftControl(
    transitionOperationalShiftControl(
      firstConsumed,
      "shift-one",
      "scheduled",
      "active",
      timestamp
    ),
    "shift-one",
    "active",
    "handover_pending",
    timestamp
  );
  const secondPending = advanceOperationalShiftControl(
    handoverPending,
    "shift-one",
    secondSlotToken,
    "2026-09-30T13:00:00.000Z"
  );

  assert.equal(
    consumeOperationalShiftSlot(
      secondPending,
      "shift-two",
      "2026-09-30T13:01:00.000Z"
    ).shiftId,
    "shift-two"
  );
  assert.throws(
    () =>
      consumeOperationalShiftSlot(
        firstConsumed,
        "shift-two",
        timestamp
      ),
    /already been consumed/
  );
});

test("stale or mismatched completion cannot advance the slot", () => {
  const consumed = adoptOperationalShiftControl(
    firstSlotToken,
    "shift-one",
    "handover_pending",
    timestamp
  );

  assert.throws(
    () =>
      advanceOperationalShiftControl(
        consumed,
        "shift-two",
        secondSlotToken,
        timestamp
      ),
    /Only the current/
  );
  assert.throws(
    () =>
      assertShiftOwnsOperationalSlot(
        consumed,
        "shift-one",
        secondSlotToken,
        "handover_pending"
      ),
    /not the current occupant/
  );
});

test("malformed and contradictory control states fail closed", () => {
  assert.throws(
    () =>
      assertOperationalShiftControl({
        ...pendingControl(),
        shiftId: "shift-one",
      }),
    /pending operational shift slot/
  );
  assert.throws(
    () =>
      assertOperationalShiftControl({
        ...pendingControl(),
        slotToken: "",
      }),
    /slot token is invalid/
  );
  assert.throws(
    () =>
      assertOperationalShiftControl({
        ...pendingControl(),
        generation: 2,
      }),
    /slot token is invalid/
  );
  assert.throws(
    () =>
      assertOperationalShiftControl({
        ...pendingControl(),
        temporaryTechnicianUid: "not-in-this-checkpoint",
      }),
    /unsupported fields/
  );
  assert.throws(
    () =>
      assertOperationalShiftControl({
        ...pendingControl(),
        updatedAt: "2026-09-30T11:00:00.000Z",
      }),
    /timestamps are contradictory/
  );
});

test("legacy occupying shift can be adopted into the singleton slot", () => {
  const control = adoptOperationalShiftControl(
    firstSlotToken,
    "legacy-shift",
    "active",
    timestamp
  );

  assert.equal(control.slotStatus, "consumed");
  assert.equal(control.shiftId, "legacy-shift");
  assert.equal(control.shiftStatus, "active");
  assert.equal(control.consumedAt, timestamp);
});
// A7 formal transfer remains separate from ordinary A6 completion advancement.
const { transferOperationalShiftControl } = await import("../src/lib/operations/operational-shift-control-state.ts");
const transferAt = "2026-09-30T12:01:00.000Z";
function handoverControl() {
  return adoptOperationalShiftControl(firstSlotToken, "outgoing-shift", "handover_pending", timestamp);
}
function transferInput(overrides = {}) {
  return {
    currentControl: handoverControl(), outgoingShiftId: "outgoing-shift",
    outgoingSlotToken: firstSlotToken, outgoingGeneration: 1,
    incomingShiftId: "incoming-shift", successorSlotToken: secondSlotToken,
    successorGeneration: 2, transferTimestamp: transferAt, ...overrides,
  };
}
test("formal handover transfers consumed ownership directly with complete successor lineage and no input mutation", () => {
  const input = transferInput();
  const original = structuredClone(input);
  const result = transferOperationalShiftControl(input);
  assert.deepEqual(input, original);
  assert.deepEqual(result, {
    generation: 2, slotToken: secondSlotToken, slotStatus: "consumed",
    shiftId: "incoming-shift", shiftStatus: "active", createdAt: transferAt,
    consumedAt: transferAt, previousSlotToken: firstSlotToken, advancedAt: transferAt, updatedAt: transferAt,
  });
  assert.deepEqual(assertOperationalShiftControl(result), result);
});
for (const status of ["scheduled", "active", "completed", "cancelled"]) {
  test(`formal transfer rejects ${status} source shift status`, () => {
    assert.throws(() => transferOperationalShiftControl(transferInput({
      currentControl: { ...handoverControl(), shiftStatus: status },
    })));
  });
}
test("formal transfer rejects pending current control", () => {
  assert.throws(() => transferOperationalShiftControl(transferInput({ currentControl: pendingControl() })), /Stale/);
});
for (const [label, overrides] of [
  ["wrong outgoing shift", { outgoingShiftId: "other-shift" }],
  ["stale outgoing token", { outgoingSlotToken: secondSlotToken }],
  ["stale outgoing generation", { outgoingGeneration: 2 }],
  ["skipped successor generation", { successorGeneration: 3 }],
  ["unchanged successor generation", { successorGeneration: 1 }],
  ["fractional successor generation", { successorGeneration: 2.5 }],
  ["reused token", { successorSlotToken: firstSlotToken }],
  ["case-only reused token", { successorSlotToken: firstSlotToken.toUpperCase() }],
  ["malformed incoming ID", { incomingShiftId: "bad/id" }],
  ["empty incoming ID", { incomingShiftId: "" }],
  ["incoming equals outgoing", { incomingShiftId: "outgoing-shift" }],
  ["malformed successor UUID", { successorSlotToken: "bad" }],
  ["malformed outgoing UUID", { outgoingSlotToken: "bad" }],
  ["malformed transfer timestamp", { transferTimestamp: "bad" }],
  ["noncanonical transfer timestamp", { transferTimestamp: "2026-09-30T12:01:00Z" }],
  ["backdated transfer timestamp", { transferTimestamp: "2026-09-30T11:59:00.000Z" }],
]) test(`formal transfer rejects ${label}`, () => {
  assert.throws(() => transferOperationalShiftControl(transferInput(overrides)));
});
test("formal transfer cannot execute twice or advance a successor twice", () => {
  const input = transferInput();
  const result = transferOperationalShiftControl(input);
  assert.throws(() => transferOperationalShiftControl({ ...input, currentControl: result }), /Stale/);
});
test("formal transfer accepts matching UUID case spellings without allowing same-token reuse", () => {
  const result = transferOperationalShiftControl(transferInput({
    outgoingSlotToken: firstSlotToken.toUpperCase(), successorSlotToken: secondSlotToken.toUpperCase(),
  }));
  assert.equal(result.slotToken, secondSlotToken);
});
test("ordinary A6 advance is still a pending successor and formal transfer is consumed at the same generation", () => {
  const source = handoverControl();
  const ordinary = advanceOperationalShiftControl(source, "outgoing-shift", secondSlotToken, transferAt);
  const formal = transferOperationalShiftControl(transferInput({ currentControl: source }));
  assert.equal(ordinary.generation, 2);
  assert.equal(formal.generation, 2);
  assert.equal(ordinary.previousSlotToken, firstSlotToken);
  assert.equal(formal.previousSlotToken, firstSlotToken);
  assert.equal(ordinary.slotStatus, "pending");
  assert.equal(ordinary.shiftId, null);
  assert.equal(ordinary.shiftStatus, null);
  assert.equal(ordinary.consumedAt, null);
  assert.equal(formal.slotStatus, "consumed");
  assert.equal(source.shiftStatus, "handover_pending");
});
