#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$Python = "python",
    [string]$TaskName = "SlideFlow-WPS-Renderer",
    [string]$TaskPath = "\",
    [string]$Version = "",
    [string]$ConstraintsFile = "",
    [string]$Wheelhouse = "",
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

function Get-OwnedTask([string]$Name, [string]$Description, [string]$Path = "\") {
    $task = Get-ScheduledTask -TaskName $Name -TaskPath $Path -ErrorAction SilentlyContinue
    if ($task -and $task.Description -ne $Description) {
        throw "Refusing to operate on unrelated scheduled task '$Name'."
    }
    return $task
}

function Get-TaskSnapshot($Task, [string]$ConfigPath) {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { throw "Task '$($Task.TaskName)' has an unexpected action count." }
    [pscustomobject]@{
        Name = [string]$Task.TaskName
        Path = [string]$Task.TaskPath
        Config = $ConfigPath
        WasEnabled = [bool]$Task.Settings.Enabled
        WasRunning = [bool]($Task.State -eq 'Running')
        Execute = [string]$actions[0].Execute
        Arguments = [string]$actions[0].Arguments
        WorkingDirectory = [string]$actions[0].WorkingDirectory
    }
}

function Disable-PullWorkers([object[]]$Workers) {
    foreach ($worker in $Workers) {
        Disable-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path | Out-Null
    }
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

function Restore-TaskStates([object[]]$Workers) {
    foreach ($worker in $Workers) {
        $task = Get-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path -ErrorAction SilentlyContinue
        if (-not $task) { throw "Pull worker '$($worker.Name)' disappeared during upgrade." }
        if ($worker.WasRunning -and $task.State -ne 'Running') {
            Enable-ScheduledTask -InputObject $task | Out-Null
            Start-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path
        } elseif (-not $worker.WasRunning -and $task.State -eq 'Running') {
            Stop-ScheduledTask -InputObject $task
            if (-not (Wait-RendererProcessExit $worker.Config 45)) { throw "Task '$($worker.Name)' did not return to its stopped state." }
        }
        if ($worker.WasEnabled) {
            Enable-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path | Out-Null
        } else {
            Disable-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path | Out-Null
        }
    }
}

function Restore-TaskActions([object[]]$Workers) {
    foreach ($worker in $Workers) {
        $action = New-ScheduledTaskAction -Execute $worker.Execute -Argument $worker.Arguments -WorkingDirectory $worker.WorkingDirectory
        Set-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path -Action $action | Out-Null
    }
}

function Set-TasksCurrentRelease([object[]]$Workers, [string]$CurrentPath, [string]$Executable = "python.exe") {
    $python = Join-Path $CurrentPath (".venv\Scripts\" + $Executable)
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
            -Argument $worker.Arguments `
            -WorkingDirectory $CurrentPath
        Set-ScheduledTask -TaskName $worker.Name -TaskPath $worker.Path -Action $action | Out-Null
    }
}

function Start-RendererTask($State) {
    Enable-ScheduledTask -TaskName $State.Name -TaskPath $State.Path | Out-Null
    Start-ScheduledTask -TaskName $State.Name -TaskPath $State.Path
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
$rendererState = $null
$maintenanceStarted = $false
$createdStage = $false
$rendererStopRequested = $false
$drainRequested = $false
try {
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "Source directory does not exist." }
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "wps_renderer") -PathType Container)) { throw "Source component is incomplete." }
    if (-not (Test-Path -LiteralPath $current -PathType Container)) { throw "No current installation exists; use Install.ps1 first." }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Shared config is missing." }
    if (-not $Version) { $Version = [DateTime]::Now.ToString("yyyy.MM.dd-HHmmss") }
    if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "Version contains unsafe characters." }
    if ($Version -in @('previous', 'current', 'shared', 'releases') -or $Version -like 'retiring-*' -or $Version -like 'failed-*') {
        throw "Version uses a reserved release name."
    }
    $newRelease = Join-Path $releases $Version
    $retiring = Join-Path $releases "retiring-$Version"
    if (Test-Path -LiteralPath $newRelease) { throw "Release $Version already exists." }
    if (Test-Path -LiteralPath $retiring) { throw "A rollback directory for $Version already exists." }
    if ($DrainTimeoutSeconds -lt 1 -or $DrainTimeoutSeconds -gt 3600) { throw "DrainTimeoutSeconds must be between 1 and 3600." }
    if ($ConstraintsFile) {
        $ConstraintsFile = [IO.Path]::GetFullPath($ConstraintsFile)
        if (-not (Test-Path -LiteralPath $ConstraintsFile -PathType Leaf)) { throw "Dependency constraints file does not exist." }
    }
    if ($Wheelhouse) {
        $Wheelhouse = [IO.Path]::GetFullPath($Wheelhouse)
        if (-not (Test-Path -LiteralPath $Wheelhouse -PathType Container)) { throw "Dependency wheelhouse does not exist." }
    }
    $Python = Resolve-Executable $Python "Python"
    & $Python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
    if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is required." }
    $sourceBytes = [int64]((Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum)
    $drive = New-Object -TypeName System.IO.DriveInfo -ArgumentList @([IO.Path]::GetPathRoot($InstallRoot))
    if ($drive.AvailableFreeSpace -lt [Math]::Max([int64](512MB), $sourceBytes * 2)) { throw "Not enough free disk space for staging and rollback." }

    # All copying, dependency resolution and import checks precede maintenance.
    # Only a directory created by this invocation is eligible for cleanup.
    New-Item -ItemType Directory -Path $newRelease -ErrorAction Stop | Out-Null
    $createdStage = $true
    Copy-Component $sourceRoot $newRelease
    $venv = Join-Path $newRelease ".venv"
    & $Python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Could not create the new Python environment." }
    $venvPython = Join-Path $venv "Scripts\python.exe"
    $pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '-r', (Join-Path $newRelease 'requirements.txt'))
    if ($ConstraintsFile) { $pipArgs += @('-c', $ConstraintsFile) }
    if ($Wheelhouse) { $pipArgs += @('--no-index', '--find-links', $Wheelhouse) }
    & $venvPython @pipArgs
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed; running services were not changed." }
    & $venvPython -m pip check
    if ($LASTEXITCODE -ne 0) { throw "Staged dependencies are inconsistent." }
    & $venvPython -m compileall -q (Join-Path $newRelease 'wps_renderer')
    if ($LASTEXITCODE -ne 0) { throw "Staged renderer source could not be compiled." }
    & $venvPython -c "import sys; sys.path.insert(0, sys.argv[1]); import fastapi, uvicorn, PIL, fontTools, defusedxml, wps_renderer.render_pull" $newRelease
    if ($LASTEXITCODE -ne 0) { throw "Staged renderer import check failed." }

    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $port = [int]$config.port
    if (($config.PSObject.Properties.Name -contains 'token_file') -and $config.token_file) {
        $tokenPath = [string]$config.token_file
        if (-not [IO.Path]::IsPathRooted($tokenPath)) { $tokenPath = Join-Path (Split-Path -Parent $configPath) $tokenPath }
    }
    if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) { throw "Configured renderer token file is missing." }
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    if ($port -lt 1 -or $port -gt 65535) { throw "Shared config contains an invalid port." }
    if ($token.Length -lt 32 -or $token -match '\s') { throw "Shared token is invalid." }
    $baseUri = "http://127.0.0.1:{0}" -f $port
    $healthUri = "$baseUri/v1/health"

    $rendererTask = Get-OwnedTask $TaskName 'SlideFlow WPS Renderer protocol v1' $TaskPath
    if (-not $rendererTask) { throw "Renderer scheduled task is not registered." }
    $rendererState = Get-TaskSnapshot $rendererTask $configPath
    if ($rendererState.Arguments -notmatch '(?:^|\s)-m\s+wps_renderer(?:\s|$)' -or
        $rendererState.Arguments -notmatch '(?:^|\s)--config\s+(?:"([^"]+)"|(\S+))') {
        throw "Renderer scheduled task does not declare the expected module and config."
    }
    $taskConfig = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
    if (-not [IO.Path]::IsPathRooted($taskConfig) -or
        -not [string]::Equals([IO.Path]::GetFullPath($taskConfig), $configPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Renderer scheduled task belongs to a different installation."
    }
    $sharedPrefix = $shared.TrimEnd('\') + '\'
    $pullWorkerStates = @(Get-RendererManagedPullTasks | Where-Object {
        ([string]$_.Config).StartsWith($sharedPrefix, [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { Get-TaskSnapshot $_.Task ([string]$_.Config) })

    $maintenanceStarted = $true
    Disable-PullWorkers $pullWorkerStates
    Stop-PullWorkers $pullWorkerStates
    $drainRequested = $true
    Invoke-Renderer "Post" "$baseUri/v1/admin/drain" $token | Out-Null
    $drained = $true
    $deadline = [DateTime]::UtcNow.AddSeconds($DrainTimeoutSeconds)
    do {
        Start-Sleep -Seconds 1
        try { $health = Invoke-Renderer "Get" $healthUri $token } catch { $health = $null }
        $active = if ($health) { [int]$health.uploading + [int]$health.accepting + [int]$health.queued + [int]$health.running + [int]$health.readers } else { 1 }
    } while ($active -gt 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($active -gt 0) { throw "Renderer did not drain before timeout." }

    Disable-ScheduledTask -TaskName $rendererState.Name -TaskPath $rendererState.Path | Out-Null
    $rendererStopRequested = $true
    Stop-ScheduledTask -TaskName $rendererState.Name -TaskPath $rendererState.Path
    if (-not (Wait-RendererProcessExit $configPath 45)) { throw "Renderer process did not stop; release switch was aborted." }
    if (Test-Path -LiteralPath $retiring) { throw "Rollback directory appeared during staging; release switch was aborted." }
    if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $retiring; $movedPrevious = $true }
    Move-Item -LiteralPath $current -Destination $previous
    $movedCurrent = $true
    Move-Item -LiteralPath $newRelease -Destination $current
    $movedNew = $true
    $switched = $true

    # Update only code entry points. Registration would rewrite shared config,
    # token files, principals, triggers and settings that belong to operators.
    Set-TasksCurrentRelease @($rendererState) $current 'pythonw.exe'
    Start-RendererTask $rendererState
    if (-not (Wait-RendererHealthy $healthUri $token 30)) { throw "New renderer failed its health check." }
    Set-TasksCurrentRelease $pullWorkerStates $current
    Restore-TaskStates @($rendererState)
    Restore-TaskStates $pullWorkerStates
    $versionTemp = Join-Path $InstallRoot "version-$Version.tmp"
    @{ version = $Version; upgraded_at = [DateTime]::UtcNow.ToString("o"); task = $TaskName } |
        ConvertTo-Json | Set-Content -LiteralPath $versionTemp -Encoding UTF8
    Move-Item -LiteralPath $versionTemp -Destination (Join-Path $InstallRoot 'version.json') -Force
    if (Test-Path -LiteralPath $retiring) {
        try { Remove-Item -LiteralPath $retiring -Recurse -Force }
        catch { Write-Warning "Upgrade succeeded; the retired release could not be removed." }
    }
    Write-Host "Upgraded SlideFlow WPS Renderer to $Version. Previous release is retained at $previous."
} catch {
    $upgradeError = $_
    Write-Warning $upgradeError.Exception.Message
    if ($maintenanceStarted -and $movedCurrent) {
        # No filesystem rollback is safe while any process may still import
        # this release. Disable restart triggers before verifying shutdown.
        try {
            Disable-PullWorkers $pullWorkerStates
            Disable-ScheduledTask -TaskName $rendererState.Name -TaskPath $rendererState.Path | Out-Null
            Stop-PullWorkers $pullWorkerStates
            Stop-ScheduledTask -TaskName $rendererState.Name -TaskPath $rendererState.Path
            if (-not (Wait-RendererProcessExit $configPath 45)) { throw "Renderer process is still running." }
        } catch {
            throw "Automatic rollback was not attempted because process shutdown could not be confirmed. Release directories were preserved and tasks remain disabled: $($_.Exception.Message)"
        }
        try {
            if (-not (Test-Path -LiteralPath $previous -PathType Container)) { throw "Previous release is missing; current was preserved." }
            if (Test-Path -LiteralPath $current) {
                if (-not $movedNew) { throw "Current directory ownership is uncertain; it was preserved." }
                Remove-Item -LiteralPath $current -Recurse -Force
            }
            Move-Item -LiteralPath $previous -Destination $current
            if ($movedPrevious -and (Test-Path -LiteralPath $retiring)) { Move-Item -LiteralPath $retiring -Destination $previous }
            Restore-TaskActions (@($rendererState) + $pullWorkerStates)
            Start-RendererTask $rendererState
            if (-not (Wait-RendererHealthy $healthUri $token 30)) { throw "Restored renderer failed its health check." }
            Restore-TaskStates @($rendererState)
            Restore-TaskStates $pullWorkerStates
            Write-Warning "The previous renderer release and original task actions/states were restored."
        } catch { throw "Automatic rollback failed; preserved releases require operator recovery: $($_.Exception.Message)" }
    } elseif ($maintenanceStarted) {
        # A failed drain must not kill an active conversion. The original
        # current directory is intact; resume it and restore worker states.
        try {
            if ($movedPrevious -and (Test-Path -LiteralPath $retiring) -and -not (Test-Path -LiteralPath $previous)) {
                Move-Item -LiteralPath $retiring -Destination $previous
            }
            if ($rendererStopRequested) { Start-RendererTask $rendererState }
            if ($drainRequested) {
                if ($rendererStopRequested) {
                    try {
                        $health = Invoke-Renderer "Get" $healthUri $token
                        if ($health.status -eq 'draining') { Invoke-Renderer "Post" "$baseUri/v1/admin/resume" $token | Out-Null }
                    } catch { }
                } else {
                    $health = Invoke-Renderer "Get" $healthUri $token
                    if ($health.status -eq 'draining') { Invoke-Renderer "Post" "$baseUri/v1/admin/resume" $token | Out-Null }
                }
                if (-not (Wait-RendererHealthy $healthUri $token 30)) { throw "Original renderer could not be resumed." }
            }
            Restore-TaskStates @($rendererState)
            Restore-TaskStates $pullWorkerStates
            Write-Warning "The original renderer and worker states were restored without switching releases."
        } catch { throw "Could not restore pre-upgrade task states; release directories were preserved: $($_.Exception.Message)" }
    }
    if ($createdStage -and $newRelease -and (Test-Path -LiteralPath $newRelease)) {
        try { Remove-Item -LiteralPath $newRelease -Recurse -Force }
        catch { Write-Warning "The failed staging directory was preserved for inspection." }
    }
    throw $upgradeError
} finally {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
}
