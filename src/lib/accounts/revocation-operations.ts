
import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  TASK_STATUSES,
  type Task,
  type TaskAssignment,
} from "@/types/task";

import {
  SHIFT_STATUSES,
  type Shift,
  type ShiftMember,
} from "@/types/shift";

import {
  evaluateRevocationEligibility,
  type RevocationEligibilityResult,
} from "./revocation-eligibility";

import {
  type AppUser,
} from "@/types/auth";

const UNFINISHED_TASK_STATUSES = new Set<string>([
  TASK_STATUSES.OPEN,
  TASK_STATUSES.IN_PROGRESS,
  TASK_STATUSES.PENDING_VERIFICATION,
]);

const BLOCKING_SHIFT_STATUSES = new Set<string>([
  SHIFT_STATUSES.SCHEDULED,
  SHIFT_STATUSES.ACTIVE,
  SHIFT_STATUSES.HANDOVER_PENDING,
]);

export interface OperationalRevocationResult {
  eligible: boolean;

  errors: string[];

  taskTransfers: {
    taskId: string;
    assignmentId: string;
    fromUid: string;
    toUid: string;
  }[];
}

export async function checkOperationalRevocation(
  actor: AppUser,
  target: AppUser,
  originalAdminUid: string
): Promise<OperationalRevocationResult> {
  const db = getAdminFirestore();

  /*
   * Fail closed until the operational collections
   * and their write-side safeguards are implemented.
   *
   * This service currently performs read-only checks.
   * It must not be used to authorize a live revocation.
   */

  const operationalServicesEnabled = false;

  if (!operationalServicesEnabled) {
    return {
      eligible: false,

      errors: [
        "Permanent account revocation is unavailable until shift, task, and handover safeguards have been implemented.",
      ],

      taskTransfers: [],
    };
  }

  const [
    shiftsSnapshot,
    membersSnapshot,
    tasksSnapshot,
    assignmentsSnapshot,
  ] = await Promise.all([
    db.collection("shifts").get(),

    db.collection("shift_members").get(),

    db.collection("tasks").get(),

    db.collection("task_assignments").get(),
  ]);

  const shifts = shiftsSnapshot.docs.map(
    (document) => ({
      ...document.data(),
      id: document.id,
    }) as Shift
  );

  const members = membersSnapshot.docs.map(
    (document) => ({
      ...document.data(),
      id: document.id,
    }) as ShiftMember
  );

  const tasks = tasksSnapshot.docs.map(
    (document) => ({
      ...document.data(),
      id: document.id,
    }) as Task
  );

  const assignments = assignmentsSnapshot.docs.map(
    (document) => ({
      ...document.data(),
      id: document.id,
    }) as TaskAssignment
  );

  const targetMemberships = members.filter(
    (member) =>
      member.technicianId === target.uid
  );

  const targetShiftIds = new Set(
    targetMemberships.map(
      (member) => member.shiftId
    )
  );

  const relatedShifts = shifts.filter(
    (shift) =>
      targetShiftIds.has(shift.id) ||
      shift.primaryTechnicianIds?.includes(
        target.uid
      )
  );

  const errors: string[] = [];

  const blockingShifts = relatedShifts.filter(
    (shift) =>
      BLOCKING_SHIFT_STATUSES.has(
        shift.status
      )
  );

  if (blockingShifts.length > 0) {
    errors.push(
      "The technician has a scheduled or active shift, or an unfinished handover. Resolve these duties before revoking the account."
    );
  }

  const invalidShifts = relatedShifts.filter(
    (shift) =>
      !Object.values(
        SHIFT_STATUSES
      ).includes(shift.status)
  );

  if (invalidShifts.length > 0) {
    errors.push(
      "One or more related shifts have an invalid status. Administrator review is required."
    );
  }

  const targetAssignments = assignments.filter(
    (assignment) =>
      assignment.technicianId === target.uid
  );

  const taskTransfers:
    OperationalRevocationResult["taskTransfers"] = [];

  for (const assignment of targetAssignments) {
    const task = tasks.find(
      (item) =>
        item.id === assignment.taskId
    );

    if (!task) {
      errors.push(
        `Assignment ${assignment.id} references a missing task.`
      );

      continue;
    }

    if (
      !UNFINISHED_TASK_STATUSES.has(
        task.status
      )
    ) {
      continue;
    }

    if (!task.shiftId) {
      errors.push(
        `Task ${task.id} has no associated shift. Its primary partner cannot be determined.`
      );

      continue;
    }

    const shift = shifts.find(
      (item) =>
        item.id === task.shiftId
    );

    if (!shift) {
      errors.push(
        `Task ${task.id} references a missing shift.`
      );

      continue;
    }

    const partnerIds =
      shift.primaryTechnicianIds.filter(
        (uid) => uid !== target.uid
      );

    if (
      !shift.primaryTechnicianIds.includes(
        target.uid
      ) ||
      partnerIds.length !== 1
    ) {
      errors.push(
        `Task ${task.id} does not have a valid primary shift partner.`
      );

      continue;
    }

    const partnerUid = partnerIds[0];

    const partnerProfile = await db
      .collection("users")
      .doc(partnerUid)
      .get();

    const partner = partnerProfile.data();

    if (
      !partnerProfile.exists ||
      partner?.role !== "technician" ||
      partner.status !== "active" ||
      partner.statusOperation ||
      partner.mustChangePassword === true
    ) {
      errors.push(
        `Task ${task.id} cannot be transferred because its primary shift partner is unavailable.`
      );

      continue;
    }

    const existingPartnerAssignment =
      assignments.find(
        (item) =>
          item.taskId === task.id &&
          item.technicianId === partnerUid
      );

    if (existingPartnerAssignment) {
      errors.push(
        `Task ${task.id} already has an assignment for its primary shift partner. Assignment review is required.`
      );

      continue;
    }

    taskTransfers.push({
      taskId: task.id,
      assignmentId: assignment.id,
      fromUid: target.uid,
      toUid: partnerUid,
    });
  }

  const eligibility:
    RevocationEligibilityResult =
    evaluateRevocationEligibility({
      actorUid: actor.uid,
      actorRole: actor.role,

      originalAdminUid,

      targetUid: target.uid,
      targetRole: target.role,
      targetStatus: target.status,

      hasPendingAccountOperation: false,

      shifts: relatedShifts.map(
        (shift) => ({
          id: shift.id,
          status: shift.status,
          technicianIds:
            shift.primaryTechnicianIds,
        })
      ),

      unfinishedTasks: [],

      eligiblePartnerIds: [],
    });

  return {
    eligible:
      errors.length === 0 &&
      eligibility.eligible,

    errors: [
      ...errors,
      ...eligibility.errors,
    ],

    taskTransfers:
      errors.length === 0 &&
      eligibility.eligible
        ? taskTransfers
        : [],
  };
}