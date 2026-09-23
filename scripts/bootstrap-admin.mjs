
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PROJECT_ID = "shiftchange20-e4265";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const fullName = process.env.BOOTSTRAP_ADMIN_NAME?.trim();

if (!email || !password || !fullName) {
  throw new Error("Missing administrator provisioning details.");
}

if (password.length < 12) {
  throw new Error("The initial password must contain at least 12 characters.");
}

const app = initializeApp({
  credential: applicationDefault(),
  projectId: PROJECT_ID,
});

const auth = getAuth(app);
const db = getFirestore(app);

const bootstrapRef = db.doc("system/bootstrap_admin");

let createdUid = null;

async function bootstrap() {
  // Verify that the credentials belong to the intended project.
  const actualProjectId = app.options.projectId;

  if (actualProjectId !== PROJECT_ID) {
    throw new Error("Firebase project mismatch.");
  }

  const bootstrapDoc = await bootstrapRef.get();

  if (bootstrapDoc.exists) {
    throw new Error(
      "Initial administrator provisioning has already been completed."
    );
  }

  // Do not overwrite an existing authentication account.
  try {
    await auth.getUserByEmail(email);

    throw new Error(
      "An authentication account already exists with this email."
    );
  } catch (error) {
    if (error.code !== "auth/user-not-found") {
      throw error;
    }
  }

  console.log("Creating initial administrator...");

  const user = await auth.createUser({
    email,
    password,
    displayName: fullName,
    disabled: false,
  });

  createdUid = user.uid;

  try {
    await auth.setCustomUserClaims(user.uid, {
      role: "admin",
    });

    const batch = db.batch();

    const userRef = db.collection("users").doc(user.uid);

    batch.create(userRef, {
      uid: user.uid,
      fullName,
      email,
      role: "admin",
      status: "active",
      mustChangePassword: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: "system-bootstrap",
    });

    batch.create(bootstrapRef, {
      completed: true,
      initialAdminUid: user.uid,
      completedAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    console.log("Administrator provisioned successfully.");
    console.log("Project:", PROJECT_ID);
    console.log("UID:", user.uid);
    console.log("Email:", email);
    console.log("Role: admin");
  } catch (error) {
    // Roll back the new Auth account if profile creation fails.
    // If deletion also fails, preserve the original error and
    // report the UID so an administrator can reconcile it.
    try {
      await auth.deleteUser(user.uid);
      createdUid = null;
    } catch (rollbackError) {
      console.error(
        "Rollback failed. Inspect the partially created account:",
        createdUid,
        rollbackError
      );
    }

    throw error;
  }
}

bootstrap().catch((error) => {
  console.error("Administrator provisioning failed:", error);
  process.exitCode = 1;
});