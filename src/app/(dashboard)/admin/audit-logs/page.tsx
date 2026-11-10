import Link from "next/link";

import { getCurrentUser } from "@/lib/auth/session";

import { formatDateTime } from "@/lib/format";

import { listAuditLogs } from "@/lib/operations/audit-log-read";

export const dynamic = "force-dynamic";

interface AuditLogsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function pageHref(
  page: number,
  action: string | null,
  actorUid: string | null,
): string {
  const params = new URLSearchParams();

  if (action) params.set("action", action);
  if (actorUid) params.set("actor", actorUid);
  if (page > 1) params.set("page", String(page));

  const query = params.toString();

  return query ? `/admin/audit-logs?${query}` : "/admin/audit-logs";
}

export default async function AdminAuditLogsPage({
  searchParams,
}: AuditLogsPageProps) {
  const actor = await getCurrentUser();

  if (!actor) return null;

  const params = await searchParams;
  const requestedPage = Number.parseInt(single(params.page), 10);

  const view = await listAuditLogs(actor, {
    action: single(params.action) || null,
    actorUid: single(params.actor) || null,
    page: Number.isFinite(requestedPage) ? requestedPage : 1,
  });

  const stats = [
    ["Matching records", view.total],
    ["Action types", view.actions.length],
    ["Accounts acting", view.actors.length],
    ["Receipt records skipped", view.recordsSkipped],
  ] as const;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Audit Logs</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Read-only history of account, shift, handover, and operational record
          activity. Entries are written by the server and cannot be edited here.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)]"
          >
            <p className="text-sm text-[var(--muted)]">{label}</p>
            <p className="mt-2 text-2xl font-bold">{value}</p>
          </div>
        ))}
      </div>

      <p className="text-sm text-[var(--muted)]">
        Latest recorded activity: {formatDateTime(view.latestTimestamp)}
        {" · "}
        {view.recordsScanned} stored records inspected
      </p>

      <form
        method="get"
        className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <label className="min-w-0 flex-1 text-sm">
          <span className="mb-2 block font-medium">Action</span>
          <select
            name="action"
            defaultValue={view.filters.action ?? ""}
            className="min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <option value="">All actions</option>
            {view.actions.map((action) => (
              <option key={action.value} value={action.value}>
                {action.label} ({action.count})
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-0 flex-1 text-sm">
          <span className="mb-2 block font-medium">Account</span>
          <select
            name="actor"
            defaultValue={view.filters.actorUid ?? ""}
            className="min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-3 py-2 text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <option value="">All accounts</option>
            {view.actors.map((account) => (
              <option key={account.uid} value={account.uid}>
                {account.name} ({account.count})
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-3">
          <button
            type="submit"
            className="btn-accent rounded-lg px-4 py-2 text-sm font-semibold"
          >
            Apply filters
          </button>

          <Link
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--elevated)]"
            href="/admin/audit-logs"
          >
            Clear
          </Link>
        </div>
      </form>

      {view.truncated && (
        <p className="text-xs text-[var(--muted)]">
          The viewer inspects the first 1,000 stored audit records. Older records
          may not appear in this list.
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            Audit log entries ordered by newest recorded activity
          </caption>
          <thead className="bg-[var(--elevated)] text-xs uppercase tracking-wide text-[var(--muted)]">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">
                Recorded
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Action
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Account
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Target and details
              </th>
            </tr>
          </thead>
          <tbody>
            {view.entries.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-[var(--muted)]"
                >
                  No audit records match these filters.
                </td>
              </tr>
            ) : (
              view.entries.map((entry) => (
                <tr
                  key={entry.documentId}
                  className="border-t border-[var(--border)] align-top"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-[var(--muted)]">
                    {formatDateTime(entry.timestamp)}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{entry.actionLabel}</p>
                    <p className="mt-1 break-all text-xs text-[var(--muted)]">
                      {entry.action}
                    </p>
                  </td>
                  <td className="px-4 py-3 font-medium">{entry.actorName}</td>
                  <td className="px-4 py-3">
                    {entry.target && <p className="font-medium">{entry.target}</p>}

                    {entry.details.map((detail) => (
                      <p
                        key={detail.label}
                        className="mt-1 text-xs text-[var(--muted)]"
                      >
                        <span className="font-medium text-[var(--foreground)]">
                          {detail.label}:
                        </span>{" "}
                        {detail.value}
                      </p>
                    ))}

                    {!entry.target && entry.details.length === 0 && (
                      <span className="text-[var(--muted)]">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {view.pageCount > 1 && (
        <nav
          aria-label="Audit log pages"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          {view.page > 1 ? (
            <Link
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--elevated)]"
              href={pageHref(view.page - 1, view.filters.action, view.filters.actorUid)}
            >
              Previous
            </Link>
          ) : (
            <span />
          )}

          <span className="text-sm text-[var(--muted)]">
            Page {view.page} of {view.pageCount}
          </span>

          {view.page < view.pageCount ? (
            <Link
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--elevated)]"
              href={pageHref(view.page + 1, view.filters.action, view.filters.actorUid)}
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
