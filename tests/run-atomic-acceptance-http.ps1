$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# HARD SAFETY BOUNDARY: a fresh disposable project on dedicated ports, no import
# or export. The presentation, 09D, 09L and 09M UAT stacks are never contacted.
$projectId = "demo-atomic-acceptance-r5"
$node = "C:\Users\Jonah\.qoder\bin\node-v24.18.0-win-x64\node.exe"
$javaRuntime = "C:\Users\Jonah\.qoder\bin\jre21\jdk-21.0.12.1+1-jre"
$firebaseCli = "C:\Users\Jonah\.qoder\bin\firebase-tools\node_modules\firebase-tools\lib\bin\firebase.js"

foreach ($required in @($node, (Join-Path $javaRuntime "bin\java.exe"), $firebaseCli, (Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"), (Join-Path $repoRoot "node_modules\next\dist\bin\next"))) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required tool was not found: $required"
    }
}

# Firestore 8183 / websocket 9183, Auth 9083, hub 4410, logging 4510 and the two
# application ports (gates on 3210, gates off 3211).
foreach ($port in @(8183, 9083, 9183, 4410, 4510, 3210, 3211)) {
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
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8183"
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9083"
$env:NEXT_PUBLIC_USE_FIREBASE_EMULATORS = "true"
# The isolated Auth emulator accepts this synthetic key; it is never a secret.
$env:NEXT_PUBLIC_FIREBASE_API_KEY = "synthetic-atomic-http-key"
$env:NOTIFICATIONS_ENABLED = "true"
# The v2 flag is on for both servers; the atomic gate itself is set ONLY on the
# gates-on child and on the test process, never inherited by the gates-off one.
$env:HANDOVER_V2_DEV = "true"
$env:HANDOVER_V2_ATOMIC_ACCEPTANCE = $null

$configurationPath = Join-Path $repoRoot "firebase.atomic-acceptance-http-emulator.generated.json"
if (Test-Path -LiteralPath $configurationPath) {
    throw "Refusing to overwrite an existing generated emulator configuration."
}

$configuration = @{
    firestore = @{ rules = "firestore.rules" }
    emulators = @{
        auth = @{ host = "127.0.0.1"; port = 9083 }
        firestore = @{ host = "127.0.0.1"; port = 8183; websocketPort = 9183 }
        hub = @{ host = "127.0.0.1"; port = 4410 }
        logging = @{ host = "127.0.0.1"; port = 4510 }
        ui = @{ enabled = $false }
        singleProjectMode = $true
    }
}

Write-Host ""
Write-Host "=== ATOMIC ACCEPTANCE HTTP EMULATOR SAFETY BOUNDARY ===" -ForegroundColor Cyan
Write-Host "Project: $projectId"
Write-Host "Firestore port: 8183 (websocket 9183), Auth port: 9083 (hub 4410, logging 4510)"
Write-Host "Application ports: 3210 (atomic gate on), 3211 (atomic gate off)"
Write-Host "No import/export. Protected UAT projects and ports are NOT used." -ForegroundColor Green

try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    & $node $firebaseCli emulators:exec `
        --config $configurationPath `
        --project $projectId `
        --only firestore,auth `
        --log-verbosity=QUIET `
        "node tests/run-atomic-acceptance-http.mjs"
    if ($LASTEXITCODE -ne 0) {
        throw "Atomic acceptance HTTP integration tests failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $configurationPath) {
        Remove-Item -LiteralPath $configurationPath
    }
}

Write-Host ""
Write-Host "ATOMIC ACCEPTANCE HTTP INTEGRATION TESTS PASSED" -ForegroundColor Green
