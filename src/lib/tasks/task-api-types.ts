import type {
  Task,
  TaskAssignment,
} from "@/types/task";

/*
 * Shared task retrieval types.
 *
 * These types describe the existing
 * authoritative task retrieval API.
 */

export interface TaskListItem {
  task: Task;

  assignments: TaskAssignment[];
}

export interface TaskListResult {
  tasks: TaskListItem[];

  total: number;
}

/*
 * Successful task retrieval response.
 */

export interface TaskListSuccessResponse {
  success: true;

  tasks: TaskListItem[];

  total: number;
}

/*
 * Standard API error response.
 */

export interface TaskApiErrorResponse {
  success: false;

  error: string;
}

/*
 * Task retrieval response.
 */

export type TaskListApiResponse =
  | TaskListSuccessResponse
  | TaskApiErrorResponse;

/*
 * Task creation input.
 *
 * The authenticated actor is determined
 * by the server-side session.
 *
 * createdBy must never be supplied
 * by the frontend.
 */

export interface CreateTaskInput {
  title: string;

  description: string;

  priority: Task["priority"];

  sectionId: string | null;

  shiftId: string | null;
}

/*
 * Successful task creation response.
 */

export interface CreateTaskSuccessResponse {
  success: true;

  message: string;

  task: Task;
}

export type CreateTaskApiResponse =
  | CreateTaskSuccessResponse
  | TaskApiErrorResponse;

/*
 * Task assignment input.
 *
 * The backend determines the actor
 * from the authenticated session.
 */

export interface CreateTaskAssignmentInput {
  technicianUid: string;

  responsibility:
    TaskAssignment["responsibility"];
}

/*
 * Successful assignment response.
 */

export interface CreateTaskAssignmentSuccessResponse {
  success: true;

  message: string;

  assignment: TaskAssignment;
}

export type CreateTaskAssignmentApiResponse =
  | CreateTaskAssignmentSuccessResponse
  | TaskApiErrorResponse;