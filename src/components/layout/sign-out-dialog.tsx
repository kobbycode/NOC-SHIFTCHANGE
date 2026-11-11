"use client";

import { useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

interface SignOutDialogProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  onSignedOut: () => void;
}

export function SignOutDialog({ dialogRef, onSignedOut }: SignOutDialogProps) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function handleLogout() {
    if (loggingOut) {
      return;
    }

    setLoggingOut(true);
    setLogoutError(null);

    try {
      const response = await fetch(
        "/api/auth/logout",
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
        }
      );

      if (!response.ok) {
        throw new Error(
          "Unable to end the current session."
        );
      }

      dialogRef.current?.close();
      onSignedOut();
      router.replace("/login");
      router.refresh();
    } catch {
      setLogoutError(
        "Unable to log out. Please try again."
      );

      setLoggingOut(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={() => setLogoutError(null)}
      aria-labelledby="logout-title"
      aria-describedby="logout-description"
      onCancel={(event) => {
        if (loggingOut) event.preventDefault();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-2xl backdrop:bg-black/60 sm:p-6"
    >
      <h2 id="logout-title" className="text-lg font-semibold">Sign out?</h2>
      <p id="logout-description" className="mt-2 text-sm text-[var(--muted)]">
        This will end your current ShiftChange session.
      </p>

      {logoutError && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
          {logoutError}
        </p>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={loggingOut}
          onClick={() => dialogRef.current?.close()}
          className="min-h-11 rounded-lg border border-[var(--border)] px-4 text-sm font-semibold hover:bg-[var(--elevated)] focus-visible:outline-2 focus-visible:outline-[var(--foreground)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={loggingOut}
          onClick={() => void handleLogout()}
          className="btn-accent inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold disabled:opacity-50"
        >
          {loggingOut && <LoaderCircle size={17} className="motion-safe:animate-spin" aria-hidden="true" />}
          {loggingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </dialog>
  );
}
