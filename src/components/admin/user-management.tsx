"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  UserPlus,
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
  const createDialog = useRef<HTMLDialogElement>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [form, setForm] = useState<CreateUserForm>(initialForm);

  const [loading, setLoading] = useState(true);

  const [submitting, setSubmitting] = useState(false);

  const [showPassword, setShowPassword] = useState(false);

  const [error, setError] = useState("");
  const [createError, setCreateError] = useState("");

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

  function closeCreateDialog() {
    createDialog.current?.close();
    setForm(initialForm);
    setShowPassword(false);
    setCreateError("");
  }

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitting) return;

    setCreateError("");
    setSuccess("");

    if (form.fullName.trim().length < 2) {
      setCreateError("Please enter the employee's full name.");
      return;
    }

    if (form.password.length < 12) {
      setCreateError("The initial password must contain at least 12 characters.");
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

      closeCreateDialog();

      await loadUsers();
    } catch (error) {
      setCreateError(
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
    <div className="space-y-5 sm:space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-wider text-[var(--muted)] uppercase">
            Administration
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            User Management
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Manage administrator, supervisor, and technician accounts.
          </p>
        </div>

        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => createDialog.current?.showModal()}
          className="btn-accent inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold"
        >
          <UserPlus size={17} aria-hidden="true" />
          Add user
        </button>
      </header>

      {success && (
        <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {success}
        </p>
      )}

      {actionSuccess && (
        <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {actionSuccess}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <section
        aria-labelledby="account-directory-title"
        className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
      >
        <div className="flex items-center justify-between gap-3 p-4 sm:px-5">
          <div>
            <h2 id="account-directory-title" className="font-semibold">Account directory</h2>
            {((!loading && !error) || users.length > 0) && (
              <p className="mt-1 text-sm tabular-nums text-[var(--muted)]">
                {users.length} {users.length === 1 ? "user" : "users"} · {activeUsers} active
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => void loadUsers()}
            disabled={loading}
            aria-label="Refresh user list"
            className="grid size-11 shrink-0 place-items-center rounded-lg border border-[var(--border)] hover:bg-[var(--elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
          >
            <RefreshCw size={18} aria-hidden="true" className={loading ? "motion-safe:animate-spin" : undefined} />
          </button>
        </div>

        {loading ? (
          <p role="status" className="border-t border-[var(--border)] p-4 text-sm text-[var(--muted)]">Loading users…</p>
        ) : users.length > 0 ? (
          <table aria-labelledby="account-directory-title" className="w-full table-fixed text-left text-sm">
            <thead className="border-t border-[var(--border)] bg-[var(--elevated)] text-xs text-[var(--muted)]">
              <tr>
                <th scope="col" className="w-3/5 px-3 py-3 font-semibold sm:w-[38%] sm:px-5">Account</th>
                <th scope="col" className="hidden w-[17%] px-3 py-3 font-semibold sm:table-cell">Role</th>
                <th scope="col" className="px-3 py-3 font-semibold sm:w-[22%]">Status</th>
                <th scope="col" className="hidden px-3 py-3 font-semibold sm:table-cell">Account setup</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
              {users.map((user) => {
                const setupLabel = user.mustChangePassword ? "Password change required" : "Complete";
                const setupClass = user.mustChangePassword
                  ? "rounded-full bg-blue-100 px-2 py-1 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "text-[var(--muted)]";
                const canChangeStatus = user.role === "technician" &&
                  user.accountStatusTestEligible &&
                  (user.status === "active" || user.status === "blocked");
                const action = user.status === "active" ? "block" : "unblock";
                const initials = user.fullName.trim().split(/\s+/).slice(0, 2)
                  .map((part) => Array.from(part)[0]).join("").toUpperCase();

                return (
                  <tr key={user.uid} className="align-top">
                    <th scope="row" className="px-3 py-3 font-normal sm:px-5">
                      <div className="flex items-start gap-3">
                        <span aria-hidden="true" className="hidden size-8 shrink-0 place-items-center rounded-full bg-[var(--elevated)] text-xs font-semibold sm:grid">
                          {initials}
                        </span>
                        <div className="min-w-0">
                          <p className="font-semibold wrap-anywhere">{user.fullName}</p>
                          <p className="text-xs wrap-anywhere text-[var(--muted)]">{user.email}</p>
                          <p className="mt-1 text-xs text-[var(--muted)] sm:hidden">{roleLabels[user.role]}</p>
                          {user.mustChangePassword && (
                            <span className={`mt-1 inline-block text-xs sm:hidden ${setupClass}`}>
                              {setupLabel}
                            </span>
                          )}
                        </div>
                      </div>
                    </th>
                    <td className="hidden px-3 py-3 wrap-anywhere sm:table-cell">{roleLabels[user.role]}</td>
                    <td className="space-y-2 px-3 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                          user.status === "active"
                            ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                            : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                        }`}
                      >
                        {statusLabel(user.status)}
                      </span>

                      {user.statusOperationPending ? (
                        <p className="text-xs text-[var(--muted)]">
                          An account change is in progress. Administrator review may be required.
                        </p>
                      ) : canChangeStatus ? (
                        <div>
                          <button
                            type="button"
                            disabled={actionSubmitting}
                            onClick={() => openAccountAction(user, action)}
                            className={`min-h-11 rounded-lg px-2 py-2 text-xs font-semibold disabled:opacity-50 ${
                              action === "block" ? "bg-red-600 text-white hover:bg-red-700" : "btn-accent"
                            }`}
                          >
                            {action === "block" ? "Block account" : "Unblock account"}
                          </button>
                        </div>
                      ) : null}
                    </td>
                    <td className="hidden px-3 py-3 sm:table-cell">
                      <span className={`inline-block text-xs ${setupClass}`}>{setupLabel}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : !error && (
          <p className="border-t border-[var(--border)] p-4 text-sm text-[var(--muted)]">No user accounts found.</p>
        )}
      </section>

      <dialog
        ref={createDialog}
        aria-labelledby="add-user-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!submitting) closeCreateDialog();
        }}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-2xl backdrop:bg-black/60 sm:p-6"
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)]">
            <UserPlus size={19} aria-hidden="true" />
          </span>
          <h2 id="add-user-title" className="text-lg font-semibold">Add user</h2>
        </div>

        <form onSubmit={handleCreateUser} className="space-y-4">
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
              className="min-h-12 w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-4 py-3 text-[var(--foreground)] placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
              className="min-h-12 w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-4 py-3 text-[var(--foreground)] placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
              className="min-h-12 w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-4 py-3 text-[var(--foreground)] placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
                aria-describedby="initial-password-help"
                value={form.password}
                onChange={(event) =>
                  setForm({
                    ...form,
                    password: event.target.value,
                  })
                }
                placeholder="Enter initial password"
                className="min-h-12 w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-4 py-3 pr-12 text-[var(--foreground)] placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              />

              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {showPassword ? (
                  <EyeOff className="h-5 w-5" />
                ) : (
                  <Eye className="h-5 w-5" />
                )}
              </button>
            </div>

            <p id="initial-password-help" className="mt-2 text-xs text-[var(--muted)]">
              Minimum 12 characters. The employee must change this password at
              first login.
            </p>
          </div>

          {createError && (
            <div
              role="alert"
              className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              {createError}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={closeCreateDialog}
              className="min-h-11 rounded-lg border border-[var(--border)] px-4 text-sm font-semibold hover:bg-[var(--elevated)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="btn-accent min-h-11 rounded-lg px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Creating account…" : "Create user"}
            </button>
          </div>
        </form>
      </dialog>

      {pendingAction && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-action-title"
            className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-[var(--foreground)] shadow-2xl"
          >
            <h2 id="account-action-title" className="text-xl font-bold">
              {pendingAction.action === "block"
                ? "Block user account"
                : "Unblock user account"}
            </h2>

            <p className="mt-3 text-sm text-[var(--muted)]">
              {pendingAction.action === "block"
                ? "Blocking this account will prevent the technician from signing in and invalidate their existing sessions."
                : "Unblocking this account will restore the technician's ability to sign in. Previously revoked sessions will remain invalid."}
            </p>

            <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--elevated)] p-3">
              <p className="font-semibold">{pendingAction.user.fullName}</p>

              <p className="mt-1 break-all text-sm text-[var(--muted)]">
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
                  className="min-h-28 w-full rounded-lg border border-[var(--border)] bg-[var(--elevated)] px-4 py-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                />

                <p className="mt-1 text-xs text-[var(--muted)]">
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
                  className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--elevated)] disabled:opacity-50"
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
                  className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                    pendingAction.action === "block"
                      ? "bg-red-600 text-white hover:bg-red-700"
                      : "btn-accent"
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
