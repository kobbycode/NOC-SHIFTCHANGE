
export type AppErrorCode =
  | "INVALID_CREDENTIALS"
  | "EMAIL_ALREADY_EXISTS"
  | "WEAK_PASSWORD"
  | "TOO_MANY_ATTEMPTS"
  | "NETWORK_ERROR"
  | "ACCOUNT_DISABLED"
  | "ACCOUNT_BLOCKED"
  | "ACCOUNT_REVOKED"
  | "SESSION_EXPIRED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "USER_NOT_FOUND"
  | "INVALID_EMAIL"
  | "PASSWORD_MISMATCH"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_UNCHANGED"
  | "INVALID_REQUEST"
  | "SERVICE_UNAVAILABLE"
  | "UNKNOWN_ERROR";

export const ERROR_MESSAGES: Record<
  AppErrorCode,
  string
> = {
  INVALID_CREDENTIALS:
    "Incorrect email or password. Please try again.",

  EMAIL_ALREADY_EXISTS:
    "An account with this email address already exists.",

  WEAK_PASSWORD:
    "Your password does not meet the security requirements. Please choose a stronger password.",

  TOO_MANY_ATTEMPTS:
    "Too many attempts. Please wait a few minutes and try again.",

  NETWORK_ERROR:
    "Unable to connect. Check your internet connection and try again.",

  ACCOUNT_DISABLED:
    "Your account is unavailable. Please contact an administrator.",

  ACCOUNT_BLOCKED:
    "Your account has been temporarily blocked. Please contact an administrator.",

  ACCOUNT_REVOKED:
    "Your account access has been permanently revoked. Please contact an administrator.",

  SESSION_EXPIRED:
    "Your session has expired. Please sign in again.",

  UNAUTHORIZED:
    "Please sign in to continue.",

  FORBIDDEN:
    "You do not have permission to perform this action.",

  USER_NOT_FOUND:
    "The requested user account could not be found.",

  INVALID_EMAIL:
    "Please enter a valid email address.",

  PASSWORD_MISMATCH:
    "The passwords do not match.",

  PASSWORD_TOO_SHORT:
    "Your password must contain at least 12 characters.",

  PASSWORD_UNCHANGED:
    "Your new password must be different from your current password.",

  INVALID_REQUEST:
    "The information provided is invalid. Please check your entries and try again.",

  SERVICE_UNAVAILABLE:
    "This service is temporarily unavailable. Please try again later.",

  UNKNOWN_ERROR:
    "Something went wrong. Please try again. If the problem continues, contact an administrator.",
};

export function getErrorMessage(
  code: AppErrorCode
): string {
  return ERROR_MESSAGES[code];
}

const FIREBASE_ERROR_MAP: Record<
  string,
  AppErrorCode
> = {
  "auth/invalid-credential":
    "INVALID_CREDENTIALS",

  "auth/wrong-password":
    "INVALID_CREDENTIALS",

  "auth/invalid-password":
    "INVALID_CREDENTIALS",

  "auth/user-not-found":
    "INVALID_CREDENTIALS",

  "auth/invalid-email":
    "INVALID_EMAIL",

  "auth/email-already-in-use":
    "EMAIL_ALREADY_EXISTS",

  "auth/email-already-exists":
    "EMAIL_ALREADY_EXISTS",

  "auth/weak-password":
    "WEAK_PASSWORD",

  "auth/too-many-requests":
    "TOO_MANY_ATTEMPTS",

  "auth/network-request-failed":
    "NETWORK_ERROR",

  "auth/user-disabled":
    "ACCOUNT_DISABLED",

  "auth/id-token-expired":
    "SESSION_EXPIRED",

  "auth/session-cookie-expired":
    "SESSION_EXPIRED",

  "auth/session-cookie-revoked":
    "SESSION_EXPIRED",

  "auth/insufficient-permission":
    "FORBIDDEN",
};

export function getFirebaseErrorMessage(
  error: unknown
): string {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error)
  ) {
    return ERROR_MESSAGES.UNKNOWN_ERROR;
  }

  const code = (error as { code: unknown }).code;

  if (typeof code !== "string") {
    return ERROR_MESSAGES.UNKNOWN_ERROR;
  }

  const appErrorCode = FIREBASE_ERROR_MAP[code];

  if (!appErrorCode) {
    return ERROR_MESSAGES.UNKNOWN_ERROR;
  }

  return ERROR_MESSAGES[appErrorCode];
}