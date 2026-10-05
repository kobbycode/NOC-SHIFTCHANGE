import "server-only";

export type PasswordReauthenticationFailure =
  | "INVALID_INPUT"
  | "CONFIGURATION_UNAVAILABLE"
  | "CREDENTIAL_REJECTED"
  | "IDENTITY_MISMATCH"
  | "SERVICE_UNAVAILABLE";

const FAILURES: Record<PasswordReauthenticationFailure, {
  status: number;
  message: string;
}> = {
  INVALID_INPUT: {
    status: 400,
    message: "Invalid password verification input.",
  },
  CONFIGURATION_UNAVAILABLE: {
    status: 503,
    message: "Password changes are temporarily unavailable.",
  },
  CREDENTIAL_REJECTED: {
    status: 400,
    message: "Current password is incorrect or authentication was rejected.",
  },
  IDENTITY_MISMATCH: {
    status: 403,
    message: "Account verification failed.",
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "Unable to verify your password. Please try again later.",
  },
};

// Errors contain only a fixed classification/status/message, never the request,
// upstream payload, tokens, or original network error (including its cause).
export class PasswordReauthenticationError extends Error {
  public readonly code: PasswordReauthenticationFailure;
  public readonly status: number;

  constructor(code: PasswordReauthenticationFailure) {
    super(FAILURES[code].message);
    this.name = "PasswordReauthenticationError";
    this.code = code;
    this.status = FAILURES[code].status;
  }
}

export interface PasswordReauthenticationInput {
  expectedUid: string;
  email: string;
  password: string;
}

export interface PasswordReauthenticationResult {
  uid: string;
}

interface PasswordReauthenticationDependencies {
  apiKey?: string;
  fetch?: (url: string, init: RequestInit) => Promise<
    Pick<Response, "ok" | "status" | "json">
  >;
}

/**
 * Accepts identity from the authenticated session and authoritative Auth account.
 * Password reauthentication must complete BEFORE entering a Firestore transaction.
 * The transaction must then re-check all authoritative mutable account and
 * handover state; this helper does not establish eligibility or persist evidence.
 */
export async function reauthenticatePassword(
  input: PasswordReauthenticationInput,
  dependencies: PasswordReauthenticationDependencies = {}
): Promise<PasswordReauthenticationResult> {
  if (
    !input ||
    typeof input.expectedUid !== "string" ||
    !input.expectedUid ||
    input.expectedUid.trim() !== input.expectedUid ||
    typeof input.email !== "string" ||
    !input.email.trim() ||
    typeof input.password !== "string" ||
    !input.password
  ) {
    throw new PasswordReauthenticationError("INVALID_INPUT");
  }

  // Capture authoritative identity and transient input before the network await.
  const { expectedUid, email, password } = input;

  // Do not trim, normalize, or apply new-password policy to an existing password.
  // Whitespace-only passwords are deliberately passed unchanged, matching the
  // proven change-password route. Only Firebase decides credential validity.
  const apiKey = dependencies.apiKey ?? process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new PasswordReauthenticationError("CONFIGURATION_UNAVAILABLE");
  }

  let response: Pick<Response, "ok" | "status" | "json">;
  try {
    const fetchPasswordVerification = dependencies.fetch ?? fetch;
    response = await fetchPasswordVerification(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" +
        encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
        cache: "no-store",
      }
    );
  } catch {
    throw new PasswordReauthenticationError("SERVICE_UNAVAILABLE");
  }

  if (!response.ok) {
    throw new PasswordReauthenticationError(
      response.status === 400 || response.status === 401
        ? "CREDENTIAL_REJECTED"
        : "SERVICE_UNAVAILABLE"
    );
  }

  let verification: unknown;
  try {
    verification = await response.json();
  } catch {
    throw new PasswordReauthenticationError("SERVICE_UNAVAILABLE");
  }

  if (
    !verification ||
    typeof verification !== "object" ||
    Array.isArray(verification) ||
    !Object.hasOwn(verification, "localId") ||
    typeof (verification as Record<string, unknown>).localId !== "string" ||
    !(verification as Record<string, unknown>).localId
  ) {
    throw new PasswordReauthenticationError("SERVICE_UNAVAILABLE");
  }

  if ((verification as Record<string, unknown>).localId !== expectedUid) {
    throw new PasswordReauthenticationError("IDENTITY_MISMATCH");
  }

  // Explicit projection discards the credential response, including all tokens.
  return { uid: expectedUid };
}
