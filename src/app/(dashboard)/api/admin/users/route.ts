

import type { AppUser } from "@/types/auth";
import { NextRequest, NextResponse } from "next/server";

import { FieldValue } from "firebase-admin/firestore";

import {
  getAdminAuth,
  getAdminFirestore,
} from "@/lib/firebase/admin";

import { getCurrentUser } from "@/lib/auth/session";

import {
  isUserRole,
  type UserRole,
} from "@/types/auth";

import {
  getErrorMessage,
  getFirebaseErrorMessage,
} from "@/lib/errors/messages";

export const runtime = "nodejs";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

type CreateUserInput = {
  fullName: string;
  email: string;
  password: string;
  role: UserRole;
};

function respond(
  message: string,
  status: number
) {
  return NextResponse.json(
    { error: message },
    { status }
  );
}

function validateInput(
  body: unknown
):
  | { valid: true; data: CreateUserInput }
  | { valid: false; message: string } {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return {
      valid: false,
      message: getErrorMessage("INVALID_REQUEST"),
    };
  }

  const input = body as Record<string, unknown>;

  const { fullName, email, password, role } = input;

  if (
    typeof fullName !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string" ||
    !isUserRole(role)
  ) {
    return {
      valid: false,
      message:
        "Enter a full name, email address, initial password, and valid account role.",
    };
  }

  const normalizedName = fullName.trim();
  const normalizedEmail = email.trim().toLowerCase();

  if (
    normalizedName.length < 2 ||
    normalizedName.length > 120
  ) {
    return {
      valid: false,
      message:
        "The full name must contain between 2 and 120 characters.",
    };
  }

  if (
    normalizedEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      normalizedEmail
    )
  ) {
    return {
      valid: false,
      message: getErrorMessage("INVALID_EMAIL"),
    };
  }

  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return {
      valid: false,
      message:
        "The initial password must contain between 12 and 128 characters.",
    };
  }

  return {
    valid: true,
    data: {
      fullName: normalizedName,
      email: normalizedEmail,
      password,
      role,
    },
  };
}

export async function POST(request: NextRequest) {
  // Only accept requests from this application.
  const origin = request.headers.get("origin");

  if (
    !origin ||
    origin !== request.nextUrl.origin
  ) {
    return respond(
      "This request could not be verified.",
      403
    );
  }

  // Check the administrator's server-side session.
  const administrator = await getCurrentUser();

  if (!administrator) {
    return respond(
      getErrorMessage("SESSION_EXPIRED"),
      401
    );
  }

  if (administrator.role !== "admin") {
    return respond(
      getErrorMessage("FORBIDDEN"),
      403
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return respond(
      getErrorMessage("INVALID_REQUEST"),
      400
    );
  }

  const validation = validateInput(body);

  if (!validation.valid) {
    return respond(validation.message, 400);
  }

  const {
    fullName,
    email,
    password,
    role,
  } = validation.data;

  const auth = getAdminAuth();
  const firestore = getAdminFirestore();

  // Verify the administrator has not been disabled
  // or blocked since the session was checked.
  try {
    const [adminAccount, adminProfile] =
      await Promise.all([
        auth.getUser(administrator.uid),
        firestore
          .collection("users")
          .doc(administrator.uid)
          .get(),
      ]);

    if (
      adminAccount.disabled ||
      !adminProfile.exists ||
      adminProfile.data()?.status !== "active" ||
      adminProfile.data()?.role !== "admin"
    ) {
      return respond(
        getErrorMessage("FORBIDDEN"),
        403
      );
    }
  } catch {
    return respond(
      getErrorMessage("SERVICE_UNAVAILABLE"),
      503
    );
  }

  // Do not include the password in logs,
  // Firestore documents, or API responses.
  let createdUid: string | null = null;

  try {
    // Create the Firebase account disabled initially.
    // It cannot be used until provisioning completes.
    const createdAccount = await auth.createUser({
      email,
      password,
      displayName: fullName,
      emailVerified: false,
      disabled: true,
    });

    createdUid = createdAccount.uid;

    // Assign the application role as a Firebase claim.
    await auth.setCustomUserClaims(
      createdUid,
      { role }
    );

    // Prepare the user profile and audit record.
    const userRef = firestore
      .collection("users")
      .doc(createdUid);

    const auditRef = firestore
      .collection("audit_logs")
      .doc();

    // Enable Firebase Authentication before publishing
    // the active Firestore profile.
    await auth.updateUser(createdUid, {
      disabled: false,
    });

    const batch = firestore.batch();

    batch.create(userRef, {
      uid: createdUid,
      fullName,
      email,
      role,
      status: "active",
      mustChangePassword: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: administrator.uid,
      passwordChangedAt: null,
    });

    batch.create(auditRef, {
      actorUid: administrator.uid,
      action: "USER_CREATED",
      targetUid: createdUid,
      targetEmail: email,
      targetRole: role,
      createdAt: FieldValue.serverTimestamp(),
      details:
        "Administrator created a new user account.",
    });

    await batch.commit();

    return NextResponse.json(
      {
        success: true,
        message: "User account created successfully.",
        user: {
          uid: createdUid,
          fullName,
          email,
          role,
          status: "active",
          mustChangePassword: true,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    // If provisioning fails, attempt to remove
    // the partially created Firebase account.
    if (createdUid) {
      try {
        await auth.deleteUser(createdUid);
      } catch (cleanupError) {
        // Never report a clean rollback if it failed.
        // An administrator must investigate this UID.
        console.error(
          "User provisioning cleanup failed:",
          createdUid,
          cleanupError instanceof Error
            ? cleanupError.message
            : "Unknown cleanup error"
        );

        return respond(
          "Account creation could not be completed. Please contact the system administrator before trying again.",
          500
        );
      }

      console.error(
        "User provisioning failed and the Firebase account was removed.",
        createdUid
      );

      return respond(
        "Account creation could not be completed. Please try again.",
        500
      );
    }

    // Handle failures before a Firebase UID was created.
    const firebaseMessage =
      getFirebaseErrorMessage(error);

    if (
      firebaseMessage ===
      getErrorMessage("EMAIL_ALREADY_EXISTS")
    ) {
      return respond(firebaseMessage, 409);
    }

    if (
      firebaseMessage ===
      getErrorMessage("INVALID_EMAIL") ||
      firebaseMessage ===
      getErrorMessage("WEAK_PASSWORD")
    ) {
      return respond(firebaseMessage, 400);
    }

    console.error(
      "User creation failed:",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

    return respond(
      getErrorMessage("SERVICE_UNAVAILABLE"),
      503
    );
  }
}


export async function GET() {
  const administrator = await getCurrentUser();

  if (!administrator) {
    return NextResponse.json(
      {
        error:
          "Your session has expired. Please sign in again.",
      },
      { status: 401 }
    );
  }

  if (administrator.role !== "admin") {
    return NextResponse.json(
      {
        error:
          "You do not have permission to view user accounts.",
      },
      { status: 403 }
    );
  }

  try {
    const firestore = getAdminFirestore();

    const snapshot = await firestore
      .collection("users")
      .get();

   type ManagedUser = AppUser & {
  accountStatusTestEligible: boolean;
  statusOperationPending: boolean;
};

const users: ManagedUser[] = [];

    for (const document of snapshot.docs) {
      const data = document.data();

      if (
        !isUserRole(data.role) ||
        (
          data.status !== "active" &&
          data.status !== "blocked" &&
          data.status !== "revoked"
        )
      ) {
        continue;
      }

      
users.push({
  uid: document.id,

  fullName:
    typeof data.fullName === "string"
      ? data.fullName
      : "Unknown user",

  email:
    typeof data.email === "string"
      ? data.email
      : "",

  role: data.role,

  status: data.status,

  mustChangePassword:
    data.mustChangePassword === true,

  accountStatusTestEligible:
    data.accountStatusTestEligible === true,

  statusOperationPending:
    data.statusOperation != null,
});
    }

    users.sort((a, b) =>
      a.fullName.localeCompare(b.fullName)
    );

    return NextResponse.json({
      users,
      total: users.length,
    });
  } catch (error) {
    console.error(
      "Unable to retrieve users:",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

    return NextResponse.json(
      {
        error:
          "Unable to load user accounts. Please try again.",
      },
      { status: 500 }
    );
  }
}