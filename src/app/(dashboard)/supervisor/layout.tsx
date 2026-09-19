
import type { ReactNode } from "react";

import {
  DashboardShell,
} from "@/components/layout/dashboard-shell";

export default function SupervisorLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <DashboardShell role="supervisor">
      {children}
    </DashboardShell>
  );
}