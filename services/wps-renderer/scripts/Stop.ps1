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
if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 600) { throw "TimeoutSeconds must be between 1 and 600." }
$layout = Get-RendererLayout $InstallRoot $Config
$task = Get-RendererTask $TaskName
if (-not $task) { Write-Host "Renderer task '$TaskName' is not registered."; return }
if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
$fontTask = Get-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" -ErrorAction SilentlyContinue
if ($fontTask -and $fontTask.State -eq 'Running') { Stop-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" }
$pullTask = Get-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" -ErrorAction SilentlyContinue
if ($pullTask -and $pullTask.State -eq 'Running') { Stop-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" }
if (-not (Wait-RendererProcessExit $layout.Config $TimeoutSeconds)) { throw "Renderer process did not stop within $TimeoutSeconds seconds." }
Write-Host "Renderer task '$TaskName' stopped."
