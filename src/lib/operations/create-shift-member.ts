
import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  SHIFT_MEMBER_ROLES,
  SHIFT_STATUSES,
  type ShiftMember,
  type ShiftMemberRole,
} from "@/types/shift";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
  requireEligibleTechnician,
  markAssignmentActivity,
} from "./assignment-transaction";

import {
  parseShiftTimeRange,
} from "./shift-overlap";

import {
  prepareTechnicianSchedule,
} from "./prepare-technician-schedule";

export interface CreateShiftMemberInput {
  shiftId: string;
  technicianUid: string;
  role: ShiftMemberRole;
  assignedBy: string;
}

export async function createShiftMember(
  input: CreateShiftMemberInput
): Promise<ShiftMember> {
  const {
    shiftId,
    technicianUid,
    role,
    assignedBy,
  } = input;

  /*
   * Validate identifiers.
   */

  if (
    !shiftId ||
    shiftId.includes("/") ||
    shiftId.length > 512 ||
    !technicianUid ||
    technicianUid.includes("/") ||
    technicianUid.length > 128 ||
    !assignedBy ||
    assignedBy.includes("/") ||
    assignedBy.length > 128
  ) {
    throw new AssignmentOperationError(
      "Please provide valid shift membership details.",
      400
    );
  }

  if (
    role !== SHIFT_MEMBER_ROLES.PRIMARY &&
    role !== SHIFT_MEMBER_ROLES.ADDITIONAL
  ) {
    throw new AssignmentOperationError(
      "Please select a valid shift membership role.",
      400
    );
  }

  const db = getAdminFirestore();

  const {
    shifts,
    shiftMembers,
    technicianSchedules,
  } = getOperationalCollections();

  const shiftRef = shifts.doc(shiftId);

  const memberRef = shiftMembers.doc(
    `${shiftId}_${technicianUid}`
  );

  const scheduleRef =
    technicianSchedules.doc(technicianUid);

  const actorRef = db
    .collection("users")
    .doc(assignedBy);

  const now = new Date().toISOString();

  const member: ShiftMember = {
    id: memberRef.id,
    shiftId,
    technicianId: technicianUid,
    role,
    joinedAt: now,
    leftAt: null,
  };

  await db.runTransaction(
    async (transaction) => {
      /*
       * PHASE 1:
       * Read all required documents.
       *
       * Firestore transaction reads must
       * precede transaction writes.
       */

      const shiftSnapshot =
        await transaction.get(shiftRef);

      const actorSnapshot =
        await transaction.get(actorRef);

      const memberSnapshot =
        await transaction.get(memberRef);

      const scheduleSnapshot =
        await transaction.get(scheduleRef);

      await requireEligibleTechnician(
        transaction,
        technicianUid
      );

      /*
       * PHASE 2:
       * Validate the selected shift.
       */

      const shift = shiftSnapshot.data();

      if (!shiftSnapshot.exists || !shift) {
        throw new AssignmentOperationError(
          "The selected shift was not found.",
          404
        );
      }

      if (
        shift.status !== SHIFT_STATUSES.SCHEDULED
      ) {
        throw new AssignmentOperationError(
          "New shift memberships can only be created before a shift starts.",
          409
        );
      }

      if (
        typeof shift.scheduledStart !== "string" ||
        typeof shift.scheduledEnd !== "string"
      ) {
        throw new AssignmentOperationError(
          "The selected shift has invalid scheduling information.",
          409
        );
      }

      parseShiftTimeRange(
        shift.scheduledStart,
        shift.scheduledEnd
      );

      /*
       * PHASE 3:
       * Validate the administrator or supervisor.
       */

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
          "Your account is not authorized to manage shift membership.",
          403
        );
      }

      /*
       * PHASE 4:
       * Prevent duplicate memberships.
       */

      if (memberSnapshot.exists) {
        throw new AssignmentOperationError(
          "This technician already has a membership record for the selected shift.",
          409
        );
      }

      /*
       * PHASE 5:
       * Validate the existing primary technician list.
       */

      const primaryTechnicianIds: unknown =
        shift.primaryTechnicianIds;

      if (
        !Array.isArray(primaryTechnicianIds) ||
        !primaryTechnicianIds.every(
          (uid) =>
            typeof uid === "string" &&
            uid.length > 0
        )
      ) {
        throw new AssignmentOperationError(
          "The shift has invalid primary technician data.",
          409
        );
      }

      const existingPrimaryIds: string[] =
        primaryTechnicianIds;

      if (
        new Set(existingPrimaryIds).size !==
        existingPrimaryIds.length
      ) {
        throw new AssignmentOperationError(
          "The shift contains duplicate primary technicians.",
          409
        );
      }

      if (existingPrimaryIds.length > 2) {
        throw new AssignmentOperationError(
          "The shift contains more than two primary technicians.",
          409
        );
      }

      /*
       * PHASE 6:
       * Validate the technician scheduling document.
       */

      /*
       * PHASE 7:
       * Prepare the primary technician list.
       */

      let updatedPrimaryIds = [
        ...existingPrimaryIds,
      ];

      if (
        role === SHIFT_MEMBER_ROLES.PRIMARY
      ) {
        if (
          existingPrimaryIds.includes(
            technicianUid
          )
        ) {
          throw new AssignmentOperationError(
            "This technician is already a primary member of the selected shift.",
            409
          );
        }

        if (
          existingPrimaryIds.length >= 2
        ) {
          throw new AssignmentOperationError(
            "This shift already has two primary technicians.",
            409
          );
        }

        updatedPrimaryIds = [
          ...existingPrimaryIds,
          technicianUid,
        ];
      } else if (
        existingPrimaryIds.includes(
          technicianUid
        )
      ) {
        throw new AssignmentOperationError(
          "This technician is already listed as a primary member of the selected shift.",
          409
        );
      }

      /*
       * PHASE 8:
       * Prepare the updated scheduling document.
       */

      const updatedSchedule =
        prepareTechnicianSchedule({
          shiftId,
          technicianUid,
          scheduledStart:
            shift.scheduledStart,
          scheduledEnd:
            shift.scheduledEnd,
          updatedAt: now,
          scheduleExists:
            scheduleSnapshot.exists,
          scheduleData:
            scheduleSnapshot.data(),
        });

      /*
       * PHASE 9:
       * All transaction reads are complete.
       *
       * Commit the membership, shift,
       * and scheduling changes atomically.
       */

      transaction.create(
        memberRef,
        member
      );

      markAssignmentActivity(
        transaction,
        technicianUid
      );

      transaction.update(
        shiftRef,
        {
          primaryTechnicianIds:
            updatedPrimaryIds,

          updatedAt: now,
        }
      );

      transaction.set(
        scheduleRef,
        updatedSchedule
      );
    }
  );

  return member;
}