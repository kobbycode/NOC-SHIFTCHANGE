import "server-only";

import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  TECHNICIAN_PAIR_STATUSES,
  type TechnicianPair,
} from "@/types/technician-pair";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
  requireEligibleTechnician,
} from "./assignment-transaction";

export interface CreateTechnicianPairInput {
  technicianIds: [string, string];
}

export interface CreateTechnicianPairActor {
  uid: string;
}

function normalizeTechnicianUid(
  technicianUid: string
): string {
  if (
    typeof technicianUid !== "string" ||
    !technicianUid.trim() ||
    technicianUid.includes("/") ||
    technicianUid.length > 128
  ) {
    throw new AssignmentOperationError(
      "Please select two valid technicians.",
      400
    );
  }

  return technicianUid.trim();
}

/**
 * Creates one permanent technician pair.
 *
 * Concurrency invariant:
 * technician_pair_memberships/{technicianUid}
 * is the authoritative active-pair reservation for each
 * technician. Both reservation documents are read and
 * written in the same transaction as the pair.
 *
 * This operation does not create shift attendance,
 * scheduling, assignments, or account-status activity.
 */
export async function createTechnicianPair(
  input: CreateTechnicianPairInput,
  actor: CreateTechnicianPairActor
): Promise<TechnicianPair> {
  if (
    !input ||
    !Array.isArray(input.technicianIds) ||
    input.technicianIds.length !== 2
  ) {
    throw new AssignmentOperationError(
      "Exactly two technicians are required.",
      400
    );
  }

  const firstTechnicianUid =
    normalizeTechnicianUid(
      input.technicianIds[0]
    );

  const secondTechnicianUid =
    normalizeTechnicianUid(
      input.technicianIds[1]
    );

  if (
    firstTechnicianUid ===
    secondTechnicianUid
  ) {
    throw new AssignmentOperationError(
      "A technician cannot be paired with themselves.",
      400
    );
  }

  if (
    !actor ||
    typeof actor.uid !== "string" ||
    !actor.uid.trim() ||
    actor.uid.includes("/") ||
    actor.uid.length > 128
  ) {
    throw new AssignmentOperationError(
      "The acting user is invalid.",
      400
    );
  }

  const {
    db,
    technicianPairs,
    technicianPairMemberships,
  } = getOperationalCollections();

  const pairRef =
    technicianPairs.doc();

  const auditRef = db
    .collection("audit_logs")
    .doc();

  const actorRef = db
    .collection("users")
    .doc(actor.uid.trim());

  const firstMembershipRef =
    technicianPairMemberships.doc(
      firstTechnicianUid
    );

  const secondMembershipRef =
    technicianPairMemberships.doc(
      secondTechnicianUid
    );

  const pairId = pairRef.id;

  const pairTimestamp =
    new Date().toISOString();

  await db.runTransaction(
    async (transaction) => {
      /*
       * Firestore requires transaction reads
       * before transaction writes.
       *
       * Technician eligibility and reservation
       * documents are therefore all read first.
       */

      const actorSnapshot =
        await transaction.get(actorRef);

      await requireEligibleTechnician(
        transaction,
        firstTechnicianUid
      );

      await requireEligibleTechnician(
        transaction,
        secondTechnicianUid
      );

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
          "Your account is not authorized to create technician pairs.",
          403
        );
      }

      if (firstMembershipSnapshot.exists) {
        throw new AssignmentOperationError(
          "The first technician already belongs to an active permanent pair.",
          409
        );
      }

      if (secondMembershipSnapshot.exists) {
        throw new AssignmentOperationError(
          "The second technician already belongs to an active permanent pair.",
          409
        );
      }

      const now =
        pairTimestamp;

      /*
       * Coordinate this privileged operational
       * mutation with concurrent account-status
       * operations using the same actor document
       * contention pattern as shift creation.
       *
       * This records operational activity only.
       * It does not change account status and does
       * not mark either technician as assigned.
       */
      transaction.update(actorRef, {
        lastOperationalActivityAt:
          FieldValue.serverTimestamp(),
      });

      transaction.create(
        pairRef,
        {
          id: pairId,

          technicianIds: [
            firstTechnicianUid,
            secondTechnicianUid,
          ],

          status:
            TECHNICIAN_PAIR_STATUSES.ACTIVE,

          createdBy: actor.uid.trim(),

          createdAt: now,
          updatedAt: now,

          deactivatedAt: null,
          deactivatedBy: null,
        }
      );

      transaction.create(
        firstMembershipRef,
        {
          technicianUid:
            firstTechnicianUid,

          pairId,

          createdAt: now,
          updatedAt: now,
        }
      );

      transaction.create(
        secondMembershipRef,
        {
          technicianUid:
            secondTechnicianUid,

          pairId,

          createdAt: now,
          updatedAt: now,
        }
      );

      /*
       * Record permanent pair creation in the same
       * transaction as the pair and both active-pair
       * reservations.
       *
       * Pair membership is organizational configuration.
       * This audit event does not create attendance,
       * assignment responsibility, or account status.
       */
      transaction.create(
        auditRef,
        {
          id: auditRef.id,

          action: "TECHNICIAN_PAIR_CREATED",

          actorUid: actor.uid.trim(),

          targetTechnicianPairId: pairId,

          technicianIds: [
            firstTechnicianUid,
            secondTechnicianUid,
          ],

          details:
            "An authorized user created a permanent technician pair.",

          createdAt:
            FieldValue.serverTimestamp(),
        }
      );
    }
  );

  const now =
    pairTimestamp;

  /*
   * Return the public pair shape.
   *
   * Pair and membership timestamps use the same
   * public ISO timestamp established before the
   * transaction. The audit event independently uses
   * a server-generated Firestore timestamp.
   */
  return {
    id: pairId,

    technicianIds: [
      firstTechnicianUid,
      secondTechnicianUid,
    ],

    status:
      TECHNICIAN_PAIR_STATUSES.ACTIVE,

    createdBy: actor.uid.trim(),

    createdAt: now,
    updatedAt: now,

    deactivatedAt: null,
    deactivatedBy: null,
  };
}
