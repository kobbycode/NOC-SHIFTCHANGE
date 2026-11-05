# ShiftChange 2.0 — Stage 1 release candidate and security gate

Target: `shiftchange20-e4265`. Date: 2026-11-05 (Africa/Sao_Tome).

Decision: **NO-GO for publication/deployment until the remaining gates below close.**
No staging, commit, push, merge, reset, stash, deployment, live resource mutation,
or protected UAT operation was performed. Recovery development was not resumed.

## 1. Git identity and inventory

Branch: `feature/handover-v2-recovery`.
HEAD: `c1703530437ff4e45010dde4f920597fe7684d9f`.

The inherited report's count of 187 is stale. This turn initially found **222
file paths: 50 modified and 172 untracked**. Directory summaries in ordinary
`git status` are not file inventories. The original 187-path snapshot is not
available to reconstruct its exact delta. All currently changed paths were read,
hashed, classified and scanned for credential-like literals without printing values.
This is inventory and dependency review, not a line-by-line correctness audit.

The initial categories were: 129 application source, 4 configuration,
6 deployment dependencies, 70 test-only, 12 documentation, 1 generated artifact.
No initial changed file was classified sensitive/environment-specific; ignored
environment files and UAT stores are separately excluded below. The 5 Functions
files are deployment dependencies of deferred push, not of the web pilot.

`STAGE1-CHANGED-PATHS-2026-11-05.csv` enumerates every reviewed changed path,
category, disposition, reason, size and SHA-256. Audit artifacts and new deployment
proposals add paths after the initial inventory. `STAGE1-CANDIDATE-FILES-2026-11-05.txt`
is the exact web build input list, including unchanged application/config files.
All local TypeScript imports resolve; CSS imports are verified by the build.

Proposed commit list: **204 paths** (197 of the original changed paths plus the
3 new deployment proposals and 4 release-review artifacts). **25 original paths
are excluded**: 11 recovery API entrypoints, 5 Functions files, Functions config,
one generated emulator config and 7 local UAT/snapshot scripts. The full build
input manifest contains 470 paths, including unchanged baseline files.

## 2. Complete recovered environment finding and mitigation

The full original warning is in `LAUNCH-READINESS-2026-11-05.md` section 3.3.
Next loads `.env.local` in both development and production. Precedence is process
environment, environment-specific local file, `.env.local`, environment-specific
file, `.env`. Public variables are embedded at build time, so restarting with new
runtime values cannot fix a bundle built for another project.

An earlier purported live startup was contaminated by `.env.local` emulator hosts
and was correctly withdrawn as live evidence. Current inspected defaults are
`demo-shiftchange-v2`, browser emulator mode true, Auth `127.0.0.1:9099`, Firestore
`127.0.0.1:8080`, Handover v2 true, atomic acceptance unset, notifications unset.
`APP_ORIGIN` appears twice; this must not be trusted as a production configuration.
No credential file environment variable or local ADC file was present.

Default startup therefore selects the demo environment, not live Firebase. The
browser client enforces a closed emulator-project list when emulator mode is true;
password reauthentication checks both project IDs and both host tuples when the
Auth emulator variable is truthy. **The central Admin SDK initializer has no
equivalent tuple check.** Process overrides can mix projects, select live Auth
when its emulator host is missing, or keep Firestore emulated while Auth is live.
Browser Storage is not connected to an emulator in this module either. No current
storage upload path was certified by this audit.

Do not run an ad hoc live `next start` in this checkout. Merely unsetting emulator
variables lets `.env.local` refill them. Even setting empty values is insufficient
unless every public/project/feature/origin variable is consistently pinned, and the
bundle must be rebuilt. `GCLOUD_PROJECT` and `GOOGLE_CLOUD_PROJECT` are project
selectors, not emulator switches; their presence alone does not enable emulators.

For this verification, the environment was made safe by copying only manifest
files into a fresh ignored directory, excluding every `.env*`/credential/UAT file,
and supplying a complete synthetic demo configuration to an isolated production
build. No server or emulator was started. The original `.env.local` was preserved.
This verifies application compilation, not a live Firebase connection or the
eventual production client configuration. Hosted builds must contain no `.env*`
and no emulator hosts. A local live login remains outside this release test.

## 3. Production security verification

Fresh authenticated **read-only** API results are stored in the ignored
`.demo/stage1-security-result.json`; no password, hash, token or key was printed.

- Administrator Authentication record: read successfully; **disabled=false**.
- Administrator custom claims: read successfully; **role=admin**. This claim is
  required: login and session code compare token role with the profile role.
- Active Firestore release: resolved through
  `/v1/projects/shiftchange20-e4265/releases/cloud.firestore` to ruleset
  `6060a373-d07b-4cd7-a024-ad8db012a4e6`. Its sole source matches repository
  `firestore.rules` after removing comments/whitespace: **deny all client access**.
- Admin initialization imports `server-only`, uses ADC and an explicit project ID,
  and embeds no private key. It bypasses Firestore rules, so route authorization
  and backend IAM remain the actual server security boundary.
- The earlier report's “Console-only” gates were caused by incorrect endpoint
  paths; correct project-scoped account lookup and active release reads worked.
  These two gates are closed without a Console change.

Hosting/runtime/profile read results: see final verification addendum below.

Additional read-only checks confirmed **zero App Hosting backends**. Separate
reads of the Auth project configuration and administrator Firestore profile
returned HTTP 500 in this run, so their earlier reported values are not promoted
to fresh evidence. Before pilot acceptance, use Authentication → Sign-in method
to confirm Email/Password enabled; Authentication → Settings → Authorized domains
to read the exact host list; and Firestore → Data → `users` →
`TH13esciAvbkwb2BVdQij0MDLLL2` to confirm `role=admin`, `status=active`,
`statusOperation` absent/null and `mustChangePassword=false`. Read only; do not
edit the account or document. No administrator sign-in was attempted.

## 4. Release source boundary and exclusions

Include the complete application/public assets and root build configuration listed
in the candidate file list; the modified lockfile is necessary for reproducible
`npm ci`. Keep notification modules because application code imports them, but pin
both notification flags false and transport mock. No push Functions deployment.

**Omit exactly the 11 untracked API files beneath**:

- `src/app/(dashboard)/api/admin/recovery-approvals/`
- `src/app/(dashboard)/api/admin/recovery-approvals-v2/`
- `src/app/(dashboard)/api/admin/recovery-eligibility/`

Each exact path appears as excluded in the path inventory. These routes currently
use the general Handover v2 flag, not an independent recovery flag. Keeping v2 on
would expose recovery approval writes, even though responses always say
`recoveryExecutionEligible: false`. The earlier report's “no HTTP importer” claim
is stale. Retain supporting source/type libraries for dependency completeness;
they have no pilot recovery API entrypoint. No source file was deleted or edited
to implement this boundary. This omission is part of the proposed Git manifest,
not an environment flag that magically disables the working-tree routes.

Include the changed tests and fixtures to preserve the source's verification
record. Their category remains test-only; inclusion does not schedule their
execution in production. Exclude local UAT/snapshot tooling edits (retain
locally for separately reviewed tooling work), `functions/`,
`firebase.functions.json`, `firebase.uat-09l-emulator.generated.json`, `.demo/`,
`.env*`, ADC/service-account files, `node_modules/`, all `.next*`, build logs,
generated Next types and TypeScript build caches. Never use `git add .` or `git add src`.
Previously tracked excluded tooling files remain at HEAD in the proposed Git
commit; local edits are not destroyed. Tests use the reviewed current test/source
files; this is not certification of every historical or recovery suite.

Historical docs may be committed as evidence, with this report explicitly
superseding their live-access, route-exposure and deployment claims.

## 5. Production build and tests

Clean candidate: `.demo/stage1-rc-20261105/`. Inputs are copied from the explicit
manifest, including baseline tracked files and proposed source/tests, without
environment files, UAT data, local build output or new Functions files.
Excluded tracked tooling uses the HEAD version from a read-only `git archive`.
A fresh dependency installation is attempted from the proposed lockfile.
The build uses a fully pinned synthetic emulator configuration; no app server or
emulator is launched. Final build/test results are in the addendum below.

Coverage selected: emulator isolation, scheduling/calendar policy, current-shift
selection, activation windows, attendance projection, administrative review,
incoming-acceptance domain and transactional atomic acceptance. These suites use
in-memory doubles or pure functions and do not mutate emulator or live data.

Executed test command (exit 0, **159 passed, 0 failed, 0 skipped**):

```powershell
node --import tsx --experimental-strip-types --test tests/isolated-emulator-environments.test.mjs tests/incoming-acceptance-application-domain.test.mjs tests/atomic-incoming-acceptance-service.test.mjs tests/handover-report-attendance.test.mjs tests/handover-admin-review-domain.test.mjs tests/shift-schedule-policy.test.mts tests/technician-current-shift-domain.test.mts tests/shift-activation-window.test.mjs
```

Log: `.demo/stage1-tests.log`. Fresh `npm ci --no-audit --no-fund`
completed successfully (584 packages). npm reported deprecations and skipped
unapproved install scripts for four dependencies; no script approval was changed.
This was not a dependency vulnerability audit.

The earlier 34/34 disposable HTTP lifecycle result is preserved in
`.demo/launch-lifecycle-run4.log`; it is historical evidence, not a newly executed
HTTP/browser smoke test for this candidate. Incident and real outside-broadcast
capture, assignment reject/reassign UI and unattended activation gaps from the
earlier report remain disclosed. No recovery development/test repair was performed.

## 6. Proposed deployment configuration

New root proposals: `apphosting.yaml`, `firebase.json`, `firestore.indexes.json`.
None is applied. The two notification indexes are retained for future enablement;
they are not required while notifications are disabled.

Changes from ignored drafts: use npm build/start scripts; preserve the complete
clean Git build context via `outputFiles.serverApp.include: ["."]` so `next start`
keeps dependencies, configuration and public assets; explicitly set notification
flags false and transport mock; remove fake key/origin values. The Console must
supply `NEXT_PUBLIC_FIREBASE_API_KEY` at build and runtime, and the exact HTTPS
`APP_ORIGIN` before serving users. All other project/web values are in YAML.

No private Admin credential belongs in YAML, public variables or Git. Use the
backend's runtime ADC identity and verify its project/Auth/Firestore permissions.
The runtime identity and effective cloud environment cannot be verified before a
backend exists. Console variables override YAML, so inspect the final rollout's
environment and remove stale emulator, development and notification overrides.
Do not delete legitimate platform-provided project variables.

Firebase documents that custom build commands bypass framework adapters. This
configuration therefore requires its own hosted smoke test. Keeping all files is
the documented conservative output option; only clean reviewed Git content may
be in that build context.

References: https://firebase.google.com/docs/app-hosting/configure and
https://firebase.google.com/docs/auth/admin/custom-claims .

## 7. Console actions still required (only after separate approval)

1. App Hosting: select `shiftchange20-e4265`, connect the intended GitHub repository
   and the exact approved commit/branch; choose backend ID and region. Disable
   automatic rollouts until the source/origin configuration is finalized. Backend
   creation may itself initiate a rollout; treat it as deployment authorization.
2. Before a rollout, supply the real public SDK API key without pasting it into
   reports; set `APP_ORIGIN` to the exact public HTTPS origin, and verify every
   effective flag/value in the rollout environment. No emulator hosts/credential
   files; notifications false; atomic handover acceptance true.
3. Authentication → Settings → Authorized domains: inspect actual entries; add
   the exact serving hostname (no scheme/path) and later any custom hostname as
   needed for Auth flows. Do not enter literal wildcard domains. Verify browser
   sign-in on the actual host. The previous categorical claim that password-only
   `signInWithEmailAndPassword` must fail solely because a host is absent was not
   demonstrated and is not treated as verified evidence here.
4. Verify backend runtime service account and IAM permit needed Firebase Auth and
   Firestore server operations, without shipping service-account private keys.
5. Compare active deny-all rules again near rollout; no rule change is presently
   necessary. Verify any requested index deployment separately.

## 8. Exact proposed Git commands — DO NOT EXECUTE YET

After reviewing the path inventory and closing the remaining blockers:

```powershell
git branch --show-current
git rev-parse HEAD
git diff --cached --name-only
git --literal-pathspecs add --pathspec-from-file=docs/STAGE1-PROPOSED-COMMIT-PATHS-2026-11-05.txt
git diff --cached --stat
git diff --cached --check
git diff --cached --name-only
git commit -m "Prepare ShiftChange 2.0 pilot release candidate"
git push origin feature/handover-v2-recovery
```

The first two commands must still match section 1, and the index must initially
be empty. Review the staged list against the exact file manifest and confirm zero
recovery API entrypoints. The pathspec file lists only approved additions/edits;
unlisted local work remains untouched. No merge is proposed. App Hosting must
track this branch/approved commit rather than an older default branch.

## 9. Exact proposed deployment actions — DO NOT EXECUTE YET

After separate Git publication and deployment approval, and with approved CLI
available on PATH:

```powershell
firebase apphosting:backends:create --project shiftchange20-e4265 --app 1:1042059464078:web:b769f6fb314ea5b848e8df --root-dir . --backend APPROVED_BACKEND_ID --primary-region APPROVED_REGION
firebase apphosting:backends:get APPROVED_BACKEND_ID --project shiftchange20-e4265
```

Backend ID/region and serving origin are unresolved inputs, not invented values.
Prefer Console creation to explicitly review the GitHub repository, branch and
automatic rollout settings. Configure section 7 values before allowing traffic.
Trigger the rollout of the exact approved commit in App Hosting Console, then
verify login, role/origin enforcement and static assets. Do not create live test
accounts/shifts without explicit live-data authorization.

No rules deployment is needed because active rules already match. Optional future
index deployment, only after approval:

```powershell
firebase deploy --only firestore:indexes --project shiftchange20-e4265
```

Do not deploy Functions or enable notifications. Rollback should target a recorded
prior App Hosting rollout; a first rollout has no prior production version, and
rollback does not undo Firestore writes.

## 10. Remaining blockers

- Explicit approval for Git publication and, separately, deployment/live changes.
- Backend ID/region/origin selection; GitHub connection; effective cloud env,
  runtime ADC/IAM and hosted smoke test.
- Verified source boundary: recovery API routes must remain outside the commit.
- Production SDK public key and origin must be configured before rollout/traffic.
- Reconfirm Email/Password provider, domain list and administrator profile after
  the two supplemental read failures, using the precise read-only Console steps.
- Review the final build/test addendum and operational gaps before pilot acceptance.

STOP after preparing this reviewable result. Await explicit approval for Git
publication and deployment.

## Final verification addendum

**Production build: PASS, exit 0.** Next.js 16.3.5 compiled in 4.8 minutes,
finished TypeScript in 2.0 minutes, generated 27/27 static pages and completed
page optimization. Evidence: `.demo/stage1-build.log` and
`.demo/stage1-build-result.json`. The first prematurely launched attempt, before
dependency installation finished, failed with missing Next executable; it was
rerun only after successful fresh installation. The final result is the complete
successful build, not that setup failure.

The built app-paths manifest has **80 entries**. Verified present: supervisor
scheduling, technician operations/attendance workspace, supervisor and technician
Handover v2, admin handover review, atomic acceptance and guard finalization.
**Zero recovery API routes** are present. All 470 listed build inputs exist in the
candidate, and every `src/` and `public/` file is byte-identical to its manifest
source. No required pilot application source is omitted; recovery API files are
deliberate non-pilot exclusions. Route evidence:
`.demo/stage1-route-verification.json`. This confirms inclusion and compilation,
not a new browser interaction test of every interface.

**Relevant tests: PASS, 159/159, no skips.** These are network-free tests against
the same source bytes as the candidate. The historical 34-step HTTP lifecycle
was not rerun and is not represented as fresh candidate evidence.

**Security: account/claim and deployed rules PASS; hosting/environment acceptance
remains gated.** Administrator enabled with admin claim; active client rules match
deny-all. Backend count is zero. Auth project settings and administrator profile
fresh reads failed with HTTP 500; follow section 3 Console instructions. Cloud
runtime identity, effective environment, final origin and live browser smoke test
remain unverified. No real SDK key or private credential was printed or committed.

**Configuration validation: PASS.** YAML and both JSON files parse; YAML has no
duplicate environment names and the index file has two entries. The production
build used synthetic demo values, so it must never be uploaded as a live bundle;
App Hosting must rebuild the approved Git commit with real production public
configuration and its runtime identity. Custom-command hosting remains subject
to the first hosted smoke test.

**Git preservation: PASS.** Branch and HEAD remain exactly those in section 1;
index is empty. Final status is 229 changed paths: the original 222 plus 3
configuration proposals and 4 release artifacts. Existing application changes,
`.env.local`, protected UAT environments and advanced recovery work were preserved.
Only the new proposals/release artifacts and ignored audit/build files were
written by this turn. No Git publication or deployment command was executed.

The source candidate is prepared and reviewable. **Online pilot remains NO-GO**
until the remaining manual/environment acceptance gates and explicit publication
and deployment approvals are satisfied.
