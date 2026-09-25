
import "server-only";
import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  SHIFT_MEMBER_ROLES,
  SHIFT_STATUSES,
} from "@/types/shift";

import type {
  TechnicianSchedule,
  TechnicianScheduleEntry,
} from "@/types/technician-schedule";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
  requireEligibleTechnician,
  markAssignmentActivity,
} from "./assignment-transaction";

import {
  assertValidShiftTransition,
  assertShiftReadyToStart,
} from "./shift-transition";

import {
  parseShiftTimeRange,
  assertNoScheduleConflict,
} from "./shift-overlap";

export interface StartShiftInput {
  shiftId: string;
  actorUid: string;
}

export interface StartShiftResult {
  shiftId: string;
  status: "active";
  actualStart: string;
}

export async function startShift(
  input: StartShiftInput
): Promise<StartShiftResult> {
  const { shiftId, actorUid } = input;

  if (
    !shiftId ||
    shiftId.includes("/") ||
    shiftId.length > 512 ||
    !actorUid ||
    actorUid.includes("/") ||
    actorUid.length > 128
  ) {
    throw new AssignmentOperationError(
      "Please provide valid shift details.",
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

  const actorRef = db
    .collection("users")
    .doc(actorUid);

  const auditRef = db
    .collection("audit_logs")
    .doc();

  /*
   * The transaction returns the actual
   * timestamp used for the successful attempt.
   */

  return db.runTransaction(
    async (transaction): Promise<StartShiftResult> => {
      /*
       * PHASE 1:
       * Read the shift and acting user's profile.
       */

      const shiftSnapshot =
        await transaction.get(shiftRef);

      const actorSnapshot =
        await transaction.get(actorRef);

      const shift = shiftSnapshot.data();
      const actor = actorSnapshot.data();

      if (!shiftSnapshot.exists || !shift) {
        throw new AssignmentOperationError(
          "The selected shift was not found.",
          404
        );
      }

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
          "Your account is not authorized to start this shift.",
          403
        );
      }

      /*
       * PHASE 2:
       * Validate the requested transition.
       */

      assertValidShiftTransition(
        shift.status,
        SHIFT_STATUSES.ACTIVE
      );

      assertShiftReadyToStart(
        shift.primaryTechnicianIds
      );

      // Validate the selected shift's scheduled time range.
      parseShiftTimeRange(
        shift.scheduledStart,
        shift.scheduledEnd
      );

      if (
        shift.actualStart != null ||
        shift.actualEnd != null
      ) {
        throw new AssignmentOperationError(
          "The selected shift has inconsistent start or completion information.",
          409
        );
      }

      const primaryIds: string[] =
        shift.primaryTechnicianIds;

      /*
       * PHASE 3:
       * Read the shift's membership records.
       *
       * This query is part of the transaction.
       */

      const membersSnapshot =
        await transaction.get(
          shiftMembers.where(
            "shiftId",
            "==",
            shiftId
          )
        );

      const members =
        membersSnapshot.docs.map(
          (document) => document.data()
        );

      /*
       * Every membership must have a valid
       * technician identifier and role.
       */

      for (const member of members) {
        if (
          typeof member.technicianId !==
            "string" ||
          !member.technicianId ||
          member.technicianId.includes("/") ||
          member.technicianId.length > 128 ||
          ![
            SHIFT_MEMBER_ROLES.PRIMARY,
            SHIFT_MEMBER_ROLES.ADDITIONAL,
          ].includes(member.role)
        ) {
          throw new AssignmentOperationError(
            "The selected shift contains invalid membership information.",
            409
          );
        }
      }

      const currentMembers =
        members.filter(
          (member) =>
            member.leftAt === null
        );

      const memberIds =
        currentMembers.map(
          (member) =>
            member.technicianId as string
        );

      if (
        new Set(memberIds).size !==
        memberIds.length
      ) {
        throw new AssignmentOperationError(
          "The shift contains duplicate technician memberships.",
          409
        );
      }

      const currentPrimaryIds =
        currentMembers
          .filter(
            (member) =>
              member.role ===
              SHIFT_MEMBER_ROLES.PRIMARY
          )
          .map(
            (member) =>
              member.technicianId as string
          );

      if (
        currentPrimaryIds.length !== 2 ||
        !primaryIds.every(
          (uid) =>
            currentPrimaryIds.includes(uid)
        )
      ) {
        throw new AssignmentOperationError(
          "The shift's primary technician memberships are inconsistent.",
          409
        );
      }

      if (currentMembers.length < 2) {
        throw new AssignmentOperationError(
          "The shift does not have the required technician memberships.",
          409
        );
      }

      /*
       * PHASE 4:
       * Read every current member's
       * scheduling document.
       *
       * All reads must finish before writes.
       */

      const scheduleRecords = [];

      for (const member of currentMembers) {
        const technicianUid =
          member.technicianId as string;

        const scheduleRef =
          technicianSchedules.doc(
            technicianUid
          );

        const scheduleSnapshot =
          await transaction.get(
            scheduleRef
          );

        await requireEligibleTechnician(
          transaction,
          technicianUid
        );

        const scheduleData =
          scheduleSnapshot.data();

        if (
          !scheduleSnapshot.exists ||
          !scheduleData ||
          scheduleData.technicianUid !==
            technicianUid ||
          !Array.isArray(
            scheduleData.entries
          )
        ) {
          throw new AssignmentOperationError(
            "A technician has an invalid scheduling record.",
            409
          );
        }

        const schedule =
          scheduleData as TechnicianSchedule;

        const matchingEntries =
          schedule.entries.filter(
            (entry) =>
              entry.shiftId === shiftId
          );

        if (
          matchingEntries.length !== 1 ||
          matchingEntries[0].status !==
            SHIFT_STATUSES.SCHEDULED
        ) {
          throw new AssignmentOperationError(
            "A technician's shift scheduling information is inconsistent.",
            409
          );
        }

        if (
          matchingEntries[0].scheduledStart !==
            shift.scheduledStart ||
          matchingEntries[0].scheduledEnd !==
            shift.scheduledEnd
        ) {
          throw new AssignmentOperationError(
            "A technician's scheduled shift times do not match the selected shift.",
            409
          );
        }

        // Check all other schedule entries for overlapping shifts,
        // active shifts, or unfinished handovers. The selected shift
        // itself has already been validated above.
        const otherScheduleEntries =
          schedule.entries.filter(
            (entry) => entry.shiftId !== shiftId
          );

        assertNoScheduleConflict(
          shift.scheduledStart,
          shift.scheduledEnd,
          otherScheduleEntries
        );

        const updatedEntries:
          TechnicianScheduleEntry[] =
            schedule.entries.map(
              (entry) =>
                entry.shiftId === shiftId
                  ? {
                      ...entry,
                      status:
                        SHIFT_STATUSES.ACTIVE,
                    }
                  : entry
            );

        scheduleRecords.push({
          technicianUid,
          scheduleRef,
          updatedEntries,
        });
      }

      /*
       * PHASE 5:
       * All transaction reads are complete.
       *
       * Begin transaction writes.
       */

      const now =
        new Date().toISOString();

      transaction.update(
        shiftRef,
        {
          status:
            SHIFT_STATUSES.ACTIVE,

          actualStart: now,

          updatedAt: now,

          startedBy: actorUid,

          startedAt:
            FieldValue.serverTimestamp(),
        }
      );

      for (const record of scheduleRecords) {
        transaction.update(
          record.scheduleRef,
          {
            entries:
              record.updatedEntries,

            updatedAt: now,
          }
        );

        markAssignmentActivity(
          transaction,
          record.technicianUid
        );
      }

      transaction.create(
        auditRef,
        {
          id: auditRef.id,

          action: "SHIFT_STARTED",

          actorUid,

          shiftId,

          previousStatus:
            SHIFT_STATUSES.SCHEDULED,

          newStatus:
            SHIFT_STATUSES.ACTIVE,

          createdAt:
            FieldValue.serverTimestamp(),

          details:
            "The scheduled shift was started.",
        }
      );

      return {
        shiftId,

        status:
          SHIFT_STATUSES.ACTIVE,

        actualStart: now,
      };
    }
  );
}