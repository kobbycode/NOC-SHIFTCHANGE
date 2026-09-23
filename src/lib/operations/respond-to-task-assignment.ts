import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminFirestore } from "@/lib/firebase/admin";

import {
  TASK_ACCEPTANCE_STATUSES,
  TASK_RESPONSIBILITY_STATUSES,
  TASK_STATUSES,
  type TaskAssignment,
  type TaskAcceptanceStatus,
} from "@/types/task";

import { SHIFT_STATUSES } from "@/types/shift";

import { getOperationalCollections } from "./collections";

import { getTaskAssignmentId } from "./assignment-identity";

import {
  AssignmentOperationError,
  markAssignmentActivity,
} from "./assignment-transaction";

export interface RespondToTaskAssignmentInput {
  taskId: string;

  assignmentId: string;

  technicianUid: string;

  action: "accept" | "reject";

  rejectionReason?: string;
}

function validIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !value.includes("/")
  );
}

export async function respondToTaskAssignment(
  input: RespondToTaskAssignmentInput,
): Promise<TaskAssignment> {
  const { taskId, assignmentId, technicianUid, action, rejectionReason } =
    input;

  /*
   * PHASE 1:
   * Validate all request parameters.
   */

  if (
    !validIdentifier(taskId, 512) ||
    !validIdentifier(assignmentId, 1500) ||
    !validIdentifier(technicianUid, 128)
  ) {
    throw new AssignmentOperationError(
      "Please provide valid assignment details.",
      400,
    );
  }

  if (action !== "accept" && action !== "reject") {
    throw new AssignmentOperationError(
      "Please select a valid assignment response.",
      400,
    );
  }

  if (
    action === "reject" &&
    (typeof rejectionReason !== "string" ||
      rejectionReason.trim().length < 5 ||
      rejectionReason.trim().length > 1000)
  ) {
    throw new AssignmentOperationError(
      "Please provide a rejection reason between 5 and 1000 characters.",
      400,
    );
  }

  /*
   * The assignment ID must match the
   * authoritative task/technician pair.
   *
   * Never trust an assignment ID supplied
   * by the browser without validation.
   */

  const expectedAssignmentId = getTaskAssignmentId(taskId, technicianUid);

  if (assignmentId !== expectedAssignmentId) {
    throw new AssignmentOperationError(
      "You are not authorized to respond to this assignment.",
      403,
    );
  }

  /*
   * PHASE 2:
   * Prepare authoritative references.
   */

  const db = getAdminFirestore();

  const { tasks, shifts, taskAssignments, taskAssignmentHistory } =
    getOperationalCollections();

  const taskRef = tasks.doc(taskId);

  const assignmentRef = taskAssignments.doc(assignmentId);

  const technicianRef = db.collection("users").doc(technicianUid);

  const historyRef = taskAssignmentHistory.doc();

  const auditRef = db.collection("audit_logs").doc();

  /*
   * PHASE 3:
   * Execute the response transaction.
   */

  return db.runTransaction(async (transaction): Promise<TaskAssignment> => {
    /*
     * All required Firestore reads
     * must occur before any writes.
     */

    const technicianSnapshot = await transaction.get(technicianRef);

    const assignmentSnapshot = await transaction.get(assignmentRef);

    const taskSnapshot = await transaction.get(taskRef);

    /*
     * PHASE 4:
     * Verify the technician account.
     */

    const technician = technicianSnapshot.data();

    if (
      !technicianSnapshot.exists ||
      !technician ||
      technician.role !== "technician" ||
      technician.status !== "active" ||
      technician.statusOperation != null ||
      technician.mustChangePassword === true
    ) {
      throw new AssignmentOperationError(
        "Your account is not eligible to respond to task assignments.",
        403,
      );
    }

    /*
     * PHASE 5:
     * Verify the authoritative assignment.
     */

    if (!assignmentSnapshot.exists) {
      throw new AssignmentOperationError(
        "The selected assignment was not found.",
        404,
      );
    }

    const assignment = assignmentSnapshot.data();

    if (
      !assignment ||
      assignment.id !== assignmentId ||
      assignment.taskId !== taskId ||
      assignment.technicianId !== technicianUid ||
      !["lead", "support"].includes(assignment.responsibility)
    ) {
      throw new AssignmentOperationError(
        "The assignment records require administrator review.",
        409,
      );
    }

    /*
     * A released assignment must never
     * receive another acceptance or rejection.
     * Legacy assignments without an explicit
     * responsibilityStatus are treated as active.
     */
    if (
      assignment.responsibilityStatus !== undefined &&
      assignment.responsibilityStatus !== TASK_RESPONSIBILITY_STATUSES.ACTIVE
    ) {
      throw new AssignmentOperationError(
        "This assignment has been released or has an invalid responsibility state.",
        409,
      );
    }

    if (
      assignment.releasedAt != null ||
      assignment.releasedBy != null ||
      assignment.transferredTo != null
    ) {
      throw new AssignmentOperationError(
        "This assignment has inconsistent release information.",
        409,
      );
    }

    /*
     * Only pending assignments may
     * receive an acceptance or rejection.
     */

    if (assignment.acceptanceStatus !== TASK_ACCEPTANCE_STATUSES.PENDING) {
      throw new AssignmentOperationError(
        "This assignment has already received a response.",
        409,
      );
    }

    /*
     * Validate the original pending
     * assignment state.
     */

    if (
      assignment.acceptedAt !== null ||
      assignment.rejectedAt !== null ||
      assignment.rejectionReason !== null ||
      typeof assignment.assignedAt !== "string" ||
      !assignment.assignedAt
    ) {
      throw new AssignmentOperationError(
        "The assignment has inconsistent acceptance information.",
        409,
      );
    }

    /*
     * PHASE 6:
     * Validate the authoritative task.
     */

    if (!taskSnapshot.exists) {
      throw new AssignmentOperationError(
        "The assigned task was not found.",
        409,
      );
    }

    const task = taskSnapshot.data();

    if (!task || !Object.values(TASK_STATUSES).includes(task.status)) {
      throw new AssignmentOperationError(
        "The assigned task has an invalid status.",
        409,
      );
    }

    if (
      task.status === TASK_STATUSES.COMPLETED ||
      task.status === TASK_STATUSES.CANCELLED
    ) {
      throw new AssignmentOperationError(
        "Completed or cancelled tasks cannot receive assignment responses.",
        409,
      );
    }

    /*
     * PHASE 7:
     * Validate shift-linked tasks.
     *
     * Standalone tasks do not require
     * a shift reference.
     */

    if (task.shiftId !== null && !validIdentifier(task.shiftId, 512)) {
      throw new AssignmentOperationError(
        "The task has invalid shift information.",
        409,
      );
    }

    if (task.shiftId !== null) {
      const shiftSnapshot = await transaction.get(shifts.doc(task.shiftId));

      if (!shiftSnapshot.exists) {
        throw new AssignmentOperationError(
          "The task references a missing shift.",
          409,
        );
      }

      const shift = shiftSnapshot.data();

      if (
        !shift ||
        ![SHIFT_STATUSES.SCHEDULED, SHIFT_STATUSES.ACTIVE].includes(
          shift.status,
        )
      ) {
        throw new AssignmentOperationError(
          "Assignment responses are unavailable during handover or after shift completion.",
          409,
        );
      }
    }

    /*
     * PHASE 8:
     * Prepare the response.
     *
     * All transaction reads are now
     * complete.
     */

    const now = new Date().toISOString();

    const nextStatus: TaskAcceptanceStatus =
      action === "accept"
        ? TASK_ACCEPTANCE_STATUSES.ACCEPTED
        : TASK_ACCEPTANCE_STATUSES.REJECTED;

    const updatedAssignment: TaskAssignment = {
      id: assignmentId,

      taskId,

      technicianId: technicianUid,

      responsibility: assignment.responsibility,

      // Preserve the authoritative
      // responsibility state.
      responsibilityStatus:
        assignment.responsibilityStatus ?? TASK_RESPONSIBILITY_STATUSES.ACTIVE,

      releasedAt: assignment.releasedAt ?? null,

      releasedBy: assignment.releasedBy ?? null,

      transferredTo: assignment.transferredTo ?? null,

      acceptanceStatus: nextStatus,

      acceptedAt: action === "accept" ? now : null,

      rejectedAt: action === "reject" ? now : null,

      rejectionReason: action === "reject" ? rejectionReason!.trim() : null,

      assignedAt: assignment.assignedAt,
    };

    /*
     * PHASE 9:
     * Atomically update the assignment,
     * history, audit event and account
     * activity.
     */

    transaction.update(assignmentRef, {
      acceptanceStatus: updatedAssignment.acceptanceStatus,

      acceptedAt: updatedAssignment.acceptedAt,

      rejectedAt: updatedAssignment.rejectedAt,

      rejectionReason: updatedAssignment.rejectionReason,
    });

    transaction.create(historyRef, {
      id: historyRef.id,

      taskId,

      assignmentId,

      event: action === "accept" ? "accepted" : "rejected",

      previousTechnicianId: technicianUid,

      newTechnicianId: technicianUid,

      responsibility: assignment.responsibility,

      responsibilityStatus:
        assignment.responsibilityStatus ?? TASK_RESPONSIBILITY_STATUSES.ACTIVE,

      releasedAt: assignment.releasedAt ?? null,

      releasedBy: assignment.releasedBy ?? null,

      transferredTo: assignment.transferredTo ?? null,

      previousAcceptanceStatus: TASK_ACCEPTANCE_STATUSES.PENDING,

      newAcceptanceStatus: nextStatus,

      performedBy: technicianUid,

      reason:
        action === "accept"
          ? "Technician accepted the assignment."
          : rejectionReason!.trim(),

      createdAt: now,
    });

    /*
     * Preserve the account-status
     * concurrency safeguard.
     */

    markAssignmentActivity(transaction, technicianUid);

    transaction.update(taskRef, {
      updatedAt: now,

      lastAssignmentResponseBy: technicianUid,

      lastAssignmentResponseAt: FieldValue.serverTimestamp(),
    });

    transaction.create(auditRef, {
      id: auditRef.id,

      action: action === "accept" ? "TASK_ACCEPTED" : "TASK_REJECTED",

      actorUid: technicianUid,

      taskId,

      assignmentId,

      technicianUid,

      createdAt: FieldValue.serverTimestamp(),

      details:
        action === "accept"
          ? "Technician accepted an operational task assignment."
          : "Technician rejected an operational task assignment.",

      ...(action === "reject"
        ? {
            rejectionReason: rejectionReason!.trim(),
          }
        : {}),
    });

    return updatedAssignment;
  });
}
