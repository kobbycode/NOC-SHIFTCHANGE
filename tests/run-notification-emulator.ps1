$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$projectId = "demo-shiftchange-notifications"
# firebase-tools requires a Java 21+ runtime for the Firestore emulator.
$javaCandidates = @(
    "C:\Users\Jonah\.qoder\bin\jre21\jdk-21.0.12.1+1-jre",
    "C:\Program Files\Android\Android Studio\jbr"
)
$javaRuntime = $javaCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ "bin\java.exe") } | Select-Object -First 1
if (-not $javaRuntime) {
    throw "A Java 21+ runtime was not found in any known location."
}
$env:JAVA_HOME = $javaRuntime
$env:PATH = "$(Join-Path $javaRuntime 'bin');$env:PATH"

# HARD SAFETY BOUNDARY: all four project env vars must point to the demo project.
$env:FIREBASE_PROJECT_ID = $projectId
$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID = $projectId
$env:GCLOUD_PROJECT = $projectId
$env:GOOGLE_CLOUD_PROJECT = $projectId
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8095"

# The notification suite owns the NOTIFICATIONS_ENABLED gate and toggles it per
# test (including the default-off regression proof). It must never be inherited.
$env:NOTIFICATIONS_ENABLED = $null
$env:HANDOVER_V2_DEV = $null

# Allow CLI execution of modules marked "server-only".
if ($env:NODE_OPTIONS -notmatch '--conditions=react-server') {
    $env:NODE_OPTIONS = "$env:NODE_OPTIONS --conditions=react-server".Trim()
}

# Generate a temporary emulator config on the dedicated notification emulator port.
$configurationPath = Join-Path $repoRoot "firebase.notification-emulator.generated.json"
if (Test-Path -LiteralPath $configurationPath) {
    throw "Refusing to overwrite an existing generated emulator configuration."
}

$configuration = Get-Content -LiteralPath (Join-Path $repoRoot "firebase.emulator.json") -Raw | ConvertFrom-Json
$configuration.emulators.firestore.port = 8095
$configuration | Add-Member -NotePropertyName firestore -NotePropertyValue @{ rules = "firestore.rules" }

# Resolve the firebase CLI: global, pinned dev dependency, then the Qoder-managed install.
$firebaseCommand = if (Get-Command firebase -ErrorAction SilentlyContinue) {
    @{ File = "firebase"; Args = @() }
} elseif (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules\.bin\firebase.cmd")) {
    @{ File = (Join-Path $repoRoot "node_modules\.bin\firebase.cmd"); Args = @() }
} elseif (Test-Path -LiteralPath "$env:USERPROFILE\.qoder\bin\firebase-tools\node_modules\.bin\firebase.cmd") {
    @{ File = "$env:USERPROFILE\.qoder\bin\firebase-tools\node_modules\.bin\firebase.cmd"; Args = @() }
} else {
    throw "The firebase CLI is not available."
}

Write-Host ""
Write-Host "=== NOTIFICATION OUTBOX (09L) EMULATOR SAFETY BOUNDARY ===" -ForegroundColor Cyan
Write-Host "Project: $projectId"
Write-Host "Firestore port: 8095"
Write-Host "Java: $(Join-Path $javaRuntime 'bin\java.exe')"
Write-Host "Production project IDs and FCM are NOT used; delivery runs against the mock transport." -ForegroundColor Green

try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    & $firebaseCommand.File @($firebaseCommand.Args) emulators:exec `
        --config $configurationPath `
        --project $projectId `
        --only firestore `
        --log-verbosity=QUIET `
        'node --import tsx --test --test-concurrency=1 tests/notification-emulator.test.mjs'
    if ($LASTEXITCODE -ne 0) {
        throw "Notification outbox emulator tests failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $configurationPath) {
        Remove-Item -LiteralPath $configurationPath
    }
}

Write-Host ""
Write-Host "NOTIFICATION OUTBOX (09L) EMULATOR TESTS PASSED" -ForegroundColor Green
