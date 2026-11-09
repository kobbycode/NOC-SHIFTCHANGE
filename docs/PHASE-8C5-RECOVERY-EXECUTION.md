# Phase 8C.5 — Recovery execution: abandonment transition, executor and gated HTTP surface

**Date:** 2026-11-09
**Status:** implemented, verified locally, **committed** (`1e5571d`, `fa4dc09`, `3d9ea80`). The operator
runbook was then executed end-to-end against the disposable stack; that evidence and the adopted
decisions are in §5.2 and §7.
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
- **The operator surfaces**: [PHASE-8C5-RECOVERY-RUNBOOK.md](PHASE-8C5-RECOVERY-RUNBOOK.md), whose
  documented PowerShell sequence was executed against a real server and emulators (§5.3), and the
  in-product recovery panel added in 8C.6 (§5.4). Both surfaces send the same requests; neither adds
  authority of its own.

Delivered after the original 8C.5 boundary (8C.6 — the operator UI, below):

- **One shared client component**, `src/components/operations/handover-recovery-panel.tsx`, mounted on
  the administrator handover review page and on the supervisor v2 handover detail page. It reads the
  classifier and the signed approvals, and sends the same request bodies the runbook documents. Every
  refusal is displayed verbatim from the server.
- **No new authority.** The supervisor mount can only add the supervisor signature; the execute form
  is rendered only when the administrator's gated read-back answers `200` and the intent is not yet
  applied. On a deployment where `HANDOVER_RECOVERY_EXECUTION_ENABLED` is unset the read-back is
  `404`, and the panel says execution is not enabled instead of offering a button.
- **Reachability.** A stalled handover is often *not* an exception in the 8B review queue — a
  never-activated handover is classified `not_activated` and is deliberately excluded — so the review
  page also accepts a handover document id and opens the panel for it, exactly as the runbook takes
  `$HANDOVER_DOCUMENT_ID`. Without that lookup the panel would only be reachable for queued cases.

Still not delivered, deliberately:

- No navigation entry, no listing of stalled handovers and no bulk recovery. The operator supplies the
  handover document id (or opens a queued case); inventing a discovery surface was out of scope.
- No notification, no attendance, no evidence and no `users` write. The executor is prohibited from
  all four, and the service suite asserts the complete write set rather than spot-checking it.
- No change to the protected acceptance/approval suites beyond the D-2 pin.
- No deploy, no emulator-flag change on a protected stack, and no allowlist change. The execution gate
  remains off everywhere outside the disposable stacks.

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
| `src/components/operations/handover-recovery-panel.tsx` | 8C.6 — the shared recovery panel (read classifier, approvals, gated execution read-back, send requests) |
| `tsconfig.verify.json` | Verification-only tsconfig (see §5.1) |

Modified:

| Path | Change |
| --- | --- |
| `src/lib/operations/equal-technician-handover-domain.ts` | `abandonEqualHandover` export (8C.4) |
| `src/components/admin/handover-review-workspace.tsx` | 8C.6 — panel mount per selected case plus the open-by-handover-id lookup |
| `src/app/(dashboard)/admin/handovers/review/page.tsx` | 8C.6 — passes the acting administrator uid |
| `src/components/operations/supervisor-handover-v2-detail.tsx` | 8C.6 — panel mount for the supervisor signature; header copy states the boundary |
| `src/app/(dashboard)/supervisor/handovers/v2/[shiftId]/page.tsx` | 8C.6 — passes handover document id and acting uid |
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
| Runbook §3 executed end-to-end (PowerShell, one real server + emulators) | **pass** — create, countersign, execute, read-back, replay, refusals |
| 8C.6 production build with both gates on (`next build`, `.next-ui-verify`) | **clean** |
| 8C.6 two-role browser flow against that production build (§5.4) | **pass** — request → countersign → execute → applied, final state identical to the runbook harness |

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

Operator path (`demo-admin-review-8b`, one server on 3198, the runbook's own PowerShell):

1. three sessions minted through `/api/auth/login`, one per actor;
2. create as the supervisor → `201`, `awaiting_second_approval`, count 1, eligible false;
3. execute before the second signature → `409 RECOVERY_APPROVAL_INVALID`;
4. countersign as the administrator → `fully_approved`, count 2;
5. execute with `actorUid` in the body → `400`, nothing read from the payload;
6. execute as the administrator → `committed`, audit id equal to the derived id, `executedBy` the
   session subject;
7. `GET` read-back → `applied: true`, same audit id;
8. replay from a second administrator → `already_applied`, same audit id and original executor;
9. anonymous read-back → `401`; foreign-origin `POST` → `403`;
10. final state: outgoing shift `cancelled` by `adm1` with `actualEnd` untouched, aggregate
    `cancelled`, audit row bound to the approval and actor, and every seeded user profile unchanged.

This run also caught three documentation defects, now fixed: a bare `Cookie` header is silently
dropped by Windows PowerShell 5.1 (the runbook uses a `WebRequestSession`), the second-request replay
identity is the evidence, not the idempotency key, and the intent cannot be "replaced" by sending a
different key.

### 5.4 The 8C.6 in-product panel, verified in a browser

Boundary: `demo-admin-review-8b` (Firestore 8980/9980, Auth 10099), one `next start` server on 3198
serving the production build `.next-ui-verify` with `HANDOVER_V2_DEV=true` and
`HANDOVER_RECOVERY_EXECUTION_ENABLED=true`, seeded with the same backdated equal-handover fixture and
users `adm1`, `sup1`, `adm2`.

The flow was executed against the built pages, not by calling the API directly:

1. `adm1` signs in at `/login`; `/admin/handovers/review` shows the recovery lookup and an empty
   review queue (a never-activated handover is not an 8B exception);
2. entering `handover_v2_outgoing` opens the panel: **Eligible for abandonment review**, evidence
   digest shown, **Request recovery intent** offered;
3. the request form requires ≥10 characters and the administrator's password; submitting records the
   intent, shows the confirmation notice, and the intent renders **Awaiting second signature**, 1/2
   signatures, "Waiting for a supervisor signature", with no countersign control for the admin;
4. `sup1` signs in; `/supervisor/handovers/v2/outgoing` shows the same intent with **Countersign as
   supervisor**, which requires only the supervisor's password; submitting shows **Fully approved**
   and states that an administrator must execute — no execute control appears for the supervisor;
5. `adm1` signs in again and reopens the panel: the gated read-back answered `200`, so **Execute
   recovery** is offered; the form shows the irreversible-effects copy, requires a reason and the
   acknowledgment, and asks for no password (OD-3);
6. execution returns **Recovery applied by adm1 … audit handover_aba…c11017**; the panel offers no
   further execute, void or reissue control, and the classifier now reports refusals (aggregate
   cancelled).

Final state read directly from the emulator with the Admin SDK, using the runbook harness's own
assertions: outgoing shift `cancelled` by `adm1` with `actualEnd` untouched, aggregate `cancelled`,
approval `fully_approved` with `admin:adm1` + `supervisor:sup1`, and a create-once audit row whose id
is derived from the approval, bound to that approval and naming `adm1`.

**F-4 — the review queue cannot be the only entry point (found by this browser run).**
`listHandoverReviewQueue` includes only exceptions and completed handovers; a never-activated handover
is classified `not_activated` and excluded. The panel was therefore unreachable for the primary
scenario when mounted only per queued case. The review page now also takes a handover document id,
which mirrors the runbook's operator input rather than inventing a discovery or listing surface.

---

## 6. Findings and deliberate deviations

**F-1 — W5 revision is not incremented (adopted as OD-1).**
The 8C.1 contract calls for `revision + 1` on the aggregate write. The aggregate's revision is bound
into every personal confirmation and into the snapshot hash that approval fences compare. Incrementing
it at abandonment would make already-recorded confirmations look stale against a cancelled document
and would invalidate the very binding that proves the approval referred to this state. The executor
therefore writes `cancelled` with the **revision unchanged**, and the snapshot hash still matches
because the hash excludes `lifecycleStatus` (hazard H-3). This is a contract deviation, not an
oversight — see OD-1.

**F-2 — W8 is implemented as an immutable intent plus a create-once audit row (adopted as OD-2).**
The contract describes consuming the approval. The executor never mutates the signed approval record;
consumption is proved by `transaction.create` on a deterministic audit id derived from the approval
id. A retry reads that row. This keeps the signed intent immutable (every signature, digest and
fingerprint stays verifiable forever) and makes double-execution structurally impossible. See OD-2.

**F-3 — no `users` write, unlike the sibling recovery path (adopted as OD-5).**
`recoverExpiredScheduledShift` calls `markAssignmentActivity`, which stamps the actor's user document.
The abandonment executor deliberately does not: the owner's constraint is that recovery must not write
`users`. The consequence is that an abandonment does not refresh the actor's "last activity" marker.
See OD-5.

**F-4 — execution requires an administrator session, not a password (adopted as OD-3).**
Approval signatures require a password proof. Execution does not: it requires a live administrator
session, same-origin, and a signed approval whose fingerprints still match. Whether execution should
also demand a fresh password is a product decision, not something this phase invented. See OD-3.

**F-5 — verification depended on generated Next types.**
The old `npx tsc --noEmit` route can silently pass when a generated file is syntactically broken.
`next typegen` + `tsconfig.verify.json` is now the documented and reproducible check. `tsconfig.json`
itself is untouched by hand; Next dev appends its dist dirs, matching every earlier phase.

---

## 7. Decisions — adopted defaults, still reversible

The phase stops behind a default-off gate, so none of these decisions is live outside a disposable
stack. Each one is recorded as the adopted default with its reason; every default is the behaviour the
suites verify today, not an inferred requirement. An owner can overturn any of them individually, and
the change is localized as noted.

| # | Decision | Adopted default | Why | To overturn |
| --- | --- | --- | --- | --- |
| OD-1 | W5 aggregate revision | Unchanged at abandonment | The revision is bound into personal confirmations and into the approval snapshot hash; incrementing it at abandonment would make valid, previously recorded confirmations look stale against a cancelled document. The hash excludes `lifecycleStatus` (H-3), so the approval fence still matches. | Increment in the W5 write and decide what happens to confirmations bound to the previous revision. |
| OD-2 | W8 approval consumption | Signed approval immutable; consumption proved by a create-once audit row derived from the approval id | Every signature, digest and fingerprint stays verifiable forever, and double execution is structurally impossible. | Add `consumedAt`/`consumedBy` to the approval; the create-once row remains the real fence, so those fields would be informational. |
| OD-3 | Executor authentication | Live administrator session, same-origin, no second password | The approval already carries two password proofs; execution re-derives authority from the session and re-checks the actor inside the transaction. | Require a password proof on the execute body and extend the contract and both suites. |
| OD-4 | Notification on abandonment | None | The notification seam is untouched; abandonment is an administrative recovery, and inventing a recipient or message shape would be undesigned product behaviour. | Define recipient, template and deep link first. |
| OD-5 | Actor activity marker | No `users` write | Matches the owner's constraint that the executor must not write `users`. The cost is that an abandonment does not refresh the actor's last-activity marker. | Exempt one field from the rule and update the write-set assertions in both suites. |
| OD-6 | Operator surface | Two surfaces over the same routes: the runbook and the 8C.6 in-product panel (admin review page, plus the supervisor signature on the v2 detail page) | The runbook stays the fallback when the panel is unavailable, and the panel was built only after the route and its authorization existed. The panel holds no authority: it renders the classifier and the approvals, offers execution only after the gated read-back succeeds, and shows every refusal verbatim. It was verified end-to-end in a browser against the production build (§5.4). | Remove the panel mounts; no route or contract changes are needed. |

**Not decided here:** enabling the executor anywhere outside a disposable stack. That is a deployment
decision, not a phase decision: `HANDOVER_RECOVERY_EXECUTION_ENABLED` stays unset there, and with it
unset neither endpoint exists.
