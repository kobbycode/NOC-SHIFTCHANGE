
import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

export const OPERATIONAL_COLLECTIONS = {
  HANDOVERS: "handovers",
  HANDOVER_TASK_DISPOSITIONS: "handover_task_dispositions",
  HANDOVER_TASK_TRANSFERS: "handover_task_transfers",
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

  HANDOVER_RESERVATION_GUARDS:
    "handover_reservation_guards",

  HANDOVER_RESERVATION_GUARD_HISTORY:
    "handover_reservation_guard_history",

  EQUAL_HANDOVERS_V2:
    "equal_handovers_v2",

  HANDOVER_REPORT_PREPARATIONS_V2:
    "handover_report_preparations_v2",

  HANDOVER_REPORTS_V2:
    "handover_reports_v2",

  ATTENDANCE_EVIDENCE_V2:
    "attendance_evidence_v2",

  ATTENDANCE_EVIDENCE_OPERATIONS_V2:
    "attendance_evidence_operations_v2",
} as const;

export const GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID =
  "global";

export function getOperationalCollections() {
  const db = getAdminFirestore();

  return {
    db,
    handovers: db.collection(OPERATIONAL_COLLECTIONS.HANDOVERS),
    handoverTaskDispositions: db.collection(OPERATIONAL_COLLECTIONS.HANDOVER_TASK_DISPOSITIONS),
    handoverTaskTransfers: db.collection(OPERATIONAL_COLLECTIONS.HANDOVER_TASK_TRANSFERS),

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

    handoverReservationGuards: db.collection(
      OPERATIONAL_COLLECTIONS.HANDOVER_RESERVATION_GUARDS
    ),

    handoverReservationGuardHistory: db.collection(
      OPERATIONAL_COLLECTIONS.HANDOVER_RESERVATION_GUARD_HISTORY
    ),

    equalHandoversV2: db.collection(
      OPERATIONAL_COLLECTIONS.EQUAL_HANDOVERS_V2
    ),

    handoverReportPreparationsV2: db.collection(
      OPERATIONAL_COLLECTIONS.HANDOVER_REPORT_PREPARATIONS_V2
    ),

    handoverReportsV2: db.collection(
      OPERATIONAL_COLLECTIONS.HANDOVER_REPORTS_V2
    ),

    attendanceEvidenceV2: db.collection(
      OPERATIONAL_COLLECTIONS.ATTENDANCE_EVIDENCE_V2
    ),

    attendanceEvidenceOperationsV2: db.collection(
      OPERATIONAL_COLLECTIONS.ATTENDANCE_EVIDENCE_OPERATIONS_V2
    ),
  };
}
