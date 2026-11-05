import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { registerDevice, deactivateDevice } from "@/lib/notifications/device-registry";
import { notificationsEnabled } from "@/lib/notifications/notification-outbox";
import { mapNotificationError, parseDeviceDeactivationBody, parseDeviceRegistrationBody, respond, sameOrigin } from "@/lib/notifications/notification-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Registers THIS authenticated technician's browser token against their own uid.
// The uid comes from the verified session cookie, never the body, so a client can
// never bind a token to another technician. A device token carries no operational
// authority: it cannot confirm, accept, or record attendance.
export async function POST(request: NextRequest) {
  if (!notificationsEnabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account cannot register a device." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid device JSON." }, 400); }
    const parsed = parseDeviceRegistrationBody(body);
    const result = await registerDevice({ uid: actor.uid, now: new Date().toISOString(), ...parsed });
    return respond({ success: true, deviceRef: result.deviceRef }, 200);
  } catch (error) {
    return mapNotificationError(error, "Device registration failed:");
  }
}

// Explicitly deactivates the current technician's binding for this installation
// (e.g. opting out). Never deactivates another technician's device.
export async function DELETE(request: NextRequest) {
  if (!notificationsEnabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account cannot deregister a device." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid device JSON." }, 400); }
    const parsed = parseDeviceDeactivationBody(body);
    await deactivateDevice({ ...parsed, uid: actor.uid, reason: "user_opt_out", now: new Date().toISOString() });
    return respond({ success: true }, 200);
  } catch (error) {
    return mapNotificationError(error, "Device deactivation failed:");
  }
}
