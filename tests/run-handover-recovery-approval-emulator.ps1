$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# HARD SAFETY BOUNDARY: a fresh, disposable demo project on dedicated ports.
# No import, no export, no emulator UI. Presentation, 09L, 09M, 8A, 8A.2R, 8B
# and every other UAT stack is never contacted. This suite drives services
# directly and never calls the real password-verification seam, so the closed
# emulator allowlist in client.ts / password-reauthentication.ts is untouched.
$projectId = "demo-recovery-approval-8c2b"
$node = "C:\Users\Jonah\.qoder\bin\node-v24.18.0-win-x64\node.exe"
$javaRuntime = "C:\Users\Jonah\.qoder\bin\jre21\jdk-21.0.12.1+1-jre"
$firebaseCli = "C:\Users\Jonah\.qoder\bin\firebase-tools\node_modules\firebase-tools\lib\bin\firebase.js"

foreach ($required in @($node, (Join-Path $javaRuntime "bin\java.exe"), $firebaseCli, (Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"))) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required tool was not found: $required"
    }
}

foreach ($port in @(8184, 9084, 4408, 4508)) {
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
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8184"
# Never inherit a feature flag: this milestone adds no route behaviour to test.
$env:HANDOVER_V2_DEV = $null
$env:HANDOVER_V2_ATOMIC_ACCEPTANCE = $null
$env:NOTIFICATIONS_ENABLED = $null

# Allow CLI execution of modules marked "server-only".
if ($env:NODE_OPTIONS -notmatch '--conditions=react-server') {
    $env:NODE_OPTIONS = "$env:NODE_OPTIONS --conditions=react-server".Trim()
}

$configurationPath = Join-Path $repoRoot "firebase.recovery-approval-emulator.generated.json"
if (Test-Path -LiteralPath $configurationPath) {
    throw "Refusing to overwrite an existing generated emulator configuration."
}

$configuration = @{
    firestore = @{ rules = "firestore.rules" }
    emulators = @{
        firestore = @{ host = "127.0.0.1"; port = 8184; websocketPort = 9084 }
        hub = @{ host = "127.0.0.1"; port = 4408 }
        logging = @{ host = "127.0.0.1"; port = 4508 }
        ui = @{ enabled = $false }
        singleProjectMode = $true
    }
}

Write-Host ""
Write-Host "=== HANDOVER RECOVERY APPROVAL EMULATOR SAFETY BOUNDARY ===" -ForegroundColor Cyan
Write-Host "Project: $projectId"
Write-Host "Firestore port: 8184 (hub 4408, logging 4508)"
Write-Host "No import/export. Protected UAT projects and ports are NOT used." -ForegroundColor Green

try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    & $node $firebaseCli emulators:exec `
        --config $configurationPath `
        --project $projectId `
        --only firestore `
        --log-verbosity=QUIET `
        "node --import tsx --test --test-concurrency=1 tests/handover-recovery-approval-domain.test.mjs tests/handover-recovery-approval-emulator.test.mjs"
    if ($LASTEXITCODE -ne 0) {
        throw "Handover recovery approval emulator tests failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $configurationPath) {
        Remove-Item -LiteralPath $configurationPath
    }
}

Write-Host ""
Write-Host "HANDOVER RECOVERY APPROVAL EMULATOR TESTS PASSED" -ForegroundColor Green
