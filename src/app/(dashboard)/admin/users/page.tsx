
import { UserManagement } from "@/components/admin/user-management";
import { requireUser } from "@/lib/auth/session";


export default async function AdminUsersPage() {
  await requireUser(["admin"]);

  return <UserManagement />;
}