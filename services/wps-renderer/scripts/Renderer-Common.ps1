#requires -Version 5.1
<###
Shared, deliberately boring helpers for the Windows renderer management
scripts.  The token is always stored in a protected file; it is never placed
in a Scheduled Task command line or echoed to the console.
###>

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Assert-RendererAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName System.Security.Principal.WindowsPrincipal -ArgumentList @($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this renderer management script from an elevated PowerShell window."
    }
}

function Resolve-RendererPath([string]$Value) {
    if ([IO.Path]::IsPathRooted($Value)) {
        return [IO.Path]::GetFullPath($Value)
    }
    return [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Value))
}

function Resolve-RendererExecutable([string]$Value, [string]$Label) {
    $command = Get-Command $Value -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return [IO.Path]::GetFullPath($command.Source) }
    if (Test-Path -LiteralPath $Value -PathType Leaf) {
        return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Value).Path)
    }
    throw "$Label executable was not found: $Value"
}

function Get-RendererLayout([string]$InstallRoot, [string]$Config) {
    $scriptRoot = Split-Path -Parent $PSScriptRoot
    $root = Resolve-RendererPath $InstallRoot
    $current = Join-Path $root "current"
    $shared = Join-Path $root "shared"
    if (Test-Path -LiteralPath (Join-Path $current "wps_renderer") -PathType Container) {
        $codeRoot = $current
    } else {
        # This also makes the scripts usable directly from a checked-out
        # services/wps-renderer directory before Install.ps1 is used.
        $codeRoot = $scriptRoot
    }
    if ([IO.Path]::IsPathRooted($Config)) { $configPath = [IO.Path]::GetFullPath($Config) }
    else { $configPath = Join-Path $shared $Config }
    [pscustomobject]@{
        InstallRoot = $root
        CodeRoot = $codeRoot
        Shared = $shared
        Config = $configPath
        Token = Join-Path $shared "token.txt"
        TaskName = "SlideFlow-WPS-Renderer"
    }
}

function Protect-RendererPath([string]$Path, [string]$Account, [switch]$Directory) {
    if ($Directory) {
        & icacls.exe $Path /inheritance:r /grant:r "${Account}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" /T /C | Out-Null
    } else {
        & icacls.exe $Path /inheritance:r /grant:r "${Account}:(F)" "SYSTEM:(F)" | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict ACL for $Path." }
}

function Assert-RendererToken([string]$Token) {
    if ([string]::IsNullOrWhiteSpace($Token) -or $Token.Length -lt 32 -or $Token.Length -gt 4096 -or $Token -match '\s') {
        throw "Token must contain 32-4096 non-whitespace characters."
    }
    if ($Token -match '[^\x21-\x7e]') { throw "Token must contain printable ASCII characters only." }
}

function New-RendererToken {
    $bytes = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes)
}

function Set-RendererToken([string]$TokenPath, [string]$Token, [string]$Account) {
    $parent = Split-Path -Parent $TokenPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    if (-not $Token) {
        if (Test-Path -LiteralPath $TokenPath -PathType Leaf) {
            $Token = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
        } else {
            $Token = New-RendererToken
        }
    }
    Assert-RendererToken $Token
    $utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)
    [IO.File]::WriteAllText($TokenPath, $Token, $utf8)
    Protect-RendererPath $TokenPath $Account
    return $Token
}

function Read-RendererToken([string]$TokenPath) {
    if (-not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) { throw "Renderer token file does not exist: $TokenPath" }
    $token = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
    Assert-RendererToken $token
    return $token
}

function Set-RendererJsonProperty($Object, [string]$Name, $Value) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Read-RendererConfig($Layout) {
    if (Test-Path -LiteralPath $Layout.Config -PathType Leaf) {
        return Get-Content -LiteralPath $Layout.Config -Raw | ConvertFrom-Json
    }
    $example = Join-Path $Layout.CodeRoot "config.example.json"
    if (-not (Test-Path -LiteralPath $example -PathType Leaf)) { throw "Renderer config does not exist: $($Layout.Config)" }
    return Get-Content -LiteralPath $example -Raw | ConvertFrom-Json
}

function Write-RendererConfig($Layout, $ConfigObject) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Layout.Config) -Force | Out-Null
    $ConfigObject | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Layout.Config -Encoding UTF8
}

function Get-RendererTask([string]$TaskName) {
    return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-RendererManagedTask([string]$TaskName, [string]$Description) {
    $task = Get-RendererTask $TaskName
    if ($task -and $task.Description -ne $Description) {
        throw "Refusing to operate on unrelated scheduled task '$TaskName'."
    }
    return $task
}

function Get-RendererManagedPullTasks {
    $descriptions = @{
        'SlideFlow WPS font pull protocol v1' = 'wps_renderer.font_sync'
        'SlideFlow WPS render pull protocol v1' = 'wps_renderer.render_pull'
    }
    foreach ($task in @(Get-ScheduledTask)) {
        if (-not $descriptions.ContainsKey([string]$task.Description)) { continue }
        $actions = @($task.Actions)
        if ($actions.Count -ne 1) {
            throw "Refusing to operate on malformed renderer pull task '$($task.TaskName)'."
        }
        $module = [regex]::Escape([string]$descriptions[[string]$task.Description])
        $arguments = [string]$actions[0].Arguments
        if ($arguments -notmatch "(?:^|\s)-m\s+$module(?:\s|$)") {
            throw "Refusing to operate on renderer pull task '$($task.TaskName)' with an unexpected command."
        }
        if ($arguments -notmatch '(?:^|\s)--config\s+(?:"([^"]+)"|(\S+))') {
            throw "Renderer pull task '$($task.TaskName)' does not declare a config path."
        }
        $configPath = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        if (-not [IO.Path]::IsPathRooted($configPath)) {
            throw "Renderer pull task '$($task.TaskName)' must use an absolute config path."
        }
        [pscustomobject]@{
            Task = $task
            Config = [IO.Path]::GetFullPath($configPath)
        }
    }
}

function New-RendererPullTaskTriggers([int]$RecoveryMinutes = 5) {
    if ($RecoveryMinutes -lt 1 -or $RecoveryMinutes -gt 60) {
        throw "Pull worker recovery interval must be between 1 and 60 minutes."
    }
    @(
        New-ScheduledTaskTrigger -AtStartup
        New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
            -RepetitionInterval (New-TimeSpan -Minutes $RecoveryMinutes)
    )
}

function Wait-RendererHealthy($Layout, [int]$Seconds = 30) {
    if ($Seconds -lt 1 -or $Seconds -gt 600) { throw "Health wait must be between 1 and 600 seconds." }
    $config = Read-RendererConfig $Layout
    $port = if ($config.port) { [int]$config.port } else { 8765 }
    $builder = New-Object System.UriBuilder -ArgumentList @("http", "127.0.0.1", $port)
    $healthUri = $builder.Uri.AbsoluteUri.TrimEnd('/') + "/v1/health"
    $tokenFile = if (($config.PSObject.Properties.Name -contains 'token_file') -and $config.token_file) { [string]$config.token_file } else { $Layout.Token }
    if (-not [IO.Path]::IsPathRooted($tokenFile)) {
        $tokenFile = Join-Path (Split-Path -Parent $Layout.Config) $tokenFile
    }
    $token = Read-RendererToken $tokenFile
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        try {
            $health = Invoke-RestMethod -UseBasicParsing -Uri $healthUri -Headers @{ Authorization = "Bearer $token" } -Method Get -TimeoutSec 5
            if ($health.status -eq "ok") { return $health }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Renderer did not become healthy within $Seconds seconds."
}

function Wait-RendererProcessExit([string]$ConfigPath, [int]$Seconds = 45) {
    $needle = [regex]::Escape([IO.Path]::GetFullPath($ConfigPath))
    for ($i = 0; $i -lt ($Seconds * 2); $i++) {
        $running = Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'wps_renderer' -and $_.CommandLine -match $needle }
        if (-not $running) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}
