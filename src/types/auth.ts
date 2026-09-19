
export const USER_ROLES = {
  ADMIN: "admin",
  SUPERVISOR: "supervisor",
  TECHNICIAN: "technician",
} as const;

export type UserRole =
  (typeof USER_ROLES)[keyof typeof USER_ROLES];

export const ACCOUNT_STATUSES = {
  ACTIVE: "active",
  BLOCKED: "blocked",
  REVOKED: "revoked",
  DELETED: "deleted",
} as const;

export type AccountStatus =
  (typeof ACCOUNT_STATUSES)[keyof typeof ACCOUNT_STATUSES];

export interface AppUser {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  status: AccountStatus;

  mustChangePassword: boolean;

  createdAt: string;
  updatedAt: string;
}