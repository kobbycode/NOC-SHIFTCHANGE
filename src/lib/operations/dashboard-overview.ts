import "server-only";
import type { AppUser } from "@/types/auth";
import { getOperationalCollections } from "./collections";
import { assertOperationalShiftControl } from "./operational-shift-control-state";
import { readOperationStations } from "./shift-operations";
import { ShiftOperationsError } from "./shift-operations-domain";

export async function getDashboardOverview(actor: AppUser) {
  const { db, shifts, shiftMembers, shiftAttendance, tasks, handovers, operationalShiftControl } = getOperationalCollections();
  return db.runTransaction(async transaction => {
    const profile = (await transaction.get(db.collection("users").doc(actor.uid))).data();
    if (!profile || !["admin", "supervisor"].includes(actor.role) || profile.role !== actor.role || profile.status !== "active" || profile.mustChangePassword !== false || profile.statusOperation != null) throw new ShiftOperationsError("Dashboard access denied.", 403);
    const controlDocument = await transaction.get(operationalShiftControl.doc("global"));
    const control = controlDocument.exists ? assertOperationalShiftControl(controlDocument.data()) : null;
    let currentShift = "No current shift", techniciansOnDuty = 0;
    if (control?.slotStatus === "consumed" && control.shiftId) {
      const shift = (await transaction.get(shifts.doc(control.shiftId))).data();
      if (!shift || shift.id !== control.shiftId || shift.status !== control.shiftStatus || shift.operationalSlotToken !== control.slotToken) throw new ShiftOperationsError("Current shift ownership is inconsistent.", 409);
      currentShift = `${String(shift.shiftType)} · ${String(shift.status).replaceAll("_", " ")}`;
      const members = (await transaction.get(shiftMembers.where("shiftId", "==", control.shiftId))).docs.map(doc => doc.data());
      const attendance = (await transaction.get(shiftAttendance.where("shiftId", "==", control.shiftId))).docs.map(doc => doc.data());
      techniciansOnDuty = new Set(attendance.filter(record => record.status === "present" && members.some(member => member.technicianId === record.technicianId && member.leftAt === null)).map(record => record.technicianId)).size;
    }
    const openTasks = (await transaction.get(tasks)).docs.filter(doc => !["completed", "cancelled"].includes(doc.data().status)).length;
    const pendingHandovers = (await transaction.get(handovers.where("lifecycleStatus", "==", "collecting_confirmations"))).size;
    const totalUsers = actor.role === "admin" ? (await transaction.get(db.collection("users"))).size : null;
    const stations = actor.role === "admin" ? (await readOperationStations(transaction)).length : null;
    return { currentShift, techniciansOnDuty, openTasks, pendingHandovers, totalUsers, stations };
  });
}
