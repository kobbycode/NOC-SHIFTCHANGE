# Phase 8C.3 — Authoritative Recovery Eligibility and Evidence Digest

**Status:** implemented as a read-only service. No operational recovery execution is authorized by
this document or by the code it describes.

**Predecessors:** [PHASE-8C-OPERATIONAL-RECOVERY-DESIGN.md](./PHASE-8C-OPERATIONAL-RECOVERY-DESIGN.md)
(OP-3 shape), [PHASE-8C1-RECOVERY-CONTRACT-SAFETY-PROOF.md](./PHASE-8C1-RECOVERY-CONTRACT-SAFETY-PROOF.md)
(P1–P8 preconditions, F-4 anchor, hazards H-1…H-6, assumptions A-1/A-2), and the Phase 8C.2b V1 approval
implementation.

## 1. What this service is, and is not

It answers one question for one committed handover: **does the authoritative record currently support
considering abandonment, and if not, exactly why not?** It reads; it never writes. `eligible` means
"the evidence supports consideration", never "you may abandon". The response carries
`executionAuthorized: false` and `executionAuthority: "none"` literally, because a read taken before a
future transaction proves nothing about the state that transaction will observe (8C.1 §3.3).

It creates no approval, consumes none, and cannot be composed into an executable path: no route calls
it to gate a write. The only future consumer is a V2 approval (design, §6), which would re-evaluate
inside its own transaction.

## 2. Classification taxonomy

`classification` is exactly one of the nine codes below. `refusals[]` contains **every** applicable
refusal, each with its own stable `detail` code, so one refusal never hides another. The primary
classification is the highest-precedence entry in `refusals[]`, or `eligible_for_abandonment_review`
when the list is empty.

| Precedence | Classification | Meaning |
| --- | --- | --- |
| 1 | `handover_not_applicable` | The aggregate is absent, unreadable-as-a-v2-aggregate, not committed, or already terminal. Abandonment is not the right action. |
| 2 | `evidence_unverifiable` | A document needed for the proof exists but cannot be validated, or the complete ID set cannot be derived with certainty. Stop short of eligibility (brief §4). |
| 3 | `acceptance_exists` | A committed acceptance is proven: valid activation receipt, or applied application receipt, or a `completed` aggregate, or an activated incoming shift. |
| 4 | `acceptance_outcome_uncertain` | An acceptance may have committed but cannot be proven either way: a pending/interrupted operation, finalized personal evidence with no receipt (`EVIDENCE_ONLY`), or an application artifact without its receipt. |
| 5 | `inconsistent_evidence` | The records contradict each other: audit without application, incoming membership/attendance/shift without any receipt, guard terminal while the aggregate is open, conflicting receipts. |
| 6 | `guard_binding_conflict` | The guard exists but is not the guard of this handover at this generation (protocol owner, owner document, reservation, incoming shift, slot token, generation). |
| 7 | `slot_binding_conflict` | The global slot is not owned by this outgoing shift at the expected token and generation. |
| 8 | `activation_window_open` | Evidence is consistent and shows no acceptance, but the server clock is still inside the permitted activation window. |
| 9 | `eligible_for_abandonment_review` | Every precondition holds. Still only a review eligibility. |

Precedence rationale: `handover_not_applicable` stops analysis because the artifact is not a stalled
committed handover at all; `evidence_unverifiable` outranks everything because an unverifiable proof
must never be summarised as a confident refusal; a **proven** acceptance outranks uncertainty and
inconsistency because it is the strongest possible "no"; uncertainty outranks inconsistency because
"possibly accepted" is the more conservative statement; guard and slot conflicts are ordinary refusals
that only matter once no acceptance exists; the window check is last because it is the only refusal
that can become `eligible` without any document changing.

Refusal `detail` codes (stable strings). Every code below is emitted by the classifier; the
constants `ACTIVATION_RECEIPT_CONFLICT` and `INCOMING_SHIFT_WITHOUT_RECEIPT` exist in the type but are
reserved and never emitted in schema version 1:

`HANDOVER_NOT_FOUND`, `AGGREGATE_UNREADABLE`, `AGGREGATE_NOT_COMMITTED`, `AGGREGATE_TERMINAL`,
`REPORT_BINDING_MISSING`, `REPORT_UNREADABLE`, `COMMIT_RECEIPT_MISSING`, `COMMIT_RECEIPT_INVALID`,
`ACTIVATION_RECEIPT_VALID`, `ACTIVATION_RECEIPT_INVALID`, `APPLICATION_RECEIPT_VALID`,
`AGGREGATE_COMPLETED`, `OUTGOING_SHIFT_COMPLETED`, `INCOMING_SHIFT_ACTIVATED`, `OPERATION_PENDING`,
`OPERATION_INTERRUPTED`, `DUPLICATE_EVIDENCE_OPERATIONS`, `EVIDENCE_WITHOUT_RECEIPT`,
`APPLICATION_WITHOUT_AUDIT`, `AUDIT_WITHOUT_APPLICATION`, `MEMBERSHIP_WITHOUT_RECEIPT`,
`ATTENDANCE_WITHOUT_RECEIPT`, `APPLICATION_UNREADABLE`, `EVIDENCE_UNREADABLE`,
`OUTGOING_SHIFT_UNREADABLE`, `OUTGOING_SHIFT_STATUS_MISMATCH`, `OUTGOING_SHIFT_BINDING_MISMATCH`,
`LEGACY_RESERVATION_AMBIGUOUS`, `KIND_SET_UNVERIFIED`, `GUARD_MISSING`, `GUARD_UNREADABLE`,
`GUARD_NOT_V2`, `GUARD_OWNER_MISMATCH`, `GUARD_RESERVATION_MISMATCH`, `GUARD_TOKEN_MISMATCH`,
`GUARD_REVISION_MISMATCH`, `GUARD_EPOCH_MISMATCH`, `GUARD_HISTORY_UNREADABLE`,
`GUARD_LIFECYCLE_NOT_ACTIVE`, `GUARD_TERMINAL_AGGREGATE_OPEN`, `SLOT_MISSING`, `SLOT_UNREADABLE`,
`SLOT_NOT_OWNED`, `SLOT_STATUS_MISMATCH`, `SLOT_SHIFT_STATUS_MISMATCH`, `SLOT_TOKEN_MISMATCH`,
`SLOT_GENERATION_MISMATCH`, `ACTIVATION_WINDOW_OPEN`, `REVIEW_CASE_UNREADABLE`,
`RECONCILIATION_REQUIRES_REVIEW`.

## 3. Authoritative read set

Every document is read **inside one read-only Firestore transaction**, so the set is a point-in-time
snapshot. IDs are derived with the production factories, never constructed by the caller.

| # | Document(s) | ID derivation | Authoritative writer(s) | Role in the proof |
| --- | --- | --- | --- | --- |
| 1 | `equal_handovers_v2/<doc>` | `createEqualHandoverDocumentId(outgoingShiftId)` | `createEqualHandover`, commit/confirmation transitions | Is this a committed, still-open v2 handover? |
| 2 | `audit_logs/handover-commit-v2-<sha256>` | `equalHandoverCommitReceiptId(documentId)` | outgoing commit transaction | Positive proof the outgoing pair committed |
| 3 | `handover_reports_v2/<reportId>` | `aggregate.reportBinding.id` | report freeze | Frozen report binding integrity (read-only) |
| 4 | `handover_reservation_guards/guard_<shiftId>` | `createHandoverReservationGuardDocumentId` | guard acquire/replace/cancel/complete | Guard identity, lifecycle, token and generation |
| 5 | `handovers/<legacyDocId>` | `createHandoverDocumentId(outgoingShiftId)` | legacy v1 reservation | Ambiguous identity model detection |
| 6 | `handover_reservation_guard_history/<id>` | query `outgoingShiftId == outgoingShiftId`; each document's id must equal `createReservationGuardArchiveDocumentId(payload)` | guard cancellation/acquire | Prior terminal guard evidence (H-5); a moved or forged archive makes the history unreadable |
| 7 | `shifts/<outgoingShiftId>` | aggregate identity | start/complete/cancel | Outgoing shift is in exactly the state an acceptance required |
| 8 | `operational_shift_control/global` | `GLOBAL_OPERATIONAL_SHIFT_CONTROL_ID` | shift create / start / advance | Slot ownership, status, token, generation |
| 9 | `audit_logs/handover-activation-v2-<sha256>` | `createIncomingAcceptanceActivationReceiptId(documentId)` | both activation paths | F-4 anchor: activation committed ⟹ receipt exists |
| 10 | `incoming_acceptance_applications_v1/acceptance_app_v1_<hash>` × 2 | `createIncomingAcceptanceApplicationIdentity` per reserved incoming UID | atomic + gated legacy acceptance | Applied acceptance proof per technician |
| 11 | `audit_logs/acceptance_application_v1_<hash>` × 2 | same identity | acceptance transaction | Corroborates its receipt; audit without receipt is inconsistent |
| 12 | `shifts/<incomingShiftId>` | aggregate identity | first activation only | Unexpected incoming shift means activation happened |
| 13 | `shift_members/<incomingShiftId>_<uid>` × 2 | `${incomingShiftId}_${uid}` | activation / roster | Membership without receipt is inconsistent |
| 14 | `shift_attendance/<incomingShiftId>_<uid>` × 2 | `${incomingShiftId}_${uid}` | activation / attendance | Attendance without receipt is inconsistent |
| 15 | `attendance_evidence_v2/att2_ev_<hash>` × 4 | `attendanceEvidenceSlotId` × {2 UIDs} × {`incoming_clock_in`, `incoming_late_acceptance`} | evidence finalization | Personal evidence exists without acceptance |
| 16 | `attendance_evidence_operations_v2/att2_op_<hash>` × 8 | atomic: `createIncomingAcceptanceApplicationIdentity(...).operationId`; legacy: `attendanceOperationId(createLegacyIncomingAcceptanceEventId(...))` | atomic and pre-atomic evidence request/finalize/abort | Pending or interrupted operations are uncertainty; an atomic and a legacy operation for the same slot is `DUPLICATE_EVIDENCE_OPERATIONS` |
| 17 | Reconciliation outcome × 2 UIDs | in-process reuse of the same reads | — | `EVIDENCE_ONLY` / `INCONSISTENT_HISTORY` / `COMMIT_UNVERIFIABLE` mapped into refusals |
| 18 | `handover_review_cases_v1/<id>` | `createHandoverReviewCaseId(documentId)` | admin review | Existing open case and fingerprint (relevant reference only) |
| 19 | `users/<actorUid>` | session identity | profile admin | Live-actor authorization |

### 3.1 Why this set is provably complete for "no acceptance occurred"

Following 8C.1 §3.4, the answer is not a count. It is:

1. **The anchor** (row 9) is content-derived from the handover document id alone and is written with
   `transaction.create` by every path that can commit a first activation. Therefore *activation
   committed ⟹ this document exists*; absent ⟹ never activated.
2. **The positive counterweight** (row 2) must exist and validate: the outgoing pair really did
   commit. Missing or invalid → the handover is not in the stalled state at all.
3. **The corroboration set** (rows 10–17) covers every personal artifact the activation transaction
   would have written. Any disagreement with the anchor is a hard refusal.

Completeness of the personal-artifact set rests on **kind enumeration**: acceptance evidence can only
be `incoming_clock_in` or `incoming_late_acceptance`
(`selectIncomingAcceptanceEvidenceKind`, `ATTENDANCE_CLOCK_IN_EVIDENCE_KINDS`), and the application
receipt id is kind-independent (`{handoverId, technicianUid}`), so two technicians × one receipt plus
two technicians × two kinds is the complete artifact space. A regression test pins that enumeration:
if a third clock-in kind is ever added, the test fails and the classifier must be revisited before
eligibility can be trusted.

The operation set is **doubled** for the same reason. The pre-atomic acceptance writer derived its
event id with `createLegacyIncomingAcceptanceEventId` rather than with the atomic identity factory, so
its operation document lives at a different document id. Both namespaces are read for every
technician × kind (row 16). A pending or interrupted operation in either namespace is
`acceptance_outcome_uncertain`; both present at once is `DUPLICATE_EVIDENCE_OPERATIONS`
(`inconsistent_evidence`). Reading only the atomic id would let an in-flight legacy acceptance look
like no attempt at all.

### 3.2 What the service refuses to infer

- A missing outgoing clock-out proves nothing: the outgoing `actualEnd` is written by the **incoming**
  acceptance, so its absence is normal (8C.1 S8).
- `attendance_evidence_v2` presence is **not** acceptance. Only a finalized operation plus a receipt
  is; finalized evidence alone is `EVIDENCE_ONLY` uncertainty.
- A legacy `handovers/<legacyDocId>` in `collecting_confirmations` means the identity model is
  ambiguous → `evidence_unverifiable`.
- `next_shift_authorizations` is not authoritative for slot ownership; the control document is.

### 3.3 Re-acquired guards and archived history

A cancelled reservation can be re-acquired, which leaves a newer **active** guard whose
`terminalEvidenceRef` names its cancelled predecessor's archive. The classifier therefore does not
treat "terminal evidence on an active guard" as a contradiction by itself. It requires:

1. Every archived entry validates and its document id equals
   `createReservationGuardArchiveDocumentId(payload)`; otherwise `GUARD_HISTORY_UNREADABLE`
   (`evidence_unverifiable`).
2. The live guard's `id` does not appear in the archive, and the live `guardRevision` is strictly
   greater than every archived revision, and the live `fencingEpoch` is at least every archived
   epoch; otherwise `GUARD_REVISION_MISMATCH` (`guard_binding_conflict`).
3. An active guard's `terminalEvidenceRef`, when set, names a validated archived predecessor;
   otherwise `GUARD_LIFECYCLE_NOT_ACTIVE`.
4. A guard whose owner lifecycle is `cancelled` while the aggregate still awaits acceptance is
   `GUARD_TERMINAL_AGGREGATE_OPEN` (`inconsistent_evidence`), regardless of archive state.

## 4. Deterministic evidence digest (schema version 1)

```
digest = sha256( canonical( { namespace: "handover-recovery-eligibility-v1",
                              schemaVersion: 1,
                              material } ) )
```

`canonical` is the repository convention: recursively sorted object keys, `undefined` members dropped,
arrays preserved in their documented order (all arrays below are pre-sorted). No floats, no locale
formatting, no timestamps of evaluation.

`material` — exact field list (all keys always present; absent documents carry `present: false` plus
their deterministic `id`):

| Group | Fields |
| --- | --- |
| envelope | `schema` (`handover-recovery-eligibility-evidence`), `schemaVersion` (1), `handoverDocumentId`, `outgoingShiftId`, `incomingShiftId` |
| conclusion | `classification`, `refusals` (sorted `code:detail` strings) |
| completeness | `kindSetComplete` |
| aggregate | `present`, `id`, `lifecycleStatus`, `revision`, `snapshotHash`, `unreadable`, `identity` (all 13 identity fields), `reservation` (`handoverId`, `reservedIncomingShiftId`, `revision`, `outgoingSlotToken`, `outgoingGeneration`, `successorSlotToken`, `expectedSuccessorGeneration`, `reservedAt`, `reservedBy`), `reportBinding` (`present`, `id`, `reportDigest`, `frozenAt`, `aggregateRevision`, `fencingEpoch`) |
| guard | `present`, `id`, `protocolOwner`, `ownerHandoverDocumentId`, `ownerLifecycleState`, `guardRevision`, `fencingEpoch`, `outgoingSlotToken`, `outgoingGeneration`, `successorSlotToken`, `successorGeneration`, `reservationId`, `reservedIncomingShiftId`, `reservedAt`, `terminalEvidenceRef`, `unreadable` |
| guard history | `present`, `unreadable`, `entries[]` (`id`, `ownerLifecycleState`, `guardRevision`, `fencingEpoch`, `outgoingSlotToken`, `terminalEvidenceRef`) sorted by `id` |
| legacy handover | `present`, `id`, `lifecycleStatus` |
| outgoing shift | `present`, `id`, `status`, `actualStart`, `actualEnd`, `handoverStartedAt`, `permanentPairId`, `primaryTechnicianIds` (as recorded order), `unreadable` |
| slot | `present`, `slotStatus`, `shiftId`, `shiftStatus`, `slotToken`, `generation`, `updatedAt`, `unreadable` |
| window | `scheduledStart`, `scheduledEnd`, `latestActivationAt`, `closedAtEvaluation` |
| commit receipt | `present`, `id`, `receiptHash`, `valid` |
| activation receipt | `present`, `id`, `receiptHash`, `valid` |
| incoming shift | `present`, `id`, `status`, `actualStart` |
| applications | `entries[]` in aggregate `incomingTechnicianIds` order: `technicianUid`, `receiptId`, `present`, `receiptHash`, `outcome`, `evidenceKind`, `auditId`, `auditPresent`, `unreadable` |
| memberships | `entries[]` sorted by id: `id`, `present`, `joinedAt`, `leftAt` |
| attendance | `entries[]` sorted by id: `id`, `present`, `clockIn`, `clockOut` |
| evidence | `entries[]` sorted by id: `id`, `technicianUid`, `kind`, `present`, `finalizedAt`, `snapshotHash`, `guardRevision`, `fencingEpoch`, `operationId`, `operationPresent`, `operationStatus`, `operationInterrupted`, `legacyOperationId`, `legacyOperationPresent`, `legacyOperationStatus`, `legacyOperationInterrupted`, `requestDigest`, `unreadable` |
| reconciliation | `entries[]` per UID sorted by UID: `technicianUid`, `status`, `reason` |
| report | `present`, `id`, `reportDigest`, `evidenceSnapshotHash`, `frozenAt`, `verified` |
| review case | `present`, `id`, `status`, `caseRevision`, `fingerprint` |

**Deliberately excluded** (non-authoritative for this decision): evaluation time, actor identity,
response formatting/labels, `createdAt`/`updatedAt` of approval or review records, and any field this
table does not list. Excluding them is what makes "equivalent reads → identical digest" hold across
processes, locales and repeated evaluations.

**Compatibility rules**

1. `schemaVersion` increments on any added, removed or renamed material field, or on any change to
   canonical ordering. A digest is only comparable within one schema version.
2. A stored digest is never recomputed under a newer schema. Consumers must treat
   `{digest, schemaVersion}` as the complete identity.
3. A missing document and a present-but-empty document are different digests (`present` differs).
4. A present document whose content changes in any listed field changes the digest; a change to an
   unlisted field does not, by design.
5. The service is the only producer. The caller cannot supply, override or truncate the digest.

## 5. HTTP contract (read-only)

`GET /api/admin/recovery-eligibility?handoverDocumentId=handover_v2_<shiftSlug>`

| Condition | Result |
| --- | --- |
| Any method other than `GET` | `405`, answered by the framework before the route runs. No eligibility payload is returned and no `Allow` header is emitted |
| V2 disabled | `404` `{success:false, error:"Not found."}` before any identity work |
| No session / disabled / suspended / role-changed account | `401` |
| Role not `admin`/`supervisor`, or `mustChangePassword` | `403` |
| Live profile no longer matches the session claim | `403` with `code:"ELIGIBILITY_FORBIDDEN"` |
| Malformed or missing `handoverDocumentId` | `400` with `code:"ELIGIBILITY_INVALID_HANDOVER"` |
| Evaluated (eligible or refused) | `200` with the classification document |
| Unreadable store / unexpected failure | `503` `{success:false, code:"ELIGIBILITY_UNAVAILABLE"}` — never a classification |

Every response: `Cache-Control: no-store`, `executionAuthorized:false`, `executionAuthority:"none"`,
`recoveryExecutionEligible:false`, `readModelStability:"point_in_time_transaction"`, and a
`concurrencyNotice` that states the read is not an execution authorization. Identity comes only from
the session cookie; query parameters and headers cannot add or change a viewer. No password, token,
cookie, receipt hash secret or personal proof material is returned; receipt *hashes* are public
integrity references and are included by design.

Response body:

```json
{ "success": true,
  "eligibility": {
    "schema": "handover-recovery-eligibility-v1",
    "schemaVersion": 1,
    "evaluatedAt": "<server ISO>",
    "executionAuthorized": false,
    "executionAuthority": "none",
    "handoverDocumentId": "...", "outgoingShiftId": "...", "incomingShiftId": "...",
    "classification": "activation_window_open",
    "reason": "…",
    "refusals": [ { "code": "activation_window_open", "detail": "ACTIVATION_WINDOW_OPEN", "message": "…" } ],
    "evidenceDigest": { "schema": "handover-recovery-eligibility-evidence", "schemaVersion": 1,
                        "algorithm": "sha256", "value": "<64 hex>" },
    "references": { "guardId": "…", "activationReceiptId": "…", "commitReceiptId": "…",
                    "applicationReceiptIds": ["…"], "reviewCaseId": "…", "slotGeneration": 1,
                    "scheduledEnd": "<ISO>", "latestActivationAt": "<ISO>" },
    "readModelStability": "point_in_time_transaction",
    "concurrencyNotice": "This is a point-in-time read. It is not an execution authorization; …"
  },
  "recoveryExecutionEligible": false }
```

`references` contains identifiers and window timestamps only — never document bodies, never
credentials.

### 5.1 Verification harnesses

The read-only contract is verified against a disposable emulator stack, never the protected UAT
environment:

- `tests/run-recovery-eligibility-http.ps1` starts Firestore/Auth on isolated ports, starts two
  Next dev servers (gate on/off), and runs the suite through `firebase emulators:exec`.
- `tests/run-recovery-eligibility-http.mjs` manages both servers, their distinct `NEXT_DIST_DIR`
  values, readiness probes, the gate-direction assertion (`GET` answers `401` when enabled and `404`
  when disabled; `POST` answers `405` in both directions), and teardown.
- `tests/recovery-eligibility-http-emulator.test.mjs` seeds a committed v2 handover exclusively
  through production services (`prepareEqualHandoverReport` → `freezeEqualHandoverReport` → four
  `confirmEqualHandoverParticipantV2` → `commitEqualHandoverOutgoingV2`), closes the activation window
  on server time, then exercises authentication, authorization, method, id validation, classification,
  digest stability, tamper resistance, zero-write behaviour and response hygiene over real
  authenticated HTTP.

## 6. V2 approval boundary (design only — not implemented)

A future V2 approval must bind to the digest, not to a handover id:

- `approvalBindingV2 = { handoverDocumentId, evidenceDigest, evidenceDigestSchemaVersion,
  classification, aggregateRevision, guardId, guardGuardRevision, guardFencingEpoch, slotToken,
  slotGeneration, approvalIntentVersion: 2 }`.
- The V2 record stores `evidenceDigestSchemaVersion` and **refuses** to execute or countersign when the
  live re-evaluation returns a different version or a different digest.
- Execution (a later milestone, not authorized here) must re-evaluate inside its own transaction and
  require `classification === "eligible_for_abandonment_review"` **and** an exact digest match before
  any write. A digest mismatch is `RECOVERY_EVIDENCE_CHANGED` and writes nothing.
- V1 approvals are never converted, upgraded or re-read as V2. `recoveryExecutionEligible` stays
  `false` on every V1 record forever (8C.2b invariant). No V2 route, collection or schema exists in
  this milestone.

## 7. Residual assumptions

- **A-1** (8C.1): Firestore absent-document reads inside a transaction are assumed to participate in
  conflict detection. The eligibility service is read-only, so it cannot be *fenced* by that
  assumption. The repository's transactional fixture exercises the behaviour (test 35: a concurrent
  write that creates the previously absent incoming shift forces a retry, and the injected write is the
  only write in the evaluation), but this phase does not re-prove it against the real emulator. It
  remains load-bearing only for a future executor.
- **A-2** (8C.1): atomic and legacy acceptance-receipt ids are equivalent by construction. Phase 8C.3
  verifies this with an executed equivalence test: `createLegacyIncomingAcceptanceEventId` is the
  shared derivation now consumed by the pre-atomic writer and by the eligibility reader, and the test
  asserts both derivations produce the same deterministic id.
- The completeness argument in §3.1 depends on the writer inventory being exhaustive. The tests pin
  the ID derivations; they cannot prove that no *unknown* writer exists. That residual risk is stated,
  not hidden, and is the reason `eligible` never authorizes execution by itself.
