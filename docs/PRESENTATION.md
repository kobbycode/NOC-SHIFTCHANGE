# ShiftChange 2.0 presentation

This demonstration uses **only** `demo-shiftchange-v2` on local Firebase Authentication and Firestore emulators. Production settings and production records are not used. The application listens on loopback at `http://localhost:3100`.

## Start

Open two PowerShell terminals in the repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-presentation.ps1 -Service emulators
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-presentation.ps1 -Service app
```

Keep both running. The app uses Webpack for this local demo because the existing Turbopack development cache had a Windows file-access failure. Production builds continue to use the normal configured build.

For a new, empty demo emulator, prepare accounts, pairs, the shift, and the task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-presentation.ps1 -Service prepare
```

Preparation creates the initial demo administrator locally, then uses the real administrator account-creation API for the supervisor and four technicians. Each provisioned account completes the real initial password-change API before use. It does not overwrite an existing completed setup.

Credentials are in the ignored local file **`.demo/credentials.json`**. Scenario identifiers are in **`.demo/presentation.json`**. Do not paste passwords into this guide, commit them, save them in the browser, or use them outside the local demo. The six entries identify Administrator, Supervisor, Outgoing Technician A/B, and Incoming Technician A/B. Use separate browser profiles or log out between users; tabs in one profile share the application session cookie.

## Demonstration order

1. Supervisor → **Shift Management**: start the prepared shift. A scheduled shift may start 15 minutes early through 60 minutes late, bounded by its end time. For an expired schedule use the existing supervisor recovery workflow and prepare a valid replacement; changing the computer clock is unnecessary.
2. Outgoing A and B → **My Tasks** / **Shift Operations**: join the current shift. The system records actual reporting confirmation. It does not invent clock-in/out or hours.
3. A → **Shift Operations**: record Joy FM, Adom FM, Asempa FM, and Hitz FM checks. Missing checks remain explicitly unverified.
4. A: record the studio codec fault and link the task ID from the scenario. B: open that fault and append a technical action. Original author and chronological history remain visible.
5. B: record the community outside broadcast, uplink issue, and backup action. For a shift with no outside broadcasts, submit an explicit no-OB declaration instead. Do not combine that declaration with a real OB record.
6. Supervisor → **Shift Management**: begin handover after operational entries are complete. This locks further operational edits.
7. Supervisor → **Handovers**: reserve the incoming permanent pair and choose a valid incoming shift period. Its start must fall within the activation window when final transfer occurs. Do not create a second ordinary shift for the reservation.
8. Open the report: review A staff, B attendance, C broadcast status, D faults/activity, E outside broadcasts, and pending tasks. Classify the unfinished codec task as **Carry forward**, with a meaningful reason.
9. Supervisor: freeze the complete report with a review reason. The screen shows its version, report digest, revision, and confirmation snapshot. A controlled correction creates a new immutable report and invalidates earlier confirmations.
10. Both outgoing technicians, then both incoming technicians → **Handovers**: review the same frozen report and authenticate their own confirmation using their current password. Incoming technicians can review their reserved handover before activation.
11. Supervisor: refresh the report, review all four participant statuses, and complete the secure atomic transfer. Genuine absences or exceptions can be recorded with an authorized reason; they are shown separately from authenticated confirmations.
12. Verify outgoing completed, incoming active, retained task identity, and released outgoing responsibility. Incoming task assignment/acceptance is a separate workflow and is never fabricated by report confirmation or transfer.
13. Any participating technician or supervisor: open the completed handover and use **Print / Save as PDF**. The frozen report, provenance, correction history, participant evidence, and transfer receipt remain available.

## Repeatable validation and local evidence

The real HTTP scenario is exercised with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-presentation.ps1 -Service validate
```

This checks actual password authentication and application sessions, operational records by both outgoing users, stale review rejection, four confirmations, atomic transfer, replay, retained task identity, no fabricated incoming assignments, and server-rendered completed report pages. Successful validation writes `.demo/validation.json` without credentials or tokens. **HTTP validation does not substitute for browser interaction or print-layout inspection.**

The retained `.demo/ready-export` checkpoint contains the initial demo before transfer; `.demo/completed-export` contains the validated completed report and receipt. Use `-Service emulators -Checkpoint ready` or `-Checkpoint completed` to explicitly select one when starting stopped emulators. The normal emulator shutdown exports current data to `.demo/emulator-data`, which the default startup imports when available, otherwise it uses the completed checkpoint. Preserve these checkpoints. Schedule timestamps in any restored checkpoint still obey real activation windows.

## Expected safeguards

Incomplete broadcast or OB information blocks report freezing. Incorrect passwords, unrelated technicians, blocked accounts, stale revisions, changed source evidence, and oversized reports fail closed. Work changes require review and a new freeze. Revisions retain prior immutable reports and audit evidence. Repeated exact transfer requests return the original receipt without advancing operational control twice.

Legacy handovers preserve their original work-snapshot contract. New handovers require `handover-report-v1` evidence in addition to the unchanged `handover-work-v2` contract.

## Current limitations

- Reporting confirmation is available; authoritative clock-in/out and late reasons are shown only when actually recorded, so hours may remain undetermined.
- Missing fault information is labeled as missing, never interpreted as a declaration of no faults.
- Conflicting OB and no-OB records block freezing and require investigation; a correction note does not erase original operational evidence.
- Printing uses the browser's Print / Save as PDF facility. No custom server PDF generator is included.
- Browser automation failed to attach to the local in-app browser during this sprint. Interactive browser and print-layout verification must be reported separately from HTTP and native-emulator results.
- Newly provisioned accounts include explicit inactive cleanup metadata. Older profiles missing that required metadata remain blocked by the protected handover guards and require administrator review; production data was not migrated during this sprint.
