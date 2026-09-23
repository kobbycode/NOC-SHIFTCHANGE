
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  RadioTower,
  X,
  LockKeyhole,
} from "lucide-react";

import type { UserRole } from "@/types/auth";

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
  "/technician",
]);
export function AppSidebar({
  role,
  open,
  onClose,
}: AppSidebarProps) {
  const pathname = usePathname();

  const navigation = ROLE_NAVIGATION[role];

  const roleTitle = {
    admin: "Administrator",
    supervisor: "Supervisor",
    technician: "Technician",
  }[role];

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="
            fixed inset-0 z-40
            bg-black/50 lg:hidden
          "
        />
      )}

      <aside
        className={`
          fixed inset-y-0 left-0 z-50
          flex w-72 flex-col
          border-r border-slate-200
          bg-white
          transition-transform duration-200
          dark:border-slate-800
          dark:bg-slate-950
          lg:translate-x-0

          ${
            open
              ? "translate-x-0"
              : "-translate-x-full"
          }
        `}
      >
        <div
          className="
            flex h-20 items-center justify-between
            border-b border-slate-200 px-6
            dark:border-slate-800
          "
        >
          <div className="flex items-center gap-3">
            <div
              className="
                flex h-11 w-11 items-center
                justify-center rounded-xl
                bg-blue-600 text-white
              "
            >
              <RadioTower size={23} />
            </div>

            <div>
              <h1
                className="
                  text-lg font-bold text-slate-900
                  dark:text-white
                "
              >
                ShiftChange
              </h1>

              <p className="text-xs text-slate-500">
                Technical Operations
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            className="
              rounded-lg p-2 text-slate-500
              hover:bg-slate-100
              dark:hover:bg-slate-800
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
              tracking-wider text-slate-400
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

            const active =
              pathname === item.href ||
              pathname.startsWith(
                `${item.href}/`
              );

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
                    text-sm text-slate-400
                    dark:text-slate-600
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

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                aria-current={
                  active ? "page" : undefined
                }
                className={`
                  flex items-center gap-3
                  rounded-xl px-4 py-3
                  text-sm font-medium
                  transition-colors

                  ${
                    active
                      ? "bg-blue-600 text-white"
                      : `
                        text-slate-600
                        hover:bg-slate-100
                        dark:text-slate-300
                        dark:hover:bg-slate-800
                      `
                  }
                `}
              >
                <Icon size={19} />

                {item.label}
              </Link>
            );
          })}
        </nav>

        <div
          className="
            border-t border-slate-200
            p-5 dark:border-slate-800
          "
        >
          <p className="text-xs text-slate-500">
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