import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fixtureRecords } from "../formal-handover-transfer-fixtures.mjs";

// No Firebase SDK or network implementation is reachable from this loader.
const compiled = new Map();
export async function acceptanceFixture(options = {}) {
  const f = { records: new Map(), writes: [], authCalls: [], hooks: {}, actor: "in-a", clock: Date.now(), retries: 0 };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [f.clock])); } static now() { return f.clock; } }
  class Timestamp {
    constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    static fromDate(date) { const ms = date.getTime(); return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
    toDate() { return new Clock(this.seconds * 1000 + this.nanoseconds / 1e6); }
  }
  const clone = value => {
    if (value instanceof Timestamp) return new Timestamp(value.seconds, value.nanoseconds);
    if (value instanceof Date) return new Clock(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
    return value;
  };
  f.advance = ms => { f.clock += ms; };
  f.iso = () => new Clock().toISOString();
  f.hit = async (phase, payload) => { if (f.hooks[phase]) await f.hooks[phase](payload); };
  f.failOnce = phase => { f.hooks[phase] = () => { delete f.hooks[phase]; throw new Error(`Injected ${phase}`); }; };
  const versions = new Map(), collectionVersions = new Map();
  const collectionOf = p => p.slice(0, p.indexOf("/"));
  const persist = (op, path, data) => {
    f.records.set(path, clone(op === "update" ? { ...f.records.get(path), ...data } : data));
    versions.set(path, (versions.get(path) ?? 0) + 1);
    const c = collectionOf(path); collectionVersions.set(c, (collectionVersions.get(c) ?? 0) + 1);
    f.writes.push({ op, path });
  };
  const snap = (records, path) => ({ id: path.slice(path.indexOf("/") + 1), exists: records.has(path), data: () => clone(records.get(path)) });
  const doc = path => ({ path, id: path.slice(path.indexOf("/") + 1), get: async () => { await f.hit("directRead", path); return snap(f.records, path); }, set: async data => { await f.hit("ackWrite", path); persist("set", path, data); } });
  const query = (collection, filters = []) => ({ collection, filters, where: (field, op, value) => { assert.equal(op, "=="); return query(collection, [...filters, [field, value]]); } });
  f.db = {
    collection: name => ({ ...query(name), doc: id => doc(`${name}/${id ?? randomUUID()}`) }), doc,
    runTransaction: async callback => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const view = new Map([...f.records].map(([p, v]) => [p, clone(v)])), reads = new Map(), queries = new Map(), writes = [];
        const startVersions = new Map(versions), startCollections = new Map(collectionVersions);
        let writing = false;
        const tx = { get: async target => {
          assert.equal(writing, false, "all authoritative reads precede writes");
          if (target.path) { reads.set(target.path, startVersions.get(target.path) ?? 0); return snap(view, target.path); }
          queries.set(target.collection, startCollections.get(target.collection) ?? 0);
          const docs = [...view.keys()].filter(p => p.startsWith(target.collection + "/") && target.filters.every(([key, value]) => view.get(p)[key] === value)).map(p => snap(view, p));
          return { docs, empty: docs.length === 0, size: docs.length };
        } };
        for (const op of ["create", "set", "update"]) tx[op] = (ref, data) => { writing = true; writes.push({ op, path: ref.path, data }); };
        const result = await callback(tx);
        await f.hit("beforeCommit", writes);
        if ([...reads].some(([p, v]) => (versions.get(p) ?? 0) !== v) || [...queries].some(([c, v]) => (collectionVersions.get(c) ?? 0) !== v) || writes.some(w => w.op === "create" && f.records.has(w.path))) { f.retries++; continue; }
        for (const w of writes) if (w.op === "update") assert.ok(f.records.has(w.path));
        for (const w of writes) persist(w.op, w.path, w.data);
        await f.hit("afterCommit", writes);
        return result;
      }
      throw new Error("Fixture transaction retry limit exceeded");
    },
  };
  const cache = new Map();
  class PasswordReauthenticationError extends Error { constructor(message, status = 403) { super(message); this.status = status; } }
  f.PasswordReauthenticationError = PasswordReauthenticationError;
  const wrap = (api, names) => Object.fromEntries(Object.entries(api).map(([key, value]) => [key, names[key] ? async (...args) => {
    await f.hit(`before${names[key]}`, args);
    const result = await value(...args);
    await f.hit(`after${names[key]}`, result);
    return result;
  } : value]));
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    if (path === "lib/firebase/admin") return { getAdminFirestore: () => f.db, getAdminAuth: () => ({ getUser: async uid => ({ uid, email: `${uid}@fixture.invalid`, disabled: false }) }) };
    if (path === "lib/auth/session") return { getCurrentUser: async () => ({ uid: f.actor, role: "technician", email: `${f.actor}@fixture.invalid`, mustChangePassword: false }) };
    if (path === "lib/auth/password-reauthentication") return { PasswordReauthenticationError, reauthenticatePassword: async input => {
      f.authCalls.push(input.expectedUid); await f.hit("password", input.expectedUid); await f.hit("afterPassword", input.expectedUid);
    } };
    if (path === "lib/notifications/notification-outbox") return { notificationsEnabled: () => false, writeOutboxEntries: () => { throw new Error("Disabled notification write"); } };
    if (path === "lib/notifications/notification-hooks") return {};
    if (path === "lib/notifications/notification-service") return { markActionedByReference: async () => {} };
    const exports = {}; cache.set(path, exports);
    if (!compiled.has(path)) compiled.set(path, ts.transpileModule(readFileSync(new URL(`../../src/${path}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
    runInNewContext(compiled.get(path), { exports, Object, Buffer, structuredClone: clone, TextEncoder, Date: Clock, process: { env: { HANDOVER_V2_DEV: "true" } }, console: { error: () => {} }, require(name) {
      if (name === "server-only") return {};
      if (name === "node:crypto") return { createHash, randomUUID };
      if (name === "firebase-admin/firestore") return { Timestamp, FieldValue: { serverTimestamp: () => Timestamp.fromDate(new Clock()) } };
      if (name === "next/server") return { NextResponse: { json: (body, options) => {
        if (f.responseFailure && body.success) { f.responseFailure = false; throw new Error("Injected response loss"); }
        return { status: options.status, json: async () => clone(body) };
      } } };
      let target;
      if (name.startsWith("@/")) target = name.slice(2);
      else if (name.startsWith("./")) target = path.slice(0, path.lastIndexOf("/") + 1) + name.slice(2);
      else throw new Error(`Unexpected dependency: ${name}`);
      const api = load(target);
      if (path.endsWith("/accept/route") && target === "lib/operations/attendance-evidence-firestore") return wrap(api, { beginAttendanceEvidenceOperation: "Begin", finalizeAttendanceEvidenceOperation: "Finalize", resumeAttendanceEvidenceOperation: "Resume" });
      if (path.endsWith("/accept/route") && target === "lib/operations/equal-handover-report-firestore") return wrap(api, { readEqualHandoverAcceptanceContext: "Context", acceptEqualHandoverIncomingV2: "Activate", finalizeEqualHandoverReservationV2: "GuardFinalize" });
      return api;
    } });
    return exports;
  }
  f.load = load;
  const base = fixtureRecords(load, { count: 0 });
  for (const [p, value] of base.records) f.records.set(p, clone(value));
  const domain = load("lib/operations/equal-technician-handover-domain");
  const identity = { ...base.aggregate.identity, schema: "equal-handover-v2", outgoingTechnicianIds: base.out, incomingTechnicianIds: base.incoming };
  delete identity.outgoingPrimaryTechnicianIds; delete identity.incomingPrimaryTechnicianIds;
  const aggregate = domain.createEqualHandover({ identity, reservedAt: base.at, reservedBy: "out-a" });
  f.records.set("equal_handovers_v2/handover_v2_outgoing", aggregate);
  const guard = load("lib/operations/handover-reservation-guard-domain").createInitialReservationGuard({ outgoingShiftId: "outgoing", protocolOwner: "v2", ownerHandoverDocumentId: "handover_v2_outgoing", outgoingSlotToken: identity.outgoingSlotToken, outgoingGeneration: identity.outgoingGeneration, successorSlotToken: identity.successorSlotToken, successorGeneration: identity.successorGeneration, reservationId: aggregate.reservation.handoverId, reservedIncomingShiftId: "incoming", reservedAt: base.at, reservedBy: "out-a" });
  f.records.set(`handover_reservation_guards/${guard.id}`, guard);
  for (const uid of [...base.out, ...base.incoming]) f.records.get(`users/${uid}`).fullName = uid;
  for (const uid of base.out) f.records.set(`shift_attendance/outgoing_${uid}`, load("lib/operations/shift-join-domain").createShiftAttendanceRecord({ shiftId: "outgoing", technicianUid: uid, participationAuthority: "primary", authorizationId: null, recordedAt: base.at }));
  for (const [index, station] of load("types/shift-operations").DEFAULT_BROADCAST_STATIONS.entries()) {
    const id = `broadcast-${index}`;
    f.records.set(`shift_operation_events/${id}`, { id, recordId: id, shiftId: "outgoing", revision: 1, kind: "broadcast", stationId: station.id, stationName: station.name, status: "on_air", occurredAt: base.at, remarks: "Synthetic observation", authorUid: "out-a", authorName: "Alpha", originalReporterUid: "out-a", originalReporterName: "Alpha", createdAt: base.at, provenance: "authenticated_technician" });
  }
  f.records.set("shift_operation_events/no-ob", { id: "no-ob", recordId: "no-ob", shiftId: "outgoing", revision: 1, kind: "no_ob", occurredAt: base.at, remarks: "Synthetic no OB", authorUid: "out-a", authorName: "Alpha", originalReporterUid: "out-a", originalReporterName: "Alpha", createdAt: base.at, provenance: "authenticated_technician" });
  f.api = load("lib/operations/equal-handover-report-firestore");
  f.evidence = load("lib/operations/attendance-evidence-firestore");
  f.binding = () => { const a = f.records.get("equal_handovers_v2/handover_v2_outgoing"), g = f.records.get("handover_reservation_guards/guard_outgoing"); return { expectedRevision: a.revision, expectedSnapshotHash: domain.createEqualHandoverSnapshot(a).snapshotHash, expectedGuardRevision: g.guardRevision, expectedFencingEpoch: g.fencingEpoch }; };
  // An absence is part of the reviewed four-person obligation, so a fixture
  // that needs one declares it through the production service BEFORE the
  // report is prepared and frozen; a declaration afterwards would diverge from
  // the frozen binding.
  if (options.absence) {
    await f.api.recordEqualHandoverAbsenceV2({
      outgoingShiftId: "outgoing",
      actorUid: options.absence.actorUid,
      technicianUid: options.absence.subjectUid,
      absenceType: options.absence.absenceType ?? "not_yet_in",
      reason: options.absence.reason ?? "Partner reported unavailable for this shift.",
      reportedDepartureTime: null,
      ...f.binding(),
    });
  }
  const p = (await f.api.prepareEqualHandoverReport({ outgoingShiftId: "outgoing", actorUid: "out-a", reason: null })).preparation;
  await f.api.freezeEqualHandoverReport({ outgoingShiftId: "outgoing", actorUid: "out-a", ...f.binding(), preparationRevision: p.preparationRevision, contentDigest: p.contentDigest, evidenceSnapshotHash: p.evidenceSnapshotHash, workSnapshotVersion: p.workSnapshotVersion, reason: "Synthetic audit fixture", correctionNote: null });
  // An absent participant attests through the absence declaration instead of
  // a personal confirmation, mirroring the production four-person obligation.
  for (const uid of [...base.out, ...base.incoming]) {
    if (options.absence && uid === options.absence.subjectUid) continue;
    await f.api.confirmEqualHandoverParticipantV2({ outgoingShiftId: "outgoing", actorUid: uid, ...f.binding() });
  }
  await f.api.commitEqualHandoverOutgoingV2({ outgoingShiftId: "outgoing", actorUid: "out-a", ...f.binding() });
  const route = load("app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/accept/route");
  f.post = async (uid = "in-a", binding = f.binding(), extra = {}) => {
    f.actor = uid;
    const response = await route.POST({ nextUrl: { origin: "http://fixture.invalid" }, headers: { get: name => name === "origin" ? "http://fixture.invalid" : null }, json: async () => ({ password: "synthetic-only", ...binding, ...extra }) }, { params: Promise.resolve({ shiftId: "outgoing" }) });
    return { status: response.status, body: await response.json() };
  };
  f.entries = collection => [...f.records].filter(([p]) => p.startsWith(collection + "/"));
  f.summary = () => ({ operations: f.entries("attendance_evidence_operations_v2").length, evidence: f.entries("attendance_evidence_v2").length, incomingAttendance: f.entries("shift_attendance").filter(([p]) => p.startsWith("shift_attendance/incoming_")).length, incomingMembers: f.entries("shift_members").filter(([p]) => p.startsWith("shift_members/incoming_")).length, activationReceipts: f.entries("audit_logs").filter(([, d]) => d.action === "EQUAL_SHIFT_ACTIVATED_INCOMING_V2").length, active: f.records.get("shifts/incoming")?.status ?? null });
  f.writes.length = 0;
  return f;
}
