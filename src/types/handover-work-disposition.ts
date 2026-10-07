export const HANDOVER_WORK_DISPOSITIONS = {
  CARRY_FORWARD: "carry_forward",
  RESOLVE_BEFORE_TRANSFER: "resolve_before_transfer",
} as const;

export type HandoverWorkDispositionValue =
  (typeof HANDOVER_WORK_DISPOSITIONS)[keyof typeof HANDOVER_WORK_DISPOSITIONS];

export interface HandoverWorkDisposition {
  id: string;
  schema: "handover-task-disposition-v1";
  outgoingShiftId: string;
  handoverDocumentId: string;
  taskId: string;
  disposition: HandoverWorkDispositionValue;
  classifiedBy: string;
  classifierRole: "admin" | "supervisor";
  classifiedAt: string;
  reason: string;
  recordedRevision: number;
  reviewedSnapshotHash: string;
  classifiedTaskWorkHash: string;
}
