#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Python = "python",
    [string]$WpsCli = "",
    [int]$Port = 8765,
    [string]$TaskName = "SlideFlow-WPS-Renderer",
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName System.Security.Principal.WindowsPrincipal -ArgumentList @($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run Install.ps1 from an elevated PowerShell window."
    }
}

function Copy-Component([string]$Source, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $excluded = @(".venv", ".git", "data", "logs", "cache", "releases", "shared", "current", "config.json", "token.txt")
    Get-ChildItem -LiteralPath $Source -Force | Where-Object { $excluded -notcontains $_.Name } | ForEach-Object {
        if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing to copy a reparse point in source: $($_.FullName)" }
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name) -Recurse -Force
    }
}

function Protect-Directory([string]$Path, [string]$Account) {
    & icacls.exe $Path /inheritance:r /grant:r "${Account}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict ACL for $Path." }
}

function Resolve-Executable([string]$Value, [string]$Label) {
    $command = Get-Command $Value -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return [IO.Path]::GetFullPath($command.Source) }
    if (Test-Path -LiteralPath $Value -PathType Leaf) { return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Value).Path) }
    throw "$Label executable was not found: $Value"
}

function Set-JsonProperty($Object, [string]$Name, $Value) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

Assert-Administrator
$sourceRoot = Split-Path -Parent $PSScriptRoot
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$releases = Join-Path $InstallRoot "releases"
$shared = Join-Path $InstallRoot "shared"
$current = Join-Path $InstallRoot "current"
$configPath = Join-Path $shared "config.json"
$tokenPath = Join-Path $shared "token.txt"

if (-not $Version) { $Version = [DateTime]::Now.ToString("yyyy.MM.dd-HHmmss") }
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "Version contains unsafe characters." }
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535." }
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "wps_renderer"))) { throw "The component source is incomplete: wps_renderer is missing." }
if (Test-Path -LiteralPath $current) { throw "A current installation already exists. Use Upgrade.ps1 instead of Install.ps1." }

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$marker = Join-Path $InstallRoot ".slideflow-wps-renderer"
if (-not (Test-Path -LiteralPath $marker)) {
    $existing = @(Get-ChildItem -LiteralPath $InstallRoot -Force)
    if ($existing.Count -gt 0) { throw "InstallRoot exists but is not owned by SlideFlow: $InstallRoot" }
    New-Item -ItemType File -Path $marker -Force | Out-Null
}
$Python = Resolve-Executable $Python "Python"
& $Python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
if ($WpsCli) { $WpsCli = Resolve-Executable $WpsCli "WPSCLI" }

New-Item -ItemType Directory -Path $releases, $shared, (Join-Path $shared "data"), (Join-Path $shared "logs"), (Join-Path $shared "cache") -Force | Out-Null
$identityName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
Protect-Directory $InstallRoot $identityName
Protect-Directory $shared $identityName

if (-not (Test-Path -LiteralPath $tokenPath)) {
    $bytes = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)
    [IO.File]::WriteAllText($tokenPath, [Convert]::ToBase64String($bytes), $utf8)
}
$tokenValue = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
if ($tokenValue.Length -lt 32 -or $tokenValue -match '\s') { throw "Existing token is invalid; replace it with a random value of at least 32 non-whitespace characters." }
& icacls.exe $tokenPath /inheritance:r /grant:r "${identityName}:(F)" "SYSTEM:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not restrict the renderer token ACL." }

if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not $WpsCli) { $WpsCli = [string]$config.wpscli }
    if ($config.port -and [int]$config.port -ne $Port) {
        throw "Existing shared config uses port $($config.port). Pass the same -Port or change it deliberately."
    }
} else {
    $config = Get-Content -LiteralPath (Join-Path $sourceRoot "config.example.json") -Raw | ConvertFrom-Json
}
$WpsCli = Resolve-Executable $WpsCli "WPSCLI"
Set-JsonProperty $config "wpscli" ([IO.Path]::GetFullPath($WpsCli))
Set-JsonProperty $config "data_dir" (Join-Path $shared "data")
Set-JsonProperty $config "token_file" $tokenPath
Set-JsonProperty $config "port" $Port
foreach ($legacyKey in @("host", "allow_network_bind", "tls_cert_file", "tls_key_file")) { $config.PSObject.Properties.Remove($legacyKey) }
$config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding UTF8

$release = Join-Path $releases $Version
if (Test-Path -LiteralPath $release) { throw "Release $Version already exists; choose a new -Version." }
Copy-Component $sourceRoot $release
$venv = Join-Path $release ".venv"
& $Python -m venv $venv
if ($LASTEXITCODE -ne 0) { throw "Could not create the Python virtual environment." }
$venvPython = Join-Path $venv "Scripts\python.exe"
& $venvPython -m pip install --disable-pip-version-check --no-cache-dir -r (Join-Path $release "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

Move-Item -LiteralPath $release -Destination $current
@{ version = $Version; installed_at = [DateTime]::UtcNow.ToString("o"); python = $venvPython; task = $TaskName } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot "version.json") -Encoding UTF8

& (Join-Path $current "scripts\Register.ps1") -InstallRoot $InstallRoot -Config $configPath -Python (Join-Path $current ".venv\Scripts\pythonw.exe") -TaskName $TaskName -Start
if ($LASTEXITCODE -ne 0) { throw "Could not register the renderer scheduled task." }

$healthUri = "http://127.0.0.1:{0}/v1/health" -f $Port
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
        $health = Invoke-RestMethod -Uri $healthUri -Headers @{ Authorization = "Bearer $token" } -Method Get -TimeoutSec 5
        if ($health.status -eq "ok") { $healthy = $true; break }
    } catch { }
}
if (-not $healthy) { throw "Renderer did not become healthy. Check shared\logs\renderer.log." }
Write-Host "Installed SlideFlow WPS Renderer $Version at $InstallRoot."
Write-Host "Shared state is under $shared; source releases are under $releases."
