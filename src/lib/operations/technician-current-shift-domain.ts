import {
  assertOperationalShiftControl,
  assertShiftOwnsOperationalSlot,
  type OperationalShiftControl,
} from "./operational-shift-control-state";

import {
  assertNextShiftAuthorization,
  readActivePermanentPairTechnicianIds,
} from "./next-shift-authorization-domain";

import {
  readAttendanceRecord,
} from "./attendance-read-domain";

import type {
  Attendance,
  AttendanceParticipationAuthority,
} from "@/types/attendance";

import type {
  NextShiftAuthorization,
} from "@/types/next-shift-authorization";

import type {
  ShiftStatus,
  ShiftType,
} from "@/types/shift";

export class TechnicianCurrentShiftDomainError extends Error {
  public readonly status: number;

  constructor(
    message: string,
    status = 409,
  ) {
    super(message);

    this.status = status;
    this.name =
      "TechnicianCurrentShiftDomainError";
  }
}

export interface TechnicianCurrentShiftView {
  id: string;

  shiftType: ShiftType;
  status: Extract<
    ShiftStatus,
    | "scheduled"
    | "active"
    | "handover_pending"
  >;

  scheduledStart: string;
  scheduledEnd: string;

  actualStart: string | null;
  actualEnd: null;

  participationAuthority:
    AttendanceParticipationAuthority;

  authorizationId: string | null;

  attendance: Attendance | null;

  joinedAt: string | null;

  canStart: boolean;
  canJoin: boolean;
}

export interface ResolveTechnicianCurrentShiftInput {
  technicianUid: string;

  control: unknown;
  shift: unknown | null;

  permanentPair: unknown | null;
  pairMemberships:
    [unknown, unknown] | null;

  authorizationDocumentId:
    string | null;
  authorization: unknown | null;

  attendanceDocumentId:
    string | null;
  attendance: unknown | null;
}

interface CurrentShiftRecord {
  id: string;

  operationalSlotToken: string;
  permanentPairId: string;

  shiftType: ShiftType;

  status:
    | "scheduled"
    | "active"
    | "handover_pending";

  scheduledStart: string;
  scheduledEnd: string;

  actualStart: string | null;
  actualEnd: null;

  primaryTechnicianIds:
    [string, string];

  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function resolveTechnicianCurrentShift(
  input: ResolveTechnicianCurrentShiftInput,
): TechnicianCurrentShiftView | null {
  if (
    !isValidIdentifier(
      input.technicianUid,
      128,
    )
  ) {
    throw new TechnicianCurrentShiftDomainError(
      "The acting technician identity is invalid.",
      403,
    );
  }

  let control:
    OperationalShiftControl;

  try {
    control =
      assertOperationalShiftControl(
        input.control,
      );
  } catch {
    throw new TechnicianCurrentShiftDomainError(
      "The global operational shift-control record requires administrator review.",
    );
  }

  if (
    control.slotStatus === "pending"
  ) {
    if (
      input.shift !== null ||
      input.permanentPair !== null ||
      input.pairMemberships !== null ||
      input.authorizationDocumentId !==
        null ||
      input.authorization !== null ||
      input.attendanceDocumentId !==
        null ||
      input.attendance !== null
    ) {
      throw new TechnicianCurrentShiftDomainError(
        "A pending operational slot cannot expose a current technician shift.",
      );
    }

    return null;
  }

  if (input.shift === null) {
    throw new TechnicianCurrentShiftDomainError(
      "The current operational shift is unavailable.",
    );
  }

  const shift =
    readCurrentShift(
      input.shift,
    );

  try {
    assertShiftOwnsOperationalSlot(
      control,
      shift.id,
      shift.operationalSlotToken,
      shift.status,
    );
  } catch {
    throw new TechnicianCurrentShiftDomainError(
      "The current shift does not match the global operational slot.",
    );
  }

  if (
    input.permanentPair === null ||
    input.pairMemberships === null
  ) {
    throw new TechnicianCurrentShiftDomainError(
      "The current shift permanent-pair context is unavailable.",
    );
  }

  let pairTechnicianIds:
    [string, string];

  try {
    pairTechnicianIds =
      readActivePermanentPairTechnicianIds(
        input.permanentPair,
        shift.permanentPairId,
      );
  } catch {
    throw new TechnicianCurrentShiftDomainError(
      "The current shift permanent pair requires administrator review.",
    );
  }

  if (
    pairTechnicianIds[0] !==
      shift.primaryTechnicianIds[0] ||
    pairTechnicianIds[1] !==
      shift.primaryTechnicianIds[1]
  ) {
    throw new TechnicianCurrentShiftDomainError(
      "The current shift primary technicians do not match its permanent pair.",
    );
  }

  validatePairMemberships(
    shift.permanentPairId,
    pairTechnicianIds,
    input.pairMemberships,
  );

  const hasAuthorizationDocument =
    input.authorizationDocumentId !==
    null;

  const hasAuthorization =
    input.authorization !== null;

  if (
    hasAuthorizationDocument !==
    hasAuthorization
  ) {
    throw new TechnicianCurrentShiftDomainError(
      "The current shift temporary authorization context is incomplete.",
    );
  }

  let authorization:
    NextShiftAuthorization | null =
      null;

  if (
    input.authorizationDocumentId !==
      null &&
    input.authorization !== null
  ) {
    try {
      authorization =
        assertNextShiftAuthorization(
          input.authorization,
        );
    } catch {
      throw new TechnicianCurrentShiftDomainError(
        "The current shift temporary authorization requires administrator review.",
      );
    }

    if (
      authorization.id !==
        input.authorizationDocumentId ||
      authorization.status !==
        "consumed" ||
      authorization.shiftId !==
        shift.id ||
      authorization.slotToken !==
        shift.operationalSlotToken ||
      authorization.slotGeneration !==
        control.generation ||
      authorization.permanentPairId !==
        shift.permanentPairId ||
      authorization.completedAt !==
        null ||
      authorization.expiredAt !==
        null
    ) {
      throw new TechnicianCurrentShiftDomainError(
        "The current shift temporary authorization does not match the operational slot.",
      );
    }
  }

  const isPrimary =
    shift.primaryTechnicianIds.includes(
      input.technicianUid,
    );

  const isTemporaryAuthorized =
    authorization !== null &&
    authorization
      .authorizedTechnicianUid ===
      input.technicianUid;

  if (
    !isPrimary &&
    !isTemporaryAuthorized
  ) {
    if (
      input.attendanceDocumentId !==
        null ||
      input.attendance !== null
    ) {
      throw new TechnicianCurrentShiftDomainError(
        "Attendance exists for a technician who is not authorized for the current shift.",
      );
    }

    return null;
  }

  if (
    isPrimary &&
    isTemporaryAuthorized
  ) {
    throw new TechnicianCurrentShiftDomainError(
      "A primary technician cannot also hold temporary authority for the same shift.",
    );
  }

  const participationAuthority:
    AttendanceParticipationAuthority =
      isPrimary
        ? "primary"
        : "temporary_authorized";

  const authorizationId =
    isPrimary
      ? null
      : authorization!.id;

  const hasAttendanceDocument =
    input.attendanceDocumentId !==
    null;

  const hasAttendance =
    input.attendance !== null;

  if (
    hasAttendanceDocument !==
    hasAttendance
  ) {
    throw new TechnicianCurrentShiftDomainError(
      "The current shift attendance context is incomplete.",
    );
  }

  let attendance:
    Attendance | null = null;

  if (
    input.attendanceDocumentId !==
      null &&
    input.attendance !== null
  ) {
    try {
      attendance =
        readAttendanceRecord(
          input.attendanceDocumentId,
          input.attendance,
        );
    } catch {
      throw new TechnicianCurrentShiftDomainError(
        "The technician attendance record requires administrator review.",
      );
    }

    if (
      attendance.shiftId !==
        shift.id ||
      attendance.technicianId !==
        input.technicianUid ||
      attendance.participationAuthority !==
        participationAuthority ||
      attendance.authorizationId !==
        authorizationId
    ) {
      throw new TechnicianCurrentShiftDomainError(
        "The technician attendance record does not match current shift authority.",
      );
    }

    if (
      shift.status === "scheduled"
    ) {
      throw new TechnicianCurrentShiftDomainError(
        "A scheduled shift cannot already contain technician attendance.",
      );
    }
  }

  return {
    id: shift.id,

    shiftType:
      shift.shiftType,

    status:
      shift.status,

    scheduledStart:
      shift.scheduledStart,

    scheduledEnd:
      shift.scheduledEnd,

    actualStart:
      shift.actualStart,

    actualEnd: null,

    participationAuthority,

    authorizationId,

    attendance,

    joinedAt:
      attendance?.recordedAt ??
      null,

    canStart:
      shift.status ===
        "scheduled" &&
      participationAuthority ===
        "temporary_authorized",

    canJoin:
      shift.status === "active" &&
      attendance === null,
  };
}

function readCurrentShift(
  value: unknown,
): CurrentShiftRecord {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TechnicianCurrentShiftDomainError(
      "The current operational shift is malformed.",
    );
  }

  const data =
    value as Record<
      string,
      unknown
    >;

  if (
    !isValidIdentifier(
      data.id,
      512,
    ) ||
    !isUuid(
      data.operationalSlotToken,
    ) ||
    !isValidIdentifier(
      data.permanentPairId,
      512,
    ) ||
    (
      data.shiftType !==
        "morning" &&
      data.shiftType !==
        "night"
    ) ||
    ![
      "scheduled",
      "active",
      "handover_pending",
    ].includes(
      data.status as string,
    ) ||
    !isCanonicalTimestamp(
      data.scheduledStart,
    ) ||
    !isCanonicalTimestamp(
      data.scheduledEnd,
    ) ||
    Date.parse(
      data.scheduledEnd as string,
    ) <=
      Date.parse(
        data.scheduledStart as string,
      ) ||
    !Array.isArray(
      data.primaryTechnicianIds,
    ) ||
    data.primaryTechnicianIds
      .length !== 2 ||
    !data.primaryTechnicianIds
      .every(
        (uid) =>
          isValidIdentifier(
            uid,
            128,
          ),
      ) ||
    data.primaryTechnicianIds[0] ===
      data.primaryTechnicianIds[1] ||
    !isValidIdentifier(
      data.createdBy,
      128,
    ) ||
    !isCanonicalTimestamp(
      data.createdAt,
    ) ||
    !isCanonicalTimestamp(
      data.updatedAt,
    ) ||
    Date.parse(
      data.updatedAt as string,
    ) <
      Date.parse(
        data.createdAt as string,
      )
  ) {
    throw new TechnicianCurrentShiftDomainError(
      "The current operational shift is malformed.",
    );
  }

  if (
    data.status === "scheduled"
  ) {
    if (
      data.actualStart !== null ||
      data.actualEnd !== null
    ) {
      throw new TechnicianCurrentShiftDomainError(
        "The scheduled shift has inconsistent lifecycle timestamps.",
      );
    }
  } else if (
    !isCanonicalTimestamp(
      data.actualStart,
    ) ||
    data.actualEnd !== null
  ) {
    throw new TechnicianCurrentShiftDomainError(
      "The current shift has inconsistent lifecycle timestamps.",
    );
  }

  return {
    id: data.id as string,

    operationalSlotToken:
      data.operationalSlotToken as string,

    permanentPairId:
      data.permanentPairId as string,

    shiftType:
      data.shiftType as ShiftType,

    status:
      data.status as
        | "scheduled"
        | "active"
        | "handover_pending",

    scheduledStart:
      data.scheduledStart as string,

    scheduledEnd:
      data.scheduledEnd as string,

    actualStart:
      data.actualStart as
        | string
        | null,

    actualEnd: null,

    primaryTechnicianIds: [
      data
        .primaryTechnicianIds[0] as string,
      data
        .primaryTechnicianIds[1] as string,
    ],

    createdBy:
      data.createdBy as string,

    createdAt:
      data.createdAt as string,

    updatedAt:
      data.updatedAt as string,
  };
}

function validatePairMemberships(
  pairId: string,
  technicianIds:
    [string, string],
  memberships:
    [unknown, unknown],
): void {
  for (
    const [
      index,
      membershipValue,
    ] of memberships.entries()
  ) {
    const membership =
      membershipValue as {
        technicianUid?: unknown;
        pairId?: unknown;
        createdAt?: unknown;
        updatedAt?: unknown;
      } | null;

    if (
      !membership ||
      membership.technicianUid !==
        technicianIds[index] ||
      membership.pairId !==
        pairId ||
      !isCanonicalTimestamp(
        membership.createdAt,
      ) ||
      !isCanonicalTimestamp(
        membership.updatedAt,
      ) ||
      Date.parse(
        membership.updatedAt as string,
      ) <
        Date.parse(
          membership.createdAt as string,
        )
    ) {
      throw new TechnicianCurrentShiftDomainError(
        "The current shift permanent-pair reservations are missing or inconsistent.",
      );
    }
  }
}

function isValidIdentifier(
  value: unknown,
  maxLength: number,
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

function isCanonicalTimestamp(
  value: unknown,
): value is string {
  if (
    typeof value !== "string"
  ) {
    return false;
  }

  const timestamp =
    Date.parse(value);

  return (
    Number.isFinite(timestamp) &&
    new Date(
      timestamp,
    ).toISOString() ===
      value
  );
}

function isUuid(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
