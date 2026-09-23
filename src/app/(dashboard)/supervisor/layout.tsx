import type { ReactNode } from "react";

import {
  requireUser,
} from "@/lib/auth/session";

import {
  DashboardShell,
} from "@/components/layout/dashboard-shell";

interface SupervisorLayoutProps {
  children: ReactNode;
}

export default async function SupervisorLayout({
  children,
}: SupervisorLayoutProps) {
  /*
   * Only authenticated supervisors
   * can access this workspace.
   *
   * Existing session validation
   * remains authoritative.
   */

  await requireUser(["supervisor"]);

  /*
   * Reuse the existing dashboard shell.
   *
   * The supervisor role determines
   * which navigation items appear.
   */

  return (
    <DashboardShell role="supervisor">
      {children}
    </DashboardShell>
  );
}