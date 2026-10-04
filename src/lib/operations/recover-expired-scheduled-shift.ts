import "server-only";

import {
  FieldValue,
  type DocumentReference,
} from "firebase-admin/firestore";

import {
  randomUUID,
} from "node:crypto";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  SHIFT_MEMBER_ROLES,
  SHIFT_STATUSES,
  type ShiftMember,
} from "@/types/shift";

import {
  SHIFT_TRANSITION_ACTIONS,
} from "@/types/shift-transition";

import {
  TASK_STATUSES,
} from "@/types/task";

import type {
  TechnicianSchedule,
  TechnicianScheduleEntry,
} from "@/types/technician-schedule";

import type {
  NextShiftAuthorization,
} from "@/types/next-shift-authorization";

import {
  AssignmentOperationError,
  markAssignmentActivity,
} from "./assignment-transaction";

import {
  GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
  getOperationalCollections,
} from "./collections";

import {
  ensureOperationalShiftControl,
  readOperationalShiftControl,
} from "./operational-shift-control";

import {
  advanceExpiredScheduledOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
} from "./operational-shift-control-state";

import {
  assertShiftActivationWindowExpired,
} from "./shift-activation-window";

import {
  assertShiftReadyToStart,
} from "./shift-transition";

import {
  assertNoScheduleConflict,
  parseShiftTimeRange,
} from "./shift-overlap";

import {
  createNextShiftAuthorizationDocumentId,
  expireConsumedNextShiftAuthorization,
  readActivePermanentPairTechnicianIds,
} from "./next-shift-authorization-domain";

export interface RecoverExpiredScheduledShiftInput {
  shiftId: string;
  actorUid: string;
}

export interface RecoverExpiredScheduledShiftResult {
  shiftId: string;
  status: "cancelled";
  cancelledAt: string;
}

interface ScheduleRelease {
  technicianUid: string;
  scheduleRef: DocumentReference;
  entries: TechnicianScheduleEntry[];
}

export async function recoverExpiredScheduledShift(
  input: RecoverExpiredScheduledShiftInput
): Promise<RecoverExpiredScheduledShiftResult> {
  const {
    shiftId,
    actorUid,
  } = input;

  if (
    !shiftId ||
    shiftId.includes("/") ||
    shiftId.length > 512 ||
    !actorUid ||
    actorUid.includes("/") ||
    actorUid.length > 128
  ) {
    throw new AssignmentOperationError(
      "Please provide valid shift recovery details.",
      400
    );
  }

  const db =
    getAdminFirestore();

  await ensureOperationalShiftControl(
    actorUid
  );

  const {
    shifts,
    shiftMembers,
    shiftAttendance,
    technicianSchedules,
    technicianPairs,
    tasks,
    operationalShiftControl,
    nextShiftAuthorizations,
  } = getOperationalCollections();

  const shiftRef =
    shifts.doc(shiftId);

  const actorRef =
    db
      .collection("users")
      .doc(actorUid);

  const operationalShiftControlRef =
    operationalShiftControl.doc(
      GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID
    );

  const auditRef =
    db
      .collection("audit_logs")
      .doc();

  const nextSlotToken =
    randomUUID();

  return db.runTransaction(
    async (
      transaction
    ): Promise<RecoverExpiredScheduledShiftResult> => {
      /*
       * PHASE 1:
       * Read the authoritative shift,
       * administrator, and global slot.
       */

      const [
        shiftSnapshot,
        actorSnapshot,
        controlSnapshot,
      ] = await Promise.all([
        transaction.get(
          shiftRef
        ),

        transaction.get(
          actorRef
        ),

        transaction.get(
          operationalShiftControlRef
        ),
      ]);

      const shift =
        shiftSnapshot.data();

      const actor =
        actorSnapshot.data();

      if (
        !shiftSnapshot.exists ||
        !shift
      ) {
        throw new AssignmentOperationError(
          "The selected shift was not found.",
          404
        );
      }

      /*
       * Recovery is deliberately narrower
       * than normal shift management.
       *
       * Supervisors cannot use this path.
       */

      if (
        !actorSnapshot.exists ||
        !actor ||
        actor.role !== "admin" ||
        actor.status !== "active" ||
        actor.statusOperation != null ||
        actor.mustChangePassword === true
      ) {
        throw new AssignmentOperationError(
          "Your account is not authorized to recover an expired scheduled shift.",
          403
        );
      }

      if (
        !controlSnapshot.exists
      ) {
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
       * Validate the special recovery
       * lifecycle.
       *
       * This is NOT the generic shift
       * transition path.
       */

      if (
        shift.status !==
        SHIFT_STATUSES.SCHEDULED
      ) {
        throw new AssignmentOperationError(
          "Only an expired scheduled shift can be recovered.",
          409
        );
      }

      assertShiftReadyToStart(
        shift.primaryTechnicianIds
      );

      if (
        typeof shift.permanentPairId !==
          "string" ||
        !shift.permanentPairId ||
        shift.permanentPairId.includes("/") ||
        shift.permanentPairId.length > 512 ||
        typeof shift.scheduledStart !==
          "string" ||
        typeof shift.scheduledEnd !==
          "string"
      ) {
        throw new AssignmentOperationError(
          "The scheduled shift contains invalid recovery information.",
          409
        );
      }

      parseShiftTimeRange(
        shift.scheduledStart,
        shift.scheduledEnd
      );

      if (
        shift.actualStart !== null ||
        shift.actualEnd !== null ||
        shift.handoverStartedAt != null
      ) {
        throw new AssignmentOperationError(
          "A shift that has already entered its operational lifecycle cannot use scheduled-shift recovery.",
          409
        );
      }

      const recoveryTime =
        new Date();

      const now =
        recoveryTime.toISOString();

      assertShiftActivationWindowExpired(
        shift.scheduledStart,
        shift.scheduledEnd,
        recoveryTime
      );

      /*
       * PHASE 3:
       * Read permanent-pair, roster,
       * attendance, task, and authorization
       * state.
       *
       * No writes occur before every
       * authoritative read has completed.
       */

      const pairRef =
        technicianPairs.doc(
          shift.permanentPairId
        );

      let expectedAuthorizationId:
        string;

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
        pairSnapshot,
        membersSnapshot,
        attendanceSnapshot,
        tasksSnapshot,
        expectedAuthorizationSnapshot,
        slotAuthorizationSnapshot,
        shiftAuthorizationSnapshot,
      ] = await Promise.all([
        transaction.get(
          pairRef
        ),

        transaction.get(
          shiftMembers.where(
            "shiftId",
            "==",
            shiftId
          )
        ),

        transaction.get(
          shiftAttendance.where(
            "shiftId",
            "==",
            shiftId
          )
        ),

        transaction.get(
          tasks.where(
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

      if (
        !pairSnapshot.exists
      ) {
        throw new AssignmentOperationError(
          "The shift's permanent technician pair is unavailable.",
          409
        );
      }

      let pairTechnicianIds:
        [string, string];

      try {
        pairTechnicianIds =
          readActivePermanentPairTechnicianIds(
            {
              ...pairSnapshot.data(),
              id: pairSnapshot.id,
            },
            shift.permanentPairId
          );
      } catch (error) {
        throw new AssignmentOperationError(
          error instanceof Error
            ? error.message
            : "The shift's permanent technician pair is invalid.",
          409
        );
      }

      const primaryIds:
        string[] =
        shift.primaryTechnicianIds;

      if (
        !primaryIds.every(
          (uid) =>
            pairTechnicianIds.includes(
              uid
            )
        ) ||
        !pairTechnicianIds.every(
          (uid) =>
            primaryIds.includes(
              uid
            )
        )
      ) {
        throw new AssignmentOperationError(
          "The scheduled shift no longer matches its permanent technician pair.",
          409
        );
      }

      /*
       * A scheduled shift must still have
       * exactly its two original PRIMARY
       * roster assignments.
       *
       * Temporary C is never a member until
       * an explicit join on an active shift.
       */

      if (
        membersSnapshot.docs.length !== 2
      ) {
        throw new AssignmentOperationError(
          "The scheduled shift has inconsistent technician memberships.",
          409
        );
      }

      const currentMembers:
        ShiftMember[] = [];

      for (
        const document of
        membersSnapshot.docs
      ) {
        const member =
          document.data();

        if (
          member.id !== document.id ||
          member.shiftId !== shiftId ||
          typeof member.technicianId !==
            "string" ||
          !member.technicianId ||
          member.technicianId.includes("/") ||
          member.technicianId.length > 128 ||
          member.role !==
            SHIFT_MEMBER_ROLES.PRIMARY ||
          typeof member.joinedAt !==
            "string" ||
          !Number.isFinite(
            Date.parse(
              member.joinedAt
            )
          ) ||
          member.leftAt !== null ||
          !primaryIds.includes(
            member.technicianId
          )
        ) {
          throw new AssignmentOperationError(
            "The scheduled shift has inconsistent technician memberships.",
            409
          );
        }

        currentMembers.push(
          member as ShiftMember
        );
      }

      const memberIds =
        currentMembers.map(
          (member) =>
            member.technicianId
        );

      if (
        new Set(
          memberIds
        ).size !== 2 ||
        !primaryIds.every(
          (uid) =>
            memberIds.includes(
              uid
            )
        )
      ) {
        throw new AssignmentOperationError(
          "The scheduled shift's primary roster is inconsistent.",
          409
        );
      }

      /*
       * Recovery must never erase or
       * reinterpret real attendance.
       *
       * Any attendance record means this
       * exceptional scheduled-only path is
       * unsafe and must fail closed.
       */

      if (
        attendanceSnapshot.docs.length !== 0
      ) {
        throw new AssignmentOperationError(
          "The scheduled shift contains attendance and cannot be recovered automatically.",
          409
        );
      }

      /*
       * Tasks may have been prepared before
       * activation. Recovery cannot silently
       * discard unresolved operational work.
       */

      for (
        const document of
        tasksSnapshot.docs
      ) {
        const task =
          document.data();

        if (
          task.shiftId !== shiftId ||
          !Object.values(
            TASK_STATUSES
          ).includes(
            task.status
          )
        ) {
          throw new AssignmentOperationError(
            "The scheduled shift contains invalid task information.",
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
            "The expired scheduled shift has unresolved tasks. Resolve them before recovery.",
            409
          );
        }
      }

      /*
       * Discover temporary authorization
       * using the same fail-closed union
       * strategy used by completion:
       *
       * - deterministic expected document,
       * - current slot identity,
       * - current shift binding.
       */

      const authorizationCandidates =
        new Map<
          string,
          unknown
        >();

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
        NextShiftAuthorization | null =
          null;

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
       * PHASE 4:
       * Read and validate the exact A+B
       * schedule entries that will be
       * released.
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
          scheduleData as
            TechnicianSchedule;

        const entries =
          schedule.entries;

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
            (entry) =>
              entry.shiftId
          );

        if (
          new Set(
            entryIds
          ).size !==
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
              entry.shiftId ===
              shiftId
          );

        if (
          matchingEntries.length !== 1 ||
          matchingEntries[0].status !==
            SHIFT_STATUSES.SCHEDULED
        ) {
          throw new AssignmentOperationError(
            "A technician's scheduled recovery information is inconsistent.",
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
              entry.shiftId !==
              shiftId
          );

        assertNoScheduleConflict(
          shift.scheduledStart,
          shift.scheduledEnd,
          otherEntries
        );

        scheduleReleases.push({
          technicianUid,
          scheduleRef,
          entries:
            otherEntries,
        });
      }

      /*
       * PHASE 5:
       * All reads are complete.
       *
       * Build the terminal authorization
       * and next global slot before any
       * Firestore writes.
       */

      let expiredAuthorization:
        NextShiftAuthorization | null =
          null;

      if (
        temporaryAuthorization
      ) {
        try {
          expiredAuthorization =
            expireConsumedNextShiftAuthorization({
              authorization:
                temporaryAuthorization,

              shiftId,

              slotToken:
                control.slotToken,

              slotGeneration:
                control.generation,

              permanentPairId:
                shift.permanentPairId,

              expiredAt:
                now,
            });
        } catch (error) {
          throw new AssignmentOperationError(
            error instanceof Error
              ? error.message
              : "The temporary authorization cannot be expired.",
            409
          );
        }
      }

      let nextControl;

      try {
        nextControl =
          advanceExpiredScheduledOperationalShiftControl(
            control,
            shiftId,
            nextSlotToken,
            now
          );
      } catch (error) {
        throw new AssignmentOperationError(
          error instanceof Error
            ? error.message
            : "The global operational slot cannot be advanced for this recovery.",
          409
        );
      }

      /*
       * PHASE 6:
       * Commit the complete recovery
       * atomically.
       *
       * IMPORTANT:
       * - actualStart remains null.
       * - actualEnd remains null.
       * - attendance is untouched.
       * - permanent pair is untouched.
       */

      transaction.update(
        shiftRef,
        {
          status:
            SHIFT_STATUSES.CANCELLED,

          cancelledAt:
            now,

          cancelledBy:
            actorUid,

          updatedAt:
            now,
        }
      );

      transaction.update(
        operationalShiftControlRef,
        nextControl
      );

      /*
       * End roster assignment only.
       *
       * leftAt is not attendance and is
       * not a technician clock-out.
       */

      for (
        const member of
        currentMembers
      ) {
        transaction.update(
          shiftMembers.doc(
            member.id
          ),
          {
            leftAt:
              now,
          }
        );
      }

      if (
        expiredAuthorization
      ) {
        transaction.update(
          nextShiftAuthorizations.doc(
            expiredAuthorization.id
          ),
          {
            status:
              expiredAuthorization.status,

            completedAt:
              expiredAuthorization.completedAt,

            expiredAt:
              expiredAuthorization.expiredAt,

            updatedAt:
              expiredAuthorization.updatedAt,
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
            entries:
              record.entries,

            updatedAt:
              now,
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
          id:
            auditRef.id,

          action:
            SHIFT_TRANSITION_ACTIONS.CANCELLED,

          actorUid,

          shiftId,

          previousOperationalSlotToken:
            control.slotToken,

          nextOperationalSlotToken:
            nextControl.slotToken,

          previousStatus:
            SHIFT_STATUSES.SCHEDULED,

          newStatus:
            SHIFT_STATUSES.CANCELLED,

          temporaryAuthorizationId:
            expiredAuthorization?.id ??
            null,

          temporaryTechnicianUid:
            expiredAuthorization
              ?.authorizedTechnicianUid ??
            null,

          createdAt:
            FieldValue.serverTimestamp(),

          details:
            expiredAuthorization
              ? "The expired scheduled shift was cancelled, technician scheduling and memberships were released, its temporary authorization was expired, and the global operational slot was advanced."
              : "The expired scheduled shift was cancelled, technician scheduling and memberships were released, and the global operational slot was advanced.",
        }
      );

      return {
        shiftId,

        status:
          SHIFT_STATUSES.CANCELLED,

        cancelledAt:
          now,
      };
    }
  );
}
