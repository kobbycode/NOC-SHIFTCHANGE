
import "server-only";

import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskPriority,
} from "@/types/task";

import {
  SHIFT_STATUSES,
} from "@/types/shift";

import {
  getOperationalCollections,
} from "./collections";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

export interface CreateTaskInput {
  title: string;
  description: string;
  priority: TaskPriority;
  sectionId: string | null;
  shiftId: string | null;
  createdBy: string;
}

function validIdentifier(
  value: unknown,
  maxLength = 128
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !value.includes("/")
  );
}

export async function createTask(
  input: CreateTaskInput
): Promise<Task> {
  const {
    title,
    description,
    priority,
    sectionId,
    shiftId,
    createdBy,
  } = input;

  /*
   * PHASE 1:
   * Validate the task information.
   */

  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 200
  ) {
    throw new AssignmentOperationError(
      "Please provide a valid task title.",
      400
    );
  }

  if (
    typeof description !== "string" ||
    description.length > 5000
  ) {
    throw new AssignmentOperationError(
      "Please provide a valid task description.",
      400
    );
  }

  if (
    !Object.values(
      TASK_PRIORITIES
    ).includes(priority)
  ) {
    throw new AssignmentOperationError(
      "Please select a valid task priority.",
      400
    );
  }

  if (
    !validIdentifier(
      createdBy
    ) ||
    (
      sectionId !== null &&
      !validIdentifier(sectionId)
    ) ||
    (
      shiftId !== null &&
      !validIdentifier(
        shiftId,
        512
      )
    )
  ) {
    throw new AssignmentOperationError(
      "Please provide valid task details.",
      400
    );
  }

  /*
   * PHASE 2:
   * Prepare Firestore references.
   */

  const db =
    getAdminFirestore();

  const {
    tasks,
    shifts,
  } = getOperationalCollections();

  const actorRef = db
    .collection("users")
    .doc(createdBy);

  const taskRef =
    tasks.doc();

  const shiftRef =
    shiftId !== null
      ? shifts.doc(shiftId)
      : null;

  const auditRef = db
    .collection("audit_logs")
    .doc();

  /*
   * PHASE 3:
   * Execute the task creation transaction.
   */

  return db.runTransaction(
    async (
      transaction
    ): Promise<Task> => {
      /*
       * Read all required documents
       * before performing writes.
       */

      const actorSnapshot =
        await transaction.get(
          actorRef
        );

      const shiftSnapshot =
        shiftRef !== null
          ? await transaction.get(
              shiftRef
            )
          : null;

      /*
       * PHASE 4:
       * Verify the acting account.
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
          "Your account is not authorized to create tasks.",
          403
        );
      }

      /*
       * PHASE 5:
       * Validate the selected shift.
       */

      if (shiftRef !== null) {
        if (
          !shiftSnapshot ||
          !shiftSnapshot.exists
        ) {
          throw new AssignmentOperationError(
            "The selected shift was not found.",
            404
          );
        }

        const shift =
          shiftSnapshot.data();

        if (
          !shift ||
          !Object.values(
            SHIFT_STATUSES
          ).includes(shift.status)
        ) {
          throw new AssignmentOperationError(
            "The selected shift has an invalid status.",
            409
          );
        }

        if (
          shift.status ===
          SHIFT_STATUSES.COMPLETED
        ) {
          throw new AssignmentOperationError(
            "New tasks cannot be created for a completed shift.",
            409
          );
        }

        if (
          shift.status ===
          SHIFT_STATUSES.HANDOVER_PENDING
        ) {
          throw new AssignmentOperationError(
            "New tasks cannot be created while shift handover is pending.",
            409
          );
        }
      }

      /*
       * PHASE 6:
       * Prepare the task document.
       */

      const now =
        new Date().toISOString();

      const task: Task = {
        id: taskRef.id,

        title:
          title.trim(),

        description:
          description.trim(),

        priority,

        status:
          TASK_STATUSES.OPEN,

        sectionId,

        shiftId,

        createdBy,

        createdAt: now,

        updatedAt: now,
      };

      /*
       * PHASE 7:
       * All transaction reads are complete.
       *
       * Create the task and audit event
       * atomically.
       */

      transaction.create(
        taskRef,
        task
      );

      transaction.create(
        auditRef,
        {
          id: auditRef.id,

          action:
            "TASK_CREATED",

          actorUid:
            createdBy,

          taskId:
            taskRef.id,

          shiftId,

          createdAt:
            FieldValue.serverTimestamp(),

          details:
            "An operational task was created.",
        }
      );

      return task;
    }
  );
}