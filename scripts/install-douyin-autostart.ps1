[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$taskName = "CodexDouyinFriendSupervisor"
$scriptDirectory = Split-Path -Parent $PSCommandPath
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory ".."))
$launcherPath = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory "start-douyin-supervisor.ps1"))
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop |
  Select-Object -First 1
$codexCommand = Get-Command codex.exe -CommandType Application -ErrorAction Stop |
  Select-Object -First 1
$nodePath = [System.IO.Path]::GetFullPath($nodeCommand.Source)
$codexPath = [System.IO.Path]::GetFullPath($codexCommand.Source)
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

foreach ($requiredPath in @($launcherPath, $nodePath, $codexPath, $windowsPowerShell)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "An autostart dependency is missing."
  }
}

$nodeVersion = (& $nodePath --version)
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(?<major>\d+)\.') {
  throw "Unable to verify Node.js."
}
$nodeMajor = [int]$Matches.major
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required."
}

$arguments = @(
  "-NoLogo"
  "-NoProfile"
  "-NonInteractive"
  "-ExecutionPolicy Bypass"
  "-File `"$launcherPath`""
  "-NodeFallbackPath `"$nodePath`""
  "-CodexFallbackPath `"$codexPath`""
) -join " "

$action = New-ScheduledTaskAction `
  -Execute $windowsPowerShell `
  -Argument $arguments `
  -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Runs the local-only Codex Douyin friend bridge after user logon." `
  -Force | Out-Null

$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($registered.TaskName -ne $taskName) {
  throw "Autostart task verification failed."
}

[pscustomobject]@{
  ok = $true
  taskName = $taskName
  state = [string]$registered.State
  user = $userId
  nodeMajor = $nodeMajor
} | ConvertTo-Json -Compress
