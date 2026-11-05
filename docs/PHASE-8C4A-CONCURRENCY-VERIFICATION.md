# Phase 8C.4A — Real Firestore concurrency, negative evidence and eligibility safety verification

Recorded: 2026-11-03. Verification milestone. No operational recovery was executed, no V2 approval
implementation was started, and nothing outside a disposable emulator instance was touched.

Harness: `tests/recovery-concurrency-8c4a.test.mjs` (1 394 lines, 20 tests) driven by
`tests/run-recovery-concurrency-8c4a.ps1` against a dedicated Firestore-only emulator project
`demo-recovery-concurrency-8c4a` (port 8186, websocket 9086, hub 4414, logging 4514, no
import/export). Final run: `.demo/p8c4a-full-run5.txt` — **20 tests, 20 pass, 0 fail**.
Iterative runs 1–4 (`.demo/p8c4a-full-run*.txt`) are kept as the audit trail of how each matrix row
was corrected against the real behaviour rather than an assumed one.

---

## 1. Baseline preservation

Branch `feature/handover-v2-recovery`, HEAD `c1703530437ff4e45010dde4f920597fe7684d9f`, 0 stashes,
0 staged entries — unchanged from the start of the phase. No commit, push, merge, reset, stash,
migration, deployment or protected-UAT action was performed.

Protected-artifact re-compare (49 hash lines from the 8C.3 and 8C.4A baselines):
**48 byte-identical, 1 difference, 0 missing.** The single difference is
`src/lib/operations/incoming-acceptance-application-domain.ts` at
`6f708bbd784764e070091d6175a6df8d8fee492e2dcf557892105c613f106ea5`, which is the value the 8C.4A
baseline already recorded at the start of this phase (the additive
`createLegacyIncomingAcceptanceEventId` export delivered by 8C.3). Nothing moved during 8C.4A.

Working tree: tracked modified 50 → 50, staged 0 → 0, untracked entries 122 → 124. The two additions
are this phase's own files, `tests/recovery-concurrency-8c4a.test.mjs` and
`tests/run-recovery-concurrency-8c4a.ps1`. All logs and the one-off re-run harness live under
`.demo/`, which is git-ignored.

## 2. Files added or modified

| File | Status |
|---|---|
| `tests/recovery-concurrency-8c4a.test.mjs` | added this phase (§2–§5 suites) |
| `tests/run-recovery-concurrency-8c4a.ps1` | added this phase (isolated emulator runner, hard project/port guard) |
| `.demo/run-guard-emulator-8c4a.ps1` | added this phase; runs the **existing** guard emulator suite with the Qoder Temurin JRE because the protected runner hard-codes a Java path that no longer exists (see §8) |
| production `src/**`, `functions/**`, `firestore.rules`, every protected test and runner | **not modified** |

No production source was changed to make a test pass. Where a matrix row disagreed with reality, the
row was corrected to the documented rule and the reason recorded below.

## 3. A-1 on the real emulator: resolved, fenced by write-withholding

A-1 is the hazard "a transaction reads a document as absent, decides, and a concurrent writer creates
that document in between". Eleven probes (1 control + 10 document families) each hold a barrier inside
the eligibility transaction, let a non-transactional `set()` create the target, and read the outcome
back with server clocks. Control proves the harness can detect interleaving: a document read *as
present* is written immediately (`writeBeforeRead` impossible; observed `write-after-commit`).

Observed for **every** family — activation receipt, application receipt, application audit, incoming
shift, incoming membership, incoming attendance, atomic evidence operation, legacy evidence operation,
commit receipt, evidence document:

```
attempts = 1                     (no retry, no abort)
observations = [{ exists: false }]
pendingAtRelease = true          (the writer was still unacknowledged when the barrier opened)
writerAcknowledgedBeforeRelease = false
targetReadTime  < decisionCommitTime < targetCreateTime
serverOrdering  = "write-after-commit"
```

Firestore does not reject or retry the stale decision: it **withholds the concurrent write until the
reading transaction commits**. The negative decision is therefore always serialised strictly before the
document exists, which is exactly the fencing A-1 needs. A-1 is **resolved**.

Derived hazard (new, real): the same mechanism turns a long eligibility read into a stall on the
acceptance path. Measured in §3.5: an un-contended production acceptance commit takes ≈337 ms; issued
against 8 concurrent eligibility reads it takes 761–857 ms. Any recovery tooling that fans out
eligibility reads over busy handovers can delay live acceptances. Read-only is not the same as
non-interfering.

## 4. Controlled concurrency evidence (§3)

No timing sleep is used as proof anywhere. Ordering is taken from Firestore's own
`{seconds, nanoseconds}` clocks — one backend clock, so it is a happens-before oracle — and from the
serialisation oracle in §3.5 (a racing read is safe if and only if its digest equals one of the two
serial baselines; a third digest proves a torn read).

- §3.1 the expired world (38 documents) evaluates to `eligible_for_abandonment_review`, `refusals: []`,
  `executionAuthorized: false`, `executionAuthority: "none"`, repeatable, and a full-store fingerprint
  proves the reader wrote nothing. Baseline digest `40f243b0c41c92108c351a2c3b0170ccd2658885886e0bf84a9cceecb4e35879`.
- §3.2 the same evidence inside the open window refuses `activation_window_open` with a different digest.
- §3.3 a **real** production acceptance (`applyIncomingAcceptanceApplicationAtomically`, the same
  service the HTTP route calls) committed through the emulator flips the read to `acceptance_exists`
  (`ACTIVATION_RECEIPT_VALID`, `APPLICATION_RECEIPT_VALID`, …), digest `fcc64cc68d6372d76a701ffe0af454a086671054df69e13151b93c69fe485396`.
  The activation window was never bypassed: the earlier-window fixture is a genuinely open window, and
  evidence-conflict testing uses the separate expired fixture, as required.
- §3.4 injected partial artifacts (each in a fresh expired world, copied byte-for-byte from what the real
  acceptance wrote):

| injected artifact alone | classification | details |
|---|---|---|
| activation receipt | `acceptance_exists` | `ACTIVATION_RECEIPT_VALID` |
| application receipt | `inconsistent_evidence` | `APPLICATION_WITHOUT_AUDIT`, `RECONCILIATION_REQUIRES_REVIEW` |
| application audit | `inconsistent_evidence` | `AUDIT_WITHOUT_APPLICATION`, `RECONCILIATION_REQUIRES_REVIEW` |
| incoming membership | `inconsistent_evidence` | `MEMBERSHIP_WITHOUT_RECEIPT`, `RECONCILIATION_REQUIRES_REVIEW` |
| incoming attendance | `inconsistent_evidence` | `ATTENDANCE_WITHOUT_RECEIPT`, `RECONCILIATION_REQUIRES_REVIEW` |
| incoming shift | `acceptance_exists` | `INCOMING_SHIFT_ACTIVATED` |
| finalized evidence operation | `eligible_for_abandonment_review` | *(finding F-1, §9)* |

  Every row changes the digest, no row reproduces the complete-acceptance digest, and no row authorizes
  execution.
- §3.5 the acceptance raced against 8 concurrent eligibility reads, 3 runs: every reader returned one of
  the two serial baselines (8 "before", 0 "after" per run — no third digest, so no torn read) and the
  writer always committed.

## 5. Digest mutation matrix (§4)

Digest contract: schema `handover-recovery-eligibility-evidence` v1, sha-256 over the canonical form of
`digestMaterial(model, conclusion)` — the complete authoritative read model (aggregate, guard, guard
history, legacy handover, outgoing shift, slot, activation window, commit/activation receipts, incoming
shift, applications, memberships, attendance, evidence, reconciliation, report, review case,
`kindSetComplete`) plus the classification and the sorted `code:detail` refusal list. `evaluatedAt` and
`actorUid` are deliberately absent.

§4.1 mutates one binding in real Firestore, re-runs the production reader, reverts, and requires the
digest to return to the exact baseline value. Two documented expectations per row: **refuse** = the
value is cross-checked against another document, so the mismatch must not read eligible; **rebind** =
the value is digest material but not independently cross-checked, so the safe outcome is an eligible
conclusion under a *changed* digest (which is what a later approval binds to). All 32 rows pass:

| group | rows → observed classification |
|---|---|
| aggregate (8) | lifecycle `acceptance_exists`; revision / snapshotHash / `identity.successorGeneration` / `identity.scheduledEnd` / `reservation.outgoingGeneration` / `reservation.reservedBy` / `reportBinding.reportDigest` / unknown field added → `evidence_unverifiable:AGGREGATE_UNREADABLE` |
| guard (6) | lifecycle `inconsistent_evidence:GUARD_TERMINAL_AGGREGATE_OPEN`; revision → **rebind** `eligible` (live revision is only compared against archived history); fencing epoch `guard_binding_conflict:GUARD_EPOCH_MISMATCH`; successor token `GUARD_TOKEN_MISMATCH`; reserved incoming shift `GUARD_RESERVATION_MISMATCH`; protocol owner `GUARD_NOT_V2` |
| global slot (3) | owning shift `slot_binding_conflict:SLOT_NOT_OWNED`; generation `evidence_unverifiable:SLOT_UNREADABLE`; token `slot_binding_conflict:SLOT_TOKEN_MISMATCH` |
| receipts (2) | commit receipt missing `inconsistent_evidence:COMMIT_RECEIPT_MISSING`; commit receipt hash `COMMIT_RECEIPT_INVALID` |
| shifts / participation (4) | outgoing status `OUTGOING_SHIFT_STATUS_MISMATCH`; membership created `MEMBERSHIP_WITHOUT_RECEIPT` + review; attendance created `ATTENDANCE_WITHOUT_RECEIPT` + review; incoming shift created `acceptance_exists:INCOMING_SHIFT_ACTIVATED` |
| receipts / evidence (2) | activation receipt created `ACTIVATION_RECEIPT_INVALID`; unparseable operation document `evidence_unverifiable:EVIDENCE_UNREADABLE` |
| frozen report (1) | reportDigest patched → `evidence_unverifiable:REPORT_UNREADABLE` |
| review case (3) | valid open → **rebind**; valid closed → **rebind** (and the two digests differ from each other, so a replay across case states is impossible); malformed → `REVIEW_CASE_UNREADABLE` |
| legacy handover (2) | the real v1 record as the fixture wrote it, and a stub the v1 validator rejects, both → `LEGACY_RESERVATION_AMBIGUOUS` |

Proven inert by design (digest returns to baseline, classification unchanged, 5 rows):
`aggregate.updatedAt`, `guard.reservedBy`, `guard.updatedAt`, `guard.retiredSuccessorSlotTokens`, an
unbound `shifts/<outgoing>.notes` field. These are wall-clock bookkeeping, operator identity already
carried by the audit trail, and a token list the model never consults: every field that *points* at
other content (`id`, `ownerHandoverDocumentId`, `guardRevision`, `fencingEpoch`, `outgoingSlotToken`,
`successorSlotToken`, `reservationId`, `reservedIncomingShiftId`, `reservedAt`, `terminalEvidenceRef`)
is digest material, so a document cannot be re-pointed while staying digest-stable.

Invariance: §4.1 also re-evaluates as two genuinely authorized peers (`users/<uid>` documents with
`role: supervisor` and `role: admin`, because the reader authorizes the viewer from the store) and at a
clock two hours later — identical digest, identical classification, different `evaluatedAt`. §4.2
reseeds the whole world in reversed arrival order: identical digest (`40f243b0…`), identical canonical
material.

§4.3 evidence-operation states (schema-coherent only: statuses are `pending | finalized | aborted`, and
"interrupted" is the boolean `interruptedFinalization` that only a finalized operation may carry):

| operation state | classification | details |
|---|---|---|
| finalized | `eligible_for_abandonment_review` | *(F-1)* |
| finalized + interruptedFinalization | `acceptance_outcome_uncertain` | `OPERATION_INTERRUPTED` |
| pending | `acceptance_outcome_uncertain` | `OPERATION_PENDING` |
| aborted (time + reason) | `eligible_for_abandonment_review` | *(F-1 family)* |
| incoherent: pending carrying `finalizedAt` | `evidence_unverifiable` | `EVIDENCE_UNREADABLE` |

The oracle here is a **bijection**, not a count: for every pair of variants, digest equality and
canonical-visible-state equality agree, and no two variants share visible state. All five states are
individually visible; deleting the document restores the baseline digest exactly.

*(Method note: the first drafts of §3.4 and §4.3 wrote captured artifacts by spreading store documents,
which silently drops the `Timestamp` prototype; the reader then hydrated those fields to `null` and
several states collapsed into `EVIDENCE_UNREADABLE`. That was a harness defect, not a model result. The
fixture serialiser now converts `_seconds/_nanoseconds` back into real `Timestamp`s and every state was
re-measured; the collapse disappeared and the 5-way distinctness above is the honest outcome.)*

## 6. Guard lifecycle matrix (§5)

16 states, each applied to the seeded world, evaluated, reverted, and required to return to the baseline
digest afterwards. Every state that is not the clean active guard moves the digest; every ambiguous state
refuses with a reason.

| state | classification | details |
|---|---|---|
| active and consistent | `eligible_for_abandonment_review` | — (digest = baseline) |
| cancelled while the aggregate is still open | `inconsistent_evidence` | `GUARD_TERMINAL_AGGREGATE_OPEN` |
| completed while the aggregate is still open | `inconsistent_evidence` | `GUARD_TERMINAL_AGGREGATE_OPEN` |
| archived predecessor, re-acquired at the same epoch | `eligible_for_abandonment_review` | — (digest ≠ baseline; consistent re-acquisition is legitimately still eligible) |
| re-acquired with an advanced fencing epoch | `guard_binding_conflict` | `GUARD_EPOCH_MISMATCH` |
| archived revision not behind the live guard | `guard_binding_conflict` | `GUARD_REVISION_MISMATCH` |
| active guard cites a terminal archive that does not exist | `guard_binding_conflict` | `GUARD_LIFECYCLE_NOT_ACTIVE` |
| forged archive (payload does not hash to its document id) | `evidence_unverifiable` | `GUARD_HISTORY_UNREADABLE` |
| forged archive **and** the live guard cites it | `evidence_unverifiable` | `GUARD_HISTORY_UNREADABLE` + `GUARD_LIFECYCLE_NOT_ACTIVE` (fails closed twice over) |
| invalid fencing epoch | `guard_binding_conflict` | `GUARD_EPOCH_MISMATCH` |
| protocol v1 ownership | `guard_binding_conflict` | `GUARD_NOT_V2` |
| guard document unreadable | `evidence_unverifiable` | `GUARD_UNREADABLE` + `REPORT_UNREADABLE` |
| guard missing | `evidence_unverifiable` | `GUARD_MISSING` + `REPORT_UNREADABLE` |
| real v1 legacy record mid-collection | `evidence_unverifiable` | `LEGACY_RESERVATION_AMBIGUOUS` |
| legacy record already terminal | `eligible_for_abandonment_review` | — (digest ≠ baseline; documented exception, and the state is still bound) |
| legacy stub the v1 validator cannot read | `evidence_unverifiable` | `LEGACY_RESERVATION_AMBIGUOUS` |

Two corrections landed here after measuring rather than assuming. Deleting the guard does **not** yield
`guard_binding_conflict`: the frozen report can only verify against a readable guard, so
`REPORT_UNREADABLE` outranks `GUARD_MISSING` and the outcome is the stronger
`evidence_unverifiable`. And a "legacy record already terminal" is the documented *exception* to the
ambiguity rule — asserting `LEGACY_RESERVATION_AMBIGUOUS` there was wrong; the safe property is that the
state is still bound into the digest.

## 7. Writer inventory and completeness (§6)

`firestore.rules:11-12` is `match /{document=**} { allow read, write: if false; }`: no client, browser
session or App SDK path can create or modify any document in these families, and none can read them
either. `functions/src` contains zero writes to these families. So every reachable write is one of the
server-side Admin SDK sites below; that is what makes a negative proof possible here.

| family | writers (file:line, all inside `db.runTransaction` unless noted) |
|---|---|
| `equal_handovers_v2` | `equal-handover-reservation-firestore.ts:585,586`; `equal-handover-report-firestore.ts:954,1034,1126,1350,1672,2037`; `incoming-acceptance-application-firestore.ts:1387` |
| `handover_reservation_guards` | `handover-reservation-guard.ts:113,141,153,183,212,234,249,251` (caller-supplied transaction); `formal-handover.ts:404,407`; `formal-handover-transfer.ts:144,322,336→388-390` |
| `handover_reservation_guard_history` | **exactly one writer**: `handover-reservation-guard.ts:112` (`transaction.create`, archived in the same transaction as its successor, and `:96-104` refuses if the archive id already exists) |
| `operational_shift_control/global` | `operational-shift-control.ts:136,240`; `create-shift.ts:580,585`; `begin-shift-handover.ts:644`; `start-shift.ts:735`; `complete-shift.ts:943`; `recover-expired-scheduled-shift.ts:944`; `formal-handover-transfer.ts:306`; `equal-handover-report-firestore.ts:2067`; `incoming-acceptance-application-firestore.ts:1448` |
| `shifts` | `create-shift.ts:557`; `operational-shift-control.ts:233`; `begin-shift-handover.ts:627`; `start-shift.ts:718`; `complete-shift.ts:926`; `recover-expired-scheduled-shift.ts:927`; `shift-operations.ts:120`; `equal-handover-report-firestore.ts:2038,2041`; `incoming-acceptance-application-firestore.ts:1388,1395`; `formal-handover-transfer.ts:288,290` |
| `shift_members` | `create-shift.ts:563`; `create-shift-member.ts:335`; `join-shift.ts:424`; `complete-shift.ts:956`; `recover-expired-scheduled-shift.ts:960`; `equal-handover-report-firestore.ts:1909,2049,2050`; `incoming-acceptance-application-firestore.ts:1417,1419,1591`; `formal-handover-transfer.ts:297,299` |
| `shift_attendance` | `join-shift.ts:418`; `equal-handover-report-firestore.ts:1912,2053`; `incoming-acceptance-application-firestore.ts:1427,1599`; `formal-handover-transfer.ts:338` |
| `attendance_evidence_v2` | `attendance-evidence-firestore.ts:273`; `atomic-acceptance-evidence.ts:438` |
| `attendance_evidence_operations_v2` | `attendance-evidence-firestore.ts:147,274,336`; `atomic-acceptance-evidence.ts:443,449`; **and the only non-transactional write in all families: `attendance-evidence-firestore.ts:405`** |
| `incoming_acceptance_applications_v1` | `incoming-acceptance-application-firestore.ts:1453,1619` |
| `audit_logs` (commit / activation receipts, acceptance audit) | `equal-handover-report-firestore.ts:1685,2080`; `incoming-acceptance-application-firestore.ts:1449,1457,1623`; `incoming-acceptance-guard-finalization.ts:1061` |
| `handover_reports_v2` | `equal-handover-report-firestore.ts:1349` |
| `handover_review_cases_v1` | `handover-admin-review-firestore.ts:1528` (create), `:1534` (update) |
| `handover_review_decisions_v1` / `_adjudications_v1` | `handover-admin-review-firestore.ts:1537,2107` (both create-only) |
| `handover_recovery_approvals_v1` | `handover-recovery-approval-firestore.ts:465,636,781,986,987` (+ audit rows `:466,643,789,991`) |

Reader coverage: the eligibility reader (`handover-recovery-eligibility-firestore.ts:941-1069`) reads
`users/<actor>`, `equal_handovers_v2`, the guard and its history (via `readReservationGuardState`, which
also supplies the legacy `handovers/<id>` snapshot consumed at `:966`), `shifts` (outgoing and incoming),
`operational_shift_control/global`, `handover_review_cases_v1`, `attendance_evidence_v2`, both atomic and
legacy operation ids in `attendance_evidence_operations_v2`, `incoming_acceptance_applications_v1`,
`shift_members`, `shift_attendance`, `handover_reports_v2` and the three receipt/audit `audit_logs` ids.
It never reads approvals, decisions or adjudications — so a V2 approval cannot influence the conclusion
it is about to be bound to.

Every family in the inventory above is present in the reader, and §4/§5 exercised the safety-relevant
states of each. Two documented limits, so this is **not** claimed as a complete negative proof:

- **ids, not identities.** The §4.1 rows change values *at the deterministic ids the reader derives*. A
  writer that placed the right content at the *wrong* id (e.g. an evidence document under a
  non-derived key) is out of the reader's declared read set entirely and was not tested. The reader's
  own id-derivation is the fence here, and §5's forged-archive row is the case where that fence was
  probed and held.
- **the non-transactional write at `attendance-evidence-firestore.ts:405`** can leave an operation whose
  paired evidence is missing only if the process dies between; the operation it writes is the
  *interrupted-flag clear* on a finalized operation whose evidence it has just re-read and requires to
  exist (`:386-389` throws 409 "Finalized attendance operation is missing its evidence document;
  refusing to guess state"). So the writers guard the shape that the eligibility reader does not — see
  F-1.

## 8. Test results

| suite | result |
|---|---|
| `tests/recovery-concurrency-8c4a.test.mjs` (this phase) | 20 / 20 pass |
| 8C.3 eligibility + approval + guard + admin-review + atomic-acceptance domain battery (7 network-free files) | 231 / 231 pass |
| `run-recovery-eligibility-http.ps1` | 17 / 17 pass |
| `run-handover-recovery-approval-emulator.ps1` | 75 / 75 pass |
| `run-recovery-approval-http.ps1` | 25 / 25 pass |
| `run-atomic-acceptance-emulator.ps1` | 6 / 6 pass |
| `run-atomic-acceptance-recovery-emulator.ps1` | 9 / 9 pass |
| `run-atomic-acceptance-http.ps1` | 27 / 27 pass |
| `handover-reservation-guard-emulator.test.mjs` | 11 / 11 pass — **via `.demo/run-guard-emulator-8c4a.ps1`**, because `tests/run-handover-reservation-guard-emulator.ps1:6` hard-codes `C:\Program Files\Android\Android Studio\jbr`, which is no longer installed (L-1) |
| `run-handover-admin-review-emulator.ps1` | 22 / 22 pass |
| `tsc --noEmit` | clean |
| ESLint (repo-wide) | 7 errors / 19 warnings, **all pre-existing and all in the build artifact `functions/lib/index.js`**; 0 findings in `recovery-concurrency-8c4a.test.mjs` |
| `git diff --check` | clean (one informational LF→CRLF warning on `tsconfig.json`, untouched this phase) |
| additive legacy event-ID export | `createLegacyIncomingAcceptanceEventId` (`incoming-acceptance-application-domain.ts:282`) is consumed identically at `equal-handover-report-firestore.ts:2241` and `handover-recovery-eligibility-firestore.ts:1021`, so the reader derives the same legacy operation id the v1 writer used |
| `tsconfig.json` | additional Next dev entries inspected only; not rewritten or deleted |

No failure was suppressed, no check was weakened, no assertion was relaxed to make a suite green.

## 9. Findings and remaining assumptions

- **F-1 (P2, negative-evidence gap).** An attendance operation document in a *conclusive* state
  (`finalized`, or `aborted`) whose paired `attendance_evidence_v2` document is absent produces **no
  refusal**: the classifier's evidence loop refuses on `evidence.unreadable`, duplicate operations,
  `pending` and `interruptedFinalization`, and its "evidence without receipt" rule is keyed on
  `evidence.present` (`handover-recovery-eligibility-domain.ts:501-557`), while
  `reconcileTechnician` locates the slot by *evidence* existence (`…-firestore.ts:774-818`), so an orphan
  operation is invisible to reconciliation. The handover therefore reads
  `eligible_for_abandonment_review` while a technician has a finalized clock-in operation. The state is
  fully **bound into the digest** (§4.3: distinct digests, `executionAuthorized: false`), so nothing can
  be silently replayed across it — but eligibility, not refusal, is the answer. The writers refuse this
  shape (`attendance-evidence-firestore.ts:386-389`), which is the asymmetry. Recommendation before any
  V2 approval implementation: a `OPERATION_WITHOUT_EVIDENCE` refusal for a finalized orphan operation.
  Open decision for the owner: whether an `aborted` orphan should refuse or stay eligible (an aborted
  operation is a clean non-acceptance).
- **F-2 (P2, operational).** A committed eligibility transaction withholds concurrent writes to every
  document it read (§3), measurably delaying live acceptance commits (337 ms → 761–857 ms under 8
  readers). Recovery tooling must serialize or rate-limit eligibility fan-out against active handovers.
- **L-1.** The protected guard runner's hard-coded Android Studio JBR path no longer exists on this
  machine; its suite was re-run with the Qoder Temurin runtime through a `.demo` harness that does not
  modify the runner. Fixing the runner is a change to a protected file and awaits an explicit go-ahead.
- **L-2.** The emulator's transaction semantics are the Firebase emulator's, not production Firestore's.
  Write-withholding for an absent-but-read document is documented behaviour, but the exact stall and
  no-retry characteristics (F-2, and A-1's "no abort" outcome) should be re-confirmed against a real
  project before any tool relies on them for timing rather than correctness. Correctness conclusions
  (§3.5 serialisability, A-1 fencing) do not depend on timing.
- **L-3.** Fixtures are one handover shape: a two-technician incoming pair, report already frozen,
  guard active at revision 1/epoch 0, v2-native reservation with the legacy record absent. Multi-round
  (`successorSlotToken` populated), absence/clearance paths, and `handover_not_applicable` worlds were
  not driven on the real store here; they are covered by the 8C.3 network-free and HTTP suites.
- **L-4.** §4.1 injects *mutations at the deterministic ids*; the two limits in §7 (wrong-id placement,
  and orphan operation coverage) are the boundary of what was proved.
- **A-1 is resolved**, and no classification, digest or precedence rule was changed during this phase.

## 10. Recommendation on beginning the V2 approval implementation

**Yes, with one gate and one backlog item.** The eligibility model is safe to build approvals on:
real-emulator transactions fence absent-document reads (A-1 resolved), a racing acceptance is always
serialisable, no partial artifact can manufacture an eligible reading except the documented F-1 orphan
case, all 32 safety-relevant bindings move the digest and revert exactly, digest stability holds across
actor, clock and document order, and all 16 guard/legacy states fail closed with a reason. Approvals must
bind the **digest plus the classification** and re-evaluate inside their own transaction (the 8C.2b V1
pattern) — never the classification alone — because several safe states are distinguished only by the
digest. Before that implementation starts, F-1 should be settled by the owner as either a new refusal
code or an explicitly accepted exception; and F-2 should constrain how any approval UI fans out
eligibility reads. No recovery execution should be authorized by anything in this report: every
evaluation here produced `executionAuthorized: false`.

**STOPPED.** Verification complete; awaiting review. No operational recovery, no V2 approval
implementation, no protected-environment change was started.
