import "server-only";

import { createHash } from "node:crypto";
import { FieldValue, type DocumentData, type Transaction } from "firebase-admin/firestore";
import type { Attendance } from "@/types/attendance";
import type { Task, TaskAssignment } from "@/types/task";
import type { Shift } from "@/types/shift";
import type { TechnicianScheduleEntry } from "@/types/technician-schedule";
import type { EqualHandoverAggregate, EqualHandoverAbsence } from "@/types/equal-technician-handover";
import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import type {
  EqualHandoverPreparationRevisionEntry,
  EqualHandoverReportPreparationV2,
  EqualHandoverReportV2AttendanceRow,
  EqualHandoverReportV2Binding,
  EqualHandoverReportV2Content,
  EqualHandoverReportV2ReportingEvidence,
  EqualHandoverReportV2TerminalTask,
  FrozenEqualHandoverReportV2,
} from "@/types/handover-report-v2";
import { AssignmentOperationError } from "./assignment-transaction";
import { getOperationalCollections, GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID } from "./collections";
import { readAttendanceRecord } from "./attendance-read-domain";
import {
  assertAttendanceEvidence,
  attendanceEvidenceCountsAsClockIn,
  computeAttendanceWorkedDuration,
} from "./attendance-evidence-domain";
import { ATTENDANCE_EVIDENCE_KINDS, type AttendanceEvidence } from "@/types/attendance-evidence";
import {
  assertEqualHandoverAggregate,
  createEqualHandoverDocumentId,
  createEqualHandoverSnapshot,
  clearEqualHandoverAbsence,
  completeEqualHandoverTransfer,
  confirmEqualHandoverParticipant,
  getEqualHandoverPositions,
  recordEqualHandoverAbsence,
  resolveEqualHandoverParticipants,
  reviseEqualHandoverReport,
} from "./equal-technician-handover-domain";
import {
  assertCanonicalIsoWrite,
  assertEqualHandoverReportPreparationV2,
  assertEqualHandoverReportV2Content,
  assertFrozenEqualHandoverReportV2,
  buildEqualHandoverReportV2Binding,
  canonicalizeTimestamp,
  createEqualHandoverPreparationDocumentId,
  createEqualHandoverReportV2Id,
  digestEqualHandoverReportV2Content,
  digestHandoverReportEvidence,
  equalHandoverReportV2FreezeMaterial,
  EqualHandoverReportDomainError,
} from "./equal-handover-report-domain";
import { readAuthoritativeHandoverWorkState } from "./formal-handover";
import {
  evaluateEqualHandoverReadiness,
  type EqualHandoverReadiness,
} from "./equal-handover-readiness-domain";
import { assertHandoverReservationGuard } from "./handover-reservation-guard-domain";
import { completeReservationGuard, readReservationGuardState } from "./handover-reservation-guard";
import { estimateTransferDocumentBytes } from "./handover-transfer-domain";
import {
  assertOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
  transferOperationalShiftControl,
} from "./operational-shift-control-state";
import { assertShiftActivationWindow } from "./shift-activation-window";
import { finalizeCurrentShiftMemberships } from "./shift-completion-domain";
import { readActivePermanentPairTechnicianIds } from "./next-shift-authorization-domain";
import { assertNoScheduleConflict, parseShiftTimeRange } from "./shift-overlap";
import { createHandoverWorkSnapshot, resolveHandoverWorkReadiness } from "./handover-work-snapshot";
import { assembleShiftOperations } from "./shift-operations-domain";
import { readOperationStations, readShiftOperationEvents } from "./shift-operations";

export { EqualHandoverReportDomainError };

// ---------------------------------------------------------------------------
// Server-only production writer for equal-technician v2 handover reports.
// V2 report documents live in dedicated `handover_report_preparations_v2` and
// `handover_reports_v2` collections; the legacy v1 report machinery is never
// read or written here, and no v2 binding can validate a v1 report schema.
// Authorization is re-checked against fresh Firestore profiles inside every
// transaction: only an outgoing reserved technician may prepare, declare an
// absence or freeze; incoming technicians are read-only; supervisors cannot
// edit or freeze v2 reports. A request-body actor UID is never consulted.
// ---------------------------------------------------------------------------

const MAX_DOCUMENT_BYTES = 786_432;

function fail(message: string, status = 409): never {
  throw new AssignmentOperationError(message, status);
}

function identifier(value: unknown, max = 512): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > max ||
      value.includes("/") || value === "." || value === "..") fail("Invalid report identifier.", 400);
}

function text(value: unknown, label: string, max = 2_000): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(`Invalid ${label}.`, 400);
  return value.trim();
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.keys(item as Record<string, unknown>).sort().reduce<Record<string, unknown>>(
        (sorted, key) => { sorted[key] = (item as Record<string, unknown>)[key]; return sorted; },
        {},
      );
    }
    return item;
  });
}

function hex64(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`Invalid ${label}.`, 400);
}

/**
 * §6 serialization boundary: any driver-converted timestamp ({seconds,
 * nanoseconds} map, Date or Timestamp instance) is hydrated back to the
 * canonical ISO string before validation or hashing, so a preparation or
 * report document that round-tripped through Firestore cannot silently
 * change digest (the lost TECH-HO-16A `createdAt` regression).
 */
function hydrateTimestamps(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(hydrateTimestamps);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    const seconds = object.seconds;
    const nanoseconds = object.nanoseconds;
    const looksLikeTimestamp = keys.length === 2 && typeof seconds === "number" &&
      typeof nanoseconds === "number" &&
      (typeof (object as { toDate?: unknown }).toDate === "function" ||
       (object.constructor === undefined || object.constructor.name === "Object"));
    if (looksLikeTimestamp) {
      return new Date(seconds * 1000 + Math.floor(nanoseconds / 1_000_000)).toISOString();
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) result[key] = hydrateTimestamps(object[key]);
    return result;
  }
  return value;
}

const positionCompare = (a: { position: string }, b: { position: string }) =>
  (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);
const idCompare = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface LiveReportEvidence {
  content: EqualHandoverReportV2Content;
  contentDigest: string;
  evidenceSnapshotHash: string;
  workSnapshotVersion: string;
}

/**
 * §4/§6/§7: every operational source is read inside the caller's transaction,
 * hydrated once, and reduced deterministically. Missing attendance stays
 * missing, missing incident records are never described as proof of no
 * faults, and terminal task records are captured explicitly so a lifecycle
 * change cannot escape source-change detection.
 */
async function buildLiveReportEvidence(
  transaction: Transaction,
  aggregate: EqualHandoverAggregate,
): Promise<LiveReportEvidence> {
  const { db, shifts, shiftAttendance, attendanceEvidenceV2 } = getOperationalCollections();
  const identity = aggregate.identity;
  const outgoingShiftId = identity.outgoingShiftId;

  const shiftSnapshot = await transaction.get(shifts.doc(outgoingShiftId));
  if (!shiftSnapshot.exists) fail("The outgoing shift was not found.", 404);
  const rawShift = hydrateTimestamps(shiftSnapshot.data()) as
    (Shift & { handoverStartedAt?: string | null; engineeringLocation?: string | null }) | undefined;
  if (!rawShift || rawShift.id !== outgoingShiftId || typeof rawShift.scheduledStart !== "string" ||
      typeof rawShift.scheduledEnd !== "string" || !["scheduled", "active", "handover_pending"].includes(rawShift.status)) {
    fail("Authoritative shift information is unavailable for the v2 report.", 409);
  }
  const scheduledStart = canonicalizeTimestamp(rawShift.scheduledStart, "scheduled start");
  const scheduledEnd = canonicalizeTimestamp(rawShift.scheduledEnd, "scheduled end");
  const actualStart = rawShift.actualStart === null ? null : canonicalizeTimestamp(rawShift.actualStart, "actual start");
  const handoverStartedAt = rawShift.handoverStartedAt === null || rawShift.handoverStartedAt === undefined
    ? null : canonicalizeTimestamp(rawShift.handoverStartedAt, "handover started time");
  if (rawShift.status !== "handover_pending") fail("The outgoing shift is not in handover.", 409);
  const engineeringLocation = typeof rawShift.engineeringLocation === "string" && rawShift.engineeringLocation.trim()
    ? rawShift.engineeringLocation : null;

  const positions = getEqualHandoverPositions(identity);
  const profiles = new Map<string, string | null>();
  for (const item of positions) {
    const profile = (await transaction.get(db.collection("users").doc(item.technicianUid))).data() as
      { fullName?: unknown } | undefined;
    profiles.set(item.technicianUid,
      typeof profile?.fullName === "string" && profile.fullName.trim() ? profile.fullName.trim() : null);
  }

  // Legacy personal attendance (v1 shift_attendance) is preserved verbatim
  // where present; v2 evidence is read only for this exact reservation.
  const legacyAttendance = new Map<string, Attendance | null>();
  for (const item of positions) {
    const document = await transaction.get(shiftAttendance.doc(`${outgoingShiftId}_${item.technicianUid}`));
    legacyAttendance.set(item.technicianUid,
      document.exists ? readAttendanceRecord(document.id, hydrateTimestamps(document.data())) : null);
  }
  const evidenceQuery = await transaction.get(
    attendanceEvidenceV2.where("handoverId", "==", aggregate.reservation.handoverId),
  );
  const evidence: AttendanceEvidence[] = evidenceQuery.docs.map((document) => {
    const record = assertAttendanceEvidence(hydrateTimestamps(document.data()));
    if (record.id !== document.id || record.outgoingShiftId !== outgoingShiftId) {
      fail("Attendance evidence identity is inconsistent; administrator review required.", 409);
    }
    return record;
  }).sort(idCompare);

  const stations = await readOperationStations(transaction);
  const events = (await readShiftOperationEvents(transaction, outgoingShiftId))
    .map((event) => hydrateTimestamps(event) as typeof event)
    .sort(idCompare);
  const operations = assembleShiftOperations(outgoingShiftId, false, stations, events);

  const correctionQuery = await transaction.get(
    db.collection("handover_report_corrections").where("outgoingShiftId", "==", outgoingShiftId),
  );
  const corrections = correctionQuery.docs.map((document) => {
    const data = hydrateTimestamps(document.data()) as Record<string, unknown>;
    if (data.id !== document.id || typeof data.note !== "string" || !data.note.trim() ||
        typeof data.recordedBy !== "string" || !data.recordedBy.trim()) {
      fail("Malformed report correction evidence.", 409);
    }
    return {
      id: document.id,
      note: data.note,
      recordedBy: data.recordedBy,
      recordedAt: canonicalizeTimestamp(data.recordedAt, "correction time"),
    };
  }).sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : idCompare(a, b)));

  const work = await readAuthoritativeHandoverWorkState(transaction, outgoingShiftId);
  const workSnapshot = createHandoverWorkSnapshot(work);
  const readiness = resolveHandoverWorkReadiness(work);
  const taskRecords = (work.tasks as Task[]).map((task) => hydrateTimestamps(task) as Task).sort(idCompare);
  const assignmentRecords = (work.assignments as TaskAssignment[])
    .map((assignment) => hydrateTimestamps(assignment) as TaskAssignment)
    .sort(idCompare);

  const pendingTasks = taskRecords.filter((task) => !["completed", "cancelled"].includes(task.status)).map((task) => {
    const disposition = work.dispositions.find((item) => item.taskId === task.id);
    return {
      id: task.id,
      title: task.title,
      priority: task.priority,
      status: task.status,
      assignments: assignmentRecords.filter((item) => item.taskId === task.id).map((item) => ({
        id: item.id,
        technicianUid: item.technicianId,
        responsibility: item.responsibility,
        acceptance: item.acceptanceStatus,
        responsibilityStatus: item.responsibilityStatus ?? "active",
      })),
      disposition: disposition?.disposition ?? "unclassified",
      reason: disposition?.reason ?? null,
      carryForwardEligible: disposition?.disposition === "carry_forward" &&
        !readiness.blockers.some((item) => item.taskId === task.id),
    };
  });

  const terminalTaskEvidence: EqualHandoverReportV2TerminalTask[] = taskRecords
    .filter((task) => ["completed", "cancelled"].includes(task.status))
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      updatedAt: canonicalizeTimestamp(task.updatedAt, "task updated time"),
      // createHandoverTaskWorkHash deliberately excludes terminal tasks, so
      // terminal evidence gets its own deterministic content hash here.
      workHash: digestHandoverReportEvidence({
        namespace: "equal-handover-terminal-task-work-v1",
        outgoingShiftId,
        task,
        assignments: assignmentRecords.filter((item) => item.taskId === task.id),
      }),
    }));

  // §8: absence declarations come only from the authoritative aggregate.
  const absences = [...aggregate.absences].sort(positionCompare);
  const absenceByPosition = new Map(absences.map((item) => [item.position, item.absenceType]));

  const attendance: EqualHandoverReportV2AttendanceRow[] = positions.map((item) => {
    const legacy = legacyAttendance.get(item.technicianUid) ?? null;
    const own = evidence.filter((record) => record.technicianUid === item.technicianUid);
    const clockInDocs = own.filter((record) => attendanceEvidenceCountsAsClockIn(record));
    const personalClockOutDocs = own.filter(
      (record) => record.kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT && record.clockOut !== null,
    );
    const attestationDocs = own.filter(
      (record) => record.kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_ABSENT_DEPARTURE_ATTESTATION,
    );
    if (clockInDocs.length > 1 || personalClockOutDocs.length > 1 || attestationDocs.length > 1) {
      fail("Conflicting attendance evidence exists for a participant; administrator review required.", 409);
    }
    if (personalClockOutDocs.length === 1 && attestationDocs.length === 1) {
      fail("A colleague attestation contradicts a personal clock-out; administrator review required.", 409);
    }
    const clockInDoc = clockInDocs[0] ?? null;
    const personalClockOutDoc = personalClockOutDocs[0] ?? null;
    const attestationDoc = attestationDocs[0] ?? null;

    const personalClockIn = legacy?.clockIn ?? null;
    const clockIn = item.side === "incoming" ? clockInDoc?.clockIn ?? null : personalClockIn;
    const personalClockOut = legacy?.clockOut ?? personalClockOutDoc?.clockOut ?? null;
    // §4: a colleague attestation never overwrites or replaces personal
    // attendance; departure provenance records exactly who evidenced it.
    const clockOut = personalClockOut;
    const departureProvenance = personalClockOut !== null
      ? "personal" as const
      : attestationDoc !== null ? "colleague_attested" as const : null;

    const source = item.side === "incoming"
      ? clockInDoc
      : personalClockOutDoc ?? attestationDoc;
    const reportingEvidence: EqualHandoverReportV2ReportingEvidence | null = source
      ? {
        kind: source.kind,
        authenticationMethod: source.authenticationMethod,
        personallyAuthenticated: source.personallyAuthenticated,
        eventTime: source.eventTime ?? null,
        attestedByUid: source.attestedByUid,
        lateReason: source.lateReason ?? null,
      }
      : null;

    // §4: worked duration only from valid personal clock-in and clock-out.
    const duration = computeAttendanceWorkedDuration({
      clockIn: clockIn !== null && departureProvenance === "personal" ? clockIn : null,
      clockOut,
    });
    return {
      position: item.position,
      side: item.side,
      uid: item.technicianUid,
      name: profiles.get(item.technicianUid) ?? null,
      clockIn,
      clockOut,
      reportingEvidence,
      legacyAttendance: legacy,
      hoursWorked: duration.status === "computed" && duration.workedMs !== null ? duration.workedMs / 3_600_000 : null,
      // Payable-hours treatment remains an explicit unresolved policy: this
      // milestone never infers an attendance-correction authority.
      payableHours: "policy_unresolved" as const,
      departureProvenance,
      absenceDeclared: absenceByPosition.get(item.position) ?? null,
    };
  }).sort(positionCompare);

  const blockers: string[] = [
    ...operations.completeness.broadcastMissing.map((name) => `Missing verified broadcast observation: ${name}`),
  ];
  if (["missing", "conflicting"].includes(operations.completeness.outsideBroadcast)) {
    blockers.push(`Outside broadcast information is ${operations.completeness.outsideBroadcast}.`);
  }
  for (const item of readiness.blockers) blockers.push(`Pending task ${item.taskId}: ${item.reason.replaceAll("_", " ")}`);

  const warnings: string[] = [];
  // §4: absent records are never described as proof that nothing happened.
  if (operations.latest.every((item) => item.kind !== "incident")) {
    warnings.push("No fault or technical activity records were submitted. This is not a declaration of no faults.");
  }
  for (const row of attendance) {
    if (row.clockIn === null && row.clockOut === null && row.reportingEvidence === null && row.absenceDeclared === null) {
      warnings.push(`Attendance missing: ${row.name ?? row.uid}`);
    }
    if (row.hoursWorked === null && row.absenceDeclared === null) warnings.push(`Hours worked cannot be determined: ${row.name ?? row.uid}`);
  }
  if ([...profiles.values()].some((name) => name === null)) {
    warnings.push("One or more staff names are missing from authoritative account profiles.");
  }

  const content: EqualHandoverReportV2Content = {
    schema: "equal-handover-report-v2",
    outgoingShiftId,
    handoverDocumentId: createEqualHandoverDocumentId(outgoingShiftId),
    reservationId: aggregate.reservation.handoverId,
    staff: {
      shiftId: outgoingShiftId,
      shiftDate: scheduledStart.slice(0, 10),
      shiftType: identity.shiftType,
      scheduledStart,
      scheduledEnd,
      actualStart,
      engineeringLocation,
      handoverStartedAt,
      incomingShiftId: aggregate.reservation.reservedIncomingShiftId,
    },
    participants: positions.map((item) => ({
      position: item.position,
      side: item.side,
      uid: item.technicianUid,
      name: profiles.get(item.technicianUid) ?? null,
    })).sort(positionCompare),
    slotLineage: {
      outgoingSlotToken: identity.outgoingSlotToken,
      outgoingGeneration: identity.outgoingGeneration,
      successorSlotToken: identity.successorSlotToken,
      successorGeneration: identity.successorGeneration,
    },
    attendance,
    operations,
    pendingTasks,
    terminalTaskEvidence,
    workSnapshot,
    absences,
    completeness: { blockers, warnings },
    corrections,
  };

  const evidenceBundle = {
    namespace: "equal-handover-report-evidence-v2",
    shift: {
      id: rawShift.id,
      status: rawShift.status,
      shiftType: rawShift.shiftType,
      scheduledStart,
      scheduledEnd,
      actualStart,
      engineeringLocation,
      handoverStartedAt,
    },
    profiles: [...profiles.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([uid, name]) => ({ uid, name })),
    legacyAttendance: attendance.map((row) => ({ uid: row.uid, record: row.legacyAttendance }))
      .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)),
    attendanceEvidence: evidence,
    stations,
    events,
    corrections,
    work: { tasks: taskRecords, assignments: assignmentRecords, dispositions: work.dispositions },
  };

  return {
    content: assertEqualHandoverReportV2Content(content),
    contentDigest: digestEqualHandoverReportV2Content(content),
    evidenceSnapshotHash: digestHandoverReportEvidence(evidenceBundle),
    workSnapshotVersion: workSnapshot.version,
  };
}

function readV2Aggregate(transactionValue: unknown, outgoingShiftId: string): EqualHandoverAggregate {
  const aggregate = assertEqualHandoverAggregate(transactionValue);
  if (aggregate.identity.outgoingShiftId !== outgoingShiftId) {
    fail("Equal handover aggregate identity does not match the requested shift.", 409);
  }
  return aggregate;
}

function requireV2GuardBinding(
  guardSnapshotExists: boolean,
  guardData: unknown,
  documentId: string,
  aggregate: EqualHandoverAggregate,
): HandoverReservationGuard {
  if (!guardSnapshotExists) fail("The reservation guard evidence for this v2 reservation is missing; administrator review required.");
  const guard = assertHandoverReservationGuard(guardData);
  if (guard.protocolOwner !== "v2" || guard.ownerHandoverDocumentId !== documentId) {
    fail(`The outgoing shift reservation is owned by protocol ${guard.protocolOwner}.`, 409);
  }
  if (guard.reservationId !== aggregate.reservation.handoverId ||
      guard.reservedIncomingShiftId !== aggregate.reservation.reservedIncomingShiftId) {
    fail("The reservation guard is no longer bound to the current reservation.");
  }
  return guard;
}

function authorizeTechnicianProfile(profile: Record<string, unknown> | undefined, actorUid: string) {
  identifier(actorUid, 128);
  if (!profile || profile.role !== "technician" || profile.status !== "active" ||
      profile.statusOperation != null || profile.mustChangePassword === true) {
    fail("Your account is not authorized to access v2 handover reports.", 403);
  }
}

function requireOutgoingTechnician(profile: Record<string, unknown> | undefined, actorUid: string, aggregate: EqualHandoverAggregate) {
  authorizeTechnicianProfile(profile, actorUid);
  if (!aggregate.identity.outgoingTechnicianIds.includes(actorUid)) {
    fail("Only an outgoing reserved technician may prepare, declare or freeze a v2 handover report.", 403);
  }
}

function parseBindingInput(data: Record<string, unknown>): { expectedRevision: number; expectedSnapshotHash: string } {
  if (!Number.isSafeInteger(data.expectedRevision) || (data.expectedRevision as number) < 1 ||
      typeof data.expectedSnapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(data.expectedSnapshotHash)) {
    fail("Invalid report revision or snapshot hash evidence.", 400);
  }
  return { expectedRevision: data.expectedRevision as number, expectedSnapshotHash: data.expectedSnapshotHash };
}

function equalHandoverReportAuditId(material: unknown, prefix: string): string {
  return `${prefix}${createHash("sha256").update(canonical(material)).digest("hex").slice(0, 40)}`;
}

/**
 * Every aggregate write re-stamps the mutable `revision` carried by each
 * standing declaration, so a raw content digest changes even when the reviewed
 * evidence did not. Comparing declarations at their immutable recorded revision
 * keeps drift detection honest: it flags only the substantive evidence a
 * technician must re-review, exactly like the freeze authority.
 */
function digestAtRecordedRevisions(content: EqualHandoverReportV2Content): string {
  return digestEqualHandoverReportV2Content({
    ...content,
    absences: content.absences.map((item) => ({ ...item, revision: item.recordedRevision })),
  });
}

// Confirmation authority: any of the four reserved technicians may confirm for
// self; the domain then enforces actor == subject. Incoming technicians never
// gain outgoing prepare/declare/freeze authority.
function requireReservedTechnician(
  profile: Record<string, unknown> | undefined,
  actorUid: string,
  aggregate: EqualHandoverAggregate,
) {
  authorizeTechnicianProfile(profile, actorUid);
  if (!getEqualHandoverPositions(aggregate.identity).some((item) => item.technicianUid === actorUid)) {
    fail("Only a reserved handover participant may confirm for self.", 403);
  }
}

// ---------------------------------------------------------------------------
// Read view (GET) — outgoing technicians full, incoming reserved technicians
// read-only, administrators/supervisors read-only. No mutation, no activity
// stamp.
// ---------------------------------------------------------------------------

export interface EqualHandoverReportState {
  aggregate: EqualHandoverAggregate;
  snapshotHash: string;
  guard: HandoverReservationGuard | null;
  preparation: EqualHandoverReportPreparationV2 | null;
  frozenReport: FrozenEqualHandoverReportV2 | null;
  live: LiveReportEvidence;
  preparationDrifted: boolean;
  readiness: EqualHandoverReadiness;
}

/**
 * The single authoritative recomputation of review, report-drift and readiness
 * evidence inside a transaction. Both the readiness read and the final
 * transfer re-derive exactly this from live sources — no parallel rules (§8).
 */
interface ReservationEvidence {
  snapshotHash: string;
  preparationId: string;
  preparation: EqualHandoverReportPreparationV2 | null;
  frozenReport: FrozenEqualHandoverReportV2 | null;
  newestReportVersion: number;
  live: LiveReportEvidence;
  preparationDrifted: boolean;
  boundReportEvidenceDrifted: boolean;
  readiness: EqualHandoverReadiness;
}

async function readReservationEvidence(
  transaction: Transaction,
  aggregate: EqualHandoverAggregate,
): Promise<ReservationEvidence> {
  const { handoverReportPreparationsV2, handoverReportsV2 } = getOperationalCollections();
  const snapshotHash = createEqualHandoverSnapshot(aggregate).snapshotHash;
  const preparationId = createEqualHandoverPreparationDocumentId(aggregate.reservation.handoverId);
  const preparationSnapshot = await transaction.get(handoverReportPreparationsV2.doc(preparationId));
  const preparation = preparationSnapshot.exists
    ? assertEqualHandoverReportPreparationV2(hydrateTimestamps(preparationSnapshot.data()))
    : null;

  let frozenReport: FrozenEqualHandoverReportV2 | null = null;
  let newestReportVersion = 0;
  if (aggregate.reportBinding !== null) {
    const reportSnapshot = await transaction.get(handoverReportsV2.doc(aggregate.reportBinding.id));
    if (!reportSnapshot.exists) fail("Frozen report evidence is missing; administrator review required.", 409);
    frozenReport = assertFrozenEqualHandoverReportV2(hydrateTimestamps(reportSnapshot.data()));
    if (canonical(frozenReport.binding) !== canonical(aggregate.reportBinding)) {
      fail("Frozen report binding does not match the reservation; administrator review required.", 409);
    }
    // The whole reservation chain is read so readiness can prove the bound
    // report is still the newest version rather than a superseded one.
    const chain = await transaction.get(
      handoverReportsV2.where("reservationId", "==", aggregate.reservation.handoverId),
    );
    for (const document of chain.docs) {
      const version = assertFrozenEqualHandoverReportV2(hydrateTimestamps(document.data())).version;
      if (version > newestReportVersion) newestReportVersion = version;
    }
  }

  const live = await buildLiveReportEvidence(transaction, aggregate);
  // A successful freeze consumes the reviewed preparation: the bound report
  // carries exactly this preparation's revision and digest, and the aggregate
  // snapshot legitimately moves on when the binding is recorded. Drift only
  // means the review behind the frozen report has since been superseded.
  const reviewConsumedByFreeze = frozenReport !== null && preparation !== null &&
    frozenReport.preparationId === preparation.id &&
    frozenReport.preparationRevision === preparation.preparationRevision &&
    frozenReport.digest === preparation.contentDigest;
  const preparationDrifted = preparation === null ? false :
    digestAtRecordedRevisions(preparation.content) !== digestAtRecordedRevisions(live.content) ||
    preparation.evidenceSnapshotHash !== live.evidenceSnapshotHash ||
    (!reviewConsumedByFreeze && preparation.aggregateSnapshotHash !== snapshotHash);
  // The bound frozen report is immutable, but its underlying authoritative
  // sources can still move. Recomputing them at recorded-revision parity
  // flags genuine evidence drift without the benign declaration re-stamp.
  const boundReportEvidenceDrifted = frozenReport !== null && (
    digestAtRecordedRevisions(frozenReport.content) !== digestAtRecordedRevisions(live.content) ||
    frozenReport.evidenceSnapshotHash !== live.evidenceSnapshotHash
  );

  const readiness = evaluateEqualHandoverReadiness({
    lifecycleStatus: aggregate.lifecycleStatus,
    reportBinding: aggregate.reportBinding,
    participants: resolveEqualHandoverParticipants(aggregate),
    absences: aggregate.absences,
    boundReportId: frozenReport?.id ?? null,
    boundReportVersion: frozenReport?.version ?? null,
    newestReportVersion,
    boundReportEvidenceDrifted,
    preparationDrifted,
  });

  return {
    snapshotHash,
    preparationId,
    preparation,
    frozenReport,
    newestReportVersion,
    live,
    preparationDrifted,
    boundReportEvidenceDrifted,
    readiness,
  };
}

export async function readEqualHandoverReportState(
  outgoingShiftId: string,
  actorUid: string,
): Promise<EqualHandoverReportState> {
  identifier(outgoingShiftId);
  identifier(actorUid, 128);
  const { db, equalHandoversV2 } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(outgoingShiftId);
  return db.runTransaction(async (transaction) => {
    const [profileSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      transaction.get(db.collection("users").doc(actorUid)),
      transaction.get(equalHandoversV2.doc(documentId)),
      readReservationGuardState(transaction, outgoingShiftId),
    ]);
    const profile = profileSnapshot.data() as Record<string, unknown> | undefined;
    if (!profile || (profile.role !== "technician" && profile.role !== "admin" && profile.role !== "supervisor") ||
        profile.status !== "active" || profile.statusOperation != null || profile.mustChangePassword === true) {
      fail("Your account cannot access this report.", 403);
    }
    if (!aggregateSnapshot.exists) fail("The equal handover reservation was not found.", 404);
    const aggregate = readV2Aggregate(aggregateSnapshot.data(), outgoingShiftId);

    let guard: HandoverReservationGuard | null = null;
    if (profile.role === "technician") {
      const participant = getEqualHandoverPositions(aggregate.identity).some((item) => item.technicianUid === actorUid);
      if (!participant) fail("This handover report belongs to another shift.", 403);
      guard = requireV2GuardBinding(
        guardState.guardSnapshot.exists, guardState.guardSnapshot.data(), documentId, aggregate,
      );
    } else if (guardState.guardSnapshot.exists) {
      guard = assertHandoverReservationGuard(guardState.guardSnapshot.data());
    }

    // A transferred handover is terminal: its outgoing Shift is completed and
    // the live report sources are no longer reachable, so the immutable bound
    // frozen report is the authoritative content. Readiness reports the closed
    // lifecycle; no live re-derivation or drift signal applies.
    if (aggregate.lifecycleStatus === "completed") {
      const { handoverReportsV2 } = getOperationalCollections();
      if (aggregate.reportBinding === null) fail("A completed v2 handover has no bound report; administrator review required.", 409);
      const reportSnapshot = await transaction.get(handoverReportsV2.doc(aggregate.reportBinding.id));
      if (!reportSnapshot.exists) fail("Frozen report evidence is missing; administrator review required.", 409);
      const frozenReport = assertFrozenEqualHandoverReportV2(hydrateTimestamps(reportSnapshot.data()));
      if (canonical(frozenReport.binding) !== canonical(aggregate.reportBinding)) {
        fail("Frozen report binding does not match the reservation; administrator review required.", 409);
      }
      const chain = await transaction.get(handoverReportsV2.where("reservationId", "==", aggregate.reservation.handoverId));
      let newestReportVersion = frozenReport.version;
      for (const document of chain.docs) {
        const version = assertFrozenEqualHandoverReportV2(hydrateTimestamps(document.data())).version;
        if (version > newestReportVersion) newestReportVersion = version;
      }
      const readiness = evaluateEqualHandoverReadiness({
        lifecycleStatus: aggregate.lifecycleStatus,
        reportBinding: aggregate.reportBinding,
        participants: resolveEqualHandoverParticipants(aggregate),
        absences: aggregate.absences,
        boundReportId: frozenReport.id,
        boundReportVersion: frozenReport.version,
        newestReportVersion,
        boundReportEvidenceDrifted: false,
        preparationDrifted: false,
      });
      return {
        aggregate,
        snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash,
        guard,
        preparation: null,
        frozenReport,
        live: {
          content: frozenReport.content,
          contentDigest: frozenReport.digest,
          evidenceSnapshotHash: frozenReport.evidenceSnapshotHash,
          workSnapshotVersion: frozenReport.workSnapshotVersion,
        },
        preparationDrifted: false,
        readiness,
      };
    }

    const evidence = await readReservationEvidence(transaction, aggregate);
    return {
      aggregate,
      snapshotHash: evidence.snapshotHash,
      guard,
      preparation: evidence.preparation,
      frozenReport: evidence.frozenReport,
      live: evidence.live,
      preparationDrifted: evidence.preparationDrifted,
      readiness: evidence.readiness,
    };
  });
}

// ---------------------------------------------------------------------------
// Preparation (§5/§9): deterministic document keyed by the reservation
// fingerprint; either outgoing technician has equal preparation authority; an
// identical-content retry replays without a new revision; changed evidence
// creates a new revision with its full immutable history.
// ---------------------------------------------------------------------------

export async function prepareEqualHandoverReport(input: {
  outgoingShiftId: string;
  actorUid: string;
  reason: string | null;
}): Promise<{ preparation: EqualHandoverReportPreparationV2; replayed: boolean }> {
  identifier(input.outgoingShiftId);
  identifier(input.actorUid, 128);
  const reason = text(input.reason, "preparation reason");
  const { db, equalHandoversV2, handoverReportPreparationsV2 } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  const aggregateRef = equalHandoversV2.doc(documentId);
  const actorRef = db.collection("users").doc(input.actorUid);

  return db.runTransaction(async (transaction) => {
    const [profileSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      transaction.get(actorRef),
      transaction.get(aggregateRef),
      readReservationGuardState(transaction, input.outgoingShiftId),
    ]);
    if (!aggregateSnapshot.exists) fail("The equal handover reservation was not found.", 404);
    const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
    requireOutgoingTechnician(profileSnapshot.data() as Record<string, unknown> | undefined, input.actorUid, aggregate);
    if (aggregate.lifecycleStatus !== "collecting_confirmations") {
      fail("The handover lifecycle does not permit report preparation.");
    }
    const guard = requireV2GuardBinding(
      guardState.guardSnapshot.exists, guardState.guardSnapshot.data(), documentId, aggregate,
    );

    const live = await buildLiveReportEvidence(transaction, aggregate);
    const snapshotHash = createEqualHandoverSnapshot(aggregate).snapshotHash;
    const preparationId = createEqualHandoverPreparationDocumentId(aggregate.reservation.handoverId);
    const preparationRef = handoverReportPreparationsV2.doc(preparationId);
    const storedSnapshot = await transaction.get(preparationRef);
    const stored = storedSnapshot.exists
      ? assertEqualHandoverReportPreparationV2(hydrateTimestamps(storedSnapshot.data()))
      : null;
    if (stored && (stored.outgoingShiftId !== input.outgoingShiftId || stored.reservationId !== aggregate.reservation.handoverId)) {
      fail("Preparation evidence belongs to another reservation; administrator review required.", 409);
    }

    const now = new Date().toISOString();
    if (stored && stored.contentDigest === live.contentDigest) {
      // Identical reviewed content is never a new revision. Review stamps are
      // refreshed in place so a freeze can proceed after unrelated aggregate
      // churn, but no revision history entry and no audit event is created.
      const refreshed: EqualHandoverReportPreparationV2 = {
        ...stored,
        aggregateRevision: aggregate.revision,
        aggregateSnapshotHash: snapshotHash,
        guardRevision: guard.guardRevision,
        fencingEpoch: guard.fencingEpoch,
        evidenceSnapshotHash: live.evidenceSnapshotHash,
        workSnapshotVersion: live.workSnapshotVersion,
        updatedAt: now,
      };
      if (canonical(refreshed) !== canonical(stored)) {
        assertEqualHandoverReportPreparationV2(refreshed);
        if (estimateTransferDocumentBytes(`handover_report_preparations_v2/${preparationId}`, refreshed) > MAX_DOCUMENT_BYTES) {
          fail("Report preparation evidence exceeds the authoritative document limit.", 413);
        }
        transaction.set(preparationRef, refreshed);
        return { preparation: refreshed, replayed: true };
      }
      return { preparation: stored, replayed: true };
    }

    const preparationRevision = (stored?.preparationRevision ?? 0) + 1;
    const historyEntry: EqualHandoverPreparationRevisionEntry = {
      preparationRevision,
      contentDigest: live.contentDigest,
      evidenceSnapshotHash: live.evidenceSnapshotHash,
      preparedBy: input.actorUid,
      preparedAt: now,
      reason: stored ? reason : (reason ?? null),
    };
    const preparation: EqualHandoverReportPreparationV2 = {
      schema: "equal-handover-report-preparation-v2",
      id: preparationId,
      outgoingShiftId: input.outgoingShiftId,
      handoverDocumentId: documentId,
      reservationId: aggregate.reservation.handoverId,
      aggregateRevision: aggregate.revision,
      aggregateSnapshotHash: snapshotHash,
      guardProtocolOwner: "v2",
      guardRevision: guard.guardRevision,
      fencingEpoch: guard.fencingEpoch,
      preparationRevision,
      content: live.content,
      evidenceSnapshotHash: live.evidenceSnapshotHash,
      contentDigest: live.contentDigest,
      workSnapshotVersion: live.workSnapshotVersion,
      blockers: live.content.completeness.blockers,
      warnings: live.content.completeness.warnings,
      preparedBy: input.actorUid,
      createdAt: assertCanonicalIsoWrite(stored?.createdAt ?? now, "preparation created time"),
      updatedAt: assertCanonicalIsoWrite(now, "preparation updated time"),
      revisionHistory: [...(stored?.revisionHistory ?? []), historyEntry],
    };
    assertEqualHandoverReportPreparationV2(preparation);
    if (estimateTransferDocumentBytes(`handover_report_preparations_v2/${preparationId}`, preparation) > MAX_DOCUMENT_BYTES) {
      fail("Report preparation evidence exceeds the authoritative document limit; reduce the operational record scope.", 413);
    }

    if (stored) transaction.set(preparationRef, preparation);
    else transaction.create(preparationRef, preparation);
    const auditId = equalHandoverReportAuditId({
      namespace: "equal-handover-report-prepare-audit-v2",
      preparationId,
      preparationRevision,
      contentDigest: live.contentDigest,
    }, "audit_report_prepared_v2_");
    transaction.create(db.collection("audit_logs").doc(auditId), {
      id: auditId,
      action: "EQUAL_HANDOVER_REPORT_PREPARED_V2",
      protocol: "equal-handover-v2",
      actorUid: input.actorUid,
      outgoingShiftId: input.outgoingShiftId,
      handoverDocumentId: documentId,
      reservationId: aggregate.reservation.handoverId,
      preparationId,
      preparationRevision,
      previousPreparationRevision: stored?.preparationRevision ?? null,
      previousContentDigest: stored?.contentDigest ?? null,
      contentDigest: live.contentDigest,
      evidenceSnapshotHash: live.evidenceSnapshotHash,
      workSnapshotVersion: live.workSnapshotVersion,
      aggregateRevision: aggregate.revision,
      aggregateSnapshotHash: snapshotHash,
      reason,
      recordedAt: now,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(actorRef, { lastOperationalActivityAt: FieldValue.serverTimestamp() });
    return { preparation, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Absence declarations (§8): persistence-layer rules only — the domain owns
// revision/invalidation semantics. A colleague attestation never replaces
// genuine personal attendance, declarations never finalize evidence, and the
// previous declaration is preserved in immutable audit history.
// ---------------------------------------------------------------------------

export interface EqualHandoverAbsenceInput {
  outgoingShiftId: string;
  actorUid: string;
  technicianUid: string;
  reason: string;
  reportedDepartureTime: string | null;
  expectedRevision: number;
  expectedSnapshotHash: string;
}

export async function recordEqualHandoverAbsenceV2(
  input: EqualHandoverAbsenceInput & { absenceType: string },
): Promise<{ aggregate: EqualHandoverAggregate; snapshotHash: string; replayed: boolean }> {
  identifier(input.outgoingShiftId);
  identifier(input.actorUid, 128);
  identifier(input.technicianUid, 128);
  const reason = text(input.reason, "absence reason", 1_000);
  if (!reason) fail("A non-empty absence reason is required.", 400);
  if (input.absenceType !== "not_yet_in" && input.absenceType !== "absent_left_office") {
    fail("Unsupported absence type.", 400);
  }
  const binding = parseBindingInput(input as unknown as Record<string, unknown>);
  const { db, equalHandoversV2, shiftAttendance, attendanceEvidenceV2 } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  const aggregateRef = equalHandoversV2.doc(documentId);
  const actorRef = db.collection("users").doc(input.actorUid);

  return db.runTransaction(async (transaction) => {
    const [profileSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      transaction.get(actorRef),
      transaction.get(aggregateRef),
      readReservationGuardState(transaction, input.outgoingShiftId),
    ]);
    if (!aggregateSnapshot.exists) fail("The equal handover reservation was not found.", 404);
    const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
    requireOutgoingTechnician(profileSnapshot.data() as Record<string, unknown> | undefined, input.actorUid, aggregate);
    requireV2GuardBinding(guardState.guardSnapshot.exists, guardState.guardSnapshot.data(), documentId, aggregate);

    if (input.actorUid === input.technicianUid) {
      fail("A technician cannot declare their own absence; a colleague must attest it.", 403);
    }
    const participant = getEqualHandoverPositions(aggregate.identity).find(
      (item) => item.technicianUid === input.technicianUid,
    );
    if (!participant) fail("Unauthorized handover participant.", 403);
    // §8: at most one supported absent participant across the whole handover.
    const existingOther = aggregate.absences.find((item) => item.technicianUid !== input.technicianUid);
    if (existingOther) {
      fail("Only one participant absence may be declared for a handover; clear the existing declaration first.", 409);
    }

    const legacySnapshot = await transaction.get(shiftAttendance.doc(`${input.outgoingShiftId}_${input.technicianUid}`));
    const evidenceQuery = await transaction.get(
      attendanceEvidenceV2.where("handoverId", "==", aggregate.reservation.handoverId),
    );
    const subjectEvidence = evidenceQuery.docs.map((document) => assertAttendanceEvidence(hydrateTimestamps(document.data())))
      .filter((record) => record.technicianUid === input.technicianUid);
    if (participant.side === "outgoing") {
      const personal = legacySnapshot.exists
        ? readAttendanceRecord(legacySnapshot.id, hydrateTimestamps(legacySnapshot.data())).clockOut !== null
        : subjectEvidence.some((record) =>
          record.kind === ATTENDANCE_EVIDENCE_KINDS.OUTGOING_PERSONAL_CLOCK_OUT && record.clockOut !== null);
      // §8: a colleague declaration must not replace genuine personal
      // attendance evidence.
      if (personal) fail("This technician already has personal clock-out evidence; an absence declaration is invalid.", 409);
    } else {
      if (subjectEvidence.some((record) => attendanceEvidenceCountsAsClockIn(record))) {
        fail("This technician already has personal clock-in evidence; an absence declaration is invalid.", 409);
      }
    }

    // §8 retry safety: an identical declaration that already stands is a
    // replay, never a second record or audit event. The check runs before the
    // revision guard so a retried request cannot be turned into a conflicting
    // revision of the same declaration.
    const standing = aggregate.absences.find((item) => item.position === participant.position) ?? null;
    if (standing && standing.absenceType === input.absenceType && standing.reason === reason &&
        standing.reportedDepartureTime === (input.reportedDepartureTime ?? null) &&
        standing.attestedByUid === input.actorUid) {
      return { aggregate, snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, replayed: true };
    }

    const now = new Date().toISOString();
    const next = recordEqualHandoverAbsence(aggregate, {
      revision: binding.expectedRevision,
      snapshotHash: binding.expectedSnapshotHash,
      recordedAt: now,
      actorUid: input.actorUid,
      technicianUid: input.technicianUid,
      absenceType: input.absenceType as EqualHandoverAbsence["absenceType"],
      reason,
      reportedDepartureTime: input.reportedDepartureTime,
      attestedByUid: input.actorUid,
    });
    if (canonical(next) === canonical(aggregate)) return { aggregate, snapshotHash: binding.expectedSnapshotHash, replayed: true };

    const previous = aggregate.absences.find((item) => item.technicianUid === input.technicianUid) ?? null;
    const snapshotHash = createEqualHandoverSnapshot(next).snapshotHash;
    transaction.set(aggregateRef, next);
    const auditId = equalHandoverReportAuditId({
      namespace: "equal-handover-absence-record-audit-v2",
      documentId,
      revision: next.revision,
      technicianUid: input.technicianUid,
    }, "audit_absence_v2_");
    transaction.create(db.collection("audit_logs").doc(auditId), {
      id: auditId,
      action: "EQUAL_HANDOVER_ABSENCE_RECORDED_V2",
      protocol: "equal-handover-v2",
      actorUid: input.actorUid,
      outgoingShiftId: input.outgoingShiftId,
      handoverDocumentId: documentId,
      reservationId: aggregate.reservation.handoverId,
      absence: next.absences.find((item) => item.technicianUid === input.technicianUid) ?? null,
      previousDeclaration: previous,
      revision: next.revision,
      snapshotHash,
      recordedAt: now,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(actorRef, { lastOperationalActivityAt: FieldValue.serverTimestamp() });
    return { aggregate: next, snapshotHash, replayed: false };
  });
}

export async function clearEqualHandoverAbsenceV2(
  input: Omit<EqualHandoverAbsenceInput, "reason" | "reportedDepartureTime">,
): Promise<{ aggregate: EqualHandoverAggregate; snapshotHash: string; replayed: boolean }> {
  identifier(input.outgoingShiftId);
  identifier(input.actorUid, 128);
  identifier(input.technicianUid, 128);
  const binding = parseBindingInput(input as unknown as Record<string, unknown>);
  const { db, equalHandoversV2 } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  const aggregateRef = equalHandoversV2.doc(documentId);
  const actorRef = db.collection("users").doc(input.actorUid);

  return db.runTransaction(async (transaction) => {
    const [profileSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      transaction.get(actorRef),
      transaction.get(aggregateRef),
      readReservationGuardState(transaction, input.outgoingShiftId),
    ]);
    if (!aggregateSnapshot.exists) fail("The equal handover reservation was not found.", 404);
    const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
    requireOutgoingTechnician(profileSnapshot.data() as Record<string, unknown> | undefined, input.actorUid, aggregate);
    requireV2GuardBinding(guardState.guardSnapshot.exists, guardState.guardSnapshot.data(), documentId, aggregate);
    if (input.actorUid === input.technicianUid) fail("A technician cannot clear their own absence declaration.", 403);

    // A clear of a position that holds no declaration is an idempotent no-op.
    if (!getEqualHandoverPositions(aggregate.identity).some((item) => item.technicianUid === input.technicianUid)) {
      fail("Unauthorized handover participant.", 403);
    }
    if (!aggregate.absences.some((item) => item.technicianUid === input.technicianUid)) {
      return { aggregate, snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, replayed: true };
    }

    const now = new Date().toISOString();
    const next = clearEqualHandoverAbsence(aggregate, {
      revision: binding.expectedRevision,
      snapshotHash: binding.expectedSnapshotHash,
      recordedAt: now,
      actorUid: input.actorUid,
      technicianUid: input.technicianUid,
    });
    if (canonical(next) === canonical(aggregate)) return { aggregate, snapshotHash: binding.expectedSnapshotHash, replayed: true };

    const previous = aggregate.absences.find((item) => item.technicianUid === input.technicianUid) ?? null;
    if (!previous) fail("Only the colleague who holds an absence declaration may clear it.", 409);
    const snapshotHash = createEqualHandoverSnapshot(next).snapshotHash;
    transaction.set(aggregateRef, next);
    const auditId = equalHandoverReportAuditId({
      namespace: "equal-handover-absence-clear-audit-v2",
      documentId,
      revision: next.revision,
      technicianUid: input.technicianUid,
    }, "audit_absence_cleared_v2_");
    transaction.create(db.collection("audit_logs").doc(auditId), {
      id: auditId,
      action: "EQUAL_HANDOVER_ABSENCE_CLEARED_V2",
      protocol: "equal-handover-v2",
      actorUid: input.actorUid,
      outgoingShiftId: input.outgoingShiftId,
      handoverDocumentId: documentId,
      reservationId: aggregate.reservation.handoverId,
      clearedDeclaration: previous,
      revision: next.revision,
      snapshotHash,
      recordedAt: now,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(actorRef, { lastOperationalActivityAt: FieldValue.serverTimestamp() });
    return { aggregate: next, snapshotHash, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Participant confirmations (§4): a dedicated v2 writer, separate from the v1
// confirmation path. Identity is strictly session-derived — the confirming
// technician is always the authenticated actor, never a request-body field.
// The confirmation binds the exact reservation, the current immutable frozen
// report (id, digest, evidence snapshot hash, work snapshot version,
// preparation revision) and the aggregate snapshot at server-recorded timing.
// An identical replay of an already-standing personal confirmation is a no-op:
// no second confirmation entry, no second audit event, no frozen-report or V1
// mutation. Rejected requests leave Firestore byte-unchanged because every
// guard runs before the first buffered write.
// ---------------------------------------------------------------------------

export interface EqualHandoverConfirmInput {
  outgoingShiftId: string;
  actorUid: string;
  expectedRevision: number;
  expectedSnapshotHash: string;
}

export async function confirmEqualHandoverParticipantV2(
  input: EqualHandoverConfirmInput,
): Promise<{ aggregate: EqualHandoverAggregate; snapshotHash: string; replayed: boolean }> {
  identifier(input.outgoingShiftId);
  identifier(input.actorUid, 128);
  const binding = parseBindingInput(input as unknown as Record<string, unknown>);
  const { db, equalHandoversV2 } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  const aggregateRef = equalHandoversV2.doc(documentId);
  const actorRef = db.collection("users").doc(input.actorUid);

  return db.runTransaction(async (transaction) => {
    const [profileSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      transaction.get(actorRef),
      transaction.get(aggregateRef),
      readReservationGuardState(transaction, input.outgoingShiftId),
    ]);
    if (!aggregateSnapshot.exists) fail("The equal handover reservation was not found.", 404);
    const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
    // Self-only: the confirming technician is the authenticated actor.
    requireReservedTechnician(profileSnapshot.data() as Record<string, unknown> | undefined, input.actorUid, aggregate);
    requireV2GuardBinding(guardState.guardSnapshot.exists, guardState.guardSnapshot.data(), documentId, aggregate);

    const position = getEqualHandoverPositions(aggregate.identity)
      .find((item) => item.technicianUid === input.actorUid)?.position;
    // Retry safety runs before the revision guard so a retried confirmation
    // cannot be turned into a stale-write rejection.
    if (position && aggregate.confirmations.some((item) => item.position === position)) {
      return { aggregate, snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, replayed: true };
    }

    const now = new Date().toISOString();
    const next = confirmEqualHandoverParticipant(aggregate, {
      revision: binding.expectedRevision,
      snapshotHash: binding.expectedSnapshotHash,
      recordedAt: now,
      actorUid: input.actorUid,
      technicianUid: input.actorUid,
    });
    if (canonical(next) === canonical(aggregate)) {
      return { aggregate, snapshotHash: binding.expectedSnapshotHash, replayed: true };
    }

    const confirmation = next.confirmations.find((item) => item.position === position) ?? null;
    if (!confirmation) fail("The confirmation was not recorded; administrator review required.", 409);
    const snapshotHash = createEqualHandoverSnapshot(next).snapshotHash;
    transaction.set(aggregateRef, next);
    const auditId = equalHandoverReportAuditId({
      namespace: "equal-handover-confirm-audit-v2",
      documentId,
      revision: next.revision,
      technicianUid: input.actorUid,
    }, "audit_confirm_v2_");
    transaction.create(db.collection("audit_logs").doc(auditId), {
      id: auditId,
      action: "EQUAL_HANDOVER_CONFIRMED_V2",
      protocol: "equal-handover-v2",
      actorUid: input.actorUid,
      outgoingShiftId: input.outgoingShiftId,
      handoverDocumentId: documentId,
      reservationId: aggregate.reservation.handoverId,
      confirmation,
      reportId: confirmation.reportBinding.id,
      preparationRevision: confirmation.reportBinding.preparationRevision,
      revision: next.revision,
      snapshotHash,
      recordedAt: now,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(actorRef, { lastOperationalActivityAt: FieldValue.serverTimestamp() });
    return { aggregate: next, snapshotHash, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Immutable freeze (§10): all authoritative sources are recomputed inside the
// transaction, so a stale preparation, changed work (including terminal task
// lifecycle) or guard change can never freeze successfully. An identical
// completed request replays the same immutable report and never duplicates
// documents or successful audit events. This transaction never completes the
// handover, creates confirmations, advances operational shift control,
// creates the incoming Shift or finalizes attendance.
// ---------------------------------------------------------------------------

export interface EqualHandoverFreezeInput {
  outgoingShiftId: string;
  actorUid: string;
  expectedRevision: number;
  expectedSnapshotHash: string;
  expectedGuardRevision: number;
  expectedFencingEpoch: number;
  preparationRevision: number;
  contentDigest: string;
  evidenceSnapshotHash: string;
  workSnapshotVersion: string;
  reason: string;
  correctionNote: string | null;
}

export async function freezeEqualHandoverReport(
  input: EqualHandoverFreezeInput,
): Promise<{ report: FrozenEqualHandoverReportV2; aggregate: EqualHandoverAggregate; snapshotHash: string; replayed: boolean }> {
  identifier(input.outgoingShiftId);
  identifier(input.actorUid, 128);
  const reason = text(input.reason, "freeze reason", 1_000);
  if (!reason) fail("A non-empty freeze reason is required.", 400);
  const correctionNote = text(input.correctionNote, "correction note", 4_000);
  for (const [value, label] of [
    [input.contentDigest, "content digest"], [input.evidenceSnapshotHash, "evidence snapshot hash"],
    [input.workSnapshotVersion, "work snapshot version"],
  ] as const) hex64(value, label);
  if (!Number.isSafeInteger(input.preparationRevision) || (input.preparationRevision as number) < 1) {
    fail("Invalid preparation revision.", 400);
  }
  if (!Number.isSafeInteger(input.expectedGuardRevision) || (input.expectedGuardRevision as number) < 1 ||
      !Number.isSafeInteger(input.expectedFencingEpoch) || (input.expectedFencingEpoch as number) < 1) {
    fail("Invalid guard revision or fencing epoch.", 400);
  }
  const binding = parseBindingInput(input as unknown as Record<string, unknown>);

  const { db, equalHandoversV2, handoverReportPreparationsV2, handoverReportsV2 } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  const aggregateRef = equalHandoversV2.doc(documentId);
  const actorRef = db.collection("users").doc(input.actorUid);

  return db.runTransaction(async (transaction) => {
    // Steps 1-2: every read precedes the first buffered write (Steps 8-10).
    const [profileSnapshot, aggregateSnapshot, guardState] = await Promise.all([
      transaction.get(actorRef),
      transaction.get(aggregateRef),
      readReservationGuardState(transaction, input.outgoingShiftId),
    ]);
    if (!aggregateSnapshot.exists) fail("The equal handover reservation was not found.", 404);
    const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
    // Step 3: technician-only outgoing authority; supervisors are excluded.
    requireOutgoingTechnician(profileSnapshot.data() as Record<string, unknown> | undefined, input.actorUid, aggregate);
    if (aggregate.lifecycleStatus !== "collecting_confirmations") {
      fail("The handover lifecycle does not permit report freezing.");
    }
    // Step 4: guard ownership and caller-reviewed epoch evidence.
    const guard = requireV2GuardBinding(
      guardState.guardSnapshot.exists, guardState.guardSnapshot.data(), documentId, aggregate,
    );
    if (guard.guardRevision !== input.expectedGuardRevision || guard.fencingEpoch !== input.expectedFencingEpoch) {
      fail("The reservation guard changed since this report was reviewed.");
    }

    const preparationId = createEqualHandoverPreparationDocumentId(aggregate.reservation.handoverId);
    const preparationSnapshot = await transaction.get(handoverReportPreparationsV2.doc(preparationId));
    if (!preparationSnapshot.exists) fail("Prepare and review the consolidated report before freezing it.", 409);
    const preparation = assertEqualHandoverReportPreparationV2(hydrateTimestamps(preparationSnapshot.data()));

    const reportsQuery = await transaction.get(
      handoverReportsV2.where("reservationId", "==", aggregate.reservation.handoverId),
    );
    const existing = reportsQuery.docs.map((document) => {
      const report = assertFrozenEqualHandoverReportV2(hydrateTimestamps(document.data()));
      if (report.id !== document.id) fail("Frozen report identity is inconsistent; administrator review required.", 409);
      return report;
    }).sort((a, b) => a.version - b.version);
    if (existing.some((report, index) => report.version !== index + 1)) {
      fail("Frozen report version chain is inconsistent; administrator review required.", 409);
    }

    // Step 5: retry safety — an identical completed freeze replays before any
    // staleness rejection, but only when the stored binding still matches the
    // reviewed evidence byte-for-byte.
    if (aggregate.reportBinding !== null &&
        aggregate.reportBinding.reservationId === aggregate.reservation.handoverId &&
        aggregate.reportBinding.preparationId === preparationId &&
        aggregate.reportBinding.preparationRevision === input.preparationRevision &&
        aggregate.reportBinding.digest === input.contentDigest &&
        aggregate.reportBinding.evidenceSnapshotHash === input.evidenceSnapshotHash &&
        aggregate.reportBinding.workSnapshotVersion === input.workSnapshotVersion) {
      const storedReportSnapshot = await transaction.get(handoverReportsV2.doc(aggregate.reportBinding.id));
      if (!storedReportSnapshot.exists) fail("Frozen report evidence is missing; administrator review required.", 409);
      const storedReport = assertFrozenEqualHandoverReportV2(hydrateTimestamps(storedReportSnapshot.data()));
      if (canonical(storedReport.binding) !== canonical(aggregate.reportBinding)) {
        fail("Frozen report binding does not match the reservation; administrator review required.", 409);
      }
      return { report: storedReport, aggregate, snapshotHash: binding.expectedSnapshotHash, replayed: true };
    }

    // Step 6: every reviewed evidence relationship must still hold, and the
    // live sources are recomputed inside this transaction (§7): a concurrent
    // operational change aborts the retry loop or fails the checks below.
    const snapshotHash = createEqualHandoverSnapshot(aggregate).snapshotHash;
    if (aggregate.revision !== binding.expectedRevision || snapshotHash !== binding.expectedSnapshotHash) {
      fail("Stale equal handover reservation evidence.");
    }
    if (preparation.preparationRevision !== input.preparationRevision ||
        preparation.contentDigest !== input.contentDigest ||
        preparation.evidenceSnapshotHash !== input.evidenceSnapshotHash ||
        preparation.workSnapshotVersion !== input.workSnapshotVersion) {
      fail("The reviewed preparation revision changed; reload and review again.");
    }
    if (preparation.aggregateRevision !== aggregate.revision || preparation.aggregateSnapshotHash !== snapshotHash) {
      fail("The reservation changed after this report was prepared; re-prepare and review before freezing.");
    }
    const live = await buildLiveReportEvidence(transaction, aggregate);
    if (live.contentDigest !== preparation.contentDigest ||
        live.evidenceSnapshotHash !== preparation.evidenceSnapshotHash ||
        live.workSnapshotVersion !== preparation.workSnapshotVersion) {
      fail("Report sources changed after preparation; a stale preparation cannot freeze. Re-prepare and review the consolidated report.");
    }
    // §7/§14: an incomplete report cannot be frozen. The authoritative
    // blockers are re-derived from live sources, so a reviewed preparation
    // never launders missing station, outside-broadcast or work evidence.
    if (live.content.completeness.blockers.length > 0) {
      fail(`Report is incomplete: ${live.content.completeness.blockers.join("; ")}`);
    }

    const version = existing.length + 1;
    if (version > 1 && correctionNote === null) {
      fail("A later frozen report version requires an explicit correction note.", 400);
    }
    const now = new Date().toISOString();
    const base = {
      schema: "handover-report-v2" as const,
      id: createEqualHandoverReportV2Id({
        reservationId: aggregate.reservation.handoverId,
        preparationRevision: preparation.preparationRevision,
        contentDigest: preparation.contentDigest,
        aggregateRevision: aggregate.revision,
        version,
      }),
      version,
      supersedesReportId: version > 1 ? existing[existing.length - 1]!.id : null,
      outgoingShiftId: input.outgoingShiftId,
      handoverDocumentId: documentId,
      reservationId: aggregate.reservation.handoverId,
      digest: preparation.contentDigest,
      evidenceSnapshotHash: preparation.evidenceSnapshotHash,
      workSnapshotVersion: preparation.workSnapshotVersion,
      preparationId,
      preparationRevision: preparation.preparationRevision,
      aggregateRevision: aggregate.revision,
      aggregateSnapshotHash: snapshotHash,
      guardRevision: guard.guardRevision,
      fencingEpoch: guard.fencingEpoch,
      participants: live.content.participants,
      absences: live.content.absences,
      content: live.content,
      reason,
      correctionNote,
      frozenBy: input.actorUid,
      frozenAt: assertCanonicalIsoWrite(now, "freeze time"),
    };
    const bindingValue: EqualHandoverReportV2Binding = buildEqualHandoverReportV2Binding(base);
    const report: FrozenEqualHandoverReportV2 = { ...base, binding: bindingValue };
    assertFrozenEqualHandoverReportV2(report);
    if (estimateTransferDocumentBytes(`handover_reports_v2/${report.id}`, report) > MAX_DOCUMENT_BYTES) {
      fail("Frozen report evidence exceeds the authoritative document limit; the evidence is rejected, never truncated.", 413);
    }

    // Step 7: bind the immutable report into the aggregate through the
    // authoritative revision semantics (confirmations are invalidated as
    // "report_revised"; none exist in this milestone).
    const nextAggregate = reviseEqualHandoverReport(aggregate, {
      revision: binding.expectedRevision,
      snapshotHash: binding.expectedSnapshotHash,
      recordedAt: now,
      reportBinding: bindingValue,
    });

    // Steps 8-10: writes only. The deterministic report id makes a concurrent
    // duplicate collide on create, so the SDK retry then takes the replay
    // branch above.
    transaction.create(handoverReportsV2.doc(report.id), report);
    transaction.set(aggregateRef, nextAggregate);
    const auditId = equalHandoverReportAuditId(
      equalHandoverReportV2FreezeMaterial({
        reservationId: report.reservationId,
        preparationRevision: report.preparationRevision,
        digest: report.digest,
        aggregateRevision: report.aggregateRevision,
        version: report.version,
      }),
      "audit_report_frozen_v2_",
    );
    transaction.create(db.collection("audit_logs").doc(auditId), {
      id: auditId,
      action: "EQUAL_HANDOVER_REPORT_FROZEN_V2",
      protocol: "equal-handover-v2",
      actorUid: input.actorUid,
      outgoingShiftId: input.outgoingShiftId,
      handoverDocumentId: documentId,
      reservationId: report.reservationId,
      reportId: report.id,
      reportVersion: report.version,
      supersedesReportId: report.supersedesReportId,
      preparationId,
      preparationRevision: report.preparationRevision,
      digest: report.digest,
      evidenceSnapshotHash: report.evidenceSnapshotHash,
      workSnapshotVersion: report.workSnapshotVersion,
      aggregateRevision: report.aggregateRevision,
      nextAggregateRevision: nextAggregate.revision,
      snapshotHash: createEqualHandoverSnapshot(nextAggregate).snapshotHash,
      guardRevision: report.guardRevision,
      fencingEpoch: report.fencingEpoch,
      reason,
      correctionNote,
      recordedAt: now,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(actorRef, { lastOperationalActivityAt: FieldValue.serverTimestamp() });
    return { report, aggregate: nextAggregate, snapshotHash: createEqualHandoverSnapshot(nextAggregate).snapshotHash, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Final transfer (§4-§6) — the single authoritative, atomic transfer of a
// completed v2 equal-technician handover. Authorization is derived entirely
// inside this transaction; a prior GET /readiness result and its
// hard-coded `transferAuthorized:false` are never treated as proof of
// authority (§4). The initiator must be an outgoing reserved technician who
// is themselves a personal-confirmed, non-absent participant. Every reviewed
// evidence relationship, the live operational sources and the authoritative
// domain readiness gate are re-derived here; the immutable frozen report is
// never mutated (§8). The transfer writes no attendance and carries no tasks:
// a station/outside-broadcast/pending-task blocker is enforced through the
// same freeze gating the report used, so nothing unfinished is silently lost.
// A deterministic receipt, created as the last write, fences every concurrent
// attempt: the loser's retry observes the completed lifecycle and replays the
// committed result instead of double-transferring (§5).
// ---------------------------------------------------------------------------

export interface EqualHandoverTransferInput {
  outgoingShiftId: string;
  actorUid: string;
  expectedRevision: number;
  expectedSnapshotHash: string;
  expectedGuardRevision: number;
  expectedFencingEpoch: number;
}

export interface EqualHandoverTransferReceipt {
  id: string;
  schema: "equal-handover-transfer-v2";
  action: "EQUAL_SHIFT_HANDOVER_TRANSFERRED_V2";
  outcome: "TRANSFERRED";
  protocol: "equal-handover-v2";
  handoverDocumentId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  finalRevision: number;
  finalSnapshotHash: string;
  boundReportId: string;
  boundReportVersion: number;
  actorUid: string;
  actorRole: "technician";
  transferredAt: string;
  receiptHash: string;
  operationalControlBefore: unknown;
  operationalControlAfter: unknown;
}

export interface EqualHandoverTransferResult {
  status: "TRANSFERRED" | "ALREADY_TRANSFERRED";
  replayed: boolean;
  receipt: EqualHandoverTransferReceipt;
  aggregate: EqualHandoverAggregate;
  snapshotHash: string;
  outgoingShiftId: string;
  incomingShiftId: string;
}

function equalHandoverTransferReceiptId(documentId: string): string {
  return `handover-transfer-v2-${createHash("sha256")
    .update(canonical({ namespace: "equal-handover-transfer-v2", handoverDocumentId: documentId }))
    .digest("hex")}`;
}

function transferReceiptMaterial(receipt: Omit<EqualHandoverTransferReceipt, "receiptHash">): string {
  return canonical({
    namespace: "equal-handover-transfer-receipt-v2",
    id: receipt.id,
    handoverDocumentId: receipt.handoverDocumentId,
    outgoingShiftId: receipt.outgoingShiftId,
    incomingShiftId: receipt.incomingShiftId,
    finalRevision: receipt.finalRevision,
    finalSnapshotHash: receipt.finalSnapshotHash,
    boundReportId: receipt.boundReportId,
    boundReportVersion: receipt.boundReportVersion,
    actorUid: receipt.actorUid,
    actorRole: receipt.actorRole,
    transferredAt: receipt.transferredAt,
  });
}

// Replay re-derives every deterministic field from the stored receipt and the
// now-completed aggregate; anything inconsistent is an administrator-review
// condition, never a silent success.
function assertEqualHandoverTransferReceipt(
  value: unknown,
  aggregate: EqualHandoverAggregate,
  documentId: string,
  receiptId: string,
): EqualHandoverTransferReceipt {
  const receipt = hydrateTimestamps(value) as EqualHandoverTransferReceipt | undefined;
  const inconsistent = "Existing v2 transfer receipt is inconsistent; administrator review required.";
  if (!receipt || receipt.id !== receiptId || receipt.schema !== "equal-handover-transfer-v2" ||
      receipt.action !== "EQUAL_SHIFT_HANDOVER_TRANSFERRED_V2" || receipt.outcome !== "TRANSFERRED" ||
      receipt.protocol !== "equal-handover-v2" || receipt.handoverDocumentId !== documentId ||
      receipt.outgoingShiftId !== aggregate.identity.outgoingShiftId ||
      receipt.incomingShiftId !== aggregate.identity.incomingShiftId ||
      receipt.finalRevision !== aggregate.revision ||
      receipt.finalSnapshotHash !== createEqualHandoverSnapshot(aggregate).snapshotHash ||
      receipt.actorRole !== "technician" ||
      typeof receipt.transferredAt !== "string" || !Number.isFinite(Date.parse(receipt.transferredAt))) {
    fail(inconsistent, 409);
  }
  if (aggregate.reportBinding === null || receipt.boundReportId !== aggregate.reportBinding.id) {
    fail(inconsistent, 409);
  }
  const { receiptHash, ...material } = receipt;
  if (receiptHash !== createHash("sha256").update(transferReceiptMaterial(material)).digest("hex")) {
    fail(inconsistent, 409);
  }
  return receipt;
}

async function validateEqualHandoverPair(
  transaction: Transaction,
  pairId: string,
  expected: readonly string[],
): Promise<void> {
  const { technicianPairs, technicianPairMemberships } = getOperationalCollections();
  let ids: readonly string[];
  try {
    identifier(pairId);
    ids = readActivePermanentPairTechnicianIds((await transaction.get(technicianPairs.doc(pairId))).data(), pairId);
  } catch { fail("The permanent pair binding is invalid."); }
  if (ids.length !== expected.length || ids.some((uid, index) => uid !== expected[index])) {
    fail("The permanent pair binding changed.");
  }
  for (const uid of ids) {
    const member = (await transaction.get(technicianPairMemberships.doc(uid))).data() as DocumentData | undefined;
    if (!member || member.technicianUid !== uid || member.pairId !== pairId) fail("Invalid permanent pair membership.");
  }
}

function readEqualHandoverParticipantSchedule(
  data: DocumentData | undefined,
  uid: string,
  target: { shiftId: string; status: string; scheduledStart: string; scheduledEnd: string },
): TechnicianScheduleEntry[] {
  if (!data || data.technicianUid !== uid || !Array.isArray(data.entries)) fail("Missing or invalid technician schedule.");
  const entries = data.entries as TechnicianScheduleEntry[];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("Invalid schedule entry.");
    identifier(entry.shiftId);
    if (seen.has(entry.shiftId) || !["scheduled", "active", "handover_pending"].includes(entry.status) ||
        typeof entry.scheduledStart !== "string" || typeof entry.scheduledEnd !== "string") fail("Invalid schedule entry.");
    parseShiftTimeRange(entry.scheduledStart, entry.scheduledEnd);
    seen.add(entry.shiftId);
  }
  const matches = entries.filter((entry) => entry.shiftId === target.shiftId);
  if (matches.length !== 1 || matches[0].status !== target.status ||
      matches[0].scheduledStart !== target.scheduledStart || matches[0].scheduledEnd !== target.scheduledEnd) {
    fail("The handover schedule binding changed.");
  }
  assertNoScheduleConflict(target.scheduledStart, target.scheduledEnd, entries.filter((entry) => entry.shiftId !== target.shiftId));
  return entries;
}

export function parseEqualHandoverTransferRequest(value: unknown): Omit<EqualHandoverTransferInput, "outgoingShiftId" | "actorUid"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid transfer request.", 400);
  const data = value as Record<string, unknown>;
  const fields = ["expectedRevision", "expectedSnapshotHash", "expectedGuardRevision", "expectedFencingEpoch"];
  if (Object.keys(data).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(data, key))) {
    fail("Provide only the reviewed revision, snapshot hash and guard evidence.", 400);
  }
  if (!Number.isSafeInteger(data.expectedRevision) || (data.expectedRevision as number) < 1 ||
      typeof data.expectedSnapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(data.expectedSnapshotHash) ||
      !Number.isSafeInteger(data.expectedGuardRevision) || (data.expectedGuardRevision as number) < 1 ||
      !Number.isSafeInteger(data.expectedFencingEpoch) || (data.expectedFencingEpoch as number) < 1) {
    fail("Invalid transfer revision, snapshot hash or guard evidence.", 400);
  }
  return {
    expectedRevision: data.expectedRevision as number,
    expectedSnapshotHash: data.expectedSnapshotHash,
    expectedGuardRevision: data.expectedGuardRevision as number,
    expectedFencingEpoch: data.expectedFencingEpoch as number,
  };
}

export async function transferEqualHandoverV2(
  input: EqualHandoverTransferInput,
): Promise<EqualHandoverTransferResult> {
  identifier(input.outgoingShiftId);
  identifier(input.actorUid, 128);
  // The strict reviewed-evidence parser guards the HTTP body at the route; the
  // service validates only its own typed contract fields here, never the actor
  // or shift identity the caller already controls server-side.
  const binding = parseEqualHandoverTransferRequest({
    expectedRevision: input.expectedRevision,
    expectedSnapshotHash: input.expectedSnapshotHash,
    expectedGuardRevision: input.expectedGuardRevision,
    expectedFencingEpoch: input.expectedFencingEpoch,
  });
  const { db, shifts, shiftMembers, technicianSchedules, equalHandoversV2, operationalShiftControl } = getOperationalCollections();
  const documentId = createEqualHandoverDocumentId(input.outgoingShiftId);
  const aggregateRef = equalHandoversV2.doc(documentId);
  const receiptId = equalHandoverTransferReceiptId(documentId);
  const receiptRef = db.collection("audit_logs").doc(receiptId);

  return db.runTransaction(async (transaction): Promise<EqualHandoverTransferResult> => {
    // Steps 1-2: every read is issued before the first buffered write.
    const [profileSnapshot, aggregateSnapshot, guardState, receiptSnapshot] = await Promise.all([
      transaction.get(db.collection("users").doc(input.actorUid)),
      transaction.get(aggregateRef),
      readReservationGuardState(transaction, input.outgoingShiftId),
      transaction.get(receiptRef),
    ]);
    if (!aggregateSnapshot.exists) fail("The equal handover reservation was not found.", 404);
    const aggregate = readV2Aggregate(aggregateSnapshot.data(), input.outgoingShiftId);
    const identity = aggregate.identity;
    const incomingId = identity.incomingShiftId;

    // §4/§5: authorization is derived here, never inherited from a readiness
    // read. The actor is an outgoing reserved technician...
    requireOutgoingTechnician(profileSnapshot.data() as Record<string, unknown> | undefined, input.actorUid, aggregate);
    // ...and must be a personally-confirmed, non-absent participant (§11).
    const actorPosition = resolveEqualHandoverParticipants(aggregate).find((item) => item.technicianUid === input.actorUid);
    if (!actorPosition || actorPosition.state !== "confirmed") {
      fail("Only a personally confirmed outgoing technician may complete this handover.", 403);
    }
    // The v2 guard must still own this exact reservation and carry the epoch
    // evidence the caller reviewed.
    const guard = requireV2GuardBinding(
      guardState.guardSnapshot.exists, guardState.guardSnapshot.data(), documentId, aggregate,
    );
    if (guard.guardRevision !== input.expectedGuardRevision || guard.fencingEpoch !== input.expectedFencingEpoch) {
      fail("The reservation guard changed since this handover was reviewed.");
    }

    const finalHash = createEqualHandoverSnapshot(aggregate).snapshotHash;

    // Step 3: retry safety — a completed handover replays its committed receipt
    // before any staleness rejection, provided every durable pointer agrees.
    if (aggregate.lifecycleStatus === "completed") {
      if (!receiptSnapshot.exists) fail("A completed v2 handover is missing its transfer receipt; administrator review required.", 409);
      const receipt = assertEqualHandoverTransferReceipt(hydrateTimestamps(receiptSnapshot.data()), aggregate, documentId, receiptId);
      if (guard.ownerLifecycleState !== "completed" || guard.terminalEvidenceRef !== receiptId) {
        fail("The reservation guard does not confirm this completed transfer.", 409);
      }
      return { status: "ALREADY_TRANSFERRED", replayed: true, receipt, aggregate, snapshotHash: finalHash, outgoingShiftId: input.outgoingShiftId, incomingShiftId: incomingId };
    }
    if (aggregate.lifecycleStatus !== "collecting_confirmations") fail("The handover is closed.");
    if (receiptSnapshot.exists) fail("A transfer receipt already exists for a still-collecting handover; administrator review required.");

    // Step 4: the live operational sources. Read the outgoing Shift, prove the
    // reserved incoming Shift does not yet exist, and take the global control.
    const [outgoingSnapshot, incomingSnapshot, controlSnapshot] = await Promise.all([
      transaction.get(shifts.doc(input.outgoingShiftId)),
      transaction.get(shifts.doc(incomingId)),
      transaction.get(operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID)),
    ]);
    const outgoing = outgoingSnapshot.data() as (Shift & { handoverStartedAt?: string | null }) | undefined;
    if (!outgoing || outgoing.id !== input.outgoingShiftId || outgoing.status !== "handover_pending" ||
        outgoing.actualEnd !== null || typeof outgoing.actualStart !== "string" ||
        !Number.isFinite(Date.parse(outgoing.actualStart)) || typeof outgoing.handoverStartedAt !== "string" ||
        !Number.isFinite(Date.parse(outgoing.handoverStartedAt)) || outgoing.handoverStartedAt < outgoing.actualStart ||
        outgoing.permanentPairId !== identity.outgoingPermanentPairId ||
        !Array.isArray(outgoing.primaryTechnicianIds) || outgoing.primaryTechnicianIds.length !== 2 ||
        outgoing.primaryTechnicianIds.some((uid, index) => uid !== identity.outgoingTechnicianIds[index])) {
      fail("Invalid outgoing handover Shift.");
    }
    parseShiftTimeRange(outgoing.scheduledStart, outgoing.scheduledEnd);
    if (incomingSnapshot.exists) fail("The reserved incoming Shift already exists.");

    let control;
    try {
      control = assertOperationalShiftControl(controlSnapshot.data());
      assertShiftOwnsOperationalSlot(control, input.outgoingShiftId, outgoing.operationalSlotToken, "handover_pending");
      if (control.generation !== identity.outgoingGeneration || control.slotToken.toLowerCase() !== identity.outgoingSlotToken.toLowerCase()) {
        fail("Invalid outgoing control lineage.");
      }
    } catch (error) {
      if (error instanceof AssignmentOperationError) throw error;
      fail("The outgoing Shift no longer owns valid operational control.");
    }

    await validateEqualHandoverPair(transaction, identity.outgoingPermanentPairId, identity.outgoingTechnicianIds);
    await validateEqualHandoverPair(transaction, identity.incomingPermanentPairId, identity.incomingTechnicianIds);

    const [outgoingMemberDocs, incomingMemberDocs] = await Promise.all([
      transaction.get(shiftMembers.where("shiftId", "==", input.outgoingShiftId)),
      transaction.get(shiftMembers.where("shiftId", "==", incomingId)),
    ]);
    if (!incomingMemberDocs.empty) fail("Reserved incoming membership already exists.");
    const currentMembers: DocumentData[] = [];
    for (const document of outgoingMemberDocs.docs) {
      const member = document.data() as DocumentData;
      identifier(member.technicianId, 128);
      if (member.id !== document.id || document.id !== `${input.outgoingShiftId}_${member.technicianId}` ||
          member.shiftId !== input.outgoingShiftId || !["primary", "additional"].includes(member.role) ||
          typeof member.joinedAt !== "string" || !Number.isFinite(Date.parse(member.joinedAt)) ||
          (member.leftAt !== null && (typeof member.leftAt !== "string" || !Number.isFinite(Date.parse(member.leftAt)) || member.leftAt < member.joinedAt))) {
        fail("Invalid outgoing membership.");
      }
      if (member.leftAt === null) currentMembers.push(member);
    }
    for (const uid of identity.incomingTechnicianIds) {
      if ((await transaction.get(shiftMembers.doc(`${incomingId}_${uid}`))).exists) fail("Reserved incoming membership already exists.");
    }

    // Every affected technician — the four reserved participants and any
    // additional current member — must still be an eligible active technician,
    // and their schedule must carry exactly the expected handover entry.
    const requiredUsers = new Set<string>([
      ...identity.outgoingTechnicianIds, ...identity.incomingTechnicianIds,
      ...currentMembers.map((member) => member.technicianId as string),
    ]);
    const schedules = new Map<string, TechnicianScheduleEntry[]>();
    for (const uid of requiredUsers) {
      authorizeTechnicianProfile((await transaction.get(db.collection("users").doc(uid))).data() as Record<string, unknown> | undefined, uid);
      const incoming = identity.incomingTechnicianIds.includes(uid);
      const entries = readEqualHandoverParticipantSchedule(
        (await transaction.get(technicianSchedules.doc(uid))).data(),
        uid,
        incoming
          ? { shiftId: incomingId, status: "scheduled", scheduledStart: identity.scheduledStart, scheduledEnd: identity.scheduledEnd }
          : { shiftId: input.outgoingShiftId, status: "handover_pending", scheduledStart: outgoing.scheduledStart, scheduledEnd: outgoing.scheduledEnd },
      );
      schedules.set(uid, entries);
    }

    // Step 5: re-derive the authoritative review, report-drift and readiness
    // evidence from live sources — the same recomputation the readiness read
    // uses — and refuse a transfer on any unresolved prerequisite.
    const evidence = await readReservationEvidence(transaction, aggregate);
    if (aggregate.revision !== binding.expectedRevision || evidence.snapshotHash !== binding.expectedSnapshotHash) {
      fail("Stale equal handover revision or snapshot.");
    }
    if (!evidence.readiness.ready) {
      fail(`The handover is not ready to transfer: ${evidence.readiness.reasons.join("; ")}`);
    }
    if (evidence.live.content.completeness.blockers.length > 0) {
      fail(`Handover cannot transfer an incomplete report: ${evidence.live.content.completeness.blockers.join("; ")}`);
    }
    const frozenReport = evidence.frozenReport;
    if (frozenReport === null || aggregate.reportBinding === null) {
      fail("Freeze and review the consolidated report before transfer.");
    }

    const now = new Date(Math.max(
      Date.now(),
      Date.parse(aggregate.updatedAt),
      Date.parse(outgoing.actualStart),
      Date.parse(outgoing.handoverStartedAt as string),
      Date.parse(control.updatedAt),
      ...currentMembers.map((member) => Date.parse(member.joinedAt as string)),
    )).toISOString();

    // Step 6: authoritative lifecycle, control and membership transitions.
    assertShiftActivationWindow(identity.scheduledStart, identity.scheduledEnd, new Date(now));
    const completed = completeEqualHandoverTransfer(aggregate, {
      revision: binding.expectedRevision, snapshotHash: binding.expectedSnapshotHash, recordedAt: now, actorUid: input.actorUid,
    });
    let after;
    try {
      after = transferOperationalShiftControl({
        currentControl: control, outgoingShiftId: input.outgoingShiftId, outgoingSlotToken: identity.outgoingSlotToken,
        outgoingGeneration: identity.outgoingGeneration, incomingShiftId: incomingId, successorSlotToken: identity.successorSlotToken,
        successorGeneration: identity.successorGeneration, transferTimestamp: now,
      });
    } catch (error) {
      if (error instanceof AssignmentOperationError) throw error;
      fail("The operational shift control could not be transferred.");
    }
    let finalizedMembers: ReturnType<typeof finalizeCurrentShiftMemberships>;
    try {
      finalizedMembers = finalizeCurrentShiftMemberships({ shiftId: input.outgoingShiftId, completedAt: now, members: currentMembers });
    } catch (error) {
      if (error instanceof AssignmentOperationError) throw error;
      fail("Outgoing shift memberships could not be finalized.");
    }

    // Steps 7+: writes only — no reads follow the first write.
    transaction.set(aggregateRef, completed);
    transaction.update(shifts.doc(input.outgoingShiftId), {
      status: "completed", actualEnd: now, completedBy: input.actorUid,
      completedAt: FieldValue.serverTimestamp(), updatedAt: now,
    });
    transaction.create(shifts.doc(incomingId), {
      id: incomingId, operationalSlotToken: identity.successorSlotToken, permanentPairId: identity.incomingPermanentPairId,
      shiftType: identity.shiftType, status: "active", scheduledStart: identity.scheduledStart, scheduledEnd: identity.scheduledEnd,
      actualStart: now, actualEnd: null, primaryTechnicianIds: identity.incomingTechnicianIds, createdBy: input.actorUid,
      createdAt: now, updatedAt: now, startedBy: input.actorUid, startedAt: FieldValue.serverTimestamp(),
      previousShiftId: input.outgoingShiftId, previousOperationalSlotToken: identity.outgoingSlotToken,
      operationalGeneration: identity.successorGeneration, handoverDocumentId: documentId,
    });
    for (const member of finalizedMembers) transaction.update(shiftMembers.doc(member.id), { leftAt: now });
    for (const uid of identity.incomingTechnicianIds) {
      transaction.create(shiftMembers.doc(`${incomingId}_${uid}`), {
        id: `${incomingId}_${uid}`, shiftId: incomingId, technicianId: uid, role: "primary", joinedAt: now, leftAt: null,
      });
    }
    for (const [uid, entries] of schedules) {
      const incoming = identity.incomingTechnicianIds.includes(uid);
      transaction.update(technicianSchedules.doc(uid), {
        entries: incoming
          ? entries.map((entry) => (entry.shiftId === incomingId ? { ...entry, status: "active" } : entry))
          : entries.filter((entry) => entry.shiftId !== input.outgoingShiftId),
        updatedAt: now,
      });
    }
    transaction.set(operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID), after);
    await completeReservationGuard(transaction, {
      outgoingShiftId: input.outgoingShiftId, protocolOwner: "v2",
      expectedGuardRevision: guard.guardRevision, expectedFencingEpoch: guard.fencingEpoch,
      receiptId, outgoingSlotToken: identity.outgoingSlotToken, outgoingGeneration: identity.outgoingGeneration,
      successorSlotToken: identity.successorSlotToken, successorGeneration: identity.successorGeneration,
      recordedAt: now, actorUid: input.actorUid,
    }, guardState);
    const receiptMaterialBase: Omit<EqualHandoverTransferReceipt, "receiptHash"> = {
      id: receiptId, schema: "equal-handover-transfer-v2", action: "EQUAL_SHIFT_HANDOVER_TRANSFERRED_V2",
      outcome: "TRANSFERRED", protocol: "equal-handover-v2", handoverDocumentId: documentId,
      outgoingShiftId: input.outgoingShiftId, incomingShiftId: incomingId, finalRevision: aggregate.revision,
      finalSnapshotHash: finalHash, boundReportId: frozenReport.id, boundReportVersion: frozenReport.version,
      actorUid: input.actorUid, actorRole: "technician", transferredAt: now,
      operationalControlBefore: control, operationalControlAfter: after,
    };
    const receipt: EqualHandoverTransferReceipt = {
      ...receiptMaterialBase,
      receiptHash: createHash("sha256").update(transferReceiptMaterial(receiptMaterialBase)).digest("hex"),
    };
    transaction.create(receiptRef, { ...receipt, createdAt: FieldValue.serverTimestamp() });
    for (const uid of requiredUsers) {
      transaction.update(db.collection("users").doc(uid), {
        lastAssignmentActivityAt: FieldValue.serverTimestamp(),
        ...(uid === input.actorUid ? { lastOperationalActivityAt: FieldValue.serverTimestamp() } : {}),
      });
    }

    return {
      status: "TRANSFERRED", replayed: false, receipt, aggregate: completed,
      snapshotHash: createEqualHandoverSnapshot(completed).snapshotHash,
      outgoingShiftId: input.outgoingShiftId, incomingShiftId: incomingId,
    };
  });
}
