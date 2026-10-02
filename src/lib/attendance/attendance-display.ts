import type {
  Attendance,
} from "@/types/attendance";

import type {
  AttendanceListItem,
} from "./attendance-api-types";

export function addAttendanceTechnicianNames(
  attendance: readonly Attendance[],
  profiles: ReadonlyMap<
    string,
    { fullName?: unknown }
  >,
): AttendanceListItem[] {
  return attendance.map(
    (record) => {
      const profile =
        profiles.get(
          record.technicianId,
        );

      const fullName =
        profile?.fullName;

      return {
        ...record,

        technicianName:
          typeof fullName ===
            "string" &&
          fullName.trim()
            ? fullName.trim()
            : profile
              ? "Unnamed technician"
              : `Technician ${record.technicianId}`,
      };
    },
  );
}