
"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  getErrorMessage,
} from "@/lib/errors/messages";

export function ChangePasswordForm() {
  const router = useRouter();

  const [currentPassword, setCurrentPassword] =
    useState("");

  const [newPassword, setNewPassword] =
    useState("");

  const [confirmPassword, setConfirmPassword] =
    useState("");

  const [showPasswords, setShowPasswords] =
    useState(false);

  const [loading, setLoading] =
    useState(false);

  const [error, setError] =
    useState("");

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (loading) return;

    setError("");

    // Validate the new password.
    if (newPassword.length < 12) {
      setError(
        getErrorMessage("PASSWORD_TOO_SHORT")
      );
      return;
    }

    if (newPassword.length > 128) {
      setError(
        "Your password must not exceed 128 characters."
      );
      return;
    }

    // Confirm that both passwords match.
    if (newPassword !== confirmPassword) {
      setError(
        getErrorMessage("PASSWORD_MISMATCH")
      );
      return;
    }

    // Prevent reusing the current password.
    if (currentPassword === newPassword) {
      setError(
        getErrorMessage("PASSWORD_UNCHANGED")
      );
      return;
    }

    setLoading(true);

    try {
      // Submit the password-change request.
      const response = await fetch(
        "/api/auth/change-password",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "same-origin",
          body: JSON.stringify({
            currentPassword,
            newPassword,
            confirmPassword,
          }),
        }
      );

      const result: unknown =
        await response.json();

      // Handle errors returned by the API.
      if (!response.ok) {
        let message: string;

        switch (response.status) {
          case 400:
            message =
              "Please check your current password and try again.";
            break;

          case 401:
            message =
              getErrorMessage("SESSION_EXPIRED");
            break;

          case 403:
            message =
              getErrorMessage("ACCOUNT_DISABLED");
            break;

          case 429:
            message =
              getErrorMessage("TOO_MANY_ATTEMPTS");
            break;

          case 503:
            message =
              getErrorMessage("SERVICE_UNAVAILABLE");
            break;

          default:
            message =
              getErrorMessage("UNKNOWN_ERROR");
        }

        // Preserve approved English messages returned
        // by the password-change API.
        const approvedMessages = [
          "Invalid request origin.",
          "Invalid request body.",
          "All password fields are required.",
          "Your new password must contain between 12 and 128 characters.",
          "The new passwords do not match.",
          "Choose a password different from your current password.",
          "Your session has expired. Please sign in again.",
          "This account cannot change its password.",
          "Current password is incorrect or authentication was rejected.",
          "Unable to verify your password. Please try again later.",
          "Account verification failed.",
          "This account is no longer active.",
          "Password changes are temporarily unavailable.",
          "Unable to complete the password change. Please try signing in again or contact an administrator if the problem persists.",
        ];

        if (
          typeof result === "object" &&
          result !== null &&
          "error" in result &&
          typeof result.error === "string" &&
          approvedMessages.includes(result.error)
        ) {
          message = result.error;
        }

        setError(message);
        return;
      }

      // Verify the success response.
      if (
        typeof result !== "object" ||
        result === null ||
        !("success" in result) ||
        result.success !== true
      ) {
        setError(
          getErrorMessage("UNKNOWN_ERROR")
        );
        return;
      }

      // Clear password fields.
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");

      // The API clears the server session.
      // Redirect to login after a successful change.
      router.replace("/login");
      router.refresh();

    } catch (err) {
      console.error(
        "Password change request failed:",
        err
      );

      setError(
        err instanceof TypeError
          ? getErrorMessage("NETWORK_ERROR")
          : getErrorMessage("UNKNOWN_ERROR")
      );

    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-6 space-y-5"
    >
      <div>
        <label
          htmlFor="currentPassword"
          className="mb-2 block text-sm font-medium"
        >
          Current password
        </label>

        <input
          id="currentPassword"
          type={showPasswords ? "text" : "password"}
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) =>
            setCurrentPassword(event.target.value)
          }
          className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 dark:border-slate-700"
          placeholder="Enter your current password"
        />
      </div>

      <div>
        <label
          htmlFor="newPassword"
          className="mb-2 block text-sm font-medium"
        >
          New password
        </label>

        <input
          id="newPassword"
          type={showPasswords ? "text" : "password"}
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          value={newPassword}
          onChange={(event) =>
            setNewPassword(event.target.value)
          }
          className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 dark:border-slate-700"
          placeholder="Enter your new password"
        />

        <p className="mt-2 text-xs text-slate-500">
          Your new password must contain between
          12 and 128 characters.
        </p>
      </div>

      <div>
        <label
          htmlFor="confirmPassword"
          className="mb-2 block text-sm font-medium"
        >
          Confirm new password
        </label>

        <input
          id="confirmPassword"
          type={showPasswords ? "text" : "password"}
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) =>
            setConfirmPassword(event.target.value)
          }
          className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 dark:border-slate-700"
          placeholder="Confirm your new password"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showPasswords}
          onChange={(event) =>
            setShowPasswords(event.target.checked)
          }
        />

        Show passwords
      </label>

      {error && (
        <div
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
      >
        {loading
          ? "Changing password..."
          : "Change password"}
      </button>
    </form>
  );
}