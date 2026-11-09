import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTechnicianWriteAuthority,
  isTechnicianWriteAuthorityGovernedRole,
  READ_ONLY_DENIALS,
  READ_ONLY_VISIBLE_SCOPES,
  WRITE_AUTHORITY_BASES,
  type ActiveShiftFacts,
} from "../src/lib/operations/technician-write-authority";

const foundingShift: ActiveShiftFacts = {
  id: "shift-1",
  status: "active",
  primaryTechnicianIds: ["in-a", "in-b"],
  isFoundingShift: true,
};

const handedOverShift: ActiveShiftFacts = {
  id: "shift-2",
  status: "active",
  primaryTechnicianIds: ["in-a", "in-b"],
  isFoundingShift: false,
};

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateTechnicianWriteAuthority({
    actorUid: "in-a",
    actorRole: "technician",
    activeShift: handedOverShift,
    personallyAcceptedShiftId: "shift-2",
    ...overrides,
  });
}

test("supervisors and admins are not governed by technician participation authority", () => {
  assert.equal(isTechnicianWriteAuthorityGovernedRole("technician"), true);
  assert.equal(isTechnicianWriteAuthorityGovernedRole("supervisor"), false);
  assert.equal(isTechnicianWriteAuthorityGovernedRole("admin"), false);

  for (const actorRole of ["supervisor", "admin"]) {
    const result = evaluate({
      actorRole,
      personallyAcceptedShiftId: null,
      activeShift: null,
    });

    assert.equal(result.governed, false, actorRole);
    assert.equal(result.mayWrite, true, actorRole);
    assert.equal(result.basis, WRITE_AUTHORITY_BASES.ROLE_NOT_GOVERNED, actorRole);
    assert.equal(result.denial, null, actorRole);
  }
});

test("a technician with no active shift is read-only", () => {
  const result = evaluate({ activeShift: null });

  assert.equal(result.mayWrite, false);
  assert.equal(result.denial, READ_ONLY_DENIALS.NO_ACTIVE_SHIFT);
  assert.match(result.message, /read-only/);
});

test("a shift outside active or handover-pending accepts no technician writes", () => {
  for (const status of ["scheduled", "completed", "cancelled"] as const) {
    const result = evaluate({ activeShift: { ...handedOverShift, status } });

    assert.equal(result.mayWrite, false, status);
    assert.equal(result.denial, READ_ONLY_DENIALS.SHIFT_NOT_RUNNING, status);
  }
});

test("handover-pending shifts stay writable for their own participants", () => {
  const result = evaluate({
    activeShift: { ...handedOverShift, status: "handover_pending" },
  });

  assert.equal(result.mayWrite, true);
  assert.equal(result.basis, WRITE_AUTHORITY_BASES.PERSONAL_HANDOVER_ACCEPTANCE);
});

test("a technician outside the running shift is read-only even with an old acceptance", () => {
  const result = evaluate({ actorUid: "out-a" });

  assert.equal(result.mayWrite, false);
  assert.equal(result.denial, READ_ONLY_DENIALS.NOT_ACTIVE_SHIFT_PARTICIPANT);
  assert.equal(result.message, "A shift is already running. Only the active technician pair can join it.");
});

test("the founding shift is writable by its own participants without any acceptance", () => {
  const result = evaluate({
    activeShift: foundingShift,
    personallyAcceptedShiftId: null,
  });

  assert.equal(result.mayWrite, true);
  assert.equal(result.basis, WRITE_AUTHORITY_BASES.FOUNDING_SHIFT_PARTICIPANT);
  assert.equal(result.denial, null);
});

test("a later shift is writable only on the strength of this technician's own acceptance", () => {
  assert.equal(evaluate().mayWrite, true);

  for (const personallyAcceptedShiftId of [null, "shift-1", "shift-3"]) {
    const result = evaluate({ personallyAcceptedShiftId });

    assert.equal(result.mayWrite, false, String(personallyAcceptedShiftId));
    assert.equal(
      result.denial,
      READ_ONLY_DENIALS.PARTICIPATION_WITHOUT_ACCEPTANCE,
      String(personallyAcceptedShiftId),
    );
  }
});

test("a founding participant who later accepts a new handover is read-only until that acceptance", () => {
  const result = evaluate({
    activeShift: { ...handedOverShift, isFoundingShift: false },
    personallyAcceptedShiftId: null,
  });

  assert.equal(result.mayWrite, false);
  assert.equal(result.denial, READ_ONLY_DENIALS.PARTICIPATION_WITHOUT_ACCEPTANCE);
});

test("read-only visibility is a closed list of the technician's own data", () => {
  assert.deepEqual(Object.values(READ_ONLY_VISIBLE_SCOPES).sort(), [
    "own_attendance_and_lateness",
    "own_authored_records_and_tasks",
    "own_handover_receipts",
    "own_shifts",
  ]);
});
