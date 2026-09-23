
import { requireUser } from "@/lib/auth/session";

export default async function TechnicianLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser(["technician"]);

  return <>{children}</>;
}