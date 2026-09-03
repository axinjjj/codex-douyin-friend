param(
    [ValidateRange(1024, 65535)]
    [int]$DebugPort = 9229
)

$ErrorActionPreference = 'Stop'
$EdgeExecutable = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProfileDirectory = Join-Path $ProjectRoot '.runtime\edge-profile'

if (-not (Test-Path -LiteralPath $EdgeExecutable -PathType Leaf)) {
    throw 'Microsoft Edge was not found at the verified install path.'
}

$ExistingListener = Get-NetTCPConnection -LocalPort $DebugPort -State Listen -ErrorAction SilentlyContinue
if ($ExistingListener) {
    throw "Debug port $DebugPort is already in use."
}

$ProfileArgument = "--user-data-dir=$ProfileDirectory"
$ExistingProfileProcess = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'msedge.exe' -and $_.CommandLine -like "*$ProfileArgument*"
})
if ($ExistingProfileProcess.Count -gt 0) {
    throw 'The dedicated Douyin Edge profile is already running. Reuse its existing window.'
}

New-Item -ItemType Directory -Path $ProfileDirectory -Force | Out-Null

$StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$StartInfo.FileName = $EdgeExecutable
$StartInfo.UseShellExecute = $false
$StartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
$StartInfo.ArgumentList.Add("--remote-debugging-address=127.0.0.1")
$StartInfo.ArgumentList.Add("--remote-debugging-port=$DebugPort")
$StartInfo.ArgumentList.Add("--remote-allow-origins=http://127.0.0.1:$DebugPort")
$StartInfo.ArgumentList.Add($ProfileArgument)
$StartInfo.ArgumentList.Add('--no-first-run')
$StartInfo.ArgumentList.Add('--new-window')
$StartInfo.ArgumentList.Add('https://www.douyin.com/chat')

$StartedProcess = [System.Diagnostics.Process]::Start($StartInfo)
if (-not $StartedProcess) {
    throw 'Microsoft Edge did not start.'
}

Write-Output "Dedicated Douyin web profile launched with localhost debugger port $DebugPort."
