
import "server-only";

import {
  SHIFT_STATUSES,
  type Shift,
} from "@/types/shift";

import type {
  TechnicianScheduleEntry,
} from "@/types/technician-schedule";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

/**
 * ShiftChange 2.0
 *
 * Shift scheduling and overlap protection.
 *
 * This module validates shift time ranges,
 * detects overlapping shifts, and prevents
 * technicians from receiving conflicting
 * shift assignments.
 */

export interface ShiftTimeRange {
  start: number;
  end: number;
}

/**
 * Validate and parse a shift's scheduled
 * start and end times.
 */

export function parseShiftTimeRange(
  scheduledStart: string,
  scheduledEnd: string
): ShiftTimeRange {
  const start = Date.parse(scheduledStart);
  const end = Date.parse(scheduledEnd);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end
  ) {
    throw new AssignmentOperationError(
      "The shift has an invalid start or end time.",
      409
    );
  }

  return {
    start,
    end,
  };
}

/**
 * Determine whether two shift time ranges
 * overlap.
 *
 * A shift ending exactly when another
 * begins is not considered overlapping.
 */

export function doShiftTimesOverlap(
  first: ShiftTimeRange,
  second: ShiftTimeRange
): boolean {
  return (
    first.start < second.end &&
    second.start < first.end
  );
}

/**
 * Prevent overlapping shifts using
 * authoritative shift records.
 *
 * Completed shifts are ignored.
 *
 * Active shifts and unfinished handovers
 * prevent new assignments.
 */

export function assertNoOverlappingShifts(
  targetShift: Shift,
  existingShifts: Shift[]
): void {
  const targetRange = parseShiftTimeRange(
    targetShift.scheduledStart,
    targetShift.scheduledEnd
  );

  for (const existingShift of existingShifts) {
    if (existingShift.id === targetShift.id) {
      continue;
    }

    if (
      existingShift.status ===
      SHIFT_STATUSES.COMPLETED
    ) {
      continue;
    }

    if (
      existingShift.status ===
        SHIFT_STATUSES.ACTIVE ||
      existingShift.status ===
        SHIFT_STATUSES.HANDOVER_PENDING
    ) {
      throw new AssignmentOperationError(
        "This technician has an active shift or an unfinished handover.",
        409
      );
    }

    if (
      existingShift.status !==
      SHIFT_STATUSES.SCHEDULED
    ) {
      throw new AssignmentOperationError(
        "An existing shift has an invalid status.",
        409
      );
    }

    const existingRange = parseShiftTimeRange(
      existingShift.scheduledStart,
      existingShift.scheduledEnd
    );

    if (
      doShiftTimesOverlap(
        targetRange,
        existingRange
      )
    ) {
      throw new AssignmentOperationError(
        "This technician is already assigned to another shift during the selected time period.",
        409
      );
    }
  }
}

/**
 * Prevent scheduling conflicts using
 * the technician's scheduling document.
 *
 * This helper must be called inside the
 * same Firestore transaction that creates
 * or modifies the shift assignment.
 */

export function assertNoScheduleConflict(
  scheduledStart: string,
  scheduledEnd: string,
  existingEntries: TechnicianScheduleEntry[]
): void {
  const targetRange = parseShiftTimeRange(
    scheduledStart,
    scheduledEnd
  );

  for (const entry of existingEntries) {
    if (
      entry.status === "active" ||
      entry.status === "handover_pending"
    ) {
      throw new AssignmentOperationError(
        "This technician has an active shift or an unfinished handover.",
        409
      );
    }

    if (entry.status !== "scheduled") {
      throw new AssignmentOperationError(
        "The technician has an invalid scheduling record.",
        409
      );
    }

    const existingRange = parseShiftTimeRange(
      entry.scheduledStart,
      entry.scheduledEnd
    );

    if (
      doShiftTimesOverlap(
        targetRange,
        existingRange
      )
    ) {
      throw new AssignmentOperationError(
        "This technician is already assigned to another shift during the selected time period.",
        409
      );
    }
  }
}