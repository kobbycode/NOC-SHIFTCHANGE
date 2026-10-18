$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$projectId = "demo-shiftchange-guard"
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

# Allow CLI execution of modules marked "server-only".
if ($env:NODE_OPTIONS -notmatch '--conditions=react-server') {
    $env:NODE_OPTIONS = "$env:NODE_OPTIONS --conditions=react-server".Trim()
}

# Generate a temporary emulator config that extends firebase.emulator.json with Firestore rules.
$configurationPath = Join-Path $repoRoot "firebase.guard-emulator.generated.json"
if (Test-Path -LiteralPath $configurationPath) {
    throw "Refusing to overwrite an existing generated emulator configuration."
}

$configuration = Get-Content -LiteralPath (Join-Path $repoRoot "firebase.emulator.json") -Raw | ConvertFrom-Json
$configuration | Add-Member -NotePropertyName firestore -NotePropertyValue @{ rules = "firestore.rules" }

Write-Host ""
Write-Host "=== GUARD EMULATOR SAFETY BOUNDARY ===" -ForegroundColor Cyan
Write-Host "Project: $projectId"
Write-Host "Firestore port: 8088"
Write-Host "Java: $(Join-Path $javaRuntime 'bin\java.exe')"
Write-Host "Production project IDs are NOT used." -ForegroundColor Green

try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    firebase emulators:exec `
        --config $configurationPath `
        --project $projectId `
        --only firestore `
        --log-verbosity=QUIET `
        'node --import tsx --test --test-concurrency=1 tests/handover-reservation-guard-emulator.test.mjs'
    if ($LASTEXITCODE -ne 0) {
        throw "Guard emulator tests failed with exit code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $configurationPath) {
        Remove-Item -LiteralPath $configurationPath
    }
}

Write-Host ""
Write-Host "GUARD EMULATOR TESTS PASSED" -ForegroundColor Green
