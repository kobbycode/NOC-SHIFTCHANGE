
import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  FieldValue,
} from "firebase-admin/firestore";

import {
  getCurrentUser,
} from "@/lib/auth/session";

import {
  getAdminAuth,
  getAdminFirestore,
} from "@/lib/firebase/admin";

import {
  requireSafeAccountBlocking,
  AccountOperationalError,
} from "@/lib/accounts/account-status-eligibility";

export const runtime = "nodejs";


type RouteContext = {
  params: Promise<{
    uid: string;
  }>;
};

class AccountStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "AccountStatusError";
  }
}

function errorResponse(
  message: string,
  status: number
) {
  return NextResponse.json(
    { error: message },
    { status }
  );
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext
) {
  /*
   * PHASE 1:
   * Authenticate the administrator.
   */

  const actor = await getCurrentUser();

  if (!actor) {
    return errorResponse(
      "Please sign in to continue.",
      401
    );
  }

  if (
    actor.role !== "admin" ||
    actor.mustChangePassword
  ) {
    return errorResponse(
      "Only authorized administrators can manage user accounts.",
      403
    );
  }

  /*
   * PHASE 2:
   * Validate the request.
   */

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      "Invalid request data.",
      400
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return errorResponse(
      "Invalid request data.",
      400
    );
  }

  const input =
    body as Record<string, unknown>;

  const action = input.action;

  const reason =
    typeof input.reason === "string"
      ? input.reason.trim()
      : "";

  if (
    action !== "block" &&
    action !== "unblock"
  ) {
    return errorResponse(
      "Choose a valid account-management action.",
      400
    );
  }

  if (
    reason.length < 10 ||
    reason.length > 500
  ) {
    return errorResponse(
      "Please provide a reason between 10 and 500 characters.",
      400
    );
  }

  const { uid } = await context.params;

  if (
    !uid ||
    uid.includes("/") ||
    uid.length > 128
  ) {
    return errorResponse(
      "Invalid user account.",
      400
    );
  }

  if (uid === actor.uid) {
    return errorResponse(
      "You cannot block or unblock your own account.",
      403
    );
  }

  /*
   * PHASE 3:
   * Prepare Firestore references.
   */

  const db = getAdminFirestore();
  const auth = getAdminAuth();

  const actorRef = db
    .collection("users")
    .doc(actor.uid);

  const userRef = db
    .collection("users")
    .doc(uid);

  const operationRef = db
    .collection("account_status_operations")
    .doc();

  const auditRef = db
    .collection("audit_logs")
    .doc();

  const operationId = operationRef.id;

  /*
   * PHASE 4:
   * Reserve the account-status operation.
   *
   * All transaction reads must finish
   * before transaction writes.
   */

  try {
    await db.runTransaction(
      async (transaction) => {
        const [
          actorSnapshot,
          targetSnapshot,
        ] = await Promise.all([
          transaction.get(actorRef),
          transaction.get(userRef),
        ]);

        const actorProfile =
          actorSnapshot.data();

        const targetProfile =
          targetSnapshot.data();

        /*
         * Revalidate the administrator
         * inside the transaction.
         */

        if (
          !actorSnapshot.exists ||
          !actorProfile ||
          actorProfile.role !== "admin" ||
          actorProfile.status !== "active" ||
          actorProfile.statusOperation != null ||
          actorProfile.mustChangePassword === true
        ) {
          throw new AccountStatusError(
            "Your administrator account is unavailable.",
            403
          );
        }

        if (
          !targetSnapshot.exists ||
          !targetProfile
        ) {
          throw new AccountStatusError(
            "User account not found.",
            404
          );
        }

        if (
          targetProfile.statusOperation != null
        ) {
          throw new AccountStatusError(
            "An account change is already in progress.",
            409
          );
        }

        if (
          targetProfile.status === "revoked"
        ) {
          throw new AccountStatusError(
            "This account has been permanently revoked.",
            409
          );
        }

        /*
         * Supervisor and administrator
         * suspension remains disabled.
         */

        if (
          targetProfile.role !== "technician"
        ) {
          throw new AccountStatusError(
            "Supervisor and administrator suspension is not enabled yet.",
            409
          );
        }

        /*
         * Preserve the existing restricted
         * account-status testing mode.
         */

        if (
          targetProfile.accountStatusTestEligible !==
          true
        ) {
          throw new AccountStatusError(
            "This account has not been cleared for suspension testing.",
            409
          );
        }

        const expectedStatus =
          action === "block"
            ? "active"
            : "blocked";

        if (
          targetProfile.status !==
          expectedStatus
        ) {
          throw new AccountStatusError(
            action === "block"
              ? "Only active accounts can be blocked."
              : "Only blocked accounts can be unblocked.",
            409
          );
        }

        /*
         * Operational safeguards apply
         * before blocking.
         *
         * Unblocking does not interrupt
         * an active shift.
         */

        if (action === "block") {
          await requireSafeAccountBlocking(
            transaction,
            uid
          );
        }

        /*
         * All transaction reads are complete.
         *
         * Reserve the account against
         * concurrent operational changes.
         */

        transaction.update(
          userRef,
          {
            statusOperation: {
              id: operationId,
              action,
              actorUid: actor.uid,
              startedAt:
                FieldValue.serverTimestamp(),
            },
          }
        );

        transaction.create(
          operationRef,
          {
            targetUid: uid,
            actorUid: actor.uid,
            action,
            reason,
            state: "pending",
            createdAt:
              FieldValue.serverTimestamp(),
          }
        );
      }
    );
  } catch (error) {
    if (
      error instanceof
        AccountStatusError ||
      error instanceof
        AccountOperationalError
    ) {
      return errorResponse(
        error.message,
        error.status
      );
    }

    console.error(
      "Account status reservation failed:",
      error
    );

    return errorResponse(
      "The account change could not be started. Please try again.",
      500
    );
  }

  /*
   * PHASE 5:
   * Apply the Firebase Authentication change.
   *
   * Authentication and Firestore cannot
   * participate in one atomic transaction.
   *
   * Keep the account reserved until
   * the operation is completed.
   */

  try {
    const authUser =
      await auth.getUser(uid);

    if (action === "block") {
      await auth.updateUser(
        uid,
        {
          disabled: true,
        }
      );

      await auth.revokeRefreshTokens(
        uid
      );
    } else {
      /*
       * Revoke old sessions before
       * restoring account access.
       */

      await auth.revokeRefreshTokens(
        uid
      );

      await auth.updateUser(
        uid,
        {
          disabled: false,
        }
      );
    }

    const newStatus =
      action === "block"
        ? "blocked"
        : "active";

    /*
     * PHASE 6:
     * Finalize the Firestore status change.
     */

    await db.runTransaction(
      async (transaction) => {
        const snapshot =
          await transaction.get(
            userRef
          );

        const profile =
          snapshot.data();

        if (
          !profile ||
          profile.statusOperation?.id !==
            operationId ||
          profile.statusOperation?.action !==
            action
        ) {
          throw new Error(
            "Account operation ownership could not be verified."
          );
        }

        transaction.update(
          userRef,
          {
            status: newStatus,

            statusOperation:
              FieldValue.delete(),

            updatedAt:
              FieldValue.serverTimestamp(),

            statusChangedAt:
              FieldValue.serverTimestamp(),

            statusChangedBy:
              actor.uid,

            statusChangeReason:
              reason,
          }
        );

        transaction.update(
          operationRef,
          {
            state: "completed",

            completedAt:
              FieldValue.serverTimestamp(),
          }
        );

        transaction.create(
          auditRef,
          {
            action:
              action === "block"
                ? "USER_BLOCKED"
                : "USER_UNBLOCKED",

            actorUid:
              actor.uid,

            targetUid:
              uid,

            reason,

            createdAt:
              FieldValue.serverTimestamp(),

            details:
              action === "block"
                ? "Administrator blocked a user account."
                : "Administrator unblocked a user account.",
          }
        );
      }
    );

    /*
     * PHASE 7:
     * Return a clear English success message.
     */

    return NextResponse.json({
      success: true,

      uid: authUser.uid,

      status: newStatus,

      message:
        action === "block"
          ? "User account blocked successfully."
          : "User account unblocked successfully.",
    });
  } catch (error) {
    /*
     * PHASE 8:
     * Fail safely.
     *
     * Do not automatically clear the
     * pending operation.
     */

    console.error(
      "Account status operation failed:",
      {
        operationId,
        uid,
        action,
        error,
      }
    );

    try {
      await operationRef.update({
        state: "requires_review",

        errorMessage:
          "Account status change requires administrator review.",

        updatedAt:
          FieldValue.serverTimestamp(),
      });
    } catch (loggingError) {
      console.error(
        "Account status failure logging failed:",
        loggingError
      );
    }

    return errorResponse(
      "The account change could not be completed. The account requires administrator review before another change can be made.",
      500
    );
  }
}