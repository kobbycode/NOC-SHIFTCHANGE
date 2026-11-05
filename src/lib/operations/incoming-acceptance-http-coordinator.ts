// 09M-R3B.2 Phase 5 — trusted HTTP-boundary coordinator for atomic incoming
// acceptance.
//
// This is the only place that turns an authenticated HTTP request into the
// Phase 3 atomic application intent. It:
//   * reads the authoritative acceptance context (authority, roster, guard),
//   * verifies the caller's OWN password against the authoritative Auth account
//     outside any transaction and binds the proof to the session UID,
//   * derives every timestamp from the server clock (never the request body),
//   * builds the reviewed binding and the personal late-arrival reason,
//   * invokes the atomic service exactly once, and
//   * re-verifies the persisted receipt through read-only reconciliation.
//
// It never falls back to the legacy split writer: if the atomic service refuses
// or cannot prove its commit, the caller receives that outcome.

import "server-only";

import { randomUUID } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import {
  PasswordReauthenticationError,
  reauthenticatePassword,
} from "@/lib/auth/password-reauthentication";
import { getAdminAuth } from "@/lib/firebase/admin";
import { ATTENDANCE_EVIDENCE_KINDS } from "@/types/attendance-evidence";
import type { IncomingAcceptanceApplicationReceipt } from "@/types/incoming-acceptance-application";
import {
  INCOMING_ACCEPTANCE_ERROR_CODES,
  IncomingAcceptanceApplicationError,
  createIncomingAcceptanceAuthenticationProof,
  normalizeIncomingAcceptanceLateReason,
} from "./incoming-acceptance-application-domain";
import {
  applyIncomingAcceptanceApplicationAtomically,
  type AtomicIncomingAcceptanceResult,
} from "./incoming-acceptance-application-firestore";
import {
  readEqualHandoverAcceptanceContext,
  type EqualHandoverAcceptanceContext,
} from "./equal-handover-report-firestore";
import {
  reconcileIncomingAcceptance,
  type IncomingAcceptanceReconciliationResult,
} from "./incoming-acceptance-reconciliation";
import {
  ACCEPTANCE_RESPONSE_CODES,
  AtomicAcceptanceHttpError,
  buildReviewedBinding,
  type AtomicAcceptanceRequest,
} from "./handover-v2-atomic-http";

export interface AcceptanceHttpActor {
  uid: string;
  email: string;
  role: string;
  mustChangePassword: boolean;
}

export interface AcceptanceClock {
  nowIso(): string;
  monotonicMs(): number;
}

const defaultClock: AcceptanceClock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => Math.floor(performance.now()),
};

// Test seams only. The production route supplies no dependencies, so the
// authoritative Auth account, password verification, service and reconciliation
// are always the real ones.
export interface AcceptanceCoordinatorDependencies {
  clock?: AcceptanceClock;
  auth?: Pick<Auth, "getUser">;
  reauthenticate?: typeof reauthenticatePassword;
  createNonce?: () => string;
  apply?: typeof applyIncomingAcceptanceApplicationAtomically;
  reconcile?: typeof reconcileIncomingAcceptance;
}

export interface AtomicAcceptanceCoordinatorResult {
  result: AtomicIncomingAcceptanceResult;
  receipt: IncomingAcceptanceApplicationReceipt;
  reconciliation: IncomingAcceptanceReconciliationResult | null;
}

function reject(input: {
  code: (typeof ACCEPTANCE_RESPONSE_CODES)[keyof typeof ACCEPTANCE_RESPONSE_CODES];
  status: number;
  message: string;
  lifecycleState?: string | null;
  retryable?: boolean;
  refreshStatus?: boolean;
}): never {
  throw new AtomicAcceptanceHttpError({
    code: input.code,
    status: input.status,
    message: input.message,
    commitState: "not_committed",
    lifecycleState: input.lifecycleState ?? null,
    retryable: input.retryable ?? false,
    refreshStatus: input.refreshStatus ?? false,
  });
}

export async function coordinateAtomicIncomingAcceptance(input: {
  outgoingShiftId: string;
  actor: AcceptanceHttpActor;
  reviewed: AtomicAcceptanceRequest;
  dependencies?: AcceptanceCoordinatorDependencies;
}): Promise<AtomicAcceptanceCoordinatorResult> {
  const dependencies = input.dependencies ?? {};
  const clock = dependencies.clock ?? defaultClock;
  const auth = dependencies.auth ?? getAdminAuth();
  const reauthenticate = dependencies.reauthenticate ?? reauthenticatePassword;
  const apply = dependencies.apply ?? applyIncomingAcceptanceApplicationAtomically;
  const reconcile = dependencies.reconcile ?? reconcileIncomingAcceptance;
  const createNonce = dependencies.createNonce ?? (() => randomUUID());
  const actor = input.actor;
  const reviewed = input.reviewed;

  // The request acceptance clock is captured BEFORE credential verification.
  const requestAcceptedAt = clock.nowIso();

  const context: EqualHandoverAcceptanceContext =
    await readEqualHandoverAcceptanceContext(input.outgoingShiftId, actor.uid);

  if (context.lifecycleStatus === "collecting_confirmations") {
    reject({
      code: ACCEPTANCE_RESPONSE_CODES.NOT_APPLIED,
      status: 409,
      message: "This handover is not yet awaiting incoming acceptance.",
      lifecycleState: context.lifecycleStatus,
      retryable: true,
      refreshStatus: true,
    });
  }
  if (context.lifecycleStatus === "cancelled" || context.lifecycleStatus === "superseded") {
    reject({
      code: ACCEPTANCE_RESPONSE_CODES.NOT_APPLIED,
      status: 409,
      message: `The handover is ${context.lifecycleStatus}; acceptance is closed.`,
      lifecycleState: context.lifecycleStatus,
    });
  }

  if (reviewed.expectedRevision !== context.aggregate.revision ||
      reviewed.expectedSnapshotHash !== context.snapshotHash) {
    reject({
      code: ACCEPTANCE_RESPONSE_CODES.BINDING_CONFLICT,
      status: 409,
      message: "The handover changed since it was reviewed. Reload and accept the updated handover.",
      lifecycleState: context.lifecycleStatus,
      retryable: true,
      refreshStatus: true,
    });
  }
  if (reviewed.expectedGuardRevision !== context.guardRevision ||
      reviewed.expectedFencingEpoch !== context.fencingEpoch) {
    reject({
      code: ACCEPTANCE_RESPONSE_CODES.BINDING_CONFLICT,
      status: 409,
      message: "The reservation guard changed since this handover was reviewed.",
      lifecycleState: context.lifecycleStatus,
      retryable: true,
      refreshStatus: true,
    });
  }

  const reviewedBinding = buildReviewedBinding({
    handoverId: context.reservation.handoverId,
    handoverDocumentId: context.handoverDocumentId,
    aggregateRevision: context.aggregate.revision,
    snapshotHash: context.snapshotHash,
    report: context.aggregate.reportBinding,
    guardRevision: context.guardRevision,
    fencingEpoch: context.fencingEpoch,
  });

  // A technician who personally declared `not_yet_in` accepts late under their
  // EXISTING authorized declaration. Its reason is authoritative and is never
  // re-inferred; a conflicting body reason is refused instead of silently
  // overwritten. Everyone else may supply their own late-arrival reason, and
  // the service decides whether it is required.
  const isLateAcceptance =
    context.evidenceKind === ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE;
  let lateReason: string | null;
  if (isLateAcceptance) {
    const declared = context.lateReason;
    const supplied = normalizeIncomingAcceptanceLateReason({
      reason: reviewed.lateReason,
      required: false,
    });
    if (declared === null) {
      reject({
        code: ACCEPTANCE_RESPONSE_CODES.NOT_APPLIED,
        status: 409,
        message: "The late-acceptance declaration is missing its authorized reason.",
        lifecycleState: context.lifecycleStatus,
      });
    }
    if (supplied !== null && supplied !== declared) {
      throw new IncomingAcceptanceApplicationError(
        INCOMING_ACCEPTANCE_ERROR_CODES.LATE_REASON_INVALID,
        "This acceptance is already bound to the declared absence reason.",
      );
    }
    lateReason = declared;
  } else {
    lateReason = normalizeIncomingAcceptanceLateReason({
      reason: reviewed.lateReason,
      required: false,
    });
  }

  // Fresh personal password verification, strictly before any transaction, using
  // the authoritative Auth account identity — never a body email or UID.
  try {
    const account = await auth.getUser(actor.uid);
    if (account.uid !== actor.uid || account.disabled === true || !account.email ||
        account.email.toLowerCase() !== actor.email.toLowerCase()) {
      reject({
        code: ACCEPTANCE_RESPONSE_CODES.NOT_APPLIED,
        status: 403,
        message: "This account cannot accept the handover.",
      });
    }
    const email = account.email;
    await reauthenticate({ expectedUid: actor.uid, email, password: reviewed.password });
    const current = await auth.getUser(actor.uid);
    if (current.uid !== actor.uid || current.disabled === true || current.email !== email) {
      reject({
        code: ACCEPTANCE_RESPONSE_CODES.NOT_APPLIED,
        status: 403,
        message: "Your account changed. Sign in again before accepting.",
      });
    }
  } catch (error) {
    if (error instanceof AtomicAcceptanceHttpError ||
        error instanceof PasswordReauthenticationError ||
        error instanceof IncomingAcceptanceApplicationError) {
      throw error;
    }
    if (error && typeof error === "object" && "code" in error &&
        (error as { code?: string }).code === "auth/user-not-found") {
      reject({
        code: ACCEPTANCE_RESPONSE_CODES.NOT_APPLIED,
        status: 403,
        message: "This account cannot accept the handover.",
      });
    }
    // Upstream failures can carry credentials; never log the raw payload.
    console.error("Atomic incoming acceptance password reauthentication failed.");
    reject({
      code: ACCEPTANCE_RESPONSE_CODES.NOT_APPLIED,
      status: 503,
      message: "Unable to verify your password. Please try again later.",
      retryable: true,
      refreshStatus: true,
    });
  }

  const passwordVerifiedAt = clock.nowIso();
  const verifiedAtMonotonicMs = clock.monotonicMs();
  const authAccountCheckedAt = clock.nowIso();
  const operationalAppliedAt = clock.nowIso();
  const requestNonce = createNonce();

  const proof = createIncomingAcceptanceAuthenticationProof({
    requestNonce,
    verifiedTechnicianUid: actor.uid,
    verifiedAt: passwordVerifiedAt,
    authAccountCheckedAt,
    reviewedBinding,
    lateReason,
    verifiedAtMonotonicMs,
  });

  const result = await apply({
    outgoingShiftId: input.outgoingShiftId,
    actorUid: actor.uid,
    reviewedBinding,
    lateReason,
    requestNonce,
    proof,
    requestAcceptedAt,
    operationalAppliedAt,
    nowIso: clock.nowIso(),
    nowMonotonicMs: clock.monotonicMs(),
  });

  // Independent read-only verification of the PERSISTED receipt. A failure to
  // read it never invalidates a validated commit; a contradictory status does.
  let reconciliation: IncomingAcceptanceReconciliationResult | null = null;
  try {
    reconciliation = await reconcile({
      outgoingShiftId: input.outgoingShiftId,
      technicianUid: actor.uid,
    });
  } catch {
    reconciliation = null;
  }
  if (reconciliation !== null && reconciliation.status !== "APPLIED_VALIDATED") {
    throw new AtomicAcceptanceHttpError({
      code: ACCEPTANCE_RESPONSE_CODES.RECONCILIATION_CONFLICT,
      status: 503,
      message: "The acceptance was committed but its persisted receipt does not reconcile yet. Refresh the acceptance status.",
      commitState: "committed_inconsistent",
      lifecycleState: reconciliation.guardLifecycleState,
      retryable: true,
      refreshStatus: true,
    });
  }

  return { result, receipt: result.receipt, reconciliation };
}
