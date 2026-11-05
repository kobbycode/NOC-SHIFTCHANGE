# Phase 8C.4B — Version 2 dual-approval service and HTTP surface (signed intent, never execution)

Delivered 2026-11-04 on branch `feature/handover-v2-recovery`; all work is uncommitted and awaiting review.
Nothing was committed, pushed, merged, deployed or migrated.

Phase 8C.4B builds the Version 2 dual-approval record on top of the 8C.3 classifier: one supervisor or
administrator binds the classifier's live evidence digest and classification to a stated intent, a person of
the complementary role signs the same intent, and the pair is stored as an audited, immutable historical
fact. **It is a record, not an authority.** No endpoint, no status and no response body in this phase can
authorize a recovery action, and no operational record is read for anything except classification evidence.

## 1. What is delivered, and what deliberately is not

| delivered | not delivered |
| --- | --- |
| §4 `handover-recovery-approval-v2-firestore.ts` — request, countersign, void, reissue, read, list, all inside Firestore transactions | an execution path of any kind (there is no route to call, so there is nothing to approve into action) |
| §4 `handover-recovery-approval-v2-domain.ts` — identity, canonical intent hash, proof binding, stored-record validators, status/code map | UI. No page, panel or button reads this surface yet |
| §5 `handover-recovery-approval-v2-http.ts` + five `recovery-approvals-v2` admin routes | V1 migration. The V1 approval collection is never read, rewritten or superseded |
| §5 verification over real authenticated HTTP on a disposable emulator, including the password seam | scheduler or sweeper. `expired` is derived at read time only |
| | any change to the closed emulator allowlist, to a protected UAT stack, or to `docs/PHASE-8C3-RECOVERY-ELIGIBILITY.md` |

## 2. Files added or modified by this phase

| sha256 (12) | lines | file |
| --- | --- | --- |
| `78111299fa8b` | 168 | `src/types/handover-recovery-approval-v2.ts` |
| `8c129a733bf5` | 1371 | `src/lib/operations/handover-recovery-approval-v2-domain.ts` |
| `6763e1c349c8` | 1035 | `src/lib/operations/handover-recovery-approval-v2-firestore.ts` |
| `c675ffdd6fd9` | 117 | `src/lib/operations/handover-recovery-approval-v2-http.ts` |
| `d1fe0001ef36` | 102 | `src/app/(dashboard)/api/admin/recovery-approvals-v2/route.ts` |
| `fe4005ddc9f1` | 51 | `src/app/(dashboard)/api/admin/recovery-approvals-v2/[approvalId]/route.ts` |
| `0d2b5f8dc4fb` | 78 | `.../[approvalId]/approvals/route.ts` |
| `8c79f4e2fd03` | 78 | `.../[approvalId]/void/route.ts` |
| `55a0862cb408` | 81 | `.../[approvalId]/reissue/route.ts` |
| `a478d7d8e57a` | 1330 | `tests/handover-recovery-approval-v2-emulator.test.mjs` |
| `ecd5550f60e0` | 1076 | `tests/recovery-approval-v2-http-emulator.test.mjs` |
| `62a1f3cb2a91` | 276 | `tests/run-recovery-approval-v2-http.mjs` |
| `7cef685ad656` | 94 | `tests/run-recovery-approval-v2-http.ps1` |
| `5268603f306f` | 86 | `tests/run-handover-recovery-approval-v2-emulator.ps1` |

Modified: `.gitignore` gains `/firebase.recovery-approval-v2-8c4b.generated.json` and
`/firebase.recovery-approval-v2-http.generated.json` (the two throwaway configs these runners write and
delete; `/.next-*/` already covers both distDirs). Late in the phase two unused bindings
(`reportFirestore`, `PROOF_MAX_AGE_MS`) were deleted from the §4 test file to clear its ESLint warnings;
the §4 suite was re-run afterwards and is still 26/26.

Four files belonging to 8C.3 were also edited, all as part of §4 and all for one reason — the fail-closed
orphan-operation rule (8C.4A finding F-1) changed what the evidence digest proves, so the digest schema
version moved to 2:

| sha256 (12) | lines | file | touched |
| --- | --- | --- | --- |
| `0c867f075620` | 381 | `src/types/handover-recovery-eligibility.ts` | 11-03 09:54 |
| `6aaa55114aac` | 759 | `src/lib/operations/handover-recovery-eligibility-domain.ts` | 11-03 09:55 |
| `b0ea885db71a` | 1394 | `src/lib/operations/handover-recovery-eligibility-firestore.ts` | 11-03 10:14 |
| `a9568231f1af` | 635 | `tests/handover-recovery-eligibility-fixture.test.mjs` | 11-04 17:40 |

That edit is what makes 8C.3's HTTP suite stale at one pinned constant; see F-6 and OD-1.
`.demo/launch-verify-lifecycle.mjs` (a gitignored scratch harness, outside this delivery) had two logging
paths corrected: the atomic-acceptance line now reads `lifecycle.guardState`, which is what that response
actually exposes, and the terminal summary now reads `guard.ownerLifecycleState` instead of the nonexistent
`guard.lifecycleStatus`.

The protected set is byte-identical — hash and modification time both predate this phase's §4/§5 work:
`src/lib/operations/handover-recovery-approval-firestore.ts` `35c78b170540c40a` (11-01 08:47),
`src/app/(dashboard)/api/admin/recovery-eligibility/route.ts` `069cb0ee7bc932eb` (11-01 16:28),
`docs/PHASE-8C3-RECOVERY-ELIGIBILITY.md` `161d370c10b0273a` (11-01 18:23),
`tests/recovery-eligibility-http-emulator.test.mjs` `6f3c96f000c092fa` (11-01 18:13), and the closed
allowlist pair `src/lib/firebase/client.ts` `288f620f4d97822f` plus
`src/lib/auth/password-reauthentication.ts` `dc3f7935df78f288` (both 10-31 09:59).

## 3. Safety boundary actually used

Both runners reuse the already-registered closed-allowlist tuple `demo-admin-review-8b`
(Firestore 8980 / websocket 9980, Auth 10099, hub 4420, logging 4520) on an **ephemeral instance**:
`emulators:exec` starts empty, there is no import and no export, so no persisted snapshot is read or written.

- §4 service suite: project `demo-recovery-approval-v2-8c4b`, Firestore 8189 / websocket 9089.
- §5 HTTP suite: two real Next.js dev servers, 3196 with `HANDOVER_V2_DEV=true` and 3197 with it false;
  distDirs `.next-recovery-approval-v2-http-on` / `-off`; logs `.demo/recovery-approval-v2-http-{on,off}.log`.
- Protected stacks were never contacted: 3100/3110/3170, 8080/8088, 8180/9199, 8186, and every protected UAT
  project id. Both runners assert their own environment (project id, both emulator hosts, emulator mode on,
  the V2 gate value, and their own sentinel variable) and refuse to start otherwise.
- Reusing the registered tuple is deliberate. `reauthenticatePassword` accepts only project/port pairs from
  the closed allowlist; a new project id would have forced an edit to the allowlist files, which this phase
  must leave byte-identical.
- Credentials are never persisted. The synthetic password exists only in the test process, the synthetic API
  key only in the environment, and the app log of the passing run contains neither (checked directly:
  `R8c4b-v2-http-Pass!` / `R8c4b-v2-http-wrong-Pass!` do not appear in `.demo/recovery-approval-v2-http-on.log`).

## 4. The Version 2 contract as implemented

**Identity.** `handover_recovery_approval_v2_<sha256-40>` is derived from
`{handoverDocumentId, intentFingerprint}`, and `intentFingerprint` is a hash of the canonical binding only —
never of the requester. Two supervisors over unchanged evidence therefore address the *same* document, so the
second one collides with `RECOVERY_APPROVAL_V2_REQUEST_CONFLICT` (409) instead of forking the intent.
`requestHash` covers `{requestedBy, handoverDocumentId, intentFingerprint, reason}`; the idempotency key is
deliberately not part of it, so replays are content-addressed: same content + same key replays (200
`replayed:true`), same content + different key is a fresh attempt at one identity, different content + same
key is `IDEMPOTENCY_CONFLICT` (409).

**Binding.** The digest and classification come from one in-transaction evaluation
(`bindCurrentRecoveryIntent`); no caller-supplied digest is ever accepted. A countersignature re-reads and
re-classifies, and refuses rather than re-binding an intent whose evidence moved. The digest the current
classifier produces is schema `handover-recovery-eligibility-evidence` version **2** (see F-6).

**Windows.** Intent 24 h, proof 60 s, both inherited from the V1 domain constants rather than restated, so
they cannot drift apart. `expired` is derived at read time from `expiresAt`; there is no scheduler, no sweep
and no implicit write — test 15 proves the store is byte-identical before and after an expired read.

**Writes.** The only paths this family can write are `handover_recovery_approvals_v2/{id}` and
`audit_logs/handover_recovery_approval_v2_audit_{id}`. Both suites fingerprint the whole store around every
mutating call, and test 26 (§4) plus tests 02/06/07/10/14/15/16 (§5) assert that nothing else moved.

**Non-executability.** `recoveryExecutionEligible: false` is a literal in every response body — success and
failure — and `nonExecutableReason` is the fixed string
`approval_records_signed_intent_only_no_execution_path_exists`. `fully_approved` means two distinct
authenticated people signed one canonical intent; it is not authority to do anything.

**Status / code map** (`handover-recovery-approval-v2-domain.ts:96-118`): 403 `ROLE_FORBIDDEN`; 404
`NOT_FOUND`, `HANDOVER_NOT_FOUND`; 409 `NOT_ELIGIBLE`, `HANDOVER_UNREADABLE`, `DUPLICATE_ACTOR`,
`ROLE_CONFLICT`, `STALE`, `EXPIRED`, `ALREADY_COMPLETE`, `ALREADY_VOIDED`, `NOT_VOIDED`, `ALREADY_REISSUED`,
`IDEMPOTENCY_CONFLICT`, `REQUEST_CONFLICT`, `STATE_INCONSISTENT`; 503 `ELIGIBILITY_UNAVAILABLE`,
`OUTCOME_UNVERIFIED`; 401 `AUTHENTICATION_INVALID`, `AUTHENTICATION_EXPIRED`; 403 `AUTH_IDENTITY_CHANGED`.
A payload validation failure is a `400` with `error` text and **no code**.

**Route surface.**

| route | handlers | body |
| --- | --- | --- |
| `GET /api/admin/recovery-approvals-v2?handoverDocumentId=…` | GET | — |
| `POST /api/admin/recovery-approvals-v2` | POST | `{handoverDocumentId, reason, idempotencyKey, password}` → 201, or 200 on replay |
| `GET /api/admin/recovery-approvals-v2/{approvalId}` | GET | — |
| `POST /api/admin/recovery-approvals-v2/{approvalId}/approvals` | POST | `{expectedRevision, password}` |
| `POST /api/admin/recovery-approvals-v2/{approvalId}/void` | POST | `{reason, idempotencyKey, password}` |
| `POST /api/admin/recovery-approvals-v2/{approvalId}/reissue` | POST | `{reason, idempotencyKey, password}` → 201, or 200 on replay |

Order of checks on every route: gate (`HANDOVER_V2_DEV`, else 404 for the whole family) → session and role →
same origin (mutating routes only) → id/body grammar → password verification → transaction. The actor is
always the session subject; `uid` in a body, query or header is ignored, never trusted. Void and countersign
answer 200 for a fresh operation and for a replay alike — `replayed` plus `audit.state` carry the distinction —
while request and reissue answer 201 fresh and 200 replayed.

## 5. Verification

| check | result |
| --- | --- |
| §4 V2 service, `tests/run-handover-recovery-approval-v2-emulator.ps1` | 26 / 26 pass (re-run after the lint cleanup, 33.1 s) |
| §5 V2 HTTP, `tests/run-recovery-approval-v2-http.ps1` | **17 / 17 pass**, 46.3 s — `.demo/p8c4b-v2-http-run2.txt` |
| `tsc --noEmit` | clean (exit 0) |
| ESLint over the V2 modules, five routes and both V2 test files | 0 errors (the two §4 warnings removed) |
| `tests/isolated-emulator-environments.test.mjs` (allowlist drift) | 41 / 41 pass, including "the browser client and the server helper list the same closed tuples" |
| V1 approval HTTP regression, `run-recovery-approval-http.ps1` | 25 / 25 pass |
| 8C.4A concurrency/eligibility battery, `run-recovery-concurrency-8c4a.ps1` | 20 / 20 pass |
| pure-node recovery suites (eligibility fixture + domain, orphan eligibility, V1 approval domain) | 164 / 164 pass |
| `git diff --check` | clean |
| V2 app log of the passing run | 75 route-family requests, **0 5xx**, no credential string, DELETE/PUT/GET probes answered 405 |

The §5 HTTP suite (`.demo/p8c4b-v2-http-run2.txt`) covers: the gate hiding the whole family; sessionless
refusal with no write; session-vs-claimed actor; role, mandatory-password-change and disabled-account refusal
before any read; same-origin on all four mutating routes; a rejected password refused with nothing written;
the malformed-payload contract; the live-classifier digest binding with `evidenceDigestSchemaVersion === 2`;
complementary-role completion preserving signature 1 verbatim while the proofs differ; a fully approved intent
still non-executable with nothing operational written; single identity under concurrency plus replay,
collision and idempotency conflict; stale revision and wrong role refused without a signature; signer-only
terminal void; reissue minting a new identity from a voided original; read-time expiry; no execution endpoint
anywhere; V1 never read, migrated or rewritten.

First run of §5 was 14 / 17 (`.demo/p8c4b-v2-http-run1.txt`). All three failures were defects in the new
test's own expectations, and each was fixed by matching the documented contract — never by weakening a check:
- 07 asserted a 404 for a malformed handover id in a POST body; body grammar is validated first and answers
  400 without a code (F-1). The test now pins both layers, including the GET query path that *is* a 404.
- 09 compared `created.approval.approval.approvals[0]`; `createApproval` returns the response view, so the
  record is one level shallower. The comparison itself — signature 1 preserved verbatim, signature 2 a
  different proof — is unchanged.
- 16 probed invented execution paths; under `next dev` an unmatched path renders the application 404 document,
  which in this offline sandbox tries to fetch Geist from Google Fonts (3 s × 3 retries) and blew the request
  abort. It now proves the same property two ways that do not depend on the 404 page: the route tree on disk
  is enumerated and compared to exactly five files exporting only GET/POST, and all ten unsupported verb
  combinations against the five real paths answer 405 with nothing written.

## 6. Findings

- **F-1, the malformed-handover-id grammar is layered.** A POST body id that fails `validHandoverDocumentId`
  is a 400 `Invalid handover document.` with no code (`...-v2-domain.ts:1222-1227` → `InputError`). The same
  string as a `?handoverDocumentId=` query is a 404
  `RECOVERY_APPROVAL_V2_HANDOVER_NOT_FOUND` (`...-v2-http.ts:104-116`). The service's own 404 mapping
  (`...-v2-firestore.ts:148-160`) is reachable only for an id that passes body grammar but fails the
  classifier's canonical re-derivation. A well-formed but absent handover is neither: 409 `NOT_ELIGIBLE`.
  Behaviour is coherent and now pinned by test 07; the comment at `...-v2-http.ts:97-99` overstates it
  ("never disagree") and should be reworded when this file is next touched. No product change was made.
- **F-2, the password seam reports V1 codes.** Reusing `authenticateHandoverRecoveryApproval` means a bad
  password arrives as 400 `CREDENTIAL_REJECTED` from the shared coordinator, not as one of the V2
  `AUTHENTICATION_*` codes. Chosen deliberately (one place where a password is verified); documented so no
  later caller assumes a 401.
- **F-3, read-time expiry has an invariant.** The stored record validator requires
  `expiresAt − requestedAt === INTENT_MAX_AGE_MS`, so a test (or a future repair tool) that ages only
  `expiresAt` produces 409 `STATE_INCONSISTENT`, not `expired`. Test 15 shifts both ends together.
- **F-4, the fixture clock.** The §5 routes take `new Date()` from the server process, so the world must
  already be old when it is written. The harness generates the whole fixture behind a backdated `Date`
  (2 h, more than the activation window) so every hash is still produced by the production writers, and
  asserts before seeding that the activation window has genuinely closed. No time-relative assertion and no
  hand-written hash.
- **F-5, offline `next dev` 404 pages are expensive.** Any assertion design that relies on unmatched URLs
  hitting the app's 404 document inherits a Google Fonts fetch that cannot succeed here. Prefer route-tree
  enumeration plus verb probes on existing paths (test 16).
- **F-6, the evidence digest is schema version 2 and 8C.3's HTTP suite still pins version 1.**
  `HANDOVER_RECOVERY_ELIGIBILITY_DIGEST_VERSION = 2` (`src/types/handover-recovery-eligibility.ts:12-15`,
  changed when the fail-closed orphan-operation rule entered the digest inputs).
  `tests/recovery-eligibility-http-emulator.test.mjs:684` still asserts `schemaVersion === 1`, so §5's
  regression run of 8C.3 fails tests 11, 12 and 13 (11 throws before assigning `eligibleDigest`, and 12/13
  then compare a real digest against `null`). The classification itself is unchanged and every other 8C.3
  assertion passes (14 of 17). This is the only red in the sweep. That test file is on the protected list, so
  it was **not** edited; see OD-1. `docs/PHASE-8C3-RECOVERY-ELIGIBILITY.md` §4 title also still says
  "schema version 1" and stays byte-identical by instruction.
- **F-7, tool-output integrity.** Throughout this phase Bash and Read intermittently returned garbled or
  fabricated content (one earlier window produced a `p8c4a-baseline.txt` that does not exist and a wrong hash
  prefix for the 8C.3 test file). Every number in this report was re-derived with a fresh command or a
  line-numbered Grep. Treat any quoted content that cannot be re-verified as unproven.

## 7. Open decisions — this phase stops here

- **OD-1 (needs a go-ahead):** may `tests/recovery-eligibility-http-emulator.test.mjs:684` be moved from
  schema version 1 to 2 — the minimum edit that makes 8C.3 green again — or should the stale pin and its
  three red tests stand as recorded drift? The alternative of teaching the classifier to emit both versions
  would weaken the digest's meaning and is not proposed.
- **OD-2:** `aborted` orphan operations are refused fail-closed by the version-2 digest rule. They remain a
  standing question for the (much later) execution phase: refuse forever, or recover the operation.
- **OD-3:** nothing in this phase gives a UI. The approval record is currently writable only over HTTP by a
  supervisor/administrator session; whether 8C.5 is the approval console or the executor contract is the
  owner's choice.
- **OD-4:** carried from 8C.3/8C.4A and untouched here — 09L owner browser retest, the L-1 protected-runner
  stale-JBR fix, and every `docs/PHASE-8C*` open decision that gates an operational change.

**STOP.** §4 and §5 are implemented and verified; no commit, push, merge, reset, stash, deploy or migration
was performed, and nothing in this phase can activate, abandon or cancel an operational record. Review before
any next step.
