import "server-only";

import type { ShiftStatus } from "@/types/shift";
import { ATTENDANCE_EVIDENCE_KINDS } from "@/types/attendance-evidence";

import { AssignmentOperationError } from "./assignment-transaction";
import {
  attendanceEvidenceId,
  attendanceEvidenceSlotId,
} from "./attendance-evidence-domain";
import {
  getOperationalCollections,
  GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
} from "./collections";
import { assertOperationalShiftControl } from "./operational-shift-control-state";
import { createNextShiftAuthorizationDocumentId } from "./next-shift-authorization-domain";
import {
  evaluateTechnicianWriteAuthority,
  isTechnicianWriteAuthorityGovernedRole,
  type ActiveShiftFacts,
  type TechnicianWriteAuthority,
} from "./technician-write-authority";

/**
 * Phase 4 — the authoritative facts behind the owner-set participation
 * contract. `personallyAcceptedShiftId` is proven from the technician's OWN
 * password-authenticated acceptance evidence, never from `shift_attendance`:
 * a supervisor-initiated formal transfer creates attendance for the reserved
 * incoming pair without any personal handover acceptance, so attendance
 * existence cannot establish write authority.
 */

export interface TechnicianWriteAuthoritySnapshot extends TechnicianWriteAuthority {
  activeShiftId: string | null;
  personallyAcceptedShiftId: string | null;
}

export interface TechnicianWriteAuthorityActor {
  uid: string;
  role: string;
}

const SHIFT_STATUSES: readonly ShiftStatus[] = [
  "scheduled",
  "active",
  "handover_pending",
  "completed",
  "cancelled",
];

// The two evidence kinds a reserved incoming technician personally produces
// when they accept a handover with their own password (inside or beyond the
// grace window). Both are written to deterministic slot documents.
const PERSONAL_ACCEPTANCE_EVIDENCE_KINDS = [
  ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
  ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE,
] as const;

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/")
  );
}

function readShiftStatus(value: unknown): ShiftStatus {
  if (
    typeof value !== "string" ||
    !SHIFT_STATUSES.includes(value as ShiftStatus)
  ) {
    throw new AssignmentOperationError(
      "The current operational shift requires administrator review.",
      409,
    );
  }
  return value as ShiftStatus;
}

function readPrimaryTechnicianIds(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((uid) => !isIdentifier(uid, 128)) ||
    new Set(value).size !== value.length
  ) {
    throw new AssignmentOperationError(
      "The current operational shift requires administrator review.",
      409,
    );
  }
  return value as readonly string[];
}

async function readPersonalAcceptance(input: {
  handoverDocumentId: string;
  technicianUid: string;
}): Promise<boolean> {
  const { equalHandoversV2, attendanceEvidenceV2 } = getOperationalCollections();
  const handoverSnapshot = await equalHandoversV2
    .doc(input.handoverDocumentId)
    .get();
  if (!handoverSnapshot.exists) return false;

  const reservation = handoverSnapshot.data()?.reservation;
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    return false;
  }
  const handoverId = (reservation as Record<string, unknown>).handoverId;
  if (!isIdentifier(handoverId, 512)) return false;

  const evidenceDocuments = await Promise.all(
    PERSONAL_ACCEPTANCE_EVIDENCE_KINDS.map((kind) =>
      attendanceEvidenceV2
        .doc(
          attendanceEvidenceId(
            attendanceEvidenceSlotId({
              handoverId,
              technicianUid: input.technicianUid,
              kind,
            }),
          ),
        )
        .get(),
    ),
  );

  return evidenceDocuments.some((document) => document.exists);
}

async function readFoundingTemporaryParticipantship(input: {
  shiftId: string;
  technicianUid: string;
  permanentPairId: unknown;
  slotGeneration: number;
  slotToken: string;
}): Promise<boolean> {
  if (!isIdentifier(input.permanentPairId, 512)) return false;

  let authorizationDocumentId: string;
  try {
    authorizationDocumentId = createNextShiftAuthorizationDocumentId(
      input.permanentPairId,
      input.slotGeneration,
      input.slotToken,
    );
  } catch {
    return false;
  }

  const { nextShiftAuthorizations } = getOperationalCollections();
  const snapshot = await nextShiftAuthorizations
    .doc(authorizationDocumentId)
    .get();
  if (!snapshot.exists) return false;

  const authorization = snapshot.data();
  return (
    authorization?.authorizedTechnicianUid === input.technicianUid &&
    authorization.shiftId === input.shiftId
  );
}

async function readActiveShiftFacts(input: {
  shiftId: string;
  technicianUid: string;
  slotGeneration: number;
  slotToken: string;
}): Promise<{
  facts: ActiveShiftFacts;
  personallyAcceptedShiftId: string | null;
}> {
  const { shifts } = getOperationalCollections();
  const shiftSnapshot = await shifts.doc(input.shiftId).get();
  if (!shiftSnapshot.exists) {
    throw new AssignmentOperationError(
      "The current operational shift is unavailable.",
      409,
    );
  }

  const shift = shiftSnapshot.data() as Record<string, unknown>;
  if (shift.id !== input.shiftId) {
    throw new AssignmentOperationError(
      "The current operational shift requires administrator review.",
      409,
    );
  }

  const status = readShiftStatus(shift.status);
  const primaryTechnicianIds = readPrimaryTechnicianIds(shift.primaryTechnicianIds);

  // A completed shift is durable, monotonic proof that an earlier shift was
  // activated, so the currently running shift is the founding shift only when
  // no earlier shift has ever completed.
  const completedShifts = await shifts
    .where("status", "==", "completed")
    .limit(1)
    .get();
  const isFoundingShift = completedShifts.empty;

  // On the founding shift the pair founds it, and a temporary technician
  // enters it through their own consumed authorization (starting it). Any
  // later shift requires a personal handover acceptance instead.
  let participantIds = primaryTechnicianIds;
  if (
    isFoundingShift &&
    !primaryTechnicianIds.includes(input.technicianUid) &&
    (await readFoundingTemporaryParticipantship({
      shiftId: input.shiftId,
      technicianUid: input.technicianUid,
      permanentPairId: shift.permanentPairId,
      slotGeneration: input.slotGeneration,
      slotToken: input.slotToken,
    }))
  ) {
    participantIds = [...primaryTechnicianIds, input.technicianUid];
  }

  let personallyAcceptedShiftId: string | null = null;
  if (
    !isFoundingShift &&
    isIdentifier(shift.handoverDocumentId, 512) &&
    primaryTechnicianIds.includes(input.technicianUid)
  ) {
    const accepted = await readPersonalAcceptance({
      handoverDocumentId: shift.handoverDocumentId,
      technicianUid: input.technicianUid,
    });
    if (accepted) personallyAcceptedShiftId = input.shiftId;
  }

  return {
    facts: {
      id: input.shiftId,
      status,
      primaryTechnicianIds: participantIds,
      isFoundingShift,
    },
    personallyAcceptedShiftId,
  };
}

export async function readTechnicianWriteAuthority(
  actor: TechnicianWriteAuthorityActor,
): Promise<TechnicianWriteAuthoritySnapshot> {
  if (!isTechnicianWriteAuthorityGovernedRole(actor.role)) {
    return {
      ...evaluateTechnicianWriteAuthority({
        actorUid: actor.uid,
        actorRole: actor.role,
        activeShift: null,
        personallyAcceptedShiftId: null,
      }),
      activeShiftId: null,
      personallyAcceptedShiftId: null,
    };
  }

  if (!isIdentifier(actor.uid, 128)) {
    throw new AssignmentOperationError(
      "Your account is not authorized to change operational data.",
      403,
    );
  }

  const { operationalShiftControl } = getOperationalCollections();
  const controlSnapshot = await operationalShiftControl
    .doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID)
    .get();
  if (!controlSnapshot.exists) {
    throw new AssignmentOperationError(
      "The global operational shift-control record is unavailable.",
      409,
    );
  }

  let control;
  try {
    control = assertOperationalShiftControl(controlSnapshot.data());
  } catch {
    throw new AssignmentOperationError(
      "The global operational shift-control record requires administrator review.",
      409,
    );
  }

  if (control.slotStatus !== "consumed" || control.shiftId === null) {
    return {
      ...evaluateTechnicianWriteAuthority({
        actorUid: actor.uid,
        actorRole: actor.role,
        activeShift: null,
        personallyAcceptedShiftId: null,
      }),
      activeShiftId: null,
      personallyAcceptedShiftId: null,
    };
  }

  const { facts, personallyAcceptedShiftId } = await readActiveShiftFacts({
    shiftId: control.shiftId,
    technicianUid: actor.uid,
    slotGeneration: control.generation,
    slotToken: control.slotToken,
  });

  return {
    ...evaluateTechnicianWriteAuthority({
      actorUid: actor.uid,
      actorRole: actor.role,
      activeShift: facts,
      personallyAcceptedShiftId,
    }),
    activeShiftId: facts.id,
    personallyAcceptedShiftId,
  };
}

export async function requireTechnicianWriteAuthority(
  actor: TechnicianWriteAuthorityActor,
): Promise<TechnicianWriteAuthoritySnapshot> {
  const authority = await readTechnicianWriteAuthority(actor);
  if (!authority.mayWrite) {
    throw new AssignmentOperationError(authority.message, 403);
  }
  return authority;
}
