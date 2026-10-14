"use client";

import {
  Bell,
  Menu,
  UserRound,
} from "lucide-react";

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

import { usePathname } from "next/navigation";

interface AppHeaderProps {
  role: UserRole;
  sidebarOpen: boolean;
  onMenuClick: () => void;
}

export function AppHeader({
  role,
  sidebarOpen,
  onMenuClick,
}: AppHeaderProps) {
  const pathname = usePathname();
  const navigation = ROLE_NAVIGATION[role];
  const roleTitle = {
    admin: "Administrator",
    supervisor: "Supervisor",
    technician: "Technician",
  }[role];

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

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <ThemeToggle />

        <div
          title="Notifications will be available in a later phase"
          className="
            flex h-11 w-11 items-center justify-center
            rounded-xl text-[var(--muted)]
          "
        >
          <Bell size={20} />
        </div>

        <div
          className="
            flex h-11 w-11 items-center justify-center
            rounded-full bg-[var(--accent)]
            text-[var(--obsidian)]
            dark:bg-[var(--accent)]
            dark:text-[var(--obsidian)]
          "
          role="img"
          aria-label="User profile"
        >
          <UserRound size={20} />
        </div>
      </div>
    </header>
  );
}
