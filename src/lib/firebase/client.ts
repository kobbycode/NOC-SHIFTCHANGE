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

// Closed list of the isolated, loopback-only emulator environments this
// application may use. It is deliberately hard-coded rather than read from the
// environment so a demonstration credential can never be redirected at
// production or an arbitrary host. A new entry needs its own emulator config
// and launcher, and must be mirrored in src/lib/auth/password-reauthentication.ts.
const ISOLATED_EMULATOR_ENVIRONMENTS = [
  {
    projectId: "demo-shiftchange-v2",
    authEmulatorHost: "127.0.0.1:9099",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8080,
  },
  {
    projectId: "demo-shiftchange-v2-uat",
    authEmulatorHost: "127.0.0.1:9199",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8180,
  },
  {
    projectId: "demo-shiftchange-v2-09l",
    authEmulatorHost: "127.0.0.1:9299",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8280,
  },
  {
    projectId: "demo-shiftchange-v2-09m",
    authEmulatorHost: "127.0.0.1:9399",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8380,
  },
  {
    projectId: "demo-atomic-acceptance-r5",
    authEmulatorHost: "127.0.0.1:9083",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8183,
  },
  {
    projectId: "demo-atomic-browser-p6",
    authEmulatorHost: "127.0.0.1:9499",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8480,
  },
  {
    projectId: "demo-product-readiness-p7",
    authEmulatorHost: "127.0.0.1:9599",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8580,
  },
  {
    projectId: "demo-scheduling-p8a",
    authEmulatorHost: "127.0.0.1:9799",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8680,
  },
  {
    projectId: "demo-lifecycle-p8a2",
    authEmulatorHost: "127.0.0.1:9899",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8780,
  },
  {
    projectId: "demo-lifecycle-p8a2r",
    authEmulatorHost: "127.0.0.1:9999",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8880,
  },
  {
    projectId: "demo-admin-review-8b",
    authEmulatorHost: "127.0.0.1:10099",
    firestoreEmulatorHost: "127.0.0.1",
    firestoreEmulatorPort: 8980,
  },
] as const;

const isolatedEmulator =
  ISOLATED_EMULATOR_ENVIRONMENTS.find(
    (environment) =>
      environment.projectId === firebaseConfig.projectId
  ) ?? null;

if (
  useFirebaseEmulators &&
  !isolatedEmulator
) {
  throw new Error(
    "Firebase emulator mode requires an isolated emulator project."
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

if (useFirebaseEmulators && isolatedEmulator) {
  if (!globalThis.__shiftchangeAuthEmulatorConnected) {
    connectAuthEmulator(
      auth,
      `http://${isolatedEmulator.authEmulatorHost}`,
      {
        disableWarnings: true,
      }
    );

    globalThis.__shiftchangeAuthEmulatorConnected = true;
  }

  if (!globalThis.__shiftchangeFirestoreEmulatorConnected) {
    connectFirestoreEmulator(
      db,
      isolatedEmulator.firestoreEmulatorHost,
      isolatedEmulator.firestoreEmulatorPort
    );

    globalThis.__shiftchangeFirestoreEmulatorConnected =
      true;
  }
}
