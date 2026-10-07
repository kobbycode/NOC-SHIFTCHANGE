
import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

export const OPERATIONAL_COLLECTIONS = {
  HANDOVERS: "handovers",
  HANDOVER_TASK_DISPOSITIONS: "handover_task_dispositions",
  SHIFTS: "shifts",

  SHIFT_MEMBERS: "shift_members",

  SHIFT_ATTENDANCE: "shift_attendance",

  TASKS: "tasks",

  TASK_ASSIGNMENTS: "task_assignments",

  TASK_ASSIGNMENT_HISTORY:
    "task_assignment_history",

  TECHNICIAN_SCHEDULES:
    "technician_schedules",

  TECHNICIAN_PAIRS:
    "technician_pairs",

  TECHNICIAN_PAIR_MEMBERSHIPS:
    "technician_pair_memberships",

  OPERATIONAL_SHIFT_CONTROL:
    "operational_shift_control",

  NEXT_SHIFT_AUTHORIZATIONS:
    "next_shift_authorizations",
} as const;

export const GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID =
  "global";

export function getOperationalCollections() {
  const db = getAdminFirestore();

  return {
    db,
    handovers: db.collection(OPERATIONAL_COLLECTIONS.HANDOVERS),
    handoverTaskDispositions: db.collection(OPERATIONAL_COLLECTIONS.HANDOVER_TASK_DISPOSITIONS),

    shifts: db.collection(
      OPERATIONAL_COLLECTIONS.SHIFTS
    ),

    shiftMembers: db.collection(
      OPERATIONAL_COLLECTIONS.SHIFT_MEMBERS
    ),

    shiftAttendance: db.collection(
      OPERATIONAL_COLLECTIONS.SHIFT_ATTENDANCE
    ),

    tasks: db.collection(
      OPERATIONAL_COLLECTIONS.TASKS
    ),

    taskAssignments: db.collection(
      OPERATIONAL_COLLECTIONS.TASK_ASSIGNMENTS
    ),

    taskAssignmentHistory: db.collection(
      OPERATIONAL_COLLECTIONS.TASK_ASSIGNMENT_HISTORY
    ),

    technicianSchedules: db.collection(
      OPERATIONAL_COLLECTIONS.TECHNICIAN_SCHEDULES
    ),

    technicianPairs: db.collection(
      OPERATIONAL_COLLECTIONS.TECHNICIAN_PAIRS
    ),

    technicianPairMemberships: db.collection(
      OPERATIONAL_COLLECTIONS.TECHNICIAN_PAIR_MEMBERSHIPS
    ),

    operationalShiftControl: db.collection(
      OPERATIONAL_COLLECTIONS.OPERATIONAL_SHIFT_CONTROL
    ),

    nextShiftAuthorizations: db.collection(
      OPERATIONAL_COLLECTIONS.NEXT_SHIFT_AUTHORIZATIONS
    ),
  };
}
