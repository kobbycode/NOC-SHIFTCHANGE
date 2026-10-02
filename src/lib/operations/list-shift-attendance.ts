import "server-only";

import type {
  AppUser,
} from "@/types/auth";

import type {
  Attendance,
} from "@/types/attendance";

import {
  addAttendanceTechnicianNames,
} from "@/lib/attendance/attendance-display";

import type {
  ShiftAttendanceListResult,
} from "@/lib/attendance/attendance-api-types";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

import {
  AttendanceReadDomainError,
  readAttendanceRecord,
} from "./attendance-read-domain";

import {
  getOperationalCollections,
} from "./collections";

export async function listShiftAttendance(
  actor: AppUser,
  shiftId: string,
): Promise<ShiftAttendanceListResult> {
  if (
    typeof shiftId !== "string" ||
    !shiftId.trim() ||
    shiftId !== shiftId.trim() ||
    shiftId.length > 512 ||
    shiftId.includes("/") ||
    shiftId === "." ||
    shiftId === ".."
  ) {
    throw new AssignmentOperationError(
      "Please provide a valid shift identifier.",
      400,
    );
  }

  const {
    db,
    shifts,
    shiftAttendance,
  } = getOperationalCollections();

  const actorSnapshot =
    await db
      .collection("users")
      .doc(actor.uid)
      .get();

  const actorProfile =
    actorSnapshot.data();

  if (
    !actorSnapshot.exists ||
    !actorProfile ||
    actorProfile.status !== "active" ||
    actorProfile.statusOperation != null ||
    actorProfile.mustChangePassword === true ||
    actorProfile.role !== actor.role
  ) {
    throw new AssignmentOperationError(
      "Your account is not authorized to retrieve attendance.",
      403,
    );
  }

  if (
    actor.role !== "admin" &&
    actor.role !== "supervisor"
  ) {
    throw new AssignmentOperationError(
      "You are not authorized to retrieve attendance.",
      403,
    );
  }

  const shiftSnapshot =
    await shifts
      .doc(shiftId)
      .get();

  if (!shiftSnapshot.exists) {
    throw new AssignmentOperationError(
      "The selected shift was not found.",
      404,
    );
  }

  /*
   * Attendance comes only from the
   * authoritative shift_attendance
   * collection. Membership, schedules,
   * permanent pairs, and authorizations
   * are not attendance substitutes.
   */
  const attendanceSnapshot =
    await shiftAttendance
      .where(
        "shiftId",
        "==",
        shiftId,
      )
      .get();

  const attendance: Attendance[] =
    [];

  for (
    const document of
    attendanceSnapshot.docs
  ) {
    try {
      attendance.push(
        readAttendanceRecord(
          document.id,
          document.data(),
        ),
      );
    } catch (error) {
      if (
        error instanceof
        AttendanceReadDomainError
      ) {
        throw new AssignmentOperationError(
          error.message,
          error.status,
        );
      }

      throw error;
    }
  }

  attendance.sort(
    (first, second) =>
      Date.parse(first.recordedAt) -
      Date.parse(second.recordedAt),
  );

  const technicianUids =
    Array.from(
      new Set(
        attendance.map(
          (record) =>
            record.technicianId,
        ),
      ),
    );

  const technicianSnapshots =
    technicianUids.length > 0
      ? await db.getAll(
          ...technicianUids.map(
            (uid) =>
              db
                .collection("users")
                .doc(uid),
          ),
        )
      : [];

  const technicianProfiles =
    new Map<
      string,
      { fullName?: unknown }
    >();

  for (
    const snapshot of
    technicianSnapshots
  ) {
    const profile =
      snapshot.data();

    if (
      snapshot.exists &&
      profile?.role === "technician"
    ) {
      technicianProfiles.set(
        snapshot.id,
        profile,
      );
    }
  }

  const result =
    addAttendanceTechnicianNames(
      attendance,
      technicianProfiles,
    );

  return {
    attendance: result,
    total: result.length,
  };
}