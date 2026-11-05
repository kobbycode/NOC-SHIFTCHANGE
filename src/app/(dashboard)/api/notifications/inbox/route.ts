import "server-only";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { listInbox, unreadCount } from "@/lib/notifications/notification-service";
import { notificationsEnabled } from "@/lib/notifications/notification-outbox";
import { respond } from "@/lib/notifications/notification-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reads ONLY the authenticated technician's own inbox. Ownership is enforced by
// recipientUid inside the service query, so this can never enumerate another
// technician's notifications — including on a shared device.
export async function GET(request: NextRequest) {
  if (!notificationsEnabled()) return respond({ success: false, error: "Not found." }, 404);
  const actor = await getCurrentUser();
  if (!actor) return respond({ success: false, error: "Please sign in to continue." }, 401);
  if (actor.role !== "technician" || actor.mustChangePassword) {
    return respond({ success: false, error: "Your account cannot view this inbox." }, 403);
  }
  const origin = request.headers.get("origin");
  const expected = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  if (origin && origin !== expected) return respond({ success: false, error: "Invalid request origin." }, 403);
  const items = await listInbox(actor.uid, 50);
  const unread = await unreadCount(actor.uid);
  return respond({ success: true, items, unread }, 200);
}
