import { createHash } from "node:crypto";
import type {
  EqualHandoverPreparationRevisionEntry,
  EqualHandoverReportPreparationV2,
  EqualHandoverReportV2AttendanceRow,
  EqualHandoverReportV2Binding,
  EqualHandoverReportV2Content,
  EqualHandoverReportV2Participant,
  EqualHandoverReportV2PendingTask,
  EqualHandoverReportV2TerminalTask,
  FrozenEqualHandoverReportV2,
} from "@/types/handover-report-v2";
import {
  EQUAL_HANDOVER_REPORT_CONTENT_V2_SCHEMA,
  EQUAL_HANDOVER_REPORT_PREPARATION_V2_SCHEMA,
  EQUAL_HANDOVER_REPORT_V2_SCHEMA,
} from "@/types/handover-report-v2";
import {
  EQUAL_ABSENCE_TYPES,
  EQUAL_HANDOVER_POSITIONS,
  EQUAL_HANDOVER_SIDES,
  type EqualHandoverAbsence,
} from "@/types/equal-technician-handover";

export class EqualHandoverReportDomainError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "EqualHandoverReportDomainError";
    this.status = status;
  }
}

function fail(message: string, status = 409): never {
  throw new EqualHandoverReportDomainError(message, status);
}

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`Malformed ${label}.`, 400);
  }
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(data, key))
  ) {
    fail(`Malformed ${label}: missing or unsupported fields.`, 400);
  }
  return data;
}

function identifier(value: unknown, label: string, max = 512): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > max ||
    value.includes("/") ||
    value === "." ||
    value === ".."
  ) {
    fail(`Invalid ${label}.`, 400);
  }
}

function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`Invalid ${label}.`, 400);
  }
}

function nonNegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`Invalid ${label}.`, 400);
  }
}

function hex64(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`Invalid ${label}.`, 400);
  }
}

/**
 * §6 serialization boundary: Firestore `Timestamp`, `Date` and canonical ISO
 * strings are all hydrated to one canonical ISO representation before any
 * domain or digest work, so a value that round-tripped through Firestore can
 * never silently change representation (the lost TECH-HO-16A `createdAt`
 * regression) and hashing stays deterministic across read/write cycles.
 */
export function canonicalizeTimestamp(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString();
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { seconds?: unknown }).seconds === "number" &&
    typeof (value as { nanoseconds?: unknown }).nanoseconds === "number"
  ) {
    const raw = value as { seconds: number; nanoseconds: number };
    return new Date(raw.seconds * 1000 + Math.floor(raw.nanoseconds / 1_000_000)).toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  fail(`Invalid ${label}.`, 400);
}

function canonicalTimestamp(value: unknown, label: string): string {
  const iso = canonicalizeTimestamp(value, label);
  if (typeof value === "string" && value !== iso) {
    fail(`Non-canonical ${label}.`, 400);
  }
  return iso;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return canonicalTimestamp(value, label);
}

function text(value: unknown, label: string, max = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail(`Invalid ${label}.`, 400);
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) fail("Unsupported report evidence: undefined.", 400);
  if (typeof value === "number" && !Number.isFinite(value)) fail("Unsupported report evidence.", 400);
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    fail("Unsupported report evidence.", 400);
  }
  return JSON.stringify(value);
}

export function digestHandoverReportEvidence(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function isSortedBy<T>(items: readonly T[], keyOf: (item: T) => string, label: string): void {
  for (let index = 1; index < items.length; index += 1) {
    if (keyOf(items[index - 1]!) >= keyOf(items[index]!)) {
      fail(`Report evidence must be deterministically sorted: ${label}.`, 400);
    }
  }
}

const positionValues = Object.values(EQUAL_HANDOVER_POSITIONS) as string[];
const absenceTypeValues = Object.values(EQUAL_ABSENCE_TYPES) as string[];

function assertAbsenceEvidence(value: unknown): EqualHandoverAbsence {
  const data = record(value, [
    "position", "technicianUid", "absenceType", "reportedDepartureTime",
    "recordedBy", "attestedByUid", "reason", "recordedRevision", "revision", "recordedAt",
  ], "absence declaration");
  if (!positionValues.includes(data.position as string)) fail("Invalid absence position.", 400);
  if (!absenceTypeValues.includes(data.absenceType as string)) fail("Invalid absence type.", 400);
  identifier(data.technicianUid, "absence technician UID", 128);
  identifier(data.recordedBy, "absence recordedBy UID", 128);
  if (data.attestedByUid !== null) identifier(data.attestedByUid, "absence attestedBy UID", 128);
  text(data.reason, "absence reason", 1_000);
  positive(data.recordedRevision, "absence recorded revision");
  positive(data.revision, "absence revision");
  canonicalTimestamp(data.recordedAt, "absence recorded time");
  if (data.reportedDepartureTime !== null) {
    canonicalTimestamp(data.reportedDepartureTime, "absence reported departure time");
  }
  return data as unknown as EqualHandoverAbsence;
}

const contentFields = [
  "schema", "outgoingShiftId", "handoverDocumentId", "reservationId", "staff", "participants",
  "slotLineage", "attendance", "operations", "pendingTasks", "terminalTaskEvidence",
  "workSnapshot", "absences", "completeness", "corrections",
] as const;

export function assertEqualHandoverReportV2Content(value: unknown): EqualHandoverReportV2Content {
  const data = record(value, contentFields, "v2 report content");
  if (data.schema !== EQUAL_HANDOVER_REPORT_CONTENT_V2_SCHEMA) fail("Invalid v2 report content schema.", 400);
  identifier(data.outgoingShiftId, "outgoing shift ID");
  identifier(data.handoverDocumentId, "v2 handover document ID");
  identifier(data.reservationId, "reservation fingerprint");

  const staff = record(data.staff, [
    "shiftId", "shiftDate", "shiftType", "scheduledStart", "scheduledEnd", "actualStart",
    "engineeringLocation", "handoverStartedAt", "incomingShiftId",
  ], "report staff section");
  identifier(staff.shiftId, "report shift ID");
  if (staff.shiftId !== data.outgoingShiftId) fail("Report staff shift does not match the outgoing shift.", 400);
  if (typeof staff.shiftDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(staff.shiftDate)) {
    fail("Invalid report shift date.", 400);
  }
  text(staff.shiftType, "report shift type", 80);
  canonicalTimestamp(staff.scheduledStart, "scheduled start");
  canonicalTimestamp(staff.scheduledEnd, "scheduled end");
  nullableTimestamp(staff.actualStart, "actual start");
  nullableTimestamp(staff.handoverStartedAt, "handover started time");
  if (staff.engineeringLocation !== null && typeof staff.engineeringLocation !== "string") {
    fail("Invalid engineering location.", 400);
  }
  if (staff.incomingShiftId !== null) identifier(staff.incomingShiftId, "incoming shift ID");

  if (!Array.isArray(data.participants) || data.participants.length !== 4) {
    fail("Report must bind exactly four participant identities.", 400);
  }
  const participants = data.participants.map((item) => {
    const participant = record(item, ["position", "side", "uid", "name"], "report participant");
    if (!positionValues.includes(participant.position as string)) fail("Invalid participant position.", 400);
    if (participant.side !== EQUAL_HANDOVER_SIDES.OUTGOING && participant.side !== EQUAL_HANDOVER_SIDES.INCOMING) {
      fail("Invalid participant side.", 400);
    }
    identifier(participant.uid, "participant UID", 128);
    if (participant.name !== null) text(participant.name, "participant name", 300);
    return participant as unknown as EqualHandoverReportV2Participant;
  });
  isSortedBy(participants, (item) => item.position, "participants");

  const slotLineage = record(data.slotLineage, [
    "outgoingSlotToken", "outgoingGeneration", "successorSlotToken", "successorGeneration",
  ], "report slot lineage");
  identifier(slotLineage.outgoingSlotToken, "outgoing slot token", 64);
  identifier(slotLineage.successorSlotToken, "successor slot token", 64);
  nonNegative(slotLineage.outgoingGeneration, "outgoing generation");
  positive(slotLineage.successorGeneration, "successor generation");

  if (!Array.isArray(data.attendance) || data.attendance.length !== 4) {
    fail("Report attendance must cover exactly the four participants.", 400);
  }
  const attendance = data.attendance.map((item) => {
    const row = record(item, [
      "position", "side", "uid", "name", "clockIn", "clockOut", "reportingEvidence",
      "legacyAttendance", "hoursWorked", "payableHours", "departureProvenance", "absenceDeclared",
    ], "report attendance row");
    if (!positionValues.includes(row.position as string)) fail("Invalid attendance position.", 400);
    identifier(row.uid, "attendance UID", 128);
    nullableTimestamp(row.clockIn, "attendance clock-in");
    nullableTimestamp(row.clockOut, "attendance clock-out");
    if (row.reportingEvidence !== null) {
      const evidence = record(row.reportingEvidence, [
        "kind", "authenticationMethod", "personallyAuthenticated", "eventTime", "attestedByUid", "lateReason",
      ], "attendance reporting evidence");
      text(evidence.kind, "attendance evidence kind", 80);
      text(evidence.authenticationMethod, "attendance authentication method", 80);
      if (typeof evidence.personallyAuthenticated !== "boolean") fail("Invalid personal authentication flag.", 400);
      nullableTimestamp(evidence.eventTime, "attendance event time");
      if (evidence.attestedByUid !== null) identifier(evidence.attestedByUid, "attestedBy UID", 128);
      if (evidence.lateReason !== null) text(evidence.lateReason, "late reason", 1_000);
    }
    if (row.hoursWorked !== null && (typeof row.hoursWorked !== "number" || !Number.isFinite(row.hoursWorked) || row.hoursWorked < 0)) {
      fail("Invalid hours worked.", 400);
    }
    if (row.payableHours !== null && row.payableHours !== "policy_unresolved") {
      fail("Payable hours treatment must remain an explicit unresolved policy value.", 400);
    }
    if (row.departureProvenance !== null && !["personal", "colleague_attested"].includes(row.departureProvenance as string)) {
      fail("Invalid departure provenance.", 400);
    }
    if (row.absenceDeclared !== null && !absenceTypeValues.includes(row.absenceDeclared as string)) {
      fail("Invalid declared absence type.", 400);
    }
    return row as unknown as EqualHandoverReportV2AttendanceRow;
  });
  isSortedBy(attendance, (item) => item.position, "attendance rows");

  const operations = record(data.operations, [
    "shiftId", "writable", "stations", "events", "latest", "broadcast", "completeness",
  ], "report operations view");
  if (operations.shiftId !== data.outgoingShiftId) fail("Report operations belong to another shift.", 400);
  if (!Array.isArray(operations.events) || !Array.isArray(operations.latest) || !Array.isArray(operations.broadcast)) {
    fail("Malformed report operations evidence.", 400);
  }

  if (!Array.isArray(data.pendingTasks)) fail("Malformed report pending tasks.", 400);
  const pendingTasks = data.pendingTasks.map((item) => {
    const task = record(item, [
      "id", "title", "priority", "status", "assignments", "disposition", "reason", "carryForwardEligible",
    ], "report pending task");
    identifier(task.id, "task ID");
    if (["completed", "cancelled"].includes(task.status as string)) {
      fail("Terminal tasks must not appear in the pending task section.", 400);
    }
    if (!Array.isArray(task.assignments)) fail("Malformed task assignments.", 400);
    if (typeof task.carryForwardEligible !== "boolean") fail("Invalid carry-forward eligibility.", 400);
    return task as unknown as EqualHandoverReportV2PendingTask;
  });
  isSortedBy(pendingTasks, (item) => item.id, "pending tasks");

  if (!Array.isArray(data.terminalTaskEvidence)) fail("Malformed terminal task evidence.", 400);
  const terminalTasks = data.terminalTaskEvidence.map((item) => {
    const task = record(item, ["id", "title", "status", "priority", "updatedAt", "workHash"], "report terminal task");
    identifier(task.id, "task ID");
    if (!["completed", "cancelled"].includes(task.status as string)) {
      fail("Non-terminal task recorded in terminal task evidence.", 400);
    }
    canonicalTimestamp(task.updatedAt, "task updated time");
    hex64(task.workHash, "task work hash");
    return task as unknown as EqualHandoverReportV2TerminalTask;
  });
  isSortedBy(terminalTasks, (item) => item.id, "terminal tasks");

  const workSnapshot = record(data.workSnapshot, ["schema", "id", "version"], "report work snapshot");
  if (workSnapshot.schema !== "handover-work-v2" || workSnapshot.id !== data.outgoingShiftId) {
    fail("Malformed report work snapshot.", 400);
  }
  hex64(workSnapshot.version, "work snapshot version");

  if (!Array.isArray(data.absences)) fail("Malformed report absence declarations.", 400);
  const absences = data.absences.map(assertAbsenceEvidence);
  isSortedBy(absences, (item) => item.position, "absence declarations");

  const completeness = record(data.completeness, ["blockers", "warnings"], "report completeness");
  for (const key of ["blockers", "warnings"] as const) {
    if (!Array.isArray(completeness[key]) || completeness[key].some((item) => typeof item !== "string" || !item.trim())) {
      fail(`Malformed report ${key}.`, 400);
    }
  }

  if (!Array.isArray(data.corrections)) fail("Malformed report corrections.", 400);
  const corrections = data.corrections.map((item) => {
    const correction = record(item, ["id", "note", "recordedBy", "recordedAt"], "report correction");
    identifier(correction.id, "correction ID");
    text(correction.note, "correction note", 4_000);
    identifier(correction.recordedBy, "correction author UID", 128);
    canonicalTimestamp(correction.recordedAt, "correction time");
    return correction;
  });
  isSortedBy(
    corrections,
    (item) => `${item.recordedAt}|${item.id}`,
    "corrections",
  );

  return structuredClone(data) as unknown as EqualHandoverReportV2Content;
}

export function digestEqualHandoverReportV2Content(content: EqualHandoverReportV2Content): string {
  assertEqualHandoverReportV2Content(content);
  return digestHandoverReportEvidence(content);
}

const bindingFields = [
  "schema", "id", "digest", "evidenceSnapshotHash", "workSnapshotVersion", "preparationId",
  "preparationRevision", "reservationId", "aggregateRevision", "fencingEpoch", "frozenBy", "frozenAt",
] as const;

export function assertEqualHandoverReportV2Binding(value: unknown): EqualHandoverReportV2Binding {
  const data = record(value, bindingFields, "v2 report binding");
  if (data.schema !== EQUAL_HANDOVER_REPORT_V2_SCHEMA) {
    fail("A v2 handover aggregate cannot bind a legacy v1 report schema.", 409);
  }
  identifier(data.id, "frozen report ID");
  if (!/^report_v2_[0-9a-f-]{36}$/.test(data.id)) fail("Malformed v2 frozen report ID.", 400);
  hex64(data.digest, "report content digest");
  hex64(data.evidenceSnapshotHash, "evidence snapshot hash");
  hex64(data.workSnapshotVersion, "work snapshot version");
  if (!/^preparation_handover_v2_[0-9a-f]{64}$/.test(String(data.preparationId))) {
    fail("Malformed v2 preparation document ID.", 400);
  }
  positive(data.preparationRevision, "preparation revision");
  if (!/^handover_v2_[0-9a-f]{64}$/.test(String(data.reservationId))) {
    fail("Malformed reservation fingerprint in report binding.", 400);
  }
  positive(data.aggregateRevision, "aggregate revision");
  positive(data.fencingEpoch, "guard fencing epoch");
  identifier(data.frozenBy, "freezing technician UID", 128);
  canonicalTimestamp(data.frozenAt, "freeze time");
  return data as unknown as EqualHandoverReportV2Binding;
}

const preparationFields = [
  "schema", "id", "outgoingShiftId", "handoverDocumentId", "reservationId", "aggregateRevision",
  "aggregateSnapshotHash", "guardProtocolOwner", "guardRevision", "fencingEpoch", "preparationRevision",
  "content", "evidenceSnapshotHash", "contentDigest", "workSnapshotVersion", "blockers", "warnings",
  "preparedBy", "createdAt", "updatedAt", "revisionHistory",
] as const;

export function assertEqualHandoverReportPreparationV2(value: unknown): EqualHandoverReportPreparationV2 {
  const data = record(value, preparationFields, "v2 report preparation");
  if (data.schema !== EQUAL_HANDOVER_REPORT_PREPARATION_V2_SCHEMA) fail("Invalid v2 preparation schema.", 400);
  if (data.id !== createEqualHandoverPreparationDocumentId(data.reservationId)) {
    fail("Preparation document ID does not match the reservation fingerprint.", 400);
  }
  if (data.handoverDocumentId !== `handover_v2_${data.outgoingShiftId}`) {
    fail("Preparation is bound to a different v2 handover document.", 400);
  }
  identifier(data.reservationId, "reservation fingerprint");
  positive(data.aggregateRevision, "aggregate revision");
  hex64(data.aggregateSnapshotHash, "aggregate snapshot hash");
  if (data.guardProtocolOwner !== "v2") fail("Preparation requires v2 guard ownership.", 409);
  positive(data.guardRevision, "guard revision");
  positive(data.fencingEpoch, "guard fencing epoch");
  positive(data.preparationRevision, "preparation revision");
  const content = assertEqualHandoverReportV2Content(data.content);
  if (
    content.outgoingShiftId !== data.outgoingShiftId ||
    content.handoverDocumentId !== data.handoverDocumentId ||
    content.reservationId !== data.reservationId
  ) {
    fail("Preparation content is bound to a different reservation.", 409);
  }
  hex64(data.evidenceSnapshotHash, "evidence snapshot hash");
  hex64(data.contentDigest, "content digest");
  if (data.contentDigest !== digestHandoverReportEvidence(content)) {
    fail("Preparation content digest does not match its content.", 409);
  }
  hex64(data.workSnapshotVersion, "work snapshot version");
  if (data.workSnapshotVersion !== content.workSnapshot.version) {
    fail("Preparation work snapshot version does not match its content.", 409);
  }
  for (const key of ["blockers", "warnings"] as const) {
    if (!Array.isArray(data[key]) || (data[key] as unknown[]).some((item) => typeof item !== "string")) {
      fail(`Malformed preparation ${key}.`, 400);
    }
    const fromContent = (content.completeness as Record<string, unknown>)[key];
    if (canonical(data[key]) !== canonical(fromContent)) fail(`Preparation ${key} diverge from content.`, 409);
  }
  identifier(data.preparedBy, "preparation actor UID", 128);
  const createdAt = canonicalTimestamp(data.createdAt, "preparation created time");
  const updatedAt = canonicalTimestamp(data.updatedAt, "preparation updated time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("Contradictory preparation timestamps.", 400);
  if (!Array.isArray(data.revisionHistory)) fail("Malformed preparation revision history.", 400);
  const history = data.revisionHistory.map((item) => {
    const entry = record(item, [
      "preparationRevision", "contentDigest", "evidenceSnapshotHash", "preparedBy", "preparedAt", "reason",
    ], "preparation revision entry");
    positive(entry.preparationRevision, "historical preparation revision");
    if (typeof entry.reason !== "string" || !entry.reason.trim()) entry.reason = null;
    hex64(entry.contentDigest, "historical content digest");
    hex64(entry.evidenceSnapshotHash, "historical evidence hash");
    identifier(entry.preparedBy, "historical preparation actor UID", 128);
    canonicalTimestamp(entry.preparedAt, "historical preparation time");
    return entry as unknown as EqualHandoverPreparationRevisionEntry;
  });
  if (
    history.length !== data.preparationRevision ||
    history.some((entry, index) => entry.preparationRevision !== index + 1)
  ) {
    fail("Preparation revision history must be contiguous from revision 1.", 409);
  }
  if (history[history.length - 1]!.contentDigest !== data.contentDigest) {
    fail("Preparation revision history must end at the current content digest.", 409);
  }
  return structuredClone(data) as unknown as EqualHandoverReportPreparationV2;
}

const frozenFields = [
  "schema", "id", "version", "supersedesReportId", "outgoingShiftId", "handoverDocumentId",
  "reservationId", "digest", "evidenceSnapshotHash", "workSnapshotVersion", "preparationId",
  "preparationRevision", "aggregateRevision", "aggregateSnapshotHash", "guardRevision", "fencingEpoch",
  "participants", "absences", "content", "reason", "correctionNote", "frozenBy", "frozenAt", "binding",
] as const;

export function assertFrozenEqualHandoverReportV2(value: unknown): FrozenEqualHandoverReportV2 {
  const data = record(value, frozenFields, "frozen v2 report");
  if (data.schema !== EQUAL_HANDOVER_REPORT_V2_SCHEMA) fail("Invalid frozen v2 report schema.", 400);
  identifier(data.id, "frozen report ID");
  if (!/^report_v2_[0-9a-f-]{36}$/.test(data.id)) fail("Malformed frozen v2 report ID.", 400);
  positive(data.version, "frozen report version");
  if (data.supersedesReportId !== null) identifier(data.supersedesReportId, "superseded report ID");
  if (data.version === 1 && data.supersedesReportId !== null) fail("First frozen report cannot supersede another.", 409);
  if (data.version > 1 && data.supersedesReportId === null) fail("Later frozen reports must chain the previous version.", 409);
  identifier(data.outgoingShiftId, "outgoing shift ID");
  if (data.handoverDocumentId !== `handover_v2_${data.outgoingShiftId}`) {
    fail("Frozen report is bound to a different v2 handover document.", 400);
  }
  identifier(data.reservationId, "reservation fingerprint");
  hex64(data.digest, "frozen report digest");
  hex64(data.evidenceSnapshotHash, "frozen evidence snapshot hash");
  hex64(data.workSnapshotVersion, "frozen work snapshot version");
  positive(data.preparationRevision, "frozen preparation revision");
  positive(data.aggregateRevision, "frozen aggregate revision");
  hex64(data.aggregateSnapshotHash, "frozen aggregate snapshot hash");
  positive(data.guardRevision, "frozen guard revision");
  positive(data.fencingEpoch, "frozen guard fencing epoch");
  text(data.reason, "freeze reason", 1_000);
  if (data.correctionNote !== null) text(data.correctionNote, "correction note", 4_000);
  if (data.version > 1 && data.correctionNote === null) {
    fail("A later frozen report version requires an explicit correction note.", 409);
  }
  identifier(data.frozenBy, "freezing technician UID", 128);
  canonicalTimestamp(data.frozenAt, "freeze time");
  const content = assertEqualHandoverReportV2Content(data.content);
  if (data.preparationId !== createEqualHandoverPreparationDocumentId(content.reservationId)) {
    fail("Frozen report preparation ID does not match the reservation.", 409);
  }
  if (data.digest !== digestHandoverReportEvidence(content)) {
    fail("Frozen report digest does not match its content.", 409);
  }
  if (data.workSnapshotVersion !== content.workSnapshot.version) {
    fail("Frozen report work snapshot does not match its content.", 409);
  }
  if (canonical(data.participants) !== canonical(content.participants)) {
    fail("Frozen report participants do not match the content.", 409);
  }
  if (!Array.isArray(data.absences)) fail("Malformed frozen report absence declarations.", 400);
  const absences = (data.absences as unknown[]).map(assertAbsenceEvidence);
  isSortedBy(absences, (item) => item.position, "frozen absence declarations");
  if (canonical(absences) !== canonical(content.absences)) {
    fail("Frozen report absence declarations do not match the content.", 409);
  }
  const binding = assertEqualHandoverReportV2Binding(data.binding);
  if (
    binding.id !== data.id ||
    binding.digest !== data.digest ||
    binding.evidenceSnapshotHash !== data.evidenceSnapshotHash ||
    binding.workSnapshotVersion !== data.workSnapshotVersion ||
    binding.preparationId !== data.preparationId ||
    binding.preparationRevision !== data.preparationRevision ||
    binding.reservationId !== data.reservationId ||
    binding.aggregateRevision !== data.aggregateRevision ||
    binding.fencingEpoch !== data.fencingEpoch ||
    binding.frozenBy !== data.frozenBy ||
    binding.frozenAt !== data.frozenAt
  ) {
    fail("Frozen report binding does not match the report document.", 409);
  }
  return structuredClone(data) as unknown as FrozenEqualHandoverReportV2;
}

export function createEqualHandoverPreparationDocumentId(reservationId: unknown): string {
  identifier(reservationId, "reservation fingerprint");
  if (!/^handover_v2_[0-9a-f]{64}$/.test(reservationId)) fail("Invalid reservation fingerprint.", 400);
  const id = `preparation_${reservationId}`;
  if (new TextEncoder().encode(id).byteLength > 1_500) fail("Preparation document ID exceeds 1500 UTF-8 bytes.", 400);
  return id;
}

/**
 * Deterministic UUID-shaped frozen report ID: unique per (reservation,
 * preparation revision, content digest, chain position) so an identical retry
 * resolves to the same immutable document instead of duplicating reports.
 */
export function createEqualHandoverReportV2Id(material: {
  reservationId: string;
  preparationRevision: number;
  contentDigest: string;
  aggregateRevision: number;
  version: number;
}): string {
  const hex = digestHandoverReportEvidence({
    namespace: "equal-handover-report-freeze-v2",
    ...material,
  });
  const bytes = Buffer.from(hex.slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `report_v2_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function buildEqualHandoverReportV2Binding(
  frozen: Omit<FrozenEqualHandoverReportV2, "binding">,
): EqualHandoverReportV2Binding {
  const binding: EqualHandoverReportV2Binding = {
    schema: EQUAL_HANDOVER_REPORT_V2_SCHEMA,
    id: frozen.id,
    digest: frozen.digest,
    evidenceSnapshotHash: frozen.evidenceSnapshotHash,
    workSnapshotVersion: frozen.workSnapshotVersion,
    preparationId: frozen.preparationId,
    preparationRevision: frozen.preparationRevision,
    reservationId: frozen.reservationId,
    aggregateRevision: frozen.aggregateRevision,
    fencingEpoch: frozen.fencingEpoch,
    frozenBy: frozen.frozenBy,
    frozenAt: frozen.frozenAt,
  };
  return assertEqualHandoverReportV2Binding(binding);
}

/**
 * §6: Firestore writes for v2 report documents must carry canonical ISO
 * strings, never driver-converted `{seconds, nanoseconds}` maps. This helper
 * proves the intent at write time: any value that is not already canonical
 * ISO is rejected rather than silently coerced.
 */
export function assertCanonicalIsoWrite(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`Report writes must be canonical ISO strings: ${label}.`, 400);
  const iso = canonicalTimestamp(value, label);
  if (iso !== value) fail(`Non-canonical timestamp write rejected: ${label}.`, 400);
  return value;
}

export function equalHandoverReportV2FreezeMaterial(frozen: {
  reservationId: string;
  preparationRevision: number;
  digest: string;
  aggregateRevision: number;
  version: number;
}): string {
  return canonical({ namespace: "equal-handover-report-freeze-audit-v2", ...frozen });
}
