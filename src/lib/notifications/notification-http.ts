import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";

// TECH-HO-RECOVERY-09L — shared HTTP helpers for notification routes. Origin
// checking mirrors the existing V2 report routes (APP_ORIGIN, else request
// origin) so a cross-site request can neither register a device nor read or
// mutate another session's inbox.
export function respond(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

export function sameOrigin(request: NextRequest): boolean {
  const expectedOrigin = process.env.APP_ORIGIN ?? request.nextUrl.origin;
  return request.headers.get("origin") === expectedOrigin;
}

function identifier(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > max) {
    throw new AssignmentOperationError(`Invalid ${label}.`, 400);
  }
  return value;
}

export function parseDeviceRegistrationBody(value: unknown): { installationId: string; token: string; platform: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentOperationError("Invalid device request.", 400);
  const data = value as Record<string, unknown>;
  return {
    installationId: identifier(data.installationId, 128, "installation id"),
    token: identifier(data.token, 8192, "device token"),
    platform: typeof data.platform === "string" ? data.platform.slice(0, 64) : "unknown",
  };
}

export function parseDeviceDeactivationBody(value: unknown): { installationId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentOperationError("Invalid device request.", 400);
  const data = value as Record<string, unknown>;
  return { installationId: identifier(data.installationId, 128, "installation id") };
}

export function mapNotificationError(error: unknown, fallback: string) {
  if (error instanceof AssignmentOperationError) return respond({ success: false, error: error.message }, error.status);
  if (error instanceof Error && /not available to your account/i.test(error.message)) return respond({ success: false, error: error.message }, 403);
  console.error(fallback, error);
  return respond({ success: false, error: "The request could not be completed." }, 500);
}
