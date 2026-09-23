
import "server-only";

import {
  requireEligibleAssignmentShift,
} from "./assignment-shift-eligibility";
import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  TASK_ACCEPTANCE_STATUSES,
  TASK_RESPONSIBILITY_STATUSES,
  TASK_STATUSES,
  type TaskAssignment,
} from "@/types/task";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
  requireEligibleTechnician,
  markAssignmentActivity,
} from "./assignment-transaction";

import {
  getTaskAssignmentId,
} from "./assignment-identity";

export interface CreateTaskAssignmentInput {
  taskId: string;
  technicianUid: string;
  responsibility: "lead" | "support";
  assignedBy: string;
}

function validIdentifier(
  value: unknown,
  maxLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !value.includes("/")
  );
}

export async function createTaskAssignment(
  input: CreateTaskAssignmentInput
): Promise<TaskAssignment> {
  const {
    taskId,
    technicianUid,
    responsibility,
    assignedBy,
  } = input;

  /*
   * PHASE 1:
   * Validate request identifiers.
   */

  if (
    !validIdentifier(taskId, 512) ||
    !validIdentifier(technicianUid, 128) ||
    !validIdentifier(assignedBy, 128)
  ) {
    throw new AssignmentOperationError(
      "Please provide valid task-assignment details.",
      400
    );
  }

  if (
    responsibility !== "lead" &&
    responsibility !== "support"
  ) {
    throw new AssignmentOperationError(
      "Please select a valid task responsibility.",
      400
    );
  }

  const db = getAdminFirestore();

  const {
    tasks,
    taskAssignments,
    taskAssignmentHistory,
  } = getOperationalCollections();

  const taskRef = tasks.doc(taskId);

  const assignmentRef =
    taskAssignments.doc(
      getTaskAssignmentId(
        taskId,
        technicianUid
      )
    );

  const actorRef = db
    .collection("users")
    .doc(assignedBy);

  const historyRef =
    taskAssignmentHistory.doc();

  const auditRef = db
    .collection("audit_logs")
    .doc();

  /*
   * PHASE 2:
   * Execute the authoritative transaction.
   */

  return db.runTransaction(
    async (transaction): Promise<TaskAssignment> => {
      /*
       * Read the task and acting account.
       */

      const taskSnapshot =
        await transaction.get(taskRef);

      const actorSnapshot =
        await transaction.get(actorRef);

      const existingAssignment =
        await transaction.get(assignmentRef);

      /*
       * Validate the acting administrator
       * or supervisor.
       */

      const actor = actorSnapshot.data();

      if (
        !actorSnapshot.exists ||
        !actor ||
        actor.status !== "active" ||
        actor.statusOperation != null ||
        actor.mustChangePassword === true ||
        !["admin", "supervisor"].includes(
          actor.role
        )
      ) {
        throw new AssignmentOperationError(
          "Your account is not authorized to assign tasks.",
          403
        );
      }

      /*
       * Validate the authoritative task.
       */

      if (!taskSnapshot.exists) {
        throw new AssignmentOperationError(
          "The selected task was not found.",
          404
        );
      }

      const task = taskSnapshot.data();

      if (
        !task ||
        !Object.values(TASK_STATUSES).includes(
          task.status
        )
      ) {
        throw new AssignmentOperationError(
          "The selected task has an invalid status.",
          409
        );
      }

      if (
        task.status === TASK_STATUSES.COMPLETED ||
        task.status === TASK_STATUSES.CANCELLED
      ) {
        throw new AssignmentOperationError(
          "Completed or cancelled tasks cannot receive new assignments.",
          409
        );
      }

      if (
        task.shiftId !== null &&
        !validIdentifier(task.shiftId, 512)
      ) {
        throw new AssignmentOperationError(
          "The selected task has invalid shift information.",
          409
        );
      }

      /*
       * Prevent duplicate assignments.
       */

      if (existingAssignment.exists) {
        throw new AssignmentOperationError(
          "This technician is already assigned to the selected task.",
          409
        );
      }

      /*
       * PHASE 3:
       * Validate the technician inside
       * the same transaction.
       */

      await requireEligibleTechnician(
        transaction,
        technicianUid
      );

      /*
       * PHASE 4:
       * Validate shift-linked assignments.
       *
       * Standalone tasks have no shiftId
       * and do not require shift membership.
       */

      await requireEligibleAssignmentShift(
        transaction,
        task.shiftId,
        technicianUid
      );

      /*
       * PHASE 5:
       * Prepare assignment records.
       *
       * No transaction writes have
       * occurred before this point.
       */

      const now = new Date().toISOString();

      const assignment: TaskAssignment = {
        id: assignmentRef.id,

        taskId,

        technicianId: technicianUid,

        responsibility,

        acceptanceStatus:
          TASK_ACCEPTANCE_STATUSES.PENDING,

        acceptedAt: null,

        rejectedAt: null,

        rejectionReason: null,

        assignedAt: now,

        responsibilityStatus:
          TASK_RESPONSIBILITY_STATUSES.ACTIVE,

        releasedAt: null,

        releasedBy: null,

        transferredTo: null,
      };

      /*
       * PHASE 6:
       * Commit the assignment,
       * history, audit event and
       * account activity atomically.
       */

      transaction.create(
        assignmentRef,
        assignment
      );

      transaction.create(
        historyRef,
        {
          id: historyRef.id,

          taskId,

          assignmentId: assignmentRef.id,

          event: "assigned",

          previousTechnicianId: null,

          newTechnicianId:
            technicianUid,

          responsibility,

          previousAcceptanceStatus: null,

          newAcceptanceStatus:
            TASK_ACCEPTANCE_STATUSES.PENDING,

          performedBy: assignedBy,

          reason:
            "Initial task assignment.",

          createdAt: now,
        }
      );

      markAssignmentActivity(
        transaction,
        technicianUid
      );

      transaction.update(
        taskRef,
        {
          updatedAt: now,

          lastAssignmentBy:
            assignedBy,

          lastAssignmentAt:
            FieldValue.serverTimestamp(),
        }
      );

      transaction.create(
        auditRef,
        {
          id: auditRef.id,

          action: "TASK_ASSIGNED",

          actorUid: assignedBy,

          taskId,

          technicianUid,

          responsibility,

          createdAt:
            FieldValue.serverTimestamp(),

          details:
            "An operational task was assigned to a technician.",
        }
      );

      return assignment;
    }
  );
}