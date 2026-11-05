// TECH-HO-RECOVERY-09L — transport selection for the delivery backend.
//
// The worker is transport-agnostic; this is the single place that chooses which
// PushTransport the trusted scheduler uses. Default is mock so nothing can send
// a real push by accident. Real FCM is used only when NOTIFICATIONS_TRANSPORT is
// explicitly "fcm" — an owner-controlled staging/production setting. FcmPushTransport
// itself does not touch Cloud Messaging credentials until send() is called.
import "server-only";

import { fcmPushTransport } from "./fcm-push-transport";
import { mockPushTransport, type PushTransport } from "./push-transport";

export function resolvePushTransport(env: NodeJS.ProcessEnv = process.env): PushTransport {
  const choice = (env.NOTIFICATIONS_TRANSPORT ?? "mock").trim().toLowerCase();
  if (choice === "fcm" || choice === "firebase") return fcmPushTransport;
  return mockPushTransport;
}
