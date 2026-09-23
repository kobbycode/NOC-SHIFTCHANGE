
import "server-only";

import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";

import {
  getAuth,
  type Auth,
} from "firebase-admin/auth";

import {
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";

const projectId =
  process.env.FIREBASE_PROJECT_ID ??
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

function initializeFirebaseAdmin(): App {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  if (!projectId) {
    throw new Error(
      "Missing Firebase project ID."
    );
  }

  return initializeApp({
    credential: applicationDefault(),
    projectId,
  });
}

export function getAdminApp(): App {
  return initializeFirebaseAdmin();
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}

export function getAdminFirestore(): Firestore {
  return getFirestore(getAdminApp());
}