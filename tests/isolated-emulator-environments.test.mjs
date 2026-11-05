// TECH-HO-RECOVERY-09D guard: the isolated emulator environments are a closed
// list. The browser client and the server-side reauthentication helper must
// agree on exactly the same project/authentication/Firestore tuples, and every
// other combination — including production and arbitrary hosts — must fail
// closed before a credential leaves the process.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const helperSource = await readFile(new URL("../src/lib/auth/password-reauthentication.ts", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../src/lib/firebase/client.ts", import.meta.url), "utf8");

const expectedUid = "technician-A";
const email = "authoritative@example.test";
const password = "  secret-current-password  ";
const validInput = () => ({ expectedUid, email, password });
const credentialResponse = () => ({ localId: expectedUid, email, idToken: "id", refreshToken: "refresh", expiresIn: "3600" });
const response = () => ({ ok: true, status: 200, async json() { return credentialResponse(); } });

function compile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function loadHelper(env, fetch) {
  const loaded = { exports: {} };
  runInNewContext(compile(helperSource), {
    exports: loaded.exports,
    process: { env: { NEXT_PUBLIC_FIREBASE_API_KEY: "synthetic-test-key", ...env } },
    fetch,
    require(specifier) {
      if (specifier === "server-only") return {};
      throw new Error(`Unexpected authentication dependency: ${specifier}`);
    },
  });
  return loaded.exports;
}

const PRESENTATION = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  FIREBASE_PROJECT_ID: "demo-shiftchange-v2",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-shiftchange-v2",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const UAT = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9199",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180",
  FIREBASE_PROJECT_ID: "demo-shiftchange-v2-uat",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-shiftchange-v2-uat",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const NOTIFICATION_UAT = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9299",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8280",
  FIREBASE_PROJECT_ID: "demo-shiftchange-v2-09l",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-shiftchange-v2-09l",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const PREFLIGHT_UAT = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9399",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8380",
  FIREBASE_PROJECT_ID: "demo-shiftchange-v2-09m",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-shiftchange-v2-09m",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const ATOMIC_HTTP = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9083",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8183",
  FIREBASE_PROJECT_ID: "demo-atomic-acceptance-r5",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-atomic-acceptance-r5",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const ATOMIC_BROWSER = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9499",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8480",
  FIREBASE_PROJECT_ID: "demo-atomic-browser-p6",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-atomic-browser-p6",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const PRODUCT_READINESS = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9599",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8580",
  FIREBASE_PROJECT_ID: "demo-product-readiness-p7",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-product-readiness-p7",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const SCHEDULING_UAT = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9799",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8680",
  FIREBASE_PROJECT_ID: "demo-scheduling-p8a",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-scheduling-p8a",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const LIFECYCLE_UAT = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9899",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8780",
  FIREBASE_PROJECT_ID: "demo-lifecycle-p8a2",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-lifecycle-p8a2",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const LIFECYCLE_RERUN_UAT = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9999",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8880",
  FIREBASE_PROJECT_ID: "demo-lifecycle-p8a2r",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-lifecycle-p8a2r",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

const ADMIN_REVIEW_UAT = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:10099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8980",
  FIREBASE_PROJECT_ID: "demo-admin-review-8b",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-admin-review-8b",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
};

for (const [label, env, host] of [
  ["presentation", PRESENTATION, "127.0.0.1:9099"],
  ["isolated UAT", UAT, "127.0.0.1:9199"],
  ["notification UAT", NOTIFICATION_UAT, "127.0.0.1:9299"],
  ["handover-preflight UAT", PREFLIGHT_UAT, "127.0.0.1:9399"],
  ["atomic acceptance HTTP", ATOMIC_HTTP, "127.0.0.1:9083"],
  ["atomic acceptance browser UAT", ATOMIC_BROWSER, "127.0.0.1:9499"],
  ["product readiness browser UAT", PRODUCT_READINESS, "127.0.0.1:9599"],
  ["scheduling browser UAT", SCHEDULING_UAT, "127.0.0.1:9799"],
  ["consecutive lifecycle browser UAT", LIFECYCLE_UAT, "127.0.0.1:9899"],
  ["consecutive lifecycle rerun browser UAT", LIFECYCLE_RERUN_UAT, "127.0.0.1:9999"],
  ["administrative review browser UAT", ADMIN_REVIEW_UAT, "127.0.0.1:10099"],
]) {
  test(`${label} reauthentication uses only its own loopback emulator`, async () => {
    let target;
    const helper = loadHelper(env, async (url) => { target = url; return response(); });
    assert.equal((await helper.reauthenticatePassword(validInput())).uid, expectedUid);
    assert.equal(target, `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic-test-key`);
  });
}

const hostile = {
  "UAT project on presentation ports": { ...UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
  "presentation project on UAT ports": { ...PRESENTATION, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9199", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180" },
  "notification UAT project on UAT ports": { ...NOTIFICATION_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9199", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180" },
  "UAT project on notification UAT ports": { ...UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9299", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8280" },
  "notification UAT project on handover-preflight UAT ports": { ...NOTIFICATION_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9399", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8380" },
  "handover-preflight UAT project on notification UAT ports": { ...PREFLIGHT_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9299", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8280" },
  "atomic acceptance HTTP project on handover-preflight UAT ports": { ...ATOMIC_HTTP, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9399", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8380" },
  "handover-preflight UAT project on atomic acceptance HTTP ports": { ...PREFLIGHT_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9083", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8183" },
  "atomic acceptance HTTP project on browser UAT ports": { ...ATOMIC_HTTP, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9499", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8480" },
  "browser UAT project on atomic acceptance HTTP ports": { ...ATOMIC_BROWSER, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9083", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8183" },
  "browser UAT project on handover-preflight UAT ports": { ...ATOMIC_BROWSER, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9399", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8380" },
  "product readiness project on browser UAT ports": { ...PRODUCT_READINESS, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9499", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8480" },
  "browser UAT project on product readiness ports": { ...ATOMIC_BROWSER, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9599", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8580" },
  "scheduling project on product readiness ports": { ...SCHEDULING_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9599", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8580" },
  "product readiness project on scheduling ports": { ...PRODUCT_READINESS, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9799", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8680" },
  "lifecycle project on scheduling ports": { ...LIFECYCLE_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9799", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8680" },
  "scheduling project on lifecycle ports": { ...SCHEDULING_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9899", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8780" },
  "lifecycle rerun project on lifecycle ports": { ...LIFECYCLE_RERUN_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9899", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8780" },
  "lifecycle project on rerun ports": { ...LIFECYCLE_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9999", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8880" },
  "admin review project on rerun ports": { ...ADMIN_REVIEW_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9999", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8880" },
  "lifecycle rerun project on admin review ports": { ...LIFECYCLE_RERUN_UAT, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:10099", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8980" },
  "split project ids": { ...UAT, FIREBASE_PROJECT_ID: "demo-shiftchange-v2" },
  "remote authentication host": { ...UAT, FIREBASE_AUTH_EMULATOR_HOST: "identity.example.com:9199" },
  "remote firestore host": { ...UAT, FIRESTORE_EMULATOR_HOST: "database.example.com:8180" },
  "unknown demo project": { ...UAT, FIREBASE_PROJECT_ID: "demo-something-else", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-something-else" },
  "production project": { ...UAT, FIREBASE_PROJECT_ID: "production", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "production" },
  "missing firestore emulator host": { ...UAT, FIRESTORE_EMULATOR_HOST: "" },
  "emulator mode disabled": { ...UAT, NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "false" },
};

for (const [label, env] of Object.entries(hostile)) {
  test(`${label} fails closed before any request`, async () => {
    const helper = loadHelper(env, async () => { throw new Error("Network must not be called"); });
    await assert.rejects(
      () => helper.reauthenticatePassword(validInput()),
      (error) => error.code === "CONFIGURATION_UNAVAILABLE"
    );
  });
}

function parseEntries(source, withPort) {
  const pattern = withPort
    ? /projectId: "([^"]+)",[\s\S]*?authEmulatorHost: "([^"]+)",[\s\S]*?firestoreEmulatorHost: "([^"]+)",[\s\S]*?firestoreEmulatorPort: (\d+)/g
    : /projectId: "([^"]+)",[\s\S]*?authEmulatorHost: "([^"]+)",[\s\S]*?firestoreEmulatorHost: "([^"]+)"/g;

  return [...source.matchAll(pattern)].map((match) => ({
    projectId: match[1],
    authHost: match[2],
    firestoreHost: withPort ? `${match[3]}:${match[4]}` : match[3],
  }));
}

test("the browser client and the server helper list the same closed tuples", () => {
  const client = parseEntries(clientSource, true);
  const server = parseEntries(helperSource, false);

  const expected = [
    { projectId: "demo-shiftchange-v2", authHost: "127.0.0.1:9099", firestoreHost: "127.0.0.1:8080" },
    { projectId: "demo-shiftchange-v2-uat", authHost: "127.0.0.1:9199", firestoreHost: "127.0.0.1:8180" },
    { projectId: "demo-shiftchange-v2-09l", authHost: "127.0.0.1:9299", firestoreHost: "127.0.0.1:8280" },
    { projectId: "demo-shiftchange-v2-09m", authHost: "127.0.0.1:9399", firestoreHost: "127.0.0.1:8380" },
    { projectId: "demo-atomic-acceptance-r5", authHost: "127.0.0.1:9083", firestoreHost: "127.0.0.1:8183" },
    { projectId: "demo-atomic-browser-p6", authHost: "127.0.0.1:9499", firestoreHost: "127.0.0.1:8480" },
    { projectId: "demo-product-readiness-p7", authHost: "127.0.0.1:9599", firestoreHost: "127.0.0.1:8580" },
    { projectId: "demo-scheduling-p8a", authHost: "127.0.0.1:9799", firestoreHost: "127.0.0.1:8680" },
    { projectId: "demo-lifecycle-p8a2", authHost: "127.0.0.1:9899", firestoreHost: "127.0.0.1:8780" },
    { projectId: "demo-lifecycle-p8a2r", authHost: "127.0.0.1:9999", firestoreHost: "127.0.0.1:8880" },
    { projectId: "demo-admin-review-8b", authHost: "127.0.0.1:10099", firestoreHost: "127.0.0.1:8980" },
  ];

  assert.deepEqual(client, expected, "client.ts emulator environments drifted");
  assert.deepEqual(server, expected, "password-reauthentication.ts environments drifted from client.ts");
});

test("emulator endpoints are never read from the environment", () => {
  assert.doesNotMatch(clientSource, /connectAuthEmulator\(\s*auth,\s*process\.env/);
  assert.doesNotMatch(clientSource, /connectFirestoreEmulator\([\s\S]*?process\.env/);
  assert.doesNotMatch(helperSource, /process\.env\.[A-Z_]*(?:AUTH|FIRESTORE)_EMULATOR_(?:HOST|PORT)\s*(?:\|\||\?\?)/);
});
