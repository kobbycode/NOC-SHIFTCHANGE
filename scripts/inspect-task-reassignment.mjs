import {
  applicationDefault,
  getApps,
  initializeApp,
} from "firebase-admin/app";

import {
  getFirestore,
} from "firebase-admin/firestore";

const projectId =
  process.env.FIREBASE_PROJECT_ID ??
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

if (!projectId) {
  throw new Error(
    "Missing FIREBASE_PROJECT_ID."
  );
}

const app =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
    projectId,
  });

const db = getFirestore(app);

const TASK_ID =
  "LizVuZmqzLnaxNM6DKKy";

const TECHNICIAN_B_UID =
  "Us8M1RVmbqRuFN5DuGbSR51TwGB3";

async function main() {
  console.log(
    "ShiftChange 2.0 - Reassignment Inspection"
  );

  console.log(
    "Firebase project:",
    projectId
  );

  console.log("Mode: READ ONLY");

  const taskSnapshot =
    await db
      .collection("tasks")
      .doc(TASK_ID)
      .get();

  console.log("\n--- Task ---");

  console.log({
    exists: taskSnapshot.exists,
    id: taskSnapshot.id,
    data: taskSnapshot.exists
      ? taskSnapshot.data()
      : null,
  });

  const assignmentsSnapshot =
    await db
      .collection("task_assignments")
      .where("taskId", "==", TASK_ID)
      .get();

  console.log(
    "\n--- Task assignments ---"
  );

  console.log(
    "Count:",
    assignmentsSnapshot.size
  );

  for (
    const document of
    assignmentsSnapshot.docs
  ) {
    console.log({
      id: document.id,
      ...document.data(),
    });
  }

  const technicianBAssignments =
    assignmentsSnapshot.docs.filter(
      (document) =>
        document.data().technicianId ===
        TECHNICIAN_B_UID
    );

  console.log(
    "\n--- Technician B assignment ---"
  );

  console.log(
    technicianBAssignments.map(
      (document) => ({
        id: document.id,
        ...document.data(),
      })
    )
  );

  const historySnapshot =
    await db
      .collection(
        "task_assignment_history"
      )
      .where("taskId", "==", TASK_ID)
      .get();

  console.log(
    "\n--- Assignment history ---"
  );

  console.log(
    "Count:",
    historySnapshot.size
  );

  for (
    const document of
    historySnapshot.docs
  ) {
    console.log({
      id: document.id,
      ...document.data(),
    });
  }

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
