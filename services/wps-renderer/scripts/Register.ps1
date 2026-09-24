#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Config = "config.json",
    [string]$Python = "",
    [string]$WpsCli = "",
    [string]$ListenHost = "",
    [int]$Port = 0,
    [string]$Token = "",
    [string]$TokenFile = "",
    [string]$TlsCertFile = "",
    [string]$TlsKeyFile = "",
    [switch]$AllowNetworkBind,
    [string]$TaskName = "SlideFlow-WPS-Renderer",
    [string]$FontTaskUrl = "",
    [string]$FontTaskToken = "",
    [string]$FontTaskTokenFile = "",
    [int]$FontPollSeconds = 5,
    [string]$RenderTaskUrl = "",
    [string]$RenderTaskToken = "",
    [string]$RenderTaskTokenFile = "",
    [string]$RenderWorkerId = "",
    [switch]$Start
)
. (Join-Path $PSScriptRoot "Renderer-Common.ps1")
Assert-RendererAdministrator
$layout = Get-RendererLayout $InstallRoot $Config
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-RendererManagedTask $TaskName 'SlideFlow WPS Renderer protocol v1'
if ($existing -and $existing.Principal.UserId -and [string]$existing.Principal.UserId -ne $identity) { throw "Refusing to take over a renderer task owned by another Windows account." }
New-Item -ItemType Directory -Path $layout.Shared, (Join-Path $layout.Shared "data"), (Join-Path $layout.Shared "logs"), (Join-Path $layout.Shared "cache") -Force | Out-Null
$configObject = Read-RendererConfig $layout
if (-not $WpsCli -and $configObject.wpscli) { $WpsCli = [string]$configObject.wpscli }
if (-not $WpsCli) { throw "Pass -WpsCli or configure wpscli in $($layout.Config)." }
$WpsCli = Resolve-RendererExecutable $WpsCli "WPSCLI"
$pythonDefault = Join-Path $layout.CodeRoot ".venv\Scripts\pythonw.exe"
if (-not $Python) { $Python = $pythonDefault }
$Python = Resolve-RendererExecutable $Python "Python"
$existingHost = if ($configObject.host) { [string]$configObject.host } else { "127.0.0.1" }
$existingPort = if ($configObject.port) { [int]$configObject.port } else { 8765 }
if (-not $ListenHost) { $ListenHost = $existingHost }
if ($Port -eq 0) { $Port = $existingPort }
$existingCert = if (($configObject.PSObject.Properties.Name -contains 'tls_cert_file') -and $configObject.tls_cert_file) { [string]$configObject.tls_cert_file } else { "" }
$existingKey = if (($configObject.PSObject.Properties.Name -contains 'tls_key_file') -and $configObject.tls_key_file) { [string]$configObject.tls_key_file } else { "" }
if (-not $PSBoundParameters.ContainsKey('TlsCertFile') -or [string]::IsNullOrWhiteSpace($TlsCertFile)) { $TlsCertFile = $existingCert }
if (-not $PSBoundParameters.ContainsKey('TlsKeyFile') -or [string]::IsNullOrWhiteSpace($TlsKeyFile)) { $TlsKeyFile = $existingKey }
$existingNetworkBind = ($configObject.PSObject.Properties.Name -contains 'allow_network_bind') -and [bool]$configObject.allow_network_bind
$networkBind = $AllowNetworkBind -or $existingNetworkBind
Assert-RendererListen $ListenHost $Port $networkBind $TlsCertFile $TlsKeyFile
$tokenPath = if ($TokenFile) { Resolve-RendererPath $TokenFile } else { $layout.Token }
$tokenValue = Set-RendererToken $tokenPath $Token $identity
Set-RendererJsonProperty $configObject "wpscli" $WpsCli
Set-RendererJsonProperty $configObject "data_dir" (Join-Path $layout.Shared "data")
Set-RendererJsonProperty $configObject "token_file" $tokenPath
Set-RendererJsonProperty $configObject "host" $ListenHost
Set-RendererJsonProperty $configObject "port" $Port
Set-RendererJsonProperty $configObject "allow_network_bind" ([bool]$networkBind)
Set-RendererJsonProperty $configObject "tls_cert_file" $(if ($TlsCertFile) { Resolve-RendererPath $TlsCertFile } else { "" })
Set-RendererJsonProperty $configObject "tls_key_file" $(if ($TlsKeyFile) { Resolve-RendererPath $TlsKeyFile } else { "" })
Write-RendererConfig $layout $configObject
$expectedPython = [IO.Path]::GetFullPath($Python)
$configPath = [IO.Path]::GetFullPath($layout.Config)
$action = New-ScheduledTaskAction -Execute $expectedPython -Argument ("-m wps_renderer --config `"{0}`"" -f $configPath) -WorkingDirectory $layout.CodeRoot
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'SlideFlow WPS Renderer protocol v1' -Force | Out-Null
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Write-Host "Renderer task '$TaskName' registered. Listener: $ListenHost`:$Port"
if ($Start) { Start-ScheduledTask -TaskName $TaskName; Write-Host "Renderer task '$TaskName' started." }
if ($FontTaskUrl) {
    $fontArgs = @{ InstallRoot = $InstallRoot; Python = (Join-Path $layout.CodeRoot ".venv\Scripts\python.exe"); Url = $FontTaskUrl; PollSeconds = $FontPollSeconds }
    if ($FontTaskToken) { $fontArgs.Token = $FontTaskToken }
    if ($FontTaskTokenFile) { $fontArgs.TokenFile = $FontTaskTokenFile }
    & (Join-Path $PSScriptRoot "Register-FontSync.ps1") @fontArgs
}
if ($RenderTaskUrl) {
    $pullArgs = @{ InstallRoot = $InstallRoot; Python = (Join-Path $layout.CodeRoot ".venv\Scripts\python.exe"); Url = $RenderTaskUrl; RendererUrl = ("http://127.0.0.1:{0}" -f $Port) }
    if ($RenderTaskToken) { $pullArgs.Token = $RenderTaskToken }
    if ($RenderTaskTokenFile) { $pullArgs.TokenFile = $RenderTaskTokenFile }
    if ($RenderWorkerId) { $pullArgs.WorkerId = $RenderWorkerId }
    & (Join-Path $PSScriptRoot "Register-RenderPull.ps1") @pullArgs
}
