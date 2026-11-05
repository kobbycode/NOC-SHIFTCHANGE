
import "server-only";

import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
  type Credential,
  type ServiceAccount,
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

function adminCredential(): Credential {
  const encodedKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_B64?.trim();

  if (!encodedKey) {
    // Application Default Credentials only resolve inside Google Cloud; other
    // hosts must supply the service-account key explicitly.
    return applicationDefault();
  }

  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(encodedKey, "base64").toString("utf8"));
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY_B64 is not base64-encoded JSON.");
  }

  return cert(key as ServiceAccount);
}

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
    credential: adminCredential(),
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