
import "server-only";

import {
  SHIFT_STATUSES,
  type ShiftStatus,
} from "@/types/shift";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

/**
 * ShiftChange 2.0
 *
 * Defines the permitted shift lifecycle.
 *
 * This module validates status transitions.
 * It does not perform Firestore writes.
 */

export const SHIFT_TRANSITIONS: Readonly<
  Record<ShiftStatus, ShiftStatus | null>
> = {
  [SHIFT_STATUSES.SCHEDULED]:
    SHIFT_STATUSES.ACTIVE,

  [SHIFT_STATUSES.ACTIVE]:
    SHIFT_STATUSES.HANDOVER_PENDING,

  [SHIFT_STATUSES.HANDOVER_PENDING]:
    SHIFT_STATUSES.COMPLETED,

  [SHIFT_STATUSES.COMPLETED]:
    null,

  [SHIFT_STATUSES.CANCELLED]:
    null,
};

export function isShiftStatus(
  value: unknown
): value is ShiftStatus {
  return (
    value === SHIFT_STATUSES.SCHEDULED ||
    value === SHIFT_STATUSES.ACTIVE ||
    value === SHIFT_STATUSES.HANDOVER_PENDING ||
    value === SHIFT_STATUSES.COMPLETED ||
    value === SHIFT_STATUSES.CANCELLED
  );
}

/**
 * Validates that the requested transition
 * follows the permitted shift lifecycle.
 */

export function assertValidShiftTransition(
  currentStatus: unknown,
  nextStatus: unknown
): asserts nextStatus is ShiftStatus {
  if (
    !isShiftStatus(currentStatus) ||
    !isShiftStatus(nextStatus)
  ) {
    throw new AssignmentOperationError(
      "The selected shift has an invalid status.",
      400
    );
  }

  if (currentStatus === nextStatus) {
    throw new AssignmentOperationError(
      "The shift is already in the requested status.",
      409
    );
  }

  const permittedNextStatus =
    SHIFT_TRANSITIONS[currentStatus];

  if (permittedNextStatus !== nextStatus) {
    throw new AssignmentOperationError(
      "The requested shift status change is not permitted.",
      409
    );
  }
}

/**
 * Ensures a shift has exactly two distinct
 * primary technicians before activation.
 */

export function assertShiftReadyToStart(
  primaryTechnicianIds: unknown
): asserts primaryTechnicianIds is string[] {
  if (
    !Array.isArray(
      primaryTechnicianIds
    ) ||
    primaryTechnicianIds.length !== 2 ||
    !primaryTechnicianIds.every(
      (uid) =>
        typeof uid === "string" &&
        uid.trim().length > 0 &&
        uid.length <= 128 &&
        !uid.includes("/")
    )
  ) {
    throw new AssignmentOperationError(
      "A shift must have exactly two valid primary technicians before it can start.",
      409
    );
  }

  if (
    new Set(
      primaryTechnicianIds
    ).size !== 2
  ) {
    throw new AssignmentOperationError(
      "A shift cannot have duplicate primary technicians.",
      409
    );
  }
}