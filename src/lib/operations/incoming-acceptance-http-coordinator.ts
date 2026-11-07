// 09M-R3B.2 Phase 5 — trusted HTTP-boundary coordinator for atomic incoming
// acceptance.
//
// This is the only place that turns an authenticated HTTP request into the
// Phase 3 atomic application intent. It:
//   * authorizes the shared console as a participant of this handover,
//   * reads the authoritative acceptance context for the NAMED reserved incoming
//     technician (authority, roster, guard),
//   * verifies that technician's OWN password against their authoritative Auth
//     account outside any transaction and binds the proof to their UID,
//   * derives every timestamp from the server clock (never the request body),
//   * builds the reviewed binding and the personal late-arrival reason,
//   * invokes the atomic service exactly once,
//   * re-verifies the persisted receipt through read-only reconciliation, and
//   * hands the one-shot id token back to the route so the acceptance can sign
//     that technician in on this console.
//
// The console session is NOT the accepting technician: it is usually still an
// outgoing technician, who may never accept for the incoming pair. Authority
// comes only from the named incoming technician's own verified credential.
//
// It never falls back to the legacy split writer: if the atomic service refuses
// or cannot prove its commit, the caller receives that outcome. The credential
// it returns is server-side only and is never part of a receipt or a response.

import "server-only";

import { randomUUID } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import {
  PasswordReauthenticationError,
  authenticatePasswordForSession,
} from "@/lib/auth/password-reauthentication";
import { getAdminAuth } from "@/lib/firebase/admin";
import { ATTENDANCE_EVIDENCE_KINDS } from "@/types/attendance-evidence";
import {
  INCOMING_ACCEPTANCE_OUTCOMES,
  type IncomingAcceptanceApplicationReceipt,
} from "@/types/incoming-acceptance-application";
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
  authorizeHandoverConsoleActor,
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
import { normalizeAttendanceLocationEvidence } from "./attendance-location-evidence";

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
  authenticate?: typeof authenticatePasswordForSession;
  createNonce?: () => string;
  apply?: typeof applyIncomingAcceptanceApplicationAtomically;
  reconcile?: typeof reconcileIncomingAcceptance;
}

// Server-side only. The route exchanges this one-shot id token for the accepting
// technician's session cookie immediately after the acceptance commits; it is
// never written to a receipt, a response body, an audit record or a log.
export interface AcceptanceSessionCredential {
  acceptingTechnicianUid: string;
  consoleActorUid: string;
  outgoingShiftId: string;
  handoverDocumentId: string;
  outgoingTechnicianIds: readonly string[];
  idToken: string;
  firstActivation: boolean;
  acceptanceReceiptId: string;
}

export interface AtomicAcceptanceCoordinatorResult {
  result: AtomicIncomingAcceptanceResult;
  receipt: IncomingAcceptanceApplicationReceipt;
  reconciliation: IncomingAcceptanceReconciliationResult | null;
  sessionCredential: AcceptanceSessionCredential;
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
  const authenticate = dependencies.authenticate ?? authenticatePasswordForSession;
  const apply = dependencies.apply ?? applyIncomingAcceptanceApplicationAtomically;
  const reconcile = dependencies.reconcile ?? reconcileIncomingAcceptance;
  const createNonce = dependencies.createNonce ?? (() => randomUUID());
  const actor = input.actor;
  const reviewed = input.reviewed;

  // The request acceptance clock is captured BEFORE credential verification.
  const requestAcceptedAt = clock.nowIso();

  // The shared console must belong to this reserved pair. It is never the
  // accepting technician's authority, and a non-participant learns nothing here.
  await authorizeHandoverConsoleActor(input.outgoingShiftId, actor.uid);

  // Everything below is derived from the NAMED reserved incoming technician,
  // whose own password is verified before any write. The roster constraint is
  // enforced by the context reader, so a forged or outgoing UID cannot accept.
  const acceptingTechnicianUid = reviewed.technicianUid;
  const context: EqualHandoverAcceptanceContext =
    await readEqualHandoverAcceptanceContext(input.outgoingShiftId, acceptingTechnicianUid);

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

  // Fresh personal password verification for the NAMED incoming technician,
  // strictly before any transaction, using their authoritative Auth account
  // email — never a body email, and never the console actor's identity. This is
  // the only credential path that retains a one-shot id token, because the
  // acceptance must also sign that technician in on this console.
  let idToken: string;
  try {
    const account = await auth.getUser(acceptingTechnicianUid);
    if (account.uid !== acceptingTechnicianUid || account.disabled === true || !account.email) {
      reject({
        code: ACCEPTANCE_RESPONSE_CODES.NOT_APPLIED,
        status: 403,
        message: "This account cannot accept the handover.",
      });
    }
    const email = account.email;
    const verified = await authenticate({
      expectedUid: acceptingTechnicianUid,
      email,
      password: reviewed.password,
    });
    idToken = verified.idToken;
    const current = await auth.getUser(acceptingTechnicianUid);
    if (current.uid !== acceptingTechnicianUid || current.disabled === true || current.email !== email) {
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
    verifiedTechnicianUid: acceptingTechnicianUid,
    verifiedAt: passwordVerifiedAt,
    authAccountCheckedAt,
    reviewedBinding,
    lateReason,
    verifiedAtMonotonicMs,
  });

  const result = await apply({
    outgoingShiftId: input.outgoingShiftId,
    actorUid: acceptingTechnicianUid,
    reviewedBinding,
    lateReason,
    requestNonce,
    proof,
    requestAcceptedAt,
    operationalAppliedAt,
    // Coarse presence evidence captured at this personal act. It is derived
    // against the trusted server clock and never blocks an acceptance.
    locationEvidence: normalizeAttendanceLocationEvidence(
      reviewed.locationEvidence,
      requestAcceptedAt,
    ),
    nowIso: clock.nowIso(),
    nowMonotonicMs: clock.monotonicMs(),
  });

  // Independent read-only verification of the PERSISTED receipt. A failure to
  // read it never invalidates a validated commit; a contradictory status does.
  let reconciliation: IncomingAcceptanceReconciliationResult | null = null;
  try {
    reconciliation = await reconcile({
      outgoingShiftId: input.outgoingShiftId,
      technicianUid: acceptingTechnicianUid,
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

  return {
    result,
    receipt: result.receipt,
    reconciliation,
    sessionCredential: {
      acceptingTechnicianUid,
      consoleActorUid: actor.uid,
      outgoingShiftId: input.outgoingShiftId,
      handoverDocumentId: result.handoverDocumentId,
      outgoingTechnicianIds: context.identity.outgoingTechnicianIds,
      idToken,
      firstActivation:
        result.status === "APPLIED" &&
        result.outcome === INCOMING_ACCEPTANCE_OUTCOMES.FIRST_ACTIVATION,
      acceptanceReceiptId: result.receipt.id,
    },
  };
}
