import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  getOperationalCollections,
} from "./collections";

import type {
  AppUser,
} from "@/types/auth";

import type {
  Shift,
} from "@/types/shift";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

export interface ListShiftsResult {
  shifts: Shift[];
  total: number;
}

/**
 * Authoritative, read-only shift retrieval.
 *
 * Administrators and supervisors can
 * retrieve operational shifts.
 *
 * The acting account is revalidated
 * against Firestore before shift data
 * is returned.
 *
 * The returned Shift objects are an
 * explicit public read model. Internal
 * Firestore metadata such as server
 * Timestamp fields is not exposed.
 *
 * Permanent revocation remains disabled.
 */
export async function listShifts(
  actor: AppUser
): Promise<ListShiftsResult> {
  const db = getAdminFirestore();

  const {
    shifts,
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
      "Your account is not authorized to retrieve shifts.",
      403
    );
  }

  if (
    actor.role !== "admin" &&
    actor.role !== "supervisor"
  ) {
    throw new AssignmentOperationError(
      "You are not authorized to retrieve shifts.",
      403
    );
  }

  /*
   * PHASE 2:
   * Retrieve authoritative shift data.
   */
  const shiftSnapshot =
    await shifts.get();

  /*
   * PHASE 3:
   * Project Firestore documents into the
   * canonical public Shift read model.
   *
   * Do not spread document.data() here.
   * Shift lifecycle operations also store
   * internal server Timestamp metadata,
   * which must remain server-side.
   */
  const results: Shift[] =
    shiftSnapshot.docs.map(
      (document) => {
        const data = document.data();

        return {
          id: document.id,

          shiftType: data.shiftType,
          status: data.status,

          scheduledStart:
            data.scheduledStart,
          scheduledEnd:
            data.scheduledEnd,

          actualStart:
            data.actualStart ?? null,
          actualEnd:
            data.actualEnd ?? null,

          primaryTechnicianIds:
            Array.isArray(
              data.primaryTechnicianIds
            )
              ? data.primaryTechnicianIds
              : [],

          createdBy:
            data.createdBy,

          createdAt:
            data.createdAt,
          updatedAt:
            data.updatedAt,
        } as Shift;
      }
    );

  /*
   * Keep the newest scheduled shifts first.
   *
   * scheduledStart is stored as a UTC ISO
   * date-time string, so lexical ordering
   * is chronological for canonical values.
   */
  results.sort(
    (a, b) =>
      b.scheduledStart.localeCompare(
        a.scheduledStart
      )
  );

  return {
    shifts: results,
    total: results.length,
  };
}
