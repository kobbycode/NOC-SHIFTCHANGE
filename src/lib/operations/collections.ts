
import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

export const OPERATIONAL_COLLECTIONS = {
  SHIFTS: "shifts",

  SHIFT_MEMBERS: "shift_members",

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
} as const;

export function getOperationalCollections() {
  const db = getAdminFirestore();

  return {
    db,

    shifts: db.collection(
      OPERATIONAL_COLLECTIONS.SHIFTS
    ),

    shiftMembers: db.collection(
      OPERATIONAL_COLLECTIONS.SHIFT_MEMBERS
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
  };
}
