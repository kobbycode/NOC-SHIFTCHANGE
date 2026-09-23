
import { requireUser } from "@/lib/auth/session";

export default async function SupervisorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser(["supervisor"]);

  return <>{children}</>;
}