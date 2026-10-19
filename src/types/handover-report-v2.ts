// Authoritative v2 (equal-technician) handover report contracts. These are
// distinct from the legacy `handover-report-v1` documents and binding: a v2
// binding is only valid against the v2 reservation fingerprint, guard fencing
// epoch, preparation revision, evidence snapshot hash and work snapshot
// version, so a relabeled v1 binding can never validate here.
import type { Attendance } from "./attendance";
import type { HandoverWorkSnapshot } from "./handover";
import type { ShiftOperationsView } from "./shift-operations";
import type {
  EqualAbsenceType,
  EqualHandoverAbsence,
  EqualHandoverPosition,
  EqualHandoverSide,
} from "./equal-technician-handover";

export const EQUAL_HANDOVER_REPORT_V2_SCHEMA = "handover-report-v2" as const;
export const EQUAL_HANDOVER_REPORT_CONTENT_V2_SCHEMA =
  "equal-handover-report-v2" as const;
export const EQUAL_HANDOVER_REPORT_PREPARATION_V2_SCHEMA =
  "equal-handover-report-preparation-v2" as const;

export interface EqualHandoverReportV2Binding {
  schema: typeof EQUAL_HANDOVER_REPORT_V2_SCHEMA;
  /** Immutable frozen report document id: report_v2_<uuid>. */
  id: string;
  /** SHA-256 digest of the canonical v2 report content. */
  digest: string;
  /** SHA-256 over the raw authoritative evidence bundle. */
  evidenceSnapshotHash: string;
  /** Authoritative work snapshot version at freeze time. */
  workSnapshotVersion: string;
  /** Deterministic preparation document id the freeze was reviewed from. */
  preparationId: string;
  preparationRevision: number;
  /** Reservation fingerprint (handover_v2_<hex64>), not the Firestore doc id. */
  reservationId: string;
  /** Aggregate revision the report was reviewed at (pre-freeze). */
  aggregateRevision: number;
  /** Shared guard fencing epoch at freeze time. */
  fencingEpoch: number;
  frozenBy: string;
  frozenAt: string;
}

export interface EqualHandoverReportV2Staff {
  shiftId: string;
  shiftDate: string;
  shiftType: string;
  scheduledStart: string;
  scheduledEnd: string;
  actualStart: string | null;
  engineeringLocation: string | null;
  handoverStartedAt: string | null;
  incomingShiftId: string | null;
}

export interface EqualHandoverReportV2Participant {
  position: EqualHandoverPosition;
  side: EqualHandoverSide;
  uid: string;
  name: string | null;
}

export interface EqualHandoverReportV2SlotLineage {
  outgoingSlotToken: string;
  outgoingGeneration: number;
  successorSlotToken: string;
  successorGeneration: number;
}

export interface EqualHandoverReportV2ReportingEvidence {
  kind: string;
  authenticationMethod: string;
  personallyAuthenticated: boolean;
  eventTime: string | null;
  attestedByUid: string | null;
  lateReason: string | null;
}

export type EqualHandoverPayableHours = "policy_unresolved" | null;

export interface EqualHandoverReportV2AttendanceRow {
  position: EqualHandoverPosition;
  side: EqualHandoverSide;
  uid: string;
  name: string | null;
  clockIn: string | null;
  clockOut: string | null;
  reportingEvidence: EqualHandoverReportV2ReportingEvidence | null;
  /** Legacy v1 shift_attendance record, preserved verbatim where present. */
  legacyAttendance: Attendance | null;
  hoursWorked: number | null;
  payableHours: EqualHandoverPayableHours;
  departureProvenance: "personal" | "colleague_attested" | null;
  absenceDeclared: EqualAbsenceType | null;
}

export interface EqualHandoverReportV2PendingTask {
  id: string;
  title: string;
  priority: string;
  status: string;
  assignments: {
    id: string;
    technicianUid: string;
    responsibility: string;
    acceptance: string;
    responsibilityStatus: string;
  }[];
  disposition: string;
  reason: string | null;
  carryForwardEligible: boolean;
}

export interface EqualHandoverReportV2TerminalTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  updatedAt: string;
  workHash: string;
}

export interface EqualHandoverReportV2Correction {
  id: string;
  note: string;
  recordedBy: string;
  recordedAt: string;
}

export interface EqualHandoverReportV2Content {
  schema: typeof EQUAL_HANDOVER_REPORT_CONTENT_V2_SCHEMA;
  outgoingShiftId: string;
  handoverDocumentId: string;
  reservationId: string;
  staff: EqualHandoverReportV2Staff;
  participants: EqualHandoverReportV2Participant[];
  slotLineage: EqualHandoverReportV2SlotLineage;
  attendance: EqualHandoverReportV2AttendanceRow[];
  operations: ShiftOperationsView;
  pendingTasks: EqualHandoverReportV2PendingTask[];
  terminalTaskEvidence: EqualHandoverReportV2TerminalTask[];
  workSnapshot: HandoverWorkSnapshot;
  absences: EqualHandoverAbsence[];
  completeness: { blockers: string[]; warnings: string[] };
  corrections: EqualHandoverReportV2Correction[];
}

export interface EqualHandoverPreparationRevisionEntry {
  preparationRevision: number;
  contentDigest: string;
  evidenceSnapshotHash: string;
  preparedBy: string;
  preparedAt: string;
  reason: string | null;
}

export interface EqualHandoverReportPreparationV2 {
  schema: typeof EQUAL_HANDOVER_REPORT_PREPARATION_V2_SCHEMA;
  /** preparation_<reservation fingerprint>. */
  id: string;
  outgoingShiftId: string;
  handoverDocumentId: string;
  reservationId: string;
  aggregateRevision: number;
  aggregateSnapshotHash: string;
  guardProtocolOwner: "v2";
  guardRevision: number;
  fencingEpoch: number;
  preparationRevision: number;
  content: EqualHandoverReportV2Content;
  evidenceSnapshotHash: string;
  contentDigest: string;
  workSnapshotVersion: string;
  blockers: string[];
  warnings: string[];
  preparedBy: string;
  createdAt: string;
  updatedAt: string;
  revisionHistory: EqualHandoverPreparationRevisionEntry[];
}

export interface FrozenEqualHandoverReportV2 {
  schema: typeof EQUAL_HANDOVER_REPORT_V2_SCHEMA;
  id: string;
  version: number;
  supersedesReportId: string | null;
  outgoingShiftId: string;
  handoverDocumentId: string;
  reservationId: string;
  digest: string;
  evidenceSnapshotHash: string;
  workSnapshotVersion: string;
  preparationId: string;
  preparationRevision: number;
  aggregateRevision: number;
  aggregateSnapshotHash: string;
  guardRevision: number;
  fencingEpoch: number;
  participants: EqualHandoverReportV2Participant[];
  absences: EqualHandoverAbsence[];
  content: EqualHandoverReportV2Content;
  reason: string;
  correctionNote: string | null;
  frozenBy: string;
  frozenAt: string;
  binding: EqualHandoverReportV2Binding;
}
