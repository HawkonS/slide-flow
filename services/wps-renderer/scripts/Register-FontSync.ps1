#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Python = "",
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$Token = "",
    [string]$TokenFile = "",
    [string]$ConfigFile = "",
    [string]$SyncTokenFile = "",
    [int]$PollSeconds = 5,
    [string]$TaskName = "SlideFlow-WPS-Font-Sync"
)
. (Join-Path $PSScriptRoot "Renderer-Common.ps1")
Assert-RendererAdministrator
$uri = [Uri]$Url
if ($uri.AbsolutePath -ne "/" -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) { throw "Url must contain only scheme, host and port." }
$loopback = @("127.0.0.1", "localhost", "::1") -contains $uri.Host.ToLowerInvariant()
if ($uri.Scheme -ne "https" -and -not ($uri.Scheme -eq "http" -and $loopback)) { throw "Url must use HTTPS unless connected through a loopback tunnel." }
if ($PollSeconds -lt 1 -or $PollSeconds -gt 300) { throw "PollSeconds must be between 1 and 300." }
$layout = Get-RendererLayout $InstallRoot "config.json"
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-RendererManagedTask $TaskName 'SlideFlow WPS font pull protocol v1'
$currentAccount = ($currentIdentity -split '\\')[-1]
$existingAccount = if ($existing -and $existing.Principal.UserId) { ([string]$existing.Principal.UserId -split '\\')[-1] } else { "" }
if ($existingAccount -and $existingAccount -ne $currentAccount) { throw "Refusing to take over a font sync task owned by another Windows account." }
if (-not $Python) { $Python = Join-Path $layout.CodeRoot ".venv\Scripts\python.exe" }
$Python = Resolve-RendererExecutable $Python "Python"
if ($TokenFile) { $Token = (Get-Content -LiteralPath (Resolve-RendererPath $TokenFile) -Raw).Trim() }
if (-not $Token) { $Token = Read-RendererToken $layout.Token }
Assert-RendererToken $Token
$syncConfig = if ($ConfigFile) { Resolve-RendererPath $ConfigFile } else { Join-Path $layout.Shared "font-sync.json" }
$syncParent = Split-Path -Parent $syncConfig
$syncStem = [IO.Path]::GetFileNameWithoutExtension($syncConfig)
$syncToken = if ($SyncTokenFile) {
    Resolve-RendererPath $SyncTokenFile
} elseif ($ConfigFile) {
    Join-Path $syncParent ($syncStem + ".token")
} else {
    Join-Path $layout.Shared "font-sync.token"
}
New-Item -ItemType Directory -Path $layout.Shared -Force | Out-Null
New-Item -ItemType Directory -Path $syncParent -Force | Out-Null
Set-RendererToken $syncToken $Token ([Security.Principal.WindowsIdentity]::GetCurrent().Name) | Out-Null
@{ url = $Url; token_file = $syncToken; interval = $PollSeconds; install_dir = (Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts") } |
    ConvertTo-Json | Set-Content -LiteralPath $syncConfig -Encoding UTF8
Protect-RendererPath $syncConfig ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$action = New-ScheduledTaskAction -Execute $Python -Argument ("-m wps_renderer.font_sync --config `"{0}`"" -f $syncConfig) -WorkingDirectory $layout.CodeRoot
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType S4U -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'SlideFlow WPS font pull protocol v1' -Force | Out-Null
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Font sync task '$TaskName' registered and started."
