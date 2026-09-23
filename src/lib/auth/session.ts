
import "server-only";

import { cookies } from "next/headers";

import {
  getAdminAuth,
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  type AppUser,
  type UserRole,
  isUserRole,
} from "@/types/auth";

import { redirect } from "next/navigation";

export const SESSION_COOKIE = "__session";

export async function getCurrentUser(): Promise<AppUser | null> {
  const cookieStore = await cookies();

  const sessionCookie =
    cookieStore.get(SESSION_COOKIE)?.value;

  if (!sessionCookie) {
    return null;
  }

  try {
    const adminAuth = getAdminAuth();

    const decoded = await adminAuth.verifySessionCookie(
      sessionCookie,
      true
    );

    const authUser = await adminAuth.getUser(decoded.uid);

    if (authUser.disabled) {
      return null;
    }

    const profileSnapshot = await getAdminFirestore()
      .collection("users")
      .doc(decoded.uid)
      .get();

    if (!profileSnapshot.exists) {
      return null;
    }

    const profile = profileSnapshot.data();

    if (!profile) {
      return null;
    }

    const role = profile.role as unknown;

    if (!isUserRole(role)) {
      return null;
    }

    if (
  profile.status !== "active" ||
  profile.statusOperation != null
) {
  return null;
}

    if (decoded.role !== role) {
      return null;
    }

    return {
      uid: decoded.uid,
      fullName: profile.fullName,
      email: authUser.email ?? profile.email,
      role,
      status: "active",
      mustChangePassword:
        profile.mustChangePassword === true,
    };
  } catch {
    return null;
  }
}




export async function requireUser(
  allowedRoles?: UserRole[],
  options?: {
    allowPasswordChangeRequired?: boolean;
  }
): Promise<AppUser> {
  const user = await getCurrentUser();

  // Redirect unauthenticated users.
  if (user === null) {
    redirect("/login");
  }

  // Require an initial password change.
  if (
    user.mustChangePassword &&
    !options?.allowPasswordChangeRequired
  ) {
    redirect("/change-password");
  }

  // Enforce role-based access.
  if (
    allowedRoles &&
    !allowedRoles.includes(user.role)
  ) {
    redirect("/unauthorized");
  }

  return user;
}