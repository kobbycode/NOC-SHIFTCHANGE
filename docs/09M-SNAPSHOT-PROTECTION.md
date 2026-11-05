# 09M-R1: snapshot protection and recovery

These commands protect only `demo-shiftchange-v2-09m` and outgoing shift
`WfKvXM6ZamF8P4n1lWlA`. They do not alter application attendance semantics or
the incoming acceptance coordinator. Run from the repository root with Node 24
and the installed `tsx` dependency. Examples are operating instructions for a
future authorized save/start/stop; none were executed against live services
during implementation validation.

## Checkpoints

Save and restore require the **exact highest verified checkpoint**, not a
minimum. Selecting a later checkpoint for an earlier rehearsal is also refused.
There is no automatic fallback to another snapshot.

| Checkpoint | Evidence checked offline |
| --- | --- |
| `base_fixture_created` | Expected shift and roster, Auth/profile UID relationships, active permanent pair, memberships and operational control |
| `operational_evidence_recorded` | Base fixture plus shift-scoped events with document identity, authenticated author and timestamp provenance |
| `handover_initiated` | Operational evidence plus outgoing shift/control lifecycle and initiation actor/time |
| `incoming_pair_reserved` | Valid V2 aggregate and reservation, V2 guard ownership/lineage, incoming pair and reserved schedules |
| `consolidated_report_prepared` | Matching preparation key, shift, reservation and content digest; current review binding before initial freeze |
| `report_frozen` | Bound immutable report, validated content/digest/binding, preparation relationship and no completeness blockers |
| `outgoing_confirmations_completed` | Both outgoing personal confirmations bound to the current snapshot and frozen report |
| `handover_committed` | Committed/completed lifecycle plus the outgoing commitment receipt, provenance and receipt hash |
| `incoming_acceptance_activated` | Activation receipt/hash, completed outgoing shift, active incoming shift/control, actual accepting technician's membership, attendance and finalized personal evidence operation |

The activation checkpoint proves **first acceptance and activation**, not that
both incoming technicians have arrived. `incomingParticipation` separately
reports each incoming technician's membership/attendance existence. Evidence
finalization alone never proves activation. These checkpoints identify preserved
workflow evidence; they are not permission to freeze, confirm, activate, or
override current application readiness and scheduling checks. In particular,
`operational_evidence_recorded` means events exist, not that all broadcast/task
requirements for freezing have been satisfied.

## Read-only inspection and verification

```powershell
node --import tsx --conditions=react-server scripts/09m-snapshot.mjs inspect --directory .demo/uat-09m-emulator-snapshots/2026-10-23T16-16-05-055Z
node --import tsx --conditions=react-server scripts/09m-snapshot.mjs verify --directory .demo/uat-09m-emulator-snapshots/<new-snapshot-id>
node --import tsx --conditions=react-server scripts/09m-snapshot.mjs select --checkpoint consolidated_report_prepared
```

These commands never contact the hub or start emulators. `inspect` computes an
offline inspection without requiring a manifest. `verify` compares the manifest
against the actual export and returns a nonzero exit code for a legacy export
without a manifest. `select` reads only `LATEST.json` and its exact target.

Document inspection states are `complete`, `missing`, `incomplete` (with a
reason), or `not_inspected` (with a reason). Schema completeness and workflow
relationship checks are separate: every milestone lists whether its required
relationships were verified. No absent/unchecked report is represented as a
verified preparation. Unsupported export encodings/versions fail closed.

## Save and pointer publication

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-uat-09m-save.ps1 -Checkpoint consolidated_report_prepared
```

The existing `.demo/run-uat-09m-save.ps1` forwards to this tracked implementation.
The old JavaScript save entry point also requires `--checkpoint`.

1. Verify the 09M environment tuple and loopback hub ports (Auth 9399, Firestore
   8380, hub 4405).
2. Take an exclusive `.save.lock` under the 09M snapshot root.
3. Export Auth and Firestore to a previously nonexistent timestamp/UUID target.
4. Decode all exported documents, verify project identity, metadata/shard
   references, record CRC32C checksums and document counts.
5. Verify the exact intended checkpoint and its authoritative relationships.
6. Write `snapshot-manifest.json` with exclusive creation, flush it, reread it
   and validate it against the export.
7. Flush a unique temporary pointer and atomically rename it to `LATEST.json`.

Errors before publication leave the previous pointer unchanged. Failed new
exports remain unreferenced for inspection; no snapshot directory is deleted.
Concurrent writers fail on the lock. A hard interruption can leave a stale lock
or temporary pointer. Inspect process state and the failed directory before an
operator explicitly removes only that stale temporary file; never remove a
lock belonging to an active saver. There is no automatic stale-lock deletion.

Earlier checkpoints are valid saves when accurately requested/labeled. An
explicit save of an earlier checkpoint can move `LATEST` backwards; all existing
snapshot directories remain preserved. Choose checkpoint intent deliberately.

## Immutable manifest schema

New manifests use `schema: shiftchange-09m-snapshot-v1` and contain exactly:

```json
{
  "schema": "shiftchange-09m-snapshot-v1",
  "snapshotId": "<UTC timestamp>_<UUID>",
  "createdAt": "<canonical UTC ISO timestamp>",
  "requestedCheckpoint": "<exact highest verified checkpoint>",
  "inspection": {
    "projectId": "demo-shiftchange-v2-09m",
    "authAccountCount": 6,
    "firestoreDocumentCount": 0,
    "firestoreCollectionCounts": {},
    "exportVersions": {},
    "files": [{ "path": "<relative path>", "bytes": 0, "sha256": "<digest>" }],
    "state": {
      "shiftId": "WfKvXM6ZamF8P4n1lWlA",
      "shiftLifecycleStatus": "<observed status>",
      "highestVerifiedMilestone": "<verified checkpoint>",
      "milestones": {},
      "documents": {},
      "operationalEventCount": 0,
      "outgoingAttendanceCount": 0,
      "reservationIdentity": null,
      "preparation": null,
      "frozenReport": null,
      "handoverLifecycleStatus": null,
      "incomingParticipation": {}
    }
  },
  "inspectionDigest": "<SHA-256 of canonical inspection>"
}
```

Numbers/nulls above illustrate shape, not a real verified fixture. Present
preparation summaries include ID, revision and digest; frozen-report summaries
include ID, version, digest and binding. Every exported file except the manifest
itself is covered by path, byte length and SHA-256. The new pointer contains its
own schema, project, shift, selected snapshot/checkpoint, save time and manifest
SHA-256. Neither manifest nor console output contains Auth credentials. Exported
Auth files remain sensitive and must remain local/ignored.

Immutability is enforced by exclusive creation and later integrity verification,
not filesystem ACLs, signatures or tamper-proof storage. The reader deliberately
supports Firestore emulator `1.22.0` EntityProto/LevelDB-log exports. Unknown
property encodings or a different version require a reviewed reader update.

## Restore and explicit legacy recovery

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-uat-09m-emulators.ps1 -Checkpoint consolidated_report_prepared
```

Selection completes before any configuration file is modified. The launcher
prints requested and actual milestones, integrity status and exact import
directory, refuses occupied ports, and never stops another process. It never
automatically imports an alternative export or starts an empty replacement.

The five October 23 exports have no immutable manifests. They are retained
unchanged; the historical `LATEST.json` boolean `verified: true` does not confer
R1 manifest verification. Normal restore therefore refuses them. To inspect an
explicit legacy selection without starting services:

```powershell
node --import tsx --conditions=react-server scripts/09m-snapshot.mjs select --checkpoint handover_initiated --allow-legacy --recovery-reason "Owner-approved inspection of the historical 09M export"
```

For a later authorized restart, the equivalent launcher switches are
`-AllowLegacySnapshot -RecoveryReason "..."`. An intentionally different
checkpoint additionally requires `-AllowCheckpointMismatch`; output still
reports the actual earlier/later milestone. Neither override bypasses project,
shift, structural, checksum, or existing-manifest mismatch failures. A managed
export whose manifest was deleted cannot masquerade as an old legacy export.
No manifests are backfilled into old snapshots.

## Stop

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-uat-09m-emulators.ps1 -Checkpoint consolidated_report_prepared
```

A failed save throws before process termination. Stop targets only listeners on
09M ports whose command lines identify `demo-shiftchange-v2-09m`. Emergency
`-NoSave` additionally requires a meaningful `-RecoveryReason`; it explicitly
discards unsaved state and is not a normal preservation workflow.

## Regression validation

```powershell
node --import tsx --conditions=react-server --test tests/09m-snapshot-protection.test.mjs
```

The suite creates synthetic exports only in uniquely named OS temporary
directories. It does not import the Firebase client/admin SDK, start emulators,
request a live export, or invoke the launcher/stop scripts. Cleanup verifies its
temporary directory boundary before recursive removal.
