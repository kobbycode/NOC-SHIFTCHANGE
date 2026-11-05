import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
} from "firebase-admin/firestore";
import type {
  AttendanceEvidence,
  AttendanceOperation,
} from "@/types/attendance-evidence";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import { getOperationalCollections } from "./collections";
import { assertHandoverReservationGuard } from "./handover-reservation-guard-domain";
import {
  ALL_ATTENDANCE_EVIDENCE_KINDS,
  assertAttendanceEvidence,
  assertAttendanceOperation,
  attendanceEvidenceId,
  attendanceEvidenceSlotId,
  AttendanceEvidenceDomainError,
} from "./attendance-evidence-domain";

export const ATTENDANCE_EVIDENCE_TIME_FIELDS = [
  "eventTime",
  "clockIn",
  "clockOut",
  "finalizedAt",
  "createdAt",
] as const;

export const ATTENDANCE_OPERATION_TIME_FIELDS = [
  "requestedAt",
  "finalizedAt",
  "abortedAt",
] as const;

const ATTENDANCE_GUARD_TIME_FIELDS = ["createdAt", "updatedAt", "reservedAt"] as const;

export function attendanceEvidenceToIso(value: unknown): string | null {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

export function hydrateAttendanceDocumentFields(
  data: DocumentData,
  fields: readonly string[],
): DocumentData {
  const hydrated: DocumentData = { ...data };
  for (const field of fields) {
    hydrated[field] = attendanceEvidenceToIso(data[field]);
  }
  return hydrated;
}

export function readAttendanceOperationSnapshot(
  snapshot: DocumentSnapshot,
): AttendanceOperation | null {
  if (!snapshot.exists) {
    return null;
  }
  return assertAttendanceOperation(
    hydrateAttendanceDocumentFields(
      snapshot.data() as DocumentData,
      ATTENDANCE_OPERATION_TIME_FIELDS,
    ),
  );
}

export function readAttendanceEvidenceSnapshot(
  snapshot: DocumentSnapshot,
): AttendanceEvidence | null {
  if (!snapshot.exists) {
    return null;
  }
  return assertAttendanceEvidence(
    hydrateAttendanceDocumentFields(
      snapshot.data() as DocumentData,
      ATTENDANCE_EVIDENCE_TIME_FIELDS,
    ),
  );
}

export function readReservationGuardSnapshot(
  snapshot: DocumentSnapshot,
): HandoverReservationGuard | null {
  if (!snapshot.exists) {
    return null;
  }
  return assertHandoverReservationGuard(
    hydrateAttendanceDocumentFields(snapshot.data() as DocumentData, ATTENDANCE_GUARD_TIME_FIELDS),
  );
}

// Firestore keeps unresolved server-timestamp sentinels as null on read.
// eventTime/finalizedAt/createdAt are non-null on every evidence kind by
// domain contract, so a null there means the write is not yet resolvable.
export function attendanceEvidenceTimestampsResolved(data: DocumentData): boolean {
  return (
    attendanceEvidenceToIso(data.eventTime) !== null &&
    attendanceEvidenceToIso(data.finalizedAt) !== null &&
    attendanceEvidenceToIso(data.createdAt) !== null
  );
}

export function toStoredAttendanceTimestamp(value: string | null): unknown {
  return value === null ? null : Timestamp.fromDate(new Date(value));
}

export function persistAttendanceEvidence(evidence: AttendanceEvidence): DocumentData {
  return {
    ...evidence,
    eventTime: toStoredAttendanceTimestamp(evidence.eventTime),
    clockIn: toStoredAttendanceTimestamp(evidence.clockIn),
    clockOut: toStoredAttendanceTimestamp(evidence.clockOut),
    finalizedAt: toStoredAttendanceTimestamp(evidence.finalizedAt),
    createdAt: toStoredAttendanceTimestamp(evidence.createdAt),
  };
}

export function persistAttendanceOperation(operation: AttendanceOperation): DocumentData {
  return {
    ...operation,
    requestedAt: toStoredAttendanceTimestamp(operation.requestedAt),
    finalizedAt: toStoredAttendanceTimestamp(operation.finalizedAt),
    abortedAt: toStoredAttendanceTimestamp(operation.abortedAt),
  };
}

export function outgoingShiftIdFromHandoverDocument(handoverDocumentId: string): string {
  const prefix = "handover_v2_";
  if (!handoverDocumentId.startsWith(prefix) || handoverDocumentId.length === prefix.length) {
    throw new AttendanceEvidenceDomainError(
      "Attendance evidence requires a v2 equal-handover document binding.",
      400,
    );
  }
  return handoverDocumentId.slice(prefix.length);
}

export async function attendanceTransactionalGetAll(
  transaction: { get(ref: DocumentReference): Promise<DocumentSnapshot> },
  refs: DocumentReference[],
): Promise<DocumentSnapshot[]> {
  return Promise.all(refs.map((ref) => transaction.get(ref)));
}

export function attendanceEvidenceOtherKindRefs(
  handoverId: string,
  technicianUid: string,
  kind: string,
): DocumentReference[] {
  const { attendanceEvidenceV2 } = getOperationalCollections();
  return ALL_ATTENDANCE_EVIDENCE_KINDS.filter((item) => item !== kind).map(
    (item) => attendanceEvidenceV2.doc(
      attendanceEvidenceId(attendanceEvidenceSlotId({ handoverId, technicianUid, kind: item })),
    ),
  );
}

// Conflicting evidence for the same technician and handover must fail closed
// and remain auditable: a personal clock-out and a colleague-attested
// departure cannot coexist, and an attested departure may never replace a
// prior personal clock-out.
export function assertNoAttendanceEvidenceCrossKindConflict(
  snapshots: DocumentSnapshot[],
  incomingKind: string,
  technicianUid: string,
): void {
  for (const snapshot of snapshots) {
    if (!snapshot.exists) {
      continue;
    }
    const other = readAttendanceEvidenceSnapshot(snapshot);
    if (other === null || other.technicianUid !== technicianUid) {
      continue;
    }
    const personal = "outgoing_personal_clock_out";
    const attested = "outgoing_absent_departure_attestation";
    const pair = `${incomingKind}|${other.kind}`;
    if (
      pair === `${personal}|${attested}` ||
      pair === `${attested}|${personal}`
    ) {
      throw new AttendanceEvidenceDomainError(
        `Conflicting attendance evidence already exists (${other.kind} for ${other.technicianUid}); fail closed and remain auditable.`,
        409,
      );
    }
  }
}
