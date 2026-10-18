import type { HandoverReportBinding } from "./handover-report";

export const EQUAL_HANDOVER_POSITIONS = {
  OUTGOING_TECH_A: "outgoing_tech_a",
  OUTGOING_TECH_B: "outgoing_tech_b",
  INCOMING_TECH_A: "incoming_tech_a",
  INCOMING_TECH_B: "incoming_tech_b",
} as const;

export type EqualHandoverPosition =
  (typeof EQUAL_HANDOVER_POSITIONS)[keyof typeof EQUAL_HANDOVER_POSITIONS];

export const EQUAL_HANDOVER_SIDES = {
  OUTGOING: "outgoing",
  INCOMING: "incoming",
} as const;

export type EqualHandoverSide =
  (typeof EQUAL_HANDOVER_SIDES)[keyof typeof EQUAL_HANDOVER_SIDES];

export const EQUAL_HANDOVER_PARTICIPANT_STATES = {
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  CONFIRMED: "confirmed",
  ABSENT: "absent",
} as const;

export type EqualHandoverParticipantState =
  (typeof EQUAL_HANDOVER_PARTICIPANT_STATES)[keyof typeof EQUAL_HANDOVER_PARTICIPANT_STATES];

export const EQUAL_HANDOVER_LIFECYCLE_STATUSES = {
  COLLECTING_CONFIRMATIONS: "collecting_confirmations",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  SUPERSEDED: "superseded",
} as const;

export type EqualHandoverLifecycleStatus =
  (typeof EQUAL_HANDOVER_LIFECYCLE_STATUSES)[keyof typeof EQUAL_HANDOVER_LIFECYCLE_STATUSES];

export const EQUAL_ABSENCE_TYPES = {
  NOT_YET_IN: "not_yet_in",
  ABSENT_LEFT_OFFICE: "absent_left_office",
} as const;

export type EqualAbsenceType =
  (typeof EQUAL_ABSENCE_TYPES)[keyof typeof EQUAL_ABSENCE_TYPES];

export interface EqualHandoverIdentity {
  schema: "equal-handover-v2";
  outgoingShiftId: string;
  outgoingPermanentPairId: string;
  outgoingTechnicianIds: [string, string];
  outgoingSlotToken: string;
  outgoingGeneration: number;
  incomingShiftId: string;
  incomingPermanentPairId: string;
  incomingTechnicianIds: [string, string];
  successorSlotToken: string;
  successorGeneration: number;
  shiftType: "morning" | "night";
  scheduledStart: string;
  scheduledEnd: string;
}

export interface EqualHandoverReservation {
  handoverId: string;
  reservedIncomingShiftId: string;
  outgoingShiftId: string;
  incomingPermanentPairId: string;
  incomingTechnicianIds: [string, string];
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

export interface EqualHandoverConfirmation {
  position: EqualHandoverPosition;
  technicianUid: string;
  revision: number;
  reportBinding: HandoverReportBinding;
  snapshotHash: string;
  confirmedAt: string;
}

export interface EqualHandoverHistoricalConfirmation extends EqualHandoverConfirmation {
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface EqualHandoverAbsence {
  position: EqualHandoverPosition;
  technicianUid: string;
  absenceType: EqualAbsenceType;
  reportedDepartureTime?: string | null;
  recordedBy: string;
  attestedByUid?: string | null;
  reason: string;
  recordedRevision: number;
  revision: number;
  recordedAt: string;
}

export interface EqualHandoverSnapshot {
  schema: "equal-handover-v2";
  identity: EqualHandoverIdentity;
  reservation: EqualHandoverReservation;
  reportBinding: HandoverReportBinding | null;
  absences: EqualHandoverAbsence[];
  revision: number;
  snapshotHash: string;
}

export interface EqualHandoverParticipant {
  position: EqualHandoverPosition;
  side: EqualHandoverSide;
  technicianUid: string;
  state: EqualHandoverParticipantState;
  confirmation?: EqualHandoverConfirmation;
  absence?: EqualHandoverAbsence;
}

export interface EqualHandoverAggregate {
  schema: "equal-handover-v2";
  identity: EqualHandoverIdentity;
  reservation: EqualHandoverReservation;
  reportBinding: HandoverReportBinding | null;
  confirmations: EqualHandoverConfirmation[];
  historicalConfirmations: EqualHandoverHistoricalConfirmation[];
  absences: EqualHandoverAbsence[];
  retiredSuccessorSlotTokens: string[];
  revision: number;
  lifecycleStatus: EqualHandoverLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

// Attendance domain contracts for V2
export const ATTENDANCE_CLOCK_OUT_PROVENANCE = {
  PERSONAL: "personal",
  COLLEAGUE_ATTESTED: "colleague_attested",
} as const;

export type AttendanceClockOutProvenance =
  (typeof ATTENDANCE_CLOCK_OUT_PROVENANCE)[keyof typeof ATTENDANCE_CLOCK_OUT_PROVENANCE];

export const UNRESOLVED_POLICY = "policy_unresolved" as const;
export type UnresolvedPolicy = typeof UNRESOLVED_POLICY;

export interface IncomingClockInEvaluation {
  technicianUid: string;
  clockInTimestamp: string;
  firstConfirmedAt: string;
  isLate: boolean;
  latenessMinutes: number;
  lateReasonRequired: boolean;
  lateReason?: string | null;
}

export interface LateIncomingAcceptanceEvaluation {
  technicianUid: string;
  acceptedAt: string;
  clockInTimestamp: string;
  isLate: true;
  latenessMinutes: number;
  lateReasonRequired: true;
  lateReason: string;
}

export interface OutgoingDepartureEvaluation {
  technicianUid: string;
  departureTimestamp: string;
  provenance: AttendanceClockOutProvenance;
  attestedByUid: string | null;
  reason: string | null;
}

export interface EqualHandoverAttendanceContract {
  incomingClockIns: Record<string, IncomingClockInEvaluation>;
  outgoingDepartures: Record<string, OutgoingDepartureEvaluation>;
  payableHoursEvaluation: UnresolvedPolicy;
  attendanceCorrectionAuthority: UnresolvedPolicy;
}
