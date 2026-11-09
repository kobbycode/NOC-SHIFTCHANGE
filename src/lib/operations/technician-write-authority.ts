import type { ShiftStatus } from "@/types/shift";

/**
 * Owner-set participation contract (2026-11-06): after the facility's first
 * shift exists, a technician may change operational data only for the shift
 * they entered with their own authenticated act — creating the founding shift
 * or accepting a handover from the last page of the A–E form. Any other
 * technician login is read-only.
 *
 * Supervisors and admins keep their own authority model, so this rule simply
 * does not govern them. Enforcement on the mutation routes is Phase 4; this
 * module is pure so the rule can be reasoned about and tested on its own.
 */

export const WRITE_AUTHORITY_BASES = {
  FOUNDING_SHIFT_PARTICIPANT: "founding_shift_participant",
  PERSONAL_HANDOVER_ACCEPTANCE: "personal_handover_acceptance",
  ROLE_NOT_GOVERNED: "role_not_governed",
} as const;

export type WriteAuthorityBasis =
  (typeof WRITE_AUTHORITY_BASES)[keyof typeof WRITE_AUTHORITY_BASES];

export const READ_ONLY_DENIALS = {
  NO_ACTIVE_SHIFT: "no_active_shift",
  SHIFT_NOT_RUNNING: "shift_not_running",
  NOT_ACTIVE_SHIFT_PARTICIPANT: "not_active_shift_participant",
  PARTICIPATION_WITHOUT_ACCEPTANCE: "participation_without_acceptance",
} as const;

export type ReadOnlyDenial =
  (typeof READ_ONLY_DENIALS)[keyof typeof READ_ONLY_DENIALS];

/** What a read-only technician may still see. Everything else is hidden. */
export const READ_ONLY_VISIBLE_SCOPES = {
  OWN_SHIFTS: "own_shifts",
  OWN_ATTENDANCE: "own_attendance_and_lateness",
  OWN_AUTHORED_RECORDS: "own_authored_records_and_tasks",
  OWN_HANDOVER_RECEIPTS: "own_handover_receipts",
} as const;

export type ReadOnlyVisibleScope =
  (typeof READ_ONLY_VISIBLE_SCOPES)[keyof typeof READ_ONLY_VISIBLE_SCOPES];

export interface ActiveShiftFacts {
  id: string;
  status: ShiftStatus;
  primaryTechnicianIds: readonly string[];
  isFoundingShift: boolean;
}

export interface TechnicianWriteAuthorityInput {
  actorUid: string;
  actorRole: string;
  activeShift: ActiveShiftFacts | null;
  /**
   * Shift the technician entered through their own password-authenticated
   * acceptance evidence, or null when they never accepted one.
   */
  personallyAcceptedShiftId: string | null;
}

export interface TechnicianWriteAuthority {
  mayWrite: boolean;
  governed: boolean;
  basis: WriteAuthorityBasis | null;
  denial: ReadOnlyDenial | null;
  message: string;
}

const WRITABLE_SHIFT_STATUSES: readonly ShiftStatus[] = [
  "active",
  "handover_pending",
];

const DENIAL_MESSAGES: Record<ReadOnlyDenial, string> = {
  [READ_ONLY_DENIALS.NO_ACTIVE_SHIFT]:
    "No shift is currently running, so operational data is read-only.",
  [READ_ONLY_DENIALS.SHIFT_NOT_RUNNING]:
    "This shift no longer accepts changes, so operational data is read-only.",
  [READ_ONLY_DENIALS.NOT_ACTIVE_SHIFT_PARTICIPANT]:
    "A shift is already running. Only the active technician pair can join it.",
  [READ_ONLY_DENIALS.PARTICIPATION_WITHOUT_ACCEPTANCE]:
    "Accept the handover with your own password to make changes; this view is read-only.",
};

function readOnly(denial: ReadOnlyDenial): TechnicianWriteAuthority {
  return {
    mayWrite: false,
    governed: true,
    basis: null,
    denial,
    message: DENIAL_MESSAGES[denial],
  };
}

export function isTechnicianWriteAuthorityGovernedRole(
  actorRole: string
): boolean {
  return actorRole === "technician";
}

export function evaluateTechnicianWriteAuthority(
  input: TechnicianWriteAuthorityInput
): TechnicianWriteAuthority {
  if (!isTechnicianWriteAuthorityGovernedRole(input.actorRole)) {
    return {
      mayWrite: true,
      governed: false,
      basis: WRITE_AUTHORITY_BASES.ROLE_NOT_GOVERNED,
      denial: null,
      message:
        "Technician participation authority does not govern this role.",
    };
  }

  const shift = input.activeShift;

  if (!shift) {
    return readOnly(READ_ONLY_DENIALS.NO_ACTIVE_SHIFT);
  }

  if (!WRITABLE_SHIFT_STATUSES.includes(shift.status)) {
    return readOnly(READ_ONLY_DENIALS.SHIFT_NOT_RUNNING);
  }

  if (!shift.primaryTechnicianIds.includes(input.actorUid)) {
    return readOnly(READ_ONLY_DENIALS.NOT_ACTIVE_SHIFT_PARTICIPANT);
  }

  if (shift.isFoundingShift) {
    return {
      mayWrite: true,
      governed: true,
      basis: WRITE_AUTHORITY_BASES.FOUNDING_SHIFT_PARTICIPANT,
      denial: null,
      message: "Founding shift participants may write their own shift.",
    };
  }

  if (input.personallyAcceptedShiftId === shift.id) {
    return {
      mayWrite: true,
      governed: true,
      basis: WRITE_AUTHORITY_BASES.PERSONAL_HANDOVER_ACCEPTANCE,
      denial: null,
      message:
        "This technician accepted the handover with their own password.",
    };
  }

  return readOnly(
    READ_ONLY_DENIALS.PARTICIPATION_WITHOUT_ACCEPTANCE
  );
}
