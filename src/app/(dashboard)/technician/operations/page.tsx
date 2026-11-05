import { getCurrentUser } from "@/lib/auth/session";
import { getTechnicianCurrentShift } from "@/lib/operations/get-technician-current-shift";
import { getShiftOperations } from "@/lib/operations/shift-operations";
import { AssignmentOperationError } from "@/lib/operations/assignment-transaction";
import { resolveOperationalSection } from "@/config/operational-sections";
import { ShiftOperationsWorkspace } from "@/components/operations/shift-operations-workspace";
import { ShiftOperationsAccessNotice } from "@/components/operations/shift-operations-access-notice";

interface ShiftOperationsPageProps {
  searchParams: Promise<{ section?: string | string[] }>;
}

const HANDOVER_LOCK_REASON =
  "Record entry is locked because handover has begun for this shift. Review the shared records below; anything still missing is a supervisor review matter.";

export default async function ShiftOperationsPage({
  searchParams,
}: ShiftOperationsPageProps) {
  const { section } = await searchParams;
  const actor = await getCurrentUser();
  if (!actor) return null;

  let current;

  try {
    current = await getTechnicianCurrentShift(actor);
  } catch (error) {
    if (!(error instanceof AssignmentOperationError)) throw error;

    return (
      <ShiftOperationsAccessNotice
        reason={{ kind: "unavailable", message: error.message }}
      />
    );
  }

  if (!current) {
    return <ShiftOperationsAccessNotice reason={{ kind: "no_shift" }} />;
  }

  if (current.status === "scheduled") {
    return (
      <ShiftOperationsAccessNotice
        reason={{ kind: "scheduled", scheduledStart: current.scheduledStart }}
      />
    );
  }

  if (!current.joinedAt || !current.attendance) {
    return (
      <ShiftOperationsAccessNotice
        reason={
          current.status === "active"
            ? { kind: "join_available" }
            : { kind: "join_closed", shiftStatus: current.status }
        }
      />
    );
  }

  if (current.attendance.clockOut !== null) {
    return <ShiftOperationsAccessNotice reason={{ kind: "clocked_out" }} />;
  }

  const initial = await getShiftOperations(actor, current.id);
  const activeSection = resolveOperationalSection(section);

  return (
    <ShiftOperationsWorkspace
      key={activeSection}
      initial={initial}
      section={activeSection}
      lockReason={initial.writable ? null : HANDOVER_LOCK_REASON}
    />
  );
}
