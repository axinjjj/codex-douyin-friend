[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$taskName = "CodexDouyinFriendSupervisor"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

[pscustomobject]@{
  ok = $true
  taskName = $taskName
  removed = ($null -ne $task)
} | ConvertTo-Json -Compress
