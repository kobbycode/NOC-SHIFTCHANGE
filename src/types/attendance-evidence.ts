// Dedicated v2 attendance evidence contracts. These documents are separate
// from legacy `shift_attendance` records; v2 evidence must never be written
// into the legacy collection (the v1 completion validator requires
// `clockIn === null && clockOut === null` on legacy documents).

export const ATTENDANCE_EVIDENCE_SCHEMA =
  "attendance-evidence-v2" as const;

export const ATTENDANCE_EVIDENCE_KINDS = {
  INCOMING_CLOCK_IN: "incoming_clock_in",
  INCOMING_LATE_ACCEPTANCE: "incoming_late_acceptance",
  OUTGOING_PERSONAL_CLOCK_OUT: "outgoing_personal_clock_out",
  OUTGOING_ABSENT_DEPARTURE_ATTESTATION:
    "outgoing_absent_departure_attestation",
} as const;

export type AttendanceEvidenceKind =
  (typeof ATTENDANCE_EVIDENCE_KINDS)[keyof typeof ATTENDANCE_EVIDENCE_KINDS];

// Only the first two kinds establish a clock-in. A login, a page open, a
// shift reservation, report preparation and a report freeze establish
// nothing; only a trusted personal confirmation/acceptance coordinator may
// finalize those events.
export const ATTENDANCE_CLOCK_IN_EVIDENCE_KINDS: readonly AttendanceEvidenceKind[] = [
  ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
  ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE,
];

export const ATTENDANCE_AUTHENTICATION_METHODS = {
  PERSONAL_PASSWORD_CONFIRMATION: "personal_password_confirmation",
  PERSONAL_PASSWORD_ACCEPTANCE: "personal_password_acceptance",
  SERVER_ISSUED_PERSONAL_CLOCK_OUT: "server_issued_personal_clock_out",
  COLLEAGUE_ATTESTATION: "colleague_attestation",
} as const;

export type AttendanceAuthenticationMethod =
  (typeof ATTENDANCE_AUTHENTICATION_METHODS)[keyof typeof ATTENDANCE_AUTHENTICATION_METHODS];

// A colleague attestation is verified authentication of the reporting
// colleague, never of the absent technician. It can never establish a
// personal clock-in or overwrite a personal clock-out.
export const ATTENDANCE_PERSONALLY_AUTHENTICATED_METHODS: readonly AttendanceAuthenticationMethod[] = [
  ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_CONFIRMATION,
  ATTENDANCE_AUTHENTICATION_METHODS.PERSONAL_PASSWORD_ACCEPTANCE,
  ATTENDANCE_AUTHENTICATION_METHODS.SERVER_ISSUED_PERSONAL_CLOCK_OUT,
];

export const ATTENDANCE_OPERATION_STATUSES = {
  PENDING: "pending",
  FINALIZED: "finalized",
  ABORTED: "aborted",
} as const;

export type AttendanceOperationStatus =
  (typeof ATTENDANCE_OPERATION_STATUSES)[keyof typeof ATTENDANCE_OPERATION_STATUSES];

export interface AttendanceTrustedAuthentication {
  verifiedTechnicianUid: string;
  method: AttendanceAuthenticationMethod;
}

export interface AttendanceEvidenceRequest {
  schema: typeof ATTENDANCE_EVIDENCE_SCHEMA;
  handoverId: string;
  handoverDocumentId: string;
  eventId: string;
  position: string;
  technicianUid: string;
  kind: AttendanceEvidenceKind;
  scheduledStart: string;
  scheduledEnd: string;
  reportedDepartureTime: string | null;
  attestedByUid: string | null;
  attestationReason: string | null;
  lateReason: string | null;
  handoverRevision: number;
  snapshotHash: string;
  expectedGuardRevision: number;
  expectedFencingEpoch: number;
}

export interface AttendanceOperation {
  schema: typeof ATTENDANCE_EVIDENCE_SCHEMA;
  id: string;
  slotId: string;
  status: AttendanceOperationStatus;
  request: AttendanceEvidenceRequest;
  requestDigest: string;
  evidenceId: string;
  interruptedFinalization: boolean;
  requestedAt: string | null;
  finalizedAt: string | null;
  abortedAt: string | null;
  abortReason: string | null;
}

export interface AttendanceEvidence {
  schema: typeof ATTENDANCE_EVIDENCE_SCHEMA;
  id: string;
  slotId: string;
  operationId: string;
  eventId: string;
  handoverId: string;
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  position: string;
  technicianUid: string;
  kind: AttendanceEvidenceKind;
  scheduledStart: string;
  scheduledEnd: string;
  // Server-clock event time. For confirmations this is the authoritative
  // confirmation time; for a late personal acceptance it is the server
  // acceptance time, never the original scheduled start, login time or
  // handover transfer time.
  eventTime: string | null;
  clockIn: string | null;
  clockOut: string | null;
  reportedDepartureTime: string | null;
  attestedByUid: string | null;
  attestationReason: string | null;
  authenticationMethod: AttendanceAuthenticationMethod;
  // True only when the attending technician personally authenticated.
  // Colleague attestations are always false.
  personallyAuthenticated: boolean;
  lateReason: string | null;
  handoverRevision: number;
  snapshotHash: string;
  guardRevision: number;
  fencingEpoch: number;
  finalizedAt: string;
  createdAt: string;
}
