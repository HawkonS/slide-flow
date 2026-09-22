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
$task = Get-RendererTask $TaskName
if (-not $task) { throw "Renderer task is not registered. Run Register.ps1 first." }
$fontTask = Get-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" -ErrorAction SilentlyContinue
if ($fontTask -and $fontTask.State -ne 'Running') { Start-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" }
if ($task.State -eq 'Running') { Write-Host "Renderer task '$TaskName' is already running."; return }
Start-ScheduledTask -TaskName $TaskName
Write-Host "Renderer task '$TaskName' start requested."
