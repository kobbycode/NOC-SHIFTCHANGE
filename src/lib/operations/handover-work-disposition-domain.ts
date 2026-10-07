import { createHash } from "node:crypto";
import type { HandoverWorkDisposition, HandoverWorkDispositionValue } from "@/types/handover-work-disposition";
import { HandoverDomainError, createHandoverDocumentId } from "./handover-domain";

export function canonicalHandoverWork(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalHandoverWork).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const data = value as Record<string, unknown>;
    return `{${Object.keys(data).sort().map((key) => `${JSON.stringify(key)}:${canonicalHandoverWork(data[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function hashHandoverWork(value: unknown): string {
  return createHash("sha256").update(canonicalHandoverWork(value), "utf8").digest("hex");
}
function fail(): never { throw new HandoverDomainError("Malformed authoritative handover disposition; administrator review required."); }
export function assertDispositionIdentifier(value: unknown, max = 512): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > max ||
      value.includes("/") || value === "." || value === "..") fail();
}
export function assertDispositionReason(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 10 || value.length > 1000) fail();
}
export function createHandoverWorkDispositionDocumentId(input: {
  outgoingShiftId: string; handoverDocumentId: string; taskId: string;
}): string {
  assertDispositionIdentifier(input.outgoingShiftId);
  assertDispositionIdentifier(input.taskId);
  if (input.handoverDocumentId !== createHandoverDocumentId(input.outgoingShiftId)) fail();
  return `disposition_${hashHandoverWork({ schema: "handover-task-disposition-v1",
    outgoingShiftId: input.outgoingShiftId, handoverDocumentId: input.handoverDocumentId, taskId: input.taskId })}`;
}
const fields = ["id", "schema", "outgoingShiftId", "handoverDocumentId", "taskId", "disposition",
  "classifiedBy", "classifierRole", "classifiedAt", "reason", "recordedRevision", "reviewedSnapshotHash", "classifiedTaskWorkHash"];
export function assertHandoverWorkDisposition(value: unknown): HandoverWorkDisposition {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(data, key)) ||
      data.schema !== "handover-task-disposition-v1" ||
      !["carry_forward", "resolve_before_transfer"].includes(data.disposition as string) ||
      !["admin", "supervisor"].includes(data.classifierRole as string)) fail();
  const record = data as unknown as HandoverWorkDisposition;
  if (record.id !== createHandoverWorkDispositionDocumentId(record)) fail();
  assertDispositionIdentifier(record.classifiedBy, 128);
  assertDispositionReason(record.reason);
  if (typeof record.classifiedAt !== "string" || !Number.isFinite(Date.parse(record.classifiedAt)) ||
      new Date(record.classifiedAt).toISOString() !== record.classifiedAt ||
      !Number.isSafeInteger(record.recordedRevision) || record.recordedRevision < 1 ||
      ![record.reviewedSnapshotHash, record.classifiedTaskWorkHash].every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) fail();
  return structuredClone(record);
}

export function classifyHandoverWork(previous: HandoverWorkDisposition | null, input: Omit<HandoverWorkDisposition, "id" | "schema">): {
  record: HandoverWorkDisposition; changed: boolean;
} {
  const record = assertHandoverWorkDisposition({ ...input, schema: "handover-task-disposition-v1",
    id: createHandoverWorkDispositionDocumentId(input) });
  const old = previous === null ? null : assertHandoverWorkDisposition(previous);
  if (old && old.id !== record.id) fail();
  if (old && old.disposition === record.disposition && old.reason === record.reason &&
      old.classifiedBy === record.classifiedBy && old.classifierRole === record.classifierRole &&
      old.classifiedTaskWorkHash === record.classifiedTaskWorkHash) return { record: old, changed: false };
  return { record, changed: true };
}
export function clearHandoverWorkDisposition(previous: HandoverWorkDisposition | null, reason: string): {
  previous: HandoverWorkDisposition | null; changed: boolean;
} {
  assertDispositionReason(reason);
  return { previous: previous === null ? null : assertHandoverWorkDisposition(previous), changed: previous !== null };
}
export function assertHandoverWorkDispositionValue(value: unknown): asserts value is HandoverWorkDispositionValue {
  if (value !== "carry_forward" && value !== "resolve_before_transfer") fail();
}
