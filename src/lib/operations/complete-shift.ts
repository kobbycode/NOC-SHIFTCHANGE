
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

import {
  randomUUID,
} from "node:crypto";

import {
  GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
} from "./collections";

import {
  advanceOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
} from "./operational-shift-control-state";

import {
  ensureOperationalShiftControl,
  readOperationalShiftControl,
} from "./operational-shift-control";

import type {
  NextShiftAuthorization,
} from "@/types/next-shift-authorization";

import {
  completeConsumedNextShiftAuthorization,
  createNextShiftAuthorizationDocumentId,
} from "./next-shift-authorization-domain";

import {
  finalizeCurrentShiftMemberships,
  validateShiftCompletionAttendance,
} from "./shift-completion-domain";

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

  await ensureOperationalShiftControl(actorUid);

  const {
    shifts,
    shiftMembers,
    shiftAttendance,
    technicianSchedules,
    tasks,
    taskAssignments,
    operationalShiftControl,
    nextShiftAuthorizations,
  } = getOperationalCollections();

  const shiftRef = shifts.doc(shiftId);

  const operationalShiftControlRef =
    operationalShiftControl.doc(
      GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID
    );

  const actorRef = db
    .collection("users")
    .doc(actorUid);

  const auditRef = db
    .collection("audit_logs")
    .doc();

  const nextSlotToken = randomUUID();

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

      const controlSnapshot =
        await transaction.get(
          operationalShiftControlRef
        );

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

      if (!controlSnapshot.exists) {
        throw new AssignmentOperationError(
          "The global operational shift control is unavailable.",
          409
        );
      }

      const control =
        readOperationalShiftControl(
          controlSnapshot.data()
        );

      try {
        assertShiftOwnsOperationalSlot(
          control,
          shiftId,
          shift.operationalSlotToken,
          shift.status
        );
      } catch {
        throw new AssignmentOperationError(
          "The shift is not the current occupant of the global operational slot.",
          409
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
          typeof member.id !== "string" ||
          member.id !== document.id ||
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
          currentMembers.push(
            member as ShiftMember
          );
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
       * PHASE 5A:
       * Read authoritative participation
       * and temporary-authorization state.
       *
       * Attendance is read-only during
       * shift completion.
       *
       * Authorization discovery uses:
       * - its deterministic expected ID,
       * - the current operational slot,
       * - the current shift binding.
       *
       * Any conflicting or malformed state
       * fails closed before completion writes.
       */

      let expectedAuthorizationId: string;

      try {
        expectedAuthorizationId =
          createNextShiftAuthorizationDocumentId(
            shift.permanentPairId,
            control.generation,
            control.slotToken
          );
      } catch (error) {
        throw new AssignmentOperationError(
          error instanceof Error
            ? error.message
            : "The shift temporary-authorization identity is invalid.",
          409
        );
      }

      const expectedAuthorizationRef =
        nextShiftAuthorizations.doc(
          expectedAuthorizationId
        );

      const [
        attendanceSnapshot,
        expectedAuthorizationSnapshot,
        slotAuthorizationSnapshot,
        shiftAuthorizationSnapshot,
      ] = await Promise.all([
        transaction.get(
          shiftAttendance.where(
            "shiftId",
            "==",
            shiftId
          )
        ),

        transaction.get(
          expectedAuthorizationRef
        ),

        transaction.get(
          nextShiftAuthorizations
            .where(
              "slotToken",
              "==",
              control.slotToken
            )
            .where(
              "slotGeneration",
              "==",
              control.generation
            )
        ),

        transaction.get(
          nextShiftAuthorizations.where(
            "shiftId",
            "==",
            shiftId
          )
        ),
      ]);

      const attendanceRecords =
        attendanceSnapshot.docs.map(
          (document) => {
            const attendance =
              document.data();

            if (
              attendance.id !== document.id
            ) {
              throw new AssignmentOperationError(
                "The shift contains an attendance record with inconsistent identity.",
                409
              );
            }

            return attendance;
          }
        );

      const authorizationCandidates =
        new Map<string, unknown>();

      if (
        expectedAuthorizationSnapshot.exists
      ) {
        authorizationCandidates.set(
          expectedAuthorizationSnapshot.id,
          expectedAuthorizationSnapshot.data()
        );
      }

      for (
        const document of
        slotAuthorizationSnapshot.docs
      ) {
        authorizationCandidates.set(
          document.id,
          document.data()
        );
      }

      for (
        const document of
        shiftAuthorizationSnapshot.docs
      ) {
        authorizationCandidates.set(
          document.id,
          document.data()
        );
      }

      if (
        authorizationCandidates.size > 1
      ) {
        throw new AssignmentOperationError(
          "More than one temporary authorization conflicts with this shift or operational slot.",
          409
        );
      }

      let temporaryAuthorization:
        NextShiftAuthorization | null = null;

      for (
        const [
          authorizationDocumentId,
          authorizationData,
        ] of authorizationCandidates
      ) {
        if (
          authorizationDocumentId !==
            expectedAuthorizationId ||
          !authorizationData ||
          typeof authorizationData !==
            "object" ||
          Array.isArray(
            authorizationData
          ) ||
          (
            authorizationData as {
              id?: unknown;
            }
          ).id !==
            authorizationDocumentId
        ) {
          throw new AssignmentOperationError(
            "The shift temporary authorization has inconsistent identity.",
            409
          );
        }

        temporaryAuthorization =
          authorizationData as
            NextShiftAuthorization;
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

      /*
       * Validate authoritative participation
       * only after every transaction read
       * has completed.
       *
       * Missing A/B attendance is valid.
       * Authorization without C joining is
       * also valid.
       */

      let validatedAuthorization:
        NextShiftAuthorization | null;

      try {
        validatedAuthorization =
          validateShiftCompletionAttendance({
            shiftId,
            primaryTechnicianIds:
              primaryIds,
            completedAt: now,
            members: currentMembers,
            attendances:
              attendanceRecords,
            authorization:
              temporaryAuthorization,
          }).authorization;
      } catch (error) {
        throw new AssignmentOperationError(
          error instanceof Error
            ? error.message
            : "The shift participation state is invalid.",
          409
        );
      }

      let finalizedMembers:
        ShiftMember[];

      try {
        finalizedMembers =
          finalizeCurrentShiftMemberships({
            shiftId,
            completedAt: now,
            members: currentMembers,
          });
      } catch (error) {
        throw new AssignmentOperationError(
          error instanceof Error
            ? error.message
            : "The shift membership state cannot be finalized.",
          409
        );
      }

      let completedAuthorization:
        NextShiftAuthorization | null = null;

      if (validatedAuthorization) {
        try {
          completedAuthorization =
            completeConsumedNextShiftAuthorization({
              authorization:
                validatedAuthorization,
              shiftId,
              slotToken:
                control.slotToken,
              slotGeneration:
                control.generation,
              permanentPairId:
                shift.permanentPairId,
              completedAt: now,
            });
        } catch (error) {
          throw new AssignmentOperationError(
            error instanceof Error
              ? error.message
              : "The temporary authorization cannot be finalized.",
            409
          );
        }
      }

      let nextControl;

      try {
        nextControl =
          advanceOperationalShiftControl(
            control,
            shiftId,
            nextSlotToken,
            now
          );
      } catch {
        throw new AssignmentOperationError(
          "The global operational slot cannot be advanced for this shift.",
          409
        );
      }

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

      transaction.update(
        operationalShiftControlRef,
        nextControl
      );
      /*
       * End current roster assignments.
       * leftAt is NOT attendance/clock-out.
       */

      for (
        const member of
        finalizedMembers
      ) {
        transaction.update(
          shiftMembers.doc(member.id),
          {
            leftAt: member.leftAt,
          }
        );
      }

      /*
       * Successful intended-shift completion
       * terminally completes its consumed
       * temporary authorization.
       */

      if (completedAuthorization) {
        transaction.update(
          nextShiftAuthorizations.doc(
            completedAuthorization.id
          ),
          {
            status:
              completedAuthorization.status,
            completedAt:
              completedAuthorization.completedAt,
            expiredAt:
              completedAuthorization.expiredAt,
            updatedAt:
              completedAuthorization.updatedAt,
          }
        );
      }
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

          previousOperationalSlotToken:
            control.slotToken,

          nextOperationalSlotToken:
            nextControl.slotToken,

          previousStatus:
            SHIFT_STATUSES.HANDOVER_PENDING,

          newStatus:
            SHIFT_STATUSES.COMPLETED,

          temporaryAuthorizationId:
            completedAuthorization?.id ??
            null,

          temporaryTechnicianUid:
            completedAuthorization
              ?.authorizedTechnicianUid ??
            null,

          createdAt:
            FieldValue.serverTimestamp(),

          details:
            completedAuthorization
              ? "The shift handover was completed, technician scheduling and memberships were released, and the temporary authorization was finalized."
              : "The shift handover was completed and technician scheduling and memberships were released.",
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
