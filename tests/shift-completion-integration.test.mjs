import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const completionSource = await readFile(
  new URL(
    "../src/lib/operations/complete-shift.ts",
    import.meta.url
  ),
  "utf8"
);

const handoverSource = await readFile(
  new URL(
    "../src/lib/operations/begin-shift-handover.ts",
    import.meta.url
  ),
  "utf8"
);

function firstTransactionWrite(source) {
  const matches = [
    source.indexOf("transaction.create("),
    source.indexOf("transaction.set("),
    source.indexOf("transaction.update("),
    source.indexOf("transaction.delete("),
  ].filter((value) => value >= 0);

  assert.ok(
    matches.length > 0,
    "Expected at least one transaction write."
  );

  return Math.min(...matches);
}

test(
  "completion reads participation and authorization authority before writes",
  () => {
    const firstWrite =
      firstTransactionWrite(completionSource);

    const requiredReads = [
      "attendanceSnapshot",
      "expectedAuthorizationSnapshot",
      "slotAuthorizationSnapshot",
      "shiftAuthorizationSnapshot",
      "scheduleSnapshot",
    ];

    for (const marker of requiredReads) {
      const index =
        completionSource.indexOf(marker);

      assert.ok(
        index >= 0,
        `Missing authoritative read: ${marker}`
      );

      assert.ok(
        index < firstWrite,
        `${marker} must be processed before the first transaction write`
      );
    }

    const lastDirectGet =
      completionSource.lastIndexOf(
        "transaction.get("
      );

    assert.ok(
      lastDirectGet >= 0 &&
        lastDirectGet < firstWrite,
      "All direct transaction reads must precede completion writes."
    );
  }
);

test(
  "completion fails closed on membership attendance and authorization identity",
  () => {
    assert.match(
      completionSource,
      /member\.id\s*!==\s*document\.id/
    );

    assert.match(
      completionSource,
      /attendance\.id\s*!==\s*document\.id/
    );

    assert.match(
      completionSource,
      /authorizationDocumentId\s*!==\s*expectedAuthorizationId/
    );

    assert.match(
      completionSource,
      /authorizationData[\s\S]*?\.id\s*!==\s*authorizationDocumentId/
    );

    assert.doesNotMatch(
      completionSource,
      /\.\.\.document\.data\(\),\s*id:\s*document\.id/
    );
  }
);

test(
  "completion discovers authorization by deterministic identity slot and shift",
  () => {
    assert.match(
      completionSource,
      /createNextShiftAuthorizationDocumentId/
    );

    assert.match(
      completionSource,
      /nextShiftAuthorizations\.doc\(\s*expectedAuthorizationId\s*\)/
    );

    assert.match(
      completionSource,
      /\.where\(\s*"slotToken"/
    );

    assert.match(
      completionSource,
      /\.where\(\s*"slotGeneration"/
    );

    assert.match(
      completionSource,
      /\.where\(\s*"shiftId"/
    );

    assert.match(
      completionSource,
      /authorizationCandidates\.size\s*>\s*1/
    );
  }
);

test(
  "completion validates participation membership and authorization before writes",
  () => {
    const firstWrite =
      firstTransactionWrite(completionSource);

    for (const marker of [
      "validateShiftCompletionAttendance({",
      "finalizeCurrentShiftMemberships({",
      "completeConsumedNextShiftAuthorization({",
      "advanceOperationalShiftControl(",
    ]) {
      const index =
        completionSource.indexOf(marker);

      assert.ok(
        index >= 0,
        `Missing completion operation: ${marker}`
      );

      assert.ok(
        index < firstWrite,
        `${marker} must run before the first transaction write`
      );
    }
  }
);

test(
  "completion closes every current membership without treating leftAt as attendance",
  () => {
    assert.match(
      completionSource,
      /for\s*\(\s*const member of\s*finalizedMembers\s*\)/
    );

    assert.match(
      completionSource,
      /shiftMembers\.doc\(member\.id\)/
    );

    assert.match(
      completionSource,
      /leftAt:\s*member\.leftAt/
    );

    assert.doesNotMatch(
      completionSource,
      /clockOut\s*:/
    );
  }
);

test(
  "completion finalizes consumed temporary authorization without deleting it",
  () => {
    assert.match(
      completionSource,
      /if\s*\(completedAuthorization\)/
    );

    assert.match(
      completionSource,
      /nextShiftAuthorizations\.doc\(\s*completedAuthorization\.id\s*\)/
    );

    assert.match(
      completionSource,
      /status:\s*completedAuthorization\.status/
    );

    assert.match(
      completionSource,
      /completedAt:\s*completedAuthorization\.completedAt/
    );

    assert.match(
      completionSource,
      /expiredAt:\s*completedAuthorization\.expiredAt/
    );

    assert.match(
      completionSource,
      /updatedAt:\s*completedAuthorization\.updatedAt/
    );

    assert.doesNotMatch(
      completionSource,
      /transaction\.delete\(\s*nextShiftAuthorizations/
    );
  }
);

test(
  "completion never writes or fabricates attendance",
  () => {
    assert.match(
      completionSource,
      /shiftAttendance\.where/
    );

    assert.doesNotMatch(
      completionSource,
      /transaction\.(?:create|set|update|delete)\(\s*shiftAttendance/
    );

    assert.doesNotMatch(
      completionSource,
      /shiftAttendance\.doc\(/
    );

    assert.doesNotMatch(
      completionSource,
      /clockIn\s*:|clockOut\s*:/
    );
  }
);

test(
  "handover transitions every current member schedule to handover pending",
  () => {
    assert.match(
      handoverSource,
      /for\s*\(\s*const member of\s*currentMembers\s*\)/
    );

    assert.match(
      handoverSource,
      /matchingEntries\[0\]\.status\s*!==\s*SHIFT_STATUSES\.ACTIVE/
    );

    assert.match(
      handoverSource,
      /status:\s*SHIFT_STATUSES\.HANDOVER_PENDING/
    );

    assert.match(
      handoverSource,
      /for\s*\(\s*const record of\s*scheduleUpdates\s*\)/
    );

    assert.match(
      handoverSource,
      /transaction\.update\(\s*record\.scheduleRef/
    );
  }
);

test(
  "handover does not fabricate attendance finalize authorization or end memberships",
  () => {
    assert.doesNotMatch(
      handoverSource,
      /shiftAttendance/
    );

    assert.doesNotMatch(
      handoverSource,
      /nextShiftAuthorizations/
    );

    assert.doesNotMatch(
      handoverSource,
      /transaction\.(?:create|set|update|delete)\(\s*shiftMembers/
    );

    assert.doesNotMatch(
      handoverSource,
      /leftAt\s*:/
    );

    assert.doesNotMatch(
      handoverSource,
      /clockOut\s*:/
    );
  }
);

test(
  "successful completion advances the global slot while permanent pair authority remains untouched",
  () => {
    assert.match(
      completionSource,
      /advanceOperationalShiftControl\(/
    );

    assert.match(
      completionSource,
      /transaction\.update\(\s*operationalShiftControlRef,\s*nextControl/
    );

    assert.doesNotMatch(
      completionSource,
      /technicianPairs/
    );

    assert.doesNotMatch(
      completionSource,
      /technicianPairMemberships/
    );

    assert.match(
      completionSource,
      /permanentPairId:\s*shift\.permanentPairId/
    );
  }
);

test(
  "handover fails closed on persisted membership identity",
  () => {
    assert.match(
      handoverSource,
      /typeof member\.id !== "string"/
    );

    assert.match(
      handoverSource,
      /member\.id !== document\.id/
    );

    assert.doesNotMatch(
      handoverSource,
      /\.\.\.member,\s*id:\s*document\.id/
    );
  }
);
