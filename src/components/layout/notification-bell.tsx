"use client";

// TECH-HO-RECOVERY-09L — technician notification bell + inbox popover.
//
// Hidden whenever notifications are disabled. In emulator mode the bell
// uses the durable in-app inbox (push
// registration is hidden); a real project additionally offers push enablement.
// Tapping an item marks it read (display metadata ONLY) and navigates to
// the deep link; the protected action still happens inside the authenticated app.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";

import { isNotificationSurfaceEnabledClient, isPushRegistrationAvailableClient } from "@/lib/notifications/push-flags";
import { enablePush } from "@/lib/notifications/browser-push";
import { getInbox, markRead, type InboxItem } from "@/lib/notifications/notification-api";

const accraTime = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  hour12: false, timeZone: "Africa/Accra",
});

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [pushStatus, setPushStatus] = useState<"idle" | "working" | "enabled" | "unsupported" | "denied">("idle");
  const containerRef = useRef<HTMLDivElement>(null);

  const active = isNotificationSurfaceEnabledClient();
  const pushAvailable = isPushRegistrationAvailableClient();

  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      const result = await getInbox();
      setItems(result.items);
      setUnread(result.unread);
    } catch {
      // A failed refresh must never throw a technician off their workflow.
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    // Initial hydration of the unread badge; the async callback sets state after
    // the request resolves, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [active, refresh]);

  // Close the popover on outside click / escape.
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!active) return null;

  async function onToggle() {
    const next = !open;
    setOpen(next);
    if (next) await refresh();
  }

  async function openItem(item: InboxItem) {
    setOpen(false);
    if (item.state === "unread") {
      void markRead(item.id).then(() => void refresh()).catch(() => {});
    }
    router.push(item.route);
  }

  async function onEnablePush() {
    setPushStatus("working");
    const result = await enablePush();
    if (result.registered) setPushStatus("enabled");
    else if (result.permission === "denied") setPushStatus("denied");
    else setPushStatus("unsupported");
  }

  return (
    <div
      ref={containerRef}
      className="sm:relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => void onToggle()}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        className="relative grid size-8 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[var(--elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] pointer-coarse:size-11"
      >
        <Bell size={16} strokeWidth={1.75} aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute right-0 top-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--accent)] px-0.5 text-[10px] font-semibold text-[var(--accent-foreground)] pointer-coarse:right-1.5 pointer-coarse:top-1.5">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-3 top-full z-40 mt-2 w-[min(20rem,calc(100%-1.5rem))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-xl sm:right-0 sm:top-auto sm:w-80 dark:bg-[var(--midnight)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <span className="text-sm font-semibold text-[var(--foreground)]">Notifications</span>
            <Link href="/technician/notifications" onClick={() => setOpen(false)} className="text-xs text-[var(--accent)] hover:underline">
              View all
            </Link>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[var(--muted)]">No notifications yet.</p>
            ) : (
              items.slice(0, 8).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openItem(item)}
                  className="flex w-full items-start gap-3 border-b border-[var(--border)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--elevated)]"
                >
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${item.state === "unread" ? "bg-[var(--accent)]" : "bg-transparent"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--foreground)]">{item.title}</span>
                    <span className="block text-xs text-[var(--muted)]">{accraTime.format(new Date(item.createdAt))}</span>
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-[var(--border)] px-4 py-3">
            {!pushAvailable ? (
              <p className="text-xs text-[var(--muted)]">Push delivery activates in a live environment.</p>
            ) : pushStatus === "enabled" ? (
              <p className="text-xs text-[var(--muted)]">Push is enabled on this device.</p>
            ) : (
              <button
                type="button"
                onClick={() => void onEnablePush()}
                disabled={pushStatus === "working"}
                className="text-xs font-medium text-[var(--accent)] disabled:opacity-60"
              >
                {pushStatus === "working" ? "Enabling…" : pushStatus === "denied" ? "Permission blocked — allow notifications in browser settings" : "Enable push on this device"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
