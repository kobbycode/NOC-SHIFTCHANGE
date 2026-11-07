# Shared executable discovery only; dot-sourcing does not start or stop services.
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
function Get-09mNode {
    $candidate = Join-Path $env:USERPROFILE ".qoder\bin\node-v24.22.1-win-x64\node.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    $command = Get-Command node -ErrorAction Stop
    return $command.Source
}
