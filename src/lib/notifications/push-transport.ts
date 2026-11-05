// TECH-HO-RECOVERY-09L — push transport seam.
//
// The delivery worker depends only on this interface. Locally the MockPushTransport
// is used so the entire lifecycle (idempotency, retry, invalid-token cleanup) is
// verifiable without Firebase Cloud Messaging (which has no emulator). The real
// FCM adapter implements the same interface and is used only in staging/production
// with provisioned credentials. An "accepted" result means FCM took the message,
// NEVER that the technician viewed it.
import type { PushTransportOutcome } from "@/types/notification";

export interface PushSendRequest {
  token: string;
  // Non-sensitive only: a short title and an opaque, relative deep-link route.
  title: string;
  deepLinkRoute: string;
  notificationId: string;
}

export interface PushSendResult {
  outcome: PushTransportOutcome;
  providerMessageId: string | null;
  errorClass: string | null;
}

export interface PushTransport {
  readonly name: "mock" | "fcm";
  send(request: PushSendRequest): Promise<PushSendResult>;
}

export interface MockSendRecord extends PushSendRequest {
  result: PushSendResult;
}

// Deterministic mock. Token prefixes steer the outcome so tests can exercise
// every branch without real devices:
//   "invalid:..."  -> INVALID_TOKEN (triggers token cleanup)
//   "fail:..."     -> FAILED_RETRYABLE (triggers retry/backoff)
//   "unsupported"  -> UNSUPPORTED
//   anything else  -> ACCEPTED
export class MockPushTransport implements PushTransport {
  readonly name = "mock" as const;
  readonly sends: MockSendRecord[] = [];
  private counter = 0;

  async send(request: PushSendRequest): Promise<PushSendResult> {
    let result: PushSendResult;
    if (request.token.startsWith("invalid:")) {
      result = { outcome: "invalid_token", providerMessageId: null, errorClass: "messaging/registration-token-not-registered" };
    } else if (request.token.startsWith("fail:")) {
      result = { outcome: "failed_retryable", providerMessageId: null, errorClass: "messaging/internal-error" };
    } else if (request.token === "unsupported") {
      result = { outcome: "unsupported", providerMessageId: null, errorClass: "transport/unsupported" };
    } else {
      this.counter += 1;
      result = { outcome: "accepted", providerMessageId: `mock-message-${this.counter}`, errorClass: null };
    }
    this.sends.push({ ...request, result });
    return result;
  }

  reset(): void {
    this.sends.length = 0;
    this.counter = 0;
  }
}

export const mockPushTransport = new MockPushTransport();
