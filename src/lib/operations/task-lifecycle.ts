
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
  type TaskStatus,
} from "@/types/task";

import {
  SHIFT_STATUSES,
} from "@/types/shift";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
  markAssignmentActivity,
} from "./assignment-transaction";

/*
 * AUTHORITATIVE TASK LIFECYCLE
 *
 * All state transitions execute inside
 * a Firestore transaction.
 *
 * Account-blocking safeguards must
 * remain active.
 */

export type TaskLifecycleAction =
  | "start"
  | "submit"
  | "return"
  | "complete"
  | "cancel";

export interface TaskLifecycleInput {
  taskId: string;

  actorUid: string;

  action: TaskLifecycleAction;

  reason?: string;
}

export interface TaskLifecycleResult {
  taskId: string;

  previousStatus: TaskStatus;

  status: TaskStatus;

  performedBy: string;

  updatedAt: string;
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

function isTaskStatus(
  value: unknown
): value is TaskStatus {
  return (
    typeof value === "string" &&
    Object.values(
      TASK_STATUSES
    ).some(
      (status) => status === value
    )
  );
}

function lifecycleError(
  message: string,
  status = 409
): never {
  throw new AssignmentOperationError(
    message,
    status
  );
}

/*
 * Define the only permitted
 * task-status transitions.
 */

const TRANSITIONS: Record<
  TaskLifecycleAction,
  {
    from: readonly TaskStatus[];
    to: TaskStatus;
  }
> = {
  start: {
    from: [
      TASK_STATUSES.OPEN,
    ],
    to:
      TASK_STATUSES.IN_PROGRESS,
  },

  submit: {
    from: [
      TASK_STATUSES.IN_PROGRESS,
    ],
    to:
      TASK_STATUSES.PENDING_VERIFICATION,
  },

  return: {
    from: [
      TASK_STATUSES.PENDING_VERIFICATION,
    ],
    to:
      TASK_STATUSES.IN_PROGRESS,
  },

  complete: {
    from: [
      TASK_STATUSES.PENDING_VERIFICATION,
    ],
    to:
      TASK_STATUSES.COMPLETED,
  },

  cancel: {
    from: [
      TASK_STATUSES.OPEN,
      TASK_STATUSES.IN_PROGRESS,
      TASK_STATUSES.PENDING_VERIFICATION,
    ],
    to:
      TASK_STATUSES.CANCELLED,
  },
};

/*
 * Execute an authoritative
 * task lifecycle transition.
 */

export async function transitionTask(
  input: TaskLifecycleInput
): Promise<TaskLifecycleResult> {
  const {
    taskId,
    actorUid,
    action,
    reason,
  } = input;

  /*
   * PHASE 1:
   * Validate request information.
   */

  if (
    !validIdentifier(taskId, 512) ||
    !validIdentifier(actorUid, 128)
  ) {
    lifecycleError(
      "Please provide valid task details.",
      400
    );
  }

  if (
    !Object.prototype.hasOwnProperty.call(
      TRANSITIONS,
      action
    )
  ) {
    lifecycleError(
      "Please select a valid task action.",
      400
    );
  }

  if (
    reason !== undefined &&
    typeof reason !== "string"
  ) {
    lifecycleError(
      "Please provide a valid reason.",
      400
    );
  }

  const cleanReason =
    reason?.trim() ?? "";

  if (
    cleanReason.length > 1000
  ) {
    lifecycleError(
      "The reason cannot exceed 1000 characters.",
      400
    );
  }

  if (
    ["return", "cancel"].includes(
      action
    ) &&
    cleanReason.length < 10
  ) {
    lifecycleError(
      "Please provide a reason of at least 10 characters.",
      400
    );
  }

  /*
   * PHASE 2:
   * Prepare authoritative references.
   */

  const db =
    getAdminFirestore();

  const {
    tasks,
    shifts,
    taskAssignments,
  } = getOperationalCollections();

  const taskRef =
    tasks.doc(taskId);

  const actorRef = db
    .collection("users")
    .doc(actorUid);

  const auditRef = db
    .collection("audit_logs")
    .doc();

  /*
   * PHASE 3:
   * Execute the transaction.
   */

  return db.runTransaction(
    async (
      transaction
    ): Promise<TaskLifecycleResult> => {
      /*
       * Read the authoritative task
       * and acting account.
       */

      const taskSnapshot =
        await transaction.get(
          taskRef
        );

      const actorSnapshot =
        await transaction.get(
          actorRef
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
          "technician",
        ].includes(actor.role)
      ) {
        lifecycleError(
          "Your account is not eligible to perform this task operation.",
          403
        );
      }

      /*
       * PHASE 5:
       * Validate the task.
       */

      if (
        !taskSnapshot.exists
      ) {
        lifecycleError(
          "The selected task was not found.",
          404
        );
      }

      const task =
        taskSnapshot.data();

      if (
        !task ||
        task.id !== taskId ||
        !isTaskStatus(
          task.status
        )
      ) {
        lifecycleError(
          "The task has invalid authoritative information."
        );
      }

      const previousStatus:
        TaskStatus = task.status;

      const transition =
        TRANSITIONS[action];

      if (
        !transition.from.includes(
          previousStatus
        )
      ) {
        lifecycleError(
          "This task cannot perform the requested lifecycle transition from its current status."
        );
      }

      /*
       * PHASE 6:
       * Validate the acting role.
       */

      const isManager =
        actor.role === "admin" ||
        actor.role === "supervisor";

      const isTechnician =
        actor.role === "technician";

      const technicianAction =
        action === "start" ||
        action === "submit";

      if (
        technicianAction &&
        !isTechnician
      ) {
        lifecycleError(
          "Only an assigned technician can perform this task action.",
          403
        );
      }

      if (
        !technicianAction &&
        !isManager
      ) {
        lifecycleError(
          "Only an administrator or supervisor can perform this task action.",
          403
        );
      }

      /*
       * PHASE 7:
       * Read authoritative assignments.
       */

      const assignmentsSnapshot =
        await transaction.get(
          taskAssignments.where(
            "taskId",
            "==",
            taskId
          )
        );

      /*
       * Validate every assignment,
       * including released records.
       */

      const activeTechnicianIds =
        new Set<string>();

      const acceptedTechnicianIds =
        new Set<string>();

      const affectedTechnicianIds =
        new Set<string>();

      let activeLeadCount = 0;

      for (
        const document of
        assignmentsSnapshot.docs
      ) {
        const assignment =
          document.data();

        if (
          assignment.id !==
            document.id ||
          assignment.taskId !==
            taskId ||
          !validIdentifier(
            assignment.technicianId,
            128
          ) ||
          ![
            "lead",
            "support",
          ].includes(
            assignment.responsibility
          ) ||
          !Object.values(
            TASK_ACCEPTANCE_STATUSES
          ).includes(
            assignment.acceptanceStatus
          )
        ) {
          lifecycleError(
            "The task contains invalid assignment information."
          );
        }

        const responsibilityStatus =
          assignment.responsibilityStatus ??
          TASK_RESPONSIBILITY_STATUSES.ACTIVE;

        if (
          !Object.values(
            TASK_RESPONSIBILITY_STATUSES
          ).includes(
            responsibilityStatus
          )
        ) {
          lifecycleError(
            "The task contains an invalid responsibility state."
          );
        }

        /*
         * Legacy assignments without
         * responsibilityStatus are active.
         */

        if (
          responsibilityStatus ===
          TASK_RESPONSIBILITY_STATUSES.ACTIVE
        ) {
          if (
            assignment.releasedAt != null ||
            assignment.releasedBy != null ||
            assignment.transferredTo != null
          ) {
            lifecycleError(
              "An active assignment has inconsistent release information."
            );
          }

          if (
            activeTechnicianIds.has(
              assignment.technicianId
            )
          ) {
            lifecycleError(
              "The task contains duplicate active technician assignments."
            );
          }

          activeTechnicianIds.add(
            assignment.technicianId
          );

          affectedTechnicianIds.add(
            assignment.technicianId
          );

          if (
            assignment.responsibility ===
            "lead"
          ) {
            activeLeadCount++;
          }

          if (
            assignment.acceptanceStatus ===
            TASK_ACCEPTANCE_STATUSES.ACCEPTED
          ) {
            acceptedTechnicianIds.add(
              assignment.technicianId
            );
          }
        } else {
          /*
           * Released assignments must
           * retain valid transfer data.
           */

          if (
            typeof assignment.releasedAt !==
              "string" ||
            !validIdentifier(
              assignment.releasedBy,
              128
            ) ||
            !validIdentifier(
              assignment.transferredTo,
              128
            ) ||
            assignment.transferredTo ===
              assignment.technicianId
          ) {
            lifecycleError(
              "A released assignment has inconsistent transfer information."
            );
          }
        }
      }

      /*
       * PHASE 8:
       * Validate technician authority.
       */

      if (
        technicianAction
      ) {
        if (
          !acceptedTechnicianIds.has(
            actorUid
          )
        ) {
          lifecycleError(
            "You must have an active, accepted assignment to perform this task action.",
            403
          );
        }

        /*
         * Only the accepted lead
         * technician controls the
         * task-level lifecycle.
         */

        const leadAssignments =
          assignmentsSnapshot.docs.filter(
            (document) => {
              const assignment =
                document.data();

              return (
                assignment.technicianId ===
                  actorUid &&
                assignment.responsibility ===
                  "lead" &&
                (
                  assignment.responsibilityStatus ===
                    undefined ||
                  assignment.responsibilityStatus ===
                    TASK_RESPONSIBILITY_STATUSES.ACTIVE
                ) &&
                assignment.acceptanceStatus ===
                  TASK_ACCEPTANCE_STATUSES.ACCEPTED
              );
            }
          );

        if (
          leadAssignments.length !== 1
        ) {
          lifecycleError(
            "Only the active, accepted lead technician can perform this task action.",
            403
          );
        }
      }

      /*
       * Starting and submitting work
       * requires an accepted lead.
       */

      if (
        technicianAction &&
        activeLeadCount !== 1
      ) {
        lifecycleError(
          "The task must have exactly one active lead assignment."
        );
      }

      /*
       * PHASE 9:
       * Validate shift-linked tasks.
       */

      if (
        task.shiftId !== null &&
        !validIdentifier(
          task.shiftId,
          512
        )
      ) {
        lifecycleError(
          "The task has invalid shift information."
        );
      }

      if (
        task.shiftId !== null
      ) {
        const shiftSnapshot =
          await transaction.get(
            shifts.doc(
              task.shiftId
            )
          );

        if (
          !shiftSnapshot.exists
        ) {
          lifecycleError(
            "The task references a missing shift."
          );
        }

        const shift =
          shiftSnapshot.data();

        if (
          !shift ||
          !Object.values(
            SHIFT_STATUSES
          ).includes(
            shift.status
          )
        ) {
          lifecycleError(
            "The task references an invalid shift."
          );
        }

        if (
          shift.status ===
          SHIFT_STATUSES.COMPLETED
        ) {
          lifecycleError(
            "Tasks cannot be modified after shift completion."
          );
        }

        /*
         * Technicians may only start
         * or submit work during an
         * active shift.
         */

        if (
          technicianAction &&
          shift.status !==
            SHIFT_STATUSES.ACTIVE
        ) {
          lifecycleError(
            "Task work can only be started or submitted during an active shift."
          );
        }
      }

      /*
       * PHASE 10:
       * Validate account eligibility
       * for every active assignment.
       *
       * All reads occur before writes.
       */

      const activeTechnicianSnapshots =
        await Promise.all(
          [...affectedTechnicianIds].map(
            (technicianUid) =>
              transaction.get(
                db
                  .collection("users")
                  .doc(
                    technicianUid
                  )
              )
          )
        );

      for (
        const snapshot of
        activeTechnicianSnapshots
      ) {
        const technician =
          snapshot.data();

        if (
          !snapshot.exists ||
          !technician ||
          technician.role !==
            "technician" ||
          technician.statusOperation != null
        ) {
          lifecycleError(
            "An active task assignment references a technician account requiring administrator review."
          );
        }

        /*
         * Technician work requires
         * an active account.
         *
         * Manager-led completion or
         * cancellation can resolve
         * existing responsibilities
         * without re-enabling a
         * blocked account.
         */

        if (
          technicianAction &&
          (
            technician.status !==
              "active" ||
            technician.mustChangePassword ===
              true
          )
        ) {
          lifecycleError(
            "A technician assigned to this task is not eligible to perform operational work."
          );
        }
      }

      /*
       * PHASE 11:
       * All transaction reads are
       * complete.
       */

      const now =
        new Date().toISOString();

      const nextStatus =
        transition.to;

      /*
       * Update the authoritative task.
       */

      transaction.update(
        taskRef,
        {
          status:
            nextStatus,

          updatedAt:
            now,

          lastLifecycleAction:
            action,

          lastLifecycleBy:
            actorUid,

          lastLifecycleAt:
            FieldValue.serverTimestamp(),

          ...(action === "start"
            ? {
                startedAt:
                  now,
                startedBy:
                  actorUid,
              }
            : {}),

          ...(action === "submit"
            ? {
                submittedAt:
                  now,
                submittedBy:
                  actorUid,
              }
            : {}),

          ...(action === "return"
            ? {
                returnedAt:
                  now,
                returnedBy:
                  actorUid,
                returnReason:
                  cleanReason,
              }
            : {}),

          ...(action === "complete"
            ? {
                completedAt:
                  now,
                completedBy:
                  actorUid,
              }
            : {}),

          ...(action === "cancel"
            ? {
                cancelledAt:
                  now,
                cancelledBy:
                  actorUid,
                cancellationReason:
                  cleanReason,
              }
            : {}),
        }
      );

      /*
       * Coordinate task operations
       * with account-status changes.
       *
       * Preserve the existing
       * account-blocking safeguard.
       */

      for (
        const technicianUid of
        affectedTechnicianIds
      ) {
        markAssignmentActivity(
          transaction,
          technicianUid
        );
      }

      /*
       * Record the lifecycle event
       * in the authoritative audit log.
       */

      transaction.create(
        auditRef,
        {
          id:
            auditRef.id,

          action:
            `TASK_${action.toUpperCase()}`,

          actorUid,

          taskId,

          previousStatus,

          newStatus:
            nextStatus,

          reason:
            cleanReason || null,

          createdAt:
            FieldValue.serverTimestamp(),

          details:
            `An operational task lifecycle transition was performed: ${action}.`,
        }
      );

      return {
        taskId,

        previousStatus,

        status:
          nextStatus,

        performedBy:
          actorUid,

        updatedAt:
          now,
      };
    }
  );
}