#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Python = "python",
    [string]$TaskName = "SlideFlow-WPS-Renderer",
    [string]$Version = "",
    [int]$DrainTimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName System.Security.Principal.WindowsPrincipal -ArgumentList @($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run Upgrade.ps1 from an elevated PowerShell window." }
}

function Copy-Component([string]$From, [string]$To) {
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    $excluded = @(".venv", ".git", "data", "logs", "cache", "releases", "shared", "current", "config.json", "token.txt")
    Get-ChildItem -LiteralPath $From -Force | Where-Object { $excluded -notcontains $_.Name } | ForEach-Object {
        if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing to copy a reparse point in source: $($_.FullName)" }
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $To $_.Name) -Recurse -Force
    }
}

function Invoke-Renderer([string]$Method, [string]$Uri, [string]$Token) {
    Invoke-RestMethod -UseBasicParsing -Method $Method -Uri $Uri -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 10
}

function Resolve-Executable([string]$Value, [string]$Label) {
    $command = Get-Command $Value -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return [IO.Path]::GetFullPath($command.Source) }
    if (Test-Path -LiteralPath $Value -PathType Leaf) { return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Value).Path) }
    throw "$Label executable was not found: $Value"
}

function Wait-RendererProcessExit([string]$ConfigPath, [int]$Seconds) {
    $needle = [regex]::Escape([IO.Path]::GetFullPath($ConfigPath))
    for ($i = 0; $i -lt ($Seconds * 2); $i++) {
        $running = Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'wps_renderer' -and $_.CommandLine -match $needle }
        if (-not $running) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-OwnedTask([string]$Name, [string]$Description) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($task -and $task.Description -ne $Description) {
        throw "Refusing to operate on unrelated scheduled task '$Name'."
    }
    return $task
}

function Stop-PullWorkers([bool]$StopFont, [bool]$StopRender, [string]$SharedPath) {
    if ($StopFont) {
        $fontTask = Get-OwnedTask "SlideFlow-WPS-Font-Sync" 'SlideFlow WPS font pull protocol v1'
        if ($fontTask -and $fontTask.State -eq 'Running') { Stop-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" }
    }
    if ($StopRender) {
        $pullTask = Get-OwnedTask "SlideFlow-WPS-Render-Pull" 'SlideFlow WPS render pull protocol v1'
        if ($pullTask -and $pullTask.State -eq 'Running') { Stop-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" }
    }
    if ($StopFont -and -not (Wait-RendererProcessExit (Join-Path $SharedPath "font-sync.json") 45)) {
        throw "Font pull worker did not stop; release switch was aborted."
    }
    if ($StopRender -and -not (Wait-RendererProcessExit (Join-Path $SharedPath "render-pull.json") 45)) {
        throw "Render pull worker did not stop; release switch was aborted."
    }
}

function Start-PullWorkers([bool]$StartFont, [bool]$StartRender) {
    if ($StartFont) {
        $fontTask = Get-OwnedTask "SlideFlow-WPS-Font-Sync" 'SlideFlow WPS font pull protocol v1'
        if ($fontTask) {
            Enable-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" | Out-Null
            if ($fontTask.State -ne 'Running') { Start-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" }
        }
    }
    if ($StartRender) {
        $pullTask = Get-OwnedTask "SlideFlow-WPS-Render-Pull" 'SlideFlow WPS render pull protocol v1'
        if ($pullTask) {
            Enable-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" | Out-Null
            if ($pullTask.State -ne 'Running') { Start-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" }
        }
    }
}

function Wait-RendererHealthy([string]$Uri, [string]$Token, [int]$Attempts = 30) {
    for ($i = 0; $i -lt $Attempts; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Invoke-Renderer "Get" $Uri $Token
            if ($health.status -eq "ok") { return $true }
        } catch { }
    }
    return $false
}

Assert-Administrator
$sourceRoot = [IO.Path]::GetFullPath($Source)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$current = Join-Path $InstallRoot "current"
$releases = Join-Path $InstallRoot "releases"
$shared = Join-Path $InstallRoot "shared"
$configPath = Join-Path $shared "config.json"
$tokenPath = Join-Path $shared "token.txt"
$previous = Join-Path $releases "previous"
$retiring = $null
$mutex = New-Object -TypeName System.Threading.Mutex -ArgumentList @($false, "Global\SlideFlowWpsRendererUpgrade")
if (-not $mutex.WaitOne(0)) { throw "Another renderer installation or upgrade is already running." }
$drained = $false
$switched = $false
$movedPrevious = $false
$movedCurrent = $false
$movedNew = $false
$newRelease = $null
$baseUri = $null
$healthUri = $null
$token = ""
$fontShouldRun = $false
$renderShouldRun = $false
$maintenanceStarted = $false
try {
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "Source directory does not exist." }
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "wps_renderer") -PathType Container)) { throw "Source component is incomplete." }
    if (-not (Test-Path -LiteralPath $current -PathType Container)) { throw "No current installation exists; use Install.ps1 first." }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or -not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw "Shared config or token is missing." }
    if (-not $Version) { $Version = [DateTime]::Now.ToString("yyyy.MM.dd-HHmmss") }
    if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "Version contains unsafe characters." }
    $retiring = Join-Path $releases "retiring-$Version"
    if ($DrainTimeoutSeconds -lt 1 -or $DrainTimeoutSeconds -gt 3600) { throw "DrainTimeoutSeconds must be between 1 and 3600." }

    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $port = [int]$config.port
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    if ($port -lt 1 -or $port -gt 65535) { throw "Shared config contains an invalid port." }
    if ($token.Length -lt 32 -or $token -match '\s') { throw "Shared token is invalid." }
    $Python = Resolve-Executable $Python "Python"
    & $Python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
    if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
    $hasTls = ($config.PSObject.Properties.Name -contains 'tls_cert_file') -and ($config.PSObject.Properties.Name -contains 'tls_key_file')
    $scheme = if ($hasTls -and $config.tls_cert_file -and $config.tls_key_file) { "https" } else { "http" }
    $listenHost = if ($config.host) { [string]$config.host } else { "127.0.0.1" }
    $baseUri = "{0}://{1}:{2}" -f $scheme, $listenHost, $port
    $healthUri = "$baseUri/v1/health"
    $sourceBytes = [int64]((Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum)
    $drive = New-Object -TypeName System.IO.DriveInfo -ArgumentList @([IO.Path]::GetPathRoot($InstallRoot))
    if ($drive.AvailableFreeSpace -lt [Math]::Max([int64](512MB), $sourceBytes * 2)) { throw "Not enough free disk space for staging and rollback." }

    $rendererTask = Get-OwnedTask $TaskName 'SlideFlow WPS Renderer protocol v1'
    if (-not $rendererTask) { throw "Renderer scheduled task is not registered." }
    $fontTask = Get-OwnedTask "SlideFlow-WPS-Font-Sync" 'SlideFlow WPS font pull protocol v1'
    $pullTask = Get-OwnedTask "SlideFlow-WPS-Render-Pull" 'SlideFlow WPS render pull protocol v1'
    $fontShouldRun = [bool]($fontTask -and $fontTask.State -ne 'Disabled')
    $renderShouldRun = [bool]($pullTask -and $pullTask.State -ne 'Disabled')
    $maintenanceStarted = $true
    # Stop pull workers before draining the local renderer. Otherwise a pull
    # worker can keep claiming main-server leases while maintenance rejects
    # local submissions, consuming all retry attempts during the upgrade.
    if ($fontShouldRun) { Disable-ScheduledTask -TaskName "SlideFlow-WPS-Font-Sync" | Out-Null }
    if ($renderShouldRun) { Disable-ScheduledTask -TaskName "SlideFlow-WPS-Render-Pull" | Out-Null }
    Stop-PullWorkers $fontShouldRun $renderShouldRun $shared

    Invoke-Renderer "Post" "$baseUri/v1/admin/drain" $token | Out-Null
    $drained = $true
    $deadline = [DateTime]::UtcNow.AddSeconds($DrainTimeoutSeconds)
    do {
        Start-Sleep -Seconds 1
        try { $health = Invoke-Renderer "Get" $healthUri $token } catch { $health = $null }
        $active = if ($health) { [int]$health.uploading + [int]$health.accepting + [int]$health.queued + [int]$health.running + [int]$health.readers } else { 1 }
    } while ($active -gt 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($active -gt 0) { throw "Renderer did not drain before timeout." }

    Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if (-not (Wait-RendererProcessExit $configPath 45)) { throw "Renderer process did not stop; release switch was aborted." }

    $newRelease = Join-Path $releases $Version
    if (Test-Path -LiteralPath $newRelease) { throw "Release $Version already exists." }
    Copy-Component $sourceRoot $newRelease
    $venv = Join-Path $newRelease ".venv"
    & $Python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Could not create the new Python environment." }
    $venvPython = Join-Path $venv "Scripts\python.exe"
    & $venvPython -m pip install --disable-pip-version-check --no-cache-dir -r (Join-Path $newRelease "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed; current release was not switched." }

    if (Test-Path -LiteralPath $retiring) { Remove-Item -LiteralPath $retiring -Recurse -Force }
    if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $retiring; $movedPrevious = $true }
    Move-Item -LiteralPath $current -Destination $previous
    $movedCurrent = $true
    Move-Item -LiteralPath $newRelease -Destination $current
    $movedNew = $true
    $switched = $true
    & (Join-Path $current "scripts\Register.ps1") -InstallRoot $InstallRoot -Config $configPath -Python (Join-Path $current ".venv\Scripts\pythonw.exe") -TaskName $TaskName -Start
    if ($LASTEXITCODE -ne 0) { throw "Could not register the upgraded scheduled task." }

    if (-not (Wait-RendererHealthy $healthUri $token 30)) { throw "New renderer failed its health check." }
    Start-PullWorkers $fontShouldRun $renderShouldRun
    if (Test-Path -LiteralPath $retiring) { Remove-Item -LiteralPath $retiring -Recurse -Force }
    @{ version = $Version; upgraded_at = [DateTime]::UtcNow.ToString("o"); task = $TaskName } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot "version.json") -Encoding UTF8
    Write-Host "Upgraded SlideFlow WPS Renderer to $Version. Previous release is retained at $previous."
} catch {
    Write-Warning $_.Exception.Message
    if ($maintenanceStarted) {
        try { Stop-PullWorkers $fontShouldRun $renderShouldRun $shared } catch { Write-Warning $_.Exception.Message }
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
        Wait-RendererProcessExit $configPath 30 | Out-Null
    }
    if ($maintenanceStarted -and $movedCurrent -and (Test-Path -LiteralPath $previous -PathType Container)) {
        try {
            if ($movedNew -and (Test-Path -LiteralPath $current)) { Remove-Item -LiteralPath $current -Recurse -Force }
            Move-Item -LiteralPath $previous -Destination $current
            if (Test-Path -LiteralPath $retiring) { Move-Item -LiteralPath $retiring -Destination $previous }
            & (Join-Path $current "scripts\Register.ps1") -InstallRoot $InstallRoot -Config $configPath -Python (Join-Path $current ".venv\Scripts\pythonw.exe") -TaskName $TaskName -Start
            if (-not (Wait-RendererHealthy $healthUri $token 30)) { throw "Restored renderer failed its health check." }
            Start-PullWorkers $fontShouldRun $renderShouldRun
            Write-Warning "The previous renderer release was restored."
        } catch { throw "Automatic rollback failed: $($_.Exception.Message)" }
    } elseif ($maintenanceStarted -and -not $switched -and $newRelease -and (Test-Path -LiteralPath $newRelease)) {
        if ($newRelease -and (Test-Path -LiteralPath $newRelease)) { Remove-Item -LiteralPath $newRelease -Recurse -Force }
        if ($movedPrevious -and (Test-Path -LiteralPath $retiring) -and -not (Test-Path -LiteralPath $previous)) { Move-Item -LiteralPath $retiring -Destination $previous }
        try {
            & (Join-Path $current "scripts\Register.ps1") -InstallRoot $InstallRoot -Config $configPath -Python (Join-Path $current ".venv\Scripts\pythonw.exe") -TaskName $TaskName -Start
            if (-not (Wait-RendererHealthy $healthUri $token 30)) { throw "Current renderer failed its health check after staging rollback." }
            Start-PullWorkers $fontShouldRun $renderShouldRun
            Write-Warning "The current renderer release was restarted after the failed staging step."
        } catch { throw "Could not restart the current renderer release: $($_.Exception.Message)" }
    } elseif ($maintenanceStarted -and -not $switched -and (Test-Path -LiteralPath $current -PathType Container)) {
        try {
            & (Join-Path $current "scripts\Register.ps1") -InstallRoot $InstallRoot -Config $configPath -Python (Join-Path $current ".venv\Scripts\pythonw.exe") -TaskName $TaskName -Start
            if (-not (Wait-RendererHealthy $healthUri $token 30)) { throw "Current renderer failed its health check after upgrade failure." }
            Start-PullWorkers $fontShouldRun $renderShouldRun
            Write-Warning "The current renderer release was restarted after the failed upgrade."
        } catch { throw "Could not restart the current renderer release: $($_.Exception.Message)" }
    }
    throw
} finally {
    if ($drained) {
        try {
            $health = Invoke-Renderer "Get" $healthUri $token
            if ($health.status -eq "draining") { Invoke-Renderer "Post" "$baseUri/v1/admin/resume" $token | Out-Null }
        } catch { }
    }
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
}
