import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { decodeFirestoreLog, overallMetadata, kindShards } from "./firestore-export.mjs";
import { assertEqualHandoverAggregate, createEqualHandoverSnapshot } from "../../src/lib/operations/equal-technician-handover-domain.ts";
import { assertHandoverReservationGuard } from "../../src/lib/operations/handover-reservation-guard-domain.ts";
import { assertEqualHandoverReportPreparationV2, assertFrozenEqualHandoverReportV2, digestEqualHandoverReportV2Content as digestEqualHandoverReportContent } from "../../src/lib/operations/equal-handover-report-domain.ts";
import { assertAttendanceEvidence, assertAttendanceOperation } from "../../src/lib/operations/attendance-evidence-domain.ts";

export const PROJECT = "demo-shiftchange-v2-09m";
export const SHIFT = "WfKvXM6ZamF8P4n1lWlA";
export const MANIFEST = "snapshot-manifest.json";
export const MILESTONES = ["base_fixture_created", "operational_evidence_recorded", "handover_initiated", "incoming_pair_reserved", "consolidated_report_prepared", "report_frozen", "outgoing_confirmations_completed", "handover_committed", "incoming_acceptance_activated"];
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : JSON.stringify(value);
export const digest = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const equal = (a, b, label) => assert.equal(canonical(a), canonical(b), label);
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);

async function filesBelow(dir, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "Snapshot symlinks are not allowed");
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(path.join(dir, entry.name), relative + "/"));
    else { assert.ok(entry.isFile(), "Unsupported snapshot file type"); files.push(relative); }
  }
  return files.sort();
}
function inside(dir, relative) {
  assert.ok(typeof relative === "string" && relative && !path.isAbsolute(relative) && !relative.includes("\\"), "Invalid export-relative path");
  const resolved = path.resolve(dir, relative), difference = path.relative(dir, resolved);
  assert.ok(difference && !difference.startsWith("..") && !path.isAbsolute(difference), "Export path escapes snapshot");
  return resolved;
}
async function json(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

// All properties are decoded before inspection. Unsupported encodings never
// produce an apparently verified count or milestone.
export async function readExport(directory, expectedProject = PROJECT) {
  const rootInfo = await fs.lstat(directory);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "Snapshot root must be a real directory");
  const files = await filesBelow(directory);
  assert.ok(files.includes("firebase-export-metadata.json"), "Export metadata is missing");
  const metadata = await json(path.join(directory, "firebase-export-metadata.json"));
  assert.ok(metadata.version && metadata.auth?.path && metadata.firestore?.path && metadata.firestore?.metadata_file, "Incomplete export metadata");
  assert.equal(metadata.firestore.version, "1.22.0", "Unsupported Firestore export version; verification must be extended explicitly");
  const authFile = metadata.auth.path + "/accounts.json";
  const authConfig = metadata.auth.path + "/config.json";
  for (const relative of [authFile, authConfig, metadata.firestore.metadata_file]) {
    inside(directory, relative);
    assert.ok(files.includes(relative), `Required export file missing: ${relative}`);
    assert.ok((await fs.stat(inside(directory, relative))).size > 0, "Empty export metadata file");
  }
  const auth = await json(inside(directory, authFile));
  const config = await json(inside(directory, authConfig));
  assert.ok(config && typeof config === "object", "Invalid Auth export configuration");
  assert.ok(Array.isArray(auth.users) && auth.users.length > 0, "Auth export has no accounts");
  const uids = auth.users.map(user => user.localId);
  assert.ok(uids.every(uid => typeof uid === "string" && uid), "Auth export has an invalid UID");
  assert.equal(new Set(uids).size, uids.length, "Duplicate Auth UIDs");
  assert.ok(auth.users.every(user => user.disabled !== true), "Disabled Auth accounts make this UAT fixture unusable");
  const firestorePrefix = metadata.firestore.path + "/";
  inside(directory, metadata.firestore.path);
  const kindMetadata = files.filter(f => f.startsWith(firestorePrefix) && f.endsWith(".export_metadata"));
  assert.ok(kindMetadata.length > 0, "Firestore kind metadata is missing");
  const outputFiles = files.filter(f => f.startsWith(firestorePrefix) && /\/output-\d+$/.test(f));
  assert.ok(outputFiles.length > 0, "Firestore export has no document shards");
  const overall = overallMetadata(await fs.readFile(inside(directory, metadata.firestore.metadata_file)));
  equal(overall.kindFiles.map(f => firestorePrefix + f).sort(), kindMetadata, "Overall metadata kind-file references mismatch");
  const referencedShards = [];
  for (const file of kindMetadata) {
    const base = file.slice(0, file.lastIndexOf("/") + 1);
    for (const shard of kindShards(await fs.readFile(inside(directory, file)))) {
      const relative = base + shard;
      inside(directory, relative);
      referencedShards.push(relative);
    }
  }
  equal(referencedShards.sort(), outputFiles, "Kind metadata shard references mismatch");
  const docs = new Map(), collections = Object.create(null);
  for (const file of outputFiles) {
    for (const record of decodeFirestoreLog(await fs.readFile(inside(directory, file)))) {
      assert.equal(record.projectId, expectedProject, "Exported document belongs to a different Firebase project");
      assert.ok(record.path && !docs.has(record.path), "Duplicate or missing exported document key");
      docs.set(record.path, record.data);
      const collection = record.path.split("/")[0];
      collections[collection] = (collections[collection] ?? 0) + 1;
    }
  }
  assert.ok(docs.size > 0, "Firestore export contains no documents");
  assert.equal(docs.size, overall.documentCount, "Export document count differs from overall metadata");
  const integrity = [];
  for (const file of files.filter(f => f !== MANIFEST)) {
    const bytes = await fs.readFile(inside(directory, file));
    integrity.push({ path: file, bytes: bytes.length, sha256: digest(bytes) });
  }
  return { docs, authUids: uids, metadata, integrity, collections, authAccountCount: uids.length, firestoreDocumentCount: docs.size };
}

function inspected(docs, key, validate) {
  if (!docs.has(key)) return { status: "missing", path: key };
  try { validate(docs.get(key)); return { status: "complete", path: key }; }
  catch (error) { return { status: "incomplete", path: key, reason: error.message }; }
}

export function inspectMilestones(exported, shiftId = SHIFT) {
  const { docs, authUids } = exported;
  const get = key => docs.get(key);
  const scoped = (collection, field = "shiftId", id = shiftId) => [...docs].filter(([key, data]) => key.startsWith(collection + "/") && data[field] === id);
  const inspectedDocs = {}, milestones = {};
  const mark = (name, check) => {
    try { check(); milestones[name] = { status: "verified" }; }
    catch (error) { milestones[name] = { status: "not_verified", reason: error.message }; }
  };
  const requirePrior = name => assert.equal(milestones[name]?.status, "verified", `Prerequisite not verified: ${name}`);
  const shift = get(`shifts/${shiftId}`), control = get("operational_shift_control/global");
  inspectedDocs.shift = inspected(docs, `shifts/${shiftId}`, value => {
    assert.equal(value.id, shiftId, "Shift identity mismatch");
    assert.ok(["scheduled", "active", "handover_pending", "completed"].includes(value.status), "Unsupported shift status");
    assert.ok(iso(value.scheduledStart) && iso(value.scheduledEnd) && value.scheduledEnd > value.scheduledStart, "Invalid shift schedule");
    assert.ok(Array.isArray(value.primaryTechnicianIds) && value.primaryTechnicianIds.length === 2 && new Set(value.primaryTechnicianIds).size === 2, "Invalid outgoing roster");
  });
  function pair(id, ids) {
    const p = get(`technician_pairs/${id}`);
    assert.ok(p && p.id === id && p.status === "active", "Missing or inactive permanent pair");
    equal(p.technicianIds, ids, "Pair roster mismatch");
    for (const uid of ids) {
      assert.equal(get(`technician_pair_memberships/${uid}`)?.pairId, id, "Pair membership mismatch");
      const profile = get(`users/${uid}`);
      assert.ok(profile && profile.uid === uid && profile.role === "technician" && profile.status === "active" && authUids.includes(uid), "Technician profile/Auth identity mismatch");
    }
  }
  mark(MILESTONES[0], () => {
    assert.equal(inspectedDocs.shift.status, "complete", "Missing or incomplete expected shift");
    assert.ok(authUids.length >= 6, "Base fixture requires its six Auth accounts");
    for (const uid of authUids) {
      const profile = get(`users/${uid}`);
      assert.ok(profile && profile.uid === uid && ["admin", "supervisor", "technician"].includes(profile.role), "Auth account lacks its corresponding role profile");
    }
    pair(shift.permanentPairId, shift.primaryTechnicianIds);
    assert.ok(control && (control.shiftId === shiftId && control.slotToken === shift.operationalSlotToken || shift.status === "completed"), "Outgoing operational control mismatch");
    for (const uid of shift.primaryTechnicianIds) {
      const member = get(`shift_members/${shiftId}_${uid}`);
      assert.ok(member && member.id === `${shiftId}_${uid}` && member.shiftId === shiftId && member.technicianId === uid && member.role === "primary", "Missing or inconsistent outgoing membership");
    }
  });
  const events = scoped("shift_operation_events");
  mark(MILESTONES[1], () => {
    requirePrior(MILESTONES[0]); assert.ok(events.length > 0, "No shift-scoped operational events");
    for (const [key, event] of events) {
      assert.equal(key, `shift_operation_events/${event.id}`, "Event identity mismatch");
      assert.ok(event.provenance === "authenticated_technician" && authUids.includes(event.authorUid) && iso(event.createdAt) && iso(event.occurredAt), "Incomplete event provenance");
    }
  });
  mark(MILESTONES[2], () => {
    requirePrior(MILESTONES[1]);
    assert.ok(["handover_pending", "completed"].includes(shift.status) && iso(shift.handoverStartedAt) && shift.primaryTechnicianIds.includes(shift.handoverStartedBy), "Handover initiation is not evidenced");
    if (shift.status !== "completed") assert.equal(control.shiftStatus, "handover_pending", "Control lifecycle mismatch");
  });
  const handoverId = `handover_v2_${shiftId}`, rawAggregate = get(`equal_handovers_v2/${handoverId}`);
  inspectedDocs.reservation = inspected(docs, `equal_handovers_v2/${handoverId}`, assertEqualHandoverAggregate);
  const aggregate = inspectedDocs.reservation.status === "complete" ? rawAggregate : null;
  const guardEntries = [...docs].filter(([key, value]) => key.startsWith("handover_reservation_guards/") && value.outgoingShiftId === shiftId);
  const guard = guardEntries[0]?.[1];
  inspectedDocs.guard = guardEntries.length ? inspected(docs, guardEntries[0][0], assertHandoverReservationGuard) : { status: "missing" };
  mark(MILESTONES[3], () => {
    requirePrior(MILESTONES[2]);
    assert.equal(inspectedDocs.reservation.status, "complete", "Missing or incomplete V2 reservation");
    assert.ok(guardEntries.length === 1 && inspectedDocs.guard.status === "complete", "Missing or ambiguous reservation guard");
    const { identity, reservation } = aggregate;
    assert.equal(identity.outgoingShiftId, shiftId, "Reservation shift identity mismatch");
    assert.equal(identity.outgoingPermanentPairId, shift.permanentPairId, "Outgoing pair mismatch");
    equal(identity.outgoingTechnicianIds, shift.primaryTechnicianIds, "Outgoing roster mismatch");
    pair(identity.incomingPermanentPairId, identity.incomingTechnicianIds);
    assert.ok(!["cancelled", "superseded"].includes(aggregate.lifecycleStatus), "Reservation is historical, not an active checkpoint");
    assert.ok(guard.protocolOwner === "v2" && guard.ownerHandoverDocumentId === handoverId && guard.reservationId === reservation.handoverId && guard.reservedIncomingShiftId === identity.incomingShiftId, "Guard reservation binding mismatch");
    assert.equal(guardEntries[0][0], `handover_reservation_guards/${guard.id}`, "Guard document key mismatch");
    assert.ok(guard.ownerLifecycleState === "active" || aggregate.lifecycleStatus === "completed" && guard.ownerLifecycleState === "completed", "Guard lifecycle does not support this reservation");
    assert.equal(guard.outgoingSlotToken, identity.outgoingSlotToken, "Guard outgoing lineage mismatch");
    assert.equal(guard.successorSlotToken, identity.successorSlotToken, "Guard successor lineage mismatch");
    assert.equal(guard.outgoingGeneration, identity.outgoingGeneration, "Guard outgoing generation mismatch");
    assert.equal(guard.successorGeneration, identity.successorGeneration, "Guard successor generation mismatch");
    for (const uid of identity.incomingTechnicianIds) {
      const entry = get(`technician_schedules/${uid}`)?.entries?.find(e => e.shiftId === identity.incomingShiftId);
      assert.ok(entry && ["scheduled", "active"].includes(entry.status) && entry.scheduledStart === identity.scheduledStart && entry.scheduledEnd === identity.scheduledEnd, "Incoming reserved schedule mismatch");
    }
  });
  const preparationKey = aggregate ? `handover_report_preparations_v2/preparation_${aggregate.reservation.handoverId}` : null;
  const preparation = preparationKey ? get(preparationKey) : null;
  inspectedDocs.preparation = preparationKey ? inspected(docs, preparationKey, value => {
    assertEqualHandoverReportPreparationV2(value);
    assert.ok(value.id === preparationKey.split("/")[1] && value.outgoingShiftId === shiftId && value.handoverDocumentId === handoverId && value.reservationId === aggregate.reservation.handoverId, "Preparation identity does not belong to the selected reservation");
  }) : { status: "not_inspected", reason: "No valid reservation identity to select its preparation" };
  mark(MILESTONES[4], () => {
    requirePrior(MILESTONES[3]);
    assert.equal(inspectedDocs.preparation.status, "complete", "Missing or incomplete preparation for the reservation");
    assert.equal(preparation.id, preparationKey.split("/")[1], "Preparation key mismatch");
    assert.equal(preparation.outgoingShiftId, shiftId, "Preparation outgoing shift mismatch");
    assert.equal(preparation.handoverDocumentId, handoverId, "Preparation handover mismatch");
    assert.equal(preparation.reservationId, aggregate.reservation.handoverId, "Preparation reservation mismatch");
    assert.equal(preparation.contentDigest, digestEqualHandoverReportContent(preparation.content), "Preparation digest mismatch");
    if (aggregate.reportBinding === null) {
      assert.equal(preparation.aggregateRevision, aggregate.revision, "Preparation belongs to a stale aggregate revision");
      assert.equal(preparation.aggregateSnapshotHash, createEqualHandoverSnapshot(aggregate).snapshotHash, "Preparation review is stale");
      assert.ok(preparation.guardRevision === guard.guardRevision && preparation.fencingEpoch === guard.fencingEpoch, "Preparation guard binding is stale");
    }
  });
  const binding = aggregate?.reportBinding, frozenKey = binding ? `handover_reports_v2/${binding.id}` : null, frozen = frozenKey ? get(frozenKey) : null;
  inspectedDocs.frozenReport = frozenKey ? inspected(docs, frozenKey, assertFrozenEqualHandoverReportV2) : { status: "not_inspected", reason: "No bound frozen report" };
  mark(MILESTONES[5], () => {
    requirePrior(MILESTONES[4]);
    assert.equal(inspectedDocs.frozenReport.status, "complete", "Missing or incomplete bound frozen report");
    assert.ok(frozen.id === binding.id && frozen.outgoingShiftId === shiftId && frozen.handoverDocumentId === handoverId && frozen.reservationId === aggregate.reservation.handoverId && frozen.preparationId === preparation.id, "Frozen report identity/binding mismatch");
    assert.ok(frozen.content.outgoingShiftId === shiftId && frozen.content.reservationId === aggregate.reservation.handoverId, "Frozen content reservation mismatch");
    equal(frozen.binding, binding, "Frozen report binding differs from aggregate");
    assert.equal(frozen.digest, digestEqualHandoverReportContent(frozen.content), "Frozen report digest mismatch");
    assert.equal(frozen.content.completeness.blockers.length, 0, "Frozen report contains completeness blockers");
  });
  mark(MILESTONES[6], () => {
    requirePrior(MILESTONES[5]);
    for (const uid of aggregate.identity.outgoingTechnicianIds) {
      const c = aggregate.confirmations.find(item => item.technicianUid === uid);
      assert.ok(c && c.position.startsWith("outgoing_") && c.revision === aggregate.revision && c.snapshotHash === createEqualHandoverSnapshot(aggregate).snapshotHash, "Missing current outgoing personal confirmation");
      equal(c.reportBinding, binding, "Outgoing confirmation report mismatch");
    }
  });
  const receipts = scoped("audit_logs", "outgoingShiftId");
  const committed = receipts.filter(([, d]) => d.schema === "equal-handover-commit-v2");
  const activated = receipts.filter(([, d]) => d.schema === "equal-handover-activation-v2");
  function validateReceipt(entries, kind) {
    assert.equal(entries.length, 1, `Missing or ambiguous ${kind} receipt`);
    const [key, receipt] = entries[0], activation = kind === "activation";
    const time = activation ? "activatedAt" : "committedAt";
    assert.equal(key, `audit_logs/${receipt.id}`, "Receipt key mismatch");
    assert.ok(receipt.actorRole === "technician" && receipt.protocol === "equal-handover-v2" && iso(receipt[time]), "Incomplete receipt provenance");
    assert.equal(receipt.action, activation ? "EQUAL_SHIFT_ACTIVATED_INCOMING_V2" : "EQUAL_HANDOVER_OUTGOING_COMMITTED_V2", "Receipt action mismatch");
    assert.equal(receipt.outcome, activation ? "INCOMING_ACTIVATED" : "AWAITING_INCOMING_ACCEPTANCE", "Receipt outcome mismatch");
    assert.ok(receipt.handoverDocumentId === handoverId && receipt.outgoingShiftId === shiftId && receipt.incomingShiftId === aggregate.identity.incomingShiftId && receipt.boundReportId === binding.id, "Receipt reservation binding mismatch");
    assert.ok(receipt.finalRevision === aggregate.revision && receipt.finalSnapshotHash === createEqualHandoverSnapshot(aggregate).snapshotHash, "Receipt revision binding mismatch");
    const material = { namespace: activation ? "equal-handover-activation-receipt-v2" : "equal-handover-commit-receipt-v2" };
    for (const field of ["id", "handoverDocumentId", "outgoingShiftId", "incomingShiftId", "finalRevision", "finalSnapshotHash", "boundReportId", ...(!activation ? ["boundReportVersion"] : []), "actorUid", "actorRole", time]) material[field] = receipt[field];
    assert.equal(receipt.receiptHash, digest(material), "Receipt hash mismatch");
  }
  mark(MILESTONES[7], () => {
    requirePrior(MILESTONES[6]);
    assert.ok(["awaiting_incoming_acceptance", "completed"].includes(aggregate.lifecycleStatus), "Handover is not committed");
    validateReceipt(committed, "commitment");
    const receipt = committed[0][1];
    assert.ok(receipt.handoverDocumentId === handoverId && receipt.incomingShiftId === aggregate.identity.incomingShiftId && receipt.boundReportId === binding.id && aggregate.identity.outgoingTechnicianIds.includes(receipt.actorUid), "Commitment receipt binding mismatch");
  });
  mark(MILESTONES[8], () => {
    requirePrior(MILESTONES[7]);
    assert.equal(aggregate.lifecycleStatus, "completed", "Incoming shift has not activated");
    validateReceipt(activated, "activation");
    const receipt = activated[0][1], incoming = get(`shifts/${aggregate.identity.incomingShiftId}`);
    assert.ok(receipt.action === "EQUAL_SHIFT_ACTIVATED_INCOMING_V2" && receipt.handoverDocumentId === handoverId && receipt.boundReportId === binding.id && receipt.incomingShiftId === incoming?.id && aggregate.identity.incomingTechnicianIds.includes(receipt.actorUid), "Activation receipt binding mismatch");
    assert.ok(incoming.status === "active" && incoming.previousShiftId === shiftId && incoming.actualStart === receipt.activatedAt && shift.status === "completed" && shift.actualEnd === receipt.activatedAt, "Shift activation lifecycle mismatch");
    assert.ok(control.shiftId === incoming.id && control.shiftStatus === "active" && control.slotToken === aggregate.identity.successorSlotToken && control.generation === aggregate.identity.successorGeneration, "Activated operational control mismatch");
    const uid = receipt.actorUid, key = `${incoming.id}_${uid}`, attendance = get(`shift_attendance/${key}`), member = get(`shift_members/${key}`);
    assert.ok(attendance?.status === "present" && attendance.shiftId === incoming.id && attendance.technicianId === uid && member?.technicianId === uid && member.shiftId === incoming.id, "Activation lacks authoritative participation");
    const personal = [...docs].filter(([k, d]) => k.startsWith("attendance_evidence_v2/") && d.handoverId === aggregate.reservation.handoverId && d.technicianUid === uid && d.personallyAuthenticated === true && iso(d.clockIn));
    assert.equal(personal.length, 1, "Activation lacks unique personal incoming evidence");
    const record = assertAttendanceEvidence(personal[0][1]);
    assert.equal(personal[0][0], `attendance_evidence_v2/${record.id}`, "Attendance evidence key mismatch");
    const operation = assertAttendanceOperation(get(`attendance_evidence_operations_v2/${record.operationId}`));
    assert.ok(operation.status === "finalized" && operation.evidenceId === record.id && operation.request.technicianUid === uid && operation.request.handoverId === aggregate.reservation.handoverId, "Activation evidence operation is not finalized and bound");
  });
  const highestVerifiedMilestone = [...MILESTONES].reverse().find(name => milestones[name].status === "verified") ?? null;
  return {
    shiftId, shiftLifecycleStatus: shift?.status ?? null,
    highestVerifiedMilestone, milestones, documents: inspectedDocs,
    operationalEventCount: events.length, outgoingAttendanceCount: scoped("shift_attendance").length,
    reservationIdentity: inspectedDocs.reservation.status === "complete" ? { handoverDocumentId: handoverId, reservationId: aggregate.reservation.handoverId, incomingShiftId: aggregate.identity.incomingShiftId } : null,
    preparation: inspectedDocs.preparation.status === "complete" ? { id: preparation.id, revision: preparation.preparationRevision, digest: preparation.contentDigest } : null,
    frozenReport: inspectedDocs.frozenReport.status === "complete" ? { id: frozen.id, version: frozen.version, digest: frozen.digest, binding: frozen.binding } : null,
    handoverLifecycleStatus: aggregate?.lifecycleStatus ?? null,
    incomingParticipation: aggregate ? aggregate.identity.incomingTechnicianIds.map(uid => ({ technicianUid: uid, authoritativeAttendanceExists: docs.has(`shift_attendance/${aggregate.identity.incomingShiftId}_${uid}`), membershipExists: docs.has(`shift_members/${aggregate.identity.incomingShiftId}_${uid}`) })) : { status: "not_inspected", reason: "No valid incoming reservation" },
  };
}

export async function inspectSnapshot(directory, { projectId = PROJECT, shiftId = SHIFT } = {}) {
  assert.equal(projectId, PROJECT, "Only the 09M project may be inspected by this workflow");
  const exported = await readExport(directory, projectId);
  const state = inspectMilestones(exported, shiftId);
  return { projectId, authAccountCount: exported.authAccountCount, firestoreDocumentCount: exported.firestoreDocumentCount, firestoreCollectionCounts: exported.collections, exportVersions: exported.metadata, files: exported.integrity, state };
}

export async function verifySnapshot(directory, options = {}) {
  const inspection = await inspectSnapshot(directory, options);
  let manifest;
  try { manifest = await json(path.join(directory, MANIFEST)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!manifest) return { manifestStatus: "legacy_missing", integrity: "unanchored", inspection };
  equal(Object.keys(manifest).sort(), ["schema", "snapshotId", "createdAt", "requestedCheckpoint", "inspection", "inspectionDigest"].sort(), "Unsupported or unchecked manifest fields");
  assert.equal(manifest.schema, "shiftchange-09m-snapshot-v1", "Unsupported snapshot manifest schema");
  assert.equal(manifest.snapshotId, path.basename(directory), "Manifest snapshot identity mismatch");
  assert.ok(iso(manifest.createdAt), "Invalid manifest creation time");
  assert.ok(manifest.snapshotId.startsWith(manifest.createdAt.replace(/[:.]/g, "-") + "_"), "Manifest creation time does not match snapshot identifier");
  equal(manifest.inspection, inspection, "Snapshot manifest does not match the export contents");
  assert.equal(manifest.inspectionDigest, digest(inspection), "Manifest inspection digest mismatch");
  assert.equal(manifest.requestedCheckpoint, inspection.state.highestVerifiedMilestone, "Manifest checkpoint mismatch");
  return { manifestStatus: "verified", integrity: "sha256_and_record_crc_verified", inspection, manifest };
}

export async function selectSnapshot(snapshotRoot, { checkpoint, shiftId = SHIFT, allowLegacy = false, allowCheckpointMismatch = false, recoveryReason = "" } = {}) {
  assert.ok(MILESTONES.includes(checkpoint), "An explicit supported checkpoint is required");
  const pointer = await json(path.join(snapshotRoot, "LATEST.json"));
  assert.equal(pointer.projectId, PROJECT, "LATEST names another Firebase project");
  assert.equal(pointer.shiftId, shiftId, "LATEST names another outgoing shift");
  assert.ok(safeId(pointer.snapshot), "Unsafe snapshot selection");
  const directory = inside(snapshotRoot, pointer.snapshot);
  const result = await verifySnapshot(directory, { shiftId });
  if (pointer.schema === "shiftchange-09m-pointer-v1") assert.equal(result.manifestStatus, "verified", "Managed snapshot manifest is missing; it cannot be treated as a legacy snapshot");
  const recovery = (allowLegacy || allowCheckpointMismatch);
  if (recovery) assert.ok(recoveryReason.trim().length >= 10, "Recovery overrides require a meaningful recovery reason");
  assert.ok(result.manifestStatus === "verified" || allowLegacy, "Legacy snapshot has no immutable manifest; use the documented explicit recovery procedure");
  const actual = result.inspection.state.highestVerifiedMilestone;
  assert.ok(actual, "Snapshot has no verified base fixture; restore refused");
  assert.ok(actual === checkpoint || allowCheckpointMismatch, `Checkpoint mismatch: requested ${checkpoint}, found ${actual}`);
  if (result.manifestStatus === "verified") {
    assert.equal(pointer.schema, "shiftchange-09m-pointer-v1", "Unsupported managed pointer schema");
    assert.ok(iso(pointer.savedAt), "Invalid pointer save time");
    assert.equal(pointer.manifestSha256, digest(await fs.readFile(path.join(directory, MANIFEST))), "LATEST manifest hash mismatch");
    assert.equal(pointer.checkpoint, actual, "LATEST checkpoint mismatch");
  }
  return { directory, requestedCheckpoint: checkpoint, actualCheckpoint: actual, manifestStatus: result.manifestStatus, integrity: result.integrity, documentInspections: result.inspection.state.documents, recoveryOverride: recovery, recoveryReason: recovery ? recoveryReason : null };
}

// Export callback is the only service-writing boundary (hub export, never a
// Firestore write). Tests inject disposable exporters; no live export is tested.
export async function saveSnapshot({ snapshotRoot, checkpoint, shiftId = SHIFT, exportTo, createdAt = new Date().toISOString() }) {
  assert.ok(MILESTONES.includes(checkpoint), "An explicit supported checkpoint is required");
  assert.ok(iso(createdAt), "Invalid save time");
  await fs.mkdir(snapshotRoot, { recursive: true });
  const rootInfo = await fs.lstat(snapshotRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "Snapshot root must not be a symlink");
  const lockPath = path.join(snapshotRoot, ".save.lock"), lock = await fs.open(lockPath, "wx");
  const snapshotId = createdAt.replace(/[:.]/g, "-") + "_" + randomUUID();
  const directory = inside(snapshotRoot, snapshotId);
  const pointerPath = path.join(snapshotRoot, "LATEST.json"), temporaryPointer = path.join(snapshotRoot, `.LATEST-${randomUUID()}.tmp`);
  let published = false;
  try {
    await fs.lstat(directory).then(() => { throw new Error("Refusing to reuse a snapshot directory"); }, error => { if (error.code !== "ENOENT") throw error; });
    await exportTo(directory);
    const inspection = await inspectSnapshot(directory, { shiftId });
    assert.equal(inspection.state.highestVerifiedMilestone, checkpoint, "Export does not contain the exact intended checkpoint");
    const manifest = { schema: "shiftchange-09m-snapshot-v1", snapshotId, createdAt, requestedCheckpoint: checkpoint, inspection, inspectionDigest: digest(inspection) };
    const manifestFile = path.join(directory, MANIFEST), manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    const handle = await fs.open(manifestFile, "wx");
    try { await handle.writeFile(manifestBytes); await handle.sync(); } finally { await handle.close(); }
    await verifySnapshot(directory, { shiftId });
    const pointer = { schema: "shiftchange-09m-pointer-v1", projectId: PROJECT, shiftId, snapshot: snapshotId, checkpoint, savedAt: new Date().toISOString(), manifestSha256: digest(manifestBytes) };
    const pointerHandle = await fs.open(temporaryPointer, "wx");
    try { await pointerHandle.writeFile(JSON.stringify(pointer, null, 2) + "\n"); await pointerHandle.sync(); } finally { await pointerHandle.close(); }
    await fs.rename(temporaryPointer, pointerPath);
    published = true;
    return { pointer, directory, manifest };
  } finally {
    // A successful atomic publication must not be reported as a failed save
    // merely because cleanup failed afterwards. A stale lock fails closed on
    // the next save and is documented for explicit operator recovery.
    const cleanup = await Promise.allSettled([
      lock.close().then(() => fs.unlink(lockPath)),
      fs.unlink(temporaryPointer).catch(error => { if (error.code !== "ENOENT") throw error; }),
    ]);
    const failed = cleanup.find(result => result.status === "rejected");
    if (failed && !published) throw failed.reason;
    if (failed) console.error("09M snapshot published successfully, but temporary-file cleanup needs operator review.");
  }
}
