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

export interface PasswordSessionResult {
  uid: string;
  // One-shot Identity Toolkit id token, good only for the single
  // createSessionCookie exchange that signs the verified technician in. It is
  // never persisted, logged, echoed, or handed to any operational service.
  idToken: string;
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
  const verified = await verifyPasswordCredential(input, dependencies);
  // Explicit projection discards the credential response, including all tokens.
  return { uid: verified.uid };
}

/**
 * The ONLY credential path that retains a token: the shared-console handover
 * acceptance, which must sign the verified incoming technician in at the moment
 * they personally accept. It returns a one-shot id token bound to the exact
 * verified UID for an immediate createSessionCookie exchange. Every other
 * personal action keeps reauthenticatePassword, which discards all tokens.
 */
export async function authenticatePasswordForSession(
  input: PasswordReauthenticationInput,
  dependencies: PasswordReauthenticationDependencies = {}
): Promise<PasswordSessionResult> {
  const verified = await verifyPasswordCredential(input, dependencies);
  // Without a usable id token no session can be minted, so this fails closed
  // rather than accepting a credential it cannot turn into a login.
  if (typeof verified.idToken !== "string" || !verified.idToken) {
    throw new PasswordReauthenticationError("SERVICE_UNAVAILABLE");
  }
  return { uid: verified.uid, idToken: verified.idToken };
}

async function verifyPasswordCredential(
  input: PasswordReauthenticationInput,
  dependencies: PasswordReauthenticationDependencies
): Promise<{ uid: string; idToken: unknown }> {
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

  let endpoint = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=";
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    // Never send demonstration credentials to production or an arbitrary host.
    // Emulator authentication still verifies the password and exact Firebase UID.
    // This closed list mirrors ISOLATED_EMULATOR_ENVIRONMENTS in
    // src/lib/firebase/client.ts so the browser and the server always reach the
    // same isolated emulator; anything else fails closed.
    const isolatedEnvironments = [
      {
        projectId: "demo-shiftchange-v2",
        authEmulatorHost: "127.0.0.1:9099",
        firestoreEmulatorHost: "127.0.0.1:8080",
      },
      {
        projectId: "demo-shiftchange-v2-uat",
        authEmulatorHost: "127.0.0.1:9199",
        firestoreEmulatorHost: "127.0.0.1:8180",
      },
      {
        projectId: "demo-shiftchange-v2-09l",
        authEmulatorHost: "127.0.0.1:9299",
        firestoreEmulatorHost: "127.0.0.1:8280",
      },
      {
        projectId: "demo-shiftchange-v2-09m",
        authEmulatorHost: "127.0.0.1:9399",
        firestoreEmulatorHost: "127.0.0.1:8380",
      },
      {
        projectId: "demo-atomic-acceptance-r5",
        authEmulatorHost: "127.0.0.1:9083",
        firestoreEmulatorHost: "127.0.0.1:8183",
      },
      {
        projectId: "demo-atomic-browser-p6",
        authEmulatorHost: "127.0.0.1:9499",
        firestoreEmulatorHost: "127.0.0.1:8480",
      },
      {
        projectId: "demo-product-readiness-p7",
        authEmulatorHost: "127.0.0.1:9599",
        firestoreEmulatorHost: "127.0.0.1:8580",
      },
      {
        projectId: "demo-scheduling-p8a",
        authEmulatorHost: "127.0.0.1:9799",
        firestoreEmulatorHost: "127.0.0.1:8680",
      },
      {
        projectId: "demo-lifecycle-p8a2",
        authEmulatorHost: "127.0.0.1:9899",
        firestoreEmulatorHost: "127.0.0.1:8780",
      },
      {
        projectId: "demo-lifecycle-p8a2r",
        authEmulatorHost: "127.0.0.1:9999",
        firestoreEmulatorHost: "127.0.0.1:8880",
      },
      {
        projectId: "demo-admin-review-8b",
        authEmulatorHost: "127.0.0.1:10099",
        firestoreEmulatorHost: "127.0.0.1:8980",
      },
    ];

    const isolated = isolatedEnvironments.find(
      (environment) =>
        environment.projectId === process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
        environment.projectId === process.env.FIREBASE_PROJECT_ID &&
        environment.authEmulatorHost === process.env.FIREBASE_AUTH_EMULATOR_HOST &&
        environment.firestoreEmulatorHost === process.env.FIRESTORE_EMULATOR_HOST
    );

    if (!isolated || process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS !== "true") {
      throw new PasswordReauthenticationError("CONFIGURATION_UNAVAILABLE");
    }

    endpoint = `http://${isolated.authEmulatorHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=`;
  }

  let response: Pick<Response, "ok" | "status" | "json">;
  try {
    const fetchPasswordVerification = dependencies.fetch ?? fetch;
    response = await fetchPasswordVerification(
      endpoint + encodeURIComponent(apiKey),
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

  const credential = verification as Record<string, unknown>;
  if (credential.localId !== expectedUid) {
    throw new PasswordReauthenticationError("IDENTITY_MISMATCH");
  }

  // Only the exact verified UID and the one-shot id token survive this
  // projection. The refresh token and the rest of the credential response are
  // discarded here, and reauthenticatePassword drops the id token as well.
  return { uid: expectedUid, idToken: credential.idToken };
}
