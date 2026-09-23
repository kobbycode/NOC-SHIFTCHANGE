
export interface TechnicianScheduleEntry {
  shiftId: string;

  scheduledStart: string;
  scheduledEnd: string;

  status:
    | "scheduled"
    | "active"
    | "handover_pending";
}

export interface TechnicianSchedule {
  technicianUid: string;

  entries: TechnicianScheduleEntry[];

  updatedAt: string;
}