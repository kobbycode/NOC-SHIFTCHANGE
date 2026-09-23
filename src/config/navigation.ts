
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
  Wrench,
  Settings,
} from "lucide-react";

export interface NavigationItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export const ADMIN_NAVIGATION: NavigationItem[] = [
  {
    label: "Dashboard",
    href: "/admin",
    icon: LayoutDashboard,
  },
  {
    label: "User Management",
    href: "/admin/users",
    icon: Users,
  },
  {
    label: "Stations & Sections",
    href: "/admin/stations",
    icon: Building2,
  },
  {
    label: "Reports",
    href: "/admin/reports",
    icon: BarChart3,
  },
  {
    label: "Audit Logs",
    href: "/admin/audit-logs",
    icon: ShieldCheck,
  },
  {
    label: "Settings",
    href: "/admin/settings",
    icon: Settings,
  },

  
];

export const SUPERVISOR_NAVIGATION: NavigationItem[] = [
  {
    label: "Dashboard",
    href: "/supervisor",
    icon: LayoutDashboard,
  },
  {
    label: "Shift Management",
    href: "/supervisor/shifts",
    icon: CalendarClock,
  },
  {
    label: "Attendance",
    href: "/supervisor/attendance",
    icon: ClipboardCheck,
  },
  {
    label: "Task Management",
    href: "/supervisor/tasks",
    icon: ListTodo,
  },
  {
    label: "Handovers",
    href: "/supervisor/handovers",
    icon: ArrowLeftRight,
  },
  {
    label: "Reports",
    href: "/supervisor/reports",
    icon: BarChart3,
  },
];

export const TECHNICIAN_NAVIGATION: NavigationItem[] = [
  {
    label: "Dashboard",
    href: "/technician",
    icon: LayoutDashboard,
  },
  {
    label: "My Tasks",
    href: "/technician/tasks",
    icon: ListTodo,
  },
  {
    label: "Sections Record",
    href: "/technician/sections",
    icon: ClipboardList,
  },
  {
    label: "Faults",
    href: "/technician/faults",
    icon: TriangleAlert,
  },
  {
    label: "Outside Broadcasts",
    href: "/technician/obs",
    icon: Radio,
  },
  {
    label: "Equipment",
    href: "/technician/equipment",
    icon: Wrench,
  },
  {
    label: "Handovers",
    href: "/technician/handovers",
    icon: ArrowLeftRight,
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