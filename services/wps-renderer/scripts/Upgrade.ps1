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
. (Join-Path $PSScriptRoot "Renderer-Common.ps1")

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName System.Security.Principal.WindowsPrincipal -ArgumentList @($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run Upgrade.ps1 from an elevated PowerShell window." }
}

function Test-IgnoredPackageMetadata([string]$Name) {
    return $Name -eq ".DS_Store" -or $Name.StartsWith("._", [StringComparison]::Ordinal)
}

function Copy-ComponentEntry([string]$From, [string]$To) {
    $source = Get-Item -LiteralPath $From -Force
    if ($source.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to copy a reparse point in source: $($source.FullName)"
    }
    if ($source.PSIsContainer) {
        New-Item -ItemType Directory -Path $To -Force | Out-Null
        Get-ChildItem -LiteralPath $source.FullName -Force | ForEach-Object {
            if (-not (Test-IgnoredPackageMetadata $_.Name)) {
                Copy-ComponentEntry $_.FullName (Join-Path $To $_.Name)
            }
        }
        return
    }
    Copy-Item -LiteralPath $source.FullName -Destination $To -Force
}

function Copy-Component([string]$From, [string]$To) {
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    $excluded = @(".venv", ".git", "data", "logs", "cache", "releases", "shared", "current", "config.json", "token.txt")
    Get-ChildItem -LiteralPath $From -Force | ForEach-Object {
        if ($excluded -notcontains $_.Name -and -not (Test-IgnoredPackageMetadata $_.Name)) {
            Copy-ComponentEntry $_.FullName (Join-Path $To $_.Name)
        }
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

function Stop-PullWorkers([object[]]$Workers) {
    foreach ($worker in $Workers) {
        $task = Get-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path -ErrorAction SilentlyContinue
        if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -InputObject $task }
    }
    foreach ($worker in $Workers) {
        if (-not (Wait-RendererProcessExit $worker.Config 45)) {
            throw "Pull worker '$($worker.Name)' did not stop; release switch was aborted."
        }
    }
}

function Restore-PullWorkers([object[]]$Workers) {
    foreach ($worker in $Workers) {
        $task = Get-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path -ErrorAction SilentlyContinue
        if (-not $task) { throw "Pull worker '$($worker.Name)' disappeared during upgrade." }
        if ($worker.WasEnabled) { Enable-ScheduledTask -InputObject $task | Out-Null }
        if ($worker.WasRunning) { Start-ScheduledTask -InputObject $task }
    }
}

function Set-PullWorkersCurrentRelease([object[]]$Workers, [string]$CurrentPath) {
    $python = Join-Path $CurrentPath ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw "Pull worker Python does not exist in the current release."
    }
    foreach ($worker in $Workers) {
        $task = Get-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path -ErrorAction SilentlyContinue
        if (-not $task) { throw "Pull worker '$($worker.Name)' disappeared during upgrade." }
        $actions = @($task.Actions)
        if ($actions.Count -ne 1) { throw "Pull worker '$($worker.Name)' has an unexpected action count." }
        $action = New-ScheduledTaskAction `
            -Execute $python `
            -Argument ([string]$actions[0].Arguments) `
            -WorkingDirectory $CurrentPath
        $triggers = @(New-RendererPullTaskTriggers)
        Set-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path -Action $action -Trigger $triggers | Out-Null
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
$pullWorkerStates = @()
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
    $baseUri = "http://127.0.0.1:{0}" -f $port
    $healthUri = "$baseUri/v1/health"
    $sourceBytes = [int64]((Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum)
    $drive = New-Object -TypeName System.IO.DriveInfo -ArgumentList @([IO.Path]::GetPathRoot($InstallRoot))
    if ($drive.AvailableFreeSpace -lt [Math]::Max([int64](512MB), $sourceBytes * 2)) { throw "Not enough free disk space for staging and rollback." }

    $rendererTask = Get-OwnedTask $TaskName 'SlideFlow WPS Renderer protocol v1'
    if (-not $rendererTask) { throw "Renderer scheduled task is not registered." }
    $pullWorkerStates = @(Get-RendererManagedPullTasks | ForEach-Object {
        [pscustomobject]@{
            Name = [string]$_.Task.TaskName
            Path = [string]$_.Task.TaskPath
            Config = [string]$_.Config
            WasEnabled = [bool]($_.Task.State -ne 'Disabled')
            WasRunning = [bool]($_.Task.State -eq 'Running')
        }
    })
    $maintenanceStarted = $true
    # Stop pull workers before draining the local renderer. Otherwise a pull
    # worker can keep claiming main-server leases while maintenance rejects
    # local submissions, consuming all retry attempts during the upgrade.
    foreach ($worker in $pullWorkerStates) {
        if ($worker.WasEnabled) {
            Disable-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path | Out-Null
        }
    }
    Stop-PullWorkers $pullWorkerStates

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
    # Every environment keeps its own URL, token and config arguments, but all
    # workers import code from the atomically switched release. This prevents
    # a development worker from surviving an upgrade on a stale dev-code copy.
    Set-PullWorkersCurrentRelease $pullWorkerStates $current
    Restore-PullWorkers $pullWorkerStates
    if (Test-Path -LiteralPath $retiring) { Remove-Item -LiteralPath $retiring -Recurse -Force }
    @{ version = $Version; upgraded_at = [DateTime]::UtcNow.ToString("o"); task = $TaskName } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot "version.json") -Encoding UTF8
    Write-Host "Upgraded SlideFlow WPS Renderer to $Version. Previous release is retained at $previous."
} catch {
    Write-Warning $_.Exception.Message
    if ($maintenanceStarted) {
        try { Stop-PullWorkers $pullWorkerStates } catch { Write-Warning $_.Exception.Message }
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
            Set-PullWorkersCurrentRelease $pullWorkerStates $current
            Restore-PullWorkers $pullWorkerStates
            Write-Warning "The previous renderer release was restored."
        } catch { throw "Automatic rollback failed: $($_.Exception.Message)" }
    } elseif ($maintenanceStarted -and -not $switched -and $newRelease -and (Test-Path -LiteralPath $newRelease)) {
        if ($newRelease -and (Test-Path -LiteralPath $newRelease)) { Remove-Item -LiteralPath $newRelease -Recurse -Force }
        if ($movedPrevious -and (Test-Path -LiteralPath $retiring) -and -not (Test-Path -LiteralPath $previous)) { Move-Item -LiteralPath $retiring -Destination $previous }
        try {
            & (Join-Path $current "scripts\Register.ps1") -InstallRoot $InstallRoot -Config $configPath -Python (Join-Path $current ".venv\Scripts\pythonw.exe") -TaskName $TaskName -Start
            if (-not (Wait-RendererHealthy $healthUri $token 30)) { throw "Current renderer failed its health check after staging rollback." }
            Set-PullWorkersCurrentRelease $pullWorkerStates $current
            Restore-PullWorkers $pullWorkerStates
            Write-Warning "The current renderer release was restarted after the failed staging step."
        } catch { throw "Could not restart the current renderer release: $($_.Exception.Message)" }
    } elseif ($maintenanceStarted -and -not $switched -and (Test-Path -LiteralPath $current -PathType Container)) {
        try {
            & (Join-Path $current "scripts\Register.ps1") -InstallRoot $InstallRoot -Config $configPath -Python (Join-Path $current ".venv\Scripts\pythonw.exe") -TaskName $TaskName -Start
            if (-not (Wait-RendererHealthy $healthUri $token 30)) { throw "Current renderer failed its health check after upgrade failure." }
            Set-PullWorkersCurrentRelease $pullWorkerStates $current
            Restore-PullWorkers $pullWorkerStates
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
