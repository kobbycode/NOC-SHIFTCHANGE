import type { TaskAssignment } from "@/types/task";
import { getTaskAssignmentInstanceId, resolveTaskAssignmentGeneration } from "./assignment-identity";

export class AssignmentGenerationError extends Error {
  constructor() { super("Malformed assignment generation history; administrator review required."); }
}
function fail(): never { throw new AssignmentGenerationError(); }
function identifier(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max &&
    !value.includes("/") && value !== "." && value !== "..";
}
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim(); }

export function assertAssignmentRelease(assignment: Record<string, unknown>): "active" | "released" {
  const status = assignment.responsibilityStatus === undefined ? "active" : assignment.responsibilityStatus;
  if (status === "active") {
    if (Object.hasOwn(assignment, "releaseMode") || assignment.releasedAt != null ||
        assignment.releasedBy != null || assignment.transferredTo != null) fail();
  } else if (status === "released") {
    if (!text(assignment.releasedAt) || !identifier(assignment.releasedBy, 128)) fail();
    if (assignment.releaseMode === "handover_transfer") {
      if (assignment.transferredTo !== null || !Number.isFinite(Date.parse(assignment.releasedAt))) fail();
    } else {
      if ((Object.hasOwn(assignment, "releaseMode") && assignment.releaseMode !== "reassignment") ||
          !identifier(assignment.transferredTo, 128) || assignment.transferredTo === assignment.technicianId) fail();
    }
  } else fail();
  return status;
}

export function assertAssignmentGenerationIdentity(documentId: string, value: unknown, taskId: string): TaskAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const data = value as Record<string, unknown>;
  if (data.id !== documentId || data.taskId !== taskId || !identifier(data.taskId, 512) ||
      !identifier(data.technicianId, 128)) fail();
  try {
    if (Object.hasOwn(data, "generation") && data.generation === undefined) fail();
    const generation = resolveTaskAssignmentGeneration(data.generation);
    if (documentId !== getTaskAssignmentInstanceId(taskId, data.technicianId, generation)) fail();
  } catch { fail(); }
  return data as unknown as TaskAssignment;
}

export function assertAssignmentAcceptance(data: Record<string, unknown>): void {
  if (!["lead", "support"].includes(data.responsibility as string) || !text(data.assignedAt)) fail();
  if (data.acceptanceStatus === "pending") {
    if (data.acceptedAt !== null || data.rejectedAt !== null || data.rejectionReason !== null) fail();
  } else if (data.acceptanceStatus === "accepted") {
    if (!text(data.acceptedAt) || data.rejectedAt !== null || data.rejectionReason !== null) fail();
  } else if (data.acceptanceStatus === "rejected") {
    if (data.acceptedAt !== null || !text(data.rejectedAt) || !text(data.rejectionReason)) fail();
  } else fail();
}

export function validateTaskAssignmentHistory(taskId: string, documents: readonly { id: string; data: unknown }[]): TaskAssignment[] {
  const generations = new Set<string>(), active = new Set<string>();
  return documents.map(document => {
    const assignment = assertAssignmentGenerationIdentity(document.id, document.data, taskId);
    const data = assignment as unknown as Record<string, unknown>;
    assertAssignmentAcceptance(data);
    const status = assertAssignmentRelease(data);
    const key = JSON.stringify([assignment.technicianId, resolveTaskAssignmentGeneration(assignment.generation)]);
    if (generations.has(key) || (status === "active" && active.has(assignment.technicianId))) fail();
    generations.add(key);
    if (status === "active") active.add(assignment.technicianId);
    return structuredClone(assignment);
  });
}

export function nextTaskAssignmentGeneration(history: readonly TaskAssignment[], technicianUid: string): number {
  let maximum = 0;
  for (const assignment of history) if (assignment.technicianId === technicianUid) {
    if (assertAssignmentRelease(assignment as unknown as Record<string, unknown>) === "active") fail();
    maximum = Math.max(maximum, resolveTaskAssignmentGeneration(assignment.generation));
  }
  if (maximum === Number.MAX_SAFE_INTEGER) fail();
  return maximum + 1;
}

// Pure patch foundation only. A future atomic handover transaction owns writes.
export function createHandoverAssignmentRelease(assignment: TaskAssignment, releasedAt: string, releasedBy: string) {
  validateTaskAssignmentHistory(assignment.taskId, [{ id: assignment.id, data: assignment }]);
  if (assertAssignmentRelease(assignment as unknown as Record<string, unknown>) !== "active" ||
      !text(releasedAt) || !Number.isFinite(Date.parse(releasedAt)) ||
      new Date(releasedAt).toISOString() !== releasedAt || !identifier(releasedBy, 128)) fail();
  return { responsibilityStatus: "released" as const, releaseMode: "handover_transfer" as const,
    releasedAt, releasedBy, transferredTo: null };
}
