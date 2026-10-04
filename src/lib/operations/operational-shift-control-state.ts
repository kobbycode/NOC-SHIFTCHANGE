import type {
  ShiftStatus,
} from "@/types/shift";

export type OperationalShiftSlotStatus =
  | "pending"
  | "consumed";

export interface OperationalShiftControl {
  generation: number;
  slotToken: string;
  slotStatus: OperationalShiftSlotStatus;
  shiftId: string | null;
  shiftStatus: ShiftStatus | null;
  createdAt: string;
  consumedAt: string | null;
  previousSlotToken: string | null;
  advancedAt: string | null;
  updatedAt: string;
}

const SLOT_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OCCUPYING_SHIFT_STATUSES = new Set([
  "scheduled",
  "active",
  "handover_pending",
]);

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function requireSlotToken(
  value: unknown
): asserts value is string {
  if (
    typeof value !== "string" ||
    !SLOT_TOKEN_PATTERN.test(value)
  ) {
    throw new Error(
      "The operational shift slot token is invalid."
    );
  }
}

function requireShiftId(
  value: unknown
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    value.includes("/") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(
      "The operational shift identifier is invalid."
    );
  }
}

function requireTimestamp(
  value: unknown
): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !==
      value
  ) {
    throw new Error(
      "The operational shift control timestamp is invalid."
    );
  }
}

function isTimestampOrNull(
  value: unknown
): value is string | null {
  if (value === null) {
    return true;
  }

  try {
    requireTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

export function assertOperationalShiftControl(
  value: unknown
): OperationalShiftControl {
  if (!isRecord(value)) {
    throw new Error(
      "The operational shift control record is malformed."
    );
  }

  const allowedFields = new Set([
    "generation",
    "slotToken",
    "slotStatus",
    "shiftId",
    "shiftStatus",
    "createdAt",
    "consumedAt",
    "previousSlotToken",
    "advancedAt",
    "updatedAt",
  ]);

  if (
    Object.keys(value).some(
      (key) => !allowedFields.has(key)
    )
  ) {
    throw new Error(
      "The operational shift control record contains unsupported fields."
    );
  }

  requireSlotToken(value.slotToken);

  if (
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !isTimestampOrNull(value.createdAt) ||
    value.createdAt === null ||
    !isTimestampOrNull(value.updatedAt) ||
    value.updatedAt === null
  ) {
    throw new Error(
      "The operational shift control record is malformed."
    );
  }

  const generation =
    value.generation as number;
  const createdAt =
    Date.parse(value.createdAt);
  const updatedAt =
    Date.parse(value.updatedAt);

  if (updatedAt < createdAt) {
    throw new Error(
      "The operational shift control timestamps are contradictory."
    );
  }

  if (generation === 1) {
    if (
      value.previousSlotToken !== null ||
      value.advancedAt !== null
    ) {
      throw new Error(
        "The initial operational shift slot has invalid advancement metadata."
      );
    }
  } else {
    requireSlotToken(value.previousSlotToken);
    requireTimestamp(value.advancedAt);

    if (
      value.previousSlotToken ===
        value.slotToken ||
      value.advancedAt !== value.createdAt
    ) {
      throw new Error(
        "An operational shift slot token cannot be reused."
      );
    }
  }

  if (value.slotStatus === "pending") {
    if (
      value.shiftId !== null ||
      value.shiftStatus !== null ||
      value.consumedAt !== null
    ) {
      throw new Error(
        "A pending operational shift slot cannot reference a consumed shift."
      );
    }
  } else if (value.slotStatus === "consumed") {
    requireShiftId(value.shiftId);
    requireTimestamp(value.consumedAt);

    if (
      Date.parse(value.consumedAt as string) <
        createdAt ||
      updatedAt <
        Date.parse(value.consumedAt as string)
    ) {
      throw new Error(
        "The consumed operational shift slot timestamps are contradictory."
      );
    }

    if (
      typeof value.shiftStatus !== "string" ||
      !OCCUPYING_SHIFT_STATUSES.has(
        value.shiftStatus
      )
    ) {
      throw new Error(
        "A consumed operational shift slot must reference an occupying shift."
      );
    }
  } else {
    throw new Error(
      "The operational shift control status is invalid."
    );
  }

  return value as unknown as OperationalShiftControl;
}

export function createPendingOperationalShiftControl(
  slotToken: string,
  generation: number,
  createdAt: string,
  previousSlotToken: string | null = null,
  advancedAt: string | null = null
): OperationalShiftControl {
  const control = {
    generation,
    slotToken,
    slotStatus: "pending" as const,
    shiftId: null,
    shiftStatus: null,
    createdAt,
    consumedAt: null,
    previousSlotToken,
    advancedAt,
    updatedAt: createdAt,
  };

  return assertOperationalShiftControl(control);
}

export function adoptOperationalShiftControl(
  slotToken: string,
  shiftId: string,
  shiftStatus: ShiftStatus,
  now: string
): OperationalShiftControl {
  if (!OCCUPYING_SHIFT_STATUSES.has(shiftStatus)) {
    throw new Error(
      "Only an occupying shift can be adopted into the global slot."
    );
  }

  return assertOperationalShiftControl({
    generation: 1,
    slotToken,
    slotStatus: "consumed",
    shiftId,
    shiftStatus,
    createdAt: now,
    consumedAt: now,
    previousSlotToken: null,
    advancedAt: null,
    updatedAt: now,
  });
}

export function consumeOperationalShiftSlot(
  value: unknown,
  shiftId: string,
  consumedAt: string
): OperationalShiftControl {
  const control =
    assertOperationalShiftControl(value);

  if (control.slotStatus !== "pending") {
    throw new Error(
      "The current global shift slot has already been consumed."
    );
  }

  requireShiftId(shiftId);
  requireTimestamp(consumedAt);

  return assertOperationalShiftControl({
    ...control,
    slotStatus: "consumed",
    shiftId,
    shiftStatus: "scheduled",
    consumedAt,
    updatedAt: consumedAt,
  });
}

export function transitionOperationalShiftControl(
  value: unknown,
  shiftId: string,
  expectedStatus: ShiftStatus,
  nextStatus: ShiftStatus,
  updatedAt: string
): OperationalShiftControl {
  const control =
    assertOperationalShiftControl(value);

  if (
    control.slotStatus !== "consumed" ||
    control.shiftId !== shiftId ||
    control.shiftStatus !== expectedStatus
  ) {
    throw new Error(
      "The shift does not match the current global operational slot."
    );
  }

  const permittedTransition =
    (expectedStatus === "scheduled" &&
      nextStatus === "active") ||
    (expectedStatus === "active" &&
      nextStatus === "handover_pending");

  if (!permittedTransition) {
    throw new Error(
      "The requested global operational slot transition is invalid."
    );
  }

  requireTimestamp(updatedAt);

  if (
    Date.parse(updatedAt) <
    Date.parse(control.updatedAt)
  ) {
    throw new Error(
      "The operational shift slot transition timestamp is stale."
    );
  }

  return assertOperationalShiftControl({
    ...control,
    shiftStatus: nextStatus,
    updatedAt,
  });
}

export function advanceOperationalShiftControl(
  value: unknown,
  completedShiftId: string,
  nextSlotToken: string,
  advancedAt: string
): OperationalShiftControl {
  const control =
    assertOperationalShiftControl(value);

  if (
    control.slotStatus !== "consumed" ||
    control.shiftId !== completedShiftId ||
    control.shiftStatus !== "handover_pending"
  ) {
    throw new Error(
      "Only the current handover-pending shift can advance the global operational slot."
    );
  }

  requireSlotToken(nextSlotToken);
  requireTimestamp(advancedAt);

  if (
    Date.parse(advancedAt) <
    Date.parse(control.updatedAt)
  ) {
    throw new Error(
      "The operational shift slot advancement timestamp is stale."
    );
  }

  if (nextSlotToken === control.slotToken) {
    throw new Error(
      "An operational shift slot token cannot be reused."
    );
  }

  return createPendingOperationalShiftControl(
    nextSlotToken,
    control.generation + 1,
    advancedAt,
    control.slotToken,
    advancedAt
  );
}

export function advanceExpiredScheduledOperationalShiftControl(
  value: unknown,
  cancelledShiftId: string,
  nextSlotToken: string,
  advancedAt: string
): OperationalShiftControl {
  const control =
    assertOperationalShiftControl(value);

  if (
    control.slotStatus !== "consumed" ||
    control.shiftId !== cancelledShiftId ||
    control.shiftStatus !== "scheduled"
  ) {
    throw new Error(
      "Only the current expired scheduled shift can advance the global operational slot through recovery."
    );
  }

  requireShiftId(cancelledShiftId);
  requireSlotToken(nextSlotToken);
  requireTimestamp(advancedAt);

  if (
    Date.parse(advancedAt) <
    Date.parse(control.updatedAt)
  ) {
    throw new Error(
      "The operational shift recovery advancement timestamp is stale."
    );
  }

  if (nextSlotToken === control.slotToken) {
    throw new Error(
      "An operational shift slot token cannot be reused."
    );
  }

  return createPendingOperationalShiftControl(
    nextSlotToken,
    control.generation + 1,
    advancedAt,
    control.slotToken,
    advancedAt
  );
}

export function assertShiftOwnsOperationalSlot(
  controlValue: unknown,
  shiftId: string,
  slotToken: unknown,
  shiftStatus: unknown
): OperationalShiftControl {
  const control =
    assertOperationalShiftControl(controlValue);

  if (
    control.slotStatus !== "consumed" ||
    control.shiftId !== shiftId ||
    control.slotToken !== slotToken ||
    control.shiftStatus !== shiftStatus
  ) {
    throw new Error(
      "The shift is not the current occupant of the global operational slot."
    );
  }

  return control;
}