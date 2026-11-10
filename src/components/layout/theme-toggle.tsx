
"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

function subscribeToClient() {
  return () => {};
}

function getClientSnapshot() {
  return true;
}

function getServerSnapshot() {
  return false;
}
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  const mounted = useSyncExternalStore(
    subscribeToClient,
    getClientSnapshot,
    getServerSnapshot
  );

  if (!mounted) {
    return (
      <div className="size-8 pointer-coarse:size-11" aria-hidden="true" />
    );
  }

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() =>
        setTheme(isDark ? "light" : "dark")
      }
      className="
        grid size-8 place-items-center rounded-lg text-[var(--muted)]
        pointer-coarse:size-11
        transition-[background-color,color,transform]
        duration-[160ms] ease-atelier
        hover:bg-[var(--elevated)]
        active:scale-[0.96]
        focus-visible:outline-none focus-visible:ring-2
        focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2
        motion-reduce:transition-none motion-reduce:active:scale-100
      "
      aria-label={
        isDark
          ? "Switch to light mode"
          : "Switch to dark mode"
      }
      title={
        isDark
          ? "Switch to light mode"
          : "Switch to dark mode"
      }
    >
      {isDark ? (
        <Sun size={16} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Moon size={16} strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  );
}
