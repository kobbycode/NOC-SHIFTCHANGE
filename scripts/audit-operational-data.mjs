
import {
  applicationDefault,
  getApps,
  initializeApp,
} from "firebase-admin/app";

import {
  getFirestore,
} from "firebase-admin/firestore";

/*
 * ShiftChange 2.0
 * Lesson 4C.9AA
 *
 * Authoritative operational data audit.
 *
 * READ ONLY:
 * This script does not create, update,
 * or delete Firestore documents.
 */

const projectId =
  process.env.FIREBASE_PROJECT_ID ??
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

if (!projectId) {
  throw new Error(
    "Missing FIREBASE_PROJECT_ID. Configure the Firebase project before running the audit."
  );
}

const app =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
    projectId,
  });

const db = getFirestore(app);

const COLLECTIONS = {
  shifts: "shifts",
  shiftMembers: "shift_members",
  technicianSchedules: "technician_schedules",
  tasks: "tasks",
  taskAssignments: "task_assignments",
  taskAssignmentHistory:
    "task_assignment_history",
};

const ACTIVE_SHIFT_STATUSES = new Set([
  "scheduled",
  "active",
  "handover_pending",
]);

const VALID_SHIFT_STATUSES = new Set([
  ...ACTIVE_SHIFT_STATUSES,
  "completed",
]);

const VALID_MEMBER_ROLES = new Set([
  "primary",
  "additional",
]);

const problems = [];

function reportProblem(
  code,
  message,
  details = {}
) {
  problems.push({
    code,
    message,
    details,
  });
}

async function inspectCollection(
  name,
  collectionPath
) {
  const snapshot = await db
    .collection(collectionPath)
    .get();

  console.log(
    `${name}: ${snapshot.size} documents`
  );

  return snapshot.docs.map((document) => ({
    ...document.data(),
    id: document.id,
  }));
}

function countBy(items, field) {
  const counts = {};

  for (const item of items) {
    const value =
      typeof item[field] === "string"
        ? item[field]
        : "invalid_or_missing";

    counts[value] =
      (counts[value] ?? 0) + 1;
  }

  return counts;
}

function validateShiftStates(shifts) {
  console.log(
    "\n--- Authoritative shift-state checks ---"
  );

  for (const shift of shifts) {
    if (!VALID_SHIFT_STATUSES.has(shift.status)) {
      reportProblem(
        "INVALID_SHIFT_STATUS",
        "A shift has an invalid status.",
        {
          shiftId: shift.id,
          status: shift.status,
        }
      );

      continue;
    }

    const start = Date.parse(
      shift.scheduledStart
    );

    const end = Date.parse(
      shift.scheduledEnd
    );

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end
    ) {
      reportProblem(
        "INVALID_SHIFT_TIME",
        "A shift has invalid scheduled times.",
        {
          shiftId: shift.id,
        }
      );
    }

    if (
      shift.status === "scheduled" &&
      (
        shift.actualStart != null ||
        shift.actualEnd != null
      )
    ) {
      reportProblem(
        "SCHEDULED_SHIFT_HAS_ACTUAL_TIMES",
        "A scheduled shift contains actual start or end information.",
        {
          shiftId: shift.id,
        }
      );
    }

    if (
      shift.status === "active" ||
      shift.status === "handover_pending"
    ) {
      if (
        typeof shift.actualStart !== "string" ||
        !Number.isFinite(
          Date.parse(shift.actualStart)
        ) ||
        shift.actualEnd != null
      ) {
        reportProblem(
          "INVALID_ACTIVE_SHIFT_TIMES",
          "An active shift or unfinished handover has inconsistent actual times.",
          {
            shiftId: shift.id,
          }
        );
      }
    }

    if (
      shift.status === "completed" &&
      (
        typeof shift.actualStart !== "string" ||
        typeof shift.actualEnd !== "string" ||
        !Number.isFinite(
          Date.parse(shift.actualStart)
        ) ||
        !Number.isFinite(
          Date.parse(shift.actualEnd)
        ) ||
        Date.parse(shift.actualEnd) <
          Date.parse(shift.actualStart)
      )
    ) {
      reportProblem(
        "INVALID_COMPLETED_SHIFT_TIMES",
        "A completed shift has inconsistent actual start or end information.",
        {
          shiftId: shift.id,
        }
      );
    }

    if (
      !Array.isArray(
        shift.primaryTechnicianIds
      ) ||
      shift.primaryTechnicianIds.some(
        (uid) =>
          typeof uid !== "string" ||
          !uid ||
          uid.includes("/")
      )
    ) {
      reportProblem(
        "INVALID_PRIMARY_TECHNICIANS",
        "A shift has invalid primary technician information.",
        {
          shiftId: shift.id,
        }
      );

      continue;
    }

    const primaryIds =
      shift.primaryTechnicianIds;

    if (
      new Set(primaryIds).size !==
      primaryIds.length
    ) {
      reportProblem(
        "DUPLICATE_PRIMARY_TECHNICIAN",
        "A shift contains duplicate primary technicians.",
        {
          shiftId: shift.id,
        }
      );
    }

    if (
      primaryIds.length > 2 ||
      (
        shift.status !== "scheduled" &&
        primaryIds.length !== 2
      )
    ) {
      reportProblem(
        "INVALID_PRIMARY_TECHNICIAN_COUNT",
        "A shift has an invalid number of primary technicians.",
        {
          shiftId: shift.id,
          count: primaryIds.length,
        }
      );
    }
  }
}

function validateMemberships(
  shifts,
  shiftMembers
) {
  console.log(
    "\n--- Authoritative membership checks ---"
  );

  const shiftMap = new Map(
    shifts.map((shift) => [
      shift.id,
      shift,
    ])
  );

  const currentMembershipKeys = new Set();

  for (const member of shiftMembers) {
    const shift =
      shiftMap.get(member.shiftId);

    if (!shift) {
      reportProblem(
        "MEMBERSHIP_SHIFT_MISSING",
        "A membership references a missing shift.",
        {
          membershipId: member.id,
          shiftId: member.shiftId,
        }
      );

      continue;
    }

    if (
      !VALID_MEMBER_ROLES.has(member.role)
    ) {
      reportProblem(
        "INVALID_MEMBERSHIP_ROLE",
        "A membership has an invalid role.",
        {
          membershipId: member.id,
        }
      );
    }

    if (
      typeof member.technicianId !== "string" ||
      !member.technicianId
    ) {
      reportProblem(
        "INVALID_MEMBERSHIP_TECHNICIAN",
        "A membership has an invalid technician identifier.",
        {
          membershipId: member.id,
        }
      );

      continue;
    }

    if (
      member.leftAt !== null &&
      (
        typeof member.leftAt !== "string" ||
        !Number.isFinite(
          Date.parse(member.leftAt)
        )
      )
    ) {
      reportProblem(
        "INVALID_MEMBERSHIP_DEPARTURE",
        "A membership has invalid departure information.",
        {
          membershipId: member.id,
        }
      );

      continue;
    }

    if (member.leftAt !== null) {
      continue;
    }

    const key = JSON.stringify([
      member.shiftId,
      member.technicianId,
    ]);

    if (currentMembershipKeys.has(key)) {
      reportProblem(
        "DUPLICATE_CURRENT_MEMBERSHIP",
        "A technician has duplicate current memberships for a shift.",
        {
          shiftId: member.shiftId,
          technicianUid:
            member.technicianId,
        }
      );
    }

    currentMembershipKeys.add(key);

    if (
      member.role === "primary" &&
      !shift.primaryTechnicianIds?.includes(
        member.technicianId
      )
    ) {
      reportProblem(
        "PRIMARY_MEMBERSHIP_MISMATCH",
        "A primary membership is missing from the shift's primary technician list.",
        {
          shiftId: member.shiftId,
          technicianUid:
            member.technicianId,
        }
      );
    }

    if (
      member.role === "additional" &&
      shift.primaryTechnicianIds?.includes(
        member.technicianId
      )
    ) {
      reportProblem(
        "ADDITIONAL_MEMBER_IS_PRIMARY",
        "An additional member is also listed as a primary technician.",
        {
          shiftId: member.shiftId,
          technicianUid:
            member.technicianId,
        }
      );
    }
  }

  for (const shift of shifts) {
    if (
      !Array.isArray(
        shift.primaryTechnicianIds
      )
    ) {
      continue;
    }

    for (
      const technicianUid of
      shift.primaryTechnicianIds
    ) {
      const matches =
        shiftMembers.filter(
          (member) =>
            member.shiftId === shift.id &&
            member.technicianId ===
              technicianUid &&
            member.role === "primary" &&
            member.leftAt === null
        );

      if (matches.length !== 1) {
        reportProblem(
          "PRIMARY_MEMBER_RECORD_MISMATCH",
          "A primary technician does not have exactly one current primary membership.",
          {
            shiftId: shift.id,
            technicianUid,
            membershipCount:
              matches.length,
          }
        );
      }
    }
  }

  return currentMembershipKeys;
}

function validateSchedules(
  shifts,
  shiftMembers,
  technicianSchedules,
  currentMembershipKeys
) {
  console.log(
    "\n--- Authoritative reconciliation ---"
  );

  const shiftMap = new Map(
    shifts.map((shift) => [
      shift.id,
      shift,
    ])
  );

  const scheduleMap = new Map();

  for (
    const schedule of
    technicianSchedules
  ) {
    const technicianUid =
      schedule.technicianUid;

    if (
      typeof technicianUid !== "string" ||
      !technicianUid ||
      schedule.id !== technicianUid ||
      !Array.isArray(schedule.entries)
    ) {
      reportProblem(
        "INVALID_TECHNICIAN_SCHEDULE",
        "A technician scheduling document has invalid identity or entry information.",
        {
          scheduleId: schedule.id,
        }
      );

      continue;
    }

    if (scheduleMap.has(technicianUid)) {
      reportProblem(
        "DUPLICATE_TECHNICIAN_SCHEDULE",
        "A technician has duplicate scheduling documents.",
        {
          technicianUid,
        }
      );
    }

    scheduleMap.set(
      technicianUid,
      schedule
    );

    const seenShiftIds = new Set();

    for (const entry of schedule.entries) {
      if (
        !entry ||
        typeof entry.shiftId !== "string" ||
        !entry.shiftId
      ) {
        reportProblem(
          "INVALID_SCHEDULE_ENTRY",
          "A technician has an invalid scheduling entry.",
          {
            technicianUid,
          }
        );

        continue;
      }

      if (
        seenShiftIds.has(entry.shiftId)
      ) {
        reportProblem(
          "DUPLICATE_SCHEDULE_ENTRY",
          "A technician has duplicate entries for the same shift.",
          {
            technicianUid,
            shiftId: entry.shiftId,
          }
        );
      }

      seenShiftIds.add(entry.shiftId);

      const shift =
        shiftMap.get(entry.shiftId);

      if (!shift) {
        reportProblem(
          "SCHEDULE_SHIFT_MISSING",
          "A scheduling entry references a missing shift.",
          {
            technicianUid,
            shiftId: entry.shiftId,
          }
        );

        continue;
      }

      const membershipKey =
        JSON.stringify([
          entry.shiftId,
          technicianUid,
        ]);

      if (
        !currentMembershipKeys.has(
          membershipKey
        )
      ) {
        reportProblem(
          "SCHEDULE_MEMBERSHIP_MISSING",
          "A scheduling entry has no corresponding current shift membership.",
          {
            technicianUid,
            shiftId: entry.shiftId,
          }
        );
      }

      if (
        !ACTIVE_SHIFT_STATUSES.has(
          shift.status
        )
      ) {
        reportProblem(
          "COMPLETED_SHIFT_SCHEDULE_REMAINS",
          "A completed shift remains in a technician's scheduling entries.",
          {
            technicianUid,
            shiftId: entry.shiftId,
          }
        );

        continue;
      }

      if (
        entry.status !== shift.status
      ) {
        reportProblem(
          "SCHEDULE_STATUS_MISMATCH",
          "A technician's scheduling status does not match the authoritative shift status.",
          {
            technicianUid,
            shiftId: entry.shiftId,
            scheduleStatus:
              entry.status,
            shiftStatus:
              shift.status,
          }
        );
      }

      if (
        entry.scheduledStart !==
          shift.scheduledStart ||
        entry.scheduledEnd !==
          shift.scheduledEnd
      ) {
        reportProblem(
          "SCHEDULE_TIME_MISMATCH",
          "A technician's scheduled times do not match the authoritative shift.",
          {
            technicianUid,
            shiftId: entry.shiftId,
          }
        );
      }
    }
  }

  /*
   * Every current membership for an
   * unfinished shift must have exactly
   * one matching scheduling entry.
   */

  for (const member of shiftMembers) {
    if (member.leftAt !== null) {
      continue;
    }

    const shift =
      shiftMap.get(member.shiftId);

    if (
      !shift ||
      !ACTIVE_SHIFT_STATUSES.has(
        shift.status
      )
    ) {
      continue;
    }

    const schedule =
      scheduleMap.get(
        member.technicianId
      );

    const matchingEntries =
      schedule?.entries.filter(
        (entry) =>
          entry?.shiftId ===
          member.shiftId
      ) ?? [];

    if (matchingEntries.length !== 1) {
      reportProblem(
        "MEMBERSHIP_SCHEDULE_MISMATCH",
        "A current membership does not have exactly one matching scheduling entry.",
        {
          technicianUid:
            member.technicianId,
          shiftId: member.shiftId,
          matchingEntries:
            matchingEntries.length,
        }
      );
    }
  }

  /*
   * Detect overlapping scheduled shifts
   * and conflicting active duties.
   */

  for (
    const schedule of
    technicianSchedules
  ) {
    if (
      !Array.isArray(
        schedule.entries
      )
    ) {
      continue;
    }

    const entries =
      schedule.entries.filter(
        (entry) =>
          entry &&
          ACTIVE_SHIFT_STATUSES.has(
            entry.status
          ) &&
          Number.isFinite(
            Date.parse(
              entry.scheduledStart
            )
          ) &&
          Number.isFinite(
            Date.parse(
              entry.scheduledEnd
            )
          )
      );

    for (
      let firstIndex = 0;
      firstIndex < entries.length;
      firstIndex++
    ) {
      for (
        let secondIndex =
          firstIndex + 1;
        secondIndex < entries.length;
        secondIndex++
      ) {
        const first =
          entries[firstIndex];

        const second =
          entries[secondIndex];

        const firstStart =
          Date.parse(
            first.scheduledStart
          );

        const firstEnd =
          Date.parse(
            first.scheduledEnd
          );

        const secondStart =
          Date.parse(
            second.scheduledStart
          );

        const secondEnd =
          Date.parse(
            second.scheduledEnd
          );

        const timeOverlap =
          firstStart < secondEnd &&
          secondStart < firstEnd;

        const activeConflict =
          first.status === "active" ||
          first.status ===
            "handover_pending" ||
          second.status === "active" ||
          second.status ===
            "handover_pending";

        if (
          timeOverlap ||
          activeConflict
        ) {
          reportProblem(
            "TECHNICIAN_SHIFT_CONFLICT",
            "A technician has overlapping shifts or conflicting active duties.",
            {
              technicianUid:
                schedule.technicianUid,
              firstShiftId:
                first.shiftId,
              secondShiftId:
                second.shiftId,
            }
          );
        }
      }
    }
  }
}

async function runAudit() {
  console.log(
    "\nShiftChange 2.0 - Operational Data Audit"
  );

  console.log(
    "Firebase project:",
    projectId
  );

  console.log(
    "Mode: READ ONLY\n"
  );

  const shifts =
    await inspectCollection(
      "Shifts",
      COLLECTIONS.shifts
    );

  const shiftMembers =
    await inspectCollection(
      "Shift memberships",
      COLLECTIONS.shiftMembers
    );

  const technicianSchedules =
    await inspectCollection(
      "Technician schedules",
      COLLECTIONS.technicianSchedules
    );

  const tasks =
    await inspectCollection(
      "Tasks",
      COLLECTIONS.tasks
    );

  const taskAssignments =
    await inspectCollection(
      "Task assignments",
      COLLECTIONS.taskAssignments
    );

  const taskAssignmentHistory =
    await inspectCollection(
      "Task assignment history",
      COLLECTIONS.taskAssignmentHistory
    );

  console.log(
    "\n--- Shift status summary ---"
  );

  console.log(
    countBy(shifts, "status")
  );

  console.log(
    "\n--- Membership role summary ---"
  );

  console.log(
    countBy(
      shiftMembers,
      "role"
    )
  );

  validateShiftStates(
    shifts
  );

  const currentMembershipKeys =
    validateMemberships(
      shifts,
      shiftMembers
    );

  validateSchedules(
    shifts,
    shiftMembers,
    technicianSchedules,
    currentMembershipKeys
  );

  console.log(
    "\n--- Audit completed ---"
  );

  console.log({
    shifts: shifts.length,
    shiftMembers:
      shiftMembers.length,
    technicianSchedules:
      technicianSchedules.length,
    tasks: tasks.length,
    taskAssignments:
      taskAssignments.length,
    taskAssignmentHistory:
      taskAssignmentHistory.length,
    schedulingInconsistencies:
      problems.length,
  });

  console.log(
    "\n--- Reconciliation findings ---"
  );

  const problemCounts = {};

  for (const problem of problems) {
    problemCounts[problem.code] =
      (problemCounts[problem.code] ?? 0) + 1;
  }

  console.log(
    problemCounts
  );

  for (const problem of problems) {
    console.log(
      JSON.stringify(
        problem,
        null,
        2
      )
    );
  }

  if (problems.length > 0) {
    console.error(
      "\nOperational inconsistencies require administrator review."
    );

    process.exitCode = 1;
  } else {
    console.log(
      "\nNo inconsistencies were detected by the implemented checks."
    );
  }
}

runAudit().catch((error) => {
  console.error(
    "Operational audit failed:",
    error instanceof Error
      ? error.message
      : "Unknown error."
  );

  process.exitCode = 1;
});