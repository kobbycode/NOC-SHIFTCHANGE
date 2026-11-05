$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# HARD SAFETY BOUNDARY: the already-registered disposable demo tuple
# "demo-admin-review-8b" (auth 10099 / firestore 8980) is reused on its own
# dedicated application ports. The tuple is required because the real password
# reauthentication seam only accepts the closed emulator allowlist. No import,
# no export, no emulator UI; presentation, 09D, 09L, 09M, 8A, 8B and every
# other UAT stack is never contacted. emulators:exec starts an empty ephemeral
# instance, so no persisted 8B snapshot is read or modified.
$projectId = "demo-admin-review-8b"
$node = "C:\Users\Jonah\.qoder\bin\node-v24.18.0-win-x64\node.exe"
$javaRuntime = "C:\Users\Jonah\.qoder\bin\jre21\jdk-21.0.12.1+1-jre"
$firebaseCli = "C:\Users\Jonah\.qoder\bin\firebase-tools\node_modules\firebase-tools\lib\bin\firebase.js"

foreach ($required in @($node, (Join-Path $javaRuntime "bin\java.exe"), $firebaseCli, (Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"), (Join-Path $repoRoot "node_modules\next\dist\bin\next"))) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required tool was not found: $required"
    }
}

# Firestore 8980 / websocket 9980, Auth 10099, hub 4420, logging 4520 and the
# two application ports (V2 gates on 3190, V2 gates off 3191).
foreach ($port in @(8980, 9980, 10099, 4420, 4520, 3190, 3191)) {
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
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8980"
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:10099"
$env:NEXT_PUBLIC_USE_FIREBASE_EMULATORS = "true"
# The isolated Auth emulator accepts this synthetic key; it is never a secret.
$env:NEXT_PUBLIC_FIREBASE_API_KEY = "synthetic-recovery-approval-http-key"
$env:NOTIFICATIONS_ENABLED = "true"
# The V2 flag is set per server by the harness; never inherit a turn-off value.
$env:HANDOVER_V2_DEV = "true"
$env:HANDOVER_V2_ATOMIC_ACCEPTANCE = $null
$env:APP_ORIGIN = $null

$configurationPath = Join-Path $repoRoot "firebase.recovery-approval-http.generated.json"
if (Test-Path -LiteralPath $configurationPath) {
    throw "Refusing to overwrite an existing generated emulator configuration."
}

$configuration = @{
    firestore = @{ rules = "firestore.rules" }
    emulators = @{
        auth = @{ host = "127.0.0.1"; port = 10099 }
        firestore = @{ host = "127.0.0.1"; port = 8980; websocketPort = 9980 }
        hub = @{ host = "127.0.0.1"; port = 4420 }
        logging = @{ host = "127.0.0.1"; port = 4520 }
        ui = @{ enabled = $false }
        singleProjectMode = $true
    }
}

Write-Host ""
Write-Host "=== RECOVERY APPROVAL HTTP EMULATOR SAFETY BOUNDARY ===" -ForegroundColor Cyan
Write-Host "Project: $projectId (registered closed-allowlist tuple, ephemeral instance)"
Write-Host "Firestore port: 8980 (websocket 9980), Auth port: 10099 (hub 4420, logging 4520)"
Write-Host "Application ports: 3190 (V2 gate on), 3191 (V2 gate off)"
Write-Host "No import/export. Protected UAT projects and ports are NOT used." -ForegroundColor Green

try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    & $node $firebaseCli emulators:exec `
        --config $configurationPath `
        --project $projectId `
        --only firestore,auth `
        --log-verbosity=QUIET `
        "node tests/run-recovery-approval-http.mjs"
    if ($LASTEXITCODE -ne 0) {
        throw "Recovery approval HTTP integration tests failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $configurationPath) {
        Remove-Item -LiteralPath $configurationPath
    }
}

Write-Host ""
Write-Host "RECOVERY APPROVAL HTTP INTEGRATION TESTS PASSED" -ForegroundColor Green
