
import type { ReactNode } from "react";

import { requireUser } from "@/lib/auth/session";

import { DashboardShell } from "@/components/layout/dashboard-shell";

interface AdminLayoutProps {
  children: ReactNode;
}

export default async function AdminLayout({
  children,
}: AdminLayoutProps) {
  // Only authenticated administrators can
  // access the administrator workspace.
  await requireUser(["admin"]);

  return (
    <DashboardShell role="admin">
      {children}
    </DashboardShell>
  );
}