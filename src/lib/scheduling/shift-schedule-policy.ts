import {
  SHIFT_TYPES,
  type ShiftType,
} from "@/types/shift";

/**
 * Single source of truth for the wall-clock
 * scheduling policy exposed by the supervisor
 * interface.
 *
 * The standard operating windows are enforced by
 * the shift-creation path through
 * findShiftWindowDeviation(); overlap, activation
 * and lifecycle rules stay authoritative in the
 * backend. These helpers translate the standard
 * operating windows into the canonical UTC ISO
 * values the shift-creation API requires.
 */
export const SCHEDULING_TIMEZONE = "Africa/Accra";

interface ShiftScheduleWindow {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  endDayOffset: number;
}

export const SHIFT_SCHEDULE_WINDOWS: Readonly<
  Record<ShiftType, ShiftScheduleWindow>
> = {
  [SHIFT_TYPES.MORNING]: {
    startHour: 8,
    startMinute: 0,
    endHour: 17,
    endMinute: 0,
    endDayOffset: 0,
  },
  [SHIFT_TYPES.NIGHT]: {
    startHour: 17,
    startMinute: 0,
    endHour: 8,
    endMinute: 0,
    endDayOffset: 1,
  },
};

export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

export interface ScheduledWindow {
  scheduledStart: string;
  scheduledEnd: string;
}

const CALENDAR_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})$/;

const schedulingDateTimeFormatter =
  new Intl.DateTimeFormat("en-GB", {
    timeZone: SCHEDULING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

function parseCalendarDate(
  value: string
): CalendarDateParts | null {
  const match =
    CALENDAR_DATE_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const candidate = new Date(
    Date.UTC(year, month - 1, day)
  );

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

/**
 * True when the value is a real calendar date
 * in strict YYYY-MM-DD form.
 */
export function isValidCalendarDate(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    parseCalendarDate(value) !== null
  );
}

/**
 * Read the wall-clock date in the scheduling
 * timezone, regardless of the browser timezone.
 */
export function getSchedulingCalendarDate(
  reference: Date = new Date()
): string {
  const parts = schedulingDateTimeFormatter
    .formatToParts(reference)
    .reduce<Record<string, string>>(
      (result, part) => {
        if (part.type !== "literal") {
          result[part.type] = part.value;
        }

        return result;
      },
      {}
    );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addCalendarDays(
  date: CalendarDateParts,
  days: number
): CalendarDateParts {
  const shifted = new Date(
    Date.UTC(
      date.year,
      date.month - 1,
      date.day + days
    )
  );

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Offset, in milliseconds, of the given zone at
 * the given instant.
 *
 * Deriving the offset from Intl keeps conversion
 * correct for any configured scheduling zone,
 * including one that observes daylight saving.
 */
function getTimeZoneOffsetMs(
  timeZone: string,
  timestamp: number
): number {
  const parts = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }
  )
    .formatToParts(new Date(timestamp))
    .reduce<Record<string, number>>(
      (result, part) => {
        if (part.type !== "literal") {
          result[part.type] = Number(part.value);
        }

        return result;
      },
      {}
    );

  const hour =
    parts.hour === 24 ? 0 : parts.hour;

  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    parts.minute,
    parts.second
  );

  const wholeSeconds =
    Math.floor(timestamp / 1000) * 1000;

  return asUtc - wholeSeconds;
}

function zonedWallClockToIso(
  date: CalendarDateParts,
  hour: number,
  minute: number
): string {
  const guess = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute
  );

  const firstOffset =
    getTimeZoneOffsetMs(
      SCHEDULING_TIMEZONE,
      guess
    );

  let utc = guess - firstOffset;

  const secondOffset =
    getTimeZoneOffsetMs(
      SCHEDULING_TIMEZONE,
      utc
    );

  if (secondOffset !== firstOffset) {
    utc = guess - secondOffset;
  }

  return new Date(utc).toISOString();
}

/**
 * Resolve the standard operating window for a
 * shift type on a calendar date.
 *
 * Morning: 08:00–17:00 on the same local day.
 * Night: 17:00–08:00 on the following local day.
 *
 * Returns null for an invalid date or type.
 */
export function buildScheduledWindow(
  shiftType: ShiftType,
  calendarDate: string
): ScheduledWindow | null {
  const window = SHIFT_SCHEDULE_WINDOWS[shiftType];

  if (!window) {
    return null;
  }

  const date = parseCalendarDate(calendarDate);

  if (!date) {
    return null;
  }

  const endDate = addCalendarDays(
    date,
    window.endDayOffset
  );

  return {
    scheduledStart: zonedWallClockToIso(
      date,
      window.startHour,
      window.startMinute
    ),
    scheduledEnd: zonedWallClockToIso(
      endDate,
      window.endHour,
      window.endMinute
    ),
  };
}

export interface ShiftWindowDeviation {
  message: string;
  expectedScheduledStart: string | null;
  expectedScheduledEnd: string | null;
}

/**
 * Owner-set scheduling policy (2026-11-06): a morning shift is 08:00–17:00 and
 * a night shift is 17:00–08:00 on the following local day, in the scheduling
 * timezone. Returns null only when the submitted window is exactly the policy
 * window for the local date of its scheduled start.
 */
export function findShiftWindowDeviation(
  shiftType: ShiftType,
  scheduledStart: string,
  scheduledEnd: string
): ShiftWindowDeviation | null {
  const startTimestamp = Date.parse(scheduledStart);
  const endTimestamp = Date.parse(scheduledEnd);

  if (
    Number.isNaN(startTimestamp) ||
    Number.isNaN(endTimestamp) ||
    endTimestamp <= startTimestamp
  ) {
    return {
      message:
        "Please provide a valid shift start and end in UTC ISO format.",
      expectedScheduledStart: null,
      expectedScheduledEnd: null,
    };
  }

  const policy = buildScheduledWindow(
    shiftType,
    getSchedulingCalendarDate(new Date(startTimestamp))
  );

  if (!policy) {
    return {
      message: "Please select a valid shift type.",
      expectedScheduledStart: null,
      expectedScheduledEnd: null,
    };
  }

  if (
    Date.parse(policy.scheduledStart) === startTimestamp &&
    Date.parse(policy.scheduledEnd) === endTimestamp
  ) {
    return null;
  }

  return {
    message:
      `${shiftType} shifts run ${formatSchedulingDateTime(policy.scheduledStart)} to ` +
      `${formatSchedulingDateTime(policy.scheduledEnd)} (${SCHEDULING_TIMEZONE}); ` +
      "submit that window.",
    expectedScheduledStart: policy.scheduledStart,
    expectedScheduledEnd: policy.scheduledEnd,
  };
}

/**
 * The window shape rule may be relaxed only in a proven isolated emulator
 * stack, so demonstration data can start a shift immediately instead of
 * waiting for the next 08:00/17:00 boundary. Every condition is required:
 * the explicit opt-in, the emulator flag, and a loopback Auth emulator host.
 * Production sets none of them, and a stray `.env.local` cannot open this on
 * its own, so the rule fails closed.
 */
export function isShiftWindowPolicyRelaxed(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return (
    env.SHIFT_WINDOW_POLICY_SANDBOX === "true" &&
    env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true" &&
    typeof env.FIREBASE_AUTH_EMULATOR_HOST === "string" &&
    env.FIREBASE_AUTH_EMULATOR_HOST.startsWith("127.0.0.1:")
  );
}

const displayFormatter =
  new Intl.DateTimeFormat("en-GB", {
    timeZone: SCHEDULING_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/**
 * Display an authoritative UTC timestamp in the
 * scheduling timezone so the operator sees the
 * same wall-clock window that was scheduled.
 */
export function formatSchedulingDateTime(
  value: string
): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return displayFormatter.format(date);
}
