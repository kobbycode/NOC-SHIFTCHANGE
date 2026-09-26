"use client";

import {
  getApp,
  getApps,
  initializeApp,
} from "firebase/app";

import {
  connectAuthEmulator,
  getAuth,
} from "firebase/auth";

import {
  connectFirestoreEmulator,
  getFirestore,
} from "firebase/firestore";

import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,

  authDomain:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,

  projectId:
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,

  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,

  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,

  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Validate the configuration without dynamically accessing
// process.env[key] in browser code.

for (const [key, value] of Object.entries(firebaseConfig)) {
  if (!value) {
    throw new Error(
      `Missing Firebase configuration value: ${key}`
    );
  }
}

const useFirebaseEmulators =
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS ===
  "true";

const EMULATOR_PROJECT_ID = "demo-shiftchange-v2";

if (
  useFirebaseEmulators &&
  firebaseConfig.projectId !== EMULATOR_PROJECT_ID
) {
  throw new Error(
    "Firebase emulator mode requires the isolated emulator project."
  );
}

// Prevent duplicate Firebase initialization during
// Next.js development and hot reloads.

export const app = getApps().length
  ? getApp()
  : initializeApp(firebaseConfig);

export const auth = getAuth(app);

export const db = getFirestore(app);

export const storage = getStorage(app);

// Browser Firebase SDKs do not use the Admin SDK emulator
// environment variables. They must be connected explicitly.
//
// The global guards prevent duplicate emulator connection
// attempts during Next.js development hot reloads.

declare global {
  var __shiftchangeAuthEmulatorConnected:
    | boolean
    | undefined;

  var __shiftchangeFirestoreEmulatorConnected:
    | boolean
    | undefined;
}

if (useFirebaseEmulators) {
  if (!globalThis.__shiftchangeAuthEmulatorConnected) {
    connectAuthEmulator(
      auth,
      "http://127.0.0.1:9099",
      {
        disableWarnings: true,
      }
    );

    globalThis.__shiftchangeAuthEmulatorConnected = true;
  }

  if (!globalThis.__shiftchangeFirestoreEmulatorConnected) {
    connectFirestoreEmulator(
      db,
      "127.0.0.1",
      8080
    );

    globalThis.__shiftchangeFirestoreEmulatorConnected =
      true;
  }
}
