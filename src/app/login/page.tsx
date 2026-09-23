
"use client";

import { useState, type FormEvent } from "react";

import { useRouter } from "next/navigation";

import {
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

import { auth } from "@/lib/firebase/client";

import {
  ROLE_HOME,
  isUserRole,
} from "@/types/auth";
import { getFirebaseErrorMessage } from "@/lib/errors/messages";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (loading) return;

    setLoading(true);
    setError("");

    try {
      const credential =
        await signInWithEmailAndPassword(
          auth,
          email.trim(),
          password
        );

      const idToken =
        await credential.user.getIdToken();

      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ idToken }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error ?? "Unable to sign in."
        );
      }

      // Validate the role before using it
      // to select the dashboard route.
      const userRole: unknown = result.user?.role;

      if (!isUserRole(userRole)) {
        throw new Error("Invalid account role.");
      }

      
const dashboardPath = ROLE_HOME[userRole];

const mustChangePassword =
  result.user.mustChangePassword === true;

await signOut(auth);

if (mustChangePassword) {
  router.replace("/change-password");
} else {
  router.replace(dashboardPath);
}

router.refresh();
    
} catch (err) {
  await signOut(auth).catch(() => {});

  console.error("Login failed:", err);

  setError(
    getFirebaseErrorMessage(err)
  );

} finally {
  setLoading(false);
}
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl dark:border-slate-800 dark:bg-slate-900">

        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            ShiftChange 2.0
          </h1>

          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Sign in to your account
          </p>
        </div>

        <form
          onSubmit={handleLogin}
          className="space-y-5"
        >
          <div>
            <label
              htmlFor="email"
              className="mb-2 block text-sm font-medium"
            >
              Email address
            </label>

            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
              className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 outline-none focus:border-blue-500 dark:border-slate-700"
              placeholder="Enter your email"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-2 block text-sm font-medium"
            >
              Password
            </label>

            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              className="w-full rounded-lg border border-slate-300 bg-transparent px-4 py-3 outline-none focus:border-blue-500 dark:border-slate-700"
              placeholder="Enter your password"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-500">
          Accounts are created by your administrator.
        </p>

      </div>
    </main>
  );
}