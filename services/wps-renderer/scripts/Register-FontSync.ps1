#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Python = "",
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$Token = "",
    [string]$TokenFile = "",
    [int]$PollSeconds = 5,
    [string]$TaskName = "SlideFlow-WPS-Font-Sync"
)
. (Join-Path $PSScriptRoot "Renderer-Common.ps1")
Assert-RendererAdministrator
if ($Url -notmatch '^https?://[^/]+$') { throw "Url must contain only scheme, host and port." }
if ($PollSeconds -lt 1 -or $PollSeconds -gt 300) { throw "PollSeconds must be between 1 and 300." }
$layout = Get-RendererLayout $InstallRoot "config.json"
if (-not $Python) { $Python = Join-Path $layout.CodeRoot ".venv\Scripts\python.exe" }
$Python = Resolve-RendererExecutable $Python "Python"
if ($TokenFile) { $Token = (Get-Content -LiteralPath (Resolve-RendererPath $TokenFile) -Raw).Trim() }
if (-not $Token) { $Token = Read-RendererToken $layout.Token }
Assert-RendererToken $Token
$syncConfig = Join-Path $layout.Shared "font-sync.json"
$syncToken = Join-Path $layout.Shared "font-sync.token"
New-Item -ItemType Directory -Path $layout.Shared -Force | Out-Null
Set-RendererToken $syncToken $Token ([Security.Principal.WindowsIdentity]::GetCurrent().Name) | Out-Null
@{ url = $Url; token_file = $syncToken; interval = $PollSeconds; install_dir = (Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts") } |
    ConvertTo-Json | Set-Content -LiteralPath $syncConfig -Encoding UTF8
Protect-RendererPath $syncConfig ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$action = New-ScheduledTaskAction -Execute $Python -Argument ("-m wps_renderer.font_sync --config `"{0}`"" -f $syncConfig) -WorkingDirectory $layout.CodeRoot
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'SlideFlow WPS font pull protocol v1' -Force | Out-Null
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Font sync task '$TaskName' registered and started."
