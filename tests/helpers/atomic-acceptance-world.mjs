import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { acceptanceFixture } from "./acceptance-integrity-fixtures.mjs";

// Network-free transactional double for the 09M-R3B.2 Phase 3 atomic
// acceptance service. The world is seeded from the fully committed
// `acceptanceFixture` handover (awaiting_incoming_acceptance) and then exposes
// only the behaviour the service needs: read-before-write ordering, optimistic
// read-version conflicts with callback retry, all-or-nothing commit,
// unresolved-then-resolved server timestamps, and fault injection.

const compiled = new Map();

class Timestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  static fromDate(date) {
    const ms = date.getTime();
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.round((ms - seconds * 1000) * 1e6));
  }
  static now() {
    return Timestamp.fromDate(new Date());
  }
  toDate() {
    return new Date(this.seconds * 1000 + this.nanoseconds / 1e6);
  }
}

class ServerTimestamp {
  constructor() {
    this.__serverTimestamp = true;
  }
}

const isTimestamp = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof value.toDate === "function" &&
  Number.isSafeInteger(value.seconds) &&
  Number.isSafeInteger(value.nanoseconds);

function clone(value) {
  if (value instanceof ServerTimestamp) return new ServerTimestamp();
  if (isTimestamp(value)) return new Timestamp(value.seconds, value.nanoseconds);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function resolveServerTimestamps(value, ts, enabled) {
  if (value instanceof ServerTimestamp) return enabled ? ts : value;
  if (isTimestamp(value) || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => resolveServerTimestamps(item, ts, enabled));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveServerTimestamps(item, ts, enabled)]),
    );
  }
  return value;
}

function serialize(value) {
  if (value instanceof ServerTimestamp) return { __serverTimestamp: true };
  if (isTimestamp(value)) return { __timestamp: [value.seconds, value.nanoseconds] };
  if (value instanceof Date) return { __date: value.toISOString() };
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  }
  return value;
}

export async function atomicAcceptanceWorld(options = {}) {
  const base = await acceptanceFixture();
  const world = createWorld({
    notificationsEnabled: options.notificationsEnabled === true,
    clockMs: options.clockMs ?? Date.now(),
  });
  for (const [path, value] of base.records) world.records.set(path, clone(value));
  return attachFixtureApi(world, base);
}

function createWorld({ notificationsEnabled, clockMs }) {
  const records = new Map();
  const versions = new Map();
  const collectionVersions = new Map();
  const writes = [];
  const hooks = {};
  let retries = 0;
  let commits = 0;

  const world = {
    records,
    writes,
    hooks,
    resolveServerTimestamps: true,
    clockMs,
    authCalls: 0,
    retries: () => retries,
    commits: () => commits,
    snapshot: () => serialize(Object.fromEntries([...records].sort(([a], [b]) => (a < b ? -1 : 1)))),
    entries: (collection) =>
      [...records].filter(([path]) => path.startsWith(`${collection}/`) && !path.slice(collection.length + 1).includes("/")),
  };

  const snapshot = (source, path) => ({
    id: path.slice(path.lastIndexOf("/") + 1),
    exists: source.has(path),
    data: () => clone(source.get(path)),
  });

  const documentRef = (path) => ({
    path,
    id: path.slice(path.lastIndexOf("/") + 1),
    get: async () => {
      if (hooks.directRead) await hooks.directRead(path);
      return snapshot(records, path);
    },
  });

  const collection = (name, filters = []) => ({
    name,
    filters,
    doc: (id) => {
      if (typeof id !== "string" || id.length === 0) throw new Error(`Missing document id in ${name}`);
      return documentRef(`${name}/${id}`);
    },
    where: (field, op, value) => {
      assert.equal(op, "==");
      return collection(name, [...filters, [field, value]]);
    },
  });

  const db = {
    collection,
    doc: (path) => documentRef(path),
    runTransaction: async (callback) => {
      for (let attempt = 0; attempt < 16; attempt++) {
        const view = new Map([...records].map(([path, value]) => [path, clone(value)]));
        const readVersions = new Map();
        const readCollections = new Map();
        const queued = [];
        let writing = false;

        const tx = {
          get: async (target) => {
            assert.equal(writing, false, "all authoritative reads must precede the first write");
            if (target.path) {
              readVersions.set(target.path, versions.get(target.path) ?? 0);
              if (hooks.readPath) await hooks.readPath(target.path);
              return snapshot(view, target.path);
            }
            readCollections.set(target.name, collectionVersions.get(target.name) ?? 0);
            if (hooks.readPath) await hooks.readPath(target.name);
            const docs = [...view.keys()]
              .filter((path) => path.startsWith(`${target.name}/`) && !path.slice(target.name.length + 1).includes("/"))
              .filter((path) => target.filters.every(([field, value]) => view.get(path)[field] === value))
              .map((path) => snapshot(view, path));
            return { docs, empty: docs.length === 0, size: docs.length };
          },
        };
        for (const op of ["create", "set", "update", "delete"]) {
          tx[op] = (ref, data) => {
            writing = true;
            queued.push({ op, path: ref.path, data });
          };
        }

        const result = await callback(tx);
        if (hooks.beforeCommit) await hooks.beforeCommit(queued);

        const conflicted =
          [...readVersions].some(([path, version]) => (versions.get(path) ?? 0) !== version) ||
          [...readCollections].some(([name, version]) => (collectionVersions.get(name) ?? 0) !== version);
        if (conflicted) {
          retries += 1;
          continue;
        }
        for (const write of queued) {
          if (write.op === "create" && records.has(write.path)) {
            throw new Error(`create on an existing document: ${write.path}`);
          }
        }
        if (hooks.commit) await hooks.commit(queued);

        const committedAt = Timestamp.fromDate(new Date(world.clockMs));
        for (const write of queued) {
          if (write.op === "delete") {
            records.delete(write.path);
          } else {
            const data = resolveServerTimestamps(write.data, committedAt, world.resolveServerTimestamps);
            records.set(
              write.path,
              write.op === "update"
                ? { ...records.get(write.path), ...clone(data) }
                : clone(data),
            );
          }
          versions.set(write.path, (versions.get(write.path) ?? 0) + 1);
          const name = write.path.slice(0, write.path.indexOf("/"));
          collectionVersions.set(name, (collectionVersions.get(name) ?? 0) + 1);
          writes.push({ op: write.op, path: write.path });
        }
        commits += 1;
        if (hooks.afterCommit) await hooks.afterCommit(queued);
        return result;
      }
      throw new Error("Fixture transaction retry limit exceeded");
    },
  };

  function load(path) {
    if (path === "lib/firebase/admin") {
      return {
        getAdminFirestore: () => db,
        getAdminAuth: () => ({
          getUser: async (uid) => {
            world.authCalls += 1;
            return { uid, email: `${uid}@fixture.invalid`, disabled: false };
          },
        }),
      };
    }
    const exports = {};
    if (!compiled.has(path)) {
      compiled.set(
        path,
        ts.transpileModule(readFileSync(new URL(`../../src/${path}.ts`, import.meta.url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      );
    }
    runInNewContext(compiled.get(path), {
      exports,
      Object,
      Buffer,
      structuredClone: clone,
      TextEncoder,
      Date,
      process: {
        env: {
          HANDOVER_V2_DEV: "true",
          ...(notificationsEnabled ? { NOTIFICATIONS_ENABLED: "true" } : {}),
        },
      },
      console: { error: () => {} },
      require(name) {
        if (name === "server-only") return {};
        if (name === "node:crypto") return { createHash, randomUUID };
        if (name === "firebase-admin/firestore") {
          return { Timestamp, FieldValue: { serverTimestamp: () => new ServerTimestamp() } };
        }
        if (name === "firebase-admin/app" || name === "firebase-admin/auth") return {};
        let target;
        if (name.startsWith("@/")) target = name.slice(2);
        else if (name.startsWith("./")) target = path.slice(0, path.lastIndexOf("/") + 1) + name.slice(2);
        else throw new Error(`Unexpected dependency: ${name}`);
        return load(target);
      },
    });
    return exports;
  }

  world.db = db;
  world.load = load;
  return world;
}

function attachFixtureApi(world, base) {
  const documentId = "handover_v2_outgoing";
  const outgoingShiftId = "outgoing";
  const incomingShiftId = "incoming";
  const aggregatePath = `equal_handovers_v2/${documentId}`;
  const guardPath = "handover_reservation_guards/guard_outgoing";

  const domain = world.load("lib/operations/equal-technician-handover-domain");
  const applicationDomain = world.load("lib/operations/incoming-acceptance-application-domain");
  const service = world.load("lib/operations/incoming-acceptance-application-firestore");
  const guardFinalization = world.load("lib/operations/incoming-acceptance-guard-finalization");
  const guardLifecycle = world.load("lib/operations/incoming-acceptance-guard-lifecycle");
  const reconciliation = world.load("lib/operations/incoming-acceptance-reconciliation");

  const aggregate = () => world.records.get(aggregatePath);
  const guard = () => world.records.get(guardPath);
  const iso = (ms) => new Date(ms).toISOString();

  const reviewedBinding = () => {
    const current = aggregate();
    const currentGuard = guard();
    return {
      handoverId: current.reservation.handoverId,
      handoverDocumentId: documentId,
      aggregateRevision: current.revision,
      snapshotHash: domain.createEqualHandoverSnapshot(current).snapshotHash,
      // Freezing revises the aggregate after it stamps the immutable report, so
      // the reviewed report carries the live revision overlaid by the
      // coordinator; only the immutable provenance fields must match the
      // frozen document.
      report: { ...clone(current.reportBinding), aggregateRevision: current.revision },
      guardRevision: currentGuard.guardRevision,
      fencingEpoch: currentGuard.fencingEpoch,
    };
  };

  // First activation must be after the committed aggregate revision and after
  // the incoming shift window opens; the grace period keeps a late reason
  // optional for the ordinary tests.
  const firstAppliedMs = Math.max(
    Date.parse(aggregate().updatedAt) + 60_000,
    Date.parse(aggregate().identity.scheduledStart) + 60_000,
  );

  const timeline = (appliedMs) => ({
    requestAcceptedAt: iso(appliedMs - 3000),
    operationalAppliedAt: iso(appliedMs),
    nowIso: iso(appliedMs + 100),
    nowMonotonicMs: 1_004_000,
  });

  const proofFor = ({ actorUid, binding, lateReason, appliedMs, nonce, verifiedAtMonotonicMs = 1_000_000 }) =>
    applicationDomain.createIncomingAcceptanceAuthenticationProof({
      requestNonce: nonce,
      verifiedTechnicianUid: actorUid,
      verifiedAt: iso(appliedMs - 2000),
      authAccountCheckedAt: iso(appliedMs - 1000),
      reviewedBinding: binding,
      lateReason,
      verifiedAtMonotonicMs,
    });

  const apply = (actorUid, overrides = {}) => {
    const appliedMs = overrides.appliedMs ?? firstAppliedMs;
    const binding = overrides.binding ?? reviewedBinding();
    const lateReason = overrides.lateReason ?? null;
    const nonce = overrides.nonce ?? `nonce-${actorUid}-${appliedMs}`;
    const proof = overrides.proof ?? proofFor({ actorUid, binding, lateReason, appliedMs, nonce });
    return service.applyIncomingAcceptanceApplicationAtomically({
      outgoingShiftId,
      actorUid,
      reviewedBinding: binding,
      lateReason,
      requestNonce: nonce,
      proof,
      ...timeline(appliedMs),
    });
  };

  // Finalization and reconciliation run against a server clock the test
  // controls explicitly; the network-free world never reads the wall clock.
  const finalizeNowIso = iso(firstAppliedMs + 10_000);
  const closureNowIso = iso(Date.parse(aggregate().identity.scheduledEnd) + 2_000);

  const finalizeGuard = (overrides = {}) =>
    guardFinalization.finalizeIncomingAcceptanceGuardAtomically({
      outgoingShiftId,
      actorUid: overrides.actorUid ?? "in-a",
      nowIso: overrides.nowIso ?? finalizeNowIso,
      exceptionalClosure: overrides.exceptionalClosure ?? null,
    });

  const reconcile = (uid) =>
    reconciliation.reconcileIncomingAcceptance({ outgoingShiftId, technicianUid: uid });

  const closureFor = (subjectUid, overrides = {}) => ({
    closureId: overrides.closureId ?? `closure_${subjectUid}`,
    subjectUid,
    reason: overrides.reason ?? "Technician did not report for the incoming shift.",
    recordedAt: overrides.recordedAt ?? iso(Date.parse(closureNowIso) - 1_000),
  });

  const addSupervisor = (uid = "sup-1") => {
    world.records.set(`users/${uid}`, {
      uid,
      role: "supervisor",
      status: "active",
      statusOperation: null,
      mustChangePassword: false,
      fullName: "Synthetic Supervisor",
    });
    return uid;
  };

  // Test-only authoritative declaration. The aggregate remains the single
  // source of absences; finalization still re-reads it inside its transaction.
  // The domain would move the position's confirmation into history and bump
  // the revision; this keeps the revision so the already-written acceptance
  // receipts stay bound to the same live reservation binding.
  const setAbsence = (uid, overrides = {}) => {
    const current = aggregate();
    const position = world.positionOf(uid);
    const absence = {
      position,
      technicianUid: uid,
      absenceType: overrides.absenceType ?? "not_yet_in",
      reportedDepartureTime: null,
      recordedBy: overrides.recordedBy ?? current.identity.outgoingTechnicianIds[0],
      attestedByUid: overrides.attestedByUid ?? null,
      reason: overrides.reason ?? "Declared not yet in.",
      recordedRevision: current.revision,
      revision: current.revision,
      recordedAt: overrides.recordedAt ?? iso(firstAppliedMs - 60_000),
    };
    current.confirmations = current.confirmations.filter((item) => item.position !== position);
    current.absences = [...current.absences, absence];
    const snapshotHash = domain.createEqualHandoverSnapshot(current).snapshotHash;
    current.confirmations = current.confirmations.map((item) => ({ ...item, snapshotHash }));
    return absence;
  };

  const patchRecord = (path, patch) => {
    const current = world.records.get(path);
    if (!current) throw new Error(`Cannot patch a missing record: ${path}`);
    Object.assign(current, patch);
    return current;
  };

  return Object.assign(world, {
    base,
    documentId,
    outgoingShiftId,
    incomingShiftId,
    aggregatePath,
    guardPath,
    aggregate,
    guard,
    reviewedBinding,
    firstAppliedMs,
    scheduledStart: aggregate().identity.scheduledStart,
    scheduledEnd: aggregate().identity.scheduledEnd,
    receiptId: (uid) =>
      applicationDomain.createIncomingAcceptanceApplicationIdentity({
        handoverId: aggregate().reservation.handoverId,
        technicianUid: uid,
        kind: "incoming_clock_in",
      }).receiptId,
    receiptPath: (uid) =>
      `incoming_acceptance_applications_v1/${
        applicationDomain.createIncomingAcceptanceApplicationIdentity({
          handoverId: aggregate().reservation.handoverId,
          technicianUid: uid,
          kind: "incoming_clock_in",
        }).receiptId
      }`,
    membershipPath: (uid) => `shift_members/${incomingShiftId}_${uid}`,
    attendancePath: (uid) => `shift_attendance/${incomingShiftId}_${uid}`,
    profile: (uid) => world.records.get(`users/${uid}`),
    positionOf: (uid) =>
      domain
        .getEqualHandoverPositions(aggregate().identity)
        .find((item) => item.technicianUid === uid && item.side === "incoming")?.position,
    proofFor,
    timeline,
    apply,
    finalizeGuard,
    reconcile,
    closureFor,
    addSupervisor,
    setAbsence,
    patchRecord,
    finalizeNowIso,
    closureNowIso,
    guardFinalization,
    guardLifecycle,
    reconciliation,
    iso,
    service,
    applicationDomain,
  });
}
