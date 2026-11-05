$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# HARD SAFETY BOUNDARY: a fresh disposable demo project on dedicated ports, no
# import or export. The presentation, 09D, 09L, 09M, 8A, 8B, 8C.3 and 8C.4A
# stacks are never contacted. emulators:exec starts an empty ephemeral instance,
# so no persisted snapshot is read or modified.
$projectId = "demo-recovery-approval-v2-8c4b"
$node = "C:\Users\Jonah\.qoder\bin\node-v24.18.0-win-x64\node.exe"
$javaRuntime = "C:\Users\Jonah\.qoder\bin\jre21\jdk-21.0.12.1+1-jre"
$firebaseCli = "C:\Users\Jonah\.qoder\bin\firebase-tools\node_modules\firebase-tools\lib\bin\firebase.js"

foreach ($required in @($node, (Join-Path $javaRuntime "bin\java.exe"), $firebaseCli, (Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"))) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required tool was not found: $required"
    }
}

foreach ($port in @(8189, 9089, 4417, 4517)) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        throw "Refusing to start: port $port is already in use."
    }
}

$env:JAVA_HOME = $javaRuntime
$env:PATH = "$(Split-Path -Parent $node);$(Join-Path $javaRuntime 'bin');$env:PATH"
$env:FIREBASE_PROJECT_ID = $projectId
$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID = $projectId
$env:GCLOUD_PROJECT = $projectId
$env:GOOGLE_CLOUD_PROJECT = $projectId
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8189"
$env:NOTIFICATIONS_ENABLED = "true"
$env:RECOVERY_APPROVAL_V2_EMULATOR = "true"
# The suite drives the approval services directly: no feature flag is inherited.
Remove-Item Env:HANDOVER_V2_DEV -ErrorAction SilentlyContinue
Remove-Item Env:HANDOVER_V2_ATOMIC_ACCEPTANCE -ErrorAction SilentlyContinue

# Allow CLI execution of modules marked "server-only".
if ($env:NODE_OPTIONS -notmatch '--conditions=react-server') {
    $env:NODE_OPTIONS = "$env:NODE_OPTIONS --conditions=react-server".Trim()
}

$configurationPath = Join-Path $repoRoot "firebase.recovery-approval-v2-8c4b.generated.json"
if (Test-Path -LiteralPath $configurationPath) {
    throw "Refusing to overwrite an existing generated emulator configuration."
}

$configuration = @{
    firestore = @{ rules = "firestore.rules" }
    emulators = @{
        firestore = @{ host = "127.0.0.1"; port = 8189; websocketPort = 9089 }
        hub = @{ host = "127.0.0.1"; port = 4417 }
        logging = @{ host = "127.0.0.1"; port = 4517 }
        ui = @{ enabled = $false }
        singleProjectMode = $true
    }
}

Write-Host ""
Write-Host "=== PHASE 8C.4B VERSION 2 DUAL APPROVAL EMULATOR BOUNDARY ===" -ForegroundColor Cyan
Write-Host "Project: $projectId (dedicated disposable instance)"
Write-Host "Firestore port: 8189 (websocket 9089, hub 4417, logging 4517)"
Write-Host "No import/export. Protected UAT projects and ports are NOT used." -ForegroundColor Green

try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    & $node $firebaseCli emulators:exec `
        --config $configurationPath `
        --project $projectId `
        --only firestore `
        --log-verbosity=QUIET `
        "node --import tsx --test --test-concurrency=1 tests/handover-recovery-approval-v2-emulator.test.mjs"
    if ($LASTEXITCODE -ne 0) {
        throw "Version 2 dual approval tests failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $configurationPath) {
        Remove-Item -LiteralPath $configurationPath
    }
}

Write-Host ""
Write-Host "PHASE 8C.4B VERSION 2 DUAL APPROVAL TESTS PASSED" -ForegroundColor Green
