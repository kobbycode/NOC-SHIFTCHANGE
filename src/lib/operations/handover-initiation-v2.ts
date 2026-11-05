import "server-only";

import { getOperationalCollections, GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID } from "./collections";
import { evaluateAssignmentEligibility } from "./assignment-eligibility";
import { readActivePermanentPairTechnicianIds } from "./next-shift-authorization-domain";
import { assertHandoverAggregate, createHandoverDocumentId } from "./handover-domain";
import { assertHandoverReservationGuard, createHandoverReservationGuardDocumentId } from "./handover-reservation-guard-domain";
import { createEqualHandoverDocumentId } from "./equal-technician-handover-domain";

// ---------------------------------------------------------------------------
// READ-ONLY INITIATION PROJECTION for the equal-technician (v2) handover.
//
// This module never writes. It mirrors, for display only, the exact
// preconditions that `beginEqualTechnicianShiftHandover` and
// `initializeEqualHandoverReservation` re-derive inside their own
// transactions. The technician interface posts exclusively to those existing
// routes, so hiding or disabling a control here can never grant authority, and
// showing one can never bypass a server-side check.
// ---------------------------------------------------------------------------

export type EqualHandoverInitiationStep = "begin" | "reserve" | "unavailable";

export interface EqualHandoverInitiationCandidate {
  pairId: string;
  label: string;
  technicianUids: [string, string];
}

export interface EqualHandoverInitiationContext {
  outgoingShiftId: string;
  actorUid: string;
  step: EqualHandoverInitiationStep;
  shiftStatus: string | null;
  permanentPairId: string | null;
  outgoingTechnicianIds: string[];
  isOutgoingTechnician: boolean;
  ownsOperationalSlot: boolean;
  reservationExists: boolean;
  blockers: string[];
  candidates: EqualHandoverInitiationCandidate[];
  outgoingWindow: { scheduledStart: string | null; scheduledEnd: string | null };
  suggested: { shiftType: "morning" | "night"; scheduledStart: string; scheduledEnd: string } | null;
}

const INITIABLE_STATUSES = ["active", "handover_pending"] as const;

function usableIdentifier(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !value.includes("/") && value !== "." && value !== "..";
}

function canonicalPair(value: readonly string[]): [string, string] {
  return [value[0]!, value[1]!];
}

function clock(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function blocked(
  base: EqualHandoverInitiationContext,
  step: EqualHandoverInitiationStep,
  blockers: string[],
): EqualHandoverInitiationContext {
  return { ...base, step, blockers };
}

async function loadCandidatePairs(
  outgoingPairId: string,
  outgoingIds: readonly string[],
): Promise<EqualHandoverInitiationCandidate[]> {
  const { db, technicianPairs, technicianPairMemberships } = getOperationalCollections();
  const documents = (await technicianPairs.where("status", "==", "active").get()).docs;
  const candidates: EqualHandoverInitiationCandidate[] = [];
  const sameOutgoingPair = new Set(outgoingIds);
  for (const document of documents) {
    if (document.id === outgoingPairId) continue;
    let ids: [string, string];
    try {
      ids = readActivePermanentPairTechnicianIds(document.data(), document.id);
    } catch {
      continue;
    }
    if (ids.every((uid) => sameOutgoingPair.has(uid))) continue;
    const memberships = await Promise.all(ids.map((uid) => technicianPairMemberships.doc(uid).get()));
    if (!memberships.every((snapshot, index) =>
      snapshot.data()?.technicianUid === ids[index] && snapshot.data()?.pairId === document.id)) continue;
    const profiles = await Promise.all(ids.map((uid) => db.collection("users").doc(uid).get()));
    const eligible = profiles.map((snapshot) => evaluateAssignmentEligibility(snapshot.data()));
    if (!eligible.every((result) => result.eligible)) continue;
    candidates.push({
      pairId: document.id,
      label: profiles.map((snapshot) => String(snapshot.data()?.fullName ?? snapshot.id)).join(" + "),
      technicianUids: canonicalPair(ids),
    });
  }
  return candidates.sort((a, b) => a.label.localeCompare(b.label) || a.pairId.localeCompare(b.pairId));
}

export async function readEqualHandoverInitiationContext(
  actorUid: string,
  outgoingShiftId: string,
  options: { includeCandidates?: boolean } = {},
): Promise<EqualHandoverInitiationContext> {
  const empty: EqualHandoverInitiationContext = {
    outgoingShiftId,
    actorUid,
    step: "unavailable",
    shiftStatus: null,
    permanentPairId: null,
    outgoingTechnicianIds: [],
    isOutgoingTechnician: false,
    ownsOperationalSlot: false,
    reservationExists: false,
    blockers: [],
    candidates: [],
    outgoingWindow: { scheduledStart: null, scheduledEnd: null },
    suggested: null,
  };
  if (!usableIdentifier(actorUid, 128) || !usableIdentifier(outgoingShiftId)) {
    return blocked(empty, "unavailable", ["Invalid shift or account identifier."]);
  }

  const { db, shifts, shiftAttendance, operationalShiftControl, equalHandoversV2, handovers, handoverReservationGuards } =
    getOperationalCollections();
  const [profileSnapshot, shiftSnapshot, controlSnapshot, aggregateSnapshot, legacySnapshot, guardSnapshot, actorAttendanceSnapshot] =
    await Promise.all([
      db.collection("users").doc(actorUid).get(),
      shifts.doc(outgoingShiftId).get(),
      operationalShiftControl.doc(GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID).get(),
      equalHandoversV2.doc(createEqualHandoverDocumentId(outgoingShiftId)).get(),
      handovers.doc(createHandoverDocumentId(outgoingShiftId)).get(),
      handoverReservationGuards.doc(createHandoverReservationGuardDocumentId(outgoingShiftId)).get(),
      shiftAttendance.doc(`${outgoingShiftId}_${actorUid}`).get(),
    ]);

  const profile = profileSnapshot.data();
  if (!profile || profile.role !== "technician" || profile.status !== "active" ||
      profile.mustChangePassword === true || profile.statusOperation != null) {
    return blocked(empty, "unavailable", ["Only an active technician account can begin an equal-technician handover."]);
  }
  if (!shiftSnapshot.exists) return blocked(empty, "unavailable", ["The outgoing shift was not found."]);

  const shift = shiftSnapshot.data();
  if (!shift) return blocked(empty, "unavailable", ["The outgoing shift was not found."]);
  const shiftStatus = typeof shift.status === "string" ? shift.status : null;
  const scheduledStart = clock(shift.scheduledStart);
  const scheduledEnd = clock(shift.scheduledEnd);
  const permanentPairId = usableIdentifier(shift.permanentPairId) ? shift.permanentPairId : null;

  let outgoingIds: readonly string[] = [];
  if (permanentPairId) {
    try {
      const pair = await db.collection("technician_pairs").doc(permanentPairId).get();
      outgoingIds = readActivePermanentPairTechnicianIds(pair.data(), permanentPairId);
    } catch {
      outgoingIds = [];
    }
  }

  const primaryIds = Array.isArray(shift.primaryTechnicianIds) ? shift.primaryTechnicianIds : [];
  const isOutgoingTechnician = outgoingIds.includes(actorUid) && primaryIds.includes(actorUid);
  const context: EqualHandoverInitiationContext = {
    ...empty,
    shiftStatus,
    permanentPairId,
    outgoingTechnicianIds: [...outgoingIds],
    isOutgoingTechnician,
    outgoingWindow: { scheduledStart, scheduledEnd },
  };

  const control = controlSnapshot.data();
  const ownsOperationalSlot = control?.slotStatus === "consumed" && control?.shiftId === outgoingShiftId &&
    control?.slotToken === shift.operationalSlotToken && control?.shiftStatus === shiftStatus;
  context.ownsOperationalSlot = ownsOperationalSlot;

  const reservationExists = aggregateSnapshot.exists;
  context.reservationExists = reservationExists;

  if (!INITIABLE_STATUSES.includes(shiftStatus as (typeof INITIABLE_STATUSES)[number])) {
    return blocked(context, "unavailable",
      [`This shift is ${shiftStatus ?? "unknown"} and cannot start an equal-technician handover.`]);
  }
  if (reservationExists) {
    return blocked(context, "unavailable", ["An equal-technician handover already exists for this shift. Reopen the report workflow."]);
  }
  if (!isOutgoingTechnician) {
    return blocked(context, "unavailable", ["Only an outgoing permanent-pair technician of this shift can initiate its handover."]);
  }
  if (!actorAttendanceSnapshot.exists) {
    return blocked(context, "unavailable", ["You must join this shift before beginning its handover. A colleague can attest your absence."]);
  }
  if (outgoingIds.length !== 2) {
    return blocked(context, "unavailable", ["The outgoing shift has no active permanent technician pair."]);
  }
  if (primaryIds.length !== 2) {
    return blocked(context, "unavailable", ["The shift must have exactly two primary technicians before it can hand over."]);
  }
  if (!permanentPairId) {
    return blocked(context, "unavailable", ["The outgoing shift has no permanent technician pair."]);
  }
  if (!controlSnapshot.exists) {
    return blocked(context, "unavailable", ["The global operational shift control is unavailable."]);
  }
  if (!ownsOperationalSlot) {
    return blocked(context, "unavailable", ["The selected shift does not occupy the current global operational slot."]);
  }
  if (!scheduledStart || !scheduledEnd) {
    return blocked(context, "unavailable", ["The shift has invalid scheduling information."]);
  }

  // Legacy v1 evidence (§7 of the reservation contract) blocks v2 initiation
  // until administrator review, exactly as the reservation writer requires.
  if (legacySnapshot.exists) {
    let legacyCancelled = false;
    try {
      legacyCancelled = assertHandoverAggregate(legacySnapshot.data()).lifecycleStatus === "cancelled";
    } catch {
      legacyCancelled = false;
    }
    if (!legacyCancelled) {
      return blocked(context, "unavailable", ["A legacy v1 handover reservation exists for this shift; administrator review is required."]);
    }
  }
  if (guardSnapshot.exists) {
    let owner: string | null = null;
    try {
      owner = assertHandoverReservationGuard(guardSnapshot.data()).protocolOwner;
    } catch {
      owner = null;
    }
    if (owner !== "v2") {
      return blocked(context, "unavailable", ["The reservation guard for this shift is not owned by protocol v2; administrator review is required."]);
    }
  }

  if (shiftStatus === "active") {
    const started = typeof shift.actualStart === "string" && Number.isFinite(Date.parse(shift.actualStart));
    if (!started || shift.actualEnd != null) {
      return blocked(context, "unavailable", ["The shift is not running with a valid activation record."]);
    }
    return { ...context, step: "begin", blockers: [] };
  }

  const duration = Date.parse(scheduledEnd) - Date.parse(scheduledStart);
  const incomingStart = new Date(Date.parse(scheduledEnd));
  const incomingEnd = new Date(incomingStart.getTime() + (duration > 0 && duration <= 24 * 60 * 60 * 1000 ? duration : 8 * 60 * 60 * 1000));
  const suggested = {
    shiftType: shift.shiftType === "night" ? "night" as const : "morning" as const,
    scheduledStart: incomingStart.toISOString(),
    scheduledEnd: incomingEnd.toISOString(),
  };
  const candidates = options.includeCandidates === false ? [] : await loadCandidatePairs(permanentPairId, outgoingIds);
  return { ...context, step: "reserve", blockers: [], candidates, suggested };
}

// Workspace discovery: the technician handover list only links v2 aggregates
// that already exist, so an eligible shift with no aggregate would otherwise
// have no entry point at all.
export async function listEqualHandoverInitiationShifts(actorUid: string) {
  if (!usableIdentifier(actorUid, 128)) return [];
  const { shifts } = getOperationalCollections();
  const documents = (await shifts.where("status", "in", [...INITIABLE_STATUSES]).get()).docs;
  const initiations: EqualHandoverInitiationContext[] = [];
  for (const document of documents) {
    const context = await readEqualHandoverInitiationContext(actorUid, document.id, { includeCandidates: false });
    if (context.step !== "unavailable") initiations.push(context);
  }
  return initiations.sort((a, b) =>
    (b.outgoingWindow.scheduledStart ?? "").localeCompare(a.outgoingWindow.scheduledStart ?? ""));
}
