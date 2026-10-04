$ErrorActionPreference = "Stop"

$projectId =
    "demo-shiftchange-technician-current"

$expectedPort =
    "8088"

$repoRoot =
    Split-Path -Parent $PSScriptRoot

Set-Location $repoRoot

$javaHome =
    "C:\Program Files\Android\Android Studio\jbr"

$javaExe =
    Join-Path `
        $javaHome `
        "bin\java.exe"

if (
    -not (
        Test-Path $javaExe
    )
) {
    throw "Required Android Studio Java runtime was not found."
}

$tsx =
    Join-Path `
        $repoRoot `
        "node_modules\.bin\tsx.cmd"

if (
    -not (
        Test-Path $tsx
    )
) {
    throw "tsx is not installed. Run npm install first."
}

$env:JAVA_HOME =
    $javaHome

$env:PATH =
    "$(Join-Path $javaHome 'bin');$env:PATH"

# HARD SAFETY BOUNDARY:
# Force every Admin SDK project identifier
# to a synthetic Firebase demo project.
$env:FIREBASE_PROJECT_ID =
    $projectId

$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID =
    $projectId

$env:GCLOUD_PROJECT =
    $projectId

$env:GOOGLE_CLOUD_PROJECT =
    $projectId

if ($env:NODE_OPTIONS) {
    if (
        $env:NODE_OPTIONS -notmatch
            "--conditions=react-server"
    ) {
        $env:NODE_OPTIONS =
            "$env:NODE_OPTIONS --conditions=react-server"
    }
}
else {
    $env:NODE_OPTIONS =
        "--conditions=react-server"
}

Write-Host ""

Write-Host `
    "=== A6.2 TECHNICIAN CURRENT-SHIFT EMULATOR SAFETY BOUNDARY ===" `
    -ForegroundColor Cyan

Write-Host "Project: $projectId"
Write-Host "Firestore port: $expectedPort"
Write-Host "Java: $javaExe"

Write-Host `
    "Production project IDs are NOT used." `
    -ForegroundColor Green

$testScript =
    "tests\run-technician-current-shift-emulator-test.cmd"

if (
    -not (
        Test-Path `
            -LiteralPath $testScript
    )
) {
    throw "Missing emulator test wrapper: $testScript"
}

$debugLog =
    Join-Path `
        $repoRoot `
        "firestore-debug.log"

# Remove a disposable log left by an
# interrupted or previous emulator run.
if (
    Test-Path `
        -LiteralPath $debugLog
) {
    Remove-Item `
        -LiteralPath $debugLog `
        -Force
}

firebase emulators:exec `
    --config firebase.emulator.json `
    --project $projectId `
    --only firestore `
    --log-verbosity=QUIET `
    $testScript

$exitCode =
    $LASTEXITCODE

# firebase emulators:exec may create a
# disposable Firestore diagnostic log.
# Allow emulator shutdown to settle, then
# ensure that artifact does not remain in
# the repository working tree.
for (
    $attempt = 0;
    $attempt -lt 10;
    $attempt += 1
) {
    Start-Sleep `
        -Milliseconds 250

    if (
        Test-Path `
            -LiteralPath $debugLog
    ) {
        Remove-Item `
            -LiteralPath $debugLog `
            -Force
    }
}

if (
    Test-Path `
        -LiteralPath $debugLog
) {
    throw "Disposable firestore-debug.log remained after emulator shutdown."
}

if (
    $exitCode -ne 0
) {
    throw "A6.2 Firestore emulator tests failed with exit code $exitCode."
}

Write-Host ""

Write-Host `
    "A6.2 TECHNICIAN CURRENT-SHIFT FIRESTORE EMULATOR TESTS PASSED" `
    -ForegroundColor Green
