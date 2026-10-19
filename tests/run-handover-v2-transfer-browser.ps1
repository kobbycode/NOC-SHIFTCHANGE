$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# HARD SAFETY BOUNDARY: the browser verification runs only against the synthetic
# presentation emulator project. Production project identifiers are never used.
$projectId = "demo-shiftchange-v2"
$javaRuntime = "C:\Program Files\Android\Android Studio\jbr"
if (-not (Test-Path -LiteralPath (Join-Path $javaRuntime "bin\java.exe"))) {
    throw "Required Java runtime was not found."
}
$env:JAVA_HOME = $javaRuntime
$env:PATH = "$(Join-Path $repoRoot 'node_modules\.bin');$(Join-Path $javaRuntime 'bin');$env:PATH"

$env:FIREBASE_PROJECT_ID = $projectId
$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID = $projectId
$env:GCLOUD_PROJECT = $projectId
$env:GOOGLE_CLOUD_PROJECT = $projectId
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
$env:NEXT_PUBLIC_USE_FIREBASE_EMULATORS = "true"
$env:NEXT_PUBLIC_FIREBASE_API_KEY = "demo-presentation-key"
$env:NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = "$projectId.firebaseapp.com"
$env:NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = "$projectId.appspot.com"
$env:NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = "000000000000"
$env:NEXT_PUBLIC_FIREBASE_APP_ID = "1:000000000000:web:demo-presentation"

$port = if ($env:HO07_BROWSER_PORT) { $env:HO07_BROWSER_PORT } else { "3103" }
$env:HO07_BROWSER_PORT = $port
$env:APP_ORIGIN = "http://127.0.0.1:$port"

# §12: the v2 gate defaults to off. The verification script enables
# it only inside the spawned application process, never in this parent shell.
if (Test-Path -LiteralPath 'env:HANDOVER_V2_DEV') {
    Remove-Item -LiteralPath 'env:HANDOVER_V2_DEV'
}

Write-Host ""
Write-Host "=== EQUAL-HANDOVER V2 FINAL TRANSFER BROWSER SAFETY BOUNDARY ===" -ForegroundColor Cyan
Write-Host "Project: $projectId"
Write-Host "Auth emulator: 127.0.0.1:9099   Firestore emulator: 127.0.0.1:8080"
Write-Host "Application origin: $env:APP_ORIGIN"
Write-Host "Java: $(Join-Path $javaRuntime 'bin\java.exe')"
Write-Host "Production project IDs and the shared presentation emulator data are NOT used." -ForegroundColor Green

# §12: real browser flow against a real Next.js server and both emulators.
& node --import tsx --conditions=react-server scripts/verify-handover-v2-transfer-browser.mjs
if ($LASTEXITCODE -ne 0) {
    throw "Equal-handover v2 final transfer browser verification failed with exit code $LASTEXITCODE."
}

Write-Host ""
Write-Host "EQUAL-HANDOVER V2 FINAL TRANSFER BROWSER VERIFICATION PASSED" -ForegroundColor Green
