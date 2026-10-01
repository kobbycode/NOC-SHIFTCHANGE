import "server-only";

import {
  type CollectionReference,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";

import {
  randomUUID,
} from "node:crypto";

import {
  SHIFT_STATUSES,
} from "@/types/shift";

import {
  AssignmentOperationError,
} from "./assignment-transaction";

import {
  GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID,
  getOperationalCollections,
} from "./collections";

import {
  adoptOperationalShiftControl,
  assertOperationalShiftControl,
  createPendingOperationalShiftControl,
  type OperationalShiftControl,
} from "./operational-shift-control-state";

interface LoadedOperationalShiftControl {
  control: OperationalShiftControl;
  persisted: boolean;
  adoptedExistingShift: boolean;
}

function asOperationalShiftControl(
  value: unknown
): OperationalShiftControl {
  try {
    return assertOperationalShiftControl(value);
  } catch {
    throw new AssignmentOperationError(
      "The global operational shift-control record requires administrator review.",
      409
    );
  }
}

function validateActor(
  snapshot: {
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
  }
): void {
  const actor = snapshot.data();

  if (
    !snapshot.exists ||
    !actor ||
    actor.status !== "active" ||
    actor.statusOperation != null ||
    actor.mustChangePassword === true ||
    !["admin", "supervisor"].includes(
      actor.role as string
    )
  ) {
    throw new AssignmentOperationError(
      "Your account is not authorized to manage operational shifts.",
      403
    );
  }
}

/**
 * Transactionally initialize the singleton control record.
 * Empty installations receive one pending slot. A single legacy
 * occupying shift is adopted; ambiguous legacy state fails closed.
 */
export async function ensureOperationalShiftControl(
  actorUid: string
): Promise<void> {
  if (
    !actorUid ||
    actorUid.includes("/") ||
    actorUid.length > 128
  ) {
    throw new AssignmentOperationError(
      "Please sign in with a valid account.",
      400
    );
  }

  const {
    db,
    shifts,
    operationalShiftControl,
  } = getOperationalCollections();

  const controlRef =
    operationalShiftControl.doc(
      GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID
    );

  const actorRef = db
    .collection("users")
    .doc(actorUid);

  await db.runTransaction(
    async (transaction) => {
      const [
        actorSnapshot,
        controlSnapshot,
      ] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(controlRef),
      ]);

      validateActor(actorSnapshot);

      const now =
        new Date().toISOString();
      const loadedControl =
        await loadOrBootstrapOperationalShiftControl(
          transaction,
          controlRef,
          controlSnapshot,
          shifts,
          now
        );

      if (!loadedControl.persisted) {
        transaction.create(
          controlRef,
          loadedControl.control
        );
      }
    }
  );
}

export function readOperationalShiftControl(
  value: unknown
): OperationalShiftControl {
  return asOperationalShiftControl(value);
}

export async function loadOrBootstrapOperationalShiftControl(
  transaction: Transaction,
  controlRef: DocumentReference,
  controlSnapshot: DocumentSnapshot,
  shifts: CollectionReference,
  now: string
): Promise<LoadedOperationalShiftControl> {
  if (controlSnapshot.exists) {
    return {
      control: asOperationalShiftControl(
        controlSnapshot.data()
      ),
      persisted: true,
      adoptedExistingShift: false,
    };
  }

  const occupyingShifts =
    await transaction.get(
      shifts.where(
        "status",
        "in",
        [
          SHIFT_STATUSES.SCHEDULED,
          SHIFT_STATUSES.ACTIVE,
          SHIFT_STATUSES.HANDOVER_PENDING,
        ]
      )
    );

  if (occupyingShifts.size > 1) {
    throw new AssignmentOperationError(
      "Multiple unfinished shifts exist without global control state. Resolve them before continuing.",
      409
    );
  }

  if (occupyingShifts.empty) {
    return {
      control:
        createPendingOperationalShiftControl(
          randomUUID(),
          1,
          now
        ),
      persisted: false,
      adoptedExistingShift: false,
    };
  }

  const legacyShiftDocument =
    occupyingShifts.docs[0];
  const legacyShift =
    legacyShiftDocument.data();

  if (
    !legacyShift ||
    legacyShift.id !== legacyShiftDocument.id ||
    legacyShift.operationalSlotToken != null
  ) {
    throw new AssignmentOperationError(
      "The unfinished shift cannot be safely adopted into global control state.",
      409
    );
  }

  let adoptedControl: OperationalShiftControl;

  try {
    adoptedControl = adoptOperationalShiftControl(
      randomUUID(),
      legacyShiftDocument.id,
      legacyShift.status,
      now
    );
  } catch {
    throw new AssignmentOperationError(
      "The unfinished shift cannot be safely adopted into global control state.",
      409
    );
  }

  transaction.update(
    legacyShiftDocument.ref,
    {
      operationalSlotToken:
        adoptedControl.slotToken,
    }
  );
  transaction.create(
    controlRef,
    adoptedControl
  );

  return {
    control: adoptedControl,
    persisted: true,
    adoptedExistingShift: true,
  };
}