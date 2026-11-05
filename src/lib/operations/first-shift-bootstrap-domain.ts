import type {
  ShiftStatus,
} from "@/types/shift";

/**
 * ShiftChange 2.0 — first-shift bootstrap contract.
 *
 * Technicians start the first-ever shift; every later shift activates
 * automatically through an incoming technician's authenticated handover
 * acceptance. Supervisors and administrators schedule shifts but never
 * activate them.
 *
 * "First-ever" is proven from the shift ledger itself, never from the shape
 * of the global slot: an empty slot, a pending slot, or generation 1 are all
 * reachable again after expired-shift recovery, so they cannot distinguish a
 * genuine first shift from a restarted installation. Shift documents are never
 * deleted and their status only moves forward
 * (scheduled -> active -> handover_pending -> completed, or scheduled ->
 * cancelled before any activation), so the existence of a shift whose status is
 * one of ACTIVATED_SHIFT_STATUSES is a durable, monotonic record that some
 * shift has already been activated.
 */

export const ACTIVATED_SHIFT_STATUSES = [
  "active",
  "handover_pending",
  "completed",
] as const satisfies readonly ShiftStatus[];

export const FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE =
  "This is not the first shift. Later shifts activate automatically when an incoming technician accepts the handover with their own password.";

export class FirstShiftBootstrapDomainError extends Error {
  public readonly status: number;

  constructor(message: string, status = 409) {
    super(message);

    this.status = status;
    this.name = "FirstShiftBootstrapDomainError";
  }
}

export interface FirstShiftBootstrapEvidence {
  hasActivatedShift: boolean;
  activatedShiftId: string | null;
  activatedShiftStatus: ShiftStatus | null;
}

const NO_ACTIVATED_SHIFT: FirstShiftBootstrapEvidence = {
  hasActivatedShift: false,
  activatedShiftId: null,
  activatedShiftStatus: null,
};

/**
 * Projects the single ledger row that would disprove a first-ever bootstrap.
 * A missing row means nothing has ever been activated. A reported row must be
 * a real, activated shift, so a caller that reads the wrong document cannot
 * silently reopen bootstrap.
 */
export function readFirstShiftBootstrapEvidence(
  input: {
    shiftId: unknown;
    shiftStatus: unknown;
  } | null
): FirstShiftBootstrapEvidence {
  if (input === null) {
    return NO_ACTIVATED_SHIFT;
  }

  const {
    shiftId,
    shiftStatus,
  } = input;

  if (
    typeof shiftId !== "string" ||
    !shiftId.trim() ||
    shiftId !== shiftId.trim() ||
    shiftId.includes("/") ||
    shiftId === "." ||
    shiftId === ".." ||
    typeof shiftStatus !== "string" ||
    !(ACTIVATED_SHIFT_STATUSES as readonly string[]).includes(
      shiftStatus
    )
  ) {
    throw new FirstShiftBootstrapDomainError(
      "The shift activation ledger is inconsistent. Administrator review is required.",
      409
    );
  }

  return {
    hasActivatedShift: true,
    activatedShiftId: shiftId,
    activatedShiftStatus: shiftStatus as ShiftStatus,
  };
}

/**
 * Rejects a manual activation once any shift has ever been activated, which is
 * the only manual-start gate that survives expired-shift recovery.
 */
export function assertFirstEverShiftBootstrap(
  evidence: FirstShiftBootstrapEvidence
): void {
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    typeof evidence.hasActivatedShift !== "boolean"
  ) {
    throw new FirstShiftBootstrapDomainError(
      "The shift activation ledger is inconsistent. Administrator review is required.",
      409
    );
  }

  if (evidence.hasActivatedShift) {
    throw new FirstShiftBootstrapDomainError(
      FIRST_SHIFT_BOOTSTRAP_CLOSED_MESSAGE,
      409
    );
  }
}
