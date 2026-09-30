import "server-only";

import type {
  TechnicianPair,
  TechnicianPairStatus,
} from "@/types/technician-pair";

import {
  TECHNICIAN_PAIR_STATUSES,
} from "@/types/technician-pair";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

import {
  addTechnicianPairMembers,
  type TechnicianPairWithTechnicians,
} from "@/lib/technician-pairs/technician-pair-display";

export interface ListTechnicianPairsActor {
  uid: string;
  role: string;
}

function normalizeActorUid(
  uid: string
): string {
  if (
    typeof uid !== "string" ||
    !uid.trim() ||
    uid.includes("/") ||
    uid.length > 128
  ) {
    throw new AssignmentOperationError(
      "The acting user is invalid.",
      400
    );
  }

  return uid.trim();
}

function isTechnicianPairStatus(
  value: unknown
): value is TechnicianPairStatus {
  return (
    value ===
      TECHNICIAN_PAIR_STATUSES.ACTIVE ||
    value ===
      TECHNICIAN_PAIR_STATUSES.INACTIVE
  );
}

function readRequiredString(
  value: unknown,
  fieldName: string
): string {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new AssignmentOperationError(
      `A technician pair contains invalid ${fieldName} information.`,
      409
    );
  }

  return value;
}

function readNullableString(
  value: unknown,
  fieldName: string
): string | null {
  if (value === null) {
    return null;
  }

  return readRequiredString(
    value,
    fieldName
  );
}

/**
 * Authoritatively list permanent technician
 * pairs visible to an administrator or
 * supervisor.
 *
 * This service returns pair-domain data only.
 * Pair membership does not prove attendance
 * on any shift.
 */
export async function listTechnicianPairs(
  actor: ListTechnicianPairsActor
): Promise<TechnicianPairWithTechnicians[]> {
  const actorUid =
    normalizeActorUid(actor.uid);

  if (
    actor.role !== "admin" &&
    actor.role !== "supervisor"
  ) {
    throw new AssignmentOperationError(
      "You are not authorized to retrieve technician pairs.",
      403
    );
  }

  const {
    db,
    technicianPairs,
  } = getOperationalCollections();

  /*
   * Revalidate the acting account against
   * authoritative Firestore state rather
   * than trusting the session role alone.
   */
  const actorSnapshot =
    await db
      .collection("users")
      .doc(actorUid)
      .get();

  const authoritativeActor =
    actorSnapshot.data();

  if (
    !actorSnapshot.exists ||
    !authoritativeActor ||
    authoritativeActor.status !== "active" ||
    authoritativeActor.statusOperation != null ||
    authoritativeActor.mustChangePassword === true ||
    authoritativeActor.role !== actor.role ||
    !["admin", "supervisor"].includes(
      authoritativeActor.role
    )
  ) {
    throw new AssignmentOperationError(
      "Your account is not authorized to retrieve technician pairs.",
      403
    );
  }

  const snapshot =
    await technicianPairs.get();

  const pairs =
    snapshot.docs.map(
      (document): TechnicianPair => {
        const data =
          document.data();

        if (
          data.id !== document.id ||
          !Array.isArray(
            data.technicianIds
          ) ||
          data.technicianIds.length !== 2 ||
          typeof data.technicianIds[0] !==
            "string" ||
          !data.technicianIds[0].trim() ||
          data.technicianIds[0].includes("/") ||
          data.technicianIds[0].length > 128 ||
          typeof data.technicianIds[1] !==
            "string" ||
          !data.technicianIds[1].trim() ||
          data.technicianIds[1].includes("/") ||
          data.technicianIds[1].length > 128 ||
          data.technicianIds[0] ===
            data.technicianIds[1] ||
          !isTechnicianPairStatus(
            data.status
          )
        ) {
          throw new AssignmentOperationError(
            "A technician pair contains invalid structural information.",
            409
          );
        }

        const createdAt =
          readRequiredString(
            data.createdAt,
            "creation timestamp"
          );

        const updatedAt =
          readRequiredString(
            data.updatedAt,
            "update timestamp"
          );

        if (
          Number.isNaN(
            Date.parse(createdAt)
          ) ||
          Number.isNaN(
            Date.parse(updatedAt)
          )
        ) {
          throw new AssignmentOperationError(
            "A technician pair contains invalid timestamp information.",
            409
          );
        }

        const deactivatedAt =
          readNullableString(
            data.deactivatedAt,
            "deactivation timestamp"
          );

        if (
          deactivatedAt !== null &&
          Number.isNaN(
            Date.parse(deactivatedAt)
          )
        ) {
          throw new AssignmentOperationError(
            "A technician pair contains invalid deactivation timestamp information.",
            409
          );
        }

        const deactivatedBy =
          readNullableString(
            data.deactivatedBy,
            "deactivation actor"
          );

        if (
          data.status ===
            TECHNICIAN_PAIR_STATUSES.ACTIVE &&
          (
            deactivatedAt !== null ||
            deactivatedBy !== null
          )
        ) {
          throw new AssignmentOperationError(
            "An active technician pair contains inconsistent deactivation information.",
            409
          );
        }

        if (
          data.status ===
            TECHNICIAN_PAIR_STATUSES.INACTIVE &&
          (
            deactivatedAt === null ||
            deactivatedBy === null
          )
        ) {
          throw new AssignmentOperationError(
            "An inactive technician pair contains incomplete deactivation information.",
            409
          );
        }

        return {
          id: document.id,

          technicianIds: [
            data.technicianIds[0],
            data.technicianIds[1],
          ],

          status: data.status,

          createdBy:
            readRequiredString(
              data.createdBy,
              "creation actor"
            ),

          createdAt,
          updatedAt,

          deactivatedAt,
          deactivatedBy,
        };
      }
    );

  /*
   * Active pairs first, then newest
   * pair creation first within each
   * status group.
   */
  pairs.sort(
    (first, second) => {
      if (
        first.status !==
        second.status
      ) {
        if (
          first.status ===
          TECHNICIAN_PAIR_STATUSES.ACTIVE
        ) {
          return -1;
        }

        return 1;
      }

      return (
        Date.parse(
          second.createdAt
        ) -
        Date.parse(
          first.createdAt
        )
      );
    }
  );

  const technicianUids = Array.from(
    new Set(
      pairs.flatMap(
        (pair) => pair.technicianIds
      )
    )
  );

  const technicianSnapshots =
    technicianUids.length > 0
      ? await db.getAll(
          ...technicianUids.map(
            (uid) =>
              db
                .collection("users")
                .doc(uid)
          )
        )
      : [];

  const technicianProfiles = new Map<
    string,
    { fullName?: unknown }
  >();

  for (const snapshot of technicianSnapshots) {
    const profile = snapshot.data();

    if (
      snapshot.exists &&
      profile?.role === "technician"
    ) {
      technicianProfiles.set(
        snapshot.id,
        profile
      );
    }
  }

  return addTechnicianPairMembers(
    pairs,
    technicianProfiles
  );
}