import "server-only";

import type { Auth } from "firebase-admin/auth";
import { getAdminAuth } from "@/lib/firebase/admin";
import * as domain from "@/lib/accounts/account-provisioning-domain";
import * as keys from "@/lib/accounts/reservation-key";
import {
  createAuthProvisioningAdapter as createAdapterCore,
  type AuthProvisioningAdapterDependencies,
} from "@/lib/accounts/auth-provisioning-adapter-core";

export type {
  ApplyRoleClaimsResult,
  AuthIdentitySummary,
  CreateDisabledAuthUserResult,
  VerifyAuthStateResult,
} from "@/lib/accounts/auth-provisioning-adapter-core";
export { AuthProvisioningInputError } from "@/lib/accounts/auth-provisioning-adapter-core";

/**
 * Server-only Firebase Admin entry point. It deliberately accepts the active
 * reservation-key configuration from the future coordinator rather than
 * reading or creating secrets during this isolated adapter phase.
 */
export function createFirebaseAuthProvisioningAdapter(
  reservationKeyConfig: AuthProvisioningAdapterDependencies["reservationKeyConfig"],
) {
  const auth: Auth = getAdminAuth();
  return createAdapterCore({
    auth: {
      createUser: (properties) => auth.createUser(properties),
      getUser: (uid) => auth.getUser(uid),
      getUserByEmail: (email) => auth.getUserByEmail(email),
      setCustomUserClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
    },
    domain,
    keys,
    reservationKeyConfig,
  });
}