import "server-only";
import type { CollectionReference, Transaction } from "firebase-admin/firestore";
import type { AppUser } from "@/types/auth";
import { getOperationalCollections } from "./collections";
import { assertHandoverAggregate } from "./handover-domain";
import { assertEqualHandoverAggregate } from "./equal-technician-handover-domain";
import { ShiftOperationsError } from "./shift-operations-domain";

export async function getHandoverWorkspace(actor: AppUser) {
  const { db, handovers, equalHandoversV2, shifts, technicianPairs } = getOperationalCollections();
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
    const v2Reports = v2WorkspaceEnabled() && !manager
      ? await readV2WorkspaceReports(transaction, equalHandoversV2, actor.uid)
      : [];
    return { reports, availableShifts, pairs, v2Reports };
  });
}

export function v2WorkspaceEnabled(): boolean {
  return process.env.HANDOVER_V2_DEV === "true";
}

// §13: v2 workspace entries exist only while the development gate is enabled;
// the moment it is disabled every v2 link disappears from the workspace.
async function readV2WorkspaceReports(
  transaction: Transaction,
  equalHandoversV2: CollectionReference,
  actorUid: string,
) {
  const documents = [
    ...(await transaction.get(equalHandoversV2.where("identity.outgoingTechnicianIds", "array-contains", actorUid))).docs,
    ...(await transaction.get(equalHandoversV2.where("identity.incomingTechnicianIds", "array-contains", actorUid))).docs,
  ];
  return [...new Map(documents.map(doc => [doc.id, doc])).values()].map(doc => {
    const state = assertEqualHandoverAggregate(doc.data());
    return {
      shiftId: state.identity.outgoingShiftId,
      incomingShiftId: state.identity.incomingShiftId,
      status: state.lifecycleStatus,
      revision: state.revision,
      scheduledStart: state.identity.scheduledStart,
    };
  }).sort((a, b) => b.scheduledStart.localeCompare(a.scheduledStart));
}
export type HandoverWorkspaceData = Awaited<ReturnType<typeof getHandoverWorkspace>>;
