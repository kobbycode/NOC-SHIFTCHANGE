import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

import {
  advanceOperationalShiftControl,
  assertOperationalShiftControl as assertOperationalShiftControlFromSlotState,
  createPendingOperationalShiftControl,
  consumeOperationalShiftSlot,
  transitionOperationalShiftControl,
} from "../src/lib/operations/operational-shift-control-state.ts";

const domainSource = await readFile(
  new URL(
    "../src/lib/operations/next-shift-authorization-domain.ts",
    import.meta.url
  ),
  "utf8"
);
const domainJavaScript = ts.transpileModule(
  domainSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }
).outputText;
const domainModule = { exports: {} };
const authorizationStatuses = {
  PENDING: "pending",
  CONSUMED: "consumed",
  COMPLETED: "completed",
  EXPIRED: "expired",
};

runInNewContext(
  domainJavaScript,
  {
    exports: domainModule.exports,
    require(specifier) {
      if (specifier === "node:crypto") {
        return { createHash };
      }

      if (
        specifier ===
        "./operational-shift-control-state"
      ) {
        return {
          assertOperationalShiftControl:
            assertOperationalShiftControlFromSlotState,
        };
      }

      if (
        specifier ===
        "@/types/next-shift-authorization"
      ) {
        return {
          NEXT_SHIFT_AUTHORIZATION_STATUSES:
            authorizationStatuses,
        };
      }

      throw new Error(`Unexpected domain import: ${specifier}`);
    },
  }
);

const {
  assertNextShiftAuthorization,
  buildNextShiftAuthorizationConsumedAuditData,
  buildNextShiftAuthorizationAuditData,
  buildShiftCreationPairBinding,
  buildPendingNextShiftAuthorization,
  completeConsumedNextShiftAuthorization,
  createNextShiftAuthorizationDocumentId,
  parseCreateNextShiftAuthorizationInput,
  readActivePermanentPairTechnicianIds,
  selectPendingAuthorizationForShift,
} = domainModule.exports;

const currentSlotToken =
  "c1000000-0000-4000-8000-000000000001";
const previousSlotToken =
  "c1000000-0000-4000-8000-000000000002";
const nextSlotToken =
  "c1000000-0000-4000-8000-000000000003";
const timestamp = "2026-10-01T00:00:00.000Z";

function pendingControl() {
  return createPendingOperationalShiftControl(
    currentSlotToken,
    2,
    timestamp,
    previousSlotToken,
    timestamp
  );
}

const pair = {
  id: "permanent-pair-1",
  technicianIds: ["permanent-a", "permanent-b"],
  status: "active",
  createdBy: "supervisor-1",
  createdAt: timestamp,
  updatedAt: timestamp,
  deactivatedAt: null,
  deactivatedBy: null,
};

const pairMemberships = [
  {
    technicianUid: "permanent-a",
    pairId: pair.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    technicianUid: "permanent-b",
    pairId: pair.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];

function buildAuthorization(overrides = {}) {
  return buildPendingNextShiftAuthorization({
    control: pendingControl(),
    pair,
    permanentPairId: pair.id,
    authorizedTechnicianUid: "temporary-c",
    technicianEligibility: {
      eligible: true,
      message: null,
    },
    createdBy: "supervisor-1",
    createdAt: timestamp,
    ...overrides,
  });
}

test("valid authorization captures the exact current pending slot", () => {
  const authorization = buildAuthorization();

  assert.equal(authorization.status, "pending");
  assert.equal(authorization.slotToken, currentSlotToken);
  assert.equal(authorization.slotGeneration, 2);
  assert.equal(authorization.permanentPairId, pair.id);
  assert.equal(
    authorization.authorizedTechnicianUid,
    "temporary-c"
  );
  assert.equal(authorization.shiftId, null);
  assert.equal(authorization.consumedAt, null);
  assert.equal(authorization.completedAt, null);
  assert.equal(authorization.expiredAt, null);
});

test("request accepts only pair and technician identifiers", () => {
  assert.deepEqual(
    structuredClone(parseCreateNextShiftAuthorizationInput({
      permanentPairId: pair.id,
      authorizedTechnicianUid: "temporary-c",
    })),
    {
      permanentPairId: pair.id,
      authorizedTechnicianUid: "temporary-c",
    }
  );

  assert.throws(
    () =>
      parseCreateNextShiftAuthorizationInput({
        permanentPairId: pair.id,
        authorizedTechnicianUid: "temporary-c",
        slotToken: previousSlotToken,
        slotGeneration: 1,
      }),
    /Only permanentPairId and authorizedTechnicianUid/
  );
});

test("inactive or nonexistent permanent pairs are rejected", () => {
  assert.throws(
    () =>
      buildAuthorization({
        pair: { ...pair, status: "inactive" },
      }),
    /pair is unavailable/
  );
  assert.throws(
    () => buildAuthorization({ pair: null }),
    /pair is unavailable/
  );
});

test("a permanent pair member cannot be authorized as temporary", () => {
  assert.throws(
    () =>
      buildAuthorization({
        authorizedTechnicianUid: "permanent-a",
      }),
    /pair member cannot be authorized/
  );
});

test("ineligible or nonexistent technician profile is rejected", () => {
  assert.throws(
    () =>
      buildAuthorization({
        technicianEligibility: {
          eligible: false,
          message:
            "The selected technician account was not found.",
        },
      }),
    /selected technician account was not found/
  );
});

test("pair and slot produce one deterministic authorization document ID", () => {
  const firstId = createNextShiftAuthorizationDocumentId(
    pair.id,
    2,
    currentSlotToken
  );
  const retryId = createNextShiftAuthorizationDocumentId(
    pair.id,
    2,
    currentSlotToken
  );
  const otherGenerationId =
    createNextShiftAuthorizationDocumentId(
      pair.id,
      3,
      nextSlotToken
    );

  assert.equal(firstId, retryId);
  assert.notEqual(firstId, otherGenerationId);
});

test("occupied global slot cannot receive a new authorization", () => {
  const occupiedControl = consumeOperationalShiftSlot(
    pendingControl(),
    "shift-1",
    timestamp
  );

  assert.throws(
    () =>
      buildAuthorization({ control: occupiedControl }),
    /current pending global shift slot/
  );
});

test("building authorization leaves global slot state unchanged", () => {
  const control = pendingControl();
  const before = structuredClone(control);

  buildAuthorization({ control });

  assert.deepEqual(control, before);
  assert.equal(control.slotStatus, "pending");
  assert.equal(control.generation, 2);
  assert.equal(control.slotToken, currentSlotToken);
});

test("old token and generation cannot replace the current slot identity", () => {
  const authorization = buildAuthorization();

  assert.equal(authorization.slotToken, currentSlotToken);
  assert.equal(authorization.slotGeneration, 2);
  assert.notEqual(authorization.slotToken, previousSlotToken);

  const consumed = consumeOperationalShiftSlot(
    pendingControl(),
    "shift-1",
    timestamp
  );
  const active = transitionOperationalShiftControl(
    consumed,
    "shift-1",
    "scheduled",
    "active",
    timestamp
  );
  const handoverPending = transitionOperationalShiftControl(
    active,
    "shift-1",
    "active",
    "handover_pending",
    "2026-10-01T00:30:00.000Z"
  );
  const advancedControl = advanceOperationalShiftControl(
    handoverPending,
    "shift-1",
    nextSlotToken,
    "2026-10-01T01:00:00.000Z"
  );

  /*
   * Control advancement is only valid from handover pending.
   */
  assert.equal(advancedControl.slotToken, nextSlotToken);
  assert.equal(advancedControl.generation, 3);
  assert.notEqual(
    authorization.slotToken,
    advancedControl.slotToken
  );
});

test("audit data names actor, pair, technician, slot, generation, and action", () => {
  const authorization = buildAuthorization();
  const audit = buildNextShiftAuthorizationAuditData(
    authorization,
    "supervisor-1",
    "audit-record-1",
    timestamp
  );

  assert.deepEqual(structuredClone(audit), {
    id: "audit-record-1",
    action: "NEXT_SHIFT_AUTHORIZATION_CREATED",
    actorUid: "supervisor-1",
    targetAuthorizationId: authorization.id,
    permanentPairId: pair.id,
    authorizedTechnicianUid: "temporary-c",
    slotToken: currentSlotToken,
    slotGeneration: 2,
    details:
      "An authorized manager created a temporary technician authorization for the current global next-shift slot.",
    createdAt: timestamp,
  });
});

test("failed validation has no authorization or audit plan", () => {
  let auditCreated = false;

  assert.throws(() => {
    const authorization = buildAuthorization({
      technicianEligibility: {
        eligible: false,
        message: "The technician account is not active.",
      },
    });

    buildNextShiftAuthorizationAuditData(
      authorization,
      "supervisor-1",
      "audit-record-1",
      timestamp
    );
    auditCreated = true;
  }, /technician account is not active/);

  assert.equal(auditCreated, false);
});

test("stored authorization requires a strict normalized pending shape", () => {
  const authorization = buildAuthorization();

  assert.deepEqual(
    structuredClone(assertNextShiftAuthorization(authorization)),
    structuredClone(authorization)
  );
  assert.throws(
    () =>
      assertNextShiftAuthorization({
        ...authorization,
        status: "pending",
        shiftId: "shift-1",
      }),
    /pending authorization cannot contain shift lifecycle metadata/
  );
});

test("stored authorization identity must match its pair and slot", () => {
  const authorization = buildAuthorization();

  assert.throws(
    () =>
      assertNextShiftAuthorization({
        ...authorization,
        id: "another-document",
      }),
    /inconsistent identity/
  );
});

test("reserved future lifecycle states require coherent shift metadata", () => {
  const authorization = buildAuthorization();
  const consumed = {
    ...authorization,
    status: "consumed",
    shiftId: "shift-1",
    consumedAt: "2026-10-01T00:30:00.000Z",
    updatedAt: "2026-10-01T00:30:00.000Z",
  };
  const completed = {
    ...consumed,
    status: "completed",
    completedAt: "2026-10-01T01:00:00.000Z",
    updatedAt: "2026-10-01T01:00:00.000Z",
  };
  const expired = {
    ...authorization,
    status: "expired",
    expiredAt: "2026-10-01T01:00:00.000Z",
    updatedAt: "2026-10-01T01:00:00.000Z",
  };

  assert.equal(assertNextShiftAuthorization(consumed).status, "consumed");
  assert.equal(assertNextShiftAuthorization(completed).status, "completed");
  assert.equal(assertNextShiftAuthorization(expired).status, "expired");
  assert.throws(
    () =>
      assertNextShiftAuthorization({
        ...expired,
        shiftId: "shift-1",
      }),
    /expired authorization metadata is invalid/
  );
});

test("service checks eligibility and deterministic existing record before writes", async () => {
  const source = await readFile(
    new URL(
      "../src/lib/operations/next-shift-authorizations.ts",
      import.meta.url
    ),
    "utf8"
  );
  const eligibilityIndex = source.indexOf(
    "evaluateAssignmentEligibility("
  );
  const existingCheckIndex = source.indexOf(
    "if (existingAuthorizationSnapshot.exists)"
  );
  const builderCall = source.match(
    /authorization\s*=\s*buildPendingNextShiftAuthorization\(/s
  );
  const writeIndexes = [
    ...source.matchAll(/transaction\.(?:update|create|delete|set)\s*\(/g),
  ].map((match) => match.index);

  assert.notEqual(eligibilityIndex, -1);
  assert.notEqual(existingCheckIndex, -1);
  assert.ok(builderCall);
  assert.match(
    source,
    /const authorizationRef\s*=\s*nextShiftAuthorizations\.doc\(\s*authorizationId\s*\)/s
  );
  assert.match(
    source,
    /transaction\.get\(authorizationRef\)/
  );
  assert.match(
    source,
    /transaction\.create\(\s*authorizationRef,\s*authorization\s*\)/s
  );
  assert.ok(eligibilityIndex < existingCheckIndex);
  assert.ok(existingCheckIndex < builderCall.index);
  assert.ok(
    writeIndexes.every((writeIndex) => writeIndex > builderCall.index)
  );
  assert.doesNotMatch(
    source,
    /transaction\.(?:update|create|delete|set)\(\s*controlRef/
  );
});

function authorizationDocument(authorization) {
  return {
    id: authorization.id,
    data: authorization,
  };
}

function createShiftBinding(overrides = {}) {
  return buildShiftCreationPairBinding({
    control: pendingControl(),
    permanentPairId: pair.id,
    pair,
    pairMemberships,
    authorization: buildAuthorization(),
    temporaryTechnicianEligibility: {
      eligible: true,
      message: null,
    },
    shiftId: "new-scheduled-shift",
    createdAt: "2026-10-01T01:00:00.000Z",
    ...overrides,
  });
}

test("matching current-slot authorization is selected and consumed for its shift", () => {
  const authorization = buildAuthorization();
  const selected = selectPendingAuthorizationForShift(
    pendingControl(),
    pair.id,
    [authorizationDocument(authorization)]
  );
  const binding = createShiftBinding({ authorization: selected });
  const consumedControl = consumeOperationalShiftSlot(
    pendingControl(),
    "new-scheduled-shift",
    "2026-10-01T01:00:00.000Z"
  );

  assert.equal(binding.consumedAuthorization.status, "consumed");
  assert.equal(
    binding.consumedAuthorization.shiftId,
    "new-scheduled-shift"
  );
  assert.equal(consumedControl.shiftId, "new-scheduled-shift");
  assert.equal(
    binding.consumedAuthorization.slotToken,
    consumedControl.slotToken
  );
  assert.equal(
    binding.consumedAuthorization.slotGeneration,
    pendingControl().generation
  );
  assert.equal(
    binding.consumedAuthorization.consumedAt,
    "2026-10-01T01:00:00.000Z"
  );
  assert.equal(binding.consumedAuthorization.completedAt, null);
  assert.equal(binding.consumedAuthorization.expiredAt, null);
});

test("shift pair identity and primary A/B IDs come from the active pair snapshot", () => {
  const binding = createShiftBinding({ authorization: null });

  assert.equal(binding.permanentPairId, pair.id);
  assert.deepEqual(
    structuredClone(binding.primaryTechnicianIds),
    pair.technicianIds
  );
});

test("active permanent pair requires consistent deactivation metadata", () => {
  assert.deepEqual(
    structuredClone(readActivePermanentPairTechnicianIds(pair, pair.id)),
    pair.technicianIds
  );
  assert.throws(
    () =>
      readActivePermanentPairTechnicianIds(
        { ...pair, status: "inactive" },
        pair.id
      ),
    /inactive, corrupt/
  );
  assert.throws(
    () =>
      readActivePermanentPairTechnicianIds(
        { ...pair, deactivatedAt: timestamp },
        pair.id
      ),
    /inactive, corrupt/
  );
  assert.throws(
    () =>
      readActivePermanentPairTechnicianIds(
        { ...pair, technicianIds: ["permanent-a", "permanent-a"] },
        pair.id
      ),
    /inactive, corrupt/
  );
});

test("both pair reservations must belong to their expected member and pair", () => {
  assert.throws(
    () =>
      createShiftBinding({
        authorization: null,
        pairMemberships: [
          pairMemberships[0],
          { ...pairMemberships[1], pairId: "another-pair" },
        ],
      }),
    /reservations are missing or inconsistent/
  );
  assert.throws(
    () =>
      createShiftBinding({
        authorization: null,
        pairMemberships: [pairMemberships[0], null],
      }),
    /reservations are missing or inconsistent/
  );
});

test("temporary technician cannot be either permanent pair member", () => {
  for (const technicianUid of pair.technicianIds) {
    assert.throws(
      () =>
        createShiftBinding({
          authorization: {
            ...buildAuthorization(),
            authorizedTechnicianUid: technicianUid,
          },
        }),
      /permanent pair member cannot be attached/
    );
  }
});

test("temporary technician is revalidated and ineligible profiles reject binding", () => {
  assert.throws(
    () =>
      createShiftBinding({
        temporaryTechnicianEligibility: {
          eligible: false,
          message: "The technician account is not active.",
        },
      }),
    /technician account is not active/
  );
});

test("stale token and stale generation authorizations cannot be selected", () => {
  const staleTokenControl = createPendingOperationalShiftControl(
    previousSlotToken,
    1,
    timestamp
  );
  const staleGenerationControl = createPendingOperationalShiftControl(
    currentSlotToken,
    1,
    timestamp
  );
  const staleTokenAuthorization = buildAuthorization({
    control: staleTokenControl,
  });
  const staleGenerationAuthorization = buildAuthorization({
    control: staleGenerationControl,
  });

  assert.throws(
    () =>
      selectPendingAuthorizationForShift(
        pendingControl(),
        pair.id,
        [authorizationDocument(staleTokenAuthorization)]
      ),
    /does not match the current global slot/
  );
  assert.throws(
    () =>
      selectPendingAuthorizationForShift(
        pendingControl(),
        pair.id,
        [authorizationDocument(staleGenerationAuthorization)]
      ),
    /does not match the current global slot/
  );
});

test("consumed authorization cannot be selected or rebound", () => {
  const consumed = createShiftBinding().consumedAuthorization;

  assert.throws(
    () =>
      selectPendingAuthorizationForShift(
        pendingControl(),
        pair.id,
        [authorizationDocument(consumed)]
      ),
    /is not pending/
  );
  assert.throws(
    () =>
      createShiftBinding({ authorization: consumed }),
    /stale, already consumed/
  );
});

test("authorization for a different permanent pair fails closed", () => {
  const otherPair = { ...pair, id: "another-pair" };
  const otherPairAuthorization = buildPendingNextShiftAuthorization({
    control: pendingControl(),
    pair: otherPair,
    permanentPairId: otherPair.id,
    authorizedTechnicianUid: "temporary-c",
    technicianEligibility: {
      eligible: true,
      message: null,
    },
    createdBy: "supervisor-1",
    createdAt: timestamp,
  });

  assert.throws(
    () =>
      selectPendingAuthorizationForShift(
        pendingControl(),
        pair.id,
        [authorizationDocument(otherPairAuthorization)]
      ),
    /different permanent pair exists/
  );
});

test("multiple authorizations for one slot fail closed", () => {
  const otherPairAuthorization = buildPendingNextShiftAuthorization({
    control: pendingControl(),
    pair: { ...pair, id: "another-pair" },
    permanentPairId: "another-pair",
    authorizedTechnicianUid: "temporary-d",
    technicianEligibility: {
      eligible: true,
      message: null,
    },
    createdBy: "supervisor-1",
    createdAt: timestamp,
  });

  assert.throws(
    () =>
      selectPendingAuthorizationForShift(
        pendingControl(),
        pair.id,
        [
          authorizationDocument(buildAuthorization()),
          authorizationDocument(otherPairAuthorization),
        ]
      ),
    /More than one temporary authorization/
  );
});

test("shift creation remains available when the current slot has no authorization", () => {
  assert.equal(
    selectPendingAuthorizationForShift(
      pendingControl(),
      pair.id,
      []
    ),
    null
  );
  const binding = createShiftBinding({ authorization: null });

  assert.equal(binding.consumedAuthorization, null);
  assert.deepEqual(
    structuredClone(binding.primaryTechnicianIds),
    pair.technicianIds
  );
});

test("authorization consumption creates an auditable shift binding", () => {
  const consumed = createShiftBinding().consumedAuthorization;
  const audit = buildNextShiftAuthorizationConsumedAuditData(
    consumed,
    "supervisor-1",
    "new-scheduled-shift",
    currentSlotToken,
    2,
    "audit-consumed-1",
    "2026-10-01T01:00:00.000Z"
  );

  assert.equal(audit.action, "NEXT_SHIFT_AUTHORIZATION_CONSUMED");
  assert.equal(audit.actorUid, "supervisor-1");
  assert.equal(audit.targetAuthorizationId, consumed.id);
  assert.equal(audit.targetShiftId, consumed.shiftId);
  assert.equal(audit.permanentPairId, pair.id);
  assert.equal(
    audit.authorizedTechnicianUid,
    "temporary-c"
  );
  assert.equal(audit.slotToken, currentSlotToken);
  assert.equal(audit.slotGeneration, 2);
});

test("binding does not mutate the pair or produce membership, schedule, or attendance data", () => {
  const pairBefore = structuredClone(pair);
  const membershipsBefore = structuredClone(pairMemberships);
  const binding = createShiftBinding();

  assert.deepEqual(pair, pairBefore);
  assert.deepEqual(pairMemberships, membershipsBefore);
  assert.equal("technicianPairMemberships" in binding, false);
  assert.equal("shiftMembers" in binding, false);
  assert.equal("technicianSchedules" in binding, false);
  assert.equal("attendance" in binding, false);
});

test("createShift reads authorization before any writes and writes all bindings in one transaction", async () => {
  const source = await readFile(
    new URL("../src/lib/operations/create-shift.ts", import.meta.url),
    "utf8"
  );
  const resolveIndex = source.indexOf(
    "selectPendingAuthorizationForShift("
  );
  const bindingIndex = source.indexOf(
    "buildShiftCreationPairBinding({"
  );
  const transactionWrites = [
    ...source.matchAll(/transaction\.(?:update|create|delete|set)\s*\(/g),
  ].map((match) => match.index);

  assert.notEqual(resolveIndex, -1);
  assert.notEqual(bindingIndex, -1);
  assert.ok(resolveIndex < bindingIndex);
  assert.ok(
    transactionWrites.every((writeIndex) => writeIndex > bindingIndex)
  );
  assert.match(
    source,
    /transaction\.create\(\s*shiftRef,\s*createdShift\s*\)/s
  );
  assert.match(
    source,
    /transaction\.(?:update|create)\(\s*operationalShiftControlRef,/s
  );
  assert.match(
    source,
    /transaction\.update\(\s*nextShiftAuthorizations\.doc\(/s
  );
  assert.match(
    source,
    /transaction\.create\(\s*consumptionAuditRef,/s
  );
  assert.match(source, /permanentPairId:\s*binding\.permanentPairId/);
  assert.match(
    source,
    /primaryTechnicianIds:\s*binding\.primaryTechnicianIds/
  );
  assert.match(
    source,
    /shiftMembers\.doc\(\s*`\$\{shiftRef\.id\}_\$\{technicianUid\}`\s*\)/s
  );
  assert.match(
    source,
    /technicianSchedules\.doc\(\s*technicianUid\s*\)/s
  );
  assert.match(source, /requireEligibleTechnician\(/);
  assert.match(source, /preparePrimaryShiftRoster\(/);
  assert.match(
    source,
    /transaction\.create\(\s*primaryMemberRefs\[index\],\s*primaryMembers\[index\]\s*\)/s
  );
  assert.match(
    source,
    /transaction\.set\(\s*primaryScheduleRefs\[index\],\s*primarySchedules\[index\]\s*\)/s
  );
  assert.doesNotMatch(
    source,
    /shiftMembers\.doc\([^)]*authorization\.authorizedTechnicianUid/s
  );
});

test("shift creation API only accepts selected pair ID, never pair members or slot authority", async () => {
  const source = await readFile(
    new URL(
      "../src/app/(dashboard)/api/operations/shifts/route.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(source, /permanentPairId/);
  assert.match(source, /Object\.keys\(input\)\.length !== 4/);
  assert.doesNotMatch(source, /authorizedTechnicianUid|slotToken|slotGeneration/);
  assert.match(source, /createdBy:\s*actor\.uid/);
});
/*
 * G-F.1B
 * Consumed temporary authorization completion.
 */

const completionShiftId =
  "synthetic-completion-shift";

const completionConsumedAt =
  "2026-10-01T01:00:00.000Z";

const completionTimestamp =
  "2026-10-01T02:00:00.000Z";

function consumedAuthorizationForCompletion(
  overrides = {}
) {
  const pending = buildAuthorization();

  const record = {
    ...pending,
    status: "consumed",
    shiftId: completionShiftId,
    consumedAt: completionConsumedAt,
    completedAt: null,
    expiredAt: null,
    updatedAt: completionConsumedAt,
    ...overrides,
  };

  return assertNextShiftAuthorization(record);
}

function completeAuthorization(overrides = {}) {
  const authorization =
    overrides.authorization ??
    consumedAuthorizationForCompletion();

  return completeConsumedNextShiftAuthorization({
    authorization,
    shiftId:
      overrides.shiftId ??
      completionShiftId,
    slotToken:
      overrides.slotToken ??
      currentSlotToken,
    slotGeneration:
      overrides.slotGeneration ?? 2,
    permanentPairId:
      overrides.permanentPairId ??
      pair.id,
    completedAt:
      overrides.completedAt ??
      completionTimestamp,
  });
}

test(
  "consumed authorization completes with exact terminal lifecycle metadata",
  () => {
    const before =
      consumedAuthorizationForCompletion();

    const completed =
      completeAuthorization({
        authorization: before,
      });

    assert.equal(completed.status, "completed");
    assert.equal(
      completed.completedAt,
      completionTimestamp
    );
    assert.equal(
      completed.updatedAt,
      completionTimestamp
    );
    assert.equal(completed.expiredAt, null);
    assert.equal(
      completed.consumedAt,
      completionConsumedAt
    );
  }
);

test(
  "authorization completion preserves identity and provenance exactly",
  () => {
    const before =
      consumedAuthorizationForCompletion();

    const completed =
      completeAuthorization({
        authorization: before,
      });

    for (const field of [
      "id",
      "slotToken",
      "slotGeneration",
      "permanentPairId",
      "authorizedTechnicianUid",
      "shiftId",
      "consumedAt",
      "createdAt",
      "createdBy",
    ]) {
      assert.equal(
        completed[field],
        before[field],
        `${field} changed during completion`
      );
    }
  }
);

test(
  "authorization completion does not mutate its input",
  () => {
    const before =
      consumedAuthorizationForCompletion();

    const snapshot =
      structuredClone(before);

    const completed =
      completeAuthorization({
        authorization: before,
      });

    assert.deepEqual(
      structuredClone(before),
      snapshot
    );

    assert.notEqual(completed, before);
  }
);

test(
  "authorization completion rejects the wrong shift",
  () => {
    assert.throws(
      () =>
        completeAuthorization({
          shiftId: "different-completion-shift",
        }),
      /does not match the shift being completed/
    );
  }
);

test(
  "authorization completion rejects the wrong slot token",
  () => {
    assert.throws(
      () =>
        completeAuthorization({
          slotToken: previousSlotToken,
        }),
      /does not match the shift being completed/
    );
  }
);

test(
  "authorization completion rejects the wrong slot generation",
  () => {
    assert.throws(
      () =>
        completeAuthorization({
          slotGeneration: 3,
        }),
      /does not match the shift being completed/
    );
  }
);

test(
  "authorization completion rejects the wrong permanent pair",
  () => {
    assert.throws(
      () =>
        completeAuthorization({
          permanentPairId:
            "different-permanent-pair",
        }),
      /does not match the shift being completed/
    );
  }
);

test(
  "authorization completion accepts only consumed lifecycle state",
  () => {
    const pending = buildAuthorization();
    const completed = completeAuthorization();

    const expired =
      assertNextShiftAuthorization({
        ...consumedAuthorizationForCompletion(),
        status: "expired",
        completedAt: null,
        expiredAt: completionTimestamp,
        updatedAt: completionTimestamp,
      });

    for (const authorization of [
      pending,
      completed,
      expired,
    ]) {
      assert.throws(
        () =>
          completeAuthorization({
            authorization,
          }),
        /does not match the shift being completed/
      );
    }
  }
);

test(
  "authorization completion rejects a timestamp before consumption",
  () => {
    assert.throws(
      () =>
        completeAuthorization({
          completedAt:
            "2026-10-01T00:59:59.999Z",
        }),
      /completion timestamp is inconsistent/
    );
  }
);

test(
  "authorization completion rejects a timestamp before latest update",
  () => {
    const authorization =
      consumedAuthorizationForCompletion({
        updatedAt:
          "2026-10-01T01:30:00.000Z",
      });

    assert.throws(
      () =>
        completeAuthorization({
          authorization,
          completedAt:
            "2026-10-01T01:15:00.000Z",
        }),
      /completion timestamp is inconsistent/
    );
  }
);

test(
  "authorization completion rejects malformed authorization state",
  () => {
    assert.throws(
      () =>
        completeAuthorization({
          authorization: {
            malformed: true,
          },
        }),
      /lifecycle state is invalid/
    );
  }
);

test(
  "authorization completion rejects invalid completion context",
  () => {
    assert.throws(
      () =>
        completeAuthorization({
          completedAt: "not-a-timestamp",
        }),
      /completion context is invalid/
    );
  }
);
