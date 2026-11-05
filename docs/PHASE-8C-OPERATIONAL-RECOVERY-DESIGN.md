# Phase 8C — Operational Recovery and Historical Integrity (DESIGN ONLY)

Repository: `C:\Users\Jonah\Desktop\KobbyProject\NOC-SHIFTCHANGE`
Branch: `feature/handover-v2-recovery` · HEAD `c1703530437ff4e45010dde4f920597fe7684d9f`
Baseline evidence: [.demo/p8c-baseline.txt](../.demo/p8c-baseline.txt) (147 working-tree entries, 0 stashes, 8B.2 hashes intact)
Date: 2026-10-31

**This document is analysis and design. No source file was changed, no operational document was written, nothing was committed, migrated or repaired.** Line numbers refer to the tree recorded in the baseline file.

Legend used throughout — the brief requires every recommendation to separate fact from proposal:

- **[VERIFIED]** — behaviour that exists in the code today and is exercised by a suite (with `file:line`).
- **[VERIFIED-ABSENT]** — searched for and confirmed *not* to exist. Do not assume it later.
- **[PROPOSED]** — new behaviour specified by this document. Requires approval before implementation.

---

## 1. Current architecture and authority map

### 1.1 Authoritative collections and document identities

[VERIFIED] Every name and id derivation below is computed, not stored by the caller:

| Collection | Document id | Derived at |
|---|---|---|
| `equal_handovers_v2` | `handover_v2_<outgoingShiftId>` | `equal-technician-handover-domain.ts:215-222` |
| `handover_reservation_guards` | `guard_<outgoingShiftId>` (or `guard_<sha256.slice(0,32)>`) | `handover-reservation-guard-domain.ts:93-100` |
| `handover_reservation_guard_history` | `guard_archive_<fencingEpoch>_<sha256(canonical)>` | `handover-reservation-guard-domain.ts:532-535` |
| `incoming_acceptance_applications_v1` | `acceptance_app_v1_<sha256{namespace,handoverId,technicianUid}>` | `incoming-acceptance-application-domain.ts:252-256,269` |
| `audit_logs` (activation receipt) | `handover-activation-v2-<sha256hex>` | `incoming-acceptance-application-domain.ts:1214-1220` |
| `audit_logs` (application audit) | `acceptance_application_v1_<businessKeyHash>` | `incoming-acceptance-application-domain.ts:270` |
| `audit_logs` (guard finalization) | `guard_finalization_v1_<sha256{handoverDocumentId,terminalEvidenceRef}.slice(0,40)>` | `incoming-acceptance-guard-finalization.ts:196-204` |
| `handover_reports_v2` | deterministic per report version chain | `equal-handover-report-firestore.ts:1299` |
| `shift_members` / `shift_attendance` | `<incomingShiftId>_<technicianUid>` | `equal-handover-report-firestore.ts:1850`, `join-shift.ts:113-115` |
| `attendance_evidence_v2` | `att2_ev_<digest>`, slot `att2_slot_<digest{handoverId,uid,kind}>` | `attendance-evidence-domain.ts:221-242` |
| `attendance_evidence_operations_v2` | `att2_op_<digest(eventId)>` | `attendance-evidence-domain.ts:234-237` |
| `operational_shift_control` | fixed `global` | `collections.ts:75-76` |
| `handover_review_cases_v1` | `handover_review_case_v1_<sha256{handoverDocumentId}.slice(0,40)>` | `handover-admin-review-domain.ts:138-142` |
| `handover_review_decisions_v1` | `handover_review_decision_v1_<sha256{caseId,idempotencyKey}>` | `handover-admin-review-domain.ts:144-149` |
| `audit_logs` (review) | `handover_review_audit_v1_<sha256{decisionId}>` | `handover-admin-review-domain.ts:151-155` |

Consequence for recovery design: **identity is content-derived everywhere**. A recovery action cannot "correct" a document in place without destroying its own identity proof. That is the structural reason every safe recovery in this codebase is either a *terminal transition* plus an *append*, or nothing at all.

[VERIFIED] `firestore.rules` is deny-all for `match /{document=**}` (`firestore.rules:11-13`); every write goes through the server-side Admin SDK. There is no client-writable collection and no per-collection rules style to imitate, so a new recovery collection needs no rules work to be server-only.

### 1.2 Write authority (who may change what)

- Handover aggregate `equal_handovers_v2` — ten transactional writers, all in `equal-handover-reservation-firestore.ts` (create/replace/cancel, `:585-586`), `equal-handover-report-firestore.ts` (preparation `:720`, absence `:879/:990`, confirm `:1087`, freeze `:1349`, commit `:1604`, accept/activate `:1817`, finalize reads `:2130/:2206`), atomic acceptance `incoming-acceptance-application-firestore.ts:1387`. Domain constructors in `equal-technician-handover-domain.ts:569-1037`.
- Guard — `handover-reservation-guard.ts`: acquire `:77-155`, replace `:187-214` (via `transitionGuardForReplacement`), cancel `:187-214`, complete `:422-475`, archive+re-acquire `:94-114`. Atomic finalization writes the guard at `incoming-acceptance-guard-finalization.ts:1044-1060`.
- Shifts — `create-shift.ts:104` (admin|supervisor), `start-shift.ts:111` (**technician-only**, with the comment "no manager branch may be reintroduced here" `:190-194`), `begin-shift-handover.ts`, `complete-shift.ts`, `recover-expired-scheduled-shift.ts:927-942`.
- Membership / attendance — `join-shift.ts:71`, `equal-handover-report-firestore.ts:2051-2055`, `incoming-acceptance-application-firestore.ts:1428,1600`. [VERIFIED-ABSENT] Any administrator- or supervisor-authored attendance: `api/operations/shifts/[shiftId]/attendance/route.ts` is GET-only (`:45-75`), no POST/PUT/PATCH exists.
- Frozen reports — create-only `equal-handover-report-firestore.ts:1348`; [VERIFIED-ABSENT] any update or delete of `handover_reports_v2` anywhere in `src`.
- Audit logs — every access is `transaction.create`; [VERIFIED-ABSENT] any audit update or delete in `src`; no retention policy exists.
- Review — writes only `handover_review_cases_v1` (create-or-update `handover-admin-review-firestore.ts:1507-1515`), `handover_review_decisions_v1` (create-only `:1517-1520`) and one `audit_logs` row (`:1521-1541`). The module boundary states it never writes an operational collection (`:4-8`), enforced by byte-equality tests (`tests/handover-admin-review-emulator.test.mjs:518,698,749,796,944,1047`).
- [VERIFIED-ABSENT] Impersonation. Roles are exactly `admin | supervisor | technician` (`types/auth.ts:2-5`). The only cross-uid pattern in the repo is provisioning-lease recovery, which *refuses* to act unless the recovery identity equals the new owner (`reservation-persistence-core.ts:375-377`) and requires an injected `authorizeRecoveryAdministrator` (`:187-192`) — and has no production caller.

### 1.3 Transaction discipline already established

[VERIFIED] Three properties hold for every mutating service examined and must hold for anything 8C adds:

1. **All authoritative reads precede all writes inside one `runTransaction`.** Atomic acceptance: `incoming-acceptance-application-firestore.ts:679` with the comment "every authoritative read completes before the first write" (`:685-687`); guard finalization `incoming-acceptance-guard-finalization.ts:575-1089`; expired-shift recovery `recover-expired-scheduled-shift.ts:156-164`.
2. **Post-commit read-back instead of guessing.** On an unreadable/unresolved result the services return 503 with an explicit commit state, never a false rollback: `APPLICATION_OUTCOME_UNKNOWN` `committed_unresolved|unreadable|inconsistent` (`incoming-acceptance-application-firestore.ts:231-243,1650-1704`), `GUARD_FINALIZATION_OUTCOME_UNKNOWN` (`incoming-acceptance-guard-finalization.ts:1091-1146`), comment "never fabricate a success" (`:233-234`).
3. **Optimistic concurrency on three axes** — `aggregateRevision`, `guardRevision`/`fencingEpoch`, `snapshotHash`: `assertLiveReviewedBinding` (`incoming-acceptance-application-firestore.ts:392-409`), guard revision/epoch and `active` state (`:988-1000`, `handover-reservation-guard-domain.ts:447-452`), reviewed-binding fields (`types/incoming-acceptance-application.ts:113-121`).
4. **Personal authentication happens strictly before the transaction** and is re-checked inside it: `signInWithPassword` through Identity Toolkit (`incoming-acceptance-http-coordinator.ts:217-231`, `src/lib/auth/password-reauthentication.ts:73-233`), UID match, request-local nonce + binding fingerprint + reason digest, 60 s max age, monotonic expiry (`incoming-acceptance-application-domain.ts:47,458-511`), and evidence must carry `personallyAuthenticated === true` (`:1108-1110`). The clocks are all server-derived (`incoming-acceptance-http-coordinator.ts:60-68`); the request body carries none (`incoming-acceptance-http-co.ts` contract at `handover-v2-atomic-http.ts:130-148`).

### 1.4 Windows, expiry and the guard

[VERIFIED]
- Activation window: `[scheduledStart − 15 min, min(scheduledStart + 60 min, scheduledEnd)]` (`shift-activation-window.ts:25-28`, enforced `incoming-acceptance-application-firestore.ts:1209-1222`).
- Join window closes at `scheduledEnd`: `if (joinTime >= scheduledEnd) fail("JOIN_WINDOW_CLOSED")` (`incoming-acceptance-application-domain.ts:1033-1038`).
- "Late" is >5 min past `scheduledStart` and requires a reason (`equal-technician-handover-domain.ts:1065`; reason codes `LATE_REASON_REQUIRED|INVALID` 400).
- Expiry test used by lifecycle classification: `if (now >= Date.parse(scheduledEnd))` → `JOINING_WINDOW_EXPIRED` / `JOIN_WINDOW_CLOSED` (`incoming-acceptance-guard-lifecycle.ts:226-232`), reached only when a personal receipt is missing.
- `scheduledStart`/`scheduledEnd` are written in exactly two places in the whole repository — shift creation (`create-shift.ts:249-250`) and incoming-shift creation during acceptance (`equal-handover-report-firestore.ts:2040-2045`). [VERIFIED-ABSENT] Any code that edits a scheduled window after the fact: no `shifts/[shiftId]/route.ts`, no PATCH/PUT on shifts anywhere in `src`.
- The guard itself has **no expiry, TTL or deadline field** (`handover-reservation-guard-domain.ts:102-123`) and no transition expires it. Elapsed window is non-terminal and fail-closed: the guard stays `active`, `terminalEvidenceRef` stays `null`, finalization throws `GUARD_FINALIZATION_NOT_ELIGIBLE` with `lifecycleState: "joining_window_expired"` (`incoming-acceptance-guard-finalization.ts:881-890`), and `requiresOperatorWorkflow = true` (`incoming-acceptance-guard-lifecycle.ts:90-93`).

### 1.5 Existing recovery precedents (the templates 8C must follow)

[VERIFIED] These are the only recovery-shaped primitives in the product today:

1. **`recoverExpiredScheduledShift`** (`recover-expired-scheduled-shift.ts:95`) — admin-only (`:207-219`, comment "Supervisors cannot use this path" `:200-205`), server clock only (`:305-315`), requires status exactly `SCHEDULED` (`:258-266`), requires the shift to still own the global slot (`:236-247`), requires `actualStart/actualEnd` null and `handoverStartedAt == null` (`:294-303`). **Refuses if any attendance exists** — "cannot be recovered automatically" (`:567-574`) — and if any task is not `COMPLETED|CANCELLED` (`:603-613`). Writes: shift → `cancelled` (`:927-942`), control → next pending generation (`:944-947`), roster `leftAt` ("roster end only, not a clock-out" `:949-969`), authorization terminal fields (`:971-992`), schedules + `lastAssignmentActivityAt` (`:994-1013`), one `audit_logs` create (`:1015-1057`). **Once-only, not replay-idempotent**: a second call 409s because the status/slot changed (`:190-198,258-266`). Exposed at `POST api/operations/shifts/[shiftId]/recover-expired` (`route.ts:44-101`, body deliberately ignored) with **no UI entry point** ([VERIFIED-ABSENT]; only non-test reference is `scripts/fresh-presentation.mjs:43`, and `docs/PHASE7-PRODUCT-READINESS-AUDIT.md:93` records "recover-expired API only").
2. **Exceptional guard closure** — supervisor-only, participant-excluded (`incoming-acceptance-guard-finalization.ts:663-711`), eligibility gate `exceptional_closure_authorized` (`:881-890`) which requires the aggregate to be `completed` with a valid activation receipt and exactly one missing reserved subject (`incoming-acceptance-application-domain.ts:1581-1619`), and a hard refusal if the subject has any receipt/membership/attendance/evidence (`:973-1003`). Writes guard + audit only. UI exists: `components/operations/supervisor-guard-closure.tsx:66` mounted at `supervisor-handover-v2-detail.tsx:175`.
3. **Idempotent replay** — the only "retry" mechanism for a lost response. Re-POSTing acceptance re-verifies and writes nothing (`incoming-acceptance-application-firestore.ts:856-961`, statuses `APPLIED|REPLAYED` `:191`, HTTP `ACCEPTANCE_ALREADY_APPLIED` `handover-v2-atomic-http.ts:43`); re-POSTing finalization returns `ALREADY_FINALIZED` with zero writes (`incoming-acceptance-guard-finalization.ts:800-856`).
4. **Read-only reconciliation** — `incoming-acceptance-reconciliation.ts:239-690`, `readOnly: true` (`:93`), eight statuses (`:55-64`: `APPLIED_VALIDATED, NOT_APPLIED, EVIDENCE_ONLY, COMMIT_UNVERIFIABLE, BINDING_CONFLICT, GUARD_CONFLICT, INCONSISTENT_HISTORY, ADMIN_REVIEW_REQUIRED`), guidance map `NONE|RETRY_ACCEPTANCE|CONTACT_ADMIN|REFRESH_STATUS|REVIEW_AND_RETRY` (`handover-v2-atomic-http.ts:223-232`), wired to the technician status route (`.../accept/atomic/status/route.ts:63`) and UI (`incoming-acceptance-atomic.tsx:161`). It has **no clock input** (`:86-90`), so it cannot see expiry at all.
5. **Interrupted personal-evidence resume** — `resumeAttendanceEvidenceOperation` (`attendance-evidence-firestore.ts:300-305,363-409`): refuses aborted (`:372-377`), refuses still-pending because that "requires the trusted confirmation/acceptance coordinator" (`:378-383`), refuses to guess when the evidence document is missing (`:386-390`), and on success **reuses the stored `finalizedAt`** rather than re-timing (`:399-407`). Already-finalized is a no-op: "never re-time or overwrite" (`:195-199`).
6. **Guard archive + successor generation** — cancelled guard + v2 owner only: `handover-reservation-guard.ts:84-114` creates create-only history (`transaction.create` `:112`, collision → 409 "administrator review required" `:99-104`), sets `terminalEvidenceRef = archiveDocumentId`, `fencingEpoch + 1`, `guardRevision + 2` (`handover-reservation-guard-domain.ts:577-645`). Comment: "Completed guards never transition, in either direction" (`:529-530`).
7. **Legacy (non-atomic) finalize** — `finalizeEqualHandoverReservationV2` (`equal-handover-report-firestore.ts:2119`), reachable by technician **and admin and supervisor** (`v2/finalize/route.ts:35`), requires aggregate `completed` (`:2135`), a valid activation receipt (`:2137-2139`), guard `active` (`:2146`) and **both** incoming attendances (`isEqualHandoverIncomingAttendanceResolved` `:2281-2297`). It completes the guard with `terminalEvidenceRef = activationReceiptId` (`:2149-2155`) and **writes no finalization audit**. This is the sole producer of unaudited closures.

[VERIFIED] Automation: only `deliverOutboxEntry` and `drainNotificationOutbox` run on a schedule (`functions/src/index.ts:37-52`), gated by `notificationsEnabled()`, and they write only notification tables; the worker header states retries "never mutate workflow state" (`outbox-worker.ts:8-9`). Nothing automated touches handover, guard, attendance, shift or control state.

### 1.6 The verified consequence of an un-accepted handover (why 8C exists)

[VERIFIED] A committed handover whose incoming technicians never accept is a **global operational stall**, not a local annoyance:

- The only exit from `awaiting_incoming_acceptance` is the ACTIVATION branch of `acceptEqualHandoverIncomingV2` (`equal-handover-report-firestore.ts:1927-2036`), whose actor must be a reserved incoming technician (`:1843`) with an `active` guard (`:1933`).
- `cancel`/`replace` require `lifecycleStatus === "collecting_confirmations"` (`equal-handover-reservation-firestore.ts:398`), so post-commit cancel or supersede [VERIFIED-ABSENT].
- Reservation operations are technician-only and require the outgoing shift to be `handover_pending` (`equal-handover-reservation-firestore.ts:323-334,348-350`). [VERIFIED-ABSENT] Any admin- or supervisor-initiated reservation.
- The outgoing shift keeps the global slot (`handover_pending` ∈ `OCCUPYING_SHIFT_STATUSES`, `operational-shift-control-state.ts:26-30`), and `consumeOperationalShiftSlot` refuses while it is held: "The current global shift slot is already occupied. Complete the current shift before creating another." (`create-shift.ts:522-530`).
- The one existing admin recovery refuses this shape by precondition: it requires status `SCHEDULED` (`recover-expired-scheduled-shift.ts:258-266`) and `advanceExpiredScheduledOperationalShiftControl` requires `shiftStatus === "scheduled"` (`operational-shift-control-state.ts:402-414`).

So today: zero acceptances + elapsed `scheduledEnd` = a permanently active guard, a permanently `awaiting_incoming_acceptance` aggregate, a `handover_pending` shift holding the slot, and **no authorized path forward for anyone** — administrator, supervisor or technician. Exceptional closure does not help because it requires the aggregate to already be `completed` (§1.5 item 2). This is the single case that justifies proposing new operational recovery in 8C; everything else is case management.

---

## 2. Recovery classification matrix

Each row is the current, verified projection state plus the recovery judgement this design proposes. "Recoverable" means *a forward transition exists that does not fabricate evidence*.

### C1. Expired joining window before first acceptance
- **Detection** [VERIFIED]: guard `active`, `terminalEvidenceRef === null`, aggregate `awaiting_incoming_acceptance`, no activation receipt, `now >= scheduledEnd` → lifecycle `JOINING_WINDOW_EXPIRED / JOIN_WINDOW_CLOSED` (`incoming-acceptance-guard-lifecycle.ts:226-232`), review classification `joining_window_expired` with reasons `JOIN_WINDOW_CLOSED` + `PERSONAL_ACCEPTANCE_MISSING` (`handover-admin-review-firestore.ts:986,995`), `requiresReview = true`.
- **Authoritative evidence**: the aggregate's `identity.scheduledEnd`, the guard document, and the *absence* of receipts (absence is meaningful only together with the closed window).
- **Recoverable?** Not *into this handover*. `JOIN_WINDOW_CLOSED` is computed from immutable `scheduledEnd` (`incoming-acceptance-application-domain.ts:1033-1038`) and the guard cannot be completed without receipts.
- **Automatable?** Partially — see OP-3 in §5: a terminal *abandonment* is provable; a *successful handover* for this instance is not.
- **Who authorizes**: administrator only, mirroring `recover-expired-scheduled-shift.ts:207-219`; supervisor excluded on the same reasoning the existing code gives.
- **Must remain immutable**: the frozen report, the commit receipt, the aggregate's identity/times, the guard's `reservedAt`, the outgoing attendance of the outgoing technician.
- **If interrupted**: the operation must be once-only with a pre-commit refusal set (as the existing recovery is), and must return a post-commit read-back outcome rather than a guessed rollback (§1.3 item 2).
- **Escalation**: always a review case; auto-recovery must not run without one. **[PROPOSED]**

### C2. Expired window after first acceptance, partner never joined
- **Detection** [VERIFIED]: aggregate `completed`, incoming shift `active`, guard `active`, exactly one validated application → classifier `EXCEPTIONAL_CLOSURE_READY` (table at `incoming-acceptance-guard-lifecycle.ts:182-247`), review `awaiting_partner_acceptance` until the window closes, then `joining_window_expired` with `PERSONAL_ACCEPTANCE_MISSING`.
- **Recoverable?** **Yes, and already implemented**: supervisor exceptional closure (§1.5 item 2). Post-closure the review classifies `completed_exceptional` (`handover-admin-review-firestore.ts:944-965`).
- **Automatable?** Should not be. It is a judgement about a person's absence; the supervisor signature is the point of the control.
- **Who authorizes**: live supervisor, never a reserved participant (`incoming-acceptance-guard-finalization.ts:683-698`).
- **Immutable**: the surviving technician's receipt/evidence/attendance; the absent subject must own none of them (`:973-1003`).
- **Interrupted**: `ALREADY_FINALIZED` replay, zero writes (`:800-856`); exceptional replay additionally *requires* the audit to exist (`:835-843`).
- **Escalation**: only if the closure is refused (subject has evidence, or the reason is empty) → `inconsistent_review_required`.

### C3. Acceptance committed but the response was lost
- **Detection** [VERIFIED]: 503 `APPLICATION_OUTCOME_UNKNOWN` with `committed_unresolved|unreadable|inconsistent` (`incoming-acceptance-application-firestore.ts:231-243,1650-1704`); reconciliation answers `COMMIT_UNVERIFIABLE` / `EVIDENCE_ONLY` (`incoming-acceptance-reconciliation.ts:55-64`).
- **Authoritative evidence**: the content-derived receipt document itself + its recomputed `receiptHash` and lineage (`incoming-acceptance-application-domain.ts:600-602,698-711`).
- **Recoverable? Yes — by replay, already implemented.** The same POST re-verifies and writes nothing (`:856-961`).
- **Automatable?** Already effectively automatic: retry the identical request. Client-safe because the id is deterministic.
- **Who authorizes**: the same technician, with the same personal reauthentication; nobody may retry *as* them [VERIFIED-ABSENT by design: `personallyAuthenticated` `incoming-acceptance-application-domain.ts:1108-1110`].
- **Interrupted**: replay converges; no partial state can exist because all writes are in one transaction.
- **Escalation**: only when reconciliation answers `INCONSISTENT_HISTORY` or `BINDING_CONFLICT`.

### C4. Receipt exists but supporting evidence is incomplete
- **Detection** [VERIFIED]: application row where `evidencePresent`/`attendancePresent`/`applicationAuditPresent` are false while a receipt exists (`handover-admin-review-firestore.ts:662-676,762-764`), reason `PERSONAL_RECEIPT_INCOMPLETE` / `APPLICATION_*`; integrity test asserts finalized evidence is immutable on retry (`tests/incoming-acceptance-integrity.test.mjs:63`).
- **Authoritative evidence**: the receipt hash is authoritative for *the acceptance act*; the evidence slot is authoritative for *the personal authentication that accompanied it*. They must agree or the receipt is not verifiable (`incoming-acceptance-application-domain.ts:1108-1110`).
- **Recoverable?** No, by design. Completing the missing half means writing attendance or a `PERSONAL_PASSWORD_*` evidence slot for someone else — the exact prohibited action (attendance route is GET-only; `attendance-evidence-domain.ts:180-193` allows only personal authentication kinds).
- **Automatable?** No.
- **Who authorizes**: nobody; the *subject* technician is the only party who can create their own evidence, and only through the live acceptance path.
- **Interrupted**: n/a.
- **Escalation**: mandatory — `mark_further_investigation` then `escalate` (§3.D).

### C5. Conflicting activation receipts
- **Detection** [VERIFIED]: two receipts cannot share the deterministic id (`transaction.create` `incoming-acceptance-application-firestore.ts:1449-1452`); a conflict therefore surfaces as hash/lineage mismatch, `RECEIPT_BEFORE_ACTIVATION` (`handover-admin-review-firestore.ts:867`), or `ACTIVATION_RECEIPT_INVALID` (`:919,1046`); finalization refuses a completed guard without an activation receipt (`incoming-acceptance-guard-finalization.ts:813-821`) and refuses an audit that exists while the guard is `active` (`:1032-1041`).
- **Authoritative evidence**: none is verifiable from inside the conflict. The recomputed hash is the tie-breaker, and if both candidates hash correctly they cannot share an id.
- **Recoverable?** No — automated repair would require choosing which history is true, which no read model can prove.
- **Automatable?** No. **Who authorizes**: nobody. **Immutable**: every candidate receipt (quarantine by annotation, never deletion).
- **Interrupted**: n/a. **Escalation**: mandatory, and this class should be reported to the security/audit owner, not just the queue (§3.D).

### C6. Guard and shift state disagree
- **Detection** [VERIFIED]: guard `completed` while the aggregate is not `completed` → `RECEIPT_BEFORE_ACTIVATION` / `HANDOVER_NOT_ACTIVATED` (`incoming-acceptance-guard-lifecycle.ts:167-180`); guard `cancelled` (`GUARD_CANCELLED`, `handover-admin-review-firestore.ts:888`); guard row missing (`GUARD_MISSING`, `:878`); `ownerHandoverDocumentId` mismatch (`GUARD_OWNER_MISMATCH`, `:137-143`).
- Note [VERIFIED]: "aggregate `awaiting_incoming_acceptance` while the guard is `completed`" is **not producible** by any current path — closure requires aggregate `completed` (`incoming-acceptance-application-domain.ts:1524`). Its appearance means out-of-band tampering.
- **Recoverable?** No. The disagreement is the finding; a repair would overwrite one of two authoritative records.
- **Automatable?** No. **Who authorizes**: administrator, case management only.
- **Immutable**: both documents as found, plus an append-only snapshot of the disputed bytes (§6).
- **Interrupted**: n/a. **Escalation**: mandatory.

### C7. Missing or invalid exceptional closure evidence
- **Detection** [VERIFIED — delivered in 8B.2]: `EXCEPTIONAL_CLOSURE_EVIDENCE_MISSING`, `EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID`, `TERMINAL_EVIDENCE_CONTRADICTION`, `TERMINAL_REFERENCE_MISSING` demote the badge to `inconsistent_review_required`, set `requiresReview`, remove `acknowledge`, and align the display fields (`handover-admin-review-firestore.ts:434-460,892-908,1139-1143`; provenance kinds `absent|normal|exceptional|unverified` `:328-424`).
- **Authoritative evidence**: `audit_logs/guard_finalization_v1_<…>` **plus** the closure self-proof chain (`closureId === terminalEvidenceRef`, reserved subject, non-empty reason, `authorizedBy === audit.authorizedByUid`, canonical `recordedAt`) — verified in `:354-424`; the finalization service writes the same material (`incoming-acceptance-guard-finalization.ts:1015-1016`).
- **Recoverable?** **No, and it must never be.** The closure audit is `create`-only with a content-derived id (`:1061`, id `:196-204`); re-issuing it after loss means minting a supervisor signature after the fact.
- **Automatable?** No. Only re-classification (read-only) is automatic and already shipped.
- **Who authorizes**: administrator for case management; nobody for evidence creation.
- **Immutable**: the guard (its `terminalEvidenceRef` is terminal proof of a specific closure, `:804-812`) and the corrupt audit *as found*.
- **Interrupted**: n/a (no write). **Escalation**: mandatory; a demoted case may only be moved to `under_investigation` or `escalated`.

### C8. Historically acknowledged case whose evidence is now inconsistent
- **Detection**: 8B.2 demotion re-derives the live classification on every read, so the demotion appears on refresh and the served fingerprint changes; a decision submitted from the old view is refused `REVIEW_DECISION_STALE` (`handover-admin-review-firestore.ts:1443-1455`).
- **The hard limit** [VERIFIED]: the acknowledgement decision itself cannot be revoked or revised. A closed case yields `allowedReviewDecisions === []` (`handover-admin-review-domain.ts:263`) and evaluation throws `REVIEW_CASE_CLOSED` (`:284-289`); no code path moves a case out of `closed`; decisions are create-only (`handover-admin-review-firestore.ts:1517-1520`).
- **Recoverable?** The *case* is unrecoverable and should stay that way. What is missing is a way to record that the old acknowledgement is now contradicted — see §6 **[PROPOSED]**.
- **Automatable?** Detection yes (it already happens on read); recording no, until OP-1/OP-2 exist.
- **Who authorizes**: administrator; original actor identity is irrelevant to the reassessment.
- **Immutable**: the original decision document and its audit row, byte-for-byte, forever.
- **Interrupted**: append-only design makes each step individually idempotent (§6).
- **Escalation**: yes — a contradicted acknowledgement is exactly what an escalation target is for.

### C9. Legacy normal closure without a finalization audit
- **Detection** [VERIFIED]: the review reader finds no audit and reports `finalizationAuditPresent: false`; the finalizer labels the replay `legacy_guard_only` (`incoming-acceptance-guard-finalization.ts:558`), but [VERIFIED-ABSENT] **no code trusts that field as proof and no test asserts it** — it is a response field only (`v2/guard/finalize/route.ts:79`). `legacy_guard_only` demotes nothing today: a normal closure with no audit still projects `completed_valid` (verified in 8B.2, `.demo/p8b2-probe-valid.json`).
- **Authoritative evidence**: for this shape, the equivalent chain *does* exist and is independently checkable: verifiable activation receipt (`handover-activation-v2-…` recomputed hash) + exactly two validated applications + both `shift_attendance` rows + a valid frozen report binding + aggregate `completed` + `terminalEvidenceRef === activationReceiptId`. The producer required exactly that (`equal-handover-report-firestore.ts:2135-2146`, `:2281-2297`).
- **Recoverable?** Nothing needs recovery: the closure is real. The defect is *provenance silence* — the audit was never written by the legacy route.
- **Proposed handling** §6 **[PROPOSED]**: a new classification `completed_valid_unaudited_legacy` gated on the **full equivalent-evidence chain**, never on the stored label. If any link is missing → `inconsistent_review_required`.
- **Automatable?** Classification, yes. Writing the missing audit, **no** — that is fabrication.
- **Who authorizes**: read-model only; no signature.
- **Immutable**: everything. **Interrupted**: n/a.
- **Escalation**: only if the chain is incomplete.
- **Compatibility warning**: adding a classification changes fingerprint inputs (§7 of 8B.2 notes; inputs at `handover-admin-review-firestore.ts:1084-1125`), so previously served decisions on such cases will be rejected as stale. This is a deliberate, approval-requiring consequence, not a silent change.

### C10. Valid exceptional absence requiring supervisor intervention
- **Detection** [VERIFIED]: aggregate `not_yet_in` absence with non-empty reason (`equal-technician-handover-domain.ts:532-533,731-732`), classifier `EXCEPTIONAL_CLOSURE_READY` (`incoming-acceptance-guard-lifecycle.ts:182-247`), supervisor UI `supervisor-guard-closure.tsx:66`.
- **Recoverable? Yes — implemented.** Constraints that must not be relaxed: supervisor live profile, non-participant, subject reserved and ≠ actor (`incoming-acceptance-guard-finalization.ts:663-711`), `activatedAt <= recordedAt <= nowIso` with `recordedAt` overwritten by the server (`:946-968`; `v2/guard/finalize/route.ts:63-69`), and no fabricated participation (`:973-1013`).
- **Automatable?** Should not be (judgement + accountability).
- **Interrupted**: replay-safe (`:800-856`). **Escalation**: when the closure is ineligible because the absent subject *does* have evidence — that is a real conflict, not an absence.

### C11. A reserved incoming technician is unavailable (declared in advance)
- **Detection** [VERIFIED]: absence records can only be created or cleared by an **outgoing** reserved technician (`equal-handover-report-firestore.ts:442-455`, services `:865` / `:981`, route `v2/absence/route.ts:22-34`). [VERIFIED-ABSENT] Any pre-declaration of unavailability by an *incoming* technician, and any supervisor-side substitution for a committed handover.
- **Consequence**: with one technician unavailable *before any acceptance*, the aggregate still cannot be replaced — `replaceEqualHandoverReservation` requires `collecting_confirmations` (`equal-handover-reservation-firestore.ts:398`), and commit has already left that state.
- **Recoverable?** Not through this handover. The only sound forward path is a **fresh** scheduling decision (new shift + new reservation), which exists for admin|supervisor at the shift layer (`create-shift.ts:104,285-299`) but is currently unreachable while the stalled shift holds the slot (§1.6).
- **Automatable?** No. This is a staffing act, not a state repair.
- **Who authorizes**: supervisor/admin schedule a new shift; the *replacement technician* must still personally accept with their own password proof.
- **Immutable**: nothing about the old instance may be reused — authorizations are slot-keyed and tokens are never reused (`operational-shift-control-state.ts:434-438`; `next-shift-authorizations.ts:313-322`), and an expired shift's cancellation is terminal.
- **Escalation**: mandatory until OP-3 exists.

### C12. A handover that cannot safely be recovered automatically
- **Definition [PROPOSED]** (all conditions fail closed to case management):
  1. any acceptance, receipt, membership, attendance or evidence exists for the subject the action would affect — the existing recovery precedent uses exactly this rule (`recover-expired-scheduled-shift.ts:567-574`);
  2. terminal evidence is present but unverifiable or contradictory (C7);
  3. guard/handover/shift disagree (C6);
  4. the global slot owner is not the shift in question (`recover-expired-scheduled-shift.ts:236-247` equivalent);
  5. a report is frozen with a binding the review model cannot verify (`handover-admin-review-firestore.ts:928,1032`);
  6. any candidate receipt fails hash/lineage (C5);
  7. the actor cannot be identified by their own live, re-authenticated session (no impersonation exists, and none may be added);
  8. the action would need a timestamp the server cannot mint now (no backdating primitive exists).
- **Behaviour**: refuse with a stable code, write zero operational documents, and leave/advance an append-only review record. [VERIFIED pattern] Refusals already write nothing (`tests/handover-admin-review-emulator.test.mjs:465-467,651-652,678`; `incoming-acceptance-guard-finalization.ts` fails with `not_committed` on every authority check).

---

## 3. Permissible recovery actions

### A. Read-only reconciliation (exists; extend, do not weaken)
[VERIFIED] Available today: `readHandoverReviewCase` (`handover-admin-review-firestore.ts:1215-1234`), `listHandoverReviewQueue` (`:1273-1346`), `reconcileIncomingAcceptance` (read-only, `incoming-acceptance-reconciliation.ts:93`), acceptance status route (`.../accept/atomic/status/route.ts:63`), and 8B.2's authoritative terminal-evidence gate (`:354-460`).
[PROPOSED] A.1 Expose reconciliation for *expired/inconsistent* aggregates too — it currently has **no clock input** (`:86-90`) and therefore cannot state whether a window has closed. Adding a server-supplied `nowIso` (never client-supplied, per §1.3) would let the queue distinguish "still open" from "closed forever".
[PROPOSED] A.2 Reassessment-on-read (already true for classification) plus an explicit `evidenceDigest` of the disputed documents so a case can be re-inspected byte-for-byte later (§6).
No operational write is permitted in this class. Refusal behaviour is unchanged: unreadable input yields an error, never a definitive "not applied" (`incoming-acceptance-reconciliation.ts:681-689`).

### B. Administrative case management (exists; two gaps)
[VERIFIED] Five decision types with the table in `handover-admin-review-domain.ts:259-274`: `acknowledge_valid_completed_state` only for `completed_valid`; `mark_further_investigation` → `under_investigation`; `record_administrative_finding` → status unchanged; `close_review_case` → `closed` + resolution summary; `escalate` → `escalated`. Case statuses `open|under_investigation|escalated|closed` (`types/handover-admin-review.ts:22-27`). Writes stay inside the three review tables; 14 operational collections are asserted byte-identical (`tests/handover-admin-review-emulator.test.mjs:97-112`).
[VERIFIED-ABSENT] Reopening a closed case (`handover-admin-review-domain.ts:263,284-289`), editing a decision (create-only `handover-admin-review-firestore.ts:1517-1520`), and any confirmation step in the UI (submit is a plain POST, `handover-review-workspace.tsx:843-850`).
[PROPOSED] B.1 **Append-only reassessment** (§6, OP-1). B.2 **Linked follow-on case** (§6, OP-2). B.3 **Mandatory confirmation step** for any decision other than `mark_further_investigation`, showing the fingerprint the administrator actually inspected. B.4 `aria-live` status region for classification changes and decision outcomes (verified gap: `decisionNotice`/`decisionError` are plain `<p>` at `handover-review-workspace.tsx:745-754`; queue/detail loading text has no `role=status`/`aria-busy` `:407-410,476-479`; evidence table lacks `<caption>`/`scope` `:634-643`).

### C. Operational recovery (one candidate; narrow)
Only three transitions in this domain are *provable without new evidence*, and two already exist:
- [VERIFIED] C-exists-1 normal guard finalization (receipt-backed, idempotent) — `incoming-acceptance-guard-finalization.ts:1044-1061`.
- [VERIFIED] C-exists-2 exceptional closure with a supervisor signature — `:881-1013`.
- [PROPOSED] C1 = **OP-3 abandon-stalled-handover** (§5). Scope: one transition, aggregate → `cancelled`, guard → `cancelled` (existing `transitionGuardForCancellation`, `handover-reservation-guard-domain.ts:383-420`), outgoing shift → `cancelled`, global slot advanced to a fresh pending generation (existing `advanceExpiredScheduledOperationalShiftControl` semantics, `operational-shift-control-state.ts:402-447`), roster `leftAt` only, one audit row. Nothing else.
Non-goals for class C — no capability may be added to: extend a window, rewrite `scheduledEnd`, mint a receipt, mint attendance, mint an evidence slot, write or repair an audit, clear/rewrite `terminalEvidenceRef`, or reopen a completed guard. [VERIFIED] "Completed guards never transition, in either direction" (`handover-reservation-guard-domain.ts:529-530`) is a hard invariant to preserve, not a limitation to remove.

### D. Non-recoverable conditions (refuse, always)
C4, C5, C6, C7, C11 and all eight tests in C12. [PROPOSED] A distinct review classification for "evidence is contradicted, human intervention required" so that refusal is visible in the queue rather than being an absence of buttons.

**Standing prohibition, restated from the brief and already enforced by the code**: no administrator may impersonate a technician, generate a personal password proof, produce an acceptance receipt, or author attendance. Verified enforcement: personal reauthentication happens before the transaction and inside it (`incoming-acceptance-http-coordinator.ts:217-231`), evidence must carry `personallyAuthenticated` (`incoming-acceptance-application-domain.ts:1108-1110`), `INCOMING_CLOCK_IN` accepts only `PERSONAL_PASSWORD_CONFIRMATION` and `INCOMING_LATE_ACCEPTANCE` only `PERSONAL_PASSWORD_ACCEPTANCE` (`attendance-evidence-domain.ts:180-213`), personally authenticated evidence requires the subject's own verified uid (`:709-712`, 403), and the attendance route has no write method at all.

---

## 4. Expired-window recovery design

**Question posed by the brief**: can a safe, separately authorized recovery exist *without* retroactively changing the original acceptance window?

**Answer**: Yes for *terminal abandonment* (one shape only), No for *completing the handover*. Both halves are stated below, because recommending only the first half would hide the product gap.

### 4.1 What is impossible without violating the protocol [VERIFIED]
- The join decision is a pure function of immutable `scheduledEnd` (`incoming-acceptance-application-domain.ts:1033-1038`); `scheduledStart/scheduledEnd` are written in only two places (`create-shift.ts:249-250`, `equal-handover-report-firestore.ts:2040-2045`) and no update path exists.
- The guard has no expiry field and no expiring transition (`handover-reservation-guard-domain.ts:102-123`).
- Exceptional closure cannot reach a zero-acceptance handover: eligibility requires aggregate `completed` + valid activation receipt (`incoming-acceptance-application-domain.ts:1581-1619`; `incoming-acceptance-guard-finalization.ts:881-890`).
- Post-commit cancel/replace is blocked by the `collecting_confirmations` precondition (`equal-handover-reservation-firestore.ts:398`).
- Re-authorizing the same technicians for an expired instance is impossible by construction: authorizations are slot-keyed and tokens are never reused (`operational-shift-control-state.ts:434-438`).

Therefore **any design that "recovers" a real handover after expiry must create a new instance**, not repair the old one. Extending the window or backdating is rejected outright (it would break the receipt hash, the evidence digests and the 8B.2 gate simultaneously).

### 4.2 OP-3 — `abandonStalledHandoverUnderExpiry` [PROPOSED]
Facts it must satisfy, each copied from the existing precedent's shape:

1. **Eligibility is provable and narrow**: guard `active` with `terminalEvidenceRef === null`; aggregate `awaiting_incoming_acceptance`; **no** application document for either reserved technician; no activation receipt; outgoing shift `handover_pending` and owner of the global slot; `assertShiftActivationWindowExpired(now, …)` true (`shift-activation-window.ts:84-117`); server clock only.
2. **First refusal**: if *any* acceptance, receipt, membership, attendance or evidence exists for either reserved technician → refuse with `HANDOVER_RECOVERY_NOT_AUTOMATIC` and hand the case to review. This is the same rule that already gates the only shipped recovery (`recover-expired-scheduled-shift.ts:567-574`).
3. **Second refusal — the participation boundary**: OP-3 must never touch a shift that has `actualStart` set or a handover that was activated, exactly as the existing recovery requires null `actualStart/actualEnd` and `handoverStartedAt == null` (`:294-303`).
4. **Fresh authorization path**: the action releases the slot into a new *pending* generation (`advanceExpiredScheduledOperationalShiftControl`, `operational-shift-control-state.ts:402-423`), which is what allows a supervisor to schedule the next shift (`create-shift.ts:522-530` is no longer blocked) and lets a new reservation be initialized (`equal-handover-reservation-firestore.ts:637`, technician-initiated, requires `handover_pending`). Nothing is re-authorized for the old instance.
5. **Immutability**: the frozen report, the commit receipt, the outgoing technician's own attendance/evidence and the aggregate's identity fields are never rewritten; the guard is *cancelled*, not deleted, through the existing transition (`handover-reservation-guard-domain.ts:383-420`), and the cancellation audit id becomes `terminalEvidenceRef` — a pattern that already exists (`handover-reservation-guard.ts:187-214`).
6. **Interruption behaviour**: once-only, like the precedent (a second call 409s because the status and slot have changed), plus a post-commit read-back that returns `committed_unresolved` rather than guessing (§1.3 item 2). Idempotency is therefore *deliberately not replay-based*: an abandoned handover must not be silently re-abandonable with different intent.

### 4.3 What is explicitly rejected
- Silent window extension or any `scheduledEnd` edit [VERIFIED-ABSENT, and must remain absent].
- Backdated acceptance or exceptional closure with `recordedAt` in the past — the finalization service already overwrites `recordedAt` with the server clock and validates the monotonic chain (`v2/guard/finalize/route.ts:63-69`; `incoming-acceptance-guard-finalization.ts:946-968`).
- Supervisor "closing" a zero-acceptance handover by exceptional closure: it would require fabricating an activation receipt.
- Administrator acceptance on behalf of a technician (§3 standing prohibition).
- Reopening or rewriting the original review decision (case is immutable by design, §6).

### 4.4 Escalation procedure when no safe path exists (C4–C7, C11, C12)
[PROPOSED, built entirely on existing pieces]
1. Read model demotes to `inconsistent_review_required` (already true, 8B.2).
2. Administrator records `mark_further_investigation` → `under_investigation` and a `record_administrative_finding` carrying the reason codes and the evidence digest.
3. `escalate` with an `escalationTarget`; case stays `escalated` (open states remain actionable; only `closed` is terminal, `handover-admin-review-domain.ts:263`).
4. Staffing action happens **outside** the system in the current product: a supervisor schedules a replacement shift and a technician starts it personally (`start-shift.ts:111`, technician-only, comment "no manager branch may be reintroduced here" `:190-194`).
5. The case stays open until OP-3 (or a human-verified correction) is approved; that is the honest status, and the queue already ranks `inconsistent` first (`handover-admin-review-firestore.ts:1327-1345`).

---

## 5. Transaction design for each proposed action

Common rules for all three [PROPOSED, following §1.3]: single `runTransaction`; all authoritative reads before any write; server-supplied clock; live-profile re-verification inside the transaction (as `assertLiveAdminProfile` does, `handover-admin-review-firestore.ts:1348-1369`); `transaction.create` for every audit and decision; content-derived ids; zero writes on refusal; post-commit read-back with a non-committal 503 on `unresolved/unreadable`.

### OP-1 `recordTerminalEvidenceAdjudication` — Category B, append-only
- **Preconditions**: a review projection whose terminal-evidence code is non-null (`handover-admin-review-firestore.ts:892-908`); live administrator; same-origin POST; `HANDOVER_V2_DEV` flag (existing gate, `handover-admin-review-http.ts` route pattern at decisions `route.ts:16-18`).
- **Actor/role**: `admin`, live `status === "active"`, `statusOperation == null`, `mustChangePassword === false`. **Personal authentication**: none required, and none permitted (an admin acts as themselves; there is no cross-uid token to abuse).
- **Reads**: handover aggregate, guard, finalization audit, activation receipt, both application receipts, report, and the existing case document.
- **Writes**: exactly one new document in a new create-only collection `handover_review_adjudications_v1`, id = `handover_review_adjudication_v1_<sha256{handoverDocumentId, evidenceDigest, idempotencyKey}>`, plus one `audit_logs` row `HANDOVER_REVIEW_EVIDENCE_ADJUDICATED_V1`. **No operational document is touched.**
- **Ordering**: read → re-derive classification → refuse if demotion is *not* present → compute `evidenceDigest` → create adjudication → create audit.
- **Concurrency**: `expectedFingerprint` and `expectedCaseRevision` reused verbatim (`handover-admin-review-firestore.ts:1443-1455`); the adjudication id is content-derived so a double submit collapses to one document (`idempotent_replay` pattern from `attendance-evidence-firestore.ts:112-120`).
- **Idempotency key**: client-generated, validated by the existing regex `/^[A-Za-z0-9._:-]{8,128}$/` (`handover-admin-review-domain.ts:176-181`); same key + same content → replay; same key + different content → 409 `REVIEW_IDEMPOTENCY_CONFLICT` (`handover-admin-review-firestore.ts:1429-1433`).
- **Audit events**: actor, actorRole, handoverDocumentId, caseId, classification, reason codes, evidenceDigest, adjudication outcome string, server timestamp.
- **Failure/retry**: any refusal → zero writes; commit acknowledged but unreadable → 503 `ADJUDICATION_OUTCOME_UNKNOWN`, retry with the same key converges.
- **Invariants before/after**: 14 operational collections byte-identical (asserted by the existing `snapshotOperational` harness, `tests/handover-admin-review-emulator.test.mjs:97-112`); case record unchanged (revision untouched — this is deliberately *not* a decision).
- **Refusal conditions**: classification not demoted; audit byte-mismatch with the projection read; case already closed and the caller demands a linked action; actor not a live admin.

Pseudocode:

```
function recordTerminalEvidenceAdjudication({ handoverDocumentId, actorUid, body, nowIso }):
  projection = buildHandoverReviewProjection(handoverDocumentId, nowIso)   // read-only
  if projection.terminalEvidenceCode is null:
    throw ReviewError(409, "ADJUDICATION_NOT_APPLICABLE")                  // nothing to adjudicate
  require body.expectedFingerprint === projection.evidenceFingerprint       // inspected-exactly-this
  require body.reason length in [10, 2000]                                  // existing domain rule
  digest = canonicalDigest({ guard, finalizationAudit, activationReceipt, applications, report })
  return db.runTransaction(async t => {
    profile = await t.get(users[actorUid]);  assertLiveAdminProfile(profile) // :1348-1369
    existing = await t.get(adjudications[adjudicationId(handoverDocumentId, digest, body.idempotencyKey)])
    if existing.exists and existing.requestHash === requestHash(body):
      return { status: "REPLAYED", adjudicationId: existing.id }             // zero writes
    if existing.exists: throw ReviewError(409, "REVIEW_IDEMPOTENCY_CONFLICT")
    auditExists = (await t.get(auditLogs[guardFinalizationAuditId(handoverDocumentId, projection.terminalRef)])).exists
    if auditExists !== projection.finalizationAuditPresent:
      throw ReviewError(409, "ADJUDICATION_EVIDENCE_CHANGED")                // evidence moved mid-flight
    t.create(adjudications[id], { schema, handoverDocumentId, caseId, classification,
                                  reasonCodes: [...], evidenceDigest: digest, actorUid,
                                  recordedAt: nowIso, createdAt: serverTimestamp() })
    t.create(auditLogs[reviewAuditId(id)], { action: "HANDOVER_REVIEW_EVIDENCE_ADJUDICATED_V1", ... })
    // no set/update/delete on any operational reference — enforced by the write set itself
  })
```

### OP-2 `openReassessmentCase` — Category B, append-only, linked case
- **Preconditions**: an existing **closed** case whose live projection is no longer the classification the closing decision asserted (`caseStatus === "closed"` and `projection.classification !== caseRecord.closingClassification`).
- **Actor**: live admin; same-origin; no personal authentication (admin acts as admin).
- **Reads**: original case document, original decision + audit ids (to link, never to modify), fresh projection.
- **Writes**: one new `handover_review_cases_v1` document with `schema: "handover-review-case-v2"` and `reassessesCaseId`, `reassessmentIndex: n`; its id **must include the discriminator** because today's id is derived from `handoverDocumentId` alone (`handover-admin-review-domain.ts:138-142`) and would collide; plus one audit row `HANDOVER_REVIEW_REASSESSMENT_OPENED_V1`.
- **Ordering / concurrency**: the case document is re-read inside the transaction; the *new* case starts at `caseRevision: 0`, so all existing decision machinery (revision + fingerprint fencing, `handover-admin-review-firestore.ts:1442-1455`) applies unchanged. A per-handover `reassessmentIndex` guard (read the highest existing index in-transaction, `+1`) prevents two concurrent reassessments minting the same index — Firestore transaction retry handles the loser (same behaviour as `tests/handover-admin-review-emulator.test.mjs:606-629`).
- **Idempotency**: id keyed on `{handoverDocumentId, reassessesCaseId, closingFingerprint}` → same trigger replays to the same document.
- **Failure/retry**: refusal writes nothing; unresolved commit returns 503 and is retry-safe.
- **Invariants**: original case and its decisions remain byte-identical forever; the "one case per handover" assumption in the readers must be replaced by "latest case per handover" (see compatibility note below).
- **Refusal conditions**: original case not closed; projection no longer contradicts the closing assertion (nothing reassessed); reassessment would reopen the acknowledged decision (never permitted).

**Compatibility cost, stated plainly** [VERIFIED]: `readHandoverReviewCase` looks up one deterministic id (`handover-admin-review-firestore.ts:1215-1234`) and `listHandoverReviewQueue` carries `caseStatus` from that single row (`:1273-1346`). Introducing linked follow-on cases requires both readers to resolve "the current case" among N, and `types/handover-admin-review.ts:162-176` to grow `reassessesCaseId`/`reassessmentIndex`. Existing closed cases keep their exact ids and bytes, so **no historical document changes** — but a fingerprint is per-projection, not per-case, so a reassessment case whose projection differs will legitimately present a different fingerprint than the original one did.

Alternative considered and **not recommended**: a single `handover_review_reassessments_v1` document attached to the closed case (OP-1 shape) with no new case. It is cheaper (no reader changes) but leaves the closed case un-actionable forever, so an administrator can record the contradiction but cannot then investigate it. Recommendation: **ship OP-1 first (pure append, zero reader change), then OP-2 if the owner wants the contradiction to become work.**

### OP-3 `abandonStalledHandoverUnderExpiry` — Category C, operational
One transaction, four phase comments, mirroring `recover-expired-scheduled-shift.ts:156-164,317-325,850-857,915-925`.

- **Preconditions** (§4.2 items 1–3, all re-read inside the transaction): guard `active` + `terminalEvidenceRef === null` + `ownerHandoverDocumentId` binding (`handover-reservation-guard-domain.ts:132-135`); aggregate `awaiting_incoming_acceptance`; zero application documents for both reserved uids (query `incoming_acceptance_applications_v1` by both deterministic ids, `incoming-acceptance-application-domain.ts:252-256`); no activation receipt document; outgoing shift `handover_pending`, `actualStart/actualEnd` null, `handoverStartedAt == null`; `assertShiftOwnsOperationalSlot(control, shiftId, token, status)` (`recover-expired-scheduled-shift.ts:236-247`, `operational-shift-control-state.ts:449-470`); `assertShiftActivationWindowExpired` true (`shift-activation-window.ts:84-117`); tasks complete/cancelled (precedent `:603-613`).
- **Actor authorization**: `role === "admin"`, live, `statusOperation == null`, `mustChangePassword !== true`, re-verified transactionally (`recover-expired-scheduled-shift.ts:207-219`; the same rule review uses at `handover-admin-review-firestore.ts:1348-1369`). Supervisors excluded, with the same rationale recorded in the existing code (`:200-205`). [PROPOSED extension] require a **review case in `under_investigation` or `escalated`** and a matching OP-1 adjudication/evidence digest for that handover, so abandonment cannot be invoked cold — a two-party control implemented inside one service.
- **Personal authentication**: none, and this is deliberate. The action creates no personal evidence; if a service ever needed a technician's credential, it must not be an admin route (standing prohibition, §3).
- **Documents read** (all before any write, `runTransaction`): `users[actorUid]`; `equal_handovers_v2[handover_v2_<outgoingShiftId>]`; `handover_reservation_guards[guard_<outgoingShiftId>]`; `shifts[outgoing]`; `operational_shift_control[global]`; `shift_members`/`shift_attendance`/`tasks` by shiftId; both `incoming_acceptance_applications_v1` ids; `audit_logs[activation receipt id]`; `handover_reports_v2` binding; `technician_schedules[uid]` for each outgoing member; the linked review case (if §4.2 item "requires case" is adopted).
- **Documents written** (exactly this set, nothing else):
  1. `equal_handovers_v2[doc]` — `lifecycleStatus: "cancelled"` via the existing domain transition `closeEqualHandover` (`equal-technician-handover-domain.ts:964-981`), `revision + 1`; identity/times/`reportBinding` untouched.
  2. `handover_reservation_guards[guard_…]` — `transitionGuardForCancellation` (`handover-reservation-guard-domain.ts:383-420`): `ownerLifecycleState: "cancelled"`, `terminalEvidenceRef = cancellationAuditId`, `guardRevision + 1`.
  3. `shifts[outgoing]` — `status: "cancelled"`, `cancelledAt/cancelledBy/updatedAt` only (precedent `:927-942`).
  4. `operational_shift_control[global]` — advance to a fresh pending generation with a **new** slot token (precedent `:900-905` + `advanceExpiredScheduledOperationalShiftControl`, `operational-shift-control-state.ts:402-423`); token is minted before the transaction and reuse is rejected.
  5. `shift_members[<outgoing>_<uid>]` — `leftAt` only, "roster end only, not a clock-out" (precedent `:949-969`). **`shift_attendance` is not written.**
  6. `technician_schedules[uid]` — remove the cancelled entry, `updatedAt` (precedent `:994-1013`).
  7. `audit_logs` — one `create`: action `HANDOVER_STALLED_ABNDED_V1` (proposed name; existing convention is SCREAMING_SNAKE with version suffix), deterministic id `handover_abandonment_v1_<sha256{handoverDocumentId, guardId, cancellationAuditId}>`, `createdAt: serverTimestamp()`, full before/after snapshot digests.
  8. `handover_review_cases_v1` — append a `record_administrative_finding`-shaped entry only if the owner approves coupling; otherwise untouched. Recommendation: **untouched in OP-3**, so the operational and case writes stay separable.
- **Ordering**: profile → aggregate → guard → shift → control → evidence-absence queries → report binding → review case → mint cancellation audit id → **then** writes in the order 3,4,5,6,1,2,7 (shift/control first would break the slot-owner assertion if the transaction were retried mid-way; the precedent's ordering is status → control → roster → authorization → schedule → audit, `:927-1057`, and 8C keeps that shape).
- **Concurrency controls**: guard `expectedGuardRevision`/`expectedFencingEpoch` (`handover-reservation-guard-domain.ts:330-335` equivalent), aggregate `expectedRevision` from the reviewed binding, control token freshness (`:434-438`), and the deterministic audit id as a uniqueness fence. Two concurrent abandonments → exactly one commits; the loser re-reads and gets `HANDOVER_RECOVERY_STALE_OR_APPLIED` (mirrors `tests/expired-scheduled-shift-recovery-emulator.test.mts:1539` "concurrent recovery commits exactly once, advances slot once").
- **Idempotency**: **deliberately once-only**, like the existing recovery (second call 409s: status is no longer `handover_pending`, the guard is `cancelled`, the slot no longer belongs). The client-visible key is the derived cancellation audit id, so a committed-but-unacknowledged attempt can be *detected* (read-back finds the audit + cancelled guard) and reported as `ALREADY_ABANDONED` rather than re-executed.
- **Audit events**: one create-only row (§ writes item 7) with actorUid, handoverDocumentId, guardId + revision before/after, outgoing shiftId + status before/after, previous/next slot token and generation, activation-window expiry proof (`nowIso`, `scheduledEnd`, `latestStart`), reason (10–2000 chars), the evidence-digest set that established "no acceptance exists", and a pointer to the review case.
- **Failure and retry behaviour**: every precondition failure returns `not_committed` with zero writes; commit acknowledged but unreadable → 503 `HANDOVER_ABANDONMENT_OUTCOME_UNKNOWN` with `committed_unresolved`, and the client is told to *verify*, never to assume rollback (precedent: `incoming-acceptance-application-firestore.ts:231-234` "never fabricate a success"). Because writes are create-or-update of documents the transaction already locked, a retry after a resolved commit is detected by the once-only branch, not re-applied.
- **Invariants before**: guard `active`; aggregate `awaiting_incoming_acceptance`; shift `handover_pending` owning a `consumed` slot; no acceptance documents; no attendance for the incoming shift; frozen report bytes unchanged.
- **Invariants after**: guard `cancelled` with `terminalEvidenceRef === cancellationAuditId`; aggregate `cancelled`; shift `cancelled` terminal (`shift-transition.ts:34-38`); control slot `pending` with a fresh token and `generation + 1` and `previousSlotToken` preserved (`operational-shift-control-state.ts:393-399,440-446`); `actualStart/actualEnd` still null; **zero** attendance/evidence documents created; **zero** audit rows updated or deleted; report and receipts byte-identical.
- **Conditions requiring refusal**: any acceptance document exists (even unreadable — unreadable must refuse, mirroring `incoming-acceptance-reconciliation.ts:681-689`); activation receipt exists; guard not `active`; aggregate not `awaiting_incoming_acceptance`; slot owned by another shift; window not proven expired; any `shift_attendance` row for the outgoing pair beyond expected; tasks not closed; report frozen *and* any incoming evidence present; actor not a live admin; missing/!approved review coupling.

Pseudocode:

```
function abandonStalledHandoverUnderExpiry({ outgoingShiftId, actorUid, reason, nowIso }):
  // no caller-supplied clock beyond the server-provided nowIso (never client)
  control = ensureOperationalShiftControl(actorUid)                       // precedent :120-122
  nextSlotToken = randomUUID()                                            // minted BEFORE the txn, :153-154
  cancellationAuditId = handoverAbandonmentAuditId(handoverDocId, guardId, ...)
  return db.runTransaction(async t => {
    // ---- phase 1: authority + identity (all reads, no writes) ----------
    actor   = await t.get(users[actorUid]);      assertLiveAdminProfile(actor)     // :207-219
    shift   = await t.get(shifts[outgoingShiftId]); require shift.status === "handover_pending"
    agg     = await t.get(equalHandovers[handoverDocId]); require agg.lifecycleStatus === "awaiting_incoming_acceptance"
    guard   = await t.get(guards[guardId(outgoingShiftId)])
    assertV2GuardBinding(guard, agg)                                                     // :616-629 shape
    require guard.ownerLifecycleState === "active" and guard.terminalEvidenceRef === null
    require actualStart == null and actualEnd == null and handoverStartedAt == null      // :294-303
    assertShiftOwnsOperationalSlot(control, outgoingShiftId, shift.operationalSlotToken, shift.status)
    assertShiftActivationWindowExpired(nowIso, shift.scheduledStart, shift.scheduledEnd) // window.ts:84-117

    // ---- phase 2: prove NOTHING personal happened -----------------------
    apps  = await Promise.all(agg.identity.incomingTechnicianIds.map(uid =>
              t.get(applications[applicationId(agg.identity.handoverId, uid)])))
    activation = await t.get(auditLogs[activationReceiptId(...)])
    evidence   = await t.get(...att2_slot ids for both uids, both kinds...)
    if apps.any.exists or activation.exists or evidence.any.exists:
      throw RecoveryError(409, "HANDOVER_RECOVERY_NOT_AUTOMATIC")          // mirrors :567-574
    // ---- phase 3: case coupling (proposed) ------------------------------
    reviewCase = await t.get(reviewCases[caseId(handoverDocId)])
    require reviewCase exists and reviewCase.status in {under_investigation, escalated}
    require reviewCase.evidenceDigest == canonicalDigest(guard, agg, shift) // refuses blind action

    // ---- phase 4: writes, exactly the enumerated set, after all reads ---
    t.update(shifts[outgoingShiftId], { status:"cancelled", cancelledAt: nowIso,
                                        cancelledBy: actorUid, updatedAt: nowIso })
    t.update(controlRef, advanceExpiredToPendingGeneration(control, nextSlotToken, nowIso))
    for m in rosters: t.update(m, { leftAt: nowIso })                       // never a clock-out
    t.update(schedules[uid], removeEntry(outgoingShiftId))
    t.update(equalHandovers[handoverDocId], closeEqualHandover(agg, expectedRevision))
    t.update(guards[guardId], transitionGuardForCancellation(guard, {
             expectedGuardRevision, expectedFencingEpoch,
             terminalEvidenceRef: cancellationAuditId, nowIso }))           // :383-420
    t.create(auditLogs[cancellationAuditId], { action: "HANDOVER_STALLED_ABNDED_V1", ...,
             createdAt: FieldValue.serverTimestamp() })
    // NO write to: shift_attendance, attendance_evidence_v2(+operations),
    // handover_reports_v2, incoming_acceptance_applications_v1, activation receipts,
    // any existing audit_logs row, handover_review_decisions_v1.
  })
```

---

## 6. Historical integrity and compatibility policy

### 6.1 Reassessing acknowledged cases without rewriting them
[PROPOSED — OP-1 + OP-2, with OP-1 first]
- **Rule**: a decision, once written, is never modified. `handover_review_decisions_v1` is already create-only (`handover-admin-review-firestore.ts:1517-1520`) and a closed case yields no allowed decisions (`handover-admin-review-domain.ts:263`). Keep both properties permanently.
- **Mechanism**: an append-only **adjudication** row (OP-1) states, as of a server timestamp, that the evidence behind acknowledgement X no longer proves what X asserted, and carries `evidenceDigest` so the bytes at that moment are reconstructible. The original case, its decisions and its audits are untouched — so an auditor can still see exactly what was decided and on what (inspected) fingerprint, and also see that it was later contradicted.
- **If the owner wants follow-up work**, OP-2 opens a linked case that starts at revision 0 and inherits the whole existing decision/audit machinery. Recommended only after OP-1 has been in use, because it changes reader semantics (§5, OP-2 compatibility note).
- **Append-only record vs new linked case** — the brief asks which is appropriate. Answer: **both, in that order, for different purposes.** An append-only adjudication is the historically correct artifact (immutable, content-derived, no concurrency risk). A linked case is the operationally correct artifact *only when a human still has work to do*. Choosing the linked case alone would rewrite "the current case" semantics; choosing the adjudication alone leaves a contradiction with nowhere to route.

### 6.2 Distinguishing legitimate `legacy_guard_only` from suspicious terminal evidence
[VERIFIED facts] The label is produced in exactly one place as a response field (`incoming-acceptance-guard-finalization.ts:558`, `auditExists ? "phase4a_audited" : "legacy_guard_only"`), read by no code as proof, and asserted by no test. The only producer of an unaudited completed guard is `finalizeEqualHandoverReservationV2` (`equal-handover-report-firestore.ts:2149-2155`), which cannot run without (a) aggregate `completed`, (b) a valid activation receipt, (c) guard `active`, and (d) both incoming `shift_attendance` rows (`:2135-2146`, `:2281-2297`), and whose route allows technician/admin/supervisor (`v2/finalize/route.ts:35`).

[PROPOSED] **Evidence-equivalence rule** — never trust the label; require the chain that the legacy route could only have completed *with*:
1. `guard.ownerLifecycleState === "completed"` and `terminalEvidenceRef === activationReceiptId` (already the 8B.2 structural test, `handover-admin-review-firestore.ts:892-908`);
2. the activation receipt exists in `audit_logs` at its content-derived id and passes `assertIncomingAcceptanceActivationReceipt` (recomputed hash + lineage, `incoming-acceptance-application-domain.ts:1281-1292`);
3. exactly **two** application documents exist at their deterministic ids, each with a receipt whose hash recomputes, an application audit, a membership row and an attendance row (`handover-admin-review-firestore.ts:762-764`, count test at `:908-942`);
4. the aggregate is `completed`, its `reportBinding` verifies against a real frozen report (`equal-technician-handover-domain.ts:51-57`; `handover-admin-review-firestore.ts:613-626,928`);
5. **no** guard finalization audit exists at the derivation `createGuardFinalizationAuditId(handoverDocumentId, terminalEvidenceRef)` — because if one exists it must be the verified kind, and a *wrong-shaped* audit is a contradiction, not a legacy gap.
Then classify **[PROPOSED]** `completed_valid_unaudited_legacy` with a reason code `LEGACY_CLOSURE_EVIDENCE_EQUIVALENT`; if any item fails → `inconsistent_review_required` with the specific failing code, which 8B.2 already emits for items 1–4.

Grounding note the brief specifically demands: items 1–4 are **verifiable historical provenance**, not stored labels; the label `legacy_guard_only` is used for display only. Compatibility is therefore a property of the bytes, and a case that only *looks* legacy (label present, chain broken) fails closed.

Two deliberate limitations, stated rather than hidden:
- A legacy closure has **no** `authorizedBy` signature and **no** `recordedAt` from the guard transition; only the receipt/attendance timestamps exist, and their monotonic chain is checkable (`incoming-acceptance-application-domain.ts:1033-1038` and the activation-window assertion) but weaker than an audited closure. So `completed_valid_unaudited_legacy` must keep acknowledge **available but explicitly flagged** (it is a completed, fully evidenced, unsigned closure) or **removed** — that is Open Decision OD-2.
- The legacy route describes itself as a recovery route and gates on server state, not on a claim: "This recovery route closes the guard only once BOTH reserved incoming technicians have personally accepted — derived from authoritative server state, never from a client claim" (`v2/finalize/route.ts:20-27`). So an admin/supervisor pressing it cannot bypass both-personal-acceptances — but the *signature* of who terminalized the guard is nevertheless absent, which is why equivalence proof rests on the attendance/receipt chain rather than on an actor record.
- A tampered legacy chain is indistinguishable from a never-audited one *only if* the attacker could also forge deterministic ids. Since ids are content hashes (§1.1), forging requires recomputing a matching `receiptHash`; a forged document would therefore be a *valid* document. The residual risk is a document that is valid but misplaced (wrong `handoverDocumentId` binding), and 8B.2 already fails closed on that class (`handover-admin-review-firestore.ts:354-424`).

**Fingerprint and concurrency implications** [VERIFIED]: `classification` and `reviewReasonCodes` are fingerprint inputs (`handover-admin-review-firestore.ts:1084-1125`), so **any new classification or reason code changes fingerprints** for the affected cases and invalidates previously served decisions with `REVIEW_DECISION_STALE` (`:1443-1455`). Adding `completed_valid_unaudited_legacy` would therefore silently invalidate open decisions on currently-`completed_valid` legacy cases. Because the brief forbids silently changing persisted cases, this is presented as **OD-2 with two safe rollout shapes**: (i) introduce the reason code only (classification unchanged → reason codes are in the fingerprint, so still a change), or (ii) introduce it *only* for cases whose fingerprint is un-consumed (no decision recorded), leaving acknowledged history untouched. Recommendation: (ii).

---

## 7. Threat model

| Threat | Where it bites today [VERIFIED] | How each proposed action fails closed |
|---|---|---|
| **Replay** of an acceptance POST | Deterministic content-derived ids + re-verification + zero writes (`incoming-acceptance-application-firestore.ts:756,856-961`) | OP-1/OP-2 ids include `{caseId, idempotencyKey, evidenceDigest}` → same intent collapses to one doc (`attendance-evidence-firestore.ts:112-120` pattern). OP-3 is once-only: the second call's preconditions are already false, so it cannot re-advance the slot (precedent `recover-expired-scheduled-shift.ts:190-198`). |
| **Replay with different intent under the same key** | 409 `REVIEW_IDEMPOTENCY_CONFLICT` (`handover-admin-review-firestore.ts:1429-1433`) | Reused verbatim; `requestHash` over content (`handover-admin-review-domain.ts:245-255`). |
| **Stale administrator decision** | `expectedCaseRevision` + `expectedFingerprint` re-checked against a projection rebuilt **inside** the transaction (`:1442-1455`); demotion removes `acknowledge` even if it was just displayed (tests `:829-841`, `:1005-1009`) | OP-1 requires the fingerprint of the exact corrupted view; OP-3 requires the review case's `evidenceDigest` to equal the digest of the documents about to be written, so a stale case cannot authorize an abandonment. |
| **Cross-technician impersonation** | Password reauthentication before the transaction, uid match, nonce+binding+reason-digest scoping, 60 s age (`incoming-acceptance-http-coordinator.ts:217-231`; `incoming-acceptance-application-domain.ts:458-511`); evidence must be `personallyAuthenticated` (`:1108-1110`); subject's own verified uid (`attendance-evidence-domain.ts:709-712`) | No OP accepts a target technician uid at all. OP-3's parameter surface is `{outgoingShiftId, reason}` — there is no uid to abuse. Standing prohibition from the brief is implementable because nothing in the design needs a cross-uid token; and [VERIFIED-ABSENT] impersonation does not exist to be extended. |
| **Forged attendance** | Kinds are fixed to personal-authentication proofs (`attendance-evidence-domain.ts:180-213`); slot ids are deterministic and `transaction.create` fails on collision (`:438-452`); attendance route is GET-only | OP-1/OP-2 write no operational doc; OP-3 refuses if any attendance exists and never writes the collection (roster `leftAt` explicitly "not a clock-out", `recover-expired-scheduled-shift.ts:949-969`). |
| **Conflicting receipts** | Id = content hash, so two different receipts cannot collide; hash/lineage mismatch → `ACTIVATION_RECEIPT_INVALID` / `RECEIPT_BEFORE_ACTIVATION` (`handover-admin-review-firestore.ts:867,919`) | C5 is on the refuse list; OP-3 aborts if an activation receipt exists at all. |
| **Concurrent recovery attempts** | Firestore transaction serializes; loser sees changed bytes (`tests/expired-scheduled-shift-recovery-emulator.test.mts:1539`; guard revision/epoch fences `handover-reservation-guard-domain.ts:330-335`) | OP-3 uses `expectedGuardRevision`/`expectedFencingEpoch` + control-token freshness + deterministic audit id as a uniqueness fence; only one commits, slot advances once. |
| **Privilege escalation** | Session rejects non-`active`, `statusOperation != null`, token/profile role mismatch, `mustChangePassword` redirect (`session.ts:66-84`); transaction re-verifies the live profile (`handover-admin-review-firestore.ts:1348-1369`); `start-shift` is technician-only with a "no manager branch" comment (`start-shift.ts:190-194`) | Every OP re-verifies inside the transaction, never from the cookie alone; OP-3 explicitly excludes supervisors (precedent comment `recover-expired-scheduled-shift.ts:200-205`); no OP grants a role or clears `mustChangePassword`. |
| **Historical evidence tampering** | 8B.2 terminal-evidence gate (`handover-admin-review-firestore.ts:354-460`); audits create-only; reports create-only [VERIFIED-ABSENT update/delete] | OP-1 exists to *record* tampering with a reconstructible digest; no OP ever repairs bytes. |
| **Audit gaps** | Audit rows are create-only with server timestamps; but the legacy finalize route writes **no** finalization audit (`equal-handover-report-firestore.ts:2149-2155`) | §6.2 replaces label-trust with byte-verification so an unaudited closure is only "legacy" when the rest of the chain proves it; otherwise it is `inconsistent_review_required`. OP-1 and OP-3 each write exactly one create-only audit row before returning. |
| **Partial transaction failure** | One transaction, all reads before writes, post-commit read-back with `committed_unresolved/unreadable/inconsistent` 503s (`incoming-acceptance-application-firestore.ts:679,685-687,1650-1704`; `incoming-acceptance-guard-finalization.ts:1091-1146`) | Identical discipline mandated in §5 preamble; "never fabricate a success" carried over verbatim from `:233-234`. |
| **Incorrect legacy compatibility assumption** | `legacy_guard_only` is asserted by no test and trusted by no code (§6.2) | Compatibility rule is *evidence-equivalence*, and rule (ii) in §6.2 restricts the new classification to never-yet-decided cases so no acknowledged history is reinterpreted. |
| **Clock spoofing** | No client clock in any acceptance/finalization body (`handover-v2-atomic-http.ts:130-148`); `recordedAt` overwritten server-side (`v2/guard/finalize/route.ts:63-69`) | OP-3's expiry proof uses only server time (`recover-expired-scheduled-shift.ts:305-315`). |

---

## 8. Administrator interface design

Layout goal: **case management and operational recovery must be visibly different surfaces.** Today the workspace banner says "read-only for operational evidence" (`handover-review-workspace.tsx:372-376,738-743`) and the only distinction from recovery is copy (`:58`, `:756-761`).

1. **Classification and severity** — keep the existing badge set, add the demotion reason codes as text (already rendered as a semantic `<ul>` of code + message, `:696-735`), and add a *state* column: `evidence verified` / `evidence missing` / `evidence contradicted` / `legacy unaudited (chain verified)` derived straight from the 8B.2 `FinalizationEvidence.kind` — no new Firestore read.
2. **Evidence and provenance pane** — per-application booleans already exist (`:632-694`); add the finalization audit's `mode`/`action`/`authorizedBy`/`recordedAt` when present, the activation receipt hash prefix, and a copyable full `evidenceFingerprint` (currently truncated to 12+6 chars, `:494-517`).
3. **Available actions, split by class** — three groups with different visual weight: *Review* (the 5 existing decision types), *Recovery proposal* (OP-1 adjudication; OP-2 reopen), *Operational* (OP-3, rendered only when the server says `abandonEligible === true`, which is a read-model answer, never a client guess).
4. **Required approvals** — OP-1 needs reason ≥10 chars (existing rule, `handover-admin-review-domain.ts:197`) + the inspected fingerprint. OP-3 additionally requires: a case in `under_investigation`/`escalated`, the matching `evidenceDigest`, a typed confirmation of the exact handover id, and a second actor to *view* the case first (soft two-party via the existing `mark_further_investigation` audit trail). No impersonation, ever.
5. **Explicit warnings** — for OP-3: "This cancels the handover instance and releases the operational slot. The two technicians will have no acceptance to make. No historical evidence will be created, changed or deleted." For demoted cases: "The completion asserted by this record cannot be proven from the stored evidence."
6. **Confirmation steps** — [VERIFIED-ABSENT] none exist today (`:843-850`). Add a two-step confirm for every action except `mark_further_investigation`: step 1 shows the fingerprint + reason codes + the exact document ids that will be written; step 2 submits. This is the single most valuable UI change because the whole model is fingerprint-fenced.
7. **Recovery outcome** — a result banner with the returned status (`APPLIED / REPLAYED / ALREADY_ABANDONED / REFUSED`), the audit id created, and an explicit "commit unverified — verify before retrying" state for 503 `*_OUTCOME_UNKNOWN`. Never present an unresolved commit as a rollback (mirrors `handover-v2-atomic-http.ts:282-294`).
8. **Audit history** — decision history already renders (`:859-907`); add adjudication rows and, for closed cases, a "contradicted by later evidence" marker computed from OP-1 presence (no case mutation).
9. **Escalation for unresolved cases** — `escalate` exists and requires `escalationTarget` (`handover-admin-review-domain.ts:212-234`); surface it as the default action for C12 with a link to the operational procedure in §4.4.
10. **Accessibility [PROPOSED, verified gaps]**: `aria-live="polite"` region for refresh/classification changes and decision notices (`:745-754` are plain `<p>`), `role="status"`/`aria-busy` on queue and detail loading (`:407-410`, `:476-479`), `<caption>` + `scope` on the evidence table (`:634-643`), announced "Recording…" state instead of button-text-only change (`:849`), and a non-colour indicator on the badge.

---

## 9. Verification plan

All runs on **fresh disposable emulator projects** with the same hard boundary discipline the review suite uses (`tests/run-handover-admin-review-emulator.ps1` refuses non-free ports, dedicated project ids, no import/export). Protected UAT projects stay untouched.

### 9.1 Exercisable through the real application (no fixtures)
1. Normal completion → `completed_valid`, acknowledge allowed, 14 collections byte-identical (existing test 1, `tests/handover-admin-review-emulator.test.mjs:334`).
2. Both technicians accept, then partner no-shows → supervisor exceptional closure → `completed_exceptional`, no acknowledge (existing tests 9/11).
3. Lost-response replay: re-POST identical acceptance → `REPLAYED`, zero writes (existing test 5; `incoming-acceptance-application-firestore.ts:856-961`).
4. Stale-fingerprint and concurrent decision refusals (existing tests 6/7).
5. Authority matrix: technician 403 → `/technician`, supervisor 403 → `/unauthorized`, blocked/`mustChangePassword` admin 403 (existing test 3; verified live in 8B/8B.2 browser passes).
6. Expired scheduled shift recovery through its API + slot release + second call 409 (existing `tests/expired-scheduled-shift-recovery-emulator.test.mts:1024`, `:1324`, `:1539`, `:1681`).
7. Exceptional closure refusal when the subject has evidence (`incoming-acceptance-guard-finalization.ts:973-1003`).

### 9.2 Requires synthetic fixtures (direct admin-SDK writes from a disposable stack only)
8. Corrupt/absent terminal evidence matrix — 10 cases already built and green (`.demo/p8b2-probe-exceptional.json`), plus 6 for normal closures (`.demo/p8b2-probe-valid.json`).
9. Audit forged at a *valid* deterministic id (hash-correct but foreign `handoverDocumentId`) → `TERMINAL_EVIDENCE_CONTRADICTION`.
10. Legacy unaudited closure **with** the full equivalent chain → new `completed_valid_unaudited_legacy`; **without** one link (drop an attendance row) → `inconsistent_review_required`. Proves §6.2 rules out label-trust.
11. Cross-handover activation receipt at the same id shape → refused.
12. OP-1 replay/idempotency and "no operational bytes changed" (reuse `snapshotOperational`).
13. OP-2 linked case: two concurrent reassessments → exactly one index wins; original case bytes unchanged; original decision still readable and unmodified.
14. OP-3 stall scenario: seeded to `awaiting_incoming_acceptance`, guard `active`, window force-expired, zero acceptances → abandon → guard `cancelled` + `terminalEvidenceRef === cancellationAuditId`, aggregate `cancelled`, shift `cancelled`, control `pending` with new token and `generation+1`, **zero** attendance/evidence created, review case untouched; then a fresh reservation is creatable and a technician can start the new shift personally.
15. OP-3 refusal battery: one acceptance present / activation receipt present / window not expired / slot owned elsewhere / guard already `completed` / supervisor actor / case not in `under_investigation` / digest mismatch → each returns the named code and `snapshotOperational()` is byte-identical.
16. OP-3 concurrency: two administrators race → one commits, slot advances once, loser re-reads to `ALREADY_ABANDONED`/stale.
17. Fingerprint-change audit: assert that a new classification changes the fingerprint only for never-decided cases (rollout rule (ii)); assert a decided case's served fingerprint is unchanged.
18. Browser: badge changes on Refresh are announced (accessibility assertions via role/aria snapshot), confirmation step required, OP-3 hidden when `abandonEligible === false`.
19. Interruption: kill the app between `t.create(audit)` and commit is impossible (same transaction), so test the *acknowledgement* failure instead — force an unreadable read-back and assert a 503 `*_OUTCOME_UNKNOWN` plus a verify-don't-retry message, then confirm a retry detects the committed state.
20. Full regression matrix parity with 8B.2 (1495 + 57 network-free, 41 allowlist drift, 6/9/27 atomic suites, 11/29/41/18 scratch suites, `tsc`, ESLint, `git diff --check`).

---

## 10. Milestones, risks, open decisions and recommendation

### 10.1 Proposed implementation milestones (each separately approvable)
- **8C.1 — Reassessment and adjudication (Category B only).** OP-1 + §8 items 1/2/6/10 (confirmation step + a11y). No operational write anywhere. Lowest risk, immediately useful: it turns 8B.2's demotions into a documented, reconstructible record. Regression surface: review suites + fingerprint tests only.
- **8C.2 — Legacy provenance policy.** §6.2 evidence-equivalence rule, `completed_valid_unaudited_legacy` under rollout rule (ii), plus fixtures 10–11. Touches the read model; fingerprint impact is the risk, so rule (ii) and a dedicated test gate it.
- **8C.3 — Linked reassessment cases (OP-2).** Reader semantics change (§5 compatibility note); ship only if 8C.1 shows contradictions that need follow-up work rather than just a record.
- **8C.4 — Reconciliation clock exposure (A.1).** Small, high-value: lets the queue distinguish "still open" from "closed forever" without any write.
- **8C.5 — OP-3 stalled-handover abandonment (Category C).** Last, only after OD-1/OD-3 are answered by the owner, and only with the case-coupling requirement enabled (no cold abandonment).
- **Explicitly out of scope for 8C**: expired-window *completion*, window extension, receipt/attendance generation, audit repair, guard reopening, notification changes, protected-UAT deployment.

### 10.2 Risks
1. **Slot coupling.** OP-3 mutates `operational_shift_control/global`, the single document that gates all shift creation (`create-shift.ts:522-530`). A wrong advance blocks the whole organization, not one shift. Mitigation: reuse `advanceExpiredScheduledOperationalShiftControl` unchanged, and test token/generation lineage exactly as `tests/expired-scheduled-shift-recovery-emulator.test.mts:1539` does.
2. **Fingerprint invalidation.** Any new classification or reason code rejects previously served decisions (`handover-admin-review-firestore.ts:1443-1455`). Mitigation: rollout rule (ii); never change reason *messages* in a way that alters codes.
3. **Reader semantics drift.** OP-2 breaks the one-case-per-handover assumption in `readHandoverReviewCase`/`listHandoverReviewQueue` (`:1215-1234`, `:1273-1346`). Mitigation: ship OP-1 first; make OP-2 a separate milestone with queue tests.
4. **False equivalence.** Accepting a legacy chain as equivalent could bless a case whose guard was terminalized by a *supervisor or admin* through `v2/finalize/route.ts:35` — that route records no closing actor and writes no finalization audit. It does enforce "both reserved incoming technicians have personally accepted", derived from server state (`route.ts:20-27`, `equal-handover-report-firestore.ts:2281-2297`), so it cannot bless a half-accepted handover; but "legacy" therefore means *"both attendances existed and nobody signed the closure"*, not *"technicians closed it themselves"*. This asymmetry is the substance of OD-2.
5. **Unreadable ≠ absent.** A refused recovery must treat an unreadable document as blocking, the way reconciliation refuses to answer "not applied" on an unreadable store (`incoming-acceptance-reconciliation.ts:681-689`).
6. **Sticky UI trust.** A confirmation dialog that shows a *stale* fingerprint is worse than none; the confirm step must render the value the server will re-check in-transaction.

### 10.3 Open product decisions (numbered, for the owner)
1. **OD-1 — Should an abandoned handover's outgoing technician be released at all?** OP-3 as specified sets roster `leftAt` but no clock-out (mirroring the existing precedent, `recover-expired-scheduled-shift.ts:949-969`). Is "roster end without attendance" the correct payroll/coverage semantics, or must the outgoing technician's attendance stay open for manual closure later? Product answer required before 8C.5.
2. **OD-2 — Is an unaudited legacy closure acknowledgeable?** `completed_valid_unaudited_legacy` proves the *act* by equivalent evidence but has no supervisor signature and no finalization audit, and the legacy route allowed admin/supervisor to complete it (`v2/finalize/route.ts:35`). Options: (a) acknowledge allowed with a warning, (b) acknowledge removed, investigation only. Recommendation: (b) until the legacy route is retired, since (a) grants a permission the audited path earns with a signature.
3. **OD-3 — Who may authorize a stalled-handover abandonment: administrator alone, or administrator + supervisor?** The existing precedent is admin-only, supervisors explicitly excluded (`:200-205`); 8C's case coupling implies a second human. Decide before 8C.5.
4. **OD-4 — Does the retired legacy route (`v2/finalize`, `v2/accept`) get closed once the atomic gate is on?** Leaving it reachable is what keeps producing unaudited closures. Retiring it is a code change outside this design's authority.
5. **OD-5 — Is there any future in which a *zero-acceptance* expired handover should still complete?** If yes, it needs a genuinely new protocol (a re-authorization ceremony), not a repair; if no, §4.2 + escalation is the final answer.
6. **OD-6 — Do contradictions found after closure need routing?** OP-2 gives a follow-on case; if the owner prefers a report/queue flag only, 8C.3 is cancelled and 8C.1 suffices.

### 10.4 Recommendation — what is safe to implement first
1. **First: 8C.1 (OP-1 adjudication + confirmation step + a11y).** Pure append, zero operational writes, reuses the review subsystem's existing idempotency/fingerprint/authority machinery, and every invariant it must preserve is already test-enforced (`tests/handover-admin-review-emulator.test.mjs:97-112`).
2. **Second: 8C.4 (A.1 reconciliation clock exposure)** — small, read-only, closes the "we cannot tell whether a window ever closed" gap.
3. **Third: 8C.2 (legacy provenance)** under rollout rule (ii), with fixtures 10–11 as the acceptance gate.
4. **Then, and only with OD-1/OD-3 answered: 8C.5 (OP-3).** Nothing else in Category C should be built: no expired-window completion, no receipt/attendance minting, no audit repair.
5. **Never**: reopening a completed guard, rewriting `terminalEvidenceRef`, backdating any timestamp, or any admin action that presents itself as a technician's personal authentication. [VERIFIED] None of these exists today; the invariants that prevent them ("Completed guards never transition" `handover-reservation-guard-domain.ts:529-530`, create-only audits and reports, technician-only `start-shift`, personal-authentication-only evidence kinds) are the ones to keep.

---

*End of Phase 8C design. No implementation performed. Awaiting explicit approval before any of 8C.1–8C.5 is built.*
