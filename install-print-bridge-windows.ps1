param(
  [string]$ProjectPath = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$bridge = Join-Path $project 'print-bridge.js'
if (!(Test-Path -LiteralPath $bridge)) { throw "print-bridge.js was not found in $project" }

$node = (Get-Command node.exe -ErrorAction Stop).Source
try {
  $action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $bridge) -WorkingDirectory $project
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName 'Red Lantern Print Bridge' -Action $action -Trigger $trigger -Description 'Starts the Red Lantern local printer bridge when this user signs in.' -Force | Out-Null
  Start-ScheduledTask -TaskName 'Red Lantern Print Bridge'
  Write-Host 'Print Bridge installed as a Windows sign-in task and started.'
} catch {
  $startup = [Environment]::GetFolderPath('Startup')
  $launcher = Join-Path $startup 'Red Lantern Print Bridge.cmd'
  @("@echo off", "start `"`" /b `"$node`" `"$bridge`"") | Set-Content -LiteralPath $launcher -Encoding Ascii
  Start-Process -FilePath $node -ArgumentList $bridge -WorkingDirectory $project -WindowStyle Hidden
  Write-Host 'Print Bridge installed in this user’s Startup folder and started.'
}
