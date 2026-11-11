"use client";

import {
  LogOut,
  Menu,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { UserRole } from "@/types/auth";

import {
  ROLE_NAVIGATION,
} from "@/config/navigation";

import type {
  NavigationItem,
} from "@/config/navigation";

import {
  ThemeToggle,
} from "./theme-toggle";

import {
  NotificationBell,
} from "./notification-bell";

import { usePathname } from "next/navigation";

interface AppHeaderProps {
  role: UserRole;
  fullName: string;
  sidebarOpen: boolean;
  onMenuClick: () => void;
  onRequestSignOut: () => void;
}

export function AppHeader({
  role,
  fullName,
  sidebarOpen,
  onMenuClick,
  onRequestSignOut,
}: AppHeaderProps) {
  const pathname = usePathname();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const navigation = ROLE_NAVIGATION[role];
  const roleTitle = {
    admin: "Administrator",
    supervisor: "Supervisor",
    technician: "Technician",
  }[role];

  useEffect(() => {
    if (!accountOpen) return;

    function closeOnOutsidePress(event: PointerEvent) {
      if (event.target instanceof Node && !accountRef.current?.contains(event.target)) {
        setAccountOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [accountOpen]);

  function getSectionTitle(
    path: string,
    navItems: NavigationItem[]
  ): string {
    let bestMatch: NavigationItem | null = null;
    let bestLength = -1;

    for (const item of navItems) {
      const matches =
        path === item.href ||
        path.startsWith(`${item.href}/`);

      if (matches && item.href.length > bestLength) {
        bestLength = item.href.length;
        bestMatch = item;
      }
    }

    return bestMatch ? bestMatch.label : path;
  }

  const sectionTitle = getSectionTitle(pathname, navigation);

  return (
    <header data-dashboard-header
      className="
        sticky top-0 z-30
        flex h-16 min-w-0 items-center
        justify-between gap-2
        border-b border-[var(--border)]
        bg-[var(--surface)]
        px-3
        dark:border-[var(--border)]
        dark:bg-[var(--midnight)]
        sm:h-[72px] sm:gap-4 sm:px-6 lg:px-8
      "
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation"
          aria-expanded={sidebarOpen}
          aria-controls="mobile-navigation"
          className="
            flex h-11 w-11 shrink-0 items-center justify-center rounded-xl
            text-[var(--muted)]
            transition-[background-color,color,transform] duration-[160ms]
            ease-atelier
            hover:bg-[var(--elevated)]
            active:scale-[0.96]
            focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2
            dark:text-[var(--muted)] dark:hover:bg-[var(--elevated)]
            motion-reduce:transition-none motion-reduce:active:scale-100
            lg:hidden
          "
        >
          <Menu size={22} />
        </button>

        <div className="min-w-0">
          <h2
            className="
              truncate whitespace-nowrap text-base font-semibold
              text-[var(--foreground)] sm:text-lg
              dark:text-[var(--foreground)]
            "
          >
            {sectionTitle}
          </h2>

          <p className="hidden truncate text-xs text-[var(--muted)] sm:block">
            {roleTitle} Workspace
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <ThemeToggle />

        {role === "technician" && <NotificationBell />}

        <div
          ref={accountRef}
          className="relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setAccountOpen(false);
          }}
          onKeyDown={(event) => {
            if (accountOpen && event.key === "Escape") {
              setAccountOpen(false);
              accountButton.current?.focus();
            }
          }}
        >
          <button
            ref={accountButton}
            type="button"
            aria-label="Account"
            aria-expanded={accountOpen}
            aria-controls={accountOpen ? "dashboard-account-panel" : undefined}
            onClick={() => setAccountOpen((open) => !open)}
            className="group grid size-8 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--foreground)] pointer-coarse:size-11"
          >
            <span className="grid size-8 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-foreground)] group-hover:bg-[var(--accent-hover)]">
              <UserRound size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
          </button>

          {accountOpen && (
            <div
              id="dashboard-account-panel"
              className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] shadow-lg"
            >
              <div className="border-b border-[var(--border)] px-4 py-3">
                <p className="text-sm font-semibold wrap-anywhere">{fullName}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">{roleTitle}</p>
              </div>
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => {
                  accountButton.current?.focus();
                  setAccountOpen(false);
                  onRequestSignOut();
                }}
                className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium hover:bg-[var(--elevated)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--foreground)]"
              >
                <LogOut size={16} aria-hidden="true" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
