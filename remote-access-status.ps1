$ErrorActionPreference = "Stop"

$accessFile = Join-Path $PSScriptRoot "remote-access.enabled"
if (-not (Test-Path -LiteralPath $accessFile)) {
  Write-Host "enabled (state file missing, default allow)"
  exit 0
}

$value = (Get-Content -LiteralPath $accessFile -Raw).Trim().ToLowerInvariant()
if ($value -in @("0", "false", "no", "off", "disabled", "pause", "paused", "deny")) {
  Write-Host "paused"
} else {
  Write-Host "enabled"
}
