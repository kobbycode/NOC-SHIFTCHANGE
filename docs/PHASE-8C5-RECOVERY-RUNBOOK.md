# Phase 8C.5 — Recovery execution runbook

**Applies to:** `POST|GET /api/admin/recovery-approvals-v2/{approvalId}/execute`
**Status:** matches the code as of `fa4dc09`. The HTTP contract is proved by
`tests/recovery-execution-http-emulator.test.mjs` (test 07) against two real Next.js servers. The
sequence below — routes, bodies, responses, refusals and the PowerShell around them — was then executed
end-to-end against the disposable `demo-admin-review-8b` stack on 2026-11-09.

This is the operator-facing path for abandoning a **stalled equal handover**. It does not replace the
approval procedure; it consumes an approval that has already been signed twice. When the app ships
the 8C.6 recovery panel, that panel is the same path in a browser; this runbook remains the fallback
and the reference for the exact requests.

---

## 1. What you are doing

1. A handover is stalled: the outgoing shift is `handover_pending`, the incoming technicians never
   accepted, and the incoming activation window has closed.
2. A supervisor and an administrator sign one recovery intent (approval V2).
3. An administrator executes it. One transaction cancels the outgoing shift, releases the technicians
   and their schedules, advances the global operational slot, cancels the reservation guard, marks the
   handover cancelled, and writes one audit row.

**Execution re-checks everything.** The approval is intent only: it always reports
`recoveryExecutionEligible: false`, and every precondition is re-evaluated inside the transaction that
writes. An approval does not make a stale state executable.

**Terminal.** Abandonment has no inverse operation. There is no un-abandon path in the codebase; the
next shift must be created through the normal scheduling flows.

---

## 2. Prerequisites

| Requirement | Detail |
| --- | --- |
| Gate | `HANDOVER_V2_DEV=true` **and** `HANDOVER_RECOVERY_EXECUTION_ENABLED=true` in the app process. With either missing, both methods answer `404`. |
| Executor | An administrator whose profile is `active`, has no pending `statusOperation`, and does not need a password change. The executor is the **session subject**; the body cannot name one. |
| Signers | One supervisor and one administrator (complementary roles), each signing with their own password. |
| Origin | `POST` requires an `Origin` header equal to the application origin. |
| Shell | Windows PowerShell 5.1 or later. On 5.1 a bare `Cookie` passed through `-Headers` is **silently dropped**; attach the cookie with the `WebRequestSession` helper in §3. PowerShell 7 accepts either form. |
| Window | The incoming activation window must be genuinely closed. If it is still open you get `RECOVERY_WINDOW_OPEN`. |
| Environment | Do this against a disposable stack first. Section 6 lists the boundary the suites use. |

---

## 3. The sequence

Set up the variables once (PowerShell):

```powershell
$APP = "http://127.0.0.1:3198"          # never a production host while §7 stands
$HANDOVER_DOCUMENT_ID = "handover_v2_outgoing"
$EMAIL                = "<actor email>"    # repeat the exchange below for each signer and the executor
$PASSWORD             = "<from your credential store>"
$SESSION_SUPERVISOR   = "<__session cookie value for the supervisor>"
$SESSION_ADMIN        = "<__session cookie value for the administrator>"
```

In a browser, sign in normally and copy the `__session` cookie. On a local stack you can mint it:

```powershell
# 1. exchange credentials for an idToken (emulator form)
$body = @{ email = $EMAIL; password = $PASSWORD; returnSecureToken = $true } | ConvertTo-Json
$idToken = (Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:10099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local" -ContentType "application/json" -Body $body).idToken

# 2. exchange the idToken for the session cookie
$session = Invoke-WebRequest -Method Post -Uri "$APP/api/auth/login" -ContentType "application/json" `
  -Headers @{ Origin = $APP } -Body (@{ idToken = $idToken } | ConvertTo-Json)
$SESSION_ADMIN = (($session.Headers["Set-Cookie"] -join ";") -split ";" |
  Where-Object { $_ -match "^__session=" } | Select-Object -First 1).Trim()
```

Whatever produced the cookie — a browser copy or the exchange above — attach it to a session object:

```powershell
# Windows PowerShell 5.1 drops a Cookie header set through -Headers, so the
# cookie goes through a WebRequestSession. This works on 5.1 and 7 alike.
function New-ApiSession([string]$CookieValue) {
  $value = $CookieValue -replace "^__session=", ""
  $web = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $web.Cookies.Add((New-Object System.Net.Cookie("__session", $value, "/", ([uri]$APP).Host)))
  return $web
}

$WEB_SUPERVISOR = New-ApiSession $SESSION_SUPERVISOR
$WEB_ADMIN      = New-ApiSession $SESSION_ADMIN
```

Passwords are never recorded here. Supply them at the prompt from your own credential store. The
`reason` must be at least 10 characters; a shorter one is a `400`.

### Step 1 — create the intent (supervisor)

```powershell
$request = @{
  handoverDocumentId = $HANDOVER_DOCUMENT_ID     # e.g. handover_v2_outgoing
  reason             = "Stalled outgoing handover; incoming never accepted."
  idempotencyKey     = "recovery-request-$(Get-Date -Format yyyyMMdd-HHmmssfff)"
  password           = $PASSWORD                 # the supervisor's own password
} | ConvertTo-Json

$created = Invoke-RestMethod -Method Post -Uri "$APP/api/admin/recovery-approvals-v2" `
  -ContentType "application/json" -Headers @{ Origin = $APP } -WebSession $WEB_SUPERVISOR -Body $request

$APPROVAL_ID = $created.approval.approval.id
$created.approval.effectiveStatus        # awaiting_second_approval
$created.approval.recoveryExecutionEligible   # false, always
```

### Step 2 — countersign (administrator, complementary role)

```powershell
$second = @{ expectedRevision = 1; password = $PASSWORD } | ConvertTo-Json
$signed = Invoke-RestMethod -Method Post -Uri "$APP/api/admin/recovery-approvals-v2/$APPROVAL_ID/approvals" `
  -ContentType "application/json" -Headers @{ Origin = $APP } -WebSession $WEB_ADMIN -Body $second

$signed.approval.effectiveStatus              # fully_approved
$signed.approval.approvalCount                # 2
```

The intent expires 24 hours after it is created (`RECOVERY_APPROVAL_EXPIRED` after that). Expired or
voided intents must be recreated; they are never revived.

The intent's identity is derived from the handover and **the current evidence**, not from the
idempotency key. Repeating the same request while the evidence is unchanged returns the existing
approval with HTTP `200` and `replayed: true`; sending a different reason against the same evidence is
a conflict. A genuinely new intent needs the evidence to move, or a void followed by a reissue. The key
is recorded for audit and keeps concurrent attempts distinct within one second — it does not create a
second intent.

### Step 3 — execute (administrator)

```powershell
$execute = @{
  reason         = "Executing the approved recovery."
  idempotencyKey = "recovery-execute-$(Get-Date -Format yyyyMMdd-HHmmssfff)"
} | ConvertTo-Json

$result = Invoke-RestMethod -Method Post -Uri "$APP/api/admin/recovery-approvals-v2/$APPROVAL_ID/execute" `
  -ContentType "application/json" -Headers @{ Origin = $APP } -WebSession $WEB_ADMIN -Body $execute

$result.status                     # committed
$result.execution.auditId          # audit_logs/{auditId}
$result.execution.executedBy       # the administrator uid
$result.execution.executedAt       # ISO timestamp
$result.recoveryExecutionEligible  # false
```

The body admits exactly `reason` and `idempotencyKey`. Any other key — `actorUid`, `handoverDocumentId`,
anything — is a `400`. That is deliberate: the payload carries no authority.

### Step 4 — confirm

```powershell
$read = Invoke-RestMethod -Method Get -Uri "$APP/api/admin/recovery-approvals-v2/$APPROVAL_ID/execute" `
  -WebSession $WEB_ADMIN

$read.execution.applied          # true
$read.execution.auditId          # same id as the commit response
```

`GET` answers from the audit row and never guesses: `applied: false` means no committed abandonment
exists for that approval.

---

## 4. What the commit writes

One transaction. If it commits, all of the following happened; if it refuses, nothing was written.

| # | Document | Change |
| --- | --- | --- |
| W1 | `shifts/{outgoingShiftId}` | `status: cancelled`, `cancelledAt`, `cancelledBy`, `updatedAt` (`actualEnd` untouched) |
| W2 | `operational_shift_control/global` | successor token, `generation + 1`, pending |
| W3 | `shift_members/*` for the outgoing shift | `leftAt` set on every live member |
| W4 | `technician_schedules/{uid}` | the outgoing entry removed, all other entries and `metadata` preserved |
| W5 | `equal_handovers_v2/{handoverDocumentId}` | `lifecycleStatus: cancelled` (revision unchanged — see §7) |
| W6 | `handover_reservation_guards/*` | cancelled, revision + 1, fencing epoch advanced, `terminalEvidenceRef` = audit id |
| W7 | `audit_logs/{auditId}` | created once; carries approval binding, slot before/after, activation window, evidence digest, negative proof, reason, idempotency key |

Never written by the executor: `users`, `shift_attendance`, attendance evidence, notifications,
`handovers/`.

---

## 5. Refusals and what to do

| HTTP | Code | Meaning | Action |
| --- | --- | --- | --- |
| 401 | — | No live session. A suspended profile also lands here. | Sign in again; check the profile is active. |
| 403 | — | Not an administrator, or password change pending, or cross-origin `POST`. | Use an administrator session from the application origin. |
| 409 | `RECOVERY_NOT_APPLICABLE` | The classifier does not consider this handover recoverable. | Read the `details.classification`; not every stalled state is abandonment. |
| 409 | `RECOVERY_WINDOW_OPEN` | The incoming technicians can still accept. | Wait for the window to close. Do not force it. |
| 409 | `RECOVERY_ACCEPTANCE_EXISTS` | An acceptance already happened. | Not an abandonment case; follow the normal lifecycle. |
| 409 | `RECOVERY_STATE_INCONSISTENT` | Stored documents disagree with the classifier (roster, schedule, shift, guard). | Stop. Investigate the listed state; do not retry blindly. |
| 409 | `RECOVERY_APPROVAL_STALE` | Evidence moved after approval (new review case, changed digest). | Create a new intent. |
| 409 | `RECOVERY_APPROVAL_EXPIRED` | Older than 24 h. | Create a new intent. |
| 409 | `RECOVERY_APPROVAL_INVALID` | Unknown, voided, unsigned, or wrong-shape approval. | Check the approval id and its `effectiveStatus`. |
| 409 | `RECOVERY_STALE_OR_APPLIED` | Aggregate revision/snapshot no longer matches the binding. | Re-read the aggregate; create a new intent if recovery is still right. |
| 409 | `RECOVERY_ALREADY_APPLIED` | The intent was consumed by an earlier commit. | Use `GET` to confirm; nothing more to do. |
| 503 | `HANDOVER_RECOVERY_OUTCOME_UNKNOWN` | The transaction failed without a tagged refusal. | **Verify, do not guess:** see below. |

`OUTCOME_UNKNOWN` is the only refusal where the response says `notCommitted: false`. Read back with
`GET`. `applied: true` → done, the commit happened. `applied: false` → no commit exists, and a retry is
safe: the audit id is derived from the approval id, so the retry either commits once or returns
`already_applied`. A committed retry always answers `already_applied` with the original outcome and
writes nothing.

---

## 6. Environment boundary

| Purpose | Project | Ports |
| --- | --- | --- |
| Execution HTTP suite (already green) | `demo-admin-review-8b` | Firestore 8980/9980, Auth 10099, apps 3198 (gate on) / 3199 (gate off) |
| Execution service suite | `demo-recovery-execution-8c5` | Firestore 8191/9091, hub 4419, logging 4519 |

Run the suites with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run-handover-recovery-execution-emulator.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run-handover-recovery-execution-http.ps1
```

The HTTP harness takes roughly 15 minutes on this machine because webpack dev compiles each new route
on first touch. Its TAP stream is mirrored to `.demo/recovery-execution-http-tests.log`.

---

## 7. What this runbook assumes

These are the executor's adopted defaults, recorded with their reasons in
[PHASE-8C5-RECOVERY-EXECUTION.md](PHASE-8C5-RECOVERY-EXECUTION.md) §7. They are what the suites verify,
they are reversible, and none is configurable at run time:

1. **W5 revision** — the aggregate keeps its revision at abandonment; the 8C.1 text said `+1`.
2. **W8 consumption** — the signed approval is never mutated; the create-once audit row proves
   consumption, so a committed retry answers `already_applied` instead of refusing.
3. **No password at execution** — a live administrator session is required, not a re-entered password.
4. **No notification** is produced by an abandonment.
5. **No activity marker** is written to the actor's user document.
6. **Two operator surfaces** — the 8C.6 panel (administrator handover review page, plus the supervisor
   signature on the v2 handover detail page) and this runbook. The panel sends the same requests and
   offers execution only after the gated read-back succeeds.

The gate is not a default you can rely on: keep `HANDOVER_RECOVERY_EXECUTION_ENABLED` unset outside
the disposable stacks. With the flag unset the endpoints do not exist.
