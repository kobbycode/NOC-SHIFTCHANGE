# SHIFTCHANGE 2.0 — Phase 8C.1: Recovery Contract, Authority and Transaction Safety Proof

**Status: DESIGN AND VERIFICATION ONLY. Nothing in this file is implemented. No operational write, migration,
recovery action, commit, push or protected-environment change was performed.**

This document converts `docs/PHASE-8C-OPERATIONAL-RECOVERY-DESIGN.md` (Phase 8C, hash
`d6560e2c6534a21c52f13ba6c69dddd4a01f1874973e859f1ebf23a8a3b64f90`) into a reviewable implementation
contract: exact preconditions, exact document read/write sets, the fences that make the recovery safe, the
approval workflow, and the decisions that still require explicit owner authorization.

## 0. How to read this contract

Every claim carries one of these labels.

| Label | Meaning |
| --- | --- |
| **[VERIFIED-EXISTING]** | Read directly from the current working tree this session, with file and line. The behaviour exists today. |
| **[PROPOSED-NEW]** | Does not exist. Requires approval before implementation. This contract defines its exact shape so it can be reviewed. |
| **[ASSUMPTION]** | Safety currently rests on something the repository does not prove. Carried into §9 as a test the implementation milestone must pass before the action is enabled. |

Rule from the brief, kept verbatim throughout: **"A mere zero count in one collection is not sufficient proof
that acceptance did not occur."** §3.4 is the direct answer to that rule. Also verbatim in force:
**"No operational evidence may be fabricated, backdated or rewritten."**

Reference numbers used later: fences `F-1…F-5`, hazards `H-1…H-6`, assumptions `A-1…A-3`,
unresolved decisions `OD-1…OD-9`, requirements `D1…D6`, scenarios `S1…S9`.

---

## 1. Repository preservation at contract time

| Item | Value |
| --- | --- |
| Repository | `NOC-SHIFTCHANGE` (the outer `KobbyProject` directory is not a git repository) |
| Branch | `feature/handover-v2-recovery` (corrected 2026-11-01 during Phase 8C.2a baseline work: this row previously read `main`, which was wrong — the repository's only other branch is `master`, no branch switch ever occurred, `git reflog` shows a single `checkout: moving from master to feature/handover-v2-recovery` immediately after the clone) |
| HEAD | `c1703530437ff4e45010dde4f920597fe7684d9f` |
| Stashes | 0 |
| Tracked+untracked tree entries at 8C.1 start | 148 |
| Protected-file hashes at 8C.1 start | 19/19 identical to the Phase 8B baseline (`11` re-hashed individually + the 19-entry protected list) |
| Phase 8C design document | `docs/PHASE-8C-OPERATIONAL-RECOVERY-DESIGN.md`, `d6560e2c…3b64f90`, unchanged |
| Evidence file | `.demo/p8c-baseline.txt` (8C start section + 8C end section, appended, never rewritten) |

Working-tree dirty state was **not** modified by this phase other than the creation of this document.
No source file, rule, test, seed, environment file or protected-UAT artifact was edited. Re-verification is
recorded in §10.

---

## 2. Six proposed product decisions, restated as requirements

Each is a **requirement proposed to the owner**, not a description of current behaviour. The "current code"
column is the honest answer to *is this already true?*

### D1 — An administrative coverage end is not a personal clock-out

**Requirement [PROPOSED-NEW, with existing precedent]:** when an administrator ends a coverage window, the
roster record may be closed (`shift_members.leftAt`), but no `shift_attendance` row, no
`attendance_evidence_v2` row and no acceptance receipt may be created or modified, and the audit row must
state that the write is administrative.

*Current code:* the precedent exists and is even commented that way in the only operational recovery that
ships today — [src/lib/operations/recover-expired-scheduled-shift.ts:949-954](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/recover-expired-scheduled-shift.ts#L949)
writes `leftAt` with an explicit "not a clock-out" note and refuses outright when attendance is present
([:567-574](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/recover-expired-scheduled-shift.ts#L567)).
Nothing enforces the rule generically; it is per-operation.
*Contract:* the rule becomes a shared invariant `INV-NO-PERSONAL-EVIDENCE-WRITE` (§6.6), asserted by a test
that byte-compares `shift_attendance`, `attendance_evidence_v2`,
`attendance_evidence_operations_v2`, `incoming_acceptance_applications_v1` and every pre-existing `audit_logs`
row before and after the recovery (harness pattern already used in `.demo/p8b-snapshots/`).

### D2 — An unaudited legacy closure stays investigation-only unless independently verified

**Requirement [PARTIALLY SUPPORTED]:** a `completed` handover whose terminal evidence cannot be independently
re-derived must never be treated as proven, and must never be a source of operational action.

*Current code:* the 8B.2 integrity precedence rule already does the read-model half. A completed guard is
verified only when the document named by `guard.terminalEvidenceRef` is present, of the expected kind and
internally provable; otherwise one of four codes
(`TERMINAL_REFERENCE_MISSING`, `EXCEPTIONAL_CLOSURE_EVIDENCE_MISSING`,
`EXCEPTIONAL_CLOSURE_EVIDENCE_INVALID`, `TERMINAL_EVIDENCE_CONTRADICTION`) demotes the projection, and the
authoritative badge classifies from guard + application structure, never from a stored label
([src/lib/operations/handover-admin-review-firestore.ts:740-767](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-firestore.ts#L740)).
*Gap:* a normal closure with no closure audit still projects `completed_valid` with `legacy_guard_only`
provenance. Under D2 as written by the owner, "unaudited" is not the same as "contradicted", so the current
behaviour is only compliant if the owner accepts that **structurally-provable** closure counts as
"independently verified". That reading is recommended and is the reason no code change is proposed here —
but it is D2's interpretation, therefore `OD-1` §8.8.

### D3 — Abandoning a stalled handover requires separate administrator **and** supervisor approval

**Requirement [PROPOSED-NEW — not supported at all today]:** a Category-C recovery may execute only against an
approval record bearing two distinct, independently authenticated, separately attributable approvals.

*Current code, verified absent:* no two-party, co-sign, countersign or dual-approval pattern exists anywhere
under `src` (searched for `coSign`, `dualApproval`, `secondApprover`, `approvers`, `countersign`). Every
existing authority is single-actor: admin review decisions require a live admin profile
([handover-admin-review-firestore.ts:1348-1369](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-firestore.ts#L1348));
the only operational recovery today is deliberately **admin-only, supervisors excluded**
([recover-expired-scheduled-shift.ts:200-219](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/recover-expired-scheduled-shift.ts#L200)).
Also relevant: the *reserved* recovery metadata in the receipt schema has a **single** approver
(`legacyRecoveryFields = { approvalId, approvedBy, approvedAt, expiresAt, … }`,
[incoming-acceptance-application-domain.ts:581-591](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-domain.ts#L581))
— so D3 cannot be satisfied by reusing that shape; it needs the separate approval record designed in §5.
Conflict recorded as `OD-2`.

### D4 — Legacy mutation routes are unavailable while atomic mode is enabled

**Requirement [PARTIALLY SUPPORTED — one real gap]:** when the atomic acceptance gate is on, no non-atomic
writer may mutate handover, shift, roster or guard state.

*Supported:* the legacy split acceptance writer refuses with 409
`ACCEPTANCE_ATOMIC_PROTOCOL_ENABLED` and the comment that "an acceptance must never silently fall back to the
old evidence-then-transaction path once the atomic gate is on"
([src/app/(dashboard)/api/operations/shifts/\[shiftId\]/handover/v2/accept/route.ts:62-68](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/accept/route.ts#L62)).
The reserved legacy-recovery receipt origin is hard-disabled at construction time
(`INCOMING_ACCEPTANCE_LEGACY_RECOVERY_WRITES_ENABLED = false`,
[incoming-acceptance-application-domain.ts:49](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-domain.ts#L49),
enforced at [:922-929](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-domain.ts#L922)
and called from the receipt factory at [:844-850](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-domain.ts#L844)) —
a recovery receipt cannot even be built, let alone written.
*Gap:* `handover/v2/finalize` is gated only by `handoverV2Enabled()`
([finalize/route.ts:29](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/finalize/route.ts#L29))
with roles `["technician","admin","supervisor"]` (`:35`) and **no atomic-mode check**. It is a self-described
recovery route that closes a guard, requires both incoming attendances to be resolved
(`isEqualHandoverIncomingAttendanceResolved`,
[equal-handover-report-firestore.ts:2281-2297](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-handover-report-firestore.ts#L2281)),
and records no closing actor. Because it requires the technicians' own attendance rows it cannot fabricate
acceptance, but it *is* an ungated mutation path while atomic mode is on. Requirement: gate it, or accept it
as an exception. **Do not gate it silently** — the exceptional-closure flow delivered in 8B.1 depends on this
route's output. `OD-3`.

### D5 — An expired zero-acceptance handover cannot be completed retroactively

**Requirement [SUPPORTED by construction, and this contract preserves it]:** no recovery may produce a
`completed` aggregate or an activation receipt after the window closed.

*Current code:* activation requires `assertFirstActivationWindow` against
`min(scheduledStart + 60, scheduledEnd)`
([incoming-acceptance-application-firestore.ts:1211-1222](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-firestore.ts#L1211),
window constants [shift-activation-window.ts:25-28](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/shift-activation-window.ts#L25)),
and the only two writers that can set `lifecycleStatus: "completed"`
([equal-technician-handover-domain.ts:883](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-technician-handover-domain.ts#L883),
[:959](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-technician-handover-domain.ts#L959))
are reached only from `activateEqualHandoverIncomingTransfer`
([:927](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-technician-handover-domain.ts#L927)),
whose two callers are the atomic transaction and the gated legacy writer. *Contract:* the abandonment action
defined in §6 writes `cancelled`, never `completed`, and its precondition set is unsatisfiable once any
activation artifact exists (§3.4, fence `F-4`).

### D6 — A historical contradiction is handled by a linked reassessment case, never by rewriting the original decision

**Requirement [PROPOSED-NEW]:** originals are immutable; reassessment is append-only and linked.

*Current code:* the substrate exists. Case, decision and audit ids are content-derived
(`createHandoverReviewCaseId(handoverDocumentId)`, `createHandoverReviewDecisionId(caseId, idempotencyKey)`,
`createHandoverReviewAuditId(decisionId)` —
[handover-admin-review-domain.ts:138-155](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-domain.ts#L138)),
decisions are append-only rows in `handover_review_decisions_v1`, audits are `transaction.create`-only
([handover-admin-review-firestore.ts:1389-1396](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-firestore.ts#L1389)),
and a stale view is rejected rather than overwritten (`REVIEW_DECISION_STALE`, `:1442-1455`).
*Structural obstacle, and it is the reason §7 exists:* the case id is derived from the handover document id
alone, so **there can only ever be one case per handover**
([handover-admin-review-domain.ts:138-142](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-domain.ts#L138)).
A "linked reassessment case" therefore cannot live in `handover_review_cases_v1` under the same key. §7
resolves this without migration.

---

## 3. Safety proof: abandoning a stalled, zero-acceptance handover

The action under proof is the single Category-C proposal of Phase 8C (`OP-3` in that document): release the
global operational slot held by a committed handover that no incoming technician ever accepted, after its
activation window has elapsed. This section proves it is safe, i.e. that it can only ever execute in a state
where **no acceptance occurred and no acceptance can still occur**, and that it fabricates nothing.

### 3.1 Why the state needs any action at all (verified stall)

A committed v2 handover in `awaiting_incoming_acceptance` with zero acceptances leaves, all simultaneously and
permanently: the guard permanently `active`; the aggregate permanently `awaiting_incoming_acceptance`; the
outgoing shift permanently `handover_pending`; the single global slot `consumed` by that shift; and `createShift`
blocked with "The current global shift slot is already occupied. Complete the current shift before creating
another." ([create-shift.ts:522-530](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/create-shift.ts#L522);
`OCCUPYING_SHIFT_STATUSES` includes `handover_pending`,
[operational-shift-control-state.ts:26-30](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/operational-shift-control-state.ts#L26)).
The existing scheduled-shift recovery cannot touch it (its advancer requires `shiftStatus === "scheduled"`,
[:402-447](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/operational-shift-control-state.ts#L402))
and exceptional guard closure cannot touch it (it requires a `completed` aggregate). Verified in 8C; restated
here because the safety argument is only meaningful against the real deadlock.

### 3.2 Preconditions (each maps to a read and to a refusal)

| # | Precondition | Authoritative read | Refusal if unmet |
| --- | --- | --- | --- |
| P1 | Aggregate exists, `lifecycleStatus === "awaiting_incoming_acceptance"` | `equal_handovers_v2/handover_v2_<outgoingShiftId>` (`createEqualHandoverDocumentId`, [equal-technician-handover-domain.ts:215-222](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-technician-handover-domain.ts#L215)) | `RECOVERY_NOT_APPLICABLE` |
| P2 | Activation window closed **by server clock**, not by caller assertion | `identity.scheduledStart/End`, re-derived `latestActivation = min(start + SHIFT_ACTIVATION_WINDOW.LATE_MINUTES, end)` — the identical bound `assertFirstActivationWindow` enforces on the live path | `RECOVERY_WINDOW_OPEN` |
| P3 | No successful acceptance, and no pending-uncertain acceptance | the read set of §3.4, all inside the transaction | `RECOVERY_ACCEPTANCE_EXISTS` |
| P4 | No incoming activation artifact of any kind | `audit_logs/handover-activation-v2-<digest>` + `shifts/<incomingShiftId>` + `shift_members`/`shift_attendance` for both incoming uids | `RECOVERY_ACCEPTANCE_EXISTS` |
| P5 | Guard identity consistent: `protocolOwner === "v2"`, `ownerLifecycleState === "active"`, `terminalEvidenceRef === null`, reservation/incoming/slot binding equals the aggregate | `handover_reservation_guards/guard_<outgoingShiftId>` (`createHandoverReservationGuardDocumentId`, [handover-reservation-guard-domain.ts:93-100](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-reservation-guard-domain.ts#L93)) + legacy `handovers/<legacyDocId>` cross-read (both are read together by `readReservationGuardState`, [handover-reservation-guard.ts:40-62](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-reservation-guard.ts#L40)) | `RECOVERY_STATE_INCONSISTENT` |
| P6 | Global slot still belongs to the expected outgoing shift **and generation**: `slotStatus === "consumed"`, `shiftId === outgoingShiftId`, `shiftStatus === "handover_pending"`, `slotToken === identity.outgoingSlotToken`, `generation === identity.outgoingGeneration` | `operational_shift_control/global` (`GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID = "global"`, [collections.ts:74-76](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/collections.ts#L74)); the token/generation equality pair is exactly what the live acceptance path enforces ([incoming-acceptance-application-firestore.ts:1113-1132](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-firestore.ts#L1113)) | `RECOVERY_STALE_OR_APPLIED` |
| P7 | Outgoing shift is in precisely the state an acceptance would have required: `status === "handover_pending"`, `actualStart` a valid timestamp, `actualEnd === null`, `handoverStartedAt` a valid timestamp `>= actualStart`, `permanentPairId` and `primaryTechnicianIds` match the reserved identity | `shifts/<outgoingShiftId>`; the assertion list is copied from the acceptance path at [:1100-1111](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-firestore.ts#L1100) | `RECOVERY_STATE_INCONSISTENT` |
| P8 | Two current, unconsumed, binding-matching approvals (§5) | `handover_recovery_approvals_v1/<approvalId>` | `RECOVERY_APPROVAL_INVALID` / `RECOVERY_APPROVAL_STALE` |

**Correction to the Phase 8C design, recorded here because the proof found it.** Design §OP-3 stated
`actualStart` must be null and cited `advanceExpiredScheduledOperationalShiftControl`. Both are wrong for this
state: the outgoing shift was started, so `actualStart` is necessarily set (the acceptance path asserts it,
`P7`), and the expired-`scheduled` advancer structurally refuses a `handover_pending` slot. The correct
reusable function is `advanceOperationalShiftControl`, whose precondition is *exactly*
`consumed + handover_pending + shiftId === completedShiftId`
([:356-400](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/operational-shift-control-state.ts#L356))
— i.e. the normal completion-path advancer, already used by `complete-shift.ts:913`. `§6` uses the corrected
form.

### 3.3 Why the preconditions cannot be satisfied by a stale view

Every precondition is re-read **inside** the transaction, after the approval has already been granted outside
it. This is the existing discipline: all authoritative reads complete before the first write
([incoming-acceptance-application-firestore.ts:685-692](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-firestore.ts#L685)),
and the reviewed binding is re-checked against the fresh read (`REVIEW_BINDING_CHANGED`, `:988-994`). Approval
therefore never carries authority over state; it only carries authority over *intent*. If the state moved, the
binding comparison fails and the approval is void (`S3`).

### 3.4 The negative proof — "acceptance did not occur" as a document-level claim

The brief's constraint rules out a query-count argument. Instead the proof anchors on **one deterministic
document that only a committed first activation can create**, then corroborates across eight independent
document classes. A count of zero in any single collection is never used as the answer.

**Anchor `F-4`:** `audit_logs/handover-activation-v2-<sha256 canonical {namespace:
"equal-handover-activation-v2", handoverDocumentId}>`
(`createIncomingAcceptanceActivationReceiptId`,
[incoming-acceptance-application-domain.ts:1214-1220](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-domain.ts#L1214)).
Its id is content-derived from the handover document id only, and it is written with `transaction.create`
inside the activation transaction
([incoming-acceptance-application-firestore.ts:1449-1452](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-firestore.ts#L1449)).
Two properties make it a proof rather than a hint:

1. **Completeness.** The only functions that can set a v2 aggregate to `completed` are reached from
   `activateEqualHandoverIncomingTransfer`, and both call sites
   (`incoming-acceptance-application-firestore.ts:1224` and the gated legacy
   `acceptEqualHandoverIncomingV2`, `equal-handover-report-firestore.ts:1804,2010`) create this same receipt
   id. The legacy writer derives it identically
   (`equalHandoverActivationReceiptId`, `:1764-1768`) — same prefix, same canonical material, same sorted-key
   canonicalisation in both files ([incoming-acceptance-application-domain.ts:110-127](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-domain.ts#L110)
   vs [equal-handover-report-firestore.ts:129-139](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-handover-report-firestore.ts#L129)),
   so both paths target the identical document. `create` cannot be overwritten by a later writer.
   Therefore *activation committed ⟹ this document exists*. Contrapositive: absent ⟹ never activated.
   [ASSUMPTION `A-2`: the id equality across the two derivations must be asserted in a unit test before this
   anchor is trusted; the reasoning is by-construction, not executed.]
2. **Non-fabricability.** No administrator or supervisor route writes to this id; the only writers are the two
   acceptance transactions, both of which require the technician's own password-authenticated proof at
   `:1023-1031`.

**Corroboration set** (all read in the same transaction; disagreement between the anchor and any of these is a
hard refusal, not a warning):

| Read | Expected in the stalled state | If it disagrees |
| --- | --- | --- |
| `incoming_acceptance_applications_v1/acceptance_app_v1_<businessKeyHash>` per incoming uid (id is `(handoverId, technicianUid)`, kind-independent — `:252-269`) | absent | anchor is suspect → `RECOVERY_STATE_INCONSISTENT` |
| `audit_logs/acceptance_application_v1_<businessKeyHash>` per incoming uid | absent | an audit without its receipt is already a defined inconsistency on the live path (`:972-977`) → refuse, require review |
| `attendance_evidence_v2` + `attendance_evidence_operations_v2` for both uids × both kinds (`incoming_clock_in`, `incoming_late_acceptance`) — 4 + 4 docs | may legitimately exist (**evidence is not acceptance**) | if any is `finalized` while the anchor is absent, this is the reconciliation `EVIDENCE_ONLY` case ([incoming-acceptance-reconciliation.ts:55-64](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-reconciliation.ts#L55)) → refuse; never convert it into an acceptance (`OD-4`) |
| `shifts/<incomingShiftId>` | absent (created only by first activation, `:1395`) | contradiction → refuse |
| `shift_members/<incomingShiftId>_<uid>`, `shift_attendance/<incomingShiftId>_<uid>` × 2 each | absent | contradiction → refuse |
| `audit_logs/handover-commit-v2-<sha256 …>` (`equalHandoverCommitReceiptId`, [equal-handover-report-firestore.ts:1538-1542](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-handover-report-firestore.ts#L1538)) | **present and valid** — the positive half of the proof: the outgoing pair really did commit | missing/invalid → the handover is not in the stalled state at all → refuse |
| `handover_reports_v2/<reportBinding.id>` | present, bytes unchanged | frozen-report integrity is out of scope for the action; the contract only forbids writing it |
| `handovers/<legacyDocId>` (`createHandoverDocumentId`) | absent, or not `collecting_confirmations` | a guardless legacy reservation for the same outgoing shift means the identity model is ambiguous → refuse (`readReservationGuardState` already reads both, `handover-reservation-guard.ts:47-53`) |

This is the answer to the constraint: the argument is **not** "collection X returned zero rows". It is "the one
document that the activation transaction necessarily creates does not exist, the commit receipt that
necessarily precedes it does exist and validates, and every personal-artifact document the same transaction
would have written is consistent with that conclusion; any disagreement aborts the action."

### 3.5 Hazards found while proving (must be closed by the contract, not by the current code)

| # | Hazard | Evidence | Contract response |
| --- | --- | --- | --- |
| H-1 | `transitionGuardForCancellation` does **not** increment `fencingEpoch` | [handover-reservation-guard-domain.ts:383-420](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-reservation-guard-domain.ts#L383) | A replayed cancellation cannot be stopped by epoch CAS. Fence on `expectedGuardRevision` (which *is* incremented) **and** on `ownerLifecycleState === "active"` **and** on the create-once audit id. Never on epoch alone. |
| H-2 | `closeEqualHandover` returns only `lifecycleStatus` + `updatedAt`; it does **not** bump `revision` | [:964-981](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-technician-handover-domain.ts#L964) | `revision` CAS alone cannot distinguish pre/post. Use the triple (`lifecycleStatus`, `revision`, `updatedAt`) read in-transaction. |
| H-3 | `createEqualHandoverSnapshot` hashes `{schema, identity, reservation, reportBinding, absences, revision}` — `lifecycleStatus` is **not** in the hash | [:299-315](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-technician-handover-domain.ts#L299) | `snapshotHash` CAS cannot fence a lifecycle change. The approval binding must carry `lifecycleStatus` explicitly (it is otherwise invisible to every existing fingerprint). **This is the single most important finding of §3.** |
| H-4 | `closeEqualHandover` refuses `awaiting_incoming_acceptance` (mutation gate requires `collecting_confirmations`) | [:601-617](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/equal-technician-handover-domain.ts#L601) | The design's "reuse `closeEqualHandover`" step is not executable. Requires a new domain transition `abandonEqualHandover` [PROPOSED-NEW] with its own gate, so the existing mutation rule is not weakened. |
| H-5 | The cancelled guard is reacquirable by v2 | `resolveOrAcquireReservationGuard` archives a `cancelled` guard to `handover_reservation_guard_history` and mints a successor at the next epoch ([handover-reservation-guard.ts:84-115](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-reservation-guard.ts#L84)) | This is why abandonment actually unblocks operations. Contract requires the archive `create` to fail closed if history already exists (existing behaviour, `:99-104`) and records that the abandoned handover can never be resumed — only superseded. |
| H-6 | `handover/v2/finalize` mutates while the atomic gate is on | D4 | Kept out of scope; `OD-3`. Abandonment must refuse if the guard is already terminal for any reason, which is covered by P5. |

### 3.6 Safety statement

Given P1–P8 re-evaluated inside one `runTransaction`, with the §3.4 read set and the fences of §6.4, the
abandonment action:

* cannot run if any acceptance succeeded or is pending-uncertain (`F-3`, `F-4`);
* cannot run while a legitimate acceptance is still possible (`F-2`, server clock only);
* cannot run twice, or concurrently with a competing recovery, or concurrently with an acceptance (`F-1`,
  `F-5`, plus `transaction.create` uniqueness);
* fabricates nothing: it creates no personal evidence, no receipt, no attendance row, no `completed` state, and
  no new audit row is ever edited (`INV-NO-PERSONAL-EVIDENCE-WRITE`, D5);
* leaves every pre-existing document outside its enumerated write set byte-identical (proven by the §9
  before/after hash harness, precedent `.demo/p8b-snapshots/`).

It does **not** yet guarantee detection of a committed-but-unacknowledged acceptance from the absence of a
document it never read; that is handled by `S4`/`S9` (verify-then-decide, never assume rollback).

---

## 4. Concurrency and ambiguity matrix

| # | Scenario | Interleaving that matters | Who wins / what happens | Mechanism | Client-visible result |
| --- | --- | --- | --- | --- | --- |
| S1 | Acceptance races an abandonment | Both transactions read the same aggregate, guard, control | Exactly one commits. If abandonment wins, the technician's later acceptance is refused **three independent ways**: lifecycle gate (`:700-705`), guard revision/epoch CAS (`:988-994`), guard no-longer-`active` (`:995-1000`), plus slot ownership (`:1113-1132`). If acceptance wins, the abandonment anchor read finds the activation receipt and refuses. | `F-1`/`F-3`/`F-4`/`F-5` | Technician: 409 `REVIEW_BINDING_CHANGED`, UI directs to admin review. Admin: 409 `RECOVERY_ACCEPTANCE_EXISTS`. Both `not_committed`, zero writes |
| S2 | Two administrators, same approved intent | Both pass pre-reads; second writes after first commits | First commits. Second is blocked by the create-once audit id derived from the **approval** (not the actor) and by the now-`cancelled` guard revision. It returns the committed outcome from a read-back, never a guessed rollback | `F-5` + revision CAS | 409 `RECOVERY_ALREADY_APPLIED` + original audit id/actor/time |
| S3 | Stale supervisor approval | Evidence moved after approval (new report revision, guard revision bump, aggregate revision bump) | In-transaction binding comparison fails. The approval is consumed-as-void and must be re-issued | `F-5` binding (§5.3 fields) | 409 `RECOVERY_APPROVAL_STALE`, message names the field that moved |
| S4 | Acceptance commits but the HTTP response is lost | Technician believes it failed | Existing verified behaviour: the deterministic receipt makes the next attempt a **zero-write replay** (`:859-969`) and the read-only reconciliation answers `APPLIED_VALIDATED` with `retryWouldReplay` ([incoming-acceptance-reconciliation.ts:92-119](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-reconciliation.ts#L92)). Consequence for recovery: the anchor now exists, so the pending abandonment refuses | `F-4` | Technician retries safely; admin gets `RECOVERY_ACCEPTANCE_EXISTS` |
| S5 | Retried recovery request | Same idempotency key, after an abort vs after a commit | **After abort:** nothing was written, the approval is unconsumed → the retry executes normally. **After commit:** anchor/cancelled-guard reads prove it applied → refused as already-applied. Recovery is deliberately once-only, unlike review decisions (which replay); precedent for once-only is the existing recovery's non-idempotent audit id (`recover-expired-scheduled-shift.ts:148-154`) | `F-5` detection before any write | Abort-retry: 200. Commit-retry: 409 `RECOVERY_ALREADY_APPLIED` |
| S6 | Global slot changes mid-recovery | `complete-shift`, another recovery, or a supersession advances/claims the control doc between approval and execution | `advanceOperationalShiftControl` itself refuses unless `consumed + handover_pending + shiftId === completedShiftId`, and refuses stale `advancedAt` and token reuse (`:365-391`) | `F-3` P6 CAS | 409 `RECOVERY_STALE_OR_APPLIED` |
| S7 | Inconsistent guard or audit record | Guard `cancelled` while aggregate still `awaiting`; audit present without receipt; two archives | Fail closed. The action never repairs and never proceeds "as far as possible". Same posture as the live path's audit-without-receipt refusal (`:972-977`) and reconciliation `INCONSISTENT_HISTORY`/`ADMIN_REVIEW_REQUIRED` | P3/P5 | 409 `RECOVERY_STATE_INCONSISTENT` + a mandatory review case reference |
| S8 | Outgoing technician never clocked out personally | Normal for this protocol — the outgoing pair's `actualEnd` is written by the *incoming* technician's acceptance (`:1388-1394`), so a missing personal clock-out proves nothing | **Not a precondition.** Absence of an outgoing clock-out must never be read as consent, and must never block or enable the action. `leftAt` remains explicitly administrative | D1, `INV-NO-PERSONAL-EVIDENCE-WRITE` | Audit row records `rosterEndOnly: true` semantics |
| S9 | Recovery fails after an ambiguous server response | 503 / connection drop after commit-time | The service returns `committed_unresolved` (existing vocabulary, `incoming-acceptance-application-firestore.ts:231-234` "never fabricate a success") and the client must run the read-only verification (`GET`) before any re-POST. A new attempt requires a **fresh approval**, because a committed attempt consumed the old one | §5.4 revocation + `F-4`/`F-5` read-back | 503 `HANDOVER_RECOVERY_OUTCOME_UNKNOWN`, `verificationRequired: true` |

**Residual assumption `A-1` [ASSUMPTION].** Firestore read-fencing of documents that *do not exist* is not
demonstrated by this repository: the only proofs are the mock harness
(`tests/helpers/transactional-firestore.mjs:66-69`) and indirect emulator evidence
(`tests/atomic-incoming-acceptance-emulator.test.mjs:269-284`). The safety argument above therefore does **not**
depend on non-existence fencing for correctness — every fence is either a CAS over a document that exists
(aggregate, guard, control, approval) or a `transaction.create` uniqueness constraint (activation receipt,
application receipt, audit rows). Non-existence reads are corroboration only. `A-1` must still be tested as a
documented behaviour, not an article of faith.

---

## 5. Approval workflow (D3 made executable)

### 5.1 Shape

A dedicated, append-only approval document — **[PROPOSED-NEW]** collection
`handover_recovery_approvals_v1`, id `handover_recovery_approval_v1_<sha256 {handoverDocumentId, action,
intentDigest}>` (same `referenceDigest` convention as
[handover-admin-review-domain.ts:134-149](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-domain.ts#L134)).
One document per recovery intent, carrying exactly two approvals and one consumption.

```
{
  schema: "handover-recovery-approval-v1",
  id, action: "abandon_stalled_handover",            // closed enum, one value now
  handoverDocumentId, outgoingShiftId, incomingShiftId,
  binding: {                                          // §5.3 — immutable intent fingerprint
    aggregateRevision, aggregateSnapshotHash, aggregateLifecycleStatus,
    guardId, guardRevision, fencingEpoch,
    slotToken, slotGeneration,
    evidenceDigest,                                  // §3.4 read-set digest
    reviewCaseId, reviewCaseRevision, reviewCaseFingerprint
  },
  intentFingerprint: hex64,                            // sha256 over binding, canonical
  reason: string(10..2000),                            // existing review reason rule
  requestedBy: uid, requestedAt: ISO,
  approvals: [
    { actorUid, actorRole: "supervisor", proofFingerprint, approvedAt, expiresAt },
    { actorUid, actorRole: "admin",      proofFingerprint, approvedAt, expiresAt }
  ],
  consumedBy: uid | null, consumedAt: ISO | null, voidedAt: ISO | null, voidReason | null,
  createdAt/updatedAt: serverTimestamp(), resultAuditId: string | null
}
```

### 5.2 Authentication and authorization per approval

* Each approver authenticates **only as themselves**. The existing generic seam is
  `reauthenticatePassword(input, dependencies)` — role-generic, verifying only that `signInWithPassword`
  succeeds and `localId === expectedUid`
  ([src/lib/auth/password-reauthentication.ts:73-76](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/auth/password-reauthentication.ts#L73),
  `:227-229`). **No technician credential is ever submitted, held or replayed by an administrator or
  supervisor** (brief, verbatim).
* Layering: reauthentication happens strictly **before** the Firestore transaction; the transaction re-reads
  `users/<uid>` and re-verifies role, `statusOperation == null`, `mustChangePassword !== true` — the pattern
  already enforced for admin recovery and review
  ([recover-expired-scheduled-shift.ts:207-219](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/recover-expired-scheduled-shift.ts#L207),
  [handover-admin-review-firestore.ts:1348-1369](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-firestore.ts#L1348)).
* The nonce+fingerprint+max-age proof convention is reused rather than invented:
  `createIncomingAcceptanceAuthenticationProof` binds `requestNonce`, `verifiedTechnicianUid`, `verifiedAt`,
  `authAccountCheckedAt`, `reviewFingerprint` and `reasonDigest`, and `assertIncomingAcceptanceAuthenticationProof`
  rejects a nonce from another request, a changed fingerprint, or an age beyond
  `INCOMING_ACCEPTANCE_PROOF_MAX_AGE_MS = 60_000`
  ([incoming-acceptance-application-domain.ts:420-511](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-domain.ts#L420)).
  The recovery approval proof is the same shape with `recoveryIntentFingerprint` in place of
  `reviewFingerprint`. Approvals expire on that clock; `expiresAt` is stored for audit, authority comes from
  the monotonic+wall comparison.
* Role separation is checked, not assumed: the two `actorUid`s must differ, and the set of roles must be
  exactly `{supervisor, admin}`. A single person holding both roles cannot satisfy D3 (one approval per
  distinct human, enforced by uid inequality).

### 5.3 Binding both approvals to the same thing (brief, verbatim requirement)

"Both approvals must bind to the same handover, guard, slot generation, evidence fingerprint and proposed
action." Implementation: `approvals[i].proofFingerprint` must equal `intentFingerprint`, which is a hash over
`{handoverDocumentId, action, binding}` where `binding` contains the guard id + `guardRevision` + `fencingEpoch`,
`slotToken` + `slotGeneration`, `aggregateRevision` + `aggregateSnapshotHash` +
**`aggregateLifecycleStatus`** (H-3: invisible to the snapshot hash, so it must be named explicitly), the
`evidenceDigest` of the §3.4 read set, and the review case's revision + fingerprint. An approval for a
different action, a different handover or a moved revision is not merely rejected — it cannot produce the right
`intentFingerprint`, so it cannot even be recorded against the wrong intent.

### 5.4 Staleness, expiry and revocation

| Trigger | Behaviour |
| --- | --- |
| Evidence/aggregate/guard/control/slot moved after approval | execution re-reads, recomputes `intentFingerprint`, mismatch → 409 `RECOVERY_APPROVAL_STALE`; the approval is marked `voidedAt`/`voidReason` by the same transaction attempt (a write-once tombstone on an approval record; it is a control document, not operational evidence) |
| `expiresAt` passed (60 s proof window; proposed 24 h intent window) | 409 `RECOVERY_APPROVAL_EXPIRED`; no execution attempted |
| Administrator wants a different action than approved | refused: `action` is inside the fingerprint |
| Revocation before execution | either approver may void (`voidedAt`), transactionally with a create-only audit row; an already-`consumed` approval cannot be revoked |
| Revocation after execution | **impossible by design** — abandonment is terminal for the handover; the guard is cancelled and may only be archived+superseded (H-5). Undo requires a new supervisor-created shift, which is normal operations, not recovery |
| Ambiguous response after consumption | `S9`: verify by read-back; consumption + `resultAuditId` make double-execution impossible |

### 5.5 What the workflow deliberately does **not** do

It does not create, accept, complete or repair anything at approval time — approvals write only to
`handover_recovery_approvals_v1` plus one audit row. It does not store passwords, tokens, cookies or
Identity Platform material: only `verifiedAt`, `authAccountCheckedAt`, the uid and the proof fingerprint,
exactly as the acceptance proof does.

---

## 6. Exact transaction specification — `abandonStalledHandoverUnderExpiry`

### 6.1 Inputs (server-derived only)

`{ outgoingShiftId, actorUid, approvalId, reason, idempotencyKey, nowIso }` where `actorUid` is the
authenticated session subject (never a body uid), `nowIso` is server-generated, `approvalId` is validated
against `§5`, and `idempotencyKey` follows the existing `/^[A-Za-z0-9._:-]{8,128}$/` rule
([handover-admin-review-domain.ts:176-179](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-domain.ts#L176)).

### 6.2 Read set (all before any write — one `runTransaction`)

| Ref | Document | Source of id |
| --- | --- | --- |
| R1 | `users[actorUid]` | session |
| R2 | `users[supervisorUid]`, `users[adminUid]` (the two approvers) | R13 |
| R3 | `handover_recovery_approvals_v1[approvalId]` | caller-supplied, then re-validated |
| R4 | `equal_handovers_v2[handover_v2_<outgoingShiftId>]` | `createEqualHandoverDocumentId` |
| R5 | `handover_reservation_guards[guard_<outgoingShiftId>]` **and** legacy `handovers[<legacyDocId>]` | `createHandoverReservationGuardDocumentId`; both read together by `readReservationGuardState` |
| R6 | `shifts[outgoingShiftId]`, `shifts[incomingShiftId]` | R4 identity |
| R7 | `operational_shift_control["global"]` | `GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID` |
| R8 | `audit_logs[handover-activation-v2-…]` (anchor), `audit_logs[handover-commit-v2-…]` | `createIncomingAcceptanceActivationReceiptId`, `equalHandoverCommitReceiptId` |
| R9 | per incoming uid: `incoming_acceptance_applications_v1[acceptance_app_v1_<hash>]`, `audit_logs[acceptance_application_v1_<hash>]` | `createIncomingAcceptanceApplicationIdentity` (`:242-274`) |
| R10 | per incoming uid × 2 kinds: `attendance_evidence_v2[…]`, `attendance_evidence_operations_v2[…]` (8 docs) | `attendanceEvidenceId(slotId)`, `attendanceOperationId(eventId)` |
| R11 | `shift_members[<incoming>_<uid>]`, `shift_attendance[<incoming>_<uid>]` ×2 each; `shift_members.where(shiftId == outgoing)` | existing composite-id convention (`:810-811`, `:1145-1171`) |
| R12 | `technician_schedules[uid]` for outgoing members + both incoming uids | `:1189-1190` |
| R13 | `handover_reports_v2[reportBinding.id]` (read-only, never written) | `:824-827` |
| R14 | `handover_review_cases_v1[caseId]`, `handover_review_decisions_v1[latest]` | `createHandoverReviewCaseId` |

### 6.3 Write set — exactly this, nothing else

| # | Ref | Operation | Content |
| --- | --- | --- | --- |
| W1 | `shifts[outgoingShiftId]` | `update` | `status: "cancelled"`, `cancelledAt`, `cancelledBy`, `updatedAt`. **`actualEnd` is never written** (D5: would assert a completion that did not happen; D1: it is not a clock-out) |
| W2 | `operational_shift_control["global"]` | `set` | `advanceOperationalShiftControl(control, outgoingShiftId, nextSlotToken, nowIso)` → fresh pending control, `generation + 1`, `previousSlotToken` preserved (`:393-399`) |
| W3 | `shift_members[<outgoing>_<uid>]` (current members only) | `update` | `leftAt: nowIso` only — roster end, explicitly not a clock-out (`recover-expired-scheduled-shift.ts:949-954`) |
| W4 | `technician_schedules[uid]` | `update` | drop the cancelled shift entry, `updatedAt` (precedent `:994-1013`) |
| W5 | `equal_handovers_v2[documentId]` | `set` | new domain transition `abandonEqualHandover(agg, {expectedRevision, expectedSnapshotHash, expectedLifecycleStatus: "awaiting_incoming_acceptance", recordedAt, actorUid})` → `lifecycleStatus: "cancelled"`, `revision + 1`, `updatedAt`; identity/reservation/reportBinding/absences untouched **[PROPOSED-NEW function — closes H-2 + H-4; the existing `closeEqualHandover` must not be relaxed]** |
| W6 | `handover_reservation_guards[guardId]` | `set` | `cancelReservationGuard(transaction, {outgoingShiftId, protocolOwner: "v2", expectedGuardRevision, expectedFencingEpoch, terminalEvidenceRef: abandonmentAuditId, recordedAt, actorUid})` → `cancelled`, `guardRevision + 1` (existing [handover-reservation-guard.ts:187-213](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-reservation-guard.ts#L187); currently reachable only from the technician-only reservation route — reservation route refuses non-technicians, [reservation/route.ts:48-49](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/app/(dashboard)/api/operations/shifts/[shiftId]/handover/v2/reservation/route.ts#L48)) |
| W7 | `audit_logs[abandonmentAuditId]` | `create` | see §6.5 |
| W8 | `handover_recovery_approvals_v1[approvalId]` | `update` | `consumedBy`, `consumedAt`, `resultAuditId` — single-use consumption |

**Never written:** `shift_attendance`, `attendance_evidence_v2`,
`attendance_evidence_operations_v2`, `incoming_acceptance_applications_v1`, any activation/commit receipt,
`handover_reports_v2`, any existing `audit_logs` row, `handover_review_cases_v1`,
`handover_review_decisions_v1`, `notification_*` (`OD-5`), `users` (beyond reads).
**Never deleted:** any document, in any collection.

### 6.4 Compare-and-set conditions and fences

| Fence | Condition, evaluated in-transaction | Refusal code | HTTP |
| --- | --- | --- | --- |
| F-1 | R4 `lifecycleStatus === "awaiting_incoming_acceptance"` **and** `revision === binding.aggregateRevision` **and** `snapshotHash === binding.aggregateSnapshotHash` | `RECOVERY_STALE_OR_APPLIED` | 409 |
| F-2 | `nowIso > min(scheduledStart + LATE_MINUTES, scheduledEnd)` computed from R4 identity, server clock only | `RECOVERY_WINDOW_OPEN` | 409 |
| F-3 | R7 `slotStatus === "consumed" && shiftId === outgoingShiftId && shiftStatus === "handover_pending" && slotToken === binding.slotToken && generation === binding.slotGeneration`; then `advanceOperationalShiftControl` re-asserts staleness and token reuse | `RECOVERY_STALE_OR_APPLIED` | 409 |
| F-4 | R8 activation anchor absent, R9 receipts absent, R11 incoming participation absent, R6 incoming shift absent — **and** R8 commit receipt present and valid via `assertEqualHandoverCommitReceipt` | `RECOVERY_ACCEPTANCE_EXISTS` | 409 |
| F-5 | R3 approval: `intentFingerprint` recomputed from fresh reads equals stored value; both approvals present, distinct uids, correct roles, unexpired, `consumedAt === null`, `voidedAt === null` | `RECOVERY_APPROVAL_STALE` / `…_EXPIRED` / `…_INVALID` | 409 |
| F-6 | R5 guard `protocolOwner === "v2"`, `active`, `terminalEvidenceRef === null`, binding equals R4 identity; and R14 review case in `under_investigation`/`escalated` with matching `fingerprint` | `RECOVERY_STATE_INCONSISTENT` | 409 |
| F-7 | `audit_logs[abandonmentAuditId]` does not exist (`transaction.create` is the ultimate uniqueness fence) | `RECOVERY_ALREADY_APPLIED` | 409 |

Refusal codes are new but follow the two established vocabularies: `REVIEW_*`
(`REVIEW_BINDING_CHANGED`, `REVIEW_DECISION_STALE`, `REVIEW_IDEMPOTENCY_CONFLICT`,
[handover-admin-review-domain.ts:29-34](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-domain.ts#L29))
and `INCOMING_ACCEPTANCE_*`
([incoming-acceptance-application-domain.ts:51-69](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/incoming-acceptance-application-domain.ts#L51)).
Every refusal is `not_committed` with zero writes; none is a 200 with a soft message.

### 6.5 Deterministic identifiers and audit semantics

```
abandonmentAuditId = "handover_abandonment_v1_" +
    sha256(canonical({ namespace: "handover-recovery-abandonment-v1", approvalId }))
nextSlotToken      = uuidV5-format(namespace "shiftchange-operational-recovery",
                                   { approvalId, control.generation + 1 })
```

Both derive from the **approval id**, not the actor and not `randomUUID()`. That is a deliberate departure from
`complete-shift.ts:147` (`nextSlotToken = randomUUID()`) and from the existing recovery's auto-id audit
(`recover-expired-scheduled-shift.ts:148-154`), and it is what makes S2/S5 decidable: a retried or duplicated
attempt recomputes the same ids, so either `transaction.create` collides (already applied) or F-7 fires before
any write. `requireSlotToken` accepts the pattern
`/^[0-9a-f]{8}-…-[1-8][0-9a-f]{3}-[89ab]…$/i`
([operational-shift-control-state.ts:23-24](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/operational-shift-control-state.ts#L23))
— version `5` is inside the accepted range. [ASSUMPTION `A-3`: an RFC-4122 v5-shaped string must be produced and
accepted by `assertOperationalShiftControl`/`createPendingOperationalShiftControl`; asserted by unit test,
since every existing caller uses `randomUUID`.]

Audit row (create-only, `createdAt: FieldValue.serverTimestamp()`):
`{ id, action: "HANDOVER_STALLED_ABANDONED_V1", protocol: "equal-handover-v2-recovery", actorUid,
approvalId, intentFingerprint, supervisorUid, adminUid, handoverDocumentId, outgoingShiftId,
incomingShiftId, guardId, guardRevisionBefore/After, fencingEpoch, slotTokenBefore/After,
generationBefore/After, aggregateRevision/lifecycleBefore/After, activationWindow: {scheduledStart,
scheduledEnd, latestActivationAt, nowIso}, evidenceDigest, negativeProof: {each §3.4 read and its state},
reason, rosterEndOnly: true, personalEvidenceWritten: false }`.
`personalEvidenceWritten: false` is asserted by the code path itself, not supplied by a caller.

### 6.6 Invariants

Before: `INV-1` guard active with no terminal ref; `INV-2` aggregate awaiting acceptance; `INV-3` outgoing
shift `handover_pending` owning a consumed slot; `INV-4` no acceptance artifacts; `INV-5` frozen report bytes
untouched.
After: `INV-6` guard `cancelled`, `terminalEvidenceRef === abandonmentAuditId`, `guardRevision + 1`;
`INV-7` aggregate `cancelled`, terminal, never resumable; `INV-8` control `pending`, fresh token,
`generation + 1`, `previousSlotToken` preserved; `INV-9` `actualEnd === null` still;
`INV-10` **zero** documents created in any personal-evidence collection; `INV-11` zero audit rows updated or
deleted; `INV-12` approval consumed exactly once with `resultAuditId === abandonmentAuditId`.

### 6.7 Operations that cannot safely be atomic

| Operation | Why it cannot join the transaction | Where it happens instead |
| --- | --- | --- |
| Password reauthentication of either approver | Identity Platform calls are network I/O inside a Firestore transaction, which the existing design forbids (proof created outside, verified inside) | before each approval write |
| Approval creation itself (two humans, minutes/hours apart) | the whole point of D3 is that authority is granted over time, not inside one commit | separate create transactions per approver |
| Computing the review projection / `evidenceDigest` shown in the UI | must be re-derived inside the execution transaction; the stored value is only a claim to compare against | read-model GET, then re-verified at F-5 |
| Notification fan-out | existing convention writes outbox rows **inside** the acceptance transaction (`:1466`) and never on replay; for a cancellation there is no existing intent type, so inventing one is a product decision | deferred, `OD-5` |
| Deleting or rewriting any historical artifact | not atomic — not permitted at all | n/a |
| Guard re-acquisition by a successor v2 reservation | necessarily a later transaction (`resolveOrAcquireReservationGuard`, `:84-115`) | normal supervisor flow |

---

## 7. Compatibility with historical cases (no migration, no reopening)

**Constraint, verbatim: "Do not migrate or reopen historical cases."**

* **Originals stay exactly as they are.** Closed cases keep their status, revision, decisions and audits. No
  backfill, no field added to `handover_review_cases_v1`, no re-derivation of historical fingerprints. Because
  the review fingerprint inputs include `classification` and `reviewReasonCodes`
  ([handover-admin-review-domain.ts:157-161](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/lib/operations/handover-admin-review-domain.ts#L157)),
  adding any new classification or reason code would invalidate previously served decisions with
  `REVIEW_DECISION_STALE`. Contract rule: **recovery introduces no new value into the existing review
  classification or reason-code enumerations**; the reassessment lives in its own vocabulary.
* **Reassessment is a different object, keyed differently.** `handover_review_cases_v1` is one-per-handover by
  construction (`createHandoverReviewCaseId(handoverDocumentId)`), so a "linked reassessment case" cannot be a
  second row there. Two-stage proposal, unchanged from 8C §6 and now specified:
  * Stage 1 (8C.1 milestone, append-only, **zero reader change**): a `handover_review_adjudications_v1` row
    keyed by `{caseId, decisionId, evidenceDigest}` stating that the evidence behind a past acknowledgement no
    longer proves what it asserted. Original case unchanged; readers that do not know the collection keep
    working.
  * Stage 2 (only if the owner wants contradictions to become work): `handover_review_reassessments_v1`
    documents that *reference* `originalCaseId` + `originalDecisionIds` and carry their own status/revision
    line starting at 0, reusing the existing decision/audit machinery against the new key.
* **Reader/query changes required, and they are small and additive.** `readCaseByDocumentId`
  (`:1215-1234`, wrapping the exported `readHandoverReviewCase` at `:1257`) and `listHandoverReviewQueue`
  (`:1273-1346`) assume one case per handover. Required deltas:
  (a) a "contradicted by later record" marker computed from adjudication presence, never stored on the case;
  (b) a decision-history section that labels each row `original` or `reassessment` by collection, not by
  mutating `HANDOVER_REVIEW_DECISION_TYPES`
  ([types/handover-admin-review.ts:32-49](file:///C:/Users/Jonah/Desktop/KobbyProject/NOC-SHIFTCHANGE/src/types/handover-admin-review.ts#L32));
  (c) queue listing unchanged unless stage 2 is approved.
* **Historical `legacy_guard_only` vs suspicious evidence** stays governed by the shipped 8B.2 precedence rule:
  provenance is derived from bytes (terminal ref resolves to provable evidence), never from a stored label.
  Recovery adds no label that could be mistaken for proof.
* **Interaction with recovery:** an executed abandonment writes **no** review case or decision (§6.3), so a
  closed historical case is never retroactively altered by a recovery. The linkage is one-way: the audit row
  points at the case and approval; the case points at nothing.

---

## 8. Deliverables

### 8.1 Proposed authority matrix

| Action | Category | Role(s) | Approvals | Personal credential used | Operational write? | Status |
| --- | --- | --- | --- | --- | --- | --- |
| View review queue / case / evidence | A | admin, supervisor | — | no | no | [VERIFIED-EXISTING] |
| Record a review decision (5 types) | B | admin | 1 | no | no | [VERIFIED-EXISTING] |
| Reconcile acceptance state (read-only) | A | technician (own), admin | — | no | no | [VERIFIED-EXISTING] `:92-119` |
| Finalize guard exceptionally | B/C seam | technician/admin/supervisor via `v2/finalize` | 1 | technician's own, where required | **yes** | [VERIFIED-EXISTING], ungated → `OD-3` |
| Recover expired **scheduled** shift | C | admin only, supervisor explicitly excluded | 1 | no | yes | [VERIFIED-EXISTING] `:200-219` |
| **Adjudicate a contradiction (append-only)** | B | admin | 1 | no | no | [PROPOSED-NEW], stage 1 |
| **Open a linked reassessment case** | B | admin | 1 | no | no | [PROPOSED-NEW], stage 2 |
| **Abandon a stalled handover** | C | **supervisor + admin, distinct uids** | **2** | no, never | yes | [PROPOSED-NEW], this contract |
| Complete/accept a handover | operational | reserved incoming technician only | 1 per technician | technician's own | yes | [VERIFIED-EXISTING], unchanged by this phase |

No row in this matrix permits an administrator to produce a technician's acceptance, attendance or personal
authentication artifact. The disabled `legacy_recovery` receipt origin
(`INCOMING_ACCEPTANCE_LEGACY_RECOVERY_WRITES_ENABLED = false`) **stays disabled**; recommendation: keep it
off permanently, since its reserved shape implies exactly the impersonation the brief forbids. `OD-4`.

### 8.2 Transaction safety proof

§3.6, resting on: the fence table §6.4, the negative-proof argument §3.4, the hazards §3.5, the three
assumptions `A-1`/`A-2`/`A-3` and their tests §9.

### 8.3 Concurrency and failure matrix — §4 (S1…S9).

### 8.4 Exact document read/write specification — §6.2/§6.3, including the never-written list and the
deterministic id derivations §6.5.

### 8.5 Administrative coverage / payroll semantics

* The outgoing pair's coverage **ends administratively** at `nowIso` via `leftAt`; their personal attendance
  rows from the shift's start are untouched; `shifts.actualEnd` stays `null`, so no system ever reads a
  fabricated end-of-work timestamp for that shift.
* The incoming pair acquires nothing: no membership, no attendance, no evidence, no receipt. Payroll for the
  incoming pair is therefore naturally zero — there is no row to suppress.
* The reserved incoming shift id is never created; the successor slot token is consumed by the *next*
  supervisor-created shift, which starts a new generation with `previousSlotToken` preserved, keeping the
  lineage auditable.
* Open semantic question (`OD-6`): with `status: "cancelled"` and `actualEnd === null`, downstream reporting
  may read "no work performed" although the pair worked the shift until the window closed. This contract
  recommends `cancelled` + audit-only (never `completed`, which would assert an activation that did not occur
  and would collide with the 8B badge semantics), and requires the report layer to surface the linked audit
  rather than the shift status. That report-layer change is **not** designed here and needs owner direction.

### 8.6 Approval workflow — §5.

### 8.7 Proposed implementation order (each step is a separate milestone needing its own go-ahead)

1. **8C.2a — Stage-1 adjudication (Category B).** Append-only `handover_review_adjudications_v1` + confirmation
   step + `aria-live` gaps. Zero operational writes; regression surface is the review suites. Lowest risk,
   immediately useful.
2. **8C.2b — Approval substrate.** `handover_recovery_approvals_v1`, proof binding, expiry/void, tests. Creates
   no operational state; makes D3 reviewable before any recovery exists.
3. **8C.3 — Recovery read-model only.** `recoveryEligibility(handoverDocumentId)` implementing §3.2/§3.4 as a
   pure read, returning which fence fails. The UI can show "why not" before anyone can press a button.
4. **8C.4 — `abandonEqualHandover` domain transition + §6.4 fences + tests** (unit only, no route). Closes
   H-2/H-3/H-4 and proves `A-2`/`A-3`.
5. **8C.5 — Execution service + route + browser UAT** behind an env gate, default off, disposable stack only
   (never the protected UAT environments).
6. **8C.6 — optional stage-2 reassessment cases**, only if `OD-7` is approved.

Recommendation unchanged from 8C §11: nothing Category-C is safe to implement first — 8C.2a/8C.2b/8C.3 deliver
value with zero operational risk and produce exactly the evidence needed to approve (or refuse) 8C.5.

### 8.8 Unresolved decisions requiring explicit authorization

| # | Decision | Options | Agent recommendation |
| --- | --- | --- | --- |
| OD-1 | Does D2's "independently verified" include structurally-provable closure with no closure audit? | (a) yes, keep today's `legacy_guard_only` display; (b) no → unaudited closures become investigation-only | (a); tightening it changes shipped 8B.1/8B.2 semantics with no integrity gain |
| OD-2 | D3 conflicts with the reserved single-`approvedBy` recovery metadata | (a) keep that schema disabled and use `handover_recovery_approvals_v1`; (b) extend the reserved schema to dual approvers | (a) |
| OD-3 | `handover/v2/finalize` is ungated while atomic mode is on | (a) gate it; (b) document it as an approved exception; (c) restrict its role list | (b) then (c) as its own milestone — gating it now would break 8B.1's exceptional-closure flow |
| OD-4 | The `legacy_recovery` receipt origin (`prior_authenticated_attempt`) | (a) keep hard-disabled forever; (b) enable for administrator-invoked recovery | (a) — enabling it lets an admin-triggered write carry a technician's personal evidence |
| OD-5 | Notifications on abandonment (no existing intent type) | (a) none; (b) new informational intent written inside the transaction | (a) for the first milestone |
| OD-6 | Coverage semantics: `cancelled` + `actualEnd === null` vs a report-layer reading of the audit | (a) audit-only, reporting reads the linked audit; (b) new `operationalRecovery` field on `shifts` | (a) — no schema growth on `shifts` |
| OD-7 | Stage-2 reassessment cases (reader semantics change) | (a) stop at stage 1; (b) approve stage 2 after 8C.2a has been used | (b) only after (a) has real data |
| OD-8 | Whether `A-1` (non-existence fencing) must be proven before 8C.5 ships | (a) prove in a dedicated emulator test; (b) rely on the CAS-over-existing-docs argument | (a) — it is cheap and the claim is load-bearing for reviewers |
| OD-9 | Any operational recovery at all, in any form | (a) approve the staged order §8.7; (b) keep Category-C permanently out of scope and handle stalls by escalation procedure (8C §5) | owner's product call; (b) remains fully viable — nothing here is required for correctness, only for unblocking operations |

---

## 9. Verification obligations carried into implementation

Nothing below was executed in this phase; they are the contract's exit criteria.

1. `A-2`: unit test asserting `createIncomingAcceptanceActivationReceiptId(d)` and
   `equalHandoverActivationReceiptId(d)` produce the same id for sampled and adversarial document ids.
2. `A-3`: unit test that a v5-shaped deterministic token passes `requireSlotToken` and survives
   `assertOperationalShiftControl` round-trip.
3. `A-1`: emulator test that two concurrent transactions cannot both observe "absent" then both create the same
   deterministic id — i.e. prove the `transaction.create` uniqueness fence under contention.
4. Byte-level before/after preservation over all never-written collections (§6.3), reusing the
   `.demo/p8b-snapshots/` capture/compare harness; any changed byte outside W1–W8 fails the suite.
5. Fence-by-fence negative tests: S1…S9 each driven in the isolated emulator stack, asserting refusal code,
   `not_committed`, and zero writes.
6. Approval lifecycle tests: stale binding, expiry, void, double-consume, same-human-different-role, two-role
   set violation.
7. Regression surface already in force and required to stay green: the guard suite, the v2 acceptance suite,
   the atomic acceptance suites, the admin-review suite (13/13) and the expired-scheduled-shift recovery suite.
   Run on a disposable stack only (ports/env per the 8B environment notes; two suites hardcode an Android Studio
   JBR path that is absent here and must be driven through `.demo/run-emulator-suite-scratch.ps1`).
8. Browser UAT on a disposable stack: eligibility read-model, two-approval flow, refusal messaging,
   `aria-live` outcomes. Protected UAT environments stay untouched and gate-off.

---

## 10. Preservation re-check after this document

Recorded in `.demo/p8c-baseline.txt` under "8C.1 END STATE". Expected: HEAD unchanged
`c1703530437ff4e45010dde4f920597fe7684d9f`, tree entries `148 → 149` (this file only), protected hashes 19/19
identical, 0 stashes, no test file, rule, seed or environment file modified.

**STOP. This is a design and verification artifact. Awaiting explicit approval before any implementation
milestone in §8.7 begins, and before any operational recovery action is taken.**
