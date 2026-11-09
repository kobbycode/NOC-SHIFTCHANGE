# Phase 8C.5 — Recovery execution: abandonment transition, executor and gated HTTP surface

**Date:** 2026-11-09
**Status:** implemented, verified locally, **uncommitted**. This phase stops here for review.
**Scope authorized by:** owner instruction "build everything" in response to the 8C decision packet
(D-1 go-ahead for 8C.4, D-2 the protected digest-pin fix, D-3 the 8C.5 target, D-4 carried decisions).

This is the first code in the repository that can actually abandon a stalled equal handover. The
approval surface built in 8C.4B grants intent only; execution is a separate, environment-gated
boundary that re-evaluates every precondition inside one Firestore transaction and writes nothing
until they all hold.

---

## 1. What is delivered, and what deliberately is not

Delivered:

- **8C.4 — `abandonEqualHandover` domain transition** in
  `src/lib/operations/equal-technician-handover-domain.ts`, with the approval-binding fences
  (revision, snapshot hash, lifecycle status) and the successor slot token derivation.
- **8C.4 unit coverage** in `tests/handover-recovery-abandonment-domain.test.mjs` (10 tests), plus
  the refusal taxonomy in `src/lib/operations/handover-recovery-abandonment-domain.ts`.
- **D-2 — protected digest pin fix** in the 8C.3 HTTP test (task 5), so that suite no longer fails
  on a digest version it does not own.
- **8C.5 — the executor** `executeHandoverAbandonment` in
  `src/lib/operations/handover-recovery-execution-firestore.ts`: a single transaction that reads the
  actor, the signed approval, the once-only audit row, the classifier, the aggregate, the global slot,
  the reservation guard, the roster, the outgoing shift and both technician schedules, then writes
  W1–W7 plus the audit row.
- **8C.5 — the gate and HTTP surface**: `src/lib/operations/handover-recovery-execution-http.ts` and
  `src/app/(dashboard)/api/admin/recovery-approvals-v2/[approvalId]/execute/route.ts` (GET read-back,
  POST execute), behind a second independent gate that defaults off.
- **Verification harnesses**: `tests/run-handover-recovery-execution-emulator.ps1` (service level),
  `tests/run-handover-recovery-execution-http.ps1` + `tests/run-recovery-execution-http.mjs` (two real
  Next.js servers), and the two suites they run.

Not delivered, deliberately:

- No UI. The route is reachable only by an administrator session that calls it directly; there is no
  button, no navigation entry, and no client component.
- No notification, no attendance, no evidence and no `users` write. The executor is prohibited from
  all four, and the service suite asserts the complete write set rather than spot-checking it.
- No change to the protected acceptance/approval suites beyond the D-2 pin.
- No commit, push, deploy, emulator-flag change, or allowlist change.

---

## 2. Files added or modified

Added:

| Path | Purpose |
| --- | --- |
| `src/lib/operations/handover-recovery-abandonment-domain.ts` | Refusal codes, HTTP statuses, create-once identifiers, approval-binding fence, typed error |
| `src/lib/operations/handover-recovery-execution-firestore.ts` | The only path that abandons an equal handover |
| `src/lib/operations/handover-recovery-execution-http.ts` | Gate predicate, JSON helpers, error mapping, executor authorization |
| `src/app/(dashboard)/api/admin/recovery-approvals-v2/[approvalId]/execute/route.ts` | GET read-back, POST execute |
| `tests/handover-recovery-abandonment-domain.test.mjs` | 10 pure-domain tests |
| `tests/handover-recovery-execution-emulator.test.mjs` | 12 service-level transaction tests |
| `tests/run-handover-recovery-execution-emulator.ps1` | Service suite boundary (`demo-recovery-execution-8c5`, ports 8191/9091/4419/4519) |
| `tests/recovery-execution-http-emulator.test.mjs` | 8 real-HTTP tests |
| `tests/run-recovery-execution-http.mjs` | Two-server harness (3198 gate on, 3199 gate off) |
| `tests/run-handover-recovery-execution-http.ps1` | HTTP boundary (`demo-admin-review-8b`, Firestore 8980/9980, Auth 10099) |
| `tsconfig.verify.json` | Verification-only tsconfig (see §5.1) |

Modified:

| Path | Change |
| --- | --- |
| `src/lib/operations/equal-technician-handover-domain.ts` | `abandonEqualHandover` export (8C.4) |
| `docs/PHASE-8C3-…` protected HTTP test | D-2 digest pin (task 5 only) |
| `tsconfig.json` | Next.js dev appends each new `NEXT_DIST_DIR` to `include` — same convention as every earlier phase's dist dirs |

---

## 3. Safety boundary actually used

Every suite ran against a dedicated, disposable emulator project; no protected project, port,
snapshot or import/export was contacted.

| Suite | Project | Ports | Gate |
| --- | --- | --- | --- |
| Service (`run-handover-recovery-execution-emulator.ps1`) | `demo-recovery-execution-8c5` | Firestore 8191, ws 9091, hub 4419, logging 4519 | `RECOVERY_EXECUTION_EMULATOR=true`; refuses `HANDOVER_V2_DEV`, `HANDOVER_V2_ATOMIC_ACCEPTANCE`, `HANDOVER_RECOVERY_EXECUTION_ENABLED` |
| HTTP (`run-handover-recovery-execution-http.ps1`) | `demo-admin-review-8b` (already on the closed reauthentication allowlist, so the allowlist stays byte-identical) | Firestore 8980/9980, Auth 10099, hub 4420, logging 4520, apps 3198/3199 | `RECOVERY_EXECUTION_HTTP_EMULATOR=true` |

Each suite refuses to start when its marker is absent, and the harness refuses to start when its
app ports are already bound.

---

## 4. The contract as implemented

### 4.1 Execution is not approval

Approval V2 records an intent and always reports `recoveryExecutionEligible: false`. The executor
re-runs `evaluateHandoverRecoveryEligibilityInTransaction` **inside** the same transaction that
writes, so approval never carries authority over state. A stale approval, an expired intent, a voided
intent, a moved review case, an open activation window or a live acceptance all refuse with nothing
written.

### 4.2 The write set

One transaction, all reads before any write:

- **W1** `shifts/{outgoingShiftId}` → `cancelled` (+`cancelledAt`, `cancelledBy`, `updatedAt`);
  `actualEnd` is not touched.
- **W2** `operational_shift_control/global` → `advanceOperationalShiftControl` with a successor token
  derived from `approvalId` + `generation + 1`.
- **W3** each live `shift_members` row for the outgoing shift → `leftAt = now`.
- **W4** each outgoing technician's `technician_schedules/{uid}` → the outgoing entry removed, all
  other entries preserved, `metadata` preserved by merge.
- **W5** `equal_handovers_v2/{handoverDocumentId}` → lifecycle `cancelled`.
- **W6** the reservation guard → cancelled with incremented revision, fencing epoch and
  `terminalEvidenceRef = auditId`.
- **W7** `audit_logs/{derived id}` created with `transaction.create` — the once-only consumption
  proof, including before/after guard and slot values, activation window, evidence digest, negative
  proof, reason and idempotency key.

Nothing else is written. The service suite asserts the exact touched-path set, so an incidental write
fails the suite rather than passing unnoticed.

### 4.3 Once-only semantics

The audit id is derived from the approval id, so a commit retry collides on `transaction.create`
instead of writing a second abandonment. A retry that finds the row answers `already_applied` with
the original outcome and writes nothing. An untagged transaction failure triggers a read of the
deterministic row: present → `already_applied`; absent → `OUTCOME_UNKNOWN` with
`notCommitted: false` and `verificationRequired: true`, never a silent claim either way. The
concurrency test proves two simultaneous executions settle on exactly one commit.

### 4.4 The gate

```ts
recoveryExecutionEnabled = handoverV2Enabled() && process.env.HANDOVER_RECOVERY_EXECUTION_ENABLED === "true"
```

With the Version 2 family reachable but the execution flag unset, both methods answer 404 while
`/api/admin/recovery-approvals-v2` still answers 401. The HTTP harness proves both directions on two
real servers over the same source tree before any test runs.

### 4.5 The actor and the payload

The actor is the session subject; the request body cannot name one. Only a live, active,
password-settled administrator executes (`assertExecutor` re-reads `users/{uid}` in the transaction).
The mutating route requires the application origin. The body admits exactly `reason` and
`idempotencyKey`; any other key is a 400, so the payload never carries authority.

---

## 5. Verification

### 5.1 Typecheck — note for future phases

`npx tsc --noEmit` silently skips semantic diagnostics when any file in the program has a syntax
error. A generated `.next-*/dev/types/validator.ts` (or a `routes.d.ts` caught mid-write) does exactly
that, so a "clean" typecheck can be a false negative. The reliable procedure used here:

```bash
node node_modules/next/dist/bin/next typegen          # deterministic route types
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.verify.json
```

`tsconfig.verify.json` extends the project config but excludes every `.next-*` variant directory, so
stale generated files from other stacks cannot mask real errors. Result: **clean (exit 0)**.

### 5.2 Results

| Check | Result |
| --- | --- |
| `tsc -p tsconfig.verify.json` after `next typegen` | **clean** |
| ESLint on every new/changed source and test file | **0 errors, 0 warnings** |
| `tests/handover-recovery-abandonment-domain.test.mjs` (unit) | **10 / 10 pass** |
| `tests/equal-technician-handover-domain.test.mjs` (unit, 8C.4 transition) | **21 / 21 pass** |
| Adjacent domain suites — approval, eligibility, admin review, handover | **305 / 305 pass** |
| `tests/handover-recovery-execution-emulator.test.mjs` (service, real Firestore emulator) | **12 / 12 pass** |
| `tests/recovery-execution-http-emulator.test.mjs` (real HTTP, two app servers) | **8 / 8 pass** |

Not re-run in this phase (unchanged by it): the 8C.4B approval suites and the 8C.3 eligibility suites.
They remain the last committed-state evidence for their own contracts.

### 5.3 What the suites actually prove

Service level (`demo-recovery-execution-8c5`):

1. an approved intent executes once and writes **exactly** W1–W7 + the audit row, with the signed
   approval deep-equal before and after, and no `users` / `shift_attendance` / evidence /
   notification / `handovers/` write;
2. a committed retry answers from the audit row and writes nothing;
3. an intent that is not fully approved is refused and writes nothing;
4. a supervisor is refused and writes nothing;
5. suspended and password-rotating administrators are refused inside the executor;
6. recovery is refused while the incoming shift can still accept (window genuinely open);
7. a live acceptance refuses recovery with the classifier's own classification;
8. an expired intent is refused;
9. a voided intent is refused;
10. evidence that moves after approval is refused inside the transaction;
11. two concurrent executions settle on exactly one commit, and a later call reads it back;
12. the read-back answers from the audit row and never guesses.

HTTP level (`demo-admin-review-8b`, servers 3198/3199):

1. the execution gate hides both endpoints while the Version 2 family answers;
2. no session writes nothing; supervisor, technician and password-rotating admin are refused;
3. a session minted while the administrator profile was active is refused (401) once the profile is
   suspended, with nothing written — the in-transaction actor re-read that backs this up is proved by
   service test 05;
4. a cross-origin POST is refused before anything is read;
5. unknown fields, missing reason, non-JSON bodies, malformed ids and unknown approvals produce the
   documented contract and write nothing;
6. an intent that is not fully approved is refused;
7. an approved intent executes, the read-back agrees, a second administrator's replay returns the
   first outcome and writes nothing;
8. evidence that moves after approval is refused with nothing written.

---

## 6. Findings and deliberate deviations

**F-1 — W5 revision is not incremented (needs a decision).**
The 8C.1 contract calls for `revision + 1` on the aggregate write. The aggregate's revision is bound
into every personal confirmation and into the snapshot hash that approval fences compare. Incrementing
it at abandonment would make already-recorded confirmations look stale against a cancelled document
and would invalidate the very binding that proves the approval referred to this state. The executor
therefore writes `cancelled` with the **revision unchanged**, and the snapshot hash still matches
because the hash excludes `lifecycleStatus` (hazard H-3). This is a contract deviation, not an
oversight — see OD-1.

**F-2 — W8 is implemented as an immutable intent plus a create-once audit row.**
The contract describes consuming the approval. The executor never mutates the signed approval record;
consumption is proved by `transaction.create` on a deterministic audit id derived from the approval
id. A retry reads that row. This keeps the signed intent immutable (every signature, digest and
fingerprint stays verifiable forever) and makes double-execution structurally impossible. See OD-2.

**F-3 — no `users` write, unlike the sibling recovery path.**
`recoverExpiredScheduledShift` calls `markAssignmentActivity`, which stamps the actor's user document.
The abandonment executor deliberately does not: the owner's constraint is that recovery must not write
`users`. The consequence is that an abandonment does not refresh the actor's "last activity" marker.
See OD-5.

**F-4 — execution requires an administrator session, not a password.**
Approval signatures require a password proof. Execution does not: it requires a live administrator
session, same-origin, and a signed approval whose fingerprints still match. Whether execution should
also demand a fresh password is a product decision, not something this phase invented. See OD-3.

**F-5 — verification depended on generated Next types.**
The old `npx tsc --noEmit` route can silently pass when a generated file is syntactically broken.
`next typegen` + `tsconfig.verify.json` is now the documented and reproducible check. `tsconfig.json`
itself is untouched by hand; Next dev appends its dist dirs, matching every earlier phase.

---

## 7. Open decisions — this phase stops here

1. **OD-1 (W5):** should abandonment leave the aggregate revision unchanged (implemented) or
   increment it as the 8C.1 text says? Incrementing requires deciding what happens to personal
   confirmations bound to the previous revision.
2. **OD-2 (W8):** accept "immutable signed approval + create-once audit row" as the consumption
   proof, or require an explicit `consumedAt`/`consumedBy` write on the approval document?
3. **OD-3:** should execution also require the executor's password (mirroring approval signatures),
   or is a live administrator session sufficient (implemented)?
4. **OD-4:** should an abandonment produce a notification? None is written today; the notification
   seam is untouched.
5. **OD-5:** accept that abandonment does not update the actor's activity marker (no `users` write),
   or should the recovery path be exempted from the "no `users` writes" rule for this one field?
6. **OD-6:** the executor has no UI and no client call site. Decide whether 8C.6 should be a UI
   surface or an operational runbook that calls the route directly. The runbook option is drafted in
   [PHASE-8C5-RECOVERY-RUNBOOK.md](PHASE-8C5-RECOVERY-RUNBOOK.md); the UI option is not started.

No commit, push, deploy or emulator-flag change was made. The work stops here for review.
