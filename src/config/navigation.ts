
import type { UserRole } from "@/types/auth";

import type {
  LucideIcon,
} from "lucide-react";

import {
  LayoutDashboard,
  Users,
  Building2,
  BarChart3,
  ShieldCheck,
  CalendarClock,
  ClipboardCheck,
  ListTodo,
  ArrowLeftRight,
  ClipboardList,
  TriangleAlert,
  Radio,
  RadioTower,
  SatelliteDish,
  Wrench,
  Settings,
  Inbox,
  FileSearch,
} from "lucide-react";

export interface NavigationItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /**
   * False means no page is served at `href` yet, so the item renders as a
   * disabled placeholder instead of a link.
   */
  implemented: boolean;
}

export const ADMIN_NAVIGATION: NavigationItem[] = [
  {
    label: "Dashboard",
    href: "/admin",
    icon: LayoutDashboard,
    implemented: true,
  },
  {
    label: "User Management",
    href: "/admin/users",
    icon: Users,
    implemented: true,
  },
  {
    label: "Handover Review",
    href: "/admin/handovers/review",
    icon: FileSearch,
    implemented: true,
  },
  {
    label: "Stations & Sections",
    href: "/admin/stations",
    icon: Building2,
    implemented: false,
  },
  {
    label: "Reports",
    href: "/admin/reports",
    icon: BarChart3,
    implemented: false,
  },
  {
    label: "Audit Logs",
    href: "/admin/audit-logs",
    icon: ShieldCheck,
    implemented: false,
  },
  {
    label: "Settings",
    href: "/admin/settings",
    icon: Settings,
    implemented: false,
  },

  
];

export const SUPERVISOR_NAVIGATION: NavigationItem[] = [
  {
    label: "Dashboard",
    href: "/supervisor",
    icon: LayoutDashboard,
    implemented: true,
  },
  {
    label: "Shift Management",
    href: "/supervisor/shifts",
    icon: CalendarClock,
    implemented: true,
  },
  {
    label: "Technician Pairs",
    href: "/supervisor/technician-pairs",
    icon: Users,
    implemented: true,
  },
  {
    label: "Attendance",
    href: "/supervisor/attendance",
    icon: ClipboardCheck,
    implemented: true,
  },
  {
    label: "Task Management",
    href: "/supervisor/tasks",
    icon: ListTodo,
    implemented: true,
  },
  {
    label: "Handovers",
    href: "/supervisor/handovers",
    icon: ArrowLeftRight,
    implemented: true,
  },
  {
    label: "Reports",
    href: "/supervisor/reports",
    icon: BarChart3,
    implemented: false,
  },
];

export const TECHNICIAN_NAVIGATION: NavigationItem[] = [
  {
    label: "Shift Operations",
    href: "/technician/operations",
    icon: RadioTower,
    implemented: true,
  },
  {
    label: "Broadcast Checks",
    href: "/technician/operations?section=broadcast",
    icon: Radio,
    implemented: true,
  },
  {
    label: "Faults and Activities",
    href: "/technician/operations?section=faults",
    icon: TriangleAlert,
    implemented: true,
  },
  {
    label: "Outside Broadcasts",
    href: "/technician/operations?section=outside-broadcasts",
    icon: SatelliteDish,
    implemented: true,
  },
  {
    label: "Dashboard",
    href: "/technician",
    icon: LayoutDashboard,
    implemented: true,
  },
  {
    label: "My Tasks",
    href: "/technician/tasks",
    icon: ListTodo,
    implemented: true,
  },
  {
    label: "Notifications",
    href: "/technician/notifications",
    icon: Inbox,
    implemented: true,
  },
  {
    label: "Sections Record",
    href: "/technician/sections",
    icon: ClipboardList,
    implemented: false,
  },
  {
    label: "Equipment",
    href: "/technician/equipment",
    icon: Wrench,
    implemented: false,
  },
  {
    label: "Handovers",
    href: "/technician/handovers",
    icon: ArrowLeftRight,
    implemented: true,
  },
];

export const ROLE_NAVIGATION: Record<
  UserRole,
  NavigationItem[]
> = {
  admin: ADMIN_NAVIGATION,
  supervisor: SUPERVISOR_NAVIGATION,
  technician: TECHNICIAN_NAVIGATION,
};
