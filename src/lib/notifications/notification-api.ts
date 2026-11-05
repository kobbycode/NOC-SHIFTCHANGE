// TECH-HO-RECOVERY-09L — client API wrapper for the technician notification inbox.
// Mirrors the task-api response-validation discipline: never trust an unverified
// success flag, and treat "opened/read" strictly as UI metadata.
export interface InboxItem {
  id: string;
  eventKind: string;
  title: string;
  state: "unread" | "read" | "actioned";
  createdAt: string;
  readAt: string | null;
  actionedAt: string | null;
  outgoingShiftId: string | null;
  taskId: string | null;
  route: string;
}

export class NotificationApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "NotificationApiError";
  }
}

async function readApiResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new NotificationApiError("The server returned an unexpected response.", response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new NotificationApiError("The server returned invalid JSON.", response.status);
  }
}

export async function getInbox(): Promise<{ items: InboxItem[]; unread: number }> {
  const response = await fetch("/api/notifications/inbox", {
    method: "GET", credentials: "same-origin", cache: "no-store",
  });
  const data = await readApiResponse(response);
  if (!response.ok || !data || typeof data !== "object") {
    const message = data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
      ? (data as { error: string }).error : "The notification retrieval failed.";
    throw new NotificationApiError(message, response.status);
  }
  const result = data as { success: boolean; items?: unknown; unread?: unknown; error?: string };
  if (!result.success || !Array.isArray(result.items) || typeof result.unread !== "number") {
    throw new NotificationApiError("The notification response is invalid.", response.status);
  }
  return { items: result.items as InboxItem[], unread: result.unread };
}

// Marking read is display-only; it never confirms a handover or accepts a task.
export async function markRead(id: string): Promise<void> {
  if (!id || id.includes("/")) throw new NotificationApiError("Invalid notification.", 400);
  const response = await fetch(`/api/notifications/inbox/${encodeURIComponent(id)}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "read" }),
  });
  const data = await readApiResponse(response);
  const result = data as { success?: boolean; error?: string };
  if (!response.ok || result?.success !== true) {
    throw new NotificationApiError(result?.error ?? "Could not update the notification.", response.status);
  }
}

export { enablePush, watchForegroundPush } from "./browser-push";
