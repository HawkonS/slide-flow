# Backwards-compatible alias used by older Install.ps1/Upgrade.ps1 releases.
# New deployments should use Register.ps1 explicitly and Start.ps1 separately.
[CmdletBinding()]
param(
    [string]$Python = "",
    [string]$Config = "config.json",
    [string]$TaskName = "SlideFlow-WPS-Renderer"
)
$args = @{ Config = $Config; TaskName = $TaskName; Start = $true }
if ($Python) { $args.Python = $Python }
& (Join-Path $PSScriptRoot "Register.ps1") @args
exit $LASTEXITCODE
