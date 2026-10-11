import { createHash } from "node:crypto";
import type { HandoverAggregate } from "@/types/handover";
import type { FormalHandoverTransferPlan, FormalHandoverTransferReceipt } from "@/types/handover-transfer";
import { createHandoverDocumentId, createHandoverSnapshot, resolveHandoverParticipants } from "./handover-domain";
import { canonicalHandoverWork, hashHandoverWork } from "./handover-work-disposition-domain";
import { assertOperationalShiftControl, transferOperationalShiftControl } from "./operational-shift-control-state";

export const MAX_PLANNED_TRANSFER_WRITES = 450;
export const MAX_HANDOVER_TASK_TRANSFER_DOCUMENT_BYTES = 786432;
export const MAX_ESTIMATED_TRANSFER_DOCUMENT_WRITE_BYTES = 6291456;

export class HandoverTransferError extends Error {
  constructor(message: string, public readonly status = 409, public readonly code = "TRANSFER_CONFLICT") {
    super(message); this.name = "HandoverTransferError";
  }
}
function conflict(message: string): never { throw new HandoverTransferError(message); }
export function ordinalCompare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function digest(values: string[]) { return createHash("sha256").update(canonicalHandoverWork(values)).digest("hex"); }
function stableId(value: string) {
  if (typeof value !== "string" || !value.startsWith("handover_") || createHandoverDocumentId(value.slice(9)) !== value) conflict("Invalid stable handover identity.");
}
export function createHandoverTaskTransferDocumentId(handoverDocumentId: string, taskId: string) {
  stableId(handoverDocumentId);
  if (typeof taskId !== "string" || !taskId || taskId.trim() !== taskId || taskId.length > 512 || taskId.includes("/") ||
      taskId === "." || taskId === "..") conflict("Invalid task transfer identity.");
  return `transfer_${digest(["handover-task-transfer-v1", handoverDocumentId, taskId])}`;
}
export function createFormalHandoverTransferReceiptId(handoverDocumentId: string) {
  stableId(handoverDocumentId);
  return `handover-transfer-${digest(["formal-handover-transfer-v1", handoverDocumentId])}`;
}

export function createFormalHandoverTransferReceipt(value: Omit<FormalHandoverTransferReceipt, "receiptHash">): FormalHandoverTransferReceipt {
  return { ...value, receiptHash: hashHandoverWork(value) };
}

export function assertIncomingHandoverActivation(value: HandoverAggregate): string[] {
  const confirmed = resolveHandoverParticipants(value).filter(p => p.side === "incoming" && p.state === "confirmed")
    .map(p => p.technicianUid).sort(ordinalCompare);
  if (confirmed.length === 0) conflict("At least one reserved incoming permanent technician must self-confirm before transfer.");
  return confirmed;
}

// Conservative persisted-document estimate: includes UTF-8 names, document path,
// per-value framing and map/array overhead. This is not the Firestore wire size.
// A server timestamp transform occupies a timestamp in the persisted document.
export function estimateTransferDocumentBytes(path: string, value: unknown): number {
  const utf8 = (text: string) => Buffer.byteLength(text, "utf8") + 1;
  const seen = new Set<object>();
  function size(value: unknown): number {
    if (value === null) return 8;
    if (typeof value === "string") return utf8(value) + 16;
    if (typeof value === "boolean") return 8;
    if (typeof value === "number" && Number.isFinite(value)) return 16;
    if (!value || typeof value !== "object" || seen.has(value)) conflict("Unsupported value in transfer evidence.");
    const object = value as Record<string, unknown>;
    if (value instanceof Date) { if (!Number.isFinite(value.getTime())) conflict("Invalid transfer timestamp."); return 24; }
    const prototype = Object.getPrototypeOf(value);
    const plainObject = prototype === null || (prototype?.constructor?.name === "Object" && Object.getPrototypeOf(prototype) === null);
    if (!plainObject && !Array.isArray(value)) {
      // Admin SDK Timestamp and serverTimestamp sentinels only. Never invoke
      // arbitrary toJSON or accept other transforms as persisted evidence.
      if (prototype?.constructor?.name === "Timestamp" && Number.isSafeInteger(object.seconds) &&
          Number.isInteger(object.nanoseconds) && Number(object.nanoseconds) >= 0 && Number(object.nanoseconds) < 1e9) return 24;
      if (prototype?.constructor?.name === "ServerTimestampTransform" && Object.keys(object).length === 0) return 24;
      conflict("Unsupported value in transfer evidence.");
    }
    seen.add(value);
    let result = 32;
    if (Array.isArray(value)) {
      if (value.some(Array.isArray)) conflict("Nested arrays cannot be persisted in transfer evidence.");
      for (const item of value) result += 8 + size(item);
    } else for (const [key, item] of Object.entries(object)) result += utf8(key) + 16 + size(item);
    seen.delete(value);
    return result;
  }
  return utf8(path) + 128 + size(value);
}

export function assertFormalHandoverTransferCapacity(plan: FormalHandoverTransferPlan) {
  const paths = new Set<string>(); let total = 0;
  for (const write of plan.writes) {
    if (paths.has(write.path)) conflict("Transfer writes must be consolidated by document.");
    paths.add(write.path);
    const bytes = estimateTransferDocumentBytes(write.path, write.document);
    total += bytes;
    if (write.path.startsWith("handover_task_transfers/") && bytes > MAX_HANDOVER_TASK_TRANSFER_DOCUMENT_BYTES) capacity();
  }
  if (paths.size > MAX_PLANNED_TRANSFER_WRITES || total > MAX_ESTIMATED_TRANSFER_DOCUMENT_WRITE_BYTES) capacity();
  return { plannedWrites: paths.size, estimatedDocumentWriteBytes: total };
}
function capacity(): never {
  throw new HandoverTransferError("Transfer exceeds the safe transaction capacity. Resolve outgoing work before retrying, or request administrator review.",
    409, "TRANSFER_CAPACITY_EXCEEDED");
}

export function assertFormalHandoverTransferReceipt(value: unknown, aggregate: HandoverAggregate,
  handoverDocumentId: string): FormalHandoverTransferReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) conflict("Missing transfer receipt; administrator review required.");
  const receipt = value as FormalHandoverTransferReceipt;
  const identity = aggregate.identity;
  const fields = ["id", "schema", "action", "outcome", "receiptHash", "handoverDocumentId", "outgoingShiftId", "incomingShiftId", "finalRevision", "finalSnapshotHash",
    "actorUid", "actorRole", "transferredAt", "reservation", "incomingAttendanceTechnicianIds", "taskTransferIds", "releasedAssignmentIds",
    "operationalControlBefore", "operationalControlAfter"];
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
      aggregate.lifecycleStatus !== "completed" || receipt.schema !== "formal-handover-transfer-v1" ||
      receipt.action !== "SHIFT_HANDOVER_TRANSFERRED" || receipt.outcome !== "TRANSFERRED" || receipt.id !== createFormalHandoverTransferReceiptId(handoverDocumentId) ||
      receipt.handoverDocumentId !== handoverDocumentId || receipt.outgoingShiftId !== identity.outgoingShiftId ||
      receipt.incomingShiftId !== identity.incomingShiftId || receipt.finalRevision !== aggregate.revision ||
      receipt.finalSnapshotHash !== createHandoverSnapshot(aggregate).snapshotHash || receipt.transferredAt !== aggregate.updatedAt ||
      typeof receipt.actorUid !== "string" || !receipt.actorUid.trim() || receipt.actorUid.trim() !== receipt.actorUid || receipt.actorUid.includes("/") || receipt.actorUid.length > 128 ||
      !["admin", "supervisor"].includes(receipt.actorRole) ||
      canonicalHandoverWork(receipt.reservation) !== canonicalHandoverWork(aggregate.reservation)) conflict("Inconsistent transfer receipt; administrator review required.");
  const { receiptHash, ...content } = receipt;
  if (receiptHash !== hashHandoverWork(content)) conflict("Corrupt transfer receipt; administrator review required.");
  for (const array of [receipt.taskTransferIds, receipt.releasedAssignmentIds, receipt.incomingAttendanceTechnicianIds]) {
    if (!Array.isArray(array) || array.some(id => typeof id !== "string" || !id || id.includes("/")) ||
        new Set(array).size !== array.length || array.some((id, i) => i > 0 && ordinalCompare(array[i - 1], id) >= 0)) conflict("Invalid transfer receipt references.");
  }
  if (receipt.taskTransferIds.some(id => !/^transfer_[0-9a-f]{64}$/.test(id)) ||
      canonicalHandoverWork(receipt.incomingAttendanceTechnicianIds) !== canonicalHandoverWork(assertIncomingHandoverActivation(aggregate))) conflict("Invalid receipt attendance binding.");
  try {
    const before = assertOperationalShiftControl(receipt.operationalControlBefore);
    const after = transferOperationalShiftControl({ currentControl: before, outgoingShiftId: identity.outgoingShiftId,
      outgoingSlotToken: identity.outgoingSlotToken, outgoingGeneration: identity.outgoingGeneration,
      incomingShiftId: identity.incomingShiftId, successorSlotToken: identity.successorSlotToken,
      successorGeneration: identity.successorGeneration, transferTimestamp: receipt.transferredAt });
    if (canonicalHandoverWork(after) !== canonicalHandoverWork(receipt.operationalControlAfter)) conflict("Invalid transfer receipt control binding.");
  } catch { conflict("Invalid transfer receipt control binding."); }
  estimateTransferDocumentBytes(`audit_logs/${receipt.id}`, receipt);
  return receipt;
}
