"use client";

// TECH-HO-RECOVERY-09L — technician inbox page. Pending-action cards list items
// that require a real business action; the card's button deep-links to the
// authoritative screen. Marking read here is display state ONLY and is decoupled
// from any confirmation/acceptance/attendance, which the linked workflow owns.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { enablePush, getInbox, markRead, watchForegroundPush, type InboxItem } from "@/lib/notifications/notification-api";
import { isPushRegistrationAvailableClient } from "@/lib/notifications/push-flags";

const ACCRA = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Accra",
});

const ACTIONABLE = new Set<string>([
  "outgoing_confirmation_required", "incoming_acceptance_required", "task_assigned", "task_reassigned", "task_transfer_outstanding",
]);

function group(item: InboxItem): "pending" | "history" {
  return ACTIONABLE.has(item.eventKind) && item.state !== "actioned" ? "pending" : "history";
}

export function NotificationInboxClient() {
  const router = useRouter();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pushStatus, setPushStatus] = useState<"idle" | "working" | "enabled" | "denied" | "unsupported">("idle");

  const refresh = useCallback(async () => {
    try {
      const result = await getInbox();
      setItems(result.items);
      setUnread(result.unread);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    let cancel = () => {};
    void watchForegroundPush(() => void refresh()).then((fn) => { cancel = fn; });
    return () => { clearInterval(interval); cancel(); };
  }, [refresh]);

  async function open(item: InboxItem) {
    if (item.state === "unread") void markRead(item.id).then(() => void refresh()).catch(() => {});
    router.push(item.route);
  }

  async function onEnablePush() {
    setPushStatus("working");
    const result = await enablePush();
    setPushStatus(result.registered ? "enabled" : result.permission === "denied" ? "denied" : "unsupported");
  }

  const pending = items.filter((item) => group(item) === "pending");
  const history = items.filter((item) => group(item) === "history");

  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[var(--foreground)]">Notifications</h1>
          <p className="text-sm text-[var(--muted)]">{unread} unread</p>
        </div>
        {isPushRegistrationAvailableClient() ? (
          pushStatus === "enabled" ? (
            <span className="text-xs text-[var(--muted)]">Push enabled</span>
          ) : (
            <button type="button" onClick={() => void onEnablePush()} disabled={pushStatus === "working"}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--accent)] disabled:opacity-60">
              {pushStatus === "working" ? "Enabling…" : pushStatus === "denied" ? "Allow notifications in browser settings" : "Enable push on this device"}
            </button>
          )
        ) : (
          <span className="text-xs text-[var(--muted)]">Push delivery activates in a live environment.</span>
        )}
      </header>

      {loading ? (
        <p className="text-sm text-[var(--muted)]">Loading…</p>
      ) : (
        <>
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-[var(--foreground)]">Needs your action</h2>
            {pending.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Nothing pending.</p>
            ) : pending.map((item) => (
              <article key={item.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 dark:bg-[var(--midnight)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--foreground)]">{item.title}</p>
                    <p className="text-xs text-[var(--muted)]">{ACCRA.format(new Date(item.createdAt))}</p>
                  </div>
                  <button type="button" onClick={() => void open(item)}
                    className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--obsidian)]">
                    Open
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-[var(--foreground)]">History</h2>
            {history.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No earlier notifications.</p>
            ) : history.map((item) => (
              <button key={item.id} type="button" onClick={() => void open(item)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-4 py-3 text-left hover:bg-[var(--elevated)]">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-[var(--foreground)]">{item.title}</span>
                  <span className="block text-xs text-[var(--muted)]">{ACCRA.format(new Date(item.createdAt))}</span>
                </span>
                <span className="shrink-0 text-xs capitalize text-[var(--muted)]">{item.state}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
