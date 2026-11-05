"use client";

// TECH-HO-RECOVERY-09L — client-side gate helpers. Real Web Push is impossible
// in emulator mode (no Cloud Messaging emulator exists), so push REGISTRATION is
// disabled there. The durable in-app inbox, however, is the documented emulator
// fallback surface and stays available whenever notifications are enabled —
// this mirrors the server API routes, which are gated only by the server flag.
export function isFirebaseEmulatorMode(): boolean {
  return process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";
}

export function areNotificationsEnabledClient(): boolean {
  return process.env.NEXT_PUBLIC_NOTIFICATIONS_ENABLED === "true";
}

// Inbox/notification UI surface (bell, inbox page). Emulator-safe: the surface
// degrades to the durable in-app inbox and hides push registration.
export function isNotificationSurfaceEnabledClient(): boolean {
  return areNotificationsEnabledClient();
}

// Full push capability (registration, foreground messages): requires a real
// (non-emulator) Firebase project with notifications enabled.
export function isPushRegistrationAvailableClient(): boolean {
  return areNotificationsEnabledClient() && !isFirebaseEmulatorMode();
}
