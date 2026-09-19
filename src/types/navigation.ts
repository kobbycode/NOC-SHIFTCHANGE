
import type { UserRole } from "@/types/auth";

export interface NavigationItem {
  label: string;
  href: string;
  icon: string;
}

export const ADMIN_NAVIGATION: NavigationItem[] = [
  {
    label: "Dashboard",
    href: "/admin",
    icon: "layout-dashboard",
  },
  {
    label: "User Management",
    href: "/admin/users",
    icon: "users",
  },
  {
    label: "Stations & Sections",
    href: "/admin/stations",
    icon: "building-2",
  },
  {
    label: "Reports",
    href: "/admin/reports",
    icon: "chart-column",
  },
  {
    label: "Audit Logs",
    href: "/admin/audit-logs",
    icon: "shield-check",
  },
];

export const SUPERVISOR_NAVIGATION: NavigationItem[] = [
  {
    label: "Dashboard",
    href: "/supervisor",
    icon: "layout-dashboard",
  },
  {
    label: "Shift Management",
    href: "/supervisor/shifts",
    icon: "calendar-clock",
  },
  {
    label: "Attendance",
    href: "/supervisor/attendance",
    icon: "clipboard-check",
  },
  {
    label: "Task Management",
    href: "/supervisor/tasks",
    icon: "list-todo",
  },
  {
    label: "Handovers",
    href: "/supervisor/handovers",
    icon: "arrow-left-right",
  },
  {
    label: "Reports",
    href: "/supervisor/reports",
    icon: "chart-column",
  },
];

export const TECHNICIAN_NAVIGATION: NavigationItem[] = [
  {
    label: "Dashboard",
    href: "/technician",
    icon: "layout-dashboard",
  },
  {
    label: "My Tasks",
    href: "/technician/tasks",
    icon: "list-todo",
  },
  {
    label: "Sections Record",
    href: "/technician/sections",
    icon: "clipboard-list",
  },
  {
    label: "Faults",
    href: "/technician/faults",
    icon: "triangle-alert",
  },
  {
    label: "Handovers",
    href: "/technician/handovers",
    icon: "arrow-left-right",
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