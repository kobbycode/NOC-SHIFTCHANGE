import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

import {
  assertOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
  consumeOperationalShiftSlot,
  createPendingOperationalShiftControl,
} from "../src/lib/operations/operational-shift-control-state.ts";

const domainSource = await readFile(
  new URL(
    "../src/lib/operations/next-shift-authorization-domain.ts",
    import.meta.url
  ),
  "utf8"
);
const domainJavaScript = ts.transpileModule(domainSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const domainModule = { exports: {} };

runInNewContext(domainJavaScript, {
  exports: domainModule.exports,
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
        NEXT_SHIFT_AUTHORIZATION_STATUSES: {
          PENDING: "pending",
          CONSUMED: "consumed",
          COMPLETED: "completed",
          EXPIRED: "expired",
        },
      };
    }

    throw new Error(`Unexpected domain import: ${specifier}`);
  },
});

const {
  assertNextShiftAuthorization,
  assertTemporaryTechnicianCanStartShift,
  buildPendingNextShiftAuthorization,
  createNextShiftAuthorizationDocumentId,
} = domainModule.exports;

const slotToken = "d1000000-0000-4000-8000-000000000001";
const unrelatedSlotToken = "d1000000-0000-4000-8000-000000000002";
const generation = 4;
const pairId = "synthetic-permanent-pair";
const technicianA = "synthetic-technician-a";
const technicianB = "synthetic-technician-b";
const technicianC = "synthetic-technician-c";
const shiftId = "synthetic-scheduled-shift";
const createdAt = "2026-10-01T00:00:00.000Z";
const scheduledStart = "2026-10-01T08:00:00.000Z";
const scheduledEnd = "2026-10-01T16:00:00.000Z";
const startedAt = "2026-10-01T07:50:00.000Z";

const pair = {
  id: pairId,
  technicianIds: [technicianA, technicianB],
  status: "active",
  createdBy: "synthetic-supervisor",
  createdAt,
  updatedAt: createdAt,
  deactivatedAt: null,
  deactivatedBy: null,
};

const memberships = [
  {
    technicianUid: technicianA,
    pairId,
    createdAt,
    updatedAt: createdAt,
  },
  {
    technicianUid: technicianB,
    pairId,
    createdAt,
    updatedAt: createdAt,
  },
];

const scheduledControl = consumeOperationalShiftSlot(
  createPendingOperationalShiftControl(
    slotToken,
    generation,
    createdAt,
    "d0000000-0000-4000-8000-000000000009",
    createdAt
  ),
  shiftId,
  createdAt
);

const shift = {
  id: shiftId,
  status: "scheduled",
  permanentPairId: pairId,
  operationalSlotToken: slotToken,
  primaryTechnicianIds: [technicianA, technicianB],
  scheduledStart,
  scheduledEnd,
  actualStart: null,
  actualEnd: null,
};

const eligibleProfile = {
  role: "technician",
  status: "active",
  statusOperation: null,
  mustChangePassword: false,
};

function authorization(overrides = {}) {
  const pending = buildPendingNextShiftAuthorization({
    control: createPendingOperationalShiftControl(
      slotToken,
      generation,
      createdAt,
      "d0000000-0000-4000-8000-000000000009",
      createdAt
    ),
    pair,
    permanentPairId: pairId,
    authorizedTechnicianUid: technicianC,
    technicianEligibility: {
      eligible: true,
      message: null,
    },
    createdBy: "synthetic-supervisor",
    createdAt,
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
    createNextShiftAuthorizationDocumentId(
      record.permanentPairId,
      record.slotGeneration,
      record.slotToken
    );

  return assertNextShiftAuthorization(record);
}

function canTemporaryTechnicianStart(overrides = {}) {
  const authorized = authorization();

  return assertTemporaryTechnicianCanStartShift({
    actorUid: technicianC,
    actorProfile: eligibleProfile,
    technicianEligibility: {
      eligible: true,
      message: null,
    },
    shift,
    control: scheduledControl,
    permanentPair: pair,
    pairMemberships: memberships,
    authorizationDocumentId: authorized.id,
    authorization: authorized,
    ...overrides,
  });
}

test("consumed authorization grants only the exact intended technician the scheduled shift", () => {
  const validated = canTemporaryTechnicianStart();

  assert.equal(validated.id, authorization().id);
  assert.equal(validated.status, "consumed");
  assert.equal(validated.shiftId, shiftId);
  assert.equal(validated.authorizedTechnicianUid, technicianC);
});

test("ordinary technician without a consumed authorization is rejected", () => {
  assert.throws(
    () =>
      assertTemporaryTechnicianCanStartShift({
        actorUid: technicianC,
        actorProfile: eligibleProfile,
        technicianEligibility: { eligible: true, message: null },
        shift,
        control: scheduledControl,
        permanentPair: pair,
        pairMemberships: memberships,
        authorizationDocumentId: "missing-authorization",
        authorization: undefined,
      }),
    /malformed or unavailable/
  );
});

test("actor UID must equal the consumed authorization technician", () => {
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        actorUid: "different-technician",
      }),
    /does not permit this technician/
  );
});

test("authorization must be consumed and cannot be pending, completed, or expired", () => {
  const invalidStates = [
    authorization({
      status: "pending",
      shiftId: null,
      consumedAt: null,
      updatedAt: createdAt,
    }),
    authorization({
      status: "completed",
      completedAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-01T08:00:00.000Z",
    }),
    authorization({
      status: "expired",
      expiredAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-01T08:00:00.000Z",
    }),
  ];

  for (const record of invalidStates) {
    assert.throws(
      () =>
        canTemporaryTechnicianStart({
          authorization: record,
        }),
      /does not permit this technician/
    );
  }
});

test("authorization shift ID must exactly match the target shift", () => {
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        authorization: authorization({ shiftId: "another-shift" }),
      }),
    /does not permit this technician/
  );
});

test("authorization token and generation must match shift and control", () => {
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        authorization: authorization({ slotToken: unrelatedSlotToken }),
      }),
    /does not permit this technician/
  );
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        authorization: authorization({ slotGeneration: generation - 1 }),
      }),
    /does not permit this technician/
  );
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        shift: { ...shift, operationalSlotToken: unrelatedSlotToken },
      }),
    /not the current occupant/
  );
});

test("authorization pair must match shift pair and active A+B identity", () => {
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        authorization: authorization({
          permanentPairId: "another-pair",
        }),
      }),
    /does not permit this technician/
  );
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        permanentPair: { ...pair, status: "inactive" },
      }),
    /inactive, corrupt/
  );
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        shift: {
          ...shift,
          primaryTechnicianIds: [technicianB, technicianA],
        },
      }),
    /do not match its permanent pair/
  );
});

test("both active pair reservations must point to this pair and expected members", () => {
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        pairMemberships: [
          memberships[0],
          { ...memberships[1], pairId: "another-pair" },
        ],
      }),
    /reservations are missing or inconsistent/
  );
});

test("completed, expired, or malformed consumed authorization is rejected", () => {
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        authorization: authorization({
          status: "completed",
          completedAt: "2026-10-01T07:55:00.000Z",
          updatedAt: "2026-10-01T07:55:00.000Z",
        }),
      }),
    /malformed or unavailable|does not permit this technician/
  );
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        authorization: authorization({
          status: "expired",
          expiredAt: "2026-10-01T07:55:00.000Z",
          updatedAt: "2026-10-01T07:55:00.000Z",
        }),
      }),
    /malformed or unavailable|does not permit this technician/
  );
  assert.throws(
    () =>
      canTemporaryTechnicianStart({
        authorization: { id: "malformed" },
      }),
    /malformed or unavailable/
  );
});

test("blocked, password-change-required, pending-operation, and non-technician profiles fail eligibility", () => {
  for (const profile of [
    { ...eligibleProfile, status: "blocked" },
    { ...eligibleProfile, mustChangePassword: true },
    { ...eligibleProfile, statusOperation: { operationId: "pending" } },
    { ...eligibleProfile, role: "supervisor" },
  ]) {
    assert.throws(
      () =>
        canTemporaryTechnicianStart({
          actorProfile: profile,
          technicianEligibility: {
            eligible: false,
            message: "The technician is not eligible.",
          },
        }),
      /not eligible|not permit this technician/
    );
  }
});

test("permanent pair members cannot use the temporary start branch", () => {
  for (const uid of [technicianA, technicianB]) {
    assert.throws(
      () =>
        canTemporaryTechnicianStart({
          actorUid: uid,
          authorization: authorization({
            authorizedTechnicianUid: uid,
          }),
        }),
      /does not permit this technician/
    );
  }
});

test("active shifts and changed control states cannot be started a second time", () => {
  const activeShift = { ...shift, status: "active" };
  const activeControl = {
    ...scheduledControl,
    shiftStatus: "active",
    updatedAt: startedAt,
  };

  assert.throws(
    () => canTemporaryTechnicianStart({ shift: activeShift }),
    /scheduled shift/
  );
  assert.throws(
    () => canTemporaryTechnicianStart({ control: activeControl }),
    /not the current occupant/
  );
});

test("G-D source preserves manager start and keeps temporary start read-only for C", async () => {
  const source = await readFile(
    new URL("../src/lib/operations/start-shift.ts", import.meta.url),
    "utf8"
  );
  const route = await readFile(
    new URL(
      "../src/app/(dashboard)/api/operations/shifts/[shiftId]/start/route.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(source, /actorIsManager/);
  assert.match(source, /actorIsTechnician/);
  assert.match(source, /assertShiftActivationWindow\(/);
  assert.match(source, /assertTemporaryTechnicianCanStartShift\(/);
  assert.match(source, /assertValidShiftTransition\(/);
  assert.match(source, /assertShiftReadyToStart\(/);
  assert.match(source, /transaction\.update\(\s*shiftRef/);
  assert.match(source, /transaction\.update\(\s*operationalShiftControlRef/);
  assert.match(source, /SHIFT_STARTED/);
  assert.match(source, /temporaryAuthorizationId/);
  assert.match(route, /actor\.role !== "technician"/);
  assert.match(route, /actorUid:\s*actor\.uid/);
  assert.doesNotMatch(route, /authorizationId|slotToken|slotGeneration/);
  assert.doesNotMatch(source, /transaction\.(?:create|update)\([^)]*attendance/i);
  assert.doesNotMatch(
    source,
    /transaction\.(?:create|set)\(\s*(?:memberRef|shiftMemberRef)/
  );
  assert.doesNotMatch(
    source,
    /technicianSchedules\.doc\(\s*authorization(?:\.|\))/
  );
  assert.doesNotMatch(source, /joinedAt|clockIn|clockOut/);
  assert.doesNotMatch(source, /nextShiftAuthorizations\.(?:doc|where)[^;]*transaction\.(?:create|update)/s);
  assert.doesNotMatch(source, /primaryTechnicianIds\s*=|primaryTechnicianIds:\s*\[/);
});

test("G-D start writes remain after every transactional authorization and roster read", async () => {
  const source = await readFile(
    new URL("../src/lib/operations/start-shift.ts", import.meta.url),
    "utf8"
  );
  const firstWriteIndex = source.search(/transaction\.(?:update|create|delete|set)\s*\(/);
  const authCheckIndex = source.indexOf(
    "assertTemporaryTechnicianCanStartShift({"
  );
  const memberQueryIndex = source.indexOf(
    "shiftMembers.where("
  );

  assert.notEqual(firstWriteIndex, -1);
  assert.ok(authCheckIndex > -1 && authCheckIndex < firstWriteIndex);
  assert.ok(memberQueryIndex > -1 && memberQueryIndex < firstWriteIndex);
});