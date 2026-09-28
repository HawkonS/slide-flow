#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Python = "",
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$RendererUrl = "http://127.0.0.1:8765",
    [string]$Token = "",
    [string]$TokenFile = "",
    [string]$RendererTokenFile = "",
    [string]$ConfigFile = "",
    [string]$PullTokenFile = "",
    [string]$WorkDir = "",
    [string]$WorkingDirectory = "",
    [string]$WorkerId = "",
    [int]$LocalJobTimeoutSeconds = 2100,
    [int]$PollFailureExitSeconds = 300,
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
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-RendererManagedTask $TaskName 'SlideFlow WPS render pull protocol v1'
$currentAccount = ($currentIdentity -split '\\')[-1]
$existingAccount = if ($existing -and $existing.Principal.UserId) { ([string]$existing.Principal.UserId -split '\\')[-1] } else { "" }
if ($existingAccount -and $existingAccount -ne $currentAccount) { throw "Refusing to take over a render pull task owned by another Windows account." }
if (-not $Python) { $Python = Join-Path $layout.CodeRoot ".venv\Scripts\python.exe" }
$Python = Resolve-RendererExecutable $Python "Python"
if ($TokenFile) { $Token = (Get-Content -LiteralPath (Resolve-RendererPath $TokenFile) -Raw).Trim() }
if (-not $Token) { $Token = Read-RendererToken $layout.Token }
Assert-RendererToken $Token
$rendererTokenPath = ""
if ($RendererTokenFile) {
    $rendererTokenPath = Resolve-RendererPath $RendererTokenFile
    if (-not (Test-Path -LiteralPath $rendererTokenPath -PathType Leaf)) { throw "Renderer token file not found: $rendererTokenPath" }
    Assert-RendererToken ((Get-Content -LiteralPath $rendererTokenPath -Raw).Trim())
}
if (-not $WorkerId) { $WorkerId = "$env:COMPUTERNAME-render-pull" }
if ($WorkerId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { throw "WorkerId is invalid." }
if ($LocalJobTimeoutSeconds -lt 60 -or $LocalJobTimeoutSeconds -gt 7200) { throw "LocalJobTimeoutSeconds must be between 60 and 7200." }
if ($PollFailureExitSeconds -lt 60 -or $PollFailureExitSeconds -gt 3600) { throw "PollFailureExitSeconds must be between 60 and 3600." }
$pullConfig = if ($ConfigFile) { Resolve-RendererPath $ConfigFile } else { Join-Path $layout.Shared "render-pull.json" }
$pullParent = Split-Path -Parent $pullConfig
$pullStem = [IO.Path]::GetFileNameWithoutExtension($pullConfig)
$pullToken = if ($PullTokenFile) {
    Resolve-RendererPath $PullTokenFile
} elseif ($ConfigFile) {
    Join-Path $pullParent ($pullStem + ".token")
} else {
    Join-Path $layout.Shared "render-pull.token"
}
$pullWorkDir = if ($WorkDir) {
    Resolve-RendererPath $WorkDir
} elseif ($ConfigFile) {
    Join-Path $pullParent ($pullStem + "-work")
} else {
    Join-Path $layout.Shared "pull-work"
}
$workingDirectory = if ($WorkingDirectory) { Resolve-RendererPath $WorkingDirectory } else { $layout.CodeRoot }
if (-not (Test-Path -LiteralPath $workingDirectory -PathType Container)) { throw "Working directory not found: $workingDirectory" }
New-Item -ItemType Directory -Path $layout.Shared -Force | Out-Null
New-Item -ItemType Directory -Path $pullParent -Force | Out-Null
Set-RendererToken $pullToken $Token ([Security.Principal.WindowsIdentity]::GetCurrent().Name) | Out-Null
$pullSettings = @{
    url = $Url
    renderer_url = $RendererUrl
    token_file = $pullToken
    worker_id = $WorkerId
    wait_seconds = 25
    renew_seconds = 30
    retry_seconds = 5
    local_job_timeout_seconds = $LocalJobTimeoutSeconds
    poll_failure_exit_seconds = $PollFailureExitSeconds
    work_dir = $pullWorkDir
}
if ($rendererTokenPath) {
    $rendererPullToken = if ($ConfigFile) {
        Join-Path $pullParent ($pullStem + "-renderer.token")
    } else {
        Join-Path $layout.Shared "render-pull-renderer.token"
    }
    Set-RendererToken $rendererPullToken ((Get-Content -LiteralPath $rendererTokenPath -Raw).Trim()) ([Security.Principal.WindowsIdentity]::GetCurrent().Name) | Out-Null
    $pullSettings.renderer_token_file = $rendererPullToken
}
$pullSettings | ConvertTo-Json | Set-Content -LiteralPath $pullConfig -Encoding UTF8
Protect-RendererPath $pullConfig ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$action = New-ScheduledTaskAction -Execute $Python -Argument ("-m wps_renderer.render_pull --config `"{0}`"" -f $pullConfig) -WorkingDirectory $workingDirectory
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType S4U -RunLevel Limited
$triggers = @(New-RendererPullTaskTriggers)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $triggers -Settings $settings -Description 'SlideFlow WPS render pull protocol v1' -Force | Out-Null
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Wait-RendererHealthy $layout 30 | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Render pull task '$TaskName' registered and started."
