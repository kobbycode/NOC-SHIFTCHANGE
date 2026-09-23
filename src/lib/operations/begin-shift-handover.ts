
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
  assertNoScheduleConflict,
  parseShiftTimeRange,
} from "./shift-overlap";

export interface BeginShiftHandoverInput {
  shiftId: string;
  actorUid: string;
}

export interface BeginShiftHandoverResult {
  shiftId: string;
  status: "handover_pending";
  handoverStartedAt: string;
}

interface ScheduleUpdate {
  technicianUid: string;
  scheduleRef: DocumentReference;
  entries: TechnicianScheduleEntry[];
}

export async function beginShiftHandover(
  input: BeginShiftHandoverInput
): Promise<BeginShiftHandoverResult> {
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

  return db.runTransaction(
    async (
      transaction
    ): Promise<BeginShiftHandoverResult> => {
      /*
       * PHASE 1:
       * Read the shift and acting user.
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
          "Your account is not authorized to begin shift handover.",
          403
        );
      }

      /*
       * PHASE 2:
       * Validate the shift lifecycle.
       */

      assertValidShiftTransition(
        shift.status,
        SHIFT_STATUSES.HANDOVER_PENDING
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
        shift.actualEnd != null
      ) {
        throw new AssignmentOperationError(
          "The shift has inconsistent activation or completion information.",
          409
        );
      }

      const primaryIds: string[] =
        shift.primaryTechnicianIds;

      /*
       * PHASE 3:
       * Read authoritative membership records.
       */

      const membersSnapshot =
        await transaction.get(
          shiftMembers.where(
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
       * Read and validate technician schedules.
       *
       * No transaction writes have occurred.
       */

      const scheduleUpdates:
        ScheduleUpdate[] = [];

      for (const member of currentMembers) {
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
            SHIFT_STATUSES.ACTIVE
        ) {
          throw new AssignmentOperationError(
            "A technician's active shift scheduling information is inconsistent.",
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

        const updatedEntries:
          TechnicianScheduleEntry[] =
            entries.map(
              (entry) =>
                entry.shiftId === shiftId
                  ? {
                      ...entry,
                      status:
                        SHIFT_STATUSES.HANDOVER_PENDING,
                    }
                  : entry
            );

        scheduleUpdates.push({
          technicianUid,
          scheduleRef,
          entries: updatedEntries,
        });
      }

      /*
       * PHASE 5:
       * All transaction reads are complete.
       *
       * Commit the shift and scheduling
       * changes atomically.
       */

      const now =
        new Date().toISOString();

      transaction.update(
        shiftRef,
        {
          status:
            SHIFT_STATUSES.HANDOVER_PENDING,

          handoverStartedAt: now,

          handoverStartedBy: actorUid,

          updatedAt: now,

          handoverStartedTimestamp:
            FieldValue.serverTimestamp(),
        }
      );

      for (
        const record of
        scheduleUpdates
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

          action:
            "SHIFT_HANDOVER_STARTED",

          actorUid,

          shiftId,

          previousStatus:
            SHIFT_STATUSES.ACTIVE,

          newStatus:
            SHIFT_STATUSES.HANDOVER_PENDING,

          createdAt:
            FieldValue.serverTimestamp(),

          details:
            "The active shift entered the handover pending state.",
        }
      );

      return {
        shiftId,

        status:
          SHIFT_STATUSES.HANDOVER_PENDING,

        handoverStartedAt: now,
      };
    }
  );
}