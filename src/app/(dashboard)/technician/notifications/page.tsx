import type { Metadata } from "next";
import { notificationsEnabled } from "@/lib/notifications/notification-outbox";
import { NotificationInboxClient } from "@/components/notifications/notification-inbox-client";

export const metadata: Metadata = { title: "Notifications · ShiftChange 2.0" };
export const dynamic = "force-dynamic";

// TECH-HO-RECOVERY-09L — technician notification history surface. The inbox is a
// durable, individually-attributable record; opening an item is display metadata
// and never a handover confirmation, task acceptance, or attendance record.
export default function TechnicianNotificationsPage() {
  // The durable in-app inbox is the documented emulator fallback surface; only
  // real push registration is reserved for a live project (server APIs enforce
  // the same server-side gate, so this page never shows data when disabled).
  const active = notificationsEnabled();
  if (!active) {
    return (
      <section className="mx-auto max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h1 className="text-lg font-semibold text-[var(--foreground)]">Notifications</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Notifications are not available in this environment. They activate in a real project once push delivery
          is enabled. Your handovers and tasks are unaffected.
        </p>
      </section>
    );
  }
  return <NotificationInboxClient />;
}
