
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
      <div className="h-10 w-10" aria-hidden="true" />
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
        flex h-10 w-10 items-center justify-center
        rounded-xl border border-slate-200
        bg-white text-slate-700
        transition-colors hover:bg-slate-100
        dark:border-slate-700
        dark:bg-slate-800 dark:text-slate-200
        dark:hover:bg-slate-700
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
        <Sun size={19} />
      ) : (
        <Moon size={19} />
      )}
    </button>
  );
}