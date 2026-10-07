import { validateTaskAssignmentHistory, assertAssignmentRelease } from "../operations/assignment-generation-domain";

import "server-only";

import type {
  Transaction,
} from "firebase-admin/firestore";

import {
  getOperationalCollections,
} from "@/lib/operations/collections";

import {
  SHIFT_STATUSES,
} from "@/types/shift";

import {
  TASK_STATUSES,
  TASK_RESPONSIBILITY_STATUSES,
  TASK_ACCEPTANCE_STATUSES,
  type TaskStatus,
} from "@/types/task";

import {
  isShiftStatus,
} from "@/lib/operations/shift-transition";
import {
  assertHandoverAggregate,
  createHandoverDocumentId,
  resolveHandoverParticipants,
} from "@/lib/operations/handover-domain";
import { HANDOVER_LIFECYCLE_STATUSES } from "@/types/handover";

export class AccountOperationalError extends Error {
  constructor(
    message: string,
    public readonly status = 409
  ) {
    super(message);

    this.name = "AccountOperationalError";
  }
}

function invalidData(): never {
  throw new AccountOperationalError(
    "The technician's operational records require administrator review."
  );
}

function protectedShiftDuty(): never {
  throw new AccountOperationalError(
    "This technician has a scheduled or active shift, or an unfinished handover. Complete or reassign these duties before blocking the account."
  );
}

const UNFINISHED_TASK_STATUSES =
  new Set<TaskStatus>([
    TASK_STATUSES.OPEN,
    TASK_STATUSES.IN_PROGRESS,
    TASK_STATUSES.PENDING_VERIFICATION,
  ]);

function isValidTaskStatus(
  value: unknown
): value is TaskStatus {
  return (
    typeof value === "string" &&
    Object.values(TASK_STATUSES).some(
      (status) => status === value
    )
  );
}

function validIdentifier(
  value: unknown,
  maxLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !value.includes("/")
  );
}

/*
 * Validate authoritative responsibility.
 *
 * Legacy assignments without an explicit
 * responsibilityStatus remain active.
 *
 * Invalid responsibility metadata must
 * never make account blocking eligible.
 */

function getAssignmentResponsibilityStatus(
  assignment: Record<string, unknown>
): "active" | "released" {
  try { return assertAssignmentRelease(assignment); }
  catch { invalidData(); }
}

export async function requireSafeAccountBlocking(
  transaction: Transaction,
  technicianUid: string
): Promise<void> {
  const {
    shifts,
    shiftMembers,
    technicianSchedules,
    tasks,
    taskAssignments,
    handovers,
  } = getOperationalCollections();

  if (
    !validIdentifier(
      technicianUid,
      128
    )
  ) {
    throw new AccountOperationalError(
      "Please select a valid technician.",
      400
    );
  }

  /*
   * PHASE 1:
   * Read authoritative operational
   * references before any writes.
   */

  const scheduleRef =
    technicianSchedules.doc(
      technicianUid
    );

  const scheduleSnapshot =
    await transaction.get(
      scheduleRef
    );

  const membershipSnapshot =
    await transaction.get(
      shiftMembers.where(
        "technicianId",
        "==",
        technicianUid
      )
    );

  const primaryShiftSnapshot =
    await transaction.get(
      shifts.where(
        "primaryTechnicianIds",
        "array-contains",
        technicianUid
      )
    );

  const assignmentSnapshot =
    await transaction.get(
      taskAssignments.where(
        "technicianId",
        "==",
        technicianUid
      )
    );

  /*
   * PHASE 2:
   * Validate scheduling information.
   */

  const schedule =
    scheduleSnapshot.data();

  if (
    scheduleSnapshot.exists &&
    (
      !schedule ||
      schedule.technicianUid !==
        technicianUid ||
      !Array.isArray(
        schedule.entries
      )
    )
  ) {
    invalidData();
  }

  const entries: unknown[] =
    scheduleSnapshot.exists
      ? schedule!.entries
      : [];

  const shiftIds =
    new Set<string>();
  const scheduleByShiftId = new Map<string, Record<string, unknown>>();
  // A future reservation can explain only a schedule reference. Active
  // membership and actual primary-Shift references still require a real Shift.
  const materializedShiftIds = new Set<string>();

  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      invalidData();
    }

    const record =
      entry as Record<
        string,
        unknown
      >;

    if (
      !validIdentifier(
        record.shiftId,
        512
      ) ||
      typeof record.scheduledStart !==
        "string" ||
      typeof record.scheduledEnd !==
        "string" ||
      typeof record.status !==
        "string"
    ) {
      invalidData();
    }

    if (
      record.status !==
        SHIFT_STATUSES.SCHEDULED &&
      record.status !==
        SHIFT_STATUSES.ACTIVE &&
      record.status !==
        SHIFT_STATUSES.HANDOVER_PENDING
    ) {
      invalidData();
    }

    if (
      shiftIds.has(
        record.shiftId
      )
    ) {
      invalidData();
    }

    shiftIds.add(
      record.shiftId
    );
    scheduleByShiftId.set(record.shiftId, record);
  }

  /*
   * PHASE 3:
   * Include authoritative memberships.
   */

  for (
    const document of
    membershipSnapshot.docs
  ) {
    const member =
      document.data();

    if (
      !validIdentifier(
        member.shiftId,
        512
      )
    ) {
      invalidData();
    }

    if (
      member.leftAt === null
    ) {
      materializedShiftIds.add(member.shiftId);
      shiftIds.add(
        member.shiftId
      );
    } else if (
      member.leftAt === undefined
    ) {
      invalidData();
    }
  }

  /*
   * Include shifts that directly
   * reference this technician as
   * a primary member.
   */

  for (
    const document of
    primaryShiftSnapshot.docs
  ) {
    materializedShiftIds.add(document.id);
    shiftIds.add(
      document.id
    );
  }

  /*
   * PHASE 4:
   * Validate authoritative shifts.
   */

  const shiftSnapshots =
    await Promise.all(
      [...shiftIds].map(
        (shiftId) =>
          transaction.get(
            shifts.doc(shiftId)
          )
      )
    );

  const shiftById =
    new Map<
      string,
      Record<string, unknown>
    >();

  for (
    const snapshot of
    shiftSnapshots
  ) {
    if (
      !snapshot.exists
    ) {
      const entry = scheduleByShiftId.get(snapshot.id);
      if (!entry || entry.status !== SHIFT_STATUSES.SCHEDULED ||
          materializedShiftIds.has(snapshot.id)) invalidData();
      const backing = await transaction.get(handovers.where(
        "reservation.reservedIncomingShiftId", "==", snapshot.id
      ));
      if (backing.size !== 1) invalidData();
      const document = backing.docs[0];
      // Translate malformed domain data into the existing account corruption
      // result. Query/transport failures are not mistaken for validated duties.
      try {
        const aggregate = assertHandoverAggregate(document.data());
        if (document.id !== createHandoverDocumentId(aggregate.identity.outgoingShiftId) ||
            aggregate.lifecycleStatus !== HANDOVER_LIFECYCLE_STATUSES.COLLECTING_CONFIRMATIONS ||
            aggregate.reservation.reservedIncomingShiftId !== entry.shiftId ||
            aggregate.reservation.scheduledStart !== entry.scheduledStart ||
            aggregate.reservation.scheduledEnd !== entry.scheduledEnd ||
            !resolveHandoverParticipants(aggregate).some((participant) =>
              participant.side === "incoming" && participant.technicianUid === technicianUid)) {
          invalidData();
        }
      } catch {
        invalidData();
      }
      protectedShiftDuty();
    }

    const shift =
      snapshot.data();

    if (
      !shift ||
      !isShiftStatus(
        shift.status
      )
    ) {
      invalidData();
    }

    shiftById.set(
      snapshot.id,
      shift
    );

    /*
     * Preserve the existing protection
     * against blocking technicians
     * with unfinished shift duties.
     */

    if (
      shift.status !==
      SHIFT_STATUSES.COMPLETED
    ) {
      protectedShiftDuty();
    }
  }

  /*
   * Completed shifts must not remain
   * in active scheduling entries.
   */

  for (
    const entry of
    entries
  ) {
    const record =
      entry as {
        shiftId: string;
      };

    const shift =
      shiftById.get(
        record.shiftId
      );

    if (
      !shift ||
      shift.status ===
        SHIFT_STATUSES.COMPLETED
    ) {
      invalidData();
    }
  }

  /*
   * PHASE 5:
   * Validate authoritative assignments.
   *
   * Released assignments remain in
   * history but no longer represent
   * active operational responsibility.
   */

  try {
    const taskIds = new Set(assignmentSnapshot.docs.map(document => document.data().taskId));
    for (const taskId of taskIds) validateTaskAssignmentHistory(taskId, assignmentSnapshot.docs
      .filter(document => document.data().taskId === taskId)
      .map(document => ({ id: document.id, data: document.data() })));
  } catch { invalidData(); }

  const assignedTaskIds =
    new Set<string>();

  const activeTaskIds =
    new Set<string>();

  for (
    const document of
    assignmentSnapshot.docs
  ) {
    const assignment =
      document.data();

    if (
      assignment.id !==
        document.id ||
      assignment.technicianId !==
        technicianUid ||
      !validIdentifier(
        assignment.taskId,
        512
      ) ||
      ![
        "lead",
        "support",
      ].includes(
        assignment.responsibility
      ) ||
      !Object.values(
        TASK_ACCEPTANCE_STATUSES
      ).includes(
        assignment.acceptanceStatus
      )
    ) {
      invalidData();
    }

    assignedTaskIds.add(
      assignment.taskId
    );

    const responsibilityStatus =
      getAssignmentResponsibilityStatus(
        assignment
      );

    if (
      responsibilityStatus ===
      TASK_RESPONSIBILITY_STATUSES.ACTIVE
    ) {
      activeTaskIds.add(
        assignment.taskId
      );
    }
  }

  /*
   * PHASE 6:
   * Read every assigned task.
   *
   * Even released assignments must
   * reference existing, valid tasks.
   */

  const taskSnapshots =
    await Promise.all(
      [...assignedTaskIds].map(
        (taskId) =>
          transaction.get(
            tasks.doc(taskId)
          )
      )
    );

  for (
    const snapshot of
    taskSnapshots
  ) {
    if (
      !snapshot.exists
    ) {
      invalidData();
    }

    const task =
      snapshot.data();

    if (
      !task ||
      !isValidTaskStatus(
        task.status
      )
    ) {
      invalidData();
    }

    /*
     * Only active responsibility for
     * an unfinished task prevents
     * account blocking.
     */

    if (
      activeTaskIds.has(
        snapshot.id
      ) &&
      UNFINISHED_TASK_STATUSES.has(
        task.status
      )
    ) {
      throw new AccountOperationalError(
        "This technician has unfinished task assignments. Complete or reassign these tasks before blocking the account."
      );
    }
  }

  /*
   * All authoritative scheduling,
   * shift and responsibility checks
   * have passed.
   *
   * The calling account-status
   * transaction may continue.
   */
}
