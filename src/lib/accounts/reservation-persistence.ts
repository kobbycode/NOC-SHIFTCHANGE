import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";
import * as domain from "@/lib/accounts/account-provisioning-domain";
import * as keys from "@/lib/accounts/reservation-key";
import {
  createReservationPersistence as createPersistenceCore,
  type ReservationPersistenceDependencies,
} from "@/lib/accounts/reservation-persistence-core";

export { ReservationPersistenceError } from "@/lib/accounts/reservation-persistence-core";
export type {
  ReservationResult,
  ReservationPersistenceDependencies,
} from "@/lib/accounts/reservation-persistence-core";

/**
 * Protected production entry point. The transaction implementation lives in
 * one dependency-injected core so deterministic tests can use a mock Firestore.
 */
export function createReservationPersistence(
  options: Pick<ReservationPersistenceDependencies, "now" | "authorizeRecoveryAdministrator"> = {},
) {
  return createPersistenceCore({
    firestore: getAdminFirestore(),
    domain,
    keys,
    ...options,
  });
}