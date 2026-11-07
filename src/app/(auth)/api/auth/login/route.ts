
import { NextRequest, NextResponse } from "next/server";

import {
  getAdminAuth,
  getAdminFirestore,
} from "@/lib/firebase/admin";

import { isUserRole } from "@/types/auth";

import { SESSION_DURATION_MS, applySessionCookie } from "@/lib/auth/session-cookie";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const idToken = body?.idToken;

    if (typeof idToken !== "string" || !idToken) {
      return NextResponse.json(
        { error: "Authentication token is required." },
        { status: 400 }
      );
    }

    const auth = getAdminAuth();

    const decoded = await auth.verifyIdToken(idToken, true);

    const authTime = decoded.auth_time;

    if (
      typeof authTime !== "number" ||
      Date.now() / 1000 - authTime > 300
    ) {
      return NextResponse.json(
        { error: "Please sign in again." },
        { status: 401 }
      );
    }

    const authUser = await auth.getUser(decoded.uid);

    if (authUser.disabled) {
      return NextResponse.json(
        { error: "This account is unavailable." },
        { status: 403 }
      );
    }

    const profileSnapshot = await getAdminFirestore()
      .collection("users")
      .doc(decoded.uid)
      .get();

    if (!profileSnapshot.exists) {
      return NextResponse.json(
        { error: "User profile not found." },
        { status: 403 }
      );
    }

    const profile = profileSnapshot.data();

    if (
  !profile ||
  profile.status !== "active" ||
  profile.statusOperation != null ||
  !isUserRole(profile.role) ||
  decoded.role !== profile.role
){
      return NextResponse.json(
        { error: "Account access is unavailable." },
        { status: 403 }
      );
    }

    const sessionCookie = await auth.createSessionCookie(
      idToken,
      {
        expiresIn: SESSION_DURATION_MS,
      }
    );

    const response = NextResponse.json({
      user: {
        uid: decoded.uid,
        fullName: profile.fullName,
        email: authUser.email,
        role: profile.role,
        mustChangePassword:
          profile.mustChangePassword === true,
      },
    });

    applySessionCookie(response, sessionCookie);

    return response;
  } catch {
    return NextResponse.json(
      { error: "Authentication failed." },
      { status: 401 }
    );
  }
}