import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScheduledWindow,
  findShiftWindowDeviation,
  formatSchedulingDateTime,
  getSchedulingCalendarDate,
  isShiftWindowPolicyRelaxed,
  isValidCalendarDate,
  SCHEDULING_TIMEZONE,
  SHIFT_SCHEDULE_WINDOWS,
} from "../src/lib/scheduling/shift-schedule-policy";

test("morning window is 08:00-17:00 on the same scheduling day", () => {
  const window = buildScheduledWindow(
    "morning",
    "2026-11-02"
  );

  assert.ok(window);
  assert.equal(
    window.scheduledStart,
    "2026-11-02T08:00:00.000Z"
  );
  assert.equal(
    window.scheduledEnd,
    "2026-11-02T17:00:00.000Z"
  );
});

test("night window crosses midnight into the next scheduling day", () => {
  const window = buildScheduledWindow(
    "night",
    "2026-11-02"
  );

  assert.ok(window);
  assert.equal(
    window.scheduledStart,
    "2026-11-02T17:00:00.000Z"
  );
  assert.equal(
    window.scheduledEnd,
    "2026-11-03T08:00:00.000Z"
  );

  assert.ok(
    Date.parse(window.scheduledEnd) >
      Date.parse(window.scheduledStart)
  );
});

test("night window rolls over month and year boundaries", () => {
  const monthEnd = buildScheduledWindow(
    "night",
    "2026-11-30"
  );
  const yearEnd = buildScheduledWindow(
    "night",
    "2026-12-31"
  );
  const leapDay = buildScheduledWindow(
    "night",
    "2028-02-28"
  );

  assert.equal(
    monthEnd?.scheduledEnd,
    "2026-12-01T08:00:00.000Z"
  );
  assert.equal(
    yearEnd?.scheduledEnd,
    "2027-01-01T08:00:00.000Z"
  );
  assert.equal(
    leapDay?.scheduledEnd,
    "2028-02-29T08:00:00.000Z"
  );
});

test("invalid calendar dates are rejected", () => {
  for (const value of [
    "",
    "2026-02-30",
    "2026-13-01",
    "2026-1-01",
    "02-11-2026",
    "2026-11-02T00:00:00Z",
  ]) {
    assert.equal(
      isValidCalendarDate(value),
      false,
      value
    );
  }

  assert.equal(
    buildScheduledWindow(
      "morning",
      "2026-02-30"
    ),
    null
  );
});

test("valid calendar dates are accepted", () => {
  assert.equal(
    isValidCalendarDate("2026-11-02"),
    true
  );
  assert.equal(
    isValidCalendarDate("2028-02-29"),
    true
  );
});

test("scheduling date follows the configured timezone", () => {
  assert.equal(
    SCHEDULING_TIMEZONE,
    "Africa/Accra"
  );

  assert.match(
    getSchedulingCalendarDate(
      new Date("2026-11-02T23:30:00.000Z")
    ),
    /^\d{4}-\d{2}-\d{2}$/
  );
});

test("windows are derived from the declared policy", () => {
  assert.equal(
    SHIFT_SCHEDULE_WINDOWS.morning.startHour,
    8
  );
  assert.equal(
    SHIFT_SCHEDULE_WINDOWS.morning.endHour,
    17
  );
  assert.equal(
    SHIFT_SCHEDULE_WINDOWS.night.startHour,
    17
  );
  assert.equal(
    SHIFT_SCHEDULE_WINDOWS.night.endHour,
    8
  );
  assert.equal(
    SHIFT_SCHEDULE_WINDOWS.night.endDayOffset,
    1
  );
});

test("display aligns the UTC window with the scheduling timezone", () => {
  assert.match(
    formatSchedulingDateTime(
      "2026-11-02T08:00:00.000Z"
    ),
    /08:00/
  );
  assert.match(
    formatSchedulingDateTime(
      "2026-11-03T08:00:00.000Z"
    ),
    /08:00/
  );
});

test("the exact policy window for its own date is accepted", () => {
  assert.equal(
    findShiftWindowDeviation(
      "morning",
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T17:00:00.000Z"
    ),
    null
  );
  assert.equal(
    findShiftWindowDeviation(
      "night",
      "2026-11-02T17:00:00.000Z",
      "2026-11-03T08:00:00.000Z"
    ),
    null
  );
  assert.equal(
    findShiftWindowDeviation(
      "night",
      "2026-11-30T17:00:00.000Z",
      "2026-12-01T08:00:00.000Z"
    ),
    null
  );
});

test("a drifted start or end is reported against the policy window", () => {
  const lateStart = findShiftWindowDeviation(
    "morning",
    "2026-11-02T08:30:00.000Z",
    "2026-11-02T17:00:00.000Z"
  );

  assert.ok(lateStart);
  assert.equal(
    lateStart.expectedScheduledStart,
    "2026-11-02T08:00:00.000Z"
  );
  assert.equal(
    lateStart.expectedScheduledEnd,
    "2026-11-02T17:00:00.000Z"
  );
  assert.match(lateStart.message, /morning shifts run/i);

  const shortEnd = findShiftWindowDeviation(
    "night",
    "2026-11-02T17:00:00.000Z",
    "2026-11-03T06:00:00.000Z"
  );

  assert.equal(
    shortEnd?.expectedScheduledEnd,
    "2026-11-03T08:00:00.000Z"
  );
});

test("a window supplied under the wrong shift type is rejected", () => {
  const deviation = findShiftWindowDeviation(
    "night",
    "2026-11-02T08:00:00.000Z",
    "2026-11-02T17:00:00.000Z"
  );

  assert.ok(deviation);
  assert.equal(
    deviation.expectedScheduledStart,
    "2026-11-02T17:00:00.000Z"
  );
  assert.equal(
    deviation.expectedScheduledEnd,
    "2026-11-03T08:00:00.000Z"
  );
});

test("an unparseable or inverted window never passes policy validation", () => {
  for (const [start, end] of [
    ["not-a-date", "2026-11-02T17:00:00.000Z"],
    ["2026-11-02T08:00:00.000Z", "2026-11-02T08:00:00.000Z"],
    ["2026-11-02T08:00:00.000Z", "2026-11-02T07:00:00.000Z"],
  ]) {
    const deviation = findShiftWindowDeviation(
      "morning",
      start,
      end
    );

    assert.ok(deviation, `${start} -> ${end}`);
    assert.equal(deviation.expectedScheduledStart, null);
  }
});

test("the window rule is relaxed only in a proven isolated emulator stack", () => {
  const isolated = {
    SHIFT_WINDOW_POLICY_SANDBOX: "true",
    NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  };

  assert.equal(isShiftWindowPolicyRelaxed(isolated), true);

  for (const env of [
    {},
    { ...isolated, SHIFT_WINDOW_POLICY_SANDBOX: undefined },
    { ...isolated, SHIFT_WINDOW_POLICY_SANDBOX: "false" },
    { ...isolated, NEXT_PUBLIC_USE_FIREBASE_EMULATORS: undefined },
    { ...isolated, NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "1" },
    { ...isolated, FIREBASE_AUTH_EMULATOR_HOST: undefined },
    { ...isolated, FIREBASE_AUTH_EMULATOR_HOST: "" },
    { ...isolated, FIREBASE_AUTH_EMULATOR_HOST: "emulator.example:9099" },
  ]) {
    assert.equal(isShiftWindowPolicyRelaxed(env), false, JSON.stringify(env));
  }
});
