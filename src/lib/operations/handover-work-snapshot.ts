import { createHash } from "node:crypto";
import type { HandoverWorkSnapshot } from "@/types/handover";
import { HandoverDomainError } from "./handover-domain";

function fail(): never {
  throw new HandoverDomainError("Malformed authoritative handover work.");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

// Match task-service identifiers; do not normalize authoritative content.
function identifier(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("/")) fail();
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value) fail();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const data = value as Record<string, unknown>;
    return `{${Object.keys(data).sort().map((key) => `${JSON.stringify(key)}:${canonical(data[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Accepts broader authoritative record sets; irrelevant object records are
 * excluded before content validation. Every outgoing task (including terminal
 * tasks) is validated; assignments are validated only for unfinished tasks.
 * Missing scope on an object cannot establish that it belongs to this shift.
 * Non-object records fail closed because their scope cannot be inspected.
 *
 * This digest is reviewed content, not transfer permission or a concurrency
 * lock. It never accepts assignments or mutates tasks. Future persistence must
 * read/derive/persist in one transaction and A7.6/A7.7/A7.8 must recompute there.
 * Current writers prohibit creation/assignment/reassignment/responses during
 * handover_pending; manager lifecycle resolution can still change work. Future
 * writers changing query membership must provide equivalent transactional
 * protection or shared coordination. No such mechanism is implemented here.
 */
export function createHandoverWorkSnapshot(input: {
  outgoingShiftId: string;
  tasks: readonly unknown[];
  assignments: readonly unknown[];
}): HandoverWorkSnapshot {
  // Match the handover domain's exact scope identifier; persistence byte limits
  // are separate from work scope identity.
  identifier(input.outgoingShiftId, 512);
  if (input.outgoingShiftId.trim() !== input.outgoingShiftId ||
      input.outgoingShiftId === "." || input.outgoingShiftId === "..") fail();
  if (!Array.isArray(input.tasks) || !Array.isArray(input.assignments)) fail();
  const taskIds = new Set<string>();
  const includedTaskIds = new Set<string>();
  const tasks: Record<string, unknown>[] = [];
  for (const value of input.tasks) {
    const task = object(value);
    if (task.shiftId !== input.outgoingShiftId) continue;
    identifier(task.id, 512);
    if (taskIds.has(task.id)) fail();
    taskIds.add(task.id);
    if (typeof task.title !== "string" || !task.title.trim() || task.title.length > 200 ||
        typeof task.description !== "string" || task.description.length > 5000 ||
        !["low", "medium", "high", "critical"].includes(task.priority as string) ||
        !["open", "in_progress", "pending_verification", "completed", "cancelled"].includes(task.status as string)) fail();
    if (task.sectionId !== null) identifier(task.sectionId, 128);
    text(task.updatedAt);
    if (!Number.isFinite(Date.parse(task.updatedAt))) fail();
    if (task.status === "completed" || task.status === "cancelled") continue;
    includedTaskIds.add(task.id);
    tasks.push({ id: task.id, shiftId: task.shiftId, title: task.title,
      description: task.description, status: task.status, priority: task.priority,
      sectionId: task.sectionId, updatedAt: task.updatedAt });
  }
  const assignmentIds = new Set<string>();
  const assignments: Record<string, unknown>[] = [];
  for (const value of input.assignments) {
    const assignment = object(value);
    if (!includedTaskIds.has(assignment.taskId as string)) continue;
    identifier(assignment.id, 1500);
    identifier(assignment.technicianId, 128);
    if (assignmentIds.has(assignment.id)) fail();
    assignmentIds.add(assignment.id);
    if (assignment.responsibility !== "lead" && assignment.responsibility !== "support") fail();
    const responsibilityStatus = assignment.responsibilityStatus === undefined
      ? "active" : assignment.responsibilityStatus;
    const releasedAt = assignment.releasedAt === undefined ? null : assignment.releasedAt;
    const releasedBy = assignment.releasedBy === undefined ? null : assignment.releasedBy;
    const transferredTo = assignment.transferredTo === undefined ? null : assignment.transferredTo;
    if (responsibilityStatus === "active") {
      if (releasedAt !== null || releasedBy !== null || transferredTo !== null) fail();
    } else if (responsibilityStatus === "released") {
      text(releasedAt);
      identifier(releasedBy, 128);
      identifier(transferredTo, 128);
      if (transferredTo === assignment.technicianId) fail();
    } else fail();
    text(assignment.assignedAt);
    if (assignment.acceptanceStatus === "pending") {
      if (assignment.acceptedAt !== null || assignment.rejectedAt !== null || assignment.rejectionReason !== null) fail();
    } else if (assignment.acceptanceStatus === "accepted") {
      text(assignment.acceptedAt);
      if (assignment.rejectedAt !== null || assignment.rejectionReason !== null) fail();
    } else if (assignment.acceptanceStatus === "rejected") {
      text(assignment.rejectedAt);
      if (assignment.acceptedAt !== null || typeof assignment.rejectionReason !== "string" || !assignment.rejectionReason.trim()) fail();
    } else fail();
    assignments.push({ id: assignment.id, taskId: assignment.taskId,
      technicianId: assignment.technicianId, responsibility: assignment.responsibility,
      responsibilityStatus, acceptanceStatus: assignment.acceptanceStatus,
      assignedAt: assignment.assignedAt, acceptedAt: assignment.acceptedAt,
      rejectedAt: assignment.rejectedAt, rejectionReason: assignment.rejectionReason,
      releasedAt, releasedBy, transferredTo });
  }
  const byId = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    (a.id as string) < (b.id as string) ? -1 : (a.id as string) > (b.id as string) ? 1 : 0;
  const payload = { schema: "handover-work-v1", outgoingShiftId: input.outgoingShiftId,
    tasks: tasks.sort(byId), assignments: assignments.sort(byId) };
  return { id: input.outgoingShiftId,
    version: createHash("sha256").update(canonical(payload), "utf8").digest("hex") };
}
