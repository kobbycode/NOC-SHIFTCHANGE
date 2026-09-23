
import "server-only";

import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  SHIFT_STATUSES,
  SHIFT_TYPES,
  type Shift,
  type ShiftType,
} from "@/types/shift";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

import {
  parseShiftTimeRange,
} from "./shift-overlap";

export interface CreateShiftInput {
  shiftType: ShiftType;
  scheduledStart: string;
  scheduledEnd: string;
  createdBy: string;
}

function isValidUid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".."
  );
}

function isValidIsoDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
      value
    )
  ) {
    return false;
  }

  const timestamp = Date.parse(value);

  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() ===
      new Date(value).toISOString()
  );
}

export async function createShift(
  input: CreateShiftInput
): Promise<Shift> {
  const {
    shiftType,
    scheduledStart,
    scheduledEnd,
    createdBy,
  } = input;

  /*
   * PHASE 1:
   * Validate all input before accessing Firestore.
   */

  if (!isValidUid(createdBy)) {
    throw new AssignmentOperationError(
      "Please sign in with a valid account.",
      400
    );
  }

  if (
    shiftType !== SHIFT_TYPES.MORNING &&
    shiftType !== SHIFT_TYPES.NIGHT
  ) {
    throw new AssignmentOperationError(
      "Please select a valid shift type.",
      400
    );
  }

  if (
    !isValidIsoDate(scheduledStart) ||
    !isValidIsoDate(scheduledEnd)
  ) {
    throw new AssignmentOperationError(
      "Please provide valid shift start and end dates in UTC ISO format.",
      400
    );
  }

  const range = parseShiftTimeRange(
    scheduledStart,
    scheduledEnd
  );

  /*
   * This initial scheduling policy limits
   * a shift to 24 hours.
   *
   * Adjust only after the operational
   * scheduling requirements are finalized.
   */

  const MAX_SHIFT_DURATION =
    24 * 60 * 60 * 1000;

  if (
    range.end - range.start >
    MAX_SHIFT_DURATION
  ) {
    throw new AssignmentOperationError(
      "A shift cannot be longer than 24 hours.",
      400
    );
  }

  /*
   * Do not create shifts whose scheduled
   * start is already in the past.
   */

  if (range.start <= Date.now()) {
    throw new AssignmentOperationError(
      "The shift must start in the future.",
      400
    );
  }

  /*
   * PHASE 2:
   * Prepare Firestore references.
   */

  const db = getAdminFirestore();

  const {
    shifts,
  } = getOperationalCollections();

  const actorRef = db
    .collection("users")
    .doc(createdBy);

  const shiftRef = shifts.doc();

  const auditRef = db
    .collection("audit_logs")
    .doc();

  const now = new Date().toISOString();

  const shift: Shift = {
    id: shiftRef.id,

    shiftType,

    status: SHIFT_STATUSES.SCHEDULED,

    scheduledStart,
    scheduledEnd,

    actualStart: null,
    actualEnd: null,

    primaryTechnicianIds: [],

    createdBy,

    createdAt: now,
    updatedAt: now,
  };

  /*
   * PHASE 3:
   * Verify the actor and create the shift
   * inside the same Firestore transaction.
   */

  await db.runTransaction(
    async (transaction) => {
      const actorSnapshot =
        await transaction.get(actorRef);

      const actor = actorSnapshot.data();

      if (
        !actorSnapshot.exists ||
        !actor ||
        actor.status !== "active" ||
        actor.statusOperation != null ||
        actor.mustChangePassword === true ||
        !["admin", "supervisor"].includes(
          actor.role
        )
      ) {
        throw new AssignmentOperationError(
          "Your account is not authorized to create shifts.",
          403
        );
      }

      /*
       * All transaction reads are complete.
       *
       * Writing the actor document coordinates
       * shift creation with concurrent account
       * status operations.
       */

      transaction.update(actorRef, {
        lastOperationalActivityAt:
          FieldValue.serverTimestamp(),
      });

      transaction.create(
        shiftRef,
        shift
      );

      transaction.create(
        auditRef,
        {
          action: "SHIFT_CREATED",

          actorUid: createdBy,

          targetShiftId: shiftRef.id,

          details:
            "An authorized user created a scheduled shift.",

          shiftType,

          scheduledStart,
          scheduledEnd,

          createdAt:
            FieldValue.serverTimestamp(),
        }
      );
    }
  );

  return shift;
}