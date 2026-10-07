
import "server-only";

import {
  FieldValue,
  type Transaction,
} from "firebase-admin/firestore";

import {
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  evaluateAssignmentEligibility,
} from "./assignment-eligibility";
import { validateTaskAssignmentHistory } from "./assignment-generation-domain";

export function requireValidTaskAssignmentHistory(taskId: string, documents: readonly { id: string; data(): unknown }[]) {
  try {
    return validateTaskAssignmentHistory(taskId, documents.map(document => ({ id: document.id, data: document.data() })));
  } catch {
    throw new AssignmentOperationError("Malformed assignment generation history; administrator review required.", 409);
  }
}

export class AssignmentOperationError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);

    this.name = "AssignmentOperationError";
  }
}

/**
 * Verifies that a technician can receive an assignment.
 *
 * This function must be called inside the same Firestore
 * transaction that creates the operational assignment.
 *
 * All transaction reads must occur before any writes.
 */
export async function requireEligibleTechnician(
  transaction: Transaction,
  technicianUid: string
): Promise<void> {
  if (
    !technicianUid ||
    technicianUid.includes("/") ||
    technicianUid.length > 128
  ) {
    throw new AssignmentOperationError(
      "Please select a valid technician.",
      400
    );
  }

  const db = getAdminFirestore();

  const userRef = db
    .collection("users")
    .doc(technicianUid);

  const userSnapshot = await transaction.get(
    userRef
  );

  const result = evaluateAssignmentEligibility(
    userSnapshot.data()
  );

  if (!result.eligible) {
    throw new AssignmentOperationError(
      result.message ??
        "This technician cannot receive assignments.",
      409
    );
  }
}

/**
 * Transactionally reserves the technician account
 * against concurrent account-status changes.
 *
 * The user document is deliberately written as part
 * of the assignment transaction.
 */
export function markAssignmentActivity(
  transaction: Transaction,
  technicianUid: string
): void {
  const db = getAdminFirestore();

  const userRef = db
    .collection("users")
    .doc(technicianUid);

  transaction.update(userRef, {
    lastAssignmentActivityAt:
      FieldValue.serverTimestamp(),
  });
}
