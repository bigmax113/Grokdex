$ErrorActionPreference = "Stop"

$accessFile = Join-Path $PSScriptRoot "remote-access.enabled"
Set-Content -LiteralPath $accessFile -Value "enabled" -Encoding UTF8
Write-Host "Remote access is enabled. Local worker may claim new Render jobs."
