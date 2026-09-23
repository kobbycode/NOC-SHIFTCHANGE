import {
  applicationDefault,
  getApps,
  initializeApp,
} from "firebase-admin/app";

import {
  getAuth,
} from "firebase-admin/auth";

import {
  getFirestore,
} from "firebase-admin/firestore";

const projectId =
  process.env.FIREBASE_PROJECT_ID ??
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

if (!projectId) {
  throw new Error(
    "Missing Firebase project ID."
  );
}

const app =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
    projectId,
  });

const db = getFirestore(app);
const auth = getAuth(app);

const TASK_ID =
  "LizVuZmqzLnaxNM6DKKy";

const TECHNICIAN_B_UID =
  "Us8M1RVmbqRuFN5DuGbSR51TwGB3";

async function inspectTechnician(
  uid,
  label
) {
  const profileSnapshot =
    await db
      .collection("users")
      .doc(uid)
      .get();

  let authState;

  try {
    const authUser =
      await auth.getUser(uid);

    authState = {
      exists: true,
      disabled: authUser.disabled,
    };
  } catch (error) {
    authState = {
      exists: false,
      errorCode:
        error?.code ?? "unknown",
    };
  }

  const profile =
    profileSnapshot.data();

  console.log(`\n--- ${label} ---`);

  console.log({
    uid,

    firestoreExists:
      profileSnapshot.exists,

    role:
      profile?.role ?? null,

    status:
      profile?.status ?? null,

    mustChangePassword:
      profile?.mustChangePassword ?? null,

    statusOperation:
      profile?.statusOperation ?? null,

    auth: authState,
  });
}

async function main() {
  console.log(
    "ShiftChange 2.0 - Technician Eligibility Inspection"
  );

  console.log(
    "Firebase project:",
    projectId
  );

  console.log("Mode: READ ONLY");

  /*
   * Find the existing Technician A
   * account without assuming its UID.
   */

  const usersSnapshot =
    await db
      .collection("users")
      .where("role", "==", "technician")
      .get();

  const technicians =
    usersSnapshot.docs.filter(
      (document) =>
        document.id !== TECHNICIAN_B_UID
    );

  console.log(
    "\nOther technician accounts:",
    technicians.length
  );

  for (const document of technicians) {
    await inspectTechnician(
      document.id,
      "Other technician"
    );
  }

  await inspectTechnician(
    TECHNICIAN_B_UID,
    "Technician B"
  );

  /*
   * Confirm that the original assignment
   * still exists and has not been released.
   */

  const assignmentId =
    `${TASK_ID}_${TECHNICIAN_B_UID}`;

  const assignmentSnapshot =
    await db
      .collection("task_assignments")
      .doc(assignmentId)
      .get();

  const assignment =
    assignmentSnapshot.data();

  console.log(
    "\n--- Original assignment ---"
  );

  console.log({
    exists:
      assignmentSnapshot.exists,

    taskId:
      assignment?.taskId ?? null,

    technicianId:
      assignment?.technicianId ?? null,

    responsibility:
      assignment?.responsibility ?? null,

    responsibilityStatus:
      assignment?.responsibilityStatus ??
      "legacy_active",

    acceptanceStatus:
      assignment?.acceptanceStatus ?? null,

    releasedAt:
      assignment?.releasedAt ?? null,

    releasedBy:
      assignment?.releasedBy ?? null,

    transferredTo:
      assignment?.transferredTo ?? null,
  });

  console.log(
    "\nInspection complete."
  );
}

main().catch((error) => {
  console.error(
    "Inspection failed:",
    error
  );

  process.exitCode = 1;
});
