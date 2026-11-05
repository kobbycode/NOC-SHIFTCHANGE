import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScheduledWindow,
  formatSchedulingDateTime,
  getSchedulingCalendarDate,
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
