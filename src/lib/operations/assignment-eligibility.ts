
import "server-only";

import type {
  DocumentData,
} from "firebase-admin/firestore";

export interface AssignmentEligibilityResult {
  eligible: boolean;
  message: string | null;
}

export function evaluateAssignmentEligibility(
  profile: DocumentData | undefined
): AssignmentEligibilityResult {
  if (!profile) {
    return {
      eligible: false,
      message:
        "The selected technician account was not found.",
    };
  }

  if (profile.role !== "technician") {
    return {
      eligible: false,
      message:
        "Only technician accounts can receive technician assignments.",
    };
  }

  if (profile.status !== "active") {
    return {
      eligible: false,
      message:
        "This technician account is not active.",
    };
  }

  if (profile.mustChangePassword === true) {
    return {
      eligible: false,
      message:
        "This technician must complete their initial password change before receiving assignments.",
    };
  }

  if (profile.statusOperation != null) {
    return {
      eligible: false,
      message:
        "An account-management operation is in progress for this technician.",
    };
  }

  return {
    eligible: true,
    message: null,
  };
}