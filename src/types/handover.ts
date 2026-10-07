export const HANDOVER_PARTICIPANT_SIDES = {
  OUTGOING: "outgoing",
  INCOMING: "incoming",
} as const;

export type HandoverParticipantSide =
  (typeof HANDOVER_PARTICIPANT_SIDES)[keyof typeof HANDOVER_PARTICIPANT_SIDES];

export const HANDOVER_PARTICIPANT_POSITIONS = {
  OUTGOING_PRIMARY_A: "outgoing_primary_a",
  OUTGOING_PRIMARY_B: "outgoing_primary_b",
  INCOMING_PRIMARY_A: "incoming_primary_a",
  INCOMING_PRIMARY_B: "incoming_primary_b",
} as const;

export type HandoverParticipantPosition =
  (typeof HANDOVER_PARTICIPANT_POSITIONS)[keyof typeof HANDOVER_PARTICIPANT_POSITIONS];

export const HANDOVER_PARTICIPANT_STATES = {
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  CONFIRMED: "confirmed",
  ABSENT: "absent",
  SUPERVISOR_EXCEPTION: "supervisor_exception",
} as const;

export type HandoverParticipantState =
  (typeof HANDOVER_PARTICIPANT_STATES)[keyof typeof HANDOVER_PARTICIPANT_STATES];

export const HANDOVER_LIFECYCLE_STATUSES = {
  COLLECTING_CONFIRMATIONS: "collecting_confirmations",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  SUPERSEDED: "superseded",
} as const;

export type HandoverLifecycleStatus =
  (typeof HANDOVER_LIFECYCLE_STATUSES)[keyof typeof HANDOVER_LIFECYCLE_STATUSES];

export const SUPERVISOR_EXCEPTION_CATEGORIES = {
  UNAVAILABLE: "unavailable",
  EMERGENCY: "emergency",
  OPERATIONAL_CONSTRAINT: "operational_constraint",
} as const;

export type SupervisorExceptionCategory =
  (typeof SUPERVISOR_EXCEPTION_CATEGORIES)[keyof typeof SUPERVISOR_EXCEPTION_CATEGORIES];

export interface HandoverIdentity {
  outgoingShiftId: string;
  outgoingPermanentPairId: string;
  outgoingPrimaryTechnicianIds: [string, string];
  outgoingSlotToken: string;
  outgoingGeneration: number;
  incomingShiftId: string;
  incomingPermanentPairId: string;
  incomingPrimaryTechnicianIds: [string, string];
  successorSlotToken: string;
  successorGeneration: number;
  shiftType: "morning" | "night";
  scheduledStart: string;
  scheduledEnd: string;
}

export interface HandoverReservation {
  handoverId: string;
  reservedIncomingShiftId: string;
  outgoingShiftId: string;
  incomingPermanentPairId: string;
  incomingPrimaryTechnicianIds: [string, string];
  shiftType: "morning" | "night";
  scheduledStart: string;
  scheduledEnd: string;
  outgoingSlotToken: string;
  outgoingGeneration: number;
  successorSlotToken: string;
  expectedSuccessorGeneration: number;
  revision: number;
  reservedAt: string;
  reservedBy: string;
}

export interface HandoverSnapshot {
  identity: HandoverIdentity;
  reservation: HandoverReservation;
  workSnapshot: HandoverWorkSnapshot;
  temporaryAuthorization: HandoverTemporaryAuthorization | null;
  absences: HandoverAbsence[];
  exceptions: HandoverSupervisorException[];
  revision: number;
  snapshotHash: string;
}

interface HandoverParticipantIdentity {
  position: HandoverParticipantPosition;
  side: HandoverParticipantSide;
  technicianUid: string;
}

// Derived from the aggregate's evidence, never a second mutable source of truth.
export type HandoverParticipant = HandoverParticipantIdentity & (
  | { state: "awaiting_confirmation" }
  | { state: "confirmed"; confirmation: HandoverConfirmation }
  | { state: "absent"; absence: HandoverAbsence }
  | { state: "supervisor_exception"; exception: HandoverSupervisorException }
);

export interface HandoverConfirmation {
  position: HandoverParticipantPosition;
  technicianUid: string;
  revision: number;
  snapshotHash: string;
  confirmedAt: string;
}

export interface HandoverAbsence {
  position: HandoverParticipantPosition;
  technicianUid: string;
  recordedBy: string;
  reason: string;
  // Original audit revision is preserved when a resolution is carried forward.
  recordedRevision: number;
  revision: number;
  recordedAt: string;
}

export interface HandoverSupervisorException {
  position: HandoverParticipantPosition;
  technicianUid: string;
  supervisorUid: string;
  category: SupervisorExceptionCategory;
  reason: string;
  recordedRevision: number;
  revision: number;
  recordedAt: string;
}

export interface HandoverAggregate {
  // Exact retired reservation lineage, not request/idempotency history.
  retiredSuccessorSlotTokens: string[];
  identity: HandoverIdentity;
  reservation: HandoverReservation;
  workSnapshot: HandoverWorkSnapshot;
  temporaryAuthorization: HandoverTemporaryAuthorization | null;
  confirmations: HandoverConfirmation[];
  absences: HandoverAbsence[];
  exceptions: HandoverSupervisorException[];
  revision: number;
  lifecycleStatus: HandoverLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

// Exact outgoing-shift scope and SHA-256 digest of reviewed unfinished work.
// V2 includes disposition evidence; a snapshot does not execute transfer or accept assignments.
export interface HandoverWorkSnapshot {
  // Omission is recognized only on the exact legacy {id, version} shape.
  schema?: "handover-work-v1" | "handover-work-v2";
  id: string;
  version: string;
}

// C remains additional and cannot occupy any permanent participant position.
export interface HandoverTemporaryAuthorization {
  authorizationId: string;
  technicianUid: string;
}

// The service layer must establish this authority and re-check account
// eligibility. This context contains no reusable authentication evidence.
export interface HandoverSupervisorActor {
  uid: string;
  authority: "supervisor" | "manager";
}

export interface TransferOperationalShiftControlInput {
  currentControl: unknown;
  outgoingShiftId: string;
  outgoingSlotToken: string;
  outgoingGeneration: number;
  incomingShiftId: string;
  successorSlotToken: string;
  successorGeneration: number;
  transferTimestamp: string;
}
