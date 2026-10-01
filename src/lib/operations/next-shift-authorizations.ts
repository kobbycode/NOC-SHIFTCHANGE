import "server-only";

import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  getOperationalCollections,
  GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
} from "./collections";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

import {
  evaluateAssignmentEligibility,
} from "./assignment-eligibility";

import {
  assertOperationalShiftControl,
} from "./operational-shift-control-state";

import {
  assertNextShiftAuthorization,
  buildNextShiftAuthorizationAuditData,
  buildPendingNextShiftAuthorization,
  createNextShiftAuthorizationDocumentId,
  NextShiftAuthorizationDomainError,
  parseCreateNextShiftAuthorizationInput,
  type CreateNextShiftAuthorizationInput,
} from "./next-shift-authorization-domain";

import type {
  AppUser,
} from "@/types/auth";

import type {
  NextShiftAuthorization,
} from "@/types/next-shift-authorization";

export interface NextShiftAuthorizationActor {
  uid: string;
  role: string;
}

export interface ListCurrentNextShiftAuthorizationsResult {
  currentSlot: {
    slotToken: string;
    generation: number;
    slotStatus: "pending" | "consumed";
    shiftId: string | null;
  };
  authorizations: NextShiftAuthorization[];
  total: number;
}

function rethrowDomainError(error: unknown): never {
  if (error instanceof NextShiftAuthorizationDomainError) {
    throw new AssignmentOperationError(
      error.message,
      error.status
    );
  }

  throw error;
}

function requireManagerActor(
  actor: NextShiftAuthorizationActor
): string {
  if (
    !actor ||
    typeof actor.uid !== "string" ||
    !actor.uid.trim() ||
    actor.uid.includes("/") ||
    actor.uid.length > 128 ||
    (actor.role !== "admin" &&
      actor.role !== "supervisor")
  ) {
    throw new AssignmentOperationError(
      "You are not authorized to manage next-shift authorizations.",
      403
    );
  }

  return actor.uid.trim();
}

function validateAuthoritativeManager(
  actorSnapshot: {
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
  },
  expectedRole: string
): void {
  const profile = actorSnapshot.data();

  if (
    !actorSnapshot.exists ||
    !profile ||
    profile.status !== "active" ||
    profile.statusOperation != null ||
    profile.mustChangePassword === true ||
    profile.role !== expectedRole ||
    !["admin", "supervisor"].includes(
      profile.role as string
    )
  ) {
    throw new AssignmentOperationError(
      "Your account is not authorized to manage next-shift authorizations.",
      403
    );
  }
}

function readPairTechnicianIds(
  pair: Record<string, unknown> | undefined,
  pairId: string
): [string, string] {
  const technicianIds = pair?.technicianIds;

  if (
    !pair ||
    pair.id !== pairId ||
    pair.status !== "active" ||
    !Array.isArray(technicianIds) ||
    technicianIds.length !== 2 ||
    technicianIds.some(
      (uid) =>
        typeof uid !== "string" ||
        !uid.trim() ||
        uid.includes("/") ||
        uid.length > 128
    ) ||
    technicianIds[0] === technicianIds[1]
  ) {
    throw new AssignmentOperationError(
      "The selected permanent technician pair is unavailable or requires administrator review.",
      409
    );
  }

  return [technicianIds[0], technicianIds[1]];
}

function readAuthorizationControl(
  value: unknown
) {
  try {
    const control = assertOperationalShiftControl(value);

    if (
      control.slotStatus !== "pending" ||
      control.shiftId !== null ||
      control.shiftStatus !== null
    ) {
      throw new Error("not-pending");
    }

    return control;
  } catch {
    throw new AssignmentOperationError(
      "Temporary authorizations can only be created for the current pending global shift slot.",
      409
    );
  }
}

export async function createNextShiftAuthorization(
  input: unknown,
  actor: NextShiftAuthorizationActor
): Promise<NextShiftAuthorization> {
  const actorUid = requireManagerActor(actor);

  let normalizedInput: CreateNextShiftAuthorizationInput;

  try {
    normalizedInput =
      parseCreateNextShiftAuthorizationInput(input);
  } catch (error) {
    rethrowDomainError(error);
  }

  const {
    db,
    operationalShiftControl,
    technicianPairs,
    technicianPairMemberships,
    nextShiftAuthorizations,
  } = getOperationalCollections();

  const actorRef = db
    .collection("users")
    .doc(actorUid);
  const controlRef = operationalShiftControl.doc(
    GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID
  );
  const pairRef = technicianPairs.doc(
    normalizedInput.permanentPairId
  );
  const technicianRef = db
    .collection("users")
    .doc(normalizedInput.authorizedTechnicianUid);
  const auditRef = db
    .collection("audit_logs")
    .doc();
  const now = new Date().toISOString();

  return db.runTransaction(
    async (transaction) => {
      const [
        actorSnapshot,
        controlSnapshot,
        pairSnapshot,
        technicianSnapshot,
      ] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(controlRef),
        transaction.get(pairRef),
        transaction.get(technicianRef),
      ]);

      validateAuthoritativeManager(
        actorSnapshot,
        actor.role
      );

      if (!controlSnapshot.exists) {
        throw new AssignmentOperationError(
          "The global operational shift-control record is unavailable.",
          409
        );
      }

      const control = readAuthorizationControl(
        controlSnapshot.data()
      );

      if (!pairSnapshot.exists) {
        throw new AssignmentOperationError(
          "The selected permanent technician pair was not found.",
          404
        );
      }

      const pair = pairSnapshot.data();
      const [firstTechnicianUid, secondTechnicianUid] =
        readPairTechnicianIds(
          pair,
          normalizedInput.permanentPairId
        );

      if (
        normalizedInput.authorizedTechnicianUid ===
          firstTechnicianUid ||
        normalizedInput.authorizedTechnicianUid ===
          secondTechnicianUid
      ) {
        throw new AssignmentOperationError(
          "A permanent pair member cannot be authorized as its temporary technician.",
          409
        );
      }

      const firstMembershipRef =
        technicianPairMemberships.doc(
          firstTechnicianUid
        );
      const secondMembershipRef =
        technicianPairMemberships.doc(
          secondTechnicianUid
        );

      const [
        firstMembershipSnapshot,
        secondMembershipSnapshot,
      ] = await Promise.all([
        transaction.get(firstMembershipRef),
        transaction.get(secondMembershipRef),
      ]);

      const firstMembership =
        firstMembershipSnapshot.data();
      const secondMembership =
        secondMembershipSnapshot.data();

      if (
        !firstMembershipSnapshot.exists ||
        firstMembership?.technicianUid !==
          firstTechnicianUid ||
        firstMembership?.pairId !== pairSnapshot.id ||
        !secondMembershipSnapshot.exists ||
        secondMembership?.technicianUid !==
          secondTechnicianUid ||
        secondMembership?.pairId !== pairSnapshot.id
      ) {
        throw new AssignmentOperationError(
          "The selected permanent pair reservations require administrator review.",
          409
        );
      }

      const technicianProfile =
        technicianSnapshot.data();
      const eligibility =
        evaluateAssignmentEligibility(
          technicianSnapshot.exists
            ? technicianProfile
            : undefined
        );

      const authorizationId =
        createNextShiftAuthorizationDocumentId(
          normalizedInput.permanentPairId,
          control.generation,
          control.slotToken
        );
      const authorizationRef =
        nextShiftAuthorizations.doc(
          authorizationId
        );
      const existingAuthorizationSnapshot =
        await transaction.get(authorizationRef);

      if (existingAuthorizationSnapshot.exists) {
        throw new AssignmentOperationError(
          "A temporary authorization already exists for this pair and global shift slot.",
          409
        );
      }

      let authorization: NextShiftAuthorization;

      try {
        authorization =
          buildPendingNextShiftAuthorization({
            control,
            pair,
            permanentPairId:
              normalizedInput.permanentPairId,
            authorizedTechnicianUid:
              normalizedInput.authorizedTechnicianUid,
            technicianEligibility: eligibility,
            createdBy: actorUid,
            createdAt: now,
          });
      } catch (error) {
        rethrowDomainError(error);
      }

      transaction.update(actorRef, {
        lastOperationalActivityAt:
          FieldValue.serverTimestamp(),
      });

      transaction.create(
        authorizationRef,
        authorization
      );

      transaction.create(
        auditRef,
        buildNextShiftAuthorizationAuditData(
          authorization,
          actorUid,
          auditRef.id,
          FieldValue.serverTimestamp()
        )
      );

      return authorization;
    }
  );
}

export async function listCurrentNextShiftAuthorizations(
  actor: AppUser
): Promise<ListCurrentNextShiftAuthorizationsResult> {
  if (
    (actor.role !== "admin" &&
      actor.role !== "supervisor") ||
    actor.mustChangePassword
  ) {
    throw new AssignmentOperationError(
      "You are not authorized to retrieve next-shift authorizations.",
      403
    );
  }

  const {
    db,
    operationalShiftControl,
    nextShiftAuthorizations,
  } = getOperationalCollections();
  const actorRef = db
    .collection("users")
    .doc(actor.uid);
  const controlRef = operationalShiftControl.doc(
    GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID
  );

  return db.runTransaction(
    async (transaction) => {
      const [actorSnapshot, controlSnapshot] =
        await Promise.all([
          transaction.get(actorRef),
          transaction.get(controlRef),
        ]);

      validateAuthoritativeManager(
        actorSnapshot,
        actor.role
      );

      if (!controlSnapshot.exists) {
        throw new AssignmentOperationError(
          "The global operational shift-control record is unavailable.",
          409
        );
      }

      let control;

      try {
        control = assertOperationalShiftControl(
          controlSnapshot.data()
        );
      } catch {
        throw new AssignmentOperationError(
          "The global operational shift-control record requires administrator review.",
          409
        );
      }

      const authorizationSnapshot =
        await transaction.get(
          nextShiftAuthorizations
            .where("slotToken", "==", control.slotToken)
            .where(
              "slotGeneration",
              "==",
              control.generation
            )
        );

      const authorizations =
        authorizationSnapshot.docs.map(
          (document) => {
            let authorization: NextShiftAuthorization;

            try {
              authorization =
                assertNextShiftAuthorization(
                  document.data()
                );
            } catch (error) {
              rethrowDomainError(error);
            }

            if (authorization.id !== document.id) {
              throw new AssignmentOperationError(
                "A next-shift authorization record requires administrator review.",
                409
              );
            }

            return authorization;
          }
        );

      authorizations.sort(
        (first, second) =>
          first.createdAt.localeCompare(
            second.createdAt
          )
      );

      return {
        currentSlot: {
          slotToken: control.slotToken,
          generation: control.generation,
          slotStatus: control.slotStatus,
          shiftId: control.shiftId,
        },
        authorizations,
        total: authorizations.length,
      };
    }
  );
}