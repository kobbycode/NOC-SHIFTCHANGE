// Phase 8C.2b — trusted HTTP boundary for the dual-approval substrate.
//
// The ONLY place a password enters the approval flow. It verifies the caller's
// own password against the authoritative Auth account, strictly before any
// Firestore transaction, binds the result to the session subject and returns a
// transient proof base. The password is never stored, logged or forwarded to a
// service.

import "server-only";

import { randomUUID } from "node:crypto";

import type { Auth } from "firebase-admin/auth";

import {
  PasswordReauthenticationError,
  reauthenticatePassword,
} from "@/lib/auth/password-reauthentication";
import { getAdminAuth } from "@/lib/firebase/admin";
import { HandoverRecoveryApprovalError } from "./handover-recovery-approval-domain";

export interface HandoverRecoveryApprovalHttpActor {
  uid: string;
  email: string;
  role: string;
  mustChangePassword: boolean;
}

export interface HandoverRecoveryApprovalClock {
  nowIso(): string;
  monotonicMs(): number;
}

const defaultClock: HandoverRecoveryApprovalClock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => Math.floor(performance.now()),
};

// Test seams only. Production routes pass no dependencies, so the real Auth
// account and the real password verification are always used.
export interface HandoverRecoveryApprovalCoordinatorDependencies {
  clock?: HandoverRecoveryApprovalClock;
  auth?: Pick<Auth, "getUser">;
  reauthenticate?: typeof reauthenticatePassword;
  createNonce?: () => string;
}

export interface HandoverRecoveryApprovalAuthenticationBase {
  actorUid: string;
  requestNonce: string;
  verifiedAt: string;
  authAccountCheckedAt: string;
  verifiedAtMonotonicMs: number;
  nowIso: string;
  nowMonotonicMs: number;
}

export async function authenticateHandoverRecoveryApproval(
  input: {
    actor: HandoverRecoveryApprovalHttpActor;
    password: string;
  },
  dependencies: HandoverRecoveryApprovalCoordinatorDependencies = {},
): Promise<HandoverRecoveryApprovalAuthenticationBase> {
  const clock = dependencies.clock ?? defaultClock;
  const auth = dependencies.auth ?? getAdminAuth();
  const reauthenticate = dependencies.reauthenticate ?? reauthenticatePassword;
  const createNonce = dependencies.createNonce ?? (() => randomUUID());

  const account = await auth.getUser(input.actor.uid).catch(() => null);
  if (
    account === null ||
    account.uid !== input.actor.uid ||
    account.disabled === true ||
    !account.email ||
    account.email.toLowerCase() !== input.actor.email.toLowerCase()
  ) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_ROLE_FORBIDDEN",
      "This account cannot approve a recovery intent.",
    );
  }

  const email = account.email;
  await reauthenticate({
    expectedUid: input.actor.uid,
    email,
    password: input.password,
  });

  const current = await auth.getUser(input.actor.uid).catch(() => null);
  if (
    current === null ||
    current.uid !== input.actor.uid ||
    current.disabled === true ||
    current.email !== email
  ) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_AUTH_IDENTITY_CHANGED",
      "Your account changed. Sign in again before approving.",
    );
  }

  const verifiedAt = clock.nowIso();
  const monotonic = clock.monotonicMs();
  const checkedAt = clock.nowIso();
  if (Date.parse(checkedAt) < Date.parse(verifiedAt)) {
    throw new HandoverRecoveryApprovalError(
      "RECOVERY_APPROVAL_AUTHENTICATION_INVALID",
      "Authentication times are not in a valid order.",
    );
  }

  return {
    actorUid: input.actor.uid,
    requestNonce: createNonce(),
    verifiedAt,
    authAccountCheckedAt: checkedAt,
    verifiedAtMonotonicMs: monotonic,
    nowIso: clock.nowIso(),
    nowMonotonicMs: clock.monotonicMs(),
  };
}

export { PasswordReauthenticationError };
