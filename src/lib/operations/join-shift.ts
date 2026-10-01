import "server-only";

import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  SHIFT_MEMBER_ROLES,
} from "@/types/shift";

import {
  ATTENDANCE_PARTICIPATION_AUTHORITIES,
  type Attendance,
} from "@/types/attendance";

import type {
  NextShiftAuthorization,
} from "@/types/next-shift-authorization";

import {
  getOperationalCollections,
  GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
} from "./collections";

import {
  AssignmentOperationError,
  markAssignmentActivity,
} from "./assignment-transaction";

import {
  evaluateAssignmentEligibility,
} from "./assignment-eligibility";

import {
  createNextShiftAuthorizationDocumentId,
  NextShiftAuthorizationDomainError,
  readActivePermanentPairTechnicianIds,
} from "./next-shift-authorization-domain";

import {
  assertPrimaryTechnicianCanJoinShift,
  assertTemporaryTechnicianCanJoinShift,
  createShiftAttendanceRecord,
  ShiftJoinDomainError,
  validateActiveShiftJoinContext,
} from "./shift-join-domain";

import {
  prepareTechnicianSchedule,
} from "./prepare-technician-schedule";

export interface JoinShiftInput {
  shiftId: string;
  actorUid: string;
}

function mapDomainError(error: unknown): never {
  if (
    error instanceof ShiftJoinDomainError ||
    error instanceof NextShiftAuthorizationDomainError
  ) {
    throw new AssignmentOperationError(
      error.message,
      error.status
    );
  }

  throw error;
}

export async function joinShift(
  input: JoinShiftInput
): Promise<Attendance> {
  const { shiftId, actorUid } = input;

  if (
    typeof shiftId !== "string" ||
    !shiftId.trim() ||
    shiftId !== shiftId.trim() ||
    shiftId.length > 512 ||
    shiftId.includes("/") ||
    typeof actorUid !== "string" ||
    !actorUid.trim() ||
    actorUid !== actorUid.trim() ||
    actorUid.length > 128 ||
    actorUid.includes("/")
  ) {
    throw new AssignmentOperationError(
      "Please provide valid shift join details.",
      400
    );
  }

  const {
    db,
    shifts,
    shiftMembers,
    shiftAttendance,
    technicianSchedules,
    operationalShiftControl,
    technicianPairs,
    technicianPairMemberships,
    nextShiftAuthorizations,
  } = getOperationalCollections();

  const actorRef = db
    .collection("users")
    .doc(actorUid);
  const shiftRef = shifts.doc(shiftId);
  const controlRef = operationalShiftControl.doc(
    GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID
  );
  const attendanceRef = shiftAttendance.doc(
    `${shiftId}_${actorUid}`
  );
  const auditRef = db
    .collection("audit_logs")
    .doc();

  return db.runTransaction(
    async (transaction): Promise<Attendance> => {
      const [
        actorSnapshot,
        shiftSnapshot,
        controlSnapshot,
        attendanceSnapshot,
      ] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(shiftRef),
        transaction.get(controlRef),
        transaction.get(attendanceRef),
      ]);

      if (!actorSnapshot.exists) {
        throw new AssignmentOperationError(
          "The technician account was not found.",
          403
        );
      }

      const actorProfile = actorSnapshot.data();
      const eligibility =
        evaluateAssignmentEligibility(actorProfile);

      if (!eligibility.eligible) {
        throw new AssignmentOperationError(
          eligibility.message ??
            "The technician is not eligible to join this shift.",
          403
        );
      }

      if (actorProfile?.role !== "technician") {
        throw new AssignmentOperationError(
          "Only technicians can join shifts.",
          403
        );
      }

      if (!shiftSnapshot.exists) {
        throw new AssignmentOperationError(
          "The selected shift was not found.",
          404
        );
      }

      if (attendanceSnapshot.exists) {
        throw new AssignmentOperationError(
          "You have already joined this shift.",
          409
        );
      }

      const shift = shiftSnapshot.data();
      const shiftPairId = shift?.permanentPairId;

      if (
        typeof shiftPairId !== "string" ||
        !shiftPairId.trim() ||
        shiftPairId.includes("/")
      ) {
        throw new AssignmentOperationError(
          "The active shift has invalid permanent-pair information.",
          409
        );
      }

      const existingShift = shift as NonNullable<typeof shift>;

      const pairRef = technicianPairs.doc(shiftPairId);
      const pairSnapshot =
        await transaction.get(pairRef);

      if (!pairSnapshot.exists) {
        throw new AssignmentOperationError(
          "The active shift's permanent pair was not found.",
          409
        );
      }

      const pair = pairSnapshot.data();
      let pairTechnicianIds: [string, string];

      try {
        pairTechnicianIds =
          readActivePermanentPairTechnicianIds(
            pair,
            shiftPairId
          );
      } catch (error) {
        mapDomainError(error);
      }

      const firstPairReservationRef =
        technicianPairMemberships.doc(
          pairTechnicianIds[0]
        );
      const secondPairReservationRef =
        technicianPairMemberships.doc(
          pairTechnicianIds[1]
        );

      const [
        firstPairReservationSnapshot,
        secondPairReservationSnapshot,
      ] = await Promise.all([
        transaction.get(firstPairReservationRef),
        transaction.get(secondPairReservationRef),
      ]);

      const pairMemberships = [
        firstPairReservationSnapshot.exists
          ? firstPairReservationSnapshot.data()
          : null,
        secondPairReservationSnapshot.exists
          ? secondPairReservationSnapshot.data()
          : null,
      ];

      let identity;

      try {
        identity = validateActiveShiftJoinContext({
          actorUid,
          actorProfile,
          actorEligibility: eligibility,
          shift,
          control: controlSnapshot.exists
            ? controlSnapshot.data()
            : undefined,
          permanentPair: pair,
          pairMemberships: [
            pairMemberships[0],
            pairMemberships[1],
          ],
        });
      } catch (error) {
        mapDomainError(error);
      }

      const isPrimary =
        identity.primaryTechnicianIds.includes(actorUid);
      const memberRef = shiftMembers.doc(
        `${shiftId}_${actorUid}`
      );
      const scheduleRef = technicianSchedules.doc(actorUid);

      let attendanceAuthority:
        typeof ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY |
        typeof ATTENDANCE_PARTICIPATION_AUTHORITIES.TEMPORARY_AUTHORIZED;
      let authorizationId: string | null = null;
      let scheduleToWrite:
        ReturnType<typeof prepareTechnicianSchedule> | null = null;
      let temporaryJoinTimestamp: string | null = null;
      let additionalMemberToWrite:
        | {
            id: string;
            shiftId: string;
            technicianId: string;
            role: typeof SHIFT_MEMBER_ROLES.ADDITIONAL;
            joinedAt: string;
            leftAt: null;
          }
        | null = null;

      if (isPrimary) {
        const [memberSnapshot, scheduleSnapshot] =
          await Promise.all([
            transaction.get(memberRef),
            transaction.get(scheduleRef),
          ]);

        try {
          assertPrimaryTechnicianCanJoinShift({
            identity,
            actorUid,
            memberDocumentId: memberSnapshot.id,
            member: memberSnapshot.exists
              ? memberSnapshot.data()
              : null,
            schedule: scheduleSnapshot.exists
              ? scheduleSnapshot.data()
              : null,
          });
        } catch (error) {
          mapDomainError(error);
        }

        attendanceAuthority =
          ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY;
      } else {
        let authorizationDocumentId: string;

        try {
          authorizationDocumentId =
            createNextShiftAuthorizationDocumentId(
              identity.permanentPairId,
              identity.slotGeneration,
              identity.operationalSlotToken
            );
        } catch (error) {
          mapDomainError(error);
        }

        const authorizationRef =
          nextShiftAuthorizations.doc(
            authorizationDocumentId
          );
        const [
          memberSnapshot,
          scheduleSnapshot,
          authorizationSnapshot,
        ] = await Promise.all([
          transaction.get(memberRef),
          transaction.get(scheduleRef),
          transaction.get(authorizationRef),
        ]);

        if (!authorizationSnapshot.exists) {
          throw new AssignmentOperationError(
            "A consumed temporary authorization for this exact shift is required.",
            403
          );
        }

        let authorization: NextShiftAuthorization;

        try {
          authorization =
            assertTemporaryTechnicianCanJoinShift({
              identity,
              actorUid,
              actorProfile,
              actorEligibility: eligibility,
              permanentPair: pair,
              pairMemberships: [
                pairMemberships[0],
                pairMemberships[1],
              ],
              authorizationDocumentId,
              authorization: authorizationSnapshot.data(),
              memberAlreadyExists: memberSnapshot.exists,
            });

          temporaryJoinTimestamp =
            new Date().toISOString();

          scheduleToWrite =
            prepareTechnicianSchedule({
              shiftId,
              technicianUid: actorUid,
              scheduledStart: existingShift.scheduledStart,
              scheduledEnd: existingShift.scheduledEnd,
              updatedAt: temporaryJoinTimestamp,
              entryStatus: "active",
              scheduleExists: scheduleSnapshot.exists,
              scheduleData: scheduleSnapshot.exists
                ? scheduleSnapshot.data()
                : undefined,
            });
        } catch (error) {
          if (
            error instanceof AssignmentOperationError
          ) {
            throw error;
          }

          mapDomainError(error);
        }

        authorizationId = authorization.id;
        attendanceAuthority =
          ATTENDANCE_PARTICIPATION_AUTHORITIES.TEMPORARY_AUTHORIZED;
      }

      const now =
        temporaryJoinTimestamp ??
        new Date().toISOString();
      const attendance = createShiftAttendanceRecord({
        shiftId,
        technicianUid: actorUid,
        participationAuthority: attendanceAuthority,
        authorizationId,
        recordedAt: now,
      });

      if (!isPrimary) {
        additionalMemberToWrite = {
          id: memberRef.id,
          shiftId,
          technicianId: actorUid,
          role: SHIFT_MEMBER_ROLES.ADDITIONAL,
          joinedAt: now,
          leftAt: null,
        };
      }

      transaction.create(
        attendanceRef,
        attendance
      );

      if (additionalMemberToWrite && scheduleToWrite) {
        transaction.create(
          memberRef,
          additionalMemberToWrite
        );

        transaction.set(
          scheduleRef,
          scheduleToWrite
        );

        markAssignmentActivity(
          transaction,
          actorUid
        );
      }

      transaction.create(
        auditRef,
        {
          id: auditRef.id,
          action: "SHIFT_TECHNICIAN_JOINED",
          actorUid,
          technicianUid: actorUid,
          shiftId,
          participationAuthority:
            attendanceAuthority,
          authorizationId,
          createdAt:
            FieldValue.serverTimestamp(),
        }
      );

      return attendance;
    }
  );
}