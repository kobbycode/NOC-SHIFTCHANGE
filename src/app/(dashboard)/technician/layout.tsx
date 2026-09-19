
import type { ReactNode } from "react";

import {
  DashboardShell,
} from "@/components/layout/dashboard-shell";

export default function TechnicianLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <DashboardShell role="technician">
      {children}
    </DashboardShell>
  );
}