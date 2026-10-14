import type {
  AccountProvisioningOperation,
} from "./account-provisioning-domain";
import type { UserRole } from "@/types/auth";
import type { ReservationKeyConfig } from "./reservation-key";

export interface AuthProvisioningUser {
  uid: string;
  email?: string | null;
  disabled: boolean;
  customClaims?: Record<string, unknown>;
}

export interface AuthProvisioningCreateRequest {
  uid: string;
  email: string;
  password: string;
  displayName: string;
  emailVerified: false;
  disabled: true;
}

/** The deliberately small Admin Auth surface needed by provisioning. */
export interface AuthProvisioningService {
  createUser(properties: AuthProvisioningCreateRequest): Promise<AuthProvisioningUser>;
  getUser(uid: string): Promise<AuthProvisioningUser>;
  getUserByEmail(email: string): Promise<AuthProvisioningUser>;
  setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
}

export interface AuthProvisioningDomain {
  assertProvisioningOperation(value: unknown): asserts value is AccountProvisioningOperation;
}

export interface AuthProvisioningKeys {
  computeEmailReservationKey(email: string, config: ReservationKeyConfig): string;
}

export interface AuthProvisioningAdapterDependencies {
  auth: AuthProvisioningService;
  domain: AuthProvisioningDomain;
  keys: AuthProvisioningKeys;
  reservationKeyConfig: ReservationKeyConfig;
}

export interface AuthIdentitySummary {
  uid: string;
  email: string;
  disabled: boolean;
  role: UserRole | null;
}

export type CreateDisabledAuthUserResult =
  | { outcome: "created"; user: AuthIdentitySummary; passwordState: "provided" }
  | {
      outcome: "recovered";
      user: AuthIdentitySummary;
      passwordState: "unknown";
      requiresReview: true;
      reviewReason: "password_state_unknown";
    }
  | { outcome: "confirmed_failure"; reason: "auth_rejected_request" }
  | { outcome: "retryable_failure"; reason: "auth_temporarily_unavailable" }
  | {
      outcome: "requires_review";
      reason: "identity_unresolved" | "uid_identity_conflict" | "email_owned_by_other_uid" | "account_enabled";
    };

export type ApplyRoleClaimsResult =
  | { outcome: "applied" | "recovered"; user: AuthIdentitySummary }
  | { outcome: "retryable_failure"; reason: "auth_temporarily_unavailable" | "claims_not_confirmed" }
  | {
      outcome: "requires_review";
      reason: "identity_unresolved" | "uid_identity_conflict" | "email_owned_by_other_uid" | "account_enabled" | "role_claim_conflict" | "claims_unresolved";
    };

export type VerifyAuthStateResult =
  | { outcome: "verified"; user: AuthIdentitySummary }
  | { outcome: "mismatch"; reasons: Array<"uid_missing" | "uid_mismatch" | "email_mismatch" | "role_mismatch" | "account_enabled"> }
  | { outcome: "unavailable" };

export class AuthProvisioningInputError extends Error {
  readonly code: "invalid_operation" | "invalid_email" | "email_reservation_mismatch" | "invalid_password" | "wrong_stage";

  constructor(code: AuthProvisioningInputError["code"]) {
    super(code);
    this.code = code;
    this.name = "AuthProvisioningInputError";
  }
}

const CONFIRMED_CREATE_REJECTIONS = new Set([
  "auth/invalid-email",
  "auth/weak-password",
  "auth/invalid-display-name",
  "auth/operation-not-allowed",
]);

const USER_NOT_FOUND = "auth/user-not-found";

export function createAuthProvisioningAdapter(
  dependencies: AuthProvisioningAdapterDependencies,
) {
  function getIdentity(
    operation: AccountProvisioningOperation,
    suppliedEmail: string,
  ): { email: string } {
    try {
      dependencies.domain.assertProvisioningOperation(operation);
    } catch {
      throw new AuthProvisioningInputError("invalid_operation");
    }

    const email = normalizeEmail(suppliedEmail);
    let reservationKey: string;
    try {
      reservationKey = dependencies.keys.computeEmailReservationKey(
        email,
        dependencies.reservationKeyConfig,
      );
    } catch {
      throw new AuthProvisioningInputError("email_reservation_mismatch");
    }
    if (reservationKey !== operation.emailReservationKey) {
      throw new AuthProvisioningInputError("email_reservation_mismatch");
    }
    return { email };
  }

  async function readByUid(uid: string): Promise<UserRead> {
    try {
      return { outcome: "found", user: await dependencies.auth.getUser(uid) };
    } catch (error) {
      return errorCode(error) === USER_NOT_FOUND
        ? { outcome: "missing" }
        : { outcome: "unavailable" };
    }
  }

  async function readByEmail(email: string): Promise<UserRead> {
    try {
      return { outcome: "found", user: await dependencies.auth.getUserByEmail(email) };
    } catch (error) {
      return errorCode(error) === USER_NOT_FOUND
        ? { outcome: "missing" }
        : { outcome: "unavailable" };
    }
  }

  function summarize(user: AuthProvisioningUser, expectedEmail: string): AuthIdentitySummary {
    const role = user.customClaims?.role;
    return {
      uid: user.uid,
      email: normalizeEmail(typeof user.email === "string" ? user.email : expectedEmail),
      disabled: user.disabled,
      role: isUserRole(role) ? role : null,
    };
  }

  function identityIssue(
    user: AuthProvisioningUser,
    operation: AccountProvisioningOperation,
    expectedEmail: string,
  ): "uid_identity_conflict" | "email_owned_by_other_uid" | null {
    if (user.uid !== operation.targetAuthUid) return "email_owned_by_other_uid";
    if (!emailMatches(user.email, expectedEmail)) {
      return "uid_identity_conflict";
    }
    return null;
  }

  function reviewForExistingUser(
    user: AuthProvisioningUser,
    operation: AccountProvisioningOperation,
    email: string,
  ): CreateDisabledAuthUserResult {
    const identityConflict = identityIssue(user, operation, email);
    if (identityConflict) return { outcome: "requires_review", reason: identityConflict };
    if (!user.disabled) return { outcome: "requires_review", reason: "account_enabled" };
    return {
      outcome: "recovered",
      user: summarize(user, email),
      passwordState: "unknown",
      requiresReview: true,
      reviewReason: "password_state_unknown",
    };
  }

  async function createDisabledAuthUser(
    operation: AccountProvisioningOperation,
    suppliedEmail: string,
    initialPassword: string,
  ): Promise<CreateDisabledAuthUserResult> {
    const { email } = getIdentity(operation, suppliedEmail);
    if (operation.stage !== "auth_create_pending") {
      throw new AuthProvisioningInputError("wrong_stage");
    }
    if (typeof initialPassword !== "string" || initialPassword.length < 12 || initialPassword.length > 128) {
      throw new AuthProvisioningInputError("invalid_password");
    }

    try {
      const created = await dependencies.auth.createUser({
        uid: operation.targetAuthUid,
        email,
        password: initialPassword,
        displayName: operation.displayName,
        emailVerified: false,
        disabled: true,
      });
      const identityConflict = identityIssue(created, operation, email);
      if (identityConflict) return { outcome: "requires_review", reason: identityConflict };
      if (!created.disabled) return { outcome: "requires_review", reason: "account_enabled" };
      return {
        outcome: "created",
        user: summarize(created, email),
        passwordState: "provided",
      };
    } catch (createError) {
      const byUid = await readByUid(operation.targetAuthUid);
      if (byUid.outcome === "found") {
        return reviewForExistingUser(byUid.user, operation, email);
      }

      const byEmail = await readByEmail(email);
      if (byEmail.outcome === "found") {
        return reviewForExistingUser(byEmail.user, operation, email);
      }
      if (byUid.outcome === "unavailable" || byEmail.outcome === "unavailable") {
        return { outcome: "requires_review", reason: "identity_unresolved" };
      }

      const code = errorCode(createError);
      if (code === "auth/uid-already-exists" || code === "auth/email-already-exists") {
        return { outcome: "requires_review", reason: "identity_unresolved" };
      }
      if (CONFIRMED_CREATE_REJECTIONS.has(code)) {
        return { outcome: "confirmed_failure", reason: "auth_rejected_request" };
      }
      return { outcome: "retryable_failure", reason: "auth_temporarily_unavailable" };
    }
  }

  async function applyRoleClaims(
    operation: AccountProvisioningOperation,
    suppliedEmail: string,
  ): Promise<ApplyRoleClaimsResult> {
    const { email } = getIdentity(operation, suppliedEmail);
    if (operation.stage !== "claims_pending") {
      throw new AuthProvisioningInputError("wrong_stage");
    }

    const before = await readByUid(operation.targetAuthUid);
    if (before.outcome === "unavailable") {
      return { outcome: "retryable_failure", reason: "auth_temporarily_unavailable" };
    }
    if (before.outcome === "missing") {
      return { outcome: "requires_review", reason: "identity_unresolved" };
    }
    const conflict = identityIssue(before.user, operation, email);
    if (conflict) return { outcome: "requires_review", reason: conflict };
    if (!before.user.disabled) return { outcome: "requires_review", reason: "account_enabled" };

    const priorClaims = normalizeClaims(before.user.customClaims);
    if (priorClaims.role !== undefined && priorClaims.role !== operation.requestedRole) {
      return { outcome: "requires_review", reason: "role_claim_conflict" };
    }

    if (priorClaims.role === operation.requestedRole) {
      return { outcome: "applied", user: summarize(before.user, email) };
    }

    const desiredClaims = { ...priorClaims, role: operation.requestedRole };
    let acknowledgementLost = false;
    try {
      await dependencies.auth.setCustomUserClaims(operation.targetAuthUid, desiredClaims);
    } catch {
      acknowledgementLost = true;
    }

    const after = await readByUid(operation.targetAuthUid);
    if (after.outcome === "unavailable") {
      return { outcome: "requires_review", reason: "claims_unresolved" };
    }
    if (after.outcome === "missing") {
      return { outcome: "requires_review", reason: "identity_unresolved" };
    }
    const afterConflict = identityIssue(after.user, operation, email);
    if (afterConflict) return { outcome: "requires_review", reason: afterConflict };
    if (!after.user.disabled) return { outcome: "requires_review", reason: "account_enabled" };

    const actualClaims = normalizeClaims(after.user.customClaims);
    if (actualClaims.role !== operation.requestedRole) {
      if (actualClaims.role !== undefined) {
        return { outcome: "requires_review", reason: "role_claim_conflict" };
      }
      return {
        outcome: "retryable_failure",
        reason: acknowledgementLost ? "auth_temporarily_unavailable" : "claims_not_confirmed",
      };
    }
    if (!preservesClaims(priorClaims, actualClaims)) {
      return { outcome: "requires_review", reason: "claims_unresolved" };
    }

    return {
      outcome: acknowledgementLost ? "recovered" : "applied",
      user: summarize(after.user, email),
    };
  }

  async function verifyAuthState(
    operation: AccountProvisioningOperation,
    suppliedEmail: string,
  ): Promise<VerifyAuthStateResult> {
    const { email } = getIdentity(operation, suppliedEmail);
    const result = await readByUid(operation.targetAuthUid);
    if (result.outcome === "unavailable") return { outcome: "unavailable" };
    if (result.outcome === "missing") return { outcome: "mismatch", reasons: ["uid_missing"] };

    const reasons: Array<"uid_missing" | "uid_mismatch" | "email_mismatch" | "role_mismatch" | "account_enabled"> = [];
    if (result.user.uid !== operation.targetAuthUid) reasons.push("uid_mismatch");
    if (!emailMatches(result.user.email, email)) {
      reasons.push("email_mismatch");
    }
    if (result.user.customClaims?.role !== operation.requestedRole) reasons.push("role_mismatch");
    if (!result.user.disabled) reasons.push("account_enabled");

    if (reasons.length > 0) return { outcome: "mismatch", reasons };
    return { outcome: "verified", user: summarize(result.user, email) };
  }

  return { createDisabledAuthUser, applyRoleClaims, verifyAuthState };
}

interface FoundUserRead {
  outcome: "found";
  user: AuthProvisioningUser;
}

interface MissingRead {
  outcome: "missing";
}

interface UnavailableRead {
  outcome: "unavailable";
}

type UserRead = FoundUserRead | MissingRead | UnavailableRead;

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) throw new AuthProvisioningInputError("invalid_email");
  return normalized;
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return typeof error.code === "string" ? error.code : "";
}

function normalizeClaims(claims: unknown): Record<string, unknown> {
  return typeof claims === "object" && claims !== null && !Array.isArray(claims)
    ? { ...(claims as Record<string, unknown>) }
    : {};
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function preservesClaims(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return Object.entries(before).every(([key, value]) =>
    stableSerialize(after[key]) === stableSerialize(value),
  );
}

function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "supervisor" || value === "technician";
}
function emailMatches(value: string | null | undefined, expected: string): boolean {
  if (typeof value !== "string") return false;
  try {
    return normalizeEmail(value) === expected;
  } catch {
    return false;
  }
}