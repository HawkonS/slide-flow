#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Config = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName System.Security.Principal.WindowsPrincipal -ArgumentList @($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run Setup.ps1 from an elevated PowerShell window."
    }
}

function Read-Settings([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Config file not found: $Path. Copy windows-renderer.config.example.json to windows-renderer.config.json and edit it first."
    }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw "Could not read config file $Path`: $($_.Exception.Message)" }
}

function Required-String($Object, [string]$Name) {
    $property = $Object.PSObject.Properties[$Name]
    $value = if ($property) { [string]$property.Value } else { "" }
    if ([string]::IsNullOrWhiteSpace($value)) { throw "Config field '$Name' is required." }
    return $value.Trim()
}

function Optional-String($Object, [string]$Name, [string]$Default = "") {
    $property = $Object.PSObject.Properties[$Name]
    if (-not $property -or $null -eq $property.Value) { return $Default }
    $value = [string]$property.Value
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value.Trim()
}

function Optional-Int($Object, [string]$Name, [int]$Default) {
    $property = $Object.PSObject.Properties[$Name]
    if (-not $property -or $null -eq $property.Value -or [string]::IsNullOrWhiteSpace([string]$property.Value)) { return $Default }
    try { return [int]$property.Value } catch { throw "Config field '$Name' must be an integer." }
}

Assert-Administrator
$sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSCommandPath))
if (-not $Config) { $Config = Join-Path $sourceRoot "windows-renderer.config.json" }
$Config = [IO.Path]::GetFullPath($Config)
$settings = Read-Settings $Config

$installRoot = Optional-String $settings "install_root" "C:\ProgramData\SlideFlow\WpsRenderer"
$python = Optional-String $settings "python" "python"
$wpsCli = Required-String $settings "wpscli"
$mainUrl = Required-String $settings "main_url"
$port = Optional-Int $settings "renderer_port" 8765
$workerId = Optional-String $settings "worker_id"
$version = Optional-String $settings "version"

$installScript = Join-Path $sourceRoot "scripts\Install.ps1"
$fontScript = Join-Path $sourceRoot "scripts\Register-FontSync.ps1"
$renderScript = Join-Path $sourceRoot "scripts\Register-RenderPull.ps1"
if (Test-Path -LiteralPath (Join-Path $installRoot "current") -PathType Container) {
    throw "A current installation already exists at $installRoot. Run Update.ps1 instead."
}

$installArgs = @{
    InstallRoot = $installRoot
    Python = $python
    WpsCli = $wpsCli
    Port = $port
}
if ($version) { $installArgs.Version = $version }
& $installScript @installArgs
if ($LASTEXITCODE -ne 0) { throw "Renderer installation failed." }

$tokenFile = Join-Path $installRoot "shared\token.txt"
$pullArgs = @{
    InstallRoot = $installRoot
    Url = $mainUrl
    TokenFile = $tokenFile
}
if ($workerId) { $pullArgs.WorkerId = $workerId }
& $fontScript @pullArgs
if ($LASTEXITCODE -ne 0) { throw "Font sync registration failed." }
& $renderScript @pullArgs
if ($LASTEXITCODE -ne 0) { throw "Render pull registration failed." }

Write-Host ""
Write-Host "SlideFlow Windows Renderer is installed and running."
Write-Host "Main URL: $mainUrl"
Write-Host "Renderer: 127.0.0.1`:$port"
Write-Host "Token file: $tokenFile"
Write-Host "Next: copy the token file contents to the main server's render.token_file, then run Update.ps1 for future upgrades."
