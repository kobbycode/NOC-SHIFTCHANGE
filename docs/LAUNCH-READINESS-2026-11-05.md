# LAUNCH READINESS — Online deployment audit for Firebase project `shiftchange20-e4265`

Date: 2026-11-05
Repository: `C:\Users\Jonah\Desktop\KobbyProject\NOC-SHIFTCHANGE`
Branch: `feature/handover-v2-recovery`
HEAD: `c1703530437ff4e45010dde4f920597fe7684d9f` (unchanged throughout; equals the tip of `origin/feature/handover-v2-recovery`)

Brief: the owner's nine launch priorities, with these standing prohibitions in force —
do not delete or recreate the administrator account; do not modify live Firestore data; no deploy,
security-rule change, billable cloud resource or code push without explicit authorization; preserve
all repository work and the protected UAT environments; stop after readiness verification and report.

Owner decisions taken during this audit (2026-11-05): the owner re-authenticated `firebase-tools` so
authenticated **live reads** were possible; the disposable lifecycle stack may be restarted and re-run;
first release posture is **Handover v2 ON, push notifications OFF**.

---

## 0. Verdict

**NO-GO today. GO once three authorizations are granted and two live checks come back clean.**

The application itself is ready: it builds cleanly from a fresh clone state, and the complete operational
lifecycle — account provisioning, supervisor pairing, scheduling, attendance, evidence, handover v2, the
four confirmations, both atomic acceptances and guard finalization — passes **34/34 over HTTP against a
production `next start` bundle** on a disposable stack, run 4 of the launch workstream. The live Firebase
project is reachable, the existing administrator account satisfies every gate the login route and the
session verifier apply, and it is in a state where signing in **writes nothing**.

What blocks is delivery, not the product:

- **B-1 (decisive).** Firebase App Hosting builds from a **GitHub connection**. The code that was built and
  verified today is not on GitHub: `git status` reports **187 uncommitted paths** (50 modified + 137
  untracked), of which **97 are under `src/`**. `origin/feature/handover-v2-recovery` is at `c170353`, and
  the working tree has diverged from it. Whatever backend is created now would build a strictly older
  application — one that lacks the 8A supervisor scheduling UI, the 8B admin review surfaces and the whole
  8C handover-v2 recovery contract. Deploying is meaningless until commit + push is authorized.
- **B-2.** `Auth → Settings → Authorized domains` currently allows only `localhost`,
  `*.firebaseapp.com` and `*.web.app` (live read, 2026-11-05). The App Hosting serving origin is
  `…-<region>.run.app`, which is not in that list, so `signInWithEmailAndPassword` from the browser would
  be refused by the Auth REST guard immediately after a successful deploy. The domain has to be added —
  an authorized console/CLI change.
- **B-3.** This machine has **no Application Default Credentials, no `gcloud`, no service account**.
  `src/lib/firebase/admin/index.ts:21-39` uses `applicationDefault()`, so a local production boot against
  `shiftchange20-e4265` throws at the first Admin SDK call. Priority 5 ("verify the administrator can log
  in through the actual application") therefore **cannot be closed locally against the live project**; it
  is closable only after the backend exists, or by supplying a credential — and either way that first login
  is a live-project event that needs its own authorization.

Two live facts could not be read with the CLI's OAuth scopes and must be confirmed in the Console
before GO (§3, checks C-1 and C-2).

---

## 1. Priority 1 — the existing administrator account (verified, preserved)

Read read-only on 2026-11-05 through the CLI's own in-process auth module (`.demo/launch-live-profile.mjs`).

| Field | Live value | Gate applied by the code |
| --- | --- | --- |
| `users/TH13esciAvbkwb2BVdQij0MDLLL2` → `role` | `admin` | must be a valid user role **and** equal to the ID-token claim |
| → `status` | `active` | `src/app/(auth)/api/auth/login/route.ts:71-74` |
| → `statusOperation` | absent / `null` | same line — a pending account-status operation blocks sign-in |
| → `mustChangePassword` | `false` | `route.ts:94-96` and `src/lib/auth/session.ts:109` would otherwise force a redirect |
| `system/bootstrap_admin` | `completed: true` | provisioning seam already closed; no re-bootstrap needed |

The account was **not** touched: no write, no disable, no re-bootstrap, no credential rotation.

**Why a live login is write-free.** The login route verifies the password via the session coordinator,
re-reads the profile, compares the token claim against `profile.role`, mints a `__session` cookie
(`route.ts:82`, set at `:100`) and returns. There is no Firestore write on the success path. The one
adjacent route that **does** write is the forced change-password flow
(`src/app/(auth)/api/auth/change-password/route.ts:198-209, :223-229` — `batch.update(users/{uid})` plus an
`audit_logs` entry); with `mustChangePassword: false`, that path is not entered. So priority 5 can be
performed without violating "do not modify live Firestore data" — **but it still writes a Firebase Auth
`lastRefreshAt`/session side-effect and should be announced before it happens.**

**Not obtainable with the CLI (needs Console, check C-1):** the Auth record's `disabled` flag and the
`role` custom claim (`customAttributes`). `authManagement` `accounts:lookup` returned permission-denied for
the CLI's granted scopes (`.demo/launch-live-account.mjs`, both attempts BLOCKED). The inference in favour
of both is the provisioning tool itself: `scripts/bootstrap-admin.mjs` creates the user with `disabled: false`
at `:63-68` and sets the claim `{role: "admin"}` at `:73-75`, immediately before writing the `users/{uid}`
profile with the same role at `:81-92`. The live profile read above matches that path, and `mustChangePassword`
now reads `false` where the bootstrap wrote `true` (`:88`), which shows the owner later rotated the password
through the real flow. Inference is not a read, though, and the login gate rejects when claim and profile
disagree (`decoded.role !== profile.role`). Confirm both in `Console → Authentication → Users` (email,
*disabled = No*, Additional claims `role=admin`).

---

## 2. Priority 2 — live Firestore inventory (inspected, unmodified)

Corrections made during this audit: an early pass reported "no Firestore database / 0 collections" — that
was a harness bug (`Client.get()` returns `{status, response, body}`; the unwrapped read was discarded).
The numbers below are the re-run values, cross-checked against `firebase firestore:databases:list`,
`firebase firestore:indexes`, `firebase apps:list` and `firebase apphosting:backends:list`.

| Item | Live state |
| --- | --- |
| Project | `shiftchange20-e4265`, project number `1042059464078`, state ACTIVE, Blaze plan |
| Firestore database | `(default)`, mode `FIRESTORE_NATIVE`, region **`nam5`** |
| Collections | **3**: `audit_logs`, `system`, `users` |
| Composite indexes | **0** |
| App Hosting backends | **0** |
| Auth providers | Email/Password **enabled** |
| Authorized domains | `localhost`, `*.firebaseapp.com`, `*.web.app` |
| Web app | `1:1042059464078:web:b769f6fb314ea5b848e8df` |

No document was written, updated or deleted anywhere in this audit.

**Security rules.** The repository's root `firestore.rules` is deny-all
(`match /{document=**} { allow read, write: if false; }`). That is safe *for this app* because there is no
client-side Firestore access at all — the only `firebase/app` + client-Firestore import is
`src/lib/firebase/client.ts:14-17`, and its sole consumer is the login page's Auth object; every read and
write goes through API routes using the Admin SDK, which bypasses rules. The **deployed** rules text could
not be read with the CLI scopes (check C-2); it must be confirmed to be at least as restrictive as the
repository file before GO.

**Missing from the repository.** There is no root `firebase.json`, no root `firestore.indexes.json` and no
`apphosting.yaml`. The three drafts prepared during this audit are in `.demo/launch-live-config/`
(gitignored) and are *not* applied — see §4.

---

## 3. Priorities 3–4 — production build, App Hosting compatibility, and the online configuration

### 3.1 Build

Two clean builds were produced today from the working tree, each into its own gitignored `distDir` so no
protected environment's build output was overwritten:

| distDir | Configured for | Result |
| --- | --- | --- |
| `.next-launch-1105` | live `shiftchange20-e4265` env (emulator vars explicitly unset) | success, 27 routes, Typecheck passed — `.demo/launch-build-2026-11-05.log` |
| `.next-launch-1105-p8a2r` | disposable `demo-lifecycle-p8a2r` env | success, 27 routes, Typecheck passed — `.demo/launch-build-2026-11-05-p8a2r.log` |

`next` 16.3.5 (App Router, Turbopack), React 19.2.8, `firebase` ^12.19.0, `firebase-admin` ^14.4.0,
`package-lock.json` present and tracked, `next.config.ts` tracked, no `engines` field. `functions/` is a
separate nodejs22 bundle and is only needed for push, which is off.

Both builds appended their `distDir` globs to `tsconfig.json → include` (`next build` does this
automatically); both edits were reverted, and `tsconfig.json` now shows only the owner's pre-existing
modification — no launch residue.

### 3.2 App Hosting compatibility — assessed, with one documentation caveat

Firebase documents App Hosting's preconfigured Next support for **Next 13.5.x–15.2.x with Node 22+**.
This project is Next **16.3.5**, outside the enumerated range. The mitigation is the explicit
`scripts.buildCommand` / `scripts.runCommand` / `outputFiles.serverApp.include` configuration, which opts
out of the framework adapter and builds the app exactly the way the local production bundle was built and
verified. That is a *supported escape hatch*, but it means the release does not inherit adapter behaviour
and must be smoke-tested after the first deploy rather than assumed. `runCommand: next start --port $PORT`
is the same `next start` process the 34/34 lifecycle run drove.

App Hosting requires a GitHub connection and builds a commit. It cannot build a local working tree, which
is B-1.

### 3.3 The `.env.local` landmine — proven, and how to disarm it

`@next/env` loads `.env.local` even in a production `next start` process. The repository's local
`.env.local` points at emulator hosts. A `next start` booted in that directory therefore silently
inherits `FIREBASE_AUTH_EMULATOR_HOST` / `FIRESTORE_EMULATOR_HOST`, and the Admin SDK — which truthiness-
checks those variables (`node_modules/firebase-admin/lib/auth/auth-api-request.js:2050-2058`) — talks to a
loopback emulator instead of the live project. **One earlier boot test in this audit was contaminated by
exactly this and its result is not cited anywhere as live evidence.**

Defenses, both required:
1. Launch a live bundle with the emulator variables explicitly set to the **empty string** in the process
   environment (`FIREBASE_AUTH_EMULATOR_HOST=` etc.). Empty string is falsy for the truthiness check, so
   emulator mode is genuinely off — merely "not mentioning them" is not enough.
2. The `.demo/launch-live-config/apphosting.yaml` draft omits `FIREBASE_AUTH_EMULATOR_HOST`,
   `FIRESTORE_EMULATOR_HOST`, `GCLOUD_PROJECT` and `GOOGLE_CLOUD_PROJECT` **on purpose**, and pins
   `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=false`.

Additional defense in depth, already in code: `src/lib/firebase/client.ts:59-126` throws
`"Firebase emulator mode requires an isolated emulator project."` for any project id outside the closed
allowlist of isolated emulator environments, so a live project id combined with emulator mode is a hard
startup failure rather than a quiet misroute.

`.env.local` is gitignored, so this is a **local-launch** hazard, not a hosted-runtime one. It still has
to be in the launch runbook, because the first live login test (priority 5) is most likely to be done
locally.

### 3.4 Live configuration drafts (prepared, not applied)

- `.demo/launch-live-config/firebase.json` — `{"firestore": {"rules": "firestore.rules", "indexes":
  "firestore.indexes.json"}}`. No `functions` key, consistent with push being off.
- `.demo/launch-live-config/firestore.indexes.json` — the two composite indexes the code actually queries:
  `notifications` (`recipientUid` + `createdAt` desc) from
  `src/lib/notifications/notification-service.ts:44-48`, and the outbox claim query (`status` in +
  `nextAttemptAt` <=) from `src/lib/notifications/outbox-worker.ts:188-192`. Under "push OFF" neither
  query runs, so **0 live indexes is not a launch blocker** — but the file must be deployed *before*
  notifications are ever enabled.
- `.demo/launch-live-config/apphosting.yaml` — build/run commands, `.next` output inclusion,
  `minInstances: 0 / maxInstances: 1 / cpu: 1 / memoryMiB: 512`, the six `NEXT_PUBLIC_FIREBASE_*` values
  verified byte-equal against live `apps:sdkconfig WEB` (`authDomain`
  `shiftchange20-e4265.firebaseapp.com`, `storageBucket` `shiftchange20-e4265.firebasestorage.app`,
  `senderId` `1042059464078`, `appId` `1:1042059464078:web:b769f6fb314ea5b848e8df`), `FIREBASE_PROJECT_ID`,
  the owner's `HANDOVER_V2_DEV=true` + `HANDOVER_V2_ATOMIC_ACCEPTANCE=true`, notifications left unset, and
  `APP_ORIGIN=https://REPLACE-WITH-BACKEND-URI` as a placeholder that **must** be replaced with the exact
  public origin. `NEXT_PUBLIC_FIREBASE_API_KEY` is deliberately a plain console variable, not a Secret
  Manager reference: it is a browser key that ships inside the client bundle, and routing it through
  Secrets would need extra service-agent IAM before the build could read it.

Console environment values override `apphosting.yaml`, so the file is the floor, not the last word.

---

## 4. Priorities 5–8 — end-to-end verification, and what it does and does not cover

### 4.1 What was run, and why not against live

Priorities 6–8 require creating accounts, pairs, shifts, records and handovers. Those are live Firestore
writes, which the brief forbids. The conflict was resolved by verifying the **whole flow on the disposable
stack** (`demo-lifecycle-p8a2r`, app 3280, auth 9999, firestore 8880, all in-memory) with today's fresh
production bundle, and recording live-write coverage as a gated decision (§6).

**Run 4: 34 steps, 34 pass.** `.demo/launch-lifecycle-run4.log`,
`runId a2512465-f620-4e9f-b224-e212a8c57045`, terminal `lifecycleStatus: completed`,
incoming shift `shift_v2c_f5e158d26d900e8b0c01be4d7ee0ad67e398c82e` status `active`. It covers, in order:
admin session → provision supervisor and technicians → password rotation → technician-pair create and
confirm → schedule the incoming shift → activate → attendance for both outgoing technicians → operational
evidence → handover v2 begin / reserve / report / freeze → four confirmations → commit → **both atomic
acceptances** → guard finalize (normal closure) → and the negative paths: a technician blocked from the
administrator review queue (403), a supervisor blocked from provisioning (403), the legacy acceptance route
refusing while the atomic gate is on (`ACCEPTANCE_ATOMIC_PROTOCOL_ENABLED`), an unauthenticated write
(401) and a cross-origin write (403). Authority and origin enforcement are therefore proven on the same
bundle that ships.

### 4.2 Priority 7 item-by-item

| Item | Result | Evidence |
| --- | --- | --- |
| Supervisor and technician account creation | **verified** | run 4 provision steps, 34/34 |
| Supervisor pairing | **verified** | pair create + both technician confirmations |
| Shift scheduling | **verified** | incoming shift scheduled for a paired supervisor |
| Forms A–E | **partial — see below** | run 4 recorded `broadcast` per enabled station + one `no_ob` |
| Personal confirmations | **verified** | four confirmations before freeze/commit |
| Incoming acceptance | **verified** | both atomic acceptances, `outcome=subsequent_join`, guard `pending` → `completed` |
| Automatic shift activation | **does not exist as a timer** | see below |

**Forms A–E.** There are no named Form A–E entities in the product; the equivalent capture is the
operational-event taxonomy — `broadcast`, `incident`, `outside_broadcast`, `no_ob`
(`src/lib/operations/shift-operations-domain.ts:25,28`, UI at
`src/components/operations/shift-operations-workspace.tsx:32`). Phase 7 recorded the same conclusion
(`docs/PHASE7-PRODUCT-READINESS-AUDIT.md:99`, "PARTIAL"). Run 4 exercises `broadcast` and `no_ob`;
**`incident` and a real `outside_broadcast` were never exercised on a production bundle** in this
workstream, even though `shift-operations.ts:106` gives them an update path the other kinds do not have.
Not a launch blocker for a first release — they are reachable through the same verified route — but it is
an honest gap and the first real shift will be their first production use.

**Automatic shift activation.** There is no server-side scheduler that flips a shift to `active`. Activation
is a *route* a technician calls, bounded by a window of `EARLY_MINUTES: 15` / `LATE_MINUTES: 60`
(`src/lib/operations/shift-activation-window.ts:26-27`). If nobody opens the app in the window, nothing
activates by itself. If the brief expects unattended activation, that expectation is unmet by design and
needs a product decision, not a deploy.

### 4.3 Priority 8 — task-management and notification defects

- **Notifications: inert by decision, and consistent with it.** With `NOTIFICATIONS_ENABLED`,
  `NEXT_PUBLIC_NOTIFICATIONS_ENABLED`, `NOTIFICATIONS_TRANSPORT` and the VAPID key unset, the outbox,
  inbox, bell and `functions/` push path never fire. No blocking defect. Two prerequisites exist for when
  they are turned on: the two composite indexes (§3.4) and a `functions` deploy — plus the 09L owner
  browser retest that is still outstanding in the phase record.
- **Task assignment response: a real gap.** The API has three routes for responding to an assignment —
  `…/assignments/{assignmentId}/accept`, `/reject` and `/reassign` — but the client layer only calls
  `accept` (`src/lib/tasks/task-api.ts:295`). **`reject` and `reassign` have no client function and no UI
  wiring**, so a technician cannot decline an assignment and a supervisor cannot reassign through the
  application. The reject route's own success text says responsibility "remains pending administrator
  review" (`…/reject/route.ts:156`), which is exactly the state the UI cannot reach. Not a launch blocker
  — task creation, listing and acceptance all work — but it is the one defect in the brief's own words
  ("blocking task-management … defects") worth naming: the task lifecycle is only partly operable from
  the product.
- 8C.4B (dual-approval recovery service) remains **paused and uncommitted** with OD-1…OD-4 open
  (`docs/PHASE-8C4B-RECOVERY-APPROVAL-V2.md` §6–§7). It has no HTTP route importer, so its absence does
  not change deployed behaviour, and the 8C recovery surface cannot be used from a released build.

---

## 5. Exact deployment steps

Each step is tagged with the authorization it consumes. Nothing below has been performed.

**Preconditions (owner, Console — no product change)**
1. **C-1:** confirm in `Console → Authentication → Users` that the administrator email exists,
   `disabled = No`, and the custom claim is `role=admin`. A mismatch with the profile is a login-time 403
   by `route.ts:71-74`.
2. **C-2:** read the deployed Firestore rules text in the Console and confirm it is at least deny-all for
   client access. If it is looser than `firestore.rules`, that is a live security exposure and must be
   fixed before any launch.

**Stage 1 — put the verified code on GitHub** `[authorization: commit + push]`
3. Preserve the 187 uncommitted paths — commit them; do not reset, stash or clean. Recommended: one commit
   of `src/`, `docs/` and `functions/` work, then a second for the launch configuration in step 5.
4. Push `feature/handover-v2-recovery`. Decide whether it also merges to the branch App Hosting will track;
   `origin/master` is 10 commits behind HEAD, so tracking master without merging deploys the older app.

**Stage 2 — project configuration** `[authorization: change security rules / create cloud resources]`
5. Copy `.demo/launch-live-config/{firebase.json,firestore.indexes.json}` to the repository root and add
   `apphosting.yaml` there; replace the `APP_ORIGIN` placeholder in stage 4, not now.
6. `firebase deploy --only firestore:rules --project shiftchange20-e4265` — deploys deny-all. Verify the
   Console shows the new version.
7. `firebase deploy --only firestore:indexes --project shiftchange20-e4265` — harmless under "push OFF",
   and required before notifications are ever enabled.

**Stage 3 — backend** `[authorization: create billable App Hosting resource]`
8. Enable App Hosting for the project and create a backend from the GitHub connection, repo
   `kobbycode/NOC-SHIFTCHANGE`, branch from step 4, region matching the Firestore region (`nam5`-adjacent
   choice; `us-central1` is the conventional pairing).
9. In the console, set `NEXT_PUBLIC_FIREBASE_API_KEY` (plain value) and confirm every other `env` entry in
   `apphosting.yaml` resolved — Console values override YAML, so verify each one that differs.
10. Create the release. Record the resulting `…-<region>.run.app` URI.

**Stage 4 — origin wiring** `[authorization: change Auth configuration]`
11. Add that exact `run.app` host to `Auth → Settings → Authorized domains`. **Without this, browser
    sign-in fails and nothing else matters.**
12. Set `APP_ORIGIN` to `https://<that host>` and redeploy — `APP_ORIGIN` is what the cross-origin write
    guard compares against, and the 403 negative path in run 4 was proven against a configured origin.

**Stage 5 — live acceptance, read-only posture** `[authorization: first live writes]`
13. Log in as the administrator **on the deployed URL**. Per §1 this writes nothing to Firestore.
14. Create one supervisor and one technician account, set a pair, schedule one shift, run one shift through
    evidence → handover → four confirmations → both atomic acceptances → guard finalization **on the live
    project**. This is the first time live data exists; it needs its own explicit go-ahead, and the
    recommended shape is a clearly-labelled test shift, because there is no supported delete path.
15. Negative checks on the live URL: technician blocked from the review queue (403), supervisor blocked
    from provisioning (403), unauthenticated write (401).

**Stage 6 — decision**
16. GO/NO-GO again, now on live evidence rather than emulator evidence. Enable notifications only in a
    separate later decision (indexes + `functions` deploy + the 09L browser retest).

**Rollback:** App Hosting can roll a backend back to a previous release without rebuilding. Rules rollback
is a re-deploy of the prior rules text (C-2's reading). Live Firestore rows created in stage 5 stay — there
is no rollback for them.

---

## 6. Authorization ledger — what is still withheld

| Need | Consumes |
| --- | --- |
| Put the verified code on GitHub | commit + push |
| Make rules/indexes live | deploy authorization (and C-2 first) |
| Create the hosting target | billable-resource authorization |
| Allow the `run.app` origin | Auth-configuration authorization |
| The first live login | live-project event authorization |
| Any account/shift created in stage 5 | **live Firestore write** authorization |
| Enable notifications | separate decision + `functions` deploy |

Also explicitly not done, per the brief: no deploy, no rule change, no cloud resource, no push, no live
write, no deletion or recreation of the administrator account, and no change to any protected UAT
environment. The disposable stack (`demo-lifecycle-p8a2r`) was the only environment mutated, and it is
in-memory — stopping it discards everything.

---

## 7. Residual risks worth carrying into the launch decision

1. Next 16.3.5 is outside the enumerated App Hosting preconfigured-Next range; the explicit build/run
   commands are the mitigation, and the first release must be smoke-tested rather than trusted (§3.2).
2. `minInstances: 0` means the first request pays a cold start; the activation window is 15 minutes wide,
   so a cold start is tolerable — but if the launch wants prompt attendance, `minInstances: 1` has a cost
   consequence on Blaze.
3. Live Firestore has no delete path for the test shift created in stage 5.
4. Forms `incident` and real `outside_broadcast` will be used in production for the first time.
5. Task `reject` and `reassign` are unreachable from the UI (§4.3).
6. The 8C recovery surface is uncommitted and unrouted, so an operational stall after launch has no
   approved in-product remedy; the only remedy today is manual, by an administrator.
7. 8C.4B's OD-1 leaves `tests/recovery-eligibility-http-emulator.test.mjs:684` pinned to digest schema
   version 1, so 3 of 17 assertions in that suite are red. It is a test-suite pin, not a product defect,
   and does not gate the launch.
