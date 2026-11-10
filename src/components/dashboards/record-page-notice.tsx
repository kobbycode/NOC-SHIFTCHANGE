import Link from "next/link";

export function RecordPageNotice({
  title,
  description,
  heading,
  body,
}: {
  title: string;
  description: string;
  heading: string;
  body: string;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>
      </div>

      <div
        role="status"
        className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-900"
      >
        <h2 className="text-lg font-semibold">{heading}</h2>
        <p className="text-sm">{body}</p>

        <div className="flex flex-wrap gap-3 pt-1">
          <Link
            className="btn-accent rounded-lg px-4 py-2 text-sm font-medium"
            href="/technician"
          >
            Open My Shift
          </Link>

          <Link
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium"
            href="/technician/operations"
          >
            Open Shift Operations
          </Link>
        </div>
      </div>
    </section>
  );
}
