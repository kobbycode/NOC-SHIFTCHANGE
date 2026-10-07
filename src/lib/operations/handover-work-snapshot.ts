import { assertHandoverWorkDisposition, hashHandoverWork } from "./handover-work-disposition-domain";
import type { HandoverWorkDisposition } from "@/types/handover-work-disposition";
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
function projectWork(input: {
  outgoingShiftId: string;
  tasks: readonly unknown[];
  assignments: readonly unknown[];
}) {
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
  return { outgoingShiftId: input.outgoingShiftId, tasks: tasks.sort(byId), assignments: assignments.sort(byId), taskIds };
}

export interface HandoverWorkInput {
  outgoingShiftId: string;
  tasks: readonly unknown[];
  assignments: readonly unknown[];
  dispositions?: readonly unknown[];
}

function dispositionState(input: HandoverWorkInput) {
  const projected = projectWork(input);
  if (input.dispositions !== undefined && !Array.isArray(input.dispositions)) fail();
  const records = new Map<string, HandoverWorkDisposition>();
  for (const value of input.dispositions ?? []) {
    const record = assertHandoverWorkDisposition(value);
    if (record.outgoingShiftId !== input.outgoingShiftId || !projected.taskIds.has(record.taskId) || records.has(record.taskId)) fail();
    records.set(record.taskId, record);
  }
  const tasks = projected.tasks.map((task) => {
    const assignments = projected.assignments.filter((assignment) => assignment.taskId === task.id);
    const taskWorkHash = hashHandoverWork({ schema: "handover-task-work-v1", outgoingShiftId: input.outgoingShiftId, task, assignments });
    const record = records.get(task.id as string);
    // Original reviewed hash/revision are persisted and audited, but excluded
    // from confirmation-visible content. Neither depends on the new snapshot.
    // Never refresh a stale binding: manager reclassification is required.
    const disposition = record ? {
      state: record.classifiedTaskWorkHash === taskWorkHash ? "current" : "stale",
      id: record.id, schema: record.schema, outgoingShiftId: record.outgoingShiftId,
      handoverDocumentId: record.handoverDocumentId, taskId: record.taskId,
      disposition: record.disposition, reason: record.reason, classifiedBy: record.classifiedBy,
      classifierRole: record.classifierRole, classifiedAt: record.classifiedAt,
      classifiedTaskWorkHash: record.classifiedTaskWorkHash,
    } : null;
    return { task, assignments, taskWorkHash, disposition };
  });
  return { projected, tasks };
}

export function createHandoverTaskWorkHash(input: HandoverWorkInput & { taskId: string }): string {
  const state = dispositionState({ ...input, dispositions: [] });
  const task = state.tasks.find((entry) => entry.task.id === input.taskId);
  if (!task) fail();
  return task.taskWorkHash;
}

export function createHandoverWorkSnapshot(input: HandoverWorkInput): HandoverWorkSnapshot {
  const { tasks } = dispositionState(input);
  return { schema: "handover-work-v2", id: input.outgoingShiftId,
    version: hashHandoverWork({ schema: "handover-work-v2", outgoingShiftId: input.outgoingShiftId,
      tasks: tasks.map(({ task, assignments, disposition }) => ({ task, assignments, disposition })) }) };
}

export function resolveHandoverWorkReadiness(input: HandoverWorkInput) {
  const { tasks } = dispositionState(input);
  const workSnapshot = createHandoverWorkSnapshot(input);
  const blockers = tasks.flatMap(({ task, disposition }) => {
    const reason = disposition === null ? "unclassified" : disposition.state === "stale" ? "stale_disposition" :
      disposition.disposition === "resolve_before_transfer" ? "resolve_before_transfer" : null;
    return reason ? [{ taskId: task.id as string, reason }] : [];
  });
  return { ready: blockers.length === 0, blockers, workSnapshot };
}

// Work readiness only. Permanent-participant readiness remains a separate gate.
export function assertFormalTransferWorkReady(input: HandoverWorkInput, expected: HandoverWorkSnapshot) {
  const result = resolveHandoverWorkReadiness(input);
  if (expected.schema !== "handover-work-v2" || expected.id !== result.workSnapshot.id ||
      expected.version !== result.workSnapshot.version) throw new HandoverDomainError("Review the current v2 handover work snapshot.");
  if (!result.ready) throw new HandoverDomainError("Unfinished handover work is not ready for transfer.");
  return result;
}
