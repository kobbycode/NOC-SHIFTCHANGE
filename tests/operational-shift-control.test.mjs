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