
export type RevocationTargetRole =
  | "admin"
  | "supervisor"
  | "technician";

export type RevocationAccountStatus =
  | "active"
  | "blocked"
  | "revoked";

export type RevocationShiftStatus =
  | "scheduled"
  | "active"
  | "handover_pending"
  | "completed"
  | "cancelled";

export interface RevocationShift {
  id: string;
  status: RevocationShiftStatus;
  technicianIds: string[];
}

export interface RevocationTask {
  id: string;
  status: string;
  leadTechnicianId: string;
  primaryPartnerId: string | null;
}

export interface RevocationEligibilityInput {
  actorUid: string;
  actorRole: RevocationTargetRole;

  originalAdminUid: string;

  targetUid: string;
  targetRole: RevocationTargetRole;
  targetStatus: RevocationAccountStatus;

  hasPendingAccountOperation: boolean;

  shifts: RevocationShift[];
  unfinishedTasks: RevocationTask[];

  eligiblePartnerIds: string[];
}

export interface RevocationEligibilityResult {
  eligible: boolean;
  errors: string[];
  taskTransfers: {
    taskId: string;
    fromUid: string;
    toUid: string;
  }[];
}

export function evaluateRevocationEligibility(
  input: RevocationEligibilityInput
): RevocationEligibilityResult {
  const errors: string[] = [];

  const taskTransfers:
    RevocationEligibilityResult["taskTransfers"] = [];

  if (input.actorRole !== "admin") {
    errors.push(
      "Only administrators can revoke user accounts."
    );
  }

  if (input.actorUid === input.targetUid) {
    errors.push(
      "You cannot revoke your own account."
    );
  }

  if (input.targetUid === input.originalAdminUid) {
    errors.push(
      "The original administrator account cannot be revoked."
    );
  }

  if (
    input.targetRole === "admin" &&
    input.actorUid !== input.originalAdminUid
  ) {
    errors.push(
      "Only the original administrator can revoke another administrator."
    );
  }

  if (input.targetStatus === "revoked") {
    errors.push(
      "This account has already been permanently revoked."
    );
  }

  if (input.hasPendingAccountOperation) {
    errors.push(
      "Another account-management operation is already in progress."
    );
  }

  const activeShifts = input.shifts.filter(
    (shift) =>
      shift.technicianIds.includes(input.targetUid) &&
      (
        shift.status === "active" ||
        shift.status === "handover_pending"
      )
  );

  if (activeShifts.length > 0) {
    errors.push(
      "This technician has an active shift or an unfinished handover. Complete the shift before revoking the account."
    );
  }

  for (const task of input.unfinishedTasks) {
    if (task.leadTechnicianId !== input.targetUid) {
      continue;
    }

    const partnerId = task.primaryPartnerId;

    if (
      !partnerId ||
      partnerId === input.targetUid ||
      !input.eligiblePartnerIds.includes(partnerId)
    ) {
      errors.push(
        `Task ${task.id} cannot be transferred because an eligible primary shift partner is unavailable.`
      );

      continue;
    }

    taskTransfers.push({
      taskId: task.id,
      fromUid: input.targetUid,
      toUid: partnerId,
    });
  }

  return {
    eligible: errors.length === 0,
    errors,
    taskTransfers:
      errors.length === 0 ? taskTransfers : [],
  };
}