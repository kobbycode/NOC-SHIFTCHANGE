
import { createHash } from "node:crypto";

export function getTaskAssignmentId(
  taskId: string,
  technicianUid: string
): string {
  if (
    !taskId ||
    !technicianUid ||
    taskId.includes("/") ||
    technicianUid.includes("/") ||
    taskId.length > 512 ||
    technicianUid.length > 128
  ) {
    throw new Error(
      "Invalid task or technician identifier."
    );
  }

  return `${taskId}_${technicianUid}`;
}

export function resolveTaskAssignmentGeneration(value: unknown): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Invalid assignment generation.");
  }
  return value as number;
}

export function getTaskAssignmentInstanceId(taskId: string, technicianUid: string, generation: number): string {
  const legacy = getTaskAssignmentId(taskId, technicianUid);
  if (generation === undefined) throw new Error("Explicit assignment generation is required.");
  resolveTaskAssignmentGeneration(generation);
  if (generation === 1) return legacy;
  // No underscore: this namespace cannot collide with any legacy pair ID.
  const digest = createHash("sha256").update(JSON.stringify([
    "shiftchange-task-assignment-instance-v1", taskId, technicianUid, generation,
  ]), "utf8").digest("hex");
  return `assignment-${digest}`;
}
