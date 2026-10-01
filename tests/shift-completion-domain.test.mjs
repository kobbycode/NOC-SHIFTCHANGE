import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const authorizationStatuses = {
  PENDING: "pending",
  CONSUMED: "consumed",
  COMPLETED: "completed",
  EXPIRED: "expired",
};

const attendanceAuthorities = {
  PRIMARY: "primary",
  TEMPORARY_AUTHORIZED: "temporary_authorized",
};

const attendanceStatuses = {
  PRESENT: "present",
};

const shiftMemberRoles = {
  PRIMARY: "primary",
  ADDITIONAL: "additional",
};

async function loadAuthorizationDomain() {
  const source = await readFile(
    new URL(
      "../src/lib/operations/next-shift-authorization-domain.ts",
      import.meta.url
    ),
    "utf8"
  );

  const javascript = ts.transpileModule(
    source,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText;

  const loadedModule = { exports: {} };

  runInNewContext(javascript, {
    exports: loadedModule.exports,

    require(specifier) {
      if (specifier === "node:crypto") {
        return { createHash };
      }

      if (
        specifier ===
        "./operational-shift-control-state"
      ) {
        return {
          assertOperationalShiftControl(value) {
            return value;
          },

          assertShiftOwnsOperationalSlot() {
            return undefined;
          },
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

      throw new Error(
        `Unexpected authorization-domain import: ${specifier}`
      );
    },
  });

  return loadedModule.exports;
}

async function loadCompletionDomain(
  authorizationDomain
) {
  const source = await readFile(
    new URL(
      "../src/lib/operations/shift-completion-domain.ts",
      import.meta.url
    ),
    "utf8"
  );

  const javascript = ts.transpileModule(
    source,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText;

  const loadedModule = { exports: {} };

  runInNewContext(javascript, {
    exports: loadedModule.exports,

    require(specifier) {
      if (specifier === "@/types/attendance") {
        return {
          ATTENDANCE_PARTICIPATION_AUTHORITIES:
            attendanceAuthorities,
          ATTENDANCE_STATUSES:
            attendanceStatuses,
        };
      }

      if (specifier === "@/types/shift") {
        return {
          SHIFT_MEMBER_ROLES:
            shiftMemberRoles,
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

      if (
        specifier ===
        "./next-shift-authorization-domain"
      ) {
        return {
          assertNextShiftAuthorization:
            authorizationDomain.assertNextShiftAuthorization,
        };
      }

      throw new Error(
        `Unexpected completion-domain import: ${specifier}`
      );
    },
  });

  return {
    module: loadedModule.exports,
    source,
  };
}

const authorizationDomain =
  await loadAuthorizationDomain();

const {
  module: completionDomain,
  source: completionDomainSource,
} = await loadCompletionDomain(
  authorizationDomain
);

const {
  finalizeCurrentShiftMemberships,
  validateShiftCompletionAttendance,
} = completionDomain;

const shiftId = "synthetic-completion-shift";
const pairId = "synthetic-permanent-pair";
const technicianA = "synthetic-primary-a";
const technicianB = "synthetic-primary-b";
const technicianC = "synthetic-temporary-c";

const slotToken =
  "f1000000-0000-4000-8000-000000000001";

const createdAt =
  "2026-10-01T06:00:00.000Z";

const primaryJoinedAt =
  "2026-10-01T06:05:00.000Z";

const consumedAt =
  "2026-10-01T06:10:00.000Z";

const primaryAttendanceAt =
  "2026-10-01T06:20:00.000Z";

const temporaryJoinedAt =
  "2026-10-01T07:00:00.000Z";

const completedAt =
  "2026-10-01T14:00:00.000Z";

function member(
  technicianId,
  role = "primary",
  overrides = {}
) {
  return {
    id: `${shiftId}_${technicianId}`,
    shiftId,
    technicianId,
    role,
    joinedAt:
      role === "additional"
        ? temporaryJoinedAt
        : primaryJoinedAt,
    leftAt: null,
    ...overrides,
  };
}

function primaryAttendance(
  technicianId,
  overrides = {}
) {
  return {
    id: `${shiftId}_${technicianId}`,
    shiftId,
    technicianId,
    status: "present",
    participationAuthority: "primary",
    authorizationId: null,
    clockIn: null,
    clockOut: null,
    isProvisional: false,
    recordedAt: primaryAttendanceAt,
    updatedAt: primaryAttendanceAt,
    ...overrides,
  };
}

function consumedAuthorization(
  overrides = {}
) {
  const record = {
    id: "",
    slotToken,
    slotGeneration: 7,
    permanentPairId: pairId,
    authorizedTechnicianUid: technicianC,
    status: "consumed",
    shiftId,
    consumedAt,
    completedAt: null,
    expiredAt: null,
    createdAt,
    createdBy: "synthetic-supervisor",
    updatedAt: consumedAt,
    ...overrides,
  };

  record.id =
    overrides.id ??
    authorizationDomain
      .createNextShiftAuthorizationDocumentId(
        record.permanentPairId,
        record.slotGeneration,
        record.slotToken
      );

  return authorizationDomain
    .assertNextShiftAuthorization(record);
}

function temporaryAttendance(
  authorization = consumedAuthorization(),
  overrides = {}
) {
  return {
    id: `${shiftId}_${technicianC}`,
    shiftId,
    technicianId: technicianC,
    status: "present",
    participationAuthority:
      "temporary_authorized",
    authorizationId: authorization.id,
    clockIn: null,
    clockOut: null,
    isProvisional: false,
    recordedAt: temporaryJoinedAt,
    updatedAt: temporaryJoinedAt,
    ...overrides,
  };
}

function baseMembers() {
  return [
    member(technicianA),
    member(technicianB),
  ];
}

function validate(overrides = {}) {
  return validateShiftCompletionAttendance({
    shiftId,
    primaryTechnicianIds: [
      technicianA,
      technicianB,
    ],
    completedAt,
    members: baseMembers(),
    attendances: [],
    authorization: null,
    ...overrides,
  });
}

test(
  "completion finalizes A and B current memberships with exact leftAt",
  () => {
    const members = baseMembers();
    const snapshot =
      structuredClone(members);

    const result =
      finalizeCurrentShiftMemberships({
        shiftId,
        completedAt,
        members,
      });

    assert.equal(result.length, 2);

    for (const finalized of result) {
      assert.equal(
        finalized.leftAt,
        completedAt
      );
      assert.equal(
        finalized.role,
        "primary"
      );
      assert.equal(
        finalized.joinedAt,
        primaryJoinedAt
      );
    }

    assert.deepEqual(
      structuredClone(members),
      snapshot
    );
  }
);

test(
  "completion finalizes temporary C membership while preserving additional role",
  () => {
    const result =
      finalizeCurrentShiftMemberships({
        shiftId,
        completedAt,
        members: [
          ...baseMembers(),
          member(
            technicianC,
            "additional"
          ),
        ],
      });

    const temporary =
      result.find(
        (value) =>
          value.technicianId ===
          technicianC
      );

    assert.ok(temporary);
    assert.equal(
      temporary.role,
      "additional"
    );
    assert.equal(
      temporary.joinedAt,
      temporaryJoinedAt
    );
    assert.equal(
      temporary.leftAt,
      completedAt
    );
  }
);

test(
  "membership finalization rejects duplicate technician membership",
  () => {
    assert.throws(
      () =>
        finalizeCurrentShiftMemberships({
          shiftId,
          completedAt,
          members: [
            member(technicianA),
            member(technicianA),
          ],
        }),
      /duplicate technician memberships/
    );
  }
);

test(
  "membership finalization rejects wrong shift and deterministic identity",
  () => {
    assert.throws(
      () =>
        finalizeCurrentShiftMemberships({
          shiftId,
          completedAt,
          members: [
            member(technicianA, "primary", {
              shiftId: "another-shift",
            }),
          ],
        }),
      /invalid current membership/
    );

    assert.throws(
      () =>
        finalizeCurrentShiftMemberships({
          shiftId,
          completedAt,
          members: [
            member(technicianA, "primary", {
              id: "wrong-member-id",
            }),
          ],
        }),
      /invalid current membership/
    );
  }
);

test(
  "membership finalization rejects already-left membership",
  () => {
    assert.throws(
      () =>
        finalizeCurrentShiftMemberships({
          shiftId,
          completedAt,
          members: [
            member(technicianA, "primary", {
              leftAt:
                "2026-10-01T13:00:00.000Z",
            }),
          ],
        }),
      /invalid current membership/
    );
  }
);

test(
  "membership finalization rejects completion before joinedAt",
  () => {
    assert.throws(
      () =>
        finalizeCurrentShiftMemberships({
          shiftId,
          completedAt:
            "2026-10-01T06:00:00.000Z",
          members: [
            member(technicianA),
          ],
        }),
      /cannot end before it began/
    );
  }
);

test(
  "ordinary A B shift is valid with zero attendance",
  () => {
    const result = validate();

    assert.equal(
      result.attendances.length,
      0
    );
    assert.equal(
      result.authorization,
      null
    );
  }
);

test(
  "A-only primary attendance is valid and B attendance is not fabricated",
  () => {
    const attendance =
      primaryAttendance(technicianA);

    const result = validate({
      attendances: [attendance],
    });

    assert.equal(
      result.attendances.length,
      1
    );
    assert.equal(
      result.attendances[0].technicianId,
      technicianA
    );

    assert.equal(
      result.attendances.some(
        (value) =>
          value.technicianId ===
          technicianB
      ),
      false
    );
  }
);

test(
  "B-only primary attendance is valid and A attendance is not fabricated",
  () => {
    const result = validate({
      attendances: [
        primaryAttendance(technicianB),
      ],
    });

    assert.equal(
      result.attendances.length,
      1
    );
    assert.equal(
      result.attendances[0].technicianId,
      technicianB
    );
  }
);

test(
  "A and B primary attendance are both valid",
  () => {
    const result = validate({
      attendances: [
        primaryAttendance(technicianA),
        primaryAttendance(technicianB),
      ],
    });

    assert.equal(
      result.attendances.length,
      2
    );
  }
);

test(
  "valid joined C requires exact additional membership attendance and consumed authorization",
  () => {
    const authorization =
      consumedAuthorization();

    const result = validate({
      members: [
        ...baseMembers(),
        member(
          technicianC,
          "additional"
        ),
      ],
      attendances: [
        temporaryAttendance(
          authorization
        ),
      ],
      authorization,
    });

    assert.equal(
      result.authorization.id,
      authorization.id
    );

    assert.equal(
      result.attendances[0]
        .technicianId,
      technicianC
    );

    assert.equal(
      result.attendances[0]
        .participationAuthority,
      "temporary_authorized"
    );
  }
);

test(
  "consumed C authorization is valid when C never joined",
  () => {
    const authorization =
      consumedAuthorization();

    const result = validate({
      authorization,
    });

    assert.equal(
      result.authorization.id,
      authorization.id
    );

    assert.equal(
      result.attendances.length,
      0
    );

    assert.equal(
      result.members.length,
      2
    );
  }
);

test(
  "temporary attendance without C membership is rejected",
  () => {
    const authorization =
      consumedAuthorization();

    assert.throws(
      () =>
        validate({
          attendances: [
            temporaryAttendance(
              authorization
            ),
          ],
          authorization,
        }),
      /not a current shift member/
    );
  }
);

test(
  "joined C membership without authoritative attendance is rejected",
  () => {
    assert.throws(
      () =>
        validate({
          members: [
            ...baseMembers(),
            member(
              technicianC,
              "additional"
            ),
          ],
          authorization:
            consumedAuthorization(),
        }),
      /missing authoritative attendance/
    );
  }
);

test(
  "temporary attendance with wrong authorization ID is rejected",
  () => {
    const authorization =
      consumedAuthorization();

    assert.throws(
      () =>
        validate({
          members: [
            ...baseMembers(),
            member(
              technicianC,
              "additional"
            ),
          ],
          attendances: [
            temporaryAttendance(
              authorization,
              {
                authorizationId:
                  "wrong-authorization",
              }
            ),
          ],
          authorization,
        }),
      /inconsistent with the shift's authorization and roster/
    );
  }
);

test(
  "authorization for wrong temporary technician is rejected when C attendance exists",
  () => {
    const authorization =
      consumedAuthorization({
        authorizedTechnicianUid:
          "different-temporary-technician",
      });

    assert.throws(
      () =>
        validate({
          members: [
            ...baseMembers(),
            member(
              technicianC,
              "additional"
            ),
          ],
          attendances: [
            temporaryAttendance(
              authorization,
              {
                authorizationId:
                  authorization.id,
              }
            ),
          ],
          authorization,
        }),
      /inconsistent with the shift's authorization and roster/
    );
  }
);

test(
  "authorization for another shift is rejected",
  () => {
    const authorization =
      consumedAuthorization({
        shiftId: "another-shift",
      });

    assert.throws(
      () =>
        validate({
          authorization,
        }),
      /inconsistent with completion/
    );
  }
);

test(
  "pending completed and expired temporary authorizations are rejected",
  () => {
    const consumed =
      consumedAuthorization();

    const pending =
      authorizationDomain
        .assertNextShiftAuthorization({
          ...consumed,
          status: "pending",
          shiftId: null,
          consumedAt: null,
          completedAt: null,
          expiredAt: null,
          updatedAt: createdAt,
        });

    const terminalAt =
      "2026-10-01T13:00:00.000Z";

    const completed =
      authorizationDomain
        .assertNextShiftAuthorization({
          ...consumed,
          status: "completed",
          completedAt: terminalAt,
          expiredAt: null,
          updatedAt: terminalAt,
        });

    const expired =
      authorizationDomain
        .assertNextShiftAuthorization({
          ...consumed,
          status: "expired",
          completedAt: null,
          expiredAt: terminalAt,
          updatedAt: terminalAt,
        });

    for (const authorization of [
      pending,
      completed,
      expired,
    ]) {
      assert.throws(
        () =>
          validate({
            authorization,
          }),
        /inconsistent with completion/
      );
    }
  }
);

test(
  "temporarily authorized technician cannot contaminate primary roster",
  () => {
    const authorization =
      consumedAuthorization();

    assert.throws(
      () =>
        validate({
          members: [
            ...baseMembers(),
            member(
              technicianC,
              "primary"
            ),
          ],
          authorization,
        }),
      /primary technician memberships are inconsistent/
    );
  }
);

test(
  "primary attendance cannot carry temporary authorization",
  () => {
    assert.throws(
      () =>
        validate({
          attendances: [
            primaryAttendance(
              technicianA,
              {
                authorizationId:
                  "temporary-authorization",
              }
            ),
          ],
        }),
      /Primary attendance cannot contain temporary authorization/
    );
  }
);

test(
  "temporary authorization cannot designate permanent primary A or B",
  () => {
    const authorization =
      consumedAuthorization({
        authorizedTechnicianUid:
          technicianA,
      });

    assert.throws(
      () =>
        validate({
          authorization,
        }),
      /inconsistent with completion/
    );
  }
);

test(
  "duplicate attendance for one technician is rejected",
  () => {
    const attendance =
      primaryAttendance(technicianA);

    assert.throws(
      () =>
        validate({
          attendances: [
            attendance,
            { ...attendance },
          ],
        }),
      /duplicate attendance records/
    );
  }
);

test(
  "attendance for a non-member is rejected",
  () => {
    assert.throws(
      () =>
        validate({
          attendances: [
            primaryAttendance(
              "non-member"
            ),
          ],
        }),
      /not a current shift member/
    );
  }
);

test(
  "malformed deterministic attendance identity is rejected",
  () => {
    assert.throws(
      () =>
        validate({
          attendances: [
            primaryAttendance(
              technicianA,
              {
                id:
                  "wrong-attendance-id",
              }
            ),
          ],
        }),
      /invalid authoritative attendance/
    );
  }
);

test(
  "attendance recorded after completion is rejected",
  () => {
    const afterCompletion =
      "2026-10-01T14:00:00.001Z";

    assert.throws(
      () =>
        validate({
          attendances: [
            primaryAttendance(
              technicianA,
              {
                recordedAt:
                  afterCompletion,
                updatedAt:
                  afterCompletion,
              }
            ),
          ],
        }),
      /after shift completion/
    );
  }
);

test(
  "current G-E attendance cannot acquire clockIn or clockOut during completion",
  () => {
    assert.throws(
      () =>
        validate({
          attendances: [
            primaryAttendance(
              technicianA,
              {
                clockIn:
                  primaryAttendanceAt,
              }
            ),
          ],
        }),
      /invalid authoritative attendance/
    );

    assert.throws(
      () =>
        validate({
          attendances: [
            primaryAttendance(
              technicianA,
              {
                clockOut:
                  completedAt,
              }
            ),
          ],
        }),
      /invalid authoritative attendance/
    );
  }
);

test(
  "attendance validation does not mutate authoritative inputs",
  () => {
    const authorization =
      consumedAuthorization();

    const members = [
      ...baseMembers(),
      member(
        technicianC,
        "additional"
      ),
    ];

    const attendances = [
      primaryAttendance(technicianA),
      temporaryAttendance(
        authorization
      ),
    ];

    const memberSnapshot =
      structuredClone(members);

    const attendanceSnapshot =
      structuredClone(attendances);

    const authorizationSnapshot =
      structuredClone(authorization);

    validate({
      members,
      attendances,
      authorization,
    });

    assert.deepEqual(
      structuredClone(members),
      memberSnapshot
    );

    assert.deepEqual(
      structuredClone(attendances),
      attendanceSnapshot
    );

    assert.deepEqual(
      structuredClone(authorization),
      authorizationSnapshot
    );
  }
);

test(
  "additional membership without temporary authorization is rejected",
  () => {
    assert.throws(
      () =>
        validate({
          members: [
            ...baseMembers(),
            member(
              technicianC,
              "additional"
            ),
          ],
        }),
      /without temporary authorization/
    );
  }
);

test(
  "completion domain is pure and contains no Firestore access",
  () => {
    assert.doesNotMatch(
      completionDomainSource,
      /firebase-admin|firebase\/firestore|transaction\.|\.collection\(|getFirestore/
    );
  }
);
