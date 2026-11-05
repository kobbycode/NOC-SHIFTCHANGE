import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { markNotificationRead } from "@/lib/notifications/notification-service";
import { notificationsEnabled } from "@/lib/notifications/notification-outbox";
import { mapNotificationError, respond, sameOrigin } from "@/lib/notifications/notification-http";
import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// Marking a notification read is display metadata only. It never confirms a
// handover, accepts a task, or records attendance — those stay owned by the
// authoritative services. Ownership is re-checked server-side via recipientUid.
export async function POST(request: NextRequest, context: Context) {
  if (!notificationsEnabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account cannot update this notification." }, 403);
  }
  if (!sameOrigin(request)) return respond({ success: false, error: "Invalid request origin." }, 403);
  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { return respond({ success: false, error: "Invalid request JSON." }, 400); }
    if (!body || typeof body !== "object" || (body as { action?: unknown }).action !== "read") {
      throw new AssignmentOperationError("Unsupported notification action.", 400);
    }
    const { id } = await context.params;
    await markNotificationRead(actor.uid, id, new Date().toISOString());
    return respond({ success: true }, 200);
  } catch (error) {
    return mapNotificationError(error, "Notification update failed:");
  }
}
