param(
    [ValidateSet("base_fixture_created", "operational_evidence_recorded", "handover_initiated", "incoming_pair_reserved", "consolidated_report_prepared", "report_frozen", "outgoing_confirmations_completed", "handover_committed", "incoming_acceptance_activated")]
    [string]$Checkpoint,
    [switch]$NoSave,
    [string]$RecoveryReason = ""
)
. (Join-Path $PSScriptRoot "09m-runtime.ps1")
Set-Location $repoRoot
if ($NoSave) {
    if ($RecoveryReason.Trim().Length -lt 10) { throw "-NoSave requires a meaningful -RecoveryReason; unsaved progress would be lost." }
    Write-Warning "Explicit no-save shutdown: $RecoveryReason"
} else {
    if (-not $Checkpoint) { throw "An explicit -Checkpoint is required before saving and stopping." }
    & (Join-Path $PSScriptRoot "run-uat-09m-save.ps1") -Checkpoint $Checkpoint
    # A save failure throws before any process enumeration or termination.
}
$projectId = "demo-shiftchange-v2-09m"
$targets = @{}
foreach ($port in @(4405, 4505, 9399, 8380, 9480)) {
    foreach ($connection in (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
        $processId = $connection.OwningProcess
        if ($targets.ContainsKey($processId)) { continue }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        if ([string]$process.CommandLine -like "*$projectId*") { $targets[$processId] = $true }
        else { Write-Warning "Leaving PID $processId on port ${port}: its command line does not identify 09M." }
    }
}
foreach ($processId in $targets.Keys) { Stop-Process -Id $processId -Force }
Write-Host "Stopped only identified 09M emulator processes. Existing snapshot directories were retained."
