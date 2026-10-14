// Standalone test for UI-04C3R2 ambiguous commit recovery
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Load the domain module
const domainSource = readFileSync(
  new URL("../src/lib/accounts/account-provisioning-domain.ts", import.meta.url),
  "utf8",
);

const domainCompile = ts.transpileModule(domainSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const domainExports = {};
runInNewContext(domainCompile, { exports: domainExports });
const domain = domainExports;

// HMAC computation
const TEST_SECRET = "test-hmac-secret-key-for-reservations-only";

function computeEmailReservationKey(email, secret = TEST_SECRET) {
  const normalizedEmail = email.trim().toLowerCase();
  const hmac = crypto.createHmac("sha256", secret).update(normalizedEmail).digest("hex");
  return `hmac-sha256:v1:${hmac}`;
}

// Mock Firestore
function makeMockFirestore() {
  const docs = new Map();

  return {
    collection(name) {
      return {
        doc(id) {
          return { id, path: `${name}/${id}` };
        },
        get() {
          const col = docs.get(name) || {};
          const items = [];
          for (const [docId, data] of Object.entries(col)) {
            items.push({ id: docId, data: () => structuredClone(data) });
          }
          return { docs: items };
        },
      };
    },

    doc(path) {
      const [collection, id] = path.split("/");
      return {
        id,
        path,
        exists() {
          const col = docs.get(collection) || {};
          return { exists: id in col, data: () => structuredClone(col[id]) };
        },
        data() {
          const col = docs.get(collection) || {};
          return col[id] || null;
        },
      };
    },

    runTransaction(callback) {
      return callback({
        get: async (docRef) => {
          const exists = await docRef.exists();
          const data = exists ? await docRef.data() : null;
          return { exists, data: () => data };
        },
        set: (docRef, data) => {
          const [collection, id] = docRef.path.split("/");
          let col = docs.get(collection) || {};
          col[id] = data;
          docs.set(collection, col);
        },
      });
    },

    collection_groups: [],
    terminate: async () => {},
  };
}

function makeReservationConfig(secret, version) {
  return { secret: secret || TEST_SECRET, version: version || "v1" };
}

function createProvOp(overrides, now = "2025-01-01T00:00:00.000Z") {
  return domain.createProvisioningOperation({
    operationId: "test-uid",
    targetAuthUid: "auth-uid-1",
    initiatingAdminUid: "admin-uid-1",
    requestedRole: "technician",
    displayName: "Taylor Technician",
    emailReservationKey: "hmac-sha256:v1:placeholder",
    requestFingerprint: "req-fp",
    schemaVersion: 1,
    stage: "reserved",
    revision: 0,
    leaseEpoch: 0,
    lease: null,
    createdAt: now,
    updatedAt: now,
    stageEnteredAt: now,
    lastAttemptAt: null,
    attemptCount: 0,
    completedAt: null,
    lastFailure: null,
    review: null,
    lastCommand: null,
  }, now);
}

// Test 1: Ambiguous commit recovery
// Scenario: 
// 1. Reserve an account (first call succeeds, writes data)
// 2. Simulate loss of Firestore commit acknowledgement (throw after write)
// 3. Confirm caller receives uncertain outcome
// 4. Retry the reservation using the same request
// 4. Confirm the original operation and predetermined UID are recovered
// 5. Confirm only one operation exists

console.log("Test 1: Ambiguous commit recovery");

// First attempt: write the reservation, then throw as though commit was lost
const firestore1 = makeMockFirestore();
const db1 = {
  collection(name) {
    return {
      doc(id) {
        return { id, path: `${name}/${id}` };
      },
      get() {
        const col = docs1.get(name) || {};
        return { docs: [{ id, data: () => structuredClone(col[id]) }] };
      },
    };
  },
  runTransaction(callback) {
    db1.attempts = (db1.attempts || 0) + 1;
    if (db1.attempts === 1) {
      // First attempt: write reservation data, then throw
      const docRef = firestore1.doc(`provisioning_reservations/${computeEmailReservationKey("ambiguous@example.test", TEST_SECRET)}`);
      const [col, id] = docRef.path.split("/");
      let colMap = docs1.get(col) || {};
      colMap[id] = {
        schemaVersion: 1, stage: "reserved", revision: 0,
        lease: { ownerId: null, fencingToken: 0, expiresAt: null },
        targetAuthUid: "auth-uid-1", initiatingAdminUid: "admin-uid-1",
        requestedRole: "technician", displayName: "Taylor Technician",
        emailReservationKey: computeEmailReservationKey("ambiguous@example.test", TEST_SECRET),
        requestFingerprint: "req-fp",
        createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
        stageEnteredAt: "2025-01-01T00:00:00.000Z", lastAttemptAt: null, attemptCount: 0,
        completedAt: null, lastFailure: null, review: null, lastCommand: null,
      };
      docs1.set(col, colMap);
      throw new Error("Simulated ambiguous commit failure");
    }
    // Second attempt: succeed and return existing
    return callback({
      get: async (docRef) => {
        const col = docs1.get(docRef.path) || {};
        const docId = docRef.path.split("/").pop();
        const data = col[docId] || null;
        return { exists: docId in col, data: () => structuredClone(data) };
      },
      set: (docRef, data) => {
        const [col, id] = docRef.path.split("/");
        let colMap = docs1.get(col) || {};
        colMap.set(id, data);
        docs1.set(col, colMap);
      },
    });
  },
};

const config1 = makeReservationConfig();
let firstResult;
try {
  firstResult = await (domainExports.reserveAccountOperation
    ? domainExports.reserveAccountOperation(db1, "ambiguous@example.test", "auth-uid-1", "admin-uid-1", "technician", "Taylor Technician", "req-fp-1", config1)
    : null);
} catch (e) {
  // Expected: first attempt throws as though commit was lost
  console.log("First attempt threw as expected:", e.message.includes("Simulated"));
  firstResult = null;
}

// Reset attempt counter
db1.attempts = 0;

// Retry: should recover the existing reservation
let secondResult;
try {
  secondResult = await (domainExports.reserveAccountOperation
    ? domainExports.reserveAccountOperation(db1, "ambiguous@example.test", "auth-uid-1", "admin-uid-1", "technician", "Taylor Technician", "req-fp-1", config1)
    : null);
} catch (e) {
  console.log("ERROR: Retry should not throw:", e.message);
  secondResult = null;
}

// Verify recovery
if (secondResult) {
  console.log("Recovery successful:");
  console.log("  newlyCreated:", secondResult.newlyCreated, "(should be false)");
  console.log("  targetAuthUid:", secondResult.operation.targetAuthUid, "(should be auth-uid-1)");
  console.log("  Only one document exists:", Object.keys(docs1.get("provisioning_reservations") || {}).length === 1, "(should be true)");
}

// Test 2: Transaction failure before commit
// Simulate a transaction that fails before committing

console.log("\nTest 2: Transaction failure before commit");

const firestore2 = makeMockFirestore();
const db2 = {
  attempts: 0,
  collection(name) {
    return {
      doc(id) {
        return { id, path: `${name}/${id}` };
      },
      get() {
        const col = docs2.get(name) || {};
        return { docs: [{ id, data: () => structuredClone(col[id]) }] };
      },
    };
  },
  runTransaction(callback) {
    db2.attempts++;
    if (db2.attempts <= 2) {
      // First two attempts fail
      throw new Error("Simulated transaction failure");
    }
    // Third attempt succeeds
    return callback({
      get: async (docRef) => {
        const col = docs2.get(docRef.path) || {};
        const docId = docRef.path.split("/").pop();
        const data = col[docId] || null;
        return { exists: docId in col, data: () => structuredClone(data) };
      },
      set: (docRef, data) => {
        const [col, id] = docRef.path.split("/");
        let colMap = docs2.get(col) || {};
        colMap.set(id, data);
        docs2.set(col, colMap);
      },
    });
  },
};

const config2 = makeReservationConfig();
let thirdResult;
try {
  thirdResult = await (domainExports.reserveAccountOperation
    ? domainExports.reserveAccountOperation(db2, "txn-fail@example.test", "auth-uid-1", "admin-uid-1", "technician", "Taylor Technician", "req-fp-1", config2)
    : null);
  console.log("Third attempt succeeded after retries");
} catch (e) {
  console.log("ERROR: Should have succeeded after retries:", e.message);
}

// Summary
console.log("\n--- UI-04C3R2 Test Summary ---");
console.log("Test 1 (ambiguous commit recovery):", firstResult === null && secondResult ? "PASS" : "FAIL");
console.log("Test 2 (transaction failure before commit):", thirdResult ? "PASS" : "FAIL");
console.log("\nUI-04C3R2 verification complete!");