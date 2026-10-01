import "server-only";

import {
  SHIFT_MEMBER_ROLES,
  SHIFT_STATUSES,
  type ShiftMember,
} from "@/types/shift";

import type {
  TechnicianSchedule,
  TechnicianScheduleEntry,
} from "@/types/technician-schedule";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

import {
  assertNoScheduleConflict,
} from "./shift-overlap";

export interface PrepareTechnicianScheduleInput {
  shiftId: string;
  technicianUid: string;
  scheduledStart: string;
  scheduledEnd: string;
  updatedAt: string;
  entryStatus?: TechnicianScheduleEntry["status"];
  scheduleExists: boolean;
  scheduleData: unknown;
}

export interface PreparePrimaryShiftRosterInput {
  shiftId: string;
  technicianIds: [string, string];
  scheduledStart: string;
  scheduledEnd: string;
  joinedAt: string;
  updatedAt: string;
  scheduleSnapshots: [
    { exists: boolean; data: unknown },
    { exists: boolean; data: unknown },
  ];
}

export interface PreparedPrimaryShiftRoster {
  members: [ShiftMember, ShiftMember];
  schedules: [TechnicianSchedule, TechnicianSchedule];
}

export function preparePrimaryShiftRoster(
  input: PreparePrimaryShiftRosterInput
): PreparedPrimaryShiftRoster {
  const [firstTechnicianUid, secondTechnicianUid] =
    input.technicianIds;

  if (
    !firstTechnicianUid ||
    !secondTechnicianUid ||
    firstTechnicianUid === secondTechnicianUid
  ) {
    throw new AssignmentOperationError(
      "A primary shift roster requires exactly two distinct technicians.",
      409
    );
  }

  const members: [ShiftMember, ShiftMember] = [
    {
      id: `${input.shiftId}_${firstTechnicianUid}`,
      shiftId: input.shiftId,
      technicianId: firstTechnicianUid,
      role: SHIFT_MEMBER_ROLES.PRIMARY,
      joinedAt: input.joinedAt,
      leftAt: null,
    },
    {
      id: `${input.shiftId}_${secondTechnicianUid}`,
      shiftId: input.shiftId,
      technicianId: secondTechnicianUid,
      role: SHIFT_MEMBER_ROLES.PRIMARY,
      joinedAt: input.joinedAt,
      leftAt: null,
    },
  ];

  const [firstScheduleSnapshot, secondScheduleSnapshot] =
    input.scheduleSnapshots;
  const schedules: [
    TechnicianSchedule,
    TechnicianSchedule,
  ] = [
    prepareTechnicianSchedule({
      shiftId: input.shiftId,
      technicianUid: firstTechnicianUid,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      updatedAt: input.updatedAt,
      scheduleExists: firstScheduleSnapshot.exists,
      scheduleData: firstScheduleSnapshot.data,
    }),
    prepareTechnicianSchedule({
      shiftId: input.shiftId,
      technicianUid: secondTechnicianUid,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      updatedAt: input.updatedAt,
      scheduleExists: secondScheduleSnapshot.exists,
      scheduleData: secondScheduleSnapshot.data,
    }),
  ];

  return { members, schedules };
}

export function prepareTechnicianSchedule(
  input: PrepareTechnicianScheduleInput
): TechnicianSchedule {
  if (
    !input.shiftId ||
    input.shiftId.includes("/") ||
    input.shiftId.length > 512 ||
    !input.technicianUid ||
    input.technicianUid.includes("/") ||
    input.technicianUid.length > 128
  ) {
    throw new AssignmentOperationError(
      "Please provide valid shift scheduling details.",
      400
    );
  }

  let existingSchedule:
    Record<string, unknown> = {};
  let existingEntries:
    TechnicianScheduleEntry[] = [];

  if (input.scheduleExists) {
    const schedule = input.scheduleData as {
      technicianUid?: unknown;
      entries?: unknown;
    } | null;

    if (
      !schedule ||
      schedule.technicianUid !== input.technicianUid ||
      !Array.isArray(schedule.entries)
    ) {
      throw new AssignmentOperationError(
        "The technician has an invalid scheduling record.",
        409
      );
    }

    if (
      schedule.entries.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof (entry as Record<string, unknown>).shiftId !==
            "string" ||
          !(entry as Record<string, unknown>).shiftId ||
          typeof (entry as Record<string, unknown>).scheduledStart !==
            "string" ||
          typeof (entry as Record<string, unknown>).scheduledEnd !==
            "string"
      )
    ) {
      throw new AssignmentOperationError(
        "The technician has invalid shift scheduling information.",
        409
      );
    }

    existingSchedule = schedule as Record<string, unknown>;
    existingEntries =
      schedule.entries as TechnicianScheduleEntry[];
  }

  if (
    existingEntries.some(
      (entry) => entry.shiftId === input.shiftId
    )
  ) {
    throw new AssignmentOperationError(
      "This technician already has a scheduling record for the selected shift.",
      409
    );
  }

  assertNoScheduleConflict(
    input.scheduledStart,
    input.scheduledEnd,
    existingEntries
  );

  const newEntry: TechnicianScheduleEntry = {
    shiftId: input.shiftId,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    status:
      input.entryStatus ??
      SHIFT_STATUSES.SCHEDULED,
  };

  return {
    ...existingSchedule,
    technicianUid: input.technicianUid,
    entries: [...existingEntries, newEntry],
    updatedAt: input.updatedAt,
  } as TechnicianSchedule;
}