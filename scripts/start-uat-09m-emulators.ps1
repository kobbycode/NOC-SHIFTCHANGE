param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("base_fixture_created", "operational_evidence_recorded", "handover_initiated", "incoming_pair_reserved", "consolidated_report_prepared", "report_frozen", "outgoing_confirmations_completed", "handover_committed", "incoming_acceptance_activated")]
    [string]$Checkpoint,
    [switch]$AllowLegacySnapshot,
    [switch]$AllowCheckpointMismatch,
    [string]$RecoveryReason = "",
    [switch]$Foreground
)
. (Join-Path $PSScriptRoot "09m-runtime.ps1")
Set-Location $repoRoot
$nodeExe = Get-09mNode
$selectionArgs = @("--import", "tsx", "--conditions=react-server", "scripts/09m-snapshot.mjs", "select", "--checkpoint", $Checkpoint, "--json")
if ($AllowLegacySnapshot) { $selectionArgs += "--allow-legacy" }
if ($AllowCheckpointMismatch) { $selectionArgs += "--allow-checkpoint-mismatch" }
if ($RecoveryReason) { $selectionArgs += @("--recovery-reason", $RecoveryReason) }
# Selection is read-only and must finish before any configuration file is changed.
$selectionText = & $nodeExe @selectionArgs
if ($LASTEXITCODE -ne 0) { throw "Snapshot selection refused. No emulators were started and no alternative snapshot was selected." }
$selection = ($selectionText -join "`n") | ConvertFrom-Json
Write-Host "Requested checkpoint: $($selection.requestedCheckpoint)"
Write-Host "Actual checkpoint:    $($selection.actualCheckpoint)"
Write-Host "Manifest/integrity:   $($selection.manifestStatus) / $($selection.integrity)"
Write-Host "Import directory:     $($selection.directory)"
if ($selection.recoveryOverride) { Write-Warning "Explicit recovery override: $($selection.recoveryReason)" }

$projectId = "demo-shiftchange-v2-09m"
foreach ($port in @(9399, 8380, 9480, 4405, 4505)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is in use. Existing environments are never stopped by this launcher."
    }
}
$javaCandidates = @(
    (Join-Path $env:USERPROFILE ".qoder\bin\jre21\jdk-21.0.12.1+1-jre"),
    "C:\Program Files\Android\Android Studio\jbr"
)
$javaRuntime = $javaCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ "bin\java.exe") } | Select-Object -First 1
if (-not $javaRuntime) { throw "Java 21+ runtime not found." }
$env:JAVA_HOME = $javaRuntime
$env:PATH = "$(Split-Path -Parent $nodeExe);$(Join-Path $javaRuntime 'bin');$env:PATH"
$env:GCLOUD_PROJECT = $projectId
$env:GOOGLE_CLOUD_PROJECT = $projectId
$firebaseJs = Join-Path $env:USERPROFILE ".qoder\bin\firebase-tools\node_modules\firebase-tools\lib\bin\firebase.js"
if (-not (Test-Path -LiteralPath $firebaseJs)) { throw "Firebase CLI was not found at $firebaseJs." }
$configurationPath = Join-Path $repoRoot "firebase.uat-09m-emulator.generated.json"
$configuration = @{
    firestore = @{ rules = "firestore.rules" }
    emulators = @{
        auth = @{ host = "127.0.0.1"; port = 9399 }
        firestore = @{ host = "127.0.0.1"; port = 8380; websocketPort = 9480 }
        hub = @{ host = "127.0.0.1"; port = 4405 }
        logging = @{ host = "127.0.0.1"; port = 4505 }
        ui = @{ enabled = $false }
        singleProjectMode = $true
    }
}
$configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
$firebaseArgs = @($firebaseJs, "emulators:start", "--config", $configurationPath, "--project", $projectId, "--only", "auth,firestore", "--import=$($selection.directory)")
if ($Foreground) {
    & $nodeExe @firebaseArgs
    exit $LASTEXITCODE
}
$logPath = Join-Path $repoRoot ".demo\uat-09m-emulator.log"
$errorLogPath = Join-Path $repoRoot ".demo\uat-09m-emulator.err.log"
# Start-Process joins its argument array; quote each value to preserve paths.
$quotedArgs = $firebaseArgs | ForEach-Object { '"' + $_ + '"' }
$started = Start-Process -FilePath $nodeExe -ArgumentList $quotedArgs -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $repoRoot ".demo\uat-09m-emulator.pid") -Value $started.Id
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Seconds 2
    try {
        $running = Invoke-RestMethod -Uri "http://127.0.0.1:4405/emulators" -TimeoutSec 3
        if ([string]$running.auth.port -eq "9399" -and [string]$running.firestore.port -eq "8380") {
            Write-Host "09M emulators ready at checkpoint $($selection.actualCheckpoint), PID $($started.Id)."
            exit 0
        }
    } catch { }
    if ($started.HasExited) { break }
}
throw "09M startup did not become ready. Inspect $logPath; no automatic stop or fallback restore was attempted."
