"use client";

import { useState, useSyncExternalStore } from "react";

import Link from "next/link";

import {
  usePathname,
  useRouter,
} from "next/navigation";

import {
  LoaderCircle,
  LockKeyhole,
  LogOut,
  RadioTower,
  X,
} from "lucide-react";

import type { UserRole } from "@/types/auth";

import type {
  NavigationItem,
} from "@/config/navigation";

import {
  ROLE_NAVIGATION,
} from "@/config/navigation";

interface AppSidebarProps {
  role: UserRole;
  open: boolean;
  onClose: () => void;
}

const AVAILABLE_ROUTES = new Set([
  "/admin",
  "/admin/users",
  "/supervisor",
  "/supervisor/shifts",
  "/supervisor/attendance",
  "/supervisor/tasks",
  "/technician",
  "/technician/tasks",
  "/technician/operations",
  "/technician/handovers",
  "/supervisor/handovers",
]);

const DESKTOP_NAV_QUERY = "(min-width: 1024px)";

function subscribeDesktopNav(onStoreChange: () => void) {
  const media = window.matchMedia(DESKTOP_NAV_QUERY);

  media.addEventListener("change", onStoreChange);

  return () => {
    media.removeEventListener("change", onStoreChange);
  };
}

function getDesktopNavSnapshot() {
  return window.matchMedia(DESKTOP_NAV_QUERY).matches;
}

function getDesktopNavServerSnapshot() {
  // Hydration must match SSR. After mount, the client snapshot
  // updates mobile viewports without throwing a mismatch.
  return true;
}

function getMostSpecificMatch(
  pathname: string,
  items: NavigationItem[],
  availableRoutes: Set<string>
): NavigationItem | null {
  let bestMatch: NavigationItem | null = null;
  let bestLength = -1;

  for (const item of items) {
    if (!availableRoutes.has(item.href)) continue;

    const matches =
      pathname === item.href ||
      pathname.startsWith(`${item.href}/`);

    if (matches && item.href.length > bestLength) {
      bestLength = item.href.length;
      bestMatch = item;
    }
  }

  return bestMatch;
}

export function AppSidebar({
  role,
  open,
  onClose,
}: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const isDesktopNav = useSyncExternalStore(
    subscribeDesktopNav,
    getDesktopNavSnapshot,
    getDesktopNavServerSnapshot
  );

  const [loggingOut, setLoggingOut] =
    useState(false);

  const [logoutError, setLogoutError] =
    useState<string | null>(null);

  const navigation = ROLE_NAVIGATION[role];

  const roleTitle = {
    admin: "Administrator",
    supervisor: "Supervisor",
    technician: "Technician",
  }[role];

  const matchedItem = getMostSpecificMatch(
    pathname,
    navigation,
    AVAILABLE_ROUTES
  );

  const drawerAccessible = open || isDesktopNav;

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

      onClose();

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
    <>
      <button
        type="button"
        aria-label="Close navigation"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        disabled={!open}
        onClick={onClose}
        data-open={open ? "true" : "false"}
        className="
          sidebar-backdrop
          fixed inset-0 z-40
          bg-black/50 lg:hidden
        "
      />

      <aside
        id="mobile-navigation"
        aria-label="Main navigation"
        aria-hidden={!drawerAccessible}
        inert={drawerAccessible ? undefined : true}
        data-open={open ? "true" : "false"}
        className="
          sidebar-drawer
          fixed inset-y-0 left-0 z-50
          flex w-72 max-w-[85vw] flex-col
          border-r border-border
          bg-[var(--surface)]
          dark:border-border
          dark:bg-[var(--midnight)]
        "
      >
        <div
          className="
            flex h-20 items-center justify-between
            border-b border-border px-6
            dark:border-slate-800
          "
        >
          <div className="flex items-center gap-3">
            <div
              className="
                flex h-11 w-11 items-center
                justify-center rounded-xl
                bg-[var(--accent)] text-[var(--obsidian)]
              "
            >
              <RadioTower size={23} />
            </div>

            <div>
              <h1
                className="
                  text-lg font-bold text-[var(--foreground)]
                  dark:text-[var(--foreground)]
                "
              >
                ShiftChange
              </h1>

              <p className="text-xs text-[var(--muted)]">
                Technical Operations
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            tabIndex={open ? 0 : -1}
            className="
              flex h-11 w-11 items-center justify-center rounded-lg
              text-[var(--muted)]
              transition-[background-color,color,transform] duration-[160ms]
              ease-atelier
              hover:bg-[var(--elevated)]
              active:scale-[0.96]
              focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2
              motion-reduce:transition-none motion-reduce:active:scale-100
              dark:hover:bg-[var(--elevated)]
              lg:hidden
            "
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5">
          <p
            className="
              text-xs font-semibold uppercase
              tracking-wider text-[var(--muted)]
            "
          >
            {roleTitle} Workspace
          </p>
        </div>

        <nav
          aria-label="Main navigation"
          className="flex-1 space-y-1 overflow-y-auto px-3"
        >
          {navigation.map((item) => {
            const Icon = item.icon;

            const available =
              AVAILABLE_ROUTES.has(item.href);

            if (!available) {
              return (
                <div
                  key={item.href}
                  aria-disabled="true"
                  title="Coming in a later phase"
                  className="
                    flex cursor-not-allowed
                    items-center gap-3
                    rounded-xl px-4 py-3
                    text-sm text-[var(--muted)]
                    dark:text-[var(--muted)]
                  "
                >
                  <Icon size={19} />

                  <span className="flex-1">
                    {item.label}
                  </span>

                  <LockKeyhole size={13} />
                </div>
              );
            }

            const isActive = matchedItem?.href === item.href;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                aria-current={isActive ? "page" : undefined}
                className={`
                  relative flex items-center gap-3
                  rounded-xl px-4 py-3
                  text-sm font-medium
                  transition-[color,background-color] duration-[180ms]
                  ease-atelier
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2
                  motion-reduce:transition-none
                  ${
                    isActive
                      ? "bg-[var(--elevated)] text-[var(--foreground)]"
                      : `
                        text-[var(--foreground)]
                        hover:bg-[var(--elevated)]
                        dark:text-[var(--muted)]
                        dark:hover:bg-[var(--elevated)]
                      `
                  }
                `}
              >
                <span
                  aria-hidden="true"
                  className={`
                    absolute top-1/2 left-0 h-6 w-0.5
                    -translate-y-1/2 rounded-full
                    bg-[var(--accent)]
                    transition-opacity duration-[200ms] ease-atelier
                    motion-reduce:transition-none
                    ${isActive ? "opacity-100" : "opacity-0"}
                  `}
                />

                <Icon
                  size={19}
                  className="
                    transition-colors duration-[160ms] ease-atelier
                    motion-reduce:transition-none
                  "
                />

                {item.label}
              </Link>
            );
          })}
        </nav>

        <div
          className="
            border-t border-[var(--border)]
            p-5 dark:border-slate-800
          "
        >
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="
              flex w-full items-center
              justify-center gap-2
              rounded-xl border
              border-[var(--border)] px-4 py-2.5
              text-sm font-medium
              text-slate-700
              focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2
              transition-colors duration-[160ms] ease-atelier
              hover:bg-[var(--elevated)]
              disabled:cursor-not-allowed
              disabled:opacity-60
              motion-reduce:transition-none
              dark:border-[var(--border)]
              dark:text-slate-200
              dark:hover:bg-[var(--midnight)]
            "
          >
            {loggingOut ? (
              <>
                <LoaderCircle
                  size={17}
                  className="animate-spin"
                />
                Logging out...
              </>
            ) : (
              <>
                <LogOut size={17} />
                Log out
              </>
            )}
          </button>

          {logoutError && (
            <p
              role="alert"
              className="
                mt-2 text-xs text-red-600
                dark:text-red-400
              "
            >
              {logoutError}
            </p>
          )}

          <p className="mt-4 text-xs text-slate-500">
            ShiftChange 2.0
          </p>

          <p className="mt-1 text-xs text-slate-400">
            Technical Department
          </p>
        </div>
      </aside>
    </>
  );
}
