import {
  ATTENDANCE_PARTICIPATION_AUTHORITIES,
  ATTENDANCE_STATUSES,
  type Attendance,
  type AttendanceParticipationAuthority,
  type AttendanceStatus,
} from "@/types/attendance";

export class AttendanceReadDomainError extends Error {
  public readonly status: number;

  constructor(
    message: string,
    status = 409,
  ) {
    super(message);

    this.status = status;
    this.name =
      "AttendanceReadDomainError";
  }
}

export function readAttendanceRecord(
  documentId: string,
  value: unknown,
): Attendance {
  if (
    !isValidIdentifier(
      documentId,
      641,
    )
  ) {
    throw new AttendanceReadDomainError(
      "The attendance document has an invalid identifier.",
    );
  }

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new AttendanceReadDomainError(
      "The attendance record is malformed.",
    );
  }

  const data =
    value as Record<string, unknown>;

  if (
    !isValidIdentifier(data.id, 641) ||
    data.id !== documentId ||
    !isValidIdentifier(
      data.shiftId,
      512,
    ) ||
    !isValidIdentifier(
      data.technicianId,
      128,
    ) ||
    documentId !==
      `${data.shiftId}_${data.technicianId}`
  ) {
    throw new AttendanceReadDomainError(
      "The attendance record identity is inconsistent.",
    );
  }

  if (
    !isAttendanceStatus(
      data.status,
    )
  ) {
    throw new AttendanceReadDomainError(
      "The attendance record has an invalid status.",
    );
  }

  if (
    !isParticipationAuthority(
      data.participationAuthority,
    )
  ) {
    throw new AttendanceReadDomainError(
      "The attendance record has an invalid participation authority.",
    );
  }

  if (
    !isNullableIdentifier(
      data.authorizationId,
      128,
    )
  ) {
    throw new AttendanceReadDomainError(
      "The attendance authorization reference is invalid.",
    );
  }

  if (
    data.participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.PRIMARY &&
    data.authorizationId !== null
  ) {
    throw new AttendanceReadDomainError(
      "Primary attendance cannot reference a temporary authorization.",
    );
  }

  if (
    data.participationAuthority ===
      ATTENDANCE_PARTICIPATION_AUTHORITIES.TEMPORARY_AUTHORIZED &&
    data.authorizationId === null
  ) {
    throw new AttendanceReadDomainError(
      "Temporary attendance requires its authorization reference.",
    );
  }

  if (
    !isNullableTimestamp(
      data.clockIn,
    ) ||
    !isNullableTimestamp(
      data.clockOut,
    ) ||
    !isCanonicalTimestamp(
      data.recordedAt,
    ) ||
    !isCanonicalTimestamp(
      data.updatedAt,
    ) ||
    typeof data.isProvisional !==
      "boolean"
  ) {
    throw new AttendanceReadDomainError(
      "The attendance record has invalid timing or provisional-state data.",
    );
  }

  if (
    Date.parse(data.updatedAt) <
    Date.parse(data.recordedAt)
  ) {
    throw new AttendanceReadDomainError(
      "The attendance update time cannot precede its recorded time.",
    );
  }

  if (
    data.clockIn !== null &&
    data.clockOut !== null &&
    Date.parse(data.clockOut) <
      Date.parse(data.clockIn)
  ) {
    throw new AttendanceReadDomainError(
      "Attendance clock-out cannot precede clock-in.",
    );
  }

  return {
    id: data.id,
    shiftId: data.shiftId,
    technicianId:
      data.technicianId,
    status: data.status,
    participationAuthority:
      data.participationAuthority,
    authorizationId:
      data.authorizationId,
    clockIn: data.clockIn,
    clockOut: data.clockOut,
    isProvisional:
      data.isProvisional,
    recordedAt:
      data.recordedAt,
    updatedAt:
      data.updatedAt,
  };
}

function isAttendanceStatus(
  value: unknown,
): value is AttendanceStatus {
  return Object.values(
    ATTENDANCE_STATUSES,
  ).includes(
    value as AttendanceStatus,
  );
}

function isParticipationAuthority(
  value: unknown,
): value is AttendanceParticipationAuthority {
  return Object.values(
    ATTENDANCE_PARTICIPATION_AUTHORITIES,
  ).includes(
    value as AttendanceParticipationAuthority,
  );
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

function isNullableIdentifier(
  value: unknown,
  maxLength: number,
): value is string | null {
  return (
    value === null ||
    isValidIdentifier(
      value,
      maxLength,
    )
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
    ).toISOString() === value
  );
}

function isNullableTimestamp(
  value: unknown,
): value is string | null {
  return (
    value === null ||
    isCanonicalTimestamp(value)
  );
}