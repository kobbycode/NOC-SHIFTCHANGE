$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
$projectId = "demo-shiftchange-handover-resolution"
$javaRuntime = "C:\Program Files\Android\Android Studio\jbr"
if (-not (Test-Path -LiteralPath (Join-Path $javaRuntime "bin\java.exe"))) { throw "Required Java runtime was not found." }
$env:JAVA_HOME = $javaRuntime
$env:PATH = "$(Join-Path $javaRuntime 'bin');$env:PATH"
$env:FIREBASE_PROJECT_ID = $projectId
$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID = $projectId
$env:GCLOUD_PROJECT = $projectId
$env:GOOGLE_CLOUD_PROJECT = $projectId
if ($env:NODE_OPTIONS -notmatch '--conditions=react-server') { $env:NODE_OPTIONS = "$env:NODE_OPTIONS --conditions=react-server".Trim() }
# Explicitly load the actual deny-all repository rules, unlike legacy runners.
$configurationPath = Join-Path $repoRoot "firebase.handover-resolution-emulator.generated.json"
if (Test-Path -LiteralPath $configurationPath) { throw "Refusing to overwrite an existing generated emulator configuration." }
$configuration = Get-Content -LiteralPath (Join-Path $repoRoot "firebase.emulator.json") -Raw | ConvertFrom-Json
$configuration | Add-Member -NotePropertyName firestore -NotePropertyValue @{ rules = "firestore.rules" }
try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    firebase emulators:exec --config $configurationPath --project $projectId --only firestore --log-verbosity=QUIET `
      'node --import tsx --test --test-concurrency=1 tests/formal-handover-resolution-emulator.test.mjs'
    if ($LASTEXITCODE -ne 0) { throw "Formal handover emulator tests failed with exit code $LASTEXITCODE." }
} finally {
    if (Test-Path -LiteralPath $configurationPath) { Remove-Item -LiteralPath $configurationPath }
}
