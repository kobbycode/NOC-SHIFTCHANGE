$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$projectId = "demo-shiftchange-handover-v2"
$javaRuntime = "C:\Program Files\Android\Android Studio\jbr"
if (-not (Test-Path -LiteralPath (Join-Path $javaRuntime "bin\java.exe"))) {
    throw "Required Java runtime was not found."
}
$env:JAVA_HOME = $javaRuntime
$env:PATH = "$(Join-Path $javaRuntime 'bin');$env:PATH"

# HARD SAFETY BOUNDARY: all four project env vars must point to the demo project.
$env:FIREBASE_PROJECT_ID = $projectId
$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID = $projectId
$env:GCLOUD_PROJECT = $projectId
$env:GOOGLE_CLOUD_PROJECT = $projectId
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8092"

# The v2 transfer suite exercises its own development-gate transitions and
# must never inherit a feature flag set outside the suite.
$env:HANDOVER_V2_DEV = $null

# Allow CLI execution of modules marked "server-only".
if ($env:NODE_OPTIONS -notmatch '--conditions=react-server') {
    $env:NODE_OPTIONS = "$env:NODE_OPTIONS --conditions=react-server".Trim()
}

# Generate a temporary emulator config on the dedicated v2 report port.
$configurationPath = Join-Path $repoRoot "firebase.handover-v2-transfer-emulator.generated.json"
if (Test-Path -LiteralPath $configurationPath) {
    throw "Refusing to overwrite an existing generated emulator configuration."
}

$configuration = Get-Content -LiteralPath (Join-Path $repoRoot "firebase.emulator.json") -Raw | ConvertFrom-Json
$configuration.emulators.firestore.port = 8092
$configuration | Add-Member -NotePropertyName firestore -NotePropertyValue @{ rules = "firestore.rules" }

# Use the global firebase CLI when installed, otherwise the pinned dev dependency.
$firebaseCommand = if (Get-Command firebase -ErrorAction SilentlyContinue) {
    @{ File = "firebase"; Args = @() }
} elseif (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules\.bin\firebase.cmd")) {
    @{ File = (Join-Path $repoRoot "node_modules\.bin\firebase.cmd"); Args = @() }
} else {
    throw "The firebase CLI is not available."
}

Write-Host ""
Write-Host "=== EQUAL-HANDOVER V2 FINAL TRANSFER EMULATOR SAFETY BOUNDARY ===" -ForegroundColor Cyan
Write-Host "Project: $projectId"
Write-Host "Firestore port: 8092"
Write-Host "Java: $(Join-Path $javaRuntime 'bin\java.exe')"
Write-Host "Production project IDs are NOT used." -ForegroundColor Green

try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    & $firebaseCommand.File @($firebaseCommand.Args) emulators:exec `
        --config $configurationPath `
        --project $projectId `
        --only firestore `
        --log-verbosity=QUIET `
        'node --import tsx --test --test-concurrency=1 tests/handover-v2-transfer-emulator.test.mjs'
    if ($LASTEXITCODE -ne 0) {
        throw "Equal-handover v2 final transfer emulator tests failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $configurationPath) {
        Remove-Item -LiteralPath $configurationPath
    }
}

Write-Host ""
Write-Host "EQUAL-HANDOVER V2 FINAL TRANSFER EMULATOR TESTS PASSED" -ForegroundColor Green
