#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Python = "",
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$RendererUrl = "http://127.0.0.1:8765",
    [string]$Token = "",
    [string]$TokenFile = "",
    [string]$WorkerId = "",
    [string]$TaskName = "SlideFlow-WPS-Render-Pull"
)
. (Join-Path $PSScriptRoot "Renderer-Common.ps1")
Assert-RendererAdministrator
$uri = [Uri]$Url
if ($uri.AbsolutePath -ne "/" -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) { throw "Url must contain only scheme, host and port." }
$loopback = @("127.0.0.1", "localhost", "::1") -contains $uri.Host.ToLowerInvariant()
if ($uri.Scheme -ne "https" -and -not ($uri.Scheme -eq "http" -and $loopback)) { throw "Url must use HTTPS unless connected through a loopback tunnel." }
if ($RendererUrl -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$') { throw "RendererUrl must use the local loopback renderer." }
$layout = Get-RendererLayout $InstallRoot "config.json"
if (-not $Python) { $Python = Join-Path $layout.CodeRoot ".venv\Scripts\python.exe" }
$Python = Resolve-RendererExecutable $Python "Python"
if ($TokenFile) { $Token = (Get-Content -LiteralPath (Resolve-RendererPath $TokenFile) -Raw).Trim() }
if (-not $Token) { $Token = Read-RendererToken $layout.Token }
Assert-RendererToken $Token
if (-not $WorkerId) { $WorkerId = "$env:COMPUTERNAME-render-pull" }
if ($WorkerId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { throw "WorkerId is invalid." }
$pullConfig = Join-Path $layout.Shared "render-pull.json"
$pullToken = Join-Path $layout.Shared "render-pull.token"
New-Item -ItemType Directory -Path $layout.Shared -Force | Out-Null
Set-RendererToken $pullToken $Token ([Security.Principal.WindowsIdentity]::GetCurrent().Name) | Out-Null
@{
    url = $Url
    renderer_url = $RendererUrl
    token_file = $pullToken
    worker_id = $WorkerId
    wait_seconds = 25
    renew_seconds = 30
    retry_seconds = 5
    work_dir = (Join-Path $layout.Shared "pull-work")
} | ConvertTo-Json | Set-Content -LiteralPath $pullConfig -Encoding UTF8
Protect-RendererPath $pullConfig ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$action = New-ScheduledTaskAction -Execute $Python -Argument ("-m wps_renderer.render_pull --config `"{0}`"" -f $pullConfig) -WorkingDirectory $layout.CodeRoot
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'SlideFlow WPS render pull protocol v1' -Force | Out-Null
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Render pull task '$TaskName' registered and started."
