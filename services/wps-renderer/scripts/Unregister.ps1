#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Config = "config.json",
    [string]$TaskName = "SlideFlow-WPS-Renderer",
    [int]$TimeoutSeconds = 45
)
. (Join-Path $PSScriptRoot "Renderer-Common.ps1")
Assert-RendererAdministrator
$task = Get-RendererTask $TaskName
if ($task -and $PSCmdlet.ShouldProcess($TaskName, "Stop and unregister scheduled task")) {
    if ($task.Description -ne 'SlideFlow WPS Renderer protocol v1') { throw "Refusing to remove an unrelated scheduled task." }
    & (Join-Path $PSScriptRoot "Stop.ps1") -InstallRoot $InstallRoot -Config $Config -TaskName $TaskName -TimeoutSeconds $TimeoutSeconds
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Renderer task '$TaskName' unregistered. Config and token were kept."
} elseif (-not $task) {
    Write-Host "Renderer task '$TaskName' is not registered."
}
$fontTask = Get-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" -ErrorAction SilentlyContinue
if ($fontTask -and $fontTask.Description -eq 'SlideFlow WPS font pull protocol v1' -and $PSCmdlet.ShouldProcess("SlideFlow-WPS-Font-Sync", "Unregister font sync task")) {
    if ($fontTask.State -eq 'Running') { Stop-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" }
    Unregister-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" -Confirm:$false
}
$pullTask = Get-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" -ErrorAction SilentlyContinue
if ($pullTask -and $pullTask.Description -eq 'SlideFlow WPS render pull protocol v1' -and $PSCmdlet.ShouldProcess("SlideFlow-WPS-Render-Pull", "Unregister render pull task")) {
    if ($pullTask.State -eq 'Running') { Stop-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" }
    Unregister-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" -Confirm:$false
}
