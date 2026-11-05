import "server-only";

import {
  type CollectionReference,
  type Transaction,
} from "firebase-admin/firestore";

import {
  ACTIVATED_SHIFT_STATUSES,
  readFirstShiftBootstrapEvidence,
  type FirstShiftBootstrapEvidence,
} from "./first-shift-bootstrap-domain";

import type {
  Query,
} from "firebase-admin/firestore";

/**
 * Bounded read of the activation ledger. One row is enough: the question is
 * whether any shift has ever been activated, not how many have been.
 */
function activatedShiftQuery(
  shifts: CollectionReference
): Query {
  return shifts
    .where(
      "status",
      "in",
      [...ACTIVATED_SHIFT_STATUSES]
    )
    .limit(1);
}

function toEvidence(
  snapshot: {
    docs: Array<{ id: string; data: () => Record<string, unknown> }>;
  }
): FirstShiftBootstrapEvidence {
  const document = snapshot.docs[0];

  if (!document) {
    return readFirstShiftBootstrapEvidence(null);
  }

  return readFirstShiftBootstrapEvidence({
    shiftId: document.id,
    shiftStatus: document.data().status,
  });
}

export async function readFirstShiftBootstrapEvidenceInTransaction(
  transaction: Transaction,
  shifts: CollectionReference
): Promise<FirstShiftBootstrapEvidence> {
  return toEvidence(
    await transaction.get(
      activatedShiftQuery(shifts)
    )
  );
}

export async function readFirstShiftBootstrapEvidenceFromDatabase(
  shifts: CollectionReference
): Promise<FirstShiftBootstrapEvidence> {
  return toEvidence(
    await activatedShiftQuery(shifts).get()
  );
}
