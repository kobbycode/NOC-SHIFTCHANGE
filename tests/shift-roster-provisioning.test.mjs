import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

let overlapConflictOnCall = 0;
let overlapCallCount = 0;
let lastConflictEntries;
const moduleSource = await readFile(
  new URL(
    "../src/lib/operations/prepare-technician-schedule.ts",
    import.meta.url
  ),
  "utf8"
);
const moduleJavaScript = ts.transpileModule(moduleSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const scheduleModule = { exports: {} };

runInNewContext(moduleJavaScript, {
  exports: scheduleModule.exports,
  require(specifier) {
    if (specifier === "server-only") {
      return {};
    }

    if (specifier === "@/types/shift") {
      return {
        SHIFT_MEMBER_ROLES: {
          PRIMARY: "primary",
          ADDITIONAL: "additional",
        },
        SHIFT_STATUSES: {
          SCHEDULED: "scheduled",
        },
      };
    }

    if (specifier === "./assignment-transaction") {
      return {
        AssignmentOperationError: class AssignmentOperationError extends Error {
          constructor(message, status) {
            super(message);
            this.status = status;
          }
        },
      };
    }

    if (specifier === "./shift-overlap") {
      return {
        assertNoScheduleConflict(start, end, entries) {
          overlapCallCount += 1;
          lastConflictEntries = entries;
          if (overlapConflictOnCall === overlapCallCount) {
            throw new Error("overlap conflict");
          }
        },
      };
    }

    throw new Error(`Unexpected schedule helper import: ${specifier}`);
  },
});

const {
  preparePrimaryShiftRoster,
  prepareTechnicianSchedule,
} = scheduleModule.exports;

const eligibilitySource = await readFile(
  new URL(
    "../src/lib/operations/assignment-eligibility.ts",
    import.meta.url
  ),
  "utf8"
);
const eligibilityJavaScript = ts.transpileModule(eligibilitySource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const eligibilityModule = { exports: {} };

runInNewContext(eligibilityJavaScript, {
  exports: eligibilityModule.exports,
  require(specifier) {
    if (specifier === "server-only") {
      return {};
    }

    throw new Error(`Unexpected eligibility import: ${specifier}`);
  },
});

const { evaluateAssignmentEligibility } =
  eligibilityModule.exports;

const assignmentTime = "2026-10-01T00:00:00.000Z";
const scheduledStart = "2026-10-02T08:00:00.000Z";
const scheduledEnd = "2026-10-02T16:00:00.000Z";

function prepare(overrides = {}) {
  return prepareTechnicianSchedule({
    shiftId: "new-shift",
    technicianUid: "pair-technician",
    scheduledStart,
    scheduledEnd,
    updatedAt: assignmentTime,
    scheduleExists: false,
    scheduleData: undefined,
    ...overrides,
  });
}

test("missing schedule initializes one scheduled entry for the technician", () => {
  const schedule = prepare();

  assert.deepEqual(structuredClone(schedule), {
    technicianUid: "pair-technician",
    entries: [
      {
        shiftId: "new-shift",
        scheduledStart,
        scheduledEnd,
        status: "scheduled",
      },
    ],
    updatedAt: assignmentTime,
  });
});

test("existing unrelated schedule entries and fields are preserved", () => {
  const existingEntry = {
    shiftId: "older-shift",
    scheduledStart: "2026-09-30T08:00:00.000Z",
    scheduledEnd: "2026-09-30T16:00:00.000Z",
    status: "scheduled",
  };
  const schedule = prepare({
    scheduleExists: true,
    scheduleData: {
      technicianUid: "pair-technician",
      entries: [existingEntry],
      updatedAt: "2026-09-29T00:00:00.000Z",
      retainedMetadata: "keep-me",
    },
  });

  assert.equal(schedule.retainedMetadata, "keep-me");
  assert.deepEqual(
    structuredClone(schedule.entries[0]),
    existingEntry
  );
  assert.equal(schedule.entries[1].shiftId, "new-shift");
});

test("existing schedule must belong to the assigned technician", () => {
  assert.throws(
    () =>
      prepare({
        scheduleExists: true,
        scheduleData: {
          technicianUid: "different-technician",
          entries: [],
        },
      }),
    /invalid scheduling record/
  );
});

test("invalid schedule entry structure is rejected", () => {
  assert.throws(
    () =>
      prepare({
        scheduleExists: true,
        scheduleData: {
          technicianUid: "pair-technician",
          entries: [{ shiftId: "missing-times" }],
        },
      }),
    /invalid shift scheduling information/
  );
});

test("duplicate schedule entry for the new shift is rejected", () => {
  assert.throws(
    () =>
      prepare({
        scheduleExists: true,
        scheduleData: {
          technicianUid: "pair-technician",
          entries: [
            {
              shiftId: "new-shift",
              scheduledStart,
              scheduledEnd,
              status: "scheduled",
            },
          ],
        },
      }),
    /already has a scheduling record/
  );
});

test("existing overlap protection is called and its conflict aborts provisioning", () => {
  const oldEntries = [
    {
      shiftId: "conflicting-shift",
      scheduledStart,
      scheduledEnd,
      status: "scheduled",
    },
  ];
  overlapConflictOnCall = 1;
  overlapCallCount = 0;

  try {
    assert.throws(
      () =>
        prepare({
          scheduleExists: true,
          scheduleData: {
            technicianUid: "pair-technician",
            entries: oldEntries,
          },
        }),
      /overlap conflict/
    );
    assert.deepEqual(lastConflictEntries, oldEntries);
  } finally {
    overlapConflictOnCall = 0;
    overlapCallCount = 0;
  }
});

test("pair roster emits exactly A+B PRIMARY members with assignment timestamps", () => {
  const roster = preparePrimaryShiftRoster({
    shiftId: "new-pair-shift",
    technicianIds: ["pair-a", "pair-b"],
    scheduledStart,
    scheduledEnd,
    joinedAt: assignmentTime,
    updatedAt: assignmentTime,
    scheduleSnapshots: [
      { exists: false, data: undefined },
      { exists: false, data: undefined },
    ],
  });

  assert.deepEqual(structuredClone(roster.members), [
    {
      id: "new-pair-shift_pair-a",
      shiftId: "new-pair-shift",
      technicianId: "pair-a",
      role: "primary",
      joinedAt: assignmentTime,
      leftAt: null,
    },
    {
      id: "new-pair-shift_pair-b",
      shiftId: "new-pair-shift",
      technicianId: "pair-b",
      role: "primary",
      joinedAt: assignmentTime,
      leftAt: null,
    },
  ]);
});

test("pair roster adds matching scheduled entries for A and B", () => {
  const roster = preparePrimaryShiftRoster({
    shiftId: "new-pair-shift",
    technicianIds: ["pair-a", "pair-b"],
    scheduledStart,
    scheduledEnd,
    joinedAt: assignmentTime,
    updatedAt: assignmentTime,
    scheduleSnapshots: [
      { exists: false, data: undefined },
      { exists: false, data: undefined },
    ],
  });

  for (const [index, technicianUid] of ["pair-a", "pair-b"].entries()) {
    assert.equal(roster.schedules[index].technicianUid, technicianUid);
    assert.deepEqual(
      structuredClone(roster.schedules[index].entries),
      [
        {
          shiftId: "new-pair-shift",
          scheduledStart,
          scheduledEnd,
          status: "scheduled",
        },
      ]
    );
  }
});

test("pair roster preserves unrelated existing entries for A and B", () => {
  const firstEntry = {
    shiftId: "previous-a",
    scheduledStart: "2026-09-29T08:00:00.000Z",
    scheduledEnd: "2026-09-29T16:00:00.000Z",
    status: "scheduled",
  };
  const secondEntry = {
    shiftId: "previous-b",
    scheduledStart: "2026-09-29T08:00:00.000Z",
    scheduledEnd: "2026-09-29T16:00:00.000Z",
    status: "scheduled",
  };
  const roster = preparePrimaryShiftRoster({
    shiftId: "new-pair-shift",
    technicianIds: ["pair-a", "pair-b"],
    scheduledStart,
    scheduledEnd,
    joinedAt: assignmentTime,
    updatedAt: assignmentTime,
    scheduleSnapshots: [
      {
        exists: true,
        data: {
          technicianUid: "pair-a",
          entries: [firstEntry],
          customField: "preserved-a",
        },
      },
      {
        exists: true,
        data: {
          technicianUid: "pair-b",
          entries: [secondEntry],
          customField: "preserved-b",
        },
      },
    ],
  });

  assert.deepEqual(
    structuredClone(roster.schedules[0].entries[0]),
    firstEntry
  );
  assert.deepEqual(
    structuredClone(roster.schedules[1].entries[0]),
    secondEntry
  );
  assert.equal(roster.schedules[0].customField, "preserved-a");
  assert.equal(roster.schedules[1].customField, "preserved-b");
});

test("schedule overlap on either A or B rejects the complete pair roster", () => {
  const conflictEntry = {
    shiftId: "overlap",
    scheduledStart,
    scheduledEnd,
    status: "scheduled",
  };

  for (const conflictIndex of [0, 1]) {
    overlapConflictOnCall = conflictIndex + 1;
    overlapCallCount = 0;
    const scheduleSnapshots = [
      { exists: false, data: undefined },
      { exists: false, data: undefined },
    ];
    scheduleSnapshots[conflictIndex] = {
      exists: true,
      data: {
        technicianUid: conflictIndex === 0 ? "pair-a" : "pair-b",
        entries: [conflictEntry],
      },
    };

    assert.throws(
      () =>
        preparePrimaryShiftRoster({
          shiftId: "new-pair-shift",
          technicianIds: ["pair-a", "pair-b"],
          scheduledStart,
          scheduledEnd,
          joinedAt: assignmentTime,
          updatedAt: assignmentTime,
          scheduleSnapshots,
        }),
      /overlap conflict/
    );
  }

  overlapConflictOnCall = 0;
  overlapCallCount = 0;
});

test("invalid existing schedule for either pair technician rejects roster preparation", () => {
  for (const invalidIndex of [0, 1]) {
    const scheduleSnapshots = [
      { exists: false, data: undefined },
      { exists: false, data: undefined },
    ];
    scheduleSnapshots[invalidIndex] = {
      exists: true,
      data: {
        technicianUid: "wrong-owner",
        entries: [],
      },
    };

    assert.throws(
      () =>
        preparePrimaryShiftRoster({
          shiftId: "new-pair-shift",
          technicianIds: ["pair-a", "pair-b"],
          scheduledStart,
          scheduledEnd,
          joinedAt: assignmentTime,
          updatedAt: assignmentTime,
          scheduleSnapshots,
        }),
      /invalid scheduling record/
    );
  }
});

test("the existing assignment eligibility rules reject invalid A and B profiles", () => {
  const validProfile = {
    role: "technician",
    status: "active",
    mustChangePassword: false,
    statusOperation: null,
  };
  const invalidProfiles = [
    undefined,
    { ...validProfile, status: "blocked" },
    { ...validProfile, mustChangePassword: true },
    { ...validProfile, statusOperation: { id: "pending-operation" } },
    { ...validProfile, role: "supervisor" },
  ];

  for (const technicianUid of ["pair-a", "pair-b"]) {
    assert.equal(
      evaluateAssignmentEligibility(validProfile).eligible,
      true
    );

    for (const profile of invalidProfiles) {
      assert.equal(
        evaluateAssignmentEligibility(profile).eligible,
        false,
        `${technicianUid} must satisfy existing eligibility before provisioning`
      );
    }
  }
});

test("createShiftMember and G-C createShift share schedule preparation", async () => {
  const [memberSource, shiftSource, rosterSource, bindingSource] = await Promise.all([
    readFile(
      new URL("../src/lib/operations/create-shift-member.ts", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../src/lib/operations/create-shift.ts", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL(
        "../src/lib/operations/prepare-technician-schedule.ts",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(
      new URL(
        "../src/lib/operations/next-shift-authorization-domain.ts",
        import.meta.url
      ),
      "utf8"
    ),
  ]);

  assert.match(memberSource, /prepareTechnicianSchedule\(/);
  assert.match(shiftSource, /preparePrimaryShiftRoster\(/);
  assert.match(rosterSource, /prepareTechnicianSchedule\(/);
  assert.match(
    shiftSource,
    /permanentTechnicianIds\.map\(/s
  );
  assert.match(rosterSource, /SHIFT_MEMBER_ROLES\.PRIMARY/);
  assert.match(shiftSource, /requireEligibleTechnician\(/);
  assert.match(
    shiftSource,
    /transaction\.create\(\s*primaryMemberRefs\[index\]/
  );
  assert.match(
    shiftSource,
    /transaction\.set\(\s*primaryScheduleRefs\[index\]/
  );
  assert.match(
    memberSource,
    /existingPrimaryIds\.includes\(\s*technicianUid\s*\)/
  );
  assert.match(
    memberSource,
    /existingPrimaryIds\.length\s*>=\s*2/
  );
  assert.match(
    memberSource,
    /role === SHIFT_MEMBER_ROLES\.ADDITIONAL|else if \(\s*existingPrimaryIds\.includes/s
  );
  assert.match(
    shiftSource,
    /for \(const technicianUid of permanentTechnicianIds\)\s*\{\s*await requireEligibleTechnician\(/s
  );
  const rosterPreparationIndex = shiftSource.indexOf(
    "preparePrimaryShiftRoster({"
  );
  const firstWriteIndex = shiftSource.search(
    /transaction\.(?:update|create|delete|set)\s*\(/
  );
  assert.ok(rosterPreparationIndex > -1);
  assert.ok(firstWriteIndex > rosterPreparationIndex);
  assert.match(
    shiftSource,
    /transaction\.create\(\s*shiftRef,\s*createdShift\s*\)/s
  );
  assert.match(
    shiftSource,
    /transaction\.(?:update|create)\(\s*operationalShiftControlRef,/s
  );
  assert.match(
    shiftSource,
    /transaction\.update\(\s*nextShiftAuthorizations\.doc\(/s
  );
  assert.match(
    shiftSource,
    /for \(let index = 0; index < 2; index \+= 1\)[\s\S]*?transaction\.create\(\s*primaryMemberRefs\[index\],[\s\S]*?transaction\.set\(\s*primaryScheduleRefs\[index\],[\s\S]*?markAssignmentActivity\(\s*transaction,\s*permanentTechnicianIds\[index\]/s
  );
  assert.match(shiftSource, /action: "SHIFT_CREATED"/);
  assert.match(bindingSource, /NEXT_SHIFT_AUTHORIZATION_CONSUMED/);
  assert.doesNotMatch(
    shiftSource,
    /primaryMemberRefs[\s\S]{0,240}authorization\.authorizedTechnicianUid/
  );
  assert.doesNotMatch(shiftSource, /attendance|clockIn|clockOut/);
});