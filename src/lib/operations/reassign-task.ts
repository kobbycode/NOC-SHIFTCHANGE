
import "server-only";

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
  requireValidTaskAssignmentHistory,
} from "./assignment-transaction";

import {
  requireEligibleAssignmentShift,
} from "./assignment-shift-eligibility";

import {
  getTaskAssignmentInstanceId,
  resolveTaskAssignmentGeneration,
} from "./assignment-identity";

import { nextTaskAssignmentGeneration } from "./assignment-generation-domain";

export interface ReassignTaskInput {
  taskId: string;

  assignmentId: string;

  originalTechnicianUid: string;

  replacementTechnicianUid: string;

  performedBy: string;

  reason: string;
}

export interface ReassignTaskResult {
  previousAssignmentId: string;

  replacementAssignment: TaskAssignment;

  releasedAt: string;
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

export async function reassignTask(
  input: ReassignTaskInput
): Promise<ReassignTaskResult> {
  const {
    taskId,
    assignmentId,
    originalTechnicianUid,
    replacementTechnicianUid,
    performedBy,
    reason,
  } = input;

  /*
   * PHASE 1:
   * Validate request data.
   */

  if (
    !validIdentifier(taskId, 512) ||
    !validIdentifier(assignmentId, 1500) ||
    !validIdentifier(
      originalTechnicianUid,
      128
    ) ||
    !validIdentifier(
      replacementTechnicianUid,
      128
    ) ||
    !validIdentifier(
      performedBy,
      128
    )
  ) {
    throw new AssignmentOperationError(
      "Please provide valid reassignment details.",
      400
    );
  }

  if (
    originalTechnicianUid ===
    replacementTechnicianUid
  ) {
    throw new AssignmentOperationError(
      "Select a different replacement technician.",
      400
    );
  }

  if (
    typeof reason !== "string" ||
    reason.trim().length < 10 ||
    reason.trim().length > 1000
  ) {
    throw new AssignmentOperationError(
      "Please provide a reassignment reason between 10 and 1000 characters.",
      400
    );
  }

  const cleanReason =
    reason.trim();

  /*
   * PHASE 2:
   * Prepare authoritative references.
   */

  const db =
    getAdminFirestore();

  const {
    tasks,
    taskAssignments,
    taskAssignmentHistory,
  } = getOperationalCollections();

  const taskRef =
    tasks.doc(taskId);

  const originalAssignmentRef = taskAssignments.doc(assignmentId);

  const actorRef = db
    .collection("users")
    .doc(performedBy);

  const originalTechnicianRef = db
    .collection("users")
    .doc(originalTechnicianUid);

  const historyRef =
    taskAssignmentHistory.doc();

  const auditRef = db
    .collection("audit_logs")
    .doc();

  /*
   * PHASE 3:
   * Execute the authoritative transaction.
   */

  return db.runTransaction(
    async (
      transaction
    ): Promise<ReassignTaskResult> => {
      /*
       * Read every required document
       * before performing writes.
       */

      const taskSnapshot =
        await transaction.get(taskRef);

      const actorSnapshot =
        await transaction.get(actorRef);

      const originalAssignmentSnapshot =
        await transaction.get(
          originalAssignmentRef
        );

      const assignmentHistory = await transaction.get(taskAssignments.where("taskId", "==", taskId));

      const originalTechnicianSnapshot =
        await transaction.get(
          originalTechnicianRef
        );

      /*
       * PHASE 4:
       * Validate the acting account.
       */

      const actor =
        actorSnapshot.data();

      if (
        !actorSnapshot.exists ||
        !actor ||
        actor.status !== "active" ||
        actor.statusOperation != null ||
        actor.mustChangePassword === true ||
        ![
          "admin",
          "supervisor",
        ].includes(actor.role)
      ) {
        throw new AssignmentOperationError(
          "Your account is not authorized to reassign tasks.",
          403
        );
      }

      /*
       * PHASE 5:
       * Validate the authoritative task.
       */

      if (!taskSnapshot.exists) {
        throw new AssignmentOperationError(
          "The selected task was not found.",
          404
        );
      }

      const task =
        taskSnapshot.data();

      if (
        !task ||
        !Object.values(
          TASK_STATUSES
        ).includes(task.status)
      ) {
        throw new AssignmentOperationError(
          "The selected task has an invalid status.",
          409
        );
      }

      if (
        task.status ===
          TASK_STATUSES.COMPLETED ||
        task.status ===
          TASK_STATUSES.CANCELLED
      ) {
        throw new AssignmentOperationError(
          "Completed or cancelled tasks cannot be reassigned.",
          409
        );
      }

      if (
        task.shiftId !== null &&
        !validIdentifier(
          task.shiftId,
          512
        )
      ) {
        throw new AssignmentOperationError(
          "The task has invalid shift information.",
          409
        );
      }

      /*
       * PHASE 6:
       * Validate the original assignment.
       */

      if (
        !originalAssignmentSnapshot.exists
      ) {
        throw new AssignmentOperationError(
          "The original task assignment was not found.",
          404
        );
      }

      const history = requireValidTaskAssignmentHistory(taskId, assignmentHistory.docs);
      const originalAssignment =
        originalAssignmentSnapshot.data();

      if (
        !originalAssignment ||
        originalAssignment.id !==
          originalAssignmentRef.id ||
        originalAssignment.taskId !==
          taskId ||
        originalAssignment.technicianId !==
          originalTechnicianUid ||
        ![
          "lead",
          "support",
        ].includes(
          originalAssignment.responsibility
        ) ||
        !Object.values(
          TASK_ACCEPTANCE_STATUSES
        ).includes(
          originalAssignment.acceptanceStatus
        )
      ) {
        throw new AssignmentOperationError(
          "The original assignment requires administrator review.",
          409
        );
      }

      /*
       * Legacy assignments without a
       * responsibilityStatus are active.
       *
       * Explicitly released assignments
       * cannot be transferred again.
       */

      if (
        originalAssignment.responsibilityStatus !==
          undefined &&
        originalAssignment.responsibilityStatus !==
          TASK_RESPONSIBILITY_STATUSES.ACTIVE
      ) {
        throw new AssignmentOperationError(
          "The original assignment has already been released or has an invalid responsibility state.",
          409
        );
      }

      if (
        originalAssignment.releasedAt != null ||
        originalAssignment.releasedBy != null ||
        originalAssignment.transferredTo != null
      ) {
        throw new AssignmentOperationError(
          "The original assignment has inconsistent release information.",
          409
        );
      }

      /*
       * Validate acceptance metadata.
       */

      if (
        typeof originalAssignment.assignedAt !==
          "string" ||
        !originalAssignment.assignedAt
      ) {
        throw new AssignmentOperationError(
          "The original assignment has invalid assignment information.",
          409
        );
      }

      if (
        originalAssignment.acceptanceStatus ===
          TASK_ACCEPTANCE_STATUSES.PENDING &&
        (
          originalAssignment.acceptedAt !== null ||
          originalAssignment.rejectedAt !== null ||
          originalAssignment.rejectionReason !== null
        )
      ) {
        throw new AssignmentOperationError(
          "The original assignment has inconsistent pending information.",
          409
        );
      }

      if (
        originalAssignment.acceptanceStatus ===
          TASK_ACCEPTANCE_STATUSES.ACCEPTED &&
        (
          typeof originalAssignment.acceptedAt !==
            "string" ||
          originalAssignment.rejectedAt !== null ||
          originalAssignment.rejectionReason !== null
        )
      ) {
        throw new AssignmentOperationError(
          "The original assignment has inconsistent acceptance information.",
          409
        );
      }

      if (
        originalAssignment.acceptanceStatus ===
          TASK_ACCEPTANCE_STATUSES.REJECTED &&
        (
          originalAssignment.acceptedAt !== null ||
          typeof originalAssignment.rejectedAt !==
            "string" ||
          typeof originalAssignment.rejectionReason !==
            "string" ||
          !originalAssignment.rejectionReason.trim()
        )
      ) {
        throw new AssignmentOperationError(
          "The original assignment has inconsistent rejection information.",
          409
        );
      }

      /*
       * PHASE 7:
       * Prevent duplicate replacement
       * assignments.
       */

      if (
        history.some(record => record.technicianId === replacementTechnicianUid && record.responsibilityStatus !== "released")
      ) {
        throw new AssignmentOperationError(
          "The replacement technician already has an active assignment for this task.",
          409
        );
      }

      let replacementGeneration: number;
      try { replacementGeneration = nextTaskAssignmentGeneration(history, replacementTechnicianUid); }
      catch { throw new AssignmentOperationError("Malformed assignment generation history; administrator review required.", 409); }
      const replacementAssignmentRef = taskAssignments.doc(getTaskAssignmentInstanceId(taskId, replacementTechnicianUid, replacementGeneration));
      if ((await transaction.get(replacementAssignmentRef)).exists) {
        throw new AssignmentOperationError("Assignment instance identity is already occupied; administrator review required.", 409);
      }

      /*
       * PHASE 8:
       * Validate the original technician.
       *
       * An account-management operation
       * in progress prevents reassignment.
       */

      const originalTechnician =
        originalTechnicianSnapshot.data();

      if (
        !originalTechnicianSnapshot.exists ||
        !originalTechnician ||
        originalTechnician.role !==
          "technician" ||
        originalTechnician.statusOperation != null
      ) {
        throw new AssignmentOperationError(
          "The original technician account requires administrator review.",
          409
        );
      }

      /*
       * The original technician may
       * already be blocked.
       *
       * Reassignment can be necessary
       * to recover operational duties.
       *
       * However, an in-progress account
       * operation must never be bypassed.
       */

      if (
        ![
          "active",
          "blocked",
        ].includes(
          originalTechnician.status
        )
      ) {
        throw new AssignmentOperationError(
          "The original technician has an invalid account status.",
          409
        );
      }

      /*
       * PHASE 9:
       * Validate the replacement technician
       * inside the same transaction.
       */

      await requireEligibleTechnician(
        transaction,
        replacementTechnicianUid
      );

      /*
       * PHASE 10:
       * Apply the same shift eligibility
       * requirements as initial assignment.
       */

      await requireEligibleAssignmentShift(
        transaction,
        task.shiftId,
        replacementTechnicianUid
      );

      /*
       * PHASE 11:
       * Prepare the new assignment.
       *
       * All transaction reads are complete.
       */

      const now =
        new Date().toISOString();

      const replacementAssignment:
        TaskAssignment = {
          id:
            replacementAssignmentRef.id,
          generation: replacementGeneration,

          taskId,

          technicianId:
            replacementTechnicianUid,

          responsibility:
            originalAssignment.responsibility,

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
       * PHASE 12:
       * Atomically release the original
       * responsibility and create the
       * replacement assignment.
       */

      transaction.update(
        originalAssignmentRef,
        {
          responsibilityStatus:
            TASK_RESPONSIBILITY_STATUSES.RELEASED,

          releaseMode: "reassignment",
          releasedAt: now,

          releasedBy:
            performedBy,

          transferredTo:
            replacementTechnicianUid,
        }
      );

      transaction.create(
        replacementAssignmentRef,
        replacementAssignment
      );

      /*
       * Preserve the original acceptance
       * or rejection history.
       *
       * Record the transfer as a separate
       * operational event.
       */

      transaction.create(
        historyRef,
        {
          id: historyRef.id,

          taskId,

          assignmentId:
            originalAssignmentRef.id,

          event: "transferred",
          originalGeneration: resolveTaskAssignmentGeneration(originalAssignment.generation),
          replacementGeneration,

          previousTechnicianId:
            originalTechnicianUid,

          newTechnicianId:
            replacementTechnicianUid,

          responsibility:
            originalAssignment.responsibility,

          previousAcceptanceStatus:
            originalAssignment.acceptanceStatus,

          newAcceptanceStatus:
            TASK_ACCEPTANCE_STATUSES.PENDING,

          performedBy,

          reason:
            cleanReason,

          createdAt: now,

          replacementAssignmentId:
            replacementAssignmentRef.id,
        }
      );

      /*
       * Coordinate with concurrent
       * account-status operations.
       */

      markAssignmentActivity(
        transaction,
        originalTechnicianUid
      );

      markAssignmentActivity(
        transaction,
        replacementTechnicianUid
      );

      /*
       * Update task assignment metadata.
       */

      transaction.update(
        taskRef,
        {
          updatedAt: now,

          lastAssignmentBy:
            performedBy,

          lastAssignmentAt:
            FieldValue.serverTimestamp(),

          lastReassignmentBy:
            performedBy,

          lastReassignmentAt:
            FieldValue.serverTimestamp(),
        }
      );

      /*
       * Record the authoritative audit
       * event in the same transaction.
       */

      transaction.create(
        auditRef,
        {
          id: auditRef.id,

          action:
            "TASK_REASSIGNED",
          originalGeneration: resolveTaskAssignmentGeneration(originalAssignment.generation),
          replacementGeneration,

          actorUid:
            performedBy,

          taskId,

          previousAssignmentId:
            originalAssignmentRef.id,

          replacementAssignmentId:
            replacementAssignmentRef.id,

          previousTechnicianUid:
            originalTechnicianUid,

          replacementTechnicianUid,

          responsibility:
            originalAssignment.responsibility,

          reason:
            cleanReason,

          createdAt:
            FieldValue.serverTimestamp(),

          details:
            "An operational task responsibility was transferred to another technician.",
        }
      );

      return {
        previousAssignmentId:
          originalAssignmentRef.id,

        replacementAssignment,

        releasedAt: now,
      };
    }
  );
}
