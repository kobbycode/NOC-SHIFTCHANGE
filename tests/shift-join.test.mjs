import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

import {
  assertOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} from "../src/lib/operations/operational-shift-control-state.ts";

const statusValues = {
  PENDING: "pending",
  CONSUMED: "consumed",
  COMPLETED: "completed",
  EXPIRED: "expired",
};
const attendanceAuthorities = {
  PRIMARY: "primary",
  TEMPORARY_AUTHORIZED: "temporary_authorized",
};
const attendanceStatuses = { PRESENT: "present" };

async function loadDomainModule() {
  const source = await readFile(
    new URL(
      "../src/lib/operations/shift-join-domain.ts",
      import.meta.url
    ),
    "utf8"
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loadedModule = { exports: {} };

  runInNewContext(javascript, {
    exports: loadedModule.exports,
    require(specifier) {
      if (specifier === "node:crypto") {
        return { createHash };
      }

      if (specifier === "./operational-shift-control-state") {
        return {
          assertOperationalShiftControl,
          assertShiftOwnsOperationalSlot,
        };
      }

      if (specifier === "./next-shift-authorization-domain") {
        return {
          assertNextShiftAuthorization:
            nextShiftAuthorizationDomain.assertNextShiftAuthorization,
          assertTemporaryTechnicianCanStartShift:
            nextShiftAuthorizationDomain.assertTemporaryTechnicianCanStartShift,
          NextShiftAuthorizationDomainError:
            nextShiftAuthorizationDomain.NextShiftAuthorizationDomainError,
          readActivePermanentPairTechnicianIds:
            nextShiftAuthorizationDomain.readActivePermanentPairTechnicianIds,
        };
      }

      if (specifier === "@/types/attendance") {
        return {
          ATTENDANCE_PARTICIPATION_AUTHORITIES:
            attendanceAuthorities,
          ATTENDANCE_STATUSES: attendanceStatuses,
        };
      }

      if (specifier === "@/types/next-shift-authorization") {
        return {};
      }

      throw new Error(`Unexpected join-domain import: ${specifier}`);
    },
  });

  return loadedModule.exports;
}

const nextShiftAuthorizationSource = await readFile(
  new URL(
    "../src/lib/operations/next-shift-authorization-domain.ts",
    import.meta.url
  ),
  "utf8"
);
const nextShiftAuthorizationJavaScript = ts.transpileModule(
  nextShiftAuthorizationSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }
).outputText;
const nextShiftAuthorizationModule = { exports: {} };

runInNewContext(nextShiftAuthorizationJavaScript, {
  exports: nextShiftAuthorizationModule.exports,
  require(specifier) {
    if (specifier === "node:crypto") {
      return { createHash };
    }

    if (specifier === "./operational-shift-control-state") {
      return {
        assertOperationalShiftControl,
        assertShiftOwnsOperationalSlot,
      };
    }

    if (specifier === "@/types/next-shift-authorization") {
      return {
        NEXT_SHIFT_AUTHORIZATION_STATUSES: statusValues,
      };
    }

    throw new Error(`Unexpected auth-domain import: ${specifier}`);
  },
});

const nextShiftAuthorizationDomain =
  nextShiftAuthorizationModule.exports;
const joinDomain = await loadDomainModule();

const firstSlotToken = "e1000000-0000-4000-8000-000000000001";
const previousSlotToken = "e1000000-0000-4000-8000-000000000002";
const shiftId = "synthetic-active-shift";
const pairId = "synthetic-active-pair";
const technicianA = "synthetic-primary-a";
const technicianB = "synthetic-primary-b";
const technicianC = "synthetic-temporary-c";
const timestamp = "2026-10-01T06:00:00.000Z";
const startedAt = "2026-10-01T06:05:00.000Z";
const scheduledStart = "2026-10-01T06:00:00.000Z";
const scheduledEnd = "2026-10-01T14:00:00.000Z";

const pair = {
  id: pairId,
  technicianIds: [technicianA, technicianB],
  status: "active",
  createdBy: "synthetic-manager",
  createdAt: timestamp,
  updatedAt: timestamp,
  deactivatedAt: null,
  deactivatedBy: null,
};

const pairMemberships = [
  {
    technicianUid: technicianA,
    pairId,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    technicianUid: technicianB,
    pairId,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];

const pendingControl = createPendingOperationalShiftControl(
  firstSlotToken,
  3,
  timestamp,
  previousSlotToken,
  timestamp
);
const consumedControl = transitionOperationalShiftControl(
  consumeOperationalShiftSlot(
    pendingControl,
    shiftId,
    timestamp
  ),
  shiftId,
  "scheduled",
  "active",
  startedAt
);

const activeShift = {
  id: shiftId,
  status: "active",
  permanentPairId: pairId,
  operationalSlotToken: firstSlotToken,
  primaryTechnicianIds: [technicianA, technicianB],
  actualStart: startedAt,
  actualEnd: null,
  scheduledStart,
  scheduledEnd,
};

const activeSchedule = (technicianUid) => ({
  technicianUid,
  entries: [
    {
      shiftId,
      scheduledStart,
      scheduledEnd,
      status: "active",
    },
  ],
  updatedAt: startedAt,
});

const activeMember = (technicianUid, role = "primary") => ({
  id: `${shiftId}_${technicianUid}`,
  shiftId,
  technicianId: technicianUid,
  role,
  joinedAt: timestamp,
  leftAt: null,
});

const eligibleActorProfile = {
  role: "technician",
  status: "active",
  mustChangePassword: false,
  statusOperation: null,
};

function currentIdentity(overrides = {}) {
  return joinDomain.validateActiveShiftJoinContext({
    actorUid: technicianA,
    actorProfile: eligibleActorProfile,
    actorEligibility: { eligible: true, message: null },
    shift: activeShift,
    control: consumedControl,
    permanentPair: pair,
    pairMemberships,
    ...overrides,
  });
}

function consumedAuthorization(overrides = {}) {
  const pending =
    nextShiftAuthorizationDomain.buildPendingNextShiftAuthorization({
      control: pendingControl,
      pair,
      permanentPairId: pairId,
      authorizedTechnicianUid: technicianC,
      technicianEligibility: { eligible: true, message: null },
      createdBy: "synthetic-manager",
      createdAt: timestamp,
    });
  const record = {
    ...pending,
    status: "consumed",
    shiftId,
    consumedAt: startedAt,
    updatedAt: startedAt,
    ...overrides,
  };

  record.id =
    overrides.id ??
    nextShiftAuthorizationDomain.createNextShiftAuthorizationDocumentId(
      record.permanentPairId,
      record.slotGeneration,
      record.slotToken
    );

  return nextShiftAuthorizationDomain.assertNextShiftAuthorization(
    record
  );
}

function validatePrimaryJoin(overrides = {}) {
  return joinDomain.assertPrimaryTechnicianCanJoinShift({
    identity: currentIdentity(),
    actorUid: technicianA,
    memberDocumentId: `${shiftId}_${technicianA}`,
    member: activeMember(technicianA),
    schedule: activeSchedule(technicianA),
    ...overrides,
  });
}

function validateTemporaryJoin(overrides = {}) {
  const authorization =
    overrides.authorization ?? consumedAuthorization();

  return joinDomain.assertTemporaryTechnicianCanJoinShift({
    identity: currentIdentity({ actorUid: technicianC }),
    actorUid: technicianC,
    actorProfile: eligibleActorProfile,
    actorEligibility: { eligible: true, message: null },
    permanentPair: pair,
    pairMemberships,
    authorizationDocumentId:
      overrides.authorizationDocumentId ?? authorization.id,
    authorization,
    memberAlreadyExists: false,
    ...overrides,
  });
}

test("active primary A and B may join only with their current primary roster and schedule", () => {
  for (const technicianUid of [technicianA, technicianB]) {
    const identity = currentIdentity({ actorUid: technicianUid });

    assert.doesNotThrow(() =>
      joinDomain.assertPrimaryTechnicianCanJoinShift({
        identity,
        actorUid: technicianUid,
        memberDocumentId: `${shiftId}_${technicianUid}`,
        member: activeMember(technicianUid),
        schedule: activeSchedule(technicianUid),
      })
    );
  }
});

test("primary join rejects missing, non-primary, left, or wrong-shift membership", () => {
  assert.throws(
    () =>
      validatePrimaryJoin({ member: null }),
    /current primary shift membership/
  );
  assert.throws(
    () =>
      validatePrimaryJoin({
        member: activeMember(technicianA, "additional"),
      }),
    /current primary shift membership/
  );
  assert.throws(
    () =>
      validatePrimaryJoin({
        member: { ...activeMember(technicianA), leftAt: startedAt },
      }),
    /current primary shift membership/
  );
  assert.throws(
    () =>
      validatePrimaryJoin({ memberDocumentId: "another-member" }),
    /current primary shift membership/
  );
});

test("primary join requires one matching ACTIVE schedule entry", () => {
  assert.throws(
    () => validatePrimaryJoin({ schedule: null }),
    /invalid scheduling record/
  );
  assert.throws(
    () =>
      validatePrimaryJoin({
        schedule: {
          ...activeSchedule(technicianA),
          entries: [
            { ...activeSchedule(technicianA).entries[0], status: "scheduled" },
          ],
        },
      }),
    /one active schedule entry/
  );
  assert.throws(
    () =>
      validatePrimaryJoin({
        schedule: {
          ...activeSchedule(technicianA),
          entries: [
            activeSchedule(technicianA).entries[0],
            activeSchedule(technicianA).entries[0],
          ],
        },
      }),
    /duplicate scheduling entries/
  );
});

test("only exact consumed C authorization permits temporary join", () => {
  const authorization = validateTemporaryJoin();

  assert.equal(authorization.status, "consumed");
  assert.equal(authorization.shiftId, shiftId);
  assert.equal(authorization.authorizedTechnicianUid, technicianC);
});

test("temporary join rejects unrelated, primary, duplicate-member, and invalid actors", () => {
  assert.throws(
    () =>
      validateTemporaryJoin({
        actorUid: "unrelated-technician",
      }),
    /does not permit this technician/
  );
  assert.throws(
    () =>
      validateTemporaryJoin({ actorUid: technicianA }),
    /permanent primary technician/
  );
  assert.throws(
    () =>
      validateTemporaryJoin({ memberAlreadyExists: true }),
    /membership already exists/
  );
});

test("scheduled, handover-pending, and completed shifts cannot be joined", () => {
  for (const status of ["scheduled", "handover_pending", "completed"]) {
    assert.throws(
      () =>
        currentIdentity({
          shift: { ...activeShift, status },
        }),
      /Only a structurally valid active shift/
    );
  }
});

test("slot, pair, and reservation mismatches reject join authority", () => {
  assert.throws(
    () =>
      currentIdentity({
        shift: {
          ...activeShift,
          operationalSlotToken: "e2000000-0000-4000-8000-000000000002",
        },
      }),
    /does not occupy the current global operational slot/
  );
  assert.throws(
    () =>
      currentIdentity({
        shift: {
          ...activeShift,
          primaryTechnicianIds: [technicianB, technicianA],
        },
      }),
    /do not match its permanent pair/
  );
  assert.throws(
    () =>
      currentIdentity({
        pairMemberships: [
          pairMemberships[0],
          { ...pairMemberships[1], pairId: "other-pair" },
        ],
      }),
    /reservations are missing or inconsistent/
  );
});

test("inactive and invalid technician profiles cannot join", () => {
  for (const profile of [
    { ...eligibleActorProfile, status: "blocked" },
    { ...eligibleActorProfile, mustChangePassword: true },
    { ...eligibleActorProfile, statusOperation: { id: "pending" } },
    { ...eligibleActorProfile, role: "supervisor" },
  ]) {
    assert.throws(
      () =>
        currentIdentity({
          actorProfile: profile,
          actorEligibility: {
            eligible: false,
            message: "The technician is not eligible.",
          },
        }),
      /not eligible/
    );
  }
});

test("attendance identity and provenance are deterministic and explicit", () => {
  const primaryAttendance = joinDomain.createShiftAttendanceRecord({
    shiftId,
    technicianUid: technicianA,
    participationAuthority: "primary",
    authorizationId: null,
    recordedAt: startedAt,
  });
  const temporaryAttendance = joinDomain.createShiftAttendanceRecord({
    shiftId,
    technicianUid: technicianC,
    participationAuthority: "temporary_authorized",
    authorizationId: consumedAuthorization().id,
    recordedAt: startedAt,
  });

  assert.equal(primaryAttendance.id, `${shiftId}_${technicianA}`);
  assert.equal(primaryAttendance.status, "present");
  assert.equal(primaryAttendance.authorizationId, null);
  assert.equal(primaryAttendance.recordedAt, startedAt);
  assert.equal(primaryAttendance.clockIn, null);
  assert.equal(primaryAttendance.clockOut, null);
  assert.equal(primaryAttendance.isProvisional, false);
  assert.equal(
    temporaryAttendance.participationAuthority,
    "temporary_authorized"
  );
  assert.equal(
    temporaryAttendance.authorizationId,
    consumedAuthorization().id
  );
});

test("join service is the only attendance writer and commits branch state atomically", async () => {
  const source = await readFile(
    new URL("../src/lib/operations/join-shift.ts", import.meta.url),
    "utf8"
  );
  const route = await readFile(
    new URL(
      "../src/app/(dashboard)/api/operations/shifts/[shiftId]/join/route.ts",
      import.meta.url
    ),
    "utf8"
  );
  const auditSource = await readFile(
    new URL("../src/lib/operations/collections.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /shiftAttendance\.doc\(\s*`\$\{shiftId\}_\$\{actorUid\}`\s*\)/s);
  assert.match(source, /transaction\.get\(attendanceRef\)/);
  assert.match(source, /if \(attendanceSnapshot\.exists\)/);
  assert.match(source, /transaction\.create\(\s*attendanceRef/);
  assert.match(source, /action: "SHIFT_TECHNICIAN_JOINED"/);
  assert.match(source, /transaction\.create\(\s*memberRef/);
  assert.match(source, /transaction\.set\(\s*scheduleRef/);
  assert.match(route, /actor\.role !== "technician"/);
  assert.match(route, /actorUid:\s*actor\.uid/);
  assert.doesNotMatch(route, /request\.json\(\)|technicianUid/);
  assert.equal(
    (auditSource.match(/SHIFT_ATTENDANCE/g) ?? []).length,
    2
  );
});