// TECH-HO-RECOVERY-09L — real FCM push transport (staging / production only).
//
// Implements the same PushTransport seam as the mock, backed by Firebase Cloud
// Messaging via the Admin SDK. This adapter is NOT exercised locally: the
// Firebase emulator suite has no Cloud Messaging emulator, so real delivery is
// UNVERIFIED until an authorized staging-device test succeeds. It is only
// instantiated when a real project is configured, and only ever called from the
// trusted outbox worker OUTSIDE a Firestore transaction.
//
// Contract preserved from the seam:
//   - "accepted" means FCM admitted the message, NOT that the technician saw it.
//   - A send failure maps to a retryable/invalid outcome and can never block or
//     roll back the business event that created the outbox row.
//   - Only non-sensitive data (a short title and an opaque relative route) leaves
//     the server; task/handover detail is never placed in the push payload.
import "server-only";

import { getMessaging, type Messaging } from "firebase-admin/messaging";

import { getAdminApp } from "@/lib/firebase/admin";

import type { PushTransportOutcome } from "@/types/notification";

import type { PushSendRequest, PushSendResult, PushTransport } from "./push-transport";

// FCM v1 error codes -> transport outcome. Anything not listed is treated as a
// transient failure so the outbox retries rather than silently dropping.
const INVALID_TOKEN_CODES = new Set<string>([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);
const RETRYABLE_CODES = new Set<string>([
  "messaging/internal-error",
  "messaging/unknown",
  "messaging/server-unavailable",
  "messaging/quota-exceeded",
  "messaging/third-party-auth-error",
  "messaging/unavailable",
]);

function hasCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "messaging/unknown";
}

function hasToken(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && INVALID_TOKEN_CODES.has((error as { code: unknown }).code as string);
}

export class FcmPushTransport implements PushTransport {
  readonly name = "fcm" as const;
  private messaging: Messaging | null = null;

  private resolveMessaging(): Messaging {
    if (!this.messaging) this.messaging = getMessaging(getAdminApp());
    return this.messaging;
  }

  async send(request: PushSendRequest): Promise<PushSendResult> {
    // The token itself is never logged; only an opaque error class is returned.
    if (!request.token) {
      return { outcome: "unsupported", providerMessageId: null, errorClass: "transport/missing-token" };
    }
    try {
      const messageId = await this.resolveMessaging().send({
        token: request.token,
        // A minimal, non-sensitive display body. Real content stays behind the
        // authenticated deep link, fetched by the client after tap.
        notification: { title: request.title },
        webpush: {
          fcmOptions: { link: request.deepLinkRoute },
          notification: { title: request.title, badge: "/icon.svg" },
        },
        data: { notificationId: request.notificationId, route: request.deepLinkRoute },
      });
      return { outcome: "accepted", providerMessageId: messageId, errorClass: null };
    } catch (error) {
      const code = hasCode(error);
      if (hasToken(error)) return { outcome: "invalid_token", providerMessageId: null, errorClass: code };
      if (code === "messaging/messaging-insufficient-permission" || code === "transport/unsupported") {
        return { outcome: "unsupported", providerMessageId: null, errorClass: code };
      }
      // Everything else (internal, unavailable, quota, unknown) is transient.
      return { outcome: "failed_retryable", providerMessageId: null, errorClass: code };
    }
  }
}

export function classifyFcmError(error: unknown): PushTransportOutcome {
  const code = hasCode(error);
  if (INVALID_TOKEN_CODES.has(code)) return "invalid_token";
  if (RETRYABLE_CODES.has(code)) return "failed_retryable";
  return "failed_retryable";
}

export const fcmPushTransport = new FcmPushTransport();
