export const HANDOVER_RESERVATION_GUARD_SCHEMA = "handover-reservation-guard-v1" as const;

export const HANDOVER_PROTOCOL_OWNERS = {
  V1: "v1",
  V2: "v2",
} as const;

export type HandoverProtocolOwner =
  (typeof HANDOVER_PROTOCOL_OWNERS)[keyof typeof HANDOVER_PROTOCOL_OWNERS];

export const GUARD_LIFECYCLE_STATES = {
  ACTIVE: "active",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
} as const;

export type GuardLifecycleState =
  (typeof GUARD_LIFECYCLE_STATES)[keyof typeof GUARD_LIFECYCLE_STATES];

export interface HandoverReservationGuard {
  id: string;
  schema: typeof HANDOVER_RESERVATION_GUARD_SCHEMA;
  outgoingShiftId: string;
  protocolOwner: HandoverProtocolOwner;
  ownerHandoverDocumentId: string;
  ownerLifecycleState: GuardLifecycleState;
  guardRevision: number;
  fencingEpoch: number;
  outgoingSlotToken: string;
  outgoingGeneration: number;
  successorSlotToken: string;
  successorGeneration: number;
  reservationId: string;
  reservedIncomingShiftId: string;
  reservedAt: string;
  reservedBy: string;
  retiredSuccessorSlotTokens: string[];
  terminalEvidenceRef?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AcquireGuardInput {
  outgoingShiftId: string;
  protocolOwner: HandoverProtocolOwner;
  ownerHandoverDocumentId: string;
  outgoingSlotToken: string;
  outgoingGeneration: number;
  successorSlotToken: string;
  successorGeneration: number;
  reservationId: string;
  reservedIncomingShiftId: string;
  reservedAt: string;
  reservedBy: string;
}

export interface ReplaceGuardInput {
  outgoingShiftId: string;
  protocolOwner: HandoverProtocolOwner;
  expectedGuardRevision: number;
  expectedFencingEpoch: number;
  outgoingSlotToken: string;
  outgoingGeneration: number;
  successorSlotToken: string;
  successorGeneration: number;
  reservationId: string;
  reservedIncomingShiftId: string;
  recordedAt: string;
  actorUid: string;
}

export interface ReacquireGuardInput extends AcquireGuardInput {
  expectedGuardRevision: number;
  expectedFencingEpoch: number;
}

export interface CancelGuardInput {
  outgoingShiftId: string;
  protocolOwner: HandoverProtocolOwner;
  expectedGuardRevision: number;
  expectedFencingEpoch: number;
  terminalEvidenceRef?: string | null;
  recordedAt: string;
  actorUid: string;
}

export interface CompleteGuardInput {
  outgoingShiftId: string;
  protocolOwner: HandoverProtocolOwner;
  expectedGuardRevision?: number;
  expectedFencingEpoch?: number;
  receiptId: string;
  outgoingSlotToken: string;
  outgoingGeneration: number;
  successorSlotToken: string;
  successorGeneration: number;
  recordedAt: string;
  actorUid: string;
}
