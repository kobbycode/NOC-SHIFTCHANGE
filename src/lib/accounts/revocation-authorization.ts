
import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  type AppUser,
  isUserRole,
} from "@/types/auth";

export class RevocationAuthorizationError
  extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);

    this.name = "RevocationAuthorizationError";
  }
}

export interface RevocationAuthorizationResult {
  actorUid: string;
  targetUid: string;
  targetRole: AppUser["role"];
  reason: string;
}

export async function authorizeRevocation(
  actor: AppUser | null,
  targetUid: string,
  reason: string
): Promise<RevocationAuthorizationResult> {
  if (!actor) {
    throw new RevocationAuthorizationError(
      "Please sign in to continue.",
      401
    );
  }

  if (
    actor.role !== "admin" ||
    actor.status !== "active" ||
    actor.mustChangePassword
  ) {
    throw new RevocationAuthorizationError(
      "Your administrator account is not authorized to perform this action.",
      403
    );
  }

  if (
    !targetUid ||
    targetUid.includes("/") ||
    targetUid.length > 128
  ) {
    throw new RevocationAuthorizationError(
      "Please select a valid user account.",
      400
    );
  }

  const normalizedReason = reason.trim();

  if (
    normalizedReason.length < 10 ||
    normalizedReason.length > 500
  ) {
    throw new RevocationAuthorizationError(
      "Please provide a reason between 10 and 500 characters.",
      400
    );
  }

  if (actor.uid === targetUid) {
    throw new RevocationAuthorizationError(
      "You cannot revoke your own account.",
      403
    );
  }

  const db = getAdminFirestore();

  const [
    actorSnapshot,
    targetSnapshot,
    bootstrapSnapshot,
  ] = await Promise.all([
    db.collection("users").doc(actor.uid).get(),

    db.collection("users").doc(targetUid).get(),

    db.doc("system/bootstrap_admin").get(),
  ]);

  const actorProfile = actorSnapshot.data();
  const targetProfile = targetSnapshot.data();
  const bootstrapProfile = bootstrapSnapshot.data();

  if (
    !actorSnapshot.exists ||
    actorProfile?.role !== "admin" ||
    actorProfile.status !== "active" ||
    actorProfile.mustChangePassword === true ||
    actorProfile.statusOperation
  ) {
    throw new RevocationAuthorizationError(
      "Your administrator account is unavailable.",
      403
    );
  }

  if (!bootstrapSnapshot.exists) {
    throw new RevocationAuthorizationError(
      "The original administrator record is unavailable. Account revocation cannot continue.",
      503
    );
  }

  const originalAdminUid =
    bootstrapProfile?.initialAdminUid;

  if (
    typeof originalAdminUid !== "string" ||
    !originalAdminUid
  ) {
    throw new RevocationAuthorizationError(
      "The original administrator record is invalid. Account revocation cannot continue.",
      503
    );
  }

  if (targetUid === originalAdminUid) {
    throw new RevocationAuthorizationError(
      "The original administrator account cannot be revoked.",
      403
    );
  }

  if (!targetSnapshot.exists || !targetProfile) {
    throw new RevocationAuthorizationError(
      "The selected user account was not found.",
      404
    );
  }

  if (!isUserRole(targetProfile.role)) {
    throw new RevocationAuthorizationError(
      "The selected account has an invalid role.",
      409
    );
  }

  if (targetProfile.status === "revoked") {
    throw new RevocationAuthorizationError(
      "This account has already been permanently revoked.",
      409
    );
  }

  if (
    targetProfile.status !== "active" &&
    targetProfile.status !== "blocked"
  ) {
    throw new RevocationAuthorizationError(
      "The selected account has an invalid status.",
      409
    );
  }

  if (targetProfile.statusOperation) {
    throw new RevocationAuthorizationError(
      "Another account-management operation is already in progress.",
      409
    );
  }

  if (
    targetProfile.role === "admin" &&
    actor.uid !== originalAdminUid
  ) {
    throw new RevocationAuthorizationError(
      "Only the original administrator can revoke another administrator.",
      403
    );
  }

  return {
    actorUid: actor.uid,
    targetUid,
    targetRole: targetProfile.role,
    reason: normalizedReason,
  };
}