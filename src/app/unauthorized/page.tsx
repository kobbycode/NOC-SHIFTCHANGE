
import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-3xl font-bold">
        Access denied
      </h1>

      <p className="max-w-md text-[var(--muted)]">
        Your account does not have permission to access
        this section.
      </p>

      <Link
        href="/"
        className="btn-accent rounded-lg px-5 py-3 font-medium"
      >
        Return to home
      </Link>
    </main>
  );
}