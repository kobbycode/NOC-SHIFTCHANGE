# 09M-R2 — attendance reporting integrity

Branch: `feature/handover-v2-recovery`. Review date: October 28, 2026.

R2 changes report generation and presentation only. Existing preparations and
frozen reports are not migrated. No live Firestore access, emulator operation,
snapshot operation or handover transition was performed. Stop before R3.

## Baseline and files

The starting tree was already dirty. In particular, the report Firestore file
already contained notification hooks and stricter absence-clear authorization;
the report emulator tests already contained related changes. These were retained.
Attendance evidence/shift-join domains and the workflow UI had no starting Git
diff. R1's manifest, pointer and restore implementation was reviewed and retained.
The installed Next client directive guide was read before editing the client UI.

| Changed file | Purpose |
| --- | --- |
| `src/lib/operations/handover-report-attendance.ts` (new) | Pure attendance reduction and classified notice generation |
| `src/lib/operations/handover-report-attendance-view.ts` (new) | Client-safe labels and notice grouping from stored report fields |
| `src/lib/operations/equal-handover-report-firestore.ts` | Uses the reducer; classifies incident/profile notices |
| `src/components/operations/handover-workflow-v2.tsx` | Separate reporting, clock evidence and worked-hours columns; notice categories |
| `tests/handover-report-attendance.test.mjs` (new) | 25 isolated regression tests, including production report transaction paths |
| `tests/handover-v2-report-emulator.test.mjs` | Updates the five exact warning-string assertions affected by R2 |
| `docs/09M-R2-MILESTONE-REPORT.md` (new) | This report |

No change was made to persisted report types, digest/validation algorithms,
attendance read/evidence/shift-join domains, readiness rules, snapshot tooling,
or the acceptance coordinator. The report file's source from
`function readV2Aggregate(` onward is byte-for-byte identical to its pre-R2
copy, covering preparation/freezing, absence, confirmation, commit and activation
writers. R2 changes the live content those existing gates compare.

## Before and after

| Evidence condition | Previous report | R2 report |
| --- | --- | --- |
| Scoped non-provisional legacy `present`, null clocks | Could say attendance missing | Reporting confirmed; personal clock evidence unavailable; worked hours unknown |
| Legacy reporting timestamp | Retained inside legacy record | Also exposed as reporting-only event time; never becomes clock-in |
| Missing outgoing legacy and V2 evidence | Generic attendance/hours warnings | Reporting evidence required, personal clocks unavailable, hours unknown; no absence inferred |
| Provisional legacy record | Could supply clocks despite provisional state | Raw record retained; not reporting confirmation or a personal clock source; provisional warning |
| Non-`present` legacy status | No explicit reporting-status warning | Exact status flagged; valid non-provisional personal clocks remain independent |
| Invalid or mismatched legacy record | Reader validation | Still fails closed, before a preparation can be written |
| Incoming without personal evidence | Missing attendance and unknown hours warnings | Awaiting personal acceptance; clocks not yet due; worked hours not yet applicable |
| Valid incoming personal clock-in/late acceptance evidence | Personal event and clock-in | Existing personal evidence contract retained; hours unknown without clock-out |
| Colleague departure attestation | Separate provenance | Preserved; never personal clock-out or computed hours |
| Explicit aggregate absence | Explicit declaration | Preserved and labeled; never inferred from missing attendance |

Reporting confirmation uses the existing reporting-evidence shape with
`kind: legacy_present_reporting`, `authenticationMethod: legacy_reporting_record`,
`personallyAuthenticated: false`, and `eventTime: legacy.recordedAt`. An existing
personal/attested V2 source retains its original provenance instead of being
overwritten by the legacy summary. The full legacy record stays in the row.
No V2 attendance document is created by this representation.

Personal clocks come only from valid non-provisional, outgoing-scoped legacy
clock fields or the existing appropriate V2 personal evidence. Incoming records
read under the outgoing shift cannot supply legacy clocks. Hours use the existing
duration function and require both valid personal clocks. Neither reporting time,
scheduled/actual shift start nor an attested departure supplies a missing clock.
Payable-hours policy remains unresolved.

## Exact warning changes

Persisted `completeness.warnings` remains `string[]`. Prefixes encode the smallest
compatible classification change; no blocker was removed or downgraded.
`<name>` is the authoritative profile name or UID fallback.

| Old text/condition | New text |
| --- | --- |
| `No fault or technical activity records were submitted. This is not a declaration of no faults.` | `Information: No fault or technical activity records were submitted. This is not a declaration of no faults.` |
| `Attendance missing: <name>` for a confirmed outgoing legacy record | Removed; reporting is confirmed. Missing clocks are still explicitly reported below. |
| `Attendance missing: <name>` for missing outgoing evidence | `Evidence required: Reporting attendance missing: <name>` |
| Provisional outgoing record | `Evidence required: Reporting attendance is provisional: <name>` |
| Non-present outgoing record | `Evidence required: Reporting attendance status is <status>: <name>` |
| One or both outgoing personal clocks unavailable | `Evidence required: Personal clock evidence unavailable: <name>` |
| `Hours worked cannot be determined: <name>` | `Information: Worked hours unknown: <name>` when evidence is due |
| Incoming missing-attendance and hours warnings before personal evidence | `Not yet due: Awaiting personal acceptance: <name>. Worked hours: Not yet applicable.` |
| Explicit absence | `Information: Declared absence (<absence type with spaces>): <name>` |
| `One or more staff names are missing from authoritative account profiles.` | `Evidence required: One or more staff names are missing from authoritative account profiles.` |

For the synthetic equivalent of the earlier nine-warning condition (two
outgoing present/null-clock rows, two incoming awaiting acceptance, no incident),
there are seven classified notices: four clock/hour notices, two not-yet-due
notices, and one incident information notice. This is a fixture result, not a
new preparation or a read of the unavailable historical prepared report.

Only `tests/handover-v2-report-emulator.test.mjs` depended on the old exact
strings/prefixes in the repository-wide test search. Its affected assertions
were updated; no emulator tests were run against a live project.

## Compatibility and immutability

- Report schema, row fields and the warnings array shape stay unchanged.
  Existing validators accept historical content and digest it unchanged.
- New generated content has a different digest where its evidence summaries or
  notices change. The raw evidence-bundle hash algorithm is unchanged.
- A read does not rewrite stored content. Existing preparation drift checks
  compare old content with new live semantics; stale preparation freeze fails.
  An explicit future preparation is required to append a revision and preserve
  the earlier digest/history. None was created in live UAT.
- Existing frozen documents and bindings are never rewritten. An open historical
  report can be flagged stale by existing readiness checks. Any subsequent new
  frozen version still requires the normal explicit correction workflow.
- Identical completed freeze retries retain their existing replay behavior;
  replay does not revise content or confer readiness. Completed handovers still
  use their stored immutable report without live regeneration.
- The UI groups old warning strings under `Historical / unclassified` and leaves
  their wording intact. Attendance labels describe stored row evidence; they
  do not write new report content or alter its digest. A frozen report remains
  a historical snapshot, not a live attendance dashboard after activation.
- R1's offline verifier remains compatible because no persisted field schema or
  digest algorithm changed. Historical snapshots are not upgraded in place.

## Validation

Final relevant regression run: **81 passed, 0 failed, 0 skipped**. Includes
25 new R2 tests plus existing attendance evidence, attendance reader, equal
handover and operational-event tests. The new suite uses the existing
in-memory transaction fixture and the real preparation, read and freeze
functions. Its synthetic writes never reach Firebase.

Coverage includes valid present/null clocks; missing/provisional/invalid/scoped
legacy evidence; independent personal clocks; missing clock endpoints/hours;
incoming before acceptance and both personal incoming evidence kinds; explicit
absence; colleague attestation; duplicate/mispositioned evidence; all six event
records including Asempa FM correction/provenance; preparation drift/revision
history; frozen digest/binding/replay immutability; completeness and confirmation
gates; and preparation writes restricted to permitted collections.

Initial new-test runs exposed cross-VM prototype comparison and call-signature
mistakes in the test harness. A later intermediate run used the old clock
expectations while the independent-clock correction was being applied. These
were corrected and the final complete run passed; no test was skipped or gate
bypassed. Logs are retained locally as `.demo/09m-r2-tests*.log`.

Full-project TypeScript (`tsc --noEmit --incremental false`) passed with exit
code 0 and no diagnostics. A separate compiler-API diagnostic attempt timed out;
an instrumented full-project compiler rerun subsequently passed as well (276
configured files, no diagnostics). Targeted ESLint passed with exit code 0 and
no diagnostics for the four changed production files and two changed test files.
Logs: `.demo/09m-r2-typecheck-final.log`,
`.demo/09m-r2-typecheck-instrumented.log`, `.demo/09m-r2-lint-final.log`.
`git diff --check` passed (line-ending conversion warnings only).
The dedicated emulator report suite was updated but not executed: restarting,
restoring or writing to a live emulator was prohibited. Browser visual QA and
an acceptance/activation end-to-end rehearsal were not performed.

## Preservation evidence

At `2026-10-28T05:59:28.623Z`, all **38 protected baseline files** matched their
SHA-256 hashes: 31 files covering all five existing 09M snapshot directories and
`LATEST.json`, plus seven R1 tooling files. No snapshot or manifest was created,
rewritten, restored or deleted; the snapshot-root file set still contains exactly
31 files with no additions. The final check also confirmed unchanged
lifecycle-writer source. Evidence: `.demo/09m-r2-preservation-final.json` and
`.demo/09m-r2-protected-baseline.json`.

No live Firestore requests were needed for R2. No emulator was restarted or
restored, and no live reservation, preparation, report, absence, confirmation,
commit, activation, attendance or membership record was created or changed.
Unrelated working-tree edits were retained. No Git commit/push/reset/deployment
was performed.

## Outstanding risks and R3 recommendation

The existing boundary between attendance finalization and activation remains
unchanged. A personal evidence record is not independently proof that activation
succeeded. R2 retains the existing authoritative evidence contract and does not
repair coordinator failure/retry behavior. Frozen report rows remain historical
even when incoming acceptance later occurs.

Personal clocks genuinely missing on outgoing rows remain evidence-required
notices. R2 neither supplies them nor decides that the report is safe to freeze.
Existing completeness/readiness and supported absence rules remain authoritative.
An absence-like legacy status with valid personal clocks remains visible as a
status warning while preserving the independently recorded clocks and duration;
reconciliation requires review rather than silently discarding evidence.

Recommended 09M-R3: review R2, then authorize a separate transactional integrity
audit and isolated failure/retry recovery tests for personal evidence finalization
versus activation. Include first and second incoming acceptance, failed activation,
retries, receipt/membership/attendance consistency and recovery from an interrupted
operation. Any coordinator redesign or live UAT rehearsal needs separate approval.
Do not use the R2 notice count as freeze approval.
