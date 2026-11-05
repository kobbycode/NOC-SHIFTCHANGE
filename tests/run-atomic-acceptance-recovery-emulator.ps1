$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# HARD SAFETY BOUNDARY: a fresh demo project on dedicated ports, no import or
# export. The presentation, 09D, 09L and 09M UAT stacks are never contacted.
$projectId = "demo-atomic-acceptance-r4a"
$node = "C:\Users\Jonah\.qoder\bin\node-v24.18.0-win-x64\node.exe"
$javaRuntime = "C:\Users\Jonah\.qoder\bin\jre21\jdk-21.0.12.1+1-jre"
$firebaseCli = "C:\Users\Jonah\.qoder\bin\firebase-tools\node_modules\firebase-tools\lib\bin\firebase.js"

foreach ($required in @($node, (Join-Path $javaRuntime "bin\java.exe"), $firebaseCli, (Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"))) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required tool was not found: $required"
    }
}

foreach ($port in @(8182, 9082, 4407, 4507)) {
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
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8182"
$env:NOTIFICATIONS_ENABLED = "true"
# This suite drives services directly; never inherit the presentation feature flag.
$env:HANDOVER_V2_DEV = $null

# Allow CLI execution of modules marked "server-only".
if ($env:NODE_OPTIONS -notmatch '--conditions=react-server') {
    $env:NODE_OPTIONS = "$env:NODE_OPTIONS --conditions=react-server".Trim()
}

$configurationPath = Join-Path $repoRoot "firebase.atomic-acceptance-recovery-emulator.generated.json"
if (Test-Path -LiteralPath $configurationPath) {
    throw "Refusing to overwrite an existing generated emulator configuration."
}

$configuration = @{
    firestore = @{ rules = "firestore.rules" }
    emulators = @{
        firestore = @{ host = "127.0.0.1"; port = 8182; websocketPort = 9082 }
        hub = @{ host = "127.0.0.1"; port = 4407 }
        logging = @{ host = "127.0.0.1"; port = 4507 }
        ui = @{ enabled = $false }
        singleProjectMode = $true
    }
}

Write-Host ""
Write-Host "=== ATOMIC ACCEPTANCE RECOVERY EMULATOR SAFETY BOUNDARY ===" -ForegroundColor Cyan
Write-Host "Project: $projectId"
Write-Host "Firestore port: 8182 (hub 4407, logging 4507)"
Write-Host "No import/export. Protected UAT projects and ports are NOT used." -ForegroundColor Green

try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    & $node $firebaseCli emulators:exec `
        --config $configurationPath `
        --project $projectId `
        --only firestore `
        --log-verbosity=QUIET `
        "node --import tsx --test --test-concurrency=1 tests/atomic-incoming-acceptance-recovery-emulator.test.mjs"
    if ($LASTEXITCODE -ne 0) {
        throw "Atomic acceptance recovery emulator tests failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $configurationPath) {
        Remove-Item -LiteralPath $configurationPath
    }
}

Write-Host ""
Write-Host "ATOMIC ACCEPTANCE RECOVERY EMULATOR TESTS PASSED" -ForegroundColor Green
