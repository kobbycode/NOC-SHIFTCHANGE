$ErrorActionPreference = "Stop"

$projectId =
    "demo-shiftchange-attendance"

$expectedPort = "8088"

$repoRoot =
    Split-Path -Parent $PSScriptRoot

Set-Location $repoRoot

$javaHome =
    "C:\Program Files\Android\Android Studio\jbr"

$javaExe =
    Join-Path `
        $javaHome `
        "bin\java.exe"

if (-not (Test-Path $javaExe)) {
    throw "Required Android Studio Java runtime was not found."
}

$tsx =
    Join-Path `
        $repoRoot `
        "node_modules\.bin\tsx.cmd"

if (-not (Test-Path $tsx)) {
    throw "tsx is not installed. Run npm install first."
}

# Java is scoped to this runner process.
$env:JAVA_HOME = $javaHome

$env:PATH =
    "$(Join-Path $javaHome 'bin');$env:PATH"

# HARD SAFETY BOUNDARY:
# Application Admin SDK configuration is
# forced to a synthetic Firebase demo project.
$env:FIREBASE_PROJECT_ID =
    $projectId

$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID =
    $projectId

$env:GCLOUD_PROJECT =
    $projectId

$env:GOOGLE_CLOUD_PROJECT =
    $projectId

# Allow CLI execution of modules containing
# import "server-only".
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
    "=== ATTENDANCE A2.1 EMULATOR SAFETY BOUNDARY ===" `
    -ForegroundColor Cyan

Write-Host "Project: $projectId"
Write-Host "Firestore port: $expectedPort"
Write-Host "Java: $javaExe"

Write-Host `
    "Production project IDs are NOT used." `
    -ForegroundColor Green

$testScript =
    "tests\run-attendance-read-emulator-test.cmd"

if (
    -not (
        Test-Path `
            -LiteralPath $testScript
    )
) {
    throw "Missing emulator test wrapper: $testScript"
}

firebase emulators:exec `
    --config firebase.emulator.json `
    --project $projectId `
    --only firestore `
    --log-verbosity=QUIET `
    $testScript

$exitCode =
    $LASTEXITCODE

if ($exitCode -ne 0) {
    throw "Attendance A2.1 Firestore emulator tests failed with exit code $exitCode."
}

Write-Host ""

Write-Host `
    "ATTENDANCE A2.1 FIRESTORE EMULATOR TESTS PASSED" `
    -ForegroundColor Green