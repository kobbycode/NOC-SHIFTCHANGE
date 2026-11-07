param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("base_fixture_created", "operational_evidence_recorded", "handover_initiated", "incoming_pair_reserved", "consolidated_report_prepared", "report_frozen", "outgoing_confirmations_completed", "handover_committed", "incoming_acceptance_activated")]
    [string]$Checkpoint
)
. (Join-Path $PSScriptRoot "09m-runtime.ps1")
Set-Location $repoRoot
. (Join-Path $repoRoot ".demo\uat-09m-env.ps1")
$nodeExe = Get-09mNode
& $nodeExe --import tsx --conditions=react-server scripts/09m-snapshot.mjs save --checkpoint $Checkpoint
if ($LASTEXITCODE -ne 0) { throw "09M save failed; the previous LATEST.json was not replaced." }
