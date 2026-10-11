$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$projectId = "demo-shiftchange-handover-transfer"
$javaRuntime = "C:\Program Files\Android\Android Studio\jbr"
if (-not (Test-Path -LiteralPath "$javaRuntime\bin\java.exe")) { throw "Java runtime not found." }
$env:JAVA_HOME = $javaRuntime
$env:PATH = "$javaRuntime\bin;$env:PATH"
foreach ($key in @("FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT")) {
    Set-Item -Path "Env:$key" -Value $projectId
}
$env:NODE_OPTIONS = "$env:NODE_OPTIONS --conditions=react-server".Trim()
$configurationPath = Join-Path (Get-Location) "firebase.operations-emulator.generated.json"
if (Test-Path -LiteralPath $configurationPath) { throw "Refusing to overwrite generated configuration." }
$configuration = Get-Content -LiteralPath firebase.emulator.json -Raw | ConvertFrom-Json
$configuration | Add-Member -NotePropertyName firestore -NotePropertyValue @{ rules = "firestore.rules" }
try {
    $configuration | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configurationPath -Encoding utf8
    firebase emulators:exec --config $configurationPath --project $projectId --only firestore --log-verbosity=QUIET `
      'node --import tsx --test --test-concurrency=1 tests/shift-operations-emulator.test.mjs'
    if ($LASTEXITCODE -ne 0) { throw "Shift operations emulator tests failed: $LASTEXITCODE" }
} finally {
    if (Test-Path -LiteralPath $configurationPath) { Remove-Item -LiteralPath $configurationPath }
}
