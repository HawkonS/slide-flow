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
$pullWorkers = @(Get-RendererManagedPullTasks)
foreach ($worker in $pullWorkers) {
    if ($worker.Task.State -eq 'Running') { Stop-ScheduledTask -InputObject $worker.Task }
}
if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
if ($task -and -not (Wait-RendererProcessExit $layout.Config $TimeoutSeconds)) { throw "Renderer process did not stop within $TimeoutSeconds seconds." }
foreach ($worker in $pullWorkers) {
    if (-not (Wait-RendererProcessExit $worker.Config $TimeoutSeconds)) {
        throw "Renderer pull task '$($worker.Task.TaskName)' did not stop within $TimeoutSeconds seconds."
    }
}
Write-Host "Renderer and registered pull tasks stopped."
