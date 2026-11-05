// Synthetic exports only. No emulator clients, account credentials, or live files.
import * as fs from "node:fs/promises";
import path from "node:path";
import { maskedCrc } from "../../scripts/snapshots/firestore-export.mjs";
import { PROJECT, SHIFT, MILESTONES, digest } from "../../scripts/snapshots/09m-snapshots.mjs";
import { createEqualHandover, createEqualHandoverSnapshot, getEqualHandoverPositions, confirmEqualHandoverParticipant, commitEqualHandoverOutgoingTransfer, activateEqualHandoverIncomingTransfer } from "../../src/lib/operations/equal-technician-handover-domain.ts";
import { createInitialReservationGuard } from "../../src/lib/operations/handover-reservation-guard-domain.ts";
import { digestEqualHandoverReportV2Content, buildEqualHandoverReportV2Binding } from "../../src/lib/operations/equal-handover-report-domain.ts";
import { EQUAL_HANDOVER_REPORT_V2_SCHEMA, EQUAL_HANDOVER_REPORT_CONTENT_V2_SCHEMA, EQUAL_HANDOVER_REPORT_PREPARATION_V2_SCHEMA } from "../../src/types/handover-report-v2.ts";
import { createPendingAttendanceOperation, buildAttendanceEvidence } from "../../src/lib/operations/attendance-evidence-domain.ts";

const at = "2026-10-23T12:00:00.000Z", end = "2026-10-23T20:00:00.000Z";
const token = "10000000-0000-4000-8000-000000000001", successor = "20000000-0000-4000-8000-000000000002";
const out = ["out-a", "out-b"], incoming = ["in-a", "in-b"];
export function documentsFor(checkpoint = MILESTONES[4], shiftId = SHIFT) {
  const stage = MILESTONES.indexOf(checkpoint), docs = new Map();
  const set = (collection, id, data) => docs.set(`${collection}/${id}`, data);
  for (const uid of [...out, ...incoming, "supervisor", "admin"]) set("users", uid, { uid, role: out.includes(uid) || incoming.includes(uid) ? "technician" : uid, status: "active" });
  for (const [id, ids] of [["pair-out", out], ["pair-in", incoming]]) {
    set("technician_pairs", id, { id, technicianIds: ids, status: "active" });
    for (const uid of ids) set("technician_pair_memberships", uid, { technicianUid: uid, pairId: id });
  }
  const shift = { id: shiftId, permanentPairId: "pair-out", primaryTechnicianIds: out, status: stage >= 2 ? "handover_pending" : "active", scheduledStart: at, scheduledEnd: end, actualStart: at, actualEnd: null, operationalSlotToken: token, ...(stage >= 2 ? { handoverStartedAt: at, handoverStartedBy: out[0] } : {}) };
  set("shifts", shiftId, shift);
  const control = { shiftId, shiftStatus: shift.status, slotToken: token, generation: 1 };
  set("operational_shift_control", "global", control);
  for (const uid of out) {
    const id = `${shiftId}_${uid}`;
    set("shift_members", id, { id, shiftId, technicianId: uid, role: "primary", joinedAt: at, leftAt: null });
    set("shift_attendance", id, { id, shiftId, technicianId: uid, status: "present", clockIn: null, clockOut: null, recordedAt: at });
  }
  if (stage >= 1) set("shift_operation_events", "event", { id: "event", recordId: "event", shiftId, kind: "no_ob", provenance: "authenticated_technician", authorUid: out[0], originalReporterUid: out[0], createdAt: at, occurredAt: at });
  if (stage < 3) return docs;
  let aggregate = createEqualHandover({ identity: { schema: "equal-handover-v2", outgoingShiftId: shiftId, outgoingPermanentPairId: "pair-out", outgoingTechnicianIds: out, outgoingSlotToken: token, outgoingGeneration: 1, incomingShiftId: "incoming", incomingPermanentPairId: "pair-in", incomingTechnicianIds: incoming, successorSlotToken: successor, successorGeneration: 2, shiftType: "morning", scheduledStart: at, scheduledEnd: end }, reservedAt: at, reservedBy: out[0] });
  const handoverDocumentId = `handover_v2_${shiftId}`, reservationId = aggregate.reservation.handoverId;
  const guard = createInitialReservationGuard({ outgoingShiftId: shiftId, protocolOwner: "v2", ownerHandoverDocumentId: handoverDocumentId, outgoingSlotToken: token, outgoingGeneration: 1, successorSlotToken: successor, successorGeneration: 2, reservationId, reservedIncomingShiftId: "incoming", reservedAt: at, reservedBy: out[0] });
  set("handover_reservation_guards", guard.id, guard);
  for (const uid of incoming) set("technician_schedules", uid, { technicianUid: uid, entries: [{ shiftId: "incoming", scheduledStart: at, scheduledEnd: end, status: "scheduled" }] });
  set("equal_handovers_v2", handoverDocumentId, aggregate);
  if (stage < 4) return docs;
  const participants = getEqualHandoverPositions(aggregate.identity).map(p => ({ position: p.position, side: p.side, uid: p.technicianUid, name: p.technicianUid })).sort((a, b) => a.position.localeCompare(b.position));
  const content = {
    schema: EQUAL_HANDOVER_REPORT_CONTENT_V2_SCHEMA, outgoingShiftId: shiftId, handoverDocumentId, reservationId,
    staff: { shiftId, shiftDate: at.slice(0, 10), shiftType: "morning", scheduledStart: at, scheduledEnd: end, actualStart: at, engineeringLocation: null, handoverStartedAt: at, incomingShiftId: "incoming" },
    participants, slotLineage: { outgoingSlotToken: token, outgoingGeneration: 1, successorSlotToken: successor, successorGeneration: 2 },
    attendance: participants.map(p => ({ ...p, clockIn: null, clockOut: null, reportingEvidence: null, legacyAttendance: null, hoursWorked: null, payableHours: "policy_unresolved", departureProvenance: null, absenceDeclared: null })),
    operations: { shiftId, writable: false, stations: [], events: [], latest: [], broadcast: [], completeness: { broadcastMissing: [], outsideBroadcast: "declared_none" } },
    pendingTasks: [], terminalTaskEvidence: [], workSnapshot: { schema: "handover-work-v2", id: shiftId, version: "a".repeat(64) }, absences: [], completeness: { blockers: [], warnings: [] }, corrections: [],
  };
  const contentDigest = digestEqualHandoverReportV2Content(content), evidenceSnapshotHash = "b".repeat(64), preparationId = `preparation_${reservationId}`;
  const preparation = { schema: EQUAL_HANDOVER_REPORT_PREPARATION_V2_SCHEMA, id: preparationId, outgoingShiftId: shiftId, handoverDocumentId, reservationId, aggregateRevision: 1, aggregateSnapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, guardProtocolOwner: "v2", guardRevision: guard.guardRevision, fencingEpoch: guard.fencingEpoch, preparationRevision: 1, content, evidenceSnapshotHash, contentDigest, workSnapshotVersion: content.workSnapshot.version, blockers: [], warnings: [], preparedBy: out[0], createdAt: at, updatedAt: at, revisionHistory: [{ preparationRevision: 1, contentDigest, evidenceSnapshotHash, preparedBy: out[0], preparedAt: at, reason: null }] };
  set("handover_report_preparations_v2", preparationId, preparation);
  if (stage < 5) return docs;
  const frozen = { schema: EQUAL_HANDOVER_REPORT_V2_SCHEMA, id: "report_v2_10000000-0000-4000-8000-000000000001", version: 1, supersedesReportId: null, outgoingShiftId: shiftId, handoverDocumentId, reservationId, digest: contentDigest, evidenceSnapshotHash, workSnapshotVersion: content.workSnapshot.version, preparationId, preparationRevision: 1, aggregateRevision: 1, aggregateSnapshotHash: preparation.aggregateSnapshotHash, guardRevision: guard.guardRevision, fencingEpoch: guard.fencingEpoch, participants, absences: [], content, reason: "Synthetic reviewed report", correctionNote: null, frozenBy: out[0], frozenAt: at };
  frozen.binding = buildEqualHandoverReportV2Binding(frozen);
  set("handover_reports_v2", frozen.id, frozen);
  aggregate.reportBinding = frozen.binding;
  if (stage >= 6) for (const uid of stage >= 7 ? [...out, ...incoming] : out) aggregate = confirmEqualHandoverParticipant(aggregate, { actorUid: uid, technicianUid: uid, revision: aggregate.revision, snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, recordedAt: at });
  if (stage >= 7) {
    aggregate = commitEqualHandoverOutgoingTransfer(aggregate, { actorUid: out[0], revision: aggregate.revision, snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, recordedAt: at });
    const material = { namespace: "equal-handover-commit-receipt-v2", id: "commit", handoverDocumentId, outgoingShiftId: shiftId, incomingShiftId: "incoming", finalRevision: aggregate.revision, finalSnapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, boundReportId: frozen.id, boundReportVersion: frozen.version, actorUid: out[0], actorRole: "technician", committedAt: at };
    const { namespace: ignoredNamespace, ...receipt } = material;
    void ignoredNamespace;
    set("audit_logs", "commit", { ...receipt, schema: "equal-handover-commit-v2", action: "EQUAL_HANDOVER_OUTGOING_COMMITTED_V2", outcome: "AWAITING_INCOMING_ACCEPTANCE", protocol: "equal-handover-v2", receiptHash: digest(material) });
  }
  if (stage >= 8) {
    aggregate = activateEqualHandoverIncomingTransfer(aggregate, { actorUid: incoming[0], revision: aggregate.revision, snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, recordedAt: at });
    shift.status = "completed"; shift.actualEnd = at;
    set("shifts", "incoming", { id: "incoming", status: "active", previousShiftId: shiftId, actualStart: at });
    Object.assign(control, { shiftId: "incoming", shiftStatus: "active", slotToken: successor, generation: 2 });
    set("shift_members", "incoming_in-a", { id: "incoming_in-a", shiftId: "incoming", technicianId: incoming[0], role: "primary" });
    set("shift_attendance", "incoming_in-a", { id: "incoming_in-a", shiftId: "incoming", technicianId: incoming[0], status: "present" });
    const pending = createPendingAttendanceOperation({ schema: "attendance-evidence-v2", handoverId: reservationId, handoverDocumentId, eventId: "personal-acceptance", position: "incoming_tech_a", technicianUid: incoming[0], kind: "incoming_clock_in", scheduledStart: at, scheduledEnd: end, reportedDepartureTime: null, attestedByUid: null, attestationReason: null, lateReason: null, handoverRevision: aggregate.revision, snapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, expectedGuardRevision: guard.guardRevision, expectedFencingEpoch: guard.fencingEpoch });
    const personal = buildAttendanceEvidence({ operation: pending, serverTime: at, guard, reservation: aggregate.reservation, identity: aggregate.identity, trustedAuthentication: { verifiedTechnicianUid: incoming[0], method: "personal_password_confirmation" } });
    set("attendance_evidence_v2", personal.id, personal);
    set("attendance_evidence_operations_v2", pending.id, { ...pending, status: "finalized", finalizedAt: at });
    const material = { namespace: "equal-handover-activation-receipt-v2", id: "activation", handoverDocumentId, outgoingShiftId: shiftId, incomingShiftId: "incoming", finalRevision: aggregate.revision, finalSnapshotHash: createEqualHandoverSnapshot(aggregate).snapshotHash, boundReportId: frozen.id, actorUid: incoming[0], actorRole: "technician", activatedAt: at };
    const { namespace: ignoredNamespace, ...receipt } = material;
    void ignoredNamespace;
    set("audit_logs", "activation", { ...receipt, schema: "equal-handover-activation-v2", action: "EQUAL_SHIFT_ACTIVATED_INCOMING_V2", outcome: "INCOMING_ACTIVATED", protocol: "equal-handover-v2", receiptHash: digest(material) });
  }
  set("equal_handovers_v2", handoverDocumentId, aggregate);
  return docs;
}

const vi = n => { n = BigInt(n); const a = []; do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); };
const n = (id, value) => Buffer.concat([vi(id * 8), vi(value)]);
const s = (id, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([vi(id * 8 + 2), vi(bytes.length), bytes]); };
function properties(data) {
  const result = [];
  for (const [key, raw] of Object.entries(data)) {
    const array = Array.isArray(raw), values = array && raw.length ? raw : [raw];
    for (const value of values) {
      let meaning = 0, encoded = Buffer.alloc(0);
      if (array && !raw.length) meaning = 24;
      else if (value !== null && typeof value === "object") { meaning = 19; encoded = s(3, Buffer.concat(properties(value))); }
      else if (typeof value === "string") encoded = s(3, value);
      else if (typeof value === "boolean") encoded = n(2, Number(value));
      else if (typeof value === "number") encoded = n(1, value);
      result.push(s(15, Buffer.concat([...(meaning ? [n(1, meaning)] : []), s(3, key), n(4, Number(array)), s(5, encoded)])));
    }
  }
  return result;
}
function encodedEntity(key, data, project) {
  const [collection, id] = key.split("/");
  const keyPath = Buffer.concat([vi(11), s(2, collection), s(4, id), vi(12)]);
  return Buffer.concat([s(13, Buffer.concat([s(13, "dev~" + project), s(14, keyPath)])), ...properties(data)]);
}
export function logRecords(records) {
  const chunks = []; let offset = 0;
  for (const record of records) {
    let p = 0, first = true;
    do {
      const room = 32768 - offset % 32768;
      if (room < 7) { chunks.push(Buffer.alloc(room)); offset += room; }
      const length = Math.min(record.length - p, 32768 - offset % 32768 - 7);
      const last = p + length === record.length, type = first ? (last ? 1 : 2) : last ? 4 : 3;
      const payload = record.subarray(p, p + length), header = Buffer.alloc(7);
      header.writeUInt32LE(maskedCrc(Buffer.concat([Buffer.from([type]), payload]))); header.writeUInt16LE(length, 4); header[6] = type;
      chunks.push(header, payload); offset += length + 7; p += length; first = false;
    } while (p < record.length);
  }
  return Buffer.concat(chunks);
}
export async function writeExport(directory, docs = documentsFor(), project = PROJECT) {
  const shard = "firestore_export/all_namespaces/all_kinds/";
  await fs.mkdir(path.join(directory, shard), { recursive: true }); await fs.mkdir(path.join(directory, "auth_export"));
  await fs.writeFile(path.join(directory, "firebase-export-metadata.json"), JSON.stringify({ version: "15.34.0", auth: { version: "15.34.0", path: "auth_export" }, firestore: { version: "1.22.0", path: "firestore_export", metadata_file: "firestore_export/firestore_export.overall_export_metadata" } }));
  await fs.writeFile(path.join(directory, "auth_export/accounts.json"), JSON.stringify({ users: [...out, ...incoming, "supervisor", "admin"].map(localId => ({ localId })) }));
  await fs.writeFile(path.join(directory, "auth_export/config.json"), "{}");
  await fs.writeFile(path.join(directory, shard, "output-0"), logRecords([...docs].map(([key, data]) => encodedEntity(key, data, project))));
  await fs.writeFile(path.join(directory, shard, "all_namespaces_all_kinds.export_metadata"), Buffer.concat([s(1, s(1, "firestore_export")), s(2, s(2, "output-0"))]));
  await fs.writeFile(path.join(directory, "firestore_export/firestore_export.overall_export_metadata"), logRecords([Buffer.from("3"), s(1, Buffer.concat([s(2, "all_namespaces/all_kinds/all_namespaces_all_kinds.export_metadata"), n(3, docs.size)]))]));
}
