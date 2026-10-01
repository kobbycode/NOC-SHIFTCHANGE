import {
  ATTENDANCE_PARTICIPATION_AUTHORITIES,
  ATTENDANCE_STATUSES,
  type Attendance,
} from "@/types/attendance";

import {
  SHIFT_MEMBER_ROLES,
  type ShiftMember,
} from "@/types/shift";

import {
  NEXT_SHIFT_AUTHORIZATION_STATUSES,
  type NextShiftAuthorization,
} from "@/types/next-shift-authorization";

import {
  assertNextShiftAuthorization,
} from "./next-shift-authorization-domain";

export class ShiftCompletionDomainError extends Error {
  public readonly status: number;

  constructor(
    message: string,
    status = 409
  ) {
    super(message);
    this.status = status;
    this.name = "ShiftCompletionDomainError";
  }
}

export interface ValidateShiftCompletionAttendanceInput {
  shiftId: string;
  primaryTechnicianIds: readonly string[];
  completedAt: string;
  members: readonly unknown[];
  attendances: readonly unknown[];
  authorization: unknown | null;
}

export interface ShiftCompletionAttendanceValidation {
  members: ShiftMember[];
  attendances: Attendance[];
  authorization: NextShiftAuthorization | null;
}

export function finalizeCurrentShiftMemberships(input: {
  shiftId: string;
  completedAt: string;
  members: readonly unknown[];
}): ShiftMember[] {
  if (
    !isValidIdentifier(input.shiftId, 512) ||
    !isCanonicalTimestamp(input.completedAt)
  ) {
    throw new ShiftCompletionDomainError(
      "The shift membership completion context is invalid."
    );
  }

  const members =
    validateCurrentShiftMembers(
      input.shiftId,
      input.members
    );

  const completedAt =
    Date.parse(input.completedAt);

  return members.map((member) => {
    if (
      completedAt <
      Date.parse(member.joinedAt)
    ) {
      throw new ShiftCompletionDomainError(
        "A shift membership cannot end before it began."
      );
    }

    return {
      ...member,
      leftAt: input.completedAt,
    };
  });
}

export function validateShiftCompletionAttendance(
  input: ValidateShiftCompletionAttendanceInput
): ShiftCompletionAttendanceValidation {
  if (
    !isValidIdentifier(input.shiftId, 512) ||
    !isCanonicalTimestamp(input.completedAt)
  ) {
    throw new ShiftCompletionDomainError(
      "The shift attendance completion context is invalid."
    );
  }

  const primaryTechnicianIds =
    validatePrimaryTechnicianIds(
      input.primaryTechnicianIds
    );

  const members =
    validateCurrentShiftMembers(
      input.shiftId,
      input.members
    );

  const memberByTechnicianId =
    new Map(
      members.map(
        (member) => [
          member.technicianId,
          member,
        ] as const
      )
    );

  for (const primaryTechnicianId of
    primaryTechnicianIds) {
    const member =
      memberByTechnicianId.get(
        primaryTechnicianId
      );

    if (
      !member ||
      member.role !==
        SHIFT_MEMBER_ROLES.PRIMARY
    ) {
      throw new ShiftCompletionDomainError(
        "The shift's primary technician memberships are inconsistent."
      );
    }
  }

  const primaryMembers =
    members.filter(
      (member) =>
        member.role ===
        SHIFT_MEMBER_ROLES.PRIMARY
    );

  if (
    primaryMembers.length !== 2 ||
    primaryMembers.some(
      (member) =>
        !primaryTechnicianIds.includes(
          member.technicianId
        )
    )
  ) {
    throw new ShiftCompletionDomainError(
      "The shift's primary technician memberships are inconsistent."
    );
  }

  let authorization:
    NextShiftAuthorization | null = null;

  if (input.authorization !== null) {
    try {
      authorization =
        assertNextShiftAuthorization(
          input.authorization
        );
    } catch {
      throw new ShiftCompletionDomainError(
        "The shift's temporary authorization is malformed."
      );
    }

    if (
      authorization.status !==
        NEXT_SHIFT_AUTHORIZATION_STATUSES.CONSUMED ||
      authorization.shiftId !==
        input.shiftId ||
      authorization.completedAt !== null ||
      authorization.expiredAt !== null ||
      primaryTechnicianIds.includes(
        authorization.authorizedTechnicianUid
      )
    ) {
      throw new ShiftCompletionDomainError(
        "The shift's temporary authorization is inconsistent with completion."
      );
    }
  }

  const attendanceByTechnicianId =
    new Map<string, Attendance>();

  const completedAt =
    Date.parse(input.completedAt);

  for (const value of input.attendances) {
    const attendance =
      validateAttendanceRecord(
        input.shiftId,
        value
      );

    if (
      attendanceByTechnicianId.has(
        attendance.technicianId
      )
    ) {
      throw new ShiftCompletionDomainError(
        "The shift contains duplicate attendance records."
      );
    }

    const member =
      memberByTechnicianId.get(
        attendance.technicianId
      );

    if (!member) {
      throw new ShiftCompletionDomainError(
        "Attendance exists for a technician who is not a current shift member."
      );
    }

    if (
      Date.parse(attendance.recordedAt) >
      completedAt
    ) {
      throw new ShiftCompletionDomainError(
        "Attendance cannot be recorded after shift completion."
      );
    }

    if (
      Date.parse(attendance.recordedAt) <
      Date.parse(member.joinedAt)
    ) {
      throw new ShiftCompletionDomainError(
        "Attendance cannot precede the technician's shift membership."
      );
    }

    if (
      attendance.participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY
    ) {
      if (
        member.role !==
          SHIFT_MEMBER_ROLES.PRIMARY ||
        !primaryTechnicianIds.includes(
          attendance.technicianId
        ) ||
        attendance.authorizationId !== null
      ) {
        throw new ShiftCompletionDomainError(
          "Primary attendance is inconsistent with the shift's primary roster."
        );
      }
    } else if (
      attendance.participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.TEMPORARY_AUTHORIZED
    ) {
      if (
        member.role !==
          SHIFT_MEMBER_ROLES.ADDITIONAL ||
        primaryTechnicianIds.includes(
          attendance.technicianId
        ) ||
        !authorization ||
        attendance.authorizationId !==
          authorization.id ||
        authorization.authorizedTechnicianUid !==
          attendance.technicianId ||
        authorization.shiftId !==
          input.shiftId
      ) {
        throw new ShiftCompletionDomainError(
          "Temporary attendance is inconsistent with the shift's authorization and roster."
        );
      }
    } else {
      throw new ShiftCompletionDomainError(
        "The shift contains unsupported attendance authority."
      );
    }

    attendanceByTechnicianId.set(
      attendance.technicianId,
      attendance
    );
  }

  const additionalMembers =
    members.filter(
      (member) =>
        member.role ===
        SHIFT_MEMBER_ROLES.ADDITIONAL
    );

  if (!authorization) {
    if (additionalMembers.length !== 0) {
      throw new ShiftCompletionDomainError(
        "An additional shift member exists without temporary authorization."
      );
    }
  } else {
    if (additionalMembers.length > 1) {
      throw new ShiftCompletionDomainError(
        "The shift contains multiple temporary technician memberships."
      );
    }

    const temporaryMember =
      memberByTechnicianId.get(
        authorization.authorizedTechnicianUid
      );

    const temporaryAttendance =
      attendanceByTechnicianId.get(
        authorization.authorizedTechnicianUid
      );

    if (temporaryMember) {
      if (
        temporaryMember.role !==
          SHIFT_MEMBER_ROLES.ADDITIONAL
      ) {
        throw new ShiftCompletionDomainError(
          "The temporarily authorized technician cannot be a primary shift member."
        );
      }

      if (!temporaryAttendance) {
        throw new ShiftCompletionDomainError(
          "The temporary technician's joined membership is missing authoritative attendance."
        );
      }

      if (
        additionalMembers.length !== 1 ||
        additionalMembers[0].technicianId !==
          authorization.authorizedTechnicianUid
      ) {
        throw new ShiftCompletionDomainError(
          "The temporary technician membership is inconsistent with its authorization."
        );
      }
    } else {
      if (
        temporaryAttendance ||
        additionalMembers.length !== 0
      ) {
        throw new ShiftCompletionDomainError(
          "Temporary participation state is incomplete or inconsistent."
        );
      }
    }
  }

  return {
    members: members.map(
      (member) => ({ ...member })
    ),
    attendances: Array.from(
      attendanceByTechnicianId.values(),
      (attendance) => ({
        ...attendance,
      })
    ),
    authorization:
      authorization
        ? { ...authorization }
        : null,
  };
}

function validateCurrentShiftMembers(
  shiftId: string,
  values: readonly unknown[]
): ShiftMember[] {
  const members: ShiftMember[] = [];
  const technicianIds =
    new Set<string>();

  for (const value of values) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new ShiftCompletionDomainError(
        "The shift contains invalid membership information."
      );
    }

    const member =
      value as Partial<ShiftMember>;

    if (
      !isValidIdentifier(member.id, 1024) ||
      !isValidIdentifier(
        member.shiftId,
        512
      ) ||
      member.shiftId !== shiftId ||
      !isValidIdentifier(
        member.technicianId,
        128
      ) ||
      member.id !==
        `${shiftId}_${member.technicianId}` ||
      ![
        SHIFT_MEMBER_ROLES.PRIMARY,
        SHIFT_MEMBER_ROLES.ADDITIONAL,
      ].includes(
        member.role as
          | typeof SHIFT_MEMBER_ROLES.PRIMARY
          | typeof SHIFT_MEMBER_ROLES.ADDITIONAL
      ) ||
      !isCanonicalTimestamp(
        member.joinedAt
      ) ||
      member.leftAt !== null
    ) {
      throw new ShiftCompletionDomainError(
        "The shift contains invalid current membership information."
      );
    }

    if (
      technicianIds.has(
        member.technicianId
      )
    ) {
      throw new ShiftCompletionDomainError(
        "The shift contains duplicate technician memberships."
      );
    }

    technicianIds.add(
      member.technicianId
    );

    members.push({
      id: member.id,
      shiftId: member.shiftId,
      technicianId:
        member.technicianId,
      role: member.role,
      joinedAt: member.joinedAt,
      leftAt: null,
    } as ShiftMember);
  }

  return members;
}

function validateAttendanceRecord(
  shiftId: string,
  value: unknown
): Attendance {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new ShiftCompletionDomainError(
      "The shift contains invalid attendance information."
    );
  }

  const attendance =
    value as Partial<Attendance>;

  if (
    !isValidIdentifier(
      attendance.id,
      1024
    ) ||
    !isValidIdentifier(
      attendance.shiftId,
      512
    ) ||
    attendance.shiftId !== shiftId ||
    !isValidIdentifier(
      attendance.technicianId,
      128
    ) ||
    attendance.id !==
      `${shiftId}_${attendance.technicianId}` ||
    attendance.status !==
      ATTENDANCE_STATUSES.PRESENT ||
    attendance.isProvisional !== false ||
    attendance.clockIn !== null ||
    attendance.clockOut !== null ||
    !isCanonicalTimestamp(
      attendance.recordedAt
    ) ||
    !isCanonicalTimestamp(
      attendance.updatedAt
    ) ||
    attendance.updatedAt !==
      attendance.recordedAt ||
    ![
      ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY,
      ATTENDANCE_PARTICIPATION_AUTHORITIES.TEMPORARY_AUTHORIZED,
    ].includes(
      attendance.participationAuthority as
        | typeof ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY
        | typeof ATTENDANCE_PARTICIPATION_AUTHORITIES.TEMPORARY_AUTHORIZED
    )
  ) {
    throw new ShiftCompletionDomainError(
      "The shift contains invalid authoritative attendance information."
    );
  }

  if (
    attendance.participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY
  ) {
    if (attendance.authorizationId !== null) {
      throw new ShiftCompletionDomainError(
        "Primary attendance cannot contain temporary authorization."
      );
    }
  } else if (
    !isValidIdentifier(
      attendance.authorizationId,
      128
    )
  ) {
    throw new ShiftCompletionDomainError(
      "Temporary attendance is missing its authorization identity."
    );
  }

  return {
    id: attendance.id,
    shiftId: attendance.shiftId,
    technicianId:
      attendance.technicianId,
    status: attendance.status,
    participationAuthority:
      attendance.participationAuthority,
    authorizationId:
      attendance.authorizationId,
    clockIn: null,
    clockOut: null,
    isProvisional: false,
    recordedAt: attendance.recordedAt,
    updatedAt: attendance.updatedAt,
  } as Attendance;
}

function validatePrimaryTechnicianIds(
  values: readonly string[]
): [string, string] {
  if (
    values.length !== 2 ||
    !values.every(
      (value) =>
        isValidIdentifier(value, 128)
    ) ||
    values[0] === values[1]
  ) {
    throw new ShiftCompletionDomainError(
      "The shift's primary technician identity is invalid."
    );
  }

  return [
    values[0],
    values[1],
  ];
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

function isCanonicalTimestamp(
  value: unknown
): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const timestamp =
    Date.parse(value);

  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() ===
      value
  );
}