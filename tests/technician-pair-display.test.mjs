import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import {
  addTechnicianPairMembers,
} from "../src/lib/technician-pairs/technician-pair-display.ts";

const technicianPairApiSource = await readFile(
  new URL(
    "../src/lib/technician-pairs/technician-pair-api.ts",
    import.meta.url
  ),
  "utf8"
);

const technicianPairApiJavaScript = ts.transpileModule(
  technicianPairApiSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }
).outputText;

const {
  createTechnicianPair,
  deactivateTechnicianPair,
} = await import(
  `data:text/javascript;base64,${Buffer.from(
    technicianPairApiJavaScript
  ).toString("base64")}`
);

const firstUid = "technician-one";
const secondUid = "technician-two";

function createPair(id, status) {
  const inactive = status === "inactive";

  return {
    id,
    technicianIds: [firstUid, secondUid],
    status,
    createdBy: "supervisor-id",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    deactivatedAt: inactive
      ? "2026-01-02T00:00:00.000Z"
      : null,
    deactivatedBy: inactive
      ? "supervisor-id"
      : null,
  };
}

const profiles = new Map([
  [firstUid, { fullName: "Test Technician One" }],
  [secondUid, { fullName: "Test Technician Two" }],
]);

test("active pairs resolve names independently of eligible technicians", () => {
  const pair = createPair("active-pair", "active");
  const eligibleTechnicianUids = new Set();

  const [resolved] = addTechnicianPairMembers(
    [pair],
    profiles
  );

  assert.equal(eligibleTechnicianUids.has(firstUid), false);
  assert.equal(eligibleTechnicianUids.has(secondUid), false);
  assert.deepEqual(
    resolved.technicians.map((technician) => technician.fullName),
    ["Test Technician One", "Test Technician Two"]
  );
  assert.deepEqual(resolved.technicianIds, pair.technicianIds);
});

test("inactive pairs resolve both technician names", () => {
  const [resolved] = addTechnicianPairMembers(
    [createPair("inactive-pair", "inactive")],
    profiles
  );

  assert.deepEqual(
    resolved.technicians.map((technician) => technician.fullName),
    ["Test Technician One", "Test Technician Two"]
  );
});

test("missing or deleted profiles use the UID fallback", () => {
  const [resolved] = addTechnicianPairMembers(
    [createPair("historical-pair", "inactive")],
    new Map()
  );

  assert.deepEqual(
    resolved.technicians,
    [
      { uid: firstUid, fullName: `Technician ${firstUid}` },
      { uid: secondUid, fullName: `Technician ${secondUid}` },
    ]
  );
});

test("resolved profiles without a name use a neutral name", () => {
  const [resolved] = addTechnicianPairMembers(
    [createPair("unnamed-pair", "inactive")],
    new Map([[firstUid, { fullName: " " }]])
  );

  assert.equal(
    resolved.technicians[0].fullName,
    "Unnamed technician"
  );
  assert.equal(
    resolved.technicians[1].fullName,
    `Technician ${secondUid}`
  );
});

test("repeated technicians resolve across historical pairs", () => {
  const pairs = [
    createPair("older-pair", "inactive"),
    createPair("newer-pair", "active"),
  ];

  const resolved = addTechnicianPairMembers(
    pairs,
    profiles
  );

  assert.equal(resolved.length, 2);
  assert.deepEqual(
    resolved.map((pair) =>
      pair.technicians.map((technician) => technician.uid)
    ),
    [
      [firstUid, secondUid],
      [firstUid, secondUid],
    ]
  );
  assert.deepEqual(
    resolved.map((pair) => pair.status),
    ["inactive", "active"]
  );
  assert.deepEqual(
    resolved.map((pair) => pair.deactivatedAt),
    [pairs[0].deactivatedAt, pairs[1].deactivatedAt]
  );
  assert.deepEqual(
    resolved.map((pair) => pair.deactivatedBy),
    [pairs[0].deactivatedBy, pairs[1].deactivatedBy]
  );
  assert.deepEqual(
    resolved.map((pair) => pair.technicianIds),
    pairs.map((pair) => pair.technicianIds)
  );
});

test("pair creation continues to submit only the technician IDs", async () => {
  const originalFetch = globalThis.fetch;
  let request;

  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return Response.json({
      success: true,
      message: "Pair created.",
      pair: createPair("created-pair", "active"),
    });
  };

  try {
    await createTechnicianPair({
      technicianIds: [firstUid, secondUid],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.url, "/api/operations/technician-pairs");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(
    JSON.parse(request.options.body),
    { technicianIds: [firstUid, secondUid] }
  );
});

test("pair deactivation continues to use its dedicated route", async () => {
  const originalFetch = globalThis.fetch;
  let request;

  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return Response.json({
      success: true,
      message: "Pair deactivated.",
      pair: createPair("pair-to-deactivate", "inactive"),
    });
  };

  try {
    await deactivateTechnicianPair("pair-to-deactivate");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    request.url,
    "/api/operations/technician-pairs/pair-to-deactivate/deactivate"
  );
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.body, undefined);
});