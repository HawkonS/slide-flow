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
        throw "Run Update.ps1 from an elevated PowerShell window."
    }
}

function Read-Settings([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Config file not found: $Path."
    }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw "Could not read config file $Path`: $($_.Exception.Message)" }
}

function Optional-String($Object, [string]$Name, [string]$Default = "") {
    $property = $Object.PSObject.Properties[$Name]
    if (-not $property -or $null -eq $property.Value) { return $Default }
    $value = [string]$property.Value
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value.Trim()
}

function Resolve-Git([string]$ConfiguredPath = "") {
    $candidates = @()
    if ($ConfiguredPath) { $candidates += $ConfiguredPath }
    $candidates += "git"
    $candidates += "C:\Program Files\Git\cmd\git.exe"
    $candidates += "C:\Program Files\Git\bin\git.exe"
    $candidates += "C:\Program Files (x86)\Git\cmd\git.exe"
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command -and $command.Source) { return $command.Source }
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $candidate).Path) }
    }
    throw "Git was not found. Install Git for Windows or set the 'git' field in windows-renderer.config.json, then run Update.ps1 again."
}

Assert-Administrator
$sourceRoot = Split-Path -Parent $PSCommandPath
$sourceRoot = [IO.Path]::GetFullPath($sourceRoot)
if (-not $Config) { $Config = Join-Path $sourceRoot "windows-renderer.config.json" }
$Config = [IO.Path]::GetFullPath($Config)
$settings = Read-Settings $Config

$installRoot = Optional-String $settings "install_root" "C:\ProgramData\SlideFlow\WpsRenderer"
$python = Optional-String $settings "python" "python"
$version = Optional-String $settings "version"
$gitPath = Optional-String $settings "git"
if (-not $version) { $version = [DateTime]::Now.ToString("yyyy.MM.dd-HHmmss") }

$current = Join-Path $installRoot "current"
if (-not (Test-Path -LiteralPath $current -PathType Container)) {
    throw "No current installation exists at $installRoot. Run Setup.ps1 first."
}

$updateScript = Join-Path $sourceRoot "scripts\Upgrade.ps1"

$git = Resolve-Git $gitPath
$status = & $git -C $sourceRoot status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0) { throw "Could not inspect the source checkout with Git: $sourceRoot" }
if ($status) { throw "The source checkout has local tracked changes. Commit or remove them before updating." }
$branch = & $git -C $sourceRoot symbolic-ref --short -q HEAD
if ($LASTEXITCODE -ne 0 -or -not $branch) { throw "The source checkout is not on a local branch; check out the branch you want to update first." }
& $git -C $sourceRoot pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "Could not fast-forward the source checkout." }

$upgradeArgs = @{
    Source = $sourceRoot
    InstallRoot = $installRoot
    Python = $python
    Version = $version
}
& $updateScript @upgradeArgs
if ($LASTEXITCODE -ne 0) { throw "Renderer upgrade failed." }

Write-Host "SlideFlow Windows Renderer updated successfully."
Write-Host "Source: $sourceRoot"
Write-Host "Version: $version"
