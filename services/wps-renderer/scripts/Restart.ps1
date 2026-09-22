#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Config = "config.json",
    [string]$TaskName = "SlideFlow-WPS-Renderer",
    [int]$TimeoutSeconds = 45
)
. (Join-Path $PSScriptRoot "Renderer-Common.ps1")
Assert-RendererAdministrator
& (Join-Path $PSScriptRoot "Stop.ps1") -InstallRoot $InstallRoot -Config $Config -TaskName $TaskName -TimeoutSeconds $TimeoutSeconds
& (Join-Path $PSScriptRoot "Start.ps1") -InstallRoot $InstallRoot -Config $Config -TaskName $TaskName
Write-Host "Renderer task '$TaskName' restarted."

