import "server-only";

import type { AppUser, UserRole } from "@/types/auth";

import { getOperationalCollections } from "./collections";

import { ShiftOperationsError } from "./shift-operations-domain";

/**
 * Revalidates the acting account against Firestore for read-only pages.
 * The cached session is never trusted on its own.
 */
export async function requireReadProfile(
  actor: AppUser,
  roles: readonly UserRole[],
): Promise<Record<string, unknown>> {
  const { db } = getOperationalCollections();

  const snapshot = await db.collection("users").doc(actor.uid).get();
  const profile = snapshot.data();

  if (
    !snapshot.exists ||
    !profile ||
    !roles.includes(actor.role) ||
    profile.role !== actor.role ||
    profile.status !== "active" ||
    profile.mustChangePassword === true ||
    profile.statusOperation != null
  ) {
    throw new ShiftOperationsError(
      "This page is not available to your account.",
      403,
    );
  }

  return profile;
}
