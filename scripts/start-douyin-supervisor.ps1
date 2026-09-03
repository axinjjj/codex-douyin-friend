[CmdletBinding()]
param(
  [string]$NodeFallbackPath = "",
  [string]$CodexFallbackPath = ""
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Resolve-ExactApplication {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$FallbackPath = ""
  )

  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($command.Source)
  }
  if ($FallbackPath -and (Test-Path -LiteralPath $FallbackPath -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($FallbackPath)
  }
  throw "Required application is unavailable: $Name"
}

function Resolve-ExactCodexApplication {
  param([string]$FallbackPath = "")

  $command = Get-Command "codex.exe" -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($command.Source)
  }
  if ($FallbackPath -and (Test-Path -LiteralPath $FallbackPath -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($FallbackPath)
  }
  $installationRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
  if (Test-Path -LiteralPath $installationRoot -PathType Container) {
    $candidate = Get-ChildItem -LiteralPath $installationRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "codex.exe" } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      ForEach-Object { Get-Item -LiteralPath $_ } |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
    if ($null -ne $candidate) {
      return [System.IO.Path]::GetFullPath($candidate.FullName)
    }
  }
  throw "Required application is unavailable: codex.exe"
}

$scriptDirectory = Split-Path -Parent $PSCommandPath
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory ".."))
$supervisorScript = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory "run-douyin-supervisor.mjs"))
$nodePath = Resolve-ExactApplication -Name "node.exe" -FallbackPath $NodeFallbackPath
$codexPath = Resolve-ExactCodexApplication -FallbackPath $CodexFallbackPath

if (-not (Test-Path -LiteralPath $supervisorScript -PathType Leaf)) {
  throw "Supervisor entry point is missing."
}

$env:CODEX_BIN = $codexPath
Set-Location -LiteralPath $projectRoot
& $nodePath $supervisorScript
exit $LASTEXITCODE
