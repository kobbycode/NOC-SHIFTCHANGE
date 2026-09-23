
import { redirect } from "next/navigation";

import {
  requireUser,
} from "@/lib/auth/session";

import {
  ChangePasswordForm,
} from "@/components/auth/change-password-form";

import { ROLE_HOME } from "@/types/auth";

export default async function ChangePasswordPage() {
  const user = await requireUser(
    undefined,
    {
      allowPasswordChangeRequired: true,
    }
  );

  if (!user.mustChangePassword) {
    redirect(ROLE_HOME[user.role]);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-12 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-2xl font-bold">
          Change your password
        </h1>

        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          Signed in as {user.email}
        </p>

        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          You must change your initial password
          before continuing to your dashboard.
        </p>

        <ChangePasswordForm />
      </div>
    </main>
  );
}