import "server-only";

import type { Transaction } from "firebase-admin/firestore";

import { readOperationStations, readShiftOperationEvents } from "./shift-operations";
import { assembleShiftOperations } from "./shift-operations-domain";

export const HANDOVER_OPERATIONAL_EVIDENCE_INCOMPLETE =
  "HANDOVER_OPERATIONAL_EVIDENCE_INCOMPLETE";

/*
 * V2 handover-begin completeness preflight (09M.1).
 *
 * The record-derived mandatory evidence is exactly the set that would later
 * block the consolidated report from being frozen: a verified (not
 * "not_verified") broadcast observation for every enabled station and a
 * non-conflicting outside-broadcast position (an outside-broadcast report or
 * an explicit authenticated no-OB declaration). Pending-task and attendance
 * concerns are deliberately excluded — they are not prerequisites for opening
 * the handover.
 */
export function missingHandoverEvidenceRequirements(
  shiftId: string,
  stations: readonly { id: string; name: string }[],
  events: Parameters<typeof assembleShiftOperations>[3],
): string[] {
  const { completeness } = assembleShiftOperations(shiftId, true, [...stations], [...events]);
  const missing: string[] = completeness.broadcastMissing.map(
    (name) => `Missing verified broadcast observation: ${name}`,
  );
  if (["missing", "conflicting"].includes(completeness.outsideBroadcast)) {
    missing.push(`Outside broadcast information is ${completeness.outsideBroadcast}.`);
  }
  return missing;
}

export class OperationalEvidenceIncompleteError extends Error {
  readonly status = 409;
  readonly code = HANDOVER_OPERATIONAL_EVIDENCE_INCOMPLETE;

  constructor(readonly missingRequirements: readonly string[]) {
    super(
      `Record the missing operational evidence before beginning this handover: ${missingRequirements.join("; ")}`,
    );
    this.name = "OperationalEvidenceIncompleteError";
  }
}

/*
 * Reads inside the caller's Firestore transaction: if evidence changes between
 * this check and the commit, the transaction aborts and reruns, so the
 * rejection and the transition always reflect the same document state. There
 * is no acknowledgment override, supervisor bypass, or flag — the only way to
 * satisfy the preflight is to record the evidence through the authenticated
 * operational-record workflow.
 */
export async function assertHandoverOperationalEvidenceComplete(
  transaction: Transaction,
  shiftId: string,
): Promise<void> {
  const stations = await readOperationStations(transaction);
  const events = await readShiftOperationEvents(transaction, shiftId);
  const missing = missingHandoverEvidenceRequirements(shiftId, stations, events);
  if (missing.length > 0) throw new OperationalEvidenceIncompleteError(missing);
}
