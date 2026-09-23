
import "server-only";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  getOperationalCollections,
} from "./collections";

import type {
  AppUser,
} from "@/types/auth";

import type {
  Task,
  TaskAssignment,
} from "@/types/task";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

export interface TaskListItem {
  task: Task;
  assignments: TaskAssignment[];
}

export interface ListTasksResult {
  tasks: TaskListItem[];
  total: number;
}

/**
 * Authoritative, read-only task retrieval.
 *
 * Administrators and supervisors can
 * retrieve operational tasks.
 *
 * Technicians can retrieve only tasks
 * with their own active assignment.
 *
 * Account status and role are checked
 * against Firestore before task data
 * is returned.
 *
 * Permanent revocation remains disabled.
 */
export async function listTasks(
  actor: AppUser
): Promise<ListTasksResult> {
  const db = getAdminFirestore();

  const {
    tasks,
    taskAssignments,
  } = getOperationalCollections();

  /*
   * PHASE 1:
   * Revalidate the acting account.
   */

  const actorSnapshot = await db
    .collection("users")
    .doc(actor.uid)
    .get();

  const profile = actorSnapshot.data();

  if (
    !actorSnapshot.exists ||
    !profile ||
    profile.status !== "active" ||
    profile.statusOperation != null ||
    profile.mustChangePassword === true ||
    profile.role !== actor.role
  ) {
    throw new AssignmentOperationError(
      "Your account is not authorized to retrieve tasks.",
      403
    );
  }

  if (
    ![
      "admin",
      "supervisor",
      "technician",
    ].includes(actor.role)
  ) {
    throw new AssignmentOperationError(
      "You are not authorized to retrieve tasks.",
      403
    );
  }

  /*
   * PHASE 2:
   * Retrieve tasks according to role.
   */

  if (actor.role === "technician") {
    const assignmentSnapshot =
      await taskAssignments
        .where(
          "technicianId",
          "==",
          actor.uid
        )
        .get();

    const activeAssignments =
      assignmentSnapshot.docs
        .map(
          (document) =>
            document.data() as TaskAssignment
        )
        .filter(
          (assignment) =>
            assignment.responsibilityStatus !==
              "released" &&
            assignment.releasedAt == null
        );

    const taskIds = [
      ...new Set(
        activeAssignments.map(
          (assignment) =>
            assignment.taskId
        )
      ),
    ];

    const taskDocuments =
      await Promise.all(
        taskIds.map(
          (taskId) =>
            tasks.doc(taskId).get()
        )
      );

    const results: TaskListItem[] = [];

    for (const taskDocument of taskDocuments) {
      if (!taskDocument.exists) {
        continue;
      }

      const task =
        taskDocument.data() as Task;

      const assignments =
        activeAssignments.filter(
          (assignment) =>
            assignment.taskId ===
            taskDocument.id
        );

      results.push({
        task: {
          ...task,
          id: taskDocument.id,
        },
        assignments,
      });
    }

    results.sort(
      (a, b) =>
        b.task.createdAt.localeCompare(
          a.task.createdAt
        )
    );

    return {
      tasks: results,
      total: results.length,
    };
  }

  /*
   * PHASE 3:
   * Administrator and supervisor
   * task retrieval.
   */

  const taskSnapshot =
    await tasks.get();

  const assignmentSnapshot =
    await taskAssignments.get();

  const allAssignments =
    assignmentSnapshot.docs.map(
      (document) => ({
        ...document.data(),
        id: document.id,
      }) as TaskAssignment
    );

  const results: TaskListItem[] =
    taskSnapshot.docs.map(
      (document) => {
        const task = {
          ...document.data(),
          id: document.id,
        } as Task;

        return {
          task,

          assignments:
            allAssignments.filter(
              (assignment) =>
                assignment.taskId ===
                document.id
            ),
        };
      }
    );

  results.sort(
    (a, b) =>
      b.task.createdAt.localeCompare(
        a.task.createdAt
      )
  );

  return {
    tasks: results,
    total: results.length,
  };
}