# 09M-R1 milestone report

Review date: October 28, 2026. Implementation complete; operational validation is limited by currently unavailable local services. Stop here before 09M-R2.

## Starting state and scope

Repository: `C:\Users\Jonah\Desktop\KobbyProject\NOC-SHIFTCHANGE`.
Branch: `feature/handover-v2-recovery` (verified again at completion).
The starting working tree was already dirty, with application, authentication,
handover, configuration and test changes, plus untracked functions,
notification and UAT work. Those changes were retained. This milestone adds
snapshot tooling and documentation; it does not change application attendance
semantics or the acceptance coordinator. No commit, push, reset or deployment
was performed.

At the earlier baseline the 09M stack used project
`demo-shiftchange-v2-09m`, app 3130, Auth 9399, Firestore 8380, hub 4405,
logging 4505 and websocket 9480. Recorded processes were Firebase Node 11112,
Firestore Java 17312 and application server 14620. The Java import path
identified the October 23 16:16 export below. These are baseline observations,
not claims that those processes remain running on October 28.

Protected environments identified: presentation `demo-shiftchange-v2`
(app 3100/Auth 9099/Firestore 8080), 09D `demo-shiftchange-v2-uat`
(app 3110/Auth 9199/Firestore 8180), and 09L `demo-shiftchange-v2-09l`
(app 3120/Auth 9299/Firestore 8280). No R1 operation targeted their services
or configuration.

## Snapshot inventory and recovery finding

All entries are under `.demo/uat-09m-emulator-snapshots/` and are legacy
exports without immutable manifests.

| October 23 snapshot | Firestore documents | Auth users | Events | Outgoing attendance | Highest verified checkpoint |
| --- | ---: | ---: | ---: | ---: | --- |
| `2026-10-23T11-18-12-507Z` | 36 | 6 | 0 | 2 | `base_fixture_created` |
| `2026-10-23T11-18-37-673Z` | 36 | 6 | 0 | 2 | `base_fixture_created` |
| `2026-10-23T11-42-08-081Z` | 36 | 6 | 0 | 2 | `base_fixture_created` |
| `2026-10-23T11-42-40-228Z` | 36 | 6 | 0 | 2 | `base_fixture_created` |
| `2026-10-23T16-16-05-055Z` | 55 | 6 | 6 | 2 | `handover_initiated` |

None contains the missing V2 reservation, preparation or frozen report. The
historical latest pointer references the final entry; its historical verification
boolean is not an R1 integrity guarantee. Available evidence supports an earlier
saved checkpoint, rather than selective loss during restore. The exact cause
or time of any unsaved browser work cannot be established from these exports.

Safest recovery: retain every export and the current pointer; do not pretend a
prepared report can be recovered from them. A later authorized restart must
explicitly acknowledge legacy recovery and its actual checkpoint. Recreating
the missing workflow, if desired, requires a separate authorized UAT operation.

## Files and purposes

| File | Purpose |
| --- | --- |
| `scripts/snapshots/firestore-export.mjs` | Offline Firestore EntityProto/log decoder, CRC32C and metadata validation |
| `scripts/snapshots/09m-snapshots.mjs` | Authoritative milestone relationships, export integrity, manifests, exact selection and transactional pointer publication |
| `scripts/09m-snapshot.mjs` | Inspect/verify/select/save CLI; live save restricted to the expected 09M environment |
| `scripts/09m-runtime.ps1` | Shared executable discovery |
| `scripts/run-uat-09m-save.ps1` | Mandatory checkpoint save entry point |
| `scripts/start-uat-09m-emulators.ps1` | Validates selection before configuration changes/start; refuses occupied ports |
| `scripts/stop-uat-09m-emulators.ps1` | Save before stop; save failure prevents termination; explicit emergency recovery reason |
| `tests/helpers/snapshot-fixtures.mjs` | Synthetic exports and workflow fixtures in disposable directories |
| `tests/09m-snapshot-protection.test.mjs` | 35 protection and relationship regression tests |
| `docs/09M-SNAPSHOT-PROTECTION.md` | Manifest schema, checkpoint definitions, commands and recovery runbook |
| `docs/09M-R1-MILESTONE-REPORT.md` | This review report |

The four ignored `.demo` compatibility entry points for save/start/stop and
`save-uat-09m-emulators.mjs` now forward to the tracked implementation. Original
copies were preserved under `.demo/09m-r1-original-scripts/`. Baseline hashes,
inspection outputs and validation logs remain local under `.demo/09m-r1-*`;
they are not snapshot exports. No environment credential file was added to Git.

## Schema and behavior

The complete schema and command examples are in
[the runbook](09M-SNAPSHOT-PROTECTION.md). New `snapshot-manifest.json` files
contain exactly `schema`, `snapshotId`, `createdAt`, `requestedCheckpoint`,
`inspection` and `inspectionDigest`. Inspection records project, versions,
Auth/document counts, every exported file's path/size/SHA-256, shift lifecycle,
events, attendance, reservation identity, preparation revision/digest, report
binding, incoming participation and milestone verification reasons. Document
states distinguish complete, missing, incomplete and not inspected.

Save acquires an exclusive lock, exports to a new directory, checks structure,
checksums and authoritative relationships, requires the exact requested highest
checkpoint, exclusively creates and verifies the manifest, then atomically
publishes a flushed latest pointer bound to the manifest hash. Pre-publication
failure preserves the old pointer. Failed new directories are retained.

Selection reads only the pointed-to export and verifies project, shift,
integrity and exact checkpoint. It never chooses an alternative. Legacy exports
require an explicit recovery reason; a checkpoint mismatch requires a separate
override. Neither override excuses corruption or an incorrect project/shift.
Existing manifests are never backfilled or overwritten.

All nine workflow stages have relationship checks. The final activation stage
means first successful personal acceptance and activation, not both incoming
technicians' arrival. Finalized evidence alone cannot prove activation. Snapshot
verification does not authorize a report freeze or replace application readiness
checks.

## Validation and preservation

- Regression suite: **35 passed, 0 failed**, using disposable synthetic exports.
  Covers all nine stages, missing/incomplete/foreign reservations and reports,
  digest/receipt/guard mismatches, export corruption/truncation, failed saves,
  concurrent writers, manifest tampering, exact checkpoint selection, explicit
  legacy recovery and deleted managed manifests.
- TypeScript check passed during implementation; its captured log is
  `.demo/09m-r1-typecheck.log`.
- Targeted lint passed during implementation. October 28 completion reruns
  produced no diagnostics but had not returned at report time; they do not
  constitute an additional confirmed pass.
- PowerShell AST parsing passed for seven launcher/runtime/compatibility files.
  Parsing did not execute start, save or stop operations.
- `git diff --check` passed on October 28 (only a pre-existing tsconfig line-ending
  conversion warning).
- At `2026-10-28T05:34:20.545Z`, all **31 existing snapshot-root files**, including
  `LATEST.json`, matched the original SHA-256 baseline with an identical file set.
  No existing snapshot or manifest was changed or added.
- Fourteen authoritative collection responses were fingerprinted at baseline.
  The October 28 comparison could not connect to Firestore 8380. Hub 4405 and
  application login 3130 were also unreachable. Consequently current live-data
  equality and application usability are **not verified**. No restart was
  attempted. Evidence is `.demo/09m-r1-preservation-final.json`.
- Validation made no Firestore writes, no live export, no restore and no handover
  transition. No other protected stack was operated on. This supports the scope
  of our actions; it does not substitute for the unavailable live comparison.

## Risks and limitations

1. Live export/start/stop behavior has synthetic and static validation, but no
   live end-to-end rehearsal, as required by the restrictions. App usability and
   live preservation need a later read-only check when services are available.
2. The offline reader supports Firestore emulator 1.22.0 and fails closed on
   unsupported encodings/versions. Upgrades need a reviewed reader change.
3. Exclusive manifest creation and hashes detect accidental change; they are
   not signatures, ACL immutability or protection from an actor rewriting all
   artifacts. Auth exports remain sensitive local files.
4. Interrupted saves can leave locks or temporary files requiring deliberate
   operator inspection. No automatic stale-lock deletion occurs.
5. Explicitly saving an earlier accurately labeled checkpoint can move the
   latest pointer backwards. Older directories remain preserved.
6. Ignored compatibility wrappers must be deployed separately in another
   checkout; tracked scripts are the durable implementation.
7. Legacy attendance interpretation and the split evidence-finalization/shift-
   activation transaction remain unchanged. R1 does not establish report safety
   to freeze or resolve those previously identified issues.

## Recommended next milestone

Review R1 first. Before further live UAT, recheck service availability and the
baseline without automatically restarting or restoring anything. Then, with
explicit approval, 09M-R2 should correct attendance-report semantics: recognize
authoritative legacy present attendance as reporting confirmation, keep unknown
personal clocks/hours unknown, mark incoming evidence not yet due before
personal acceptance, and distinguish informational conditions from missing
required evidence while preserving event provenance and audit history. Review
activation failure/retry integrity separately before changing its coordinator.

No R2 implementation, reservation, preparation, freeze, confirmation, commitment
or activation was performed.
