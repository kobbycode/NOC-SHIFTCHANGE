
import "server-only";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

import {
  parseShiftTimeRange,
} from "./shift-overlap";

/**
 * ShiftChange 2.0
 *
 * Controlled shift activation window.
 *
 * A shift may start:
 * - 15 minutes before its scheduled start.
 * - Up to 60 minutes after its scheduled start.
 *
 * This helper performs validation only.
 * It does not modify Firestore.
 */

export const SHIFT_ACTIVATION_WINDOW = {
  EARLY_MINUTES: 15,
  LATE_MINUTES: 60,
} as const;

export function assertShiftActivationWindow(
  scheduledStart: string,
  scheduledEnd: string,
  activationTime: Date = new Date()
): void {
  const range = parseShiftTimeRange(
    scheduledStart,
    scheduledEnd
  );

  const now = activationTime.getTime();

  if (!Number.isFinite(now)) {
    throw new AssignmentOperationError(
      "The shift activation time is invalid.",
      409
    );
  }

  const earliestStart =
    range.start -
    SHIFT_ACTIVATION_WINDOW.EARLY_MINUTES *
      60_000;

  const latestStart =
    Math.min(
      range.start +
        SHIFT_ACTIVATION_WINDOW.LATE_MINUTES *
          60_000,
      range.end
    );

  if (now < earliestStart) {
    throw new AssignmentOperationError(
      "This shift cannot be started yet. Please wait until its permitted activation window.",
      409
    );
  }

  if (now > latestStart) {
    throw new AssignmentOperationError(
      "The permitted activation window has expired. Administrator review is required.",
      409
    );
  }
}

/**
 * Require the normal shift activation window
 * to have fully expired before recovery.
 *
 * This helper validates only. It performs no
 * Firestore writes.
 */
export function assertShiftActivationWindowExpired(
  scheduledStart: string,
  scheduledEnd: string,
  recoveryTime: Date = new Date()
): void {
  const range = parseShiftTimeRange(
    scheduledStart,
    scheduledEnd
  );

  const now = recoveryTime.getTime();

  if (!Number.isFinite(now)) {
    throw new AssignmentOperationError(
      "The shift recovery time is invalid.",
      409
    );
  }

  const latestStart =
    Math.min(
      range.start +
        SHIFT_ACTIVATION_WINDOW.LATE_MINUTES *
          60_000,
      range.end
    );

  if (now <= latestStart) {
    throw new AssignmentOperationError(
      "The shift activation window has not expired. Recovery is not permitted.",
      409
    );
  }
}
