// ---------------------------------------------------------------------------
// TECH-HO-RECOVERY-06 §6 — pure, deterministic handover readiness domain.
//
// Readiness is a *derived* result over authoritative evidence: it never writes,
// never advances lifecycle state and never authorizes a transfer. The final
// transfer milestone re-reads the same evidence inside its own transaction; a
// client-side `ready` flag is display only.
// ---------------------------------------------------------------------------
import {
  EQUAL_ABSENCE_TYPES,
  EQUAL_HANDOVER_LIFECYCLE_STATUSES,
  EQUAL_HANDOVER_PARTICIPANT_STATES,
  EQUAL_HANDOVER_SIDES,
} from "@/types/equal-technician-handover";
import type {
  EqualHandoverAbsence,
  EqualHandoverParticipant,
  EqualHandoverPosition,
} from "@/types/equal-technician-handover";

export const EQUAL_HANDOVER_READINESS_REASONS = {
  /** No immutable frozen report is bound to the reservation. */
  NO_FROZEN_REPORT_BINDING: "no_frozen_report_binding",
  /** A required participant has neither a personal confirmation nor a permitted absence. */
  MISSING_CONFIRMATION: "missing_confirmation",
  /** A standing confirmation was recorded against a different frozen report. */
  CONFIRMATION_REPORT_MISMATCH: "confirmation_report_mismatch",
  /** The bound report is no longer the newest version of its reservation chain. */
  REPORT_SUPERSEDED: "report_superseded",
  /** The evidence behind the bound report no longer matches the authoritative sources. */
  REPORT_EVIDENCE_STALE: "report_evidence_stale",
  /** The reviewed preparation no longer matches live evidence, so no freeze is current. */
  REVIEW_STALE: "review_stale",
  /** An absence is of an unsupported type, for the wrong side, malformed or withdrawn. */
  INVALID_ABSENCE_EVIDENCE: "invalid_absence_evidence",
  /** More than one absence is declared; v2 supports exactly one exception. */
  MULTIPLE_ABSENCES: "multiple_absences",
  /** Two resolutions cover the same participant position. */
  CONFLICTING_PARTICIPANT_RESOLUTION: "conflicting_participant_resolution",
  /** The reservation lifecycle is terminal, so no resolution round is open. */
  HANDOVER_NOT_OPEN: "handover_not_open",
} as const;

export type EqualHandoverReadinessReason =
  (typeof EQUAL_HANDOVER_READINESS_REASONS)[keyof typeof EQUAL_HANDOVER_READINESS_REASONS];

export interface EqualHandoverReadiness {
  readonly schema: "equal-handover-readiness-v2";
  readonly ready: boolean;
  readonly reasons: EqualHandoverReadinessReason[];
  readonly missingConfirmations: EqualHandoverPosition[];
  readonly invalidAbsences: EqualHandoverPosition[];
  readonly confirmedCount: number;
  readonly absenceCount: number;
  readonly requiredConfirmations: number;
  readonly supportedAbsences: number;
  readonly lifecycleStatus: string;
  readonly boundReportId: string | null;
  readonly boundReportVersion: number | null;
  readonly newestReportVersion: number;
  readonly transferAuthorized: false;
}

export interface EqualHandoverReadinessEvidence {
  readonly lifecycleStatus: string;
  readonly reportBinding: { readonly id: string; readonly reservationId: string } | null;
  readonly participants: readonly EqualHandoverParticipant[];
  readonly absences: readonly EqualHandoverAbsence[];
  /** Id of the frozen report currently bound to the reservation, or null. */
  readonly boundReportId: string | null;
  /** Version of that bound report, or null when it cannot be proven. */
  readonly boundReportVersion: number | null;
  /** Newest version that exists in this reservation's frozen report chain. */
  readonly newestReportVersion: number;
  /** Live evidence recomputed now differs from the bound report's reviewed evidence. */
  readonly boundReportEvidenceDrifted: boolean;
  /** The latest reviewed preparation has been overtaken by live sources. */
  readonly preparationDrifted: boolean;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function positionSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A standing absence must be one of the two supported categories, recorded for
 * the correct side, and carry the evidence that category requires. Anything
 * else cannot substitute for a genuine personal confirmation.
 */
function absenceIsSupported(absence: EqualHandoverAbsence | undefined, side: string): boolean {
  if (!absence) return false;
  if (absence.reason === null || absence.reason === undefined || !absence.reason.trim()) return false;
  if (side === EQUAL_HANDOVER_SIDES.INCOMING) {
    return absence.absenceType === EQUAL_ABSENCE_TYPES.NOT_YET_IN && !absence.reportedDepartureTime;
  }
  if (side === EQUAL_HANDOVER_SIDES.OUTGOING) {
    if (absence.absenceType !== EQUAL_ABSENCE_TYPES.ABSENT_LEFT_OFFICE) return false;
    if (!absence.reportedDepartureTime) return false;
    return Number.isFinite(Date.parse(absence.reportedDepartureTime));
  }
  return false;
}

export function evaluateEqualHandoverReadiness(
  evidence: EqualHandoverReadinessEvidence,
): EqualHandoverReadiness {
  const reasons: EqualHandoverReadinessReason[] = [];
  const R = EQUAL_HANDOVER_READINESS_REASONS;
  const S = EQUAL_HANDOVER_PARTICIPANT_STATES;

  if (evidence.lifecycleStatus !== EQUAL_HANDOVER_LIFECYCLE_STATUSES.COLLECTING_CONFIRMATIONS) {
    reasons.push(R.HANDOVER_NOT_OPEN);
  }

  const bound = evidence.reportBinding;
  if (!bound || !bound.id || bound.id !== evidence.boundReportId) {
    reasons.push(R.NO_FROZEN_REPORT_BINDING);
  } else {
    if (evidence.boundReportVersion === null) reasons.push(R.NO_FROZEN_REPORT_BINDING);
    if (evidence.newestReportVersion > (evidence.boundReportVersion ?? 0)) reasons.push(R.REPORT_SUPERSEDED);
    if (evidence.boundReportEvidenceDrifted) reasons.push(R.REPORT_EVIDENCE_STALE);
    if (evidence.preparationDrifted) reasons.push(R.REVIEW_STALE);
  }

  const absenceByPosition = new Map(evidence.absences.map((item) => [item.position, item]));
  const confirmedPositions = new Set<EqualHandoverPosition>();
  const missingConfirmations: string[] = [];
  const invalidAbsences: string[] = [];
  let confirmedCount = 0;

  for (const participant of evidence.participants) {
    if (participant.state === S.CONFIRMED) {
      confirmedCount += 1;
      confirmedPositions.add(participant.position);
      if (absenceByPosition.has(participant.position)) {
        reasons.push(R.CONFLICTING_PARTICIPANT_RESOLUTION);
      }
      if (bound && participant.confirmation && participant.confirmation.reportBinding.id !== bound.id) {
        reasons.push(R.CONFIRMATION_REPORT_MISMATCH);
      }
      continue;
    }
    if (participant.state === S.ABSENT) {
      if (!absenceIsSupported(participant.absence, participant.side)) {
        invalidAbsences.push(participant.position);
        reasons.push(R.INVALID_ABSENCE_EVIDENCE);
      }
      continue;
    }
    if (participant.state === S.AWAITING_CONFIRMATION) {
      missingConfirmations.push(participant.position);
      reasons.push(R.MISSING_CONFIRMATION);
      continue;
    }
    reasons.push(R.MISSING_CONFIRMATION);
    missingConfirmations.push(participant.position);
  }

  if (evidence.absences.length > 1) reasons.push(R.MULTIPLE_ABSENCES);

  return {
    schema: "equal-handover-readiness-v2",
    ready: uniqueSorted(reasons).length === 0,
    reasons: uniqueSorted(reasons) as EqualHandoverReadinessReason[],
    missingConfirmations: positionSorted(missingConfirmations) as EqualHandoverPosition[],
    invalidAbsences: positionSorted(invalidAbsences) as EqualHandoverPosition[],
    confirmedCount,
    absenceCount: evidence.absences.length,
    requiredConfirmations: 4,
    supportedAbsences: 1,
    lifecycleStatus: evidence.lifecycleStatus,
    boundReportId: evidence.boundReportId,
    boundReportVersion: evidence.boundReportVersion,
    newestReportVersion: evidence.newestReportVersion,
    transferAuthorized: false,
  };
}
