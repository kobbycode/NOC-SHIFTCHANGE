
import "server-only";

import {
  FieldValue,
  type DocumentReference,
} from "firebase-admin/firestore";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  SHIFT_MEMBER_ROLES,
  SHIFT_STATUSES,
  type ShiftMember,
} from "@/types/shift";

import {
  TASK_STATUSES,
} from "@/types/task";

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

export interface CompleteShiftInput {
  shiftId: string;
  actorUid: string;
}

export interface CompleteShiftResult {
  shiftId: string;
  status: "completed";
  actualEnd: string;
}

interface ScheduleRelease {
  technicianUid: string;
  scheduleRef: DocumentReference;
  entries: TechnicianScheduleEntry[];
}

export async function completeShift(
  input: CompleteShiftInput
): Promise<CompleteShiftResult> {
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
    tasks,
    taskAssignments,
  } = getOperationalCollections();

  const shiftRef = shifts.doc(shiftId);

  const actorRef = db
    .collection("users")
    .doc(actorUid);

  const auditRef = db
    .collection("audit_logs")
    .doc();

  return db.runTransaction(
    async (
      transaction
    ): Promise<CompleteShiftResult> => {
      /*
       * PHASE 1:
       * Read the authoritative shift
       * and acting user.
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
          "Your account is not authorized to complete this shift.",
          403
        );
      }

      /*
       * PHASE 2:
       * Validate the shift lifecycle.
       */

      assertValidShiftTransition(
        shift.status,
        SHIFT_STATUSES.COMPLETED
      );

      assertShiftReadyToStart(
        shift.primaryTechnicianIds
      );

      if (
        typeof shift.scheduledStart !==
          "string" ||
        typeof shift.scheduledEnd !==
          "string"
      ) {
        throw new AssignmentOperationError(
          "The shift has invalid scheduling information.",
          409
        );
      }

      parseShiftTimeRange(
        shift.scheduledStart,
        shift.scheduledEnd
      );

      if (
        typeof shift.actualStart !==
          "string" ||
        !Number.isFinite(
          Date.parse(shift.actualStart)
        ) ||
        shift.actualEnd != null ||
        typeof shift.handoverStartedAt !==
          "string" ||
        !Number.isFinite(
          Date.parse(shift.handoverStartedAt)
        )
      ) {
        throw new AssignmentOperationError(
          "The shift has inconsistent activation or handover information.",
          409
        );
      }

      const primaryIds: string[] =
        shift.primaryTechnicianIds;

      /*
       * PHASE 3:
       * Read authoritative membership
       * and task records.
       *
       * All transaction reads must
       * occur before any writes.
       */

      const membersSnapshot =
        await transaction.get(
          shiftMembers.where(
            "shiftId",
            "==",
            shiftId
          )
        );

      const tasksSnapshot =
        await transaction.get(
          tasks.where(
            "shiftId",
            "==",
            shiftId
          )
        );

      const currentMembers: ShiftMember[] =
        [];

      for (
        const document of
        membersSnapshot.docs
      ) {
        const member = document.data();

        if (
          member.shiftId !== shiftId ||
          typeof member.technicianId !==
            "string" ||
          !member.technicianId ||
          member.technicianId.includes("/") ||
          member.technicianId.length > 128 ||
          ![
            SHIFT_MEMBER_ROLES.PRIMARY,
            SHIFT_MEMBER_ROLES.ADDITIONAL,
          ].includes(member.role) ||
          (
            member.leftAt !== null &&
            (
              typeof member.leftAt !==
                "string" ||
              !Number.isFinite(
                Date.parse(member.leftAt)
              )
            )
          )
        ) {
          throw new AssignmentOperationError(
            "The shift contains invalid membership information.",
            409
          );
        }

        if (member.leftAt === null) {
          currentMembers.push({
            ...member,
            id: document.id,
          } as ShiftMember);
        }
      }

      const memberIds =
        currentMembers.map(
          (member) => member.technicianId
        );

      if (
        memberIds.length < 2 ||
        new Set(memberIds).size !==
          memberIds.length
      ) {
        throw new AssignmentOperationError(
          "The shift has missing or duplicate technician memberships.",
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
              member.technicianId
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

      /*
       * PHASE 4:
       * Validate shift tasks.
       *
       * A shift cannot be completed
       * while its associated tasks
       * remain unfinished.
       */

      const completedTaskIds: string[] = [];

      for (
        const document of
        tasksSnapshot.docs
      ) {
        const task = document.data();

        if (
          task.shiftId !== shiftId ||
          !Object.values(
            TASK_STATUSES
          ).includes(task.status)
        ) {
          throw new AssignmentOperationError(
            "The shift contains invalid task information.",
            409
          );
        }

        if (
          task.status !==
            TASK_STATUSES.COMPLETED &&
          task.status !==
            TASK_STATUSES.CANCELLED
        ) {
          throw new AssignmentOperationError(
            "The shift has unfinished tasks. Complete or resolve these tasks before completing the handover.",
            409
          );
        }

        completedTaskIds.push(
          document.id
        );
      }

      /*
       * PHASE 5:
       * Read task assignments associated
       * with the shift's tasks.
       *
       * Do not release technicians
       * if assignment records are
       * inconsistent.
       */

      for (
        const taskId of
        completedTaskIds
      ) {
        const assignmentsSnapshot =
          await transaction.get(
            taskAssignments.where(
              "taskId",
              "==",
              taskId
            )
          );

        for (
          const document of
          assignmentsSnapshot.docs
        ) {
          const assignment =
            document.data();

          if (
            assignment.taskId !== taskId ||
            typeof assignment.technicianId !==
              "string" ||
            !assignment.technicianId ||
            assignment.technicianId.includes("/")
          ) {
            throw new AssignmentOperationError(
              "The shift contains invalid task assignment information.",
              409
            );
          }
        }
      }

      /*
       * PHASE 6:
       * Validate every current
       * technician's scheduling record.
       */

      const scheduleReleases:
        ScheduleRelease[] = [];

      for (
        const member of
        currentMembers
      ) {
        const technicianUid =
          member.technicianId;

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

        const entries = schedule.entries;

        if (
          entries.some(
            (entry) =>
              !entry ||
              typeof entry.shiftId !==
                "string" ||
              !entry.shiftId ||
              typeof entry.scheduledStart !==
                "string" ||
              typeof entry.scheduledEnd !==
                "string"
          )
        ) {
          throw new AssignmentOperationError(
            "A technician has invalid scheduling information.",
            409
          );
        }

        const entryIds =
          entries.map(
            (entry) => entry.shiftId
          );

        if (
          new Set(entryIds).size !==
          entryIds.length
        ) {
          throw new AssignmentOperationError(
            "A technician has duplicate scheduling entries.",
            409
          );
        }

        const matchingEntries =
          entries.filter(
            (entry) =>
              entry.shiftId === shiftId
          );

        if (
          matchingEntries.length !== 1 ||
          matchingEntries[0].status !==
            SHIFT_STATUSES.HANDOVER_PENDING
        ) {
          throw new AssignmentOperationError(
            "A technician's handover scheduling information is inconsistent.",
            409
          );
        }

        const matchingEntry =
          matchingEntries[0];

        if (
          matchingEntry.scheduledStart !==
            shift.scheduledStart ||
          matchingEntry.scheduledEnd !==
            shift.scheduledEnd
        ) {
          throw new AssignmentOperationError(
            "A technician's scheduled shift times do not match the selected shift.",
            409
          );
        }

        const otherEntries =
          entries.filter(
            (entry) =>
              entry.shiftId !== shiftId
          );

        assertNoScheduleConflict(
          shift.scheduledStart,
          shift.scheduledEnd,
          otherEntries
        );

        /*
         * Release only the completed
         * shift's scheduling entry.
         *
         * Preserve other valid entries.
         */

        scheduleReleases.push({
          technicianUid,
          scheduleRef,
          entries: otherEntries,
        });
      }

      /*
       * PHASE 7:
       * All transaction reads are complete.
       *
       * Commit the shift completion,
       * scheduling release, and audit
       * event atomically.
       */

      const now =
        new Date().toISOString();

      transaction.update(
        shiftRef,
        {
          status:
            SHIFT_STATUSES.COMPLETED,

          actualEnd: now,

          completedAt:
            FieldValue.serverTimestamp(),

          completedBy: actorUid,

          updatedAt: now,
        }
      );

      for (
        const record of
        scheduleReleases
      ) {
        transaction.update(
          record.scheduleRef,
          {
            entries: record.entries,
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

          action: "SHIFT_COMPLETED",

          actorUid,

          shiftId,

          previousStatus:
            SHIFT_STATUSES.HANDOVER_PENDING,

          newStatus:
            SHIFT_STATUSES.COMPLETED,

          createdAt:
            FieldValue.serverTimestamp(),

          details:
            "The shift handover was completed and technician scheduling entries were released.",
        }
      );

      return {
        shiftId,

        status:
          SHIFT_STATUSES.COMPLETED,

        actualEnd: now,
      };
    }
  );
}