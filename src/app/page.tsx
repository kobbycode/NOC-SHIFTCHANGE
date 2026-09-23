
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";

import { ROLE_HOME } from "@/types/auth";

export default async function HomePage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  redirect(ROLE_HOME[user.role]);
}