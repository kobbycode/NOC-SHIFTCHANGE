// 09M-R3B.2 Phase 4A — pure guard lifecycle classifier.
//
// The reservation guard is completed only after both reserved incoming
// technicians have valid personal applications, or by an operator-authorized
// exception closure. Activation alone never finalizes it: the partner must
// still be able to join. This classifier is the single pure decision table used
// by the finalization transaction, the reconciliation service and the tests; it
// performs no I/O and mutates nothing.

import type { HandoverReservationGuard } from "@/types/handover-reservation-guard";
import type {
  IncomingAcceptanceExceptionalClosure,
  IncomingAcceptanceGuardApplicationState,
} from "@/types/incoming-acceptance-application";
import {
  evaluateIncomingAcceptanceGuardCompletion,
  type IncomingAcceptanceGuardCompletionResult,
} from "./incoming-acceptance-application-domain";

export const INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES = {
  AWAITING_FIRST_ACCEPTANCE: "awaiting_first_acceptance",
  AWAITING_PARTNER_ACCEPTANCE: "awaiting_partner_acceptance",
  ELIGIBLE_FOR_NORMAL_CLOSURE: "eligible_for_normal_closure",
  EXCEPTIONAL_CLOSURE_AUTHORIZED: "exceptional_closure_authorized",
  JOINING_WINDOW_EXPIRED: "joining_window_expired",
  GUARD_FINALIZED: "guard_finalized",
  INCONSISTENT_REVIEW_REQUIRED: "inconsistent_review_required",
} as const;

export type IncomingAcceptanceGuardLifecycleState =
  (typeof INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES)[keyof typeof INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES];

export type IncomingAcceptanceGuardLifecycleReason =
  | "HANDOVER_NOT_ACTIVATED"
  | "RECEIPT_BEFORE_ACTIVATION"
  | "ACTIVATION_RECEIPT_MISSING"
  | "PARTNER_NOT_YET_APPLIED"
  | "JOIN_WINDOW_CLOSED"
  | "NORMAL_CLOSURE_READY"
  | "EXCEPTIONAL_CLOSURE_READY"
  | "GUARD_FINALIZED"
  | "GUARD_MISSING"
  | "GUARD_OWNER_MISMATCH"
  | "GUARD_CANCELLED"
  | "TERMINAL_REFERENCE_MISMATCH"
  | "APPLICATION_RECEIPT_INCONSISTENT"
  | "CLOSURE_INVALID"
  | "CLOSURE_SUBJECT_NOT_MISSING"
  | "CLOCK_INVALID";

export interface IncomingAcceptanceGuardLifecycleInput {
  handoverDocumentId: string;
  aggregateLifecycleStatus: string;
  scheduledStart: string;
  scheduledEnd: string;
  /** Server-derived request clock; never a client value. */
  nowIso: string;
  guard: HandoverReservationGuard | null;
  activationReceiptId: string | null;
  activationReceiptHash: string | null;
  activationActorUid: string | null;
  applications: IncomingAcceptanceGuardApplicationState[];
  exceptionalClosure?: IncomingAcceptanceExceptionalClosure | null;
}

export interface IncomingAcceptanceGuardLifecycleClassification {
  state: IncomingAcceptanceGuardLifecycleState;
  reason: IncomingAcceptanceGuardLifecycleReason;
  missingTechnicianUids: string[];
  terminalEvidenceRef: string | null;
  closureSubjectUid: string | null;
  /** True only when both valid personal applications prove the closure. */
  automatic: boolean;
  requiresOperatorWorkflow: boolean;
}

function classify(
  state: IncomingAcceptanceGuardLifecycleState,
  reason: IncomingAcceptanceGuardLifecycleReason,
  input: IncomingAcceptanceGuardLifecycleInput,
  missing: string[] = [],
): IncomingAcceptanceGuardLifecycleClassification {
  return {
    state,
    reason,
    missingTechnicianUids: missing,
    terminalEvidenceRef: input.guard?.terminalEvidenceRef ?? null,
    closureSubjectUid: input.exceptionalClosure?.subjectUid ?? null,
    automatic: state === INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.ELIGIBLE_FOR_NORMAL_CLOSURE,
    requiresOperatorWorkflow:
      state === INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.EXCEPTIONAL_CLOSURE_AUTHORIZED ||
      state === INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.JOINING_WINDOW_EXPIRED ||
      state === INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
  };
}

function completionFor(
  input: IncomingAcceptanceGuardLifecycleInput,
): IncomingAcceptanceGuardCompletionResult | null {
  const reserved = input.applications.map((item) => item.technicianUid);
  if (reserved.length !== 2) return null;
  try {
    return evaluateIncomingAcceptanceGuardCompletion({
      reservedTechnicianIds: [reserved[0], reserved[1]],
      activationReceiptId: input.activationReceiptId,
      activationReceiptHash: input.activationReceiptHash,
      activationActorUid: input.activationActorUid,
      aggregateLifecycleStatus: input.aggregateLifecycleStatus,
      applications: input.applications,
      exceptionalClosure: input.exceptionalClosure ?? null,
    });
  } catch {
    return null;
  }
}

export function classifyIncomingAcceptanceGuardLifecycle(
  input: IncomingAcceptanceGuardLifecycleInput,
): IncomingAcceptanceGuardLifecycleClassification {
  const now = Date.parse(input.nowIso);
  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(input.scheduledEnd))) {
    return classify(
      INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
      "CLOCK_INVALID",
      input,
    );
  }

  const { guard } = input;
  if (guard === null) {
    return classify(
      INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
      "GUARD_MISSING",
      input,
    );
  }
  if (guard.protocolOwner !== "v2" || guard.ownerHandoverDocumentId !== input.handoverDocumentId) {
    return classify(
      INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
      "GUARD_OWNER_MISMATCH",
      input,
    );
  }
  if (guard.ownerLifecycleState === "cancelled") {
    return classify(
      INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
      "GUARD_CANCELLED",
      input,
    );
  }
  if (guard.ownerLifecycleState === "completed") {
    const expected = input.exceptionalClosure?.closureId ?? input.activationReceiptId;
    if (expected !== null && guard.terminalEvidenceRef === expected) {
      return classify(
        INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.GUARD_FINALIZED,
        "GUARD_FINALIZED",
        input,
      );
    }
    return classify(
      INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
      "TERMINAL_REFERENCE_MISMATCH",
      input,
    );
  }

  if (input.aggregateLifecycleStatus !== "completed") {
    if (input.applications.some((item) => item.receipt !== null)) {
      return classify(
        INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
        "RECEIPT_BEFORE_ACTIVATION",
        input,
      );
    }
    return classify(
      INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.AWAITING_FIRST_ACCEPTANCE,
      "HANDOVER_NOT_ACTIVATED",
      input,
    );
  }

  const completion = completionFor(input);
  if (completion === null) {
    return classify(
      INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
      "APPLICATION_RECEIPT_INCONSISTENT",
      input,
    );
  }
  switch (completion.status) {
    case "eligible":
      return classify(
        INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.ELIGIBLE_FOR_NORMAL_CLOSURE,
        "NORMAL_CLOSURE_READY",
        input,
      );
    case "exceptional_closure_authorized":
      return classify(
        INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.EXCEPTIONAL_CLOSURE_AUTHORIZED,
        "EXCEPTIONAL_CLOSURE_READY",
        input,
      );
    case "exceptional_closure_invalid":
      return classify(
        INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
        completion.reason === "CLOSURE_SUBJECT_NOT_MISSING"
          ? "CLOSURE_SUBJECT_NOT_MISSING"
          : "CLOSURE_INVALID",
        input,
      );
    case "not_eligible":
      switch (completion.reason) {
        case "ACTIVATION_RECEIPT_MISSING":
          return classify(
            INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
            "ACTIVATION_RECEIPT_MISSING",
            input,
          );
        case "APPLICATION_RECEIPT_INCONSISTENT":
          return classify(
            INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.INCONSISTENT_REVIEW_REQUIRED,
            "APPLICATION_RECEIPT_INCONSISTENT",
            input,
          );
        case "PERSONAL_RECEIPT_MISSING":
          if (now >= Date.parse(input.scheduledEnd)) {
            return classify(
              INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.JOINING_WINDOW_EXPIRED,
              "JOIN_WINDOW_CLOSED",
              input,
              completion.missingTechnicianUids,
            );
          }
          return classify(
            INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.AWAITING_PARTNER_ACCEPTANCE,
            "PARTNER_NOT_YET_APPLIED",
            input,
            completion.missingTechnicianUids,
          );
        case "HANDOVER_NOT_COMPLETED":
          return classify(
            INCOMING_ACCEPTANCE_GUARD_LIFECYCLE_STATES.AWAITING_FIRST_ACCEPTANCE,
            "HANDOVER_NOT_ACTIVATED",
            input,
          );
      }
  }
}
