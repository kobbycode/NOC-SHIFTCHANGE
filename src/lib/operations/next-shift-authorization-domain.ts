import { createHash } from "node:crypto";

import {
  assertOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
  type OperationalShiftControl,
} from "./operational-shift-control-state";

import type {
  NextShiftAuthorization,
} from "@/types/next-shift-authorization";

import {
  NEXT_SHIFT_AUTHORIZATION_STATUSES,
} from "@/types/next-shift-authorization";

export class NextShiftAuthorizationDomainError extends Error {
  public readonly status: number;

  constructor(
    message: string,
    status = 409
  ) {
    super(message);
    this.status = status;
    this.name = "NextShiftAuthorizationDomainError";
  }
}

export interface CreateNextShiftAuthorizationInput {
  permanentPairId: string;
  authorizedTechnicianUid: string;
}

export interface CurrentSlotAuthorizationDocument {
  id: string;
  data: unknown;
}

export interface ShiftCreationPairBinding {
  permanentPairId: string;
  primaryTechnicianIds: [string, string];
  consumedAuthorization: NextShiftAuthorization | null;
}

export function parseCreateNextShiftAuthorizationInput(
  value: unknown
): CreateNextShiftAuthorizationInput {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new NextShiftAuthorizationDomainError(
      "Please provide valid authorization details.",
      400
    );
  }

  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);

  if (
    keys.length !== 2 ||
    !keys.includes("permanentPairId") ||
    !keys.includes("authorizedTechnicianUid")
  ) {
    throw new NextShiftAuthorizationDomainError(
      "Only permanentPairId and authorizedTechnicianUid may be provided.",
      400
    );
  }

  const permanentPairId =
    input.permanentPairId;
  const authorizedTechnicianUid =
    input.authorizedTechnicianUid;

  if (!isValidIdentifier(permanentPairId, 512)) {
    throw new NextShiftAuthorizationDomainError(
      "Please provide a valid permanent pair identifier.",
      400
    );
  }

  if (!isValidIdentifier(authorizedTechnicianUid, 128)) {
    throw new NextShiftAuthorizationDomainError(
      "Please select a valid technician.",
      400
    );
  }

  return {
    permanentPairId,
    authorizedTechnicianUid,
  };
}

export function createNextShiftAuthorizationDocumentId(
  permanentPairId: string,
  slotGeneration: number,
  slotToken: string
): string {
  if (
    !isValidIdentifier(permanentPairId, 512) ||
    !Number.isSafeInteger(slotGeneration) ||
    slotGeneration < 1 ||
    !isValidUuid(slotToken)
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The authorization slot identity is invalid.",
      409
    );
  }

  const identity = [
    permanentPairId,
    String(slotGeneration),
    slotToken,
  ].join("\u0000");
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex");

  return `next-shift-auth-${digest}`;
}

export function selectPendingAuthorizationForShift(
  controlValue: unknown,
  permanentPairId: string,
  documents: readonly CurrentSlotAuthorizationDocument[]
): NextShiftAuthorization | null {
  let control: OperationalShiftControl;

  try {
    control = assertOperationalShiftControl(controlValue);
  } catch {
    throw new NextShiftAuthorizationDomainError(
      "The global operational shift-control record requires administrator review.",
      409
    );
  }

  if (
    control.slotStatus !== "pending" ||
    control.shiftId !== null ||
    control.shiftStatus !== null
  ) {
    throw new NextShiftAuthorizationDomainError(
      "A shift can only be created for the current pending global slot.",
      409
    );
  }

  if (documents.length === 0) {
    return null;
  }

  if (documents.length !== 1) {
    throw new NextShiftAuthorizationDomainError(
      "More than one temporary authorization exists for the current global slot.",
      409
    );
  }

  const document = documents[0];
  let authorization: NextShiftAuthorization;

  try {
    authorization = assertNextShiftAuthorization(
      document.data
    );
  } catch {
    throw new NextShiftAuthorizationDomainError(
      "The current-slot temporary authorization requires administrator review.",
      409
    );
  }

  if (
    authorization.id !== document.id ||
    authorization.slotToken !== control.slotToken ||
    authorization.slotGeneration !== control.generation
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The temporary authorization does not match the current global slot.",
      409
    );
  }

  if (
    authorization.permanentPairId !== permanentPairId
  ) {
    throw new NextShiftAuthorizationDomainError(
      "A temporary authorization for a different permanent pair exists for the current global slot.",
      409
    );
  }

  if (
    authorization.status !==
      NEXT_SHIFT_AUTHORIZATION_STATUSES.PENDING ||
    authorization.shiftId !== null ||
    authorization.consumedAt !== null ||
    authorization.completedAt !== null ||
    authorization.expiredAt !== null
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The current-slot temporary authorization is not pending and cannot be consumed.",
      409
    );
  }

  return authorization;
}

export function buildShiftCreationPairBinding(input: {
  control: OperationalShiftControl;
  permanentPairId: string;
  pair: unknown;
  pairMemberships: [unknown, unknown];
  authorization: NextShiftAuthorization | null;
  temporaryTechnicianEligibility?: {
    eligible: boolean;
    message: string | null;
  };
  shiftId: string;
  createdAt: string;
}): ShiftCreationPairBinding {
  const control = assertOperationalShiftControl(
    input.control
  );

  if (
    control.slotStatus !== "pending" ||
    control.shiftId !== null ||
    control.shiftStatus !== null
  ) {
    throw new NextShiftAuthorizationDomainError(
      "A shift can only be created for the current pending global slot.",
      409
    );
  }

  if (
    !isValidIdentifier(input.permanentPairId, 512) ||
    !isValidIdentifier(input.shiftId, 512) ||
    !isCanonicalTimestamp(input.createdAt)
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The shift pair-binding information is invalid.",
      409
    );
  }

  const permanentTechnicianIds =
    readActivePermanentPairTechnicianIds(
      input.pair,
      input.permanentPairId
    );

  for (const [index, membershipValue] of
    input.pairMemberships.entries()) {
    const expectedUid = permanentTechnicianIds[index];
    const membership = membershipValue as {
      technicianUid?: unknown;
      pairId?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    } | null;

    if (
      !membership ||
      membership.technicianUid !== expectedUid ||
      membership.pairId !== input.permanentPairId ||
      !isCanonicalTimestamp(membership.createdAt) ||
      !isCanonicalTimestamp(membership.updatedAt) ||
      Date.parse(membership.updatedAt) <
        Date.parse(membership.createdAt)
    ) {
      throw new NextShiftAuthorizationDomainError(
        "The selected permanent pair reservations are missing or inconsistent.",
        409
      );
    }
  }

  let consumedAuthorization:
    NextShiftAuthorization | null = null;

  if (input.authorization) {
    const authorization = assertNextShiftAuthorization(
      input.authorization
    );

    if (
      authorization.status !==
        NEXT_SHIFT_AUTHORIZATION_STATUSES.PENDING ||
      authorization.slotToken !== control.slotToken ||
      authorization.slotGeneration !== control.generation ||
      authorization.permanentPairId !== input.permanentPairId ||
      authorization.shiftId !== null ||
      authorization.consumedAt !== null ||
      authorization.completedAt !== null ||
      authorization.expiredAt !== null
    ) {
      throw new NextShiftAuthorizationDomainError(
        "The temporary authorization is stale, already consumed, or does not match this shift.",
        409
      );
    }

    if (
      permanentTechnicianIds.includes(
        authorization.authorizedTechnicianUid
      )
    ) {
      throw new NextShiftAuthorizationDomainError(
        "A permanent pair member cannot be attached as its temporary technician.",
        409
      );
    }

    if (!input.temporaryTechnicianEligibility?.eligible) {
      throw new NextShiftAuthorizationDomainError(
        input.temporaryTechnicianEligibility?.message ??
          "The temporary technician is no longer eligible for this shift.",
        409
      );
    }

    if (
      Date.parse(input.createdAt) <
      Date.parse(authorization.createdAt)
    ) {
      throw new NextShiftAuthorizationDomainError(
        "The shift creation timestamp predates its authorization.",
        409
      );
    }

    consumedAuthorization = assertNextShiftAuthorization({
      ...authorization,
      status: NEXT_SHIFT_AUTHORIZATION_STATUSES.CONSUMED,
      shiftId: input.shiftId,
      consumedAt: input.createdAt,
      completedAt: null,
      expiredAt: null,
      updatedAt: input.createdAt,
    });
  }

  return {
    permanentPairId: input.permanentPairId,
    primaryTechnicianIds: permanentTechnicianIds,
    consumedAuthorization,
  };
}

export function readActivePermanentPairTechnicianIds(
  value: unknown,
  expectedPairId: string
): [string, string] {
  const pair = value as {
    id?: unknown;
    status?: unknown;
    technicianIds?: unknown;
    createdBy?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    deactivatedAt?: unknown;
    deactivatedBy?: unknown;
  } | null;

  if (
    !pair ||
    pair.id !== expectedPairId ||
    pair.status !== "active" ||
    pair.deactivatedAt !== null ||
    pair.deactivatedBy !== null ||
    !isValidIdentifier(pair.createdBy, 128) ||
    !isCanonicalTimestamp(pair.createdAt) ||
    !isCanonicalTimestamp(pair.updatedAt) ||
    Date.parse(pair.updatedAt) < Date.parse(pair.createdAt) ||
    !Array.isArray(pair.technicianIds) ||
    pair.technicianIds.length !== 2 ||
    !pair.technicianIds.every(
      (uid) => isValidIdentifier(uid, 128)
    ) ||
    pair.technicianIds[0] === pair.technicianIds[1]
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The selected permanent technician pair is inactive, corrupt, or requires administrator review.",
      409
    );
  }

  return [
    pair.technicianIds[0],
    pair.technicianIds[1],
  ];
}

export function assertTemporaryTechnicianCanStartShift(input: {
  requiredShiftStatus?: "scheduled" | "active";
  actorUid: string;
  actorProfile: unknown;
  technicianEligibility: {
    eligible: boolean;
    message: string | null;
  };
  shift: unknown;
  control: unknown;
  permanentPair: unknown;
  pairMemberships: [unknown, unknown];
  authorizationDocumentId: string;
  authorization: unknown;
}): NextShiftAuthorization {
  if (!isValidIdentifier(input.actorUid, 128)) {
    throw new NextShiftAuthorizationDomainError(
      "The acting technician is invalid.",
      403
    );
  }

  const actor = input.actorProfile as {
    role?: unknown;
    status?: unknown;
    statusOperation?: unknown;
    mustChangePassword?: unknown;
  } | null;

  if (
    !actor ||
    actor.role !== "technician" ||
    actor.status !== "active" ||
    actor.statusOperation != null ||
    actor.mustChangePassword === true ||
    !input.technicianEligibility.eligible
  ) {
    throw new NextShiftAuthorizationDomainError(
      input.technicianEligibility.message ??
        "The technician is not eligible to start this shift.",
      403
    );
  }

  const shift = input.shift as {
    id?: unknown;
    status?: unknown;
    permanentPairId?: unknown;
    operationalSlotToken?: unknown;
    primaryTechnicianIds?: unknown;
  } | null;
  const requiredShiftStatus =
    input.requiredShiftStatus ?? "scheduled";

  if (
    !shift ||
    !isValidIdentifier(shift.id, 512) ||
    shift.status !== requiredShiftStatus ||
    !isValidIdentifier(shift.permanentPairId, 512) ||
    !isValidUuid(shift.operationalSlotToken) ||
    !Array.isArray(shift.primaryTechnicianIds) ||
    shift.primaryTechnicianIds.length !== 2 ||
    !shift.primaryTechnicianIds.every(
      (uid) => isValidIdentifier(uid, 128)
    ) ||
    shift.primaryTechnicianIds[0] ===
      shift.primaryTechnicianIds[1]
  ) {
    throw new NextShiftAuthorizationDomainError(
      `The ${requiredShiftStatus} shift pair or slot identity requires administrator review.`,
      409
    );
  }

  let control: OperationalShiftControl;

  try {
    control = assertOperationalShiftControl(
      input.control
    );
    assertShiftOwnsOperationalSlot(
      control,
      shift.id,
      shift.operationalSlotToken,
      shift.status
    );
  } catch {
    throw new NextShiftAuthorizationDomainError(
      `The ${requiredShiftStatus} shift is not the current occupant of the global operational slot.`,
      409
    );
  }

  if (
    control.shiftStatus !== requiredShiftStatus ||
    control.slotToken !== shift.operationalSlotToken
  ) {
    throw new NextShiftAuthorizationDomainError(
      `The global operational slot does not match the ${requiredShiftStatus} shift.`,
      409
    );
  }

  const pairTechnicianIds =
    readActivePermanentPairTechnicianIds(
      input.permanentPair,
      shift.permanentPairId
    );

  if (
    pairTechnicianIds[0] !== shift.primaryTechnicianIds[0] ||
    pairTechnicianIds[1] !== shift.primaryTechnicianIds[1]
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The shift's primary technicians do not match its permanent pair.",
      409
    );
  }

  for (const [index, membershipValue] of
    input.pairMemberships.entries()) {
    const membership = membershipValue as {
      technicianUid?: unknown;
      pairId?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    } | null;

    if (
      !membership ||
      membership.technicianUid !== pairTechnicianIds[index] ||
      membership.pairId !== shift.permanentPairId ||
      !isCanonicalTimestamp(membership.createdAt) ||
      !isCanonicalTimestamp(membership.updatedAt) ||
      Date.parse(membership.updatedAt) <
        Date.parse(membership.createdAt)
    ) {
      throw new NextShiftAuthorizationDomainError(
        "The permanent pair reservations are missing or inconsistent.",
        409
      );
    }
  }

  let authorization: NextShiftAuthorization;

  try {
    authorization = assertNextShiftAuthorization(
      input.authorization
    );
  } catch {
    throw new NextShiftAuthorizationDomainError(
      "The temporary start authorization is malformed or unavailable.",
      409
    );
  }

  if (
    authorization.id !== input.authorizationDocumentId ||
    authorization.status !==
      NEXT_SHIFT_AUTHORIZATION_STATUSES.CONSUMED ||
    authorization.shiftId !== shift.id ||
    authorization.slotToken !== shift.operationalSlotToken ||
    authorization.slotGeneration !== control.generation ||
    authorization.permanentPairId !== shift.permanentPairId ||
    authorization.authorizedTechnicianUid !== input.actorUid ||
    !isCanonicalTimestamp(authorization.consumedAt) ||
    authorization.completedAt !== null ||
    authorization.expiredAt !== null ||
    pairTechnicianIds.includes(input.actorUid)
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The temporary authorization does not permit this technician to start this exact shift.",
      403
    );
  }

  return authorization;
}

export function buildPendingNextShiftAuthorization(input: {
  control: OperationalShiftControl;
  pair: unknown;
  permanentPairId: string;
  authorizedTechnicianUid: string;
  technicianEligibility: {
    eligible: boolean;
    message: string | null;
  };
  createdBy: string;
  createdAt: string;
}): NextShiftAuthorization {
  let control: OperationalShiftControl;

  try {
    control = assertOperationalShiftControl(
      input.control
    );
  } catch {
    throw new NextShiftAuthorizationDomainError(
      "The global operational shift-control record requires administrator review.",
      409
    );
  }

  if (
    control.slotStatus !== "pending" ||
    control.shiftId !== null ||
    control.shiftStatus !== null
  ) {
    throw new NextShiftAuthorizationDomainError(
      "Temporary authorizations can only be created for the current pending global shift slot.",
      409
    );
  }

  if (!isValidIdentifier(input.createdBy, 128)) {
    throw new NextShiftAuthorizationDomainError(
      "The acting user is invalid.",
      400
    );
  }

  if (!isValidIdentifier(input.permanentPairId, 512)) {
    throw new NextShiftAuthorizationDomainError(
      "Please provide a valid permanent pair identifier.",
      400
    );
  }

  if (!isValidIdentifier(input.authorizedTechnicianUid, 128)) {
    throw new NextShiftAuthorizationDomainError(
      "Please select a valid technician.",
      400
    );
  }

  if (!input.technicianEligibility.eligible) {
    throw new NextShiftAuthorizationDomainError(
      input.technicianEligibility.message ??
        "The selected technician is not eligible for temporary authorization.",
      409
    );
  }

  const pair = input.pair as {
    id?: unknown;
    status?: unknown;
    technicianIds?: unknown;
  } | null;

  if (
    !pair ||
    !isValidIdentifier(pair.id, 512) ||
    pair.id !== input.permanentPairId ||
    pair.status !== "active" ||
    !Array.isArray(pair.technicianIds) ||
    pair.technicianIds.length !== 2 ||
    !pair.technicianIds.every(
      (uid) => isValidIdentifier(uid, 128)
    ) ||
    pair.technicianIds[0] === pair.technicianIds[1]
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The selected permanent technician pair is unavailable or requires administrator review.",
      409
    );
  }

  if (
    pair.technicianIds.includes(
      input.authorizedTechnicianUid
    )
  ) {
    throw new NextShiftAuthorizationDomainError(
      "A permanent pair member cannot be authorized as its temporary technician.",
      409
    );
  }

  if (!isCanonicalTimestamp(input.createdAt)) {
    throw new NextShiftAuthorizationDomainError(
      "The authorization timestamp is invalid.",
      409
    );
  }

  const id = createNextShiftAuthorizationDocumentId(
    pair.id,
    control.generation,
    control.slotToken
  );

  return {
    id,
    slotToken: control.slotToken,
    slotGeneration: control.generation,
    permanentPairId: pair.id,
    authorizedTechnicianUid:
      input.authorizedTechnicianUid,
    status: "pending",
    shiftId: null,
    consumedAt: null,
    completedAt: null,
    expiredAt: null,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    updatedAt: input.createdAt,
  };
}

export function buildNextShiftAuthorizationAuditData(
  authorization: NextShiftAuthorization,
  actorUid: string,
  auditId: string,
  createdAt: unknown
): Record<string, unknown> {
  if (
    !isValidIdentifier(actorUid, 128) ||
    !isValidIdentifier(auditId, 128)
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The authorization audit identity is invalid.",
      409
    );
  }

  return {
    id: auditId,
    action: "NEXT_SHIFT_AUTHORIZATION_CREATED",
    actorUid,
    targetAuthorizationId: authorization.id,
    permanentPairId: authorization.permanentPairId,
    authorizedTechnicianUid:
      authorization.authorizedTechnicianUid,
    slotToken: authorization.slotToken,
    slotGeneration: authorization.slotGeneration,
    details:
      "An authorized manager created a temporary technician authorization for the current global next-shift slot.",
    createdAt,
  };
}

export function buildNextShiftAuthorizationConsumedAuditData(
  authorization: NextShiftAuthorization,
  actorUid: string,
  shiftId: string,
  slotToken: string,
  slotGeneration: number,
  auditId: string,
  createdAt: unknown
): Record<string, unknown> {
  const normalizedAuthorization =
    assertNextShiftAuthorization(authorization);

  if (
    normalizedAuthorization.status !==
      NEXT_SHIFT_AUTHORIZATION_STATUSES.CONSUMED ||
    normalizedAuthorization.shiftId !== shiftId ||
    normalizedAuthorization.slotToken !== slotToken ||
    normalizedAuthorization.slotGeneration !==
      slotGeneration ||
    !isValidIdentifier(actorUid, 128) ||
    !isValidIdentifier(auditId, 128)
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The authorization consumption audit data is inconsistent.",
      409
    );
  }

  return {
    id: auditId,
    action: "NEXT_SHIFT_AUTHORIZATION_CONSUMED",
    actorUid,
    targetAuthorizationId:
      normalizedAuthorization.id,
    targetShiftId: shiftId,
    permanentPairId:
      normalizedAuthorization.permanentPairId,
    authorizedTechnicianUid:
      normalizedAuthorization.authorizedTechnicianUid,
    slotToken,
    slotGeneration,
    details:
      "A temporary technician authorization was atomically bound to its scheduled shift.",
    createdAt,
  };
}

export function completeConsumedNextShiftAuthorization(input: {
  authorization: unknown;
  shiftId: string;
  slotToken: string;
  slotGeneration: number;
  permanentPairId: string;
  completedAt: string;
}): NextShiftAuthorization {
  let authorization: NextShiftAuthorization;

  try {
    authorization =
      assertNextShiftAuthorization(
        input.authorization
      );
  } catch {
    throw new NextShiftAuthorizationDomainError(
      "The temporary authorization cannot be completed because its lifecycle state is invalid.",
      409
    );
  }

  if (
    !isValidIdentifier(input.shiftId, 512) ||
    !isValidUuid(input.slotToken) ||
    !Number.isSafeInteger(
      input.slotGeneration
    ) ||
    input.slotGeneration < 1 ||
    !isValidIdentifier(
      input.permanentPairId,
      512
    ) ||
    !isCanonicalTimestamp(
      input.completedAt
    )
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The authorization completion context is invalid.",
      409
    );
  }

  if (
    authorization.status !==
      NEXT_SHIFT_AUTHORIZATION_STATUSES.CONSUMED ||
    authorization.shiftId !==
      input.shiftId ||
    authorization.slotToken !==
      input.slotToken ||
    authorization.slotGeneration !==
      input.slotGeneration ||
    authorization.permanentPairId !==
      input.permanentPairId ||
    !isCanonicalTimestamp(
      authorization.consumedAt
    ) ||
    authorization.completedAt !== null ||
    authorization.expiredAt !== null
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The temporary authorization does not match the shift being completed.",
      409
    );
  }

  const completedAt =
    Date.parse(input.completedAt);

  const consumedAt =
    Date.parse(authorization.consumedAt);

  const updatedAt =
    Date.parse(authorization.updatedAt);

  if (
    completedAt < consumedAt ||
    completedAt < updatedAt
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The authorization completion timestamp is inconsistent with its lifecycle.",
      409
    );
  }

  const completedAuthorization:
    NextShiftAuthorization = {
      ...authorization,
      status:
        NEXT_SHIFT_AUTHORIZATION_STATUSES.COMPLETED,
      completedAt: input.completedAt,
      expiredAt: null,
      updatedAt: input.completedAt,
    };

  try {
    return assertNextShiftAuthorization(
      completedAuthorization
    );
  } catch {
    throw new NextShiftAuthorizationDomainError(
      "The completed temporary authorization is invalid.",
      409
    );
  }
}

export function expireConsumedNextShiftAuthorization(input: {
  authorization: unknown;
  shiftId: string;
  slotToken: string;
  slotGeneration: number;
  permanentPairId: string;
  expiredAt: string;
}): NextShiftAuthorization {
  let authorization: NextShiftAuthorization;

  try {
    authorization =
      assertNextShiftAuthorization(
        input.authorization
      );
  } catch {
    throw new NextShiftAuthorizationDomainError(
      "The temporary authorization cannot be expired because its lifecycle state is invalid.",
      409
    );
  }

  if (
    !isValidIdentifier(input.shiftId, 512) ||
    !isValidUuid(input.slotToken) ||
    !Number.isSafeInteger(
      input.slotGeneration
    ) ||
    input.slotGeneration < 1 ||
    !isValidIdentifier(
      input.permanentPairId,
      512
    ) ||
    !isCanonicalTimestamp(
      input.expiredAt
    )
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The authorization expiry context is invalid.",
      409
    );
  }

  if (
    authorization.status !==
      NEXT_SHIFT_AUTHORIZATION_STATUSES.CONSUMED ||
    authorization.shiftId !==
      input.shiftId ||
    authorization.slotToken !==
      input.slotToken ||
    authorization.slotGeneration !==
      input.slotGeneration ||
    authorization.permanentPairId !==
      input.permanentPairId ||
    !isCanonicalTimestamp(
      authorization.consumedAt
    ) ||
    authorization.completedAt !== null ||
    authorization.expiredAt !== null
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The temporary authorization does not match the expired scheduled shift.",
      409
    );
  }

  const expiredAt =
    Date.parse(input.expiredAt);

  const consumedAt =
    Date.parse(authorization.consumedAt);

  const updatedAt =
    Date.parse(authorization.updatedAt);

  if (
    expiredAt < consumedAt ||
    expiredAt < updatedAt
  ) {
    throw new NextShiftAuthorizationDomainError(
      "The authorization expiry timestamp is inconsistent with its lifecycle.",
      409
    );
  }

  const expiredAuthorization:
    NextShiftAuthorization = {
      ...authorization,
      status:
        NEXT_SHIFT_AUTHORIZATION_STATUSES.EXPIRED,
      completedAt: null,
      expiredAt: input.expiredAt,
      updatedAt: input.expiredAt,
    };

  try {
    return assertNextShiftAuthorization(
      expiredAuthorization
    );
  } catch {
    throw new NextShiftAuthorizationDomainError(
      "The expired temporary authorization is invalid.",
      409
    );
  }
}

export function assertNextShiftAuthorization(
  value: unknown
): NextShiftAuthorization {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new NextShiftAuthorizationDomainError(
      "A next-shift authorization record is malformed.",
      409
    );
  }

  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "id",
    "slotToken",
    "slotGeneration",
    "permanentPairId",
    "authorizedTechnicianUid",
    "status",
    "shiftId",
    "consumedAt",
    "completedAt",
    "expiredAt",
    "createdAt",
    "createdBy",
    "updatedAt",
  ];

  if (
    Object.keys(record).length !== expectedKeys.length ||
    Object.keys(record).some(
      (key) => !expectedKeys.includes(key)
    ) ||
    !isValidIdentifier(record.id, 128) ||
    !isValidUuid(record.slotToken) ||
    !Number.isSafeInteger(record.slotGeneration) ||
    (record.slotGeneration as number) < 1 ||
    !isValidIdentifier(record.permanentPairId, 512) ||
    !isValidIdentifier(record.authorizedTechnicianUid, 128) ||
    ![
      "pending",
      "consumed",
      "completed",
      "expired",
    ].includes(record.status as string) ||
    !isCanonicalTimestamp(record.createdAt) ||
    !isValidIdentifier(record.createdBy, 128) ||
    !isCanonicalTimestamp(record.updatedAt)
  ) {
    throw new NextShiftAuthorizationDomainError(
      "A next-shift authorization record is malformed.",
      409
    );
  }

  const expectedId =
    createNextShiftAuthorizationDocumentId(
      record.permanentPairId as string,
      record.slotGeneration as number,
      record.slotToken as string
    );

  if (record.id !== expectedId) {
    throw new NextShiftAuthorizationDomainError(
      "A next-shift authorization record has an inconsistent identity.",
      409
    );
  }

  const createdAt = Date.parse(record.createdAt as string);
  const updatedAt = Date.parse(record.updatedAt as string);

  if (updatedAt < createdAt) {
    throw new NextShiftAuthorizationDomainError(
      "A next-shift authorization has contradictory timestamps.",
      409
    );
  }

  if (record.status === "pending") {
    if (
      record.shiftId !== null ||
      record.consumedAt !== null ||
      record.completedAt !== null ||
      record.expiredAt !== null
    ) {
      throw new NextShiftAuthorizationDomainError(
        "A pending authorization cannot contain shift lifecycle metadata.",
        409
      );
    }
  } else if (
    record.status === "consumed" ||
    record.status === "completed"
  ) {
    if (
      !isValidIdentifier(record.shiftId, 512) ||
      !isCanonicalTimestamp(record.consumedAt) ||
      Date.parse(record.consumedAt as string) < createdAt ||
      updatedAt < Date.parse(record.consumedAt as string) ||
      (record.status === "consumed" &&
        (record.completedAt !== null || record.expiredAt !== null)) ||
      (record.status === "completed" &&
        (!isCanonicalTimestamp(record.completedAt) ||
          record.expiredAt !== null ||
          Date.parse(record.completedAt as string) <
            Date.parse(record.consumedAt as string) ||
          updatedAt < Date.parse(record.completedAt as string)))
    ) {
      throw new NextShiftAuthorizationDomainError(
        "The authorization lifecycle metadata is contradictory.",
        409
      );
    }
  } else if (record.status === "expired") {
    const hasShift = record.shiftId !== null;
    const hasConsumption = record.consumedAt !== null;

    if (
      !isCanonicalTimestamp(record.expiredAt) ||
      hasShift !== hasConsumption ||
      (hasShift && !isValidIdentifier(record.shiftId, 512)) ||
      (hasConsumption &&
        (!isCanonicalTimestamp(record.consumedAt) ||
          Date.parse(record.consumedAt as string) < createdAt)) ||
      Date.parse(record.expiredAt as string) <
        (hasConsumption
          ? Date.parse(record.consumedAt as string)
          : createdAt) ||
      updatedAt < Date.parse(record.expiredAt as string) ||
      record.completedAt !== null
    ) {
      throw new NextShiftAuthorizationDomainError(
        "The expired authorization metadata is invalid.",
        409
      );
    }
  }

  return record as unknown as NextShiftAuthorization;
}

function isValidIdentifier(
  value: unknown,
  maxLength: number
): value is string {
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

function isValidUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const timestamp = Date.parse(value);

  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
}