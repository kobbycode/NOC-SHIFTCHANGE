
export type UserRole =
  | "admin"
  | "supervisor"
  | "technician";

export type UserStatus =
  | "active"
  | "blocked"
  | "revoked";

export interface AppUser {
  uid: string;
  fullName: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
}

export const ROLE_HOME: Record<UserRole, string> = {
  admin: "/admin",
  supervisor: "/supervisor",
  technician: "/technician",
};

export function isUserRole(
  value: unknown
): value is UserRole {
  return (
    value === "admin" ||
    value === "supervisor" ||
    value === "technician"
  );
}