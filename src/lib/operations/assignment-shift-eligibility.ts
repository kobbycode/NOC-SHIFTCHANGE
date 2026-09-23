
import "server-only";

import type {
  Transaction,
} from "firebase-admin/firestore";

import {
  SHIFT_STATUSES,
} from "@/types/shift";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

export async function requireEligibleAssignmentShift(
  transaction: Transaction,
  shiftId: string | null,
  technicianUid: string
): Promise<void> {
  /*
   * Standalone tasks do not require
   * shift membership.
   */

  if (shiftId === null) {
    return;
  }

  if (
    typeof shiftId !== "string" ||
    !shiftId.trim() ||
    shiftId.length > 512 ||
    shiftId.includes("/")
  ) {
    throw new AssignmentOperationError(
      "The task has invalid shift information.",
      409
    );
  }

  const {
    shifts,
    shiftMembers,
    technicianSchedules,
  } = getOperationalCollections();

  const shiftRef =
    shifts.doc(shiftId);

  const scheduleRef =
    technicianSchedules.doc(
      technicianUid
    );

  /*
   * All reads occur before writes.
   */

  const shiftSnapshot =
    await transaction.get(shiftRef);

  const membershipSnapshot =
    await transaction.get(
      shiftMembers
        .where("shiftId", "==", shiftId)
        .where(
          "technicianId",
          "==",
          technicianUid
        )
    );

  const scheduleSnapshot =
    await transaction.get(scheduleRef);

  if (!shiftSnapshot.exists) {
    throw new AssignmentOperationError(
      "The task references a missing shift.",
      409
    );
  }

  const shift =
    shiftSnapshot.data();

  if (
    !shift ||
    ![
      SHIFT_STATUSES.SCHEDULED,
      SHIFT_STATUSES.ACTIVE,
    ].includes(shift.status)
  ) {
    throw new AssignmentOperationError(
      "Tasks cannot be assigned during handover or after shift completion.",
      409
    );
  }

  if (
    typeof shift.scheduledStart !==
      "string" ||
    typeof shift.scheduledEnd !==
      "string"
  ) {
    throw new AssignmentOperationError(
      "The selected shift has invalid scheduling information.",
      409
    );
  }

  /*
   * Require exactly one current
   * membership.
   */

  const currentMemberships =
    membershipSnapshot.docs.filter(
      (document) =>
        document.data().leftAt === null
    );

  if (
    currentMemberships.length !== 1
  ) {
    throw new AssignmentOperationError(
      "The technician must have exactly one current membership in the selected shift.",
      409
    );
  }

  const membership =
    currentMemberships[0].data();

  if (
    !["primary", "additional"].includes(
      membership.role
    )
  ) {
    throw new AssignmentOperationError(
      "The technician has an invalid shift membership.",
      409
    );
  }

  /*
   * Validate authoritative scheduling.
   */

  const schedule =
    scheduleSnapshot.data();

  if (
    !scheduleSnapshot.exists ||
    !schedule ||
    schedule.technicianUid !==
      technicianUid ||
    !Array.isArray(schedule.entries)
  ) {
    throw new AssignmentOperationError(
      "The technician has an invalid scheduling record.",
      409
    );
  }

  const matchingEntries =
    schedule.entries.filter(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        "shiftId" in entry &&
        entry.shiftId === shiftId
    );

  if (
    matchingEntries.length !== 1
  ) {
    throw new AssignmentOperationError(
      "The technician's shift scheduling information is inconsistent.",
      409
    );
  }

  const matchingEntry =
    matchingEntries[0];

  if (
    matchingEntry.status !==
      shift.status ||
    matchingEntry.scheduledStart !==
      shift.scheduledStart ||
    matchingEntry.scheduledEnd !==
      shift.scheduledEnd
  ) {
    throw new AssignmentOperationError(
      "The technician's scheduling information does not match the authoritative shift.",
      409
    );
  }

  /*
   * Verify the authoritative primary
   * technician membership.
   */

  if (
    !Array.isArray(
      shift.primaryTechnicianIds
    ) ||
    shift.primaryTechnicianIds.length !==
      2 ||
    new Set(
      shift.primaryTechnicianIds
    ).size !== 2
  ) {
    throw new AssignmentOperationError(
      "The selected shift has invalid primary technician information.",
      409
    );
  }

  if (
    membership.role === "primary" &&
    !shift.primaryTechnicianIds.includes(
      technicianUid
    )
  ) {
    throw new AssignmentOperationError(
      "The technician's primary shift membership is inconsistent.",
      409
    );
  }

  if (
    membership.role === "additional" &&
    shift.primaryTechnicianIds.includes(
      technicianUid
    )
  ) {
    throw new AssignmentOperationError(
      "The technician's shift membership role is inconsistent.",
      409
    );
  }
}