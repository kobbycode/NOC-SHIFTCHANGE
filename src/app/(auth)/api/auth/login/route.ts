
import { NextRequest, NextResponse } from "next/server";

import {
  getAdminAuth,
  getAdminFirestore,
} from "@/lib/firebase/admin";

import { isUserRole } from "@/types/auth";

import { SESSION_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";

const SESSION_DURATION = 60 * 60 * 24 * 5 * 1000;

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
        expiresIn: SESSION_DURATION,
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

    response.cookies.set({
      name: SESSION_COOKIE,
      value: sessionCookie,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_DURATION / 1000,
    });

    return response;
  } catch {
    return NextResponse.json(
      { error: "Authentication failed." },
      { status: 401 }
    );
  }
}