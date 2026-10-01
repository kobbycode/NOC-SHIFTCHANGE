
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
  GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
  requireEligibleTechnician,
  markAssignmentActivity,
} from "./assignment-transaction";

import {
  evaluateAssignmentEligibility,
} from "./assignment-eligibility";

import {
  assertValidShiftTransition,
  assertShiftReadyToStart,
} from "./shift-transition";

import {
  parseShiftTimeRange,
  assertNoScheduleConflict,
} from "./shift-overlap";

import {
  assertShiftActivationWindow,
} from "./shift-activation-window";

import {
  assertShiftOwnsOperationalSlot,
  transitionOperationalShiftControl,
} from "./operational-shift-control-state";

import {
  loadOrBootstrapOperationalShiftControl,
} from "./operational-shift-control";

import {
  assertTemporaryTechnicianCanStartShift,
  createNextShiftAuthorizationDocumentId,
  NextShiftAuthorizationDomainError,
  readActivePermanentPairTechnicianIds,
} from "./next-shift-authorization-domain";

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
    operationalShiftControl,
    technicianPairs,
    technicianPairMemberships,
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

      const controlSnapshot =
        await transaction.get(
          operationalShiftControlRef
        );

      const shift = shiftSnapshot.data();
      const actor = actorSnapshot.data();

      const actorIsManager =
        actor?.role === "admin" ||
        actor?.role === "supervisor";
      const actorIsTechnician =
        actor?.role === "technician";

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
        (!actorIsManager && !actorIsTechnician)
      ) {
        throw new AssignmentOperationError(
          "Your account is not authorized to start this shift.",
          403
        );
      }

      const technicianEligibility =
        actorIsTechnician
          ? evaluateAssignmentEligibility(actor)
          : null;

      if (
        technicianEligibility &&
        !technicianEligibility.eligible
      ) {
        throw new AssignmentOperationError(
          technicianEligibility.message ??
            "The technician is not eligible to start this shift.",
          403
        );
      }

      if (
        actorIsTechnician &&
        !controlSnapshot.exists
      ) {
        throw new AssignmentOperationError(
          "The global operational shift control is unavailable.",
          409
        );
      }

      assertShiftActivationWindow(
        shift.scheduledStart,
        shift.scheduledEnd
      );

      const loadedControl =
        await loadOrBootstrapOperationalShiftControl(
          transaction,
          operationalShiftControlRef,
          controlSnapshot,
          shifts,
          new Date().toISOString()
        );
      const control = loadedControl.control;
      const shiftSlotToken =
        loadedControl.adoptedExistingShift
          ? control.slotToken
          : shift.operationalSlotToken;

      try {
        assertShiftOwnsOperationalSlot(
          control,
          shiftId,
          shiftSlotToken,
          shift.status
        );
      } catch {
        throw new AssignmentOperationError(
          "The selected shift does not occupy the current global operational slot.",
          409
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

      let temporaryAuthorizationId:
        string | null = null;

      if (actorIsTechnician) {
        if (
          typeof shift.permanentPairId !== "string" ||
          !shift.permanentPairId.trim() ||
          shift.permanentPairId.includes("/") ||
          typeof shift.operationalSlotToken !== "string"
        ) {
          throw new AssignmentOperationError(
            "The shift does not contain a valid permanent-pair and slot identity.",
            409
          );
        }

        const pairRef = technicianPairs.doc(
          shift.permanentPairId
        );
        const pairSnapshot =
          await transaction.get(pairRef);

        if (!pairSnapshot.exists) {
          throw new AssignmentOperationError(
            "The shift's permanent technician pair was not found.",
            409
          );
        }

        const pair = pairSnapshot.data();
        let pairTechnicianIds: [string, string];

        try {
          pairTechnicianIds =
            readActivePermanentPairTechnicianIds(
              pair,
              shift.permanentPairId
            );
        } catch (error) {
          if (
            error instanceof NextShiftAuthorizationDomainError
          ) {
            throw new AssignmentOperationError(
              error.message,
              error.status
            );
          }

          throw error;
        }

        if (
          pairTechnicianIds[0] !== primaryIds[0] ||
          pairTechnicianIds[1] !== primaryIds[1]
        ) {
          throw new AssignmentOperationError(
            "The shift's primary technicians do not match its permanent pair.",
            409
          );
        }

        const firstMembershipRef =
          technicianPairMemberships.doc(
            pairTechnicianIds[0]
          );
        const secondMembershipRef =
          technicianPairMemberships.doc(
            pairTechnicianIds[1]
          );

        let authorizationDocumentId: string;

        try {
          authorizationDocumentId =
            createNextShiftAuthorizationDocumentId(
              shift.permanentPairId,
              control.generation,
              shift.operationalSlotToken
            );
        } catch (error) {
          if (
            error instanceof NextShiftAuthorizationDomainError
          ) {
            throw new AssignmentOperationError(
              error.message,
              error.status
            );
          }

          throw error;
        }

        const authorizationRef =
          nextShiftAuthorizations.doc(
            authorizationDocumentId
          );

        const [
          firstMembershipSnapshot,
          secondMembershipSnapshot,
          authorizationSnapshot,
        ] = await Promise.all([
          transaction.get(firstMembershipRef),
          transaction.get(secondMembershipRef),
          transaction.get(authorizationRef),
        ]);

        if (!authorizationSnapshot.exists) {
          throw new AssignmentOperationError(
            "This technician is not authorized to start the selected shift.",
            403
          );
        }

        try {
          const authorization =
            assertTemporaryTechnicianCanStartShift({
              actorUid,
              actorProfile: actor,
              technicianEligibility:
                technicianEligibility!,
              shift,
              control,
              permanentPair: pair,
              pairMemberships: [
                firstMembershipSnapshot.exists
                  ? firstMembershipSnapshot.data()
                  : null,
                secondMembershipSnapshot.exists
                  ? secondMembershipSnapshot.data()
                  : null,
              ],
              authorizationDocumentId,
              authorization:
                authorizationSnapshot.data(),
            });

          temporaryAuthorizationId =
            authorization.id;
        } catch (error) {
          if (
            error instanceof NextShiftAuthorizationDomainError
          ) {
            throw new AssignmentOperationError(
              error.message,
              error.status
            );
          }

          throw error;
        }
      }

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

      let activeControl;

      try {
        activeControl =
          transitionOperationalShiftControl(
            control,
            shiftId,
            SHIFT_STATUSES.SCHEDULED,
            SHIFT_STATUSES.ACTIVE,
            now
          );
      } catch {
        throw new AssignmentOperationError(
          "The global operational slot cannot transition to active.",
          409
        );
      }

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

      transaction.update(
        operationalShiftControlRef,
        activeControl
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

          actorRole: actor.role,

          startAuthority:
            actorIsTechnician
              ? "temporary_authorization"
              : "manager",

          temporaryAuthorizationId,

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