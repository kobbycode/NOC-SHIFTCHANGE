// TECH-HO-RECOVERY-09L — notification intent builders for authoritative
// handover + task events. Each builder takes the ALREADY-COMMITTED authoritative
// aggregate/event (never re-reads) and returns intents whose recipients come
// from that authoritative identity. These are pure; the caller writes them
// transactionally via writeOutboxEntries and only when notificationsEnabled().
import {
  NOTIFICATION_EVENT_KINDS,
  type NotificationIntent,
} from "@/types/notification";
import {
  EQUAL_HANDOVER_POSITIONS,
  type EqualHandoverAggregate,
} from "@/types/equal-technician-handover";
import { buildNotificationIntents } from "./notification-domain";

function handoverRefs(aggregate: EqualHandoverAggregate) {
  return {
    outgoingShiftId: aggregate.identity.outgoingShiftId,
    incomingShiftId: aggregate.identity.incomingShiftId,
    handoverId: aggregate.reservation.handoverId,
  };
}

function allParticipants(aggregate: EqualHandoverAggregate): string[] {
  return [...aggregate.identity.outgoingTechnicianIds, ...aggregate.identity.incomingTechnicianIds];
}

// Reservation created/replaced: tell everyone a handover is upcoming, and tell
// the outgoing pair their confirmation is required. Cancel emits no intent.
export function reservationIntents(aggregate: EqualHandoverAggregate, now: string): NotificationIntent[] {
  const eventId = `${aggregate.reservation.handoverId}:${aggregate.revision}`;
  const refs = handoverRefs(aggregate);
  return [
    ...buildNotificationIntents({
      eventKind: NOTIFICATION_EVENT_KINDS.HANDOVER_RESERVATION_UPCOMING,
      eventId, recipientUids: allParticipants(aggregate), refs, createdAt: now,
    }),
    ...buildNotificationIntents({
      eventKind: NOTIFICATION_EVENT_KINDS.OUTGOING_CONFIRMATION_REQUIRED,
      eventId, recipientUids: [...aggregate.identity.outgoingTechnicianIds], refs, createdAt: now,
    }),
  ];
}

// After a confirmation, remind the participants who have NOT yet personally
// confirmed that their confirmation is still required. A confirmation event
// never notifies the confirming technician as if someone else confirmed.
export function confirmationIntents(aggregate: EqualHandoverAggregate, now: string): NotificationIntent[] {
  const confirmedPositions = new Set(aggregate.confirmations.map((item) => item.position));
  const byPosition: Array<[string, string]> = [
    [EQUAL_HANDOVER_POSITIONS.OUTGOING_TECH_A, aggregate.identity.outgoingTechnicianIds[0]],
    [EQUAL_HANDOVER_POSITIONS.OUTGOING_TECH_B, aggregate.identity.outgoingTechnicianIds[1]],
    [EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_A, aggregate.identity.incomingTechnicianIds[0]],
    [EQUAL_HANDOVER_POSITIONS.INCOMING_TECH_B, aggregate.identity.incomingTechnicianIds[1]],
  ];
  const recipients = byPosition.filter(([position]) => !confirmedPositions.has(position as never)).map(([, uid]) => uid);
  return buildNotificationIntents({
    eventKind: NOTIFICATION_EVENT_KINDS.OUTGOING_CONFIRMATION_REQUIRED,
    eventId: `${aggregate.reservation.handoverId}:${aggregate.revision}`,
    recipientUids: recipients,
    refs: handoverRefs(aggregate),
    createdAt: now,
  });
}

// Outgoing commit: the incoming pair must now personally accept.
export function commitIntents(aggregate: EqualHandoverAggregate, now: string): NotificationIntent[] {
  return buildNotificationIntents({
    eventKind: NOTIFICATION_EVENT_KINDS.INCOMING_ACCEPTANCE_REQUIRED,
    eventId: `${aggregate.reservation.handoverId}:${aggregate.revision}`,
    recipientUids: [...aggregate.identity.incomingTechnicianIds],
    refs: handoverRefs(aggregate),
    createdAt: now,
  });
}

// Documented absence: surfaced to all four participants for transparency. The
// absence is a status change, never a confirmation.
export function absenceIntents(aggregate: EqualHandoverAggregate, now: string): NotificationIntent[] {
  return buildNotificationIntents({
    eventKind: NOTIFICATION_EVENT_KINDS.HANDOVER_ABSENCE_RECORDED,
    eventId: `${aggregate.reservation.handoverId}:${aggregate.revision}`,
    recipientUids: allParticipants(aggregate),
    refs: handoverRefs(aggregate),
    createdAt: now,
  });
}

// Handover completed (successor activated): notify all four participants.
export function completionIntents(aggregate: EqualHandoverAggregate, now: string): NotificationIntent[] {
  return buildNotificationIntents({
    eventKind: NOTIFICATION_EVENT_KINDS.HANDOVER_COMPLETED,
    eventId: `${aggregate.reservation.handoverId}:${aggregate.revision}`,
    recipientUids: allParticipants(aggregate),
    refs: handoverRefs(aggregate),
    createdAt: now,
  });
}

// A shift is live. Owner-approved recipients: the partner of whichever
// technician acted (started or joined), never the acting technician. A partner
// absent from the roster (e.g. a temporary technician acting alone) yields no
// intent rather than a notification to nobody.
export function shiftStartedIntents(input: {
  shiftId: string;
  partnerUid: string | null;
  createdAt: string;
}): NotificationIntent[] {
  return buildNotificationIntents({
    eventKind: NOTIFICATION_EVENT_KINDS.SHIFT_STARTED,
    eventId: `${input.shiftId}:started`,
    recipientUids: input.partnerUid ? [input.partnerUid] : [],
    refs: { incomingShiftId: input.shiftId },
    createdAt: input.createdAt,
  });
}

// Handover initiated (shift locked into handover): notify the outgoing pair.
// The incoming roster is not authoritative until reservation, so it is not used.
export function initiationIntents(outgoingShiftId: string, outgoingTechnicianIds: string[], now: string): NotificationIntent[] {
  return buildNotificationIntents({
    eventKind: NOTIFICATION_EVENT_KINDS.HANDOVER_INITIATED,
    eventId: `${outgoingShiftId}:initiated`,
    recipientUids: outgoingTechnicianIds,
    refs: { outgoingShiftId },
    createdAt: now,
  });
}

export function taskAssignedIntents(input: {
  eventId: string;
  assigneeUid: string;
  taskId: string;
  createdAt: string;
}): NotificationIntent[] {
  return buildNotificationIntents({
    eventKind: NOTIFICATION_EVENT_KINDS.TASK_ASSIGNED,
    eventId: input.eventId,
    recipientUids: [input.assigneeUid],
    refs: { taskId: input.taskId },
    createdAt: input.createdAt,
  });
}

export function taskReassignedIntents(input: {
  eventId: string;
  newAssigneeUid: string;
  previousAssigneeUid?: string | null;
  taskId: string;
  createdAt: string;
}): NotificationIntent[] {
  return buildNotificationIntents({
    eventKind: NOTIFICATION_EVENT_KINDS.TASK_REASSIGNED,
    eventId: input.eventId,
    recipientUids: [input.newAssigneeUid, input.previousAssigneeUid ?? null].filter((v): v is string => !!v),
    refs: { taskId: input.taskId },
    createdAt: input.createdAt,
  });
}

// Outstanding-task transfer during handover: notify the incoming technicians who
// now carry the task. Recipients come from the authoritative successor roster.
export function taskTransferIntents(input: {
  eventId: string;
  incomingTechnicianUids: string[];
  taskId: string;
  outgoingShiftId: string;
  incomingShiftId: string;
  createdAt: string;
}): NotificationIntent[] {
  return buildNotificationIntents({
    eventKind: NOTIFICATION_EVENT_KINDS.TASK_TRANSFER_OUTSTANDING,
    eventId: input.eventId,
    recipientUids: input.incomingTechnicianUids,
    refs: { taskId: input.taskId, outgoingShiftId: input.outgoingShiftId, incomingShiftId: input.incomingShiftId },
    createdAt: input.createdAt,
  });
}
