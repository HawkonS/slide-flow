#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallRoot = "C:\ProgramData\SlideFlow\WpsRenderer",
    [string]$MainUrl = "http://127.0.0.1:18089",
    [string]$RendererUrl = "http://127.0.0.1:8765",
    [string]$TokenFile = "",
    [string]$MainTokenFile = "",
    [string]$RendererTokenFile = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Assert-LoopbackHttpUrl([string]$Value, [string]$Label) {
    $uri = [Uri]$Value
    if ($uri.Scheme -ne "http" -or $uri.AbsolutePath -ne "/" -or $uri.Query -or $uri.Fragment) {
        throw "$Label must be an HTTP origin without path, query, or fragment."
    }
    if (@("127.0.0.1", "localhost", "::1") -notcontains $uri.Host.ToLowerInvariant()) {
        throw "$Label must use a loopback host through the SSH bridge."
    }
    return $uri.AbsoluteUri.TrimEnd("/")
}

$MainUrl = Assert-LoopbackHttpUrl $MainUrl "MainUrl"
$RendererUrl = Assert-LoopbackHttpUrl $RendererUrl "RendererUrl"
if (-not $MainTokenFile -and $TokenFile) { $MainTokenFile = $TokenFile }
if (-not $RendererTokenFile -and $TokenFile) { $RendererTokenFile = $TokenFile }
if (-not $MainTokenFile) { $MainTokenFile = Join-Path $InstallRoot "shared\token.txt" }
if (-not $RendererTokenFile) { $RendererTokenFile = Join-Path $InstallRoot "shared\token.txt" }
foreach ($path in @($MainTokenFile, $RendererTokenFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Token file not found: $path" }
}
$mainToken = (Get-Content -LiteralPath $MainTokenFile -Raw).Trim()
$rendererToken = (Get-Content -LiteralPath $RendererTokenFile -Raw).Trim()
if ($mainToken.Length -lt 32 -or $mainToken -match '\s') { throw "Main token file is invalid." }
if ($rendererToken.Length -lt 32 -or $rendererToken -match '\s') { throw "Renderer token file is invalid." }
$mainHeaders = @{ Authorization = "Bearer $mainToken"; Accept = "application/json" }
$rendererHeaders = @{ Authorization = "Bearer $rendererToken"; Accept = "application/json" }

$renderer = Invoke-RestMethod -Uri "$RendererUrl/v1/health" -Headers $rendererHeaders -Method Get -TimeoutSec 10
if ($renderer.status -notin @("ok", "draining")) { throw "Renderer health is not ready." }
$font = Invoke-RestMethod -Uri "$MainUrl/api/renderer/font-sync/status" -Headers $mainHeaders -Method Get -TimeoutSec 10
$render = Invoke-RestMethod -Uri "$MainUrl/api/renderer/render-tasks/status" -Headers $mainHeaders -Method Get -TimeoutSec 10

Write-Host "Bridge verification passed."
Write-Host "  Renderer status: $($renderer.status)"
Write-Host "  Renderer queue: queued=$($renderer.queued) running=$($renderer.running)"
Write-Host "  Font queue: total=$($font.total) queued=$($font.queued) running=$($font.running) completed=$($font.completed) failed=$($font.failed) ready=$($font.ready)"
Write-Host "  Render queue: queued=$($render.queued) running=$($render.running) completed=$($render.completed) failed=$($render.failed) fonts_ready=$($render.fonts_ready)"
Write-Host "No credential value was printed."
