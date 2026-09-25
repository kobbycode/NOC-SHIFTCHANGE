
import type { ReactNode } from "react";

import {
  requireUser,
} from "@/lib/auth/session";

import {
  DashboardShell,
} from "@/components/layout/dashboard-shell";

interface TechnicianLayoutProps {
  children: ReactNode;
}

export default async function TechnicianLayout({
  children,
}: TechnicianLayoutProps) {
  // Only authenticated technicians
  // can access this workspace.
  await requireUser(["technician"]);

  return (
    <DashboardShell role="technician">
      {children}
    </DashboardShell>
  );
}