"use client";

// TECH-HO-RECOVERY-09L — browser push registration + foreground handling.
//
// This runs ONLY in a real (non-emulator) project with notifications enabled,
// because Web Push requires a provisioned FCM project and a VAPID key — neither
// exists in the local emulators, so local verification never enters here.
// Enabling push NEVER grants or records any business action: it is transport
// registration only. A received/opened push does not confirm a handover, accept a
// task, or mark attendance; the authenticated app re-fetches protected content.
import { initializeApp, getApp, getApps, type FirebaseApp } from "firebase/app";

import { isPushRegistrationAvailableClient } from "./push-flags";

const INSTALLATION_KEY = "shiftchange.installationId";

// The Firebase default app is initialized on the login page only; a technician
// who lands on a dashboard via deep link or refresh never ran it, so the push
// module must be able to bring up the app itself before getMessaging().
function ensureFirebaseApp(): FirebaseApp {
  if (getApps().length > 0) return getApp();
  return initializeApp({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  });
}

function notificationsEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    isPushRegistrationAvailableClient() &&
    "Notification" in window &&
    "serviceWorker" in navigator
  );
}

// A stable per-browser installation id. Exactly one technician is bound to an
// installation server-side, so a shared-device account switch overwrites the
// previous binding instead of leaking another technician's notifications.
function installationId(): string {
  let id = window.localStorage.getItem(INSTALLATION_KEY);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() ?? `inst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(INSTALLATION_KEY, id);
  }
  return id;
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const query = new URLSearchParams({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  });
  return navigator.serviceWorker.register(`/firebase-messaging-sw.js?${query.toString()}`, {
    type: "module",
    scope: "/",
  });
}

// Requests permission and registers this device's token with the server.
// Returns the registration result, or null when push is unavailable here.
export async function enablePush(): Promise<{ registered: boolean; permission: NotificationPermission }> {
  if (!notificationsEnabled()) return { registered: false, permission: "default" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { registered: false, permission };

  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) return { registered: false, permission };

  // A missing VAPID key, an unconfigured project, or an FCM error must leave the
  // technician on a usable screen with an honest "not enabled" state, never a
  // stuck button or an unhandled rejection.
  try {
    const registration = await registerServiceWorker();
    const { getMessaging, getToken } = await import("firebase/messaging");
    const messaging = getMessaging(ensureFirebaseApp());

    const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
    if (!token) return { registered: false, permission };

    const response = await fetch("/api/notifications/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        installationId: installationId(),
        token,
        platform: navigator.userAgent.slice(0, 64),
      }),
    });
    return { registered: response.ok, permission };
  } catch {
    return { registered: false, permission };
  }
}

// Foreground handler: shows an in-app notification and lets the inbox refresh.
// A foreground push is display-only; the technician still performs the real
// action inside the authenticated app.
export async function watchForegroundPush(refreshInbox: () => void): Promise<() => void> {
  if (!notificationsEnabled()) return () => {};
  const { getMessaging, onMessage } = await import("firebase/messaging");
  const messaging = getMessaging(ensureFirebaseApp());
  return onMessage(messaging, (payload) => {
    const title = payload?.notification?.title ?? "ShiftChange notification";
    if (document.visibilityState !== "visible") {
      new Notification(title, { body: "Open ShiftChange to view details.", icon: "/icon.svg" });
    }
    refreshInbox();
  });
}
