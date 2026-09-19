
"use client";

import {
  Bell,
  Menu,
  UserRound,
} from "lucide-react";

import type { UserRole } from "@/types/auth";

import {
  ThemeToggle,
} from "./theme-toggle";

interface AppHeaderProps {
  role: UserRole;
  onMenuClick: () => void;
}

export function AppHeader({
  role,
  onMenuClick,
}: AppHeaderProps) {
  const roleTitle = {
    admin: "Administrator",
    supervisor: "Supervisor",
    technician: "Technician",
  }[role];

  return (
    <header
      className="
        sticky top-0 z-30
        flex h-20 items-center
        justify-between gap-4
        border-b border-slate-200
        bg-white px-4
        dark:border-slate-800
        dark:bg-slate-950
        sm:px-8
      "
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation"
          className="
            rounded-xl p-2
            text-slate-700
            hover:bg-slate-100
            dark:text-slate-200
            dark:hover:bg-slate-800
            lg:hidden
          "
        >
          <Menu size={22} />
        </button>

        <div>
          <h2
            className="
              text-lg font-semibold
              text-slate-900
              dark:text-white
            "
          >
            {roleTitle} Dashboard
          </h2>

          <p className="hidden text-xs text-slate-500 sm:block">
            Technical Department Operations
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <ThemeToggle />

        <div
          title="Notifications will be available in a later phase"
          className="
            flex h-10 w-10
            items-center justify-center
            rounded-xl
            text-slate-400
          "
        >
          <Bell size={20} />
        </div>

        <div
          className="
            flex h-10 w-10
            items-center justify-center
            rounded-full bg-blue-100
            text-blue-700
            dark:bg-blue-950
            dark:text-blue-300
          "
          aria-label="User profile"
        >
          <UserRound size={20} />
        </div>
      </div>
    </header>
  );
}