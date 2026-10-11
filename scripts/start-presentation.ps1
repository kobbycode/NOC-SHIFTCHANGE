param([ValidateSet("emulators", "app", "prepare", "validate", "inspect")][string]$Service = "app", [ValidateSet("current", "ready", "completed")][string]$Checkpoint = "current")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:FIREBASE_PROJECT_ID = "demo-shiftchange-v2"
$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID = "demo-shiftchange-v2"
$env:GCLOUD_PROJECT = "demo-shiftchange-v2"
$env:GOOGLE_CLOUD_PROJECT = "demo-shiftchange-v2"
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
$env:NEXT_PUBLIC_USE_FIREBASE_EMULATORS = "true"
$env:NEXT_PUBLIC_FIREBASE_API_KEY = "demo-presentation-key"
$env:NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = "demo-shiftchange-v2.firebaseapp.com"
$env:NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = "demo-shiftchange-v2.appspot.com"
$env:NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = "000000000000"
$env:NEXT_PUBLIC_FIREBASE_APP_ID = "1:000000000000:web:demo-presentation"
$env:APP_ORIGIN = "http://localhost:3100"
if ($Service -eq "emulators") {
  $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
  $env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
  $options = @("emulators:start", "--config", "firebase.presentation.json", "--project", "demo-shiftchange-v2", "--only", "auth,firestore", "--export-on-exit=.demo/emulator-data", "--log-verbosity=QUIET")
  $importDirectory = if ($Checkpoint -eq "ready") { '.demo/ready-export' } elseif ($Checkpoint -eq "completed") { '.demo/completed-export' } elseif (Test-Path -LiteralPath '.demo/emulator-data/firebase-export-metadata.json') { '.demo/emulator-data' } else { '.demo/completed-export' }
  if (Test-Path -LiteralPath "$importDirectory/firebase-export-metadata.json") { $options += "--import=$importDirectory" }
  elseif ($Checkpoint -ne "current") { throw "Requested demo checkpoint does not exist." }
  & firebase @options
} elseif ($Service -eq "prepare") {
  & node scripts/prepare-presentation.mjs
} elseif ($Service -eq "validate") {
  & node scripts/validate-presentation.mjs
} elseif ($Service -eq "inspect") {
  & node scripts/inspect-presentation.mjs
} else {
  & npm run dev -- --webpack --hostname 127.0.0.1 --port 3100
}
exit $LASTEXITCODE
