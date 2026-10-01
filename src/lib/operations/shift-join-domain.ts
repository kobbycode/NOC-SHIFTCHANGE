import {
  assertOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
  type OperationalShiftControl,
} from "./operational-shift-control-state";

import {

  assertTemporaryTechnicianCanStartShift,

  readActivePermanentPairTechnicianIds,
} from "./next-shift-authorization-domain";

import {
  ATTENDANCE_PARTICIPATION_AUTHORITIES,
  ATTENDANCE_STATUSES,
  type Attendance,
  type AttendanceParticipationAuthority,
} from "@/types/attendance";

import type {
  NextShiftAuthorization,
} from "@/types/next-shift-authorization";

export class ShiftJoinDomainError extends Error {
  public readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
    this.name = "ShiftJoinDomainError";
  }
}

export interface ActiveShiftJoinContext {
  actorUid: string;
  actorProfile: unknown;
  actorEligibility: {
    eligible: boolean;
    message: string | null;
  };
  shift: unknown;
  control: unknown;
  permanentPair: unknown;
  pairMemberships: [unknown, unknown];
}

export interface ActiveShiftJoinIdentity {
  shiftId: string;
  actualStart: string;
  permanentPairId: string;
  operationalSlotToken: string;
  slotGeneration: number;
  primaryTechnicianIds: [string, string];
  pairTechnicianIds: [string, string];
  control: OperationalShiftControl;
}

export function validateActiveShiftJoinContext(
  input: ActiveShiftJoinContext
): ActiveShiftJoinIdentity {
  const actorProfile = input.actorProfile as {
    role?: unknown;
    status?: unknown;
    statusOperation?: unknown;
    mustChangePassword?: unknown;
  } | null;

  if (
    !isValidIdentifier(input.actorUid, 128) ||
    !actorProfile ||
    actorProfile.role !== "technician" ||
    actorProfile.status !== "active" ||
    actorProfile.statusOperation != null ||
    actorProfile.mustChangePassword === true ||
    !input.actorEligibility.eligible
  ) {
    throw new ShiftJoinDomainError(
      input.actorEligibility.message ??
        "An active eligible technician account is required to join a shift.",
      403
    );
  }

  const shift = input.shift as {
    id?: unknown;
    status?: unknown;
    permanentPairId?: unknown;
    operationalSlotToken?: unknown;
    primaryTechnicianIds?: unknown;
    actualStart?: unknown;
    actualEnd?: unknown;
  } | null;

  if (
    !shift ||
    !isValidIdentifier(shift.id, 512) ||
    shift.status !== "active" ||
    !isValidIdentifier(shift.permanentPairId, 512) ||
    !isValidUuid(shift.operationalSlotToken) ||
    !isCanonicalTimestamp(shift.actualStart) ||
    shift.actualEnd !== null ||
    !Array.isArray(shift.primaryTechnicianIds) ||
    shift.primaryTechnicianIds.length !== 2 ||
    !shift.primaryTechnicianIds.every(
      (uid) => isValidIdentifier(uid, 128)
    ) ||
    shift.primaryTechnicianIds[0] === shift.primaryTechnicianIds[1]
  ) {
    throw new ShiftJoinDomainError(
      "Only a structurally valid active shift can be joined.",
      409
    );
  }

  let control: OperationalShiftControl;

  try {
    control = assertOperationalShiftControl(input.control);
    assertShiftOwnsOperationalSlot(
      control,
      shift.id,
      shift.operationalSlotToken,
      shift.status
    );
  } catch {
    throw new ShiftJoinDomainError(
      "The active shift does not occupy the current global operational slot.",
      409
    );
  }

  if (
    control.slotStatus !== "consumed" ||
    control.shiftStatus !== "active" ||
    control.shiftId !== shift.id ||
    control.slotToken !== shift.operationalSlotToken
  ) {
    throw new ShiftJoinDomainError(
      "The global operational control does not match the active shift.",
      409
    );
  }

  let pairTechnicianIds: [string, string];

  try {
    pairTechnicianIds = readActivePermanentPairTechnicianIds(
      input.permanentPair,
      shift.permanentPairId
    );
  } catch {
    throw new ShiftJoinDomainError(
      "The active permanent pair requires administrator review.",
      409
    );
  }

  if (
    pairTechnicianIds[0] !== shift.primaryTechnicianIds[0] ||
    pairTechnicianIds[1] !== shift.primaryTechnicianIds[1]
  ) {
    throw new ShiftJoinDomainError(
      "The active shift primary technicians do not match its permanent pair.",
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
      Date.parse(membership.updatedAt) < Date.parse(membership.createdAt)
    ) {
      throw new ShiftJoinDomainError(
        "The active pair reservations are missing or inconsistent.",
        409
      );
    }
  }

  return {
    shiftId: shift.id,
    actualStart: shift.actualStart,
    permanentPairId: shift.permanentPairId,
    operationalSlotToken: shift.operationalSlotToken,
    slotGeneration: control.generation,
    primaryTechnicianIds: [
      shift.primaryTechnicianIds[0],
      shift.primaryTechnicianIds[1],
    ],
    pairTechnicianIds,
    control,
  };
}

export function assertPrimaryTechnicianCanJoinShift(input: {
  identity: ActiveShiftJoinIdentity;
  actorUid: string;
  memberDocumentId: string;
  member: unknown;
  schedule: unknown;
}): void {
  if (!input.identity.primaryTechnicianIds.includes(input.actorUid)) {
    throw new ShiftJoinDomainError(
      "The technician is not a primary member of this shift.",
      403
    );
  }

  const member = input.member as {
    shiftId?: unknown;
    technicianId?: unknown;
    role?: unknown;
    leftAt?: unknown;
  } | null;

  if (
    !member ||
    input.memberDocumentId !==
      `${input.identity.shiftId}_${input.actorUid}` ||
    member.shiftId !== input.identity.shiftId ||
    member.technicianId !== input.actorUid ||
    member.role !== "primary" ||
    member.leftAt !== null
  ) {
    throw new ShiftJoinDomainError(
      "A current primary shift membership is required to join.",
      409
    );
  }

  assertActiveScheduleEntry(
    input.schedule,
    input.actorUid,
    input.identity.shiftId
  );
}

export function assertTemporaryTechnicianCanJoinShift(input: {
  identity: ActiveShiftJoinIdentity;
  actorUid: string;
  actorProfile: unknown;
  actorEligibility: {
    eligible: boolean;
    message: string | null;
  };
  permanentPair: unknown;
  pairMemberships: [unknown, unknown];
  authorizationDocumentId: string;
  authorization: unknown;
  memberAlreadyExists: boolean;
}): NextShiftAuthorization {
  if (input.identity.primaryTechnicianIds.includes(input.actorUid)) {
    throw new ShiftJoinDomainError(
      "A permanent primary technician cannot use temporary join authority.",
      409
    );
  }

  if (input.memberAlreadyExists) {
    throw new ShiftJoinDomainError(
      "A shift membership already exists for this technician; administrator review is required.",
      409
    );
  }

  try {
    return assertTemporaryTechnicianCanStartShift({
      requiredShiftStatus: "active",
      actorUid: input.actorUid,
      actorProfile: input.actorProfile,
      technicianEligibility: input.actorEligibility,
      shift: {
        id: input.identity.shiftId,
        status: "active",
        permanentPairId: input.identity.permanentPairId,
        operationalSlotToken: input.identity.operationalSlotToken,
        primaryTechnicianIds: input.identity.primaryTechnicianIds,
        actualStart: input.identity.actualStart,
        actualEnd: null,
      },
      control: input.identity.control,
      permanentPair: input.permanentPair,
      pairMemberships: input.pairMemberships,
      authorizationDocumentId: input.authorizationDocumentId,
      authorization: input.authorization,
    });
  } catch {
    throw new ShiftJoinDomainError(
      "The consumed temporary authorization does not permit this technician to join this exact shift.",
      403
    );
  }
}

export function assertActiveScheduleEntry(
  value: unknown,
  technicianUid: string,
  shiftId: string
): void {
  const schedule = value as {
    technicianUid?: unknown;
    entries?: unknown;
  } | null;

  if (
    !schedule ||
    schedule.technicianUid !== technicianUid ||
    !Array.isArray(schedule.entries)
  ) {
    throw new ShiftJoinDomainError(
      "The technician has an invalid scheduling record.",
      409
    );
  }

  const entries = schedule.entries as unknown[];

  if (
    entries.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !isValidIdentifier(
          (entry as Record<string, unknown>).shiftId,
          512
        ) ||
        typeof (entry as Record<string, unknown>).scheduledStart !== "string" ||
        typeof (entry as Record<string, unknown>).scheduledEnd !== "string" ||
        !["scheduled", "active", "handover_pending"].includes(
          (entry as Record<string, unknown>).status as string
        )
    )
  ) {
    throw new ShiftJoinDomainError(
      "The technician has malformed scheduling information.",
      409
    );
  }

  const entryIds = entries.map(
    (entry) => (entry as Record<string, unknown>).shiftId
  );

  if (new Set(entryIds).size !== entryIds.length) {
    throw new ShiftJoinDomainError(
      "The technician has duplicate scheduling entries.",
      409
    );
  }

  const matches = entries.filter(
    (entry) =>
      (entry as Record<string, unknown>).shiftId === shiftId
  );

  if (
    matches.length !== 1 ||
    (matches[0] as Record<string, unknown>).status !== "active"
  ) {
    throw new ShiftJoinDomainError(
      "The technician must have one active schedule entry for this shift.",
      409
    );
  }
}

export function createShiftAttendanceRecord(input: {
  shiftId: string;
  technicianUid: string;
  participationAuthority: AttendanceParticipationAuthority;
  authorizationId: string | null;
  recordedAt: string;
}): Attendance {
  if (
    !isValidIdentifier(input.shiftId, 512) ||
    !isValidIdentifier(input.technicianUid, 128) ||
    !isCanonicalTimestamp(input.recordedAt) ||
    (input.participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY &&
      input.authorizationId !== null) ||
    (input.participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.TEMPORARY_AUTHORIZED &&
      !isValidIdentifier(input.authorizationId, 128))
  ) {
    throw new ShiftJoinDomainError(
      "The shift attendance record is invalid.",
      409
    );
  }

  return {
    id: `${input.shiftId}_${input.technicianUid}`,
    shiftId: input.shiftId,
    technicianId: input.technicianUid,
    status: ATTENDANCE_STATUSES.PRESENT,
    participationAuthority: input.participationAuthority,
    authorizationId: input.authorizationId,
    isProvisional: false,
    clockIn: null,
    clockOut: null,
    recordedAt: input.recordedAt,
    updatedAt: input.recordedAt,
  };
}

function isValidIdentifier(value: unknown, maxLength: number): value is string {
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