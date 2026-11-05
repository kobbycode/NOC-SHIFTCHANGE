// TECH-HO-RECOVERY-09K — supervisor read-only visibility over the equal-technician
// v2 handover. This module is deliberately SEPARATE from the shared
// handover-workspace contract (which keeps `v2Reports: []` for managers so that
// technicians alone drive the v2 workflow). Here we expose the authoritative v2
// report state to a supervisor for OBSERVATION ONLY: no mutation service is
// reachable through this module and none is added.
import "server-only";
import type { AppUser } from "@/types/auth";
import { getOperationalCollections } from "./collections";
import { ShiftOperationsError } from "./shift-operations-domain";
import { readEqualHandoverReportState } from "./equal-handover-report-firestore";
import { EQUAL_HANDOVER_PARTICIPANT_STATES } from "@/types/equal-technician-handover";
import { ATTENDANCE_EVIDENCE_KINDS } from "@/types/attendance-evidence";
import type { EqualHandoverReportState } from "./equal-handover-report-firestore";
import { readSupervisorNotificationActivity, type SupervisorNotificationActivity } from "@/lib/notifications/supervisor-notification-activity";

export type SupervisorV2ParticipantView = {
  uid: string;
  name: string | null;
  confirmed: boolean;
  absent: boolean;
  confirmationTimestamp: string | null;
  absenceType: string | null;
  attestedByUid: string | null;
};

// Per-incoming-technician acceptance, read ONLY from the persisted
// attendance-evidence-v2 records the acceptance flow writes. A completed
// handover's report intentionally returns the immutable frozen (pre-acceptance)
// content, so acceptance timestamps live here, never inferred from a
// confirmation, the pair roster, the schedule or the successor shift status.
export type SupervisorV2AcceptanceView = {
  uid: string;
  position: string;
  kind: string | null;
  personallyAuthenticated: boolean;
  authenticationMethod: string | null;
  acceptedAt: string | null;
  lateReason: string | null;
};

export type SupervisorV2HandoverDetailView = {
  state: EqualHandoverReportState;
  incomingAcceptance: SupervisorV2AcceptanceView[];
  notificationActivity: SupervisorNotificationActivity;
};

export type SupervisorV2HandoverRow = {
  outgoingShiftId: string;
  incomingShiftId: string | null;
  lifecycleStatus: string;
  revision: number;
  scheduledStart: string | null;
  initiationAt: string | null;
  outgoingTeam: SupervisorV2ParticipantView[];
  incomingTeam: SupervisorV2ParticipantView[];
  confirmedCount: number;
  requiredConfirmations: number;
  absenceCount: number;
  // null means the authoritative readiness could not be derived from persisted
  // evidence for this row; the UI must show an accurate unavailable state.
  ready: boolean | null;
  blockers: string[];
  evidenceAvailable: boolean;
};

function isSupervisorProfile(profile: Record<string, unknown> | undefined): boolean {
  return !!profile &&
    profile.role === "supervisor" &&
    profile.status === "active" &&
    profile.statusOperation == null &&
    profile.mustChangePassword === false;
}

// Defense in depth: the supervisor layout already gates the route tree with
// requireUser(["supervisor"]); the service re-verifies the LIVE profile so a
// stale session, a demoted account, or a direct service call can never read.
async function requireSupervisorProfile(uid: string): Promise<void> {
  const { db } = getOperationalCollections();
  const snapshot = await db.collection("users").doc(uid).get();
  if (!isSupervisorProfile(snapshot.data() as Record<string, unknown> | undefined)) {
    throw new ShiftOperationsError("This account cannot view v2 handover reports.", 403);
  }
}

function timestampToIso(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const candidate = value as { toISOString?: () => string; toDate?: () => Date };
    if (typeof candidate.toISOString === "function") return candidate.toISOString.call(value);
    if (typeof candidate.toDate === "function") return candidate.toDate.call(value).toISOString();
  }
  return null;
}

// Builds the two team arrays from the authoritative report content (which
// carries real names) merged with the aggregate's per-position confirmations
// and absences. Confirmation state is read ONLY from aggregate.confirmations —
// never inferred from pair membership, schedule, notification or attendance.
function buildRow(
  outgoingShiftId: string,
  state: Awaited<ReturnType<typeof readEqualHandoverReportState>>,
): SupervisorV2HandoverRow {
  const { aggregate, readiness, live } = state;
  const nameByUid = new Map(live.content.participants.map((item) => [item.uid, item.name]));

  const viewFor = (position: string, uid: string): SupervisorV2ParticipantView => {
    const confirmation = aggregate.confirmations.find((item) => item.position === position);
    const absence = aggregate.absences.find((item) => item.position === position);
    return {
      uid,
      name: nameByUid.get(uid) ?? null,
      confirmed: !!confirmation,
      absent: !!absence,
      confirmationTimestamp: confirmation?.confirmedAt ?? null,
      absenceType: absence?.absenceType ?? null,
      attestedByUid: absence?.recordedBy ?? null,
    };
  };

  const blockers = [
    ...readiness.reasons.map((reason) => reason.replaceAll("_", " ")),
    ...live.content.completeness.blockers,
  ];

  return {
    outgoingShiftId,
    incomingShiftId: aggregate.identity.incomingShiftId ?? null,
    lifecycleStatus: aggregate.lifecycleStatus,
    revision: aggregate.revision,
    scheduledStart: aggregate.identity.scheduledStart ?? null,
    initiationAt: live.content.staff.handoverStartedAt ?? timestampToIso(aggregate.createdAt),
    outgoingTeam: aggregate.identity.outgoingTechnicianIds.map((uid, index) =>
      viewFor(index === 0 ? "outgoing_tech_a" : "outgoing_tech_b", uid)),
    incomingTeam: aggregate.identity.incomingTechnicianIds.map((uid, index) =>
      viewFor(index === 0 ? "incoming_tech_a" : "incoming_tech_b", uid)),
    confirmedCount: readiness.confirmedCount,
    requiredConfirmations: readiness.requiredConfirmations,
    absenceCount: aggregate.absences.length,
    ready: readiness.ready,
    blockers: [...new Set(blockers)],
    evidenceAvailable: true,
  };
}

// A row assembled when the full authoritative read fails (for example a
// mid-mutation or superseded aggregate). Only identity primitives that are safe
// to disclose to a supervisor are shown; readiness is marked unavailable.
function buildUnavailableRow(data: Record<string, unknown>, outgoingShiftId: string): SupervisorV2HandoverRow {
  const identity = (data.identity ?? {}) as Record<string, unknown>;
  const outgoingIds = Array.isArray(identity.outgoingTechnicianIds) ? identity.outgoingTechnicianIds as string[] : [];
  const incomingIds = Array.isArray(identity.incomingTechnicianIds) ? identity.incomingTechnicianIds as string[] : [];
  const confirmations = Array.isArray(data.confirmations) ? data.confirmations : [];
  const absences = Array.isArray(data.absences) ? data.absences : [];
  return {
    outgoingShiftId,
    incomingShiftId: typeof identity.incomingShiftId === "string" ? identity.incomingShiftId : null,
    lifecycleStatus: typeof data.lifecycleStatus === "string" ? data.lifecycleStatus : "unknown",
    revision: typeof data.revision === "number" ? data.revision : 0,
    scheduledStart: typeof identity.scheduledStart === "string" ? identity.scheduledStart : null,
    initiationAt: timestampToIso(data.createdAt),
    outgoingTeam: outgoingIds.map((uid) => ({ uid, name: null, confirmed: false, absent: false, confirmationTimestamp: null, absenceType: null, attestedByUid: null })),
    incomingTeam: incomingIds.map((uid) => ({ uid, name: null, confirmed: false, absent: false, confirmationTimestamp: null, absenceType: null, attestedByUid: null })),
    confirmedCount: confirmations.length,
    requiredConfirmations: 4,
    absenceCount: absences.length,
    ready: null,
    blockers: ["authoritative report evidence is unavailable — open the handover detail"],
    evidenceAvailable: false,
  };
}

export async function getSupervisorV2HandoverList(actor: AppUser): Promise<SupervisorV2HandoverRow[]> {
  await requireSupervisorProfile(actor.uid);
  const { equalHandoversV2 } = getOperationalCollections();

  // Supervisor authorized scope is every v2 handover, matching the existing V1
  // supervisor report/attendance readers (admin/supervisor read all). There is
  // no narrower supervisor partition in the current model to enforce against.
  const collection = await equalHandoversV2.get();
  const rows: SupervisorV2HandoverRow[] = [];
  for (const document of collection.docs) {
    const data = document.data() as Record<string, unknown>;
    const identity = (data.identity ?? {}) as Record<string, unknown>;
    const outgoingShiftId = typeof identity.outgoingShiftId === "string" ? identity.outgoingShiftId : "";
    if (!outgoingShiftId) continue;
    try {
      const state = await readEqualHandoverReportState(outgoingShiftId, actor.uid);
      rows.push(buildRow(outgoingShiftId, state));
    } catch {
      rows.push(buildUnavailableRow(data, outgoingShiftId));
    }
  }
  return rows.sort((a, b) => (b.scheduledStart ?? "").localeCompare(a.scheduledStart ?? ""));
}

// Reads the persisted incoming-acceptance evidence for one handover reservation.
// This is a pure read of the attendance-evidence-v2 records the acceptance flow
// already wrote; it never mutates and never synthesizes an acceptance.
async function readIncomingAcceptance(
  handoverId: string,
  outgoingShiftId: string,
): Promise<SupervisorV2AcceptanceView[]> {
  const { attendanceEvidenceV2 } = getOperationalCollections();
  const snapshot = await attendanceEvidenceV2.where("handoverId", "==", handoverId).get();
  const incomingKinds: string[] = [
    ATTENDANCE_EVIDENCE_KINDS.INCOMING_CLOCK_IN,
    ATTENDANCE_EVIDENCE_KINDS.INCOMING_LATE_ACCEPTANCE,
  ];
  const views = snapshot.docs
    .map((document) => document.data() as Record<string, unknown>)
    .filter((record) =>
      typeof record.technicianUid === "string" &&
      record.outgoingShiftId === outgoingShiftId &&
      incomingKinds.includes(String(record.kind)))
    .map((record) => ({
      uid: String(record.technicianUid),
      position: typeof record.position === "string" ? record.position : "",
      kind: typeof record.kind === "string" ? record.kind : null,
      personallyAuthenticated: record.personallyAuthenticated === true,
      authenticationMethod: typeof record.authenticationMethod === "string" ? record.authenticationMethod : null,
      acceptedAt: timestampToIso(record.clockIn) ?? timestampToIso(record.eventTime),
      lateReason: typeof record.lateReason === "string" ? record.lateReason : null,
    }));
  return views.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
}

export async function getSupervisorV2HandoverDetail(
  actor: AppUser,
  outgoingShiftId: string,
): Promise<SupervisorV2HandoverDetailView> {
  await requireSupervisorProfile(actor.uid);
  // readEqualHandoverReportState re-derives authority and live evidence inside
  // its own transaction; supervisors skip the technician participant gate and
  // receive a read-only guard. No mutation is ever reachable through this call.
  const state = await readEqualHandoverReportState(outgoingShiftId, actor.uid);
  const incomingAcceptance = await readIncomingAcceptance(
    state.aggregate.reservation.handoverId,
    state.aggregate.identity.outgoingShiftId,
  );
  // Read-only activity derived from the durable notification records. Never a
  // mutation, and never a fabricated delivery/view receipt.
  const notificationActivity = await readSupervisorNotificationActivity(state.aggregate.identity.outgoingShiftId);
  return { state, incomingAcceptance, notificationActivity };
}

export const SUPERVISOR_V2_PARTICIPANT_STATE = EQUAL_HANDOVER_PARTICIPANT_STATES;
