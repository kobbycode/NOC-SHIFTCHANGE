import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

import type {
  AppUser,
} from "@/types/auth";

import type {
  ShiftMember,
} from "@/types/shift";

export interface ListShiftMembersResult {
  members: ShiftMember[];
  total: number;
}

/**
 * Authoritative, read-only shift-membership
 * retrieval.
 *
 * Administrators and supervisors can retrieve
 * membership records for an operational shift.
 *
 * The acting account is revalidated against
 * Firestore before membership data is returned.
 *
 * Permanent revocation remains disabled.
 */
export async function listShiftMembers(
  actor: AppUser,
  shiftId: string,
): Promise<ListShiftMembersResult> {
  if (
    !shiftId ||
    shiftId.includes("/") ||
    shiftId.length > 512
  ) {
    throw new AssignmentOperationError(
      "Please provide a valid shift identifier.",
      400
    );
  }

  const db = getAdminFirestore();

  const {
    shifts,
    shiftMembers,
  } = getOperationalCollections();

  /*
   * PHASE 1:
   * Revalidate the acting account.
   */
  const actorSnapshot = await db
    .collection("users")
    .doc(actor.uid)
    .get();

  const profile = actorSnapshot.data();

  if (
    !actorSnapshot.exists ||
    !profile ||
    profile.status !== "active" ||
    profile.statusOperation != null ||
    profile.mustChangePassword === true ||
    profile.role !== actor.role
  ) {
    throw new AssignmentOperationError(
      "Your account is not authorized to retrieve shift memberships.",
      403
    );
  }

  if (
    actor.role !== "admin" &&
    actor.role !== "supervisor"
  ) {
    throw new AssignmentOperationError(
      "You are not authorized to retrieve shift memberships.",
      403
    );
  }

  /*
   * PHASE 2:
   * Require the selected shift to exist.
   */
  const shiftSnapshot =
    await shifts.doc(shiftId).get();

  if (!shiftSnapshot.exists) {
    throw new AssignmentOperationError(
      "The selected shift was not found.",
      404
    );
  }

  /*
   * PHASE 3:
   * Retrieve membership records belonging
   * to the selected shift.
   */
  const memberSnapshot =
    await shiftMembers
      .where("shiftId", "==", shiftId)
      .get();

  /*
   * PHASE 4:
   * Project Firestore records into the
   * canonical public ShiftMember model.
   */
  const members: ShiftMember[] =
    memberSnapshot.docs.map(
      (document) => {
        const data = document.data();

        return {
          id: document.id,
          shiftId: data.shiftId,
          technicianId:
            data.technicianId,
          role: data.role,
          joinedAt: data.joinedAt,
          leftAt:
            data.leftAt ?? null,
        } as ShiftMember;
      }
    );

  members.sort(
    (a, b) => {
      if (a.role !== b.role) {
        return a.role === "primary"
          ? -1
          : 1;
      }

      return a.joinedAt.localeCompare(
        b.joinedAt
      );
    }
  );

  return {
    members,
    total: members.length,
  };
}
