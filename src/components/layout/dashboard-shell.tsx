
"use client";

import {
  useEffect,
  useState,
} from "react";

import { usePathname } from "next/navigation";

import type {
  ReactNode,
} from "react";

import type {
  UserRole,
} from "@/types/auth";

import {
  AppSidebar,
} from "./app-sidebar";

import {
  AppHeader,
} from "./app-header";

interface DashboardShellProps {
  role: UserRole;
  children: ReactNode;
}

export function DashboardShell({
  role,
  children,
}: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] =
    useState(false);

  const pathname = usePathname();

  useEffect(() => {
    // Close the mobile drawer when the route changes.
    // The parent must also be able to close it manually.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSidebarOpen(false);
  }, [pathname]);

  return (
    <div
      className="
        min-h-screen bg-slate-50
        text-slate-900
        dark:bg-slate-900
        dark:text-slate-100
      "
    >
      <AppSidebar
        role={role}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="min-h-screen lg:pl-72">
        <AppHeader
          role={role}
          onMenuClick={() => setSidebarOpen(true)}
        />

        <main
          className="
            mx-auto w-full max-w-7xl
            p-4 sm:p-6 lg:p-8
          "
        >
          {children}
        </main>
      </div>
    </div>
  );
}