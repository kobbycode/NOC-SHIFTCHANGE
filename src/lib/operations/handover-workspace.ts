import "server-only";
import type { AppUser } from "@/types/auth";
import { getOperationalCollections } from "./collections";
import { assertHandoverAggregate } from "./handover-domain";
import { ShiftOperationsError } from "./shift-operations-domain";

export async function getHandoverWorkspace(actor: AppUser) {
  const { db, handovers, shifts, technicianPairs } = getOperationalCollections();
  return db.runTransaction(async transaction => {
    const profile = (await transaction.get(db.collection("users").doc(actor.uid))).data();
    if (!profile || profile.status !== "active" || profile.role !== actor.role || profile.mustChangePassword !== false || profile.statusOperation != null) throw new ShiftOperationsError("Your account cannot access handovers.", 403);
    const manager = actor.role === "supervisor" || actor.role === "admin";
    const documents = manager ? (await transaction.get(handovers)).docs : [
      ...(await transaction.get(handovers.where("identity.outgoingPrimaryTechnicianIds", "array-contains", actor.uid))).docs,
      ...(await transaction.get(handovers.where("identity.incomingPrimaryTechnicianIds", "array-contains", actor.uid))).docs,
    ];
    const reports = [...new Map(documents.map(doc => [doc.id, doc])).values()].map(doc => {
      const state = assertHandoverAggregate(doc.data());
      return { shiftId: state.identity.outgoingShiftId, incomingShiftId: state.identity.incomingShiftId, status: state.lifecycleStatus, revision: state.revision, scheduledStart: state.identity.scheduledStart, outgoing: state.identity.outgoingPrimaryTechnicianIds, incoming: state.identity.incomingPrimaryTechnicianIds };
    }).sort((a, b) => b.scheduledStart.localeCompare(a.scheduledStart));
    const availableShifts = manager ? (await transaction.get(shifts.where("status", "==", "handover_pending"))).docs.map(doc => ({ id: doc.id, permanentPairId: String(doc.data().permanentPairId ?? ""), scheduledStart: String(doc.data().scheduledStart) })).filter(shift => !reports.some(report => report.shiftId === shift.id && report.status === "collecting_confirmations")) : [];
    const pairs = [];
    if (manager) for (const doc of (await transaction.get(technicianPairs.where("status", "==", "active"))).docs) {
      const ids = doc.data().technicianIds;
      if (!Array.isArray(ids) || ids.length !== 2 || ids.some(uid => typeof uid !== "string")) throw new ShiftOperationsError("Permanent pair information is inconsistent.", 409);
      const names = [];
      for (const uid of ids) names.push(String((await transaction.get(db.collection("users").doc(uid))).data()?.fullName ?? uid));
      pairs.push({ id: doc.id, label: names.join(" + ") });
    }
    return { reports, availableShifts, pairs };
  });
}
export type HandoverWorkspaceData = Awaited<ReturnType<typeof getHandoverWorkspace>>;
