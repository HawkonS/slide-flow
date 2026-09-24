param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Config = "config.json",
    [string]$TaskName = "SlideFlow-WPS-Renderer",
    [switch]$Foreground
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Renderer-Common.ps1")
if ($Foreground) {
    $layout = Get-RendererLayout $InstallRoot $Config
    $python = Join-Path $layout.CodeRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "Renderer Python does not exist; run Install.ps1 first." }
    & $python -m wps_renderer --config $layout.Config
    exit $LASTEXITCODE
}
Assert-RendererAdministrator
$layout = Get-RendererLayout $InstallRoot $Config
$task = Get-RendererManagedTask $TaskName 'SlideFlow WPS Renderer protocol v1'
if (-not $task) { throw "Renderer task is not registered. Run Register.ps1 first." }
if ($task.State -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Renderer task '$TaskName' start requested."
} else {
    Write-Host "Renderer task '$TaskName' is already running."
}
Wait-RendererHealthy $layout 30 | Out-Null
$fontTask = Get-RendererManagedTask "SlideFlow-WPS-Font-Sync" 'SlideFlow WPS font pull protocol v1'
if ($fontTask -and $fontTask.State -ne 'Running') { Start-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" }
$pullTask = Get-RendererManagedTask "SlideFlow-WPS-Render-Pull" 'SlideFlow WPS render pull protocol v1'
if ($pullTask -and $pullTask.State -ne 'Running') { Start-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" }
Write-Host "Renderer is healthy; registered pull workers are running."
