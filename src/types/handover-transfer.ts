import type { HandoverWorkSnapshot } from "./handover";
import type { HandoverWorkDisposition } from "./handover-work-disposition";
import type { OperationalShiftControl } from "@/lib/operations/operational-shift-control-state";

export interface HandoverTaskTransferEvidence {
  id: string;
  schema: "handover-task-transfer-v1";
  taskId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  handoverDocumentId: string;
  finalRevision: number;
  finalSnapshotHash: string;
  workSnapshot: HandoverWorkSnapshot;
  taskBeforeTransfer: Record<string, unknown>;
  disposition: HandoverWorkDisposition;
  assignmentEvidence: Record<string, unknown>[];
  releasedAssignmentIds: string[];
  actorUid: string;
  actorRole: "admin" | "supervisor";
  transferredAt: string;
  operationalControlBefore: OperationalShiftControl;
  operationalControlAfter: OperationalShiftControl;
}

export interface FormalHandoverTransferReceipt {
  id: string;
  schema: "formal-handover-transfer-v1";
  action: "SHIFT_HANDOVER_TRANSFERRED";
  outcome: "TRANSFERRED";
  receiptHash: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  finalRevision: number;
  finalSnapshotHash: string;
  actorUid: string;
  actorRole: "admin" | "supervisor";
  transferredAt: string;
  reservation: import("./handover").HandoverReservation;
  incomingAttendanceTechnicianIds: string[];
  taskTransferIds: string[];
  releasedAssignmentIds: string[];
  operationalControlBefore: OperationalShiftControl;
  operationalControlAfter: OperationalShiftControl;
}

export type FormalHandoverTransferResult = {
  status: "TRANSFERRED" | "ALREADY_TRANSFERRED";
  receipt: FormalHandoverTransferReceipt;
} | { status: "REVIEW_REQUIRED"; handover: { revision: number; snapshotHash: string } };

export interface FormalHandoverTransferPlan {
  writes: { path: string; operation: "create" | "update" | "set"; data: Record<string, unknown>;
    // Full post-write value for capacity estimation of partial updates.
    document: Record<string, unknown> }[];
}
