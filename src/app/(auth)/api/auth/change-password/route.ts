
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

import {
  getAdminAuth,
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  getCurrentUser,
  SESSION_COOKIE,
} from "@/lib/auth/session";

export const runtime = "nodejs";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

function errorResponse(
  message: string,
  status: number
) {
  return NextResponse.json(
    { error: message },
    { status }
  );
}

export async function POST(request: NextRequest) {
  // Verify the request origin.
  const origin = request.headers.get("origin");

  if (
    !origin ||
    origin !== request.nextUrl.origin
  ) {
    return errorResponse(
      "Invalid request origin.",
      403
    );
  }

  // Identify the user through the existing session.
  const user = await getCurrentUser();

  if (!user) {
    return errorResponse(
      "Your session has expired. Please sign in again.",
      401
    );
  }

  // Read and validate the request body.
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      "Invalid request body.",
      400
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return errorResponse(
      "Invalid request body.",
      400
    );
  }

  const data = body as Record<string, unknown>;

  const {
    currentPassword,
    newPassword,
    confirmPassword,
  } = data;

  if (
    typeof currentPassword !== "string" ||
    typeof newPassword !== "string" ||
    typeof confirmPassword !== "string" ||
    !currentPassword
  ) {
    return errorResponse(
      "All password fields are required.",
      400
    );
  }

  if (
    newPassword.length < MIN_PASSWORD_LENGTH ||
    newPassword.length > MAX_PASSWORD_LENGTH
  ) {
    return errorResponse(
      "Your new password must contain between 12 and 128 characters.",
      400
    );
  }

  if (newPassword !== confirmPassword) {
    return errorResponse(
      "The new passwords do not match.",
      400
    );
  }

  if (currentPassword === newPassword) {
    return errorResponse(
      "Choose a password different from your current password.",
      400
    );
  }

  const apiKey =
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

  if (!apiKey) {
    return errorResponse(
      "Password changes are temporarily unavailable.",
      503
    );
  }

  const adminAuth = getAdminAuth();
  const firestore = getAdminFirestore();

  try {
    // Retrieve the authoritative Firebase account.
    const authUser = await adminAuth.getUser(user.uid);

    if (
      authUser.disabled ||
      !authUser.email ||
      authUser.email.toLowerCase() !==
        user.email.toLowerCase()
    ) {
      return errorResponse(
        "This account cannot change its password.",
        403
      );
    }

    // Verify the current password with Firebase.
    const verificationResponse = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" +
        encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: authUser.email,
          password: currentPassword,
          returnSecureToken: true,
        }),
        cache: "no-store",
      }
    );

    if (!verificationResponse.ok) {
      if (
        verificationResponse.status === 400 ||
        verificationResponse.status === 401
      ) {
        return errorResponse(
          "Current password is incorrect or authentication was rejected.",
          400
        );
      }

      console.error(
        "Firebase password verification failed:",
        verificationResponse.status
      );

      return errorResponse(
        "Unable to verify your password. Please try again later.",
        503
      );
    }

    const verification =
      await verificationResponse.json();

    // Ensure the verified credentials belong
    // to the currently authenticated user.
    if (verification.localId !== user.uid) {
      return errorResponse(
        "Account verification failed.",
        403
      );
    }

    // Recheck the latest account status.
    const latestProfile = await firestore
      .collection("users")
      .doc(user.uid)
      .get();

    const latestAuthUser =
      await adminAuth.getUser(user.uid);

    if (
      !latestProfile.exists ||
      latestProfile.data()?.status !== "active" ||
      latestAuthUser.disabled ||
      latestAuthUser.email !== authUser.email
    ) {
      return errorResponse(
        "This account is no longer active.",
        403
      );
    }

    // Update the Firebase Authentication password.
    await adminAuth.updateUser(user.uid, {
      password: newPassword,
    });

    // Invalidate existing Firebase sessions.
    await adminAuth.revokeRefreshTokens(user.uid);

    // Update the Firestore profile and audit record.
    const batch = firestore.batch();

    const userRef = firestore
      .collection("users")
      .doc(user.uid);

    const auditRef = firestore
      .collection("audit_logs")
      .doc();

    const changedAt = new Date().toISOString();

    batch.update(userRef, {
      mustChangePassword: false,
      passwordChangedAt: changedAt,
    });

    batch.set(auditRef, {
      actorUid: user.uid,
      action: "PASSWORD_CHANGED",
      targetUid: user.uid,
      createdAt: changedAt,
      details:
        "User changed their account password.",
    });

    await batch.commit();

    // Clear the current server session.
    const cookieStore = await cookies();

    cookieStore.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });

    return NextResponse.json({
      success: true,
      message:
        "Password changed successfully. Please sign in again.",
    });
  } catch (error) {
    console.error(
      "Password change failed:",
      error instanceof Error
        ? error.message
        : "Unknown error"
    );

    return errorResponse(
      "Unable to complete the password change. Please try signing in again or contact an administrator if the problem persists.",
      500
    );
  }
}