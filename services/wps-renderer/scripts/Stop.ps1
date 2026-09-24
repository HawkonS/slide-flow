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
$task = Get-RendererManagedTask $TaskName 'SlideFlow WPS Renderer protocol v1'
$fontTask = Get-RendererManagedTask "SlideFlow-WPS-Font-Sync" 'SlideFlow WPS font pull protocol v1'
if ($fontTask -and $fontTask.State -eq 'Running') { Stop-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" }
$pullTask = Get-RendererManagedTask "SlideFlow-WPS-Render-Pull" 'SlideFlow WPS render pull protocol v1'
if ($pullTask -and $pullTask.State -eq 'Running') { Stop-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" }
if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
if ($task -and -not (Wait-RendererProcessExit $layout.Config $TimeoutSeconds)) { throw "Renderer process did not stop within $TimeoutSeconds seconds." }
foreach ($workerConfig in @((Join-Path $layout.Shared "font-sync.json"), (Join-Path $layout.Shared "render-pull.json"))) {
    if (-not (Wait-RendererProcessExit $workerConfig $TimeoutSeconds)) { throw "A renderer pull worker did not stop within $TimeoutSeconds seconds." }
}
Write-Host "Renderer and registered pull tasks stopped."
