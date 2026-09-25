"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  UserPlus,
  Users,
  UserCheck,
  RefreshCw,
  Eye,
  EyeOff,
} from "lucide-react";

import type { AppUser, UserRole } from "@/types/auth";

type CreateUserForm = {
  fullName: string;
  email: string;
  password: string;
  role: UserRole;
};

type ManagedUser = AppUser & {
  accountStatusTestEligible: boolean;
  statusOperationPending: boolean;
};

type AccountAction = "block" | "unblock";

type PendingAccountAction = {
  user: ManagedUser;
  action: AccountAction;
};

const initialForm: CreateUserForm = {
  fullName: "",
  email: "",
  password: "",
  role: "technician",
};

const roleLabels: Record<UserRole, string> = {
  admin: "Administrator",
  supervisor: "Supervisor",
  technician: "Technician",
};

function statusLabel(status: AppUser["status"]) {
  switch (status) {
    case "active":
      return "Active";
    case "blocked":
      return "Blocked";
    case "revoked":
      return "Revoked";
    default:
      return "Unknown";
  }
}

export function UserManagement() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [form, setForm] = useState<CreateUserForm>(initialForm);

  const [loading, setLoading] = useState(true);

  const [submitting, setSubmitting] = useState(false);

  const [showPassword, setShowPassword] = useState(false);

  const [error, setError] = useState("");

  const [success, setSuccess] = useState("");

  const [pendingAction, setPendingAction] =
    useState<PendingAccountAction | null>(null);

  const [actionReason, setActionReason] = useState("");

  const [actionSubmitting, setActionSubmitting] = useState(false);

  const [actionError, setActionError] = useState("");

  const [actionSuccess, setActionSuccess] = useState("");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/admin/users", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Unable to load user accounts.");
      }

      setUsers(result.users);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to load user accounts.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadInitialUsers() {
      try {
        const response = await fetch("/api/admin/users", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });

        const result = await response.json();

        if (controller.signal.aborted) {
          return;
        }

        if (!response.ok) {
          throw new Error(
            result.error || "Unable to load user accounts.",
          );
        }

        setUsers(result.users);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setError(
          error instanceof Error
            ? error.message
            : "Unable to load user accounts.",
        );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadInitialUsers();

    return () => {
      controller.abort();
    };
  }, []);

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitting) return;

    setError("");
    setSuccess("");

    if (form.fullName.trim().length < 2) {
      setError("Please enter the employee's full name.");
      return;
    }

    if (form.password.length < 12) {
      setError("The initial password must contain at least 12 characters.");
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(form),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Unable to create the user account.");
      }

      setSuccess(
        "User account created successfully. Provide the initial login credentials to the employee through an approved secure channel.",
      );

      setForm(initialForm);
      setShowPassword(false);

      await loadUsers();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to create the user account.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function openAccountAction(user: ManagedUser, action: AccountAction) {
    if (actionSubmitting) {
      return;
    }

    setActionError("");
    setActionSuccess("");
    setActionReason("");

    setPendingAction({
      user,
      action,
    });
  }

  function closeAccountAction() {
    if (actionSubmitting) {
      return;
    }

    setPendingAction(null);
    setActionReason("");
    setActionError("");
  }

  async function handleAccountAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!pendingAction || actionSubmitting) {
      return;
    }

    const reason = actionReason.trim();

    if (reason.length < 10 || reason.length > 500) {
      setActionError("Please provide a reason between 10 and 500 characters.");

      return;
    }

    const { user, action } = pendingAction;

    setActionSubmitting(true);
    setActionError("");
    setActionSuccess("");

    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(user.uid)}/status`,
        {
          method: "PATCH",

          headers: {
            "Content-Type": "application/json",
          },

          credentials: "same-origin",

          body: JSON.stringify({
            action,
            reason,
          }),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : "The account change could not be completed.",
        );
      }

      setPendingAction(null);
      setActionReason("");

      setActionSuccess(
        action === "block"
          ? `${user.fullName}'s account has been blocked successfully.`
          : `${user.fullName}'s account has been unblocked successfully.`,
      );

      await loadUsers();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The account change could not be completed. Please try again.",
      );
    } finally {
      setActionSubmitting(false);
    }
  }

  const activeUsers = users.filter((user) => user.status === "active").length;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 p-4 md:p-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">User Management</h1>

        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Create and manage administrator, supervisor, and technician accounts.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-3">
            <Users className="h-6 w-6 text-blue-600" />

            <div>
              <p className="text-sm text-slate-500">Total users</p>

              <p className="text-3xl font-bold">{users.length}</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-3">
            <UserCheck className="h-6 w-6 text-green-600" />

            <div>
              <p className="text-sm text-slate-500">Active users</p>

              <p className="text-3xl font-bold">{activeUsers}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-6 flex items-center gap-3">
            <UserPlus className="h-6 w-6 text-blue-600" />

            <h2 className="text-xl font-semibold">Create new user</h2>
          </div>

          <form onSubmit={handleCreateUser} className="space-y-5">
            <div>
              <label
                htmlFor="fullName"
                className="mb-2 block text-sm font-medium"
              >
                Full name
              </label>

              <input
                id="fullName"
                required
                maxLength={120}
                value={form.fullName}
                onChange={(event) =>
                  setForm({
                    ...form,
                    fullName: event.target.value,
                  })
                }
                placeholder="Employee's full name"
                className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 dark:border-slate-700"
              />
            </div>

            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium">
                Email address
              </label>

              <input
                id="email"
                type="email"
                required
                autoComplete="off"
                value={form.email}
                onChange={(event) =>
                  setForm({
                    ...form,
                    email: event.target.value,
                  })
                }
                placeholder="employee@company.com"
                className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 dark:border-slate-700"
              />
            </div>

            <div>
              <label htmlFor="role" className="mb-2 block text-sm font-medium">
                Account role
              </label>

              <select
                id="role"
                value={form.role}
                onChange={(event) =>
                  setForm({
                    ...form,
                    role: event.target.value as UserRole,
                  })
                }
                className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 dark:border-slate-700"
              >
                <option value="technician">Technician</option>

                <option value="supervisor">Supervisor</option>

                <option value="admin">Administrator</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-2 block text-sm font-medium"
              >
                Initial password
              </label>

              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      password: event.target.value,
                    })
                  }
                  placeholder="Enter initial password"
                  className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 pr-12 dark:border-slate-700"
                />

                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                Minimum 12 characters. The employee must change this password at
                first login.
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
              >
                {error}
              </div>
            )}

            {success && (
              <div
                role="status"
                className="rounded-lg bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300"
              >
                {success}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "Creating account..." : "Create user"}
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-6 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Registered users</h2>

            <button
              type="button"
              onClick={() => void loadUsers()}
              disabled={loading}
              aria-label="Refresh user list"
              className="rounded-lg border border-slate-300 p-2 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <RefreshCw
                className={`h-5 w-5 ${loading ? "animate-spin" : ""}`}
              />
            </button>

            {actionSuccess && (
              <div
                role="status"
                className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300"
              >
                {actionSuccess}
              </div>
            )}

            {actionError && !pendingAction && (
              <div
                role="alert"
                className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
              >
                {actionError}
              </div>
            )}
          </div>

          {loading ? (
            <p className="text-sm text-slate-500">Loading users...</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-slate-500">No user accounts found.</p>
          ) : (
            <div className="space-y-3">
              {users.map((user) => (
                <div
                  key={user.uid}
                  className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">{user.fullName}</p>

                      <p className="break-all text-sm text-slate-500">
                        {user.email}
                      </p>
                    </div>

                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${
                        user.status === "active"
                          ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                          : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                      }`}
                    >
                      {statusLabel(user.status)}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs dark:bg-slate-800">
                      {roleLabels[user.role]}
                    </span>

                    {user.mustChangePassword && (
                      <span className="rounded-full bg-blue-100 px-3 py-1 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                        Password change required
                      </span>
                    )}

                    {user.statusOperationPending ? (
                      <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                        An account change is in progress. Administrator review
                        may be required.
                      </div>
                    ) : user.role === "technician" &&
                      user.accountStatusTestEligible &&
                      (user.status === "active" ||
                        user.status === "blocked") ? (
                      <div className="mt-4 flex justify-end border-t border-slate-200 pt-4 dark:border-slate-800">
                        {user.status === "active" ? (
                          <button
                            type="button"
                            disabled={actionSubmitting}
                            onClick={() => openAccountAction(user, "block")}
                            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Block account
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={actionSubmitting}
                            onClick={() => openAccountAction(user, "unblock")}
                            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Unblock account
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {pendingAction && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-action-title"
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
          >
            <h2 id="account-action-title" className="text-xl font-bold">
              {pendingAction.action === "block"
                ? "Block user account"
                : "Unblock user account"}
            </h2>

            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
              {pendingAction.action === "block"
                ? "Blocking this account will prevent the technician from signing in and invalidate their existing sessions."
                : "Unblocking this account will restore the technician's ability to sign in. Previously revoked sessions will remain invalid."}
            </p>

            <div className="mt-4 rounded-lg bg-slate-100 p-3 dark:bg-slate-800">
              <p className="font-semibold">{pendingAction.user.fullName}</p>

              <p className="mt-1 break-all text-sm text-slate-500 dark:text-slate-400">
                {pendingAction.user.email}
              </p>
            </div>

            <form onSubmit={handleAccountAction} className="mt-5 space-y-4">
              <div>
                <label
                  htmlFor="account-action-reason"
                  className="mb-2 block text-sm font-medium"
                >
                  Reason for this action
                </label>

                <textarea
                  id="account-action-reason"
                  required
                  minLength={10}
                  maxLength={500}
                  rows={4}
                  value={actionReason}
                  onChange={(event) => setActionReason(event.target.value)}
                  placeholder="Enter the reason for this account change..."
                  className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 text-sm outline-none focus:border-blue-500 dark:border-slate-700"
                />

                <p className="mt-1 text-xs text-slate-500">
                  Between 10 and 500 characters. This reason will be recorded in
                  the audit log.
                </p>
              </div>

              {actionError && (
                <div
                  role="alert"
                  className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
                >
                  {actionError}
                </div>
              )}

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  disabled={actionSubmitting}
                  onClick={closeAccountAction}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={
                    actionSubmitting ||
                    actionReason.trim().length < 10 ||
                    actionReason.trim().length > 500
                  }
                  className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${
                    pendingAction.action === "block"
                      ? "bg-red-600 hover:bg-red-700"
                      : "bg-green-600 hover:bg-green-700"
                  }`}
                >
                  {actionSubmitting
                    ? "Processing..."
                    : pendingAction.action === "block"
                      ? "Confirm blocking"
                      : "Confirm unblocking"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
