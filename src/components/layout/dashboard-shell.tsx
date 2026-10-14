"use client";

import {
  useEffect,
  useRef,
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
  const pageContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Close the mobile drawer when the route changes.
    // The parent must also be able to close it manually.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    const pageContent = pageContentRef.current;
    const motionPreference = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );

    if (
      !pageContent ||
      motionPreference.matches ||
      typeof pageContent.animate !== "function"
    ) {
      return;
    }

    const animation = pageContent.animate(
      [
        { opacity: 0.94, transform: "translateY(8px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      {
        duration: 200,
        easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
      }
    );

    function handleMotionPreferenceChange(
      event: MediaQueryListEvent
    ) {
      if (event.matches) {
        animation.cancel();
      }
    }

    motionPreference.addEventListener(
      "change",
      handleMotionPreferenceChange
    );

    return () => {
      motionPreference.removeEventListener(
        "change",
        handleMotionPreferenceChange
      );
      animation.cancel();
    };
  }, [pathname]);

  return (
    <div
      className="
        min-h-screen overflow-x-clip bg-[var(--surface)]
        text-[var(--foreground)]
        dark:bg-[var(--midnight)]
        dark:text-[var(--foreground)]
      "
    >
      <AppSidebar
        role={role}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="min-h-screen overflow-x-clip lg:pl-72 print:pl-0">
        <AppHeader
          role={role}
          sidebarOpen={sidebarOpen}
          onMenuClick={() => setSidebarOpen(true)}
        />

        <main
          className="
            mx-auto w-full max-w-7xl
            p-4 sm:p-6 lg:p-8
          "
        >
          <div ref={pageContentRef} data-page-content>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
