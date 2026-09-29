import "server-only";

import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  AccountOperationalError,
  requireSafeAccountBlocking,
} from "@/lib/accounts/account-status-eligibility";

import {
  TECHNICIAN_PAIR_STATUSES,
  type TechnicianPair,
} from "@/types/technician-pair";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

export interface DeactivateTechnicianPairInput {
  pairId: string;
}

export interface DeactivateTechnicianPairActor {
  uid: string;
}

function normalizeIdentifier(
  value: string,
  message: string
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("/") ||
    value.length > 128
  ) {
    throw new AssignmentOperationError(
      message,
      400
    );
  }

  return value.trim();
}

function requireTechnicianIds(
  value: unknown
): [string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new AssignmentOperationError(
      "The technician pair record requires administrator review.",
      409
    );
  }

  const firstTechnicianUid =
    normalizeIdentifier(
      value[0],
      "The technician pair record requires administrator review."
    );

  const secondTechnicianUid =
    normalizeIdentifier(
      value[1],
      "The technician pair record requires administrator review."
    );

  if (
    firstTechnicianUid ===
    secondTechnicianUid
  ) {
    throw new AssignmentOperationError(
      "The technician pair record requires administrator review.",
      409
    );
  }

  return [
    firstTechnicianUid,
    secondTechnicianUid,
  ];
}

/**
 * Deactivates one permanent technician pair.
 *
 * Concurrency invariant:
 * technician_pair_memberships/{technicianUid}
 * is the authoritative active-pair reservation.
 *
 * The pair remains as historical organizational data,
 * while both active-pair reservations are released in
 * the same transaction.
 *
 * Deactivation is blocked while either technician has
 * protected operational responsibility.
 *
 * This operation does not create or alter attendance,
 * shifts, task responsibility, or technician account
 * status.
 */
export async function deactivateTechnicianPair(
  input: DeactivateTechnicianPairInput,
  actor: DeactivateTechnicianPairActor
): Promise<TechnicianPair> {
  if (!input) {
    throw new AssignmentOperationError(
      "Please select a valid technician pair.",
      400
    );
  }

  const pairId =
    normalizeIdentifier(
      input.pairId,
      "Please select a valid technician pair."
    );

  if (!actor) {
    throw new AssignmentOperationError(
      "The acting user is invalid.",
      400
    );
  }

  const actorUid =
    normalizeIdentifier(
      actor.uid,
      "The acting user is invalid."
    );

  const {
    db,
    technicianPairs,
    technicianPairMemberships,
  } = getOperationalCollections();

  const pairRef =
    technicianPairs.doc(pairId);

  const actorRef = db
    .collection("users")
    .doc(actorUid);

  const auditRef = db
    .collection("audit_logs")
    .doc();

  const pairTimestamp =
    new Date().toISOString();

  let deactivatedPair:
    TechnicianPair | null = null;

  await db.runTransaction(
    async (transaction) => {
      /*
       * PHASE 1:
       * Read the actor and pair before writes.
       */

      const [
        actorSnapshot,
        pairSnapshot,
      ] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(pairRef),
      ]);

      const authoritativeActor =
        actorSnapshot.data();

      if (
        !actorSnapshot.exists ||
        !authoritativeActor ||
        authoritativeActor.status !== "active" ||
        authoritativeActor.statusOperation != null ||
        authoritativeActor.mustChangePassword === true ||
        !["admin", "supervisor"].includes(
          authoritativeActor.role
        )
      ) {
        throw new AssignmentOperationError(
          "Your account is not authorized to deactivate technician pairs.",
          403
        );
      }

      if (!pairSnapshot.exists) {
        throw new AssignmentOperationError(
          "The technician pair was not found.",
          404
        );
      }

      const pair =
        pairSnapshot.data();

      if (!pair) {
        throw new AssignmentOperationError(
          "The technician pair record requires administrator review.",
          409
        );
      }

      if (pair.id !== pairId) {
        throw new AssignmentOperationError(
          "The technician pair record requires administrator review.",
          409
        );
      }

      if (
        pair.status !==
        TECHNICIAN_PAIR_STATUSES.ACTIVE
      ) {
        throw new AssignmentOperationError(
          "Only an active technician pair can be deactivated.",
          409
        );
      }

      if (
        pair.deactivatedAt !== null ||
        pair.deactivatedBy !== null
      ) {
        throw new AssignmentOperationError(
          "The technician pair record requires administrator review.",
          409
        );
      }

      const [
        firstTechnicianUid,
        secondTechnicianUid,
      ] = requireTechnicianIds(
        pair.technicianIds
      );

      /*
       * Historical pair metadata is authoritative.
       * Do not silently normalize malformed history.
       */

      if (
        typeof pair.createdBy !== "string" ||
        !pair.createdBy.trim() ||
        typeof pair.createdAt !== "string" ||
        !pair.createdAt.trim()
      ) {
        throw new AssignmentOperationError(
          "The technician pair record requires administrator review.",
          409
        );
      }

      const createdBy =
        pair.createdBy.trim();

      const createdAt =
        pair.createdAt.trim();

      const firstMembershipRef =
        technicianPairMemberships.doc(
          firstTechnicianUid
        );

      const secondMembershipRef =
        technicianPairMemberships.doc(
          secondTechnicianUid
        );

      /*
       * PHASE 2:
       * Read and validate both deterministic
       * active-pair reservations.
       */

      const [
        firstMembershipSnapshot,
        secondMembershipSnapshot,
      ] = await Promise.all([
        transaction.get(
          firstMembershipRef
        ),
        transaction.get(
          secondMembershipRef
        ),
      ]);

      const firstMembership =
        firstMembershipSnapshot.data();

      const secondMembership =
        secondMembershipSnapshot.data();

      if (
        !firstMembershipSnapshot.exists ||
        !firstMembership ||
        firstMembership.technicianUid !==
          firstTechnicianUid ||
        firstMembership.pairId !== pairId
      ) {
        throw new AssignmentOperationError(
          "The first technician's pair reservation requires administrator review.",
          409
        );
      }

      if (
        !secondMembershipSnapshot.exists ||
        !secondMembership ||
        secondMembership.technicianUid !==
          secondTechnicianUid ||
        secondMembership.pairId !== pairId
      ) {
        throw new AssignmentOperationError(
          "The second technician's pair reservation requires administrator review.",
          409
        );
      }

      /*
       * PHASE 3:
       * Require both technicians to be free of
       * protected shift, handover, and unfinished
       * task responsibility before releasing the pair.
       *
       * The existing account-blocking guard is reused
       * for its authoritative responsibility inspection.
       * Pair membership itself is not part of that guard.
       */

      try {
        await requireSafeAccountBlocking(
          transaction,
          firstTechnicianUid
        );

        await requireSafeAccountBlocking(
          transaction,
          secondTechnicianUid
        );
      } catch (error) {
        if (
          error instanceof
          AccountOperationalError
        ) {
          throw new AssignmentOperationError(
            "This technician pair cannot be deactivated while either technician has a scheduled or active shift, an unfinished handover, or active responsibility for an unfinished task. Complete or reassign those duties first.",
            error.status
          );
        }

        throw error;
      }

      /*
       * PHASE 4:
       * All authoritative reads and guards passed.
       * Perform the pair lifecycle mutation atomically.
       *
       * Historical pair data remains intact.
       * Only the active-pair reservations are released.
       */

      const now =
        pairTimestamp;

      transaction.update(actorRef, {
        lastOperationalActivityAt:
          FieldValue.serverTimestamp(),
      });

      transaction.update(pairRef, {
        status:
          TECHNICIAN_PAIR_STATUSES.INACTIVE,

        updatedAt: now,

        deactivatedAt: now,
        deactivatedBy: actorUid,
      });

      transaction.delete(
        firstMembershipRef
      );

      transaction.delete(
        secondMembershipRef
      );

      transaction.create(
        auditRef,
        {
          id: auditRef.id,

          action:
            "TECHNICIAN_PAIR_DEACTIVATED",

          actorUid,

          targetTechnicianPairId:
            pairId,

          technicianIds: [
            firstTechnicianUid,
            secondTechnicianUid,
          ],

          details:
            "An authorized user deactivated a permanent technician pair.",

          createdAt:
            FieldValue.serverTimestamp(),
        }
      );

      deactivatedPair = {
        id: pairId,

        technicianIds: [
          firstTechnicianUid,
          secondTechnicianUid,
        ],

        status:
          TECHNICIAN_PAIR_STATUSES.INACTIVE,

        createdBy,

        createdAt,

        updatedAt: now,

        deactivatedAt: now,
        deactivatedBy: actorUid,
      };
    }
  );

  if (!deactivatedPair) {
    throw new AssignmentOperationError(
      "The technician pair could not be deactivated.",
      500
    );
  }

  return deactivatedPair;
}