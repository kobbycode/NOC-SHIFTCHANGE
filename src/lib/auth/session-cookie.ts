import "server-only";

import type { NextResponse } from "next/server";

export const SESSION_COOKIE = "__session";

// One session policy for every issuer: the interactive login route and the
// handover acceptance that signs the incoming technician in on a shared console.
export const SESSION_DURATION_MS = 60 * 60 * 24 * 5 * 1000;

export function applySessionCookie(response: NextResponse, sessionCookie: string): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: sessionCookie,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_MS / 1000,
  });
}