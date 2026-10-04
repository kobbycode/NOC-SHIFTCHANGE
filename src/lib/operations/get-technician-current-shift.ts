import "server-only";

import type {
  AppUser,
} from "@/types/auth";

import {
  evaluateAssignmentEligibility,
} from "./assignment-eligibility";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

import {
  getOperationalCollections,
  GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
} from "./collections";

import {
  assertOperationalShiftControl,
} from "./operational-shift-control-state";

import {
  createNextShiftAuthorizationDocumentId,
  NextShiftAuthorizationDomainError,
  readActivePermanentPairTechnicianIds,
} from "./next-shift-authorization-domain";

import {
  resolveTechnicianCurrentShift,
  TechnicianCurrentShiftDomainError,
  type TechnicianCurrentShiftView,
} from "./technician-current-shift-domain";

function mapDomainError(
  error: unknown,
): never {
  if (
    error instanceof
      TechnicianCurrentShiftDomainError ||
    error instanceof
      NextShiftAuthorizationDomainError
  ) {
    throw new AssignmentOperationError(
      error.message,
      error.status,
    );
  }

  throw error;
}

export async function getTechnicianCurrentShift(
  actor: AppUser,
): Promise<TechnicianCurrentShiftView | null> {
  if (
    !actor ||
    typeof actor.uid !== "string" ||
    !actor.uid.trim() ||
    actor.uid !== actor.uid.trim() ||
    actor.uid.length > 128 ||
    actor.uid.includes("/") ||
    actor.uid === "." ||
    actor.uid === ".." ||
    actor.role !== "technician"
  ) {
    throw new AssignmentOperationError(
      "Only a valid technician account can retrieve a current shift.",
      403,
    );
  }

  const {
    db,
    shifts,
    shiftAttendance,
    technicianPairs,
    technicianPairMemberships,
    operationalShiftControl,
    nextShiftAuthorizations,
  } = getOperationalCollections();

  const actorRef =
    db
      .collection("users")
      .doc(actor.uid);

  const controlRef =
    operationalShiftControl.doc(
      GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
    );

  const [
    actorSnapshot,
    controlSnapshot,
  ] = await Promise.all([
    actorRef.get(),
    controlRef.get(),
  ]);

  const actorProfile =
    actorSnapshot.data();

  const eligibility =
    evaluateAssignmentEligibility(
      actorProfile,
    );

  if (
    !actorSnapshot.exists ||
    !eligibility.eligible ||
    actorProfile?.role !==
      actor.role
  ) {
    throw new AssignmentOperationError(
      eligibility.message ??
        "Your account is not authorized to retrieve a technician shift.",
      403,
    );
  }

  if (!controlSnapshot.exists) {
    throw new AssignmentOperationError(
      "The global operational shift-control record is unavailable.",
      409,
    );
  }

  let control;

  try {
    control =
      assertOperationalShiftControl(
        controlSnapshot.data(),
      );
  } catch {
    throw new AssignmentOperationError(
      "The global operational shift-control record requires administrator review.",
      409,
    );
  }

  if (
    control.slotStatus === "pending"
  ) {
    try {
      return resolveTechnicianCurrentShift({
        technicianUid:
          actor.uid,

        control,

        shift: null,

        permanentPair: null,
        pairMemberships: null,

        authorizationDocumentId:
          null,
        authorization: null,

        attendanceDocumentId:
          null,
        attendance: null,
      });
    } catch (error) {
      mapDomainError(error);
    }
  }

  const shiftId =
    control.shiftId;

  if (!shiftId) {
    throw new AssignmentOperationError(
      "The current operational shift is unavailable.",
      409,
    );
  }

  const shiftSnapshot =
    await shifts
      .doc(shiftId)
      .get();

  if (!shiftSnapshot.exists) {
    throw new AssignmentOperationError(
      "The current operational shift is unavailable.",
      409,
    );
  }

  const shift =
    shiftSnapshot.data();

  const permanentPairId =
    shift?.permanentPairId;

  if (
    typeof permanentPairId !==
      "string" ||
    !permanentPairId.trim() ||
    permanentPairId !==
      permanentPairId.trim() ||
    permanentPairId.length > 512 ||
    permanentPairId.includes("/") ||
    permanentPairId === "." ||
    permanentPairId === ".."
  ) {
    throw new AssignmentOperationError(
      "The current shift permanent-pair identity requires administrator review.",
      409,
    );
  }

  const pairSnapshot =
    await technicianPairs
      .doc(permanentPairId)
      .get();

  if (!pairSnapshot.exists) {
    throw new AssignmentOperationError(
      "The current shift permanent pair is unavailable.",
      409,
    );
  }

  let pairTechnicianIds:
    [string, string];

  try {
    pairTechnicianIds =
      readActivePermanentPairTechnicianIds(
        pairSnapshot.data(),
        permanentPairId,
      );
  } catch (error) {
    mapDomainError(error);
  }

  let authorizationDocumentId:
    string;

  try {
    authorizationDocumentId =
      createNextShiftAuthorizationDocumentId(
        permanentPairId,
        control.generation,
        control.slotToken,
      );
  } catch (error) {
    mapDomainError(error);
  }

  const firstMembershipRef =
    technicianPairMemberships.doc(
      pairTechnicianIds[0],
    );

  const secondMembershipRef =
    technicianPairMemberships.doc(
      pairTechnicianIds[1],
    );

  const authorizationRef =
    nextShiftAuthorizations.doc(
      authorizationDocumentId,
    );

  const attendanceDocumentId =
    `${shiftId}_${actor.uid}`;

  const attendanceRef =
    shiftAttendance.doc(
      attendanceDocumentId,
    );

  const [
    firstMembershipSnapshot,
    secondMembershipSnapshot,
    authorizationSnapshot,
    attendanceSnapshot,
  ] = await Promise.all([
    firstMembershipRef.get(),
    secondMembershipRef.get(),
    authorizationRef.get(),
    attendanceRef.get(),
  ]);

  try {
    return resolveTechnicianCurrentShift({
      technicianUid:
        actor.uid,

      control,

      shift,

      permanentPair:
        pairSnapshot.data(),

      pairMemberships: [
        firstMembershipSnapshot.exists
          ? firstMembershipSnapshot.data()
          : null,

        secondMembershipSnapshot.exists
          ? secondMembershipSnapshot.data()
          : null,
      ],

      authorizationDocumentId:
        authorizationSnapshot.exists
          ? authorizationSnapshot.id
          : null,

      authorization:
        authorizationSnapshot.exists
          ? authorizationSnapshot.data()
          : null,

      attendanceDocumentId:
        attendanceSnapshot.exists
          ? attendanceSnapshot.id
          : null,

      attendance:
        attendanceSnapshot.exists
          ? attendanceSnapshot.data()
          : null,
    });
  } catch (error) {
    mapDomainError(error);
  }
}
