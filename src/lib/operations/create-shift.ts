
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
  markAssignmentActivity,
  requireEligibleTechnician,
} from "./assignment-transaction";

import {
  evaluateAssignmentEligibility,
} from "./assignment-eligibility";

import {
  parseShiftTimeRange,
} from "./shift-overlap";

import {
  consumeOperationalShiftSlot,
} from "./operational-shift-control-state";

import {
  loadOrBootstrapOperationalShiftControl,
} from "./operational-shift-control";

import {
  buildShiftCreationPairBinding,
  buildNextShiftAuthorizationConsumedAuditData,
  NextShiftAuthorizationDomainError,
  readActivePermanentPairTechnicianIds,
  selectPendingAuthorizationForShift,
  type ShiftCreationPairBinding,
} from "./next-shift-authorization-domain";

import {
  preparePrimaryShiftRoster,
} from "./prepare-technician-schedule";

import type {
  NextShiftAuthorization,
} from "@/types/next-shift-authorization";

import {
  GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
} from "./collections";

export interface CreateShiftInput {
  shiftType: ShiftType;
  scheduledStart: string;
  scheduledEnd: string;
  permanentPairId: string;
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
    permanentPairId,
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
    typeof permanentPairId !== "string" ||
    !permanentPairId.trim() ||
    permanentPairId !== permanentPairId.trim() ||
    permanentPairId.length > 512 ||
    permanentPairId.includes("/") ||
    permanentPairId === "." ||
    permanentPairId === ".."
  ) {
    throw new AssignmentOperationError(
      "Please select a valid permanent technician pair.",
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
    shiftMembers,
    technicianSchedules,
    operationalShiftControl,
    technicianPairs,
    technicianPairMemberships,
    nextShiftAuthorizations,
  } = getOperationalCollections();

  const operationalShiftControlRef =
    operationalShiftControl.doc(
      GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID
    );

  const actorRef = db
    .collection("users")
    .doc(createdBy);

  const pairRef = technicianPairs.doc(
    permanentPairId
  );

  const shiftRef = shifts.doc();

  const auditRef = db
    .collection("audit_logs")
    .doc();

  const now = new Date().toISOString();

  const shift: Shift = {
    id: shiftRef.id,

    operationalSlotToken: null,

    permanentPairId,

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

  let createdShiftResult = shift;

  /*
   * PHASE 3:
   * Verify the actor and create the shift
   * inside the same Firestore transaction.
   */

  const created = await db.runTransaction(
    async (transaction) => {
      const [
        actorSnapshot,
        controlSnapshot,
        pairSnapshot,
      ] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(operationalShiftControlRef),
        transaction.get(pairRef),
      ]);

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

      const loadedControl =
        await loadOrBootstrapOperationalShiftControl(
          transaction,
          operationalShiftControlRef,
          controlSnapshot,
          shifts,
          now
        );

      if (loadedControl.adoptedExistingShift) {
        return false;
      }

      const control = loadedControl.control;

      if (!pairSnapshot.exists) {
        throw new AssignmentOperationError(
          "The selected permanent technician pair was not found.",
          404
        );
      }

      const pair = pairSnapshot.data();
      let permanentTechnicianIds: [string, string];

      try {
        permanentTechnicianIds =
          readActivePermanentPairTechnicianIds(
            pair,
            permanentPairId
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

      const firstMembershipRef =
        technicianPairMemberships.doc(
          permanentTechnicianIds[0]
        );
      const secondMembershipRef =
        technicianPairMemberships.doc(
          permanentTechnicianIds[1]
        );

      const primaryMemberRefs =
        permanentTechnicianIds.map(
          (technicianUid) =>
            shiftMembers.doc(
              `${shiftRef.id}_${technicianUid}`
            )
        );
      const primaryScheduleRefs =
        permanentTechnicianIds.map(
          (technicianUid) =>
            technicianSchedules.doc(
              technicianUid
            )
        );

      const [
        firstMembershipSnapshot,
        secondMembershipSnapshot,
        slotAuthorizationSnapshot,
        firstPrimaryMemberSnapshot,
        secondPrimaryMemberSnapshot,
        firstScheduleSnapshot,
        secondScheduleSnapshot,
      ] = await Promise.all([
        transaction.get(firstMembershipRef),
        transaction.get(secondMembershipRef),
        transaction.get(
          nextShiftAuthorizations.where(
            "slotToken",
            "==",
            control.slotToken
          )
        ),
        transaction.get(primaryMemberRefs[0]),
        transaction.get(primaryMemberRefs[1]),
        transaction.get(primaryScheduleRefs[0]),
        transaction.get(primaryScheduleRefs[1]),
      ]);

      for (const technicianUid of permanentTechnicianIds) {
        await requireEligibleTechnician(
          transaction,
          technicianUid
        );
      }

      if (
        firstPrimaryMemberSnapshot.exists ||
        secondPrimaryMemberSnapshot.exists
      ) {
        throw new AssignmentOperationError(
          "A primary membership already exists for the new shift.",
          409
        );
      }

      let authorization: NextShiftAuthorization | null;

      try {
        authorization =
          selectPendingAuthorizationForShift(
            control,
            permanentPairId,
            slotAuthorizationSnapshot.docs.map(
              (document) => ({
                id: document.id,
                data: document.data(),
              })
            )
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

      let temporaryTechnicianProfile:
        Record<string, unknown> | undefined;

      if (authorization) {
        const temporaryTechnicianSnapshot =
          await transaction.get(
            db
              .collection("users")
              .doc(
                authorization.authorizedTechnicianUid
              )
          );

        temporaryTechnicianProfile =
          temporaryTechnicianSnapshot.exists
            ? temporaryTechnicianSnapshot.data()
            : undefined;
      }

      let binding: ShiftCreationPairBinding;

      try {
        binding =
          buildShiftCreationPairBinding({
            control,
            permanentPairId,
            pair,
            pairMemberships: [
              firstMembershipSnapshot.exists
                ? firstMembershipSnapshot.data()
                : null,
              secondMembershipSnapshot.exists
                ? secondMembershipSnapshot.data()
                : null,
            ],
            authorization,
            temporaryTechnicianEligibility:
              authorization
                ? evaluateAssignmentEligibility(
                    temporaryTechnicianProfile
                  )
                : undefined,
            shiftId: shiftRef.id,
            createdAt: now,
          });
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

      const primaryRoster =
        preparePrimaryShiftRoster({
          shiftId: shiftRef.id,
          technicianIds:
            binding.primaryTechnicianIds,
          scheduledStart,
          scheduledEnd,
          joinedAt: now,
          updatedAt: now,
          scheduleSnapshots: [
            {
              exists: firstScheduleSnapshot.exists,
              data: firstScheduleSnapshot.data(),
            },
            {
              exists: secondScheduleSnapshot.exists,
              data: secondScheduleSnapshot.data(),
            },
          ],
        });
      const primaryMembers = primaryRoster.members;
      const primarySchedules = primaryRoster.schedules;

      let consumedControl;

      try {
        consumedControl =
          consumeOperationalShiftSlot(
            control,
            shiftRef.id,
            now
          );
      } catch {
        throw new AssignmentOperationError(
          "The current global shift slot is already occupied. Complete the current shift before creating another.",
          409
        );
      }

      const createdShift: Shift = {
        ...shift,
        operationalSlotToken:
          control.slotToken,
        permanentPairId:
          binding.permanentPairId,
        primaryTechnicianIds:
          binding.primaryTechnicianIds,
      };

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
        createdShift
      );

      for (let index = 0; index < 2; index += 1) {
        transaction.create(
          primaryMemberRefs[index],
          primaryMembers[index]
        );

        transaction.set(
          primaryScheduleRefs[index],
          primarySchedules[index]
        );

        markAssignmentActivity(
          transaction,
          permanentTechnicianIds[index]
        );
      }

      if (loadedControl.persisted) {
        transaction.update(
          operationalShiftControlRef,
          consumedControl
        );
      } else {
        transaction.create(
          operationalShiftControlRef,
          consumedControl
        );
      }

      if (binding.consumedAuthorization) {
        transaction.update(
          nextShiftAuthorizations.doc(
            binding.consumedAuthorization.id
          ),
          binding.consumedAuthorization
        );
      }

      transaction.create(
        auditRef,
        {
          action: "SHIFT_CREATED",

          actorUid: createdBy,

          targetShiftId: shiftRef.id,

          operationalSlotToken:
            control.slotToken,

          permanentPairId:
            binding.permanentPairId,

          primaryTechnicianIds:
            binding.primaryTechnicianIds,

          details:
            "An authorized user created a scheduled shift.",

          shiftType,

          scheduledStart,
          scheduledEnd,

          createdAt:
            FieldValue.serverTimestamp(),
        }
      );

      if (binding.consumedAuthorization) {
        const consumptionAuditRef = db
          .collection("audit_logs")
          .doc();

        transaction.create(
          consumptionAuditRef,
          buildNextShiftAuthorizationConsumedAuditData(
            binding.consumedAuthorization,
            createdBy,
            shiftRef.id,
            control.slotToken,
            control.generation,
            consumptionAuditRef.id,
            FieldValue.serverTimestamp()
          )
        );
      }

      createdShiftResult = createdShift;
      return true;
    }
  );

  if (!created) {
    throw new AssignmentOperationError(
      "The existing global shift must complete before another shift can be created.",
      409
    );
  }

  return createdShiftResult;
}