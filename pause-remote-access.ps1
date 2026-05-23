$ErrorActionPreference = "Stop"

$accessFile = Join-Path $PSScriptRoot "remote-access.enabled"
Set-Content -LiteralPath $accessFile -Value "disabled" -Encoding UTF8
Write-Host "Remote access is paused. Local worker will not claim new Render jobs."
